// backend/src/services/deletedExams.service.js
"use strict";

/**
 * A deleted exam's marks are not results.
 *
 * Deleting an exam only stamps deletedAt on the Exam; its ResultSummary and
 * StudentScore rows stay live. Every reader that goes to those rows directly
 * — the portal, transcripts, a teacher's class results, intelligence review
 * and class analysis — would otherwise still read them as results. They all
 * drop them through this one function.
 *
 * A row whose exam row is missing altogether is kept, as
 * shared/intelligence/academicOrder does: absence of the exam is not proof it
 * was deleted.
 */

const Exam = require("../db/models/Exam");

/**
 * Drop the rows (anything with an `examId`) whose exam is soft-deleted.
 *
 * @param {string}   schoolId
 * @param {object[]} rows
 * @returns {Promise<object[]>} the same rows, in order, minus a deleted exam's
 */
async function withoutDeletedExams(schoolId, rows) {
  if (!rows?.length) return rows ?? [];
  const ids = [...new Set(rows.map((r) => r.examId).filter(Boolean).map(String))];
  if (!ids.length) return rows;
  const filter = { _id: { $in: ids }, deletedAt: { $ne: null } };
  if (schoolId) filter.schoolId = String(schoolId);
  const deleted = await Exam.find(filter).select("_id").lean();
  if (!deleted.length) return rows;
  const gone = new Set(deleted.map((e) => String(e._id)));
  return rows.filter((r) => !gone.has(String(r.examId)));
}

module.exports = { withoutDeletedExams };
