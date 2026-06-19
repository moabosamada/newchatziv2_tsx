import { Types } from "mongoose";
import {
  Bot,
  Contact,
  Conversation,
  ConversationEvent,
  ConversationInsight,
  Message
} from "@/lib/models";
import { connectToDatabase } from "@/lib/mongodb";
import { buildKnowledgePrompt, searchKnowledge } from "@/lib/knowledge";
import { routeAiRequest } from "@/lib/ai-router";

type Sentiment = "positive" | "neutral" | "negative";
type Intent = "complaint" | "sales" | "support" | "billing" | "cancellation" | "upgrade" | "general";

type Suggestion = {
  id: string;
  label: string;
  text: string;
  tone: string;
  confidence: number;
  source: "knowledge" | "llm" | "fallback";
};

type AnalysisResult = {
  summary: string;
  sentiment: Sentiment;
  sentimentScore: number;
  intent: Intent;
  confidence: number;
  needsHuman: boolean;
  escalationReason: string;
  suggestedReplies: Suggestion[];
  bestReply: string;
  customerFacts: string[];
  recommendedActions: string[];
  detectedTags: string[];
  modelProvider?: string;
  modelName?: string;
};

const intentKeywords: Record<Intent, string[]> = { complaint: [], sales: [], support: [], billing: [], cancellation: [], upgrade: [], general: [] };

const escalationKeywords: string[] = [];


const positiveKeywords: string[] = [];
const negativeKeywords: string[] = [];

