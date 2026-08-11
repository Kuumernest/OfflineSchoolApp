import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate }   from "react-router-dom";
import {
  Plus,
  BookOpen,
  School,
  Pencil,
  Trash2,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  UserCheck,
  UserX,
} from "lucide-react";

import { subjectService }  from "@/services/subject.service";
import { fetchClasses }    from "@/services/class.service";
import { useUser }         from "@/store/auth.store";
import { cn }              from "@/utils/cn";
import type { RawSubject } from "@/services/subject.service";
import type { Class }      from "@/types/classes.types";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface Subject {
  id:          string;
  name:        string;
  code:        string | null;
  classId:     string | null;
  className:   string;
  teacherId:   string | null;
  teacherName: string | null;
}

interface Group {
  classId:   string;
  className: string;
  items:     Subject[];
}

interface StatItem {
  label: string;
  value: number;
  color: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const nid = (v: unknown): string | null =>
  v == null ? null : String(v).trim() || null;

const normaliseSubject = (
  raw:      RawSubject,
  classMap: Map<string | null, Class>,
): Subject => {
  const id = nid(raw._id ?? raw.id) ?? "";

  const rawClassId = nid(
    (raw.class as { _id?: string } | null)?._id ??
    raw.classId ??
    raw.class_id ??
    (typeof raw.class === "string" ? raw.class : null)
  );

  const classObj  = rawClassId ? classMap.get(rawClassId) : null;
  const className =
    classObj?.name                                        ??
    raw.className                                         ??
    raw.class_name                                        ??
    (raw.class as { name?: string } | null)?.name         ??
    "Unknown Class";

  const teacherId = nid(
    (raw.teacher as { _id?: string; id?: string } | null)?._id ??
    (raw.teacher as { _id?: string; id?: string } | null)?.id  ??
    raw.teacherId ??
    raw.teacher_id
  );

  const teacherName =
    (raw.teacher as { name?: string; fullName?: string } | null)?.name     ??
    (raw.teacher as { name?: string; fullName?: string } | null)?.fullName ??
    raw.teacherName  ??
    raw.teacher_name ??
    null;

  return {
    id,
    name:        String(raw.name ?? "").trim(),
    code:        raw.code ? String(raw.code).trim() : null,
    classId:     rawClassId,
    className,
    teacherId,
    teacherName: teacherName ?? null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

interface FilterChipProps {
  label:    string;
  isActive: boolean;
  onClick:  () => void;
}

const FilterChip = ({ label, isActive, onClick }: FilterChipProps) => (
  <button
    onClick={onClick}
    className={cn(
      "shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold",
      "transition-colors duration-150 focus-visible:outline-none",
      "focus-visible:ring-2 focus-visible:ring-emerald-500",
      isActive
        ? "border-emerald-600 bg-emerald-600 text-white"
        : "border-gray-200 bg-gray-100 text-gray-500 hover:border-gray-300 hover:bg-gray-200"
    )}
  >
    {label}
  </button>
);

interface StatsBannerProps {
  total:      number;
  assigned:   number;
  unassigned: number;
}

const StatsBanner = ({ total, assigned, unassigned }: StatsBannerProps) => {
  const items: StatItem[] = [
    { label: "Total",      value: total,      color: "text-gray-900"    },
    { label: "Assigned",   value: assigned,   color: "text-emerald-600" },
    {
      label: "Unassigned",
      value: unassigned,
      color: unassigned > 0 ? "text-amber-600" : "text-gray-900",
    },
  ];

  return (
    <div className="flex items-center justify-center gap-8 border-b border-gray-100 bg-white px-6 py-3">
      {items.map(({ label, value, color }, i) => (
        <div key={label} className="flex items-center gap-8">
          <div className="flex flex-col items-center">
            <span className={cn("text-xl font-bold", color)}>{value}</span>
            <span className="mt-0.5 text-xs font-medium text-gray-400">
              {label}
            </span>
          </div>
          {i < items.length - 1 && <div className="h-7 w-px bg-gray-200" />}
        </div>
      ))}
    </div>
  );
};

interface SubjectCardProps {
  subject:         Subject;
  onEdit:          (s: Subject) => void;
  onDelete:        (s: Subject) => void;
  hideClassBadge?: boolean;
}

const SubjectCard = ({
  subject,
  onEdit,
  onDelete,
  hideClassBadge = false,
}: SubjectCardProps) => (
  <div className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-4">
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50">
      <BookOpen size={20} className="text-emerald-600" />
    </div>

    <div className="min-w-0 flex-1">
      <p className="truncate text-[15px] font-bold text-gray-900">
        {subject.name}
        {subject.code && (
          <span className="ml-2 text-xs font-medium text-gray-400">
            ({subject.code})
          </span>
        )}
      </p>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {!hideClassBadge && (
          <span className="inline-flex items-center gap-1 rounded-lg bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">
            <School size={11} />
            {subject.className}
          </span>
        )}

        {subject.teacherName ? (
          <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800">
            <UserCheck size={11} />
            {subject.teacherName}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
            <UserX size={11} />
            No teacher assigned
          </span>
        )}
      </div>
    </div>

    <div className="flex shrink-0 items-center gap-1">
      <button
        onClick={() => onEdit(subject)}
        className="rounded-lg p-2 text-indigo-500 transition-colors hover:bg-indigo-50"
        title="Edit subject"
      >
        <Pencil size={17} />
      </button>
      <button
        onClick={() => onDelete(subject)}
        className="rounded-lg p-2 text-red-500 transition-colors hover:bg-red-50"
        title="Delete subject"
      >
        <Trash2 size={17} />
      </button>
    </div>
  </div>
);

interface ClassSectionProps {
  className:    string;
  count:        number;
  children:     React.ReactNode;
  defaultOpen?: boolean;
}

const ClassSection = ({
  className,
  count,
  children,
  defaultOpen = true,
}: ClassSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl bg-indigo-50 px-4 py-2.5",
          "text-left transition-colors hover:bg-indigo-100"
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white">
          <GraduationCap size={14} className="text-indigo-500" />
        </div>
        <span className="flex-1 truncate text-sm font-bold text-indigo-900">
          {className}
        </span>
        <span className="rounded-lg bg-white px-2 py-0.5 text-xs font-bold text-indigo-600">
          {count}
        </span>
        {open
          ? <ChevronDown  size={15} className="text-indigo-400" />
          : <ChevronRight size={15} className="text-indigo-400" />
        }
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2.5">{children}</div>
      )}
    </div>
  );
};

