// backend/src/services/actionItems.service.js
"use strict";

/**
 * Things waiting on somebody, for the notification panel (C11).
 *
 * Not stored notifications: each is counted live from the records, so an item
 * disappears the moment the work is done — nobody has to mark a reminder read
 * after approving the marks it was about. Each kind is shown only to a reader
 * who can act on it, by the same permission the action itself checks:
 *
 *   marksAwaitingApproval   ExamSubject submitted, not approved   exams.manage
 *   resultsUnpublished      results processed, not published      results.publish
 *   overdueFees             families behind on a due date         fees.view
 *                           (feeReminders.candidates, overdue — the same rule
 *                           as Fee reminders and Students to watch, C6)
 */

const Exam          = require("../db/models/Exam");
const ExamSubject   = require("../db/models/ExamSubject");
const ResultSummary = require("../db/models/ResultSummary");
const { candidates } = require("./feeReminders.service");

/** One exam → its own page; several → the list. */
const linkFor = (examIds, tab) =>
  examIds.length === 1 ? `/exams/${examIds[0]}?tab=${tab}` : "/exams";

/**
 * @param {object} p
 * @param {string} p.schoolId
 * @param {{marks?: boolean, publish?: boolean, fees?: boolean}} p.can
 * @param {Date}   [p.asOf]
 * @returns {Promise<Array<{key, count, link, amount?}>>} only non-zero items
 */
const actionItemsFor = async ({ schoolId, can, asOf = new Date() }) => {
  const live = { schoolId, deletedAt: null };

  const [submitted, processed, overdue] = await Promise.all([
    can.marks
      ? ExamSubject.find({ ...live, submissionStatus: "submitted" }).select("examId").lean()
      : [],
    can.publish
      ? ResultSummary.distinct("examId", { ...live, isPublished: { $ne: true } })
      : [],
    can.fees ? candidates({ schoolId, mode: "overdue", asOf }) : [],
  ]);

  // Processed but unpublished, on an exam that still exists and is not out.
  const unpublished = processed.length
    ? (await Exam.find({ _id: { $in: processed }, ...live, resultsPublished: { $ne: true } })
        .select("_id").lean()).map((e) => String(e._id))
    : [];

  const items = [];
  if (submitted.length) {
    const examIds = [...new Set(submitted.map((s) => String(s.examId)))];
    items.push({ key: "marksAwaitingApproval", count: submitted.length, exams: examIds.length,
      link: linkFor(examIds, "marks") });
  }
  if (unpublished.length) {
    items.push({ key: "resultsUnpublished", count: unpublished.length,
      link: linkFor(unpublished, "results") });
  }
  if (overdue.length) {
    items.push({ key: "overdueFees", count: overdue.length,
      amount: overdue.reduce((sum, r) => sum + (r.balance || 0), 0), link: "/fees" });
  }
  return items;
};

module.exports = { actionItemsFor };
