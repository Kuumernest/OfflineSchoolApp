// web/src/pages/exams/results/index.tsx
import { useState, useMemo }          from "react";
import { useSearchParams, Link }      from "react-router-dom";
import { useExams }                   from "@/hooks/useExams";
import { useUser }                    from "@/store/auth.store";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
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
import { Trophy, BarChart3, Calculator, Pin, Printer, PieChart, Layers, ListOrdered, BookOpen, Percent, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageIcon } from "@/components/ui/PageHeader";
import { cn } from "@/utils/cn";
import { type DashAccent } from "@/config/dashboardTint";
import { DASH_TINT } from "@/config/dashboardTint";
import { resultsScope, type ClassOption } from "@/utils/resultsScope";

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
  passMark?:         number;
  /** Pupils per band of the school's remark scale, highest band first. */
  remarkDistribution?: RemarkBand[];
  subjectStats:      SubjectStat[];
  /** The classes this exam has results in, for the class filter. */
  classes?:          { classId: string; className: string | null }[];
  /** The chosen class's best and weakest pupils; null with no class chosen. */
  topBottom?:        { top: PlacedPupil[]; bottom: PlacedPupil[]; total: number } | null;
}

/** A pupil in a class's top or bottom list, numbered by class position. */
interface PlacedPupil {
  position:    number;
  studentId:   string;
  studentName: string | null;
  admissionNo: string | null;
  className:   string | null;
  average20:   number | null;
  remark:      string | null;
  remarkFr:    string | null;
  passes:      boolean | null;
}

interface RemarkBand {
  remark:   string | null;
  remarkFr: string | null;
  minMark:  number;
  maxMark:  number;
  count:    number;
}

/** A ranking row's remark in the reader's language. */
const remarkText = (r: ResultSummary) =>
  (i18next.language?.startsWith("fr") ? r.remarkFr : r.remark) ?? r.remark ?? null;

/** A mark out of twenty, as every analytics figure is printed. */
const on20 = (v: number | null | undefined) => (v == null ? "—" : `${Number(v).toFixed(2)}/20`);

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

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

/** A small solid icon square in front of a panel's heading. */
const HeadBox = ({ icon: Icon, accent = "slate" }: { icon: LucideIcon; accent?: DashAccent }) => (
  <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT[accent].box)} aria-hidden="true">
    <Icon className="h-4 w-4" />
  </span>
);

const EmptyState = ({
  icon, title, subtitle,
}: {
  icon: LucideIcon; title: string; subtitle?: string;
}) => {
  const Icon = icon;
  return (
  <div className="flex flex-col items-center justify-center
                  py-20 text-center text-ink-muted">
    <div className={cn("mb-3 flex h-12 w-12 items-center justify-center rounded-card", DASH_TINT.slate.box)} aria-hidden="true">
      <Icon className="w-6 h-6" aria-hidden />
    </div>
    <p className="font-semibold text-ink text-lg">{title}</p>
    {subtitle && <p className="text-sm mt-1 max-w-sm">{subtitle}</p>}
  </div>
  );
};

// ─────────────────────────────────────────────────────────
// EXAM PICKER
// ─────────────────────────────────────────────────────────

