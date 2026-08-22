// web/src/components/dashboard/AttendanceWidget.tsx
import { useTranslation }   from "react-i18next";
import { Card, CardHeader } from "@/components/ui/Card";
import { useFormat }        from "@/i18n/format";
import { cn }               from "@/utils/cn";

interface Props {
  present:  number;
  absent:   number;
  rate:     number;   // 0–100
  loading?: boolean;
}

/**
 * Today's attendance.
 *
 * The rate is the headline and the bar is the only coloured element — present
 * and absent are figures, not alarms, so they are set in ink rather than in
 * matching green and red boxes competing with the bar for the same message.
 */
export default function AttendanceWidget({
  present,
  absent,
  rate,
  loading = false,
}: Props) {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const total = present + absent;
  const healthy = rate >= 75;
  const pct = Math.max(0, Math.min(rate, 100));

  return (
    <Card>
      <CardHeader title={t("dashboard.attendanceToday")} />

      {loading ? (
        <div className="space-y-3">
          <div className="h-8 w-24 animate-pulse rounded-control bg-canvas" />
          <div className="h-1.5 w-full animate-pulse rounded-full bg-canvas" />
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-[30px] leading-none text-ink tabular">
              {fmt.number(rate)}%
            </span>
            <span className="text-xs text-ink-muted">{t("dashboard.presentShort")}</span>
          </div>

          <div
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-canvas"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Attendance rate"
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                healthy ? "bg-success" : "bg-warning"
              )}
              style={{ width: `${pct}%` }}
            />
          </div>

          <dl className="mt-4 flex items-center gap-6">
            <div>
              <dt className="text-xs text-ink-muted">{t("academic.present")}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink tabular">
                {fmt.number(present)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">{t("academic.absent")}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-ink tabular">
                {fmt.number(absent)}
              </dd>
            </div>
          </dl>

          <p className="mt-4 border-t border-line pt-3 text-xs text-ink-faint">
            {total > 0
              ? t("dashboard.recordsToday", { count: total })
              : t("dashboard.noAttendanceYet")}
          </p>
        </>
      )}
    </Card>
  );
}
