import { routeAiRequest } from "@/lib/ai-router";
import { buildUnifiedSystemPrompt } from "@/lib/ai/build-system-prompt";
import { logger } from "@/lib/logger";

export type FastIntentKind =
  | "greeting"
  | "thanks"
  | "goodbye"
  | "out_of_scope"
  | "unclear"
  | "identity"
  | "business";

export type FastIntentResult = {
  handled: boolean;
  intent: FastIntentKind;
  language: string;
  reply?: string;
  confidence: number;
  modelCalled: boolean;
  providerUsed?: string;
  modelUsed?: string;
  reason?: string;
};

export type FastIntentResponderInput = {
  tenantId: string;
  botId: string;
  message: string;
  businessName?: string;
  botName?: string;
  role?: string;
  tone?: string;
  responseLength?: string;
  language?: string;
  fallbackMessage?: string;
  customInstructions?: string;
  useEmojis?: boolean;
};

const HANDLED_INTENTS = new Set(["greeting", "thanks", "goodbye", "out_of_scope", "unclear", "identity"]);

function shouldUseFastResponder(message: string) {
  const text = String(message || "").trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  const hasQuestionMark = /[؟?]/.test(text);

  // The fast AI responder is intentionally limited to lightweight turns.
  // Business questions with enough context go straight to Knowledge/Mastra CRM.
  return text.length <= Number(process.env.AI_FAST_RESPONDER_MAX_CHARS || 240) || words <= 16 || hasQuestionMark;
}

function extractJsonObject(value: string) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeIntent(value: unknown): FastIntentKind {
  const intent = String(value || "business").trim().toLowerCase();
  if (intent === "greeting" || intent === "thanks" || intent === "goodbye" || intent === "out_of_scope" || intent === "unclear" || intent === "identity") {
    return intent;
  }
  return "business";
}

function normalizeConfidence(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 1) return Math.round(numeric * 100);
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

export async function detectAndReplyFast(input: FastIntentResponderInput): Promise<FastIntentResult> {
  if (!shouldUseFastResponder(input.message)) {
    return {
      handled: false,
      intent: "business",
      language: input.language || "auto",
      confidence: 0,
      modelCalled: false,
      reason: "message_not_fast_candidate",
    };
  }

  const systemPrompt = [
    buildUnifiedSystemPrompt({
      businessName: input.businessName || input.botName,
      botName: input.botName,
      role: input.role,
      tone: input.tone,
      responseLength: input.responseLength,
      language: input.language || "auto",
      customInstructions: input.customInstructions,
      useEmojis: input.useEmojis,
    }),
    "Fast responder mode: classify lightweight customer messages and generate a short customer-facing reply only when the message is safe to answer without business knowledge.",
    "Do not use detailed business knowledge here. Do not invent business facts. Do not mention internal systems.",
    "If the message is a business question, booking request, sales request, support request, complaint, price question, service/product question, or anything that needs knowledge, set intent to business and handled to false and do not write a customer reply.",
    "If the message is only a greeting, identity question, thanks, goodbye, clearly unrelated general-topic question, or too unclear to route, set handled to true and write one concise human reply.",
    "For out_of_scope, politely say you are specialized in this business and invite the customer to ask about services, booking, pricing, policies, or support. Do not answer the general question itself.",
    "Return strict JSON only. No markdown.",
  ].join("\n");

  const userInput = JSON.stringify({
    businessName: input.businessName || input.botName || "this business",
    botName: input.botName || "Chatzi assistant",
    configuredLanguage: input.language || "auto",
    role: input.role || "assistant",
    tone: input.tone || "friendly",
    responseLength: input.responseLength || "short",
    allowedIntents: ["greeting", "thanks", "goodbye", "out_of_scope", "unclear", "identity", "business"],
    requiredJsonShape: {
      handled: "boolean",
      intent: "greeting|thanks|goodbye|out_of_scope|unclear|identity|business",
      language: "BCP-47 or short language code",
      confidence: "0-100",
      reply: "string only when handled is true",
    },
    customInstructions: input.customInstructions || "",
    customerMessage: input.message,
  });

  try {
    const result = await routeAiRequest({
      systemPrompt,
      userInput,
      temperature: Number(process.env.AI_FAST_RESPONDER_TEMPERATURE || 0.1),
    });
    const parsed = extractJsonObject(result.reply);
    if (!parsed) {
      return {
        handled: false,
        intent: "business",
        language: input.language || "auto",
        confidence: 0,
        modelCalled: true,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        reason: "invalid_fast_responder_json",
      };
    }

    const intent = normalizeIntent(parsed.intent);
    const confidence = normalizeConfidence(parsed.confidence);
    const reply = String(parsed.reply || "").trim();
    const handled = Boolean(parsed.handled) && HANDLED_INTENTS.has(intent) && Boolean(reply) && confidence >= Number(process.env.AI_FAST_RESPONDER_MIN_CONFIDENCE || 75);

    return {
      handled,
      intent,
      language: String(parsed.language || input.language || "auto"),
      reply: handled ? reply : undefined,
      confidence,
      modelCalled: true,
      providerUsed: result.providerUsed,
      modelUsed: result.modelUsed,
      reason: handled ? `ai_fast_${intent}` : "fast_responder_not_confident_or_business",
    };
  } catch (error) {
    logger.warn("ai.fast_responder_failed", {
      tenantId: input.tenantId,
      botId: input.botId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      handled: false,
      intent: "business",
      language: input.language || "auto",
      confidence: 0,
      modelCalled: true,
      reason: "fast_responder_error",
    };
  }
}
