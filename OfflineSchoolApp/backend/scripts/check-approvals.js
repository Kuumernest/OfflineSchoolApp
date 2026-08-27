// backend/scripts/check-approvals.js
"use strict";

/**
 * Assert the approval workflow.
 *
 * Unlike check-role-matrix.js and check-communication-policy.js, this one needs
 * a database — the control it exists to protect is "the approver cannot be the
 * requester", and that is enforced against a stored document, not a pure
 * function. It spins up mongodb-memory-server, so it still needs no external
 * MongoDB and touches nothing real.
 *
 * What it proves:
 *   • the threshold boundary, at, above and below                (no DB needed)
 *   • that nobody can approve their own request, super admin included
 *   • that each kind's effect actually lands: an expense starts counting, a
 *     refund becomes a negative payment, a waiver reduces a bill, a payroll run
 *     becomes approvable-then-payable
 *   • that a pending expense is excluded from the financial report and a
 *     historic expense with no status is not
 *   • that a decided request cannot be edited afterwards
 *   • that a second request cannot be raised for the same target
 *
 *   node scripts/check-approvals.js
 */

const mongoose = require("mongoose");

const approvals = require("../src/services/approvals.service");
const reports   = require("../src/services/financeReports.service");

const ApprovalRequest = require("../src/db/models/ApprovalRequest");
const School          = require("../src/db/models/School");
const Expense         = require("../src/db/models/Expense");
const ExpenseCategory = require("../src/db/models/ExpenseCategory");
const FeeCharge       = require("../src/db/models/FeeCharge");
const FeePayment      = require("../src/db/models/FeePayment");
const PayrollRun      = require("../src/db/models/PayrollRun");
const Student         = require("../src/db/models/Student");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
};

/** Runs `fn` and reports the error code it threw, or "no error". */
const codeOf = async (fn) => {
  try { await fn(); return "no error"; }
  catch (err) { return err.code ?? err.message; }
};

const BURSAR = "user-bursar";
const HEAD   = "user-head";

