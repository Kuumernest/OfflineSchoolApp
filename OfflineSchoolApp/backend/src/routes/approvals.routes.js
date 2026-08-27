// backend/src/routes/approvals.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { requirePermission } = require("../../middleware/permissions");
const approvals   = require("../services/approvals.service");
const permissions = require("../services/permissions.service");
const School      = require("../db/models/School");

/**
 * What is waiting for a second signature.
 *
 * ── Two audiences, one list ───────────────────────────────────────────────
 *
 * A head teacher asks "what needs me". A bursar asks "what have I put up, and
 * has anybody looked at it yet". Same collection, and the scoping is by
 * capability rather than by a query parameter the client chooses: somebody who
 * can decide sees the school's queue, and somebody who can only raise sees
 * their own requests. A `?mine=true` flag would put that decision in the
 * client, where it is not a decision at all.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const bad = (res, message, code) =>
  res.status(400).json({ success: false, code: code ?? "BAD_REQUEST", message });

const fail = (res, err) =>
  res.status(err.status ?? 500).json({
    success: false,
    code:    err.code ?? "ERROR",
    message: err.message,
    // Set when the decision was recorded but the effect could not be applied.
    // The client has to say both things, so it has to be told both things.
    ...(err.decisionRecorded ? { decisionRecorded: true } : {}),
  });

const userId = (req) => (req.user?._id ? String(req.user._id) : null);

// Everything here needs at least the ability to see the queue.
router.use(requirePermission("approvals.view"));

const canDecide    = requirePermission("approvals.decide");
const canConfigure = requirePermission("approvals.configure");

// ═════════════════════════════════════════════════════════════════════════════
// THE QUEUE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/approvals?status=pending&kind=expense
 *
 * Scoped to the caller's own requests unless they can decide. `status=all`
 * returns the history, which is what makes this the audit trail rather than
 * just an inbox.
 */
router.get("/", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const decider = await permissions.can(req.user, "approvals.decide");

  const rows = await approvals.list({
    schoolId,
    status:      req.query.status ?? "pending",
    kind:        req.query.kind  ?? null,
    requestedBy: decider ? null : userId(req),
    limit:       req.query.limit,
  });

  return res.json({
    success: true,
    count:   rows.length,
    /** So the client knows whether to draw Approve buttons or a status column. */
    canDecide: decider,
    data:      rows,
  });
}));

/**
 * GET /api/approvals/summary
 *
 * The number for a dashboard tile, plus the thresholds in force so a screen can
 * explain why something did or did not need approval without a second call.
 */
router.get("/summary", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const decider = await permissions.can(req.user, "approvals.decide");

  const [pending, thresholds, mine] = await Promise.all([
    approvals.pendingCount(schoolId),
    approvals.thresholdsFor(schoolId),
    approvals.list({ schoolId, status: "pending", requestedBy: userId(req), limit: 500 }),
  ]);

  return res.json({
    success: true,
    data: {
      /** Everything waiting in the school. */
      pending,
      /** Of those, the ones this person raised — which they cannot decide. */
      mine: mine.length,
      canDecide: decider,
      thresholds,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// DECIDING
// ═════════════════════════════════════════════════════════════════════════════

const decide = (approve) => asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  // Required on a rejection, optional on an approval. Somebody whose refund was
  // refused is owed a reason; somebody whose refund went through does not need
  // to be told why it was fine.
  const note = req.body.note ? String(req.body.note).trim() : null;
  if (!approve && !note) {
    return bad(res, "A reason is required when rejecting a request", "NOTE_REQUIRED");
  }

  try {
    const { request, applied } = await approvals.decide({
      schoolId,
      requestId: req.params.id,
      approve,
      decidedBy: userId(req),
      note,
    });
    return res.json({ success: true, data: request, applied });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/:id/approve", canDecide, decide(true));
router.post("/:id/reject",  canDecide, decide(false));

/**
 * POST /api/approvals/:id/cancel
 *
 * Withdrawn by whoever raised it. Not gated by approvals.decide — taking back
 * your own request is not a decision about somebody else's work, and requiring
 * an administrator to un-ask a question would be silly.
 */
router.post("/:id/cancel", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const request = await approvals.cancel({
      schoolId,
      requestId: req.params.id,
      userId:    userId(req),
    });
    return res.json({ success: true, data: request });
  } catch (err) {
    return fail(res, err);
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// THRESHOLDS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/approvals/thresholds
 *
 * Null on a threshold means "never require approval for this", which is the
 * shipped default. Zero means "always" — a real setting, and the one a school
 * that wants every refund countersigned should use.
 */
router.put("/thresholds", canConfigure, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const asThreshold = (value, name) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      const err = new Error(`${name} must be a whole number of XAF, or empty for never`);
      err.code = "INVALID_AMOUNT";
      throw err;
    }
    return n;
  };

  let next;
  try {
    next = {
      expenseThreshold: asThreshold(req.body.expenseThreshold, "expenseThreshold"),
      refundThreshold:  asThreshold(req.body.refundThreshold,  "refundThreshold"),
      waiverThreshold:  asThreshold(req.body.waiverThreshold,  "waiverThreshold"),
      payrollRequired:  req.body.payrollRequired === true,
    };
  } catch (err) {
    return bad(res, err.message, err.code);
  }

  await School.updateOne(
    { _id: schoolId },
    { $set: { "settings.approvals": next } }
  );

  console.log(
    `🔐 approval thresholds set for ${schoolId} by ${req.user?.email ?? userId(req)}: ` +
    JSON.stringify(next)
  );

  return res.json({ success: true, data: approvals.resolveThresholds(next) });
}));

module.exports = router;
