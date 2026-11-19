// backend/scripts/check-compliance.js
"use strict";

/**
 * Fee compliance at the gate — shared/compliance.js, the one rule every app
 * runs (server, desktop window, web, phone).
 *
 *   compliant ⇔ verified payments ≥ the amount due BY TODAY
 *
 * Proves, with no database:
 *   - the owner's worked examples (200,000 total; 100,000 due; 75,000 paid
 *     → 25,000 outstanding due, 125,000 remaining, non-compliant)
 *   - an APPROVED individual agreement replaces the general schedule;
 *     pending / rejected / cancelled / expired / not-yet-in-force ones never do
 *   - partial payments, overdue, due-soon, paid ahead, reversals
 *   - pending offline payments are never counted, and say when they would
 *     change the answer; rejected ones are never counted
 *   - gate authorizations (Authorized) — in force, expired, revoked
 *   - stale data is flagged
 *   - the engine's own plan rule is shared/arrears.js isPlanApplicable, case
 *     for case (the engine is an ES module and cannot import it)
 *   - with no agreement, outstandingDue is exactly arrears' overdue figure
 *
 *   node scripts/check-compliance.js
 */

const {
  compliance, STATUS, isPlanApplicable: engineApplies, standardSchedule,
} = require("../../shared/compliance.js");
const arrears = require("../../shared/arrears");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const d = (s) => new Date(s);
const asOf = d("2026-11-19T10:00:00Z");

// The general structure: three terms, 75,000 + 75,000 + 50,000 = 200,000.
const general = [
  { amount: 75000, dueDate: d("2026-09-10") },
  { amount: 75000, dueDate: d("2027-01-10") },
  { amount: 50000, dueDate: d("2027-04-10") },
];
// An individual agreement over the same 200,000: 50,000 + 50,000 + 100,000.
const agreement = (over = {}) => ({
  status: "active", approvalStatus: "approved", basis: "total", baselinePaid: 0, agreedTotal: 200000,
  instalments: [
    { seq: 1, amount: 50000,  dueDate: d("2026-09-10") },
    { seq: 2, amount: 50000,  dueDate: d("2026-11-10") },
    { seq: 3, amount: 100000, dueDate: d("2027-03-10") },
  ],
  ...over,
});
const paid = (...amounts) => amounts.map((a, i) => ({ amount: a, receivedAt: d(`2026-09-0${i + 1}`) }));
const pick = (r) => [r.status, r.amountDue, r.totalPaid, r.outstandingDue, r.remainingBalance];

console.log("--- the worked example ---");
let r = compliance({ charges: general, payments: paid(75000), plan: agreement(), asOf });
check("agreement: 100,000 due, 75,000 paid → 25,000 outstanding, 125,000 remaining, non-compliant",
  pick(r), [STATUS.NON_COMPLIANT, 100000, 75000, 25000, 125000]);
check("  the arrangement is the agreement", [r.arrangement, r.agreementState, r.agreedTotal], ["agreement", "in_force", 200000]);
check("  overdue since the instalment that was missed", r.overdueSince?.toISOString().slice(0, 10), "2026-11-10");
check("  expected instalment is the one missed", r.expectedInstalment, 50000);
check("  next due date is the third instalment", [r.nextDueDate?.toISOString().slice(0, 10), r.nextDueAmount], ["2027-03-10", 100000]);
check("  never the full fee as the amount due", r.amountDue < r.totalFees, true);

console.log("\n--- current paid, future unpaid ---");
r = compliance({ charges: general, payments: paid(75000), asOf });
check("standard: first term paid, the rest not yet due → compliant",
  pick(r), [STATUS.COMPLIANT, 75000, 75000, 0, 125000]);
check("  last payment date is reported", r.lastPaymentDate?.toISOString().slice(0, 10), "2026-09-01");
r = compliance({ charges: general, payments: paid(50000, 50000), plan: agreement(), asOf });
check("agreement: both instalments due so far paid → compliant", pick(r), [STATUS.COMPLIANT, 100000, 100000, 0, 100000]);

