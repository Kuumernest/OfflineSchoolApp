// backend/src/db/models/ExamMark.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * A teacher's submitted exam marks for one student in one exam.
 *
 * The marks ENTRY screens write here: a teacher records what each pupil
 * scored, submits, and an administrator approves or rejects the submission.
 * Approved marks move into the results pipeline (StudentScore /
 * ResultSummary), which is what report cards and the sync feed read.
 *
 * The row is keyed by the TEACHER who wrote it — the same pupil's marks in
 * the same exam sit once under teacher A and once under teacher B until the
 * administrator decides — and `status` records where each submission is.
 *
 * `before` / `after` style change log does not apply: the submitted row is
 * the record, and the correction flows (changeReason on results) live at the
 * approved layer, not here.
 */

const examMarkSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Core references ───────────────────────────────────
    examId:    { type: String, ref: "Exam",    required: true, index: true },
    studentId: { type: String, ref: "Student", required: true, index: true },
    teacherId: { type: String, ref: "User",    required: true, index: true },

    // ── The marks themselves ──────────────────────────────
    marksObtained: { type: Number, default: null },
    totalMarks:    { type: Number, default: null },
    grade:         { type: String, default: null },
    remarks:       { type: String, default: null },

    // ── Submission lifecycle ──────────────────────────────
    status: {
      type:    String,
      enum:    ["pending", "submitted", "approved", "rejected"],
      default: "pending",
      index:   true,
    },
    submittedAt:  { type: Date,   default: null },
    approvedAt:   { type: Date,   default: null },
    approvedBy:   { type: String, default: null },
    rejectedAt:   { type: Date,   default: null },
    rejectedBy:   { type: String, default: null },
    rejectReason: { type: String, default: null },

    // ── Sync ─────────────────────────────────────────────
    syncStatus: {
      type:    String,
      enum:    ["synced", "pending", "conflict"],
      default: "pending",
    },
    deletedAt: { type: Date, default: null },
  },
  {
    _id:       false,
    timestamps: true,
    toJSON:    { virtuals: true },
    toObject:  { virtuals: true },
  }
);

// One teacher's row per exam per pupil. The pair can exist again under a
// different teacher, which is exactly the submission model above.
examMarkSchema.index(
  { examId: 1, studentId: 1, teacherId: 1 },
  { unique: true }
);
examMarkSchema.index({ teacherId: 1, status: 1 });

module.exports = mongoose.model("ExamMark", examMarkSchema);