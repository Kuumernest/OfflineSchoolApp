// backend/src/db/models/Enrollment.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * Which class a student was in, for a given academic year.
 *
 * `student.classId` says where a student is NOW, and promotion overwrites it.
 * That single pointer cannot answer "which class was she in when she sat these
 * exams", which is precisely what a report card, a transcript and an arrears
 * breakdown all need — so the year is recorded here before the pointer moves.
 *
 * One row per student per year, enforced by the unique index. Promotion writes
 * the outgoing year as well as the incoming one, so the first run backfills the
 * history that was never captured before.
 */
const enrollmentSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:     { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },
    academicYear: { type: String, required: true, index: true },

    classId:   { type: String, default: null },
    /** Denormalised so history survives a class being renamed or deleted. */
    className: { type: String, default: null },

    /** How the student left this year. Null while the year is still running. */
    outcome: {
      type:    String,
      enum:    ["promoted", "repeated", "graduated", "transferred", "withdrawn", null],
      default: null,
    },

    /** The run that wrote this row, so a reversal knows what to undo. */
    promotionRunId: { type: String, default: null, index: true },

    enrolledAt: { type: Date, default: () => new Date() },
    deletedAt:  { type: Date, default: null },
  },
  { _id: false, timestamps: true }
);

// A student sits in exactly one class per year. This is what makes committing a
// promotion run idempotent: a replay collides rather than enrolling twice.
enrollmentSchema.index(
  { schoolId: 1, studentId: 1, academicYear: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

enrollmentSchema.index({ schoolId: 1, academicYear: 1, classId: 1 });


// The change feed's page (GET /api/sync/changes, config/syncFeed.js): filtered
// on schoolId and a keyset of (updatedAt, _id), sorted the same way. Without
// this the planner walked the school's rows in full for every page and every
// idle poll, examining N documents to return none (docs/37). The mobile pull
// (updatedAt >= since) is served by the same prefix.
enrollmentSchema.index({ schoolId: 1, updatedAt: 1, _id: 1 });
module.exports =
  mongoose.models.Enrollment ||
  mongoose.model("Enrollment", enrollmentSchema);
