// backend/src/services/agreements.service.js
"use strict";

/**
 * Individual fee agreements: one pupil's own instalment schedule, which
 * overrides the general fee structure once — and only once — an administrator
 * has approved it.
 *
 * ── Built on PaymentPlan, not beside it ───────────────────────────────────
 *
 * The school already had "a family pays this year's fees on its own dates":
 * PaymentPlan, read by the arrears figures, reminders, late fees, the portal
 * and the desktop. A second collection for the same idea would give one
 * family's deadline two homes. An agreement is a PaymentPlan with an approval,
 * dates it is in force between, notes and a history (models/PaymentPlan.js).
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 *   - An agreement changes WHEN, never HOW MUCH. Its instalments add up either
 *     to the year's whole net bill (basis "total" — the 50,000 + 50,000 +
 *     100,000 in place of 75,000 + 75,000 + 50,000) or to what is still
 *     outstanding (basis "balance"). Anything else is refused: a reduction
 *     is a waiver, which has its own approval.
 *   - Proposed by whoever holds fees.plan (the bursar); decided through the
 *     approvals queue by an administrator who is NOT the proposer
 *     (approvals.service decide — four eyes, no exemption).
 *   - Unapproved never overrides: a pending agreement, a rejected one, and a
 *     pending CHANGE to an approved one all leave the pupil measured against
 *     what was in force before (shared/arrears.js isPlanApplicable).
 *   - Every step is written to the plan's own append-only history — creator,
 *     approver, modifier, the instalments before and after.
 */

const PaymentPlan     = require("../db/models/PaymentPlan");
const ApprovalRequest = require("../db/models/ApprovalRequest");
const Student         = require("../db/models/Student");
const { balanceFor }  = require("./fees.service");
const { asWholeAmount, asDueDate } = require("../../../shared/feeStructures");
const { displayName } = require("../utils/studentName");

const fail = (message, code, status = 400) => {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
};

const plainInstalments = (list) =>
  (list ?? []).map((i) => ({ seq: i.seq, amount: i.amount, dueDate: i.dueDate }));

/** The part of an agreement the history records as before/after. */
const snapshot = (p) => ({
  instalments:   plainInstalments(p.instalments),
  agreedTotal:   p.agreedTotal ?? null,
  basis:         p.basis ?? null,
  baselinePaid:  p.baselinePaid ?? 0,
  effectiveFrom: p.effectiveFrom ?? null,
  expiresAt:     p.expiresAt ?? null,
  notes:         p.notes ?? null,
});

/**
 * Raw instalments from a request → [{ seq, amount, dueDate }], or a thrown 400.
 * Dates must not go backwards (the model checks too, but a sentence here is
 * kinder than a validation error).
 */
function cleanInstalments(raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw fail("An agreement needs at least two instalments — one is just a due date", "TOO_FEW_INSTALMENTS");
  }
  const out = [];
  for (const [i, r] of raw.entries()) {
    const amount = asWholeAmount(r?.amount);
    if (amount === null || amount <= 0) {
      throw fail(`Instalment ${i + 1} must be a whole number of XAF greater than zero`, "INVALID_AMOUNT");
    }
    const dueDate = asDueDate(r?.dueDate);
    if (dueDate === undefined || dueDate === null) {
      throw fail(`Instalment ${i + 1} needs a date like 2026-09-15`, "INVALID_DATE");
    }
    if (out.length && dueDate < out[out.length - 1].dueDate) {
      throw fail(`Instalment ${i + 1} is due before instalment ${i}`, "DATES_BACKWARDS");
    }
    out.push({ seq: i + 1, amount, dueDate });
  }
  return out;
}

/** An optional date field: undefined (absent), null (cleared), or a Date. */
function optionalDate(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = asDueDate(value);
  if (!d) throw fail(`${label} needs a date like 2026-09-15`, "INVALID_DATE");
  return d;
}

function cleanAttachments(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw fail("attachments must be a list", "BAD_REQUEST");
  return raw.slice(0, 20).map((a, i) => {
    const name = String(a?.name ?? "").trim();
    const url  = String(a?.url ?? "").trim();
    if (!name || !url) throw fail(`Attachment ${i + 1} needs a name and a link`, "BAD_REQUEST");
    if (!/^(\/uploads\/|https?:\/\/)/i.test(url)) {
      throw fail(`Attachment ${i + 1} must be a stored file or a web link`, "BAD_REQUEST");
    }
    return { name: name.slice(0, 200), url: url.slice(0, 1000) };
  });
}

