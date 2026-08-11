// backend/src/db/models/Announcement.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

const readReceiptSchema = new mongoose.Schema(
  {
    user:   { type: String, ref: "User", required: true },
    readAt: { type: Date,   default: Date.now           },
  },
  { _id: false }
);

const acknowledgeReceiptSchema = new mongoose.Schema(
  {
    user:           { type: String, ref: "User", required: true },
    acknowledgedAt: { type: Date,   default: Date.now           },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const announcementSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────
    _id: {
      type:    String,
      default: uuidv4,
    },

    // ── School scope ──────────────────────────────────────────────────────
    schoolId: {
      type:     String,
      required: true,
      index:    true,
    },

    // ── Content ───────────────────────────────────────────────────────────
    title: {
      type:     String,
      required: true,
      trim:     true,
      maxlength: 300,
    },

    body: {
      type:     String,
      required: true,
      trim:     true,
    },

    // ── Authorship ────────────────────────────────────────────────────────
    author: {
      type: String,
      ref:  "User",
      default: null,
    },

    authorName: {
      type:    String,
      default: null,
      trim:    true,
    },

    authorRole: {
      type: String,
      enum: ["super_admin", "school_admin", "teacher", "system", null],
      default: null,
    },

    // ── Audience ──────────────────────────────────────────────────────────
    audience: {
      type:    String,
      enum:    ["all", "students", "teachers", "class", "parents"],
      default: "all",
      index:   true,
    },

    /**
     * Only populated when audience === "class".
     * References Class._id (String UUID).
     */
    targetClasses: [
      {
        type: String,
        ref:  "Class",
      },
    ],

    // ── Subject link (optional) ───────────────────────────────────────────
    subjectId: {
      type:    String,
      ref:     "Subject",
      default: null,
      index:   true,
    },

    subjectName: {
      type:    String,
      default: null,
    },

    // ── Priority & display ────────────────────────────────────────────────
    priority: {
      type:    String,
      enum:    ["low", "normal", "high", "urgent"],
      default: "normal",
      index:   true,
    },

    isPinned: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // ── Scheduling ────────────────────────────────────────────────────────
    publishAt: {
      type:    Date,
      default: null,
    },

    expiresAt: {
      type:    Date,
      default: null,
    },

    // ── Engagement tracking ───────────────────────────────────────────────
    readBy: {
      type:    [readReceiptSchema],
      default: [],
    },

    acknowledgedBy: {
      type:    [acknowledgeReceiptSchema],
      default: [],
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
      index:   true,
    },

    deletedAt: {
      type:    Date,
      default: null,
    },

    // ── Optimistic concurrency ────────────────────────────────────────────
    version: {
      type:    Number,
      default: 1,
    },
  },
  {
    _id:        false,       // we supply our own UUID string _id
    timestamps: true,        // createdAt, updatedAt
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;    // expose id alias for frontend compatibility
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

// Primary query path — fetch active announcements for a school sorted by pin+date
announcementSchema.index({ schoolId: 1, isActive: 1, isPinned: -1, createdAt: -1 });

// Audience filter
announcementSchema.index({ schoolId: 1, audience: 1, isActive: 1 });

// Class-targeted announcements
announcementSchema.index({ schoolId: 1, targetClasses: 1, isActive: 1 });

// Scheduling — publishAt / expiresAt range queries
announcementSchema.index({ schoolId: 1, publishAt: 1  });
announcementSchema.index({ schoolId: 1, expiresAt: 1  });

// Sync — updatedAt delta pulls
announcementSchema.index({ schoolId: 1, updatedAt: 1  });

// Author lookup
announcementSchema.index({ schoolId: 1, author: 1     });

// Subject-scoped announcements
announcementSchema.index({ schoolId: 1, subjectId: 1  });

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────

/** True when the announcement is currently visible (not scheduled, not expired). */
announcementSchema.virtual("isLive").get(function () {
  const now = new Date();
  if (this.publishAt && this.publishAt > now) return false;
  if (this.expiresAt && this.expiresAt < now) return false;
  return this.isActive && !this.deletedAt;
});

/** Convenience counts without exposing the full arrays. */
announcementSchema.virtual("readCount").get(function () {
  return (this.readBy || []).length;
});

announcementSchema.virtual("acknowledgedCount").get(function () {
  return (this.acknowledgedBy || []).length;
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

/** Enforce targetClasses is non-empty when audience is "class". */
announcementSchema.pre("save", function (next) {
  if (this.audience === "class" && (!this.targetClasses || this.targetClasses.length === 0)) {
    return next(new Error("targetClasses must not be empty when audience is 'class'"));
  }
  // Clear targetClasses for non-class audiences to keep data clean
  if (this.audience !== "class") {
    this.targetClasses = [];
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// MODEL
// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Announcement
  || mongoose.model("Announcement", announcementSchema);