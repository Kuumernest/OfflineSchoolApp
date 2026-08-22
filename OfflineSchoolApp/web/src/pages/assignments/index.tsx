// web/src/pages/assignments/index.tsx
//
// Teacher-assignment overview: who teaches what, rolled up per teacher.
//
// The file was empty, so /teachers/assignments — a link in both the sidebar and
// the dashboard's quick actions — resolved to nothing.

import { useDeferredValue, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardList,
  Plus,
  Users,
  BookMarked,
  School,
  ChevronRight,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SearchInput } from "@/components/ui/SearchInput";
import { PageSpinner } from "@/components/ui/Spinner";
import { Table, THead, Th, TBody } from "@/components/ui/DataTable";
import { useUser } from "@/store/auth.store";
import {
  fetchAssignments,
  summariseByTeacher,
} from "@/services/assignment.service";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

const QK = {
  assignments: (schoolId: string) => ["assignments", schoolId] as const,
};

export default function AssignmentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [search, setSearch] = useState("");
  // The list is filtered on every keystroke over a table that can run to
  // hundreds of rows. Deferring keeps the input itself responsive while the
  // filtered result catches up a frame later.
  const deferredSearch = useDeferredValue(search);

  const { data, isLoading, error } = useQuery({
    queryKey: QK.assignments(schoolId),
    queryFn:  () => fetchAssignments({ schoolId }),
    enabled:  !!schoolId,
  });

  // Memoised so the two useMemos below keep a stable dependency.
  const assignments = useMemo(() => data ?? [], [data]);

  const summaries = useMemo(
    () => summariseByTeacher(assignments),
    [assignments],
  );

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter((s) => s.teacherName.toLowerCase().includes(q));
  }, [summaries, deferredSearch]);

  const totals = useMemo(() => ({
    teachers: summaries.length,
    classes:  new Set(assignments.map((a) => a.classId).filter(Boolean)).size,
    subjects: new Set(assignments.map((a) => a.subjectId).filter(Boolean)).size,
    // Rows with a missing class or subject: the reference resolved to nothing,
    // usually because the class was deleted without cascading. Worth surfacing
    // rather than rendering as a silent "—".
    orphaned: assignments.filter((a) => !a.class?.name || !a.subject?.name).length,
  }), [assignments, summaries]);

  if (isLoading) return <PageSpinner />;

  if (error) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">
              {t("assignments.loadFailed")}
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">{getErrorMessage(error)}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">
            {t("assignments.title")}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("assignments.blurb")}
          </p>
        </div>

        <Button
          icon={<Plus className="w-4 h-4" />}
          onClick={() => navigate("/teachers/assignments/assign")}
        >
          {t("assignments.assignTeacher")}
        </Button>
      </div>

      {/* ── Totals ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={Users}      label={t("assignments.teachersAssigned")} value={totals.teachers} />
        <Stat icon={School}     label={t("assignments.classesCovered")}   value={totals.classes} />
        <Stat icon={BookMarked} label={t("teachers.subjectsCovered")}  value={totals.subjects} />
        <Stat
          icon={AlertCircle}
          label={t("assignments.brokenLinks")}
          value={totals.orphaned}
          tone={totals.orphaned > 0 ? "warn" : "default"}
        />
      </div>

      {totals.orphaned > 0 && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">
            <strong>{totals.orphaned}</strong>{" "}
            {totals.orphaned === 1 ? "assignment" : "assignments"} point at a
            class or subject that no longer exists. Open the teacher to remove
            them.
          </p>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="p-4 border-b border-gray-100">
          <CardHeader
            title={t("assignments.byTeacher")}
            subtitle={`${filtered.length} of ${summaries.length} shown`}
            action={
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("assignments.searchTeachers")}
                className="w-56"
              />
            }
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <ClipboardList className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-gray-700">
              {summaries.length === 0
                ? "No assignments yet"
                : "No teacher matches that search"}
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {summaries.length === 0
                ? "Assign a teacher to a class and subject to get started."
                : "Try a different name."}
            </p>
            {summaries.length === 0 && (
              <Button
                className="mt-4"
                size="sm"
                icon={<Plus className="w-4 h-4" />}
                onClick={() => navigate("/teachers/assignments/assign")}
              >
                {t("assignments.assignTeacher")}
              </Button>
            )}
          </div>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>{t("academic.teacher")}</Th>
                <Th className="text-right">{t("academic.class_other")}</Th>
                <Th className="text-right">{t("academic.subject_other")}</Th>
                <Th className="text-right">{t("assignments.totalLessons")}</Th>
                <Th />
              </tr>
            </THead>
            <TBody>
              {filtered.map((s) => (
                <tr
                  key={s.teacherId}
                  onClick={() => navigate(`/teachers/assignments/${s.teacherId}`)}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-800">{s.teacherName}</p>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{s.classes}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{s.subjects}</td>
                  <td className="px-4 py-3 text-right">
                    <Badge
                      label={String(s.total)}
                      variant={s.total > 20 ? "warning" : "info"}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="w-4 h-4 text-gray-400 inline" />
                  </td>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Stat({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon:  React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: "default" | "warn";
}) {
  return (
    <Card className="flex items-center gap-3" padding>
      <div
        className={cn(
          "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
          tone === "warn" ? "bg-amber-50" : "bg-primary-50",
        )}
      >
        <Icon
          className={cn(
            "w-4 h-4",
            tone === "warn" ? "text-amber-600" : "text-primary-600",
          )}
        />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold text-gray-900 leading-tight">{value}</p>
        <p className="text-xs text-gray-500 truncate">{label}</p>
      </div>
    </Card>
  );
}