/**
 * Which basis a schedule is on, from what it adds up to — or a thrown 400.
 *
 * @returns {{ basis: "total"|"balance", baselinePaid: number, total: number }}
 */
async function basisFor({ schoolId, studentId, academicYear, instalments }) {
  const totals  = await balanceFor({ schoolId, studentId, academicYear });
  const billed  = totals.charged - totals.waived;
  const planned = instalments.reduce((s, i) => s + i.amount, 0);

  if (billed <= 0 || totals.balance <= 0) {
    throw fail("This family has nothing outstanding for that year", "NOTHING_OUTSTANDING");
  }
  // Whole bill first: when nothing has been paid the two are equal, and
  // "total" (no baseline) is the simpler reading.
  if (planned === billed) return { basis: "total", baselinePaid: 0, total: planned };
  if (planned === totals.balance) {
    return { basis: "balance", baselinePaid: Math.max(0, totals.paid), total: planned };
  }
  throw fail(
    `The instalments add up to ${planned}. They must add up to the year's fees ` +
    `(${billed}) or to what is still outstanding (${totals.balance}). An agreement ` +
    `changes when fees are due, never how much — use a waiver to reduce a bill.`,
    "PLAN_TOTAL_MISMATCH"
  );
}

async function studentLabel(schoolId, studentId) {
  const s = await Student.findOne({ _id: studentId, schoolId })
    .select("studentName name firstName lastName enrollmentNo").lean();
  return s ? `${displayName(s)}${s.enrollmentNo ? ` (${s.enrollmentNo})` : ""}` : "a pupil";
}

/** Put an agreement (or a change to one) in the approvals queue. */
async function raiseApproval({ plan, action, amount, reason, requestedBy }) {
  const { raise } = require("./approvals.service");
  const who = await studentLabel(plan.schoolId, plan.studentId);
  return raise({
    schoolId: plan.schoolId,
    kind:     "agreement",
    amount,
    targetId: String(plan._id),
    payload:  { action },
    reason,
    summary:  action === "change"
      ? `Change to the fee agreement for ${who}`
      : `Fee agreement for ${who}`,
    requestedBy,
  });
}

/**
 * Propose a new agreement. It is created PENDING and does not govern the pupil
 * until approved.
 *
 * Replay-safe on `planId`, like the plan endpoint it replaces: a proposal
 * made with no connection and retried answers with the row it made.
 */
async function propose({
  schoolId, studentId, academicYear, term = null, instalments: rawInstalments,
  reason, notes = null, attachments, effectiveFrom, expiresAt, planId = null, userId = null,
}) {
  if (!studentId)    throw fail("studentId is required", "BAD_REQUEST");
  if (!academicYear) throw fail("academicYear is required", "BAD_REQUEST");
  const why = reason ? String(reason).trim() : "";
  if (!why) throw fail("A reason is required for a fee agreement", "REASON_REQUIRED");

  if (planId) {
    const already = await PaymentPlan.findById(planId).lean();
    if (already) {
      if (String(already.schoolId) !== String(schoolId)) {
        throw fail("That plan id already belongs to another school", "PLAN_ID_TAKEN", 409);
      }
      return { plan: already, replay: true };
    }
  }

  const student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null }).select("_id").lean();
  if (!student) throw fail("No student with that id in this school", "STUDENT_NOT_FOUND", 404);

  const instalments = cleanInstalments(rawInstalments);
  const from  = optionalDate(effectiveFrom, "The start date") ?? null;
  const until = optionalDate(expiresAt, "The expiry date") ?? null;
  if (from && until && until < from) throw fail("The agreement expires before it starts", "INVALID_DATE");
  const files = cleanAttachments(attachments) ?? [];
  const { basis, baselinePaid, total } = await basisFor({ schoolId, studentId, academicYear, instalments });

  let plan;
  try {
    plan = await PaymentPlan.create({
      _id: planId || undefined,
      schoolId, studentId, academicYear, term,
      instalments, reason: why,
      notes: notes ? String(notes).trim() : null,
      attachments: files,
      basis, baselinePaid, agreedTotal: total,
      effectiveFrom: from, expiresAt: until,
      status: "active",
      approvalStatus: "pending",
      agreedBy: userId,
      history: [{
        by: userId, action: "created", note: why,
        after: snapshot({ instalments, agreedTotal: total, basis, baselinePaid, effectiveFrom: from, expiresAt: until, notes }),
      }],
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw fail(
        "This family already has an agreement for that year and term (approved or " +
        "waiting for approval). Cancel it, or propose a change to it.",
        "PLAN_EXISTS", 409
      );
    }
    throw err;
  }

  try {
    const request = await raiseApproval({ plan, action: "create", amount: total, reason: why, requestedBy: userId });
    plan.approvalRequestId = String(request._id);
    await plan.save();
  } catch (err) {
    // Without a request nobody could ever approve it, and it would hold the
    // pupil's slot for good. Withdrawn, with the reason recorded.
    plan.status = "cancelled";
    plan.cancelledAt = new Date();
    plan.cancelledReason = `Could not be sent for approval: ${err.message}`;
    plan.history.push({ by: userId, action: "cancelled", note: plan.cancelledReason });
    await plan.save().catch(() => {});
    throw err;
  }

  return { plan: plan.toObject(), replay: false };
}

