// backend/src/db/models/FeeStructure.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * A price list: what a class is charged in a given year and term.
 *
 * Versioned rather than edited in place. When fees rise next year you publish a
 * new structure; last year's charges keep pointing at the old one, so a
 * historical receipt still reconciles against the price that was actually in
 * force. Editing a structure that has already been applied would silently
 * rewrite the past.
 *
 * Amounts are whole XAF. The Central African CFA franc has no minor unit —
 * there are no centimes in circulation — so there is nothing to store below the
 * franc, and a float here would eventually show a parent 29999.999999996.
 */

const feeItemSchema = new mongoose.Schema(
  {
    /** Stable machine name: "tuition", "pta", "uniform". Used for reporting. */
    code:    { type: String, required: true, trim: true },
    label:   { type: String, required: true, trim: true },
    /** French label, per the bilingual convention — see src/i18n. */
    labelFr: { type: String, default: null, trim: true },

    amount: {
      type:     Number,
      required: true,
      min:      [0, "A fee item cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    /** Optional charges the guardian may decline (bus, boarding). */
    isOptional: { type: Boolean, default: false },
  },
  { _id: false }
);

const feeStructureSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:     { type: String, required: true, index: true },
    academicYear: { type: String, required: true, index: true },

    /**
     * The classes this structure bills.
     *
     * An EMPTY array means every class in the school — the same meaning the
     * old nullable `classId` carried. Most schools charge Forms 1–3 one set of
     * fees and Forms 4–5 another, so billing several classes from one price
     * list is the normal case, not an edge case.
     */
    classIds: {
      type:    [String],
      default: [],
      index:   true,
    },

    /**
     * Null means the whole year in one bill. A term value bills per term,
     * which is what most schools here actually do.
     */
    term: { type: String, default: null },

    items: {
      type: [feeItemSchema],
      default: [],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message:   "A fee structure needs at least one item",
      },
    },

    isActive: { type: Boolean, default: true, index: true },

    createdBy: { type: String, default: null },
    deletedAt: { type: Date,   default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

/** Convenience: the whole bill for this structure. */
feeStructureSchema.virtual("total").get(function () {
  return (this.items || []).reduce((sum, i) => sum + (i.amount || 0), 0);
});

// A class may appear in only one ACTIVE structure per year and term.
//
// `classIds` is an array, so this is a multikey index and Mongo enforces
// uniqueness per element: publishing a second active structure that includes a
// class already billed for that term is rejected, which is exactly the rule —
// otherwise a student is billed twice from two different price lists and the
// arrears report has no way to tell which is right.
//
// An empty array indexes as a single null key, so it also allows only one
// school-wide structure per year and term.
feeStructureSchema.index(
  { schoolId: 1, academicYear: 1, classIds: 1, term: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true, deletedAt: null },
  }
);

module.exports =
  mongoose.models.FeeStructure ||
  mongoose.model("FeeStructure", feeStructureSchema);
