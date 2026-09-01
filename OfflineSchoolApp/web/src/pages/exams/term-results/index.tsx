// web/src/pages/exams/term-results/index.tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Loader2, ArrowLeft, Calculator, Send, ChevronDown, Award, TrendingUp, Users,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  useTermResults,
  useComputeTermResults,
  usePublishTermResults,
} from "@/hooks/useExamResults";
import { cn } from "@/utils/cn";
import type { TermResult, TermNumber } from "@/types/exam.types";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}/${CURRENT_YEAR}`,
  `${CURRENT_YEAR}/${CURRENT_YEAR + 1}`,
  `${CURRENT_YEAR + 1}/${CURRENT_YEAR + 2}`,
];

const TERMS: { value: TermNumber; labelKey: string }[] = [
  { value: 1, labelKey: "academicStructure.term" + " 1" },
  { value: 2, labelKey: "academicStructure.term" + " 2" },
  { value: 3, labelKey: "academicStructure.term" + " 3" },
];

// ─────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────

export default function TermResultsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [academicYear, setAcademicYear] = useState(ACADEMIC_YEARS[1]);
  const [term, setTerm] = useState<TermNumber>(1);
  const [page, setPage] = useState(1);

  const { data, isLoading } = useTermResults(academicYear, term, undefined, page);
  const computeMutation = useComputeTermResults();
  const publishMutation = usePublishTermResults();

  const results: TermResult[] = data?.results ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  // Summary stats
  const avg = results.length
    ? (results.reduce((s, r) => s + r.termAverage, 0) / results.length).toFixed(1)
    : "—";
  const passed = results.filter((r) => r.isPassing).length;
  const passRate = results.length ? ((passed / results.length) * 100).toFixed(0) : "—";

  const handleCompute = async () => {
    await computeMutation.mutateAsync({ academicYear, term });
  };

  const handlePublish = async () => {
    await publishMutation.mutateAsync({ academicYear, term });
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/exams" className="rounded-lg p-2 hover:bg-gray-100 transition">
            <ArrowLeft className="h-5 w-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t("termResults.title")}</h1>
            <p className="text-sm text-gray-500">{t("termResults.description")}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("academicStructure.academicYear")}
          </label>
          <select
            value={academicYear}
            onChange={(e) => { setAcademicYear(e.target.value); setPage(1); }}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          >
            {ACADEMIC_YEARS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("academicStructure.term")}
          </label>
          <select
            value={term}
            onChange={(e) => { setTerm(Number(e.target.value) as TermNumber); setPage(1); }}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          >
            {TERMS.map((te) => (
              <option key={te.value} value={te.value}>
                {t("academicStructure.term")} {te.value}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleCompute}
          disabled={computeMutation.isPending}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition",
            computeMutation.isPending
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-indigo-600 text-white hover:bg-indigo-700"
          )}
        >
          {computeMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Calculator className="h-4 w-4" />
          )}
          {t("termResults.compute")}
        </button>
        <button
          onClick={handlePublish}
          disabled={publishMutation.isPending || !results.length}
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition",
            publishMutation.isPending || !results.length
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-emerald-600 text-white hover:bg-emerald-700"
          )}
        >
          {publishMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {t("termResults.publish")}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard icon={Users} label={t("termResults.totalStudents")} value={String(total)} />
        <SummaryCard icon={TrendingUp} label={t("termResults.classAverage")} value={avg} />
        <SummaryCard icon={Award} label={t("termResults.passed")} value={String(passed)} />
        <SummaryCard icon={Award} label={t("termResults.passRate")} value={`${passRate}%`} />
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">{t("termResults.studentName")}</th>
              <th className="px-4 py-3">{t("termResults.admissionNo")}</th>
              <th className="px-4 py-3">{t("termResults.className")}</th>
              <th className="px-4 py-3 text-center">{t("termResults.seq1Avg")}</th>
              <th className="px-4 py-3 text-center">{t("termResults.seq2Avg")}</th>
              <th className="px-4 py-3 text-center">{t("termResults.termAverage")}</th>
              <th className="px-4 py-3 text-center">{t("termResults.grade")}</th>
              <th className="px-4 py-3 text-center">{t("termResults.position")}</th>
              <th className="px-4 py-3 text-center">{t("termResults.status")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-indigo-500" />
                </td>
              </tr>
            ) : results.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                  {t("termResults.noResults")}
                </td>
              </tr>
            ) : (
              results.map((r, idx) => {
                const seq1 = r.sequenceAverages?.find((s) => s.sequence === ((r.term - 1) * 2 + 1));
                const seq2 = r.sequenceAverages?.find((s) => s.sequence === ((r.term - 1) * 2 + 2));
                return (
                  <tr key={r._id} className="hover:bg-gray-50 transition">
                    <td className="px-4 py-3 text-gray-500">{(page - 1) * 50 + idx + 1}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.studentName}</td>
                    <td className="px-4 py-3 text-gray-500">{r.admissionNo}</td>
                    <td className="px-4 py-3 text-gray-500">{r.className}</td>
                    <td className="px-4 py-3 text-center text-gray-700">
                      {seq1?.average?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-700">
                      {seq2?.average?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center font-semibold text-gray-900">
                      {r.termAverage?.toFixed(1) ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        {r.overallGrade ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-gray-700">
                      {r.classPosition ? `${r.classPosition}/${r.totalInClass}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          r.isPassing
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-red-50 text-red-700"
                        )}
                      >
                        {r.isPassing ? t("termResults.pass") : t("termResults.fail")}
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
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50">
        <Icon className="h-5 w-5 text-indigo-600" />
      </div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-lg font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
}
