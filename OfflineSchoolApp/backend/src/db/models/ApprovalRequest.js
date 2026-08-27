// backend/src/db/models/ApprovalRequest.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE THING WAITING FOR A SECOND SIGNATURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Roles decide who may act. Permissions decide what an act is. Neither stops
 * one person owning a whole transaction end to end, and that is the gap this
 * closes: the bursar raises, somebody else decides, the bursar carries out.
 *
 * ── Why one collection and not a status field per model ───────────────────
 *
 * Both, in fact — but the DECISION lives here, and only here.
 *
 * A status on the Expense answers "may this be counted yet". It cannot answer
 * "who approved it, when, why, and what was the rule at the time", because the
 * next edit overwrites it — the same reasoning that put ResultChangeLog in its
 * own collection rather than adding fields to ExamScore.
 *
 * And the question a head teacher actually asks is not per-model. It is "what
 * is waiting for me", across fees, expenses and payroll at once. That is one
 * query here and four queries with four different shapes otherwise.
 *
 * ── Why some kinds carry a payload and others a target ────────────────────
 *
 * The asymmetry is real, not an oversight:
 *
 *   expense   The money has already left. The row exists the moment it is
 *             recorded — with its category, its reference and its scanned
 *             receipt — and carries status "pending" until decided. Deferring
 *             creation would mean asking a bursar to hold a paper receipt until
 *             the head is next in the building.
 *
 *   refund    Nothing has happened yet; this is a proposal. Creating the
 *             negative payment up front would change the student's balance
 *             before anybody agreed to it, and every screen that sums the
 *             ledger would have to learn to ignore it. So the intent is held
 *             in `payload` and the payment row is written on approval.
 *
 *   waiver    Same: the reduction is held here and applied to the FeeCharge on
 *             approval, so a proposed waiver never silently reduces what a
 *             family owes.
 *
 *   payroll   The draft run already exists and already pays nobody, which is
 *             what "draft" has always meant here. This just gates the step from
 *             draft to confirmed.
 *
 * ── Decisions are immutable ───────────────────────────────────────────────
 *
 * Once decided, nothing in this document may change. Enforced by the hook
 * below rather than trusted to every future caller, because an approval trail
 * that can be edited is not a trail. A decision made in error is corrected the
 * way the rest of this ledger corrects things — by a new, opposing record: void
 * the expense, reverse the payment.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** What can be put up for approval. */
const KINDS = ["expense", "refund", "waiver", "payroll"];

const STATUSES = ["pending", "approved", "rejected", "cancelled"];

const approvalRequestSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },

    kind: {
      type:     String,
      required: true,
      enum:     KINDS,
      index:    true,
    },

    /**
     * The document this decision is about, when one exists already.
     *
     * Null for a refund, where the payment row does not exist until approval.
     * Set for an expense (the pending Expense), a waiver (the FeeCharge being
     * reduced) and payroll (the draft PayrollRun).
     */
    targetId: { type: String, default: null, index: true },

    /**
     * Everything needed to carry out the action later, for the kinds where
     * nothing has been written yet. Deliberately schema-less: each kind reads
     * back exactly the fields it wrote, and adding a kind must not require a
     * migration of rows that will never be read by it.
     *
     * Never trusted blindly on approval — the applier revalidates, because a
     * request approved in March may name a student who left in February.
     */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * The money at stake, in whole XAF, and what the threshold was tested
     * against. Stored rather than recomputed so the queue can be sorted and
     * totalled without loading four other collections.
     */
    amount: {
      type:     Number,
      required: true,
      min:      [0, "An approval for nothing is not a decision"],
      validate: {
        validator: Number.isInteger,
        message:   "Amounts are whole XAF — the currency has no minor unit",
      },
    },

    /**
     * The threshold in force when this was raised.
     *
     * Kept so the record explains itself years later. A school that raises its
     * expense threshold from 50,000 to 200,000 leaves behind approvals that
     * would not be required today, and without this the trail looks like
     * somebody was being asked to sign off on trivia.
     */
    thresholdAtRequest: { type: Number, default: null },

    /** What the requester says this is for. The head reads this and nothing else. */
    reason: { type: String, default: null, trim: true, maxlength: 2000 },

    /** Human-readable summary, so a queue row needs no joins to be legible. */
    summary: { type: String, default: null, trim: true, maxlength: 300 },

    status: {
      type:    String,
      enum:    STATUSES,
      default: "pending",
      index:   true,
    },

    requestedBy: { type: String, default: null },
    requestedAt: { type: Date,   default: Date.now, index: true },

    decidedBy:    { type: String, default: null },
    decidedAt:    { type: Date,   default: null },
    decisionNote: { type: String, default: null, trim: true, maxlength: 2000 },

    /**
     * Set when approval succeeded but carrying out the action did not — an
     * approved refund for a student who has since been deleted, say. The
     * decision stands and is not silently reversed; this records that the
     * effect never landed, so somebody can look.
     */
    applyError: { type: String, default: null },

    deletedAt: { type: Date, default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

// The queue: what is waiting, newest first.
approvalRequestSchema.index({ schoolId: 1, status: 1, requestedAt: -1 });
// "What have I put up?" — the bursar's own view.
approvalRequestSchema.index({ schoolId: 1, requestedBy: 1, requestedAt: -1 });
// One live request per target, so a second click cannot raise a duplicate.
// Partial rather than plain unique: a rejected request must not block a fresh
// attempt after the objection has been dealt with, and targetId is null for
// refunds, which have no target to be unique about.
approvalRequestSchema.index(
  { schoolId: 1, kind: 1, targetId: 1 },
  {
    unique: true,
    name:   "approval_one_pending_per_target",
    partialFilterExpression: {
      status:   "pending",
      targetId: { $type: "string" },
    },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// IMMUTABILITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A decided request is frozen — except for applyError, which is written after
 * the decision by definition and records that the effect failed.
 *
 * Guarded here rather than in the service because the service is not the only
 * thing that will ever hold one of these documents.
 */
// The status the document had when it was read, remembered so the hook can
// tell "deciding now" from "editing something already decided". By the time
// pre-save runs, this.status is whatever the caller set, so the current value
// cannot answer that. $locals is mongoose's documented per-document scratch
// space; reaching into this.$__ would be reading its internals.
approvalRequestSchema.post("init", function () {
  this.$locals.loadedStatus = this.status;
});

// async with a throw, and NO `next` parameter.
//
// Mongoose 9 runs document middleware off the returned promise and does not
// pass a callback: a hook declaring `next` gets undefined and dies with
// "next is not a function" on the first save. The same trap is written up at
// length in User.js, which is where this shape comes from.
approvalRequestSchema.pre("save", async function () {
  if (this.isNew) return;

  const loaded = this.$locals.loadedStatus;

  // Still pending when it was read: this save is the decision itself, which is
  // exactly the one write a pending request is for.
  if (!loaded || loaded === "pending") return;

  const touched = this.modifiedPaths().filter(
    (p) => p !== "applyError" && p !== "updatedAt"
  );

  if (touched.length) {
    throw new Error(
      `This approval was already ${loaded} and cannot be changed ` +
      `(attempted: ${touched.join(", ")})`
    );
  }
});

/** Nothing updates or deletes these through a query, either. */
const refuse = (verb) => async function () {
  throw new Error(`Approval records are append-only — ${verb} is not permitted`);
};

approvalRequestSchema.pre("deleteOne",   { document: false, query: true }, refuse("delete"));
approvalRequestSchema.pre("deleteMany",  { document: false, query: true }, refuse("delete"));
approvalRequestSchema.pre("findOneAndDelete", refuse("delete"));

module.exports =
  mongoose.models.ApprovalRequest ||
  mongoose.model("ApprovalRequest", approvalRequestSchema);

module.exports.KINDS    = KINDS;
module.exports.STATUSES = STATUSES;
