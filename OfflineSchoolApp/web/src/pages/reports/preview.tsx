// web/src/pages/reports/preview.tsx
import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api from "@/services/api";
import { ArrowLeft, Edit2, Loader2, AlertCircle, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function TemplatePreviewPage() {
  const { t } = useTranslation();
  const navigate     = useNavigate();
  const [params]     = useSearchParams();
  const user         = useAuthStore((s) => s.user);
  const schoolId     = user?.schoolId;

  const templateId = params.get("id");
  const examId     = params.get("examId")    || undefined;
  const studentId  = params.get("studentId") || undefined;

  const [html,    setHtml]    = useState<string | null>(null);
  const [name,    setName]    = useState("Preview");
  const [isRaw,   setIsRaw]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!templateId) {
      setError("No template ID provided.");
      setLoading(false);
      return;
    }

    // ✅ POST — backend uses POST for preview, not GET
    // schoolId, examId, studentId go in the request body
    api.post(`/templates/${templateId}/preview`, {
      schoolId,
      ...(examId    ? { examId }    : {}),
      ...(studentId ? { studentId } : {}),
    })
      .then((res) => {
        const data = res.data;
        setHtml(data.renderedHtml);
        setName(data.templateName || "Preview");
        setIsRaw(data.isRaw       || false);
      })
      .catch((err) => {
        setError(err?.response?.data?.error || err.message);
      })
      .finally(() => setLoading(false));
  }, [templateId, examId, studentId, schoolId]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex
                      items-center gap-4 shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="w-9 h-9 flex items-center justify-center rounded-xl
                     bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          <ArrowLeft size={20} className="text-gray-700" />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900 truncate">{name}</h1>
          <p className="text-xs text-gray-500">
            {examId ? "Live Preview" : "Layout Preview"}
          </p>
        </div>
        {templateId && (
          <button
            onClick={() =>
              navigate(`/reports/builder?id=${templateId}`)
            }
            className="flex items-center gap-2 bg-blue-50 hover:bg-blue-100
                       text-blue-600 text-sm font-semibold px-4 py-2 rounded-lg
                       border border-blue-200 transition-colors"
          >
            <Edit2 size={14} />
            {t("common.edit")}
          </button>
        )}
      </div>

      {/* Raw-mode banner */}
      {isRaw && !loading && !error && (
        <div className="flex items-start gap-3 bg-blue-50 border-b
                        border-blue-200 px-6 py-3 text-sm text-blue-700">
          <Info size={16} className="mt-0.5 shrink-0" />
          <p>
            Showing layout only — placeholders are still visible.
            Open with a real student to see filled data.
          </p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center gap-3">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <span className="text-gray-500 text-sm">Rendering preview…</span>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <AlertCircle size={48} className="text-red-400" />
          <p className="text-sm text-red-600 text-center max-w-sm">{error}</p>
          <button
            onClick={() => navigate(-1)}
            className="bg-blue-600 text-white text-sm font-semibold
                       px-5 py-2.5 rounded-lg hover:bg-blue-700 transition-colors"
          >
            {t("templates.goBack")}
          </button>
        </div>
      )}

      {/* Iframe preview */}
      {html && !loading && !error && (
        <iframe
          srcDoc={html}
          className="flex-1 w-full border-0"
          sandbox="allow-same-origin"
          title={t("templates.previewTitle")}
          style={{ minHeight: "calc(100vh - 64px)" }}
        />
      )}
    </div>
  );
}