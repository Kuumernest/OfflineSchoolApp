// backend/src/routes/insights.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authorize } = require("../../middleware/auth");
const earlyWarning  = require("../services/earlyWarning.service");

/**
 * Cross-cutting reads over data other modules write.
 *
 * Nothing here has a write route and nothing here owns a collection: this
 * router exists to answer questions that span attendance, results, homework
 * and fees at once — the questions a head teacher actually asks.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

// Office only, teachers excluded — the list names children by fee arrears,
// which is bursar knowledge, not staffroom knowledge. A per-class teacher
// view would first need the money signal stripped.
router.use(authorize("admin", "school_admin", "super_admin"));

/**
 * GET /api/insights/early-warning?days=30
 *
 * The watch list: students whose attendance, results, homework or fee record
 * says something is going wrong, each with the reasons spelled out.
 */
router.get("/early-warning", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId is required" });
  }

  // Clamped rather than rejected: a hand-typed ?days=900 means "a long time",
  // and 7..120 keeps the window inside a school year's worth of signal.
  const days = Math.max(7, Math.min(120,
    Number.parseInt(String(req.query.days ?? ""), 10) || earlyWarning.DEFAULT_WINDOW_DAYS
  ));

  return res.json({
    success: true,
    data: await earlyWarning.watchlist({ schoolId, days }),
  });
}));

module.exports = router;
