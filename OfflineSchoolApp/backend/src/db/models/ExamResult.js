// backend/src/db/models/ExamResult.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * Aggregated result per student per exam.
 * Computed from ExamScore records after all subjects are submitted.
 * This is the single source of truth for rankings and report cards.
 */

const subjectScoreSchema = new mongoose.Schema(
  {
    subjectId:     { type: String, default: null },
    subjectName:   { type: String, default: null },
    score:         { type: Number, default: null },
    maxScore:      { type: Number, default: 100  },
    passMark:      { type: Number, default: 50   },
    grade:         { type: String, default: null },
    gradePoint:    { type: Number, default: null },
    percentage:    { type: Number, default: null },
    normalizedMark:{ type: Number, default: null }, // out of 20 (Cameroon)
    isAbsent:      { type: Boolean, default: false },
    isExempt:      { type: Boolean, default: false },
    teacherRemark: { type: String,  default: null  },
    isPassing:     { type: Boolean, default: false },
  },
  { _id: false }
);

const examResultSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    examId:    { type: String, ref: "Exam",    required: true, index: true },
    studentId: { type: String, ref: "User",    required: true, index: true },
    classId:   { type: String, ref: "Class",   required: true, index: true },
    schoolId:  { type: String,                 required: true, index: true },

    // ── Denormalised student info for fast reads ──────────────────────────
    studentName:  { type: String, default: null },
    admissionNo:  { type: String, default: null },
    className:    { type: String, default: null },
    academicYear: { type: String, default: null },
    term:         { type: String, default: null },

    // ── Subject breakdown ─────────────────────────────────────────────────
    subjectScores: { type: [subjectScoreSchema], default: [] },

    // ── Aggregates ────────────────────────────────────────────────────────
    totalScore:      { type: Number, default: 0    },
    totalMaxScore:   { type: Number, default: 0    },
    percentage:      { type: Number, default: 0    },
    average:         { type: Number, default: 0    }, // normalized /20
    gpa:             { type: Number, default: 0    },
    subjectsPassed:  { type: Number, default: 0    },
    subjectsFailed:  { type: Number, default: 0    },
    subjectsTaken:   { type: Number, default: 0    },
    subjectsAbsent:  { type: Number, default: 0    },
    isPassing:       { type: Boolean, default: false },

    // ── Overall grade ─────────────────────────────────────────────────────
    overallGrade:   { type: String, default: null },
    overallRemark:  { type: String, default: null },
    principalRemark:{ type: String, default: null },

    promotionStatus: {
      type:    String,
      enum:    ["pending", "promoted", "repeated", "conditional", "graduated"],
      default: "pending",
    },

    // ── Rankings ──────────────────────────────────────────────────────────
    classPosition:  { type: Number, default: null },
    gradePosition:  { type: Number, default: null },
    schoolPosition: { type: Number, default: null },
    totalInClass:   { type: Number, default: null },
    totalInGrade:   { type: Number, default: null },
    totalInSchool:  { type: Number, default: null },

    // ── Partial flag ──────────────────────────────────────────────────────
    isPartial:    { type: Boolean, default: false },

    // ── Publishing ────────────────────────────────────────────────────────
    isPublished:  { type: Boolean, default: false },
    publishedAt:  { type: Date,    default: null  },
    publishedBy:  { type: String,  default: null  },
    isLocked:     { type: Boolean, default: false },
    lockedAt:     { type: Date,    default: null  },

    // ── Sync ─────────────────────────────────────────────────────────────
    syncStatus:   { type: String, enum: ["synced", "pending", "conflict"], default: "synced" },
    lastSyncedAt: { type: Date,   default: null },
    deletedAt:    { type: Date,   default: null },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────

examResultSchema.index(
  { examId: 1, studentId: 1 },
  { unique: true }
);
examResultSchema.index({ examId: 1, classId: 1, classPosition: 1 });
examResultSchema.index({ examId: 1, schoolPosition: 1 });
examResultSchema.index({ examId: 1, gradePosition: 1 });
examResultSchema.index({ schoolId: 1, isPublished: 1 });
examResultSchema.index({ examId: 1, academicYear: 1, term: 1 });
examResultSchema.index({ studentId: 1, academicYear: 1, term: 1 });

module.exports = mongoose.model("ExamResult", examResultSchema);