interface EmptyStateAction {
  label:   string;
  color:   string;
  onClick: () => void;
}

interface EmptyStateProps {
  icon:     React.ElementType;
  title:    string;
  subtitle: string;
  action?:  EmptyStateAction;
}

const EmptyState = ({ icon: Icon, title, subtitle, action }: EmptyStateProps) => (
  <div className="flex flex-col items-center justify-center py-20 text-center">
    <div className="mb-3 flex h-20 w-20 items-center justify-center rounded-2xl bg-gray-100">
      <Icon size={36} className="text-gray-400" />
    </div>
    <p className="mt-2 text-[17px] font-bold text-gray-900">{title}</p>
    <p className="mt-1.5 max-w-xs text-sm leading-5 text-gray-500">{subtitle}</p>
    {action && (
      <button
        onClick={action.onClick}
        className={cn(
          "mt-6 inline-flex items-center gap-2 rounded-xl border-2 px-5 py-3",
          "text-sm font-semibold transition-colors hover:opacity-80"
        )}
        style={{ borderColor: action.color, color: action.color }}
      >
        <Plus size={17} />
        {action.label}
      </button>
    )}
  </div>
);

interface DeleteDialogProps {
  subject:   Subject;
  onConfirm: () => void;
  onCancel:  () => void;
  busy:      boolean;
}

const DeleteDialog = ({
  subject,
  onConfirm,
  onCancel,
  busy,
}: DeleteDialogProps) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
    <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
        <Trash2 size={22} className="text-red-600" />
      </div>
      <h3 className="text-lg font-bold text-gray-900">Delete Subject</h3>
      <p className="mt-2 text-sm text-gray-500">
        Permanently delete{" "}
        <span className="font-semibold text-gray-900">"{subject.name}"</span>{" "}
        from {subject.className}?
      </p>
      <p className="mt-1 text-xs text-amber-700">
        This may affect teacher assignments and timetable entries.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  </div>
);

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═════════════════════════════════════════════════════════════════════════════

