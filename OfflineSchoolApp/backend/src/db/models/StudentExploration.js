// backend/src/db/models/StudentExploration.js
"use strict";

/**
 * One pupil's engagement with one catalog activity.
 *
 * ── What it is, and is not ────────────────────────────────────────────────
 *
 * The record of a choice and what followed it: discovered, saved, started,
 * submitted, reviewed, completed — or skipped, declined, abandoned. It is
 * never evidence of ability on its own. DISCOVERED and STARTED say the pupil
 * looked and began; NOT_INTERESTED is evidence of preference, not of failure,
 * and nothing about a pupil's strengths profile is lowered by it.
 *
 * ── What hangs off it ─────────────────────────────────────────────────────
 *
 *   ExplorationReflection    the pupil's own account, student-authored, private by default
 *   ExplorationObservation   a teacher's dated observation of the activity
 *   performance              a teacher's rating against the activity's own criteria (here)
 *   ExplorationEvidence      the rows the layer derives, one per kind, ids fixed
 *
 * Status is written only through exploration.service, under the transitions
 * in shared/exploration. Corrections revise; nothing here is silently
 * rewritten — the transition trail keeps every move.
 *
 * ── Offline ───────────────────────────────────────────────────────────────
 *
 * The client mints the _id (a UUID) so a retried create is a replay. Every
 * later mutation carries the row's version, as an intervention does.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { STATES, PERFORMANCE_CRITERIA, PERFORMANCE_RATINGS } = require("../../../../shared/exploration");

const COMPLETION_MODES = ["individual", "pair", "group", "with_teacher"];

const studentExplorationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, required: true, index: true },

    activityId:      { type: String, required: true, index: true },
    activityVersion: { type: Number, required: true },
    area:            { type: String, required: true },
    level:           { type: String, required: true },
    explorationEngineVersion: { type: String, required: true },

    status: { type: String, enum: STATES, default: "DISCOVERED", index: true },

    // Why it was in front of the pupil, as the recommender said it.
    suggestedBecause: { type: [String], default: [] },
    relevance:        { type: String, default: null },

    discoveredAt: { type: Date, default: Date.now },
    startedAt:    { type: Date, default: null },
    submittedAt:  { type: Date, default: null },
    completedAt:  { type: Date, default: null },
    closedAt:     { type: Date, default: null },

    completionMode: { type: String, enum: [...COMPLETION_MODES, null], default: null },

    // What the pupil says they produced, against the activity's expected outputs.
    outputs: {
      type: [new mongoose.Schema({ label: { type: String, maxlength: 200 }, value: { type: String, maxlength: 2000 } }, { _id: false })],
      default: [],
    },

    // A teacher's rating against the activity's own criteria — performance,
    // specific to this activity, never a score of the pupil.
    performance: {
      type: new mongoose.Schema({
        ratings: { type: [new mongoose.Schema({ criterion: { type: String, enum: PERFORMANCE_CRITERIA }, rating: { type: String, enum: PERFORMANCE_RATINGS } }, { _id: false })], default: [] },
        level:   { type: String, default: null },
        note:    { type: String, default: null, maxlength: 1000 },
        ratedBy: { type: String, required: true },
        ratedAt: { type: Date, default: Date.now },
      }, { _id: false }),
      default: null,
    },

    generatedEvidenceIds: { type: [String], default: [] },

    transitions: {
      type: [new mongoose.Schema({ from: String, to: String, at: { type: Date, default: Date.now }, by: String }, { _id: false })],
      default: [],
    },

    version:   { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

studentExplorationSchema.index({ schoolId: 1, studentId: 1, updatedAt: -1 });
studentExplorationSchema.index({ schoolId: 1, classId: 1, updatedAt: -1 });
studentExplorationSchema.index({ schoolId: 1, studentId: 1, activityId: 1, status: 1 });

const StudentExploration =
  mongoose.models.StudentExploration ||
  mongoose.model("StudentExploration", studentExplorationSchema);

StudentExploration.COMPLETION_MODES = COMPLETION_MODES;

module.exports = StudentExploration;
