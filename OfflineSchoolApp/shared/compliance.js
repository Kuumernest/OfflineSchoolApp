// shared/compliance.js

/**
 * Is this pupil up to date with their fees TODAY? — defined once.
 *
 * The gate asks it of every child at the door, the server answers it for the
 * gate's online lookups, and the phone and the desktop answer it offline from
 * what they last synced. One pure function, so all of them give the same
 * answer from the same facts.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 *   compliant  ⇔  verified payments ≥ the amount due BY TODAY
 *
 * "Due by today" counts only instalments whose due date has passed, never the
 * whole year's fee: a pupil who has paid every instalment that has fallen due
 * is compliant however much of next term is still unpaid.
 *
 *   Fees 200,000; instalments due so far 100,000; verified 75,000
 *     → outstanding due 25,000, remaining balance 125,000, NON-COMPLIANT
 *
 * ── Which schedule ───────────────────────────────────────────────────────
 *
 * An individual agreement (PaymentPlan) that is approved and in its dates
 * replaces the general schedule (shared/arrears.js isPlanApplicable). Anything
 * else — none, pending, rejected, expired — and the general schedule applies:
 * the pupil's own charges, grouped by due date (one term's structure = one
 * instalment). A charge with no due date is due at once, as everywhere else.
 *
 * ── Statuses, in the order they win ─────────────────────────────────────
 *
 *   AUTHORIZED     an administrator's gate authorization is in force for the
 *                  pupil (models/GateAuthorization.js), whatever they owe
 *   NON_COMPLIANT  something due has not been paid
 *   DUE            nothing missed, but the next unpaid instalment falls due
 *                  within `dueSoonDays`
 *   COMPLIANT      everything due is paid, nothing due soon
 *
 * ── What counts as paid ──────────────────────────────────────────────────
 *
 * Only CONFIRMED payments — ones the server has accepted. A payment recorded
 * on a device and not yet synced (pending) is reported beside the result,
 * never added to it; a rejected one is never counted. When a pending payment
 * would change the answer, `dependsOnPending` says so, so the gate can show
 * "would be compliant once the 50,000 recorded offline is confirmed" instead
 * of pretending.
 *
 * Pure: no database, no clock it is not handed.
 *
 * ── An ES module, on purpose ─────────────────────────────────────────────
 *
 * Every app runs this one file: the web (and so the desktop window) imports
 * it, Metro bundles it for the phone, and the server requires it (Node ≥ 22.12
 * loads an ES module through require()). It therefore imports nothing —
 * endOfDay and isPlanApplicable below are the rules of shared/arrears.js
 * (CommonJS, which a browser cannot load), and
 * backend/scripts/check-compliance.js asserts the two agree on every case.
 */

/** The last instant of a calendar day (UTC) — shared/arrears.js endOfDay. */
const endOfDay = (d) => {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
};

/**
 * Does an agreement govern on asOf? — shared/arrears.js isPlanApplicable, the
 * same rule: approved (or from before approvals existed), active, in its dates.
 */
function isPlanApplicable(plan, asOf = new Date()) {
  if (!plan || plan.deletedAt) return false;
  if (plan.status !== "active") return false;
  if (plan.approvalStatus != null && plan.approvalStatus !== "approved") return false;
  const at = new Date(asOf).getTime();
  if (plan.effectiveFrom) {
    const from = new Date(plan.effectiveFrom);
    from.setUTCHours(0, 0, 0, 0);
    if (from.getTime() > at) return false;
  }
  if (plan.expiresAt && endOfDay(plan.expiresAt).getTime() < at) return false;
  return true;
}

const STATUS = Object.freeze({
  COMPLIANT:     "compliant",
  DUE:           "due",
  NON_COMPLIANT: "non_compliant",
  AUTHORIZED:    "authorized",
});

/** How far ahead "due soon" looks — the same window as fee reminders. */
const DUE_SOON_DAYS = 14;

/** How old synced data may be before the gate calls it stale. */
const STALE_AFTER_HOURS = 24;

const DAY_MS = 86_400_000;

const netOf = (c) => (c?.voidedAt || c?.deletedAt ? 0 : Math.max(0, (c.amount ?? 0) - (c.waivedAmount ?? 0)));
const time  = (d) => (d == null ? null : new Date(d).getTime());

/**
 * A payment's state. Rows from the server are confirmed; a device marks its
 * own unsynced rows "pending" and refused ones "rejected" before calling.
 */
