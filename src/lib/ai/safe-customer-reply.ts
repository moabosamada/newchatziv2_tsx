import { routeAiRequest } from "@/lib/ai-router";
import { buildUnifiedSystemPrompt } from "@/lib/ai/build-system-prompt";
import { logger } from "@/lib/logger";

export async function buildSafeCustomerReply(input: {
  tenantId: string;
  botId?: string;
  customerMessage: string;
  businessName?: string;
  botName?: string;
  language?: string;
  intent?: string;
  reason?: string;
  hasKnowledge?: boolean;
  customInstructions?: string;
  knowledgeSummary?: string;
  contextSummary?: string;
}) {
  try {
    const systemPrompt = buildUnifiedSystemPrompt({
      businessName: input.businessName,
      botName: input.botName,
      language: input.language || "auto",
      customInstructions: input.customInstructions,
      knowledgeInstructions: input.knowledgeSummary,
      contextSummary: input.contextSummary,
      tone: "professional, helpful, marketing-aware, concise",
      responseLength: "short",
    });

    const userInput = JSON.stringify({
      task: "Generate one safe customer-facing reply in the customer's language. Do not use a canned phrase. Do not invent business facts.",
      customerMessage: input.customerMessage,
      detectedIntent: input.intent || "unknown",
      reason: input.reason || "fallback_needed",
      hasKnowledge: Boolean(input.hasKnowledge),
      requirement: input.hasKnowledge
        ? "Use the available business context and give the closest useful answer."
        : "Ask one natural concise clarification question or offer the closest next step within the business scope.",
    });

    const result = await routeAiRequest({ systemPrompt, userInput, temperature: 0.2 });
    return String(result.reply || "").trim();
  } catch (error) {
    logger.warn("ai.safe_customer_reply_failed", {
      tenantId: input.tenantId,
      botId: input.botId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}
