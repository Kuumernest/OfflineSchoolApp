// web/src/pages/timetable/index.tsx
//
// The timetable grid: periods down, days across, one lesson per cell.
//
// Three things drive the design here, all of them coming from the API rather
// than from taste:
//
//   1. The server enforces two uniqueness rules — one class cannot have two
//      lessons in a period, and one teacher cannot be in two places at once.
//      Both come back as 409s with a `conflict` discriminator. The grid checks
//      the teacher rule locally too, so a busy teacher is greyed out in the
//      picker rather than offered and then rejected.
//
//   2. Slots carry a `version`. An edit must round-trip it, and a mismatch is a
//      409 that includes the server's current copy. That is what makes a
//      dropped lesson safe when two people are editing the same week.
//
//   3. Days are canonical three-letter codes ("MON"). Sending "Monday" is a
//      400, so DayCode is used throughout rather than a display string.

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  Clock,
  Plus,
  Trash2,
  AlertCircle,
  Coffee,
  GripVertical,
  Users,
  Printer,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { FormField, SelectField, Input } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

import {
  fetchSlots,
  createSlot,
  updateSlot,
  deleteSlot,
  moveSlot,
  buildGrid,
  slotAt,
  isTeacherBusy,
  teacherWorkload,
  findGaps,
} from "@/services/timetable.service";
import { fetchPeriods } from "@/services/period.service";
import { fetchClasses, fetchSubjects } from "@/services/class.service";
import { fetchTeachers, fetchTeacherIdsFor } from "@/services/teacher.service";

import {
  SCHOOL_WEEK,
  DAY_LABELS,
  DAY_SHORT,
  TimetableConflictError,
} from "@/types/timetable.types";
import type { DayCode, TimetableSlot } from "@/types/timetable.types";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────

const QK = {
  slots:    (schoolId: string, classId: string) => ["timetable", schoolId, classId] as const,
  periods:  (schoolId: string) => ["periods", schoolId, false] as const,
  classes:  (schoolId: string) => ["classes", schoolId] as const,
  subjects: (schoolId: string, classId: string) => ["subjects", schoolId, classId] as const,
  teachers: (schoolId: string) => ["teachers-all", schoolId] as const,
  allSlots: (schoolId: string) => ["timetable-all", schoolId] as const,
};

interface CellTarget {
  day:      DayCode;
  periodId: string;
  existing?: TimetableSlot;
}

interface DragPayload {
  slotId: string;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function TimetablePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [classId, setClassId] = useState("");
  const [cell, setCell]       = useState<CellTarget | null>(null);
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [hoverCell, setHoverCell] = useState<string | null>(null);