const stateOf = (p) => {
  const s = String(p?.state ?? p?.syncState ?? "confirmed").toLowerCase();
  return s === "pending" || s === "rejected" ? s : "confirmed";
};

/**
 * The general schedule: the pupil's live charges as dated instalments,
 * one per due date, in date order. Undated charges are due at once (asOf).
 */
function standardSchedule(charges, asOf) {
  const byDay = new Map();
  for (const c of charges ?? []) {
    const net = netOf(c);
    if (net <= 0) continue;
    const day = c.dueDate ? new Date(c.dueDate) : null;
    const key = day ? day.toISOString().slice(0, 10) : "undated";
    const row = byDay.get(key) ?? { amount: 0, dueDate: day, undated: !day };
    row.amount += net;
    byDay.set(key, row);
  }
  return [...byDay.values()]
    .sort((a, b) => (a.undated ? asOf.getTime() : a.dueDate.getTime()) - (b.undated ? asOf.getTime() : b.dueDate.getTime()))
    .map((r, i) => ({ seq: i + 1, amount: r.amount, dueDate: r.dueDate }));
}

/** Is a gate authorization in force on asOf? */
function authorizationApplies(a, asOf) {
  if (!a || a.deletedAt || a.revokedAt) return false;
  const at = asOf.getTime();
  if (a.validFrom) {
    const from = new Date(a.validFrom);
    from.setUTCHours(0, 0, 0, 0);
    if (from.getTime() > at) return false;
  }
  if (!a.validUntil) return false;            // a gate pass always has an end
  return endOfDay(a.validUntil).getTime() >= at;
}

/**
 * Walk a schedule against an amount paid (in the schedule's own terms).
 * Cumulative: by the third date the first three instalments are due in total.
 */
function walk(schedule, paid, asOf, dueSoonDays) {
  let dueByNow = 0, running = 0;
  let nextDue = null, nextAmount = 0, missedSince = null, missedAmount = 0;
  const lines = [];

  for (const inst of schedule) {
    running += inst.amount;
    const isDue = !inst.dueDate || endOfDay(inst.dueDate) < asOf;
    const covered = Math.max(0, Math.min(inst.amount, paid - (running - inst.amount)));
    lines.push({
      seq: inst.seq, amount: inst.amount, dueDate: inst.dueDate ?? null,
      isDue, paid: covered, unpaid: inst.amount - covered,
    });
    if (isDue) {
      dueByNow = running;
      if (missedSince === null && paid < running) { missedSince = inst.dueDate ?? null; missedAmount = inst.amount; }
    } else if (nextDue === null && paid < running) {
      // The next instalment the family still has to fund — skipping any
      // already covered by paying ahead.
      nextDue = inst.dueDate;
      nextAmount = inst.amount;
    }
  }

  const outstandingDue = Math.max(0, dueByNow - paid);
  const dueSoon = nextDue != null &&
    (time(nextDue) - asOf.getTime()) <= dueSoonDays * DAY_MS;

  return { dueByNow, outstandingDue, nextDue, nextAmount, missedSince, missedAmount, dueSoon, lines, total: running };
}

/**
 * A pupil's fee compliance on `asOf`.
 *
 * @param {object} p
 * @param {Array}  p.charges         the year's charges (voided/deleted ignored)
 * @param {Array}  [p.payments]      the year's payments: { amount, receivedAt, state? }
 *                                   state "confirmed" (default) | "pending" | "rejected"
 * @param {object} [p.plan]          the pupil's agreement, if any (any state)
 * @param {Array|object} [p.authorizations] gate authorizations for the pupil
 * @param {Date}   [p.asOf]
 * @param {Date|string|null} [p.dataAsOf]  when the data was last synced (offline);
 *                                   omit for live server data
 * @param {number} [p.dueSoonDays]
 * @param {number} [p.staleAfterHours]
 */
