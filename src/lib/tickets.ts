import crypto from "crypto";
import { Types } from "mongoose";
import { Bot, Conversation, Message, Ticket } from "@/lib/models";
import { connectToDatabase } from "@/lib/mongodb";
import { publishRealtimeEvent } from "@/lib/realtime";
import { syncLeadFromTicket } from "@/lib/leads-from-tickets";

export type TicketCategory =
  | "technical_support"
  | "complaint"
  | "human_request"
  | "booking_request"
  | "sales_request"
  | "ai_failed"
  | "general";

export type TicketPriority = "low" | "medium" | "high" | "urgent";

export type EnsureTicketInput = {
  tenantId: string;
  botId: string;
  conversationId: string;
  triggerReason: string;
  category: TicketCategory;
  priority?: TicketPriority;
  subject?: string;
  description?: string;
  aiSummary?: string;
  source?: "ai" | "agent" | "system";
  metadata?: Record<string, unknown>;
};

export type TicketIntentClassification = {
  shouldCreate: boolean;
  category: TicketCategory;
  priority: TicketPriority;
  reason: string;
};

function buildSubject(input: {
  category: TicketCategory;
  triggerReason: string;
  externalUserId: string;
}) {
  const label = input.category.replace(/_/g, " ");
  return `${label} - ${input.externalUserId}`;
}

export function classifyTicketIntent(_message: string): TicketIntentClassification {
  return { shouldCreate: false, category: "general", priority: "medium", reason: "ticket_intent_requires_ai_policy_engine" };
}

export async function ensureTicketForConversation(input: EnsureTicketInput) {
  await connectToDatabase();

  if (
    !Types.ObjectId.isValid(input.tenantId) ||
    !Types.ObjectId.isValid(input.botId) ||
    !Types.ObjectId.isValid(input.conversationId)
  ) {
    throw new Error("معرفات التذكرة غير صالحة.");
  }

  const conversation = await Conversation.findOne({
    _id: input.conversationId,
    tenantId: input.tenantId,
    botId: input.botId,
  });
  if (!conversation) throw new Error("المحادثة غير موجودة.");

  const issueFingerprint = buildTicketIssueFingerprint(input);

  const existing = await Ticket.findOne({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    status: { $in: ["open", "pending", "in_progress"] },
    $or: [{ "metadata.issueFingerprint": issueFingerprint }, { category: input.category }],
  });

  if (existing) {
    const update: Record<string, unknown> = {
      triggerReason: input.triggerReason,
      category: input.category,
      priority: input.priority || existing.priority,
      metadata: {
        ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
        ...(input.metadata || {}),
        issueFingerprint,
        lastTriggerReason: input.triggerReason,
      },
    };
    if (input.aiSummary) update.aiSummary = input.aiSummary;
    if (input.description) update.description = input.description;

    await existing.updateOne({ $set: update });
    const refreshed = await Ticket.findById(existing._id);
    if (refreshed) {
      await syncLeadFromTicket({ tenantId: input.tenantId, ticketId: refreshed._id.toString() }).catch(() => null);
      await publishRealtimeEvent(input.tenantId, "ticket.updated", {
        ticket: {
          id: refreshed._id.toString(),
          number: refreshed.number || 0,
          subject: refreshed.subject || refreshed.title,
          status: refreshed.status,
          priority: refreshed.priority,
          category: refreshed.category,
          updatedAt: refreshed.updatedAt?.toISOString?.() || new Date().toISOString(),
        },
        conversation: { id: input.conversationId },
      }).catch(() => undefined);
    }
    return refreshed;
  }

  const [counter, bot, lastMessages] = await Promise.all([
    Ticket.countDocuments({ tenantId: input.tenantId }),
    Bot.findById(input.botId).lean(),
    Message.find({
      tenantId: input.tenantId,
      botId: input.botId,
      conversationId: input.conversationId,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
  ]);

  const transcriptSummary = lastMessages
    .reverse()
    .map((message) => `${message.sender}: ${message.content}`)
    .join("\n");
  const subject =
    input.subject ||
    buildSubject({
      category: input.category,
      triggerReason: input.triggerReason,
      externalUserId: conversation.externalUserId,
    });

  const createdTicket = await Ticket.create({
    tenantId: input.tenantId,
    botId: input.botId,
    contactId: conversation.contactId || undefined,
    conversationId: input.conversationId,
    number: counter + 1,
    subject,
    title: subject,
    description: input.description || transcriptSummary,
    status: "open",
    priority: input.priority || "medium",
    category: input.category,
    requesterExternalId: conversation.externalUserId,
    channel: conversation.channel,
    source: input.source || "ai",
    triggerReason: input.triggerReason,
    aiSummary:
      input.aiSummary ||
      `Bot: ${bot?.name || "-"}\nReason: ${input.triggerReason}\nCustomer: ${
        conversation.externalUserId
      }`,
    metadata: { ...(input.metadata || {}), issueFingerprint },
  });

  await syncLeadFromTicket({ tenantId: input.tenantId, ticketId: createdTicket._id.toString() }).catch(() => null);
  await publishRealtimeEvent(input.tenantId, "ticket.created", {
    ticket: {
      id: createdTicket._id.toString(),
      number: createdTicket.number || 0,
      subject: createdTicket.subject || createdTicket.title,
      status: createdTicket.status,
      priority: createdTicket.priority,
      category: createdTicket.category,
      createdAt: createdTicket.createdAt?.toISOString?.() || new Date().toISOString(),
    },
    conversation: { id: input.conversationId },
  }).catch(() => undefined);

  return createdTicket;
}


function buildTicketIssueFingerprint(input: EnsureTicketInput) {
  const source = [input.tenantId, input.botId, input.conversationId, input.category, input.triggerReason, (input.subject || input.description || input.aiSummary || "").toLowerCase().replace(/\s+/g, " ").slice(0, 500)].join("|");
  return crypto.createHash("sha256").update(source).digest("hex");
}
