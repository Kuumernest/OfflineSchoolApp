// web/src/pages/exams/annual-results/index.tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Loader2, ArrowLeft, Calculator, Send, Award, TrendingUp, Users, GraduationCap,
  AlertTriangle,
} from "lucide-react";
import {
  useAnnualResults,
  useComputeAnnualResults,
  usePublishAnnualResults,
} from "@/hooks/useExamResults";
import { useQuery } from "@tanstack/react-query";
import { useUser } from "@/store/auth.store";
import { fetchStaffClasses } from "@/services/insights.service";
import { cn } from "@/utils/cn";
import { DASH_TINT, type DashAccent } from "@/config/dashboardTint";
import { PageIcon } from "@/components/ui/PageHeader";
import { UnpublishButton } from "@/components/results/UnpublishButton";
import NeedsInternet from "@/components/offline/NeedsInternet";
import { useNeedsInternet } from "@/hooks/useNeedsInternet";
import { useAcademicPeriods } from "@/hooks/useAcademicPeriods";
import type { AnnualResult } from "@/types/exam.types";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}/${CURRENT_YEAR}`,
  `${CURRENT_YEAR}/${CURRENT_YEAR + 1}`,
  `${CURRENT_YEAR + 1}/${CURRENT_YEAR + 2}`,
];

const PROMO_COLORS: Record<string, string> = {
  promoted:   "bg-success-soft text-success-text ring-1 ring-inset ring-success-line",
  repeated:   "bg-danger-soft text-danger-text ring-1 ring-inset ring-danger-line",
  conditional:"bg-warning-soft text-warning-text ring-1 ring-inset ring-warning-line",
  graduated:  "bg-accent-violet-soft text-accent-violet-deep ring-1 ring-inset ring-accent-violet/30",
  pending:    "bg-info-soft text-info-text ring-1 ring-inset ring-info-line",
};

// ─────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────

export default function AnnualResultsPage() {
  const { t } = useTranslation();

  const [academicYear, setAcademicYear] = useState(ACADEMIC_YEARS[1]);
  const [page, setPage] = useState(1);
  const [classId, setClassId] = useState("");

  // Who may do what here is the server's call (periodResultScope.js); the page
  // only avoids offering what it would refuse. A teacher reads the published
  // results of their classes and computes one class at a time; publishing is
  // an administrator's run. The class list is the teacher's roster or the
  // school's, as fetchStaffClasses decides — never all schools for an operator.
  const user      = useUser();
  const isAdmin   = user?.role === "super_admin" || user?.role === "school_admin";
  const needsClass = !isAdmin && !classId;
  // Computing and publishing run on the server: online-only on the desktop.
  const net = useNeedsInternet();
  const classesQ  = useQuery({
    queryKey: ["staff-classes", user?.role ?? "", user?.schoolId ?? ""],
    queryFn:  () => fetchStaffClasses(user),
    enabled:  !!user?.schoolId,
  });
  const classes = classesQ.data ?? [];

  const { data, isLoading } = useAnnualResults(academicYear, classId || undefined, page);
  // One column per term the year actually has (docs/39 Phase 6), not a fixed three.
  const periods = useAcademicPeriods(academicYear);
  const columnCount = 8 + periods.terms.length;
  const computeMutation = useComputeAnnualResults();
  const publishMutation = usePublishAnnualResults();

  const results: AnnualResult[] = data?.results ?? [];
  const total = data?.total ?? 0;
  /** How many stored annual results their TERM results have overtaken. */
  const staleCount = data?.staleCount ?? 0;
  const totalPages = data?.totalPages ?? 1;

  // Summary stats
  const avg = results.length
    ? (results.reduce((s, r) => s + r.annualAverage, 0) / results.length).toFixed(1)
    : "—";
  const passed = results.filter((r) => r.isPassing).length;
  const passRate = results.length ? ((passed / results.length) * 100).toFixed(0) : "—";
  const promoted = results.filter((r) => r.promotionStatus === "promoted").length;

  /*
   * `mutate`, not `await mutateAsync` — see the note on the term-results page.
   * mutateAsync rejects on failure regardless of onError, so the hook showed its
   * error toast and an unhandled rejection was raised alongside it.
   */
  const handleCompute = () => {
    if (needsClass) return;
    computeMutation.mutate({ academicYear, ...(classId ? { classId } : {}) });
  };

  const handlePublish = () => {
    publishMutation.mutate({ academicYear, ...(classId ? { classId } : {}) });
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/exams" className="rounded-lg p-2 hover:bg-accent-blue-soft transition">
            <ArrowLeft className="h-5 w-5 text-ink-body" />
          </Link>
          <PageIcon />
          <div>
            <h1 className="text-2xl font-bold text-ink">{t("annualResults.title")}</h1>
            <p className="text-sm text-ink-muted">{t("annualResults.description")}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-ink mb-1">
            {t("academicStructure.academicYear")}
          </label>
          <select
            value={academicYear}
            onChange={(e) => { setAcademicYear(e.target.value); setPage(1); }}
            className="rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
          >
            {ACADEMIC_YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1">
            {t("annualResults.className")}
          </label>
          <select
            value={classId}
            onChange={(e) => { setClassId(e.target.value); setPage(1); }}
            className="rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
          >
            <option value="">{t("annualResults.allClasses")}</option>
            {classes.map((c) => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleCompute}
          disabled={computeMutation.isPending || needsClass || net.blocked}
          title={needsClass ? t("annualResults.pickClassToCompute") : net.hint}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition",
            computeMutation.isPending || needsClass || net.blocked
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-primary-600 text-white hover:bg-primary-700"
          )}
        >
          {computeMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Calculator className="h-4 w-4" />
          )}
          {t("annualResults.compute")}
        </button>
        {isAdmin && <button
          onClick={handlePublish}
          title={net.hint}
          disabled={publishMutation.isPending || !results.length || net.blocked}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition",
            publishMutation.isPending || !results.length || net.blocked
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-emerald-600 text-white hover:bg-emerald-700"
          )}
        >
          {publishMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {t("annualResults.publish")}
        </button>}
        {/* One class at a time, with a reason (docs/41 §7). */}
        {isAdmin && <UnpublishButton
          layer="annual"
          classOptions={classes.map((c) => ({ id: String(c._id), name: c.name }))}
          classId={classId || undefined}
          academicYear={academicYear}
          disabled={!results.some((r) => r.isPublished) || net.blocked}
        />}
      </div>

      {/* Overtaken by the term results behind them.
          Stale against the TERMS, not the marks: an annual average is built
          from term averages, so a corrected mark makes the term stale first.
          Telling a school to redo the year when it needs to redo one term
          would send it to the wrong screen. */}
      <NeedsInternet />

      {staleCount > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200
                        bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              {t("annualResults.staleTitle", { count: staleCount })}
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              {t("annualResults.staleBody")}
            </p>
          </div>
          <button
            onClick={handleCompute}
            disabled={computeMutation.isPending || needsClass || net.blocked}
            className="shrink-0 rounded-xl bg-amber-600 px-3 py-1.5 text-xs
                       font-semibold text-white hover:bg-amber-700
                       disabled:opacity-50"
          >
            {t("annualResults.recompute")}
          </button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryCard icon={Users} accent="blue" label={t("annualResults.totalStudents")} value={String(total)} />
        <SummaryCard icon={TrendingUp} accent="slate" label={t("annualResults.schoolAverage")} value={avg} />
        <SummaryCard icon={Award} accent="green" label={t("annualResults.passed")} value={String(passed)} />
        <SummaryCard icon={Award} accent="slate" label={t("annualResults.passRate")} value={`${passRate}%`} />
        <SummaryCard icon={GraduationCap} accent="blue" label={t("annualResults.promoted")} value={String(promoted)} />
      </div>

      {/* Table */}
      <div className={cn("overflow-x-auto rounded-2xl border border-line bg-surface shadow-card", DASH_TINT.slate.edge)}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-xs font-medium uppercase tracking-wider text-ink-muted">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">{t("annualResults.studentName")}</th>
              <th className="px-4 py-3">{t("annualResults.admissionNo")}</th>
              <th className="px-4 py-3">{t("annualResults.className")}</th>
              {periods.terms.map((tm) => (
                <th key={tm.number} className="px-4 py-3 text-center">{tm.label}</th>
              ))}
              <th className="px-4 py-3 text-center">{t("annualResults.annualAverage")}</th>
              <th className="px-4 py-3 text-center">{t("results.remark")}</th>
              <th className="px-4 py-3 text-center">{t("annualResults.position")}</th>
              <th className="px-4 py-3 text-center">{t("annualResults.promotion")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {isLoading ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary-500" />
                </td>
              </tr>
            ) : results.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-12 text-center text-ink-muted">
                  {t("annualResults.noResults")}
                </td>
              </tr>
            ) : (
              results.map((r, idx) => {
                return (
                  <tr
                    key={r._id}
                    className={cn("transition",
                      r.isStale ? "bg-accent-amber-soft hover:bg-accent-amber-soft/70" : "hover:bg-accent-blue-soft/70")}
                  >
                    <td className="px-4 py-3 text-ink-muted">{(page - 1) * 50 + idx + 1}</td>
                    <td className="px-4 py-3 font-medium text-ink">
                      {r.studentName}
                      {r.isStale && (
                        <span
                          title={t("annualResults.staleRow")}
                          className="ml-2 inline-flex items-center rounded-full
                                     bg-amber-100 px-2 py-0.5 text-[10px]
                                     font-semibold text-amber-800"
                        >
                          {t("annualResults.staleTag")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{r.admissionNo}</td>
                    <td className="px-4 py-3 text-ink-muted">{r.className}</td>
                    {periods.terms.map((tm) => (
                      <td key={tm.number} className="px-4 py-3 text-center text-ink-body">
                        {r.termAverages?.find((ta) => ta.term === tm.number)?.average?.toFixed(1) ?? "—"}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-center font-semibold text-ink">
                      {r.annualAverage?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700">
                        {r.overallRemark ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-ink-body">
                      {r.classPosition ? `${r.classPosition}/${r.totalInClass}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                          PROMO_COLORS[r.promotionStatus] ?? PROMO_COLORS.pending
                        )}
                      >
                        {t(`annualResults.status_${r.promotionStatus}`)}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40"
          >
            {t("common.previous")}
          </button>
          <span className="text-sm text-gray-500">
            {t("pagination.pageOf", { current: page, total: totalPages })}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40"
          >
            {t("common.next")}
          </button>
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────

function SummaryCard({
  icon: Icon,
  accent,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  /** The figure's kind colour (config/dashboardTint.ts). */
  accent: DashAccent;
  label: string;
  value: string;
}) {
  const tint = DASH_TINT[accent];
  return (
    <div className={cn("flex items-center gap-3 p-4", tint.card)}>
      <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", tint.box)}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xs text-ink-muted">{label}</p>
        <p className={cn("text-lg font-bold", tint.number)}>{value}</p>
      </div>
    </div>
  );
}
