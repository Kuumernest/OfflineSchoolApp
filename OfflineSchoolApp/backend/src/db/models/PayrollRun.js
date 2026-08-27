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
 * ── The states ────────────────────────────────────────────────────────────
 *
 *   draft     → rows exist, nothing is owed, everything is editable
 *   approved  → a second person has signed it off; still not paid
 *   confirmed → the rows are payments and count in the accounts
 *   reversed  → the whole batch was undone by reversing entries
 *
 * "approved" only appears in schools that have turned payroll approval on. The
 * step it adds is the §12 separation: the bursar prepares the run and carries
 * out the payment, and somebody else agrees to it in between. With approval off
 * a run goes draft → confirmed exactly as before, because a school that has not
 * asked for a second signature should not have its month blocked waiting for
 * one.
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
      enum:    ["draft", "approved", "confirmed", "reversed"],
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
    /**
     * Who agreed to it, and never the same person who confirms it — that pair
     * is checked in payroll.service.js, not here, because a schema cannot see
     * who is making the request.
     */
    approvedBy:  { type: String, default: null },
    approvedAt:  { type: Date,   default: null },
    approvalId:  { type: String, default: null },
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
//
// "approved" had to join the filter — a run awaiting confirmation is very much
// live, and leaving it out would let a second run be generated for the same
// month while the first sat signed and unpaid.
//
// Given a NEW NAME deliberately. The previous index was declared without one,
// so mongoose auto-named it "schoolId_1_periodMonth_1"; redefining that name
// with a different partialFilterExpression raises IndexOptionsConflict on
// connect and takes the app down at startup on every existing deployment. The
// two coexist until scripts/fix-payroll-index.js drops the old one, and while
// the old one is present a second run for an approved month is still blocked by
// it anyway — the old filter is narrower, not wrong.
payrollRunSchema.index(
  { schoolId: 1, periodMonth: 1 },
  {
    unique: true,
    name:   "payroll_live_per_month",
    partialFilterExpression: {
      status:    { $in: ["draft", "approved", "confirmed"] },
      deletedAt: null,
    },
  }
);

module.exports =
  mongoose.models.PayrollRun ||
  mongoose.model("PayrollRun", payrollRunSchema);
