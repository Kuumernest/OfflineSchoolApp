// web/src/pages/attendance/index.tsx
//
// Marking the register, for students (per class) or teachers (whole school).
//
// The register is edited as a local draft and saved in one request. That is a
// deliberate choice, not laziness: marking thirty students one PATCH at a time
// means thirty chances to half-fail, and a teacher with a flaky connection ends
// up with a register that is partly saved and impossible to reason about.
//
// The bulk endpoint answers 201 even when individual rows are rejected, so the
// result body is inspected rather than trusting the status code — a register
// that half-saved says so.

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCheck,
  Check,
  X,
  Clock3,
  FileMinus,
  Users,
  ChevronLeft,
  ChevronRight,
  Save,
  BarChart3,
  AlertCircle,
  CalendarDays,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { SearchInput } from "@/components/ui/SearchInput";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

import {
  fetchRegister,
  fetchPeriods,
  saveRegister,
  todayKey,
  shiftDateKey,
  isFutureDate,
} from "@/services/attendance.service";
import { fetchClasses } from "@/services/class.service";
import {
  STUDENT_STATUSES,
  TEACHER_STATUSES,
  STATUS_LABELS,
} from "@/types/attendance.types";
import type {
  AttendanceStatus,
  AttendanceSubject,
  BulkAttendanceRow,
  Period,
  RosterEntry,
} from "@/types/attendance.types";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/axios";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────

const QK = {
  register: (subject: string, schoolId: string, classId: string, periodId: string, date: string) =>
    ["attendance", subject, schoolId, classId, periodId, date] as const,
  classes: (schoolId: string) => ["classes", schoolId] as const,
  periods: (schoolId: string) => ["periods", schoolId] as const,
};

const STATUS_STYLE: Record<AttendanceStatus, { on: string; off: string; icon: typeof Check }> = {
  present:  { on: "bg-emerald-600 text-white border-emerald-600", off: "text-emerald-700 border-emerald-200 hover:bg-emerald-50", icon: Check },
  absent:   { on: "bg-red-600 text-white border-red-600",         off: "text-red-700 border-red-200 hover:bg-red-50",             icon: X },
  late:     { on: "bg-amber-500 text-white border-amber-500",     off: "text-amber-700 border-amber-200 hover:bg-amber-50",       icon: Clock3 },
  excused:  { on: "bg-blue-600 text-white border-blue-600",       off: "text-blue-700 border-blue-200 hover:bg-blue-50",          icon: FileMinus },
  on_leave: { on: "bg-blue-600 text-white border-blue-600",       off: "text-blue-700 border-blue-200 hover:bg-blue-50",          icon: FileMinus },
};

