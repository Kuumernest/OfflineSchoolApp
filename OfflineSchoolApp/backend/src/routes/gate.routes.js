// backend/src/routes/gate.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { requirePermission } = require("../../middleware/permissions");
const gate   = require("../services/gate.service");
const notify = require("../services/notification");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const bad = (res, message, code) =>
  res.status(400).json({ success: false, code: code ?? "BAD_REQUEST", message });

/**
 * The gate.
 *
 * Teachers are included: the person on the gate in the morning is usually a
 * teacher on duty, not an administrator. The bursar is not — arrivals and
 * departures are a safeguarding record, and nothing about collecting fees
 * needs it.
 */
// Delegable, and this is the clearest case for it: in a small school the person
// on the gate at eight in the morning is whoever is standing there, and gate.scan
// is exactly the sort of capability a head should be able to hand the bursar
// without also handing them the register.
router.use(requirePermission("gate.scan"));

/** Reissuing a card and flushing the notification queue are office decisions. */
const officeOnly = requirePermission("gate.manage");

/**
 * Fee compliance at the gate: read-only, and separate from gate.scan so a
 * school can let someone record arrivals without seeing any money at all.
 */
const canVerify = requirePermission("gate.verify");

/** Gate passes: administrators only, never delegable (config/permissions.js). */
const canAuthorize = requirePermission("gate.authorize");

const mayVerify = async (req) =>
  require("../services/permissions.service").can(req.user, "gate.verify");

const fail = (res, err) =>
  res.status(err.status ?? 500).json({ success: false, code: err.code ?? "FAILED", message: err.message });

/**
 * POST /api/gate/scan   { token, at?, station? }
 *
 * `at` is accepted so a gate device that was offline can send this morning's
 * scans this afternoon with the times they actually happened. The server keeps
 * its own receivedAt alongside, so a device with a wrong clock is detectable
 * rather than silently authoritative.
 */
router.post("/scan", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const verify = await mayVerify(req);
    const result = await gate.scan({
      schoolId,
      // A forgotten card: the pupil the operator found by name.
      studentId: req.body.studentId ? String(req.body.studentId).trim() : null,
      // What the device showed the operator (shared/compliance.js), kept for
      // the audit beside the server's own answer. Only from a caller who may
      // see compliance at all.
      verification: verify ? req.body.verification ?? null : null,
      verify,
      // The scanning device's id for this event. A replay of a scan the server
      // already recorded — the response was lost, the phone tried again — must
      // answer with that event, not record a second one and message the
      // guardian twice. See scan() in services/gate.service.js.
      id:        req.body._id ? String(req.body._id).trim() : null,
      token:     req.body.token,
      at:        req.body.at,
      direction: req.body.direction,
      station:   req.body.station,
      scannedBy: req.user?._id ? String(req.user._id) : null,
      // A school can turn the messages off without turning the gate off.
      notifyGuardian: req.body.notify !== false,
    });

    return res.json({
      success: true,
      // The gate screen shows this straight back to the operator, so it carries
      // the name — a token echoed back would tell them nothing.
      student: {
        ...(await gate.studentCard(result.student)),
        _id:  String(result.student._id),
        name: result.student.studentName
              ?? [result.student.firstName, result.student.lastName].filter(Boolean).join(" ")
              ?? null,
        enrollmentNo: result.student.enrollmentNo ?? null,
      },
      method:    result.event?.method ?? "card",
      // The server's fee verification — only for gate.verify. A replay or a
      // debounced double-beep made none, so it is computed for the answer.
      compliance: verify
        ? (result.compliance ?? await require("../services/compliance.service")
            .complianceFor({ schoolId, studentId: String(result.student._id) }).catch(() => null))
        : undefined,
      direction: result.direction,
      at:        result.event.at,
      duplicate: result.duplicate,
      // True when this request repeated a scan the server had already
      // recorded under the same id — the retry path, not a second event.
      replay:    Boolean(result.replay),
      notified:  Boolean(result.notification && result.notification.status !== "skipped"),
      notifySkipped: result.notification?.skipReason ?? null,
      // Why no message went, when none did — "arrived on time" is an answer,
      // an empty field is a worry.
      notifyReason:  result.notifyPolicy?.reason ?? null,
      // The decision itself, separate from what came of it.
      //
      // `notified` above is false for two unrelated reasons — the school does
      // not email on-time arrivals, or this family has no address — and the
      // operator screen was left to guess which. It also now means something
      // narrower than it used to: every scan is recorded whatever this says,
      // so "not notified" no longer implies "not written down".
      notifyPolicy:  result.notifyPolicy ?? null,
      recorded:      Boolean(result.notification),
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "SCAN_FAILED", message: err.message,
    });
  }
}));

/**
 * GET /api/gate/roster — every card this school can recognise.
 *
 * A gate device holds this so it can turn a QR token into a child's NAME with
 * no signal. Without it an offline scanner could record the event but not show
 * who it was, which is the one thing the person on the gate needs to see.
 *
 * It is a list of gate tokens, so it is only useful to a device that can
 * already read the cards — staff-only, like the rest of this router.
 */
