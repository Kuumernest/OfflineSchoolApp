import { useState, useCallback, useRef }          from "react";
import { useNavigate, useParams }                from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  User,
  Mail,
  Phone,
  School,
  Calendar,
  Hash,
  Users,
  ArrowRightLeft,
  Ban,
  RefreshCw,
  Trash2,
  AlertCircle,
  CheckCircle2,
  MapPin,
  IdCard,
  KeyRound,
  ShieldAlert,
} from "lucide-react";

import { useUser }              from "@/store/auth.store";
import { useToast }             from "@/components/ui/Toast";
import { fetchClasses }         from "@/services/class.service";
import {
  fetchStudentById,
  suspendStudent,
  restoreStudent,
  moveStudentToClass,
  deleteStudent,
}                               from "@/services/student.service";
import { cn }                   from "@/utils/cn";
import type { Student }         from "@/types";
import { useTranslation } from "react-i18next";
import { Button }               from "@/components/ui/Button";
import { getErrorMessage }      from "@/lib/api";
import {
  uploadStudentPhoto, deleteStudentPhoto,
} from "@/services/document.service";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface SchoolClass {
  _id:      string;
  id?:      string;
  name:     string;
  level?:   string;
  section?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY KEYS
// ─────────────────────────────────────────────────────────────────────────────

const QK = {
  student:  (id: string)       => ["student",  id]       as const,
  classes:  (schoolId: string) => ["classes",  schoolId] as const,
  students: (schoolId: string) => ["students", schoolId] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const getStatusConfig = (status: string) => {
  switch (status?.toLowerCase()) {
    case "suspended":
      return {
        label:  "Suspended",
        color:  "text-red-700",
        bg:     "bg-red-50",
        border: "border-red-200",
        dot:    "bg-red-500",
      };
    case "inactive":
      return {
        label:  "Inactive",
        color:  "text-gray-600",
        bg:     "bg-gray-50",
        border: "border-gray-200",
        dot:    "bg-gray-400",
      };
    default:
      return {
        label:  "Active",
        color:  "text-emerald-700",
        bg:     "bg-emerald-50",
        border: "border-emerald-200",
        dot:    "bg-emerald-500",
      };
  }
};

const formatDate = (value?: string | null): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, {
        year:  "numeric",
        month: "long",
        day:   "numeric",
      });
};

