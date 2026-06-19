import { Types } from "mongoose";
import { KnowledgeEntity } from "@/lib/models/knowledge-entity";
import { connectToDatabase } from "@/lib/mongodb";
import { routeAiRequest } from "@/lib/ai-router";
import { entityTypesForIntent, type BusinessIntent } from "@/lib/ai/business-intent";
import { logger } from "@/lib/logger";

export type KnowledgeEntityType =
  | "service"
  | "product"
  | "price"
  | "offer"
  | "doctor"
  | "branch"
  | "contact"
  | "faq"
  | "policy"
  | "appointment_rule"
  | "business_info"
  | "payment"
  | "delivery"
  | "support";

export type KnowledgeEntitySearchResult = {
  id: string;
  type: KnowledgeEntityType;
  name: string;
  description: string;
  category: string;
  price: string;
  availability: string;
  url: string;
  aliases: string[];
  keywords: string[];
  sourceText: string;
  confidence: number;
  score: number;
};

const ALLOWED_TYPES = new Set<KnowledgeEntityType>([
  "service",
  "product",
  "price",
  "offer",
  "doctor",
  "branch",
  "contact",
  "faq",
  "policy",
  "appointment_rule",
  "business_info",
  "payment",
  "delivery",
  "support",
]);

export function normalizeArabicText(input: string) {
  return String(input || "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/اال/g, "ال")
    .replace(/اأ/g, "الا")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(input: string) {
  return normalizeArabicText(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function scoreEntity(entity: any, queryTokens: string[], query: string) {
  const haystack = normalizeArabicText([
    entity.name,
    entity.description,
    entity.category,
    entity.price,
    entity.availability,
    ...(entity.aliases || []),
    ...(entity.keywords || []),
  ].filter(Boolean).join(" "));
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 18;
  }
  if (haystack.includes(query)) score += 35;
  if (entity.normalizedName && query.includes(entity.normalizedName)) score += 45;
  return Math.min(100, Math.round(score + Number(entity.confidence || 0.7) * 10));
}

function extractJsonObject(value: string) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as any; } catch { return null; }
}

function sanitizeEntity(raw: any) {
  const type = String(raw?.type || "").trim() as KnowledgeEntityType;
  const name = String(raw?.name || "").trim();
  if (!ALLOWED_TYPES.has(type) || !name) return null;
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 12) : [];
  const keywords = Array.isArray(raw.keywords) ? raw.keywords.map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 20) : [];
  return {
    type,
    name,
    description: String(raw.description || "").trim().slice(0, 1200),
    category: String(raw.category || "").trim().slice(0, 160),
    price: String(raw.price || "").trim().slice(0, 160),
    availability: String(raw.availability || "").trim().slice(0, 160),
    url: String(raw.url || "").trim().slice(0, 400),
    aliases,
    keywords,
    confidence: Math.max(0.1, Math.min(1, Number(raw.confidence || 0.7))),
  };
}

function lexicalEntityFallback(_text: string) {
  return [] as Array<{ type: KnowledgeEntityType; name: string; keywords: string[]; description: string; category: string; price: string; availability: string; url: string; aliases: string[]; confidence: number }>;
}