function compliance({
  charges = [], payments = [], plan = null, authorizations = [],
  asOf = new Date(), dataAsOf, dueSoonDays = DUE_SOON_DAYS, staleAfterHours = STALE_AFTER_HOURS,
} = {}) {
  asOf = new Date(asOf);

  // ── Money in ──────────────────────────────────────────────────────────
  let verifiedPaid = 0, pendingPaid = 0, pendingCount = 0, rejectedCount = 0, rejectedPaid = 0;
  let lastPaymentDate = null;
  for (const p of payments ?? []) {
    if (!p || p.deletedAt) continue;
    const amount = Number(p.amount) || 0;
    const state = stateOf(p);
    if (state === "rejected") { rejectedCount++; rejectedPaid += amount; continue; }
    if (state === "pending")  { pendingCount++;  pendingPaid  += amount; continue; }
    verifiedPaid += amount;    // reversals are negative rows: a plain sum nets them
    if (amount > 0 && p.receivedAt) {
      const t = time(p.receivedAt);
      if (lastPaymentDate === null || t > time(lastPaymentDate)) lastPaymentDate = new Date(t);
    }
  }

  const totalFees = (charges ?? []).reduce((s, c) => s + netOf(c), 0);
  const remainingBalance = Math.max(0, totalFees - verifiedPaid);

  // ── Which schedule ────────────────────────────────────────────────────
  const onAgreement = isPlanApplicable(plan, asOf);
  const baseline = onAgreement ? Math.max(0, Number(plan.baselinePaid) || 0) : 0;
  const schedule = onAgreement
    ? [...(plan.instalments ?? [])].sort((a, b) => a.seq - b.seq)
        .map((i) => ({ seq: i.seq, amount: i.amount, dueDate: i.dueDate ? new Date(i.dueDate) : null }))
    : standardSchedule(charges, asOf);

  // A "balance" agreement's schedule starts after what was already paid.
  const credited     = (paid) => Math.max(0, paid - baseline);
  const now          = walk(schedule, credited(verifiedPaid), asOf, dueSoonDays);
  const withPending  = walk(schedule, credited(verifiedPaid + pendingPaid), asOf, dueSoonDays);

  // ── Status ────────────────────────────────────────────────────────────
  const auths = Array.isArray(authorizations) ? authorizations : authorizations ? [authorizations] : [];
  const authorization = auths
    .filter((a) => authorizationApplies(a, asOf))
    .sort((a, b) => time(b.validUntil) - time(a.validUntil))[0] ?? null;

  const statusOf = (w) => {
    if (authorization) return STATUS.AUTHORIZED;
    if (w.outstandingDue > 0) return STATUS.NON_COMPLIANT;
    if (w.dueSoon) return STATUS.DUE;
    return STATUS.COMPLIANT;
  };
  const status = statusOf(now);
  const statusIfPendingConfirmed = statusOf(withPending);

  // The instalment the gate quotes as "expected": the missed one while
  // something is overdue, otherwise the next one coming.
  const expectedInstalment = now.outstandingDue > 0 ? now.missedAmount : now.nextAmount;

  const ageMs = dataAsOf === undefined ? null : dataAsOf === null ? Infinity : asOf.getTime() - time(dataAsOf);
  const stale = ageMs !== null && ageMs > staleAfterHours * 3_600_000;

  return {
    status,
    asOf,
    arrangement: onAgreement ? "agreement" : "standard",
    // A plan that exists but does not govern, so the gate can say why.
    agreementState: plan
      ? (onAgreement ? "in_force"
        : plan.approvalStatus === "pending" ? "pending_approval"
        : plan.approvalStatus === "rejected" ? "rejected"
        : plan.status !== "active" ? plan.status
        : "outside_dates")
      : null,

    totalFees,
    agreedTotal:        onAgreement ? (plan.agreedTotal ?? now.total) : null,
    expectedInstalment,
    amountDue:          baseline + now.dueByNow,      // due by today, in the year's terms
    totalPaid:          verifiedPaid,
    outstandingDue:     now.outstandingDue,
    remainingBalance,
    nextDueDate:        now.nextDue,
    nextDueAmount:      now.nextAmount,
    overdueSince:       now.outstandingDue > 0 ? now.missedSince : null,
    lastPaymentDate,
    schedule:           now.lines,

    authorization: authorization ? {
      _id: authorization._id ?? null,
      validUntil: authorization.validUntil,
      reason: authorization.reason ?? null,
      grantedBy: authorization.grantedBy ?? null,
    } : null,

    pending: {
      count: pendingCount,
      amount: pendingPaid,
      statusIfConfirmed: statusIfPendingConfirmed,
    },
    rejected: { count: rejectedCount, amount: rejectedPaid },
    /** The answer would differ once pending payments are confirmed. */
    dependsOnPending: pendingCount > 0 && statusIfPendingConfirmed !== status,

    dataAsOf: dataAsOf === undefined ? null : dataAsOf ? new Date(dataAsOf) : null,
    stale,
  };
}

export {
  compliance, standardSchedule, authorizationApplies, isPlanApplicable,
  STATUS, DUE_SOON_DAYS, STALE_AFTER_HOURS,
};
