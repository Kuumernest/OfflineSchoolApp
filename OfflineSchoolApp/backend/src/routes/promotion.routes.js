// backend/src/routes/promotion.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { requirePermission } = require("../../middleware/permissions");

const Class             = require("../db/models/Class");
const Enrollment        = require("../db/models/Enrollment");
const PromotionRun      = require("../db/models/PromotionRun");
const PromotionDecision = require("../db/models/PromotionDecision");

const promotion = require("../services/promotion.service");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const bad = (res, message, code) =>
  res.status(400).json({ success: false, code: code ?? "BAD_REQUEST", message });

/** Turns a thrown service error into its intended response. */
const fail = (res, err) =>
  res.status(err.status ?? 500).json({
    success: false,
    code:    err.code ?? "ERROR",
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  });

const YEAR = /^\d{4}[/-]\d{4}$/;

// Rolling the school over is the head's decision — not a teacher's, and not
// the bursar's. Promotion rewrites which class every child belongs to, which is
// the single most consequential academic act in the system, and promotion.run
// is non-delegable in consequence.
router.use(requirePermission("promotion.run"));

// ═════════════════════════════════════════════════════════════════════════════
// CLASS PROGRESSION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The progression map: which class leads to which.
 *
 * Kept here rather than under /admin/classes because it exists for promotion
 * and is meaningless without it.
 */
router.get("/progression", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await Class.find({ schoolId, deletedAt: null })
    .select("name level nextClassId isFinalYear")
    .sort({ name: 1 })
    .lean();

  return res.json({
    success: true,
    count:   rows.length,
    // A class that is neither final-year nor pointed anywhere will strand its
    // students at generate time, so it is flagged here where it can still be
    // fixed cheaply.
    incomplete: rows.filter((c) => !c.isFinalYear && !c.nextClassId).length,
    data: rows,
  });
}));

router.put("/progression", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { entries } = req.body;
  if (!Array.isArray(entries)) return bad(res, "entries must be an array");

  const ids = entries.map((e) => String(e.classId));
  const own = await Class.find({ _id: { $in: ids }, schoolId, deletedAt: null })
    .select("_id").lean();
  const ownIds = new Set(own.map((c) => String(c._id)));

  const stranger = ids.find((id) => !ownIds.has(id));
  if (stranger) {
    return res.status(404).json({
      success: false, code: "CLASS_NOT_FOUND",
      message: "One or more classes do not belong to this school",
    });
  }

  for (const e of entries) {
    const nextId = e.nextClassId ? String(e.nextClassId) : null;

    // A class that leads to itself would promote a whole year group into the
    // class it just left, which reads as a successful rollover and is not one.
    if (nextId && nextId === String(e.classId)) {
      return bad(res, "A class cannot lead to itself", "SELF_REFERENCE");
    }
    if (nextId && !ownIds.has(nextId) && !(await Class.exists({ _id: nextId, schoolId, deletedAt: null }))) {
      return res.status(404).json({
        success: false, code: "CLASS_NOT_FOUND",
        message: "A destination class does not belong to this school",
      });
    }

    await Class.updateOne(
      { _id: e.classId, schoolId },
      {
        nextClassId: e.isFinalYear ? null : nextId,
        isFinalYear: Boolean(e.isFinalYear),
      }
    );
  }

  const rows = await Class.find({ schoolId, deletedAt: null })
    .select("name level nextClassId isFinalYear").sort({ name: 1 }).lean();

  return res.json({ success: true, count: rows.length, data: rows });
}));

// ═════════════════════════════════════════════════════════════════════════════
// RUNS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/runs", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await PromotionRun.find({ schoolId, deletedAt: null })
    .sort({ createdAt: -1 }).lean();
  return res.json({ success: true, count: rows.length, data: rows });
}));

router.get("/runs/:runId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const run = await PromotionRun.findOne({
    _id: req.params.runId, schoolId, deletedAt: null,
  }).lean();
  if (!run) return res.status(404).json({ success: false, message: "Run not found" });

  const decisions = await PromotionDecision.find({
    runId: run._id, deletedAt: null,
  }).sort({ fromClassName: 1, studentName: 1 }).lean();

  return res.json({ success: true, data: { run, decisions } });
}));

