// web/src/components/dashboard/SystemHealthGrid.tsx
import { useTranslation }         from "react-i18next";
import { type SystemHealthStats } from "@/services/dashboard.service";
import { Card, CardHeader }       from "@/components/ui/Card";
import {
  HEALTH_METRIC_ROWS,
  type HealthMetric,
} from "@/constants/dashboard.constants";
import { SEMANTIC, type Semantic } from "@/config/sections";
import { ALERT_NUMBER, dashTint, healthLook } from "@/config/dashboardTint";
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
 * Each count takes its kind's tinted card (config/dashboardTint.ts) — the
 * same colour as that kind's headline card above, with a solid icon square. A
 * metric that is a problem only when non-zero keeps its kind's light tint and
 * a soft icon square in its own colour at every value — no tile is grey; only
 * its figure and border change, from navy at zero to amber above it (red for
 * a timetable conflict). Notices are informational and keep the info tint.
 * When nothing is wrong the header pill is the success tint.
 *
 * The tile colours are styling only: the header's count of faults is still
 * each metric's own `alert`, as before.
 */
export default function SystemHealthGrid({
  stats,
}: {
  stats: SystemHealthStats;
}) {
  const { t } = useTranslation();
  const s = stats as unknown as Record<string, number>;

  /** Whether a metric is a fault right now (the header's count), or null. */
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
          const look  = healthLook(metric, value);
          const sem   = look.kind === "status" ? SEMANTIC[look.status] : null;
          const tint  = dashTint(metric.tone);
          const alert = look.kind === "alert" ? look.level : null;
          const card   = sem ? sem.card
            : alert === "warning" ? tint.warnCard
            : alert === "error"   ? tint.errorCard
            : tint.card;
          const box    = sem ? sem.box  : alert ? tint.softBox : tint.box;
          const number = sem ? sem.text : alert ? ALERT_NUMBER[alert] : tint.number;

          return (
            <div
              key={metric.key}
              className={cn("p-4 transition-colors", card)}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-control",
                    box
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>

                <p className={cn("text-[28px] font-bold leading-none tabular", number)}>
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
                <p className={cn("text-xs", sem ? sem.text : "text-ink-muted")}>
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
