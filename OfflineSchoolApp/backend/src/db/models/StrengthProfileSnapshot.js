// backend/src/db/models/StrengthProfileSnapshot.js
"use strict";

/**
 * A strengths profile as it read on one day.
 *
 * ── Why a snapshot at all ─────────────────────────────────────────────────
 *
 * The profile is derived and recomputed on every read, so there is nothing to
 * overwrite. But the brief's longitudinal requirement is that a pupil's
 * PROGRESSION stays visible — "Term 1 emerging, Term 2 recurring, Term 3
 * persistent" — and a recomputation cannot show what it used to say. A
 * snapshot is that memory: taken deliberately (a teacher or the office at a
 * term's end), numbered per pupil, stamped with both engine versions and the
 * period the evidence covered, and never edited.
 *
 * ── What it keeps, and what it does not ───────────────────────────────────
 *
 * The reading: strengths, emerging and declining dimensions, exploration
 * areas, confidence, coverage, limitations. Not the per-subject mark series —
 * that lives in the results and would drift from them the moment a mark was
 * corrected. Not a name. Identity is joined by the service layer, as for
 * every other intelligence record.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const strengthProfileSnapshotSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, default: null },

    // Per pupil, 1, 2, 3 … in the order taken.
    profileVersion:        { type: Number, required: true },
    academicEngineVersion:    { type: String, required: true },
    strengthEngineVersion:    { type: String, required: true },
    explorationEngineVersion: { type: String, default: null },

    // The evidence the reading was made from: how much, up to when, and a
    // hash of exactly which rows — so a rebuild on unchanged evidence returns
    // this snapshot instead of minting an identical one.
    asOf: { type: Date, default: null },
    evidenceBoundary: {
      type: new mongoose.Schema({ evidenceRows: Number, latestEvidenceAt: Date, academicTo: mongoose.Schema.Types.Mixed, hash: String }, { _id: false }),
      default: null,
    },

    sourcePeriod: {
      type: new mongoose.Schema({ from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed, sequences: Number }, { _id: false }),
      default: null,
    },
    periodLabel: { type: String, default: null, maxlength: 60 },

    generatedAt: { type: Date, required: true },
    recordedBy:  { type: String, required: true },

    // The reading, as the engine produced it. Mixed on purpose: the shape is
    // the strength engine's and is versioned by strengthEngineVersion.
    profile: { type: mongoose.Schema.Types.Mixed, required: true },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

strengthProfileSnapshotSchema.index({ schoolId: 1, studentId: 1, profileVersion: 1 }, { unique: true });

module.exports =
  mongoose.models.StrengthProfileSnapshot ||
  mongoose.model("StrengthProfileSnapshot", strengthProfileSnapshotSchema);
