// backend/src/db/models/ExplorationReflection.js
"use strict";

/**
 * A pupil's own account of an exploration.
 *
 * ── Student-authored, and treated that way ────────────────────────────────
 *
 * Controlled values first — interest, difficulty, whether to continue — so
 * they can be counted; free text kept apart. The pupil chooses whether the
 * text is shared with their teachers; the controlled values are visible to
 * the staff who may see the pupil, because the pattern "high interest, limited
 * performance" needs them. A guardian sees neither. Nothing here is converted
 * into a strength: a reflection is what the pupil said, not what the system
 * concluded.
 *
 * ── Revised, never rewritten ──────────────────────────────────────────────
 *
 * A pupil may change their mind. The earlier account is pushed onto
 * revisions[] with when it was replaced; the row's version moves; nothing is
 * lost. One reflection per exploration.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { REFLECTION } = require("../../../../shared/exploration");

const bodySchema = new mongoose.Schema(
  {
    interest:   { type: String, enum: [...REFLECTION.interest, null],   default: null },
    difficulty: { type: String, enum: [...REFLECTION.difficulty, null], default: null },
    continue:   { type: String, enum: [...REFLECTION.continue, null],   default: null },
    enjoyed:    { type: String, default: null, maxlength: 1000 },
    difficult:  { type: String, default: null, maxlength: 1000 },
    next:       { type: String, default: null, maxlength: 1000 },
    shareText:  { type: Boolean, default: false },
  },
  { _id: false }
);

const explorationReflectionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    schoolId:      { type: String, required: true, index: true },
    studentId:     { type: String, required: true, index: true },
    classId:       { type: String, required: true, index: true },
    explorationId: { type: String, required: true },

    body: { type: bodySchema, required: true },
    revisions: {
      type: [new mongoose.Schema({ body: bodySchema, replacedAt: { type: Date, default: Date.now } }, { _id: false })],
      default: [],
    },

    authoredBy: { type: String, required: true },
    version:    { type: Number, default: 1 },
    deletedAt:  { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

explorationReflectionSchema.index({ schoolId: 1, explorationId: 1 }, { unique: true });
explorationReflectionSchema.index({ schoolId: 1, studentId: 1, updatedAt: -1 });

module.exports =
  mongoose.models.ExplorationReflection ||
  mongoose.model("ExplorationReflection", explorationReflectionSchema);
