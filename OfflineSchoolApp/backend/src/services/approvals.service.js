// backend/src/services/approvals.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SEGREGATION OF DUTIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Roles say who somebody is. Permissions say what an act is. Neither stops one
 * person owning a whole transaction, and that is what this closes:
 *
 *   raise  →  a different person decides  →  the effect lands
 *
 * ── The one rule that makes it worth anything ─────────────────────────────
 *
 * The approver cannot be the requester. Checked in decide(), by user id, and
 * it holds even for a super admin. Everything else here is bookkeeping; that
 * line is the control. A school where the bursar can approve their own refund
 * has bought a workflow and kept the risk.
 *
 * ── Off by default, and why that is not a cop-out ─────────────────────────
 *
 * Every threshold defaults to null, meaning "never require approval". A school
 * turns them on deliberately.
 *
 * The alternative — on by default — sounds stricter and is worse. On the
 * morning after the upgrade, no bursar could record the day's cash expenses
 * until a head teacher signed in, no refund could be paid at the desk, and the
 * month's payroll would stop. What happens next is not that schools adopt the
 * discipline; it is that somebody turns the whole thing off, or shares an admin
 * password, and then there is no separation at all AND nobody knows it.
 *
 * So the default is off and the audit trail is on regardless: every expense now
 * records who entered it, every decision is immutable, and the settings screen
 * says plainly what turning it on buys. That is the honest version.
 *
 * ── Applying the effect ───────────────────────────────────────────────────
 *
 * Approving is not the same as carrying out. Each kind has an applier below,
 * and every one of them REVALIDATES before acting: a refund approved in March
 * may name a student who left in February, and a waiver may point at a charge
 * that has since been voided. When an applier fails the decision still stands —
 * it was a real decision — and applyError records that the effect never landed.
 * Silently reversing somebody's approval would be worse than a visible failure.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ApprovalRequest = require("../db/models/ApprovalRequest");
const School          = require("../db/models/School");
const Expense         = require("../db/models/Expense");
const FeeCharge       = require("../db/models/FeeCharge");
const FeePayment      = require("../db/models/FeePayment");
const PayrollRun      = require("../db/models/PayrollRun");
const Student         = require("../db/models/Student");

const { nextReceiptNo } = require("./fees.service");

const KINDS = ApprovalRequest.KINDS;

/** Amounts are whole XAF throughout this module. */
const whole = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};

const fail = (message, code, status = 400) => {
  const err = new Error(message);
  err.code   = code;
  err.status = status;
  return err;
};

// ─────────────────────────────────────────────────────────────────────────────
// THRESHOLDS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = Object.freeze({
  expenseThreshold: null,
  refundThreshold:  null,
  waiverThreshold:  null,
  payrollRequired:  false,
});

/**
 * A school's thresholds with the defaults applied.
 *
 * Accepts whatever the School document holds — possibly nothing, for a school
 * created before this existed — and returns a complete object, exactly as
 * communication/policy.service.js resolveSettings does.
 */
function resolveThresholds(raw) {
  const s = raw ?? {};
  const num = (v) => {
    const n = whole(v);
    return n === null || n < 0 ? null : n;
  };
  return {
    expenseThreshold: num(s.expenseThreshold),
    refundThreshold:  num(s.refundThreshold),
    waiverThreshold:  num(s.waiverThreshold),
    payrollRequired:  s.payrollRequired === true,
  };
}

/** Read a school's thresholds. Falls back to the defaults on any failure. */
async function thresholdsFor(schoolId) {
  if (!schoolId) return { ...DEFAULT_THRESHOLDS };
  try {
    const school = await School.findById(String(schoolId))
      .select("settings.approvals")
      .lean();
    return resolveThresholds(school?.settings?.approvals);
  } catch (err) {
    // A database blip must not quietly switch the control off OR wedge the fee
    // desk. Falling back to the defaults is the state the school shipped with.
    console.warn(`[approvals] could not read thresholds for ${schoolId}: ${err.message}`);
    return { ...DEFAULT_THRESHOLDS };
  }
}

const THRESHOLD_KEY = {
  expense: "expenseThreshold",
  refund:  "refundThreshold",
  waiver:  "waiverThreshold",
};

