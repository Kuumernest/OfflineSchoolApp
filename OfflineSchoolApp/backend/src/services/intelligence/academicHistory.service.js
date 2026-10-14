// backend/src/services/intelligence/academicHistory.service.js
"use strict";

/**
 * Loading a pupil's published results. The ORDER they happened in is shared/.
 *
 * ── What is left here, and why ────────────────────────────────────────────
 *
 * Two queries and a projection. Everything that decides which rows count and
 * how they sort moved to shared/intelligence/academicOrder.js, because the
 * desktop has to reach the same answer from its own mirror when there is no
 * connection — and two implementations of "is this continuous assessment" or
 * "which sequence came first" would eventually disagree about the same child.
 *
 * What cannot move is this: knowing that the rows live in Mongo, that only
 * PUBLISHED ones may be read, and that the caller has already established which
 * school and which pupils it may ask about. That is application knowledge and
 * it stays in the application.
 *
 * ── Published only ────────────────────────────────────────────────────────
 *
 * The reason the watch list gave and it has not changed: an unpublished summary
 * is a draft nobody has signed off, and acting on it would use marks the school
 * has not issued.
 */

const Exam          = require("../../db/models/Exam");
const ResultSummary = require("../../db/models/ResultSummary");
const academicOrder = require("../../../../shared/intelligence/academicOrder");

/** The fields every caller needs. Enough to compare two occasions. */
const BASE_FIELDS =
  "studentId examId classId percentage average isPassing subjectsFailed " +
  "term academicYear createdAt";

/** subjectBreakdown as well — the per-subject marks, on the /20 scale. */
const SUBJECT_FIELDS = `${BASE_FIELDS} subjectBreakdown`;

/** Ordering fields off the exam. */
const EXAM_FIELDS = "type academicYear term sequenceNumber startDate";

/**
 * Published results per pupil, oldest first, continuous assessment excluded.
 *
 * @param   {object}   opts
 * @param   {string}   opts.schoolId
 * @param   {string[]} [opts.studentIds]   all pupils in the school when omitted
 * @param   {boolean}  [opts.withSubjects] load subjectBreakdown too. Off by
 *          default: the watch list reads a whole school and does not need it,
 *          and it is by far the largest field on the document.
 * @returns {Promise<Map<string, object[]>>} studentId → summaries, each with an
 *          added `occurrence`.
 */
const publishedHistory = async ({ schoolId, studentIds = null, withSubjects = false }) => {
  const filter = { schoolId, isPublished: true, deletedAt: null };
  if (studentIds) {
    if (!studentIds.length) return new Map();
    filter.studentId = { $in: studentIds };
  }

  const summaries = await ResultSummary.find(filter)
    .select(withSubjects ? SUBJECT_FIELDS : BASE_FIELDS)
    .lean();

  if (!summaries.length) return new Map();

  // Only the exams these summaries actually name. A school's exams are counted
  // in dozens, but scoping the read to the ids present keeps it that way for a
  // school with years of history and one pupil being looked at.
  const examIds = [...new Set(summaries.map((s) => String(s.examId)).filter(Boolean))];
  const exams = await Exam.find({ _id: { $in: examIds }, deletedAt: null })
    .select(EXAM_FIELDS)
    .lean();

  return academicOrder.orderPublishedHistory(summaries, exams);
};

module.exports = {
  publishedHistory,
  BASE_FIELDS,
  SUBJECT_FIELDS,
  // Re-exported from shared so existing callers and checks keep one import,
  // and so nothing is tempted to grow a second copy of the ordering rule here.
  occurrenceOf: academicOrder.occurrenceOf,
  byOccurrence: academicOrder.byOccurrence,
  UNSEQUENCED:  academicOrder.UNSEQUENCED,
};
