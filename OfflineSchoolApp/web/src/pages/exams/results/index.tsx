// web/src/pages/exams/results/index.tsx
import { useState, useMemo }          from "react";
import { useSearchParams, Link }      from "react-router-dom";
import { useExams }                   from "@/hooks/useExams";
import { useTranslation } from "react-i18next";
import {
  useExamStats,
  useRankings,
}                                     from "@/hooks/useExamResults";
import {
  EXAM_STATUS_META,
  examTypeLabel,
}                                     from "@/constants/exam.constants";
import type {
  Exam,
  ResultSummary,
  SubjectStat,
}                                     from "@/types/exam.types";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

type RankScope = "class" | "grade" | "school";

interface Stats {
  totalStudents:     number;
  passed:            number;
  failed:            number;
  average:           number;
  highest:           number;
  lowest:            number;
  passRate:          number;
  averageGpa:        number;
  gradeDistribution: Record<string, number>;
  subjectStats:      SubjectStat[];
}

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const GRADE_COLORS: Record<string, string> = {
  "A+": "bg-emerald-500",
  "A":  "bg-emerald-400",
  "B+": "bg-blue-500",
  "B":  "bg-blue-400",
  "C+": "bg-yellow-500",
  "C":  "bg-yellow-400",
  "D":  "bg-orange-500",
  "E":  "bg-red-400",
  "F":  "bg-red-600",
};

// `key` is the scope sent to the rankings endpoint — it must not change.
// Module scope has no `t`, so the label is stored as a key and resolved
// at render time.
const RANK_SCOPES: { key: RankScope; labelKey: string }[] = [
  { key: "class",  labelKey: "results.scopeClass"  },
  { key: "grade",  labelKey: "results.scopeGrade"  },
  { key: "school", labelKey: "results.scopeSchool" },
];

const RANKINGS_TITLE_KEYS: Record<RankScope, string> = {
  class:  "results.rankingsClass",
  grade:  "results.rankingsGrade",
  school: "results.rankingsSchool",
};

const SECTION_LABEL_KEYS = {
  overview: "nav.overview",
  rankings: "results.rankings",
  subjects: "results.subjectAnalysis",
} as const;

// ─────────────────────────────────────────────────────────
// SMALL SHARED COMPONENTS
// ─────────────────────────────────────────────────────────

const Spinner = () => (
  <div className="w-6 h-6 border-4 border-primary-600
                  border-t-transparent rounded-full animate-spin" />
);

const EmptyState = ({
  icon, title, subtitle,
}: {
  icon: string; title: string; subtitle?: string;
}) => (
  <div className="flex flex-col items-center justify-center
                  py-20 text-center text-gray-400">
    <span className="text-5xl mb-3">{icon}</span>
    <p className="font-semibold text-gray-600 text-lg">{title}</p>
    {subtitle && <p className="text-sm mt-1 max-w-sm">{subtitle}</p>}
  </div>
);

// ─────────────────────────────────────────────────────────
// EXAM PICKER
// ─────────────────────────────────────────────────────────

const ExamPicker = ({
  exams,
  selectedId,
  onSelect,
}: {
  exams:      Exam[];
  selectedId: string | null;
  onSelect:   (id: string) => void;
}) => {
  const { t } = useTranslation();
  return <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
    <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
      <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">
        {t("results.selectExam")}
      </p>
    </div>

    {exams.length === 0 ? (
      <div className="px-4 py-8 text-center text-sm text-gray-400">
        {t("results.noneCompleted")}
      </div>
    ) : (
      <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
        {exams.map((exam) => {
          const meta     = EXAM_STATUS_META[exam.status] ?? EXAM_STATUS_META.draft;
          const isActive = selectedId === exam._id;
          return (
            <button
              key={exam._id}
              onClick={() => onSelect(exam._id)}
              className={`w-full text-left px-4 py-3 flex items-start
                gap-3 transition-colors
                ${isActive
                  ? "bg-primary-50 border-l-4 border-primary-600"
                  : "hover:bg-gray-50 border-l-4 border-transparent"
                }`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold truncate
                  ${isActive ? "text-primary-700" : "text-gray-900"}`}>
                  {exam.name}
                </p>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  {examTypeLabel(t, exam.type)}
                  {exam.term         ? ` · ${exam.term}`         : ""}
                  {exam.academicYear ? ` · ${exam.academicYear}` : ""}
                </p>
                {exam.classNames && (
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {exam.classNames}
                  </p>
                )}
              </div>
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full
                shrink-0 mt-0.5 ${meta.color} ${meta.bg}`}>
                {t(meta.labelKey)}
              </span>
            </button>
          );
        })}
      </div>
    )}
  </div>;
};