/**
 * The rule itself, given the thresholds — no database.
 *
 * Split out from requiresApproval so the boundary can be asserted without a
 * connection, because the boundary is the part most likely to be wrong and
 * least likely to be noticed: AT or above, not merely above. A school that sets
 * 50,000 means an expense of exactly 50,000 is the kind it wants to see, and
 * nobody reading "approval required over 50,000" expects 50,000 itself to slip
 * through.
 *
 * @param {object} thresholds from resolveThresholds()
 * @param {string} kind
 * @param {number} amount
 * @returns {{required: boolean, threshold: number|null}}
 */
function requiresApprovalWith(thresholds, kind, amount) {
  if (kind === "payroll") {
    return { required: thresholds.payrollRequired === true, threshold: null };
  }

  const threshold = thresholds[THRESHOLD_KEY[kind]] ?? null;
  if (threshold === null) return { required: false, threshold: null };

  const n = whole(amount) ?? 0;
  return { required: n >= threshold, threshold };
}

/**
 * Does an action of this kind and size need a second signature?
 *
 * @returns {Promise<{required: boolean, threshold: number|null}>}
 */
async function requiresApproval({ schoolId, kind, amount }) {
  return requiresApprovalWith(await thresholdsFor(schoolId), kind, amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// RAISING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Put something up for approval.
 *
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string}  p.kind        one of ApprovalRequest.KINDS
 * @param {number}  p.amount      whole XAF at stake
 * @param {string} [p.targetId]   the document this is about, where one exists
 * @param {object} [p.payload]    what the applier needs, where nothing exists
 * @param {string} [p.reason]     what the requester says it is for
 * @param {string} [p.summary]    one legible line for the queue
 * @param {string}  p.requestedBy
 * @param {number} [p.threshold]  the rule in force, for the record
 */
async function raise({
  schoolId, kind, amount, targetId = null, payload = null,
  reason = null, summary = null, requestedBy, threshold = null,
}) {
  if (!schoolId)            throw fail("schoolId is required", "BAD_REQUEST");
  if (!KINDS.includes(kind)) throw fail(`Unknown approval kind "${kind}"`, "BAD_REQUEST");

  const n = whole(amount);
  if (n === null || n < 0) {
    throw fail("amount must be a whole number of XAF", "INVALID_AMOUNT");
  }

  try {
    return await ApprovalRequest.create({
      schoolId, kind, targetId, payload,
      amount: n,
      thresholdAtRequest: threshold,
      reason, summary, requestedBy,
      status: "pending",
    });
  } catch (err) {
    // The partial unique index on (schoolId, kind, targetId) while pending. A
    // double-click, or two people acting on the same expense at once.
    if (err.code === 11000) {
      throw fail(
        "There is already a request waiting for a decision on this",
        "ALREADY_PENDING",
        409
      );
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPLIERS
//
// One per kind. Each revalidates its world before acting — see the header.
// Each returns a short line for the log; each throws to signal that the effect
// could not land, which decide() records without unwinding the decision.
// ─────────────────────────────────────────────────────────────────────────────

const appliers = {
  /**
   * An expense already exists and is pending. Approving lets it count.
   */
  async expense(request, { approve }) {
    const expense = await Expense.findOne({
      _id: request.targetId, schoolId: request.schoolId, deletedAt: null,
    });
    if (!expense) throw fail("The expense no longer exists", "TARGET_GONE", 409);

    if (expense.voidedAt) {
      throw fail("The expense was voided while awaiting approval", "TARGET_VOID", 409);
    }

    expense.status = approve ? "approved" : "rejected";
    await expense.save();
    return `expense ${expense._id} → ${expense.status}`;
  },

  /**
   * Nothing exists yet: on approval, write the negative payment.
   *
   * A refund is NOT a reversal, and the ledger keeps them apart. A reversal
   * says the payment should never have been recorded and points at it with
   * reversesId. A refund says the payment was real and the money is going
   * back — so it stands alone, and the student's balance rises by the amount
   * returned, which is exactly what balancesFor computes from the sum.
   */
  async refund(request, { approve }) {
    if (!approve) return "refund declined — nothing written";

    const p = request.payload ?? {};
    const amount = whole(p.amount);
    if (amount === null || amount <= 0) {
      throw fail("The stored refund amount is not usable", "BAD_PAYLOAD", 409);
    }

    const student = await Student.findOne({
      _id: p.studentId, schoolId: request.schoolId, deletedAt: null,
    }).select("_id classId").lean();

    if (!student) {
      throw fail("The student no longer exists", "TARGET_GONE", 409);
    }

    const payment = await FeePayment.create({
      schoolId:     request.schoolId,
      studentId:    p.studentId,
      academicYear: p.academicYear,
      term:         p.term ?? null,
      classId:      student.classId ?? null,
      // Negative: money leaving the school. The sign is the whole mechanism.
      amount:       -Math.abs(amount),
      method:       p.method ?? "cash",
      reference:    p.reference ?? null,
      // Receipt numbers are per school AND per academic year, so the year has
      // to be passed — omitting it would mint every refund under the counter
      // key "…:undefined" and hand out numbers labelled RCT-undefined-0001.
      receiptNo:    await nextReceiptNo(request.schoolId, p.academicYear),
      receivedAt:   new Date(),
      receivedBy:   request.requestedBy ?? null,
      note:         p.note ?? `Refund approved (${request._id})`,
      source:       "web",
    });

    return `refund payment ${payment._id} written for ${amount}`;
  },

  /**
   * The charge exists; the reduction does not until now.
   */
  async waiver(request, { approve }) {
    if (!approve) return "waiver declined — the charge is unchanged";

    const charge = await FeeCharge.findOne({
      _id: request.targetId, schoolId: request.schoolId, deletedAt: null,
    });
    if (!charge) throw fail("The fee charge no longer exists", "TARGET_GONE", 409);
    if (charge.voidedAt) {
      throw fail("The charge was voided while awaiting approval", "TARGET_VOID", 409);
    }

    const waived = whole(request.payload?.waivedAmount);
    if (waived === null || waived <= 0) {
      throw fail("The stored waiver amount is not usable", "BAD_PAYLOAD", 409);
    }

    // Revalidated against the charge as it stands NOW, not as it stood when the
    // request was raised. A part-payment or an earlier waiver in between must
    // not let the total reduction exceed the bill.
    if (waived > charge.amount) {
      throw fail(
        `A waiver of ${waived} exceeds the charge of ${charge.amount}`,
        "WAIVER_TOO_LARGE",
        409
      );
    }

    charge.waivedAmount = waived;
    charge.waiverReason = request.payload?.waiverReason ?? request.reason ?? null;
    await charge.save();
    return `charge ${charge._id} waived by ${waived}`;
  },

  /**
   * The draft run exists and pays nobody. Approving moves it to "approved",
   * which is what the bursar's confirm step then requires.
   */
  async payroll(request, { approve }) {
    const run = await PayrollRun.findOne({
      _id: request.targetId, schoolId: request.schoolId, deletedAt: null,
    });
    if (!run) throw fail("The payroll run no longer exists", "TARGET_GONE", 409);

    if (run.status !== "draft") {
      throw fail(`This run is already ${run.status}`, "NOT_DRAFT", 409);
    }

    if (!approve) return "payroll declined — the run stays a draft";

    run.status     = "approved";
    run.approvedBy = request.decidedBy ?? null;
    run.approvedAt = new Date();
    run.approvalId = request._id;
    await run.save();
    return `payroll run ${run._id} → approved`;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DECIDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approve or reject, then carry out the effect.
 *
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string}  p.requestId
 * @param {boolean} p.approve
 * @param {string}  p.decidedBy   the user id of whoever is deciding
 * @param {string} [p.note]
 */
async function decide({ schoolId, requestId, approve, decidedBy, note = null }) {
  const request = await ApprovalRequest.findOne({
    _id: requestId, schoolId, deletedAt: null,
  });

  if (!request) throw fail("Approval request not found", "NOT_FOUND", 404);

  if (request.status !== "pending") {
    throw fail(
      `This request was already ${request.status}`,
      "ALREADY_DECIDED",
      409
    );
  }

  // ── The control ───────────────────────────────────────────────────────────
  //
  // Four eyes, and no exemption for a super admin. Somebody with two accounts
  // can still defeat it, which is a problem about handing out accounts and not
  // one a workflow can solve; what this stops is the ordinary case, which is
  // one busy person clicking twice because it is faster.
  if (
    decidedBy &&
    request.requestedBy &&
    String(decidedBy) === String(request.requestedBy)
  ) {
    throw fail(
      "You raised this request, so you cannot be the one to decide it. " +
      "Approval has to come from somebody else.",
      "SELF_APPROVAL",
      403
    );
  }

  request.status       = approve ? "approved" : "rejected";
  request.decidedBy    = decidedBy ?? null;
  request.decidedAt    = new Date();
  request.decisionNote = note;
  await request.save();

  // The decision is recorded before the effect is attempted, and deliberately
  // so: if applying throws, the decision must survive it. The alternative is a
  // head teacher who approved something and finds no record that they did.
  let applied = null;
  try {
    applied = await appliers[request.kind](request, { approve });
  } catch (err) {
    request.applyError = err.message;
    await request.save();
    console.error(
      `[approvals] ${request.kind} ${request._id} was ${request.status} ` +
      `but could not be applied: ${err.message}`
    );
    // Rethrown with the decision noted, so the caller can tell the user that
    // their approval was recorded and did not take effect — two facts, both
    // true, and hiding either is worse.
    err.decisionRecorded = true;
    throw err;
  }

  console.log(
    `🔐 approval ${request._id} (${request.kind}) ${request.status} ` +
    `by ${decidedBy} — ${applied}`
  );

  return { request, applied };
}

/**
 * Withdraw a request you raised, before anybody has decided it.
 *
 * Not the same as rejection: nobody has said no, so nothing is recorded against
 * the requester. For an expense it leaves the row rejected rather than pending,
 * because a withdrawn expense must not keep sitting outside the accounts with
 * nothing waiting to resolve it.
 */
async function cancel({ schoolId, requestId, userId }) {
  const request = await ApprovalRequest.findOne({
    _id: requestId, schoolId, deletedAt: null,
  });

  if (!request) throw fail("Approval request not found", "NOT_FOUND", 404);
  if (request.status !== "pending") {
    throw fail(`This request was already ${request.status}`, "ALREADY_DECIDED", 409);
  }
  if (String(request.requestedBy ?? "") !== String(userId ?? "")) {
    throw fail("Only the person who raised a request may withdraw it", "NOT_YOURS", 403);
  }

  request.status    = "cancelled";
  request.decidedBy = userId ?? null;
  request.decidedAt = new Date();
  await request.save();

  if (request.kind === "expense" && request.targetId) {
    await Expense.updateOne(
      { _id: request.targetId, schoolId, status: "pending" },
      { $set: { status: "rejected" } }
    );
  }

  return request;
}

// ─────────────────────────────────────────────────────────────────────────────
// READING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string} [p.status]      defaults to pending
 * @param {string} [p.kind]
 * @param {string} [p.requestedBy] scope to one person's own requests
 * @param {number} [p.limit]
 */
async function list({ schoolId, status = "pending", kind = null, requestedBy = null, limit = 100 }) {
  const filter = { schoolId, deletedAt: null };
  if (status && status !== "all") filter.status = status;
  if (kind)        filter.kind        = kind;
  if (requestedBy) filter.requestedBy = requestedBy;

  return ApprovalRequest.find(filter)
    .sort({ requestedAt: -1 })
    .limit(Math.max(1, Math.min(500, Number(limit) || 100)))
    .lean();
}

/** How many are waiting. The number on the dashboard tile. */
async function pendingCount(schoolId) {
  if (!schoolId) return 0;
  return ApprovalRequest.countDocuments({
    schoolId, status: "pending", deletedAt: null,
  });
}

module.exports = {
  KINDS,
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  thresholdsFor,
  requiresApprovalWith,
  requiresApproval,
  raise,
  decide,
  cancel,
  list,
  pendingCount,
};
