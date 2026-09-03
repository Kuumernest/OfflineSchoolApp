// backend/controllers/quiz.controller.js
"use strict";

const Question        = require("../db/models/Question");
const QuestionCategory= require("../db/models/QuestionCategory");
const Quiz            = require("../db/models/Quiz");
const QuizAttempt     = require("../db/models/QuizAttempt");
const QuestionAnalytics = require("../db/models/QuestionAnalytics");
const QuizAnalytics   = require("../db/models/QuizAnalytics");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) {
    return String(provided).trim();
  }
  return req.user?.schoolId || provided || null;
};

// Strip correct answers before sending to student
const sanitizeQuestions = (questions) =>
  questions.map((q) => ({
    ...q,
    options: (q.options || []).map(({ is_correct, ...opt }) => opt),
  }));

// Shuffle array (Fisher-Yates)
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Update question-level analytics atomically
const updateQuestionAnalytics = async (questionId, {
  wasAnswered = false,
  wasCorrect  = false,
  timeSpent   = null,
}) => {
  try {
    const inc = { times_shown: 1 };
    if (wasAnswered) inc.times_answered = 1;
    if (wasCorrect)  inc.times_correct  = 1;

    const doc = await QuestionAnalytics.findOneAndUpdate(
      { question_id: questionId },
      { $inc: inc },
      { upsert: true, returnDocument: 'after' }
    );

    // Recalculate difficulty score and avg time
    const updates = {
      difficulty_score: doc.times_shown > 0
        ? doc.times_correct / doc.times_shown
        : 0,
    };

    if (timeSpent != null && doc.times_answered > 0) {
      updates.avg_time_secs = Math.round(
        (doc.avg_time_secs * (doc.times_answered - 1) + timeSpent) /
        doc.times_answered
      );
    }

    await QuestionAnalytics.findByIdAndUpdate(doc._id, { $set: updates });
  } catch (err) {
    console.warn("updateQuestionAnalytics failed:", err.message);
  }
};

