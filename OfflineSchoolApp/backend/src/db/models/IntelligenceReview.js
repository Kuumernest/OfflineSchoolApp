// backend/src/db/models/IntelligenceReview.js
"use strict";

/**
 * A teacher's judgement of one thing the engine said about one pupil.
 *
 * ── Why this is a collection ──────────────────────────────────────────────
 *
 * The engine's conclusions are derived and never stored — recompute them from
 * published marks whenever anybody asks. A teacher's opinion of a conclusion
 * is the opposite kind of thing: a person looked at the evidence and said
 * "yes, that is this child" or "no, that was a hard paper". Nothing in the
 * school's records says that, and it is exactly the evidence the calibration
 * protocol in docs/25 needs before any rule may change.
 *
 * ── Why it is not the teacher's private note ──────────────────────────────
 *
 * A review is a school record about a pupil, like an intervention. The teacher
 * who wrote it is named on it and stays named on it; a head teacher reading
 * the school's reviews sees who said what, which is what makes a disagreement
 * between two reviewers worth anything. Visibility follows the same hierarchy
 * as every other intelligence read: a teacher for the classes they take, the
 * office for the school, the platform operator for the school they have
 * selected.
 *
 * ── What it stores about the engine ───────────────────────────────────────
 *
 * The codes that were on the sheet and the engine version that produced them.
 * Not the evidence, not the marks, not the guidance text: those are recomputed
 * from source, and a copy frozen here would drift from the report card the
 * moment a mark was corrected. What a review needs to remain meaningful is
 * "what was I asked about", and codes plus a version answer that.
 *
 * ── Nothing here feeds back into the engine ───────────────────────────────
 *
 * A review changes no classification, no threshold and no guidance. It is
 * read by scripts/calibration/reviewFeedback.js, cross-tabulated, and put in
 * front of a human who decides whether a rule should change. That is the
 * whole loop, and this is the only place a human's verdict is written down.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const YES_NO_UNCERTAIN = ["YES", "NO", "UNCERTAIN"];
const APPROPRIATE      = ["YES", "PARTIALLY", "NO", "UNCERTAIN"];

const temporalSchema = new mongoose.Schema(
  {
    interpretationReasonable: { type: String, enum: [...YES_NO_UNCERTAIN, null], default: null },
    possibleExplanation: {
      type: String,
      enum: [
        "genuine_student_change", "assessment_difficulty", "curriculum_or_content_change",
        "grading_change", "missing_data", "attendance_or_context", "other", null,
      ],
      default: null,
    },
  },
  { _id: false }
);

const formSchema = new mongoose.Schema(
  {
    observedPattern:           { type: String, enum: [...YES_NO_UNCERTAIN, null], default: null },
    classificationAppropriate: { type: String, enum: [...APPROPRIATE, null],      default: null },
    evidenceSufficient:        { type: String, enum: ["YES", "NO", null],         default: null },
    guidanceAppropriate:       { type: String, enum: [...APPROPRIATE, null],      default: null },
    reason:   { type: String, default: null, maxlength: 2000 },
    notes:    { type: String, default: null, maxlength: 4000 },
    // Where the reviewer thinks the problem is the data, not the rule. Codes,
    // never free text, so it can be counted; it changes no result and no rule.
    dataQuality: {
      type: [String],
      enum: [
        "missing_assessment", "incorrect_result", "unpublished_result", "assessment_unusually_difficult",
        "grading_change", "student_absence", "curriculum_change", "insufficient_history",
        "stale_record", "context_unavailable", "other",
      ],
      default: [],
    },
    temporal: { type: temporalSchema, default: undefined },
  },
  { _id: false }
);

const intelligenceReviewSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Tenancy and subject ────────────────────────────────────────────────
    // classId is stored, as on Intervention, because it is what the sync
    // feed's taught-pupils scope filters on and what decides whether a teacher
    // may see the row.
    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, required: true, index: true },
    subjectId: { type: String, default: null },

    // ── What was reviewed ──────────────────────────────────────────────────
    // The review category the case was selected under, the codes that were on
    // the sheet, and the engine that produced them.
    category:      { type: String, required: true, maxlength: 60 },
    engineVersion: { type: String, required: true, maxlength: 20 },
    classifications: {
      type: [new mongoose.Schema({ code: String, confidence: String }, { _id: false })],
      default: [],
    },

    // ── The pilot it was made inside, if any ───────────────────────────────
    // Stamped by the server from the school's open pilot at the moment of
    // submission; null when no pilot was open. A pilot's evidence snapshot
    // counts the reviews that carry its id and no others, so a review made
    // in a synthetic or development exercise can never be counted as real
    // evidence, and one made before a pilot opened is not that pilot's.
    pilotRunId: { type: String, default: null, index: true },
    pilotKind:  { type: String, enum: ["synthetic", "development", "real", null], default: null },

    // ── The judgement ──────────────────────────────────────────────────────
    review: { type: formSchema, required: true },

    // ── Who, and when ──────────────────────────────────────────────────────
    // Named, and it stays named. See the header.
    reviewedBy: { type: String, required: true, index: true },
    reviewedAt: { type: Date, default: Date.now },

    // ── Revision, without erasure ──────────────────────────────────────────
    // The author may correct their own review. What they said before is kept,
    // with when it was replaced, because a review is calibration evidence and
    // evidence that can be silently rewritten is not evidence. engineVersion is
    // NOT touched by a revision: the review was of what version 1.0.0 said,
    // whatever the engine says today.
    revisedAt: { type: Date, default: null },
    revisions: {
      type: [new mongoose.Schema({ review: formSchema, replacedAt: { type: Date, default: Date.now } }, { _id: false })],
      default: [],
    },

    // ── Offline concurrency, as on Intervention ────────────────────────────
    version:   { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

// The reads the routes make: one pupil's reviews, and one class's for the sheet.
intelligenceReviewSchema.index({ schoolId: 1, studentId: 1, updatedAt: -1 });
intelligenceReviewSchema.index({ schoolId: 1, classId: 1, updatedAt: -1 });
// One reviewer, one review per case. A second opinion from the same person is a
// revision of the first, not a new row that would count twice in the tally.
intelligenceReviewSchema.index(
  { schoolId: 1, studentId: 1, category: 1, subjectId: 1, reviewedBy: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.IntelligenceReview ||
  mongoose.model("IntelligenceReview", intelligenceReviewSchema);
