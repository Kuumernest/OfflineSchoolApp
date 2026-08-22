// backend/src/db/models/ResultChangeLog.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * Append-only history of everything that changes a result.
 *
 * Why a table and not more fields
 * -------------------------------
 * ExamSubject already stamps `approvedBy` / `approvedAt`, and ExamScore keeps a
 * `corrections[]` array. Both record only the *latest* state: the next approval
 * overwrites the last one, so "who changed this mark, when, and why" cannot be
 * answered after the second edit. A results system that publishes to parents
 * has to answer that question months later, which means one row per change and
 * no updates, ever.
 *
 * Nothing in the codebase may update or delete a row here. The pre-hooks below
 * enforce that rather than trusting every future caller to remember.
 */

const resultChangeLogSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    // ── Scope ────────────────────────────────────────────────────────────────
    schoolId:  { type: String, required: true, index: true },
    examId:    { type: String, required: true, index: true },

    // Null for exam-wide events such as locking every result at once.
    studentId: { type: String, default: null, index: true },
    subjectId: { type: String, default: null },

    /** The row that actually changed, when there is one. */
    entity: {
      type:     String,
      required: true,
      enum:     ["score", "summary", "examSubject", "exam"],
    },
    entityId: { type: String, default: null },

    // ── What happened ────────────────────────────────────────────────────────
    action: {
      type:     String,
      required: true,
      enum: [
        "created", "updated", "deleted",
        "submitted", "approved", "rejected",
        "published", "unpublished",
        "locked", "unlocked",
      ],
      index: true,
    },

    /** Field-level detail. Null on whole-row events like `locked`. */
    field:    { type: String, default: null },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Required by the write guard whenever the result was already locked or
     * published — that is the whole point of the field. Optional for ordinary
     * edits made before publication.
     */
    reason: { type: String, default: null },

    /**
     * True when an admin edited past a lock. These are the rows an auditor
     * actually wants, so they are indexed and easy to filter to.
     */
    isOverride: { type: Boolean, default: false, index: true },

    // ── Who ──────────────────────────────────────────────────────────────────
    changedBy:     { type: String, default: null },
    changedByName: { type: String, default: null },  // denormalised: users get renamed
    changedByRole: { type: String, default: null },
    changedAt:     { type: Date,   default: Date.now, index: true },

    /** Correlates a batch: every row of one bulk save shares this. */
    batchId: { type: String, default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// The two questions this table is asked: "history for this student's result"
// and "show me every override on this exam".
resultChangeLogSchema.index({ examId: 1, studentId: 1, changedAt: -1 });
resultChangeLogSchema.index({ schoolId: 1, isOverride: 1, changedAt: -1 });

// ── Append-only enforcement ──────────────────────────────────────────────────
// An audit trail that can be rewritten is not an audit trail. These block the
// mutating entry points at the model layer, so a future caller cannot quietly
// undo history by using the wrong helper.
// Async hooks, not the `next` callback form: Mongoose 9 no longer passes a
// `next` to document middleware, so a callback-style hook throws
// "next is not a function" on every save. The same trap already bit the
// Announcement and School pre-save hooks in this codebase.
const refuse = (verb) => async function () {
  throw new Error(`ResultChangeLog is append-only — ${verb} is not permitted`);
};

resultChangeLogSchema.pre("findOneAndUpdate", refuse("update"));
resultChangeLogSchema.pre("updateOne",        { query: true, document: false }, refuse("update"));
resultChangeLogSchema.pre("updateMany",       refuse("update"));
resultChangeLogSchema.pre("replaceOne",       refuse("replace"));
resultChangeLogSchema.pre("findOneAndDelete", refuse("delete"));
resultChangeLogSchema.pre("deleteOne",        { query: true, document: false }, refuse("delete"));
resultChangeLogSchema.pre("deleteMany",       refuse("delete"));

resultChangeLogSchema.pre("save", async function () {
  if (!this.isNew) {
    throw new Error("ResultChangeLog is append-only — update is not permitted");
  }
});

module.exports =
  mongoose.models.ResultChangeLog ||
  mongoose.model("ResultChangeLog", resultChangeLogSchema);
