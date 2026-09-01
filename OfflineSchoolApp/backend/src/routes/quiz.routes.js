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

/**
 * Every write below is scoped to the caller's school.
 *
 * These four handlers addressed rows by _id alone, so a teacher at one school
 * could rewrite or delete another school's question bank by id — and, since the
 * update body went in unfiltered, could also move a question BETWEEN schools by
 * sending a schoolId. Same class of bug as the attempt IDOR further down, one
 * audience up: staff-only rather than student-facing, and cross-tenant rather
 * than cross-pupil.
 *
 * A super admin legitimately acts across schools, so the filter is theirs to
 * widen; everybody else is pinned to their own.
 */
const ownScope = (req) =>
  req.user?.role === ROLES.SUPER_ADMIN
    ? {}
    : { schoolId: req.user?.schoolId ?? "__none__" };

/**
 * What a client may NOT set, on anything.
 *
 * A denylist derived from the schema, rather than an allowlist typed out by
 * hand. Written by hand first, and three of the eleven names were wrong —
 * "text" for question_text, "marks" for points, "duration_mins" for
 * time_limit_minutes — which would have made every edit silently drop the
 * field it was meant to change. A wrong allowlist is worse than no allowlist:
 * it fails quietly and looks like the save button is broken.
 *
 * Reading the paths off the model cannot drift, and a field added in a later
 * release is editable by default rather than mysteriously ignored. What has to
 * stay listed here is only the small set of things a client must never own:
 * tenancy, authorship, soft-delete and mongoose's own bookkeeping.
 */
const NEVER_FROM_CLIENT = new Set([
  "_id", "schoolId", "created_by", "deleted_at",
  "createdAt", "updatedAt", "__v",
]);

const settableFields = (Model) =>
  Object.keys(Model.schema.paths).filter((p) => !NEVER_FROM_CLIENT.has(p));

const QUESTION_FIELDS = settableFields(Question);
const QUIZ_FIELDS     = settableFields(Quiz);

const pick = (body, fields) => {
  const out = {};
  for (const f of fields) {
    if (body?.[f] !== undefined) out[f] = body[f];
  }
  return out;
};

router.put("/questions/:id", authoring, asyncHandler(async (req, res) => {
  const q = await Question.findOneAndUpdate(
    { _id: req.params.id, ...ownScope(req) },
    pick(req.body, QUESTION_FIELDS),
    { returnDocument: 'after' }
  );
  if (!q) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Question not found",
    });
  }
  res.json({ success: true, question: q });
}));

router.delete("/questions/:id", authoring, asyncHandler(async (req, res) => {
  const q = await Question.findOneAndUpdate(
    { _id: req.params.id, ...ownScope(req) },
    { deleted_at: new Date() }
  );
  if (!q) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Question not found",
    });
  }
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
  const quiz = await Quiz.findOneAndUpdate(
    { _id: req.params.id, ...ownScope(req) },
    pick(req.body, QUIZ_FIELDS),
    { returnDocument: 'after' }
  );
  if (!quiz) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Quiz not found",
    });
  }
  res.json({ success: true, quiz });
}));

router.delete("/quizzes/:id", authoring, asyncHandler(async (req, res) => {
  const quiz = await Quiz.findOneAndUpdate(
    { _id: req.params.id, ...ownScope(req) },
    { deleted_at: new Date() }
  );
  if (!quiz) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Quiz not found",
    });
  }
  res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
// ATTEMPTS
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/quiz/attempts
 *
 * This was `QuizAttempt.create(req.body)`, which is mass assignment on a
 * document containing user_id, schoolId, raw_score, percentage and is_passed.
 * A student could therefore post an attempt as somebody else, into another
 * school, with a perfect score. Three separate holes in one line.
 *
 * ── What is fixed, and what cannot be ─────────────────────────────────────
 *
 * Identity and tenancy now come from the token and never from the body, and
 * only the fields below are read at all.
 *
 * The SCORE still comes from the device, and that is not an oversight — it is
 * what offline-first costs. The mobile app runs the quiz, marks it and shows
 * the result with no signal, then the outbox posts it later; the server has no
 * way to recompute a mark for a paper that was sat on a phone two days ago
 * without re-implementing the whole quiz engine server-side. So a student can
 * still inflate their OWN score, which is a cheating problem rather than a
 * privacy one, and is bounded by the fact that they can no longer touch
 * anybody else's attempt or any other school's data. Server-side scoring is a
 * feature, not a guard, and it belongs in its own change.
 */