export default function AdminSubjectsPage() {
  const navigate = useNavigate();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [subjects,        setSubjects]        = useState<Subject[]>([]);
  const [classes,         setClasses]         = useState<Class[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [loading,         setLoading]         = useState(true);
  const [refreshing,      setRefreshing]      = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [deleteTarget,    setDeleteTarget]    = useState<Subject | null>(null);
  const [deleteBusy,      setDeleteBusy]      = useState(false);

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      isRefresh ? setRefreshing(true) : setLoading(true);
      setError(null);

      const [rawSubjects, classRows] = await Promise.all([
        subjectService.getAll({
          schoolId,
          classId: selectedClassId ?? undefined,
        }),
        fetchClasses(schoolId),
      ]);

      const safeClasses  = Array.isArray(classRows)  ? classRows  : [];
      const safeSubjects = Array.isArray(rawSubjects) ? rawSubjects : [];

      const classMap = new Map<string | null, Class>(
        safeClasses.map((c) => [nid(c._id ?? c.id), c])
      );

      setClasses(safeClasses);
      setSubjects(safeSubjects.map((s) => normaliseSubject(s, classMap)));
    } catch (err: unknown) {
      console.error("[AdminSubjects] loadData failed:", err);
      setError("Failed to load subjects. Click retry to try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [schoolId, selectedClassId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await subjectService.delete(deleteTarget.id);
      setSubjects((prev) => prev.filter((s) => s.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ??
        (err instanceof Error ? err.message : null) ??
        "Failed to delete subject";
      setError(msg);
      setDeleteTarget(null);
      loadData(true);
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, loadData]);

  const stats = useMemo(() => {
    const assigned = subjects.filter((s) => !!s.teacherName).length;
    return {
      total:      subjects.length,
      assigned,
      unassigned: subjects.length - assigned,
    };
  }, [subjects]);

  const subjectCountByClass = useMemo(() => {
    const map: Record<string, number> = {};
    subjects.forEach((s) => {
      const key = nid(s.classId) ?? "unknown";
      map[key]  = (map[key] || 0) + 1;
    });
    return map;
  }, [subjects]);

  const groupedSubjects = useMemo((): Group[] => {
    if (selectedClassId !== null) return [];
    const groups: Record<string, Group> = {};
    subjects.forEach((s) => {
      const cid = nid(s.classId) ?? "unknown";
      if (!groups[cid]) {
        groups[cid] = { classId: cid, className: s.className, items: [] };
      }
      groups[cid].items.push(s);
    });
    return Object.values(groups).sort((a, b) =>
      a.className.localeCompare(b.className)
    );
  }, [subjects, selectedClassId]);

  const hasClasses = classes.length > 0;
  const isAllTab   = selectedClassId === null;

  const renderContent = () => {
    if (!hasClasses) {
      return (
        <EmptyState
          icon={School}
          title="No classes yet"
          subtitle="A subject must be linked to a class. Create a class first."
          action={{
            label:   "Add Class",
            color:   "#4F46E5",
            onClick: () => navigate("/classes"),
          }}
        />
      );
    }

    if (subjects.length === 0) {
      return (
        <EmptyState
          icon={BookOpen}
          title="No subjects found"
          subtitle={
            selectedClassId
              ? "No subjects in this class yet. Add one to get started."
              : "Add your first subject and link it to a class."
          }
          action={{
            label:   "Add Subject",
            color:   "#059669",
            onClick: () => navigate("/subjects/add"),
          }}
        />
      );
    }

    if (isAllTab) {
      return groupedSubjects.map((group) => (
        <ClassSection
          key={group.classId}
          className={group.className}
          count={group.items.length}
        >
          {group.items.map((subject) => (
            <SubjectCard
              key={subject.id}
              subject={subject}
              onEdit={(s) => navigate(`/subjects/edit/${s.id}`)}
              onDelete={setDeleteTarget}
              hideClassBadge
            />
          ))}
        </ClassSection>
      ));
    }

    return (
      <div className="flex flex-col gap-2.5">
        {subjects.map((subject) => (
          <SubjectCard
            key={subject.id}
            subject={subject}
            onEdit={(s) => navigate(`/subjects/edit/${s.id}`)}
            onDelete={setDeleteTarget}
          />
        ))}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-gray-50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
        <p className="text-sm font-medium text-gray-500">Loading subjects…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">

      <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-gray-200 bg-white px-6 py-4">
        <button
          onClick={() => navigate(-1)}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200"
        >
          ←
        </button>

        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">Subjects</h1>
          <p className="text-sm text-gray-500">
            {stats.total} {stats.total === 1 ? "subject" : "subjects"}
            {stats.unassigned > 0 ? ` • ${stats.unassigned} unassigned` : ""}
          </p>
        </div>

        <button
          onClick={() => loadData(true)}
          disabled={refreshing}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
        </button>

        <button
          onClick={() => navigate("/subjects/add")}
          className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          <Plus size={18} />
          Add Subject
        </button>
      </header>

      {hasClasses && (
        <div className="border-b border-gray-100 bg-white">
          <div className="flex gap-2 overflow-x-auto px-6 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <FilterChip
              label={`All Subjects (${stats.total})`}
              isActive={selectedClassId === null}
              onClick={() => setSelectedClassId(null)}
            />
            {classes.map((cls) => {
              const cid   = nid(cls._id ?? cls.id);
              const count = cid ? (subjectCountByClass[cid] ?? 0) : 0;
              return (
                <FilterChip
                  key={cid ?? cls.name}
                  label={`${cls.name} (${count})`}
                  isActive={nid(selectedClassId) === cid}
                  onClick={() => setSelectedClassId(cid)}
                />
              );
            })}
          </div>
        </div>
      )}

      {subjects.length > 0 && (
        <StatsBanner
          total={stats.total}
          assigned={stats.assigned}
          unassigned={stats.unassigned}
        />
      )}

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-5">
        {error && (
          <div className="mb-4 flex items-center gap-3 rounded-xl bg-red-50 p-3">
            <AlertCircle size={18} className="shrink-0 text-red-600" />
            <p className="flex-1 text-sm font-medium text-red-800">{error}</p>
            <button
              onClick={() => loadData()}
              className="shrink-0 text-sm font-bold text-red-600 hover:underline"
            >
              Retry
            </button>
          </div>
        )}
        {renderContent()}
      </main>

      {deleteTarget && (
        <DeleteDialog
          subject={deleteTarget}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          busy={deleteBusy}
        />
      )}
    </div>
  );
}