export async function extractAndStoreKnowledgeEntities(input: {
  tenantId: string;
  botId: string;
  documentId: string;
  chunks: Array<{ _id?: any; text: string }>;
  documentTitle?: string;
}) {
  await connectToDatabase();
  await KnowledgeEntity.deleteMany({ tenantId: input.tenantId, documentId: input.documentId });

  const allEntities: any[] = [];
  const textForAi = input.chunks.map((chunk, index) => `Chunk ${index + 1}:\n${chunk.text}`).join("\n\n").slice(0, Number(process.env.KNOWLEDGE_ENTITY_EXTRACTION_MAX_CHARS || 12000));

  try {
    const systemPrompt = [
      "Extract structured CRM knowledge entities from the supplied business knowledge text.",
      "Return strict JSON only. Do not write prose.",
      "Extract services, products, prices, offers, doctors, branches, contact info, FAQs, policies, appointment rules, business info, payment, delivery, and support items.",
      "Do not invent entities. Use the source language. Normalize obvious OCR noise when naming entities.",
    ].join("\n");
    const userInput = JSON.stringify({
      documentTitle: input.documentTitle || "Knowledge document",
      allowedTypes: Array.from(ALLOWED_TYPES),
      jsonShape: { entities: [{ type: "service", name: "", description: "", category: "", price: "", availability: "", aliases: [], keywords: [], confidence: 0.8 }] },
      text: textForAi,
    });
    const result = await routeAiRequest({ systemPrompt, userInput, temperature: 0.05 });
    const parsed = extractJsonObject(result.reply);
    if (Array.isArray(parsed?.entities)) {
      for (const raw of parsed.entities) {
        const entity = sanitizeEntity(raw);
        if (entity) allEntities.push(entity);
      }
    }
  } catch (error) {
    logger.warn("knowledge.entities.ai_extraction_failed", {
      tenantId: input.tenantId,
      documentId: input.documentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!allEntities.length) {
    for (const chunk of input.chunks) allEntities.push(...lexicalEntityFallback(chunk.text));
  }

  const unique = new Map<string, any>();
  for (const entity of allEntities) {
    const key = `${entity.type}:${normalizeArabicText(entity.name)}`;
    if (!unique.has(key)) unique.set(key, entity);
  }

  const docs = Array.from(unique.values()).slice(0, Number(process.env.KNOWLEDGE_ENTITY_LIMIT_PER_DOCUMENT || 120)).map((entity) => {
    const normalizedName = normalizeArabicText(entity.name);
    const normalizedSearchText = normalizeArabicText([
      entity.name,
      entity.description,
      entity.category,
      entity.price,
      entity.availability,
      ...(entity.aliases || []),
      ...(entity.keywords || []),
    ].join(" "));
    return {
      tenantId: input.tenantId,
      botId: input.botId,
      documentId: input.documentId,
      type: entity.type,
      name: entity.name,
      description: entity.description || "",
      category: entity.category || "",
      price: entity.price || "",
      availability: entity.availability || "",
      url: entity.url || "",
      aliases: entity.aliases || [],
      keywords: entity.keywords || [],
      normalizedName,
      normalizedSearchText,
      sourceText: entity.description || entity.name,
      confidence: entity.confidence || 0.7,
      metadata: { extractedBy: "knowledge-entities" },
    };
  });

  if (docs.length) await KnowledgeEntity.insertMany(docs, { ordered: false }).catch(async () => {
    for (const doc of docs) await KnowledgeEntity.create(doc).catch(() => null);
  });

  logger.info("knowledge.entities_extracted", { tenantId: input.tenantId, documentId: input.documentId, count: docs.length });
  return docs.length;
}

export async function searchKnowledgeEntities(input: {
  tenantId: string;
  botId?: string;
  query: string;
  intent?: BusinessIntent | string;
  limit?: number;
}) {
  await connectToDatabase();
  const limit = Math.min(20, Math.max(1, Number(input.limit || 8)));
  const normalizedQuery = normalizeArabicText(input.query);
  const queryTokens = tokens(input.query);
  const typeFilter = entityTypesForIntent((input.intent || "business") as BusinessIntent);
  const filter: Record<string, any> = { tenantId: input.tenantId };
  if (input.botId && Types.ObjectId.isValid(input.botId)) filter.botId = input.botId;
  if (typeFilter.length) filter.type = { $in: typeFilter };

  const regexTokens = queryTokens.slice(0, 6).map((token) => ({ normalizedSearchText: { $regex: token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }));
  const candidates = await KnowledgeEntity.find(regexTokens.length ? { ...filter, $or: regexTokens } : filter)
    .sort({ confidence: -1, updatedAt: -1 })
    .limit(Number(process.env.KNOWLEDGE_ENTITY_CANDIDATE_LIMIT || 80))
    .lean();

  const scored = candidates
    .map((entity: any) => ({ entity, score: scoreEntity(entity, queryTokens, normalizedQuery) }))
    .filter((item) => item.score > 0 || typeFilter.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entity, score }) => ({
      id: entity._id.toString(),
      type: entity.type,
      name: entity.name,
      description: entity.description || "",
      category: entity.category || "",
      price: entity.price || "",
      availability: entity.availability || "",
      url: entity.url || "",
      aliases: entity.aliases || [],
      keywords: entity.keywords || [],
      sourceText: entity.sourceText || "",
      confidence: entity.confidence || 0.7,
      score,
    })) as KnowledgeEntitySearchResult[];

  return { entities: scored, count: scored.length, source: "entities" as const, normalizedQuery };
}

export function buildEntitiesPrompt(input: { intent?: string; entities: KnowledgeEntitySearchResult[]; question: string }) {
  if (!input.entities.length) return "";
  const lines = input.entities.slice(0, 12).map((entity, index) => {
    const parts = [
      `${index + 1}. [${entity.type}] ${entity.name}`,
      entity.category ? `Category: ${entity.category}` : "",
      entity.description ? `Description: ${entity.description}` : "",
      entity.price ? `Price: ${entity.price}` : "",
      entity.availability ? `Availability: ${entity.availability}` : "",
      entity.url ? `URL: ${entity.url}` : "",
      entity.keywords?.length ? `Keywords: ${entity.keywords.join(", ")}` : "",
    ].filter(Boolean);
    return parts.join("\n");
  });
  return [
    "Structured business knowledge entities are available and must be used before generic clarification.",
    `Detected intent: ${input.intent || "business"}`,
    `Customer question: ${input.question}`,
    "Entities:",
    lines.join("\n\n"),
  ].join("\n");
}
