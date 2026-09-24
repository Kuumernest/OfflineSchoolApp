// backend/src/db/models/LearningEvidenceSnapshot.js
"use strict";

/**
 * A learning-evidence reading as it stood on one day.
 *
 * The reading itself is recomputed on every request from the source records
 * (homework, quiz attempts, scores, attendance) — there is nothing to
 * overwrite. The snapshot is the memory: numbered per pupil, stamped with the
 * layer's version and `asOf`, carrying a hash of exactly which events it was
 * made from, so a rebuild on unchanged evidence returns it instead of minting
 * an identical one, and a corrected source record changes the NEXT reading
 * and never this one.
 *
 * What it keeps: counts, the pattern readings, quality, contradictions, the
 * concise lines. Not the events — they live in their source collections.
 * Not a name.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const learningEvidenceSnapshotSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, default: null },

    snapshotNumber:          { type: Number, required: true },
    learningEvidenceVersion: { type: String, required: true },
    asOf:                    { type: Date, default: null },

    evidenceBoundary: {
      type: new mongoose.Schema({ events: Number, latestEventAt: Date, hash: String }, { _id: false }),
      required: true,
    },

    // The reading, minus the events. Shape versioned by learningEvidenceVersion.
    reading: { type: mongoose.Schema.Types.Mixed, required: true },

    generatedAt: { type: Date, required: true },
    recordedBy:  { type: String, required: true },
    deletedAt:   { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

learningEvidenceSnapshotSchema.index({ schoolId: 1, studentId: 1, snapshotNumber: 1 }, { unique: true });

module.exports =
  mongoose.models.LearningEvidenceSnapshot ||
  mongoose.model("LearningEvidenceSnapshot", learningEvidenceSnapshotSchema);
