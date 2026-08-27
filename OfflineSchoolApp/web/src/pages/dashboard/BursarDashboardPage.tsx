// web/src/pages/dashboard/BursarDashboardPage.tsx
//
// The dashboard a bursar opens on.
//
// Deliberately not the admin dashboard with the academic tiles removed. That
// page answers "how is the school doing" — enrolment, exams, attendance,
// pending admissions — and every one of its queries reads an endpoint a bursar
// is refused, so for them it renders as eight failed requests. This page
// answers a different question: what is owed, what came in, what went out.
//
// ── The numbers, and which kind each one is ────────────────────────────────
//
// Two kinds of figure sit on this page and they must not be added together.
//
//   A POSITION is true as of now: expected, collected, outstanding. A fee
//   raised in October is still owed in March, so these are never clipped to a
//   date range. They come from the `arrears` half of the finance report, which
//   ignores from/to for exactly that reason.
//
//   A FLOW happened during an interval: today's collections, today's spending.
//   These come from the `summary` half, over a one-day range.
//
// One request covers both, because /finance/reports/summary answers with the
// two in separate objects — the flow bounded by from/to, the position not.
//
// ── What is deliberately absent ───────────────────────────────────────────
//
// "Recent payments" is not here. There is no endpoint that lists payments
// across the school — the fee ledger answers per student, and the school-wide
// view exists only as a spreadsheet (Exports → Payments). Today's total is
// shown instead, which is the figure a bursar reconciles the cash drawer
// against at closing time.
//
// "Pending approvals" WAS absent for a better reason, and now is not. It used
// to be that nothing in this system required approval: an expense was written
// the moment it was recorded and a payroll run was confirmed by whoever
// generated it, so a tile reading "0" would have claimed the school had nothing
// waiting when the truth was that it could not queue anything at all.
//
// That state now exists, so the tile does. It renders only for a school that has
// actually turned a threshold on — a permanent "0 waiting" in a school that has
// not asked for approvals is the same empty claim in a different costume.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Wallet, TrendingDown, TrendingUp, Users, ArrowRight,
  CalendarClock, Receipt, AlertCircle,
} from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { PageSpinner } from "@/components/ui/Spinner";
import StatCard        from "@/components/dashboard/StatCard";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }   from "@/i18n/format";
import { cn }          from "@/utils/cn";

