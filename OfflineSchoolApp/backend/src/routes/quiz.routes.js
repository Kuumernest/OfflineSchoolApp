"use strict";

const express = require("express");
const router  = express.Router();

const TeacherAssignment = require("../db/models/TeacherAssignment");
const Student           = require("../db/models/Student");

const {
  QuestionCategory,
  Question,
  Quiz,
  QuizAttempt,
  QuestionAnalytics,
  QuizAnalytics,
} = require("../db/models/QuizModule");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const { authorize } = require("../../middleware/auth");
const { requirePermission } = require("../../middleware/permissions");
const { ADMIN_ROLES, TEACHING_ROLES, ROLES } = require("../config/roles");

/**
 * Authorisation, which this router had none of.
 *
 * Found while auditing every guard in the codebase for the bursar, and it is a
 * bigger problem than the bursar: mounted behind authenticate only, every route
 * below was reachable by any signed-in account. A STUDENT could GET /questions
 * and read the school question bank — answers included — and could POST, PUT
 * and DELETE against it. Sitting an exam is not much of a test when the
 * candidate can read the paper and then delete it.
 *
 * The split:
 *
 *   authoring   Categories, questions, quizzes, analytics. Teachers and the
 *               office. A bursar has no part in any of it.
 *
 *   sitting     Attempts. Students, plus staff who need to look at one.
 *
 *   /sync       Keeps its own per-role branching below, which is the point of
 *               it: each role is handed a different slice.
 */
const authoring = requirePermission("quiz.author");
const sitting   = authorize(TEACHING_ROLES, ROLES.STUDENT);

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) =>
  req.user?.role === "super_admin"
    ? provided || req.user?.schoolId
    : req.user?.schoolId;

// ─────────────────────────────────────────────────────────────
// SYNC
// ─────────────────────────────────────────────────────────────

router.get("/sync", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const since    = req.query.since
    ? new Date(req.query.since)
    : new Date("1970-01-01");

  const userId = String(req.user?._id || req.user?.id || "");
  const role   = req.user?.role;

  // ── STUDENT SYNC ──────────────────────────────────────────
  if (role === "student") {
    const student = await Student.findOne({
      $or: [{ userId }, { _id: userId }],
    }).lean();

    const classId = student?.classId || student?.class_id || null;

    if (!classId) {
      console.warn(`[quiz/sync] student="${userId}" has no classId — returning empty`);
      return res.json({
        success: true,
        data: { categories: [], questions: [], quizzes: [], attempts: [] },
      });
    }

    // Quiz IDs the student has already attempted
    const attemptedQuizIds = await QuizAttempt.distinct("quiz_id", {
      user_id: userId,
    });

    // All published quizzes for their class
    // PLUS any quiz they've attempted (for result viewing)
    const quizzes = await Quiz.find({
      schoolId,
      deleted_at: null,
      $or: [
        {
          class_id:     classId,
          is_published: true,
        },
        {
          _id: { $in: attemptedQuizIds },
        },
      ],
    }).lean();

    // All attempts for this student updated since last sync
    const attempts = await QuizAttempt.find({
      user_id: userId,
      $or: [
        { updatedAt: { $gt: since } },
        { createdAt: { $gt: since } },
      ],
    }).lean();

    const quizIds   = quizzes.map((q) => String(q._id));
    const questions = await Question.find({
      schoolId,
      deleted_at: null,
      quiz_id:    { $in: quizIds },
    }).lean();

    const categories = await QuestionCategory.find({
      schoolId,
      updatedAt:  { $gt: since },
      deleted_at: null,
    }).lean();

    console.log(
      `[quiz/sync] student="${userId}"` +
      ` classId="${classId}"` +
      ` quizzes=${quizzes.length}` +
      ` attempts=${attempts.length}` +
      ` attemptedQuizIds=${attemptedQuizIds.length}`
    );

    return res.json({
      success: true,
      data: { categories, questions, quizzes, attempts },
    });
  }

  // ── TEACHER SYNC ──────────────────────────────────────────
  if (role === "teacher") {
    const [categories, questions, quizzes, attempts] = await Promise.all([
      QuestionCategory.find({
        schoolId,
        created_by: userId,
        updatedAt:  { $gt: since },
      }),
      Question.find({
        schoolId,
        created_by: userId,
        updatedAt:  { $gt: since },
      }),
      Quiz.find({
        schoolId,
        created_by: userId,
        updatedAt:  { $gt: since },
      }),
      QuizAttempt.find({
        schoolId,
        status:    { $in: ["submitted", "timed_out"] },
        updatedAt: { $gt: since },
      }),
    ]);

    console.log(
      `[quiz/sync] teacher="${userId}"` +
      ` quizzes=${quizzes.length}` +
      ` questions=${questions.length}` +
      ` attempts=${attempts.length}`
    );

    return res.json({
      success: true,
      data: { categories, questions, quizzes, attempts },
    });
  }

  // ── ADMIN / SUPER_ADMIN SYNC ──────────────────────────────
  //
  // This branch was the plain fall-through: not a student, not a teacher,
  // therefore everything in the school. That was safe only for as long as
  // exactly three roles existed. A bursar would have walked into it and been
  // handed every question, quiz and attempt in the building.
  //
  // Stated explicitly now, and anything unrecognised is refused rather than
  // promoted. A role this router has no slice for should be told so, not given
  // the largest one by default.
  if (!ADMIN_ROLES.includes(role)) {
    return res.status(403).json({
      success: false,
      code:    "FORBIDDEN",
      message: `The quiz module has nothing for the role "${role}".`,
    });
  }

  const [categories, questions, quizzes, attempts] = await Promise.all([
    QuestionCategory.find({ schoolId, updatedAt: { $gt: since } }),
    Question.find({ schoolId, updatedAt: { $gt: since } }),
    Quiz.find({ schoolId, updatedAt: { $gt: since } }),
    QuizAttempt.find({
      schoolId,
      status:    { $in: ["submitted", "timed_out"] },
      updatedAt: { $gt: since },
    }),
  ]);

  console.log(
    `[quiz/sync] admin="${userId}"` +
    ` quizzes=${quizzes.length}` +
    ` questions=${questions.length}`
  );

  return res.json({
    success: true,
    data: { categories, questions, quizzes, attempts },
  });
}));

