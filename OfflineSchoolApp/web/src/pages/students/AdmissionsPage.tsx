// web/src/pages/students/AdmissionsPage.tsx
import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  UserPlus,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  School,
  Users,
  Calendar,
  Phone,
  Mail,
  FileText,
  Eye,
  X,
  Clipboard,
  ChevronLeft,
} from "lucide-react";

import { useUser } from "@/store/auth.store";
import { fetchClasses } from "@/services/class.service";
import {
  fetchPendingApplications,
  approveApplication,
  rejectApplication,
  type StudentApplication,
  type ApplicationDocument,
} from "@/services/studentApplications.service";
import { cn } from "@/utils/cn";
import { type Semantic, type TileTone } from "@/config/sections";
import { ACCENT_BADGE, ACCENT_LEFT_CARD, DASH_TINT, dashTint } from "@/config/dashboardTint";
import { PageIcon } from "@/components/ui/PageHeader";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useToast }       from "@/components/ui/Toast";
import { formatDay } from "../../../../shared/dateFormat.js";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface SchoolClass {
  _id:     string;
  id?:     string;
  name:    string;
  level?:  string;
  section?: string;
}

interface FlashMessage {
  kind:      "success" | "warning";
  title:     string;
  message:   string;
  copyText?: string;
}

// ─────────────────────────────────────────────────────────
// CONSTANTS / HELPERS
// ─────────────────────────────────────────────────────────

const STALE_DAYS = 3;
const STALE_MS   = STALE_DAYS * 24 * 60 * 60 * 1000;

const isStaleApplication = (createdAt?: string | null): boolean => {
  if (!createdAt) return false;
  const ts = new Date(createdAt).getTime();
  return !Number.isNaN(ts) && ts < Date.now() - STALE_MS;
};

const formatDate = (value?: string | null): string => {
  return formatDay(value, i18n.t("common.unknownDate"));
};

const resolveDocumentUrl = (uri?: string | null): string | null => {
  if (!uri) return null;
  if (/^https?:\/\//i.test(uri)) return uri;

  if (uri.startsWith("/uploads")) {
    const isDevVite = window.location.port === "3000";
    const origin = isDevVite
      ? `${window.location.protocol}//${window.location.hostname}:5000`
      : window.location.origin;
    return `${origin}${uri}`;
  }

  return uri;
};

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function FlashBanner({
  flash,
  onClose,
  onCopy,
}: {
  flash: FlashMessage;
  onClose: () => void;
  onCopy?: () => void;
}) {
  const { t } = useTranslation();
  const isSuccess = flash.kind === "success";

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3",
        isSuccess
          ? "border-emerald-200 bg-emerald-50"
          : "border-amber-200 bg-amber-50"
      )}
    >
      <div className="flex items-start gap-3">
        {isSuccess ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        ) : (
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        )}

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-sm font-bold",
              isSuccess ? "text-emerald-800" : "text-amber-800"
            )}
          >
            {flash.title}
          </p>
          <p
            className={cn(
              "mt-1 text-sm whitespace-pre-line",
              isSuccess ? "text-emerald-700" : "text-amber-700"
            )}
          >
            {flash.message}
          </p>

          {flash.copyText && (
            <button
              onClick={onCopy}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              <Clipboard className="h-3.5 w-3.5" />
              {t("admissions.copyPassword")}
            </button>
          )}
        </div>

        <button
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-white/50 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * A count over the list: the kind's tinted card with a solid icon square.
 * When the count means something, `semantic` swaps in an amber (warning) or
 * red (error) border and gives the figure that status colour.
 */
function SummaryCard({
  icon: Icon,
  tone,
  semantic,
  value,
  label,
}: {
  icon: React.ElementType;
  tone: TileTone;
  semantic?: Semantic | null;
  value: number;
  label: string;
}) {
  const tint = dashTint(tone);
  const card =
    semantic === "warning" ? tint.warnCard :
    semantic === "error"   ? tint.errorCard :
    tint.card;
  const figure =
    semantic === "warning" ? "text-warning-text" :
    semantic === "error"   ? "text-danger-text" :
    tint.number;
  return (
    <div className={cn("flex flex-1 flex-col items-center gap-1 px-4 py-4", card)}>
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-control", tint.box)}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className={cn("text-xl font-bold", figure)}>{value}</span>
      <span className="text-xs font-semibold text-ink-muted">{label}</span>
    </div>
  );
}

