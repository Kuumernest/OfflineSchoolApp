// backend/src/db/models/Class.js
"use strict";

/**
 * Class.js
 *
 * Fixed:
 *  #CL1 — deletedAt typed as Mixed (not Date) to prevent CastError on
 *          query conditions containing boolean false
 *  #CL2 — set() coercer normalises deletedAt on document save
 *  #CL3 — softDelete / restore / notDeletedClause statics centralised
 *  #CL4 — compound covering index for most common query pattern
 *  #CL5 — toJSON transform returns new object (no mutation)
 *  #CL6 — description field added (selected by normaliseClass())
 *  #CL7 — school ObjectId ref field added alongside schoolId String
 *  #CL8 — uuid with crypto.randomUUID() fallback
 *  #CL9 — FIXED: removed index: true from schoolId and isActive field
 *          definitions — they were already covered by explicit
 *          classSchema.index() calls below, causing the duplicate
 *          index warnings
 */

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ID GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

const generateId = (() => {
  try {
    const { v4 } = require("uuid");
    return v4;
  } catch {
    return () => require("crypto").randomUUID();
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — DELETED-AT COERCER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises any value stored in deletedAt to either null or a Date.
 * Runs on document SAVE only — not on query conditions (see #CL1).
 *
 *   false / 0 / "" / undefined / null → null        (not deleted)
 *   true                              → new Date()  (deleted now)
 *   Date instance                     → unchanged
 *   parseable date string             → new Date(v)
 *   anything else                     → null
 */
const coerceDeletedAt = (v) => {
  if (v === null || v === undefined || v === false || v === 0 || v === "") {
    return null;
  }
  if (v === true)        return new Date();
  if (v instanceof Date) return v;
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const classSchema = new mongoose.Schema(
  {
    // ── Explicit string _id (UUID) ────────────────────────────────────────────
    _id: {
      type:    String,
      default: generateId,
    },

    // ── School reference ──────────────────────────────────────────────────────
    schoolId: {
      type:     String,
      required: [true, "schoolId is required"],
      trim:     true,
      // ✅ FIXED (#CL9): removed index: true — covered by classSchema.index() below
    },

    school: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "School",
      default: null,
    },

    // ── Class details ─────────────────────────────────────────────────────────
    name: {
      type:      String,
      required:  [true, "Class name is required"],
      trim:      true,
      maxlength: [100, "Class name must not exceed 100 characters"],
    },

    level: {
      type:    String,
      default: null,
      trim:    true,
    },

    section: {
      type:    String,
      default: "",
      trim:    true,
    },

    /**
     * Where this class's students go at the end of the year.
     *
     * Stated, never inferred. `level` is null on every real class here, and the
     * names cannot be ordered — "Form 10" sorts before "Form 2", and nothing in
     * "Form 5" says the next stop is "Lower Sixth". A promotion run that guessed
     * would move children into the wrong class, so where this is null the run
     * marks the student as needing a decision instead of assuming one.
     */
    nextClassId: {
      type:    String,
      default: null,
    },

    /** Students here leave at the end of the year rather than moving up. */
    isFinalYear: {
      type:    Boolean,
      default: false,
    },

    /**
     * The promotion average this class demands, as a percentage 0–100.
     *
     * Set per class, by the school admin, on the promotion page. A student
     * whose published yearly average is below this number proposes as
     * "repeated" regardless of how their per-term pass/fail counts look;
     * null falls back to the majority-of-terms rule. Per class rather than
     * per school because a Form 6 science stream and a Form 1 intake are
     * rarely held to the same bar.
     */
    promotionAverage: {
      type:    Number,
      default: null,
      min:     [0, "promotionAverage cannot be below 0"],
      max:     [100, "promotionAverage cannot be above 100"],
    },

    description: {
      type:    String,
      default: null,
      trim:    true,
    },

    capacity: {
      type:    Number,
      default: null,
      min:     [0, "capacity cannot be negative"],
    },

    /**
     * The class teacher — the form master, in Cameroonian usage.
     *
     * Every report card has a line for this person and a signature under it,
     * and until now there was nowhere for the name to come from: the class had
     * no teacher field at all, so {{class_teacher}} printed an empty box with
     * a rule under it on every card the school issued.
     *
     * Two fields rather than one. The id is the reference; the name is
     * denormalised because a report card must print the teacher who held the
     * class when the card was issued, and a teacher who leaves the school has
     * their User row deactivated. A card reprinted a year later should not
     * lose the name of the person who signed it.
     */
    classTeacherId: {
      type:    String,
      ref:     "User",
      default: null,
      index:   true,
    },

    classTeacherName: {
      type:    String,
      default: null,
      trim:    true,
    },

    isActive: {
      type:    Boolean,
      default: true,
      // ✅ FIXED (#CL9): removed index: true — covered by classSchema.index() below
    },

    // ── Soft delete ───────────────────────────────────────────────────────────
    /**
     * FIXED (#CL1):
     * type: Mixed — Mongoose's query caster passes Mixed values through
     * unchanged, so { deletedAt: false } in a query condition no longer
     * throws a CastError. The set() coercer still fires on document save
     * to ensure clean storage (null or Date, never a raw boolean).
     */
    deletedAt: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
      set:     coerceDeletedAt,
    },

    deletedBy: {
      type:    String,
      default: null,
    },

    createdBy: {
      type:    String,
      default: null,
    },
  },
  {
    _id:        false,   // we supply our own string _id
    timestamps: true,    // createdAt + updatedAt
    toJSON: {
      virtuals:  true,
      transform: (_doc, ret) => ({
        ...ret,
        id: ret._id,
      }),
    },
    toObject: { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — INDEXES
//
// ALL indexes are declared here and ONLY here.
// No field definition above uses index: true to avoid duplicate warnings.
// ─────────────────────────────────────────────────────────────────────────────

// ── Single-field indexes ──────────────────────────────────────────────────────
classSchema.index({ schoolId:  1 });
classSchema.index({ school:    1 });
classSchema.index({ isActive:  1 });
classSchema.index({ deletedAt: 1 });
classSchema.index({ createdAt: -1 });

// ── Two-field compound indexes ────────────────────────────────────────────────
classSchema.index({ schoolId: 1, name:      1 });
classSchema.index({ schoolId: 1, isActive:  1 });
classSchema.index({ schoolId: 1, deletedAt: 1 });
classSchema.index({ school:   1, isActive:  1 });
classSchema.index({ school:   1, deletedAt: 1 });

// ── Three-field covering indexes (most common query pattern) ──────────────────
//    Class.find({ schoolId, isActive: {$ne:false}, ...notDeletedClause() })
classSchema.index({ schoolId: 1, isActive: 1, deletedAt: 1 });
classSchema.index({ school:   1, isActive: 1, deletedAt: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────

classSchema.virtual("id").get(function () {
  return this._id;
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — STATICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Mongoose $or clause that excludes soft-deleted classes.
 * Safe in queries because deletedAt type is Mixed (no CastError on booleans).
 */
classSchema.statics.notDeletedClause = function () {
  return {
    $or: [
      { deletedAt: { $exists: false } },
      { deletedAt: null               },
      { deletedAt: ""                 },
      { deletedAt: 0                  },
      { deletedAt: false              },   // safe — type is Mixed, not Date
    ],
  };
};

/**
 * Soft-deletes a class. Never removes the document from MongoDB.
 *
 * @param {string}      classId
 * @param {string|null} [deletedByUserId]
 * @returns {Promise<object|null>}
 */
classSchema.statics.softDelete = async function (classId, deletedByUserId = null) {
  return this.findByIdAndUpdate(
    classId,
    {
      deletedAt: new Date(),
      deletedBy: deletedByUserId || null,
      isActive:  false,
    },
    { returnDocument: 'after' }
  );
};

/**
 * Restores a soft-deleted class.
 *
 * @param {string} classId
 * @returns {Promise<object|null>}
 */
classSchema.statics.restore = async function (classId) {
  return this.findByIdAndUpdate(
    classId,
    {
      deletedAt: null,
      deletedBy: null,
      isActive:  true,
    },
    { returnDocument: 'after' }
  );
};

/**
 * Finds all active, non-deleted classes for a school.
 * Accepts either the String schoolId or an ObjectId school ref.
 *
 * @param {string|mongoose.Types.ObjectId} schoolRef
 * @returns {Promise<object[]>}
 */
classSchema.statics.findActiveBySchool = async function (schoolRef) {
  const sid        = String(schoolRef);
  const notDeleted = this.notDeletedClause();

  return this.find({
    $and: [
      {
        $or: [
          { schoolId: sid       },
          { school:   schoolRef },
        ],
      },
      { isActive: { $ne: false } },
      notDeleted,
    ],
  })
    .sort({ name: 1, section: 1 })
    .lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — INSTANCE METHODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if this class has been soft-deleted.
 * Safe against boolean, numeric, and Date values.
 */
classSchema.methods.isDeleted = function () {
  const v = this.deletedAt;
  if (!v || v === false || v === 0 || v === "") return false;
  if (v instanceof Date) return !isNaN(v.getTime());
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — MODEL REGISTRATION (hot-reload safe)
// ─────────────────────────────────────────────────────────────────────────────

const Class = mongoose.models.Class
  ? mongoose.model("Class")
  : mongoose.model("Class", classSchema);

module.exports = Class;