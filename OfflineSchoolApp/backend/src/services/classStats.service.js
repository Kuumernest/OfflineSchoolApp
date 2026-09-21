// backend/src/services/classStats.service.js
"use strict";

/**
 * How a class did, as one calculation used by everything that reports it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * GET /api/results/:examId/stats computed the class average, the best mark and
 * the lowest inline in its handler. The report card needs the same three
 * figures, and a second implementation of them inside the card builder is how
 * a school ends up holding two documents that disagree about the same class —
 * the statistics page saying one average and the bulletin another, with no way
 * to tell which is right.
 *
 * So the arithmetic moved here unchanged and the endpoint calls it. The card
 * calls the same function. If the definition of a class average ever changes,
 * it changes once.
 *
 * ── The scale each figure is on ───────────────────────────────────────────
 *
 * The STATISTICS PAGE has always worked in percentages: r.average on a
 * summary mixes scales when subjects have different maxScore, so the
 * endpoint reads r.percentage instead. examStatistics below is that page's
 * calculation and is unchanged.
 *
 * A REPORT CARD is marked out of twenty, and a class average printed beside
 * a pupil's 13.50/20 has to be on the same scale or the two cannot be read
 * together. So the sequence figures are the same authoritative percentages
 * that page reads, put on the card's scale and aggregated by the same
 * helper the term and annual figures use. No second average is computed
 * anywhere; only the scale it is printed on differs.
 */

const ResultSummary = require("../db/models/ResultSummary");
const TermResult    = require("../db/models/TermResult");
const AnnualResult  = require("../db/models/AnnualResult");

/** Two decimal places, the rounding the statistics endpoint has always used. */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Average, highest and lowest over a list of numbers.
 *
 * Empty in, nothing out: `count: 0` and nulls rather than zeroes, because a
 * class with no published results has no average, and printing 0.00 on a
 * report card says something false about the class the pupil is in. The
 * statistics endpoint below keeps its own long-standing zeroes for the same
 * empty case, since an API that starts answering null where it answered 0
 * breaks whatever is reading it.
 */
const cohortFigures = (values) => {
  const numbers = (values || [])
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);
  if (!numbers.length) return { count: 0, average: null, highest: null, lowest: null };
  return {
    count:   numbers.length,
    average: round2(numbers.reduce((s, v) => s + v, 0) / numbers.length),
    highest: Math.max(...numbers),
    lowest:  Math.min(...numbers),
  };
};

/**
 * The statistics for one exam, optionally narrowed to one class.
 *
 * Moved verbatim from GET /api/results/:examId/stats, which now calls it. The
 * zeroes-when-empty, the percentage scale and the subject breakdown are all as
 * they were; nothing about the endpoint's answer changed.
 *
 * @param {object}  args
 * @param {string}  [args.schoolId]  omitted only by a super admin who named no school
 * @param {string}  args.examId
 * @param {string}  [args.classId]
 */
