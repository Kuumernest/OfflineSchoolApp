// backend/src/routes/results.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authenticate, authorize } = require("../../middleware/auth");
const ctrl                        = require("../controllers/results.controller");
const { requirePermission } = require("../../middleware/permissions");

// ── Apply authenticate to ALL routes ─────────────────────
router.use(authenticate);

// ── Role shorthand ────────────────────────────────────────
//
// Three guards, not two, because "may look at a result" and "may change one"
// are different questions and were previously answered by the same list.
//
//   readRoles      every member of staff, bursar included. A bursar chasing
//                  arrears is told which children are doing badly, and that is
//                  a look, not a licence.
//   adminOrTeacher whoever may enter or recalculate a mark. The bursar is
//                  deliberately absent: the person taking the money must never
//                  be able to move the grade of the child who paid it.
//   adminOnly      publishing, deleting, reissuing an already-issued card, and
//                  reading who changed what.
//
// All three now come from the shared sets, which also fixes a live bug: both
// lists said "admin" — a string no account can hold, since the User enum has
// never included it — and neither said "super_admin". A super admin was
// therefore 403'd out of every results route in the system.
// results.edit and results.publish are both non-delegable. This is the single
// most important pair of locks in the registry: a school can hand the bursar
// almost anything, and cannot hand them the ability to move a mark.
const readRoles      = requirePermission("results.view");
const adminOrTeacher = requirePermission("results.edit");
const adminOnly      = requirePermission("results.publish");

// ── Read routes ───────────────────────────────────────────

// All results for an exam
router.get("/:examId",                                readRoles,      ctrl.getExamResults);

// Aggregate stats (pass rate, averages, grade distribution)
router.get("/:examId/stats",                          readRoles,      ctrl.getExamStats);

// Rankings — ?rankBy=class|grade|school
router.get("/:examId/rankings",                       readRoles,      ctrl.getExamRankings);

// Single student result
router.get("/:examId/student/:studentId",             readRoles,      ctrl.getStudentResult);

// Change history for an exam — ?studentId= ?subjectId= ?overridesOnly=1
// Admin-only: it names who changed what, which is not a teacher's business.
router.get("/:examId/history",                        adminOnly,      ctrl.getResultHistory);

// Full report card (scores + summary + positions)
router.get(
  "/:examId/student/:studentId/reportcard",
  readRoles,
  ctrl.getStudentReportCard
);

// Printable HTML — single shared rendering engine (web batch print + mobile PDF)
router.get(
  "/:examId/student/:studentId/reportcard/html",
  readRoles,
  ctrl.getStudentReportCardHtml
);

// ── Write routes ──────────────────────────────────────────

// (Re)calculate a student's report card from raw subject scores
router.post(
  "/:examId/student/:studentId/reportcard/calculate",
  adminOrTeacher,
  ctrl.calculateStudentReportCard
);

// Replace the frozen copy of an already-issued card, after a correction.
// Admin-only: it supersedes a document a parent may already hold.
router.post(
  "/:examId/student/:studentId/reportcard/reissue",
  adminOnly,
  ctrl.reissueStudentReportCard
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