console.log("\n--- the agreement only overrides when approved and in force ---");
const same = (label, plan) => {
  const x = compliance({ charges: general, payments: paid(75000), plan, asOf });
  check(label, [x.status, x.arrangement, x.amountDue], [STATUS.COMPLIANT, "standard", 75000]);
  return x;
};
check("  pending reports why", same("pending agreement → general schedule", agreement({ approvalStatus: "pending" })).agreementState, "pending_approval");
same("rejected agreement → general schedule", agreement({ approvalStatus: "rejected", status: "cancelled" }));
same("cancelled agreement → general schedule", agreement({ status: "cancelled" }));
check("  expired reports why", same("expired agreement → general schedule", agreement({ expiresAt: d("2026-11-01") })).agreementState, "outside_dates");
same("agreement not yet in force → general schedule", agreement({ effectiveFrom: d("2026-12-01") }));
r = compliance({ charges: general, payments: paid(75000), plan: agreement({ approvalStatus: null }), asOf });
check("a plan from before approvals (no approvalStatus) still governs", [r.arrangement, r.status], ["agreement", STATUS.NON_COMPLIANT]);
r = compliance({ charges: general, payments: paid(75000), plan: agreement({ expiresAt: d("2026-11-19") }), asOf });
check("an agreement expiring TODAY is still in force today", r.arrangement, "agreement");

console.log("\n--- a 'balance' agreement sets aside what was paid before it ---");
// 60,000 paid, then 140,000 rescheduled as 70,000 + 70,000.
const balancePlan = agreement({
  basis: "balance", baselinePaid: 60000, agreedTotal: 140000,
  instalments: [{ seq: 1, amount: 70000, dueDate: d("2026-11-01") }, { seq: 2, amount: 70000, dueDate: d("2027-02-01") }],
});
r = compliance({ charges: general, payments: paid(60000), plan: balancePlan, asOf });
check("paid nothing since the agreement → the first 70,000 is outstanding",
  [r.status, r.outstandingDue, r.amountDue, r.remainingBalance], [STATUS.NON_COMPLIANT, 70000, 130000, 140000]);
r = compliance({ charges: general, payments: paid(60000, 70000), plan: balancePlan, asOf });
check("then paid it → compliant", [r.status, r.outstandingDue], [STATUS.COMPLIANT, 0]);
check("arrears.planStatus agrees (the same baseline)", arrears.planStatus(balancePlan, 60000, asOf).behindBy, 70000);

console.log("\n--- partial, overdue, due soon, paid ahead, reversals ---");
r = compliance({ charges: general, payments: paid(40000), asOf });
check("partial payment of a passed instalment → non-compliant for the rest", [r.status, r.outstandingDue], [STATUS.NON_COMPLIANT, 35000]);
r = compliance({ charges: general, payments: paid(75000), asOf: d("2026-12-30T10:00:00Z") });
check("12 days before the next date, nothing missed → due", [r.status, r.outstandingDue], [STATUS.DUE, 0]);
r = compliance({ charges: general, payments: paid(150000), asOf: d("2026-12-30T10:00:00Z") });
check("paid ahead of the coming date → compliant, next date skips what is covered", [r.status, r.nextDueDate?.toISOString().slice(0, 10)], [STATUS.COMPLIANT, "2027-04-10"]);
r = compliance({ charges: general, payments: [{ amount: 75000 }, { amount: -75000 }], asOf });
check("a reversal cancels the payment it reverses", [r.status, r.totalPaid], [STATUS.NON_COMPLIANT, 0]);
r = compliance({ charges: [{ amount: 20000 }], payments: [], asOf });
check("an undated charge is due at once", [r.status, r.amountDue], [STATUS.NON_COMPLIANT, 20000]);
r = compliance({ charges: [{ amount: 75000, waivedAmount: 75000, dueDate: d("2026-09-10") }, general[1]], payments: [], asOf });
check("a waived charge is not owed", [r.status, r.totalFees], [STATUS.COMPLIANT, 75000]);
r = compliance({ charges: [{ ...general[0], voidedAt: d("2026-10-01") }], payments: [], asOf });
check("a voided charge is not owed", [r.status, r.totalFees], [STATUS.COMPLIANT, 0]);
check("charges on the same day are one instalment",
  standardSchedule([{ amount: 50000, dueDate: d("2026-09-10") }, { amount: 25000, dueDate: d("2026-09-10") }], asOf).map((i) => i.amount), [75000]);

console.log("\n--- pending and rejected payments are never counted ---");
r = compliance({ charges: general, payments: [{ amount: 50000 }, { amount: 25000, state: "pending" }], asOf });
check("50,000 confirmed + 25,000 pending → non-compliant on confirmed money",
  [r.status, r.totalPaid, r.outstandingDue], [STATUS.NON_COMPLIANT, 50000, 25000]);
check("  the pending money is reported, with what it would change",
  [r.pending.count, r.pending.amount, r.pending.statusIfConfirmed, r.dependsOnPending], [1, 25000, STATUS.COMPLIANT, true]);
