// web/src/components/dashboard/AttendanceWidget.tsx
import { CheckSquare, XCircle, TrendingUp } from "lucide-react";

interface Props {
  present:  number;
  absent:   number;
  rate:     number;   // 0–100
  loading?: boolean;
}

export default function AttendanceWidget({
  present,
  absent,
  rate,
  loading = false,
}: Props) {
  const total = present + absent;

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200
                  dark:border-gray-700 shadow-sm p-6 flex flex-col gap-4"
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          Today's Attendance
        </h3>

        <span
          className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
            rate >= 75
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          }`}
        >
          {rate}% rate
        </span>
      </div>

      {/* ── Body ── */}
      {loading ? (
        <div className="h-28 flex items-center justify-center text-gray-400 text-sm">
          Loading…
        </div>
      ) : (
        <>
          {/* Progress bar */}
          <div className="w-full bg-gray-100 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
            <div
              className={`h-3 rounded-full transition-all duration-700 ${
                rate >= 75 ? "bg-green-500" : "bg-red-500"
              }`}
              style={{ width: `${Math.min(rate, 100)}%` }}
            />
          </div>

          {/* Present / Absent cards */}
          <div className="grid grid-cols-2 gap-3">
            {/* Present */}
            <div
              className="flex items-center gap-3 bg-green-50 dark:bg-green-900/20
                          rounded-xl p-3"
            >
              <CheckSquare className="h-5 w-5 text-green-600 shrink-0" />
              <div>
                <p className="text-xl font-bold text-green-700 dark:text-green-400 leading-tight">
                  {present}
                </p>
                <p className="text-xs text-green-600 dark:text-green-500">
                  Present
                </p>
              </div>
            </div>

            {/* Absent */}
            <div
              className="flex items-center gap-3 bg-red-50 dark:bg-red-900/20
                          rounded-xl p-3"
            >
              <XCircle className="h-5 w-5 text-red-600 shrink-0" />
              <div>
                <p className="text-xl font-bold text-red-700 dark:text-red-400 leading-tight">
                  {absent}
                </p>
                <p className="text-xs text-red-600 dark:text-red-500">
                  Absent
                </p>
              </div>
            </div>
          </div>

          {/* Total */}
          <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 shrink-0" />
            {total > 0
              ? `${total} attendance record${total !== 1 ? "s" : ""} taken today`
              : "No attendance records for today yet"}
          </p>
        </>
      )}
    </div>
  );
}