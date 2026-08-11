"use strict";

const mongoose = require("mongoose");

// ─────────────────────────────────────────────
// QUESTION CATEGORY
// ─────────────────────────────────────────────

const QuestionCategorySchema = new mongoose.Schema(
  {
    schoolId:   { type: String, required: true, index: true },
    name:       { type: String, required: true, trim: true  },
    description:{ type: String, default: null               },
    parent_id:  {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "QuestionCategory",
      default: null,
    },
    is_active:  { type: Boolean, default: true },
    deleted_at: { type: Date,    default: null },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────
// QUESTION
// ─────────────────────────────────────────────

const QuestionOptionSchema = new mongoose.Schema(
  {
    option_text:   { type: String, required: true },
    is_correct:    { type: Boolean, default: false },
    match_pair:    { type: String,  default: null  },
    display_order: { type: Number,  default: 0     },
  },
  { _id: true }
);

const QuestionSchema = new mongoose.Schema(
  {
    schoolId:      { type: String, required: true, index: true },
    category_id:   {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "QuestionCategory",
      default: null,
    },
    question_text: { type: String, required: true },
    question_type: {
      type: String,
      enum: [
        "multiple_choice",
        "multiple_select",
        "true_false",
        "fill_in_the_blank",
        "matching",
      ],
      required: true,
    },
    difficulty: {
      type:    String,
      enum:    ["easy", "medium", "hard"],
      default: "medium",
    },
    points:      { type: Number, default: 1 },
    explanation: { type: String, default: null },
    media_url:   { type: String, default: null },
    is_active:   { type: Boolean, default: true },
    created_by:  { type: String, default: null },
    deleted_at:  { type: Date,   default: null },
    options:     [QuestionOptionSchema],
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────
// QUIZ
// ─────────────────────────────────────────────

const QuizQuestionSchema = new mongoose.Schema(
  {
    question_id:     {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Question",
      required: true,
    },
    display_order:   { type: Number, default: 0 },
    points_override: { type: Number, default: null },
  },
  { _id: true }
);

const QuizSchema = new mongoose.Schema(
  {
    schoolId:     { type: String, required: true, index: true },
    title:        { type: String, required: true, trim: true  },
    description:  { type: String, default: null               },
    instructions: { type: String, default: null               },

    subject_id:   { type: String, default: null },
    class_id:     { type: String, default: null },

    time_limit_minutes: { type: Number, default: null },
    time_per_question:  { type: Number, default: null },

    shuffle_questions:  { type: Boolean, default: false },
    shuffle_options:    { type: Boolean, default: false },
    questions_per_page: { type: Number,  default: 1     },
    allow_backtrack:    { type: Boolean, default: true  },

    max_attempts:  { type: Number, default: 1    },
    passing_score: { type: Number, default: 70   },

    show_answers_after: {
      type: String,
      enum: ["immediately", "on_completion", "after_deadline", "never"],
      default: "on_completion",
    },
    show_score:       { type: Boolean, default: true },
    show_explanation: { type: Boolean, default: true },

    is_published: { type: Boolean, default: false },
    created_by:   { type: String,  default: null  },
    deleted_at:   { type: Date,    default: null  },

    questions: [QuizQuestionSchema],
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────
// QUIZ ATTEMPT
// ─────────────────────────────────────────────

const AnswerSelectionSchema = new mongoose.Schema(
  {
    selected_option_id: { type: String, required: true },
  },
  { _id: true }
);

const AttemptAnswerSchema = new mongoose.Schema(
  {
    question_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Question",
      required: true,
    },
    selected_option_id: { type: String,  default: null },
    text_answer:        { type: String,  default: null },
    selections:         [AnswerSelectionSchema],
    is_correct:         { type: Boolean, default: null },
    points_earned:      { type: Number,  default: 0    },
    points_possible:    { type: Number,  default: 0    },
    time_spent_secs:    { type: Number,  default: null },
    is_flagged:         { type: Boolean, default: false },
    answered_at:        { type: Date,    default: null  },
  },
  { _id: true }
);

const QuizAttemptSchema = new mongoose.Schema(
  {
    quiz_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Quiz",
      required: true,
    },
    user_id:        { type: String, required: true, index: true },
    schoolId:       { type: String, default: null               },
    attempt_number: { type: Number, default: 1                  },
    status: {
      type: String,
      enum: ["in_progress", "submitted", "timed_out", "abandoned"],
      default: "in_progress",
    },

    raw_score:  { type: Number, default: 0 },
    max_score:  { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    is_passed:  { type: Boolean, default: false },

    started_at:      { type: Date, default: Date.now },
    submitted_at:    { type: Date, default: null     },
    time_taken_secs: { type: Number, default: null   },

    answers: [AttemptAnswerSchema],
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────

const QuestionAnalyticsSchema = new mongoose.Schema(
  {
    question_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Question",
      unique: true,
    },
    times_shown:     { type: Number, default: 0 },
    times_answered:  { type: Number, default: 0 },
    times_correct:   { type: Number, default: 0 },
    avg_time_secs:   { type: Number, default: 0 },
    difficulty_score:{ type: Number, default: 0 },
  },
  { timestamps: true }
);

const QuizAnalyticsSchema = new mongoose.Schema(
  {
    quiz_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Quiz",
      unique: true,
    },
    total_attempts:    { type: Number, default: 0 },
    total_completions: { type: Number, default: 0 },
    total_passes:      { type: Number, default: 0 },
    avg_score:         { type: Number, default: 0 },
    avg_time_secs:     { type: Number, default: 0 },
    highest_score:     { type: Number, default: 0 },
    lowest_score:      { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = {
  QuestionCategory: mongoose.model("QuestionCategory", QuestionCategorySchema),
  Question:         mongoose.model("Question",         QuestionSchema),
  Quiz:             mongoose.model("Quiz",             QuizSchema),
  QuizAttempt:      mongoose.model("QuizAttempt",      QuizAttemptSchema),
  QuestionAnalytics:mongoose.model("QuestionAnalytics",QuestionAnalyticsSchema),
  QuizAnalytics:    mongoose.model("QuizAnalytics",    QuizAnalyticsSchema),
};