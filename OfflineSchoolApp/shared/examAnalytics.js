// OfflineSchoolApp/shared/examAnalytics.js
"use strict";

/**
 * An exam's analytics on /20, with the school's own remarks (decided
 * 2026-10-27).
 *
 * The analytics page, the exams overview and Students to watch spoke in
 * percentages, an "Avg GPA" and US letter grades (A+ … F). A Cameroonian
 * school grades /20 and reads a mark through its own remark scale ("Assez
 * bien", "Insuffisant"…). Everything here is /20; there is no GPA and no
 * letter.
 *
 * Who is counted, and who passes, is shared/passRate.js: the pupils with
 * results, against the school's pass mark.
 *
 * Pure.
 */

const { sequenceFigureOn20 } = require("./academicRules");
const { fullyAbsent, passRateOf, summaryPasses, DEFAULT_PASS_MARK } = require("./passRate");
const { findBand, DEFAULT_GRADES } = require("./gradeScale");

const round2 = (n) => Math.round(n * 100) / 100;

/** A subject entry's mark on /20, or null when the pupil has none. */
function subjectMarkOn20(s) {
  if (!s || s.isAbsent || s.isExempt) return null;
  if (s.normalizedMark != null && Number.isFinite(Number(s.normalizedMark))) return Number(s.normalizedMark);
  const score = Number(s.score), max = Number(s.maxScore);
  if (s.score == null || !Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return null;
  return (score / max) * 20;
}

/** The school's bands, highest first, or the shipped table. */
const bandsOf = (bands) =>
  [...(Array.isArray(bands) && bands.length ? bands : DEFAULT_GRADES)]
    .sort((a, b) => Number(b.minMark ?? b.min) - Number(a.minMark ?? a.min));

/** A /20 mark's remark in both languages, or nulls. */
function remarkOf(markOn20, bands) {
  const band = findBand(markOn20, bandsOf(bands));
  return { remark: band?.remark ?? null, remarkFr: band?.remarkFr || band?.remark || null };
}

/** min, max and mean of a list of /20 marks (0s for an empty list). */
const spread = (values) => (values.length
  ? { average: round2(values.reduce((s, v) => s + v, 0) / values.length),
      highest: round2(Math.max(...values)), lowest: round2(Math.min(...values)) }
  : { average: 0, highest: 0, lowest: 0 });

/**
 * @param {Array} summaries  ResultSummary rows for one exam (and class)
 * @param {object} [opts]
 * @param {number} [opts.passMark]  /20
 * @param {Array}  [opts.bands]     the school's GradingConfig.grades
 */
function examAnalytics(summaries, { passMark = DEFAULT_PASS_MARK, bands = null } = {}) {
  const rows = (summaries || []).filter((r) => !fullyAbsent(r));
  const averages = rows.map((r) => sequenceFigureOn20(r)).filter((a) => a != null && Number.isFinite(Number(a))).map(Number);
  const pr = passRateOf(averages, passMark);

  // How many pupils' averages fall in each of the school's remark bands,
  // highest band first, every band listed (an empty band is information too).
  const scale = bandsOf(bands);
  const remarkDistribution = scale.map((b) => ({
    remark: b.remark ?? null, remarkFr: b.remarkFr || b.remark || null,
    minMark: Number(b.minMark ?? b.min), maxMark: Number(b.maxMark ?? b.max), count: 0,
  }));
  for (const avg of averages) {
    const band = findBand(avg, scale);
    const slot = band ? remarkDistribution[scale.indexOf(band)] : null;
    if (slot) slot.count += 1;
  }

  const bySubject = new Map();
  for (const r of rows) {
    for (const s of r.subjectBreakdown || []) {
      const mark = subjectMarkOn20(s);
      if (mark == null) continue;
      const key = String(s.subjectId || s.subjectName || "");
      if (!key) continue;
      if (!bySubject.has(key)) {
        bySubject.set(key, { subjectId: s.subjectId || key, subjectName: s.subjectName || key, marks: [] });
      }
      bySubject.get(key).marks.push(mark);
    }
  }
  const subjectStats = [...bySubject.values()].map((x) => ({
    subjectId:   x.subjectId,
    subjectName: x.subjectName,
    ...spread(x.marks),
    passRate:    passRateOf(x.marks, passMark).rate ?? 0,
    total:       x.marks.length,
  }));

  return {
    scale:         "20",
    totalStudents: pr.withResults,
    passed:        pr.passed,
    failed:        pr.failed,
    passMark:      Number(passMark ?? DEFAULT_PASS_MARK),
    passRate:      pr.rate ?? 0,
    ...spread(averages),
    remarkDistribution,
    subjectStats,
  };
}

/**
 * Result rows as the analytics tables print them: each pupil's average on /20,
 * the school's remark for it, and whether it passes the school's pass mark.
 */
const rowsOn20 = (rows, { passMark = DEFAULT_PASS_MARK, bands = null } = {}) =>
  (rows || []).map((r) => {
    // A pupil absent from every subject has no result: no mark, no remark.
    const average20 = fullyAbsent(r) ? null : sequenceFigureOn20(r);
    return { ...r, average20, ...remarkOf(average20, bands), passes: summaryPasses(r, passMark) };
  });

/**
 * One class's best and weakest pupils (decided 2026-10-27).
 *
 * The analytics page took its top 5 from every class the exam was sat in —
 * Form 1 next to Upper Sixth — and numbered its bottom 5 from the wrong end
 * (the weakest pupil was #4, the next one up #5). Here the rows are ONE
 * class's, each pupil is numbered by their position in that class (pupils
 * level on average share a position), the top list runs best-first and the
 * bottom list weakest-first. A pupil already in the top list is not repeated
 * at the bottom, so a class of three shows three pupils, not six.
 *
 * @param {Array} rows  rows from rowsOn20, all of one class
 * @param {number} [n]
 * @returns {{ top: Array<{position, row}>, bottom: Array<{position, row}>, total: number }}
 */
function topAndBottom(rows, n = 5) {
  const ranked = (rows || [])
    .filter((r) => r && r.average20 != null && Number.isFinite(Number(r.average20)))
    .sort((a, b) => Number(b.average20) - Number(a.average20)
      || String(a.studentName ?? "").localeCompare(String(b.studentName ?? "")));
  let position = 0;
  const placed = ranked.map((row, i) => {
    if (i === 0 || Number(row.average20) !== Number(ranked[i - 1].average20)) position = i + 1;
    return { position, row };
  });
  const top = placed.slice(0, n);
  const bottom = placed.slice(Math.max(top.length, placed.length - n)).reverse();
  return { top, bottom, total: placed.length };
}

/** The classes an exam's results are in, for a class filter, by name. */
const classesOf = (summaries) =>
  [...new Map((summaries || []).filter((r) => r && r.classId)
    .map((r) => [String(r.classId), { classId: String(r.classId), className: r.className || null }])).values()]
    .sort((a, b) => String(a.className ?? "").localeCompare(String(b.className ?? ""), undefined, { numeric: true }));

/**
 * One class's top and bottom pupils from its ResultSummary rows, shaped for
 * the page: position, name, average /20, the school's remark, passes.
 */
function classTopBottom(summaries, { passMark = DEFAULT_PASS_MARK, bands = null, n = 5 } = {}) {
  const tb = topAndBottom(rowsOn20(summaries, { passMark, bands }), n);
  const slim = ({ position, row }) => ({
    position, studentId: row.studentId, studentName: row.studentName ?? null, admissionNo: row.admissionNo ?? null,
    className: row.className ?? null, average20: row.average20, remark: row.remark, remarkFr: row.remarkFr, passes: row.passes,
  });
  return { top: tb.top.map(slim), bottom: tb.bottom.map(slim), total: tb.total };
}

module.exports = { examAnalytics, remarkOf, subjectMarkOn20, rowsOn20, topAndBottom, classesOf, classTopBottom };