function ApplicationCard({
  application,
  onReview,
}: {
  application: StudentApplication;
  onReview: (app: StudentApplication) => void;
}) {
  const { t } = useTranslation();
  const stale    = isStaleApplication(application.created_at);
  const docCount = application.documents?.length ?? 0;

  return (
    <div
      className={cn(
        stale ? DASH_TINT.blue.errorCard : DASH_TINT.blue.card,
        "rounded-2xl p-4"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            stale ? DASH_TINT.red.box : DASH_TINT.amber.box
          )}
        >
          <UserPlus className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-ink">
            {application.name}
          </p>
          <p className="truncate text-xs text-ink-muted">
            {application.email || t("admissions.noEmail")}
          </p>
        </div>

        <span
          className={cn(
            "shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ring-inset",
            stale
              ? ACCENT_BADGE.red
              : ACCENT_BADGE.amber
          )}
        >
          {stale ? t("common.stale") : t("common.pending")}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-ink-body sm:grid-cols-2">
        <div className="flex items-center gap-1.5">
          <School className="h-3.5 w-3.5 text-primary-500" />
          <span>{application.className || application.grade || t("admissions.noClassSelected")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Users className={cn("h-3.5 w-3.5", DASH_TINT.blue.glyph)} />
          <span>{application.guardianName || t("admissions.noGuardian")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Calendar className={cn("h-3.5 w-3.5", DASH_TINT.blue.glyph)} />
          <span>{formatDate(application.created_at)}</span>
        </div>
        {application.phone ? (
          <div className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5 text-emerald-500" />
            <span>{application.phone}</span>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 text-emerald-500" />
          <span>
            {docCount} {docCount === 1 ? "document" : "documents"}
          </span>
        </div>
      </div>

      <button
        onClick={() => onReview(application)}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
      >
        <Eye className="h-4 w-4" />
        {t("admissions.review")}
      </button>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          {label}
        </p>
        <p className="mt-0.5 text-sm font-medium text-ink whitespace-pre-line">
          {value || t("common.notProvided")}
        </p>
      </div>
    </div>
  );
}

function DocumentCard({
  doc,
  index,
  onOpen,
}: {
  doc: ApplicationDocument;
  index: number;
  onOpen: (doc: ApplicationDocument) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={() => onOpen(doc)}
      className={cn(ACCENT_LEFT_CARD.slate, "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:shadow-lift")}
    >
      <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", DASH_TINT.slate.box)}>
        <FileText className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">
          {doc.title || t("admissions.documentN", { n: index + 1 })}
        </p>
        <p className="truncate text-xs text-ink-muted">
          {doc.type || t("admissions.attachedDocument")}
        </p>
      </div>
      <Eye className={cn("h-4 w-4 shrink-0", DASH_TINT.slate.glyph)} />
    </button>
  );
}

function ClassOption({
  classItem,
  isSelected,
  onSelect,
}: {
  classItem: SchoolClass;
  isSelected: boolean;
  onSelect: (cls: SchoolClass) => void;
}) {
  return (
    <button
      onClick={() => onSelect(classItem)}
      className={cn(
        "flex w-full items-center gap-2 border-b border-gray-100 px-4 py-3 text-left last:border-b-0",
        isSelected ? "bg-primary-50" : "hover:bg-gray-50"
      )}
    >
      <School className={cn("h-4 w-4", isSelected ? "text-primary-600" : "text-gray-400")} />
      <span className={cn(
        "flex-1 text-sm",
        isSelected ? "font-bold text-primary-700" : "font-medium text-gray-700"
      )}>
        {classItem.name}
      </span>
      {isSelected && (
        <CheckCircle2 className="h-4 w-4 text-primary-600" />
      )}
    </button>
  );
}

function ReviewSheet({
  application,
  classes,
  selectedClassId,
  rejectReason,
  setRejectReason,
  showClassPicker,
  setShowClassPicker,
  selectedClass,
  approving,
  rejecting,
  onClose,
  onApprove,
  onReject,
  onClassSelect,
  onOpenDocument,
}: {
  application: StudentApplication;
  classes: SchoolClass[];
  selectedClassId: string | null;
  rejectReason: string;
  setRejectReason: (v: string) => void;
  showClassPicker: boolean;
  setShowClassPicker: (v: boolean | ((p: boolean) => boolean)) => void;
  selectedClass: SchoolClass | null;
  approving: boolean;
  rejecting: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onClassSelect: (cls: SchoolClass) => void;
  onOpenDocument: (doc: ApplicationDocument) => void;
}) {
  const { t } = useTranslation();
  const isBusy = approving || rejecting;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-hidden rounded-t-3xl rounded-b-2xl bg-gray-50 shadow-2xl">
        <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-gray-300" />

        <div className="flex items-center gap-3 border-b border-gray-100 bg-white px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold text-gray-900">{t("admissions.review")}</h2>
            <p className="text-sm text-gray-500">
              {t("admissions.reviewHint")}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[calc(92vh-80px)] overflow-y-auto px-5 py-4">
          {/* Student Details */}
          <section className={cn("mb-4 rounded-2xl border border-line bg-surface p-4", DASH_TINT.blue.edge)}>
            <div className="mb-4 flex items-center gap-2">
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.blue.box)} aria-hidden="true">
                <Users className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-bold text-ink">{t("admissions.studentDetails")}</h3>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <DetailRow
                icon={<Users className="h-4 w-4 text-amber-600" />}
                label={t("common.fullName")}
                value={application.name}
              />
              <DetailRow
                icon={<Mail className="h-4 w-4 text-primary-600" />}
                label={t("common.email")}
                value={application.email || t("admissions.noEmail")}
              />
              <DetailRow
                icon={<Phone className="h-4 w-4 text-emerald-600" />}
                label={t("common.phone")}
                value={application.phone}
              />
              <DetailRow
                icon={<Users className="h-4 w-4 text-primary-600" />}
                label={t("admissions.guardian")}
                value={application.guardianName}
              />
              <DetailRow
                icon={<School className="h-4 w-4 text-purple-600" />}
                label={t("admissions.appliedForClass")}
                value={application.className || application.grade || t("common.notSpecified")}
              />
              <DetailRow
                icon={<Calendar className="h-4 w-4 text-primary-600" />}
                label={t("admissions.appliedOn")}
                value={formatDate(application.created_at)}
              />
              {application.address ? (
                <DetailRow
                  icon={<School className={cn("h-4 w-4", DASH_TINT.blue.glyph)} />}
                  label={t("common.address")}
                  value={application.address}
                />
              ) : null}
              {application.notes ? (
                <DetailRow
                  icon={<FileText className={cn("h-4 w-4", DASH_TINT.blue.glyph)} />}
                  label={t("common.notes")}
                  value={application.notes}
                />
              ) : null}
            </div>
          </section>

          {/* Documents */}
          <section className={cn("mb-4 rounded-2xl border border-line bg-surface p-4", DASH_TINT.blue.edge)}>
            <div className="mb-4 flex items-center gap-2">
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.slate.box)} aria-hidden="true">
                <FileText className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-bold text-ink">{t("common.documents")}</h3>
            </div>

            {application.documents?.length ? (
              <div className="flex flex-col gap-2">
                {application.documents.map((doc, index) => (
                  <DocumentCard
                    key={doc.id || `doc-${index}`}
                    doc={doc}
                    index={index}
                    onOpen={onOpenDocument}
                  />
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-line bg-accent-slate-soft px-3 py-3 text-sm text-ink-muted">
                <FileText className={cn("h-4 w-4", DASH_TINT.slate.glyph)} />
                {t("admissions.noDocuments")}
              </div>
            )}
          </section>

          {/* Class assignment */}
          <section className={cn("mb-4 rounded-2xl border border-line bg-surface p-4", DASH_TINT.blue.edge)}>
            <div className="mb-4 flex items-center gap-2">
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.indigo.box)} aria-hidden="true">
                <School className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-bold text-ink">
                {t("admissions.assignClass")}
              </h3>
            </div>

            {classes.length === 0 ? (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {t("students.noActiveClasses")}
              </div>
            ) : (
              <>
                <button
                  onClick={() => setShowClassPicker((p) => !p)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-xl border-2 px-4 py-3 text-left transition-colors",
                    selectedClass
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 bg-gray-50 hover:bg-white"
                  )}
                >
                  <span
                    className={cn(
                      "text-sm font-medium",
                      selectedClass ? "text-gray-900" : "text-gray-400"
                    )}
                  >
                    {selectedClass ? selectedClass.name : "Select a class…"}
                  </span>
                  {showClassPicker ? (
                    <ChevronLeft className="h-4 w-4 rotate-90 text-gray-500" />
                  ) : (
                    <ChevronLeft className="h-4 w-4 -rotate-90 text-gray-500" />
                  )}
                </button>

                {showClassPicker && (
                  <div className="mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white">
                    {classes.map((cls) => (
                      <ClassOption
                        key={cls._id}
                        classItem={cls}
                        isSelected={String(selectedClassId) === String(cls._id)}
                        onSelect={onClassSelect}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Rejection reason */}
          <section className={cn("mb-4 rounded-2xl border border-line bg-surface p-4", DASH_TINT.blue.edge)}>
            <div className="mb-4 flex items-center gap-2">
              <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.red.box)} aria-hidden="true">
                <AlertCircle className="h-4 w-4" />
              </span>
              <h3 className="text-sm font-bold text-ink">
                {t("admissions.rejectionReason")} <span className="font-normal text-ink-muted">(Optional)</span>
              </h3>
            </div>

            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={isBusy}
              rows={3}
              placeholder={t("admissions.rejectionPh")}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none transition-colors focus:border-primary-500 focus:bg-white"
            />
          </section>

          {/* Actions */}
          <div className="sticky bottom-0 grid grid-cols-2 gap-3 bg-gray-50 pb-2 pt-1">
            <button
              onClick={onReject}
              disabled={isBusy}
              className={cn(
                "flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white transition-colors",
                isBusy ? "bg-gray-400 cursor-not-allowed" : "bg-red-600 hover:bg-red-700"
              )}
            >
              {rejecting ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {t("exams.rejecting")}
                </>
              ) : (
                "Reject"
              )}
            </button>

            <button
              onClick={onApprove}
              disabled={isBusy || classes.length === 0}
              className={cn(
                "flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white transition-colors",
                isBusy || classes.length === 0
                  ? "bg-gray-400 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-700"
              )}
            >
              {approving ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  {t("admissions.approving")}
                </>
              ) : (
                "Approve"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────

export default function AdmissionsPage() {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const user      = useUser();
  const schoolId  = user?.schoolId ?? "";
  const qc        = useQueryClient();

  const [selectedApplication, setSelectedApplication] = useState<StudentApplication | null>(null);
  const [selectedClassId,     setSelectedClassId]     = useState<string | null>(null);
  const [rejectReason,        setRejectReason]        = useState("");
  const [showClassPicker,     setShowClassPicker]     = useState(false);
  const [flash,               setFlash]               = useState<FlashMessage | null>(null);

  // ── Queries ────────────────────────────────────────────

  const applicationsQuery = useQuery<StudentApplication[], Error>({
    queryKey:  ["applications", schoolId],
    queryFn:   () => fetchPendingApplications(schoolId),
    enabled:   !!schoolId,
    staleTime: 30_000,
  });

  const classesQuery = useQuery<SchoolClass[], Error>({
    queryKey:  ["classes", schoolId],
    queryFn:   () => fetchClasses(schoolId),
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  // Memoised: `?? []` is a new array each render, and these feed a useMemo
  // below, which then recomputes every render instead of memoising.
  const applications = useMemo(() => applicationsQuery.data ?? [], [applicationsQuery.data]);
  const classes      = useMemo(() => classesQuery.data      ?? [], [classesQuery.data]);

  // ── Derived ────────────────────────────────────────────

  const staleCount = useMemo(
    () => applications.filter((a) => isStaleApplication(a.created_at)).length,
    [applications]
  );

  const selectedClass = useMemo(
    () =>
      classes.find(
        (c) => String(c._id ?? c.id) === String(selectedClassId)
      ) || null,
    [classes, selectedClassId]
  );

  // ── Modal helpers ──────────────────────────────────────

  const openReviewModal = useCallback((application: StudentApplication) => {
    setSelectedApplication(application);
    setSelectedClassId(application.classId ? String(application.classId) : null);
    setRejectReason("");
    setShowClassPicker(false);
  }, []);


  const handleClassSelect = useCallback((classItem: SchoolClass) => {
    setSelectedClassId(String(classItem._id ?? classItem.id));
    setShowClassPicker(false);
  }, []);

  const openDocument = useCallback((doc: ApplicationDocument) => {
    const url = resolveDocumentUrl(
      doc.uri || doc.url || doc.fileUrl || null
    );

    if (!url) {
      toast({ kind: "error", title: t("admissions.noDocumentLink") });
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }, [t, toast]);

  const copyToClipboard = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ kind: "success", title: t("common.copied") });
    } catch {
      toast({ kind: "error", title: t("admissions.copyFailed", { value }) });
    }
  }, [t, toast]);

  // ── Mutations ───────────────────────────────────────────

  const approveMutation = useMutation({
    mutationFn: ({ id, classId }: { id: string; classId: string }) =>
      approveApplication(id, classId),
    onSuccess: (result, vars) => {
      const approved = selectedApplication;
      qc.invalidateQueries({ queryKey: ["applications", schoolId] });

      setSelectedApplication(null);
      setSelectedClassId(null);
      setRejectReason("");
      setShowClassPicker(false);

      const className = selectedClass?.name ?? t("admissions.theSelectedClass");
      const appName   = approved?.name ?? t("academic.student");
      const appEmail  = approved?.email ?? "";

      if (result.warning) {
        setFlash({
          kind:    "warning",
          title:   t("admissions.approvedNoEmail"),
          message:
            `${t("admissions.approvedBody", { name: appName, className })}\n\n${result.warning}`,
        });
      } else if (result.emailSent === false && result.tempPassword) {
        setFlash({
          kind:    "success",
          title:   t("admissions.approvedShare"),
          message:
            `${appName} has been approved.\n\n` +
            `Email delivery failed. Share these login details:\n\n` +
            `Email: ${appEmail}\n` +
            `Temp Password: ${result.tempPassword}`,
          copyText: result.tempPassword,
        });
      } else if (result.synced === false) {
        setFlash({
          kind:    "warning",
          title:   t("admissions.approvedOffline"),
          message:
            `${t("admissions.approvedBody", { name: appName, className })}\n\n` +
            t("admissions.offlineNote"),
        });
      } else {
        setFlash({
          kind:    "success",
          title:   t("approvals.approved"),
          message:
            `${t("admissions.approvedBody", { name: appName, className })}\n\n` +
            t("admissions.welcomeEmailSent"),
        });
      }

      // Optional immediate optimistic UI cleanup
      qc.invalidateQueries({ queryKey: ["applications", schoolId] });
      void vars;
    },
    onError: (err: unknown) => {
      const message =
        (err as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ??
        (err instanceof Error ? err.message : null) ??
        t("admissions.approveFailed");

      toast({ kind: "error", title: message });
      qc.invalidateQueries({ queryKey: ["applications", schoolId] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectApplication(id, reason),
    onSuccess: () => {
      const rejected = selectedApplication;
      qc.invalidateQueries({ queryKey: ["applications", schoolId] });

      setSelectedApplication(null);
      setSelectedClassId(null);
      setRejectReason("");
      setShowClassPicker(false);

      setFlash({
        kind:    "success",
        title:   t("students.rejected"),
        message: t("admissions.rejectedBody", { name: rejected?.name ?? t("students.theStudent") }),
      });
    },
    onError: (err: unknown) => {
      const message =
        (err as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ??
        (err instanceof Error ? err.message : null) ??
        t("admissions.rejectFailed");

      toast({ kind: "error", title: message });
      qc.invalidateQueries({ queryKey: ["applications", schoolId] });
    },
  });

  /*
   * Declared AFTER the two mutations, because it depends on them.
   *
   * It used to sit above both. The body referencing approveMutation from up
   * there was survivable — a callback body runs later, by which time the const
   * exists — but a dependency array is evaluated during render, so naming them
   * as dependencies from above the declarations is a real temporal-dead-zone
   * error rather than a lint opinion. tsc says so too: TS2448.
   */
  const closeReviewModal = useCallback(() => {
    if (approveMutation.isPending || rejectMutation.isPending) return;
    setSelectedApplication(null);
    setSelectedClassId(null);
    setRejectReason("");
    setShowClassPicker(false);
  }, [approveMutation.isPending, rejectMutation.isPending]);

  // ── Actions ─────────────────────────────────────────────

  const handleApprove = useCallback(async () => {
    if (!selectedApplication) return;

    if (!selectedClassId) {
      toast({ kind: "warning", title: t("admissions.selectClassFirst") });
      return;
    }

    const confirmed = await confirm({
      title:   t("common.confirm"),
      message: t("admissions.approveConfirm", {
        name:      selectedApplication.name,
        className: selectedClass?.name ?? "",
      }),
    });
    if (!confirmed) return;

    approveMutation.mutate({
      id:      selectedApplication.id,
      classId: selectedClassId,
    });
  }, [selectedApplication, selectedClassId, selectedClass, approveMutation, confirm, t, toast]);

  const handleReject = useCallback(async () => {
    if (!selectedApplication) return;

    const confirmed = await confirm({
      title:   t("common.confirm"),
      message: t("admissions.rejectConfirm", { name: selectedApplication.name }),
      kind:    "danger",
    });
    if (!confirmed) return;

    rejectMutation.mutate({
      id:     selectedApplication.id,
      reason: rejectReason,
    });
  }, [selectedApplication, rejectReason, rejectMutation, confirm, t]);

  // ── Loading ─────────────────────────────────────────────

  if (applicationsQuery.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary-600 border-t-transparent" />
        <p className="text-sm font-medium text-gray-400">{t("admissions.loading")}</p>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <PageIcon />
          <div>
            <h1 className="text-2xl font-bold text-ink">{t("admissions.title")}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {t("admissions.pendingCount", { count: applications.length })}
            </p>
          </div>
        </div>

        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["applications", schoolId] })}
          disabled={applicationsQuery.isFetching}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600 transition-colors hover:bg-amber-100 disabled:opacity-50"
          title={t("common.refresh")}
        >
          <RefreshCw
            className={cn("h-4 w-4", applicationsQuery.isFetching && "animate-spin")}
          />
        </button>
      </div>

      {/* Flash */}
      {flash && (
        <FlashBanner
          flash={flash}
          onClose={() => setFlash(null)}
          onCopy={
            flash.copyText
              ? () => copyToClipboard(flash.copyText!)
              : undefined
          }
        />
      )}

      {/* Error */}
      {applicationsQuery.isError && (
        <ErrorBanner
          message={applicationsQuery.error.message || "Failed to load applications."}
        />
      )}

      {/* Summary */}
      <div className="flex gap-3">
        <SummaryCard
          icon={UserPlus}
          tone="students"
          semantic={applications.length > 0 ? "warning" : null}
          value={applications.length}
          label={t("common.pending")}
        />
        <SummaryCard
          icon={AlertCircle}
          tone="students"
          semantic={staleCount > 0 ? "error" : null}
          value={staleCount}
          label={`Over ${STALE_DAYS}d`}
        />
        <SummaryCard
          icon={School}
          tone="classes"
          value={classes.length}
          label={t("academic.class_other")}
        />
      </div>

      {/* Content */}
      {applications.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-line bg-surface px-8 py-16 text-center shadow-sm">
          <span className={cn("flex h-12 w-12 items-center justify-center rounded-card", DASH_TINT.green.box)} aria-hidden="true">
            <CheckCircle2 className="h-6 w-6" />
          </span>
          <p className="mt-3 text-lg font-bold text-ink">{t("admissions.allCaughtUp")}</p>
          <p className="mt-1 max-w-md text-sm text-ink-muted">
            {t("admissions.noPendingBody")}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {applications.map((app) => (
            <ApplicationCard
              key={app.id}
              application={app}
              onReview={openReviewModal}
            />
          ))}
        </div>
      )}

      {/* Bottom sheet review modal */}
      {selectedApplication && (
        <ReviewSheet
          application={selectedApplication}
          classes={classes}
          selectedClassId={selectedClassId}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          showClassPicker={showClassPicker}
          setShowClassPicker={setShowClassPicker}
          selectedClass={selectedClass}
          approving={approveMutation.isPending}
          rejecting={rejectMutation.isPending}
          onClose={closeReviewModal}
          onApprove={handleApprove}
          onReject={handleReject}
          onClassSelect={handleClassSelect}
          onOpenDocument={openDocument}
        />
      )}
    </div>
  );
}