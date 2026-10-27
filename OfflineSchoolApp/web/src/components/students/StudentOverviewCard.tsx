// web/src/components/students/StudentOverviewCard.tsx
//
// The student profile's summary (C10): latest published results, the last
// month's attendance, this year's fee balance and the guardian's contact —
// what the office is asked about a pupil, without opening four screens.
// Every figure is computed on the server by the function that owns it (see
// backend/src/services/studentOverview.service.js).

import { useQuery }       from "@tanstack/react-query";
import { Link }           from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BarChart3, CalendarCheck, Wallet, Phone, Mail, Users } from "lucide-react";

import { useFormat }      from "@/i18n/format";
import { cn }             from "@/utils/cn";
import { fetchStudentOverview } from "@/services/student.service";

function Panel({ icon: Icon, title, children, action }: {
  icon: typeof BarChart3; title: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-gray-900">
          <Icon className="h-4 w-4 text-gray-400" aria-hidden />
          {title}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export function StudentOverviewCard({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const q = useQuery({
    queryKey: ["studentOverview", studentId],
    queryFn:  () => fetchStudentOverview(studentId),
    enabled:  !!studentId,
  });

  if (q.isLoading) {
    return (
      <div className="grid gap-6 lg:grid-cols-2" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-2xl border border-gray-200 bg-gray-50" />
        ))}
      </div>
    );
  }
  if (q.isError || !q.data) {
    return <p className="text-sm text-gray-500">{t("studentOverview.unavailable")}</p>;
  }

  const { results, attendance, fees, guardian } = q.data;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ── Results ── */}
      <Panel icon={BarChart3} title={t("studentOverview.results")}>
        {results.length === 0 ? (
          <p className="text-sm text-gray-500">{t("studentOverview.noResults")}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {results.map((r) => (
              <li key={r.examId} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate text-gray-700">{r.examName ?? "—"}</span>
                <span className="flex shrink-0 items-center gap-3 tabular-nums">
                  {r.position != null && r.outOf != null && (
                    <span className="text-xs text-gray-500">
                      {t("studentOverview.position", { position: r.position, outOf: r.outOf })}
                    </span>
                  )}
                  <span className={cn("font-semibold",
                    r.passed === false ? "text-red-600" : r.passed ? "text-green-700" : "text-gray-500")}>
                    {r.average != null ? `${fmt.decimal(r.average, 2)}/20` : "—"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ── Attendance ── */}
      <Panel icon={CalendarCheck} title={t("studentOverview.attendance", { days: attendance.days })}>
        <p className="text-2xl font-bold tabular-nums text-gray-900">
          {attendance.rate != null ? `${fmt.decimal(attendance.rate, 1)}%` : "–"}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          {attendance.marked
            ? t("studentOverview.attendanceBreakdown", attendance)
            : t("studentOverview.notMarked")}
        </p>
      </Panel>

      {/* ── Fees ── (absent for a reader without fees.view) */}
      {fees && (
        <Panel icon={Wallet} title={t("studentOverview.fees", { year: fees.academicYear })}
          action={
            <Link to={`/fees/students/${studentId}?year=${encodeURIComponent(fees.academicYear)}`}
              className="text-xs font-semibold text-primary-600 hover:underline">
              {t("studentOverview.openAccount")}
            </Link>
          }>
          <p className={cn("text-2xl font-bold tabular-nums",
            fees.balance > 0 ? "text-red-600" : "text-green-700")}>
            {fees.balance > 0 ? fmt.money(fees.balance) : t("studentOverview.settled")}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {t("studentOverview.feesBreakdown", { charged: fmt.money(fees.charged), paid: fmt.money(fees.paid) })}
          </p>
        </Panel>
      )}

      {/* ── Guardian ── */}
      <Panel icon={Users} title={t("studentOverview.guardian")}>
        {!guardian.name && !guardian.phone && !guardian.email ? (
          <p className="text-sm text-gray-500">{t("studentOverview.noGuardian")}</p>
        ) : (
          <div className="flex flex-col gap-1.5 text-sm">
            {guardian.name && <span className="font-medium text-gray-900">{guardian.name}</span>}
            {guardian.phone && (
              <a href={`tel:${guardian.phone}`} className="flex items-center gap-2 text-primary-600 hover:underline">
                <Phone className="h-3.5 w-3.5" aria-hidden />{guardian.phone}
              </a>
            )}
            {guardian.email && (
              <a href={`mailto:${guardian.email}`} className="flex items-center gap-2 text-primary-600 hover:underline">
                <Mail className="h-3.5 w-3.5" aria-hidden />{guardian.email}
              </a>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
