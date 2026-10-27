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
const { sequenceAverageIsOn20 } = require("../../../shared/academicRules");
const { summaryPassRate } = require("../../../shared/passRate");
const { examAnalytics, rowsOn20, classesOf, classTopBottom } = require("../../../shared/examAnalytics");
const GradingConfig = require("../db/models/GradingConfig");
const { passMarkOf } = require("./passMark.service");
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
async function examStatistics({ schoolId, examId, classId, onlyPublished = false } = {}) {
  const filter = { examId, deletedAt: null };
  // A teacher's or a bursar's statistics are of published results; a draft
  // average seen early is a grade argued about before the school decided it.
  if (onlyPublished) filter.isPublished = true;
  if (schoolId) filter.schoolId = String(schoolId);
  if (classId)  filter.classId  = String(classId);

  const results = await ResultSummary.find(filter).lean();

  /*
   * On /20, with the school's own remarks (shared/examAnalytics.js, decided
   * 2026-10-27): average, highest and lowest of the pupils' averages /20; a
   * distribution over the school's remark bands; subjects on /20 with their
   * pass rate against the school's pass mark. No percentages, no GPA, no
   * letter grades — and the pass rate is shared/passRate.js: pupils with
   * results, against the school's pass mark.
   */
  const sid = schoolId ?? results[0]?.schoolId;
  const cfg = sid
    ? await GradingConfig.findOne({ schoolId: String(sid) }).select("grades passMark").lean().catch(() => null)
    : null;
  const opts = { passMark: cfg?.passMark ?? undefined, bands: cfg?.grades ?? null };
  const analytics = examAnalytics(results, opts);

  // Rankings are per class (A6, decided 2026-10-27): the classes this exam has
  // results in, for the page's class filter, and — once one class is chosen —
  // that class's best and weakest pupils, numbered by their class position.
  // Without a class there is no top 5: Form 1 and Upper Sixth are not one list.
  const { backfillRankingNames } = require("./results.service");
  await backfillRankingNames(results);
  let classRows = results;
  if (classId) {
    const { classId: _chosen, ...allClasses } = filter;
    classRows = await ResultSummary.find(allClasses).select("studentId classId className").lean();
    await backfillRankingNames(classRows);
  }
  const classes = classesOf(classRows);
  const topBottom = classId ? classTopBottom(results, opts) : null;
  return { ...analytics, classes, topBottom };
}

/**
 * Result rows as the analytics tables print them: each pupil's average on
 * /20, the school's remark for it, and whether it passes the school's pass
 * mark — no percentage, letter or GPA (shared/examAnalytics.js).
 */
async function withAverage20(rows, schoolId) {
  if (!rows?.length) return rows || [];
  const cfg = await GradingConfig.findOne({ schoolId: String(schoolId ?? rows[0].schoolId) })
    .select("grades passMark").lean().catch(() => null);
  return rowsOn20(rows, { passMark: cfg?.passMark ?? undefined, bands: cfg?.grades ?? null });
}

/**
 * The pass rate over a stated scope of sequences — a year, optionally a term
 * and a class — for the exams overview (shared/passRate.js).
 *
 * Scoped through the exams, not the summaries: a summary written before the
 * server stored academicYear on it has none, and its `term` is a string.
 * Sequence papers only — a CA's own summary is already inside its paper's,
 * and counting it would count the pupil twice.
 *
 * @returns {Promise<{ academicYear, term, passMark, average, withResults, passed, failed, rate }>}
 */
async function scopedPassRate({ schoolId, academicYear, term = null, classId = null, onlyPublished = true }) {
  const Exam = require("../db/models/Exam");
  const { CA_TYPE } = require("../../../shared/caAssessment");
  const forms = [...new Set([String(academicYear), String(academicYear).replace("/", "-"), String(academicYear).replace("-", "/")])];
  const exams = await Exam.find({
    schoolId: String(schoolId), academicYear: { $in: forms }, deletedAt: null, type: { $ne: CA_TYPE },
    ...(term ? { term: Number(term) } : {}),
  }).select("_id").lean();
  const filter = { schoolId: String(schoolId), examId: { $in: exams.map((e) => String(e._id)) }, deletedAt: null };
  if (onlyPublished) filter.isPublished = true;
  if (classId) filter.classId = String(classId);
  const [rows, passMark] = await Promise.all([
    exams.length
      ? ResultSummary.find(filter).select("average percentage calcVersion subjectBreakdown.isAbsent subjectBreakdown.isExempt").lean()
      : [],
    passMarkOf(schoolId),
  ]);
  // The average beside the pass rate, on /20 over the same pupils.
  const { average } = examAnalytics(rows, { passMark });
  return { academicYear, term: term ? Number(term) : null, passMark, average, ...summaryPassRate(rows, passMark) };
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
  const rows = await ResultSummary.find(filter).select("percentage average calcVersion").lean();
  return {
    scale: "20",
    // A weighted_20 row (exam-process/2) stores its exact /20 average; its
    // percentage is that average rounded to a whole number, so reading the
    // percentage would print a class figure a few hundredths off the pupils'.
    ...cohortFigures(rows.map((r) => (sequenceAverageIsOn20(r.calcVersion)
      ? round2(Number(r.average)) : percentAsMark(r.percentage)))),
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
  scopedPassRate,
  withAverage20,
  cohortFigures,
  examStatistics,
  sequenceClassStats,
  termClassStats,
  annualClassStats,
};
