// web/src/pages/portal/AttendanceScreen.tsx
//
// Attendance for the selected child, a month at a time: the month's rate as
// the server gives it (the figure Home shows), the school days on a calendar,
// each day with its gate times, and the month by subject.
//
// A day's mark on the calendar is read from that day's own counts — all
// absent, some absent, late without absence, excused, present — so a late
// arrival reads as late, with an icon as well as a colour.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, X, Clock, CircleDashed, ShieldCheck, ChevronLeft, ChevronRight, CalendarCheck } from "lucide-react";

import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { fetchAttendance, type PortalAttendance } from "@/services/portal.service";
import { PortalCard, Skeleton, EmptyState } from "./ui";

type DayState = "present" | "absent" | "late" | "partial" | "excused";
type Day = NonNullable<PortalAttendance["dailySummaries"]>[number];

const STATE: Record<DayState, { icon: React.ReactNode; cell: string; chip: string }> = {
  present: { icon: <Check className="h-3.5 w-3.5" />,        cell: "bg-success-soft text-success",  chip: "border-success-line bg-success-soft text-success" },
  absent:  { icon: <X className="h-3.5 w-3.5" />,            cell: "bg-danger-soft text-danger",    chip: "border-danger-line bg-danger-soft text-danger" },
  late:    { icon: <Clock className="h-3.5 w-3.5" />,        cell: "bg-warning-soft text-warning",  chip: "border-warning-line bg-warning-soft text-warning" },
  partial: { icon: <CircleDashed className="h-3.5 w-3.5" />, cell: "bg-warning-soft text-warning",  chip: "border-warning-line bg-warning-soft text-warning" },
  excused: { icon: <ShieldCheck className="h-3.5 w-3.5" />,  cell: "bg-primary-50 text-primary-700", chip: "border-primary-200 bg-primary-50 text-primary-700" },
};

const stateOf = (d: Day): DayState =>
  d.total > 0 && d.absent === d.total ? "absent"
    : d.absent > 0 ? "partial"
    : d.late > 0 ? "late"
    : d.total > 0 && d.excused === d.total ? "excused"
    : "present";