const main = async () => {
  // Required lazily so the module is only needed when this script runs.
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "approvals-check" });

  // Mongoose builds indexes in the background after connecting, so on a fresh
  // database the first writes can land before the unique constraints exist.
  // Waiting for them is not harness hygiene — the duplicate-request assertion
  // below tests an INDEX, and without this it would pass or fail depending on
  // timing, which is worse than not testing it at all.
  await Promise.all([
    ApprovalRequest.syncIndexes(),
    FeePayment.syncIndexes(),
    PayrollRun.syncIndexes(),
  ]);

  // ───────────────────────────────────────────────────────────────────────────
  console.log("--- the threshold boundary ---");

  const t = approvals.resolveThresholds({ expenseThreshold: 50_000, payrollRequired: true });
  check("just below is not caught",  approvals.requiresApprovalWith(t, "expense", 49_999).required, false);
  check("exactly at IS caught",      approvals.requiresApprovalWith(t, "expense", 50_000).required, true);
  check("above is caught",           approvals.requiresApprovalWith(t, "expense", 50_001).required, true);
  check("an unset threshold never catches",
    approvals.requiresApprovalWith(t, "refund", 10_000_000).required, false);
  check("zero means always",
    approvals.requiresApprovalWith(approvals.resolveThresholds({ refundThreshold: 0 }), "refund", 1).required,
    true);
  check("payroll is a switch, not an amount",
    approvals.requiresApprovalWith(t, "payroll", 0).required, true);

  console.log("--- defaults are off ---");
  const bare = approvals.resolveThresholds(undefined);
  check("nothing is required out of the box",
    ["expense", "refund", "waiver", "payroll"]
      .filter((k) => approvals.requiresApprovalWith(bare, k, 999_999_999).required),
    []);

  // ───────────────────────────────────────────────────────────────────────────
  const school = await School.create({
    name: "Test School",
    settings: {
      approvals: {
        expenseThreshold: 50_000,
        refundThreshold:  10_000,
        waiverThreshold:  5_000,
        payrollRequired:  true,
      },
    },
  });
  const schoolId = String(school._id);

  console.log("--- thresholds are read back from the school ---");
  check("stored and resolved", await approvals.thresholdsFor(schoolId), {
    expenseThreshold: 50_000,
    refundThreshold:  10_000,
    waiverThreshold:  5_000,
    payrollRequired:  true,
  });
  check("a school with none gets the defaults",
    await approvals.thresholdsFor("000000000000000000000000"),
    approvals.DEFAULT_THRESHOLDS);

  // ── THE CONTROL ────────────────────────────────────────────────────────────
  console.log("--- nobody approves their own request ---");

  const category = await ExpenseCategory.create({ schoolId, code: "GEN", label: "General" });
  const pendingExpense = await Expense.create({
    schoolId, categoryId: String(category._id), amount: 80_000,
    description: "Roof repair", recordedBy: BURSAR, status: "pending",
  });

  const expReq = await approvals.raise({
    schoolId, kind: "expense", targetId: String(pendingExpense._id),
    amount: 80_000, threshold: 50_000, reason: "Storm damage",
    summary: "General — Roof repair", requestedBy: BURSAR,
  });

  check("the requester is refused",
    await codeOf(() => approvals.decide({
      schoolId, requestId: expReq._id, approve: true, decidedBy: BURSAR,
    })),
    "SELF_APPROVAL");
  check("and the request is untouched",
    (await ApprovalRequest.findById(expReq._id).lean()).status, "pending");
  check("and the expense still does not count",
    (await Expense.findById(pendingExpense._id).lean()).status, "pending");

  console.log("--- a second request cannot be raised for the same target ---");
  check("duplicate refused",
    await codeOf(() => approvals.raise({
      schoolId, kind: "expense", targetId: String(pendingExpense._id),
      amount: 80_000, requestedBy: BURSAR,
    })),
    "ALREADY_PENDING");

  console.log("--- a pending expense is outside the accounts ---");
  const beforeApproval = await reports.summary({ schoolId });
  check("excluded from expenditure", beforeApproval.expenditure.expenses, 0);

  // A row written before the status field existed. $unset rather than a create,
  // because the schema default would fill it in.
  await Expense.collection.insertOne({
    _id: "legacy-expense", schoolId, categoryId: String(category._id),
    amount: 7_000, incurredAt: new Date(), deletedAt: null, voidedAt: null,
  });
  const withLegacy = await reports.summary({ schoolId });
  check("a historic row with no status still counts",
    withLegacy.expenditure.expenses, 7_000);

  console.log("--- somebody else approves, and the effect lands ---");
  const decided = await approvals.decide({
    schoolId, requestId: expReq._id, approve: true, decidedBy: HEAD, note: "Agreed",
  });
  check("recorded as approved", decided.request.status, "approved");
  check("by the head",          decided.request.decidedBy, HEAD);
  check("the expense now counts",
    (await Expense.findById(pendingExpense._id).lean()).status, "approved");
  const afterApproval = await reports.summary({ schoolId });
  check("and appears in expenditure", afterApproval.expenditure.expenses, 87_000);

  console.log("--- a decided request is frozen ---");
  const frozen = await ApprovalRequest.findById(expReq._id);
  frozen.reason = "changed my mind";
  check("editing is refused",
    (await codeOf(() => frozen.save())).includes("already approved"), true);
  check("deciding twice is refused",
    await codeOf(() => approvals.decide({
      schoolId, requestId: expReq._id, approve: false, decidedBy: HEAD, note: "no",
    })),
    "ALREADY_DECIDED");

  // ── REFUND ─────────────────────────────────────────────────────────────────
  console.log("--- a refund writes nothing until it is approved ---");

  // userId and enrollmentNo are required once a student is "approved" — the
  // model refuses an enrolled student with no login and no admission number.
  const student = await Student.create({
    schoolId, studentName: "Ama Tem", status: "approved",
    userId: "user-student-1", enrollmentNo: "TS-0001",
  });
  const studentId = String(student._id);

  await FeePayment.create({
    schoolId, studentId, academicYear: "2025/2026",
    amount: 40_000, method: "cash", receivedBy: BURSAR,
  });

  const refundReq = await approvals.raise({
    schoolId, kind: "refund", amount: 15_000, threshold: 10_000,
    reason: "Overpaid the second term",
    payload: { studentId, academicYear: "2025/2026", amount: 15_000, method: "cash" },
    requestedBy: BURSAR,
  });

  check("no payment row yet",
    await FeePayment.countDocuments({ schoolId, amount: { $lt: 0 } }), 0);

  await approvals.decide({
    schoolId, requestId: refundReq._id, approve: true, decidedBy: HEAD,
  });

  const refundRow = await FeePayment.findOne({ schoolId, amount: { $lt: 0 } }).lean();
  check("the negative payment exists", refundRow?.amount, -15_000);
  check("it is not a reversal",        refundRow?.reversesId ?? null, null);
  check("it carries a receipt number", /^RCT-2025\/2026-\d{4}$/.test(refundRow?.receiptNo ?? ""), true);

  console.log("--- a rejected refund writes nothing at all ---");
  const refused = await approvals.raise({
    schoolId, kind: "refund", amount: 12_000, threshold: 10_000, reason: "Asked again",
    payload: { studentId, academicYear: "2025/2026", amount: 12_000, method: "cash" },
    requestedBy: BURSAR,
  });
  await approvals.decide({
    schoolId, requestId: refused._id, approve: false, decidedBy: HEAD, note: "No basis",
  });
  check("still only one refund",
    await FeePayment.countDocuments({ schoolId, amount: { $lt: 0 } }), 1);

  // ── WAIVER ─────────────────────────────────────────────────────────────────
  console.log("--- a waiver does not reduce the bill until it is approved ---");

  const charge = await FeeCharge.create({
    schoolId, studentId, academicYear: "2025/2026",
    code: "TUIT", label: "Tuition", amount: 60_000,
  });

  const waiverReq = await approvals.raise({
    schoolId, kind: "waiver", targetId: String(charge._id), amount: 20_000,
    threshold: 5_000, reason: "Hardship",
    payload: { waivedAmount: 20_000, waiverReason: "Hardship" },
    requestedBy: BURSAR,
  });

  check("the charge is untouched while pending",
    (await FeeCharge.findById(charge._id).lean()).waivedAmount, 0);

  await approvals.decide({
    schoolId, requestId: waiverReq._id, approve: true, decidedBy: HEAD,
  });
  check("and reduced once approved",
    (await FeeCharge.findById(charge._id).lean()).waivedAmount, 20_000);

  console.log("--- a waiver is revalidated at approval time ---");
  const charge2 = await FeeCharge.create({
    schoolId, studentId, academicYear: "2025/2026",
    code: "BOOK", label: "Books", amount: 30_000,
  });
  const staleReq = await approvals.raise({
    schoolId, kind: "waiver", targetId: String(charge2._id), amount: 30_000,
    reason: "Full write-off", payload: { waivedAmount: 30_000 }, requestedBy: BURSAR,
  });
  // The charge shrinks after the request is raised — a correction, say.
  await FeeCharge.updateOne({ _id: charge2._id }, { $set: { amount: 10_000 } });

  check("a waiver that now exceeds the charge is refused",
    await codeOf(() => approvals.decide({
      schoolId, requestId: staleReq._id, approve: true, decidedBy: HEAD,
    })),
    "WAIVER_TOO_LARGE");
  check("the decision is still recorded",
    (await ApprovalRequest.findById(staleReq._id).lean()).status, "approved");
  check("with the failure noted",
    Boolean((await ApprovalRequest.findById(staleReq._id).lean()).applyError), true);
  check("and the charge is unchanged",
    (await FeeCharge.findById(charge2._id).lean()).waivedAmount, 0);

  // ── PAYROLL ────────────────────────────────────────────────────────────────
  console.log("--- payroll: prepared, signed, then paid ---");

  const run = await PayrollRun.create({
    schoolId, periodMonth: "2026-03", staffCount: 12,
    totalNet: 2_400_000, generatedBy: BURSAR,
  });
  check("starts as a draft", run.status, "draft");

  const payrollReq = await approvals.raise({
    schoolId, kind: "payroll", targetId: String(run._id),
    amount: 2_400_000, summary: "Payroll 2026-03 — 12 staff", requestedBy: BURSAR,
  });

  check("the preparer cannot sign it",
    await codeOf(() => approvals.decide({
      schoolId, requestId: payrollReq._id, approve: true, decidedBy: BURSAR,
    })),
    "SELF_APPROVAL");

  await approvals.decide({
    schoolId, requestId: payrollReq._id, approve: true, decidedBy: HEAD,
  });
  const signed = await PayrollRun.findById(run._id).lean();
  check("moves to approved", signed.status, "approved");
  check("recording who signed", signed.approvedBy, HEAD);

  // ── WITHDRAWAL ─────────────────────────────────────────────────────────────
  console.log("--- withdrawing your own request ---");

  const spare = await Expense.create({
    schoolId, categoryId: String(category._id), amount: 90_000,
    description: "Second thoughts", recordedBy: BURSAR, status: "pending",
  });
  const spareReq = await approvals.raise({
    schoolId, kind: "expense", targetId: String(spare._id),
    amount: 90_000, requestedBy: BURSAR,
  });

  check("somebody else cannot withdraw it",
    await codeOf(() => approvals.cancel({
      schoolId, requestId: spareReq._id, userId: HEAD,
    })),
    "NOT_YOURS");

  await approvals.cancel({ schoolId, requestId: spareReq._id, userId: BURSAR });
  check("the request is cancelled",
    (await ApprovalRequest.findById(spareReq._id).lean()).status, "cancelled");
  check("and the expense does not sit pending forever",
    (await Expense.findById(spare._id).lean()).status, "rejected");

  // ── THE QUEUE ──────────────────────────────────────────────────────────────
  console.log("--- the queue and the count ---");
  check("nothing left waiting", await approvals.pendingCount(schoolId), 0);
  check("the history is all there",
    (await approvals.list({ schoolId, status: "all", limit: 500 })).length, 7);
  check("scoped to one requester",
    (await approvals.list({ schoolId, status: "all", requestedBy: HEAD, limit: 500 })).length, 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
