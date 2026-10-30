// web/src/components/dashboard/ExamStatusChart.tsx
import { useTranslation }   from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";
import { EXAM_STATUS_META, EXAM_STATUSES } from "@/constants/exam.constants";
import type { ExamStats }   from "@/services/dashboard.service";
import { percentShares }    from "@/utils/percentShares";
import type { ExamStatus }  from "@/types/exam.types";

interface Props {
  /** Empty while loading: every count reads 0. */
  stats: Partial<ExamStats>;
}

/**
 * Exams by status.
 *
 * This was a 140px donut. A donut asks the eye to compare arc lengths around a
 * curve, which is the hardest comparison to make and the least precise — for
 * a handful of parts of one whole, a stacked bar with the figures written next
 * to the labels is both more accurate and a third of the height, which matters
 * in a side rail.
 *
 * The statuses are the exams page's own list (EXAM_STATUSES), not a copy of
 * it. The copy named four of six, so a school whose exams were published saw
 * "Total 2" over a bar of 0% segments.
 *
 * The ramp is one hue getting darker along the exam lifecycle — draft is
 * neutral, and each step towards published is a step darker; archived drops
 * back to grey, being out of the cycle. The colours carry the sequence rather
 * than unrelated hues implying unrelated things.
 */
const RAMP: Record<ExamStatus, string> = {
  draft:     "bg-line-strong",
  scheduled: "bg-primary-200",
  ongoing:   "bg-primary-400",
  completed: "bg-primary-600",
  published: "bg-primary-900",
  archived:  "bg-gray-300",
};

const SEGMENTS = EXAM_STATUSES.map((key) => ({
  key,
  labelKey: EXAM_STATUS_META[key].labelKey,
  bar:      RAMP[key],
  dot:      RAMP[key],
}));

export default function ExamStatusChart({ stats }: Props) {
  const { t } = useTranslation();
  const total = stats.total ?? 0;
  const hasAnyExams = total > 0;
  // Shares of the counted statuses, adding to 100 — never 99 or 101.
  const values = SEGMENTS.map((seg) => stats[seg.key] ?? 0);
  const pcts   = percentShares(values);

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
                style={{ width: `${(value / (values.reduce((a, b) => a + b, 0) || 1)) * 100}%` }}
                title={`${t(seg.labelKey)}: ${value}`}
              />
            );
          })}
      </div>

      {/* Legend — the numbers live here, where they can be read exactly */}
      <dl className="mt-4 space-y-0">
        {SEGMENTS.map((seg, i) => {
          const value = values[i];
          const pct   = pcts[i];

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
