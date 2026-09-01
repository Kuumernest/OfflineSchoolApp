// web/src/pages/attendance/reports/index.tsx
//
// Attendance at a glance: today's split for students and staff, and the
// seven-day present-rate trend.
//
// The chart is hand-drawn SVG rather than a charting library. It is a single
// seven-point line — pulling in a chart runtime for that costs more than it
// returns, and inline SVG scales and themes without extra work.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Users,
  School,
  ClipboardCheck,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PageSpinner } from "@/components/ui/Spinner";
import {
  fetchOverview,
  fetchWeeklyTrend,
  todayKey,
} from "@/services/attendance.service";
import type { AttendanceSummary } from "@/types/attendance.types";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/axios";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

const QK = {
  overview: (schoolId: string, date: string) => ["attendance-overview", schoolId, date] as const,
  weekly:   (schoolId: string) => ["attendance-weekly", schoolId] as const,
};

export default function AttendanceReportsPage() {
  const { t } = useTranslation();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [date, setDate] = useState(todayKey());

  const overviewQ = useQuery({
    queryKey: QK.overview(schoolId, date),
    queryFn:  () => fetchOverview(schoolId, date),
    enabled:  !!schoolId,
  });

  const weeklyQ = useQuery({
    queryKey: QK.weekly(schoolId),
    queryFn:  () => fetchWeeklyTrend(schoolId),
    enabled:  !!schoolId,
  });

  const trend = useMemo(() => weeklyQ.data ?? [], [weeklyQ.data]);

  // Direction of travel: today's rate against the mean of the days before it.
  // A single day-on-day comparison swings wildly (a Monday against a Friday),
  // so the baseline is the rest of the week.
  const movement = useMemo(() => {
    const rates = trend
      .map((t) => t.students?.rate)
      .filter((r): r is number => typeof r === "number");
    if (rates.length < 2) return null;

    const latest   = rates[rates.length - 1];
    const previous = rates.slice(0, -1);
    const baseline = previous.reduce((a, b) => a + b, 0) / previous.length;
    return { latest, delta: Math.round(latest - baseline) };
  }, [trend]);

  if (overviewQ.isLoading) return <PageSpinner />;

  if (overviewQ.error) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">
              {t("attendance.figuresFailed")}
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {getErrorMessage(overviewQ.error)}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const students = overviewQ.data?.students;
  const teachers = overviewQ.data?.teachers;

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{t("attendance.reportsTitle")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t("attendance.reportBlurb")}
          </p>
        </div>

        <div className="flex items-end gap-2">
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1.5">{t("common.date")}</span>
            <input
              type="date"
              value={date}
              max={todayKey()}
              onChange={(e) => setDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </label>
          <Link to="/attendance">
            <Button variant="secondary" size="sm" icon={<ClipboardCheck className="w-4 h-4" />}>
              {t("attendance.markRegister")}
            </Button>
          </Link>
        </div>
      </div>

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-4">
        <SummaryPanel
          title={t("academic.student_other")}
          icon={Users}
          summary={students}
          statuses={[
            { key: "present", label: "Present", tone: "bg-emerald-500" },
            { key: "absent",  label: "Absent",  tone: "bg-red-500" },
            { key: "late",    label: "Late",    tone: "bg-amber-500" },
            { key: "excused", label: "Excused", tone: "bg-blue-500" },
          ]}
        />
        <SummaryPanel
          title={t("academic.teacher_other")}
          icon={School}
          summary={teachers}
          statuses={[
            { key: "present",  label: "Present",  tone: "bg-emerald-500" },
            { key: "absent",   label: "Absent",   tone: "bg-red-500" },
            { key: "late",     label: "Late",     tone: "bg-amber-500" },
            { key: "on_leave", label: t("attendance.onLeave"), tone: "bg-blue-500" },
          ]}
        />
      </div>

      {/* ── Trend ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={t("attendance.last7d")}
          subtitle={t("attendance.shareMarked")}
          action={
            movement && (
              <div className="flex items-center gap-1.5">
                {movement.delta > 1 ? (
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                ) : movement.delta < -1 ? (
                  <TrendingDown className="w-4 h-4 text-red-600" />
                ) : (
                  <Minus className="w-4 h-4 text-gray-400" />
                )}
                <span
                  className={cn(
                    "text-sm font-medium",
                    movement.delta > 1
                      ? "text-emerald-600"
                      : movement.delta < -1
                        ? "text-red-600"
                        : "text-gray-500",
                  )}
                >
                  {movement.delta > 0 ? "+" : ""}{movement.delta} pts vs week
                </span>
              </div>
            )
          }
        />

        {weeklyQ.isLoading ? (
          <div className="h-48 flex items-center justify-center">
            <span className="text-sm text-gray-400">{t("attendance.loadingTrend")}</span>
          </div>
        ) : trend.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center gap-2">
            <BarChart3 className="w-7 h-7 text-gray-300" />
            <p className="text-sm text-gray-500">
              {t("attendance.noneLastWeek")}
            </p>
          </div>
        ) : (
          <TrendChart
            points={trend.map((t) => ({
              date: t.date,
              rate: t.students?.rate ?? 0,
            }))}
          />
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY PANEL
// ─────────────────────────────────────────────────────────────────────────────

function SummaryPanel({
  title,
  icon: Icon,
  summary,
  statuses,
}: {
  title:    string;
  icon:     React.ComponentType<{ className?: string }>;
  summary?: AttendanceSummary;
  statuses: { key: keyof AttendanceSummary; label: string; tone: string }[];
}) {
  const { t } = useTranslation();
  const total   = summary?.total ?? 0;
  const marked  = summary?.marked ?? 0;
  const rate    = summary?.rate ?? 0;
  const unmarked = summary?.unmarked ?? Math.max(0, total - marked);

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center">
            <Icon className="w-4 h-4 text-primary-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
            <p className="text-xs text-gray-500">{total} on the roster</p>
          </div>
        </div>

        <div className="text-right">
          <p className="text-2xl font-semibold text-gray-900 leading-none tabular-nums">
            {rate}%
          </p>
          <p className="text-xs text-gray-400 mt-0.5">present</p>
        </div>
      </div>

      {/* Stacked bar. Unmarked is shown as its own segment rather than folded
          into "absent" — not knowing where someone is, is different from
          knowing they are away. */}
      <div className="mt-4 h-2 rounded-full overflow-hidden bg-gray-100 flex">
        {statuses.map((s) => {
          const n = Number(summary?.[s.key] ?? 0);
          if (!n || !total) return null;
          return (
            <div
              key={String(s.key)}
              className={s.tone}
              style={{ width: `${(n / total) * 100}%` }}
              title={`${s.label}: ${n}`}
            />
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {statuses.map((s) => (
          <div key={String(s.key)} className="flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-full", s.tone)} />
            <span className="text-xs text-gray-500">{s.label}</span>
            <span className="text-xs font-semibold text-gray-800 tabular-nums">
              {Number(summary?.[s.key] ?? 0)}
            </span>
          </div>
        ))}
        {unmarked > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-200" />
            <span className="text-xs text-gray-500">{t("attendance.unmarked")}</span>
            <Badge label={String(unmarked)} variant="warning" />
          </div>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND CHART
// ─────────────────────────────────────────────────────────────────────────────

function TrendChart({ points }: { points: { date: string; rate: number }[] }) {
  const { t } = useTranslation();
  const W = 100;   // viewBox units — the SVG scales to its container
  const H = 40;
  const PAD = 3;

  const { line, area, dots } = useMemo(() => {
    if (points.length === 0) return { line: "", area: "", dots: [] };

    const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
    // The y axis is pinned to 0–100 rather than scaled to the data. An
    // auto-scaled axis makes a drop from 98% to 95% look like a collapse.
    const toY = (rate: number) => H - PAD - (Math.max(0, Math.min(100, rate)) / 100) * (H - PAD * 2);

    const coords = points.map((p, i) => ({
      x: PAD + i * stepX,
      y: toY(p.rate),
      ...p,
    }));

    return {
      line: coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" "),
      area:
        `M ${coords[0].x} ${H - PAD} ` +
        coords.map((c) => `L ${c.x} ${c.y}`).join(" ") +
        ` L ${coords[coords.length - 1].x} ${H - PAD} Z`,
      dots: coords,
    };
  }, [points]);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-40"
        role="img"
        aria-label={t("attendance.rate7d")}
      >
        {/* Gridlines at 25% intervals, for reading a value off the line. */}
        {[0, 25, 50, 75, 100].map((pct) => {
          const y = H - PAD - (pct / 100) * (H - PAD * 2);
          return (
            <line
              key={pct}
              x1={PAD} y1={y} x2={W - PAD} y2={y}
              stroke="#f3f4f6"
              strokeWidth="0.3"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        <path d={area} fill="rgb(37 99 235 / 0.08)" />
        <path
          d={line}
          fill="none"
          stroke="rgb(37 99 235)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {dots.map((d) => (
          <circle
            key={d.date}
            cx={d.x} cy={d.y} r="1.2"
            fill="white"
            stroke="rgb(37 99 235)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="flex justify-between mt-1">
        {points.map((p) => (
          <div key={p.date} className="text-center flex-1 min-w-0">
            <p className="text-[11px] text-gray-400">{weekdayOf(p.date)}</p>
            <p className="text-xs font-medium text-gray-700 tabular-nums">
              {p.rate}%
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Weekday initial from a "YYYY-MM-DD" key.
 *
 * Parsed as local calendar fields rather than `new Date(key)`, which treats a
 * bare date string as UTC and can label the wrong day west of Greenwich.
 */
const weekdayOf = (key: string): string => {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return "";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(y, m - 1, d).getDay()
  ];
};