export async function refreshConversationIntelligence(input: {
  tenantId: string;
  conversationId: string;
  force?: boolean;
}) {
  await connectToDatabase();
  if (!Types.ObjectId.isValid(input.conversationId)) {
    throw new Error("Invalid conversation id.");
  }

  const conversation = await Conversation.findOne({
    _id: input.conversationId,
    tenantId: input.tenantId
  });
  if (!conversation) throw new Error("Conversation not found.");

  const latestMessage = await Message.findOne({
    tenantId: input.tenantId,
    conversationId: conversation._id,
    direction: "incoming"
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!latestMessage) {
    return upsertInsight(input.tenantId, conversation, fallbackAnalysis("", "لا توجد رسائل واردة بعد."));
  }

  const existing = await ConversationInsight.findOne({
    tenantId: input.tenantId,
    conversationId: conversation._id
  }).lean();

  const existingMessageId = existing?.analyzedMessageId?.toString();
  if (!input.force && existingMessageId === latestMessage._id.toString()) {
    return existing;
  }

  const [messages, contact, bot] = await Promise.all([
    Message.find({ tenantId: input.tenantId, conversationId: conversation._id })
      .sort({ createdAt: -1 })
      .limit(18)
      .lean(),
    conversation.contactId ? Contact.findOne({ _id: conversation.contactId, tenantId: input.tenantId }).lean() : null,
    conversation.botId ? Bot.findOne({ _id: conversation.botId, tenantId: input.tenantId }).lean() : null
  ]);

  const transcript = messages
    .reverse()
    .map((message) => {
      const speaker = message.sender === "agent" ? "Agent" : message.sender === "assistant" ? "AI" : "Customer";
      return `${speaker}: ${message.content}`;
    })
    .join("\n");

  const latestText = latestMessage.content || "";
  const knowledge = bot?.knowledgeEnabled !== false && conversation.botId
    ? await searchKnowledge({
        tenantId: input.tenantId,
        botId: conversation.botId.toString(),
        question: latestText,
        limit: 6
      }).catch(() => null)
    : null;

  const heuristic = fallbackAnalysis(latestText, transcript);
  let analysis = heuristic;

  try {
    const systemPrompt = [
      "You are an AI copilot embedded inside a production CRM omnichannel inbox.",
      "Return strict JSON only. Do not wrap it in Markdown.",
      "Use the knowledge base as the primary source when available. Never invent policy, pricing, SLA, refund, billing, or legal details.",
      "Escalate to a human when there is severe anger, a manager request, refund/chargeback, cancellation risk, or low confidence.",
      "The JSON shape is: summary, sentiment, sentimentScore, intent, confidence, needsHuman, escalationReason, suggestedReplies, bestReply, customerFacts, recommendedActions, detectedTags.",
      "suggestedReplies must contain exactly 3 concise Arabic replies suitable for an agent to send."
    ].join("\n");

    const knowledgePrompt = knowledge
      ? buildKnowledgePrompt({
          question: latestText,
          intent: knowledge.intent,
          keywords: knowledge.keywords,
          confidence: knowledge.confidence,
          results: knowledge.results,
          showSources: false
        })
      : "No retrieved knowledge.";

    const userInput = [
      `Customer: ${contact?.name || contact?.email || contact?.phone || conversation.externalUserId}`,
      `Channel: ${conversation.provider || conversation.channel}`,
      `Current priority: ${conversation.priority}`,
      `Latest customer message: ${latestText}`,
      "Conversation transcript:",
      transcript,
      "Knowledge:",
      knowledgePrompt
    ].join("\n\n");

    const ai = await routeAiRequest({ systemPrompt, userInput, temperature: 0.2 });
    analysis = normalizeAnalysis(parseJson(ai.reply), heuristic, "llm");
    analysis.modelProvider = ai.providerUsed;
    analysis.modelName = ai.modelUsed;
  } catch {
    analysis = normalizeAnalysis({}, heuristic, knowledge?.results?.length ? "knowledge" : "fallback");
  }

  if (knowledge?.results?.length) {
    analysis.suggestedReplies = analysis.suggestedReplies.map((suggestion) => ({
      ...suggestion,
      source: suggestion.source === "fallback" ? "knowledge" : suggestion.source
    }));
  }

  const insight = await upsertInsight(input.tenantId, conversation, analysis, latestMessage._id, knowledge);
  await syncConversationAiFields(input.tenantId, conversation, analysis);
  return insight;
}

export async function generateSmartReply(input: {
  tenantId: string;
  conversationId: string;
  action: string;
}) {
  await connectToDatabase();
  const detail = await buildConversationPrompt(input.tenantId, input.conversationId);
  const tone = actionToTone(input.action);

  try {
    const response = await routeAiRequest({
      temperature: 0.25,
      systemPrompt: [
        "You write one ready-to-send CRM agent reply in Arabic.",
        "Base the reply on retrieved knowledge and the conversation. Never invent facts.",
        `Style: ${tone}.`,
        "Return the reply text only."
      ].join("\n"),
      userInput: detail
    });
    return response.reply.trim();
  } catch {
    return buildFallbackReply(detail, tone);
  }
}

export async function rewriteDraft(input: {
  tenantId: string;
  conversationId: string;
  draft: string;
  mode: string;
}) {
  await connectToDatabase();
  const draft = input.draft.trim();
  if (!draft) throw new Error("Draft is required.");

  const context = await buildConversationPrompt(input.tenantId, input.conversationId);
  const instruction = rewriteInstruction(input.mode);

  try {
    const response = await routeAiRequest({
      temperature: 0.2,
      systemPrompt: [
        "You are a rewrite assistant for customer support agents.",
        "Preserve the meaning and do not add unsupported promises.",
        instruction,
        "Return the rewritten text only."
      ].join("\n"),
      userInput: `Context:\n${context}\n\nDraft:\n${draft}`
    });
    return response.reply.trim();
  } catch {
    return fallbackRewrite(draft, input.mode);
  }
}

async function buildConversationPrompt(tenantId: string, conversationId: string) {
  if (!Types.ObjectId.isValid(conversationId)) throw new Error("Invalid conversation id.");
  const conversation = await Conversation.findOne({ _id: conversationId, tenantId }).lean();
  if (!conversation) throw new Error("Conversation not found.");

  const messages = await Message.find({ tenantId, conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .limit(14)
    .lean();

  const latest = messages.find((message) => message.direction === "incoming")?.content || "";
  const knowledge = conversation.botId && latest
    ? await searchKnowledge({
        tenantId,
        botId: conversation.botId.toString(),
        question: latest,
        limit: 5
      }).catch(() => null)
    : null;

  const transcript = messages
    .reverse()
    .map((message) => `${message.sender}: ${message.content}`)
    .join("\n");

  const knowledgePrompt = knowledge
    ? buildKnowledgePrompt({
        question: latest,
        intent: knowledge.intent,
        keywords: knowledge.keywords,
        confidence: knowledge.confidence,
        results: knowledge.results,
        showSources: false
      })
    : "No knowledge was retrieved.";

  return [`Conversation:\n${transcript}`, `Knowledge:\n${knowledgePrompt}`].join("\n\n");
}

async function upsertInsight(
  tenantId: string,
  conversation: any,
  analysis: AnalysisResult,
  analyzedMessageId?: Types.ObjectId,
  knowledge?: Awaited<ReturnType<typeof searchKnowledge>> | null
) {
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  return ConversationInsight.findOneAndUpdate(
    { tenantId, conversationId: conversation._id },
    {
      $set: {
        tenantId,
        conversationId: conversation._id,
        botId: conversation.botId,
        summary: analysis.summary,
        sentiment: analysis.sentiment,
        sentimentScore: analysis.sentimentScore,
        intent: analysis.intent,
        confidence: analysis.confidence,
        needsHuman: analysis.needsHuman,
        escalationReason: analysis.escalationReason,
        suggestedReplies: analysis.suggestedReplies,
        bestReply: analysis.bestReply,
        customerFacts: analysis.customerFacts,
        recommendedActions: analysis.recommendedActions,
        detectedTags: analysis.detectedTags,
        knowledgeSources: (knowledge?.results || []).slice(0, 6).map((result: { sourceTitle: string, sourceUrl?: string, score: number, documentId: string }) => ({
          title: result.sourceTitle,
          url: result.sourceUrl,
          score: result.score,
          documentId: result.documentId
        })),
        modelProvider: analysis.modelProvider || "",
        modelName: analysis.modelName || "",
        analyzedMessageId,
        expiresAt
      }
    },
    { new: true, upsert: true }
  );
}

async function syncConversationAiFields(tenantId: string, conversation: any, analysis: AnalysisResult) {
  const labels = new Set<string>([
    ...(Array.isArray(conversation.labels) ? conversation.labels : []),
    ...(Array.isArray(conversation.tags) ? conversation.tags : [])
  ]);
  for (const tag of analysis.detectedTags) labels.add(tag);
  if (analysis.needsHuman) labels.add("AI Escalations");
  if (analysis.intent === "sales") labels.add("New Lead");
  if (analysis.sentiment === "negative") labels.add("Urgent");

  const update: Record<string, unknown> = {
    aiStatus: analysis.needsHuman ? "escalated" : analysis.confidence < 55 ? "needs_review" : "suggesting",
    aiConfidence: analysis.confidence,
    aiSummary: analysis.summary,
    aiSentiment: analysis.sentiment,
    aiIntent: analysis.intent,
    aiEscalationReason: analysis.escalationReason,
    aiLastAnalyzedAt: new Date(),
    labels: [...labels],
    tags: [...labels]
  };

  if (analysis.needsHuman) {
    update.mode = "human";
    update.aiPaused = true;
    update.aiPausedReason = analysis.escalationReason || "ai_escalation";
    update.aiPausedAt = new Date();
    update.priority = analysis.intent === "billing" || analysis.intent === "cancellation" ? "urgent" : "high";
  }

  await Conversation.updateOne({ _id: conversation._id, tenantId }, { $set: update });

  await ConversationEvent.create({
    tenantId,
    conversationId: conversation._id,
    actorType: "ai",
    type: "ai_event",
    title: analysis.needsHuman ? "AI Escalation" : "AI Suggestions Updated",
    content: analysis.needsHuman ? analysis.escalationReason : analysis.summary,
    metadata: {
      sentiment: analysis.sentiment,
      intent: analysis.intent,
      confidence: analysis.confidence,
      suggestions: analysis.suggestedReplies.length
    }
  }).catch(() => undefined);
}

function fallbackAnalysis(latestText: string, transcript: string): AnalysisResult {
  const lower = latestText.toLowerCase();
  const sentiment = detectSentiment(lower);
  const intent = detectIntent(lower);
  const needsHuman = shouldEscalate(lower, sentiment, intent);
  const confidence = Math.max(45, Math.min(88, 70 + scoreKeywordHits(lower, intentKeywords[intent]) * 6 - (needsHuman ? 12 : 0)));
  const summary = summarizeFallback(latestText, transcript, intent);
  const source: Suggestion["source"] = "fallback";

  return {
    summary,
    sentiment,
    sentimentScore: sentiment === "positive" ? 42 : sentiment === "negative" ? -58 : 0,
    intent,
    confidence,
    needsHuman,
    escalationReason: needsHuman ? escalationReason(lower, intent) : "",
    suggestedReplies: [
      {
        id: "suggestion-1",
        label: "رد احترافي",
        text: professionalReply(latestText, intent),
        tone: "professional",
        confidence,
        source
      },
      {
        id: "suggestion-2",
        label: "رد مختصر",
        text: shortReply(latestText, intent),
        tone: "short",
        confidence: Math.max(45, confidence - 5),
        source
      },
      {
        id: "suggestion-3",
        label: "رد ودي",
        text: friendlyReply(latestText, intent),
        tone: "friendly",
        confidence: Math.max(45, confidence - 3),
        source
      }
    ],
    bestReply: professionalReply(latestText, intent),
    customerFacts: [],
    recommendedActions: needsHuman ? ["مراجعة المحادثة قبل إرسال أي رد", "تعيين المحادثة لوكيل مختص"] : ["استخدام أحد الردود المقترحة بعد المراجعة"],
    detectedTags: tagsFor(intent, sentiment, needsHuman)
  };
}

function normalizeAnalysis(raw: Record<string, unknown>, fallback: AnalysisResult, source: Suggestion["source"]): AnalysisResult {
  const suggestions = Array.isArray(raw.suggestedReplies)
    ? raw.suggestedReplies.slice(0, 3).map((item, index) => {
        const suggestion = item as Record<string, unknown>;
        return {
          id: String(suggestion.id || `suggestion-${index + 1}`),
          label: String(suggestion.label || fallback.suggestedReplies[index]?.label || `اقتراح ${index + 1}`),
          text: String(suggestion.text || fallback.suggestedReplies[index]?.text || fallback.bestReply),
          tone: String(suggestion.tone || fallback.suggestedReplies[index]?.tone || "professional"),
          confidence: clampNumber(suggestion.confidence, fallback.confidence),
          source
        };
      })
    : fallback.suggestedReplies;

  while (suggestions.length < 3) suggestions.push(fallback.suggestedReplies[suggestions.length]);

  return {
    summary: String(raw.summary || fallback.summary),
    sentiment: parseSentiment(raw.sentiment, fallback.sentiment),
    sentimentScore: clampNumber(raw.sentimentScore, fallback.sentimentScore, -100, 100),
    intent: parseIntent(raw.intent, fallback.intent),
    confidence: clampNumber(raw.confidence, fallback.confidence),
    needsHuman: typeof raw.needsHuman === "boolean" ? raw.needsHuman : fallback.needsHuman,
    escalationReason: String(raw.escalationReason || fallback.escalationReason || ""),
    suggestedReplies: suggestions,
    bestReply: String(raw.bestReply || suggestions[0]?.text || fallback.bestReply),
    customerFacts: parseStringArray(raw.customerFacts),
    recommendedActions: parseStringArray(raw.recommendedActions),
    detectedTags: [...new Set([...parseStringArray(raw.detectedTags), ...fallback.detectedTags])].slice(0, 8)
  };
}

function parseJson(value: string): Record<string, unknown> {
  const fenced = value.match(/```(?:json)?([\s\S]*?)```/i)?.[1] || value;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function detectSentiment(lower: string): Sentiment {
  const positive = scoreKeywordHits(lower, positiveKeywords);
  const negative = scoreKeywordHits(lower, negativeKeywords);
  if (negative > positive && negative > 0) return "negative";
  if (positive > negative && positive > 0) return "positive";
  return "neutral";
}

function detectIntent(lower: string): Intent {
  let winner: Intent = "general";
  let winnerScore = 0;
  for (const [intent, keywords] of Object.entries(intentKeywords) as Array<[Intent, string[]]>) {
    const score = scoreKeywordHits(lower, keywords);
    if (score > winnerScore) {
      winner = intent;
      winnerScore = score;
    }
  }
  return winner;
}

function scoreKeywordHits(lower: string, keywords: string[]) {
  return keywords.reduce((score, keyword) => score + (lower.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function shouldEscalate(lower: string, sentiment: Sentiment, intent: Intent) {
  if (scoreKeywordHits(lower, escalationKeywords) > 0) return true;
  if (sentiment === "negative" && (intent === "billing" || intent === "cancellation" || intent === "complaint")) return true;
  return false;
}

function escalationReason(lower: string, intent: Intent) {
  if (lower.includes("manager") || lower.includes("مدير")) return "Customer requested a manager.";
  if (lower.includes("refund") || lower.includes("استرجاع") || lower.includes("استرداد")) return "Refund or payment escalation detected.";
  if (intent === "cancellation") return "Cancellation risk detected.";
  return "High-risk negative sentiment detected.";
}

function summarizeFallback(latestText: string, transcript: string, intent: Intent) {
  const first = latestText.trim() || transcript.split("\n").slice(-1)[0] || "لا توجد تفاصيل كافية.";
  return `نية العميل: ${intentLabel(intent)}. آخر رسالة: ${first.slice(0, 160)}`;
}

function intentLabel(intent: Intent) { return intent; }
function professionalReply(_text: string, _intent: Intent) { return ""; }
function shortReply(_text: string, _intent: Intent) { return ""; }
function friendlyReply(_text: string, _intent: Intent) { return ""; }
function tagsFor(intent: Intent, sentiment: Sentiment, needsHuman: boolean) {
  const tags = [intentLabel(intent)];
  if (sentiment === "negative") tags.push("urgent");
  if (needsHuman) tags.push("escalated");
  return tags;
}

function parseSentiment(value: unknown, fallback: Sentiment): Sentiment {
  return value === "positive" || value === "neutral" || value === "negative" ? value : fallback;
}

function parseIntent(value: unknown, fallback: Intent): Intent {
  return value === "complaint" ||
    value === "sales" ||
    value === "support" ||
    value === "billing" ||
    value === "cancellation" ||
    value === "upgrade" ||
    value === "general"
    ? value
    : fallback;
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
}

function clampNumber(value: unknown, fallback: number, min = 0, max = 100) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function actionToTone(action: string) { return action || "professional"; }
function rewriteInstruction(mode: string) { return mode || "improve"; }
function buildFallbackReply(_context: string, _tone: string) { return ""; }

function fallbackRewrite(draft: string, mode: string) {
  if (mode === "shorten") return draft.length > 120 ? `${draft.slice(0, 117).trim()}...` : draft;
  return draft;
}

