// backend/src/db/models/SalaryPayment.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One payslip.
 *
 * The components are SNAPSHOTTED here, not looked up from SalaryStructure when
 * the payslip is read. When someone gets a raise next term, last term's payslip
 * must still show what was actually paid — a payslip that changes retroactively
 * because a structure was edited is worse than no payslip at all.
 *
 * Corrections follow the fee ledger: a reversal is a new row with the opposite
 * sign, never an edit.
 */

const lineSchema = new mongoose.Schema(
  {
    code:   { type: String, required: true, trim: true },
    label:  { type: String, required: true, trim: true },
    amount: { type: Number, required: true },
  },
  { _id: false }
);

const salaryPaymentSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },
    userId:   { type: String, required: true, index: true },
    runId:    { type: String, default: null, index: true },

    periodMonth: { type: String, required: true, index: true },

    /** Which structure produced this, for tracing a query about the figure. */
    structureId: { type: String, default: null },

    // ── Snapshot ─────────────────────────────────────────────────────────────
    baseAmount:      { type: Number, default: 0 },
    allowances:      { type: [lineSchema], default: [] },
    deductions:      { type: [lineSchema], default: [] },
    gross:           { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },

    /**
     * What was actually paid. Negative on a reversal, so summing the column
     * nets corrections off without a special case.
     */
    net: {
      type:     Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    status: {
      type:    String,
      enum:    ["draft", "paid", "reversed"],
      default: "draft",
      index:   true,
    },

    method: {
      type:    String,
      enum:    ["cash", "mobile_money", "bank", "cheque", "other"],
      default: "bank",
    },
    reference: { type: String, default: null, trim: true },

    /** Assigned when the run is confirmed, never while it is a draft. */
    payslipNo: { type: String, default: null, index: true },

    paidAt: { type: Date,   default: null },
    paidBy: { type: String, default: null },

    reversesId:     { type: String, default: null, index: true },
    reversedById:   { type: String, default: null },
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

// A person is paid once per month per run. Drafts are included: generating the
// same month twice must not produce two payslips for the same person.
salaryPaymentSchema.index(
  { schoolId: 1, userId: 1, periodMonth: 1, runId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
salaryPaymentSchema.index({ schoolId: 1, periodMonth: 1, status: 1 });
salaryPaymentSchema.index(
  { schoolId: 1, payslipNo: 1 },
  { unique: true, partialFilterExpression: { payslipNo: { $type: "string" } } }
);

module.exports =
  mongoose.models.SalaryPayment ||
  mongoose.model("SalaryPayment", salaryPaymentSchema);
