// web/src/components/dashboard/SystemHealthGrid.tsx
import { type SystemHealthStats } from "@/services/dashboard.service";
import {
  HEALTH_METRIC_ROWS,
  type HealthMetric,
} from "@/constants/dashboard.constants";

// Flatten the grouped rows into one responsive grid.
// This keeps the same metric order while allowing larger desktop tiles.
const METRICS: HealthMetric[] = HEALTH_METRIC_ROWS.reduce<HealthMetric[]>(
  (acc, row) => acc.concat(row),
  []
);

export default function SystemHealthGrid({
  stats,
}: {
  stats: SystemHealthStats;
}) {
  const s = stats as unknown as Record<string, number>;

  return (
    <div
      className="
        rounded-xl border border-gray-200 dark:border-gray-700
        bg-white dark:bg-gray-800
        p-5 shadow-sm
      "
    >
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
        System Health
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-3">
        {METRICS.map((metric) => {
          const Icon    = metric.icon;
          const value   = s[metric.key] ?? 0;
          const isAlert = !!metric.alertOnNonZero && value > 0;

          return (
            <div
              key={metric.key}
              className={`
                min-h-[96px] md:min-h-[110px]
                rounded-xl p-4 md:p-5
                flex flex-col items-center justify-center
                text-center gap-2
                ${
                  isAlert
                    ? "bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200 dark:ring-red-800"
                    : "bg-gray-50 dark:bg-gray-700/40"
                }
              `}
            >
              <Icon
                className="h-5 w-5 md:h-6 md:w-6 shrink-0"
                style={{ color: metric.color }}
                aria-hidden="true"
              />

              <span
                className={`text-2xl md:text-3xl font-bold tabular-nums leading-none ${
                  isAlert
                    ? "text-red-600 dark:text-red-400"
                    : "text-gray-900 dark:text-white"
                }`}
              >
                {value}
              </span>

              <span className="text-xs md:text-sm text-gray-500 dark:text-gray-400 leading-tight">
                {metric.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}