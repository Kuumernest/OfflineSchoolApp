// web/src/pages/timetable/conflicts.tsx
//
// Every timetable conflict, and a way to fix each one.
//
// The dashboard said "1 timetable conflict detected" and the alert opened the
// grid, which could not say which lessons it meant. This page lists what the
// server's detector found — the same list the dashboard counts — one card per
// conflict, grouped by day, with the entries side by side.
//
// Each entry carries the fixes the server has checked are safe: a period where
// the class AND the teacher are free, a teacher of the subject who is free at
// that slot, or a swap with another lesson of the class that leaves neither in
// a conflict. Every fix is an ordinary PUT/DELETE, so the desktop queues them
// offline like any other edit. After each one the list and the dashboard count
// are refetched, so the number drops the moment the fix lands.

import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Trash2,
  UserRoundCog,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

import {
  fetchConflicts,
  fetchResolutionOptions,
  updateSlot,
  deleteSlot,
  applySwap,
} from "@/services/timetable.service";
import { DAY_CODES, DAY_LABEL_KEYS, DAY_SHORT_KEYS } from "@/types/timetable.types";
import type {
  ConflictEntry,
  DayCode,
  TimetableConflict,
  TimetableConflictType,
} from "@/types/timetable.types";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/axios";

// ─────────────────────────────────────────────────────────────────────────────

type Action = "move" | "teacher" | "swap";

const TYPE_BADGE: Record<TimetableConflictType, { key: string; variant: "danger" | "warning" | "info" }> = {
  TEACHER_DOUBLE_BOOKED: { key: "ttConflicts.typeTeacher", variant: "danger"  },
  CLASS_DOUBLE_BOOKED:   { key: "ttConflicts.typeClass",   variant: "danger"  },
  ROOM_DOUBLE_BOOKED:    { key: "ttConflicts.typeRoom",    variant: "warning" },
  PERIOD_OVERLAP:        { key: "ttConflicts.typePeriod",  variant: "info"    },
};

const ALL_WEEK = "ALL";

// ─────────────────────────────────────────────────────────────────────────────

