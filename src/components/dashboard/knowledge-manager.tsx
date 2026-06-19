"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  DatabaseZap,
  FileSpreadsheet,
  FileText,
  FileUp,
  Loader2,
  Save,
  Sparkles,
  Trash2,
  Eye,
  RefreshCcw,
  Beaker,
  Lightbulb,
} from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { KnowledgeDetailsModal } from "./knowledge-details-modal";
import { KnowledgeTestModal } from "./knowledge-test-modal";

type BotRow = {
  id: string;
  name: string;
  knowledgeEnabled: boolean;
  showKnowledgeSources: boolean;
  confidenceDirectThreshold: number;
  confidenceReviewThreshold: number;
  systemPrompt: string;
  autoFollowupEnabled: boolean;
  followupDelayMinutes: number;
  followupMaxAttempts: number;
  autoCloseEnabled: boolean;
  autoCloseAfterMinutes: number;
  autoCloseMessage: string;
};

type CategoryRow = { id: string; name: string };
type CollectionRow = { id: string; categoryId: string; name: string };
type DocumentRow = {
  id: string;
  categoryId?: string;
  title: string;
  sourceType: string;
  status: string;
  statusReason: string;
  tags: string[];
  isTemporary: boolean;
  expiresAt: string;
  chunkCount: number;
  embeddingCount: number;
  needsRetraining: boolean;
  updatedAt: string;
};

type KnowledgeManagerProps = {
  bots: BotRow[];
  categories: CategoryRow[];
  collections: CollectionRow[];
  documents: DocumentRow[];
};

const acceptedFileTypes = ".pdf,.docx,.xlsx,.xls,.csv,.txt,.json,application/pdf,application/json,text/plain";

function detectSourceType(file: File | null) {
  if (!file) return "custom_text";
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "excel";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".txt")) return "txt";
  return "custom_text";
}

function getGlobalHealth(documents: DocumentRow[]) {
  if (!documents.length) return 0;
  const ready = documents.filter((doc) => doc.status === "ready" || doc.status === "duplicate").length;
  const broken = documents.filter((doc) => ["error", "pending", "processing"].includes(doc.status)).length;
  const chunks = documents.reduce((sum, doc) => sum + (doc.chunkCount || 0), 0);
  const embeddings = documents.reduce((sum, doc) => sum + (doc.embeddingCount || 0), 0);
  const readinessScore = (ready / documents.length) * 40;
  const embeddingScore = chunks ? Math.min(1, embeddings / chunks) * 40 : 0;
  const stabilityScore = Math.max(0, 20 - (broken / documents.length) * 20);
  return Math.round(Math.max(0, Math.min(100, readinessScore + embeddingScore + stabilityScore)));
}

function healthTone(score: number) {
  if (score >= 80) return "text-emerald-700 bg-emerald-50 ring-emerald-100";
  if (score >= 50) return "text-amber-700 bg-amber-50 ring-amber-100";
  return "text-red-700 bg-red-50 ring-red-100";
}

function sourceTypeLabel(type: string, isAr: boolean) {
  const labels: Record<string, string> = {
    custom_text: isAr ? "نص مباشر" : "Text",
    pdf: "PDF",
    docx: "Word",
    excel: "Excel",
    csv: "CSV",
    txt: "TXT",
    json: "JSON",
  };
  return labels[type] || type;
}

function statusLabel(status: string, isAr: boolean) {
  const labels: Record<string, string> = {
    pending: isAr ? "قيد الانتظار" : "Pending",
    processing: isAr ? "جاري التدريب" : "Processing",
    ready: isAr ? "جاهز" : "Ready",
    error: isAr ? "خطأ" : "Error",
    duplicate: isAr ? "مكرر" : "Duplicate",
    needs_retraining: isAr ? "يحتاج تدريب" : "Needs retraining",
  };
  return labels[status] || status;
}

