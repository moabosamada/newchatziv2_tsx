const ARABIC_EXPLICIT_HANDOFF_PATTERNS = [
  /\b(موظف|الموظف|بشري|البشري|إنسان|انسان|آدمي|ادمي)\b/u,
  /(اكلم|أكلم|كلمني|كلمنى|كلم|اتكلم|التحدث|اتحدث|تحدث|تواصل|حولني|حوّلني|حولنى|وصلني|وصّلني|أوصلني|اوصلني)\s*(الي|إلى|ل|مع)?\s*(حد|شخص|موظف|بشري|إنسان|انسان|خدمة العملاء|الدعم|الدعم الفني|الدعم البشري|الفريق|فريق الدعم)/u,
  /(عايز|عاوز|أريد|اريد|ابغى|أبغى|محتاج|احتاج|بدي|بدى|ممكن|يمكنني)\s+(اكلم|أكلم|اتكلم|التحدث|اتحدث|تحدث|التواصل|تواصل)\s*(الي|إلى|ل|مع)?\s*(موظف|بشري|إنسان|انسان|خدمة العملاء|الدعم|الدعم الفني|الدعم البشري|فريق الدعم|حد)/u,
  /(خدمة العملاء|الدعم البشري|الدعم الفني|مندوب|ممثل خدمة العملاء|فريق الدعم)/u,
];
const ENGLISH_EXPLICIT_HANDOFF_PATTERNS = [/\b(human|agent|representative|real person|live person|customer service|human support)\b/i,/\b(talk|speak|chat|connect|transfer)\s+(to|with)?\s*(a\s+)?(human|agent|representative|real person|live person)\b/i];
export function normalizeForIntent(value: string) { return String(value || "").toLowerCase().replace(/[إأآا]/g,"ا").replace(/[ىي]/g,"ي").replace(/ة/g,"ه").replace(/[ًٌٍَُِّْـ]/g,"").replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim(); }
export function isExplicitHumanHandoffRequest(message: string) { const raw=String(message||"").trim(); if(!raw) return false; const normalized=normalizeForIntent(raw); return [...ARABIC_EXPLICIT_HANDOFF_PATTERNS,...ENGLISH_EXPLICIT_HANDOFF_PATTERNS].some((pattern)=>pattern.test(raw)||pattern.test(normalized)); }
