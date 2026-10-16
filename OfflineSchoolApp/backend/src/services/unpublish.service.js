// backend/src/services/unpublish.service.js
"use strict";

/**
 * Unpublishing a class's results: its sequence results for one exam, its
 * term results for one term, or its annual results for one year (decided by
 * the project owner, 2026-10-16, docs/41 §7).
 *
 * A published result is never recalculated (docs/39 §21.1, D3): the refusal
 * says "unpublish first", and this is how. Unpublishing is the deliberate,
 * visible act, so it needs a reason and leaves a record:
 *
 *   - only isPublished and publishedAt change. Figures, positions and
 *     calcVersion stay exactly as they are;
 *   - report cards already issued stay as issued (GeneratedReport is frozen
 *     at first issue); the answer says so;
 *   - an AuditLog row ("results.unpublished") with the counts before and
 *     after and the reason; a sequence also gets a ResultChangeLog row, the
 *     exam's own history (that log is per exam, so term and annual results,
 *     which belong to no exam, are recorded in the AuditLog only);
 *   - a year's annual results are not unpublished while a promotion run for
 *     that year is draft or committed: the run was made from them.
 *
 * Each function answers { status, body } for the route to send.
 */

const ResultSummary = require("../db/models/ResultSummary");
const TermResult    = require("../db/models/TermResult");
const AnnualResult  = require("../db/models/AnnualResult");
const Exam          = require("../db/models/Exam");
const Class         = require("../db/models/Class");
const PromotionRun  = require("../db/models/PromotionRun");
const { recordAudit } = require("./audit.service");
const { logResultChange } = require("./resultAudit.service");

const ISSUED_NOTE =
  "Report cards already issued stay as issued. Reissue a card if it must change after the results are recalculated.";

const refuse = (status, code, message, extra = {}) => ({ status, body: { success: false, code, error: message, ...extra } });

/** The checks every layer shares: a reason, a class, the class in the school. */
const common = async ({ schoolId, classId, reason }) => {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) return { refusal: refuse(400, "REASON_REQUIRED", "Give a reason for unpublishing.") };
  if (!classId) return { refusal: refuse(400, "CLASS_REQUIRED", "classId is required: results are unpublished one class at a time.") };
  const cls = await Class.findOne({ _id: String(classId), schoolId, deletedAt: null }).select("_id name").lean();
  if (!cls) return { refusal: refuse(404, "CLASS_NOT_FOUND", "Class not found") };
  return { why, cls };
};

const done = (layer, unpublished, extra = {}) => ({
  status: 200,
  body: { success: true, layer, unpublished, issuedCardsUnchanged: true, note: ISSUED_NOTE, ...extra },
});

/** A class's sequence results for one exam. */
async function unpublishSequence(req, { schoolId, examId, classId, reason }) {
  const c = await common({ schoolId, classId, reason });
  if (c.refusal) return c.refusal;
  const exam = await Exam.findOne({ _id: String(examId), schoolId, deletedAt: null }).select("_id name").lean();
  if (!exam) return refuse(404, "EXAM_NOT_FOUND", "Exam not found");

  const filter = { examId: String(examId), schoolId, classId: String(classId), deletedAt: null };
  const before = await ResultSummary.countDocuments({ ...filter, isPublished: true });
  const { modifiedCount } = await ResultSummary.updateMany(
    { ...filter, isPublished: true },
    { $set: { isPublished: false, publishedAt: null } }
  );

  // The exam agrees with its results. "published" is every result out, so
  // once any class is unpublished the exam is back to completed and the
  // exam screen offers Publish again (which publishes the class back).
  // resultsPublished says whether any result is still out.
  const still = await ResultSummary.countDocuments({ examId: String(examId), schoolId, deletedAt: null, isPublished: true });
  if (modifiedCount > 0) {
    await Exam.updateOne(
      { _id: String(examId), schoolId, status: "published" },
      { $set: { status: "completed" } }
    );
    await Exam.updateOne(
      { _id: String(examId), schoolId },
      { $set: still > 0 ? { resultsPublished: true } : { resultsPublished: false, resultsPublishedAt: null } }
    );
  }

  const actor = { id: req.user?._id ? String(req.user._id) : null, name: req.user?.name || null, role: req.user?.role || null };
  await logResultChange({ examId: String(examId), schoolId, reason: c.why, isOverride: false, actor }, {
    entity: "exam", entityId: String(examId), action: "unpublished", field: "isPublished",
    oldValue: { classId: String(classId), published: before }, newValue: { classId: String(classId), published: before - modifiedCount },
  });
  await recordAudit(req, {
    action: "results.unpublished", schoolId,
    resource: { type: "sequence", id: String(examId), label: `${exam.name ?? examId} · ${c.cls.name ?? classId}` },
    before: { published: before }, after: { published: before - modifiedCount }, reason: c.why,
  });
  return done("sequence", modifiedCount, { examId: String(examId), classId: String(classId), examStillPublished: still > 0 });
}

