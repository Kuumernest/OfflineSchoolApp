import { useState, useMemo, useCallback }        from "react";
import { useNavigate, useParams }                from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Plus,
  Trash2,
  BookOpen,
  School,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

import { useUser }              from "@/store/auth.store";
import { fetchTeacherById }     from "@/services/teacher.service";
import {
  fetchAssignmentsByTeacher,
  deleteAssignment,
  type Assignment,
} from "@/services/assignment.service";
import { cn }                   from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface ClassGroup {
  classId:   string;
  className: string;
  items:     Assignment[];
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY KEYS
// ─────────────────────────────────────────────────────────────────────────────

const QK = {
  teacher:     (id: string) => ["teacher",              id] as const,
  assignments: (id: string) => ["teacher-assignments",  id] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

interface DeleteDialogProps {
  assignment: Assignment;
  onConfirm:  () => void;
  onCancel:   () => void;
  busy:       boolean;
}

const DeleteDialog = ({ assignment, onConfirm, onCancel, busy }: DeleteDialogProps) => {
  const { t } = useTranslation();
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
    <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
        <Trash2 size={22} className="text-red-600" />
      </div>
      <h3 className="text-lg font-bold text-gray-900">{t("assignments.remove")}</h3>
      <p className="mt-2 text-sm text-gray-500">
        Remove{" "}
        <span className="font-semibold text-gray-900">
          {assignment.subject?.name ?? "this subject"}
        </span>{" "}
        from{" "}
        <span className="font-semibold text-gray-900">
          {assignment.class?.name ?? "this class"}
        </span>
        ?
      </p>
      <div className="mt-6 flex gap-3">
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </div>
  </div>;
};

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function TeacherAssignmentDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id }   = useParams<{ id: string }>();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const qc       = useQueryClient();

  const [deleteTarget, setDeleteTarget] = useState<Assignment | null>(null);

  // ── Queries ───────────────────────────────────────────

  const teacherQuery = useQuery({
    queryKey:  QK.teacher(id ?? ""),
    queryFn:   () => fetchTeacherById(id!),
    enabled:   !!id,
    staleTime: 60_000,
  });

  const assignmentsQuery = useQuery<Assignment[], Error>({
    queryKey:  QK.assignments(id ?? ""),
    queryFn:   () => fetchAssignmentsByTeacher(id!),
    enabled:   !!id,
    staleTime: 30_000,
  });

  const teacher     = teacherQuery.data;
  const assignments = assignmentsQuery.data ?? [];

  // ── Delete mutation ───────────────────────────────────

  const deleteMutation = useMutation({
    mutationFn: (assignmentId: string) => deleteAssignment(assignmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.assignments(id ?? "") });
      qc.invalidateQueries({ queryKey: ["assignments", schoolId] });
      setDeleteTarget(null);
    },
  });

  // ── Derived ───────────────────────────────────────────

  const groupedByClass = useMemo((): ClassGroup[] => {
    const map: Record<string, ClassGroup> = {};
    assignments.forEach((a) => {
      const cid = a.classId ?? `unknown-${a._id}`;
      if (!map[cid]) {
        map[cid] = {
          classId:   cid,
          className: a.class?.name ?? "Unknown Class",
          items:     [],
        };
      }
      map[cid].items.push(a);
    });
    return Object.values(map).sort((a, b) =>
      a.className.localeCompare(b.className)
    );
  }, [assignments]);

  const classCount = useMemo(
    () => groupedByClass.filter((g) => !g.classId.startsWith("unknown-")).length,
    [groupedByClass]
  );

  const handleAssignMore = useCallback(() => {
    navigate("/teachers/assignments/assign", {
      state: { teacherId: id, teacherName: teacher?.name },
    });
  }, [navigate, id, teacher]);

  // ── Loading ───────────────────────────────────────────

  if (assignmentsQuery.isLoading || teacherQuery.isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        <p className="text-sm font-medium text-gray-400">Loading assignments…</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">

      {/* HEADER */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate("/teachers/assignments")}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="truncate text-2xl font-bold text-gray-900">
            {teacher?.name ?? "Teacher"}
          </h1>
          <p className="text-sm text-gray-500">
            {assignments.length} assignment{assignments.length !== 1 ? "s" : ""}{" "}
            · {classCount} class{classCount !== 1 ? "es" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => qc.invalidateQueries({ queryKey: QK.assignments(id ?? "") })}
            disabled={assignmentsQuery.isFetching}
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={15} className={assignmentsQuery.isFetching ? "animate-spin" : ""} />
          </button>
          <button
            onClick={handleAssignMore}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
          >
            <Plus size={16} />
            {t("assignments.assignMore")}
          </button>
        </div>
      </div>

      {assignmentsQuery.isError && (
        <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3">
          <AlertCircle size={16} className="shrink-0 text-red-500" />
          <p className="text-sm font-medium text-red-700">
            {assignmentsQuery.error.message}
          </p>
        </div>
      )}

      {/* TEACHER PROFILE CARD */}
      {teacher && (
        <div className="flex items-center gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-100 text-xl font-bold text-indigo-700">
            {teacher.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-bold text-gray-900">
              {teacher.name}
            </p>
            <p className="truncate text-sm text-gray-400">{teacher.email}</p>
          </div>
          <div className="flex shrink-0 items-center gap-6">
            <div className="text-center">
              <p className="text-xl font-bold text-indigo-600">
                {assignments.length}
              </p>
              <p className="text-xs text-gray-400">{t("academic.subject_other")}</p>
            </div>
            <div className="h-8 w-px bg-gray-200" />
            <div className="text-center">
              <p className="text-xl font-bold text-purple-600">
                {classCount}
              </p>
              <p className="text-xs text-gray-400">{t("academic.class_other")}</p>
            </div>
          </div>
        </div>
      )}

      {/* EMPTY STATE */}
      {assignments.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100">
            <BookOpen size={28} className="text-gray-300" />
          </div>
          <p className="text-base font-bold text-gray-900">{t("assignments.none")}</p>
          <p className="mt-1 text-sm text-gray-400">
            {t("assignments.noneForTeacher")}
          </p>
          <button
            onClick={handleAssignMore}
            className="mt-4 flex items-center gap-2 rounded-xl bg-indigo-50 px-5 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
          >
            <Plus size={16} />
            {t("assignments.assignSubjects")}
          </button>
        </div>
      )}

      {/* ASSIGNMENTS BY CLASS */}
      {assignments.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700">
              {t("assignments.byClass")}
            </h2>
            <button
              onClick={handleAssignMore}
              className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800"
            >
              <Plus size={12} />
              {t("common.addMore")}
            </button>
          </div>

          {groupedByClass.map((group) => (
            <div
              key={group.classId}
              className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
            >
              <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-100">
                  <School size={16} className="text-purple-700" />
                </div>
                <span className="flex-1 truncate text-sm font-bold text-gray-900">
                  {group.className}
                </span>
                <span className="rounded-lg bg-purple-100 px-2 py-0.5 text-xs font-bold text-purple-700">
                  {group.items.length}
                </span>
              </div>

              <div className="divide-y divide-gray-50">
                {group.items.map((a) => (
                  <div
                    key={a._id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <div className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {a.subject?.name ?? "—"}
                      </p>
                      {a.subject?.code && (
                        <p className="text-xs text-gray-400">{a.subject.code}</p>
                      )}
                    </div>
                    <button
                      onClick={() => setDeleteTarget(a)}
                      disabled={
                        deleteMutation.isPending && deleteTarget?._id === a._id
                      }
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        "bg-red-50 text-red-400 transition-colors hover:bg-red-100 hover:text-red-600",
                        "disabled:opacity-40"
                      )}
                      title={t("assignments.remove")}
                    >
                      {deleteMutation.isPending && deleteTarget?._id === a._id ? (
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-400 border-t-transparent" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteDialog
          assignment={deleteTarget}
          onConfirm={() => deleteMutation.mutate(deleteTarget._id)}
          onCancel={() => setDeleteTarget(null)}
          busy={deleteMutation.isPending}
        />
      )}
    </div>
  );
}