  // ── Data ───────────────────────────────────────────────────────────────────
  const classesQ = useQuery({
    queryKey: QK.classes(schoolId),
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const periodsQ = useQuery({
    queryKey: QK.periods(schoolId),
    queryFn:  () => fetchPeriods(schoolId),
    enabled:  !!schoolId,
  });

  const slotsQ = useQuery({
    queryKey: QK.slots(schoolId, classId),
    queryFn:  () => fetchSlots({ schoolId, classId }),
    enabled:  !!schoolId && !!classId,
  });

  // Every slot in the school, not just this class — needed to answer "is this
  // teacher free?", which is a school-wide question. Cached separately so
  // switching class does not refetch it.
  const allSlotsQ = useQuery({
    queryKey: QK.allSlots(schoolId),
    queryFn:  () => fetchSlots({ schoolId }),
    enabled:  !!schoolId,
  });

  const subjectsQ = useQuery({
    queryKey: QK.subjects(schoolId, classId),
    queryFn:  () => fetchSubjects(schoolId, classId),
    enabled:  !!schoolId && !!classId,
  });

  const teachersQ = useQuery({
    queryKey: QK.teachers(schoolId),
    queryFn:  () => fetchTeachers({ schoolId, limit: 200 }),
    enabled:  !!schoolId,
  });

  // Each fallback is memoised rather than written inline as `?? []`: a fresh
  // array literal every render would change the identity the useMemos below
  // depend on, so buildGrid/findGaps/teacherWorkload would rerun constantly.
  const classes  = useMemo(() => classesQ.data ?? [],           [classesQ.data]);
  const periods  = useMemo(() => periodsQ.data ?? [],           [periodsQ.data]);
  const slots    = useMemo(() => slotsQ.data ?? [],             [slotsQ.data]);
  const allSlots = useMemo(() => allSlotsQ.data ?? [],          [allSlotsQ.data]);
  const subjects = useMemo(() => subjectsQ.data ?? [],          [subjectsQ.data]);
  const teachers = useMemo(() => teachersQ.data?.teachers ?? [], [teachersQ.data]);

  const grid = useMemo(() => buildGrid(slots), [slots]);

  const gaps = useMemo(
    () => findGaps(grid, SCHOOL_WEEK, periods),
    [grid, periods],
  );

  const workload = useMemo(() => teacherWorkload(allSlots), [allSlots]);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["timetable"] });
    qc.invalidateQueries({ queryKey: ["timetable-all"] });
  }, [qc]);

  // ── Conflict reporting ─────────────────────────────────────────────────────
  // A 409 is not a failure to save so much as a rule being enforced; saying
  // which rule is the whole point of surfacing it.
  const reportError = useCallback((err: unknown, fallback: string) => {
    if (err instanceof TimetableConflictError) {
      const { kind, message } = err.conflict;
      toast({
        title:   kind === "version" ? "Someone else got there first" : "That clashes",
        message: kind === "version"
          ? `${message} The grid has been refreshed with their version.`
          : message,
        kind:    "warning",
      });
      if (kind === "version") invalidate();
      return;
    }
    toast({ title: fallback, message: getErrorMessage(err), kind: "error" });
  }, [toast, invalidate]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (input: {
      day:      DayCode;
      periodId: string;
      subjectId: string;
      teacherId: string;
      room:      string;
      existing?: TimetableSlot;
    }) =>
      input.existing
        ? updateSlot(input.existing._id, {
            subjectId: input.subjectId,
            teacherId: input.teacherId,
            room:      input.room || null,
            version:   input.existing.version,
          })
        : createSlot({
            schoolId,
            classId,
            subjectId: input.subjectId,
            teacherId: input.teacherId,
            dayOfWeek: input.day,
            periodId:  input.periodId,
            room:      input.room || null,
          }),
    onSuccess: () => {
      toast({ title: "Timetable updated", kind: "success" });
      setCell(null);
      invalidate();
    },
    onError: (err) => reportError(err, "Could not save the lesson"),
  });

  const removeMutation = useMutation({
    mutationFn: (slotId: string) => deleteSlot(slotId),
    onSuccess: () => {
      toast({ title: "Lesson removed", kind: "success" });
      setCell(null);
      invalidate();
    },
    onError: (err) => reportError(err, "Could not remove the lesson"),
  });

  const moveMutation = useMutation({
    mutationFn: (input: { slot: TimetableSlot; day: DayCode; periodId: string }) =>
      moveSlot(input.slot, input.day, input.periodId),
    onSuccess: invalidate,
    onError: (err) => reportError(err, "Could not move the lesson"),
  });

  // ── Drag & drop ────────────────────────────────────────────────────────────
  // Native HTML5 DnD rather than a library: the whole interaction is "pick up
  // one card, drop it on one cell", which the platform already does.
  const onDrop = (day: DayCode, periodId: string) => {
      setHoverCell(null);
    if (!dragging) return;

    const slot = slots.find((s) => s._id === dragging.slotId);
    setDragging(null);
    if (!slot) return;

    // Dropped back where it started.
    if (slot.dayOfWeek === day && slot.periodId === periodId) return;

    // The target is occupied. Swapping would need two writes that can half-fail
    // and the server has no atomic swap, so this is refused rather than
    // half-applied.
    if (slotAt(grid, day, periodId)) {
      toast({
        title:   "That period is taken",
        message: "Remove the lesson already there first, then move this one in.",
        kind:    "warning",
      });
      return;
    }

    moveMutation.mutate({ slot, day, periodId });
  };

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (classesQ.isLoading || periodsQ.isLoading) return <PageSpinner />;

  if (periods.length === 0) {
    return (
      <Card className="max-w-xl mx-auto mt-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center mx-auto">
          <Clock className="w-6 h-6 text-amber-600" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-gray-800">
          {t("timetable.setUpDay")}
        </h2>
        <p className="mt-1.5 text-sm text-gray-500">
          A timetable is built out of periods, and none are defined yet. Add
          them once and every class's timetable gets the same rows.
        </p>
        <Link to="/periods">
          <Button className="mt-4" size="sm" icon={<Clock className="w-4 h-4" />}>
            {t("timetable.setUpPeriods")}
          </Button>
        </Link>
      </Card>
    );
  }

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{t("timetable.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Click a free period to add a lesson, or drag a lesson to move it.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select
            options={classOptions}
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="min-w-48"
          />
          {classId && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="w-4 h-4" />}
                onClick={invalidate}
              >
                {t("common.refresh")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Printer className="w-4 h-4" />}
                onClick={() => window.print()}
              >
                {t("common.print")}
              </Button>
            </>
          )}
        </div>
      </div>

      {!classId ? (
        <Card className="text-center py-16">
          <CalendarDays className="w-8 h-8 text-gray-300 mx-auto" />
          <p className="mt-3 text-sm font-medium text-gray-700">
            {t("timetable.pickClass")}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Each class has its own timetable, built from the same periods.
          </p>
        </Card>
      ) : slotsQ.isLoading ? (
        <PageSpinner />
      ) : (
        <>
          {/* ── Grid ────────────────────────────────────────────────────── */}
          <Card padding={false} className="overflow-hidden">
            {/* Wide grids scroll inside the card; the page never scrolls
                sideways. */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse min-w-[52rem]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="sticky left-0 z-10 bg-gray-50 px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-40">
                      {t("periods.period")}
                    </th>
                    {SCHOOL_WEEK.map((day) => (
                      <th
                        key={day}
                        className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider"
                      >
                        <span className="hidden lg:inline">{DAY_LABELS[day]}</span>
                        <span className="lg:hidden">{DAY_SHORT[day]}</span>
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-100">
                  {periods.map((period) => (
                    <tr key={period._id}>
                      {/* Period label — sticky so it stays readable while the
                          days scroll under it. */}
                      <td className="sticky left-0 z-10 bg-white px-4 py-2 align-top border-r border-gray-100">
                        <div className="flex items-start gap-1.5">
                          {period.isBreak && (
                            <Coffee className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {period.name}
                            </p>
                            <p className="text-xs text-gray-400 tabular-nums">
                              {period.startTime}–{period.endTime}
                            </p>
                          </div>
                        </div>
                      </td>

                      {SCHOOL_WEEK.map((day) => {
                        const slot    = slotAt(grid, day, period._id);
                        const key     = `${day}:${period._id}`;
                        const isHover = hoverCell === key;

                        // A break row is rendered but not editable — scheduling
                        // a lesson through morning break is a mistake, not a
                        // feature.
                        if (period.isBreak) {
                          return (
                            <td key={day} className="px-2 py-2 align-top bg-amber-50/40">
                              <div className="h-14 rounded-lg border border-dashed border-amber-200 flex items-center justify-center">
                                <span className="text-xs text-amber-600">{t("timetable.break")}</span>
                              </div>
                            </td>
                          );
                        }

                        return (
                          <td
                            key={day}
                            className="px-2 py-2 align-top"
                            onDragOver={(e) => {
                              if (!dragging) return;
                              e.preventDefault();
                              setHoverCell(key);
                            }}
                            onDragLeave={() => setHoverCell((h) => (h === key ? null : h))}
                            onDrop={(e) => { e.preventDefault(); onDrop(day, period._id); }}
                          >
                            {slot ? (
                              <LessonCard
                                slot={slot}
                                onOpen={() => setCell({ day, periodId: period._id, existing: slot })}
                                onDragStart={() => setDragging({ slotId: slot._id })}
                                onDragEnd={() => { setDragging(null); setHoverCell(null); }}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => setCell({ day, periodId: period._id })}
                                className={cn(
                                  "w-full h-14 rounded-lg border border-dashed transition-colors",
                                  "flex items-center justify-center group",
                                  isHover
                                    ? "border-primary-500 bg-primary-50"
                                    : "border-gray-200 hover:border-primary-400 hover:bg-primary-50/50",
                                )}
                              >
                                <Plus
                                  className={cn(
                                    "w-4 h-4 transition-colors",
                                    isHover
                                      ? "text-primary-600"
                                      : "text-gray-300 group-hover:text-primary-500",
                                  )}
                                />
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── Side panels ─────────────────────────────────────────────── */}
          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader
                title={t("timetable.unfilled")}
                subtitle={
                  gaps.length === 0
                    ? "Every teaching period this week has a lesson."
                    : `${gaps.length} teaching ${gaps.length === 1 ? "period" : "periods"} still empty`
                }
              />
              {gaps.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {gaps.slice(0, 24).map(({ day, period }) => (
                    <button
                      key={`${day}-${period._id}`}
                      onClick={() => setCell({ day, periodId: period._id })}
                      className="px-2 py-1 rounded-md bg-gray-50 border border-gray-200 text-xs text-gray-600 hover:border-primary-400 hover:text-primary-600 transition-colors"
                    >
                      {DAY_SHORT[day]} · {period.name}
                    </button>
                  ))}
                  {gaps.length > 24 && (
                    <span className="px-2 py-1 text-xs text-gray-400">
                      +{gaps.length - 24} more
                    </span>
                  )}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title={t("timetable.teacherLoad")}
                subtitle={t("timetable.blurb")}
              />
              {workload.length === 0 ? (
                <p className="text-sm text-gray-500">{t("timetable.nothingYet")}</p>
              ) : (
                <ul className="space-y-1.5">
                  {workload.slice(0, 8).map((w) => (
                    <li key={w.teacherId} className="flex items-center gap-3">
                      <Users className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                      <span className="text-sm text-gray-700 truncate flex-1">
                        {w.name}
                      </span>
                      <Badge
                        label={`${w.slots}`}
                        variant={w.slots > 25 ? "warning" : "info"}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      {/* ── Cell editor ─────────────────────────────────────────────────── */}
      {cell && (
        <SlotEditor
          target={cell}
          periodName={periods.find((p) => p._id === cell.periodId)?.name ?? ""}
          subjects={subjects.map((s) => ({
            value: s.id ?? s._id ?? "",
            label: s.code ? `${s.name} (${s.code})` : s.name,
          }))}
          teachers={teachers.map((t) => ({
            value:    t._id,
            label:    t.name,
            // The server would reject a double-booked teacher with a 409.
            // Disabling them here means the clash is visible before saving.
            disabled: isTeacherBusy(
              allSlots,
              t._id,
              cell.day,
              cell.periodId,
              cell.existing?._id,
            ),
          }))}
          classId={classId}
          schoolId={schoolId}
          saving={saveMutation.isPending}
          removing={removeMutation.isPending}
          onClose={() => setCell(null)}
          onSave={(v) => saveMutation.mutate({ ...v, day: cell.day, periodId: cell.periodId, existing: cell.existing })}
          onRemove={async () => {
            if (!cell.existing) return;
            const ok = await confirm({
              title:        "Remove this lesson?",
              message:      "The period becomes free again. Nothing else changes.",
              confirmLabel: "Remove lesson",
              kind:         "danger",
            });
            if (ok) removeMutation.mutate(cell.existing._id);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LESSON CARD
// ─────────────────────────────────────────────────────────────────────────────

function LessonCard({
  slot,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  slot:        TimetableSlot;
  onOpen:      () => void;
  onDragStart: () => void;
  onDragEnd:   () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Some browsers refuse to start a drag without data on the transfer.
        e.dataTransfer.setData("text/plain", slot._id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
      className={cn(
        "group h-14 px-2.5 py-1.5 rounded-lg cursor-grab active:cursor-grabbing",
        "bg-primary-50 border border-primary-200",
        "hover:border-primary-400 hover:bg-primary-100/70 transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-primary-500",
        "flex items-start gap-1.5",
      )}
    >
      <GripVertical className="w-3 h-3 text-primary-300 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-primary-900 truncate leading-tight">
          {slot.subject?.name ?? slot.subjectName ?? "Unknown subject"}
        </p>
        <p className="text-[11px] text-primary-700/80 truncate">
          {slot.teacher?.name ?? "Unassigned"}
        </p>
        {slot.room && (
          <p className="text-[10px] text-primary-600/70 truncate">{slot.room}</p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOT EDITOR
// ─────────────────────────────────────────────────────────────────────────────

interface EditorOption {
  value:     string;
  label:     string;
  disabled?: boolean;
}

function SlotEditor({
  target,
  periodName,
  subjects,
  teachers,
  classId,
  schoolId,
  saving,
  removing,
  onClose,
  onSave,
  onRemove,
}: {
  target:     CellTarget;
  periodName: string;
  subjects:   EditorOption[];
  teachers:   EditorOption[];
  /** Needed to look up who actually teaches the chosen subject here. */
  classId:    string;
  schoolId:   string;
  saving:     boolean;
  removing:   boolean;
  onClose:    () => void;
  onSave:     (v: { subjectId: string; teacherId: string; room: string }) => void;
  onRemove:   () => void;
}) {
  const { t } = useTranslation();
  const existing = target.existing;

  const [subjectId, setSubjectId] = useState(existing?.subjectId ?? "");
  const [teacherId, setTeacherId] = useState(existing?.teacherId ?? "");
  const [room,      setRoom]      = useState(existing?.room ?? "");

  /**
   * Only the teachers assigned to this subject IN THIS CLASS.
   *
   * The list used to be every teacher in the school, narrowed only by who was
   * already busy that period. So picking Mathematics offered staff who do not
   * teach Mathematics, and the resulting timetable looked perfectly valid to
   * everyone downstream — the mistake surfaces in a classroom, not on screen.
   * The mobile builder has always filtered this way; the web never did.
   */
  const assignedQ = useQuery({
    queryKey: ["assigned-teachers", schoolId, classId, subjectId],
    queryFn:  () => fetchTeacherIdsFor(schoolId, classId, subjectId),
    enabled:  Boolean(schoolId && classId && subjectId),
  });

  const options = useMemo(() => {
    if (!subjectId) return [];
    if (!assignedQ.data) return [];
    return teachers.filter((o) => assignedQ.data.has(o.value));
  }, [teachers, assignedQ.data, subjectId]);

  /**
   * The teacher actually in effect.
   *
   * Derived rather than cleared through an effect. A teacher held in state who
   * is not on the current list must not count — otherwise changing the subject
   * leaves a name selected that the dropdown no longer offers, and Save would
   * submit it. Deriving also avoids the cascading render an effect-and-setState
   * pair produces on every list change.
   */
  const effectiveTeacherId =
    teacherId && options.some((o) => o.value === teacherId) ? teacherId : "";

  const busyTeachers = options.filter((o) => o.disabled).length;
  const noneAssigned =
    Boolean(subjectId) && !assignedQ.isFetching && options.length === 0;
  const canSave = !!subjectId && !!effectiveTeacherId;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${DAY_LABELS[target.day]} · ${periodName}`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) onSave({ subjectId, teacherId: effectiveTeacherId, room });
        }}
        className="space-y-4"
      >
        <FormField label={t("academic.subject")} required>
          <SelectField
            options={subjects}
            placeholder={t("timetable.chooseSubject")}
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
          />
        </FormField>

        <FormField
          label={t("academic.teacher")}
          required
          error={noneAssigned ? t("timetable.noTeacherAssigned") : undefined}
          hint={
            busyTeachers > 0
              ? t("timetable.teachersBusy", { count: busyTeachers })
              : subjectId ? t("timetable.assignedOnly") : undefined
          }
        >
          <SelectField
            options={options}
            placeholder={
              !subjectId              ? t("timetable.chooseSubjectFirst") :
              assignedQ.isFetching    ? t("common.loading") :
                                        t("timetable.chooseTeacher")
            }
            disabled={!subjectId || assignedQ.isFetching}
            invalid={noneAssigned}
            value={effectiveTeacherId}
            onChange={(e) => setTeacherId(e.target.value)}
          />
        </FormField>

        <FormField label={t("timetable.room")} hint="Optional.">
          <Input
            value={room ?? ""}
            onChange={(e) => setRoom(e.target.value)}
            placeholder={t("timetable.roomPh")}
          />
        </FormField>

        {subjects.length === 0 && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">
              This class has no subjects yet. Add them under{" "}
              <Link to="/subjects" className="underline font-medium">{t("academic.subject_other")}</Link>{" "}
              before building its timetable.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {existing ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              icon={<Trash2 className="w-4 h-4" />}
              loading={removing}
              onClick={onRemove}
            >
              {t("common.remove")}
            </Button>
          ) : <span />}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave} loading={saving}>
              {existing ? "Save changes" : "Add lesson"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
