// web/src/pages/reports/templates.tsx
import { useState, useEffect, useCallback } from "react";
import { useNavigate }  from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api              from "@/services/api";
import { getErrorMessage } from "@/lib/axios";
import { useTranslation } from "react-i18next";
import { useToast }       from "@/components/ui/Toast";
import {
  Plus, Edit2, Eye, Star, Copy, Trash2,
  FileText, Info, Loader2, AlertCircle,
} from "lucide-react";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface Template {
  _id:        string;
  name:       string;
  isDefault:  boolean;
  version:    number;
  variables?: string[];
  updatedAt?: string;
}

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function TemplatesPage() {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const navigate = useNavigate();
  const user     = useAuthStore((s) => s.user);
  const schoolId = user?.schoolId;

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [actionId,  setActionId]  = useState<string | null>(null);

  // ── Load ───────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get("/templates", { params: { schoolId } });
      const data: Template[] =
        res.data?.templates ??
        res.data?.data      ??
        (Array.isArray(res.data) ? res.data : []);
      setTemplates(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [schoolId]);

  useEffect(() => {
    if (!schoolId) return;
    load();
  }, [schoolId]);

  // ── Seed the built-in layout ───────────────────────────

  /**
   * Write the built-in report card layout into an editable template.
   *
   * Without this a school has to author one from scratch, so most never do
   * and per-school templates go unused. The endpoint is idempotent, so
   * pressing this twice returns the existing row rather than making copies.
   */
  const handleSeedDefault = async () => {
    try {
      setActionId("__seed__");
      const res = await api.post("/templates/seed-default", { schoolId });
      await load();
      if (res.data?.created === false) {
        toast({ kind: "info", title: t("templates.seedExists") });
      }
    } catch (err) {
      toast({ kind: "error", title: getErrorMessage(err) });
    } finally {
      setActionId(null);
    }
  };

  // ── Set default ────────────────────────────────────────

  const handleSetDefault = async (id: string) => {
    const ok = await confirm({
      title:   t("common.confirm"),
      message: t("templates.setDefaultConfirm"),
    });
    if (!ok) return;
    try {
      setActionId(id);
      await api.patch(`/templates/${id}/default`, { schoolId });
      await load();
    } catch (err) {
      toast({ kind: "error", title: getErrorMessage(err) });
    } finally {
      setActionId(null);
    }
  };

  // ── Duplicate ──────────────────────────────────────────

  const handleDuplicate = async (id: string) => {
    try {
      setActionId(id);
      await api.post(`/templates/${id}/duplicate`, { schoolId });
      await load();
    } catch (err) {
      toast({ kind: "error", title: getErrorMessage(err) });
    } finally {
      setActionId(null);
    }
  };

  // ── Delete ─────────────────────────────────────────────

  const handleDelete = async (id: string, name: string, isDefault: boolean) => {
    if (isDefault) {
      toast({ kind: "warning", title: t("templates.cannotDeleteDefault") });
      return;
    }
    const ok = await confirm({
      title:   t("common.delete"),
      message: t("templates.deleteConfirm", { name }),
      kind:    "danger",
    });
    if (!ok) return;
    try {
      setActionId(id);
      await api.delete(`/templates/${id}`, { params: { schoolId } });
      await load();
    } catch (err) {
      toast({ kind: "error", title: getErrorMessage(err) });
    } finally {
      setActionId(null);
    }
  };

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{t("templates.title")}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t("templates.blurb")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSeedDefault}
              disabled={actionId === "__seed__"}
              className="flex items-center gap-2 border border-gray-300
                         hover:bg-gray-50 disabled:opacity-50 text-gray-700
                         text-sm font-semibold px-4 py-2 rounded-lg
                         transition-colors"
            >
              {actionId === "__seed__"
                ? <Loader2 size={16} className="animate-spin" />
                : <FileText size={16} />}
              {t("templates.startFromDefault")}
            </button>
            <button
              onClick={() => navigate("/reports/builder")}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700
                         text-white text-sm font-semibold px-4 py-2 rounded-lg
                         transition-colors"
            >
              <Plus size={16} />
              {t("templates.new")}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-4">

        {/* Info banner */}
        <div className="flex items-start gap-3 bg-blue-50 border border-blue-200
                        rounded-xl p-4 text-sm text-blue-700">
          <Info size={18} className="mt-0.5 shrink-0" />
          <p>
            Paste any HTML layout and use{" "}
            <code className="bg-blue-100 px-1 rounded font-mono text-xs">
              {"{{student_name}}"}
            </code>{" "}
            style placeholders. Set one template as <strong>default</strong> and
            it will be used automatically when generating reports.
          </p>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={32} className="animate-spin text-blue-600" />
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="flex items-center gap-3 bg-red-50 border border-red-200
                          rounded-xl p-4 text-sm text-red-700">
            <AlertCircle size={18} className="shrink-0" />
            <span>{error}</span>
            <button
              onClick={load}
              className="ml-auto text-red-700 underline font-medium"
            >
              {t("common.retry")}
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && templates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center
                            justify-center">
              <FileText size={40} className="text-gray-300" />
            </div>
            <h2 className="text-lg font-bold text-gray-700">{t("templates.none")}</h2>
            <p className="text-sm text-gray-500 text-center max-w-sm">
              Create your first report card template by pasting your school's
              HTML layout and using placeholders.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
              <button
                onClick={handleSeedDefault}
                disabled={actionId === "__seed__"}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700
                           disabled:opacity-50 text-white text-sm font-semibold
                           px-5 py-2.5 rounded-lg transition-colors"
              >
                {actionId === "__seed__"
                  ? <Loader2 size={16} className="animate-spin" />
                  : <FileText size={16} />}
                {t("templates.startFromDefault")}
              </button>
              <button
                onClick={() => navigate("/reports/builder")}
                className="flex items-center gap-2 border border-gray-300
                           hover:bg-gray-50 text-gray-700 text-sm font-semibold
                           px-5 py-2.5 rounded-lg transition-colors"
              >
                <Plus size={16} />
                {t("templates.create")}
              </button>
            </div>
          </div>
        )}

        {/* Template cards grid */}
        {!loading && !error && templates.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {templates.map((tmpl) => (
              <TemplateCard
                key={tmpl._id}
                template={tmpl}
                isActioning={actionId === tmpl._id}
                onEdit={() =>
                  navigate(`/reports/builder?id=${tmpl._id}`)
                }
                onPreview={() =>
                  navigate(`/reports/preview?id=${tmpl._id}`)
                }
                onSetDefault={() => handleSetDefault(tmpl._id)}
                onDuplicate={() => handleDuplicate(tmpl._id)}
                onDelete={() =>
                  handleDelete(tmpl._id, tmpl.name, tmpl.isDefault)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// TEMPLATE CARD
// ─────────────────────────────────────────────────────────

interface TemplateCardProps {
  template:     Template;
  isActioning:  boolean;
  onEdit:       () => void;
  onPreview:    () => void;
  onSetDefault: () => void;
  onDuplicate:  () => void;
  onDelete:     () => void;
}

function TemplateCard({
  template, isActioning,
  onEdit, onPreview, onSetDefault, onDuplicate, onDelete,
}: TemplateCardProps) {
  const { t } = useTranslation();
  return (
    <div className={`
      bg-white rounded-2xl border p-5 flex flex-col gap-4
      shadow-sm hover:shadow-md transition-shadow
      ${template.isDefault ? "border-blue-500 border-2" : "border-gray-200"}
    `}>

      {/* Top */}
      <div className="flex items-start gap-3">
        <div className={`
          w-12 h-12 rounded-xl flex items-center justify-center shrink-0
          ${template.isDefault ? "bg-blue-50" : "bg-gray-100"}
        `}>
          <FileText
            size={24}
            className={template.isDefault ? "text-blue-600" : "text-gray-400"}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-gray-900 truncate">{template.name}</h3>
            {template.isDefault && (
              <span className="flex items-center gap-1 bg-blue-50 text-blue-600
                               text-xs font-bold px-2 py-0.5 rounded-full">
                <Star size={10} fill="currentColor" />
                {t("common.default")}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            Version {template.version || 1}
            {template.variables?.length
              ? ` · ${template.variables.length} placeholders`
              : ""}
          </p>
        </div>
      </div>

      {/* Variable chips */}
      {template.variables && template.variables.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {template.variables.slice(0, 5).map((v, i) => (
            <span
              key={i}
              className="bg-gray-100 text-gray-600 text-xs font-mono
                         px-2 py-0.5 rounded"
            >
              {v}
            </span>
          ))}
          {template.variables.length > 5 && (
            <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded">
              +{template.variables.length - 5} more
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-100">
        {isActioning ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
            <Loader2 size={14} className="animate-spin" />
            <span>{t("common.processing")}</span>
          </div>
        ) : (
          <>
            <ActionButton icon={<Eye size={13} />}   label={t("common.preview")} onClick={onPreview}    color="gray"   />
            <ActionButton icon={<Edit2 size={13} />} label={t("common.edit")}    onClick={onEdit}       color="blue"   />
            {!template.isDefault && (
              <ActionButton icon={<Star size={13} />} label={t("common.default")} onClick={onSetDefault} color="yellow" />
            )}
            <ActionButton icon={<Copy size={13} />}  label={t("common.copy")}   onClick={onDuplicate}  color="purple" />
            <ActionButton icon={<Trash2 size={13} />} label={t("common.delete")} onClick={onDelete}     color="red"    />
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// ACTION BUTTON
// ─────────────────────────────────────────────────────────

type ButtonColor = "gray" | "blue" | "yellow" | "purple" | "red";

const COLOR_MAP: Record<ButtonColor, string> = {
  gray:   "border-gray-200   text-gray-600   hover:bg-gray-50",
  blue:   "border-blue-200   text-blue-600   hover:bg-blue-50",
  yellow: "border-yellow-200 text-yellow-600 hover:bg-yellow-50",
  purple: "border-purple-200 text-purple-600 hover:bg-purple-50",
  red:    "border-red-200    text-red-600    hover:bg-red-50",
};

function ActionButton({
  icon, label, onClick, color,
}: {
  icon:    React.ReactNode;
  label:   string;
  onClick: () => void;
  color:   ButtonColor;
}) {
  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-1.5 text-xs font-semibold
        px-2.5 py-1.5 rounded-lg border transition-colors
        ${COLOR_MAP[color]}
      `}
    >
      {icon}
      {label}
    </button>
  );
}