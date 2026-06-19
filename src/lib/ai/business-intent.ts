export type BusinessIntent =
  | "identity" | "services" | "products" | "prices" | "offers" | "contact" | "location" | "hours" | "appointment" | "doctor" | "faq" | "support" | "complaint" | "business" | "out_of_scope" | "unknown";

export function normalizeIntentText(input: string) {
  return String(input || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectBusinessIntent(message: string): BusinessIntent {
  return normalizeIntentText(message) ? "business" : "unknown";
}

export function entityTypesForIntent(_intent: BusinessIntent) {
  return [] as string[];
}

export function isDirectKnowledgeIntent(intent: BusinessIntent) {
  return intent !== "unknown";
}
