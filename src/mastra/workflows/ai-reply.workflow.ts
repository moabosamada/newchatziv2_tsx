import { createStep, createWorkflow } from "@mastra/core/workflows";
import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { Types } from "mongoose";
import {
  aiReplyInputSchema,
  aiReplyOutputSchema,
} from "@/mastra/schemas/ai-reply.schema";
import { AiSetting, Bot, Conversation, Message, Tenant } from "@/lib/models";
import { connectToDatabase } from "@/lib/mongodb";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/strings";
import { buildUnifiedSystemPrompt } from "@/lib/ai/build-system-prompt";
import { buildSafeCustomerReply } from "@/lib/ai/safe-customer-reply";
import { detectBusinessIntent, isDirectKnowledgeIntent } from "@/lib/ai/business-intent";
import { buildEntitiesPrompt, searchKnowledgeEntities } from "@/lib/knowledge-entities";
import { assertCanSendAiMessage, recordAiMessageUsage } from "@/lib/billing";
import { buildKnowledgePrompt, searchKnowledge } from "@/lib/knowledge";
import { checkContentModeration } from "@/lib/moderation";
import { getMastraMaxToolCalls } from "@/lib/ai/orchestrator-flags";
import {
  CHATZI_MASTRA_MODEL_CONTEXT_KEY,
  resolveMastraModelForBot,
} from "@/lib/ai/mastra-model-resolver";
import { validateCustomerReply } from "@/lib/ai/reply-validators";
import { logger } from "@/lib/logger";
import { publishRealtimeEvent } from "@/lib/realtime";
import {
  describeAttachmentsForAi,
  type MessageAttachment,
} from "@/lib/attachments";
import {
  classifyTicketIntent,
  ensureTicketForConversation,
  type TicketCategory,
  type TicketPriority,
} from "@/lib/tickets";
import { isExplicitHumanHandoffRequest } from "@/lib/ai/handoff";
import { detectAndReplyFast } from "@/lib/ai/fast-intent-responder";
import { getSystemMessage } from "@/lib/i18n-server";

const settingSchema = z
  .object({
    systemPrompt: z.string().optional(),
    fallbackMessage: z.string().optional(),
    temperature: z.number().optional(),
    language: z.string().optional(),
    role: z.string().optional(),
    tone: z.string().optional(),
    responseLength: z.string().optional(),
    useEmojis: z.boolean().optional(),
    isEnabled: z.boolean().optional(),
  })
  .nullable()
  .optional();

const botRuntimeSchema = z.object({
  name: z.string().optional(),
  knowledgeEnabled: z.boolean(),
  showKnowledgeSources: z.boolean(),
  confidenceDirectThreshold: z.number(),
  confidenceReviewThreshold: z.number(),
});

const knowledgeEntitiesSchema = z
  .object({
    source: z.literal("entities"),
    normalizedQuery: z.string().optional(),
    count: z.number(),
    entities: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        name: z.string(),
        description: z.string().optional(),
        category: z.string().optional(),
        price: z.string().optional(),
        availability: z.string().optional(),
        url: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        sourceText: z.string().optional(),
        confidence: z.number().optional(),
        score: z.number().optional(),
      })
    ),
  })
  .nullable()
  .optional();

const knowledgeSchema = z
  .object({
    confidence: z.number(),
    intent: z.string(),
    keywords: z.array(z.string()),
    results: z.array(
      z.object({
        text: z.string(),
        score: z.number(),
        rankScore: z.number().optional(),
        semanticScore: z.number().optional(),
        keywordScore: z.number().optional(),
        sourceTitle: z.string(),
        sourceUrl: z.string(),
        tags: z.array(z.string()).optional(),
        documentId: z.string(),
      })
    ),
    retrievalEngine: z.string().optional(),
    qdrantResultCount: z.number().optional(),
    mongoResultCount: z.number().optional(),
    documentFallbackCount: z.number().optional(),
  })
  .nullable()
  .optional();

