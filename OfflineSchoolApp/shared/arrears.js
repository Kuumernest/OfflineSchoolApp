// shared/arrears.js
"use strict";

/**
 * What a pupil owes, and how much of it is late — defined once.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Two screens disagreed about the same school on the same day. The bell said
 * "7 families overdue (1,025,000 FCFA)"; the Fees page said 3,125,000 owed.
 * Both were reading the ledger correctly and answering different questions
 * with the same words:
 *
 *   - the Fees page summed every positive balance, due or not — what is OWED;
 *   - the bell picked the pupils whose oldest unpaid charge was past its date,
 *     then summed their WHOLE balance, next term's fees included, and called
 *     each pupil a family.
 *
 * So there are now exactly two money figures, and every screen uses them:
 *
 *   owed     everything unpaid: charged − waived − paid, when above zero
 *   overdue  the part of that whose due date has passed
 *
 * and a pupil is overdue when their overdue figure is above zero.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 *   Payments settle the oldest obligation first: charges in due-date order,
 *   each net of its waiver. A family that has paid 60,000 of a 100,000 First
 *   Term owes 40,000 overdue, not 100,000 of Second Term.
 *
 *   A charge is late the day AFTER its due date (endOfDay) — fees due on the
 *   15th are not late at one minute past midnight on the 15th.
 *
 *   A charge with no due date is due at once. The caller scopes charges to one
 *   academic year, which is what keeps every undated charge from before due
 *   dates existed from being chased forever.
 *
 *   A pupil on an active payment plan is judged against the plan instead: the
 *   plan moves WHEN money is due, never how much is owed, so overdue is how far
 *   behind the plan's schedule they are.
 *
 * Pure: no database, no clock it does not take as an argument. Required by
 * backend/src/services/arrears.service.js (which loads the ledger) and by the
 * fee reminders and late-fee code.
 */

/** The last instant of a calendar day (UTC), when something due that day becomes late. */
const endOfDay = (d) => {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
};

const netOf = (c) => Math.max(0, (c.amount ?? 0) - (c.waivedAmount ?? 0));

/** Charges in the order payments settle them: due date, undated as "now", then creation. */
const settleOrder = (charges, asOf) => {
  const at = (c) => (c.dueDate ? new Date(c.dueDate).getTime() : asOf.getTime());
  return [...charges].sort((a, b) =>
    at(a) - at(b) || new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
};

const isLate = (c, asOf) => !c.dueDate || endOfDay(c.dueDate) < asOf;

/**
 * The first charge a family's payments have not covered, or null.
 *
 * @param {Array<{amount:number, waivedAmount?:number, dueDate?:Date|null, createdAt?:Date}>} charges
 * @param {number} paid
 * @param {Date}   [asOf]
 */
function firstUnpaid(charges, paid, asOf = new Date()) {
  let left = paid;
  for (const c of settleOrder(charges, asOf)) {
    const net = netOf(c);
    if (left >= net) { left -= net; continue; }
    return c;
  }
  return null;
}

/**
 * Where a family stands against an instalment plan.
 *
 * CUMULATIVE, not per instalment: by the third date a family should have paid
 * the first three instalments in total, so one who paid double on the first
 * and nothing on the second is exactly on track.
 *
 * @param {{instalments: Array<{seq:number,amount:number,dueDate:Date}>}} plan
 * @param {number} paid
 * @param {Date}   [asOf]
 */
function planStatus(plan, paid, asOf = new Date()) {
  const schedule = [...(plan?.instalments ?? [])].sort((a, b) => a.seq - b.seq);

  let dueByNow    = 0;
  let nextDue     = null;
  let nextAmount  = 0;
  let missedSince = null;
  let running     = 0;

  for (const inst of schedule) {
    running += inst.amount;
    if (endOfDay(inst.dueDate) < asOf) {
      dueByNow = running;
      // The FIRST shortfall wins: the date a reminder should quote.
      if (missedSince === null && paid < running) missedSince = inst.dueDate;
    } else if (nextDue === null) {
      nextDue    = inst.dueDate;
      nextAmount = inst.amount;
    }
  }

  const behindBy = Math.max(0, dueByNow - paid);

  return {
    dueByNow,
    behindBy,
    isBehind: behindBy > 0,
    nextDue,
    nextAmount,
    missedSince,
    /** Every instalment covered, whether or not the dates have passed. */
    settled: paid >= running,
  };
}

/**
 * One pupil's position for one academic year.
 *
 * @param {object} p
 * @param {Array}  p.charges  the year's live charges (not voided, not deleted)
 * @param {number} p.paid     the year's payments
 * @param {object} [p.plan]   the pupil's active payment plan, if any
 * @param {Date}   [p.asOf]
 * @returns {{
 *   owed: number, overdue: number, notYetDue: number, isOverdue: boolean,
 *   overdueSince: Date|null,  // the first unpaid due date that has passed; null when undated
 *   nextDue: Date|null,       // the next unpaid due date still to come
 *   onPlan: boolean, plan: object|null
 * }}
 */
function feePosition({ charges = [], paid = 0, plan = null, asOf = new Date() }) {
  const billed = charges.reduce((s, c) => s + netOf(c), 0);
  const owed   = Math.max(0, billed - paid);

  if (plan) {
    const status  = planStatus(plan, paid, asOf);
    const overdue = Math.min(owed, status.behindBy);
    return {
      owed, overdue, notYetDue: owed - overdue, isOverdue: overdue > 0,
      overdueSince: overdue > 0 ? status.missedSince : null,
      nextDue: status.nextDue,
      onPlan: true, plan: status,
    };
  }

  // Payments go to the oldest charges first, so the late ones are covered
  // before anything not yet due.
  let left = paid;
  let overdue = 0;
  let overdueSince = null;
  let nextDue = null;
  for (const c of settleOrder(charges, asOf)) {
    const net    = netOf(c);
    const unpaid = Math.max(0, net - left);
    left = Math.max(0, left - net);
    if (unpaid === 0) continue;
    if (isLate(c, asOf)) {
      overdue += unpaid;
      // An undated charge is late with no date to quote; the first dated
      // late one is the date a reminder names.
      if (c.dueDate && overdueSince === null) overdueSince = c.dueDate;
    } else if (nextDue === null) {
      nextDue = c.dueDate;
    }
  }
  overdue = Math.min(owed, overdue);

  return {
    owed, overdue, notYetDue: owed - overdue, isOverdue: overdue > 0,
    overdueSince: overdue > 0 ? overdueSince : null,
    nextDue,
    onPlan: false, plan: null,
  };
}

/**
 * How many families a set of pupils belongs to.
 *
 * One guardian with three children is one family, not three (CLAUDE.md). The
 * link is the portal access record — one code covers all of a guardian's
 * children — and never a shared name, email or phone, which is normal for
 * siblings and proves nothing on its own. A pupil no access record covers
 * counts as a family of one. Access records that share a child are joined, so
 * two codes for one household still make one family.
 *
 * @param {string[]} studentIds
 * @param {Array<{studentIds: string[]}>} accesses
 */
function familyCount(studentIds, accesses = []) {
  const ids = [...new Set(studentIds.map(String))];
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const a of accesses) {
    const members = (a.studentIds ?? []).map(String).filter((id) => parent.has(id));
    for (let i = 1; i < members.length; i++) {
      const ra = find(members[0]), rb = find(members[i]);
      if (ra !== rb) parent.set(rb, ra);
    }
  }
  return new Set(ids.map(find)).size;
}

module.exports = { endOfDay, firstUnpaid, planStatus, feePosition, familyCount };
