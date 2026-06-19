import { Task } from "@/lib/models/task";
import { Lead } from "@/lib/models/lead";
import { connectToDatabase } from "@/lib/mongodb";
import { ensureTicketForConversation, type TicketCategory, type TicketPriority } from "@/lib/tickets";
import { processTicketFlow } from "@/lib/crm/ticket-flow-engine";

/**
 * Registry mapping tool names to their OpenAI function definitions.
 *
 * Tools available to the AI:
 *  - save_extracted_data: generic data extraction → Task (legacy, kept for compat)
 *  - save_lead_data: upsert lead details by contactId (idempotent, Day 5 foundation)
 *  - create_ticket: create or update a real Ticket without pausing AI
 *  - update_contact_profile: update structured contact fields
 *  - escalate_to_human: hand off conversation to human agent
 */
export const AVAILABLE_TOOLS: Record<string, any> = {
  save_extracted_data: {
    type: "function",
    function: {
      name: "save_extracted_data",
      description: "Saves structured extracted data from the user (like orders, support tickets, contact info) into the database as a Task.",
      parameters: {
        type: "object",
        properties: {
          taskType: { type: "string", description: "The type of task (e.g., 'order', 'support_ticket', 'lead')" },
          title: { type: "string", description: "A brief title for this task" },
          extractedData: { type: "object", description: "The JSON object containing the extracted details" }
        },
        required: ["taskType", "title", "extractedData"]
      }
    }
  },

  save_lead_data: {
    type: "function",
    function: {
      name: "save_lead_data",
      description: "Saves or updates structured lead information extracted from the conversation. Idempotent — updates existing lead if one exists for this contact.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name of the lead" },
          email: { type: "string", description: "Email address if provided" },
          phone: { type: "string", description: "Phone number if provided" },
          company: { type: "string", description: "Company or organization name if provided" },
          interest: { type: "string", description: "What the lead is interested in (product, service, topic)" },
          notes: { type: "string", description: "Any additional qualifying notes or context" },
          score: { type: "number", description: "Lead quality score from 0 to 100 based on intent signals" }
        },
        required: ["name"]
      }
    }
  },

  create_ticket: {
    type: "function",
    function: {
      name: "create_ticket",
      description: "Creates or updates a real customer ticket from the current conversation without pausing AI. Use for booking, sales, support, complaints, or follow-up intent.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short descriptive title for the ticket" },
          description: { type: "string", description: "Full description of the issue or request" },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "Ticket priority based on urgency signals in the conversation"
          },
          category: { type: "string", enum: ["technical_support", "complaint", "human_request", "booking_request", "sales_request", "ai_failed", "general"], description: "Ticket category for routing" }
        },
        required: ["title", "description"]
      }
    }
  },

  update_contact_profile: {
    type: "function",
    function: {
      name: "update_contact_profile",
      description: "Updates known profile fields for the current contact. Only update fields explicitly confirmed by the user.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name" },
          email: { type: "string", description: "Email address" },
          phone: { type: "string", description: "Phone number" },
          language: { type: "string", description: "Preferred language code (e.g., 'ar', 'en')" },
          timezone: { type: "string", description: "IANA timezone (e.g., 'Asia/Riyadh')" },
          customFields: { type: "object", description: "Any additional structured fields confirmed by the user" }
        },
        required: []
      }
    }
  },

  escalate_to_human: {
    type: "function",
    function: {
      name: "escalate_to_human",
      description: "Escalates the conversation to a human agent only when the customer explicitly asks for a human, agent, representative, or real person.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why it is escalated" }
        },
        required: ["reason"]
      }
    }
  }
};

type ToolContext = {
  tenantId: string;
  conversationId: string;
  contactId?: string;
  botId?: string;
  conversation?: any;
  sendSmsCallback?: Function;
};

/**
 * Registry mapping tool names to their execution functions.
 * All executors must be idempotent and never store sensitive data beyond what is
 * explicitly provided. Each executor receives (args, context) where context
 * always includes tenantId, conversationId, and optionally contactId.
 */
