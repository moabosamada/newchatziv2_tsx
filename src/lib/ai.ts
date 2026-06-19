import { Types } from "mongoose";
import { AiPersona, AiSetting, Bot, Conversation, Message, Tenant, User } from "@/lib/models";
import { connectToDatabase } from "@/lib/mongodb";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/strings";
import { assertAndReserveQuota } from "@/lib/quota";
import { buildKnowledgePrompt, searchKnowledge } from "@/lib/knowledge";
import { checkContentModeration } from "@/lib/moderation";
import { routeAiRequest } from "@/lib/ai-router";
import { publishRealtimeEvent } from "@/lib/realtime";
import { escalateConversationToHuman } from "@/lib/ai/escalation";
import { generateAiReplyWithMastra } from "@/lib/ai/mastra-orchestrator";
import { isMastraAllowed, shouldFallbackToLegacy } from "@/lib/ai/orchestrator-flags";
import { logger } from "@/lib/logger";
import { isExplicitHumanHandoffRequest } from "@/lib/ai/handoff";
import { classifyTicketIntent, ensureTicketForConversation } from "@/lib/tickets";
import { detectAndReplyFast } from "@/lib/ai/fast-intent-responder";
import { buildSafeCustomerReply } from "@/lib/ai/safe-customer-reply";

export type GenerateReplyInput = {
  tenantId: string;
  botId: string;
  message: string;
  conversationId?: string;
  channel: string;
  externalUserId: string;
  metadata?: Record<string, unknown>;
};

// ─── Token estimation ──────────────────────────────────────────────────────────



const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate: 4 characters ≈ 1 token.
 * Conservative and safe for mixed Arabic/English content.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Token budget constants.
 * Total safe limit: 4000 tokens. Breakdown:
 *  - 1200 reserved for system + persona prompt
 *  - 800  reserved for RAG knowledge context
 *  - 2000 available for conversation transcript
 * Models like gpt-4o-mini support 128k context but we keep a conservative
 * default to avoid latency/cost spikes and to ensure structured output fits.
 * Override via env CONTEXT_BUDGET_TOKENS if needed.
 */
const CONTEXT_BUDGET_TOKENS = Number(process.env.CONTEXT_BUDGET_TOKENS) || 4000;
const SYSTEM_RESERVE_TOKENS = 1200;
const KNOWLEDGE_RESERVE_TOKENS = 800;
const TRANSCRIPT_BUDGET_TOKENS = CONTEXT_BUDGET_TOKENS - SYSTEM_RESERVE_TOKENS - KNOWLEDGE_RESERVE_TOKENS;
const MIN_MESSAGES_IN_CONTEXT = 2;
const MAX_MESSAGES_FETCH = 60;

/**
 * Build a conversation transcript that respects the token budget.
 * Processes messages newest-first; stops when budget is exhausted but
 * always includes at least MIN_MESSAGES_IN_CONTEXT messages.
 * If the full history is truncated, prepends a summary placeholder.
 */
