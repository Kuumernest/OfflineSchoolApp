// OfflineSchoolApp/shared/passRate.js
"use strict";

/**
 * The one pass rate (decided 2026-10-27).
 *
 *   pass rate = pupils whose average /20 >= the school's pass mark
 *               ÷ pupils with results (a pupil absent from every subject has
 *                 none, and is not counted either way)
 *
 * over one stated scope — an exam, a term, a year — and nothing else. The
 * exams page said 96%, Test 3's analytics 75% and the platform dashboard 100%:
 * three scopes (every published exam ever, one exam, every term of every
 * year), two denominators, and pass flags stored by writers that disagreed
 * about the threshold (one hard-coded 10/20 whatever the school had set).
 * The stored isPassing is not read: the average and the school's pass mark
 * decide it here.
 *
 * Pure.
 */

const { sequenceFigureOn20 } = require("./academicRules");

const DEFAULT_PASS_MARK = 10;

/** A sequence summary in which every subject was missed holds no result. */
const fullyAbsent = (summary) =>
  Array.isArray(summary?.subjectBreakdown) && summary.subjectBreakdown.length > 0 &&
  summary.subjectBreakdown.every((s) => s.isAbsent || s.isExempt);

/**
 * Pass rate over averages already on /20. A null average is no result.
 *
 * @param {Array<number|null|undefined>} averages
 * @param {number} [passMark]  on /20
 * @returns {{ withResults: number, passed: number, failed: number, rate: number|null }}
 *   rate in percent, one decimal; null when nobody has a result
 */
function passRateOf(averages, passMark = DEFAULT_PASS_MARK) {
  const bar = Number.isFinite(Number(passMark)) ? Number(passMark) : DEFAULT_PASS_MARK;
  const counted = (averages || []).filter((a) => a != null && Number.isFinite(Number(a))).map(Number);
  const passed = counted.filter((a) => a >= bar).length;
  return {
    withResults: counted.length,
    passed,
    failed: counted.length - passed,
    rate: counted.length ? Math.round((passed / counted.length) * 1000) / 10 : null,
  };
}

/**
 * Pass rate over sequence summaries (ResultSummary rows), each read on /20
 * whichever writer produced it (sequenceFigureOn20).
 */
function summaryPassRate(summaries, passMark = DEFAULT_PASS_MARK) {
  return passRateOf(
    (summaries || []).map((s) => (fullyAbsent(s) ? null : sequenceFigureOn20(s))),
    passMark
  );
}

/** One summary's verdict under the same rule, or null with no result. */
function summaryPasses(summary, passMark = DEFAULT_PASS_MARK) {
  if (fullyAbsent(summary)) return null;
  const avg = sequenceFigureOn20(summary);
  return avg == null ? null : avg >= Number(passMark ?? DEFAULT_PASS_MARK);
}

module.exports = { passRateOf, summaryPassRate, summaryPasses, fullyAbsent, DEFAULT_PASS_MARK };