/**
 * Propose a change.
 *
 *   - to an agreement still waiting for approval: the proposal itself is
 *     replaced (it governs nothing yet), and the same request stays open;
 *   - to an approved agreement: held in pendingChange — the approved schedule
 *     keeps governing until this is approved.
 */
async function proposeChange({
  schoolId, planId, instalments: rawInstalments, effectiveFrom, expiresAt, notes, attachments,
  reason, userId = null,
}) {
  const why = reason ? String(reason).trim() : "";
  if (!why) throw fail("A reason is required to change a fee agreement", "REASON_REQUIRED");

  const plan = await PaymentPlan.findOne({ _id: planId, schoolId, deletedAt: null });
  if (!plan) throw fail("Agreement not found", "NOT_FOUND", 404);
  if (plan.status !== "active") throw fail(`This agreement is ${plan.status}`, "NOT_ACTIVE");
  if (plan.pendingChange) {
    throw fail("A change to this agreement is already waiting for approval", "CHANGE_PENDING", 409);
  }

  const instalments = rawInstalments === undefined
    ? plainInstalments(plan.instalments)
    : cleanInstalments(rawInstalments);
  const fromIn  = optionalDate(effectiveFrom, "The start date");
  const untilIn = optionalDate(expiresAt, "The expiry date");
  const from  = fromIn  === undefined ? plan.effectiveFrom ?? null : fromIn;
  const until = untilIn === undefined ? plan.expiresAt ?? null     : untilIn;
  if (from && until && until < from) throw fail("The agreement expires before it starts", "INVALID_DATE");
  const files = cleanAttachments(attachments);
  const nextNotes = notes === undefined ? plan.notes : (notes ? String(notes).trim() : null);

  const { basis, baselinePaid, total } = await basisFor({
    schoolId, studentId: plan.studentId, academicYear: plan.academicYear, instalments,
  });

  const before = snapshot(plan);
  const after  = snapshot({ instalments, agreedTotal: total, basis, baselinePaid, effectiveFrom: from, expiresAt: until, notes: nextNotes });

  if (plan.approvalStatus === "pending") {
    plan.instalments   = instalments;
    plan.agreedTotal   = total;
    plan.basis         = basis;
    plan.baselinePaid  = baselinePaid;
    plan.effectiveFrom = from;
    plan.expiresAt     = until;
    plan.notes         = nextNotes;
    if (files) plan.attachments = files;
    plan.history.push({ by: userId, action: "change_proposed", note: why, before, after });
    await plan.save();
    if (plan.approvalRequestId) {
      await ApprovalRequest.updateOne(
        { _id: plan.approvalRequestId, schoolId, status: "pending" },
        { $set: { amount: total } }
      );
    }
    return plan.toObject();
  }

  plan.pendingChange = {
    instalments, effectiveFrom: from, expiresAt: until, notes: nextNotes,
    reason: why, requestedBy: userId, requestedAt: new Date(),
  };
  // basis, baseline and total are worked out again when it is approved
  // (applyDecision) — payments may have arrived in between.
  plan.history.push({ by: userId, action: "change_proposed", note: why, before, after });
  if (files) plan.attachments = files;   // the paperwork itself is not the schedule
  await plan.save();

  try {
    const request = await raiseApproval({ plan, action: "change", amount: total, reason: why, requestedBy: userId });
    plan.pendingChange.approvalRequestId = String(request._id);
    await plan.save();
  } catch (err) {
    plan.pendingChange = null;
    plan.history.push({ by: userId, action: "change_rejected", note: `Could not be sent for approval: ${err.message}` });
    await plan.save().catch(() => {});
    throw err;
  }
  return plan.toObject();
}

/**
 * The approvals applier for kind "agreement" (approvals.service decide). The
 * decision is already saved on the request; this makes it true of the plan.
 */
