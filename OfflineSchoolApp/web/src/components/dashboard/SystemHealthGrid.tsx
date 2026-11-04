// web/src/components/dashboard/SystemHealthGrid.tsx
import { useTranslation }         from "react-i18next";
import { type SystemHealthStats } from "@/services/dashboard.service";
import { Card, CardHeader }       from "@/components/ui/Card";
import {
  HEALTH_METRIC_ROWS,
  type HealthMetric,
} from "@/constants/dashboard.constants";
import { CARD_SHELL, SEMANTIC, iconBox, type Semantic } from "@/config/sections";
import { cn } from "@/utils/cn";

// Flatten the grouped rows into one list; the grid handles wrapping.
const METRICS: HealthMetric[] = HEALTH_METRIC_ROWS.flat();

/**
 * Setup completeness at a glance.
 *
 * This was fourteen 110px tiles, each with a coloured icon and a 30px number —
 * a wall that took as much vertical space as the rest of the dashboard and
 * gave every metric equal weight, so the two that actually needed action (a
 * timetable conflict, an unassigned teacher) were invisible among the twelve
 * that were merely counts.
 *
 * Each reading is a white card with an accented icon box, so a count reads
 * as a count. A metric that is a problem only when non-zero stays white at
 * zero and takes a status tint above it: pending applications the warning
 * tint, a missing teacher, timetable gap or conflict the error tint. Notices
 * are informational and always take the info tint. When nothing is wrong the
 * header pill is the success tint.
 */
export default function SystemHealthGrid({
  stats,
}: {
  stats: SystemHealthStats;
}) {
  const { t } = useTranslation();
  const s = stats as unknown as Record<string, number>;

  /** The status tint a metric takes right now, or null for a white card. */
  const toneOf = (m: HealthMetric): Semantic | null => {
    if (m.alertOnNonZero) return (s[m.key] ?? 0) > 0 ? (m.alert ?? "error") : null;
    return m.semantic ?? null;
  };

  // Faults only. Pending applications are a queue to work through, not a
  // setup fault, so they tint their own card but do not turn the panel's
  // "healthy" pill into "action needed" — the same count as before.
  const problems = METRICS.filter((m) => toneOf(m) === "error");

  return (
    <Card>
      <CardHeader
        title={t("dashboard.setupHealth")}
        subtitle={
          problems.length
            ? t("dashboard.itemsNeedAttention", { count: problems.length })
            : t("dashboard.healthy")
        }
        action={
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-control px-2 py-0.5",
              "text-xs font-medium ring-1 ring-inset",
              problems.length
                ? "bg-warning-soft text-warning-text ring-warning-line"
                : "bg-success-soft text-success-text ring-success-line"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                problems.length ? "bg-warning" : "bg-success"
              )}
              aria-hidden="true"
            />
            {problems.length ? t("dashboard.actionNeeded") : t("dashboard.healthy")}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {METRICS.map((metric) => {
          const Icon  = metric.icon;
          const value = s[metric.key] ?? 0;
          const tone  = toneOf(metric);
          const sem   = tone ? SEMANTIC[tone] : null;

          return (
            <div
              key={metric.key}
              className={cn("p-4 transition-colors", sem ? sem.card : CARD_SHELL)}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-control",
                    sem ? sem.box : iconBox(metric.tone)
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>

                <p className={cn("text-[28px] font-bold leading-none tabular", sem ? sem.text : "text-ink")}>
                  {value}
                </p>
              </div>

              <p
                className={cn("mt-3 text-sm font-medium leading-snug", sem ? sem.text : "text-ink-muted")}
                title={t(`health.${metric.key}`, { defaultValue: metric.label })}
              >
                {t(`health.${metric.key}`, { defaultValue: metric.label })}
              </p>
              {/* B4: the pairs, then how many distinct subjects they are. */}
              {metric.key === "totalSubjects" && stats.distinctSubjects != null && (
                <p className={cn("text-xs", sem ? sem.text : "text-ink-faint")}>
                  {t("health.distinctSubjects", { count: stats.distinctSubjects })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
