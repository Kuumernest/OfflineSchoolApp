// backend/src/db/models/ExplorationObservation.js
"use strict";

/**
 * A teacher's dated observation of a pupil during an exploration activity.
 *
 * Structured: whether the behaviour was observed, partly observed, not
 * observed, or there was no opportunity; which of the layer's observation
 * codes applied (problem solving, persistence, communication, technical
 * execution, creative approach, collaboration, explanation, iteration); a
 * short note. These describe the activity as it happened. They are not
 * diagnoses, and the codes are the only vocabulary — "natural leader" and
 * "lazy" have no field to land in.
 *
 * One observation per teacher per exploration; a change is a revision on the
 * row. The evidence row it produces (kind teacher_observation) is derived by
 * shared/exploration with an id fixed by exploration and observer, so a
 * resend never doubles it.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { OBSERVATION_LEVELS, OBSERVATION_CODES } = require("../../../../shared/exploration");

const explorationObservationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    schoolId:      { type: String, required: true, index: true },
    studentId:     { type: String, required: true, index: true },
    classId:       { type: String, required: true, index: true },
    explorationId: { type: String, required: true, index: true },

    level: { type: String, enum: OBSERVATION_LEVELS, required: true },
    codes: { type: [String], enum: OBSERVATION_CODES, default: [] },
    note:  { type: String, default: null, maxlength: 1000 },

    observedBy: { type: String, required: true, index: true },
    observedAt: { type: Date, default: Date.now },

    revisions: {
      type: [new mongoose.Schema({ level: String, codes: [String], note: String, replacedAt: { type: Date, default: Date.now } }, { _id: false })],
      default: [],
    },
    version:   { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

explorationObservationSchema.index({ schoolId: 1, explorationId: 1, observedBy: 1 }, { unique: true });

module.exports =
  mongoose.models.ExplorationObservation ||
  mongoose.model("ExplorationObservation", explorationObservationSchema);