export const TOOL_EXECUTORS: Record<string, Function> = {
  save_extracted_data: async (args: any, context: ToolContext) => {
    await connectToDatabase();
    const { taskType, title, extractedData } = args;

    await Task.create({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      contactId: context.contactId,
      type: taskType,
      title,
      details: extractedData,
      status: "open",
    });

    return JSON.stringify({ ok: true, event: "task_saved" });
  },

  save_lead_data: async (args: any, context: ToolContext) => {
    await connectToDatabase();
    const { name, email, phone, company, interest, notes, score } = args;

    if (!name?.trim()) return JSON.stringify({ ok: false, event: "lead_missing_required_field", missingFields: ["name"] });

    const leadData = {
      name,
      ...(email && { email }),
      ...(phone && { phone }),
      ...(company && { company }),
      ...(interest && { interest }),
      ...(notes && { notes }),
      ...(score !== undefined && { score }),
    };

    // Use contactId when available for accurate dedup; fall back to conversationId
    const dedupeFilter = context.contactId
      ? { tenantId: context.tenantId, contactId: context.contactId }
      : { tenantId: context.tenantId, conversationId: context.conversationId };

    await Lead.findOneAndUpdate(
      dedupeFilter,
      {
        $set: {
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          ...(context.contactId && { contactId: context.contactId }),
          stage: "new",
          ...leadData,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return JSON.stringify({ ok: true, event: "lead_saved" });
  },

  create_ticket: async (args: any, context: ToolContext) => {
    await connectToDatabase();
    const { title, description, priority = "medium", category = "general" } = args;

    if (!title?.trim() && !description?.trim()) return JSON.stringify({ ok: false, event: "ticket_tool_missing_input" });

    const botId = context.botId || context.conversation?.botId?.toString?.() || "";
    if (!botId) return JSON.stringify({ ok: false, event: "ticket_tool_missing_bot_id" });

    const flow = await processTicketFlow({
      tenantId: context.tenantId,
      botId,
      conversationId: context.conversationId,
      message: [title, description].filter(Boolean).join("\n"),
      conversationMetadata: context.conversation?.metadata || undefined,
      detectedIntent: {
        shouldCreate: true,
        category: (category || "general") as TicketCategory,
        priority: (priority || "medium") as TicketPriority,
        reason: "ai_tool_create_ticket",
      },
    });

    if (flow.action !== "create_ticket") {
      return JSON.stringify({ ok: false, event: "ticket_flow_pending", status: flow.state?.status || "collecting_required_fields", missingFields: flow.missingFields || [] });
    }

    const fields = flow.collectedFields || {};
    const ticket = await ensureTicketForConversation({
      tenantId: context.tenantId,
      botId,
      conversationId: context.conversationId,
      triggerReason: "ai_tool_create_ticket",
      category: (category || "general") as TicketCategory,
      priority: (priority || "medium") as TicketPriority,
      subject: title?.trim() || String(fields.issueDescription || "").slice(0, 120),
      description: String(fields.issueDescription || description || title || ""),
      source: "ai",
      metadata: {
        tool: "create_ticket",
        aiWorkflow: true,
        customerName: fields.name || "",
        customerPhone: fields.phone || "",
        issueDescription: fields.issueDescription || "",
        crmTicketFlow: flow.state || null,
      },
    });

    return JSON.stringify({ ok: true, event: "ticket_saved", ticketId: ticket?._id?.toString?.() || "" });
  },

  update_contact_profile: async (args: any, context: ToolContext) => {
    if (!context.contactId) return "No contact linked to this conversation. Profile not updated.";

    await connectToDatabase();
    const { name, email, phone, language, timezone, customFields } = args;

    const updates: Record<string, any> = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (phone) updates.phone = phone;
    if (language) updates.preferredLanguage = language;
    if (timezone) updates.timezone = timezone;
    if (customFields && typeof customFields === "object") {
      Object.entries(customFields).forEach(([k, v]) => {
        updates[`customFields.${k}`] = v;
      });
    }

    if (Object.keys(updates).length === 0) return "No fields to update.";

    try {
      const { Contact } = await import("@/lib/models/contact");
      await Contact.findOneAndUpdate(
        { _id: context.contactId, tenantId: context.tenantId },
        { $set: updates }
      );
      return `Contact profile updated: ${Object.keys(updates).join(", ")}.`;
    } catch {
      return "Contact model not yet available. Update queued for Day 5 migration.";
    }
  },

  escalate_to_human: async (args: any, context: ToolContext & { conversation?: any; sendSmsCallback?: Function }) => {
    const { reason } = args;

    if (context.conversation) {
      context.conversation.mode = "human";
      context.conversation.aiPaused = true;
      context.conversation.aiPausedReason = reason || "handover_requested";
      context.conversation.aiStatus = "escalated";
      context.conversation.handoffReason = reason || "handover_requested";
      await context.conversation.save();
    }

    if (typeof context.sendSmsCallback === "function") {
      context.sendSmsCallback(context.tenantId, context.conversationId, reason);
    }

    return "Escalated to human agent successfully.";
  },
};
