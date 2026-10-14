// backend/src/db/models/ExplorationEvidence.js
"use strict";

/**
 * Something a pupil tried, enjoyed, was seen doing, or reflected on — outside
 * the marks.
 *
 * ── Four kinds that are never the same thing ──────────────────────────────
 *
 *   interest             the pupil says they would like to, or enjoyed         (student)
 *   exposure             the pupil took part — a club, a trip, a project       (teacher/office)
 *   performance          the pupil did something well, and a teacher saw it    (teacher/office)
 *   teacher_observation  a teacher's dated observation in a domain            (teacher/office)
 *   student_reflection   "I found this difficult", "I want help with this"    (student)
 *
 * Participation is not competence and interest is not ability. The strength
 * engine carries interest, exposure and reflection as separate signals and
 * never folds them into a strength; a teacher observation touches confidence
 * only under the one explicit rule in shared/strengths (two distinct teachers
 * recording a PERFORMANCE observation in a domain). The kind is on the row so
 * that no later reader can blur them.
 *
 * ── Domain, not occupation ────────────────────────────────────────────────
 *
 * A row names an exploration dimension and/or area from the layer's taxonomy;
 * it never names a profession. Free text is for what happened, not for what
 * the child should become.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { DIMENSIONS, EXPLORATION_AREAS } = require("../../../../shared/strengths");

// Stage 10 adds participation (the pupil engaged in an activity) and the
// system source for rows the exploration layer derives from a pupil's own
// moves. The strengths engine 1.0.0 reads the kinds it already knew;
// participation and performance are carried, not yet consumed.
const KINDS   = ["interest", "exposure", "participation", "performance", "teacher_observation", "student_reflection"];
const SOURCES = ["student", "teacher", "office", "system"];
const PARTICIPATION = ["attended", "took_part", "led", "completed", "did_not_complete", null];
const REFLECTIONS   = ["enjoyed", "want_more", "found_difficult", "want_help", null];

const explorationEvidenceSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, required: true, index: true },

    kind:   { type: String, enum: KINDS, required: true },
    source: { type: String, enum: SOURCES, required: true },

    dimension: { type: String, enum: [...DIMENSIONS, null], default: null },
    area:      { type: String, enum: [...EXPLORATION_AREAS.map((a) => a.code), null], default: null },

    activity: { type: String, required: true, maxlength: 200 },
    date:     { type: Date, required: true },

    // When the row came out of an exploration: which one, of which activity.
    explorationId:   { type: String, default: null, index: true },
    activityId:      { type: String, default: null },
    activityVersion: { type: Number, default: null },

    participation: { type: String, enum: PARTICIPATION, default: null },
    outcome:       { type: String, default: null, maxlength: 500 },
    reflection:    { type: String, enum: REFLECTIONS, default: null },
    notes:         { type: String, default: null, maxlength: 2000 },

    recordedBy: { type: String, required: true, index: true },

    version:   { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

explorationEvidenceSchema.index({ schoolId: 1, studentId: 1, date: -1 });
explorationEvidenceSchema.index({ schoolId: 1, classId: 1, updatedAt: -1 });

const ExplorationEvidence =
  mongoose.models.ExplorationEvidence ||
  mongoose.model("ExplorationEvidence", explorationEvidenceSchema);

ExplorationEvidence.KINDS = KINDS;
ExplorationEvidence.SOURCES = SOURCES;
ExplorationEvidence.PARTICIPATION = PARTICIPATION.filter(Boolean);
ExplorationEvidence.REFLECTIONS = REFLECTIONS.filter(Boolean);

module.exports = ExplorationEvidence;