// POST /api/promotion/runs   { fromYear, toYear }
router.post("/runs", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { fromYear, toYear } = req.body;
  if (!YEAR.test(String(fromYear || ""))) return bad(res, "fromYear must look like 2025/2026");
  if (!YEAR.test(String(toYear   || ""))) return bad(res, "toYear must look like 2026/2027");

  try {
    const result = await promotion.generateRun({
      schoolId, fromYear, toYear,
      generatedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({
      success: true,
      run: result.run,
      message: `${result.decisions.length} decision(s) drafted. Review them before committing.`,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false, code: "RUN_EXISTS",
        message: "A rollover for those years already exists. Reverse it before generating another.",
      });
    }
    return fail(res, err);
  }
}));

// PATCH /api/promotion/runs/:runId/decisions/:studentId   { outcome, toClassId }
router.patch("/runs/:runId/decisions/:studentId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { outcome, toClassId } = req.body;
  if (!["promoted", "repeated", "graduated"].includes(outcome)) {
    return bad(res, "outcome must be promoted, repeated or graduated");
  }

  try {
    const { decision, counts } = await promotion.setDecision({
      schoolId,
      runId:     req.params.runId,
      studentId: req.params.studentId,
      outcome,
      toClassId,
    });
    return res.json({ success: true, data: decision, counts });
  } catch (err) {
    return fail(res, err);
  }
}));

/**
 * Discard a draft.
 *
 * Without this a head who generates a rollover, spots that the progression map
 * is wrong, and fixes it is stuck: the unique index refuses a second run for the
 * same year pair, and the only escape is a reversal, which a draft cannot have
 * because it was never committed.
 *
 * Only a draft can be discarded. A committed run is history and is undone by
 * reversing it, which leaves both the run and its decisions on the record.
 */
router.delete("/runs/:runId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const run = await PromotionRun.findOne({
    _id: req.params.runId, schoolId, deletedAt: null,
  });
  if (!run) return res.status(404).json({ success: false, message: "Run not found" });

  if (run.status !== "draft") {
    return res.status(409).json({
      success: false, code: "NOT_DRAFT",
      // Told apart deliberately: "reverse it instead" is useless advice to
      // somebody looking at a run that has already been reversed.
      message: run.status === "committed"
        ? "A committed run cannot be discarded. Reverse it instead."
        : "This run has already been reversed. There is nothing left to discard.",
    });
  }

  await PromotionDecision.deleteMany({ runId: String(run._id) });
  await PromotionRun.deleteOne({ _id: run._id });

  return res.json({ success: true, discarded: true });
}));

router.post("/runs/:runId/commit", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const result = await promotion.commitRun({
      schoolId, runId: req.params.runId,
      committedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.json({ success: true, run: result.run, applied: result.applied });
  } catch (err) {
    return fail(res, err);
  }
}));

router.post("/runs/:runId/reverse", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const reason   = (req.body.reason || "").trim();
  if (!schoolId) return bad(res, "schoolId is required");
  if (!reason)   return bad(res, "A reason is required to reverse a rollover", "REASON_REQUIRED");

  try {
    const result = await promotion.reverseRun({
      schoolId, runId: req.params.runId, reason,
      reversedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.json({
      success: true, run: result.run,
      restored: result.restored,
      enrollmentsRemoved: result.enrollmentsRemoved,
    });
  } catch (err) {
    return fail(res, err);
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// HISTORY
// ═════════════════════════════════════════════════════════════════════════════

/** Where one student has sat, year by year. The basis of a transcript. */
router.get("/students/:studentId/history", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await Enrollment.find({
    schoolId, studentId: req.params.studentId, deletedAt: null,
  }).sort({ academicYear: 1 }).lean();

  return res.json({ success: true, count: rows.length, data: rows });
}));

module.exports = router;
