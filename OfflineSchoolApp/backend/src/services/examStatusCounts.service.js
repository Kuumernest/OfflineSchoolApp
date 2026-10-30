// backend/src/services/examStatusCounts.service.js
"use strict";

/**
 * Exams counted by status — the one count the dashboard and the exams page
 * both show.
 *
 * Each endpoint used to run its own countDocuments per status, and the
 * dashboard's (/admin/exams/stats) named only four of the six. A school whose
 * exams were all published saw "Total 2" over a bar of 0% segments: the total
 * counted every exam, the segments only the statuses someone had listed.
 *
 * So the statuses come from the model's own enum, the counts from one
 * grouping, and the total is their sum — a status added to the model is
 * counted everywhere, and the parts always add up to the whole.
 */

const Exam = require("../db/models/Exam");

/** draft, scheduled, ongoing, completed, published, archived — in lifecycle order. */
const EXAM_STATUSES = Exam.schema.path("status").enumValues;

/**
 * @param {object} match  The filter, e.g. { schoolId, deletedAt: null }. Its
 *                        values must already be the stored types: an
 *                        aggregate does not cast the way countDocuments does.
 * @returns {Promise<{ total: number } & Record<string, number>>}
 *          A count for every status (0 when none), and `total`.
 */
async function countExamsByStatus(match) {
  const rows = await Exam.aggregate([
    { $match: match },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);

  const counts = Object.fromEntries(EXAM_STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const { _id, n } of rows) {
    total += n;
    // A row with no status, or one written before a status was retired,
    // still counts in the total; it is reported apart rather than dropped.
    if (_id in counts) counts[_id] += n;
    else counts.other = (counts.other ?? 0) + n;
  }
  return { total, ...counts };
}

module.exports = { countExamsByStatus, EXAM_STATUSES };