async function applyDecision(request, { approve }) {
  const plan = await PaymentPlan.findOne({ _id: request.targetId, schoolId: request.schoolId, deletedAt: null });
  if (!plan) throw fail("The agreement no longer exists", "TARGET_GONE", 409);
  const by   = request.decidedBy ?? null;
  const note = request.decisionNote ?? null;
  const now  = new Date();

  if (request.payload?.action === "change") {
    const change = plan.pendingChange;
    if (!change || String(change.approvalRequestId) !== String(request._id)) {
      throw fail("That change is no longer waiting on this agreement", "TARGET_CHANGED", 409);
    }
    if (!approve) {
      plan.pendingChange = null;
      plan.history.push({ at: now, by, action: "change_rejected", note });
      await plan.save();
      return `agreement ${plan._id} change → rejected`;
    }
    if (plan.status !== "active") throw fail(`The agreement was ${plan.status} meanwhile`, "NOT_ACTIVE", 409);
    // Re-checked at the moment it takes effect: a payment or a waiver since the
    // proposal may mean it no longer adds up.
    const instalments = plainInstalments(change.instalments);
    const { basis, baselinePaid, total } = await basisFor({
      schoolId: plan.schoolId, studentId: plan.studentId, academicYear: plan.academicYear, instalments,
    });
    const before = snapshot(plan);
    plan.instalments   = instalments;
    plan.agreedTotal   = total;
    plan.basis         = basis;
    plan.baselinePaid  = baselinePaid;
    plan.effectiveFrom = change.effectiveFrom ?? null;
    plan.expiresAt     = change.expiresAt ?? null;
    plan.notes         = change.notes ?? plan.notes;
    plan.pendingChange = null;
    plan.history.push({ at: now, by, action: "change_approved", note, before, after: snapshot(plan) });
    await plan.save();
    return `agreement ${plan._id} change → approved`;
  }

  if (plan.approvalStatus !== "pending") {
    throw fail(`This agreement is already ${plan.approvalStatus ?? "approved"}`, "ALREADY_DECIDED", 409);
  }
  if (!approve) {
    plan.approvalStatus  = "rejected";
    plan.status          = "cancelled";        // frees the pupil's slot
    plan.rejectedBy      = by;
    plan.rejectedAt      = now;
    plan.rejectionReason = note;
    plan.cancelledBy     = by;
    plan.cancelledAt     = now;
    plan.cancelledReason = note ? `Rejected: ${note}` : "Rejected";
    plan.history.push({ at: now, by, action: "rejected", note });
    await plan.save();
    return `agreement ${plan._id} → rejected`;
  }
  if (plan.status !== "active") throw fail(`The agreement was ${plan.status} meanwhile`, "NOT_ACTIVE", 409);

  plan.approvalStatus = "approved";
  plan.approvedBy     = by;
  plan.approvedAt     = now;
  if (!plan.effectiveFrom) plan.effectiveFrom = now;
  plan.history.push({ at: now, by, action: "approved", note });
  await plan.save();
  return `agreement ${plan._id} → approved`;
}

/** The proposer withdrew the request (approvals.service cancel). */
async function onWithdrawn(request) {
  const plan = await PaymentPlan.findOne({ _id: request.targetId, schoolId: request.schoolId, deletedAt: null });
  if (!plan) return;
  const by = request.decidedBy ?? null;
  if (request.payload?.action === "change") {
    if (plan.pendingChange && String(plan.pendingChange.approvalRequestId) === String(request._id)) {
      plan.pendingChange = null;
      plan.history.push({ by, action: "change_rejected", note: "Withdrawn by the proposer" });
      await plan.save();
    }
    return;
  }
  if (plan.approvalStatus === "pending" && plan.status === "active") {
    plan.status = "cancelled";
    plan.cancelledBy = by;
    plan.cancelledAt = new Date();
    plan.cancelledReason = "Withdrawn before approval";
    plan.history.push({ by, action: "cancelled", note: "Withdrawn before approval" });
    await plan.save();
  }
}

/**
 * Called when a plan is cancelled through the plan route: closes any approval
 * still open on it, so the queue does not offer to approve a dead agreement.
 */
async function closeOpenRequests(plan, { by }) {
  const ids = [plan.approvalRequestId, plan.pendingChange?.approvalRequestId].filter(Boolean);
  if (!ids.length) return;
  await ApprovalRequest.updateMany(
    { _id: { $in: ids }, schoolId: plan.schoolId, status: "pending" },
    { $set: { status: "cancelled", decidedBy: by ?? null, decidedAt: new Date(), decisionNote: "Agreement cancelled" } }
  );
}

module.exports = {
  propose, proposeChange, applyDecision, onWithdrawn, closeOpenRequests,
  cleanInstalments, basisFor, snapshot,
};
