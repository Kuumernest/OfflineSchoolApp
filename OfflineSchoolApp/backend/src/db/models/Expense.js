// backend/src/db/models/Expense.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * Money going out.
 *
 * Deliberately the same shape as FeePayment: append-only, whole XAF, voided
 * rather than deleted. One ledger pattern across the whole finance module means
 * the income statement is two sums over two collections rather than two
 * different sets of rules to keep straight.
 */
const expenseSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:     { type: String, required: true, index: true },
    categoryId:   { type: String, required: true, index: true },
    academicYear: { type: String, default: null, index: true },

    amount: {
      type:     Number,
      required: true,
      min:      [1, "An expense of zero records nothing"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    description: { type: String, default: null, trim: true },
    vendor:      { type: String, default: null, trim: true },

    method: {
      type:    String,
      enum:    ["cash", "mobile_money", "bank", "cheque", "other"],
      default: "cash",
      index:   true,
    },

    /** Receipt number from the supplier, transfer reference, cheque number. */
    reference: { type: String, default: null, trim: true },

    /** When the money left — not when the row was typed in. */
    incurredAt: { type: Date, default: Date.now, index: true },
    recordedBy: { type: String, default: null },

    /**
     * Whether this counts yet.
     *
     *   approved  Counts in every total. The default, and what every row
     *             written before approvals existed effectively is.
     *   pending   Recorded, waiting for a second signature, and excluded from
     *             the accounts until it gets one.
     *   rejected  Somebody said no. Kept, never counted — deleting it would
     *             erase the fact that it was asked for.
     *
     * The default is "approved" rather than "pending" on purpose. A school that
     * has set no expense threshold has not asked for approvals, and making them
     * opt out would freeze the fee desk of every existing deployment on upgrade
     * morning. approvals.service.js decides which one a new row gets.
     *
     * Rows written before this field existed have no value at all, which is why
     * every report filters with $nin rather than $eq: a missing field is not in
     * ["pending", "rejected"], so historic expenses keep counting.
     */
    status: {
      type:    String,
      enum:    ["approved", "pending", "rejected"],
      default: "approved",
      index:   true,
    },

    /** The ApprovalRequest that gated this, when one did. */
    approvalId: { type: String, default: null, index: true },

    /** Scan or photo of the receipt, stored like the school logo. */
    attachmentPath: { type: String, default: null },

    // ── Void, never delete ───────────────────────────────────────────────────
    voidedAt:   { type: Date,   default: null, index: true },
    voidedBy:   { type: String, default: null },
    voidReason: { type: String, default: null, trim: true },

    deletedAt: { type: Date, default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// The two questions asked of this collection: spend over a period, and spend
// by category.
expenseSchema.index({ schoolId: 1, incurredAt: -1 });
expenseSchema.index({ schoolId: 1, categoryId: 1, incurredAt: -1 });

module.exports =
  mongoose.models.Expense ||
  mongoose.model("Expense", expenseSchema);