router.get("/roster", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const Student = require("../db/models/Student");
  const Class   = require("../db/models/Class");
  const { displayName } = require("../utils/studentName");

  const rows = await Student.find({
    schoolId, status: "approved", deletedAt: null, gateToken: { $ne: null },
  }).select("studentName name firstName lastName enrollmentNo classId gateToken photoUrl").lean();

  const classes = await Class.find({ schoolId, deletedAt: null }).select("name").lean();
  const className = new Map(classes.map((c) => [String(c._id), c.name]));

  return res.json({
    success: true,
    count: rows.length,
    data: rows.map((s) => ({
      token:        s.gateToken,
      studentId:    String(s._id),
      name:         displayName(s) || null,
      enrollmentNo: s.enrollmentNo ?? null,
      className:    s.classId ? (className.get(String(s.classId)) ?? null) : null,
      // The stored path; the device fetches the file with its own token.
      photoUrl:     s.photoUrl ?? null,
    })),
  });
}));

/**
 * GET /api/gate/snapshot — everything a gate device needs to verify pupils
 * offline (services/gate.service.js snapshot). Replaced whole on each pull.
 */
router.get("/snapshot", canVerify, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  return res.json({ success: true, data: await gate.snapshot({ schoolId }) });
}));

/** GET /api/gate/search?q= — manual lookup by name or admission number. */
router.get("/search", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  return res.json({ success: true, data: await gate.search({ schoolId, q: req.query.q, limit: req.query.limit }) });
}));

/** GET /api/gate/verify/:studentId — one pupil's card and compliance, without recording a passage. */
router.get("/verify/:studentId", canVerify, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  try {
    return res.json({ success: true, data: await gate.verifyStudent({ schoolId, studentId: req.params.studentId }) });
  } catch (err) {
    return fail(res, err);
  }
}));

/**
 * GET /api/gate/history?studentId=&limit= — recent verifications, newest
 * first, with the status each one showed. Fee figures only for gate.verify.
 */
router.get("/history", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  const rows = await gate.history({ schoolId, studentId: req.query.studentId, limit: req.query.limit });
  const verify = await mayVerify(req);
  return res.json({
    success: true,
    data: verify ? rows : rows.map(({ verification, serverVerification, ...rest }) => rest),
  });
}));

// ── Gate authorizations ────────────────────────────────────────────────────

/** GET /api/gate/authorizations?studentId=&current=1 — seen by the gate, issued by the office. */
router.get("/authorizations", canVerify, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  return res.json({
    success: true,
    data: await gate.listAuthorizations({
      schoolId, studentId: req.query.studentId,
      current: req.query.current === "1" || req.query.current === "true",
    }),
  });
}));

/** POST /api/gate/authorizations { studentId, validFrom?, validUntil, reason } */
router.post("/authorizations", canAuthorize, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  try {
    const data = await gate.authorize({
      schoolId,
      studentId:  req.body.studentId,
      validFrom:  req.body.validFrom,
      validUntil: req.body.validUntil,
      reason:     req.body.reason,
      grantedBy:  req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    return fail(res, err);
  }
}));

/** POST /api/gate/authorizations/:id/revoke { reason } */
router.post("/authorizations/:id/revoke", canAuthorize, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");
  try {
    const data = await gate.revokeAuthorization({
      schoolId, id: req.params.id, reason: req.body.reason,
      revokedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return fail(res, err);
  }
}));

/** GET /api/gate/today — the day's log and who is currently on site. */
router.get("/today", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  return res.json({
    success: true,
    data: await gate.today({ schoolId, date: req.query.date }),
  });
}));

/**
 * POST /api/gate/token/:studentId — reissue, cancelling the previous card.
 *
 * Office-only: reissuing invalidates a card a child may be carrying, which is
 * not something to do from the gate by accident.
 */
router.post(
  "/token/:studentId",
  officeOnly,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.body.schoolId);
    if (!schoolId) return bad(res, "schoolId is required");

    try {
      const token = await gate.issueToken({ schoolId, studentId: req.params.studentId });
      // The token itself is returned so the caller can print immediately, but
      // it is the QR on the card that matters — this is not a secret to store.
      return res.json({ success: true, token, reprintRequired: true });
    } catch (err) {
      return res.status(err.status ?? 500).json({ success: false, message: err.message });
    }
  })
);

/**
 * POST /api/gate/dispatch — send whatever the queue is holding.
 *
 * Exposed so a school can flush notifications the moment a connection returns
 * rather than waiting for the timer, which is the offline case this whole
 * design exists for.
 */
router.post(
  "/dispatch",
  officeOnly,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.body.schoolId);
    return res.json({ success: true, ...(await notify.dispatch({ schoolId })) });
  })
);

module.exports = router;