// ─────────────────────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────────────────────

router.get("/categories", authoring, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const cats = await QuestionCategory.find({
    schoolId,
    deleted_at: null,
  });
  res.json({ success: true, categories: cats });
}));

router.post("/categories", authoring, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const cat = await QuestionCategory.create({
    schoolId,
    name:        req.body.name,
    description: req.body.description || null,
  });
  res.status(201).json({ success: true, category: cat });
}));

// ─────────────────────────────────────────────────────────────
// QUESTIONS
// ─────────────────────────────────────────────────────────────

router.get("/questions", authoring, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const questions = await Question.find({ schoolId, deleted_at: null });
  res.json({ success: true, questions });
}));

router.post("/questions", authoring, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const question = await Question.create({
    ...req.body,
    schoolId,
    created_by: req.user?._id,
  });
  res.status(201).json({ success: true, question });
}));

router.put("/questions/:id", authoring, asyncHandler(async (req, res) => {
  const q = await Question.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true }
  );
  res.json({ success: true, question: q });
}));

router.delete("/questions/:id", authoring, asyncHandler(async (req, res) => {
  await Question.findByIdAndUpdate(req.params.id, {
    deleted_at: new Date(),
  });
  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
// QUIZZES
// ─────────────────────────────────────────────────────────────

router.get("/quizzes", authoring, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const quizzes  = await Quiz.find({ schoolId, deleted_at: null });
  res.json({ success: true, quizzes });
}));

router.post("/quizzes", authoring, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);

  const { title, class_id, subject_id } = req.body;

  if (!title?.trim()) {
    return res.status(400).json({ success: false, message: "title is required" });
  }
  if (!class_id) {
    return res.status(400).json({ success: false, message: "class_id is required" });
  }
  if (!subject_id) {
    return res.status(400).json({ success: false, message: "subject_id is required" });
  }

  const created_by = String(req.user?._id || req.user?.id || "");
  if (!created_by) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  if (req.user?.role === "teacher") {
    const assignment = await TeacherAssignment.findOne({
      teacher: created_by,
      class:   class_id,
      subject: subject_id,
    }).lean();

    if (!assignment) {
      return res.status(403).json({
        success: false,
        message: "You are not assigned to teach this subject in this class",
      });
    }
  }

  const quiz = await Quiz.create({
    ...req.body,
    schoolId,
    class_id,
    subject_id,
    is_published: false,
    created_by,
  });

  await QuizAnalytics.findOneAndUpdate(
    { quiz_id: quiz._id },
    { $setOnInsert: { quiz_id: quiz._id } },
    { upsert: true }
  );

  console.log(
    `✅ Quiz created: "${quiz.title}"` +
    ` class=${class_id} subject=${subject_id}` +
    ` teacher=${created_by} [${quiz._id}]`
  );

  res.status(201).json({ success: true, quiz });
}));

router.put("/quizzes/:id", authoring, asyncHandler(async (req, res) => {
  const quiz = await Quiz.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true }
  );
  res.json({ success: true, quiz });
}));

router.delete("/quizzes/:id", authoring, asyncHandler(async (req, res) => {
  await Quiz.findByIdAndUpdate(req.params.id, {
    deleted_at: new Date(),
  });
  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
// ATTEMPTS
// ─────────────────────────────────────────────────────────────

router.post("/attempts", sitting, asyncHandler(async (req, res) => {
  const attempt = await QuizAttempt.create(req.body);
  res.status(201).json({ success: true, attempt });
}));

router.get("/attempts/:id", sitting, asyncHandler(async (req, res) => {
  const attempt = await QuizAttempt.findById(req.params.id);
  res.json({ success: true, attempt });
}));

// ─────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────

router.get("/analytics/quizzes/:quizId", authoring, asyncHandler(async (req, res) => {
  const summary = await QuizAnalytics.findOne({
    quiz_id: req.params.quizId,
  });
  res.json({ success: true, summary });
}));

module.exports = router;