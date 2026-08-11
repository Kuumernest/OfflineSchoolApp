// backend/src/db/models/Exam.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const examSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:  { type: String, required: true, index: true },

    // ── Single class (primary / backwards compat) ─────────
    classId:   { type: String, ref: "Class", index: true, default: null },
    className: { type: String, default: null },

    // ── Multiple classes support ──────────────────────────
    classIds:   { type: [String], default: [] },
    classNames: { type: String,   default: null },

    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    type: {
      type:    String,
      enum:    [
        "first_test", "second_test", "mid_term", "practical",
        "final_exam", "mock_exam", "promotion_exam", "continuous_assessment",
      ],
      default: "first_test",
    },

    academicYear: { type: String, required: true },
    term:         { type: String, required: true },

    startDate: { type: String, default: null },
    endDate:   { type: String, default: null },

    status: {
      type:    String,
      enum:    ["draft", "scheduled", "ongoing", "completed", "published", "archived"],
      default: "draft",
      index:   true,
    },

    description:  { type: String, default: null },
    instructions: { type: String, default: null },

    totalMarks: { type: Number, default: 100 },
    passMark:   { type: Number, default: 50  },

    resultsPublished:   { type: Boolean, default: false },
    resultsLockedAt:    { type: Date,    default: null  },
    resultsPublishedAt: { type: Date,    default: null  },
    publishedBy:        { type: String,  default: null  },

    createdBy: { type: String, ref: "User", default: null },
    updatedBy: { type: String, ref: "User", default: null },

    syncStatus:   { type: String, enum: ["synced", "pending", "conflict"], default: "synced" },
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

examSchema.index({ schoolId: 1, status: 1 });
examSchema.index({ schoolId: 1, academicYear: 1, term: 1 });
examSchema.index({ schoolId: 1, classId: 1, status: 1 });
examSchema.index({ schoolId: 1, classIds: 1 });

module.exports = mongoose.model("Exam", examSchema);