// backend/src/db/models/AcademicPolicySnapshot.js
"use strict";

const mongoose = require("mongoose");

/**
 * One school's academic rules for one year, frozen (docs/39 §6.3).
 *
 * The configuration a result is computed under — the structure and its
 * weights, the CA split, the grade bands, the pass marks, the ranking and
 * promotion rules — lives in documents a school edits in place. This is a
 * copy of their EFFECTIVE content at the moment something was computed under
 * them, so that a result can say which rules produced it long after the
 * documents have moved on (shared/academicPolicy.js builds the content).
 *
 * ── Keyed by its content ──────────────────────────────────────────────────
 *
 * `_id` is the SHA-256 of the canonical policy, which includes the school and
 * year. Equal rules are one document however many computations used them;
 * different rules are different documents; two schools never share one. And
 * because the key is `_id`, de-duplication rests on the one index MongoDB
 * always has — not on a declared index that production, with autoIndex off
 * (docs/37 §15), may not have built.
 *
 * ── Append-only ───────────────────────────────────────────────────────────
 *
 * A snapshot that could be edited would answer "which rules produced this?"
 * with whatever somebody wrote later. Same enforcement as ResultChangeLog:
 * the mutating entry points throw at the model layer.
 *
 * Nothing reads or writes this outside services/academicPolicy.service.js,
 * and in Phase 2b nothing computes under it yet — results start carrying its
 * hash in Phase 2c.
 */

const academicPolicySnapshotSchema = new mongoose.Schema(
  {
    // sha256 hex of canonicalJson(policy).
    _id: { type: String, required: true },

    schoolId:     { type: String, required: true },
    academicYear: { type: String, required: true },

    format:      { type: Number, required: true },
    calcVersion: { type: String, required: true },

    // The canonical policy itself, exactly as hashed.
    policy: { type: mongoose.Schema.Types.Mixed, required: true },

    /*
     * Where the content came from, the first time it was seen. NOT hashed:
     * an administrator who changes a weight and changes it back has the same
     * rules, and the same snapshot, with the provenance of its first use.
     */
    sources: {
      structureId:            { type: String, default: null },
      structureUpdatedAt:     { type: Date,   default: null },
      gradingConfigUpdatedAt: { type: Date,   default: null },
    },

    createdBy: { type: String, default: null },
  },
  {
    _id:        false,
    timestamps: { createdAt: true, updatedAt: false },
    minimize:   false,
  }
);

// "The rules this school has used this year, in order" — the admin view of
// policy history (Phase 5) and the staleness comparison (Phase 4).
academicPolicySnapshotSchema.index({ schoolId: 1, academicYear: 1, createdAt: -1 });

const refuse = (verb) => async function () {
  throw new Error(`AcademicPolicySnapshot is append-only — ${verb} is not permitted`);
};

academicPolicySnapshotSchema.pre("findOneAndUpdate", refuse("update"));
academicPolicySnapshotSchema.pre("updateOne",        { query: true, document: false }, refuse("update"));
academicPolicySnapshotSchema.pre("updateMany",       refuse("update"));
academicPolicySnapshotSchema.pre("replaceOne",       refuse("replace"));
academicPolicySnapshotSchema.pre("findOneAndDelete", refuse("delete"));
academicPolicySnapshotSchema.pre("findOneAndReplace", refuse("replace"));
academicPolicySnapshotSchema.pre("deleteOne",        { query: true, document: false }, refuse("delete"));
academicPolicySnapshotSchema.pre("deleteMany",       refuse("delete"));

academicPolicySnapshotSchema.pre("save", async function () {
  if (!this.isNew) {
    throw new Error("AcademicPolicySnapshot is append-only — update is not permitted");
  }
});

module.exports =
  mongoose.models.AcademicPolicySnapshot ||
  mongoose.model("AcademicPolicySnapshot", academicPolicySnapshotSchema);