function buildTokenAwareTranscript(
  messages: Array<{ sender: string; content: string }>,
  budgetTokens: number
): string {
  const lines: string[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (const msg of messages) {
    const line = `${msg.sender === "assistant" ? "المساعد" : "المستخدم"}: ${msg.content}`;
    const tokens = estimateTokens(line);

    if (usedTokens + tokens > budgetTokens && lines.length >= MIN_MESSAGES_IN_CONTEXT) {
      truncated = true;
      break;
    }

    lines.unshift(line);
    usedTokens += tokens;
  }

  if (truncated) {
    lines.unshift("[... محادثة سابقة محذوفة لتوفير مساحة — استمر بناءً على السياق الأخير ...]");
  }

  return lines.join("\n");
}

// ─── Orchestrator switch ───────────────────────────────────────────────────────

export async function generateAiReply(input: GenerateReplyInput) {
  if (isMastraAllowed(input.tenantId)) {
    try {
      const result = await generateAiReplyWithMastra(input);
      logger.info("ai.reply_mode", {
        mode: "mastra_orchestrator",
        tenantId: input.tenantId,
        botId: input.botId,
        action: result.action,
        confidence: result.confidence ?? null,
        hasReply: Boolean(result.reply?.trim()),
      });

      if (!result.reply?.trim() && result.action !== "skip" && shouldFallbackToLegacy()) {
        logger.warn("ai.direct_fallback_triggered", {
          tenantId: input.tenantId,
          botId: input.botId,
          reason: "orchestrator_empty_reply",
        });
        return generateAiReplyLegacy(input, { mode: "direct_fallback", reason: "orchestrator_empty_reply" });
      }

      return result;
    } catch (error) {
      logger.error("mastra.orchestrator_failed", {
        error: error instanceof Error ? error.message : String(error),
        tenantId: input.tenantId,
        botId: input.botId,
      });

      if (!shouldFallbackToLegacy()) {
        throw error;
      }

      logger.info("ai.direct_fallback_triggered", {
        tenantId: input.tenantId,
        botId: input.botId,
        reason: "orchestrator_error",
      });
      return generateAiReplyLegacy(input, { mode: "direct_fallback", reason: "orchestrator_error" });
    }
  }

  return generateAiReplyLegacy(input, { mode: "legacy_direct", reason: "orchestrator_disabled" });
}

// ─── Direct implementation ────────────────────────────────────────────────────

type DirectReplyOptions = {
  mode?: "legacy_direct" | "direct_fallback";
  reason?: string;
};

export async function generateAiReplyLegacy(input: GenerateReplyInput, options: DirectReplyOptions = {}) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(input.tenantId) || !Types.ObjectId.isValid(input.botId)) {
    throw new Error("معرف المستأجر أو البوت غير صالح.");
  }

  const bot = await Bot.findOne({
    _id: input.botId,
    tenantId: input.tenantId,
    isActive: true,
  });
  if (!bot) throw new Error("البوت غير موجود أو غير مفعل.");

  const setting = await AiSetting.findOne({
    tenantId: input.tenantId,
    botId: input.botId,
  });
  const tenant = await Tenant.findById(input.tenantId).select("name").lean();

  if (setting && !setting.isEnabled) {
    throw new Error("الذكاء الاصطناعي غير مفعل لهذا البوت.");
  }

  const conversation =
    input.conversationId && Types.ObjectId.isValid(input.conversationId)
      ? await Conversation.findOne({
          _id: input.conversationId,
          tenantId: input.tenantId,
          botId: input.botId,
        })
      : await Conversation.findOneAndUpdate(
          {
            tenantId: input.tenantId,
            botId: input.botId,
            channel: input.channel,
            externalUserId: input.externalUserId,
          },
          {
            $setOnInsert: {
              tenantId: input.tenantId,
              botId: input.botId,
              channel: input.channel,
              externalUserId: input.externalUserId,
              status: "open",
              mode: "ai",
              aiStatus: "active",
            },
          },
          { new: true, upsert: true }
        );

  if (!conversation) throw new Error("تعذر العثور على المحادثة.");

  if (!input.conversationId) {
    await Message.create({
      tenantId: input.tenantId,
      botId: input.botId,
      conversationId: conversation._id,
      contactId: conversation.contactId,
      channelIdentityId: conversation.channelIdentityId,
      provider: input.channel,
      direction: "incoming",
      sender: "user",
      senderType: "customer",
      content: input.message,
      deliveryStatus: "delivered",
      metadata: input.metadata || {},
    });

    conversation.lastMessageAt = new Date();
    conversation.lastCustomerMessageAt = new Date();
    conversation.lastMessagePreview = input.message.slice(0, 220);
    await conversation.save();
  }

  if (conversation.status === "closed" || conversation.status === "resolved") {
    return {
      reply: "",
      conversationId: conversation._id.toString(),
      confidence: null,
      messageId: null,
    };
  }

  if (conversation.mode === "human" || conversation.aiPaused) {
    return {
      reply: "",
      conversationId: conversation._id.toString(),
      confidence: null,
      messageId: null,
    };
  }

  const metadata = normalizeObject(conversation.metadata);
  const aiPolicy = normalizeObject(metadata.aiPolicy);
  const explicitHandoffRequested = isExplicitHumanHandoffRequest(input.message);
  const handoffRequested = explicitHandoffRequested && (aiPolicy.handoffRequested === true || conversation.handoffReason === "handover_requested" || explicitHandoffRequested);

  if (handoffRequested) {
    const handoffMessage = await escalateConversationToHuman({
      tenantId: input.tenantId,
      conversation,
      reason: "handoff_requested",
      userMessage: input.message,
      summary: "Customer requested a human agent.",
      // publicMessage intentionally omitted — escalation.ts DEFAULT_ESCALATION_MESSAGE is used
      // The agent itself should generate a natural contextual message when possible
    });

    return {
      reply: handoffMessage.content,
      conversationId: conversation._id.toString(),
      confidence: null,
      messageId: handoffMessage._id.toString(),
    };
  }

  const moderation = await checkContentModeration(input.message);
  if (!moderation.isSafe) {
    const fallback = setting?.fallbackMessage || await buildSafeCustomerReply({ tenantId: input.tenantId, botId: input.botId, customerMessage: input.message, businessName: bot?.name || tenant?.name || "", botName: bot?.name || "Chatzi", language: setting?.language || "auto", reason: moderation.reason || "moderation_blocked", customInstructions: setting?.systemPrompt });
    if (!fallback) return { reply: "", conversationId: conversation._id.toString(), confidence: null };
    const flaggedMessage = await Message.create({
      tenantId: input.tenantId,
      botId: input.botId,
      conversationId: conversation._id,
      contactId: conversation.contactId,
      channelIdentityId: conversation.channelIdentityId,
      provider: input.channel,
      direction: "outgoing",
      sender: "assistant",
      senderType: "assistant",
      content: fallback,
      deliveryStatus: "queued",
      metadata: { flagged: true, reason: moderation.reason },
    });
    conversation.lastMessageAt = new Date();
    conversation.lastAiMessageAt = new Date();
    conversation.lastMessagePreview = fallback.slice(0, 220);
    await conversation.save();
    publishRealtimeEvent(input.tenantId, "message.created", {
      message: {
        id: flaggedMessage._id.toString(),
        conversationId: conversation._id.toString(),
        content: fallback,
        direction: "outgoing",
        sender: "assistant",
        senderType: "assistant",
        provider: input.channel,
        deliveryStatus: flaggedMessage.deliveryStatus || "sent",
        createdAt: flaggedMessage.createdAt?.toISOString?.() || new Date().toISOString(),
        attachments: []
      },
      conversation: {
        id: conversation._id.toString(),
        lastMessage: fallback.slice(0, 220),
        lastMessageAt: conversation.lastMessageAt?.toISOString?.() || new Date().toISOString(),
        unreadCount: conversation.unreadCount || 0,
        channel: conversation.channel,
        provider: input.channel
      }
    }).catch(() => undefined);
    return {
      reply: fallback,
      conversationId: conversation._id.toString(),
      confidence: 100,
      messageId: flaggedMessage._id.toString(),
    };
  }

  const previousMessages = await Message.find({
    tenantId: input.tenantId,
    botId: input.botId,
    conversationId: conversation._id,
  })
    .sort({ createdAt: -1 })
    .limit(MAX_MESSAGES_FETCH)
    .lean();

  const tenantDisplayName = await resolveTenantDisplayName(input.tenantId, bot.name);
  const fastIntent = await detectAndReplyFast({
    tenantId: input.tenantId,
    botId: input.botId,
    message: input.message,
    botName: bot.name,
    businessName: tenantDisplayName,
    language: setting?.language || "auto",
    role: setting?.role || "assistant",
    tone: setting?.tone || "friendly",
    responseLength: setting?.responseLength || "short",
    fallbackMessage: setting?.fallbackMessage,
  });

  if (fastIntent.handled && fastIntent.reply) {
    const replyMessage = await createOutgoingAiReply({
      tenantId: input.tenantId,
      conversation,
      channel: input.channel,
      reply: fastIntent.reply,
      metadata: {
        fastPath: fastIntent.reason || `ai_fast_${fastIntent.intent}`,
        fastIntent: fastIntent.intent,
        fastLanguage: fastIntent.language,
        fastModelCalled: fastIntent.modelCalled,
        fastProviderUsed: fastIntent.providerUsed,
        fastModelUsed: fastIntent.modelUsed,
      },
    });

    conversation.aiTurnCount = Number(conversation.aiTurnCount || 0) + 1;
    conversation.aiStatus = "active";
    conversation.metadata = {
      ...normalizeObject(conversation.metadata),
      aiPolicy: {
        ...normalizeObject(normalizeObject(conversation.metadata).aiPolicy),
        lastFastIntent: fastIntent.intent,
        lastFastIntentAt: new Date().toISOString(),
      },
    };
    await conversation.save();

    return {
      reply: fastIntent.reply,
      conversationId: conversation._id.toString(),
      confidence: fastIntent.confidence,
      messageId: replyMessage._id.toString(),
    };
  }

  const routedPersona = await inferAutoPersona({
    tenantId: input.tenantId,
    message: input.message,
    metadata: input.metadata,
    currentPersonaId: conversation.activePersonaId?.toString?.() || ""
  });

  if (routedPersona && String(conversation.activePersonaId || "") !== routedPersona._id.toString()) {
    conversation.activePersonaId = routedPersona._id as any;
    conversation.aiIntent = mapPersonaToConversationIntent(routedPersona, input.message) as any;
    conversation.metadata = {
      ...normalizeObject(conversation.metadata),
      aiRouting: {
        ...normalizeObject(normalizeObject(conversation.metadata).aiRouting),
        autoRoutedPersonaId: routedPersona._id.toString(),
        autoRoutedPersonaName: routedPersona.roleName,
        autoRoutedAt: new Date().toISOString(),
        reason: inferPersonaRoutingReason(input.message)
      }
    };
    await conversation.save();
  }

  const activePersona = routedPersona || (conversation.activePersonaId
    ? await AiPersona.findOne({ _id: conversation.activePersonaId, tenantId: input.tenantId, isActive: true }).lean()
    : null);

  const transcript = buildTokenAwareTranscript(previousMessages, TRANSCRIPT_BUDGET_TOKENS);
  const currentUserFingerprint = fingerprint(input.message);
  const priorUserFingerprint = previousMessages
    .filter((message) => message.direction === "incoming" && message.sender === "user")
    .slice(1, 2)
    .map((message) => fingerprint(message.content || ""))[0];
  const lastAssistantFingerprint = previousMessages
    .filter((message) => message.direction === "outgoing" && message.sender === "assistant")
    .slice(0, 1)
    .map((message) => fingerprint(message.content || ""))[0];

  const repeatedUserCount =
    currentUserFingerprint && currentUserFingerprint === priorUserFingerprint
      ? Number(aiPolicy.repeatedUserCount || 0) + 1
      : 0;

  const nextAiTurnCount = Number(conversation.aiTurnCount || 0) + 1;
  const maxAutoTurns = Number(process.env.AI_MAX_AUTO_TURNS || 30);
  const maxRepeatedUserTurns = Number(process.env.AI_MAX_REPEATED_USER_TURNS || 4);

  if (nextAiTurnCount > maxAutoTurns) {
    logger.info("ai.max_auto_turns_continue_without_handoff", { tenantId: input.tenantId, botId: input.botId, conversationId: conversation._id.toString(), nextAiTurnCount, maxAutoTurns, reason: "max_ai_turns_reached_but_customer_did_not_request_human" });
  }

  if (repeatedUserCount > maxRepeatedUserTurns) {
    logger.info("ai.repeated_user_continue_without_handoff", { tenantId: input.tenantId, botId: input.botId, conversationId: conversation._id.toString(), repeatedUserCount, maxRepeatedUserTurns, reason: "repeated_question_loop_but_customer_did_not_request_human" });
  }

  const knowledgeEnabled = bot.knowledgeEnabled ?? true;
  const knowledgeQuery = enhanceQuestionWithAttachments(input.message, input.metadata);
  const knowledge = knowledgeEnabled
    ? await searchKnowledge({
        tenantId: input.tenantId,
        botId: input.botId,
        question: knowledgeQuery,
        limit: Number(process.env.AI_KB_SEARCH_LIMIT || 5),
      })
    : null;

  const reviewThreshold = Number(process.env.AI_KB_REVIEW_THRESHOLD || bot.confidenceReviewThreshold || 15);
  const directThreshold = Number(process.env.AI_KB_DIRECT_THRESHOLD || bot.confidenceDirectThreshold || 50);
  const hasKnowledgeResults = Boolean(knowledge && knowledge.results.length > 0);
  const weakKnowledgeButAvailable = knowledgeEnabled && hasKnowledgeResults && (knowledge?.confidence ?? 0) < reviewThreshold;
  const lowKnowledgeConfidence = knowledgeEnabled && (!knowledge || knowledge.results.length === 0);
  const clarificationCount = lowKnowledgeConfidence ? Number(aiPolicy.clarificationCount || 0) + 1 : 0;
  const maxClarificationTurns = Number(process.env.AI_MAX_CLARIFICATION_TURNS || 4);
  const topKnowledgeScore = knowledge?.results[0]?.score ?? null;

  logger.info("ai.knowledge_retrieval", {
    mode: options.mode || "legacy_direct",
    tenantId: input.tenantId,
    botId: input.botId,
    conversationId: conversation._id.toString(),
    enabled: knowledgeEnabled,
    ragResults: knowledge?.results.length ?? 0,
    topScore: topKnowledgeScore,
    confidence: knowledge?.confidence ?? null,
    retrievalEngine: knowledge?.retrievalEngine,
    lowKnowledgeConfidence,
    weakKnowledgeButAvailable,
  });

  if (lowKnowledgeConfidence && clarificationCount > maxClarificationTurns) {
    logger.info("ai.knowledge_missing_continue_direct", {
      tenantId: input.tenantId,
      botId: input.botId,
      conversationId: conversation._id.toString(),
      clarificationCount,
      maxClarificationTurns,
      reason: "knowledge_missing_without_handoff",
    });
  }

  const knowledgePrompt = knowledge
    ? buildKnowledgePrompt({
        question: input.message,
        intent: knowledge.intent,
        keywords: knowledge.keywords,
        confidence: knowledge.confidence,
        results: knowledge.results,
        showSources: bot.showKnowledgeSources ?? false,
      })
    : "";

  const personaDirectives: string[] = [];
  if (activePersona) {
    personaDirectives.push(`Active AI employee/persona: ${activePersona.roleName}. Persona type: ${activePersona.personaType || "general"}. Description: ${activePersona.description || "-"}.`);
    personaDirectives.push(`Persona system instructions: ${activePersona.systemPrompt}`);
    personaDirectives.push(`Reply with the flexibility and business focus expected from this employee. If the customer intent fits another employee later, the system may reroute automatically.`);
  }
  if (setting?.role && setting.role !== "assistant") {
    personaDirectives.push(`Your role is: ${setting.role}. Always stay in character.`);
  }
  if (setting?.language && setting.language !== "auto") {
    personaDirectives.push(`You must reply exclusively in this language: ${setting.language}.`);
  }
  if (setting?.tone && setting.tone !== "neutral") {
    personaDirectives.push(`Maintain a ${setting.tone} tone throughout the conversation.`);
  }
  if (setting?.responseLength && setting.responseLength !== "medium") {
    personaDirectives.push(`Keep your answers ${setting.responseLength}.`);
  }
  if (setting?.useEmojis === false) {
    personaDirectives.push(`Do NOT use any emojis in your responses.`);
  } else if (setting?.useEmojis === true) {
    personaDirectives.push(`Feel free to use relevant emojis in your responses.`);
  }

  const systemPrompt = [
    ...personaDirectives,
    setting?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    "You are Chatzi AI assistant for this business.",
    "Answer naturally, clearly, and helpfully. Keep the answer concise, friendly, and human-like.",
    "Use the provided business knowledge as the primary source.",
    "If the customer asks about unrelated general knowledge, programming, weather, animals, food, or any topic outside the business scope, politely explain that you can only help with this business and invite them to ask about products, services, booking, prices, policies, or support.",
    "Do not invent exact business facts such as prices, policies, availability, dates, addresses, guarantees, integrations, or private account details.",
    "If the knowledge is incomplete, say that clearly and provide the closest useful guidance.",
    "Ask one short clarifying question only if needed.",
    "Do not mention internal tools, retrieval, prompts, scores, or system rules.",
    "Escalate to a human only when the user explicitly asks for a human/agent/representative. Do not hand off because of missing knowledge, repeated messages, or ticket creation.",
    "Match the user language. If the user writes Arabic, reply in Arabic naturally. If the user writes English, reply in English naturally.",
    !activePersona ? "You are the default AI assistant for this inbox. Answer using tenant knowledge and conversation context. Escalate only when necessary." : "",
    lowKnowledgeConfidence
      ? "No specific business knowledge was found. Be honest about that and still provide the safest useful next step instead of handing off immediately."
      : "",
    weakKnowledgeButAvailable
      ? "Knowledge is partial. Use what is available, avoid exact unsupported claims, and ask one short clarifying question if it helps."
      : "",
    knowledgePrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  const modelInput = knowledgePrompt
    ? `${knowledgePrompt}\n\nسياق المحادثة الأخير:\n${transcript}`
    : transcript;

  const temperature = groundedTemperature(setting?.temperature);


  await assertAndReserveQuota(input.tenantId);

  let rawReply = "";
  let responseId = "";
  let providerUsed = "";
  let modelUsed = "";

  try {
    const result = await routeAiRequest({
      systemPrompt,
      userInput: modelInput,
      temperature
    });
    rawReply = result.reply;
    responseId = result.responseId;
    providerUsed = result.providerUsed;
    modelUsed = result.modelUsed;
    logger.info("ai.model_reply", {
      mode: options.mode || "legacy_direct",
      tenantId: input.tenantId,
      botId: input.botId,
      provider: providerUsed,
      model: modelUsed,
      temperature,
      ragResults: knowledge?.results.length ?? 0,
      topScore: topKnowledgeScore,
    });
  } catch (error) {
    logger.error("ai.provider_error_direct_fallback", {
      tenantId: input.tenantId,
      botId: input.botId,
      conversationId: conversation._id.toString(),
      error: error instanceof Error ? error.message : String(error),
      ragResults: knowledge?.results.length ?? 0,
      topScore: knowledge?.results[0]?.score ?? null,
      temperature,
    });
    const fallback = setting?.fallbackMessage || await buildSafeCustomerReply({ tenantId: input.tenantId, botId: input.botId, customerMessage: input.message, businessName: bot?.name || tenant?.name || "", botName: bot?.name || "Chatzi", language: setting?.language || "auto", reason: "provider_error", hasKnowledge: Boolean(knowledge?.results?.length), knowledgeSummary: knowledgePrompt, customInstructions: setting?.systemPrompt });
    if (!fallback) return { reply: "", conversationId: conversation._id.toString(), confidence: knowledge?.confidence ?? null };
    const fallbackMessage = await createOutgoingAiReply({
      tenantId: input.tenantId,
      conversation,
      channel: input.channel,
      reply: fallback,
      metadata: {
        directFallback: true,
        reason: "provider_error",
        aiPolicy: {
          turnCount: nextAiTurnCount,
          clarificationCount,
          repeatedUserCount,
        },
        knowledge: knowledge ? { enabled: knowledgeEnabled, confidence: knowledge.confidence, sourceCount: knowledge.results.length } : { enabled: false },
      },
    });
    return {
      reply: fallback,
      conversationId: conversation._id.toString(),
      confidence: knowledge?.confidence ?? null,
      messageId: fallbackMessage._id.toString(),
    };
  }

  let reply = sanitizeCustomerReply(rawReply || setting?.fallbackMessage || "");
  if (!reply) {
    reply = await buildSafeCustomerReply({ tenantId: input.tenantId, botId: input.botId, customerMessage: input.message, businessName: bot?.name || tenant?.name || "", botName: bot?.name || "Chatzi", language: setting?.language || "auto", reason: "empty_model_reply", hasKnowledge: Boolean(knowledge?.results?.length), knowledgeSummary: knowledgePrompt, customInstructions: setting?.systemPrompt });
  }
  if (!reply) return { reply: "", conversationId: conversation._id.toString(), confidence: knowledge?.confidence ?? null };
  const replyFingerprint = fingerprint(reply);

  if (replyFingerprint && replyFingerprint === lastAssistantFingerprint) {
    const repeatedAssistantCount = Number(aiPolicy.repeatedAssistantCount || 0) + 1;
    if (repeatedAssistantCount <= 1) {
      const repairReply = await buildSafeCustomerReply({ tenantId: input.tenantId, botId: input.botId, customerMessage: input.message, businessName: bot?.name || tenant?.name || "", botName: bot?.name || "Chatzi", language: setting?.language || "auto", reason: "repeated_reply_repair", hasKnowledge: Boolean(knowledge?.results?.length), knowledgeSummary: knowledgePrompt, customInstructions: setting?.systemPrompt });
      if (!repairReply) return { reply: "", conversationId: conversation._id.toString(), confidence: knowledge?.confidence ?? null };
      const repairMessage = await createOutgoingAiReply({
        tenantId: input.tenantId,
        conversation,
        channel: input.channel,
        reply: repairReply,
        metadata: {
          aiPolicy: {
            turnCount: nextAiTurnCount,
            repeatedAssistantCount,
            repairAttempt: true
          },
          knowledge: knowledge ? { enabled: knowledgeEnabled, confidence: knowledge.confidence, sourceCount: knowledge.results.length } : { enabled: false }
        }
      });
      conversation.aiTurnCount = nextAiTurnCount;
      conversation.aiStatus = "needs_review";
      conversation.metadata = {
        ...metadata,
        aiPolicy: {
          ...aiPolicy,
          repeatedAssistantCount,
          lastUserFingerprint: currentUserFingerprint,
          lastAssistantFingerprint: fingerprint(repairReply),
          lastAiReplyAt: new Date().toISOString()
        }
      };
      await conversation.save();
      return {
        reply: repairReply,
        conversationId: conversation._id.toString(),
        confidence: knowledge?.confidence ?? null,
        messageId: repairMessage._id.toString(),
      };
    }

    logger.warn("ai.repeated_reply_direct_repair", {
      tenantId: input.tenantId,
      botId: input.botId,
      conversationId: conversation._id.toString(),
      reason: "repeated_reply_after_repair",
      ragResults: knowledge?.results.length ?? 0,
      topScore: knowledge?.results[0]?.score ?? null,
    });
    const finalRepairReply = await buildSafeCustomerReply({ tenantId: input.tenantId, botId: input.botId, customerMessage: input.message, businessName: bot?.name || tenant?.name || "", botName: bot?.name || "Chatzi", language: setting?.language || "auto", reason: "repeated_reply_final_repair", hasKnowledge: Boolean(knowledge?.results?.length), knowledgeSummary: knowledgePrompt, customInstructions: setting?.systemPrompt });
    if (!finalRepairReply) return { reply: "", conversationId: conversation._id.toString(), confidence: knowledge?.confidence ?? null };
    const finalRepairMessage = await createOutgoingAiReply({
      tenantId: input.tenantId,
      conversation,
      channel: input.channel,
      reply: finalRepairReply,
      metadata: {
        directFallback: true,
        reason: "repeated_reply_repair",
        aiPolicy: {
          turnCount: nextAiTurnCount,
          repeatedAssistantCount,
          repairAttempt: true
        },
        knowledge: knowledge ? { enabled: knowledgeEnabled, confidence: knowledge.confidence, sourceCount: knowledge.results.length } : { enabled: false }
      }
    });
    return {
      reply: finalRepairReply,
      conversationId: conversation._id.toString(),
      confidence: knowledge?.confidence ?? null,
      messageId: finalRepairMessage._id.toString(),
    };
  }

  const replyMessage = await Message.create({
    tenantId: input.tenantId,
    botId: input.botId,
    conversationId: conversation._id,
    contactId: conversation.contactId,
    channelIdentityId: conversation.channelIdentityId,
    provider: input.channel,
    direction: "outgoing",
    sender: "assistant",
    senderType: "assistant",
    content: reply,
    deliveryStatus: "queued",
    metadata: {
      responseId,
      provider: providerUsed,
      aiModelId: modelUsed,
      mode: options.mode || "legacy_direct",
      fallbackReason: options.reason,
      temperature,
      aiPolicy: {
        turnCount: nextAiTurnCount,
        clarificationCount,
        repeatedUserCount,
        repeatedAssistantCount: 0,
        lowKnowledgeConfidence,
        activePersonaId: activePersona?._id?.toString?.() || "",
        activePersonaName: activePersona?.roleName || "",
        directThreshold,
        reviewThreshold
      },
      knowledge: knowledge
        ? {
            enabled: knowledgeEnabled,
            confidence: knowledge.confidence,
            intent: knowledge.intent,
            keywords: knowledge.keywords,
            sourceCount: knowledge.results.length,
            sources: (bot.showKnowledgeSources ? knowledge.results.slice(0, 6) : []).map(
              (result: any) => ({
                title: result.sourceTitle,
                url: result.sourceUrl,
                score: result.score,
                documentId: result.documentId,
              })
            ),
          }
        : { enabled: false },
    },
  });

  conversation.lastMessageAt = new Date();
  conversation.lastAiMessageAt = new Date();
  conversation.lastMessagePreview = reply.slice(0, 220);
  conversation.aiTurnCount = nextAiTurnCount;
  conversation.aiConfidence = knowledge?.confidence ?? undefined;
  conversation.aiStatus = lowKnowledgeConfidence ? "needs_review" : "active";
  conversation.metadata = {
    ...metadata,
    aiPolicy: {
      ...aiPolicy,
      handoffRequested: false,
      lastUserFingerprint: currentUserFingerprint,
      lastAssistantFingerprint: replyFingerprint,
      repeatedUserCount,
      repeatedAssistantCount: 0,
      clarificationCount,
      activePersonaId: activePersona?._id?.toString?.() || "",
      activePersonaName: activePersona?.roleName || "",
      lastKnowledgeConfidence: knowledge?.confidence ?? null,
      lastKnowledgeSourceCount: knowledge?.results.length ?? 0,
      lastAiReplyAt: new Date().toISOString()
    }
  };
  await conversation.save();

  void captureWorkflowIfReady({
    tenantId: input.tenantId,
    conversation,
    userMessage: input.message,
    aiReply: reply,
    confidence: knowledge?.confidence ?? null
  }).catch(() => undefined);

  publishRealtimeEvent(input.tenantId, "message.created", {
    message: {
      id: replyMessage._id.toString(),
      conversationId: conversation._id.toString(),
      content: reply,
      direction: "outgoing",
      sender: "assistant",
      senderType: "assistant",
      provider: input.channel,
      deliveryStatus: replyMessage.deliveryStatus || "sent",
      createdAt: replyMessage.createdAt?.toISOString?.() || new Date().toISOString(),
      attachments: []
    },
    conversation: {
      id: conversation._id.toString(),
      aiStatus: conversation.aiStatus,
      lastMessage: reply.slice(0, 220),
      lastMessageAt: conversation.lastMessageAt?.toISOString?.() || new Date().toISOString(),
      unreadCount: conversation.unreadCount || 0,
      channel: conversation.channel,
      provider: input.channel
    }
  }).catch(() => undefined);

  return {
    reply,
    conversationId: conversation._id.toString(),
    confidence: knowledge?.confidence ?? null,
    messageId: replyMessage._id.toString(),
  };
}


