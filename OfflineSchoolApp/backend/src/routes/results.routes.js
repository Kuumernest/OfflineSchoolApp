// backend/src/routes/results.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authenticate } = require("../../middleware/auth");
const ctrl                        = require("../controllers/results.controller");
const ResultSummary = require("../db/models/ResultSummary");
const Exam          = require("../db/models/Exam");
const Student       = require("../db/models/Student");

// Same one-liner exam.routes.js uses: forward a rejected promise to the
// error handler instead of leaving the request hanging.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
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

// ── A pupil's own results ─────────────────────────────────────────────────
//
// GET /api/results/my-results
//
// Every route below this one is gated on results.view, which a student does
// not have and must not be given: results.view opens GET /results/:examId,
// which answers with the whole cohort, and /rankings, which orders it. A
// pupil reading their own mark and a pupil reading everyone's are not the
// same permission and were never going to be.
//
// So the pupil route asks a different question — "what are MY published
// results" — and the answer cannot name anybody else. No permission check,
// because there is nothing here to be permitted to: the scope is the caller.
//
// Two things it will not do:
//
//   • It resolves the caller's own student ids and fails CLOSED. If it
//     cannot establish who they are it answers with an empty list, never
//     with everybody's.
//   • It reads only summaries where isPublished is true. Publishing is what
//     the school does when it decides the marks may be seen; a computed but
//     unpublished result is not a result yet.
//
// It is also one request. The screen it serves was fetching the exam list and
// then one result per exam per candidate id, which is a request per exam on a
// connection this app spends its life apologising for.
router.get("/my-results", asyncHandler(async (req, res) => {
  const userId   = req.user?._id || req.user?.id;
  const schoolId = req.query.schoolId || req.user?.schoolId;

  if (!userId)   return res.status(401).json({ success: false, message: "Not signed in" });
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });

  // Who this account is, as far as the Student collection is concerned. A
  // pupil may be keyed by userId, user_id, authId, or be the student row
  // itself — the same four the attendance router resolves.
  const candidates = new Set([String(userId)]);
  try {
    const rows = await Student.find({
      schoolId,
      $or: [
        { userId:  String(userId) },
        { user_id: String(userId) },
        { authId:  String(userId) },
        { _id:     String(userId) },
      ],
    }).select("_id userId user_id authId").lean();

    for (const s of rows) {
      for (const v of [s._id, s.userId, s.user_id, s.authId]) {
        if (v) candidates.add(String(v));
      }
    }
  } catch (err) {
    // Fail closed. An identity we could not establish shows nothing, rather
    // than falling through to a query with no studentId filter at all.
    console.error("[results] my-results identity lookup failed:", err.message);
    return res.json({ success: true, count: 0, data: [] });
  }

  const summaries = await ResultSummary.find({
    schoolId,
    studentId:   { $in: [...candidates] },
    isPublished: true,
    deletedAt:   null,
  }).sort({ publishedAt: -1 }).lean();

  if (!summaries.length) return res.json({ success: true, count: 0, data: [] });

  // The exam names, in one query rather than one per summary.
  const examIds = [...new Set(summaries.map((s) => String(s.examId)))];
  const exams   = await Exam.find({ _id: { $in: examIds }, schoolId })
    .select("_id name type academicYear term startDate")
    .lean();
  const examById = new Map(exams.map((e) => [String(e._id), e]));

  const data = summaries.map((s) => {
    const exam = examById.get(String(s.examId)) ?? null;
    return {
      _id:              s._id,
      examId:           s.examId,
      studentId:        s.studentId,
      examName:         exam?.name ?? "Examination",
      examType:         exam?.type ?? null,
      academicYear:     s.academicYear ?? exam?.academicYear ?? null,
      term:             s.term ?? exam?.term ?? null,
      className:        s.className ?? null,
      totalScore:       s.totalScore ?? 0,
      maxTotalScore:    s.maxTotalScore ?? 0,
      percentage:       s.percentage ?? 0,
      average:          s.average ?? 0,
      overallGrade:     s.overallGrade ?? null,
      overallRemark:    s.overallRemark ?? null,
      isPassing:        s.isPassing ?? null,
      subjectsPassed:   s.subjectsPassed ?? 0,
      subjectsFailed:   s.subjectsFailed ?? 0,
      subjectsTotal:    s.subjectsTotal ?? 0,
      subjectBreakdown: s.subjectBreakdown ?? [],
      // Rank is included, after checking what this school actually does with
      // it rather than assuming. The parent portal returns classPosition and
      // totalInClass, and the report card prints a position per subject — so a
      // pupil's rank is already on the card their family holds. Withholding it
      // here would only mean the pupil sees less of their own result than
      // their parent does.
      classPosition:    s.classPosition ?? null,
      totalInClass:     s.totalInClass ?? null,
      publishedAt:      s.publishedAt ?? null,
    };
  });

  return res.json({ success: true, count: data.length, data });
}));

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