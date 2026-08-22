// backend/src/db/models/FeeCharge.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What a student OWES — one row per billed item.
 *
 * Half of the ledger. A student's balance is
 *
 *     Σ charges − Σ waivers − Σ payments
 *
 * computed on read. Nothing anywhere stores a balance: the moment it becomes a
 * field, two devices recording against the same student both write their own
 * idea of it and one of them wins. Rows only ever get appended, so two offline
 * devices simply contribute two rows and the arithmetic stays correct without a
 * conflict being possible.
 *
 * A charge is never edited or deleted once raised. A mistake is voided, which
 * leaves the original visible and the reason recorded — the same reason a
 * cashbook is written in pen.
 */

const feeChargeSchema = new mongoose.Schema(
  {
    /**
     * Client-generated UUID.
     *
     * Applying a structure to a class is one request that raises many charges;
     * generating the ids up front makes the whole operation replayable — a
     * retry writes the same ids and upserts to the same rows rather than
     * billing the class twice.
     */
    _id: { type: String, default: () => uuidv4() },

    schoolId:     { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },
    academicYear: { type: String, required: true, index: true },
    term:         { type: String, default: null },

    /** Which price list raised this, so a receipt can be reconciled later. */
    structureId: { type: String, default: null, index: true },
    classId:     { type: String, default: null },

    code:  { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },

    amount: {
      type:     Number,
      required: true,
      min:      [0, "A charge cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    /**
     * Scholarships, sibling discounts, hardship waivers. Kept beside the amount
     * rather than reducing it, so the bursar can still see the full fee and
     * what was forgiven — which is what an auditor asks for.
     */
    waivedAmount: {
      type:    Number,
      default: 0,
      min:     [0, "A waiver cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },
    waiverReason: { type: String, default: null, trim: true },

    dueDate: { type: Date, default: null },

    // ── Void, never delete ───────────────────────────────────────────────────
    voidedAt:     { type: Date,   default: null, index: true },
    voidedBy:     { type: String, default: null },
    voidReason:   { type: String, default: null, trim: true },

    raisedBy:  { type: String, default: null },
    deletedAt: { type: Date,   default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

/** What this row actually contributes to the balance. */
feeChargeSchema.virtual("netAmount").get(function () {
  if (this.voidedAt) return 0;
  return Math.max(0, (this.amount || 0) - (this.waivedAmount || 0));
});

// The balance query: everything owed by one student in a year.
feeChargeSchema.index({ schoolId: 1, studentId: 1, academicYear: 1 });
// The arrears report: who owes what across a class.
feeChargeSchema.index({ schoolId: 1, classId: 1, academicYear: 1, voidedAt: 1 });
// Applying a structure twice must not double-bill.
feeChargeSchema.index(
  { studentId: 1, structureId: 1, code: 1, term: 1 },
  { unique: true, partialFilterExpression: { structureId: { $type: "string" } } }
);

module.exports =
  mongoose.models.FeeCharge ||
  mongoose.model("FeeCharge", feeChargeSchema);
