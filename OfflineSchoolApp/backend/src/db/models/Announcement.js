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
     * Multi-select audience.
     *
     * `audience` above is the original single-select and is kept because
     * older clients and older rows still speak it. This is the field that
     * can express "Form 5A and 5B and the parents and the teachers" in one
     * announcement, which the single enum cannot.
     *
     * Both shapes are readable at once: use Announcement.audienceMatch() to
     * build a query rather than testing either field directly, so a row
     * written in either era is found.
     */
    audiences: {
      type: [String],
      enum: ["students", "teachers", "parents"],
      default: undefined,
      index: true,
    },

    /**
     * Populated when audience === "class", or alongside `audiences` to scope
     * the student/parent part of the announcement to particular classes.
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
  const usesMultiSelect = Array.isArray(this.audiences) && this.audiences.length > 0;

  if (!usesMultiSelect &&
      this.audience === "class" &&
      (!this.targetClasses || this.targetClasses.length === 0)) {
    throw new Error("targetClasses must not be empty when audience is 'class'");
  }

  // Clear targetClasses for non-class audiences to keep data clean.
  //
  // Skipped entirely for multi-select rows. `audience` carries a schema
  // default of "all", so an announcement written as
  // audiences:["students"] + targetClasses:["5A"] arrives here looking like
  // a non-class row and had its class scoping silently wiped on save — the
  // notice then went to the whole school. The multi-select field is the
  // authority for those rows; the legacy cleanup only applies to legacy ones.
  if (!usesMultiSelect && this.audience !== "class") {
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


// ── Audience helpers ────────────────────────────────────────────────────────

/**
 * The legacy single `audience` value expressed as the multi-select set, so
 * both eras of row can be reasoned about in one vocabulary.
 *
 * @param {string} audience
 * @returns {string[]} some of ["students", "teachers", "parents"]
 */
announcementSchema.statics.expandLegacyAudience = function (audience) {
  switch (audience) {
    case "all":      return ["students", "teachers", "parents"];
    case "students": return ["students"];
    case "teachers": return ["teachers"];
    case "parents":  return ["parents"];
    // "class" scoped the announcement to students of targetClasses.
    case "class":    return ["students"];
    default:         return [];
  }
};

/**
 * Every audience this announcement reaches, whichever field it was written
 * with. Reading code should prefer this over touching either field.
 */
announcementSchema.methods.effectiveAudiences = function () {
  if (Array.isArray(this.audiences) && this.audiences.length) {
    return [...this.audiences];
  }
  return this.constructor.expandLegacyAudience(this.audience);
};

/**
 * Query conditions selecting the announcements one reader should see.
 *
 * Returns an array for `$or`. It covers BOTH storage shapes — the legacy
 * `audience` enum and the `audiences` array — because a school will have
 * rows from before and after this field existed, and a reader who only
 * matched one shape would silently miss half their notices.
 *
 * @param {object}  opts
 * @param {"students"|"teachers"|"parents"} opts.audience  reader's audience
 * @param {string} [opts.classId]  reader's class, when they have one
 * @returns {object[]} conditions for $or
 */
announcementSchema.statics.audienceMatch = function ({ audience, classId }) {
  // New shape, NOT scoped to particular classes — everyone in the audience.
  //
  // The empty/absent test matters: without it a school-wide match would also
  // return announcements that were deliberately narrowed to one class, and a
  // Form 5A notice would appear on every Form 5B student's feed.
  const unscopedNew = {
    audiences: audience,
    $or: [
      { targetClasses: { $size: 0 } },
      { targetClasses: { $exists: false } },
    ],
  };

  // A row that HAS `audiences` must be judged by that alone.
  //
  // `audience` carries a schema default of "all", so an announcement written
  // as audiences:["teachers"] still has audience:"all" sitting underneath it.
  // Without this guard the legacy conditions below would match that row for
  // every reader, and a staff-only notice would appear on student phones.
  const legacyOnly = [
    { audiences: { $size: 0 } },
    { audiences: { $exists: false } },
  ];

  const conditions = [
    unscopedNew,
    // Legacy shape. "all"/"students"/"teachers"/"parents" rows were never
    // class-scoped — only audience:"class" was — so they need no class guard.
    { audience: "all", $or: legacyOnly },
    { audience,        $or: legacyOnly },
  ];

  if (classId) {
    // Legacy class-scoped rows.
    conditions.push({ audience: "class", targetClasses: classId, $or: legacyOnly });
    // New rows scoped to specific classes: the reader's class must be among
    // them AND their audience must be one the announcement targets.
    conditions.push({ audiences: audience, targetClasses: classId });
  }

  return conditions;
};

module.exports = mongoose.models.Announcement
  || mongoose.model("Announcement", announcementSchema);