export function KnowledgeManager({ bots, categories, documents }: KnowledgeManagerProps) {
  const router = useRouter();
  const { locale } = useI18n();
  const isAr = locale === "ar";

  const [selectedBot, setSelectedBot] = useState(bots[0]?.id || "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [detailsDocumentId, setDetailsDocumentId] = useState<string | null>(null);
  const [detailsDocumentTitle, setDetailsDocumentTitle] = useState("");
  const [isTestModalOpen, setIsTestModalOpen] = useState(false);

  const sourceType = detectSourceType(selectedFile);
  const globalHealth = useMemo(() => getGlobalHealth(documents), [documents]);
  const readyCount = documents.filter((doc) => doc.status === "ready").length;
  const issueCount = documents.filter((doc) => doc.status === "error" || doc.needsRetraining).length;

  const categoryHealth = useMemo(() => {
    return categories
      .map((category) => {
        const docs = documents.filter((doc) => doc.categoryId === category.id);
        return { category, docs, score: getGlobalHealth(docs) };
      })
      .filter((item) => item.docs.length > 0)
      .sort((a, b) => b.score - a.score || b.docs.length - a.docs.length);
  }, [categories, documents]);

  async function handleDelete(docId: string) {
    if (!confirm(isAr ? "هل أنت متأكد من حذف هذا المصدر؟" : "Are you sure you want to delete this source?")) return;
    try {
      const res = await fetch(`/api/knowledge/${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      alert(isAr ? "تعذر الحذف" : "Failed to delete");
    }
  }

  async function handleRewrite(docId: string) {
    try {
      setLoading(true);
      const res = await fetch(`/api/knowledge/${docId}/rewrite`, { method: "POST" });
      if (!res.ok) throw new Error();
      setSuccess(isAr ? "بدأت إعادة الصياغة بالذكاء الاصطناعي." : "AI rewrite started.");
      router.refresh();
    } catch {
      setError(isAr ? "تعذر بدء إعادة الصياغة" : "Failed to start rewrite");
    } finally {
      setLoading(false);
    }
  }

  async function submitKnowledge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!selectedBot) {
      setError(isAr ? "اختر البوت أولًا." : "Select a bot first.");
      return;
    }

    if (!text.trim() && !selectedFile) {
      setError(isAr ? "اكتب محتوى أو ارفع ملف معرفة." : "Write content or upload a knowledge file.");
      return;
    }

    setLoading(true);
    const form = new FormData();
    form.set("botId", selectedBot);
    form.set("title", title.trim() || selectedFile?.name.replace(/\.[^.]+$/, "") || (isAr ? "معرفة جديدة" : "New knowledge"));
    form.set("sourceType", sourceType);
    form.set("categoryName", "تلقائي");
    form.set("collectionName", "عام");
    form.set("tags", tags);
    form.set("text", text);
    form.set("isTemporary", "false");
    if (selectedFile) form.set("file", selectedFile);

    try {
      const response = await fetch("/api/knowledge", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || (isAr ? "تعذر حفظ المعرفة." : "Could not save knowledge."));
      setTitle("");
      setText("");
      setTags("");
      setSelectedFile(null);
      setSuccess(isAr ? "تم حفظ المعرفة وبدأ التدريب والتصنيف التلقائي." : "Knowledge saved. Training and auto-classification started.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : isAr ? "تعذر حفظ المعرفة." : "Could not save knowledge.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      {success ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p> : null}

      <section className="grid gap-4 lg:grid-cols-4">
        <article className="panel p-4 lg:col-span-2">
          <label className="label flex items-center gap-2"><Bot size={16} /> {isAr ? "البوت" : "Bot"}</label>
          <select className="field" value={selectedBot} onChange={(event) => setSelectedBot(event.target.value)}>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </article>
        <article className="panel p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">{isAr ? "الصحة العامة" : "Global health"}</p>
            <button type="button" onClick={() => setIsTestModalOpen(true)} className="btn-secondary py-1 text-xs px-2" disabled={!selectedBot}>
              <Beaker size={14} /> {isAr ? "اختبار" : "Test"}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span className={`inline-flex rounded-full px-3 py-1 text-2xl font-bold ring-1 ${healthTone(globalHealth)}`}>{globalHealth}%</span>
            {globalHealth < 60 && (
              <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded-md">
                <Lightbulb size={12} /> {isAr ? "ننصح بإضافة ملفات أو إعادة صياغتها" : "Add/rewrite sources to improve"}
              </span>
            )}
          </div>
        </article>
        <article className="panel p-4">
          <p className="text-sm text-slate-500">{isAr ? "المصادر الجاهزة / المشاكل" : "Ready / issues"}</p>
          <p className="mt-2 text-2xl font-bold text-ink">{readyCount} / {issueCount}</p>
        </article>
      </section>

      <form onSubmit={submitKnowledge} className="panel overflow-hidden">
        <div className="border-b border-slate-100 p-5 dark:border-slate-800">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary-50 p-2 text-primary-700 dark:bg-primary-950/30 dark:text-primary-300">
              <DatabaseZap size={22} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink">{isAr ? "إضافة معرفة دفعة واحدة" : "Add bulk knowledge"}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {isAr
                  ? "اكتب البيانات في المحرر أو ارفع PDF / Word / Excel / JSON وسيتم استخراج النص وتصنيفه تلقائيًا إلى فئات المعرفة."
                  : "Write in the editor or upload PDF / Word / Excel / JSON. The system extracts text and auto-classifies it."}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-5 p-5 xl:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            <div>
              <label className="label">{isAr ? "العنوان" : "Title"}</label>
              <input
                className="field"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={isAr ? "مثال: بيانات مركز الأسنان والخدمات والأسعار" : "Example: Company services and pricing"}
              />
            </div>
            <div>
              <label className="label flex items-center gap-2"><Sparkles size={16} /> {isAr ? "محرر المعرفة الكبير" : "Large knowledge editor"}</label>
              <textarea
                className="field min-h-[340px] text-sm leading-7"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={isAr ? "اكتب هنا معلومات النشاط، النبذة، الخدمات، الأسعار، الحجز، السياسات، الأسئلة الشائعة..." : "Write company info, services, pricing, booking rules, policies, FAQ..."}
              />
            </div>
            <div>
              <label className="label">{isAr ? "وسوم اختيارية" : "Optional tags"}</label>
              <input className="field" value={tags} onChange={(event) => setTags(event.target.value)} placeholder={isAr ? "أسنان, حجز, أسعار" : "dental, booking, prices"} />
            </div>
          </div>

          <aside className="space-y-4">
            <label className="flex min-h-[210px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center transition hover:border-primary-400 hover:bg-primary-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-primary-950/20">
              <FileUp size={34} className={selectedFile ? "text-primary-700" : "text-slate-400"} />
              {selectedFile ? (
                <span>
                  <span className="block text-sm font-bold text-primary-700">{selectedFile.name}</span>
                  <span className="mt-1 block text-xs text-slate-500">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB · {sourceTypeLabel(sourceType, isAr)}</span>
                </span>
              ) : (
                <span>
                  <span className="block text-sm font-bold text-slate-700 dark:text-slate-200">{isAr ? "ارفع ملف معرفة" : "Upload a knowledge file"}</span>
                  <span className="mt-1 block text-xs text-slate-500">PDF, Word, Excel, CSV, TXT, JSON</span>
                </span>
              )}
              <input
                type="file"
                className="hidden"
                accept={acceptedFileTypes}
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  setSelectedFile(file);
                  if (file && !title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ""));
                }}
              />
            </label>

            {selectedFile ? (
              <button
                type="button"
                onClick={() => setSelectedFile(null)}
                className="btn-secondary w-full justify-center text-red-600 hover:bg-red-50"
              >
                <Trash2 size={16} /> {isAr ? "إزالة الملف" : "Remove file"}
              </button>
            ) : null}

            <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm leading-6 text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-200">
              {isAr
                ? "التصنيف تلقائي: معلومات النشاط، النبذة، المنتجات، الخدمات، الأسعار، العروض، الشحن، الدفع، السياسات، الدعم، المبيعات، التذاكر."
                : "Auto-classifies into company info, products, services, pricing, offers, shipping, payments, policies, support, sales, and tickets."}
            </div>

            <button type="submit" className="btn-primary w-full justify-center" disabled={loading || !selectedBot}>
              {loading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
              {isAr ? "حفظ وتدريب المعرفة" : "Save and train"}
            </button>
          </aside>
        </div>
      </form>

      <section className="grid gap-5 xl:grid-cols-[360px_1fr]">
        <article className="panel p-5">
          <h2 className="mb-4 flex items-center gap-2 font-bold text-ink"><CheckCircle2 size={18} /> {isAr ? "صحة الفئات" : "Category health"}</h2>
          <div className="space-y-3">
            {categoryHealth.length ? categoryHealth.map((item) => (
              <div key={item.category.id} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-ink">{item.category.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${healthTone(item.score)}`}>{item.score}%</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{item.docs.length} {isAr ? "مصدر" : "sources"}</p>
              </div>
            )) : (
              <p className="text-sm text-slate-500">{isAr ? "لا توجد فئات بها مصادر بعد." : "No category sources yet."}</p>
            )}
          </div>
        </article>

        <article className="panel overflow-hidden">
          <div className="border-b border-slate-100 p-4 dark:border-slate-800">
            <h2 className="flex items-center gap-2 font-bold text-ink"><FileText size={18} /> {isAr ? "آخر مصادر المعرفة" : "Latest knowledge sources"}</h2>
          </div>
          {documents.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr>
                    <th className="p-3 text-right">{isAr ? "المصدر" : "Source"}</th>
                    <th className="p-3 text-right">{isAr ? "النوع" : "Type"}</th>
                    <th className="p-3 text-right">{isAr ? "الحالة" : "Status"}</th>
                    <th className="p-3 text-right">Chunks</th>
                    <th className="p-3 text-right">Embeddings</th>
                    <th className="p-3 text-right">{isAr ? "آخر تحديث" : "Updated"}</th>
                    <th className="p-3 text-right">{isAr ? "الإجراءات" : "Actions"}</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.slice(0, 30).map((doc) => (
                    <tr key={doc.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="max-w-sm p-3 font-semibold text-ink">
                        <span className="line-clamp-1">{doc.title}</span>
                        {doc.statusReason ? <span className="mt-1 flex items-center gap-1 text-xs text-red-600"><AlertCircle size={12} /> {doc.statusReason}</span> : null}
                      </td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">
                        <span className="inline-flex items-center gap-1"><FileSpreadsheet size={13} /> {sourceTypeLabel(doc.sourceType, isAr)}</span>
                      </td>
                      <td className="p-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${doc.status === "ready" ? "bg-emerald-50 text-emerald-700" : doc.status === "error" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
                          {statusLabel(doc.status, isAr)}
                        </span>
                      </td>
                      <td className="p-3 text-slate-600">{doc.chunkCount}</td>
                      <td className="p-3 text-slate-600">{doc.embeddingCount}</td>
                      <td className="p-3 text-xs text-slate-500">{doc.updatedAt ? new Date(doc.updatedAt).toLocaleString(isAr ? "ar-EG" : "en-US") : "-"}</td>
                      <td className="p-3 text-right space-x-2 rtl:space-x-reverse">
                        <button type="button" onClick={() => { setDetailsDocumentId(doc.id); setDetailsDocumentTitle(doc.title); }} className="p-1 text-slate-400 hover:text-blue-600" title={isAr ? "التفاصيل" : "Details"}>
                          <Eye size={16} />
                        </button>
                        <button type="button" onClick={() => handleRewrite(doc.id)} className="p-1 text-slate-400 hover:text-amber-600" title={isAr ? "إعادة الصياغة بالذكاء الاصطناعي" : "AI Rewrite"}>
                          <RefreshCcw size={16} />
                        </button>
                        <button type="button" onClick={() => handleDelete(doc.id)} className="p-1 text-slate-400 hover:text-red-600" title={isAr ? "حذف" : "Delete"}>
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-6 text-sm text-slate-500">{isAr ? "لا توجد مصادر معرفة بعد." : "No knowledge sources yet."}</p>
          )}
        </article>
      </section>

      {detailsDocumentId && (
        <KnowledgeDetailsModal
          documentId={detailsDocumentId}
          documentTitle={detailsDocumentTitle}
          onClose={() => setDetailsDocumentId(null)}
        />
      )}
      {isTestModalOpen && selectedBot && (
        <KnowledgeTestModal
          botId={selectedBot}
          onClose={() => setIsTestModalOpen(false)}
        />
      )}
    </div>
  );
}