// Update quiz-level analytics atomically
const updateQuizAnalytics = async (quizId, {
  percentage,
  is_passed,
  time_taken_secs = null,
}) => {
  try {
    const doc = await QuizAnalytics.findOneAndUpdate(
      { quiz_id: quizId },
      {
        $inc: {
          total_attempts:    1,
          total_completions: 1,
          total_passes:      is_passed ? 1 : 0,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const updates = {
      avg_score:     Math.round(
        ((doc.avg_score * (doc.total_completions - 1)) + percentage) /
        doc.total_completions * 100
      ) / 100,
      highest_score: Math.max(doc.highest_score, percentage),
      lowest_score:  doc.total_completions === 1
        ? percentage
        : Math.min(doc.lowest_score, percentage),
    };

    if (time_taken_secs != null && doc.total_completions > 0) {
      updates.avg_time_secs = Math.round(
        ((doc.avg_time_secs * (doc.total_completions - 1)) + time_taken_secs) /
        doc.total_completions
      );
    }

    await QuizAnalytics.findByIdAndUpdate(doc._id, { $set: updates });
  } catch (err) {
    console.warn("updateQuizAnalytics failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────────────────────

exports.getCategories = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const cats     = await QuestionCategory.find({
    schoolId,
    is_active: true,
    deleted_at: null,
  }).sort({ name: 1 }).lean();

  return res.json({ success: true, categories: cats });
};

exports.createCategory = async (req, res) => {
  const { name, description, parent_id } = req.body;
  const schoolId = resolveSchoolId(req, req.body.schoolId);

  if (!name?.trim()) {
    return res.status(400).json({ success: false, message: "name is required" });
  }

  const cat = await QuestionCategory.create({
    schoolId,
    name:      name.trim(),
    description: description || null,
    parent_id:   parent_id  || null,
  });

  return res.status(201).json({ success: true, category: cat });
};

// ─────────────────────────────────────────────────────────────
// QUESTIONS
// ─────────────────────────────────────────────────────────────

exports.getQuestions = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const {
    category_id,
    difficulty,
    question_type,
    search,
    limit  = 50,
    offset = 0,
  } = req.query;

  const filter = {
    schoolId,
    is_active:  true,
    deleted_at: null,
  };

  if (category_id)   filter.category_id   = category_id;
  if (difficulty)    filter.difficulty    = difficulty;
  if (question_type) filter.question_type = question_type;
  if (search)        filter.question_text = { $regex: search, $options: "i" };

  const questions = await Question.find(filter)
    .sort({ createdAt: -1 })
    .skip(Number(offset))
    .limit(Number(limit))
    .populate("category_id", "name")
    .lean();

  // Attach analytics
  const ids       = questions.map((q) => q._id);
  const analytics = await QuestionAnalytics.find({
    question_id: { $in: ids },
  }).lean();

  const analyticsMap = new Map(
    analytics.map((a) => [String(a.question_id), a])
  );

  const enriched = questions.map((q) => {
    const a = analyticsMap.get(String(q._id)) || {};
    return {
      ...q,
      category_name:   q.category_id?.name || null,
      difficulty_score:a.difficulty_score || 0,
      times_shown:     a.times_shown      || 0,
    };
  });

  return res.json({ success: true, questions: enriched });
};

exports.getQuestionById = async (req, res) => {
  const question = await Question.findOne({
    _id:        req.params.id,
    deleted_at: null,
  })
    .populate("category_id", "name")
    .lean();

  if (!question) {
    return res.status(404).json({ success: false, message: "Question not found" });
  }

  return res.json({ success: true, question });
};

exports.createQuestion = async (req, res) => {
  const {
    question_text,
    question_type,
    category_id,
    difficulty,
    points,
    explanation,
    media_url,
    options = [],
  } = req.body;

  const schoolId = resolveSchoolId(req, req.body.schoolId);

  if (!question_text?.trim()) {
    return res.status(400).json({
      success: false,
      message: "question_text is required",
    });
  }

  if (!question_type) {
    return res.status(400).json({
      success: false,
      message: "question_type is required",
    });
  }

  const question = await Question.create({
    schoolId,
    question_text: question_text.trim(),
    question_type,
    category_id:   category_id || null,
    difficulty:    difficulty  || "medium",
    points:        points      || 1.0,
    explanation:   explanation || null,
    media_url:     media_url   || null,
    created_by:    String(req.user?._id || req.user?.id || ""),
    options:       options.map((o, i) => ({
      option_text:   o.option_text,
      is_correct:    !!o.is_correct,
      match_pair:    o.match_pair    || null,
      display_order: o.display_order ?? i,
    })),
  });

  // Seed analytics
  await QuestionAnalytics.findOneAndUpdate(
    { question_id: question._id },
    { $setOnInsert: { question_id: question._id } },
    { upsert: true }
  );

  console.log(`✅ Question created: [${question._id}]`);
  return res.status(201).json({ success: true, question });
};

exports.updateQuestion = async (req, res) => {
  const allowed = [
    "question_text", "question_type", "category_id",
    "difficulty", "points", "explanation", "media_url",
    "is_active", "options",
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Normalise options if provided
  if (updates.options) {
    updates.options = updates.options.map((o, i) => ({
      option_text:   o.option_text,
      is_correct:    !!o.is_correct,
      match_pair:    o.match_pair    || null,
      display_order: o.display_order ?? i,
    }));
  }

  const question = await Question.findOneAndUpdate(
    { _id: req.params.id, deleted_at: null },
    { $set: updates },
    { returnDocument: 'after', runValidators: true }
  ).lean();

  if (!question) {
    return res.status(404).json({ success: false, message: "Question not found" });
  }

  return res.json({ success: true, question });
};

exports.deleteQuestion = async (req, res) => {
  const question = await Question.findOneAndUpdate(
    { _id: req.params.id, deleted_at: null },
    { $set: { deleted_at: new Date(), is_active: false } },
    { returnDocument: 'after' }
  );

  if (!question) {
    return res.status(404).json({ success: false, message: "Question not found" });
  }

  return res.json({ success: true, message: "Question deleted" });
};

// ─────────────────────────────────────────────────────────────
// QUIZZES
// ─────────────────────────────────────────────────────────────

exports.getQuizzes = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const {
    class_id,
    subject_id,
    is_published,
    created_by,
    limit  = 20,
    offset = 0,
  } = req.query;

  const filter = { schoolId, deleted_at: null };

  if (class_id)    filter.class_id    = class_id;
  if (subject_id)  filter.subject_id  = subject_id;
  if (created_by)  filter.created_by  = created_by;
  if (is_published !== undefined) {
    filter.is_published = is_published === "true" || is_published === "1";
  }

  const quizzes = await Quiz.find(filter)
    .sort({ createdAt: -1 })
    .skip(Number(offset))
    .limit(Number(limit))
    .lean();

  // Attach analytics + question count
  const ids       = quizzes.map((q) => q._id);
  const analytics = await QuizAnalytics.find({
    quiz_id: { $in: ids },
  }).lean();

  const analyticsMap = new Map(
    analytics.map((a) => [String(a.quiz_id), a])
  );

  const enriched = quizzes.map((q) => {
    const a = analyticsMap.get(String(q._id)) || {};
    return {
      ...q,
      question_count: (q.questions || []).length,
      total_attempts: a.total_attempts || 0,
      avg_score:      a.avg_score      || 0,
    };
  });

  return res.json({ success: true, quizzes: enriched });
};

exports.getQuizById = async (req, res) => {
  const quiz = await Quiz.findOne({
    _id:        req.params.id,
    deleted_at: null,
  }).lean();

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  // Populate questions
  const questionIds = (quiz.questions || []).map((q) => q.question_id);
  const questions   = await Question.find({
    _id:        { $in: questionIds },
    deleted_at: null,
  }).lean();

  const questionMap = new Map(
    questions.map((q) => [String(q._id), q])
  );

  quiz.questions = (quiz.questions || []).map((entry) => ({
    ...questionMap.get(String(entry.question_id)) || {},
    display_order:   entry.display_order,
    points_override: entry.points_override,
  }));

  return res.json({ success: true, quiz });
};

exports.createQuiz = async (req, res) => {
  const {
    title,
    description,
    instructions,
    subject_id,
    class_id,
    time_limit_minutes,
    time_per_question,
    shuffle_questions,
    shuffle_options,
    questions_per_page,
    allow_backtrack,
    max_attempts,
    passing_score,
    available_from,
    available_until,
    password,
    show_answers_after,
    show_score,
    show_explanation,
    questionIds = [],
  } = req.body;

  const schoolId = resolveSchoolId(req, req.body.schoolId);

  if (!title?.trim()) {
    return res.status(400).json({ success: false, message: "title is required" });
  }

  // Build embedded questions array
  const questions = questionIds.map((qId, i) => ({
    question_id:   qId,
    display_order: i,
  }));

  const quiz = await Quiz.create({
    schoolId,
    title:              title.trim(),
    description:        description   || null,
    instructions:       instructions  || null,
    subject_id:         subject_id    || null,
    class_id:           class_id      || null,
    time_limit_minutes: time_limit_minutes || null,
    time_per_question:  time_per_question  || null,
    shuffle_questions:  !!shuffle_questions,
    shuffle_options:    !!shuffle_options,
    questions_per_page: questions_per_page || 1,
    allow_backtrack:    allow_backtrack !== false,
    max_attempts:       max_attempts   || 1,
    passing_score:      passing_score  || 70,
    available_from:     available_from || null,
    available_until:    available_until|| null,
    password:           password       || null,
    show_answers_after: show_answers_after || "on_completion",
    show_score:         show_score !== false,
    show_explanation:   show_explanation !== false,
    is_published:       false,
    created_by:         String(req.user?._id || req.user?.id || ""),
    questions,
  });

  // Seed analytics
  await QuizAnalytics.findOneAndUpdate(
    { quiz_id: quiz._id },
    { $setOnInsert: { quiz_id: quiz._id } },
    { upsert: true }
  );

  console.log(`✅ Quiz created: "${quiz.title}" [${quiz._id}]`);
  return res.status(201).json({ success: true, quiz });
};

exports.updateQuiz = async (req, res) => {
  const allowed = [
    "title", "description", "instructions",
    "subject_id", "class_id",
    "time_limit_minutes", "time_per_question",
    "shuffle_questions", "shuffle_options",
    "questions_per_page", "allow_backtrack",
    "max_attempts", "passing_score",
    "available_from", "available_until", "password",
    "show_answers_after", "show_score", "show_explanation",
    "is_published",
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const quiz = await Quiz.findOneAndUpdate(
    { _id: req.params.id, deleted_at: null },
    { $set: updates },
    { returnDocument: 'after', runValidators: true }
  ).lean();

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  return res.json({ success: true, quiz });
};

exports.publishQuiz = async (req, res) => {
  const quiz = await Quiz.findOneAndUpdate(
    { _id: req.params.id, deleted_at: null },
    { $set: { is_published: true } },
    { returnDocument: 'after' }
  ).lean();

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  return res.json({ success: true, quiz });
};

exports.unpublishQuiz = async (req, res) => {
  const quiz = await Quiz.findOneAndUpdate(
    { _id: req.params.id, deleted_at: null },
    { $set: { is_published: false } },
    { returnDocument: 'after' }
  ).lean();

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  return res.json({ success: true, quiz });
};

exports.deleteQuiz = async (req, res) => {
  const quiz = await Quiz.findOneAndUpdate(
    { _id: req.params.id, deleted_at: null },
    { $set: { deleted_at: new Date(), is_published: false } },
    { returnDocument: 'after' }
  );

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  return res.json({ success: true, message: "Quiz deleted" });
};

exports.addQuestionToQuiz = async (req, res) => {
  const { questionId, points_override } = req.body;

  if (!questionId) {
    return res.status(400).json({ success: false, message: "questionId is required" });
  }

  const quiz = await Quiz.findOne({
    _id:        req.params.id,
    deleted_at: null,
  });

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  const alreadyAdded = quiz.questions.some(
    (q) => String(q.question_id) === String(questionId)
  );

  if (alreadyAdded) {
    return res.status(409).json({
      success: false,
      message: "Question already in quiz",
    });
  }

  quiz.questions.push({
    question_id:     questionId,
    display_order:   quiz.questions.length,
    points_override: points_override || null,
  });

  await quiz.save();
  return res.json({ success: true, quiz });
};

exports.removeQuestionFromQuiz = async (req, res) => {
  const quiz = await Quiz.findOne({
    _id:        req.params.id,
    deleted_at: null,
  });

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found" });
  }

  quiz.questions = quiz.questions.filter(
    (q) => String(q.question_id) !== String(req.params.questionId)
  );

  await quiz.save();
  return res.json({ success: true, quiz });
};

// ─────────────────────────────────────────────────────────────
// ATTEMPTS
// ─────────────────────────────────────────────────────────────

exports.startAttempt = async (req, res) => {
  const { quizId } = req.params;
  const userId     = String(req.user?._id || req.user?.id);

  const quiz = await Quiz.findOne({
    _id:          quizId,
    deleted_at:   null,
    is_published: true,
  }).lean();

  if (!quiz) {
    return res.status(404).json({ success: false, message: "Quiz not found or not published" });
  }

  // Check availability window
  const now = new Date();
  if (quiz.available_from  && now < new Date(quiz.available_from)) {
    return res.status(403).json({ success: false, message: "Quiz has not started yet" });
  }
  if (quiz.available_until && now > new Date(quiz.available_until)) {
    return res.status(403).json({ success: false, message: "Quiz has ended" });
  }

  // Check attempt count
  if (quiz.max_attempts != null) {
    const count = await QuizAttempt.countDocuments({
      quiz_id: quizId,
      user_id: userId,
      status:  { $ne: "abandoned" },
    });
    if (count >= quiz.max_attempts) {
      return res.status(403).json({
        success: false,
        message: `Maximum attempts (${quiz.max_attempts}) reached`,
      });
    }
  }

  // Calculate attempt number
  const attemptCount = await QuizAttempt.countDocuments({
    quiz_id: quizId,
    user_id: userId,
  });

  // Fetch questions
  const questionIds = (quiz.questions || []).map((q) => q.question_id);
  const questions   = await Question.find({
    _id:        { $in: questionIds },
    deleted_at: null,
  }).lean();

  const questionMap = new Map(questions.map((q) => [String(q._id), q]));

  let orderedQuestions = (quiz.questions || []).map((entry) => ({
    ...questionMap.get(String(entry.question_id)) || {},
    display_order:   entry.display_order,
    points_override: entry.points_override,
  }));

  if (quiz.shuffle_questions) {
    orderedQuestions = shuffle(orderedQuestions);
  }

  if (quiz.shuffle_options) {
    orderedQuestions = orderedQuestions.map((q) => ({
      ...q,
      options: q.question_type !== "matching"
        ? shuffle(q.options || [])
        : (q.options || []),
    }));
  }

  const max_score = orderedQuestions.reduce(
    (sum, q) => sum + (q.points_override ?? q.points ?? 1), 0
  );

  // Create attempt
  const attempt = await QuizAttempt.create({
    quiz_id:        quizId,
    user_id:        userId,
    schoolId:       quiz.schoolId,
    attempt_number: attemptCount + 1,
    status:         "in_progress",
    max_score,
    started_at:     now,
  });

  // Strip correct answers
  const safeQuestions = sanitizeQuestions(orderedQuestions);

  return res.status(201).json({
    success: true,
    attemptId:      String(attempt._id),
    attempt_number: attempt.attempt_number,
    quiz: {
      title:              quiz.title,
      instructions:       quiz.instructions,
      time_limit_minutes: quiz.time_limit_minutes,
      time_per_question:  quiz.time_per_question,
      allow_backtrack:    quiz.allow_backtrack,
      questions_per_page: quiz.questions_per_page,
      passing_score:      quiz.passing_score,
    },
    questions: safeQuestions,
    max_score,
  });
};

exports.saveAnswer = async (req, res) => {
  const { attemptId } = req.params;
  const {
    questionId,
    selected_option_id  = null,
    selected_option_ids = [],
    text_answer         = null,
    time_spent_secs     = null,
    is_flagged          = false,
  } = req.body;

  const attempt = await QuizAttempt.findOne({
    _id:    attemptId,
    status: "in_progress",
  });

  if (!attempt) {
    return res.status(404).json({
      success: false,
      message: "Attempt not found or already submitted",
    });
  }

  // Find existing answer or create new
  const existingIdx = attempt.answers.findIndex(
    (a) => String(a.question_id) === String(questionId)
  );

  const answerData = {
    question_id:        questionId,
    selected_option_id: selected_option_id || null,
    text_answer:        text_answer        || null,
    time_spent_secs:    time_spent_secs    || null,
    is_flagged:         !!is_flagged,
    answered_at:        new Date(),
    selections:         selected_option_ids.map((id) => ({
      selected_option_id: id,
    })),
  };

  if (existingIdx >= 0) {
    attempt.answers[existingIdx] = {
      ...attempt.answers[existingIdx].toObject(),
      ...answerData,
    };
  } else {
    attempt.answers.push(answerData);
  }

  await attempt.save();
  return res.json({ success: true, saved: true });
};

exports.submitAttempt = async (req, res) => {
  const { attemptId } = req.params;
  const userId        = String(req.user?._id || req.user?.id);

  const attempt = await QuizAttempt.findOne({
    _id:     attemptId,
    user_id: userId,
  });

  if (!attempt) {
    return res.status(404).json({ success: false, message: "Attempt not found" });
  }

  if (attempt.status !== "in_progress") {
    return res.status(400).json({
      success: false,
      message: `Attempt already ${attempt.status}`,
    });
  }

  const now           = new Date();
  const timeTakenSecs = Math.round(
    (now - new Date(attempt.started_at)) / 1000
  );

  attempt.status          = "submitted";
  attempt.submitted_at    = now;
  attempt.time_taken_secs = timeTakenSecs;

  await attempt.save();

  // Grade it
  const result = await gradeAttempt(attempt);

  return res.json({ success: true, ...result });
};

exports.getAttemptResult = async (req, res) => {
  const { attemptId } = req.params;
  const userId        = String(req.user?._id || req.user?.id);

  const attempt = await QuizAttempt.findOne({
    _id:     attemptId,
    user_id: userId,
  }).lean();

  if (!attempt) {
    return res.status(404).json({ success: false, message: "Attempt not found" });
  }

  const quiz = await Quiz.findById(attempt.quiz_id).lean();

  // Populate question details on each answer
  const questionIds = attempt.answers.map((a) => a.question_id);
  const questions   = await Question.find({
    _id: { $in: questionIds },
  }).lean();

  const questionMap = new Map(
    questions.map((q) => [String(q._id), q])
  );

  const answers = attempt.answers.map((a) => ({
    ...a,
    question: questionMap.get(String(a.question_id)) || null,
  }));

  return res.json({
    success: true,
    attempt: {
      ...attempt,
      answers,
      quiz: quiz
        ? {
            title:            quiz.title,
            passing_score:    quiz.passing_score,
            show_score:       quiz.show_score,
            show_explanation: quiz.show_explanation,
            show_answers_after: quiz.show_answers_after,
          }
        : null,
    },
  });
};

exports.getUserAttempts = async (req, res) => {
  const userId   = String(req.user?._id || req.user?.id);
  const { quizId } = req.query;

  const filter = { user_id: userId };
  if (quizId) filter.quiz_id = quizId;

  const attempts = await QuizAttempt.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  return res.json({ success: true, attempts });
};

// ─────────────────────────────────────────────────────────────
// GRADING (internal)
// ─────────────────────────────────────────────────────────────

const gradeAttempt = async (attempt) => {
  const quiz = await Quiz.findById(attempt.quiz_id).lean();
  if (!quiz) throw new Error("Quiz not found during grading");

  const questionMap = new Map(
    (quiz.questions || []).map((q) => [
      String(q.question_id),
      q.points_override,
    ])
  );

  const questionIds = attempt.answers.map((a) => a.question_id);
  const questions   = await Question.find({
    _id: { $in: questionIds },
  }).lean();

  const questionDetails = new Map(
    questions.map((q) => [String(q._id), q])
  );

  let raw_score = 0;
  let max_score = 0;

  for (const answer of attempt.answers) {
    const qId      = String(answer.question_id);
    const question = questionDetails.get(qId);
    if (!question) continue;

    const pointsPossible =
      questionMap.get(qId) ?? question.points ?? 1;
    max_score += pointsPossible;

    let pointsEarned = 0;
    let isCorrect    = false;

    switch (question.question_type) {

      case "multiple_choice":
      case "true_false": {
        if (!answer.selected_option_id) break;
        const opt = question.options.find(
          (o) => String(o._id) === String(answer.selected_option_id)
        );
        isCorrect    = !!opt?.is_correct;
        pointsEarned = isCorrect ? pointsPossible : 0;
        break;
      }

      case "multiple_select": {
        const correctIds = new Set(
          question.options
            .filter((o) => o.is_correct)
            .map((o) => String(o._id))
        );
        const selectedIds = new Set(
          (answer.selections || []).map((s) => String(s.selected_option_id))
        );

        let correct = 0;
        let wrong   = 0;
        for (const id of selectedIds) {
          correctIds.has(id) ? correct++ : wrong++;
        }
        const missed     = correctIds.size - correct;
        const net        = Math.max(0, correct - wrong - missed);
        pointsEarned     = correctIds.size > 0
          ? (net / correctIds.size) * pointsPossible
          : 0;
        isCorrect        = correct === correctIds.size && wrong === 0;
        break;
      }

      case "fill_in_the_blank": {
        if (!answer.text_answer) break;
        const correctOpt = question.options.find((o) => o.is_correct);
        if (correctOpt) {
          isCorrect = answer.text_answer.trim().toLowerCase() ===
                      correctOpt.option_text.trim().toLowerCase();
          pointsEarned = isCorrect ? pointsPossible : 0;
        }
        break;
      }

      case "matching": {
        const opt = question.options.find(
          (o) => String(o._id) === String(answer.selected_option_id)
        );
        isCorrect    = !!opt?.is_correct;
        pointsEarned = isCorrect ? pointsPossible : 0;
        break;
      }

      default:
        break;
    }

    raw_score += pointsEarned;

    // Update answer in-place
    answer.is_correct      = isCorrect;
    answer.points_earned   = pointsEarned;
    answer.points_possible = pointsPossible;

    await updateQuestionAnalytics(answer.question_id, {
      wasAnswered: true,
      wasCorrect:  isCorrect,
      timeSpent:   answer.time_spent_secs,
    });
  }

  const percentage = max_score > 0
    ? Math.round((raw_score / max_score) * 10000) / 100
    : 0;

  const is_passed = percentage >= (quiz.passing_score || 70);

  await QuizAttempt.findByIdAndUpdate(attempt._id, {
    $set: {
      raw_score,
      max_score,
      percentage,
      is_passed,
      answers: attempt.answers,
    },
  });

  await updateQuizAnalytics(attempt.quiz_id, {
    percentage,
    is_passed,
    time_taken_secs: attempt.time_taken_secs,
  });

  return { attemptId: String(attempt._id), raw_score, max_score, percentage, is_passed };
};

// ─────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────

exports.getQuizAnalytics = async (req, res) => {
  const { quizId } = req.params;

  const summary = await QuizAnalytics.findOne({ quiz_id: quizId }).lean();
  const quiz    = await Quiz.findById(quizId).select("title passing_score").lean();

  // Hardest questions
  const questionIds = (
    await Quiz.findById(quizId).select("questions").lean()
  )?.questions?.map((q) => q.question_id) || [];

  const hardestQuestions = await QuestionAnalytics.find({
    question_id: { $in: questionIds },
    times_shown: { $gt: 0 },
  })
    .sort({ difficulty_score: 1 })
    .limit(5)
    .populate("question_id", "question_text difficulty")
    .lean();

  return res.json({
    success: true,
    data: {
      summary: summary
        ? { ...summary, ...quiz }
        : null,
      hardestQuestions: hardestQuestions.map((a) => ({
        question_text:   a.question_id?.question_text || "",
        difficulty:      a.question_id?.difficulty    || "medium",
        times_shown:     a.times_shown,
        times_correct:   a.times_correct,
        difficulty_score:a.difficulty_score,
        avg_time_secs:   a.avg_time_secs,
      })),
    },
  });
};

// ─────────────────────────────────────────────────────────────
// SYNC ENDPOINTS
// ─────────────────────────────────────────────────────────────

exports.syncPull = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const since    = req.query.since
    ? new Date(req.query.since)
    : new Date("1970-01-01");

  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId required" });
  }

  const [categories, questions, quizzes, attempts] = await Promise.all([

    QuestionCategory.find({
      schoolId,
      updatedAt: { $gt: since },
    }).lean(),

    Question.find({
      schoolId,
      updatedAt: { $gt: since },
    }).lean(),

    Quiz.find({
      schoolId,
      updatedAt: { $gt: since },
    }).lean(),

    QuizAttempt.find({
      schoolId,
      status:    { $in: ["submitted", "timed_out"] },
      updatedAt: { $gt: since },
    }).lean(),

  ]);

  return res.json({
    success: true,
    data: {
      categories,
      questions,
      quizzes,
      attempts,
    },
  });
};

exports.syncPushAttempt = async (req, res) => {
  const attempt = req.body;

  if (!attempt?.quiz_id || !attempt?.user_id) {
    return res.status(400).json({
      success: false,
      message: "quiz_id and user_id are required",
    });
  }

  const existing = await QuizAttempt.findOne({
    quiz_id:        attempt.quiz_id,
    user_id:        attempt.user_id,
    attempt_number: attempt.attempt_number || 1,
  });

  if (existing) {
    // Only update if incoming data is newer
    if (
      existing.status === "submitted" ||
      existing.status === "timed_out"
    ) {
      return res.json({ success: true, skipped: true, message: "Already submitted" });
    }

    await QuizAttempt.findByIdAndUpdate(existing._id, {
      $set: {
        status:          attempt.status,
        raw_score:       attempt.raw_score,
        max_score:       attempt.max_score,
        percentage:      attempt.percentage,
        is_passed:       attempt.is_passed,
        submitted_at:    attempt.submitted_at,
        time_taken_secs: attempt.time_taken_secs,
        answers:         attempt.answers || [],
      },
    });

    return res.json({ success: true, updated: true });
  }

  await QuizAttempt.create({
    quiz_id:        attempt.quiz_id,
    user_id:        attempt.user_id,
    schoolId:       attempt.schoolId || null,
    attempt_number: attempt.attempt_number || 1,
    status:         attempt.status          || "submitted",
    raw_score:      attempt.raw_score       || 0,
    max_score:      attempt.max_score       || 0,
    percentage:     attempt.percentage      || 0,
    is_passed:      attempt.is_passed       || false,
    started_at:     attempt.started_at      || new Date(),
    submitted_at:   attempt.submitted_at    || new Date(),
    time_taken_secs:attempt.time_taken_secs || null,
    answers:        attempt.answers         || [],
  });

  return res.status(201).json({ success: true, created: true });
};