import { fetchReport, fetchExpenses, fetchRuns } from "@/services/finance.service";
import { fetchOutstanding } from "@/services/fee.service";
import { fetchApprovalSummary } from "@/services/approval.service";

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Cameroonian school years run September–July. */
const currentAcademicYear = () => {
  const now   = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

/** How many arrears rows to show before sending the reader to the full list. */
const ARREARS_PREVIEW = 6;
const RECENT_EXPENSES = 5;

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

/** A panel heading with an optional "see all" link on the right. */
function PanelHeader({
  title,
  to,
  linkLabel,
}: {
  title:      string;
  to?:        string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {to && (
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
        >
          {linkLabel}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function BursarDashboardPage() {
  const { t }  = useTranslation();
  const user   = useUser();
  const fmt    = useFormat();
  const schoolId = user?.schoolId ?? "";

  const year  = useMemo(() => currentAcademicYear(), []);
  const today = useMemo(() => iso(new Date()), []);

  // One call, both kinds of number: `summary` bounded to today, `arrears`
  // unbounded by design. See the note at the top of the file.
  const reportQ = useQuery({
    queryKey: ["finance", "report", schoolId, today, year],
    queryFn:  () => fetchReport(schoolId, { from: today, to: today, academicYear: year }),
    enabled:  Boolean(schoolId),
  });

  const arrearsQ = useQuery({
    queryKey: ["fees", "outstanding", schoolId, year],
    queryFn:  () => fetchOutstanding(schoolId, year),
    enabled:  Boolean(schoolId),
  });

  const expensesQ = useQuery({
    queryKey: ["finance", "expenses", schoolId, "recent"],
    queryFn:  () => fetchExpenses(schoolId, {}),
    enabled:  Boolean(schoolId),
  });

  const payrollQ = useQuery({
    queryKey: ["finance", "payroll", schoolId],
    queryFn:  () => fetchRuns(schoolId),
    enabled:  Boolean(schoolId),
  });

  const approvalsQ = useQuery({
    queryKey: ["approvals", "summary", schoolId],
    queryFn:  () => fetchApprovalSummary(schoolId),
    enabled:  Boolean(schoolId),
  });

  if (!schoolId) {
    return <ErrorBanner message={t("bursarDashboard.noSchool")} />;
  }

  // The four tiles are the point of the page, so it waits for the one request
  // that fills them. Everything below streams in on its own.
  if (reportQ.isLoading) return <PageSpinner />;

  const arrears = reportQ.data?.arrears;
  const flow    = reportQ.data?.summary;

  const owingCount = arrearsQ.data?.count ?? 0;

  // Voided rows stay in the list and out of every total, so they are dropped
  // here too — a voided expense in a "most recent" panel reads as money spent.
  const recentExpenses = (expensesQ.data?.rows ?? [])
    .filter((e) => !e.voidedAt)
    .slice(0, RECENT_EXPENSES);

  const lastRun = (payrollQ.data ?? [])[0] ?? null;

  const topArrears = (arrearsQ.data?.rows ?? []).slice(0, ARREARS_PREVIEW);

  // Whether this school has asked for approvals at all. Any threshold set, or
  // payroll approval switched on, is enough — the tile is about the workflow
  // existing here, not about which part of it is in use.
  const thresholds     = approvalsQ.data?.thresholds;
  const approvalsInUse = Boolean(
    thresholds && (
      thresholds.expenseThreshold !== null ||
      thresholds.refundThreshold  !== null ||
      thresholds.waiverThreshold  !== null ||
      thresholds.payrollRequired
    )
  );
  const pendingApprovals = approvalsQ.data?.pending ?? 0;
  const myPending        = approvalsQ.data?.mine ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("bursarDashboard.title")}
        description={t("bursarDashboard.subtitle")}
        meta={<span>{t("bursarDashboard.academicYear", { year })}</span>}
      />

      {reportQ.isError && <ErrorBanner message={t("bursarDashboard.reportFailed")} />}

      {/* ── The position: what the year says as of now ──────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t("bursarDashboard.expected")}
          value={fmt.money(arrears?.billed ?? 0)}
          subtitle={t("bursarDashboard.expectedNote")}
          icon={Wallet}
        />
        <StatCard
          title={t("bursarDashboard.collected")}
          value={fmt.money(arrears?.paid ?? 0)}
          /*
            Null rather than 0% when nothing has been billed — the API is
            explicit that 0% would be a lie rather than a fact, and a school
            that has not raised its fees yet has not failed to collect them.
          */
          subtitle={
            arrears?.collectionRate == null
              ? t("bursarDashboard.rateUnknown")
              : t("bursarDashboard.rate", { rate: arrears.collectionRate })
          }
          icon={TrendingUp}
        />
        <StatCard
          title={t("bursarDashboard.outstanding")}
          value={fmt.money(arrears?.outstanding ?? 0)}
          subtitle={t("bursarDashboard.owingStudents", { count: owingCount })}
          subtitleColor={
            (arrears?.outstanding ?? 0) > 0 ? "text-warning" : undefined
          }
          icon={TrendingDown}
          href="/fees"
        />
        <StatCard
          title={t("bursarDashboard.waived")}
          value={fmt.money(arrears?.waived ?? 0)}
          subtitle={t("bursarDashboard.waivedNote")}
          icon={Users}
        />
      </div>

      {/* ── Waiting for a signature ────────────────────────────────────────
          Between the year's position and today's movements, because that is
          where it belongs in a bursar's morning: what have I asked for, and has
          anybody looked at it. Absent entirely in a school with no thresholds
          set — see the note at the top of the file. */}
      {approvalsInUse && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                {t("bursarDashboard.approvalsTitle")}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className={cn(
                    "font-display text-[22px] leading-tight",
                    pendingApprovals > 0 ? "text-warning" : "text-ink"
                  )}
                >
                  {pendingApprovals}
                </span>
                <span className="text-sm text-ink-muted">
                  {t("bursarDashboard.approvalsWaiting")}
                </span>
              </div>

              {/*
                Said separately because it is the useful half for a bursar: of
                everything waiting, these are the ones they raised and therefore
                cannot decide. A single total would leave them wondering whether
                the queue was theirs to clear.
              */}
              {myPending > 0 && (
                <div className="mt-0.5 text-xs text-ink-faint">
                  {t("bursarDashboard.approvalsMine", { total: myPending })}
                </div>
              )}
            </div>

            <Link
              to="/approvals"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
            >
              {t("bursarDashboard.openApprovals")}
              <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
        </Card>
      )}

      {/* ── The flow: today only ───────────────────────────────────────────
          Captioned as today rather than left to the reader to infer. The tiles
          above and the tiles here look alike and mean entirely different
          things, which is precisely the confusion worth spending a line on. */}
      <Card>
        <PanelHeader
          title={t("bursarDashboard.todayTitle")}
          to="/finance/reports"
          linkLabel={t("bursarDashboard.fullReport")}
        />
        <p className="mt-1 text-xs text-ink-faint">
          {t("bursarDashboard.todayNote")}
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              {t("bursarDashboard.collectedToday")}
            </div>
            <div className="mt-1 font-display text-[22px] leading-tight text-ink">
              {fmt.money(flow?.income.total ?? 0)}
            </div>
            <div className="mt-0.5 text-xs text-ink-muted">
              {t("bursarDashboard.payments", { count: flow?.income.count ?? 0 })}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              {t("bursarDashboard.spentToday")}
            </div>
            <div className="mt-1 font-display text-[22px] leading-tight text-ink">
              {fmt.money(flow?.expenditure.total ?? 0)}
            </div>
            <div className="mt-0.5 text-xs text-ink-muted">
              {t("bursarDashboard.spentBreakdown", {
                expenses: fmt.money(flow?.expenditure.expenses ?? 0),
                payroll:  fmt.money(flow?.expenditure.payroll ?? 0),
              })}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              {t("bursarDashboard.netToday")}
            </div>
            <div
              className={cn(
                "mt-1 font-display text-[22px] leading-tight",
                (flow?.net ?? 0) < 0 ? "text-danger" : "text-ink"
              )}
            >
              {fmt.money(flow?.net ?? 0)}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">

        {/* ── Who owes ─────────────────────────────────────────────────── */}
        <Card>
          <PanelHeader
            title={t("bursarDashboard.arrearsTitle")}
            to="/fees"
            linkLabel={t("bursarDashboard.seeAll", { total: owingCount })}
          />

          <div className="mt-3">
            {topArrears.length === 0 ? (
              <EmptyTable
                title={
                  arrearsQ.isLoading
                    ? t("bursarDashboard.loading")
                    : t("bursarDashboard.nobodyOwes")
                }
              />
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t("bursarDashboard.student")}</Th>
                    <Th numeric>{t("bursarDashboard.owed")}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {topArrears.map((row) => (
                    <Tr key={row.studentId}>
                      <Td>
                        {/*
                          Links into the ledger rather than the student record:
                          a bursar clicking a name in an arrears list wants the
                          account, and /students is admin-only anyway.
                        */}
                        <Link
                          to={`/fees/students/${row.studentId}`}
                          className="font-medium text-ink hover:text-primary-700"
                        >
                          {row.name}
                        </Link>
                        {row.enrollmentNo && (
                          <span className="ml-2 text-xs text-ink-faint">
                            {row.enrollmentNo}
                          </span>
                        )}
                      </Td>
                      <Td numeric className="font-medium text-warning">
                        {fmt.money(row.balance)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        </Card>

        {/* ── What went out ────────────────────────────────────────────── */}
        <Card>
          <PanelHeader
            title={t("bursarDashboard.expensesTitle")}
            to="/finance/expenses"
            linkLabel={t("bursarDashboard.recordExpense")}
          />

          <div className="mt-3">
            {recentExpenses.length === 0 ? (
              <EmptyTable
                title={
                  expensesQ.isLoading
                    ? t("bursarDashboard.loading")
                    : t("bursarDashboard.noExpenses")
                }
              />
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t("bursarDashboard.description")}</Th>
                    <Th numeric>{t("bursarDashboard.amount")}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {recentExpenses.map((e) => (
                    <Tr key={e._id}>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Receipt className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                          <span className="truncate">
                            {e.description || e.vendor || t("bursarDashboard.untitledExpense")}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-faint">
                          {fmt.dateShort(e.incurredAt)}
                        </div>
                      </Td>
                      <Td numeric className="font-medium">{fmt.money(e.amount)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        </Card>
      </div>

      {/* ── Payroll ──────────────────────────────────────────────────────
          One line, not a panel. What a bursar needs at a glance is whether the
          current month has been run and confirmed; the detail is one click
          away and does not belong on a dashboard. */}
      <Card>
        <PanelHeader
          title={t("bursarDashboard.payrollTitle")}
          to="/finance/payroll"
          linkLabel={t("bursarDashboard.openPayroll")}
        />

        {lastRun ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="inline-flex items-center gap-2 text-ink">
              <CalendarClock className="h-4 w-4 text-ink-faint" aria-hidden="true" />
              {fmt.monthLabel(lastRun.periodMonth)}
            </span>
            <span className="text-ink-muted">
              {t("bursarDashboard.staffCount", { count: lastRun.staffCount })}
            </span>
            <span className="font-medium text-ink">
              {fmt.money(lastRun.totalNet)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                lastRun.status === "confirmed"
                  ? "bg-success-soft text-success"
                  : lastRun.status === "reversed"
                    ? "bg-danger-soft text-danger"
                    : "bg-warning-soft text-warning"
              )}
            >
              {t(`bursarDashboard.runStatus.${lastRun.status}`)}
            </span>
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            {payrollQ.isLoading
              ? t("bursarDashboard.loading")
              : t("bursarDashboard.noPayroll")}
          </p>
        )}
      </Card>
    </div>
  );
}
