import { Conversation } from "@/lib/models";
import type { TicketCategory, TicketIntentClassification, TicketPriority } from "@/lib/tickets";
import { classifyTicketMessageWithAi } from "@/lib/crm/ticket-ai-classifier";
import { getCrmTicketPolicy, priorityForCategory, type CrmTicketPolicy, type TicketRequiredField } from "@/lib/crm/ticket-policy";

export type { TicketRequiredField } from "@/lib/crm/ticket-policy";

export type TicketFlowAction = "none" | "ask_missing_fields" | "answer_current_message" | "create_ticket";
export type TicketFlowState = {
  version: 1;
  status: "collecting_required_fields" | "paused_for_context" | "ready_to_create" | "created";
  category: TicketCategory;
  priority: TicketPriority;
  reason: string;
  requiredFields: TicketRequiredField[];
  missingFields: TicketRequiredField[];
  collectedFields: Partial<Record<TicketRequiredField, string>>;
  startedAt: string;
  updatedAt: string;
  lastCustomerMessage?: string;
  lastInterruptReason?: string;
  ticketId?: string;
  ticketNumber?: number;
};
export type TicketFlowResult = {
  action: TicketFlowAction;
  state?: TicketFlowState;
  category?: TicketCategory;
  priority?: TicketPriority;
  reason?: string;
  missingFields?: TicketRequiredField[];
  collectedFields?: Partial<Record<TicketRequiredField, string>>;
  interrupted?: boolean;
  readyToCreate?: boolean;
};

function normalizePhone(value?: string | null) {
  if (!value) return "";
  const cleaned = String(value).replace(/[^\d+]/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? cleaned : "";
}
function cleanField(value: unknown, field: TicketRequiredField) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (field === "phone") return normalizePhone(raw);
  return raw.slice(0, field === "issueDescription" ? 1200 : 120);
}
export function extractTicketFieldsFromMessage() { return {} as Partial<Record<TicketRequiredField, string>>; }
function asTicketFlowState(value: unknown): TicketFlowState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as TicketFlowState;
  if (state.version !== 1) return null;
  if (!state.category || !Array.isArray(state.requiredFields)) return null;
  if (state.status === "created") return null;
  return state;
}
function mergeFields(requiredFields: TicketRequiredField[], previous: Partial<Record<TicketRequiredField, string>> | undefined, next: Partial<Record<TicketRequiredField, string>>) {
  return requiredFields.reduce((acc, field) => {
    const value = cleanField(next[field] || previous?.[field] || "", field);
    if (value) acc[field] = value;
    return acc;
  }, {} as Partial<Record<TicketRequiredField, string>>);
}
function missingFields(requiredFields: TicketRequiredField[], fields: Partial<Record<TicketRequiredField, string>>) {
  return requiredFields.filter((field) => !cleanField(fields[field], field));
}
async function saveState(input: { tenantId: string; botId: string; conversationId: string; state: TicketFlowState }) {
  await Conversation.updateOne({ _id: input.conversationId, tenantId: input.tenantId, botId: input.botId }, { $set: { "metadata.crmTicketFlow": input.state } });
}
export async function clearTicketFlow(input: { tenantId: string; botId: string; conversationId: string; ticketId?: string; ticketNumber?: number }) {
  const now = new Date().toISOString();
  await Conversation.updateOne({ _id: input.conversationId, tenantId: input.tenantId, botId: input.botId }, { $set: { "metadata.crmTicketFlow.status": "created", "metadata.crmTicketFlow.ticketId": input.ticketId || "", "metadata.crmTicketFlow.ticketNumber": input.ticketNumber || 0, "metadata.crmTicketFlow.updatedAt": now } });
}

