import { routeAiRequest } from "@/lib/ai-router";
import { logger } from "@/lib/logger";
import type { TicketCategory, TicketPriority } from "@/lib/tickets";
import type { CrmTicketPolicy, TicketRequiredField } from "@/lib/crm/ticket-policy";
import { isAllowedPriority, isAllowedTicketCategory, priorityForCategory } from "@/lib/crm/ticket-policy";
import type { TicketFlowState } from "@/lib/crm/ticket-flow-engine";

export type TicketClassifierAction = "none" | "start_ticket_flow" | "continue_ticket_flow" | "answer_current_message" | "cancel_ticket_flow";
export type TicketAiClassification = {
  action: TicketClassifierAction;
  category?: TicketCategory;
  priority?: TicketPriority;
  reason?: string;
  confidence?: number;
  collectedFields: Partial<Record<TicketRequiredField, string>>;
};

function extractJsonObject(value: string) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as any; } catch { return null; }
}
function cleanField(value: unknown, max = 500) { return String(value || "").trim().slice(0, max); }
function normalizePhone(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? cleaned : "";
}
function sanitizeFields(value: any): TicketAiClassification["collectedFields"] {
  const fields = value && typeof value === "object" ? value : {};
  const cleaned: TicketAiClassification["collectedFields"] = {};
  const name = cleanField(fields.name, 120);
  const phone = normalizePhone(fields.phone);
  const issueDescription = cleanField(fields.issueDescription, 1200);
  if (name) cleaned.name = name;
  if (phone) cleaned.phone = phone;
  if (issueDescription) cleaned.issueDescription = issueDescription;
  return cleaned;
}
function sanitizeClassification(raw: any, policy: CrmTicketPolicy): TicketAiClassification {
  const action = ["none", "start_ticket_flow", "continue_ticket_flow", "answer_current_message", "cancel_ticket_flow"].includes(String(raw?.action)) ? String(raw.action) as TicketClassifierAction : "none";
  const rawCategory = String(raw?.category || "general");
  const category = isAllowedTicketCategory(policy, rawCategory) ? rawCategory : "general";
  const rawPriority = String(raw?.priority || priorityForCategory(policy, category));
  const priority = isAllowedPriority(rawPriority) ? rawPriority : priorityForCategory(policy, category);
  return { action, category, priority, reason: cleanField(raw?.reason, 180) || action, confidence: Math.max(0, Math.min(1, Number(raw?.confidence || 0))), collectedFields: sanitizeFields(raw?.collectedFields) };
}

export async function classifyTicketMessageWithAi(input: {
  tenantId: string;
  botId?: string;
  message: string;
  policy: CrmTicketPolicy;
  activeState?: TicketFlowState | null;
  languageMode?: string;
  businessCategory?: string;
  businessSubcategory?: string;
  customInstructionsEn?: string;
  requestedCategory?: TicketCategory;
  requestedPriority?: TicketPriority;
  reasonHint?: string;
}): Promise<TicketAiClassification> {
  const systemPrompt = [
    "You are a structured CRM policy engine for an omnichannel SaaS.",
    "Return strict JSON only. Do not write customer-facing text.",
    "Decide whether the latest message starts a ticket flow, continues an active ticket flow, temporarily switches to an informational conversation, cancels a pending flow, or does nothing.",
    "A formal ticket must not be created until all policy.requiredFields are collected.",
    "If a pending flow exists and the customer asks for business information instead of providing missing fields, set action='answer_current_message' and keep the flow pending.",
    "Use semantic meaning, not language-specific keyword rules. Support any customer language.",
    "Extract only fields explicitly provided by the customer. Do not infer name, phone, or issue description.",
  ].join("\n");
  const userInput = JSON.stringify({
    latestCustomerMessage: input.message,
    activeTicketFlow: input.activeState ? { status: input.activeState.status, category: input.activeState.category, priority: input.activeState.priority, requiredFields: input.activeState.requiredFields, missingFields: input.activeState.missingFields, collectedFields: input.activeState.collectedFields } : null,
    policy: { requiredFields: input.policy.requiredFields, allowedCategories: input.policy.categories, defaultPriority: input.policy.defaultPriority, customerVisibleTextPolicy: input.policy.customerVisibleTextPolicy },
    hints: { requestedCategory: input.requestedCategory || null, requestedPriority: input.requestedPriority || null, reasonHint: input.reasonHint || null, languageMode: input.languageMode || "auto", businessCategory: input.businessCategory || "", businessSubcategory: input.businessSubcategory || "", customInstructionsEn: input.customInstructionsEn || "" },
    jsonShape: { action: "none | start_ticket_flow | continue_ticket_flow | answer_current_message | cancel_ticket_flow", category: "one of policy.allowedCategories[].id", priority: "low | medium | high | urgent", collectedFields: { name: "", phone: "", issueDescription: "" }, reason: "short internal reason code", confidence: 0.0 },
  });
  try {
    const result = await routeAiRequest({ systemPrompt, userInput, temperature: 0 });
    return sanitizeClassification(extractJsonObject(result.reply), input.policy);
  } catch (error) {
    logger.warn("crm.ticket_classifier_failed", { tenantId: input.tenantId, botId: input.botId, error: error instanceof Error ? error.message : String(error) });
    return { action: input.activeState ? "continue_ticket_flow" : "none", category: input.activeState?.category || input.requestedCategory || "general", priority: input.activeState?.priority || input.requestedPriority || priorityForCategory(input.policy, input.requestedCategory || "general"), reason: "ticket_classifier_unavailable", confidence: 0, collectedFields: {} };
  }
}
