export function normalizeForIntent(value: string) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isExplicitHumanHandoffRequest(_message: string) {
  return false;
}
