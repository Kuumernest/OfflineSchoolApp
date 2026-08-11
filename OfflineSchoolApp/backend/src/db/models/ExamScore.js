// backend/src/db/models/ExamScore.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const examScoreSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    examId:        { type: String, ref: "Exam",        required: true, index: true },
    examSubjectId: { type: String, ref: "ExamSubject", required: true},
    subjectId:     { type: String, ref: "Subject",     required: true, index: true },
    studentId:     { type: String, ref: "User",        required: true, index: true },
    classId:       { type: String, ref: "Class",       required: true, index: true },
    schoolId:      { type: String,                     required: true, index: true },

    score:         { type: Number, default: null },   // null = not entered
    maxScore:      { type: Number, default: 100  },
    passMark:      { type: Number, default: 50   },

    grade:         { type: String, default: null },
    gradePoint:    { type: Number, default: null },
    percentage:    { type: Number, default: null },

    isAbsent:      { type: Boolean, default: false },
    isExempt:      { type: Boolean, default: false },
    teacherRemark: { type: String,  default: null  },

    enteredBy:     { type: String, ref: "User", default: null },
    enteredAt:     { type: Date,   default: null },
    updatedBy:     { type: String, ref: "User", default: null },

    corrections: [
      {
        originalScore: { type: Number },
        newScore:      { type: Number },
        reason:        { type: String },
        correctedBy:   { type: String },
        correctedAt:   { type: Date   },
        _id:           false,
      },
    ],

    syncStatus:   { type: String, enum: ["synced", "pending", "conflict"], default: "synced" },
    lastSyncedAt: { type: Date, default: null },
    deletedAt:    { type: Date, default: null },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────

// One score record per student per subject per exam
examScoreSchema.index(
  { examId: 1, subjectId: 1, studentId: 1, classId: 1 },
  { unique: true }
);
examScoreSchema.index({ examId: 1, classId: 1 });
examScoreSchema.index({ studentId: 1, examId: 1 });
examScoreSchema.index({ schoolId: 1, examId: 1 });
examScoreSchema.index({ examSubjectId: 1 });
examScoreSchema.index({ examId: 1, subjectId: 1, classId: 1 });

module.exports = mongoose.model("ExamScore", examScoreSchema);