const aiReplyRunContextSchema = aiReplyInputSchema.extend({
  conversationId: z.string().optional(),
  userMessageId: z.string().optional(),
  messageId: z.string().optional(),
  action: z.enum(["reply", "handoff", "skip", "fallback"]).optional(),
  generated: z.boolean().optional(),
  reply: z.string().optional(),
  confidence: z.number().nullable().optional(),
  reason: z.string().optional(),
  responseId: z.string().optional(),
  providerUsed: z.string().optional(),
  modelUsed: z.string().optional(),
  bot: botRuntimeSchema.optional(),
  setting: settingSchema,
  moderation: z
    .object({
      isSafe: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
  businessIntent: z.string().optional(),
  knowledgeEntities: knowledgeEntitiesSchema,
  knowledge: knowledgeSchema,
  knowledgePrompt: z.string().optional(),
  unifiedPrompt: z.string().optional(),
  validation: z
    .object({
      valid: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
  ticket: z
    .object({
      shouldCreate: z.boolean(),
      category: z.enum([
        "technical_support",
        "complaint",
        "human_request",
        "booking_request",
        "sales_request",
        "ai_failed",
        "general",
      ]),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      reason: z.string(),
    })
    .optional(),
  ticketId: z.string().optional(),
  ticketNumber: z.number().optional(),
  modelCalled: z.boolean().optional(),
  tenantName: z.string().optional(),
  needsLeadInfo: z.boolean().optional(),
});

type AiReplyRunContext = z.infer<typeof aiReplyRunContextSchema>;
type AiReplyTicketContext = NonNullable<AiReplyRunContext["ticket"]>;

function getInputAttachments(metadata: Record<string, unknown> | undefined) {
  const attachments = metadata?.attachments;
  if (!Array.isArray(attachments)) return [];

  return attachments.filter((attachment): attachment is MessageAttachment => {
    if (!attachment || typeof attachment !== "object") return false;
    const item = attachment as Partial<MessageAttachment>;
    return Boolean(
      item.id &&
        item.key &&
        item.name &&
        item.mimeType &&
        typeof item.size === "number" &&
        (item.type === "image" || item.type === "audio" || item.type === "file")
    );
  });
}

function getTimeoutMs() {
  const value = Number(process.env.MASTRA_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function withTimeoutSignal() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function hasExplicitHumanRequest(message: string) {
  return isExplicitHumanHandoffRequest(message);
}

function sanitizeCustomerReply(value: string) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/\[SENTIMENT:[^\]]*\]/gi, "")
    .replace(/\bRAG\b/gi, "المعرفة المتاحة")
    .replace(/\bconfidence score\b/gi, "درجة التأكد")
    .trim();
}

function replyAcknowledgesHandoff(value: string) {
  const text = String(value || "").toLowerCase();
  return /(سجل|تسجل|تسجيل|تذكره|تذكرة|طلبك|حول|تحويل|الفريق|الدعم|موظف|سيتواصل|هنتواصل|نتواصل|registered|recorded|ticket|support|team|agent|representative|follow up|reach out)/i.test(text);
}

function buildRuntimeContext(inputData: AiReplyRunContext, ticketId?: string) {
  const parts: string[] = [];

  if (inputData.businessIntent) {
    parts.push(`businessIntent=${inputData.businessIntent}`);
  }
  if (inputData.reason) {
    parts.push(`reason=${inputData.reason}`);
  }
  if (inputData.ticket?.shouldCreate) {
    parts.push(`ticketRequired=true`);
    parts.push(`ticketCategory=${inputData.ticket.category}`);
    parts.push(`ticketReason=${inputData.ticket.reason}`);
  }
  if (inputData.reason === "explicit_human_request" || inputData.ticket?.category === "human_request") {
    parts.push("handoffRequested=true");
  }
  if (ticketId) {
    parts.push("ticketCreated=true");
  }

  return parts.length ? parts.join("; ") : "";
}


// Lightweight greeting/thanks/out-of-scope responses are generated by src/lib/ai/fast-intent-responder.ts.
// No customer-facing reply text is hardcoded in this workflow.

// handoffReplyFor removed — the AI agent now generates natural context-aware handoff messages


const loadConversationStep = createStep({
  id: "load-conversation",
  inputSchema: aiReplyInputSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData }) => {
    await connectToDatabase();

    if (!Types.ObjectId.isValid(inputData.tenantId) || !Types.ObjectId.isValid(inputData.botId)) {
      throw new Error("معرف المستأجر أو البوت غير صالح.");
    }

    const bot = await Bot.findOne({
      _id: inputData.botId,
      tenantId: inputData.tenantId,
      isActive: true,
    }).lean();
    if (!bot) throw new Error("البوت غير موجود أو غير مفعل.");

    const tenant = await Tenant.findOne({ _id: inputData.tenantId }).lean();
    if (!tenant) throw new Error("مساحة العمل غير موجودة.");

    const setting = await AiSetting.findOne({
      tenantId: inputData.tenantId,
      botId: inputData.botId,
    }).lean();

    const conversation =
      inputData.conversationId && Types.ObjectId.isValid(inputData.conversationId)
        ? await Conversation.findOne({
            _id: inputData.conversationId,
            tenantId: inputData.tenantId,
            botId: inputData.botId,
          }).lean()
        : await Conversation.findOneAndUpdate(
            {
              tenantId: inputData.tenantId,
              botId: inputData.botId,
              channel: inputData.channel,
              externalUserId: inputData.externalUserId,
            },
            {
              $setOnInsert: {
                tenantId: inputData.tenantId,
                botId: inputData.botId,
                channel: inputData.channel,
                externalUserId: inputData.externalUserId,
                status: "open",
                mode: "ai",
                aiStatus: "active",
              },
            },
            { new: true, upsert: true }
          ).lean();

    if (!conversation) throw new Error("تعذر العثور على المحادثة.");

    const attachments = getInputAttachments(inputData.metadata);
    const attachmentDescription = describeAttachmentsForAi(attachments);
    const contentForStorage = attachmentDescription
      ? `${inputData.message}\n\nمرفقات العميل: ${attachmentDescription}`
      : inputData.message;

    const sourceMessageId = (inputData.metadata as any)?.sourceMessageId;
    const userMessage = sourceMessageId && Types.ObjectId.isValid(String(sourceMessageId))
      ? await Message.findOne({ _id: sourceMessageId, tenantId: inputData.tenantId, conversationId: conversation._id }).lean()
      : await Message.create({
          tenantId: inputData.tenantId,
          botId: inputData.botId,
          conversationId: conversation._id,
          contactId: conversation.contactId,
          channelIdentityId: conversation.channelIdentityId,
          provider: inputData.channel,
          direction: "incoming",
          sender: "user",
          senderType: "customer",
          content: contentForStorage,
          deliveryStatus: "delivered",
          attachments,
          metadata: inputData.metadata || {},
        });

    if (!userMessage) throw new Error("تعذر العثور على رسالة العميل.");

    const shouldSkip =
      conversation.status === "closed" ||
      conversation.status === "resolved" ||
      conversation.mode === "human" ||
      conversation.aiPaused === true;

    return {
      ...inputData,
      conversationId: conversation._id.toString(),
      userMessageId: userMessage._id.toString(),
      action: shouldSkip ? ("skip" as const) : undefined,
      reason: shouldSkip
        ? conversation.mode === "human" || conversation.aiPaused
          ? "conversation_human_mode"
          : `conversation_${conversation.status}`
        : undefined,
      bot: {
        name: bot.name,
        knowledgeEnabled: bot.knowledgeEnabled ?? true,
        showKnowledgeSources: bot.showKnowledgeSources ?? false,
        confidenceDirectThreshold: bot.confidenceDirectThreshold ?? 70,
        confidenceReviewThreshold: bot.confidenceReviewThreshold ?? 40,
      },
      setting: setting
        ? {
            systemPrompt: setting.systemPrompt || undefined,
            fallbackMessage: setting.fallbackMessage || undefined,
            temperature: setting.temperature ?? undefined,
            language: setting.language || undefined,
            role: setting.role || undefined,
            tone: setting.tone || undefined,
            responseLength: setting.responseLength || undefined,
            useEmojis: setting.useEmojis ?? undefined,
            isEnabled: setting.isEnabled ?? undefined,
          }
        : null,
      tenantName: tenant.name,
      unifiedPrompt: buildUnifiedSystemPrompt({
        businessName: tenant.name,
        botName: bot.name || "Chatzi",
        role: setting?.role || "CRM assistant",
        tone: setting?.tone || "professional, warm, marketing-focused",
        responseLength: setting?.responseLength || "short",
        language: setting?.language || "auto",
        customInstructions: setting?.systemPrompt || "",
        useEmojis: setting?.useEmojis ?? undefined,
      }),
      generated: false,
    };
  },
});

const fastReplyStep = createStep({
  id: "fast-ai-intent-responder",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData }) => {
    if (inputData.action) return inputData;

    const fast = await detectAndReplyFast({
      tenantId: inputData.tenantId,
      botId: inputData.botId,
      message: inputData.message,
      botName: inputData.bot?.name,
      businessName: inputData.tenantName || inputData.bot?.name,
      language: inputData.setting?.language || "auto",
      role: inputData.setting?.role || "assistant",
      tone: inputData.setting?.tone || "friendly",
      responseLength: inputData.setting?.responseLength || "short",
      fallbackMessage: inputData.setting?.fallbackMessage,
      customInstructions: inputData.setting?.systemPrompt,
      useEmojis: inputData.setting?.useEmojis ?? undefined,
    });

    if (!fast.handled || !fast.reply) return inputData;

    return {
      ...inputData,
      action: "reply" as const,
      reply: fast.reply,
      confidence: fast.confidence,
      reason: fast.reason || `ai_fast_${fast.intent}`,
      modelCalled: fast.modelCalled,
      providerUsed: fast.providerUsed,
      modelUsed: fast.modelUsed,
    };
  },
});