const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export function AttendanceScreen({ studentId }: { studentId: string | null }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const thisMonth = monthKey(new Date());
  const [month, setMonth] = useState(thisMonth);

  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${month}-${pad(lastDay)}`;

  const q = useQuery({
    queryKey: ["portal", "attendance", studentId, month],
    queryFn: () => fetchAttendance(studentId, { from, to }),
    enabled: Boolean(studentId), retry: false, placeholderData: (prev) => prev,
  });
  const data = q.data;

  const shift = (by: number) => setMonth(monthKey(new Date(y, m - 1 + by, 1)));

  const byDate = useMemo(() => new Map((data?.dailySummaries ?? []).map((d) => [d.date, d])), [data]);
  const days = useMemo(() => [...(data?.dailySummaries ?? [])].sort((a, b) => b.date.localeCompare(a.date)), [data]);

  // Mon–Fri rows for the month; weekends are not school days.
  const weeks = useMemo(() => {
    const rows: (string | null)[][] = [];
    let row: (string | null)[] = [null, null, null, null, null];
    for (let d = 1; d <= lastDay; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) continue;
      row[dow - 1] = `${month}-${pad(d)}`;
      if (dow === 5) { rows.push(row); row = [null, null, null, null, null]; }
    }
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }, [month, y, m, lastDay]);

  const today = new Date().toISOString().slice(0, 10);
  const weekdays = t("portal.attendanceScreen.weekdays", { returnObjects: true }) as string[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-ink">{t("portal.attendanceScreen.title")}</h1>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => shift(-1)} aria-label={t("portal.attendanceScreen.prevMonth")}
            className="flex h-11 w-11 items-center justify-center rounded-control text-ink-muted hover:bg-surface hover:text-ink">
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <p className="min-w-[8.5rem] text-center text-sm font-semibold capitalize text-ink" aria-live="polite">{fmt.monthLabel(month)}</p>
          <button type="button" onClick={() => shift(1)} disabled={month >= thisMonth} aria-label={t("portal.attendanceScreen.nextMonth")}
            className="flex h-11 w-11 items-center justify-center rounded-control text-ink-muted hover:bg-surface hover:text-ink disabled:opacity-30">
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {(q.isLoading || !studentId) && <AttendanceSkeleton />}

      {data && data.total === 0 && (
        <PortalCard>
          <EmptyState icon={<CalendarCheck className="h-6 w-6" />}
            title={t("portal.attendanceScreen.empty", { month: fmt.monthLabel(month) })} hint={t("portal.attendanceScreen.emptyHint")} />
        </PortalCard>
      )}

      {data && data.total > 0 && (
        <>
          <PortalCard className="p-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink-muted">{t("portal.attendanceScreen.rate")}</p>
                <p className="text-4xl font-semibold tabular-nums text-ink">{data.rate == null ? "–" : `${data.rate}%`}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{t("portal.attendanceScreen.rateHint")}</p>
              </div>
              <p className="text-right text-sm text-ink-body">{t("portal.attendanceScreen.marked", { count: data.total })}</p>
            </div>
            <dl className="mt-4 grid grid-cols-4 gap-2">
              {(["present", "absent", "late", "excused"] as const).map((k) => (
                <div key={k} className={cn("rounded-control border px-2 py-2 text-center", STATE[k].chip)}>
                  <dt className="flex items-center justify-center gap-1 text-[11px] font-medium"><span aria-hidden="true">{STATE[k].icon}</span>{t(`portal.attendanceScreen.${k}`)}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{data.tally?.[k] ?? 0}</dd>
                </div>
              ))}
            </dl>
          </PortalCard>

          <PortalCard className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">{t("portal.attendanceScreen.calendar")}</h2>
            <div role="grid" aria-label={fmt.monthLabel(month)} className="grid grid-cols-5 gap-1.5">
              {weekdays.map((w) => <div key={w} role="columnheader" className="pb-1 text-center text-[11px] font-medium text-ink-muted">{w}</div>)}
              {weeks.flat().map((date, i) => {
                if (!date) return <div key={`b${i}`} role="gridcell" aria-hidden="true" />;
                const d = byDate.get(date);
                const st = d ? stateOf(d) : null;
                const label = `${fmt.date(date)}: ${st ? t(`portal.attendanceScreen.${st}`) : t("portal.attendanceScreen.noRecord")}`;
                return (
                  <div key={date} role="gridcell" aria-label={label} title={label}
                    className={cn("flex aspect-square min-h-11 flex-col items-center justify-center rounded-control text-xs",
                      st ? STATE[st].cell : date > today ? "text-ink-faint/50" : "bg-canvas text-ink-faint",
                      date === today && "ring-2 ring-primary-600")}>
                    <span className="font-semibold tabular-nums">{Number(date.slice(8))}</span>
                    {st && <span aria-hidden="true">{STATE[st].icon}</span>}
                  </div>
                );
              })}
            </div>
            <ul aria-label={t("portal.attendanceScreen.legend")} className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-ink-body">
              {(["present", "late", "partial", "absent", "excused"] as const).map((k) => (
                <li key={k} className="flex items-center gap-1">
                  <span className={cn("flex h-5 w-5 items-center justify-center rounded", STATE[k].cell)} aria-hidden="true">{STATE[k].icon}</span>
                  {t(`portal.attendanceScreen.${k}`)}
                </li>
              ))}
            </ul>
          </PortalCard>

          <PortalCard className="overflow-hidden">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{t("portal.attendanceScreen.days")}</h2>
            <ul>
              {days.map((d) => {
                const st = stateOf(d);
                return (
                  <li key={d.date} className="flex min-h-14 items-center justify-between gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{fmt.date(d.date)}</p>
                      {(d.arrivedAt || d.departedAt) && (
                        <p className="text-xs text-ink-muted">
                          {d.arrivedAt ? t("portal.attendanceScreen.arrived", { time: fmt.time(d.arrivedAt) }) : ""}
                          {d.arrivedAt && d.departedAt ? " · " : ""}
                          {d.departedAt ? t("portal.attendanceScreen.left", { time: fmt.time(d.departedAt) }) : ""}
                        </p>
                      )}
                    </div>
                    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold", STATE[st].chip)}>
                      <span aria-hidden="true">{STATE[st].icon}</span>{t(`portal.attendanceScreen.${st}`)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </PortalCard>

          {(data.subjectSummary?.filter((s) => s.subjectId).length ?? 0) > 0 && (
            <PortalCard className="p-4">
              <h2 className="mb-3 text-sm font-semibold text-ink">{t("portal.attendanceScreen.bySubject")}</h2>
              <ul className="space-y-3">
                {data.subjectSummary!.filter((s) => s.subjectId).map((s) => {
                  const pct = s.total ? Math.round((s.present / s.total) * 100) : 0;
                  return (
                    <li key={s.subjectId}>
                      <div className="flex justify-between text-sm"><span className="text-ink">{s.subjectName ?? t("portal.general")}</span><span className="tabular-nums text-ink-body">{s.present}/{s.total}</span></div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-line" aria-hidden="true"><div className="h-full rounded-full bg-primary-600" style={{ width: `${pct}%` }} /></div>
                    </li>
                  );
                })}
              </ul>
            </PortalCard>
          )}
        </>
      )}
    </div>
  );
}

function AttendanceSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full rounded-card" />
      <Skeleton className="h-72 w-full rounded-card" />
    </div>
  );
}
