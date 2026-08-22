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

/**
 * Enforce targetClasses is non-empty when audience is "class".
 *
 * Written as an async hook that THROWS rather than a callback hook that calls
 * next(). Mongoose 9 no longer passes a next callback to document middleware —
 * it passes a single internal options object — so `function (next) { … next() }`
 * threw "next is not a function" on every save. That killed the entire
 * announcement write surface: create, update, pin, mark-read, acknowledge and
 * soft-delete all go through .save().
 *
 * The async form works on Mongoose 6 through 9, so this is not a version lock.
 */
announcementSchema.pre("save", async function () {
  if (this.audience === "class" && (!this.targetClasses || this.targetClasses.length === 0)) {
    throw new Error("targetClasses must not be empty when audience is 'class'");
  }
  // Clear targetClasses for non-class audiences to keep data clean
  if (this.audience !== "class") {
    this.targetClasses = [];
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an announcement by an ObjectId OR a plain string _id.
 *
 * The mobile client generates its own ids (nanoid, e.g. "iz5q6xic96rmrf64hup")
 * and those are stored verbatim as _id. findById() casts to ObjectId first and
 * throws CastError on them, which surfaced as a 500 on every route that looked
 * an announcement up that way. Three routes each needed the same fallback, so
 * it lives here rather than being copied a fourth time.
 */
announcementSchema.statics.findByAnyId = async function (id) {
  if (!id) return null;

  if (mongoose.Types.ObjectId.isValid(id)) {
    const doc = await this.findById(id);
    if (doc) return doc;
    // A 24-char hex string id passes isValid but may still be stored as a
    // string, so fall through rather than reporting "not found".
  }

  return this.findOne({ _id: id });
};

// ─────────────────────────────────────────────────────────────────────────────
// MODEL
// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Announcement
  || mongoose.model("Announcement", announcementSchema);