const moderationStep = createStep({
  id: "moderation-check",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData }) => {
    if (inputData.action === "skip") return inputData;

    const moderation = await checkContentModeration(inputData.message);
    if (!moderation.isSafe) {
      return {
        ...inputData,
        moderation,
        action: "fallback" as const,
        reply: await buildSafeCustomerReply({
          tenantId: inputData.tenantId,
          botId: inputData.botId,
          customerMessage: inputData.message,
          businessName: inputData.tenantName || inputData.bot?.name,
          botName: inputData.bot?.name || "Chatzi",
          language: inputData.setting?.language || "auto",
          intent: "moderation",
          reason: moderation.reason || "moderation_blocked",
          customInstructions: inputData.setting?.systemPrompt,
          contextSummary: buildRuntimeContext(inputData),
        }),
        confidence: 100,
        reason: moderation.reason || "moderation_blocked",
      };
    }

    return { ...inputData, moderation };
  },
});

const routeHandoffStep = createStep({
  id: "route-handoff",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData }) => {
    if (inputData.action) return inputData;

    // If customer explicitly asks for a human, flag it and let the unified prompt shape the reply.
    if (hasExplicitHumanRequest(inputData.message)) {
      const ticket: AiReplyTicketContext = {
        shouldCreate: true,
        category: "human_request",
        priority: "medium",
        reason: "explicit_human_request",
      };
      // Pass runtime context forward; no customer-facing handoff copy is hardcoded here.
      return { ...inputData, ticket, reason: "explicit_human_request" };
    }

    const ticketIntent = classifyTicketIntent(inputData.message);
    if (ticketIntent.shouldCreate) {
      const ticket: AiReplyTicketContext = {
        shouldCreate: ticketIntent.shouldCreate,
        category: ticketIntent.category as AiReplyTicketContext["category"],
        priority: ticketIntent.priority as AiReplyTicketContext["priority"],
        reason: ticketIntent.reason,
      };
      // For human requests — create ticket and forward
      return { ...inputData, ticket, reason: ticketIntent.reason };
    }

    return inputData;
  },
});

