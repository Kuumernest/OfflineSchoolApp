// OfflineSchoolApp/shared/intelligence/academicOrder.js
"use strict";

/**
 * The order a pupil's results actually happened in, and which rows count.
 *
 * ── Why this is in shared/ ────────────────────────────────────────────────
 *
 * Two faults live here, both silent, and both would have to be got right
 * independently by every consumer that wanted to answer "how is this child
 * doing" without a connection:
 *
 *   CONTINUOUS ASSESSMENT IS NOT A SECOND SEQUENCE. A sequence is two exams —
 *   the paper and its CA — and processing either one writes a ResultSummary.
 *   A reader that does not drop the CA compares one half of a sequence against
 *   the other and reports the difference as a change in the child.
 *
 *   createdAt IS NOT CHRONOLOGY. It is when the row was WRITTEN. Recompute
 *   Sequence 1 after a mark correction and it becomes the newest row while
 *   remaining the oldest event, so "the last two results" reports a decline as
 *   an improvement.
 *
 * shared/gradeScale.js is in this directory because four copies of the grading
 * table had drifted and a pupil on 11.5 was told two different things by two
 * screens. This is the same class of rule and it moved here before that could
 * happen to it: the desktop answering offline and the server answering online
 * now run the identical function rather than two that agree today.
 *
 * ── Pure ──────────────────────────────────────────────────────────────────
 *
 * No database, no models, no clock, no network. It takes plain rows — whatever
 * loaded them — and returns plain rows. The backend hands it Mongoose lean
 * documents; the desktop hands it rows out of its local mirror; neither has to
 * tell this module which.
 */

const { CA_TYPE } = require("../caAssessment");

/**
 * Where an exam with no sequence number sits inside its term.
 *
 * A promotion exam, or a plain test a school created without binding it to a
 * sequence, is a real occasion and must not be dropped — a school that runs no
 * sequences at all would otherwise lose every result signal. It sorts AFTER the
 * numbered sequences of the same term, because that is when such a paper is sat.
 */
const UNSEQUENCED = 99;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Where one result sits in the school year.
 *
 * Read from the exam, which is authoritative for all three fields and the only
 * place sequenceNumber exists at all. The summary's own year and term are the
 * fallback for a summary whose exam has been deleted — rare, and dropping those
 * rows would silently narrow what a reader has always seen.
 *
 * @param {object} summary a ResultSummary-shaped row
 * @param {object|null} exam the Exam it belongs to, when known
 */
const occurrenceOf = (summary, exam) => ({
  academicYear: String(exam?.academicYear ?? summary.academicYear ?? ""),
  term:         Number(exam?.term ?? summary.term ?? 0) || 0,
  sequence:     exam?.sequenceNumber ?? UNSEQUENCED,
  startDate:    String(exam?.startDate ?? ""),
  // Tie-breakers, so the order is total and stable between loads. Two exams
  // genuinely sat on the same day in the same sequence are ordered by when they
  // were computed and then by id; neither is meaningful, both are fixed.
  createdAt:    summary.createdAt ? new Date(summary.createdAt).getTime() : 0,
  examId:       String(summary.examId ?? ""),
});

/** Oldest first. */
const byOccurrence = (a, b) =>
  cmp(a.occurrence.academicYear, b.occurrence.academicYear) ||
  (a.occurrence.term     - b.occurrence.term)     ||
  (a.occurrence.sequence - b.occurrence.sequence) ||
  cmp(a.occurrence.startDate, b.occurrence.startDate) ||
  (a.occurrence.createdAt - b.occurrence.createdAt) ||
  cmp(a.occurrence.examId, b.occurrence.examId);

/**
 * Published summaries → one ordered list per pupil, continuous assessment out.
 *
 * The caller decides WHICH summaries to hand over — published only, this school
 * only, these pupils only. That is a scoping question and it belongs to
 * whatever has the authorisation context, which this module deliberately does
 * not.
 *
 * @param {object[]} summaries ResultSummary-shaped rows
 * @param {object[]} exams     the Exams those rows name
 * @returns {Map<string, object[]>} studentId → rows, each with an `occurrence`
 */
const orderPublishedHistory = (summaries, exams) => {
  const examById = new Map((exams ?? []).map((e) => [String(e._id), e]));
  const history = new Map();

  for (const summary of summaries ?? []) {
    const exam = examById.get(String(summary.examId)) ?? null;

    // The whole point. A summary whose exam is a CA is half of a sequence, not
    // an occasion of its own. A summary whose exam is missing is kept, because
    // there is nothing to say it is a CA and dropping it would lose a result
    // the reader has always counted.
    if (exam && exam.type === CA_TYPE) continue;

    const id = String(summary.studentId);
    const row = { ...summary, occurrence: occurrenceOf(summary, exam) };
    const list = history.get(id);
    if (list) list.push(row);
    else history.set(id, [row]);
  }

  for (const list of history.values()) list.sort(byOccurrence);
  return history;
};

module.exports = {
  UNSEQUENCED,
  occurrenceOf,
  byOccurrence,
  orderPublishedHistory,
};