// ─────────────────────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const isTeacherUser = user?.role === "teacher";

  const [subject, setSubject] = useState<AttendanceSubject>("students");
  const [classId, setClassId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [date,    setDate]    = useState(todayKey());
  const [search,  setSearch]  = useState("");

  // The unsaved draft, tagged with the register it belongs to.
  //
  // Switching class/date/subject has to clear it — a mark for student X on
  // Tuesday means nothing on Wednesday's register. Doing that in an effect
  // (`useEffect(() => setDraft({}), [...])`) works but renders once with the
  // stale draft still showing before the reset lands. Tagging the draft and
  // deriving it during render has no such window and no extra render.
  const registerKey = `${subject}|${classId}|${periodId}|${date}`;

  const [draftState, setDraftState] = useState<{
    key:   string;
    marks: Record<string, AttendanceStatus>;
  }>({ key: registerKey, marks: {} });

  const draft = useMemo(
    () => (draftState.key === registerKey ? draftState.marks : {}),
    [draftState, registerKey],
  );

  const setDraft = useCallback(
    (update: (prev: Record<string, AttendanceStatus>) => Record<string, AttendanceStatus>) =>
      setDraftState((prev) => ({
        key:   registerKey,
        marks: update(prev.key === registerKey ? prev.marks : {}),
      })),
    [registerKey],
  );

  const statuses = subject === "students" ? STUDENT_STATUSES : TEACHER_STATUSES;

  const classesQ = useQuery({
    queryKey: QK.classes(schoolId),
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId && subject === "students",
  });

  const periodsQ = useQuery({
    queryKey: QK.periods(schoolId),
    queryFn:  () => fetchPeriods(schoolId),
    enabled:  !!schoolId,
  });

  // Teacher registers are school-wide; student registers need a class.
  const ready = !!schoolId && (subject === "teachers" || !!classId);

  const registerQ = useQuery({
    queryKey: QK.register(subject, schoolId, classId, periodId, date),
    queryFn:  () => fetchRegister({
      subject,
      schoolId,
      classId:  classId || null,
      periodId: periodId || null,
      date,
    }),
    enabled: ready,
  });

  // Memoised: the filter/tally useMemos below key off this array's identity.
  const roster = useMemo(() => registerQ.data?.roster ?? [], [registerQ.data]);

  const statusOf = useCallback(
    (entry: RosterEntry): AttendanceStatus | null =>
      draft[entry.id] ?? entry.attendance?.status ?? null,
    [draft],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.admissionNo?.toLowerCase().includes(q),
    );
  }, [roster, search]);

  const counts = useMemo(() => {
    const acc: Record<string, number> = { unmarked: 0 };
    for (const s of statuses) acc[s] = 0;
    for (const entry of roster) {
      const s = statusOf(entry);
      if (s && s in acc) acc[s] += 1;
      else if (!s) acc.unmarked += 1;
    }
    return acc;
  }, [roster, statuses, statusOf]);

  const dirtyCount = Object.keys(draft).length;

  // ── Save ───────────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: () => {
      const records: BulkAttendanceRow[] = Object.entries(draft).map(
        ([personId, status]) =>
          subject === "students"
            ? { studentId: personId, status }
            : { teacherId: personId, status },
      );

      return saveRegister(subject, {
        schoolId,
        date,
        ...(subject === "students" ? { classId } : {}),
        ...(periodId ? { periodId } : {}),
        records,
      });
    },
    onSuccess: (result) => {
      // The endpoint reports per-row outcomes; a 201 alone does not mean the
      // whole register landed.
      if (result.failed > 0) {
        toast({
          title:   "Partly saved",
          message:
            `${result.saved} saved, ${result.failed} rejected` +
            (result.failedRecords[0]?.reason
              ? ` — first reason: ${result.failedRecords[0].reason}`
              : ""),
          kind:     "warning",
          duration: 0,
        });
      } else {
        toast({
          title:   t("attendance.registerSaved"),
          message: `${result.saved} ${result.saved === 1 ? "entry" : "entries"} recorded.`,
          kind:    "success",
        });
      }
      setDraft(() => ({}));
      qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err) =>
      toast({ title: t("attendance.errSaveRegister"), message: getErrorMessage(err), kind: "error" }),
  });

  // ── Bulk helpers ───────────────────────────────────────────────────────────
  const markAll = (status: AttendanceStatus) => {
    setDraft((d) => {
      const next = { ...d };
      // Only the visible rows, so a search narrows what "all" means — marking
      // rows the user cannot see would be a nasty surprise.
      for (const entry of filtered) next[entry.id] = status;
      return next;
    });
  };

  const markRemaining = (status: AttendanceStatus) => {
    setDraft((d) => {
      const next = { ...d };
      for (const entry of filtered) {
        if (!statusOf(entry)) next[entry.id] = status;
      }
      return next;
    });
  };

  const discard = async () => {
    const ok = await confirm({
      title:        t("attendance.discardConfirm"),
      message:      `${dirtyCount} ${dirtyCount === 1 ? "mark" : "marks"} will be lost.`,
      confirmLabel: t("common.discard"),
      kind:         "warning",
    });
    if (ok) setDraft(() => ({}));
  };

  const classes = classesQ.data ?? [];
  const classOptions = [
    { value: "", label: "Choose a class…" },
    ...classes.map((c) => ({
      value: c.id ?? c._id ?? "",
      label: [c.name, c.section].filter(Boolean).join(" "),
    })),
  ];

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{t("attendance.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Mark the register, then save. Nothing is sent until you do.
          </p>
        </div>

        <Link to="/attendance/reports">
          <Button variant="secondary" size="sm" icon={<BarChart3 className="w-4 h-4" />}>
            {t("nav.reports")}
          </Button>
        </Link>
      </div>

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">

          {/* Students / teachers. Hidden for teachers — marking staff
              attendance is an admin job, and the endpoint rejects it anyway. */}
          {!isTeacherUser && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1.5">{t("attendance.register")}</span>
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                {(["students", "teachers"] as AttendanceSubject[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSubject(s)}
                    className={cn(
                      "px-3 py-2 text-sm capitalize transition-colors",
                      subject === s
                        ? "bg-primary-600 text-white"
                        : "bg-white text-gray-600 hover:bg-gray-50",
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </label>
          )}

          {subject === "students" && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1.5">{t("academic.class")}</span>
              <Select
                options={classOptions}
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                className="min-w-44"
              />
            </label>
          )}

          {/* Period selector — lets the teacher pick which class period
              they are marking. The register is keyed on this, so switching
              periods clears the unsaved draft. */}
          {subject === "students" && (
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1.5">{t("attendance.period", "Period")}</span>
              <Select
                options={[
                  { value: "", label: t("attendance.allDay", "All day") },
                  ...(periodsQ.data ?? []).map((p: Period) => ({
                    value: p._id,
                    label: `${p.name} (${p.startTime}–${p.endTime})`,
                  })),
                ]}
                value={periodId}
                onChange={(e) => setPeriodId(e.target.value)}
                className="min-w-44"
              />
            </label>
          )}

          {/* Date stepper. The register for a future date cannot be marked, so
              the forward arrow stops at today. */}
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1.5">{t("common.date")}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={t("attendance.prevDay")}
                onClick={() => setDate((d) => shiftDateKey(d, -1))}
                className="p-2 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="date"
                value={date}
                max={todayKey()}
                onChange={(e) => setDate(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <button
                type="button"
                aria-label={t("attendance.nextDay")}
                disabled={isFutureDate(shiftDateKey(date, 1))}
                onClick={() => setDate((d) => shiftDateKey(d, 1))}
                className="p-2 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:hover:bg-transparent"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </label>

          {date !== todayKey() && (
            <div className="flex items-center gap-1.5 pb-2 text-xs text-amber-700">
              <CalendarDays className="w-3.5 h-3.5" />
              {t("attendance.backdated")}
            </div>
          )}
        </div>
      </Card>

      {/* ── Register ────────────────────────────────────────────────────── */}
      {!ready ? (
        <Card className="text-center py-16">
          <Users className="w-8 h-8 text-gray-300 mx-auto" />
          <p className="mt-3 text-sm font-medium text-gray-700">{t("attendance.pickClass")}</p>
          <p className="mt-1 text-sm text-gray-500">
            {t("attendance.blurb")}
          </p>
        </Card>
      ) : registerQ.isLoading ? (
        <PageSpinner />
      ) : registerQ.error ? (
        <Card>
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-semibold text-gray-800">{t("attendance.loadFailed")}</h3>
              <p className="text-sm text-gray-500 mt-0.5">{getErrorMessage(registerQ.error)}</p>
            </div>
          </div>
        </Card>
      ) : roster.length === 0 ? (
        <Card className="text-center py-16">
          <ClipboardCheck className="w-8 h-8 text-gray-300 mx-auto" />
          <p className="mt-3 text-sm font-medium text-gray-700">
            {t("attendance.nobody")}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {subject === "students"
              ? "This class has no active students yet."
              : "No active teachers found for this school."}
          </p>
        </Card>
      ) : (
        <>
          {/* Tally */}
          <div className="flex flex-wrap gap-2">
            {statuses.map((s) => (
              <div
                key={s}
                className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 flex items-center gap-2"
              >
                <span className="text-xs text-gray-500">{STATUS_LABELS[s]}</span>
                <span className="text-sm font-semibold text-gray-900 tabular-nums">
                  {counts[s] ?? 0}
                </span>
              </div>
            ))}
            <div className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 flex items-center gap-2">
              <span className="text-xs text-gray-500">{t("attendance.unmarked")}</span>
              <span className="text-sm font-semibold text-gray-500 tabular-nums">
                {counts.unmarked}
              </span>
            </div>
          </div>

          <Card padding={false}>
            <div className="p-4 border-b border-gray-100 space-y-3">
              <CardHeader
                title={`${roster.length} on the register`}
                subtitle={
                  dirtyCount > 0
                    ? `${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"}`
                    : "No unsaved changes"
                }
                action={
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder={t("attendance.findSomeone")}
                    className="w-52"
                  />
                }
              />

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-400">{t("attendance.quickMark")}</span>
                <Button size="sm" variant="secondary" onClick={() => markAll("present")}>
                  {t("attendance.allPresent")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => markRemaining("present")}>
                  {t("attendance.restPresent")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => markRemaining("absent")}>
                  {t("attendance.restAbsent")}
                </Button>
                {search && (
                  <span className="text-xs text-gray-400">
                    (applies to the {filtered.length} shown)
                  </span>
                )}
              </div>
            </div>

            <ul className="divide-y divide-gray-100">
              {filtered.map((entry) => {
                const current = statusOf(entry);
                const isDirty = entry.id in draft;

                return (
                  <li
                    key={entry.id}
                    className={cn(
                      "px-4 py-2.5 flex flex-wrap items-center gap-3 transition-colors",
                      isDirty && "bg-primary-50/40",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {entry.name}
                      </p>
                      {entry.admissionNo && (
                        <p className="text-xs text-gray-400">{entry.admissionNo}</p>
                      )}
                    </div>

                    {!current && (
                      <Badge label={t("attendance.notMarked")} variant="default" />
                    )}

                    <div className="flex items-center gap-1">
                      {statuses.map((s) => {
                        const style  = STATUS_STYLE[s];
                        const active = current === s;
                        const Icon   = style.icon;
                        return (
                          <button
                            key={s}
                            type="button"
                            aria-pressed={active}
                            title={STATUS_LABELS[s]}
                            onClick={() =>
                              setDraft((d) => ({ ...d, [entry.id]: s }))
                            }
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs font-medium transition-colors",
                              active ? style.on : cn("bg-white", style.off),
                            )}
                          >
                            <Icon className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">{STATUS_LABELS[s]}</span>
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          {/* Sticky save bar — with thirty rows the buttons would otherwise be
              off-screen by the time the register is filled in. */}
          {dirtyCount > 0 && (
            <div className="sticky bottom-4 z-10">
              <div className="mx-auto max-w-xl px-4 py-3 rounded-xl bg-gray-900 text-white shadow-lg flex items-center justify-between gap-4">
                <p className="text-sm">
                  <strong>{dirtyCount}</strong> unsaved{" "}
                  {dirtyCount === 1 ? "mark" : "marks"}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={discard}
                    className="text-xs text-gray-300 hover:text-white underline"
                  >
                    {t("common.discard")}
                  </button>
                  <Button
                    size="sm"
                    icon={<Save className="w-4 h-4" />}
                    loading={saveMutation.isPending}
                    onClick={() => saveMutation.mutate()}
                  >
                    {t("attendance.save")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
