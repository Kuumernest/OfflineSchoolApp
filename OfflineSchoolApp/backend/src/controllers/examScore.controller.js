// backend/src/controllers/examScore.controller.js
"use strict";

const ExamScore   = require("../db/models/ExamScore");
const ExamSubject = require("../db/models/ExamSubject");
const { gradeSubject } = require("../utils/gradeUtils");
const { computeResults } = require("../services/examResult.service");

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided)
    return String(provided).trim();
  return req.user?.schoolId;
};

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────────────────
// GET SCORES
// GET /api/exams/:examId/scores
// ─────────────────────────────────────────────────────────

exports.getScores = asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  const { examId } = req.params;
  const { subjectId, classId } = req.query;

  const filter = { examId, deletedAt: null };
  if (schoolId)  filter.schoolId  = schoolId;
  if (subjectId) filter.subjectId = subjectId;
  if (classId)   filter.classId   = classId;

  const scores = await ExamScore.find(filter)
    .sort({ studentId: 1 })
    .lean();

  return res.json({ success: true, scores });
});

// ─────────────────────────────────────────────────────────
// BULK SAVE SCORES
// POST /api/exams/:examId/scores/bulk
// ─────────────────────────────────────────────────────────

exports.saveBulkScores = asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.body.schoolId);
  const { examId } = req.params;
  const {
    classId,
    subjectId,
    examSubjectId,
    scores,
  } = req.body;

  // ── Validation ────────────────────────────────────────
  if (!classId || !subjectId || !Array.isArray(scores)) {
    return res.status(400).json({
      message: "classId, subjectId, and scores[] are required",
    });
  }

  if (scores.length === 0) {
    return res.status(400).json({ message: "scores array is empty" });
  }

  // ── Find exam subject ─────────────────────────────────
  const examSubject = examSubjectId
    ? await ExamSubject.findById(examSubjectId).lean()
    : await ExamSubject.findOne({
        examId, subjectId, classId, deletedAt: null,
      }).lean();

  const maxScoreDefault = examSubject?.maxScore ?? 100;

  // ── Validate score ranges ─────────────────────────────
  const invalid = scores.filter(
    (s) =>
      !s.isAbsent &&
      !s.isExempt &&
      s.score !== null &&
      s.score !== undefined &&
      (s.score < 0 || s.score > (s.maxScore ?? maxScoreDefault))
  );

  if (invalid.length > 0) {
    return res.status(400).json({
      message: `${invalid.length} score(s) are out of range`,
      invalid: invalid.map((s) => s.studentId),
    });
  }

  // ── Build upsert operations ────────────────────────────
  const now = new Date();
  const ops = scores.map((s) => {
    const maxScore = s.maxScore ?? maxScoreDefault;
    const isAbsent = s.isAbsent ?? false;
    const isExempt = s.isExempt ?? false;

    let gradeInfo = { grade: null, points: null, isPassing: null };
    if (!isAbsent && !isExempt && s.score != null) {
      const graded  = gradeSubject(s.score, maxScore);
      gradeInfo = {
        grade:     graded.grade,
        points:    graded.points,
        isPassing: graded.isPassing,
      };
    }

    const percentage =
      !isAbsent && !isExempt && s.score != null && maxScore > 0
        ? Math.round((s.score / maxScore) * 10000) / 100
        : null;

    return {
      updateOne: {
        filter: {
          examId,
          subjectId,
          studentId: String(s.studentId),
          classId,
        },
        update: {
          $set: {
            examSubjectId: examSubjectId || examSubject?._id || null,
            schoolId,
            score:         s.score         ?? null,
            maxScore,
            percentage,
            grade:         gradeInfo.grade,
            gradePoint:    gradeInfo.points,
            isPassing:     gradeInfo.isPassing,
            isAbsent,
            isExempt,
            teacherRemark: s.teacherRemark || null,
            enteredBy:     req.user?._id   || null,
            enteredAt:     now,
            updatedBy:     req.user?._id   || null,
            syncStatus:    "synced",
            lastSyncedAt:  now,
            deletedAt:     null,
          },
          $setOnInsert: {
            examId,
            subjectId,
            studentId: String(s.studentId),
            classId,
            schoolId,
          },
        },
        upsert: true,
      },
    };
  });

  await ExamScore.bulkWrite(ops, { ordered: false });

  // ── Update ExamSubject submission status ───────────────
  if (examSubject) {
    await ExamSubject.findByIdAndUpdate(examSubject._id, {
      $set: {
        submissionStatus: "submitted",
        submittedAt:      now,
        submittedBy:      req.user?._id || null,
      },
    });
  }

  // ── Fire-and-forget: recompute results ────────────────
  computeResults({ examId, classId, schoolId }).catch((err) => {
    console.error("[saveBulkScores] computeResults error:", err.message);
  });

  console.log(`📝 Bulk scores saved: ${scores.length} record(s)`);

  return res.status(201).json({
    success: true,
    saved:   scores.length,
    message: `${scores.length} score(s) saved successfully`,
  });
});

