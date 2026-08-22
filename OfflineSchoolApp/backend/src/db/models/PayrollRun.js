// backend/src/db/models/PayrollRun.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One month's payroll, as a reviewable batch.
 *
 * Generating never pays anyone. It produces DRAFT payslip rows the admin reads,
 * corrects and then confirms — because a generator that writes payments
 * directly turns a wrong allowance into money that has already left, and the
 * only remedy left is a reversal.
 *
 *   draft     → rows exist, nothing is owed, everything is editable
 *   confirmed → the rows are payments and count in the accounts
 *   reversed  → the whole batch was undone by reversing entries
 */
const payrollRunSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },

    /** "2026-08". A month, not a date range — payroll is monthly here. */
    periodMonth: {
      type:     String,
      required: true,
      index:    true,
      match:    [/^\d{4}-(0[1-9]|1[0-2])$/, "periodMonth must look like 2026-08"],
    },

    status: {
      type:    String,
      enum:    ["draft", "confirmed", "reversed"],
      default: "draft",
      index:   true,
    },

    /** Snapshot of the batch, so the list does not have to re-aggregate. */
    staffCount:      { type: Number, default: 0 },
    totalGross:      { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    totalNet:        { type: Number, default: 0 },

    generatedBy: { type: String, default: null },
    generatedAt: { type: Date,   default: Date.now },
    confirmedBy: { type: String, default: null },
    confirmedAt: { type: Date,   default: null },
    reversedBy:  { type: String, default: null },
    reversedAt:  { type: Date,   default: null },
    reversalReason: { type: String, default: null, trim: true },

    deletedAt: { type: Date, default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// One live run per month. A reversed run does not block a fresh attempt, which
// is the whole point of being able to reverse one.
payrollRunSchema.index(
  { schoolId: 1, periodMonth: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status:    { $in: ["draft", "confirmed"] },
      deletedAt: null,
    },
  }
);

module.exports =
  mongoose.models.PayrollRun ||
  mongoose.model("PayrollRun", payrollRunSchema);
