// backend/src/db/models/FeePayment.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What a student PAID. Append-only, and the row a bursar creates offline.
 *
 * The id is generated on the device that takes the money, which is what makes
 * this safe over an unreliable link: the id IS the idempotency key, so the
 * outbox can retry the same POST as many times as it likes and the server
 * upserts to the same row. A server-generated id would create a second payment
 * on every retry, and duplicated money is the one bug nobody forgives.
 *
 * Nothing here is ever edited. A payment entered wrongly is corrected by
 * appending a reversing row that points at it — the way every ledger since the
 * fifteenth century has handled a mistake.
 */

const feePaymentSchema = new mongoose.Schema(
  {
    /** Client-generated UUID; doubles as the idempotency key. */
    _id: { type: String, default: () => uuidv4() },

    schoolId:     { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },
    academicYear: { type: String, required: true, index: true },
    term:         { type: String, default: null },
    classId:      { type: String, default: null },

    /**
     * Positive on a normal payment, negative on a reversal. Storing the sign
     * rather than a `type` field means the balance is a plain sum and cannot
     * disagree with itself.
     */
    amount: {
      type:     Number,
      required: true,
      validate: [
        {
          validator: Number.isInteger,
          message:   "Amounts are whole XAF — the currency has no minor unit",
        },
        {
          validator: (v) => v !== 0,
          message:   "A payment of zero records nothing",
        },
      ],
    },

    method: {
      type:    String,
      enum:    ["cash", "mobile_money", "bank", "cheque", "waiver", "other"],
      default: "cash",
      index:   true,
    },

    /** MoMo transaction id, teller slip, cheque number. */
    reference: { type: String, default: null, trim: true },

    /**
     * Server-assigned on first sync, from a Counter. A phone offline for two
     * days must not invent these: two phones would mint the same number, and a
     * receipt book with duplicates is worthless. Null until the server sees it.
     */
    receiptNo: { type: String, default: null, index: true },

    /** When the money changed hands — not when the row reached the server. */
    receivedAt: { type: Date, default: Date.now, index: true },
    receivedBy: { type: String, default: null },

    note: { type: String, default: null, trim: true },

    // ── Reversal pairing ─────────────────────────────────────────────────────
    /** Set on a correcting row: the payment this one cancels. */
    reversesId:  { type: String, default: null, index: true },
    /** Set on the original once a reversal exists, so the UI can grey it out. */
    reversedById: { type: String, default: null },
    reversalReason: { type: String, default: null, trim: true },

    /**
     * Where the row was created. Useful when reconciling a day's takings
     * against a particular phone.
     */
    source: {
      type:    String,
      enum:    ["web", "mobile", "import"],
      default: "web",
    },

    deletedAt: { type: Date, default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

feePaymentSchema.virtual("isReversal").get(function () {
  return Boolean(this.reversesId);
});

feePaymentSchema.virtual("isReversed").get(function () {
  return Boolean(this.reversedById);
});

// Balance and statement queries.
feePaymentSchema.index({ schoolId: 1, studentId: 1, academicYear: 1 });
// The daily cash book.
feePaymentSchema.index({ schoolId: 1, receivedAt: -1 });
// A receipt number is unique within a school; sparse because it is null until
// the server assigns it.
feePaymentSchema.index(
  { schoolId: 1, receiptNo: 1 },
  { unique: true, partialFilterExpression: { receiptNo: { $type: "string" } } }
);

module.exports =
  mongoose.models.FeePayment ||
  mongoose.model("FeePayment", feePaymentSchema);