// ─────────────────────────────────────────────────────────
// APPROVE SUBMISSION
// PATCH /api/exams/:examId/subjects/:examSubjectId/approve
// ─────────────────────────────────────────────────────────

exports.approveSubmission = asyncHandler(async (req, res) => {
  const schoolId     = resolveSchoolId(req, req.body.schoolId);
  const { examId, examSubjectId } = req.params;
  const now          = new Date();

  const es = await ExamSubject.findOneAndUpdate(
    { _id: examSubjectId, examId, schoolId },
    {
      $set: {
        submissionStatus: "approved",
        approvedAt:       now,
        approvedBy:       req.user?._id || null,
        rejectedBy:       null,
        rejectedAt:       null,
        rejectReason:     null,
      },
    },
    { new: true }
  ).lean();

  if (!es) {
    return res.status(404).json({ message: "ExamSubject not found" });
  }

  console.log(`✅ Submission approved: ${es.subjectName}`);
  return res.json({ success: true, subject: es });
});

// ─────────────────────────────────────────────────────────
// REJECT SUBMISSION
// PATCH /api/exams/:examId/subjects/:examSubjectId/reject
// ─────────────────────────────────────────────────────────

exports.rejectSubmission = asyncHandler(async (req, res) => {
  const schoolId     = resolveSchoolId(req, req.body.schoolId);
  const { examId, examSubjectId } = req.params;
  const { reason }   = req.body;
  const now          = new Date();

  if (!reason?.trim()) {
    return res.status(400).json({ message: "A rejection reason is required" });
  }

  const es = await ExamSubject.findOneAndUpdate(
    { _id: examSubjectId, examId, schoolId },
    {
      $set: {
        submissionStatus: "rejected",
        rejectedAt:       now,
        rejectedBy:       req.user?._id || null,
        rejectReason:     reason.trim(),
        approvedBy:       null,
        approvedAt:       null,
      },
    },
    { new: true }
  ).lean();

  if (!es) {
    return res.status(404).json({ message: "ExamSubject not found" });
  }

  console.log(`❌ Submission rejected: ${es.subjectName} — ${reason}`);
  return res.json({ success: true, subject: es });
});

// ─────────────────────────────────────────────────────────
// SUBMIT MARKS (teacher submits for review)
// PATCH /api/exams/:examId/subjects/:examSubjectId/submit
// ─────────────────────────────────────────────────────────

exports.submitMarks = asyncHandler(async (req, res) => {
  const schoolId     = resolveSchoolId(req, req.body.schoolId);
  const { examId, examSubjectId } = req.params;
  const now          = new Date();

  const es = await ExamSubject.findOneAndUpdate(
    { _id: examSubjectId, examId, schoolId },
    {
      $set: {
        submissionStatus: "submitted",
        submittedAt:      now,
        submittedBy:      req.user?._id || null,
        rejectedBy:       null,
        rejectedAt:       null,
        rejectReason:     null,
      },
    },
    { new: true }
  ).lean();

  if (!es) {
    return res.status(404).json({ message: "ExamSubject not found" });
  }

  console.log(`📤 Marks submitted: ${es.subjectName}`);
  return res.json({ success: true, subject: es });
});