/** A class's term results for one term. */
async function unpublishTerm(req, { schoolId, academicYear, term, classId, reason }) {
  const c = await common({ schoolId, classId, reason });
  if (c.refusal) return c.refusal;
  if (!academicYear) return refuse(400, "YEAR_REQUIRED", "academicYear is required");
  if (!(Number.isInteger(Number(term)) && Number(term) >= 1)) return refuse(400, "BAD_TERM", "term must be a positive integer");

  const filter = { schoolId, academicYear: String(academicYear), term: Number(term), classId: String(classId), deletedAt: null, isPublished: true };
  const before = await TermResult.countDocuments(filter);
  const { modifiedCount } = await TermResult.updateMany(filter, { $set: { isPublished: false, publishedAt: null } });

  await recordAudit(req, {
    action: "results.unpublished", schoolId,
    resource: { type: "term", id: `${academicYear}|${term}|${classId}`, label: `${academicYear} · term ${term} · ${c.cls.name ?? classId}` },
    before: { published: before }, after: { published: before - modifiedCount }, reason: c.why,
  });
  return done("term", modifiedCount, { academicYear: String(academicYear), term: Number(term), classId: String(classId) });
}

/** A class's annual results for one year; refused while a promotion run for the year stands. */
async function unpublishAnnual(req, { schoolId, academicYear, classId, reason }) {
  const c = await common({ schoolId, classId, reason });
  if (c.refusal) return c.refusal;
  if (!academicYear) return refuse(400, "YEAR_REQUIRED", "academicYear is required");

  const run = await PromotionRun.findOne({
    schoolId, fromYear: String(academicYear), status: { $in: ["draft", "committed"] }, deletedAt: null,
  }).select("_id status").lean();
  if (run) {
    return refuse(409, "PROMOTION_RUN_EXISTS",
      `A ${run.status} promotion run for ${academicYear} was made from these results. ` +
      (run.status === "draft" ? "Discard the draft first." : "Reverse the run first."),
      { runId: String(run._id), runStatus: run.status });
  }

  const filter = { schoolId, academicYear: String(academicYear), classId: String(classId), deletedAt: null, isPublished: true };
  const before = await AnnualResult.countDocuments(filter);
  const { modifiedCount } = await AnnualResult.updateMany(filter, { $set: { isPublished: false, publishedAt: null } });

  await recordAudit(req, {
    action: "results.unpublished", schoolId,
    resource: { type: "annual", id: `${academicYear}|${classId}`, label: `${academicYear} · ${c.cls.name ?? classId}` },
    before: { published: before }, after: { published: before - modifiedCount }, reason: c.why,
  });
  return done("annual", modifiedCount, { academicYear: String(academicYear), classId: String(classId) });
}

module.exports = { unpublishSequence, unpublishTerm, unpublishAnnual, ISSUED_NOTE };
