"use client";

import { useEffect, useState } from "react";
import { X, Loader2, Database, Tag, Key } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

type KnowledgeChunk = {
  id: string;
  chunkIndex: number;
  text: string;
  keywords: string[];
  tokens: number;
};

type KnowledgeEntity = {
  id: string;
  type: string;
  value: string;
  originalText: string;
  metadata?: Record<string, any>;
};

type DetailsResponse = {
  success: boolean;
  chunks: KnowledgeChunk[];
  entities: KnowledgeEntity[];
};

type Props = {
  documentId: string;
  documentTitle: string;
  onClose: () => void;
};

export function KnowledgeDetailsModal({ documentId, documentTitle, onClose }: Props) {
  const { locale } = useI18n();
  const isAr = locale === "ar";
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"chunks" | "entities">("chunks");

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const res = await fetch(`/api/knowledge/${documentId}/details`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || (isAr ? "حدث خطأ" : "An error occurred"));
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : (isAr ? "تعذر جلب التفاصيل" : "Failed to load details"));
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [documentId, isAr]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-center justify-between border-b border-slate-100 p-5 dark:border-slate-800">
          <div>
            <h2 className="text-xl font-bold text-ink">{documentTitle}</h2>
            <p className="mt-1 text-sm text-slate-500">{isAr ? "التفاصيل الداخلية لمصدر المعرفة" : "Knowledge source internal details"}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800">
            <X size={20} />
          </button>
        </header>

        <div className="flex border-b border-slate-100 dark:border-slate-800">
          <button
            onClick={() => setActiveTab("chunks")}
            className={`flex-1 border-b-2 p-3 text-sm font-bold transition ${activeTab === "chunks" ? "border-primary-600 text-primary-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {isAr ? "النصوص المجزأة (Chunks)" : "Chunks"}
          </button>
          <button
            onClick={() => setActiveTab("entities")}
            className={`flex-1 border-b-2 p-3 text-sm font-bold transition ${activeTab === "entities" ? "border-primary-600 text-primary-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {isAr ? "الكيانات المستخرجة (Entities)" : "Extracted Entities"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="animate-spin text-primary-600" size={32} />
            </div>
          ) : error ? (
            <div className="rounded-lg bg-red-50 p-4 text-center text-red-700">{error}</div>
          ) : activeTab === "chunks" ? (
            <div className="space-y-4">
              {data?.chunks.length === 0 ? (
                <p className="text-center text-slate-500">{isAr ? "لا توجد نصوص مجزأة." : "No chunks found."}</p>
              ) : (
                data?.chunks.map((chunk) => (
                  <div key={chunk.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
                    <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2 dark:border-slate-800">
                      <span className="flex items-center gap-2 text-xs font-bold text-slate-500">
                        <Database size={14} /> Chunk #{chunk.chunkIndex}
                      </span>
                      <span className="text-xs text-slate-400">{chunk.tokens} {isAr ? "توكن" : "tokens"}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-7 text-ink">{chunk.text}</p>
                    {chunk.keywords.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {chunk.keywords.map((kw, i) => (
                          <span key={i} className="inline-flex items-center gap-1 rounded-md bg-slate-200 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            <Key size={12} /> {kw}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {data?.entities.length === 0 ? (
                <p className="text-center text-slate-500">{isAr ? "لا توجد كيانات مستخرجة." : "No entities found."}</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {data?.entities.map((entity) => (
                    <div key={entity.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900">
                      <div className="flex items-start justify-between">
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                          <Tag size={12} /> {entity.type}
                        </span>
                      </div>
                      <p className="text-base font-bold text-ink">{entity.value}</p>
                      {entity.originalText && entity.originalText !== entity.value && (
                        <p className="text-xs text-slate-500">{isAr ? "في النص الأصلي:" : "Original text:"} {entity.originalText}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
