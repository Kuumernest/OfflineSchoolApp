// web/src/components/dashboard/SystemHealthGrid.tsx
import { useTranslation }         from "react-i18next";
import { type SystemHealthStats } from "@/services/dashboard.service";
import { Card, CardHeader }       from "@/components/ui/Card";
import {
  HEALTH_METRIC_ROWS,
  type HealthMetric,
} from "@/constants/dashboard.constants";
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
 * Now it is a quiet list where only a problem is coloured. If nothing is wrong,
 * nothing is red, and the panel reads as "fine" in one glance.
 */
export default function SystemHealthGrid({
  stats,
}: {
  stats: SystemHealthStats;
}) {
  const { t } = useTranslation();
  const s = stats as unknown as Record<string, number>;

  const problems = METRICS.filter(
    (m) => m.alertOnNonZero && (s[m.key] ?? 0) > 0
  );

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
                ? "bg-warning-soft text-warning ring-warning-line"
                : "bg-success-soft text-success ring-success-line"
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

      {/*
        Tiles, matching Quick actions, rather than a two-column list of rows.
        Fourteen metrics as ruled rows read as a spreadsheet; as tiles they read
        as a panel of readings — and a tile gives the problem state somewhere to
        live, since it can carry a tinted surface and border that a table row
        cannot without striping the whole grid.
      */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {METRICS.map((metric) => {
          const Icon    = metric.icon;
          const value   = s[metric.key] ?? 0;
          const isAlert = Boolean(metric.alertOnNonZero) && value > 0;

          return (
            <div
              key={metric.key}
              className={cn(
                "rounded-control border p-2.5 transition-colors",
                isAlert
                  ? "border-danger-line bg-danger-soft"
                  : "border-line bg-gradient-to-b from-surface to-[#fcfcfe]"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-control ring-1 ring-inset",
                    isAlert
                      ? "bg-surface text-danger ring-danger-line"
                      : "bg-canvas text-ink-muted ring-line"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>

                <p
                  className={cn(
                    "text-lg font-semibold leading-none tabular",
                    isAlert ? "text-danger" : "text-ink"
                  )}
                >
                  {value}
                </p>
              </div>

              <p
                className={cn(
                  "mt-2 truncate text-xs leading-tight",
                  isAlert ? "font-medium text-danger" : "text-ink-muted"
                )}
                title={t(`health.${metric.key}`, { defaultValue: metric.label })}
              >
                {t(`health.${metric.key}`, { defaultValue: metric.label })}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
