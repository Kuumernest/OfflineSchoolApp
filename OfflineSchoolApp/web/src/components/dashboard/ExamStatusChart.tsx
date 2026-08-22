// web/src/components/dashboard/ExamStatusChart.tsx
import { useTranslation }   from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";

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

/**
 * Exams by status.
 *
 * This was a 140px donut. A donut asks the eye to compare arc lengths around a
 * curve, which is the hardest comparison to make and the least precise — for
 * four parts of one whole, a stacked bar with the figures written next to the
 * labels is both more accurate and a third of the height, which matters in a
 * side rail.
 *
 * The ramp is one hue getting darker along the exam lifecycle — draft is
 * neutral, and each step towards completed is a step darker. The colours carry
 * the sequence rather than four unrelated hues implying four unrelated things.
 */
const SEGMENTS = [
  { key: "draft"     as const, labelKey: "examStatus.draft",     bar: "bg-line-strong", dot: "bg-line-strong" },
  { key: "scheduled" as const, labelKey: "examStatus.scheduled", bar: "bg-primary-200", dot: "bg-primary-200" },
  { key: "ongoing"   as const, labelKey: "examStatus.ongoing",   bar: "bg-primary-400", dot: "bg-primary-400" },
  { key: "completed" as const, labelKey: "examStatus.completed", bar: "bg-primary-700", dot: "bg-primary-700" },
];

export default function ExamStatusChart({ stats }: Props) {
  const { t } = useTranslation();
  const total = stats.total ?? 0;
  const hasAnyExams = total > 0;

  return (
    <Card>
      <CardHeader
        title={t("dashboard.examsByStatus")}
        action={
          <span className="text-xs text-ink-muted tabular">
            {t("common.total")} {total}
          </span>
        }
      />

      {/* Stacked bar */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-canvas">
        {hasAnyExams &&
          SEGMENTS.map((seg) => {
            const value = stats[seg.key] ?? 0;
            if (value === 0) return null;
            return (
              <div
                key={seg.key}
                className={`h-full transition-[width] duration-500 ${seg.bar}`}
                style={{ width: `${(value / total) * 100}%` }}
                title={`${t(seg.labelKey)}: ${value}`}
              />
            );
          })}
      </div>

      {/* Legend — the numbers live here, where they can be read exactly */}
      <dl className="mt-4 space-y-0">
        {SEGMENTS.map((seg) => {
          const value = stats[seg.key] ?? 0;
          const pct   = hasAnyExams ? Math.round((value / total) * 100) : 0;

          return (
            <div
              key={seg.key}
              className="flex items-center gap-2 border-b border-line py-1.5 last:border-b-0"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${seg.dot}`}
                aria-hidden="true"
              />
              <dt className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                {t(seg.labelKey)}
              </dt>
              <dd className="flex shrink-0 items-baseline gap-1.5">
                <span className="text-sm font-semibold text-ink tabular">
                  {value}
                </span>
                <span className="w-8 text-right text-xs text-ink-faint tabular">
                  {pct}%
                </span>
              </dd>
            </div>
          );
        })}
      </dl>

      {!hasAnyExams && (
        <p className="mt-3 text-center text-xs text-ink-faint">
          {t("dashboard.noExamsCreated")}
        </p>
      )}
    </Card>
  );
}