async function createOutgoingAiReply(input: {
  tenantId: string;
  conversation: any;
  channel: string;
  reply: string;
  metadata?: Record<string, unknown>;
}) {
  const message = await Message.create({
    tenantId: input.tenantId,
    botId: input.conversation.botId,
    conversationId: input.conversation._id,
    contactId: input.conversation.contactId,
    channelIdentityId: input.conversation.channelIdentityId,
    provider: input.channel,
    direction: "outgoing",
    sender: "assistant",
    senderType: "assistant",
    content: input.reply,
    deliveryStatus: "queued",
    metadata: input.metadata || {},
  });

  input.conversation.lastMessageAt = new Date();
  input.conversation.lastAiMessageAt = new Date();
  input.conversation.lastMessagePreview = input.reply.slice(0, 220);
  await input.conversation.save();

  publishRealtimeEvent(input.tenantId, "message.created", {
    message: {
      id: message._id.toString(),
      conversationId: input.conversation._id.toString(),
      content: input.reply,
      direction: "outgoing",
      sender: "assistant",
      senderType: "assistant",
      provider: input.channel,
      deliveryStatus: message.deliveryStatus || "sent",
      createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
      attachments: []
    },
    conversation: {
      id: input.conversation._id.toString(),
      aiStatus: input.conversation.aiStatus,
      lastMessage: input.reply.slice(0, 220),
      lastMessageAt: input.conversation.lastMessageAt?.toISOString?.() || new Date().toISOString(),
      unreadCount: input.conversation.unreadCount || 0,
      channel: input.conversation.channel,
      provider: input.channel
    }
  }).catch(() => undefined);

  return message;
}