const ExamPicker = ({
  exams,
  loading = false,
  selectedId,
  onSelect,
}: {
  exams:      Exam[];
  /** C2: while the exams load, a spinner — not "no completed exams". */
  loading?:   boolean;
  selectedId: string | null;
  onSelect:   (id: string) => void;
}) => {
  const { t } = useTranslation();
  return <div className={cn("bg-surface rounded-xl border border-line overflow-hidden", DASH_TINT.slate.edge)}>
    <div className="px-4 py-3 bg-accent-slate-soft border-b border-line">
      <p className="text-xs font-bold text-accent-slate-deep uppercase tracking-wide">
        {t("results.selectExam")}
      </p>
    </div>

    {loading ? (
      <div className="flex justify-center py-8"><Spinner /></div>
    ) : exams.length === 0 ? (
      <div className="px-4 py-8 text-center text-sm text-ink-muted">
        {t("results.noneCompleted")}
      </div>
    ) : (
      <div className="max-h-80 overflow-y-auto divide-y divide-line">
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
                  : "hover:bg-accent-blue-soft/70 border-l-4 border-transparent"
                }`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold truncate
                  ${isActive ? "text-primary-700" : "text-ink"}`}>
                  {exam.name}
                </p>
                <p className="text-xs text-ink-muted mt-0.5 truncate">
                  {examTypeLabel(t, exam.type)}
                  {exam.term         ? ` · ${exam.term}`         : ""}
                  {exam.academicYear ? ` · ${exam.academicYear}` : ""}
                </p>
                {exam.classNames && (
                  <p className="text-xs text-ink-muted truncate mt-0.5">
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
    // Tinted cards (config/dashboardTint.ts): the kind's wash and top edge,
    // the figure in its deep shade.
    { id: "students", label: t("academic.student_other"), value: stats.totalStudents,             tint: DASH_TINT.blue  },
    { id: "passed",   label: t("results.passed"),         value: stats.passed,                    tint: DASH_TINT.green },
    { id: "failed",   label: t("results.failed"),         value: stats.failed,                    tint: DASH_TINT.red   },
    { id: "passRate", label: t("exams.passRate"),         value: `${stats.passRate.toFixed(1)}%`, tint: DASH_TINT.slate },
    { id: "average",  label: t("academic.average"),       value: on20(stats.average),             tint: DASH_TINT.amber },
    { id: "highest",  label: t("results.highest"),        value: on20(stats.highest),             tint: DASH_TINT.green },
    { id: "lowest",   label: t("results.lowest"),         value: on20(stats.lowest),              tint: DASH_TINT.red   },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3">
      {cards.map((c) => (
        <div key={c.id}
             className={`p-3 text-center ${c.tint.card}`}>
          <p className={`text-xl font-bold ${c.tint.number}`}>{c.value}</p>
          <p className="text-xs text-ink-muted font-medium mt-0.5">{c.label}</p>
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
            <p className="text-sm font-bold text-ink">
              {total > 0 ? Math.round((passed / total) * 100) : 0}%
            </p>
            <p className="text-xs text-ink-muted">{t("examCreate.pass")}</p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-green-500 shrink-0" />
          <span className="text-sm text-ink">
            {t("results.passed")} — <strong>{passed}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-red-500 shrink-0" />
          <span className="text-sm text-ink">
            {t("results.failed")} — <strong>{failed}</strong>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-accent-slate shrink-0" />
          <span className="text-sm text-ink">
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
      { id: "average", label: t("academic.average"), value: average, color: "bg-primary-500"  },
      { id: "lowest",  label: t("results.lowest"),   value: lowest,  color: "bg-red-500"     },
    ].map(({ id, label, value, color }) => (
      <div key={id} className="flex items-center gap-3">
        <span className="w-14 text-xs text-ink-muted text-right">{label}</span>
        <div className="flex-1 h-4 bg-accent-slate-soft rounded-full overflow-hidden">
          <div
            className={`h-full ${color} rounded-full transition-all`}
            style={{ width: `${Math.min((value / 20) * 100, 100)}%` }}
          />
        </div>
        <span className="w-16 text-xs font-bold text-ink text-right">
          {on20(value)}
        </span>
      </div>
    ))}
  </div>;
};

// ─────────────────────────────────────────────────────────
// GRADE DISTRIBUTION CHART
// ─────────────────────────────────────────────────────────

const RemarkDistributionChart = ({
  bands,
  total,
}: {
  bands: RemarkBand[];
  total: number;
}) => {
  const { t, i18n } = useTranslation();
  if (bands.every((b) => b.count === 0)) {
    return (
      <p className="text-sm text-ink-muted text-center py-6">
        {t("results.noGradeData")}
      </p>
    );
  }

  const maxCount = Math.max(...bands.map((b) => b.count));
  // Highest band first, shaded from strong to weak; the server sends them in
  // the school's own order.
  const SHADES = ["bg-emerald-500", "bg-emerald-400", "bg-blue-500", "bg-blue-400",
                  "bg-yellow-500", "bg-yellow-400", "bg-orange-500", "bg-red-500", "bg-red-600"];

  return (
    <div className="space-y-2.5">
      {bands.map((b, i) => {
        const pct      = total > 0 ? Math.round((b.count / total) * 100) : 0;
        const barWidth = maxCount > 0 ? Math.round((b.count / maxCount) * 100) : 0;
        const label    = (i18n.language?.startsWith("fr") ? b.remarkFr : b.remark) || b.remark || "—";
        return (
          <div key={`${b.minMark}-${b.maxMark}`} className="flex items-center gap-3">
            <span className="w-40 text-xs font-semibold text-ink text-right truncate" title={label}>
              {label}
              <span className="block text-[10px] font-normal text-ink-muted">
                {b.minMark}–{b.maxMark}/20
              </span>
            </span>
            <div className="flex-1 h-7 bg-accent-slate-soft rounded-lg overflow-hidden relative">
              <div
                className={`h-full ${SHADES[Math.min(i, SHADES.length - 1)]} rounded-lg flex items-center
                            justify-end pr-2 transition-all`}
                style={{ width: `${b.count > 0 ? Math.max(barWidth, 3) : 0}%` }}
              >
                {pct > 15 && (
                  <span className="text-white text-xs font-bold">{pct}%</span>
                )}
              </div>
            </div>
            <span className="w-8 text-sm text-ink-muted font-medium">
              {b.count}
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
      <p className="text-sm text-ink-muted text-center py-6">
        {t("results.noBreakdown")}
      </p>
    );
  }

  // Sort by average descending
  const sorted = [...subjects].sort((a, b) => b.average - a.average);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-surface text-xs font-bold text-ink-muted
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
        <tbody className="divide-y divide-line">
          {sorted.map((s) => {
            const passColor = s.passRate >= 70
              ? "text-green-600"
              : s.passRate >= 50
                ? "text-amber-600"
                : "text-red-600";

            return (
              <tr key={s.subjectId}
                  className="hover:bg-accent-blue-soft/70 transition-colors">
                <td className="px-4 py-2.5 font-medium text-ink">
                  {s.subjectName}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold text-primary-600">
                  {on20(s.average)}
                </td>
                <td className="px-4 py-2.5 text-right text-emerald-600 font-semibold">
                  {on20(s.highest)}
                </td>
                <td className="px-4 py-2.5 text-right text-red-500 font-semibold">
                  {on20(s.lowest)}
                </td>
                <td className={`px-4 py-2.5 text-right font-bold ${passColor}`}>
                  {s.passRate.toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-right text-ink-muted">
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
  classId,
  page,
  onPage,
}: {
  examId:   string;
  scope:    RankScope;
  classId?: string;
  page:     number;
  onPage:   (page: number) => void;
}) => {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { data, isLoading } = useRankings(examId, scope, classId, page);
  const totalPages: number = data?.totalPages ?? 1;
  // Memoised: `?? []` is a new array each render, and these feed a useMemo
  // below, which then recomputes every render instead of memoising.
  // In the server's order, a page at a time. With every class shown, class
  // positions come grouped by class (Form 1's table, then Form 2's), so a
  // page never interleaves positions (1, 1, 2, 2…) — the server sorts so
  // that the page boundary falls inside one class's run, not across them.
  const rankings: ResultSummary[] = useMemo(() => data?.data ?? [], [data]);

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
        icon={Trophy}
        title={t("results.noRankings")}
        subtitle={t("results.processFirst")}
      />
    );
  }

  return (
    <div>
      {/* Search */}
      <div className="p-4 border-b border-line">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("results.searchPh")}
          className="w-full px-3 py-2 border border-line rounded-lg
                     text-sm focus:outline-none focus:ring-2
                     focus:ring-primary-400"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface text-xs font-bold text-ink-muted
                            uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">{t("results.pos")}</th>
              <th className="px-4 py-3 text-left">{t("academic.student")}</th>
              <th className="px-4 py-3 text-left">{t("academic.class")}</th>
              <th className="px-4 py-3 text-right">{t("academic.average")}</th>
              <th className="px-4 py-3 text-left">{t("results.remark")}</th>
              <th className="px-4 py-3 text-center">{t("academic.subject_other")}</th>
              <th className="px-4 py-3 text-center">{t("common.status")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.map((r, idx) => {
              const pos     = (r[posField] as number | null) ?? idx + 1;
              const total   = (r[totalField] as number | null) ?? data?.total ?? rankings.length;
              // Judged on /20 against the school's pass mark by the server.
              const passing = r.passes ?? r.isPassing;
              const color   = passing ? "text-green-600" : "text-red-600";
              const podium  = pos >= 1 && pos <= 3;

              return (
                <tr key={r._id || r.studentId}
                    className="hover:bg-accent-blue-soft/70 transition-colors">

                  {/* Position */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <span className={`font-bold ${podium ? "text-amber-600" : "text-ink-muted"}`}>
                        #{pos}
                      </span>
                      {total > 0 && (
                        <span className="text-xs text-ink-muted">
                          /{total}
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Student */}
                  <td className="px-4 py-3">
                    <p className="font-semibold text-ink">
                      {r.studentName || t("results.unknownStudent")}
                    </p>
                    {r.admissionNo && (
                      <p className="text-xs text-ink-muted">
                        #{r.admissionNo}
                      </p>
                    )}
                  </td>

                  {/* Class */}
                  <td className="px-4 py-3 text-ink-muted text-xs">
                    {r.className || "—"}
                  </td>

                  {/* Average /20 */}
                  <td className={`px-4 py-3 text-right font-bold ${color}`}>
                    {on20(r.average20)}
                  </td>

                  {/* The school's remark */}
                  <td className="px-4 py-3 text-ink-body">
                    {remarkText(r) || "—"}
                  </td>

                  {/* Subjects passed/total */}
                  <td className="px-4 py-3 text-center text-xs text-ink-muted">
                    <span className="text-green-600 font-semibold">
                      {r.subjectsPassed}
                    </span>
                    <span className="text-ink-muted mx-0.5">/</span>
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
          <div className="text-center py-8 text-sm text-ink-muted">
            {t("results.noStudentsMatch", { query: search })}
          </div>
        )}
      </div>

      {/* Pages of RANKINGS_PAGE_SIZE, as Term Results pages its list. */}
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line px-4 py-3">
          {search && (
            <span className="w-full text-center text-xs text-ink-muted">
              {t("results.searchThisPage")}
            </span>
          )}
          <button
            type="button"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-accent-slate-soft disabled:opacity-40"
          >
            {t("common.previous")}
          </button>
          <span className="text-sm text-ink-muted">
            {t("pagination.pageOf", { current: page, total: totalPages })}
          </span>
          <button
            type="button"
            onClick={() => onPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-accent-slate-soft disabled:opacity-40"
          >
            {t("common.next")}
          </button>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────
// SUBJECT BREAKDOWN PANEL
// Shows per-student subject scores from subjectBreakdown[]
// Opened when user clicks a student row (future enhancement)
// ─────────────────────────────────────────────────────────

const TopBottomStudents = ({
  topBottom,
  n = 5,
}: {
  topBottom: Stats["topBottom"];
  n?:        number;
}) => {
  const { t, i18n } = useTranslation();
  // One class at a time (A6): Form 1 and Upper Sixth are not one list. The
  // server numbers each pupil by their position in the class — the bottom
  // list runs weakest first, so it reads 5, 4, … not 4, 5.
  if (!topBottom) {
    return (
      <p className={cn("text-sm text-ink-muted text-center py-4 bg-surface rounded-xl border border-line", DASH_TINT.slate.edge)}>
        {t("results.chooseClassForTop")}
      </p>
    );
  }
  if (topBottom.total === 0) return null;
  const top    = topBottom.top;
  const bottom = topBottom.bottom;
  const remarkOf = (r: PlacedPupil) =>
    (i18n.language?.startsWith("fr") ? r.remarkFr : r.remark) ?? r.remark ?? null;

  const Row = ({ r, rank }: { r: PlacedPupil; rank: number }) => (
    <div className="flex items-center gap-3 py-2 border-b
                    border-line last:border-0">
      <span className="w-6 text-sm font-bold text-ink-muted text-center">
        {rank}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink truncate">
          {r.studentName || t("results.unknownStudent")}
        </p>
        <p className="text-xs text-ink-muted truncate">
          {r.className || "—"}
          {r.admissionNo ? ` · #${r.admissionNo}` : ""}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-sm font-bold
          ${r.passes ? "text-green-600" : "text-red-600"}`}>
          {on20(r.average20)}
        </p>
        <p className="text-xs text-ink-muted">{remarkOf(r) || "—"}</p>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Top performers */}
      <div className={cn("bg-surface rounded-xl border border-line p-4", DASH_TINT.slate.edge)}>
        <div className="flex items-center gap-2 mb-3">
          <HeadBox icon={Trophy} accent="amber" />
          <h3 className="font-semibold text-ink text-sm">
            {t("results.topStudents", { count: n })}
          </h3>
        </div>
        {top.map((r) => (
          <Row key={r.studentId} r={r} rank={r.position} />
        ))}
      </div>

      {/* Bottom performers — need attention */}
      <div className={cn("bg-surface rounded-xl border border-line p-4", DASH_TINT.slate.edge)}>
        <div className="flex items-center gap-2 mb-3">
          <HeadBox icon={Pin} accent="red" />
          <h3 className="font-semibold text-ink text-sm">
            {t("results.needsAttention", { count: n })}
          </h3>
        </div>
        {bottom.length === 0 && (
          <p className="text-xs text-ink-muted py-2">{t("results.allInTop")}</p>
        )}
        {bottom.map((r) => (
          <Row key={r.studentId} r={r} rank={r.position} />
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
  // The page of the rankings table; back to 1 whenever what it ranks changes.
  const [rankPage, setRankPage] = useState(1);
  // The class the analytics are for; "" (the default) is every class the exam
  // was sat in — the pupils Term Results counts. One class is only ever the
  // user's choice, and the page then says "Showing <class> only".
  const [classId, setClassId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<
    "overview" | "rankings" | "subjects"
  >("overview");

  // Data fetching
  const { data: examsData, isLoading: examsLoading } = useExams();
  // The exam's classes come from its all-classes statistics. With every class
  // shown, rankings are still per class (grouped by class, A6) and the top 5
  // asks for a class: Form 1 and Upper Sixth are not one list.
  const { data: allStatsData, isLoading: allStatsLoading } = useExamStats(selectedExamId ?? "");
  const classOptions: ClassOption[] =
    (allStatsData?.data as Stats | undefined)?.classes ?? [];
  const scope = resultsScope(classId, classOptions);
  const activeClassId = scope.classId ?? "";
  const { data: classStatsData, isLoading: classStatsLoading } = useExamStats(
    activeClassId ? selectedExamId ?? "" : "", activeClassId || undefined
  );
  const statsData    = activeClassId ? classStatsData : allStatsData;
  const statsLoading = allStatsLoading || (!!activeClassId && classStatsLoading);
  const { data: rankingsData, isLoading: rankingsLoading } = useRankings(selectedExamId ?? "", rankScope, activeClassId || undefined, rankPage);

  // A processed-but-unpublished exam is the office's to look at; the server
  // answers a teacher's statistics and rankings for published results only,
  // so offering the draft would be offering an empty page.
  const user    = useUser();
  const isAdmin = user?.role === "super_admin" || user?.role === "school_admin";
  const completedExams = useMemo(
    () =>
      (examsData?.exams ?? []).filter(
        (e) => e.status === "published" || (isAdmin && e.status === "completed")
      ),
    [examsData, isAdmin]
  );

  const stats: Stats | null    = statsData?.data ?? null;
  const rankings: ResultSummary[] = rankingsData?.data ?? [];
  // The whole table's size, not this page's: "N students" agrees with the
  // overview however many pages the table runs to.
  const rankingsTotal: number = rankingsData?.total ?? rankings.length;

  const selectedExam = completedExams.find((e) => e._id === selectedExamId);

  const handleSelectExam = (id: string) => {
    setSelectedExamId(id);
    setClassId("");
    setRankPage(1);
    setSearchParams({ examId: id });
    setActiveSection("overview");
  };

  // ── Render ────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <PageIcon />
          <div>
            <h1 className="text-2xl font-bold text-ink">
              {t("results.analytics")}
            </h1>
            <p className="text-ink-muted text-sm mt-1">
              {t("results.selectCompletedExam")}
            </p>
          </div>
        </div>
        <Link
          to="/reports/cards"
          className="px-4 py-2 bg-primary-600 text-white rounded-xl
                     text-sm font-semibold hover:bg-primary-700
                     transition-colors"
        >
          <Printer className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5" aria-hidden />{t("reportCards.title")}
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6
                      items-start">

        {/* Left — Exam picker */}
        <div className="space-y-3">
          <ExamPicker
            exams={completedExams}
            loading={examsLoading}
            selectedId={selectedExamId}
            onSelect={handleSelectExam}
          />
          <p className="text-xs text-ink-muted text-center">
            {t("results.onlyCompleted")}
          </p>
        </div>

        {/* Right — Results panel */}
        <div className="space-y-5">
          {!selectedExamId ? (
            <div className={cn("bg-surface rounded-xl border border-line", DASH_TINT.slate.edge)}>
              <EmptyState
                icon={BarChart3}
                title={t("results.selectToView")}
                subtitle={t("results.chooseExam")}
              />
            </div>
          ) : statsLoading ? (
            <div className="flex justify-center py-20">
              <Spinner />
            </div>
          ) : !stats || stats.totalStudents === 0 ? (
            <div className={cn("bg-surface rounded-xl border border-line", DASH_TINT.slate.edge)}>
              <EmptyState
                icon={Calculator}
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
                <div className={cn("bg-surface rounded-xl border border-line px-5 py-4 flex items-center justify-between", DASH_TINT.slate.edge)}>
                  <div>
                    <h2 className="flex items-center gap-2 font-bold text-ink text-lg">
                      <HeadBox icon={FileText} accent="amber" />
                      {selectedExam.name}
                    </h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {examTypeLabel(t, selectedExam.type)}
                      {selectedExam.term         ? ` · ${selectedExam.term}`         : ""}
                      {selectedExam.academicYear ? ` · ${selectedExam.academicYear}` : ""}
                      {selectedExam.classNames   ? ` · ${selectedExam.classNames}`   : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {classOptions.length > 1 && (
                      <select
                        value={activeClassId}
                        onChange={(e) => { setClassId(e.target.value); setRankPage(1); }}
                        aria-label={t("academic.class")}
                        className="rounded-lg border border-line px-2 py-1.5 text-xs font-semibold text-ink"
                      >
                        <option value="">{t("results.allClasses")}</option>
                        {classOptions.map((c) => (
                          <option key={c.classId} value={c.classId}>{c.className || c.classId}</option>
                        ))}
                      </select>
                    )}
                    <Link
                      to={`/exams/${selectedExamId}`}
                      className="text-xs font-semibold text-primary-600
                                 hover:text-primary-700"
                    >
                      {t("results.manageExam")} →
                    </Link>
                  </div>
                </div>
              )}

              {/* Section tabs */}
              <div className="flex border-b border-line bg-surface
                              rounded-t-xl overflow-hidden">
                {(["overview", "rankings", "subjects"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setActiveSection(s)}
                    className={`px-5 py-3 text-sm font-semibold
                      transition-colors
                      ${activeSection === s
                        ? "text-primary-600 border-b-2 border-primary-600"
                        : "text-ink-muted hover:text-ink"
                      }`}
                  >
                    {t(SECTION_LABEL_KEYS[s])}
                  </button>
                ))}
              </div>

              {/* One class chosen: every figure below is that class's, and
                  the exam title above names them all — say which. */}
              {scope.className && (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
                >
                  <span className="font-semibold">
                    {t("results.showingClassOnly", { className: scope.className })}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setClassId(""); setRankPage(1); }}
                    className="text-xs font-semibold text-primary-600 hover:text-primary-700"
                  >
                    {t("results.showAllClasses")}
                  </button>
                </div>
              )}

              {/* ── OVERVIEW SECTION ── */}
              {activeSection === "overview" && (
                <div className="space-y-5">

                  {/* 8 stat cards */}
                  <StatsOverview stats={stats} />

                  {/* Pass/fail + score distribution */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={cn("bg-surface rounded-xl border border-line p-5", DASH_TINT.slate.edge)}>
                      <h3 className="flex items-center gap-2 font-semibold text-ink mb-4 text-sm">
                        <HeadBox icon={PieChart} />
                        {t("results.passFailSplit")}
                      </h3>
                      <PassFailDonut
                        passed={stats.passed}
                        failed={stats.failed}
                        total={stats.totalStudents}
                      />
                    </div>

                    <div className={cn("bg-surface rounded-xl border border-line p-5", DASH_TINT.slate.edge)}>
                      <h3 className="flex items-center gap-2 font-semibold text-ink mb-4 text-sm">
                        <HeadBox icon={BarChart3} />
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
                  <div className={cn("bg-surface rounded-xl border border-line p-5", DASH_TINT.slate.edge)}>
                    <h3 className="flex items-center gap-2 font-semibold text-ink mb-4 text-sm">
                      <HeadBox icon={Layers} />
                      {t("results.remarkDistribution")}
                    </h3>
                    <RemarkDistributionChart
                      bands={stats.remarkDistribution ?? []}
                      total={stats.totalStudents}
                    />
                  </div>

                  {/* Top / Bottom students */}
                  <TopBottomStudents topBottom={stats.topBottom ?? null} n={5} />
                </div>
              )}

              {/* ── RANKINGS SECTION ── */}
              {activeSection === "rankings" && (
                <div className="space-y-4">

                  {/* Scope selector */}
                  <div className={cn("bg-surface rounded-xl border border-line p-4 flex items-center justify-between", DASH_TINT.slate.edge)}>
                    <p className="text-sm font-semibold text-ink">
                      {t("results.rankBy")}
                    </p>
                    <div className="flex gap-1">
                      {RANK_SCOPES.map((s) => (
                        <button
                          key={s.key}
                          onClick={() => { setRankScope(s.key); setRankPage(1); }}
                          className={`px-3 py-1.5 rounded-lg text-xs
                            font-semibold transition-colors
                            ${rankScope === s.key
                              ? "bg-primary-600 text-white"
                              : "bg-accent-slate-soft text-accent-slate-deep hover:bg-accent-blue-soft"
                            }`}
                        >
                          {t(s.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Table */}
                  <div className={cn("bg-surface rounded-xl border border-line overflow-hidden", DASH_TINT.slate.edge)}>
                    <div className="px-5 py-3 border-b border-line
                                    flex items-center justify-between">
                      <h3 className="flex items-center gap-2 font-semibold text-ink text-sm">
                        <HeadBox icon={ListOrdered} />
                        {t(RANKINGS_TITLE_KEYS[rankScope])}
                        <span className="ml-2 text-xs text-ink-muted font-normal">
                          {rankingsLoading ? "…" : t("results.studentCount", { count: rankingsTotal })}
                        </span>
                      </h3>
                    </div>
                    <RankingsTable
                      examId={selectedExamId}
                      scope={rankScope}
                      classId={activeClassId || undefined}
                      page={rankPage}
                      onPage={setRankPage}
                    />
                  </div>
                </div>
              )}

              {/* ── SUBJECT ANALYSIS SECTION ── */}
              {activeSection === "subjects" && (
                <div className="space-y-4">
                  <div className={cn("bg-surface rounded-xl border border-line overflow-hidden", DASH_TINT.slate.edge)}>
                    <div className="px-5 py-3 border-b border-line">
                      <h3 className="flex items-center gap-2 font-semibold text-ink text-sm">
                        <HeadBox icon={BookOpen} />
                        {t("results.bySubject")}
                        <span className="ml-2 text-xs text-ink-muted font-normal">
                          {t("results.subjectCount", { count: stats.subjectStats.length })}
                        </span>
                      </h3>
                    </div>
                    <SubjectPerformanceTable subjects={stats.subjectStats} />
                  </div>

                  {/* Subject pass rate bars */}
                  {stats.subjectStats.length > 0 && (
                    <div className={cn("bg-surface rounded-xl border border-line p-5", DASH_TINT.slate.edge)}>
                      <h3 className="flex items-center gap-2 font-semibold text-ink text-sm mb-4">
                        <HeadBox icon={Percent} />
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
                                <span className="w-28 text-xs text-ink-body
                                                 truncate text-right">
                                  {s.subjectName}
                                </span>
                                <div className="flex-1 h-5 bg-accent-slate-soft
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
                                <span className="w-10 text-xs text-ink-muted
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