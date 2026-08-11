// backend/src/db/models/ResultSummary.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const subjectBreakdownSchema = new mongoose.Schema(
  {
    subjectId:      { type: String,  required: true  },
    subjectName:    { type: String,  default: null   },
    score:          { type: Number,  default: 0      },
    maxScore:       { type: Number,  default: 100    },
    normalizedMark: { type: Number,  default: 0      },
    grade:          { type: String,  default: null   },
    points:         { type: Number,  default: 0      },
    remark:         { type: String,  default: null   },
    isPassing:      { type: Boolean, default: false  },
    isAbsent:       { type: Boolean, default: false  },
  },
  { _id: false }
);

const resultSummarySchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Core References ──────────────────────────────────────
    examId:    { type: String, ref: "Exam",    required: true, index: true },
    studentId: { type: String, ref: "Student", required: true, index: true },
    classId:   { type: String, ref: "Class",   required: true, index: true },
    schoolId:  { type: String,                 required: true, index: true },

    // ── Denormalized Student Info ────────────────────────────
    studentName: { type: String, default: null },
    admissionNo: { type: String, default: null },
    className:   { type: String, default: null },

    // ── Academic Period ──────────────────────────────────────
    academicYear: { type: String, default: null, index: true },
    term:         { type: String, default: null },

    // ── Aggregate Scores ─────────────────────────────────────
    totalScore:    { type: Number, default: 0    },
    maxTotalScore: { type: Number, default: 0    },
    percentage:    { type: Number, default: 0    },
    average:       { type: Number, default: 0    },
    overallGrade:  { type: String, default: null },
    overallRemark: { type: String, default: null },
    gpa:           { type: Number, default: null },

    // ── Pass/Fail Counts ─────────────────────────────────────
    subjectsPassed: { type: Number,  default: 0     },
    subjectsFailed: { type: Number,  default: 0     },
    subjectsTotal:  { type: Number,  default: 0     },
    isPassing:      { type: Boolean, default: false },

    // ── Rankings ─────────────────────────────────────────────
    classPosition:  { type: Number, default: null },
    gradePosition:  { type: Number, default: null },
    schoolPosition: { type: Number, default: null },
    totalInClass:   { type: Number, default: null },
    totalInGrade:   { type: Number, default: null },
    totalInSchool:  { type: Number, default: null },

    // ── Subject Breakdown ────────────────────────────────────
    subjectBreakdown: { type: [subjectBreakdownSchema], default: [] },

    // ── Flags ────────────────────────────────────────────────
    isPartial: { type: Boolean, default: false },

    // ── Remarks ──────────────────────────────────────────────
    principalRemark: { type: String, default: null },
    promotionStatus: {
      type:    String,
      enum:    ["promoted", "repeated", "conditional", "graduated", "pending"],
      default: "pending",
    },

    // ── Publishing ───────────────────────────────────────────
    isPublished: { type: Boolean, default: false },
    publishedAt: { type: Date,    default: null  },
    isLocked:    { type: Boolean, default: false },
    lockedAt:    { type: Date,    default: null  },

    // ── Sync ─────────────────────────────────────────────────
    syncStatus:   { type: String, enum: ["synced", "pending", "conflict"], default: "pending" },
    lastSyncedAt: { type: Date,   default: null },
    deletedAt:    { type: Date,   default: null },
  },
  {
    _id:       false,
    timestamps: true,
    toJSON:    { virtuals: true },
    toObject:  { virtuals: true },
  }
);

// ── Indexes ──────────────────────────────────────────────────────────────────

resultSummarySchema.index(
  { examId: 1, studentId: 1 },
  { unique: true, sparse: true }
);
resultSummarySchema.index({ examId: 1, classId: 1, classPosition: 1 });
resultSummarySchema.index({ examId: 1, schoolPosition: 1 });
resultSummarySchema.index({ examId: 1, gradePosition: 1 });
resultSummarySchema.index({ schoolId: 1, isPublished: 1 });
resultSummarySchema.index({ examId: 1, academicYear: 1, term: 1 });

module.exports = mongoose.model("ResultSummary", resultSummarySchema);