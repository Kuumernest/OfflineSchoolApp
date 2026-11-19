// backend/src/db/models/PaymentPlan.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN AGREEMENT TO PAY IN INSTALMENTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One family, one academic year, a schedule of dated amounts.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * Not a school-wide payment schedule. A school that bills in three tranches
 * already has that: three fee structures, one per term, each with its own due
 * date. Building a second mechanism for the same thing would give the same
 * deadline two homes and let them disagree.
 *
 * This is the other case, and the one a bursar actually asks for — the family
 * who cannot pay the term in one go and has agreed with the school to pay it
 * across four dates instead. It is a private arrangement with one household.
 *
 * ── It changes WHEN, never HOW MUCH ───────────────────────────────────────
 *
 * A plan does not touch the ledger. Nothing here is a charge, nothing here is a
 * payment, and balanceFor() does not know this collection exists — what a
 * family owes is still charges minus waivers minus payments, and a plan cannot
 * alter that by construction. A school that wants to reduce a bill uses a
 * waiver, which is a different thing with an approval behind it.
 *
 * What a plan changes is which date a family is measured against: reminders and
 * late fees read the plan instead of the structure's due date. That is the
 * whole point. Chasing a family on the original deadline while they keep to an
 * agreement the school itself proposed is worse than having no plans at all.
 *
 * ── Falling behind ────────────────────────────────────────────────────────
 *
 * "Behind" is not "missed an instalment". It is CUMULATIVE: by the third date a
 * family should have paid the first three instalments in total, and a family
 * who paid double on the first and nothing on the second is exactly on track.
 * Measuring instalments individually would flag them, which is both wrong and
 * the kind of wrong that erodes trust in the reminder list.
 *
 * feeReminders.service.js planStatus() is the one place that arithmetic lives.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const instalmentSchema = new mongoose.Schema(
  {
    /** 1-based position in the schedule. Order is meaning here. */
    seq: {
      type:     Number,
      required: true,
      min:      [1, "Instalments are numbered from 1"],
    },

    amount: {
      type:     Number,
      required: true,
      min:      [1, "An instalment of zero is not an instalment"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    /** The day this instalment is expected. Compared with endOfDay(). */
    dueDate: { type: Date, required: true },
  },
  { _id: false }
);

/**
 * One entry in an agreement's history. Append-only: who did what, when, and —
 * for anything that touched the schedule — the instalments before and after,
 * so "what did we agree with this family in March?" has an answer.
 */
const historySchema = new mongoose.Schema(
  {
    at:     { type: Date,   default: Date.now },
    by:     { type: String, default: null },
    action: {
      type: String,
      enum: [
        "created", "change_proposed", "approved", "rejected",
        "change_approved", "change_rejected", "cancelled", "completed",
      ],
      required: true,
    },
    note:   { type: String, default: null, trim: true, maxlength: 2000 },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after:  { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

/**
 * A proposed change to an APPROVED agreement. Held here, not applied: the
 * approved schedule keeps governing until an administrator approves this one
 * (an unapproved schedule never overrides anything).
 */
const pendingChangeSchema = new mongoose.Schema(
  {
    instalments:       { type: [instalmentSchema], default: [] },
    effectiveFrom:     { type: Date,   default: null },
    expiresAt:         { type: Date,   default: null },
    notes:             { type: String, default: null, trim: true, maxlength: 2000 },
    reason:            { type: String, default: null, trim: true, maxlength: 2000 },
    requestedBy:       { type: String, default: null },
    requestedAt:       { type: Date,   default: Date.now },
    approvalRequestId: { type: String, default: null },
  },
  { _id: false }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    /** A stored upload ("/uploads/…") or an external link to the signed paper. */
    url:  { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { _id: false }
);

const paymentPlanSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:     { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },
    academicYear: { type: String, required: true, index: true },

    /** Null means the plan covers the whole year rather than one term. */
    term: { type: String, default: null },

    instalments: {
      type:     [instalmentSchema],
      default:  [],
      validate: [
        {
          validator: (v) => Array.isArray(v) && v.length >= 2,
          message:   "A plan needs at least two instalments — one is just a due date",
        },
        {
          // Out-of-order dates would make "cumulative due by now" meaningless,
          // and the schedule is walked in seq order everywhere.
          validator: (v) => {
            const sorted = [...v].sort((a, b) => a.seq - b.seq);
            for (let i = 1; i < sorted.length; i++) {
              if (sorted[i].dueDate < sorted[i - 1].dueDate) return false;
            }
            return true;
          },
          message: "Instalment dates must not go backwards",
        },
      ],
    },

    /**
     *   active     the arrangement stands and is what the family is measured on
     *   completed  every instalment has been covered
     *   cancelled  the school has withdrawn it; normal due dates apply again
     *
     * Cancelled rather than deleted, because "we gave them a plan and they
     * broke it" is a thing a school needs to be able to see next year.
     */
    status: {
      type:    String,
      enum:    ["active", "completed", "cancelled"],
      default: "active",
      index:   true,
    },

    /** Why the school agreed to it. Read by whoever asks about it later. */
    reason: { type: String, default: null, trim: true, maxlength: 2000 },

    // ── An individual fee agreement ─────────────────────────────────────────
    //
    // The fields below make a plan the "individual agreement" that overrides
    // the general fee structure for one pupil (shared/arrears.js
    // isPlanApplicable). All additive: a plan written before them has none,
    // and reads as an approved, open-ended plan — exactly what it was.

    /**
     *   total    the instalments are the pupil's WHOLE bill for the year
     *            (50,000 + 50,000 + 100,000 instead of the structure's
     *            75,000 + 75,000 + 50,000); every payment of the year counts
     *   balance  they are what was still outstanding when agreed; payments
     *            made before then (baselinePaid) are set aside
     *
     * Either way the instalments add up to what is owed — an agreement
     * changes WHEN, never HOW MUCH (a reduction is a waiver).
     */
    basis:        { type: String, enum: ["total", "balance", null], default: null },
    baselinePaid: { type: Number, default: 0, min: 0 },
    /** Σ instalments, stored so the agreement reads without arithmetic. */
    agreedTotal:  { type: Number, default: null, min: 0 },

    /** In force from the start of this day; null = from when it is approved. */
    effectiveFrom: { type: Date, default: null },
    /** Not in force after the end of this day; null = no expiry. */
    expiresAt:     { type: Date, default: null },

    /**
     *   pending   proposed by the bursar, waiting for an administrator —
     *             does NOT override the general structure
     *   approved  governs the pupil (while active and in its dates)
     *   rejected  refused; the plan is also cancelled, freeing the slot
     *
     * Null on plans written before approvals existed (read as approved).
     */
    approvalStatus: {
      type: String, enum: ["pending", "approved", "rejected", null], default: null, index: true,
    },
    approvalRequestId: { type: String, default: null },
    approvedBy:        { type: String, default: null },
    approvedAt:        { type: Date,   default: null },
    rejectedBy:        { type: String, default: null },
    rejectedAt:        { type: Date,   default: null },
    rejectionReason:   { type: String, default: null, trim: true, maxlength: 2000 },

    notes:       { type: String, default: null, trim: true, maxlength: 4000 },
    attachments: { type: [attachmentSchema], default: [] },

    /** A change to an approved agreement, waiting for approval. */
    pendingChange: { type: pendingChangeSchema, default: null },

    history: { type: [historySchema], default: [] },

    agreedBy: { type: String, default: null },
    agreedAt: { type: Date,   default: Date.now },

    cancelledBy:     { type: String, default: null },
    cancelledAt:     { type: Date,   default: null },
    cancelledReason: { type: String, default: null, trim: true, maxlength: 2000 },

    deletedAt: { type: Date, default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

/** What the family has agreed to pay in total under this plan. */
paymentPlanSchema.virtual("total").get(function () {
  return (this.instalments || []).reduce((sum, i) => sum + (i.amount || 0), 0);
});

/** The last date in the schedule — when the plan is meant to be finished. */
paymentPlanSchema.virtual("finalDueDate").get(function () {
  return (this.instalments || []).reduce(
    (latest, i) => (!latest || i.dueDate > latest ? i.dueDate : latest),
    null
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

// One ACTIVE plan per student per year and term.
//
// Two live arrangements for the same bill would leave every reader — reminders,
// late fees, the ledger screen — picking one arbitrarily. A cancelled or
// completed plan does not block a fresh one, which is the point of both states:
// a family whose circumstances change gets a new arrangement, and the old one
// stays on the record.
paymentPlanSchema.index(
  { schoolId: 1, studentId: 1, academicYear: 1, term: 1 },
  {
    unique: true,
    name:   "plan_one_active_per_student_term",
    partialFilterExpression: { status: "active", deletedAt: null },
  }
);

// The bursar's list: every plan running in a year.
paymentPlanSchema.index({ schoolId: 1, academicYear: 1, status: 1 });

module.exports =
  mongoose.models.PaymentPlan ||
  mongoose.model("PaymentPlan", paymentPlanSchema);