const quotaStep = createStep({
  id: "quota-check",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData }) => {
    if (inputData.action) return inputData;

    if (inputData.setting && inputData.setting.isEnabled === false) {
      throw new Error("الذكاء الاصطناعي غير مفعل لهذا البوت.");
    }

    await assertCanSendAiMessage(inputData.tenantId);
    return inputData;
  },
});

const knowledgeStep = createStep({
  id: "search-knowledge",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData }) => {
    if (inputData.action) return inputData;

    const knowledgeEnabled = inputData.bot?.knowledgeEnabled ?? true;
    const businessIntent = detectBusinessIntent(inputData.message);
    const entitySearch = knowledgeEnabled && isDirectKnowledgeIntent(businessIntent)
      ? await searchKnowledgeEntities({
          tenantId: inputData.tenantId,
          botId: inputData.botId,
          query: inputData.message,
          intent: businessIntent,
          limit: Number(process.env.AI_ENTITY_SEARCH_LIMIT || 10),
        })
      : null;

    const knowledge = knowledgeEnabled
      ? await searchKnowledge({
          tenantId: inputData.tenantId,
          botId: inputData.botId,
          question: inputData.message,
          limit: Number(process.env.AI_KB_SEARCH_LIMIT || 5),
        })
      : null;

    const entitiesPrompt = entitySearch?.entities?.length
      ? buildEntitiesPrompt({ intent: businessIntent, entities: entitySearch.entities, question: inputData.message })
      : "";

    const chunkPrompt = knowledge
      ? buildKnowledgePrompt({
          question: inputData.message,
          intent: knowledge.intent,
          keywords: knowledge.keywords,
          confidence: knowledge.confidence,
          results: knowledge.results,
          showSources: false,
        })
      : "";

    const knowledgePrompt = [entitiesPrompt, chunkPrompt].filter(Boolean).join("\n\n");

    logger.info("ai.knowledge_retrieval", {
      mode: "mastra_orchestrator",
      tenantId: inputData.tenantId,
      botId: inputData.botId,
      conversationId: inputData.conversationId,
      enabled: knowledgeEnabled,
      businessIntent,
      entityCount: entitySearch?.entities.length ?? 0,
      entityTopScore: entitySearch?.entities[0]?.score ?? null,
      ragResults: knowledge?.results.length ?? 0,
      topScore: knowledge?.results[0]?.score ?? null,
      confidence: knowledge?.confidence ?? null,
      retrievalEngine: knowledge?.retrievalEngine,
      rejected: false,
    });

    return {
      ...inputData,
      businessIntent,
      knowledgeEntities: entitySearch,
      knowledge,
      knowledgePrompt,
      confidence: Math.max(knowledge?.confidence ?? 0, entitySearch?.entities[0]?.score ?? 0),
    };
  },
});