// ─────────────────────────────────────────────────────────
// STATS OVERVIEW — 8 metric cards
// ─────────────────────────────────────────────────────────

const StatsOverview = ({ stats }: { stats: Stats }) => {
  const { t } = useTranslation();
  const cards = [
    { id: "students", label: t("academic.student_other"), value: stats.totalStudents,             color: "text-primary-600", bg: "bg-primary-50"  },
    { id: "passed",   label: t("results.passed"),         value: stats.passed,                    color: "text-green-600",   bg: "bg-green-50"    },
    { id: "failed",   label: t("results.failed"),         value: stats.failed,                    color: "text-red-600",     bg: "bg-red-50"      },
    { id: "passRate", label: t("exams.passRate"),         value: `${stats.passRate.toFixed(1)}%`, color: "text-amber-600",   bg: "bg-amber-50"    },
    { id: "average",  label: t("academic.average"),       value: `${stats.average.toFixed(1)}%`,  color: "text-indigo-600",  bg: "bg-indigo-50"   },
    { id: "highest",  label: t("results.highest"),        value: `${stats.highest}%`,             color: "text-emerald-600", bg: "bg-emerald-50"  },
    { id: "lowest",   label: t("results.lowest"),         value: `${stats.lowest}%`,              color: "text-rose-600",    bg: "bg-rose-50"     },
    { id: "gpa",      label: t("results.avgGpa"),         value: stats.averageGpa.toFixed(2),     color: "text-purple-600",  bg: "bg-purple-50"   },
  ];

  return (
    <div className="grid grid-cols-4 md:grid-cols-8 gap-3">
      {cards.map((c) => (
        <div key={c.id}
             className={`rounded-xl border border-gray-100 p-3 text-center ${c.bg}`}>
          <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
          <p className="text-xs text-gray-500 font-medium mt-0.5">{c.label}</p>
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// PASS / FAIL DONUT (CSS-only)
// ─────────────────────────────────────────────────────────

const PassFailDonut = ({
  passed, failed, total,
}: {
  passed: number; failed: number; total: number;
}) => {
  const { t } = useTranslation();
  const passAngle = total > 0 ? Math.round((passed / total) * 360) : 0;

  return (
    <div className="flex items-center gap-6">
      {/* Donut via conic-gradient */}
      <div
        className="w-24 h-24 rounded-full shrink-0"
        style={{
          background: `conic-gradient(
            #22c55e 0deg ${passAngle}deg,
            #ef4444 ${passAngle}deg 360deg
          )`,
        }}
      >
        <div className="w-24 h-24 rounded-full flex items-center
                        justify-center bg-white m-0"
             style={{ margin: "12px", width: "calc(100% - 24px)",
                      height: "calc(100% - 24px)" }}>
          <div className="text-center">
            <p className="text-sm font-bold text-gray-900">
              {total > 0 ? Math.round((passed / total) * 100) : 0}%
            </p>
            <p className="text-xs text-gray-400">{t("examCreate.pass")}</p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-green-500 shrink-0" />
          <span className="text-sm text-gray-700">
            {t("results.passed")} — <strong>{passed}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-red-500 shrink-0" />
          <span className="text-sm text-gray-700">
            {t("results.failed")} — <strong>{failed}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-gray-300 shrink-0" />
          <span className="text-sm text-gray-700">
            {t("common.total")} — <strong>{total}</strong>
          </span>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// SCORE DISTRIBUTION BAR
// Shows a horizontal bar broken into pass/fail zones
// ─────────────────────────────────────────────────────────

const ScoreDistributionBar = ({
  average, highest, lowest,
}: {
  average: number; highest: number; lowest: number;
}) => {
  const { t } = useTranslation();
  return <div className="space-y-3">
    {[
      { id: "highest", label: t("results.highest"),  value: highest, color: "bg-emerald-500" },
      { id: "average", label: t("academic.average"), value: average, color: "bg-indigo-500"  },
      { id: "lowest",  label: t("results.lowest"),   value: lowest,  color: "bg-red-500"     },
    ].map(({ id, label, value, color }) => (
      <div key={id} className="flex items-center gap-3">
        <span className="w-14 text-xs text-gray-500 text-right">{label}</span>
        <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full ${color} rounded-full transition-all`}
            style={{ width: `${Math.min(value, 100)}%` }}
          />
        </div>
        <span className="w-10 text-xs font-bold text-gray-700 text-right">
          {value.toFixed(1)}%
        </span>
      </div>
    ))}
  </div>;
};

// ─────────────────────────────────────────────────────────
// GRADE DISTRIBUTION CHART
// ─────────────────────────────────────────────────────────

const GradeDistributionChart = ({
  distribution,
  total,
}: {
  distribution: Record<string, number>;
  total:        number;
}) => {
  const { t } = useTranslation();
  const entries = Object.entries(distribution)
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-400 text-center py-6">
        {t("results.noGradeData")}
      </p>
    );
  }

  const maxCount = Math.max(...entries.map(([, n]) => n));

  return (
    <div className="space-y-2.5">
      {entries.map(([grade, count]) => {
        const pct      = total > 0 ? Math.round((count / total) * 100) : 0;
        const barColor = GRADE_COLORS[grade] ?? "bg-gray-400";
        const barWidth = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;

        return (
          <div key={grade} className="flex items-center gap-3">
            {/* Grade label */}
            <span className="w-8 text-sm font-bold text-gray-700 text-right">
              {grade}
            </span>

            {/* Bar */}
            <div className="flex-1 h-7 bg-gray-100 rounded-lg overflow-hidden
                            relative">
              <div
                className={`h-full ${barColor} rounded-lg flex items-center
                            justify-end pr-2 transition-all`}
                style={{ width: `${Math.max(barWidth, 3)}%` }}
              >
                {pct > 15 && (
                  <span className="text-white text-xs font-bold">{pct}%</span>
                )}
              </div>
            </div>

            {/* Count */}
            <span className="w-8 text-sm text-gray-500 font-medium">
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// SUBJECT PERFORMANCE TABLE
// ─────────────────────────────────────────────────────────

const SubjectPerformanceTable = ({
  subjects,
}: {
  subjects: SubjectStat[];
}) => {
  const { t } = useTranslation();
  if (subjects.length === 0) {
    return (
      <p className="text-sm text-gray-400 text-center py-6">
        {t("results.noBreakdown")}
      </p>
    );
  }

  // Sort by average descending
  const sorted = [...subjects].sort((a, b) => b.average - a.average);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs font-bold text-gray-500
                          uppercase tracking-wide">
          <tr>
            <th className="px-4 py-2.5 text-left">{t("academic.subject")}</th>
            <th className="px-4 py-2.5 text-right">{t("academic.average")}</th>
            <th className="px-4 py-2.5 text-right">{t("results.highest")}</th>
            <th className="px-4 py-2.5 text-right">{t("results.lowest")}</th>
            <th className="px-4 py-2.5 text-right">{t("exams.passRate")}</th>
            <th className="px-4 py-2.5 text-right">{t("academic.student_other")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map((s) => {
            const passColor = s.passRate >= 70
              ? "text-green-600"
              : s.passRate >= 50
                ? "text-amber-600"
                : "text-red-600";

            return (
              <tr key={s.subjectId}
                  className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-2.5 font-medium text-gray-900">
                  {s.subjectName}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold text-indigo-600">
                  {s.average.toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-right text-emerald-600 font-semibold">
                  {s.highest.toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-right text-red-500 font-semibold">
                  {s.lowest.toFixed(1)}%
                </td>
                <td className={`px-4 py-2.5 text-right font-bold ${passColor}`}>
                  {s.passRate.toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-right text-gray-500">
                  {s.total}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// RANKINGS TABLE
// ─────────────────────────────────────────────────────────

const RankingsTable = ({
  examId,
  scope,
}: {
  examId: string;
  scope:  RankScope;
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { data, isLoading } = useRankings(examId, scope);
  const rankings: ResultSummary[] = data?.data ?? [];

  const posField: keyof ResultSummary =
    scope === "school" ? "schoolPosition" :
    scope === "grade"  ? "gradePosition"  :
                         "classPosition";

  const totalField: keyof ResultSummary =
    scope === "school" ? "totalInSchool" :
    scope === "grade"  ? "totalInGrade"  :
                         "totalInClass";

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return rankings;
    return rankings.filter(
      (r) =>
        r.studentName?.toLowerCase().includes(q) ||
        r.admissionNo?.toLowerCase().includes(q)  ||
        r.className?.toLowerCase().includes(q)
    );
  }, [rankings, search]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (rankings.length === 0) {
    return (
      <EmptyState
        icon="🏆"
        title={t("results.noRankings")}
        subtitle={t("results.processFirst")}
      />
    );
  }

  return (
    <div>
      {/* Search */}
      <div className="p-4 border-b border-gray-100">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("results.searchPh")}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg
                     text-sm focus:outline-none focus:ring-2
                     focus:ring-primary-400"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-bold text-gray-500
                            uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">{t("results.pos")}</th>
              <th className="px-4 py-3 text-left">{t("academic.student")}</th>
              <th className="px-4 py-3 text-left">{t("academic.class")}</th>
              <th className="px-4 py-3 text-right">{t("academic.score")}</th>
              <th className="px-4 py-3 text-right">%</th>
              <th className="px-4 py-3 text-center">{t("academic.grade")}</th>
              <th className="px-4 py-3 text-center">GPA</th>
              <th className="px-4 py-3 text-center">{t("academic.subject_other")}</th>
              <th className="px-4 py-3 text-center">{t("common.status")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map((r, idx) => {
              const pos     = (r[posField] as number | null) ?? idx + 1;
              const total   = (r[totalField] as number | null) ?? rankings.length;
              const passing = r.isPassing;
              const color   = passing ? "text-green-600" : "text-red-600";
              const medal   =
                pos === 1 ? "🥇" :
                pos === 2 ? "🥈" :
                pos === 3 ? "🥉" : null;

              return (
                <tr key={r._id || r.studentId}
                    className="hover:bg-gray-50 transition-colors">

                  {/* Position */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {medal ? (
                        <span className="text-lg">{medal}</span>
                      ) : (
                        <span className="font-bold text-gray-500">
                          #{pos}
                        </span>
                      )}
                      {total > 0 && (
                        <span className="text-xs text-gray-300">
                          /{total}
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Student */}
                  <td className="px-4 py-3">
                    <p className="font-semibold text-gray-900">
                      {r.studentName || t("results.unknownStudent")}
                    </p>
                    {r.admissionNo && (
                      <p className="text-xs text-gray-400">
                        #{r.admissionNo}
                      </p>
                    )}
                  </td>

                  {/* Class */}
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {r.className || "—"}
                  </td>

                  {/* Score */}
                  <td className="px-4 py-3 text-right font-semibold text-gray-700">
                    {r.totalScore}/{r.maxTotalScore}
                  </td>

                  {/* Percentage */}
                  <td className={`px-4 py-3 text-right font-bold ${color}`}>
                    {r.percentage?.toFixed(1)}%
                  </td>

                  {/* Grade */}
                  <td className={`px-4 py-3 text-center font-bold ${color}`}>
                    {r.overallGrade || "—"}
                  </td>

                  {/* GPA */}
                  <td className="px-4 py-3 text-center text-gray-500">
                    {r.gpa != null ? r.gpa.toFixed(2) : "—"}
                  </td>

                  {/* Subjects passed/total */}
                  <td className="px-4 py-3 text-center text-xs text-gray-500">
                    <span className="text-green-600 font-semibold">
                      {r.subjectsPassed}
                    </span>
                    <span className="text-gray-300 mx-0.5">/</span>
                    <span>{r.subjectsTotal}</span>
                  </td>

                  {/* Pass/Fail badge */}
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex px-2 py-0.5 rounded-full
                      text-xs font-bold
                      ${passing
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                      }`}>
                      {passing ? t("results.pass") : t("results.fail")}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 && search && (
          <div className="text-center py-8 text-sm text-gray-400">
            {t("results.noStudentsMatch", { query: search })}
          </div>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// SUBJECT BREAKDOWN PANEL
// Shows per-student subject scores from subjectBreakdown[]
// Opened when user clicks a student row (future enhancement)
// ─────────────────────────────────────────────────────────

const TopBottomStudents = ({
  rankings,
  n = 5,
}: {
  rankings: ResultSummary[];
  n?:       number;
}) => {
  const { t } = useTranslation();
  if (rankings.length === 0) return null;

  const sorted  = [...rankings].sort((a, b) => b.percentage - a.percentage);
  const top     = sorted.slice(0, n);
  const bottom  = sorted.slice(-n).reverse();

  const Row = ({ r, rank }: { r: ResultSummary; rank: number }) => (
    <div className="flex items-center gap-3 py-2 border-b
                    border-gray-50 last:border-0">
      <span className="w-6 text-sm font-bold text-gray-400 text-center">
        {rank}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">
          {r.studentName || t("results.unknownStudent")}
        </p>
        <p className="text-xs text-gray-400 truncate">
          {r.className || "—"}
          {r.admissionNo ? ` · #${r.admissionNo}` : ""}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-sm font-bold
          ${r.isPassing ? "text-green-600" : "text-red-600"}`}>
          {r.percentage?.toFixed(1)}%
        </p>
        <p className="text-xs text-gray-400">{r.overallGrade || "—"}</p>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Top performers */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🏆</span>
          <h3 className="font-semibold text-gray-900 text-sm">
            {t("results.topStudents", { count: n })}
          </h3>
        </div>
        {top.map((r, i) => (
          <Row key={r.studentId} r={r} rank={i + 1} />
        ))}
      </div>

      {/* Bottom performers — need attention */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">📌</span>
          <h3 className="font-semibold text-gray-900 text-sm">
            {t("results.needsAttention", { count: n })}
          </h3>
        </div>
        {bottom.map((r, i) => (
          <Row key={r.studentId} r={r} rank={rankings.length - n + i + 1} />
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function ExamResultsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedExamId, setSelectedExamId] = useState<string | null>(
    searchParams.get("examId") ?? null
  );
  const [rankScope, setRankScope] = useState<RankScope>("class");
  const [activeSection, setActiveSection] = useState<
    "overview" | "rankings" | "subjects"
  >("overview");

  // Data fetching
  const { data: examsData } = useExams();
  const { data: statsData, isLoading: statsLoading } = useExamStats(
    selectedExamId ?? ""
  );
  const { data: rankingsData } = useRankings(selectedExamId ?? "", rankScope);

  const completedExams = useMemo(
    () =>
      (examsData?.exams ?? []).filter(
        (e) => e.status === "completed" || e.status === "published"
      ),
    [examsData]
  );

  const stats: Stats | null    = statsData?.data ?? null;
  const rankings: ResultSummary[] = rankingsData?.data ?? [];

  const selectedExam = completedExams.find((e) => e._id === selectedExamId);

  const handleSelectExam = (id: string) => {
    setSelectedExamId(id);
    setSearchParams({ examId: id });
    setActiveSection("overview");
  };

  // ── Render ────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t("results.analytics")}
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            {t("results.selectCompletedExam")}
          </p>
        </div>
        <Link
          to="/reports/cards"
          className="px-4 py-2 bg-green-600 text-white rounded-xl
                     text-sm font-semibold hover:bg-green-700
                     transition-colors"
        >
          🖨️ {t("reportCards.title")}
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6
                      items-start">

        {/* Left — Exam picker */}
        <div className="space-y-3">
          <ExamPicker
            exams={completedExams}
            selectedId={selectedExamId}
            onSelect={handleSelectExam}
          />
          <p className="text-xs text-gray-400 text-center">
            {t("results.onlyCompleted")}
          </p>
        </div>

        {/* Right — Results panel */}
        <div className="space-y-5">
          {!selectedExamId ? (
            <div className="bg-white rounded-xl border border-gray-100">
              <EmptyState
                icon="📊"
                title={t("results.selectToView")}
                subtitle={t("results.chooseExam")}
              />
            </div>
          ) : statsLoading ? (
            <div className="flex justify-center py-20">
              <Spinner />
            </div>
          ) : !stats || stats.totalStudents === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100">
              <EmptyState
                icon="🧮"
                title={t("results.none")}
                subtitle={t("results.processFromDetail")}
              />
              {selectedExamId && (
                <div className="flex justify-center pb-8">
                  <Link
                    to={`/exams/${selectedExamId}?tab=results`}
                    className="px-4 py-2 bg-primary-600 text-white
                               rounded-xl text-sm font-semibold
                               hover:bg-primary-700 transition-colors"
                  >
                    → {t("results.goToResultsTab")}
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Exam title bar */}
              {selectedExam && (
                <div className="bg-white rounded-xl border border-gray-100
                                px-5 py-4 flex items-center justify-between">
                  <div>
                    <h2 className="font-bold text-gray-900 text-lg">
                      {selectedExam.name}
                    </h2>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {examTypeLabel(t, selectedExam.type)}
                      {selectedExam.term         ? ` · ${selectedExam.term}`         : ""}
                      {selectedExam.academicYear ? ` · ${selectedExam.academicYear}` : ""}
                      {selectedExam.classNames   ? ` · ${selectedExam.classNames}`   : ""}
                    </p>
                  </div>
                  <Link
                    to={`/exams/${selectedExamId}`}
                    className="text-xs font-semibold text-primary-600
                               hover:text-primary-700"
                  >
                    {t("results.manageExam")} →
                  </Link>
                </div>
              )}

              {/* Section tabs */}
              <div className="flex border-b border-gray-200 bg-white
                              rounded-t-xl overflow-hidden">
                {(["overview", "rankings", "subjects"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setActiveSection(s)}
                    className={`px-5 py-3 text-sm font-semibold
                      transition-colors
                      ${activeSection === s
                        ? "text-primary-600 border-b-2 border-primary-600"
                        : "text-gray-500 hover:text-gray-700"
                      }`}
                  >
                    {t(SECTION_LABEL_KEYS[s])}
                  </button>
                ))}
              </div>

              {/* ── OVERVIEW SECTION ── */}
              {activeSection === "overview" && (
                <div className="space-y-5">

                  {/* 8 stat cards */}
                  <StatsOverview stats={stats} />

                  {/* Pass/fail + score distribution */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white rounded-xl border border-gray-100 p-5">
                      <h3 className="font-semibold text-gray-900 mb-4 text-sm">
                        {t("results.passFailSplit")}
                      </h3>
                      <PassFailDonut
                        passed={stats.passed}
                        failed={stats.failed}
                        total={stats.totalStudents}
                      />
                    </div>

                    <div className="bg-white rounded-xl border border-gray-100 p-5">
                      <h3 className="font-semibold text-gray-900 mb-4 text-sm">
                        {t("results.scoreDistribution")}
                      </h3>
                      <ScoreDistributionBar
                        average={stats.average}
                        highest={stats.highest}
                        lowest={stats.lowest}
                      />
                    </div>
                  </div>

                  {/* Grade distribution */}
                  <div className="bg-white rounded-xl border border-gray-100 p-5">
                    <h3 className="font-semibold text-gray-900 mb-4 text-sm">
                      {t("results.gradeDistribution")}
                    </h3>
                    <GradeDistributionChart
                      distribution={stats.gradeDistribution}
                      total={stats.totalStudents}
                    />
                  </div>

                  {/* Top / Bottom students */}
                  <TopBottomStudents rankings={rankings} n={5} />
                </div>
              )}

              {/* ── RANKINGS SECTION ── */}
              {activeSection === "rankings" && (
                <div className="space-y-4">

                  {/* Scope selector */}
                  <div className="bg-white rounded-xl border border-gray-100 p-4
                                  flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-700">
                      {t("results.rankBy")}
                    </p>
                    <div className="flex gap-1">
                      {RANK_SCOPES.map((s) => (
                        <button
                          key={s.key}
                          onClick={() => setRankScope(s.key)}
                          className={`px-3 py-1.5 rounded-lg text-xs
                            font-semibold transition-colors
                            ${rankScope === s.key
                              ? "bg-primary-600 text-white"
                              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                        >
                          {t(s.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Table */}
                  <div className="bg-white rounded-xl border border-gray-100
                                  overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100
                                    flex items-center justify-between">
                      <h3 className="font-semibold text-gray-900 text-sm">
                        {t(RANKINGS_TITLE_KEYS[rankScope])}
                        <span className="ml-2 text-xs text-gray-400 font-normal">
                          {t("results.studentCount", { count: rankings.length })}
                        </span>
                      </h3>
                    </div>
                    <RankingsTable
                      examId={selectedExamId}
                      scope={rankScope}
                    />
                  </div>
                </div>
              )}

              {/* ── SUBJECT ANALYSIS SECTION ── */}
              {activeSection === "subjects" && (
                <div className="space-y-4">
                  <div className="bg-white rounded-xl border border-gray-100
                                  overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100">
                      <h3 className="font-semibold text-gray-900 text-sm">
                        {t("results.bySubject")}
                        <span className="ml-2 text-xs text-gray-400 font-normal">
                          {t("results.subjectCount", { count: stats.subjectStats.length })}
                        </span>
                      </h3>
                    </div>
                    <SubjectPerformanceTable subjects={stats.subjectStats} />
                  </div>

                  {/* Subject pass rate bars */}
                  {stats.subjectStats.length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-100 p-5">
                      <h3 className="font-semibold text-gray-900 text-sm mb-4">
                        {t("results.subjectPassRates")}
                      </h3>
                      <div className="space-y-3">
                        {[...stats.subjectStats]
                          .sort((a, b) => b.passRate - a.passRate)
                          .map((s) => {
                            const color =
                              s.passRate >= 70 ? "bg-green-500" :
                              s.passRate >= 50 ? "bg-amber-500" :
                                                 "bg-red-500";
                            return (
                              <div key={s.subjectId}
                                   className="flex items-center gap-3">
                                <span className="w-28 text-xs text-gray-600
                                                 truncate text-right">
                                  {s.subjectName}
                                </span>
                                <div className="flex-1 h-5 bg-gray-100
                                                rounded-full overflow-hidden">
                                  <div
                                    className={`h-full ${color} rounded-full
                                                flex items-center justify-end
                                                pr-2 transition-all`}
                                    style={{
                                      width: `${Math.max(s.passRate, 3)}%`
                                    }}
                                  >
                                    {s.passRate > 20 && (
                                      <span className="text-white text-xs
                                                       font-bold">
                                        {s.passRate.toFixed(0)}%
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <span className="w-10 text-xs text-gray-500
                                                 text-right">
                                  {s.total}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}