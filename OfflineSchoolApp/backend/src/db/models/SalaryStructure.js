// backend/src/db/models/SalaryStructure.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What a staff member is owed each month.
 *
 * Dated rather than edited: a raise closes the current row with an
 * `effectiveTo` and opens a new one. That is what makes a payslip from six
 * months ago reproducible — the generator asks "which structure was in force on
 * that date?", and gets the answer that was true then rather than the answer
 * that is true now.
 */

const componentSchema = new mongoose.Schema(
  {
    code:    { type: String, required: true, trim: true },
    label:   { type: String, required: true, trim: true },
    labelFr: { type: String, default: null, trim: true },
    amount: {
      type:     Number,
      required: true,
      min:      [0, "A component cannot be negative — use the other list"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },
  },
  { _id: false }
);

const salaryStructureSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },
    /** The staff User this pays. */
    userId:   { type: String, required: true, index: true },

    baseAmount: {
      type:     Number,
      required: true,
      min:      [0, "Base pay cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    /** Housing, transport, responsibility. Added to base. */
    allowances: { type: [componentSchema], default: [] },
    /** Tax, pension, loan repayment. Subtracted from gross. */
    deductions: { type: [componentSchema], default: [] },

    effectiveFrom: { type: Date, required: true, index: true },
    /** Null while this is the row currently in force. */
    effectiveTo:   { type: Date, default: null, index: true },

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

salaryStructureSchema.virtual("gross").get(function () {
  return (this.baseAmount || 0) +
    (this.allowances || []).reduce((s, a) => s + (a.amount || 0), 0);
});

salaryStructureSchema.virtual("net").get(function () {
  return this.gross -
    (this.deductions || []).reduce((s, d) => s + (d.amount || 0), 0);
});

// One open-ended structure per person: a second row with no effectiveTo would
// make "what is in force today" ambiguous, and the generator would silently
// pick whichever the index returned first.
salaryStructureSchema.index(
  { schoolId: 1, userId: 1 },
  {
    unique: true,
    partialFilterExpression: { effectiveTo: null, deletedAt: null },
  }
);
salaryStructureSchema.index({ schoolId: 1, userId: 1, effectiveFrom: -1 });

module.exports =
  mongoose.models.SalaryStructure ||
  mongoose.model("SalaryStructure", salaryStructureSchema);