const generateReplyStep = createStep({
  id: "generate-reply",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyRunContextSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.action) return inputData;
    if (!inputData.conversationId) throw new Error("تعذر تحديد المحادثة.");

    const runtimeContext = buildRuntimeContext(inputData);
    const instructions = [
      buildUnifiedSystemPrompt({
        businessName: inputData.tenantName || inputData.bot?.name,
        botName: inputData.bot?.name || "Chatzi",
        role: inputData.setting?.role,
        tone: inputData.setting?.tone,
        responseLength: inputData.setting?.responseLength,
        language: inputData.setting?.language || "auto",
        customInstructions: inputData.setting?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        knowledgeInstructions: inputData.knowledgePrompt,
        contextSummary: runtimeContext,
        useEmojis: inputData.setting?.useEmojis ?? undefined,
        enableTicketMarkers: true,
        needsLeadInfo: inputData.needsLeadInfo,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");

    const timeout = withTimeoutSignal();
    const attachmentDescription = describeAttachmentsForAi(
      getInputAttachments(inputData.metadata)
    );
    const userPrompt = attachmentDescription
      ? `${inputData.message}\n\nمرفقات العميل: ${attachmentDescription}`
      : inputData.message;

    try {
      const resolvedModel = await resolveMastraModelForBot({
        tenantId: inputData.tenantId,
        botId: inputData.botId,
      });
      const requestContext = new RequestContext();
      requestContext.set(CHATZI_MASTRA_MODEL_CONTEXT_KEY, resolvedModel.model);
      const temperature = inputData.setting?.temperature ?? 0.6;
      const agent = mastra.getAgentById("customer-support-agent");
      const result = await agent.generate(userPrompt, {
        requestContext,
        model: resolvedModel.model,
        instructions,
        maxSteps: getMastraMaxToolCalls(),
        abortSignal: timeout.signal,
        modelSettings: {
          temperature,
        },
        memory: {
          resource: `${inputData.tenantId}:${inputData.externalUserId}`,
          thread: {
            id: inputData.conversationId,
            title: inputData.bot?.name
              ? `${inputData.bot.name} support conversation`
              : "Support conversation",
            metadata: {
              tenantId: inputData.tenantId,
              botId: inputData.botId,
              channel: inputData.channel,
            },
          },
        },
      });

      let replyText = result.text?.trim() || "";
      let ticketToCreate = inputData.ticket;

      const ticketMatch = replyText.match(/\[CREATE_TICKET:\s*(booking_request|sales_request)\]/i);
      if (ticketMatch) {
        ticketToCreate = {
          shouldCreate: true,
          category: ticketMatch[1].toLowerCase() as "booking_request" | "sales_request",
          priority: "medium",
          reason: "ai_detected_intent",
        };
        replyText = replyText.replace(ticketMatch[0], "").trim();
        // Signal that we need customer lead info (name + phone) — detected by AI in any language
        inputData = { ...inputData, needsLeadInfo: true };
      }

      const shouldHandoff =
        inputData.reason === "explicit_human_request";

      logger.info("ai.model_reply", {
        mode: "mastra_orchestrator",
        tenantId: inputData.tenantId,
        botId: inputData.botId,
        provider: resolvedModel.providerUsed,
        model: resolvedModel.modelUsed,
        temperature,
        action: shouldHandoff ? "handoff" : "reply",
        ragResults: inputData.knowledge?.results.length ?? 0,
        topScore: inputData.knowledge?.results[0]?.score ?? null,
      });

      return {
        ...inputData,
        action: shouldHandoff ? ("handoff" as const) : ("reply" as const),
        reply: replyText,
        ticket: ticketToCreate,
        responseId: (result as { runId?: string }).runId || "",
        providerUsed: resolvedModel.providerUsed,
        modelUsed: resolvedModel.modelUsed,
        modelCalled: true,
      };
    } finally {
      timeout.clear();
    }
  },
});

const persistResultStep = createStep({
  id: "persist-result",
  inputSchema: aiReplyRunContextSchema,
  outputSchema: aiReplyOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData.conversationId) {
      throw new Error("تعذر تحديد المحادثة.");
    }

    if (inputData.action === "skip") {
      return {
        generated: false,
        action: "skip" as const,
        conversationId: inputData.conversationId,
        confidence: null,
        reason: inputData.reason,
      };
    }

    let action: NonNullable<AiReplyRunContext["action"]> =
      inputData.action || "fallback";
    let reply = sanitizeCustomerReply(inputData.reply || "") || inputData.setting?.fallbackMessage || "";

    let validation = validateCustomerReply(reply);
    if (!reply || !validation.valid) {
      action = "fallback";
      reply = await buildSafeCustomerReply({
        tenantId: inputData.tenantId,
        botId: inputData.botId,
        customerMessage: inputData.message,
        businessName: inputData.tenantName || inputData.bot?.name,
        botName: inputData.bot?.name || "Chatzi",
        language: inputData.setting?.language || "auto",
        intent: inputData.businessIntent || inputData.knowledge?.intent,
        reason: validation.reason || inputData.reason || "reply_validation_failed",
        hasKnowledge: Boolean(inputData.knowledgePrompt || inputData.knowledgeEntities?.entities?.length || inputData.knowledge?.results?.length),
        customInstructions: inputData.setting?.systemPrompt,
        knowledgeSummary: inputData.knowledgePrompt,
        contextSummary: buildRuntimeContext(inputData),
      });
      validation = validateCustomerReply(reply);
    }

    if (!reply || !validation.valid) {
      return {
        generated: false,
        action: "skip" as const,
        conversationId: inputData.conversationId,
        confidence: inputData.confidence ?? null,
        reason: validation.reason || "no_safe_customer_reply_generated",
      };
    }

    let ticketId: string | undefined;
    let ticketNumber: number | null | undefined;
    const shouldCreateTicket =
      inputData.ticket?.shouldCreate ||
      action === "handoff" ||
      (!validation.valid && inputData.modelCalled);

    if (shouldCreateTicket) {
      const ticket = await ensureTicketForConversation({
        tenantId: inputData.tenantId,
        botId: inputData.botId,
        conversationId: inputData.conversationId,
        triggerReason:
          inputData.ticket?.reason ||
          inputData.reason ||
          validation.reason ||
          "ai_followup_required",
        category: (inputData.ticket?.category ||
          (!validation.valid ? "ai_failed" : "human_request")) as TicketCategory,
        priority: (inputData.ticket?.priority || "medium") as TicketPriority,
        aiSummary: [
          `Reason: ${inputData.ticket?.reason || inputData.reason || validation.reason || "-"}`,
          `Channel: ${inputData.channel}`,
          `Knowledge confidence: ${inputData.confidence ?? "-"}`,
          `Last customer message: ${inputData.message}`,
        ].join("\n"),
        metadata: {
          workflow: "ai-reply-workflow",
          action,
          validation,
          knowledgeConfidence: inputData.confidence,
        },
      });
      ticketId = ticket?._id?.toString();
      ticketNumber = ticket?.number ?? undefined;
    }

    if (ticketId && !replyAcknowledgesHandoff(reply)) {
      if (action === "handoff") {
        reply += getSystemMessage("handoff_initiated", inputData.setting?.language);
        validation = { valid: true };
      } else if (ticketNumber) {
        reply += getSystemMessage("ticket_created", inputData.setting?.language, { ticketNumber: ticketNumber.toString() });
        validation = { valid: true };
      }
    }

    if (action === "handoff") {
      await Conversation.updateOne(
        { _id: inputData.conversationId, tenantId: inputData.tenantId, botId: inputData.botId },
        {
          $set: {
            status: "pending",
            mode: "human",
            aiPaused: true,
            aiPausedAt: new Date(),
            aiPausedReason: inputData.reason || "ticket_created",
            aiStatus: "escalated",
            handoffReason: inputData.reason || "ticket_created",
          },
        }
      );
    }

    const assistantMessage = await Message.create({
      tenantId: inputData.tenantId,
      botId: inputData.botId,
      conversationId: inputData.conversationId,
      provider: inputData.channel,
      direction: "outgoing",
      sender: "assistant",
      senderType: "assistant",
      content: reply,
      deliveryStatus: "queued",
      metadata: {
        trace: {
          ...(inputData.metadata as any)?.trace,
          traceId: (inputData.metadata as any)?.traceId,
          aiPersistedAt: new Date().toISOString(),
          modelCalled: inputData.modelCalled === true,
        },
        responseId: inputData.responseId,
        provider: inputData.providerUsed || "mastra",
        model: inputData.modelUsed,
        orchestrator: "mastra",
        temperature: inputData.setting?.temperature ?? 0.6,
        action,
        reason: inputData.reason,
        ticketId,
        validation: validation.valid ? { valid: true } : validation,
        knowledgeEntities: inputData.knowledgeEntities
          ? {
              intent: inputData.businessIntent,
              count: inputData.knowledgeEntities.entities.length,
              topScore: inputData.knowledgeEntities.entities[0]?.score || 0,
              entities: inputData.knowledgeEntities.entities.slice(0, 8).map((entity) => ({
                type: entity.type,
                name: entity.name,
                score: entity.score,
              })),
            }
          : { enabled: false },
        knowledge: inputData.knowledge
          ? {
              enabled: inputData.bot?.knowledgeEnabled ?? true,
              confidence: inputData.knowledge.confidence,
              intent: inputData.knowledge.intent,
              keywords: inputData.knowledge.keywords,
              sourceCount: inputData.knowledge.results.length,
              sources: (inputData.bot?.showKnowledgeSources
                ? inputData.knowledge.results.slice(0, 6)
                : []
              ).map((result) => ({
                title: result.sourceTitle,
                url: result.sourceUrl,
                score: result.score,
                documentId: result.documentId,
              })),
            }
          : { enabled: false },
      },
    });

    const createdAt = assistantMessage.createdAt?.toISOString?.() || new Date().toISOString();
    await Conversation.updateOne(
      { _id: inputData.conversationId, tenantId: inputData.tenantId, botId: inputData.botId },
      {
        $set: {
          lastMessageAt: new Date(),
          lastAiMessageAt: new Date(),
          lastAgentMessageAt: new Date(),
          lastMessagePreview: reply.slice(0, 220),
          aiStatus: action === "handoff" ? "escalated" : "active",
        },
        $inc: { aiTurnCount: 1 },
      }
    );

    await publishRealtimeEvent(inputData.tenantId, "message.created", {
      message: {
        id: assistantMessage._id.toString(),
        conversationId: inputData.conversationId,
        content: reply,
        direction: "outgoing",
        sender: "assistant",
        senderType: "assistant",
        provider: inputData.channel,
        deliveryStatus: assistantMessage.deliveryStatus,
        createdAt,
        attachments: [],
      },
      conversation: {
        id: inputData.conversationId,
        lastMessage: reply.slice(0, 220),
        lastMessageAt: createdAt,
        aiStatus: action === "handoff" ? "escalated" : "active",
      },
    });

    if (inputData.modelCalled) {
      await recordAiMessageUsage(inputData.tenantId);
    }

    return {
      generated: action === "reply" || action === "fallback" || action === "handoff",
      action,
      reply,
      messageId: assistantMessage._id.toString(),
      conversationId: inputData.conversationId,
      confidence: inputData.confidence ?? null,
      reason: validation.valid ? inputData.reason : validation.reason,
      providerUsed: inputData.providerUsed || "mastra",
      modelUsed: inputData.modelUsed,
    };
  },
});

export const aiReplyWorkflow = createWorkflow({
  id: "ai-reply-workflow",
  inputSchema: aiReplyInputSchema,
  outputSchema: aiReplyOutputSchema,
})
  .then(loadConversationStep)
  .then(fastReplyStep)
  .then(moderationStep)
  .then(routeHandoffStep)
  .then(quotaStep)
  .then(knowledgeStep)
  .then(generateReplyStep)
  .then(persistResultStep)
  .commit();