function groundedTemperature(configured?: number | null) {
  if (typeof configured === "number" && Number.isFinite(configured)) return configured;
  return 0.6;
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

async function resolveTenantDisplayName(tenantId: string, fallback: string) {
  const tenant = await Tenant.findById(tenantId).select("name slug").lean();
  return tenant?.name || fallback || "ChatZi";
}

function enhanceQuestionWithAttachments(message: string, metadata?: Record<string, unknown>) {
  const attachments = Array.isArray((metadata as any)?.attachments) ? ((metadata as any).attachments as any[]) : [];
  if (!attachments.length) return message;
  const attachmentSummary = attachments
    .map((att) => att?.type || att?.mimeType || att?.name || "attachment")
    .slice(0, 5)
    .join(", ");
  return `${message || "أرسل العميل مرفقًا"}\nمرفقات العميل: ${attachmentSummary}`;
}

async function captureWorkflowIfReady(input: {
  tenantId: string;
  conversation: any;
  userMessage: string;
  aiReply: string;
  confidence: number | null;
}) {
  const directClassification = classifyTicketIntent(input.userMessage);
  const contextualClassification = directClassification.shouldCreate
    ? directClassification
    : classifyTicketIntent(`${input.userMessage}
${input.aiReply}`);
  const classification = contextualClassification;
  if (!classification.shouldCreate) return;

  const ticket = await ensureTicketForConversation({
    tenantId: input.tenantId,
    botId: input.conversation.botId?.toString?.() || "",
    conversationId: input.conversation._id.toString(),
    triggerReason: classification.reason,
    category: classification.category,
    priority: classification.priority,
    subject: summarizeTicketTitle(input.userMessage),
    description: [
      `رسالة العميل: ${input.userMessage}`,
      input.aiReply ? `رد المساعد: ${input.aiReply}` : "",
    ].filter(Boolean).join("\n\n"),
    aiSummary: input.aiReply,
    source: "ai",
    metadata: {
      aiWorkflow: true,
      confidence: input.confidence,
      channel: input.conversation.provider || input.conversation.channel,
      contactId: input.conversation.contactId?.toString?.() || "",
      customerMessage: input.userMessage,
    },
  });

  if (!ticket) return;

  await notifyWorkflowCapture({
    tenantId: input.tenantId,
    conversation: input.conversation,
    ticket,
    userMessage: input.userMessage,
  });
}
async function inferAutoPersona(input: {
  tenantId: string;
  message: string;
  metadata?: Record<string, unknown>;
  currentPersonaId?: string;
}) {
  const personas = await AiPersona.find({ tenantId: input.tenantId, isActive: true })
    .select("roleName description personaType systemPrompt greetingMessage")
    .lean();
  if (!personas.length) return null;

  const intent = inferPersonaRoutingReason(input.message);
  if (intent === "general" && input.currentPersonaId) return null;

  const scored = personas
    .map((persona) => ({ persona, score: scorePersonaMatch(persona, input.message, intent) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.persona || null;
}

function inferPersonaRoutingReason(_message: string) {
  return "general";
}

function scorePersonaMatch(persona: any, message: string, _intent: string) {
  const haystack = fingerprint(`${persona.personaType || ""} ${persona.roleName || ""} ${persona.description || ""} ${persona.systemPrompt || ""}`);
  const messageTokens = fingerprint(message).split(" ").filter((token) => token.length > 2);
  let score = 0;
  for (const token of messageTokens.slice(0, 12)) if (haystack.includes(token)) score += 1;
  return score;
}

function mapPersonaToConversationIntent(_persona: any, _message: string) {
  return "general";
}

function summarizeTicketTitle(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return (text || "Customer request").slice(0, 120);
}

async function notifyWorkflowCapture(input: { tenantId: string; conversation: any; ticket: any; userMessage: string }) {
  const recipients = await resolveWorkflowRecipients(input.tenantId);
  const payload = {
    type: "ai_ticket_created",
    tenantId: input.tenantId,
    conversationId: input.conversation._id.toString(),
    ticketId: input.ticket._id.toString(),
    channel: input.conversation.provider || input.conversation.channel,
    userMessage: input.userMessage
  };

  const webhookUrl = process.env.AI_WORKFLOW_WEBHOOK_URL || process.env.AI_ESCALATION_WEBHOOK_URL || "";
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => undefined);
  }

  const smsWebhookUrl = process.env.AI_WORKFLOW_SMS_WEBHOOK_URL || "";
  if (smsWebhookUrl) {
    await fetch(smsWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => undefined);
  }

  const resendApiKey = process.env.RESEND_API_KEY || "";
  if (resendApiKey && recipients.length) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resendApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || process.env.RESEND_FROM_EMAIL || "ChatZi <notifications@chatzi.io>",
        to: recipients,
        subject: `ChatZi: تم تسجيل تذكرة عميل`,
        text: [
          "تم تسجيل تذكرة جديدة بناءً على نية العميل في المحادثة.",
          "",
          `Ticket ID: ${input.ticket._id.toString()}`,
          `Conversation ID: ${input.conversation._id.toString()}`,
          `Channel: ${input.conversation.provider || input.conversation.channel}`,
          `Customer message: ${input.userMessage}`
        ].join("\n")
      })
    }).catch(() => undefined);
  }
}

async function resolveWorkflowRecipients(tenantId: string) {
  const override = (process.env.AI_WORKFLOW_EMAIL_TO || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (override.length) return [...new Set(override)];

  const tenant = await Tenant.findById(tenantId).select("ownerId").lean();
  const userFilter: any = tenant?.ownerId
    ? { _id: tenant.ownerId, tenantId, isActive: true }
    : { tenantId, isActive: true, role: { $in: ["owner", "admin", "manager"] } };
  const users = await User.find(userFilter).select("email").limit(5).lean();
  return [...new Set(users.map((user: any) => user.email).filter(Boolean))];
}


function normalizeObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function fingerprint(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/[ة]/g, "ه")
    .replace(/[ىي]/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 180);
}