router.post("/attempts", sitting, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const callerId = String(req.user?._id ?? req.user?.id ?? "");
  const isStudent = req.user?.role === ROLES.STUDENT;

  if (!req.body?.quiz_id) {
    return res.status(400).json({
      success: false, code: "BAD_REQUEST", message: "quiz_id is required",
    });
  }

  // A student may only ever record their own attempt. Staff may name one,
  // because a teacher entering a paper sat on paper is a real thing — and a
  // teacher acting for a student they teach is a far smaller concern than a
  // student acting for a classmate.
  const ownerId = isStudent
    ? callerId
    : String(req.body.user_id ?? callerId);

  if (!ownerId) {
    return res.status(400).json({
      success: false, code: "BAD_REQUEST", message: "user_id could not be resolved",
    });
  }

  const attemptNumber = Number(req.body.attempt_number) || 1;

  // The outbox retries a post whose response was lost, and QuizAttempt has a
  // server-generated _id, so without this a bad connection produces two
  // attempts for one sitting and corrupts the analytics that average them.
  // (quiz_id, user_id, attempt_number) is the natural key; answering with the
  // stored row lets the phone mark the send done, exactly as the fee and
  // expense endpoints already do.
  const existing = await QuizAttempt.findOne({
    quiz_id: req.body.quiz_id,
    user_id: ownerId,
    attempt_number: attemptNumber,
  });
  if (existing) {
    return res.status(200).json({ success: true, replay: true, attempt: existing });
  }

  // Explicit allowlist. Anything the client sends that is not named here —
  // including a field added to the schema in a later release — is dropped.
  const attempt = await QuizAttempt.create({
    quiz_id:         req.body.quiz_id,
    user_id:         ownerId,
    schoolId:        schoolId ?? null,
    attempt_number:  attemptNumber,
    status:          req.body.status,
    raw_score:       req.body.raw_score,
    max_score:       req.body.max_score,
    percentage:      req.body.percentage,
    is_passed:       req.body.is_passed,
    started_at:      req.body.started_at,
    submitted_at:    req.body.submitted_at,
    time_taken_secs: req.body.time_taken_secs,
    answers:         Array.isArray(req.body.answers) ? req.body.answers : [],
  });

  res.status(201).json({ success: true, attempt });
}));

/**
 * GET /api/quiz/attempts/:id
 *
 * Scoped, where it read any attempt by id: one student could read another's
 * answers and marks by guessing or harvesting an id. Staff are scoped to their
 * own school, which the route also failed to do.
 */
router.get("/attempts/:id", sitting, asyncHandler(async (req, res) => {
  const attempt = await QuizAttempt.findById(req.params.id);

  if (!attempt) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Attempt not found",
    });
  }

  const callerId = String(req.user?._id ?? req.user?.id ?? "");

  if (req.user?.role === ROLES.STUDENT) {
    // 404 rather than 403, so the response does not confirm that an attempt
    // with that id exists — the same reasoning users.routes.js uses for
    // cross-school lookups.
    if (String(attempt.user_id) !== callerId) {
      return res.status(404).json({
        success: false, code: "NOT_FOUND", message: "Attempt not found",
      });
    }
  } else if (req.user?.role !== ROLES.SUPER_ADMIN) {
    const schoolId = req.user?.schoolId ? String(req.user.schoolId) : null;
    // A null schoolId on the attempt is a row written before tenancy was
    // enforced here; it is refused rather than shown to whoever asks first.
    if (!schoolId || String(attempt.schoolId ?? "") !== schoolId) {
      return res.status(404).json({
        success: false, code: "NOT_FOUND", message: "Attempt not found",
      });
    }
  }

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