/** Extracts a human-readable message from any thrown error shape. */
const extractMessage = (err: unknown): string =>
  (err as { response?: { data?: { message?: string } } })
    ?.response?.data?.message ??
  (err instanceof Error ? err.message : "Please try again.");

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon,
  label,
  value,
  iconColor = "text-gray-400",
  mono = false,
}: {
  icon:       React.ElementType;
  label:      string;
  value:      string | null | undefined;
  iconColor?: string;
  mono?:      boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0">
        <Icon className={cn("h-4 w-4", iconColor)} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>
        <p className={cn(
          "mt-0.5 text-sm font-medium text-gray-900 wrap-break-word",
          mono && "font-mono tracking-widest"
        )}>
          {value}
        </p>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title:    string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-sm font-bold text-gray-900">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  description,
  onClick,
  variant  = "default",
  disabled = false,
}: {
  icon:        React.ElementType;
  label:       string;
  description: string;
  onClick:     () => void;
  variant?:    "default" | "warning" | "danger" | "success";
  disabled?:   boolean;
}) {
  const variants = {
    default: "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100",
    warning: "border-amber-200  bg-amber-50  text-amber-700  hover:bg-amber-100",
    danger:  "border-red-200    bg-red-50    text-red-700    hover:bg-red-100",
    success: "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-50",
        variants[variant]
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{label}</p>
        <p className="mt-0.5 text-xs opacity-70">{description}</p>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT NUMBER CARD
// ─────────────────────────────────────────────────────────────────────────────

function EnrollmentCard({
  enrollmentNo,
  mustResetPassword,
}: {
  enrollmentNo:      string | null;
  mustResetPassword: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!enrollmentNo) return;
    try {
      await navigator.clipboard.writeText(enrollmentNo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  };

  if (!enrollmentNo) return null;

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <IdCard className="h-4 w-4 text-indigo-600" />
        <h2 className="text-sm font-bold text-indigo-900">{t("studentDetail.credentials")}</h2>
      </div>

      <p className="text-xs text-indigo-600 mb-3 leading-relaxed">
        The student uses this enrollment number to log in from any device.
        Their first password is generated automatically — it was shown once
        when the student was enrolled (or sent to their email). They will be
        asked to set their own password at first login.
      </p>

      {/* Enrollment number display */}
      <div className="flex items-center gap-2 rounded-xl bg-white border border-indigo-200 px-4 py-3">
        <span className="flex-1 font-mono text-base font-bold tracking-widest text-indigo-800 select-all">
          {enrollmentNo}
        </span>
        <button
          onClick={handleCopy}
          className={cn(
            "shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition",
            copied
              ? "bg-emerald-100 text-emerald-700"
              : "bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
          )}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>

      {/* Must-reset warning */}
      {mustResetPassword && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
          <ShieldAlert className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-800 leading-relaxed">
            <span className="font-semibold">{t("studentDetail.passwordNotChangedYet")}</span>{" "}
            The student is still using their generated first password. Ask them to
            log in and change it.
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVE CLASS PICKER
// ─────────────────────────────────────────────────────────────────────────────

function MoveClassPicker({
  classes,
  currentClassId,
  onSelect,
  onCancel,
}: {
  classes:        SchoolClass[];
  currentClassId: string | null | undefined;
  onSelect:       (cls: SchoolClass) => void;
  onCancel:       () => void;
}) {
  const { t } = useTranslation();
  const others = classes.filter(
    (c) => String(c._id ?? c.id) !== String(currentClassId ?? "")
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-indigo-600" />
          <h3 className="text-lg font-bold text-gray-900">{t("studentDetail.moveToClass")}</h3>
        </div>

        {others.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-800">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {t("studentDetail.noOtherClasses")}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-xl border border-gray-200">
            {others.map((cls, i) => (
              <button
                key={cls._id ?? cls.id}
                onClick={() => onSelect(cls)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-indigo-50 transition-colors",
                  i < others.length - 1 && "border-b border-gray-100"
                )}
              >
                <School className="h-4 w-4 shrink-0 text-indigo-500" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {cls.name}
                  </p>
                  {cls.level && (
                    <p className="text-xs text-gray-400">Level {cls.level}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <button
          onClick={onCancel}
          className="mt-4 w-full rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The photo printed on the student's ID card.
 *
 * The student can set their own from their profile on the phone; this exists
 * because most cannot — a young child has no account they use, and the picture
 * is taken at the desk during enrolment. Without an office-side control the
 * card's photo box could only ever be filled by students old enough to sign in.
 */
function PhotoCard({
  studentId, schoolId, photoUrl, onChanged,
}: {
  studentId: string;
  schoolId:  string;
  photoUrl:  string | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const src = photoUrl
    ? (/^https?:/i.test(photoUrl) ? photoUrl : photoUrl)
    : null;

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      // Read as a data URL and hand over just the payload — the server sniffs
      // the real format from the magic bytes rather than trusting us.
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });

      await uploadStudentPhoto(studentId, schoolId, base64);
      toast({ kind: "success", title: t("photo.saved") });
      onChanged();
    } catch (err) {
      toast({ kind: "error", title: t("photo.failed"), message: getErrorMessage(err) });
    } finally {
      setBusy(false);
      // Cleared so choosing the same file twice still fires a change event.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onRemove = async () => {
    const ok = await confirm({
      title:   t("photo.removeTitle"),
      message: t("photo.removeBody"),
      confirmLabel: t("common.delete"),
      kind: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteStudentPhoto(studentId, schoolId);
      onChanged();
    } catch (err) {
      toast({ kind: "error", title: t("photo.failed"), message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex h-[96px] w-[72px] flex-none items-center justify-center overflow-hidden rounded-lg border-2 border-indigo-500 bg-indigo-50">
        {src
          ? <img src={src} alt="" className="h-full w-full object-cover" />
          : <IdCard className="h-8 w-8 text-indigo-300" aria-hidden="true" />}
      </div>

      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-bold text-gray-700">{t("photo.title")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("photo.hint")}</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <Button
            size="sm"
            loading={busy}
            onClick={() => inputRef.current?.click()}
          >
            {photoUrl ? t("photo.change") : t("photo.add")}
          </Button>
          {photoUrl && !busy && (
            <Button size="sm" variant="secondary" onClick={onRemove}>
              {t("common.delete")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StudentDetailPage() {
  const { t } = useTranslation();
  const { id }   = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const qc       = useQueryClient();
  const { toast, confirm } = useToast();

  const [showMovePicker, setShowMovePicker] = useState(false);

  // ── Queries ───────────────────────────────────────────────────────────────

  const studentQuery = useQuery<Student, Error>({
    queryKey:  QK.student(id ?? ""),
    queryFn:   () => fetchStudentById(id!),
    enabled:   !!id,
    staleTime: 30_000,
  });

  const classesQuery = useQuery<SchoolClass[], Error>({
    queryKey:  QK.classes(schoolId),
    queryFn:   () => fetchClasses(schoolId) as Promise<SchoolClass[]>,
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  const student = studentQuery.data;
  const classes = classesQuery.data ?? [];

  // ── Cache invalidation helper ─────────────────────────────────────────────

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: QK.student(id ?? "") });
    qc.invalidateQueries({ queryKey: QK.students(schoolId) });
  }, [qc, id, schoolId]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const suspendMutation = useMutation({
    mutationFn: () => suspendStudent(id!),
    onSuccess: () => {
      invalidate();
      toast({ kind: "success", title: "Student Suspended", message: `${student?.name} has been suspended.` });
    },
    onError: (err) => toast({ kind: "error", title: "Suspend Failed", message: extractMessage(err) }),
  });

  const restoreMutation = useMutation({
    mutationFn: () => restoreStudent(id!),
    onSuccess: () => {
      invalidate();
      toast({ kind: "success", title: "Student Restored", message: `${student?.name} has been restored.` });
    },
    onError: (err) => toast({ kind: "error", title: "Restore Failed", message: extractMessage(err) }),
  });

  const moveMutation = useMutation({
    mutationFn: (classId: string) => moveStudentToClass(id!, classId),
    onSuccess: (_data, classId) => {
      setShowMovePicker(false);
      invalidate();
      const cls = classes.find((c) => String(c._id ?? c.id) === String(classId));
      toast({ kind: "success", title: "Student Moved", message: `${student?.name} moved to ${cls?.name ?? "new class"}.` });
    },
    onError: (err) => {
      setShowMovePicker(false);
      toast({ kind: "error", title: "Move Failed", message: extractMessage(err) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteStudent(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.students(schoolId) });
      toast({ kind: "success", title: "Student Deleted", message: `${student?.name} has been permanently removed.` });
      navigate("/students");
    },
    onError: (err) => toast({ kind: "error", title: "Delete Failed", message: extractMessage(err) }),
  });

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleSuspend = useCallback(async () => {
    const yes = await confirm({
      title:        t("studentDetail.suspend"),
      message:      `Are you sure you want to suspend "${student?.name}"?\n\nThey will not be able to log in until restored.`,
      confirmLabel: "Suspend",
      kind:         "warning",
    });
    if (yes) suspendMutation.mutate();
  }, [student, confirm, suspendMutation, t]);

  const handleRestore = useCallback(async () => {
    const yes = await confirm({
      title:        t("studentDetail.restore"),
      message:      `Restore "${student?.name}" and re-enable their account?`,
      confirmLabel: "Restore",
      kind:         "default",
    });
    if (yes) restoreMutation.mutate();
  }, [student, confirm, restoreMutation, t]);

  const handleDelete = useCallback(async () => {
    const yes = await confirm({
      title:        t("studentDetail.delete"),
      message:      `Permanently delete "${student?.name}"?\n\nThis action cannot be undone.`,
      confirmLabel: "Delete",
      kind:         "danger",
    });
    if (yes) deleteMutation.mutate();
  }, [student, confirm, deleteMutation, t]);

  const handleMoveSelect = useCallback(
    async (cls: SchoolClass) => {
      const yes = await confirm({
        title:        "Move Student",
        message:      `Move "${student?.name}" to "${cls.name}"?`,
        confirmLabel: "Move",
        kind:         "default",
      });
      if (yes) moveMutation.mutate(String(cls._id ?? cls.id));
    },
    [student, confirm, moveMutation]
  );

  // ── Derived state ─────────────────────────────────────────────────────────

  const isSuspended  = student?.status?.toLowerCase() === "suspended";
  const statusConfig = getStatusConfig(student?.status ?? "active");
  const isBusy       =
    suspendMutation.isPending ||
    restoreMutation.isPending ||
    moveMutation.isPending    ||
    deleteMutation.isPending;

  // 🔧 Backend now returns className as a top-level string (enriched list).
  // Support both shapes so this works with legacy and current API responses.
  const classNameDisplay = student?.className || student?.class?.name;
  const classIdForMove   = student?.classId || student?.class?._id || student?.class?.id;

  // ── Loading state ─────────────────────────────────────────────────────────

  if (studentQuery.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        <p className="text-sm font-medium text-gray-400">Loading student…</p>
      </div>
    );
  }

  if (studentQuery.isError || !student) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50">
          <AlertCircle className="h-7 w-7 text-red-500" />
        </div>
        <p className="text-lg font-bold text-gray-900">{t("studentDetail.notFound")}</p>
        <p className="text-sm text-gray-400">
          {t("studentDetail.notFoundHint")}
        </p>
        <button
          onClick={() => navigate("/students")}
          className="mt-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
        >
          {t("studentDetail.back")}
        </button>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const firstLetter       = (student.name || "?").charAt(0).toUpperCase();
  // 🔧 Backend normaliseStudent guarantees enrollmentNo (mapped from admissionNo if needed)
  const enrollmentNo      = student.enrollmentNo ?? null;
  const mustResetPassword = student.mustResetPassword ?? false;

  return (
    <div className="flex flex-col gap-6">

      {/* ── Header ── */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate("/students")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold text-gray-900">
            {student.name}
          </h1>
          <p className="text-sm text-gray-500">{t("studentDetail.title")}</p>
        </div>

        <button
          onClick={() => studentQuery.refetch()}
          disabled={studentQuery.isFetching}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50 transition-colors"
          title={t("common.refresh")}
        >
          <RefreshCw
            className={cn("h-4 w-4", studentQuery.isFetching && "animate-spin")}
          />
        </button>
      </div>

      {/* ── Profile card ── */}
      <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-4">
          {/* Avatar */}
          <div
            className={cn(
              "flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold",
              isSuspended
                ? "bg-red-100 text-red-600"
                : "bg-indigo-100 text-indigo-600"
            )}
          >
            {firstLetter}
          </div>

          {/* Name + badges */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-bold text-gray-900">
              {student.name}
            </p>

            {/* Show enrollment number under the name if available */}
            {enrollmentNo && (
              <p className="mt-0.5 font-mono text-sm font-semibold text-indigo-600 tracking-widest">
                {enrollmentNo}
              </p>
            )}

            {/* Fall back to admission number */}
            {!enrollmentNo && student.admissionNumber && (
              <p className="mt-0.5 text-sm text-gray-400">
                #{student.admissionNumber}
              </p>
            )}

            <div className="mt-2 flex flex-wrap gap-2">
              {/* Status badge */}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold",
                  statusConfig.bg,
                  statusConfig.border,
                  statusConfig.color
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", statusConfig.dot)} />
                {statusConfig.label}
              </span>

              {/* Class badge */}
              {classNameDisplay && classNameDisplay !== "Unassigned" && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-700">
                  <School className="h-3 w-3" />
                  {classNameDisplay}
                </span>
              )}

              {/* Must-reset badge */}
              {mustResetPassword && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">
                  <KeyRound className="h-3 w-3" />
                  {t("studentDetail.passwordNotChanged")}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">

        {/* ── Personal info ── */}
        <Section title={t("studentDetail.personal")}>
          <InfoRow
            icon={User}
            label={t("common.fullName")}
            value={student.name}
            iconColor="text-amber-500"
          />
          <InfoRow
            icon={Mail}
            label={t("common.email")}
            value={student.email}
            iconColor="text-indigo-500"
          />
          <InfoRow
            icon={Phone}
            label={t("common.phone")}
            value={student.phone}
            iconColor="text-emerald-500"
          />
          <InfoRow
            icon={Calendar}
            label={t("common.dateOfBirth")}
            value={formatDate(student.dateOfBirth) ?? student.dateOfBirth}
            iconColor="text-purple-500"
          />
          <InfoRow
            icon={IdCard}
            label={t("academic.enrollmentNo")}
            value={enrollmentNo}
            iconColor="text-indigo-600"
            mono
          />
          <InfoRow
            icon={Hash}
            label={t("studentDetail.admissionNumber")}
            value={student.admissionNumber}
            iconColor="text-gray-500"
          />
          <InfoRow
            icon={User}
            label={t("common.gender")}
            value={student.gender}
            iconColor="text-pink-500"
          />
          <InfoRow
            icon={MapPin}
            label={t("common.address")}
            value={student.address}
            iconColor="text-gray-400"
          />
        </Section>

        {/* ── School info ── */}
        <Section title={t("studentDetail.school")}>
          <InfoRow
            icon={School}
            label={t("academic.class")}
            value={classNameDisplay}
            iconColor="text-indigo-500"
          />
          <InfoRow
            icon={Users}
            label={t("studentDetail.guardianName")}
            value={student.guardianName}
            iconColor="text-amber-500"
          />
          <InfoRow
            icon={Phone}
            label={t("studentDetail.guardianPhone")}
            value={student.guardianPhone}
            iconColor="text-emerald-500"
          />
          <InfoRow
            icon={Calendar}
            label={t("studentDetail.enrolledOn")}
            value={formatDate(student.enrolledAt)}
            iconColor="text-indigo-400"
          />
          <InfoRow
            icon={Calendar}
            label={t("common.created")}
            value={formatDate(student.createdAt)}
            iconColor="text-gray-400"
          />
          <InfoRow
            icon={Calendar}
            label={t("common.lastUpdated")}
            value={formatDate(student.updatedAt)}
            iconColor="text-gray-400"
          />
        </Section>

        {/* ── ID card photo ── */}
        <div className="lg:col-span-2">
          <PhotoCard
            studentId={student._id}
            schoolId={schoolId}
            photoUrl={(student as { photoUrl?: string | null }).photoUrl ?? null}
            onChanged={() => { void qc.invalidateQueries({ queryKey: QK.student(id ?? "") }); }}
          />
        </div>

        {/* ── Enrollment / Login credentials card ── */}
        <div className="lg:col-span-2">
          <EnrollmentCard
            enrollmentNo={enrollmentNo}
            mustResetPassword={mustResetPassword}
          />
        </div>

        {/* ── Actions ── */}
        <div className="flex flex-col gap-3 lg:col-span-2">
          <h2 className="text-sm font-bold text-gray-700">{t("common.actions")}</h2>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* Move */}
            <ActionButton
              icon={ArrowRightLeft}
              label={t("studentDetail.moveToClass")}
              description={t("studentDetail.moveHint")}
              variant="default"
              disabled={isBusy}
              onClick={() => setShowMovePicker(true)}
            />

            {/* Suspend / Restore */}
            {isSuspended ? (
              <ActionButton
                icon={CheckCircle2}
                label={t("studentDetail.restore")}
                description={t("studentDetail.restoreHint")}
                variant="success"
                disabled={isBusy}
                onClick={handleRestore}
              />
            ) : (
              <ActionButton
                icon={Ban}
                label={t("studentDetail.suspend")}
                description={t("studentDetail.suspendHint")}
                variant="warning"
                disabled={isBusy}
                onClick={handleSuspend}
              />
            )}

            {/* Delete */}
            <ActionButton
              icon={Trash2}
              label={t("studentDetail.delete")}
              description={t("studentDetail.deleteHint")}
              variant="danger"
              disabled={isBusy}
              onClick={handleDelete}
            />
          </div>
        </div>

      </div>

      {/* ── Move class picker modal ── */}
      {showMovePicker ? (
        <MoveClassPicker
          classes={classes}
          currentClassId={classIdForMove}
          onSelect={handleMoveSelect}
          onCancel={() => setShowMovePicker(false)}
        />
      ) : null}
    </div>
  );
}