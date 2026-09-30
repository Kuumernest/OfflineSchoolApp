// backend/src/db/models/IntelligenceStudentFeedback.js
"use strict";

/**
 * A pupil's answers to the bounded pilot questions about their own summary.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * Stage 18 asks, where a pilot includes actual pupil use, whether pupils can
 * understand what the system observed, what it inferred, what remains
 * uncertain, what evidence supports the reading, what they can explore and
 * what they choose themselves. Six questions, each answered from four words.
 * A pupil is not asked whether an algorithm is "correct".
 *
 * ── What it is not ────────────────────────────────────────────────────────
 *
 * Not a review (a teacher's judgement of a case lives on IntelligenceReview
 * and this is not a second copy of it), not free text (there is none), not
 * an input to any engine (nothing reads it but the pilot report, which counts
 * answers per question and never lists a pupil), and not a profile of the
 * pupil (six words about a screen say nothing about a child).
 *
 * One row per pupil per pilot; a second submission replaces the first and
 * says when. The row names the pilot it was given in, so a later pilot never
 * counts it, and the engine versions the summary was of.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const QUESTIONS = ["observedClear", "inferredClear", "uncertaintyClear", "evidenceClear", "explorationClear", "choiceClear"];
const ANSWERS   = ["YES", "PARTLY", "NO", "NOT_SHOWN"];

const answersSchema = new mongoose.Schema(
  Object.fromEntries(QUESTIONS.map((q) => [q, { type: String, enum: ANSWERS, required: true }])),
  { _id: false }
);

const intelligenceStudentFeedbackSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    schoolId:   { type: String, required: true, index: true },
    studentId:  { type: String, required: true },
    pilotRunId: { type: String, required: true, index: true },
    answers:    { type: answersSchema, required: true },
    advancedIntelligenceVersion: { type: String, required: true, maxlength: 20 },
    strengthEngineVersion:       { type: String, required: true, maxlength: 20 },
    submittedAt: { type: Date, default: Date.now },
    revisedAt:   { type: Date, default: null },
    deletedAt:   { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

intelligenceStudentFeedbackSchema.index({ pilotRunId: 1, studentId: 1 }, { unique: true });

const IntelligenceStudentFeedback =
  mongoose.models.IntelligenceStudentFeedback ||
  mongoose.model("IntelligenceStudentFeedback", intelligenceStudentFeedbackSchema);

IntelligenceStudentFeedback.QUESTIONS = QUESTIONS;
IntelligenceStudentFeedback.ANSWERS   = ANSWERS;

module.exports = IntelligenceStudentFeedback;
