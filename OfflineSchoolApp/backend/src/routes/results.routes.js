// backend/src/routes/results.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authenticate, authorize } = require("../../middleware/auth");
const ctrl                        = require("../controllers/results.controller");

// ── Apply authenticate to ALL routes ─────────────────────
router.use(authenticate);

// ── Role shorthand ────────────────────────────────────────
const adminOrTeacher = authorize("admin", "school_admin", "teacher");
const adminOnly      = authorize("admin", "school_admin");

// ── Read routes ───────────────────────────────────────────

// All results for an exam
router.get("/:examId",                                adminOrTeacher, ctrl.getExamResults);

// Aggregate stats (pass rate, averages, grade distribution)
router.get("/:examId/stats",                          adminOrTeacher, ctrl.getExamStats);

// Rankings — ?rankBy=class|grade|school
router.get("/:examId/rankings",                       adminOrTeacher, ctrl.getExamRankings);

// Single student result
router.get("/:examId/student/:studentId",             adminOrTeacher, ctrl.getStudentResult);

// Change history for an exam — ?studentId= ?subjectId= ?overridesOnly=1
// Admin-only: it names who changed what, which is not a teacher's business.
router.get("/:examId/history",                        adminOnly,      ctrl.getResultHistory);

// Full report card (scores + summary + positions)
router.get(
  "/:examId/student/:studentId/reportcard",
  adminOrTeacher,
  ctrl.getStudentReportCard
);

// Printable HTML — single shared rendering engine (web batch print + mobile PDF)
router.get(
  "/:examId/student/:studentId/reportcard/html",
  adminOrTeacher,
  ctrl.getStudentReportCardHtml
);

// ── Write routes ──────────────────────────────────────────

// (Re)calculate a student's report card from raw subject scores
router.post(
  "/:examId/student/:studentId/reportcard/calculate",
  adminOrTeacher,
  ctrl.calculateStudentReportCard
);

// Upsert a single score
router.post("/score",                                 adminOrTeacher, ctrl.upsertScore);

// Publish / unpublish a single result summary
router.put("/summary/:summaryId/publish",             adminOnly,      ctrl.publishResult);

// Soft-delete a score
router.delete("/score/:scoreId",                      adminOnly,      ctrl.deleteScore);

// ── Error handler ─────────────────────────────────────────
router.use((err, req, res, next) => {
  console.error("❌ results.routes error:", err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

module.exports = router;