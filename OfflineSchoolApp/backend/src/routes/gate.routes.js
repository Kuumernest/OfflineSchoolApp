// backend/src/routes/gate.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authorize } = require("../../middleware/auth");
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
 * Staff only, and teachers are included: the person on the gate in the morning
 * is usually a teacher on duty, not an administrator.
 */
router.use(authorize("admin", "school_admin", "super_admin", "teacher"));

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
    const result = await gate.scan({
      schoolId,
      token:     req.body.token,
      at:        req.body.at,
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
        _id:  String(result.student._id),
        name: result.student.studentName
              ?? [result.student.firstName, result.student.lastName].filter(Boolean).join(" ")
              ?? null,
        enrollmentNo: result.student.enrollmentNo ?? null,
      },
      direction: result.direction,
      at:        result.event.at,
      duplicate: result.duplicate,
      notified:  Boolean(result.notification && result.notification.status !== "skipped"),
      notifySkipped: result.notification?.skipReason ?? null,
    });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "SCAN_FAILED", message: err.message,
    });
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
  authorize("admin", "school_admin", "super_admin"),
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
  authorize("admin", "school_admin", "super_admin"),
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.body.schoolId);
    return res.json({ success: true, ...(await notify.dispatch({ schoolId })) });
  })
);

module.exports = router;
