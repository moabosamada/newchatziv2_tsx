"use client";

import { useState } from "react";
import { X, Loader2, Send, Database, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

type TestResult = {
  text: string;
  score: number;
  sourceTitle: string;
};

type TestResponse = {
  success: boolean;
  result: {
    intent: string;
    confidence: number;
    results: TestResult[];
  };
};

type Props = {
  botId: string;
  onClose: () => void;
};

export function KnowledgeTestModal({ botId, onClose }: Props) {
  const { locale } = useI18n();
  const isAr = locale === "ar";
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TestResponse["result"] | null>(null);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    
    setLoading(true);
    setError("");
    setData(null);

    try {
      const res = await fetch("/api/knowledge/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId, question: question.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || (isAr ? "حدث خطأ" : "An error occurred"));
      setData(json.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : (isAr ? "فشل الاختبار" : "Test failed"));
    } finally {
      setLoading(false);
    }
  }

  function confidenceTone(score: number) {
    if (score >= 80) return "text-emerald-700 bg-emerald-50 border-emerald-200";
    if (score >= 50) return "text-amber-700 bg-amber-50 border-amber-200";
    return "text-red-700 bg-red-50 border-red-200";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-center justify-between border-b border-slate-100 p-5 dark:border-slate-800">
          <div>
            <h2 className="text-xl font-bold text-ink">{isAr ? "اختبار قاعدة المعرفة" : "Test Knowledge Base"}</h2>
            <p className="mt-1 text-sm text-slate-500">{isAr ? "اطرح سؤالاً لترى كيف سيجيب النظام والفقرات التي سيعتمد عليها." : "Ask a question to see how the system responds and which chunks it uses."}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800">
            <X size={20} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {error && <div className="mb-4 rounded-lg bg-red-50 p-4 text-center text-red-700">{error}</div>}

          {data && (
            <div className="mb-6 space-y-4">
              <div className={`flex items-center justify-between rounded-xl border p-4 ${confidenceTone(data.confidence)}`}>
                <div>
                  <h3 className="font-bold">{isAr ? "مستوى الثقة في الإجابة" : "Confidence Level"}</h3>
                  <p className="text-sm opacity-80">{isAr ? "بناءً على مدى تطابق السؤال مع المعرفة المسجلة." : "Based on how well the query matches knowledge."}</p>
                </div>
                <div className="text-3xl font-black">{data.confidence}%</div>
              </div>

              {data.results.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg bg-amber-50 p-4 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  <AlertTriangle size={18} />
                  <p className="text-sm font-semibold">{isAr ? "لم يتم العثور على أي معلومات متعلقة بهذا السؤال في قاعدة المعرفة." : "No relevant information found in the knowledge base."}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 font-bold text-ink">
                    <CheckCircle2 size={18} className="text-primary-600" />
                    {isAr ? "الفقرات المستخرجة (التي سيعتمد عليها الذكاء الاصطناعي)" : "Retrieved Chunks (AI context)"}
                  </h3>
                  {data.results.map((result, i) => (
                    <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="flex items-center gap-2 text-xs font-bold text-slate-500">
                          <Database size={14} /> {result.sourceTitle}
                        </span>
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                          {isAr ? "تطابق" : "Match"}: {result.score}%
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-7 text-ink">{result.text}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/50">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={isAr ? "اطرح سؤالك هنا لتجربة البحث..." : "Ask your question here to test..."}
              className="field flex-1"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="btn-primary"
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
              <span className="hidden sm:inline">{isAr ? "اختبار" : "Test"}</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