r = compliance({ charges: general, payments: [{ amount: 10000 }, { amount: 5000, state: "pending" }], asOf });
check("pending money that would not change the answer → dependsOnPending false",
  [r.status, r.pending.count, r.dependsOnPending], [STATUS.NON_COMPLIANT, 1, false]);
r = compliance({ charges: general, payments: [{ amount: 75000, state: "rejected" }], asOf });
check("a rejected payment never counts", [r.status, r.totalPaid, r.rejected.count, r.rejected.amount], [STATUS.NON_COMPLIANT, 0, 1, 75000]);

console.log("\n--- gate authorizations ---");
const pass1 = { _id: "a1", validFrom: d("2026-11-15"), validUntil: d("2026-11-20"), reason: "Scholarship processing" };
r = compliance({ charges: general, payments: [], authorizations: [pass1], asOf });
check("an authorization in force → authorized, whatever is owed", [r.status, r.outstandingDue, r.authorization?._id], [STATUS.AUTHORIZED, 75000, "a1"]);
check("expired → back to the money", compliance({ charges: general, payments: [], authorizations: [{ ...pass1, validUntil: d("2026-11-18") }], asOf }).status, STATUS.NON_COMPLIANT);
check("revoked → back to the money", compliance({ charges: general, payments: [], authorizations: [{ ...pass1, revokedAt: d("2026-11-18") }], asOf }).status, STATUS.NON_COMPLIANT);
check("not started → back to the money", compliance({ charges: general, payments: [], authorizations: [{ ...pass1, validFrom: d("2026-11-25"), validUntil: d("2026-11-30") }], asOf }).status, STATUS.NON_COMPLIANT);
check("no end date → never in force", compliance({ charges: general, payments: [], authorizations: [{ ...pass1, validUntil: null }], asOf }).status, STATUS.NON_COMPLIANT);

console.log("\n--- freshness ---");
check("live server data (no dataAsOf) is not stale", compliance({ charges: general, asOf }).stale, false);
check("synced 2 h ago → fresh", compliance({ charges: general, asOf, dataAsOf: d("2026-11-19T08:00:00Z") }).stale, false);
check("synced 2 days ago → stale", compliance({ charges: general, asOf, dataAsOf: d("2026-11-17T08:00:00Z") }).stale, true);
check("never synced → stale", compliance({ charges: general, asOf, dataAsOf: null }).stale, true);

console.log("\n--- the engine's plan rule IS shared/arrears.js isPlanApplicable ---");
const variants = [];
for (const status of ["active", "cancelled", "completed"])
  for (const approvalStatus of [undefined, null, "pending", "approved", "rejected"])
    for (const effectiveFrom of [null, d("2026-11-19"), d("2026-11-20"), d("2026-01-01")])
      for (const expiresAt of [null, d("2026-11-18"), d("2026-11-19"), d("2027-01-01")])
        for (const deletedAt of [null, d("2026-10-01")])
          variants.push({ status, approvalStatus, effectiveFrom, expiresAt, deletedAt });
const disagree = variants.filter((p) => engineApplies(p, asOf) !== arrears.isPlanApplicable(p, asOf));
check(`${variants.length} plan shapes, the two rules agree on every one`, disagree.length, 0);
check("both refuse no plan", [engineApplies(null, asOf), arrears.isPlanApplicable(null, asOf)], [false, false]);

console.log("\n--- with no agreement, outstanding due IS arrears' overdue ---");
const cases = [0, 40000, 75000, 100000, 150000, 200000, 250000];
const mismatch = [];
for (const p of cases) for (const when of [d("2026-08-01"), asOf, d("2027-02-01"), d("2027-06-01")]) {
  const c = compliance({ charges: general, payments: [{ amount: p }], asOf: when });
  const f = arrears.feePosition({ charges: general, paid: p, asOf: when });
  if (c.outstandingDue !== f.overdue) mismatch.push({ p, when, c: c.outstandingDue, f: f.overdue });
}
check("28 payment/date pairs give the same figure", mismatch, []);
const pf = arrears.feePosition({ charges: general, paid: 75000, plan: agreement(), asOf });
check("and with the agreement, arrears' overdue is the engine's outstanding due", pf.overdue, 25000);
check("a pending agreement is ignored by arrears too", arrears.feePosition({ charges: general, paid: 75000, plan: agreement({ approvalStatus: "pending" }), asOf }).overdue, 0);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