export async function processTicketFlow(input: {
  tenantId: string;
  botId: string;
  conversationId: string;
  message: string;
  conversationMetadata?: Record<string, unknown> | null;
  detectedIntent?: TicketIntentClassification | null;
  ticketPolicy?: unknown;
  languageMode?: string;
  businessCategory?: string;
  businessSubcategory?: string;
  customInstructionsEn?: string;
}) : Promise<TicketFlowResult> {
  const now = new Date().toISOString();
  const metadata = input.conversationMetadata || {};
  const activeState = asTicketFlowState((metadata as any).crmTicketFlow);
  const policy: CrmTicketPolicy = getCrmTicketPolicy(input.ticketPolicy);
  const requiredFields = activeState?.requiredFields?.length ? activeState.requiredFields : policy.requiredFields;
  const requestedCategory = input.detectedIntent?.shouldCreate ? input.detectedIntent.category : undefined;
  const requestedPriority = input.detectedIntent?.shouldCreate ? input.detectedIntent.priority : undefined;
  const classification = await classifyTicketMessageWithAi({ tenantId: input.tenantId, botId: input.botId, message: input.message, policy, activeState, languageMode: input.languageMode, businessCategory: input.businessCategory, businessSubcategory: input.businessSubcategory, customInstructionsEn: input.customInstructionsEn, requestedCategory, requestedPriority, reasonHint: input.detectedIntent?.reason });

  if (activeState && (classification.action === "answer_current_message" || classification.action === "cancel_ticket_flow")) {
    const state: TicketFlowState = { ...activeState, status: "paused_for_context", updatedAt: now, lastCustomerMessage: input.message, lastInterruptReason: classification.reason || classification.action };
    await saveState({ ...input, state });
    return { action: "answer_current_message", state, category: state.category, priority: state.priority, reason: classification.reason || "ticket_flow_paused", missingFields: state.missingFields, collectedFields: state.collectedFields, interrupted: true };
  }

  if (activeState) {
    const fields = mergeFields(requiredFields, activeState.collectedFields, classification.collectedFields);
    const missing = missingFields(requiredFields, fields);
    const state: TicketFlowState = { ...activeState, status: missing.length ? "collecting_required_fields" : "ready_to_create", collectedFields: fields, missingFields: missing, requiredFields, updatedAt: now, lastCustomerMessage: input.message };
    await saveState({ ...input, state });
    return { action: missing.length ? "ask_missing_fields" : "create_ticket", state, category: state.category, priority: state.priority, reason: missing.length ? "ticket_required_fields_missing" : "ticket_required_fields_complete", missingFields: missing, collectedFields: fields, readyToCreate: missing.length === 0 };
  }

  const shouldStart = classification.action === "start_ticket_flow" || classification.action === "continue_ticket_flow";
  if (!shouldStart) return { action: "none" };

  const category = classification.category || requestedCategory || "general";
  const priority = classification.priority || requestedPriority || priorityForCategory(policy, category);
  const fields = mergeFields(requiredFields, undefined, classification.collectedFields);
  const missing = missingFields(requiredFields, fields);
  const state: TicketFlowState = { version: 1, status: missing.length ? "collecting_required_fields" : "ready_to_create", category, priority, reason: classification.reason || input.detectedIntent?.reason || "crm_ticket_flow_started", requiredFields, missingFields: missing, collectedFields: fields, startedAt: now, updatedAt: now, lastCustomerMessage: input.message };
  await saveState({ ...input, state });
  return { action: missing.length ? "ask_missing_fields" : "create_ticket", state, category: state.category, priority: state.priority, reason: missing.length ? "ticket_required_fields_missing" : "ticket_required_fields_complete", missingFields: missing, collectedFields: fields, readyToCreate: missing.length === 0 };
}

export function buildTicketFlowContext(flow?: TicketFlowResult) {
  if (!flow || flow.action === "none" || !flow.state) return "";
  const fields = flow.state.collectedFields || {};
  const parts = [
    `crmTicketFlow.action=${flow.action}`,
    `crmTicketFlow.status=${flow.state.status}`,
    `crmTicketFlow.category=${flow.state.category}`,
    `crmTicketFlow.requiredFields=${flow.state.requiredFields.join(",")}`,
    `crmTicketFlow.missingFields=${flow.state.missingFields.join(",") || "none"}`,
    `crmTicketFlow.hasName=${Boolean(fields.name)}`,
    `crmTicketFlow.hasPhone=${Boolean(fields.phone)}`,
    `crmTicketFlow.hasIssueDescription=${Boolean(fields.issueDescription)}`,
    "crmTicketFlow.customerVisibleTextPolicy=AI_GENERATED_ONLY",
  ];
  if (flow.action === "ask_missing_fields") parts.push("crmTicketFlow.replyGoal=Generate a natural customer-facing reply asking only for the missing required fields. Do not say a ticket is created yet. Match the customer's language and bot settings.");
  if (flow.action === "answer_current_message") parts.push("crmTicketFlow.replyGoal=The customer switched topics temporarily. Answer the current question from business knowledge first. Keep the pending ticket flow open silently.");
  if (flow.action === "create_ticket") parts.push("crmTicketFlow.replyGoal=The required ticket fields are complete. The system will create the CRM ticket. After creation, generate a natural confirmation in the customer's language.");
  return parts.join("; ");
}