export default function TimetableConflictsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast, confirm } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";
  const lang     = i18n.language?.startsWith("fr") ? "fr" : "en";

  const [active, setActive] = useState<{ entry: ConflictEntry; action: Action } | null>(null);

  const conflictsQ = useQuery({
    queryKey: ["timetable-conflicts", schoolId, lang],
    queryFn:  () => fetchConflicts(lang),
    enabled:  !!schoolId,
  });

  const conflicts = useMemo(() => conflictsQ.data ?? [], [conflictsQ.data]);

  // Grouped by day in week order; period overlaps hold every day, so they get
  // their own group at the top.
  const groups = useMemo(() => {
    const byDay = new Map<string, TimetableConflict[]>();
    for (const c of conflicts) {
      const key = c.day ?? ALL_WEEK;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(c);
    }
    return [ALL_WEEK, ...DAY_CODES]
      .filter((d) => byDay.has(d))
      .map((d) => ({ day: d, items: byDay.get(d)! }));
  }, [conflicts]);

  /** Re-run detection here and on the dashboard after any fix. */
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["timetable-conflicts"] });
    qc.invalidateQueries({ queryKey: ["timetable-conflict-options"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["timetable"] });
    qc.invalidateQueries({ queryKey: ["timetable-all"] });
  }, [qc]);

  const fixed = useCallback(() => {
    toast({ title: t("ttConflicts.fixed"), kind: "success" });
    setActive(null);
    refresh();
  }, [toast, t, refresh]);

  const failed = useCallback((err: unknown) => {
    toast({ title: t("ttConflicts.fixFailed"), message: getErrorMessage(err), kind: "error" });
    refresh();
  }, [toast, t, refresh]);

  const removeMutation = useMutation({
    mutationFn: (entryId: string) => deleteSlot(entryId),
    onSuccess:  fixed,
    onError:    failed,
  });

  const onRemove = async (entry: ConflictEntry) => {
    const ok = await confirm({
      title:        t("ttConflicts.removeTitle"),
      message:      t("ttConflicts.removeBody", {
        subject: entry.subjectName, className: entry.className, teacher: entry.teacherName,
      }),
      confirmLabel: t("ttConflicts.remove"),
      kind:         "danger",
    });
    if (ok) removeMutation.mutate(entry.entryId);
  };

  const openInTimetable = (entry: ConflictEntry) =>
    navigate(`/timetable?classId=${encodeURIComponent(entry.classId)}&highlight=${encodeURIComponent(entry.entryId)}`);

  if (conflictsQ.isLoading) return <PageSpinner />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/dashboard" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
            <ArrowLeft className="w-3.5 h-3.5" /> {t("ttConflicts.back")}
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-gray-900">{t("ttConflicts.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {conflicts.length === 0
              ? t("ttConflicts.none")
              : t("ttConflicts.count", { count: conflicts.length })}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="w-4 h-4" />}
          onClick={refresh}
          loading={conflictsQ.isFetching}
        >
          {t("common.refresh")}
        </Button>
      </div>

      {conflictsQ.isError ? (
        <Card className="text-center py-10">
          <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
          <p className="mt-3 text-sm text-gray-700">{getErrorMessage(conflictsQ.error)}</p>
        </Card>
      ) : conflicts.length === 0 ? (
        <Card className="text-center py-16">
          <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
          <p className="mt-3 text-sm font-medium text-gray-700">{t("ttConflicts.allClear")}</p>
          <Link to="/timetable">
            <Button className="mt-4" size="sm" variant="secondary">{t("ttConflicts.openTimetable")}</Button>
          </Link>
        </Card>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              {g.day === ALL_WEEK ? t("ttConflicts.allWeek") : t(DAY_LABEL_KEYS[g.day as DayCode])}
            </h2>
            {g.items.map((c) => (
              <ConflictCard
                key={c.id}
                conflict={c}
                busy={removeMutation.isPending}
                onAction={(entry, action) => setActive({ entry, action })}
                onRemove={onRemove}
                onOpen={openInTimetable}
              />
            ))}
          </section>
        ))
      )}

      {active && (
        <ResolveModal
          entry={active.entry}
          action={active.action}
          onClose={() => setActive(null)}
          onDone={fixed}
          onError={failed}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLICT CARD
// ─────────────────────────────────────────────────────────────────────────────

function whenLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  c: { periodName: string | null; periodNumber: number | null; startTime: string | null; endTime: string | null },
) {
  const name = c.periodName ?? (c.periodNumber ? t("ttConflicts.periodN", { n: c.periodNumber }) : "");
  const time = c.startTime && c.endTime ? ` (${c.startTime}–${c.endTime})` : "";
  return `${name}${time}`;
}

function ConflictCard({
  conflict,
  busy,
  onAction,
  onRemove,
  onOpen,
}: {
  conflict: TimetableConflict;
  busy:     boolean;
  onAction: (entry: ConflictEntry, action: Action) => void;
  onRemove: (entry: ConflictEntry) => void;
  onOpen:   (entry: ConflictEntry) => void;
}) {
  const { t } = useTranslation();
  const badge = TYPE_BADGE[conflict.conflict_type];

  return (
    <Card className="space-y-3 border-l-4 border-l-red-400">
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={t(badge.key)} variant={badge.variant} />
        <span className="text-sm font-medium text-gray-800">
          {conflict.day ? `${t(DAY_LABEL_KEYS[conflict.day])} · ` : ""}
          {conflict.conflict_type === "PERIOD_OVERLAP" ? t("ttConflicts.periodDefinitions") : whenLabel(t, conflict)}
        </span>
      </div>

      <p className="text-sm text-gray-700">{conflict.message}</p>

      {conflict.conflict_type === "PERIOD_OVERLAP" ? (
        <div className="flex flex-wrap items-center gap-2">
          {(conflict.periods ?? []).map((p) => (
            <span key={p.periodId} className="px-2.5 py-1 rounded-md bg-gray-50 border border-gray-200 text-xs text-gray-700">
              {whenLabel(t, { periodName: p.name, periodNumber: p.number, startTime: p.startTime, endTime: p.endTime })}
            </span>
          ))}
          <Link to="/periods">
            <Button size="sm" variant="secondary" icon={<CalendarClock className="w-4 h-4" />}>
              {t("ttConflicts.editPeriods")}
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {conflict.entries.map((e) => (
            <div key={e.entryId} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-2.5">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-gray-500">{t("ttConflicts.class")}</dt>
                <dd className="font-medium text-gray-900 truncate">{e.className}</dd>
                <dt className="text-gray-500">{t("ttConflicts.subject")}</dt>
                <dd className="text-gray-800 truncate">{e.subjectName}</dd>
                <dt className="text-gray-500">{t("ttConflicts.teacher")}</dt>
                <dd className="text-gray-800 truncate">{e.teacherName}</dd>
                <dt className="text-gray-500">{t("ttConflicts.room")}</dt>
                <dd className="text-gray-800 truncate">{e.room || "—"}</dd>
              </dl>

              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" icon={<CalendarClock className="w-4 h-4" />} onClick={() => onAction(e, "move")}>
                  {t("ttConflicts.move")}
                </Button>
                <Button size="sm" variant="secondary" icon={<UserRoundCog className="w-4 h-4" />} onClick={() => onAction(e, "teacher")}>
                  {t("ttConflicts.changeTeacher")}
                </Button>
                <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="w-4 h-4" />} onClick={() => onAction(e, "swap")}>
                  {t("ttConflicts.swap")}
                </Button>
                <Button size="sm" variant="ghost" icon={<ExternalLink className="w-4 h-4" />} onClick={() => onOpen(e)}>
                  {t("ttConflicts.openInTimetable")}
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="w-4 h-4" />} disabled={busy} onClick={() => onRemove(e)}>
                  {t("ttConflicts.remove")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVE MODAL
//
// Lists only the options the server has checked: nothing here can create a
// new conflict, so one tap applies it.
// ─────────────────────────────────────────────────────────────────────────────

function ResolveModal({
  entry,
  action,
  onClose,
  onDone,
  onError,
}: {
  entry:   ConflictEntry;
  action:  Action;
  onClose: () => void;
  onDone:  () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();

  const optionsQ = useQuery({
    queryKey: ["timetable-conflict-options", entry.entryId],
    queryFn:  () => fetchResolutionOptions(entry.entryId),
  });

  const apply = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess:  onDone,
    onError,
  });

  const title = {
    move:    t("ttConflicts.moveTitle",    { subject: entry.subjectName, className: entry.className }),
    teacher: t("ttConflicts.teacherTitle", { subject: entry.subjectName, className: entry.className }),
    swap:    t("ttConflicts.swapTitle",    { subject: entry.subjectName, className: entry.className }),
  }[action];

  const opts = optionsQ.data;
  const rowClass =
    "w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-gray-200 " +
    "text-left text-sm hover:border-primary-400 hover:bg-primary-50/50 transition-colors disabled:opacity-50";

  const empty = (key: string) => <p className="text-sm text-gray-500 py-4 text-center">{t(key)}</p>;

  return (
    <Modal open onClose={onClose} title={title} size="md">
      {optionsQ.isLoading ? (
        <PageSpinner />
      ) : optionsQ.isError ? (
        <p className="text-sm text-red-600">{getErrorMessage(optionsQ.error)}</p>
      ) : action === "move" ? (
        opts && opts.freePeriods.length ? (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            <p className="text-xs text-gray-500 pb-1">{t("ttConflicts.moveHint")}</p>
            {opts.freePeriods.map((p) => (
              <button
                key={`${p.dayOfWeek}:${p.periodId}`}
                type="button"
                className={rowClass}
                disabled={apply.isPending}
                onClick={() => apply.mutate(() => updateSlot(entry.entryId, { dayOfWeek: p.dayOfWeek, periodId: p.periodId }))}
              >
                <span className="font-medium text-gray-800">
                  {t(DAY_SHORT_KEYS[p.dayOfWeek])} · {whenLabel(t, p)}
                </span>
                {p.sameDay && <Badge label={t("ttConflicts.sameDay")} variant="success" />}
              </button>
            ))}
          </div>
        ) : empty("ttConflicts.noFreePeriods")
      ) : action === "teacher" ? (
        opts && opts.freeTeachers.length ? (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            <p className="text-xs text-gray-500 pb-1">{t("ttConflicts.teacherHint")}</p>
            {opts.freeTeachers.map((tch) => (
              <button
                key={tch.teacherId}
                type="button"
                className={rowClass}
                disabled={apply.isPending}
                onClick={() => apply.mutate(() => updateSlot(entry.entryId, { teacherId: tch.teacherId }))}
              >
                <span className="font-medium text-gray-800">{tch.teacherName}</span>
                {tch.teachesThisClass && <Badge label={t("ttConflicts.teachesClass")} variant="info" />}
              </button>
            ))}
          </div>
        ) : empty("ttConflicts.noFreeTeachers")
      ) : opts && opts.swaps.length ? (
        <div className="space-y-1.5 max-h-96 overflow-y-auto">
          <p className="text-xs text-gray-500 pb-1">{t("ttConflicts.swapHint")}</p>
          {opts.swaps.map((s) => (
            <button
              key={s.entryId}
              type="button"
              className={rowClass}
              disabled={apply.isPending}
              onClick={() => apply.mutate(() => applySwap(s.updates, {
                entryId: entry.entryId, subjectId: entry.subjectId, teacherId: entry.teacherId, room: entry.room,
              }))}
            >
              <span className="min-w-0">
                <span className="block font-medium text-gray-800">
                  {t(DAY_SHORT_KEYS[s.dayOfWeek])} · {whenLabel(t, s)}
                </span>
                <span className="block text-xs text-gray-500 truncate">
                  {s.subjectName} · {s.teacherName}{s.room ? ` · ${s.room}` : ""}
                </span>
              </span>
              <ArrowRightLeft className="w-4 h-4 text-gray-400 shrink-0" />
            </button>
          ))}
        </div>
      ) : empty("ttConflicts.noSwaps")}

      <div className="flex justify-end pt-4">
        <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
      </div>
    </Modal>
  );
}
