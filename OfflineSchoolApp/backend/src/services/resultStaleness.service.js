// backend/src/services/resultStaleness.service.js
"use strict";

/**
 * Has a computed result been overtaken by the marks it was computed from?
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * A term average is computed once, deliberately: it is a decision a school
 * takes when the sequences are final, not something that should shift under
 * them mid-marking. But nothing recomputes it afterwards either, and that has
 * a sharp edge.
 *
 * Correct a sequence mark after computing, and the report card disagrees with
 * itself. The subject rows are rebuilt on every print, so they show the new
 * mark. The term average, the grade, the remark and the class position are read
 * from the stored TermResult, so they still show the old one. Nobody is told.
 * A parent gets a card whose subject marks do not add up to its average.
 *
 * So rather than recompute behind the school's back — which would take the
 * decision away — this reports it: which pupils' stored results are older than
 * the marks behind them, so a screen can say "these need recomputing" and an
 * administrator can decide when.
 *
 * ── What "older" means ────────────────────────────────────────────────────
 *
 * Strictly newer, compared on updatedAt. A mark saved in the same second as the
 * computation is not evidence of anything, and calling it stale would leave a
 * warning on screen that no amount of recomputing could clear.
 */

const Exam         = require("../db/models/Exam");
const StudentScore = require("../db/models/StudentScore");
const TermResult   = require("../db/models/TermResult");

/** The latest updatedAt per student, over a set of exams. */
async function latestMarkPerStudent(examIds) {
  if (!examIds.length) return new Map();
  const rows = await StudentScore.aggregate([
    { $match: { examId: { $in: examIds }, deletedAt: null } },
    { $group: { _id: "$studentId", latest: { $max: "$updatedAt" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.latest]));
}

/**
 * Which of these term results have been overtaken by their sequence marks.
 *
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string}  p.academicYear
 * @param {number}  p.term
 * @param {Array}   p.results  the TermResult rows being shown, lean
 * @returns {{ staleIds: Set<string>, latestMark: Date|null }}
 */
async function termStaleness({ schoolId, academicYear, term, results }) {
  if (!Array.isArray(results) || results.length === 0) {
    return { staleIds: new Set(), latestMark: null };
  }

  // Every exam of this term, whether or not it names a sequence: a school that
  // ran an extra assessment inside the term still marked it, and a change to
  // that mark still moves the average.
  const exams = await Exam.find({
    schoolId: String(schoolId), academicYear, term: Number(term), deletedAt: null,
  }).select("_id").lean();

  const perStudent = await latestMarkPerStudent(exams.map((e) => String(e._id)));

  const staleIds = new Set();
  let latestMark = null;

  for (const row of results) {
    const marked   = perStudent.get(String(row.studentId));
    const computed = row.updatedAt;
    if (marked && (!latestMark || marked > latestMark)) latestMark = marked;
    if (marked && computed && new Date(marked) > new Date(computed)) {
      staleIds.add(String(row.studentId));
    }
  }

  return { staleIds, latestMark };
}

/**
 * The same question one level up: an annual result is stale when any term
 * result it was built from has been recomputed since.
 *
 * Deliberately NOT reaching all the way down to the marks. An annual average is
 * built from term averages, so a corrected mark makes the TERM stale first —
 * and reporting the annual as stale before its term has been recomputed would
 * tell a school to redo the year when what it needs is to redo one term.
 *
 * @returns {{ staleIds: Set<string>, latestTerm: Date|null }}
 */
async function annualStaleness({ schoolId, academicYear, results }) {
  if (!Array.isArray(results) || results.length === 0) {
    return { staleIds: new Set(), latestTerm: null };
  }

  const rows = await TermResult.aggregate([
    { $match: { schoolId: String(schoolId), academicYear, deletedAt: null } },
    { $group: { _id: "$studentId", latest: { $max: "$updatedAt" } } },
  ]);
  const perStudent = new Map(rows.map((r) => [String(r._id), r.latest]));

  const staleIds = new Set();
  let latestTerm = null;

  for (const row of results) {
    const termComputed   = perStudent.get(String(row.studentId));
    const annualComputed = row.updatedAt;
    if (termComputed && (!latestTerm || termComputed > latestTerm)) {
      latestTerm = termComputed;
    }
    if (termComputed && annualComputed &&
        new Date(termComputed) > new Date(annualComputed)) {
      staleIds.add(String(row.studentId));
    }
  }

  return { staleIds, latestTerm };
}

/**
 * Stamp the rows and summarise, in the shape both listings answer with.
 *
 * The flag rides on each row as well as being counted, so a table can mark the
 * pupils concerned rather than only warning that some exist — "4 of these need
 * recomputing" is not much use without knowing which four.
 */
function withStaleness(results, staleIds) {
  return {
    results: results.map((r) => ({
      ...r,
      isStale: staleIds.has(String(r.studentId)),
    })),
    staleCount: staleIds.size,
  };
}

module.exports = { termStaleness, annualStaleness, withStaleness };
