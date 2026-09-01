// backend/src/db/models/Exam.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const examSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:  { type: String, required: true, index: true },

    // ── Class references ──────────────────────────────────
    classId:   { type: String, ref: "Class", index: true, default: null },
    className: { type: String, default: null },
    classIds:   { type: [String], default: [] },
    classNames: { type: String,   default: null },

    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // ── Simplified type — only 3 values ───────────────────
    type: {
      type:    String,
      enum:    ["test", "practical", "promotion_exam"],
      default: "test",
    },

    // ── Sequence binding (1–6) ────────────────────────────
    sequenceNumber: {
      type:    Number,
      min:     1,
      max:     6,
      default: null,
    },

    // ── Academic period ───────────────────────────────────
    academicYear: { type: String, required: true },
    term:         { type: Number, required: true, min: 1, max: 3 },

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

    // ── Weighting ─────────────────────────────────────────
    weight: { type: Number, default: 100 }, // percentage weight within its sequence

    // ── Publishing ────────────────────────────────────────
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
examSchema.index({ schoolId: 1, academicYear: 1, term: 1, sequenceNumber: 1 });
examSchema.index({ schoolId: 1, classId: 1, status: 1 });
examSchema.index({ schoolId: 1, classIds: 1 });

module.exports = mongoose.model("Exam", examSchema);
