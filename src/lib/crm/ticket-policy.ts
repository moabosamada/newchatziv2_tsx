import rawPolicy from "@/config/crm-ticket-policy.json";
import type { TicketCategory, TicketPriority } from "@/lib/tickets";

export type TicketRequiredField = "name" | "phone" | "issueDescription";

export type CrmTicketPolicy = {
  version: number;
  requiredFields: TicketRequiredField[];
  categories: Array<{ id: TicketCategory; defaultPriority: TicketPriority }>;
  defaultPriority: TicketPriority;
  classifierMode: "ai_structured_json";
  customerVisibleTextPolicy: "ai_generated_only";
  contextSwitchHandling: "pause_ticket_flow_and_answer_current_message";
};

const validRequiredFields = new Set<TicketRequiredField>(["name", "phone", "issueDescription"]);
const validCategories = new Set<TicketCategory>([
  "technical_support", "complaint", "human_request", "booking_request", "sales_request", "ai_failed", "general",
]);
const validPriorities = new Set<TicketPriority>(["low", "medium", "high", "urgent"]);

function sanitizeRequiredFields(value: unknown): TicketRequiredField[] {
  const items = Array.isArray(value) ? value : [];
  const clean = items.filter((field): field is TicketRequiredField => validRequiredFields.has(field as TicketRequiredField));
  return clean.length ? clean : ["name", "phone", "issueDescription"];
}

function sanitizeCategories(value: unknown): CrmTicketPolicy["categories"] {
  const items = Array.isArray(value) ? value : [];
  const clean = items
    .map((item: any) => ({ id: String(item?.id || "") as TicketCategory, defaultPriority: String(item?.defaultPriority || "medium") as TicketPriority }))
    .filter((item) => validCategories.has(item.id) && validPriorities.has(item.defaultPriority));
  return clean.length ? clean : [
    { id: "technical_support", defaultPriority: "high" },
    { id: "complaint", defaultPriority: "high" },
    { id: "human_request", defaultPriority: "medium" },
    { id: "booking_request", defaultPriority: "medium" },
    { id: "sales_request", defaultPriority: "medium" },
    { id: "ai_failed", defaultPriority: "medium" },
    { id: "general", defaultPriority: "medium" },
  ];
}

function settingPolicyRequiredFields(settingPolicy: unknown) {
  const policy = settingPolicy && typeof settingPolicy === "object" ? (settingPolicy as any) : null;
  if (Array.isArray(policy?.requiredFields)) return policy.requiredFields;
  const fields: TicketRequiredField[] = [];
  if (policy?.requireName !== false) fields.push("name");
  if (policy?.requirePhone !== false) fields.push("phone");
  if (policy?.requireDescription !== false) fields.push("issueDescription");
  return fields.length ? fields : undefined;
}

export function getCrmTicketPolicy(settingPolicy?: unknown): CrmTicketPolicy {
  const source = rawPolicy as any;
  const priority = String(source.defaultPriority || "medium") as TicketPriority;
  return {
    version: Number(source.version || 1),
    requiredFields: sanitizeRequiredFields(settingPolicyRequiredFields(settingPolicy) || source.defaultRequiredFields),
    categories: sanitizeCategories(source.categories),
    defaultPriority: validPriorities.has(priority) ? priority : "medium",
    classifierMode: "ai_structured_json",
    customerVisibleTextPolicy: "ai_generated_only",
    contextSwitchHandling: "pause_ticket_flow_and_answer_current_message",
  };
}

export function priorityForCategory(policy: CrmTicketPolicy, category: TicketCategory): TicketPriority {
  return policy.categories.find((item) => item.id === category)?.defaultPriority || policy.defaultPriority;
}

export function isAllowedTicketCategory(policy: CrmTicketPolicy, category: string): category is TicketCategory {
  return policy.categories.some((item) => item.id === category);
}

export function isAllowedPriority(priority: string): priority is TicketPriority {
  return validPriorities.has(priority as TicketPriority);
}
