// web/src/components/dashboard/ExamStatusChart.tsx
import { FileText } from "lucide-react";

interface ExamStats {
  total:     number;
  ongoing:   number;
  completed: number;
  draft:     number;
  scheduled?: number;
}

interface Props {
  stats: ExamStats;
}

// ─────────────────────────────────────────────────────────
// SEGMENT CONFIG
// ─────────────────────────────────────────────────────────
const SEGMENTS = [
  {
    key:      "ongoing"   as const,
    label:    "Ongoing",
    color:    "bg-orange-500",
    dotColor: "bg-orange-500",
    textColor:"text-orange-600 dark:text-orange-400",
    bgColor:  "bg-orange-50 dark:bg-orange-900/20",
  },
  {
    key:      "completed" as const,
    label:    "Completed",
    color:    "bg-green-500",
    dotColor: "bg-green-500",
    textColor:"text-green-600 dark:text-green-400",
    bgColor:  "bg-green-50 dark:bg-green-900/20",
  },
  {
    key:      "draft"     as const,
    label:    "Draft",
    color:    "bg-gray-400",
    dotColor: "bg-gray-400",
    textColor:"text-gray-600 dark:text-gray-400",
    bgColor:  "bg-gray-50 dark:bg-gray-700/40",
  },
  {
    key:      "scheduled" as const,
    label:    "Scheduled",
    color:    "bg-blue-500",
    dotColor: "bg-blue-500",
    textColor:"text-blue-600 dark:text-blue-400",
    bgColor:  "bg-blue-50 dark:bg-blue-900/20",
  },
] as const;

// ─────────────────────────────────────────────────────────
// DONUT HELPERS
// ─────────────────────────────────────────────────────────
const RADIUS      = 54;
const STROKE      = 10;
const CIRCUMF     = 2 * Math.PI * RADIUS;
const CENTER      = 70;  // viewBox is 140×140

function buildArcs(stats: ExamStats) {
  const total = stats.total || 1; // avoid divide-by-zero
  let offset  = 0;

  return SEGMENTS.map((seg) => {
    const value   = stats[seg.key] ?? 0;
    const pct     = value / total;
    const dash    = pct * CIRCUMF;
    const gap     = CIRCUMF - dash;
    const arc     = { ...seg, value, dash, gap, offset };
    offset       += dash;
    return arc;
  });
}

// ─────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────
export default function ExamStatusChart({ stats }: Props) {
  const arcs         = buildArcs(stats);
  const hasAnyExams  = stats.total > 0;

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200
                  dark:border-gray-700 shadow-sm p-6 flex flex-col gap-4"
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          Exam Status
        </h3>
        <div
          className="flex items-center gap-1.5 text-xs font-medium
                      text-gray-500 dark:text-gray-400"
        >
          <FileText className="h-3.5 w-3.5" />
          {stats.total} total
        </div>
      </div>

      {/* ── Donut chart ── */}
      <div className="flex items-center justify-center">
        <div className="relative">
          <svg
            width="140"
            height="140"
            viewBox="0 0 140 140"
            className="-rotate-90"   /* start arcs from 12 o'clock */
          >
            {hasAnyExams ? (
              arcs.map((arc) => (
                <circle
                  key={arc.key}
                  cx={CENTER}
                  cy={CENTER}
                  r={RADIUS}
                  fill="none"
                  strokeWidth={STROKE}
                  className={`transition-all duration-700 ${arc.color}`}
                  stroke="currentColor"
                  strokeDasharray={`${arc.dash} ${arc.gap}`}
                  strokeDashoffset={-arc.offset}
                  strokeLinecap="butt"
                />
              ))
            ) : (
              /* Empty state ring */
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                className="text-gray-200 dark:text-gray-700"
                stroke="currentColor"
                strokeDasharray={`${CIRCUMF} 0`}
              />
            )}
          </svg>

          {/* Centre label */}
          <div
            className="absolute inset-0 flex flex-col items-center
                        justify-center pointer-events-none"
          >
            <span className="text-2xl font-bold text-gray-900 dark:text-white">
              {stats.total}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              exams
            </span>
          </div>
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="grid grid-cols-2 gap-2">
        {SEGMENTS.map((seg) => {
          const value = stats[seg.key] ?? 0;
          const pct   = stats.total > 0
            ? Math.round((value / stats.total) * 100)
            : 0;

          return (
            <div
              key={seg.key}
              className={`flex items-center justify-between rounded-lg px-3 py-2 ${seg.bgColor}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${seg.dotColor}`}
                />
                <span className="text-xs text-gray-600 dark:text-gray-300">
                  {seg.label}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className={`text-sm font-bold ${seg.textColor}`}>
                  {value}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  ({pct}%)
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Empty state message ── */}
      {!hasAnyExams && (
        <p className="text-center text-xs text-gray-400 dark:text-gray-500 -mt-1">
          No exams created yet
        </p>
      )}
    </div>
  );
}