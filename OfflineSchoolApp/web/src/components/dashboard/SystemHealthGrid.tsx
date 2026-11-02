// web/src/components/dashboard/SystemHealthGrid.tsx
import { useTranslation }         from "react-i18next";
import { type SystemHealthStats } from "@/services/dashboard.service";
import { Card, CardHeader }       from "@/components/ui/Card";
import {
  HEALTH_METRIC_ROWS,
  type HealthMetric,
} from "@/constants/dashboard.constants";
import { TILE_TONE } from "@/config/sections";
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
 * Each reading is a tile in the colour of what it counts — people teal, the
 * timetable olive, subjects terracotta — the same colours as the stat row and
 * the quick actions, so the panel is a map of the school rather than a wall
 * of grey. A problem leaves the palette altogether: it turns into the pale
 * danger tile with red text, so "needs action" is never confused with "this
 * is about the timetable". If nothing is wrong, nothing is red.
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {METRICS.map((metric) => {
          const Icon    = metric.icon;
          const value   = s[metric.key] ?? 0;
          const isAlert = Boolean(metric.alertOnNonZero) && value > 0;

          return (
            <div
              key={metric.key}
              className={cn(
                "rounded-tile p-4 transition-colors",
                isAlert
                  ? "border border-danger-line bg-danger-soft text-danger"
                  : cn(TILE_TONE[metric.tone].fill, "shadow-tile")
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-control",
                    isAlert
                      ? "bg-surface ring-1 ring-inset ring-danger-line"
                      : TILE_TONE[metric.tone].well
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>

                <p className="text-[28px] font-bold leading-none tabular">
                  {value}
                </p>
              </div>

              <p
                className="mt-3 text-sm font-medium leading-snug"
                title={t(`health.${metric.key}`, { defaultValue: metric.label })}
              >
                {t(`health.${metric.key}`, { defaultValue: metric.label })}
              </p>
              {/* B4: the pairs, then how many distinct subjects they are. */}
              {metric.key === "totalSubjects" && stats.distinctSubjects != null && (
                <p className="text-xs">
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