async function examStatistics({ schoolId, examId, classId } = {}) {
  const filter = { examId, deletedAt: null };
  if (schoolId) filter.schoolId = String(schoolId);
  if (classId)  filter.classId  = String(classId);

  const results = await ResultSummary.find(filter).lean();

  const totalStudents = results.length;
  const passed = results.filter((r) => r.isPassing).length;
  const failed = totalStudents - passed;

  // Average / highest / lowest use each student's overall percentage (0-100),
  // not the /20 average stored on the summary. r.average mixes scales when
  // subjects have different maxScore, so a 12/20 average must not render as 12%.
  const percentages = results
    .map((r) => r.percentage)
    .filter((p) => p != null && Number.isFinite(Number(p)))
    .map(Number);
  const average = percentages.length
    ? round2(percentages.reduce((s, v) => s + v, 0) / percentages.length)
    : 0;
  const highest = percentages.length ? Math.max(...percentages) : 0;
  const lowest  = percentages.length ? Math.min(...percentages) : 0;
  const passRate = totalStudents > 0
    ? Math.round((passed / totalStudents) * 10000) / 100
    : 0;

  const gpas = results
    .map((r) => r.gpa)
    .filter((g) => g != null && Number.isFinite(Number(g)))
    .map(Number);
  const averageGpa = gpas.length
    ? round2(gpas.reduce((s, v) => s + v, 0) / gpas.length)
    : 0;

  const gradeDistribution = {};
  for (const r of results) {
    const g = r.overallGrade || "N/A";
    gradeDistribution[g] = (gradeDistribution[g] || 0) + 1;
  }

  // Subject analysis — aggregate per-subject numbers from every student's
  // subjectBreakdown. Averages / highs / lows are percentages so the UI can
  // render them alongside the pass rate without mixing scales.
  const subjectAgg = new Map();
  for (const r of results) {
    for (const s of r.subjectBreakdown || []) {
      if (s.isAbsent || s.isExempt || s.score == null) continue;
      const key = String(s.subjectId || s.subjectName || "");
      if (!key) continue;
      if (!subjectAgg.has(key)) {
        subjectAgg.set(key, {
          subjectId:   s.subjectId || key,
          subjectName: s.subjectName || key,
          total:       0,
          sum:         0,
          highest:     -Infinity,
          lowest:      Infinity,
          passed:      0,
        });
      }
      const agg = subjectAgg.get(key);
      agg.total += 1;
      const pct = s.percentage != null && Number.isFinite(Number(s.percentage))
        ? Number(s.percentage)
        : s.maxScore > 0
          ? Math.round((Number(s.score) / Number(s.maxScore)) * 10000) / 100
          : 0;
      agg.sum += pct;
      if (pct > agg.highest) agg.highest = pct;
      if (pct < agg.lowest)  agg.lowest  = pct;
      if (s.isPassing) agg.passed += 1;
    }
  }
  const subjectStats = [...subjectAgg.values()].map((a) => ({
    subjectId:   a.subjectId,
    subjectName: a.subjectName,
    average:     a.total > 0 ? round2(a.sum / a.total) : 0,
    highest:     a.total > 0 ? a.highest : 0,
    lowest:      a.total > 0 ? a.lowest  : 0,
    passRate:    a.total > 0 ? Math.round((a.passed / a.total) * 10000) / 100 : 0,
    total:       a.total,
  }));

  return {
    totalStudents,
    passed,
    failed,
    average,
    highest,
    lowest,
    passRate,
    averageGpa,
    gradeDistribution,
    subjectStats,
  };
}

/**
 * The three figures a sequence card prints about the class, out of twenty.
 *
 * The same rows the statistics endpoint reads and the same cohort — every
 * pupil with a summary for this exam in this class — but each pupil's stored
 * average read the way the card reads it (averageOutOf20), so the class
 * average can be set beside the pupil's own without converting either.
 *
 * The pupil the card is for is INCLUDED, exactly as the statistics endpoint
 * includes them — a class average that leaves one pupil out is a different
 * number for every pupil, and the page and the paper would disagree.
 */
/** A percentage, on the twenty-point scale the card is marked in. */
const percentAsMark = (pct) =>
  pct == null || !Number.isFinite(Number(pct)) ? null : round2((Number(pct) / 100) * 20);

async function sequenceClassStats({ schoolId, examId, classId }) {
  const filter = { examId, deletedAt: null };
  if (schoolId) filter.schoolId = String(schoolId);
  if (classId)  filter.classId  = String(classId);

  /*
   * From `percentage`, the field the statistics page already treats as
   * authoritative, put on the card's scale.
   *
   * Not from `average`: what that field holds depends on when the summary
   * was written. The current pipeline stores it out of twenty already
   * (results.controller: "average is already out of `out`"), while older
   * summaries hold GPA points, which is why the card multiplies its own
   * fallback by five. A cohort read through that rule printed a class
   * average of 66.40 out of 20 on a real card — the percentage, five times
   * over. `percentage` means the same thing in both, so the conversion is
   * the same arithmetic for every row: a hundredth of it, twenty times.
   */
  const rows = await ResultSummary.find(filter).select("percentage").lean();
  return {
    scale: "20",
    ...cohortFigures(rows.map((r) => percentAsMark(r.percentage))),
  };
}

/**
 * The class's term averages, out of twenty — the scale a term card prints.
 *
 * Scoped to school + year + term + class, which is the key TermResult is
 * written under and the cohort `totalInClass` on each record already counts.
 */
async function termClassStats({ schoolId, academicYear, term, classId }) {
  const rows = await TermResult.find({
    schoolId:     String(schoolId),
    academicYear,
    term:         Number(term),
    classId:      String(classId),
    deletedAt:    null,
  }).select("termAverage").lean();

  return { scale: "20", ...cohortFigures(rows.map((r) => r.termAverage)) };
}

/** The same for the annual card, over the year's annual averages. */
async function annualClassStats({ schoolId, academicYear, classId }) {
  const rows = await AnnualResult.find({
    schoolId:     String(schoolId),
    academicYear,
    classId:      String(classId),
    deletedAt:    null,
  }).select("annualAverage").lean();

  return { scale: "20", ...cohortFigures(rows.map((r) => r.annualAverage)) };
}

module.exports = {
  cohortFigures,
  examStatistics,
  sequenceClassStats,
  termClassStats,
  annualClassStats,
};
