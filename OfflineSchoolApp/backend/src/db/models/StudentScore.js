// backend/src/db/models/StudentScore.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const correctionSchema = new mongoose.Schema(
  {
    originalScore: { type: Number, default: null },
    newScore:      { type: Number, default: null },
    reason:        { type: String, default: null },
    correctedBy:   { type: String, default: null },
    correctedAt:   { type: Date,   default: () => new Date() },
  },
  { _id: false }
);

const studentScoreSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Core references ───────────────────────────────────
    examId:        { type: String, ref: "Exam",        required: true, index: true },
    // ✅ NOT required — scores can be entered before exam subjects are fully set up
    examSubjectId: { type: String, ref: "ExamSubject", default: null  },
    studentId:     { type: String, ref: "Student",     required: true, index: true },
    subjectId:     { type: String, ref: "Subject",     required: true, index: true },
    classId:       { type: String, ref: "Class",       required: true, index: true },
    schoolId:      { type: String,                     required: true, index: true },

    // ── Score data ────────────────────────────────────────
    score:     { type: Number, default: null  },
    maxScore:  { type: Number, default: 100   },
    passMark:  { type: Number, default: 50    },

    // ── Computed ──────────────────────────────────────────
    percentage: { type: Number,  default: null  },
    grade:      { type: String,  default: null  },
    remark:     { type: String,  default: null  },
    gpaPoints:  { type: Number,  default: null  },
    isPassing:  { type: Boolean, default: null  },

    // ── Flags ─────────────────────────────────────────────
    isAbsent: { type: Boolean, default: false },
    isExempt: { type: Boolean, default: false },

    // ── Teacher remarks ───────────────────────────────────
    teacherRemark: { type: String, default: null },

    // ── Correction log ────────────────────────────────────
    corrections: { type: [correctionSchema], default: [] },

    // ── Audit ─────────────────────────────────────────────
    enteredBy:    { type: String, ref: "User", default: null },
    enteredAt:    { type: Date,               default: null  },
    updatedBy:    { type: String, ref: "User", default: null },
    verifiedBy:   { type: String, ref: "User", default: null },
    verifiedAt:   { type: Date,               default: null  },

    // ── Sync ─────────────────────────────────────────────
    syncStatus:   {
      type:    String,
      enum:    ["synced", "pending", "conflict"],
      default: "pending",
    },
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

// ── Indexes ───────────────────────────────────────────────
studentScoreSchema.index(
  { examId: 1, studentId: 1, subjectId: 1 },
  { unique: true, sparse: true }
);
studentScoreSchema.index({ examId: 1, classId: 1,    subjectId: 1 });
studentScoreSchema.index({ examId: 1, subjectId: 1                });
studentScoreSchema.index({ schoolId: 1, studentId: 1             });
studentScoreSchema.index({ syncStatus: 1                          });
studentScoreSchema.index({ examId: 1, classId: 1, syncStatus: 1  });

module.exports = mongoose.model("StudentScore", studentScoreSchema);