// backend/src/services/payroll.service.js
"use strict";

const Counter         = require("../db/models/Counter");
const SalaryStructure = require("../db/models/SalaryStructure");
const SalaryPayment   = require("../db/models/SalaryPayment");
const PayrollRun      = require("../db/models/PayrollRun");

/**
 * Payroll arithmetic, in one place — the same reason fees.service exists.
 *
 * The rule this module enforces: generating payroll produces DRAFTS. Nothing
 * here writes a payment. Confirming a run is a separate, deliberate act.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PERIODS
// ─────────────────────────────────────────────────────────────────────────────

/** Last instant of the month, which is when a monthly salary is considered due. */
const endOfMonth = (periodMonth) => {
  const [y, m] = periodMonth.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
};

// ─────────────────────────────────────────────────────────────────────────────
// PAYSLIP NUMBERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gapless payslip number, e.g. "PSL-2026-08-0007".
 *
 * Assigned only on confirmation. A draft has no number because a draft is not
 * a payslip — numbering one that is later discarded leaves a hole an auditor
 * will ask about.
 */
const nextPayslipNo = async (schoolId, periodMonth) => {
  const counter = await Counter.findOneAndUpdate(
    { _id: `payslipNo:${schoolId}:${periodMonth}` },
    { $inc: { seq: 1 }, $setOnInsert: { schoolId } },
    { upsert: true, new: true }
  );
  return `PSL-${periodMonth}-${String(counter.seq).padStart(4, "0")}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTING A PAYSLIP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a structure into the figures for one month.
 *
 * Pure — no database, no clock. That is what makes payroll testable and what
 * lets the same function serve both the preview and the saved snapshot.
 */
const computeFromStructure = (structure) => {
  const allowances = (structure.allowances ?? []).map((a) => ({
    code: a.code, label: a.label, amount: a.amount ?? 0,
  }));
  const deductions = (structure.deductions ?? []).map((d) => ({
    code: d.code, label: d.label, amount: d.amount ?? 0,
  }));

  const base            = structure.baseAmount ?? 0;
  const gross           = base + allowances.reduce((s, a) => s + a.amount, 0);
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);

  return {
    baseAmount: base,
    allowances,
    deductions,
    gross,
    totalDeductions,
    net: gross - totalDeductions,
  };
};

/**
 * The structure in force for a person at the end of a given month.
 *
 * "In force" means it had started and had not yet been closed. Asking by date
 * rather than taking the latest row is what makes a payslip for March still
 * reproduce March's figures after a June raise.
 */
const structuresInForce = async (schoolId, periodMonth) => {
  const asOf = endOfMonth(periodMonth);
  return SalaryStructure.find({
    schoolId,
    deletedAt:     null,
    effectiveFrom: { $lte: asOf },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
  }).lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a draft run for a month.
 *
 * Idempotent: the unique index on (schoolId, userId, periodMonth, runId) means
 * re-running against the same run cannot produce a second payslip for anyone.
 *
 * @returns {Promise<{run: object, payslips: object[]}>}
 */
const generateRun = async ({ schoolId, periodMonth, generatedBy }) => {
  const structures = await structuresInForce(schoolId, periodMonth);
  if (!structures.length) {
    const err = new Error("No salary structures are in force for that month");
    err.code = "NO_STRUCTURES";
    throw err;
  }

  const run = await PayrollRun.create({
    schoolId,
    periodMonth,
    status:      "draft",
    generatedBy: generatedBy ?? null,
    staffCount:  structures.length,
  });

  const rows = structures.map((s) => {
    const figures = computeFromStructure(s);
    return {
      schoolId,
      userId:      String(s.userId),
      runId:       String(run._id),
      periodMonth,
      structureId: String(s._id),
      ...figures,
      status:      "draft",
    };
  });

  const payslips = await SalaryPayment.insertMany(rows, { ordered: false });

  const totals = payslips.reduce(
    (acc, p) => ({
      gross:      acc.gross + (p.gross ?? 0),
      deductions: acc.deductions + (p.totalDeductions ?? 0),
      net:        acc.net + (p.net ?? 0),
    }),
    { gross: 0, deductions: 0, net: 0 }
  );

  const summary = {
    staffCount:      payslips.length,
    totalGross:      totals.gross,
    totalDeductions: totals.deductions,
    totalNet:        totals.net,
  };

  await PayrollRun.updateOne({ _id: run._id }, summary);

  // Spread the SAME keys the document uses. Spreading `totals` — whose keys are
  // gross/deductions/net — left totalGross/totalNet at their zero defaults, so
  // the response said the run was worth nothing while the payslips beneath it
  // were correct. The stored row was right; only what the caller saw was wrong,
  // which is the kind of mismatch nobody notices until a total is queried.
  return {
    run: { ...run.toObject(), ...summary },
    payslips,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a reviewed draft into payments.
 *
 * Payslip numbers are minted here, one per row, so the sequence contains only
 * payslips that were really issued.
 */
const confirmRun = async ({ schoolId, runId, method, confirmedBy }) => {
  const run = await PayrollRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Payroll run not found");
    err.status = 404;
    throw err;
  }
  if (run.status !== "draft") {
    const err = new Error(`This run is already ${run.status}`);
    err.code   = "NOT_DRAFT";
    err.status = 409;
    throw err;
  }

  const drafts = await SalaryPayment.find({
    schoolId, runId, status: "draft", deletedAt: null,
  });

  const now = new Date();
  for (const p of drafts) {
    p.payslipNo = await nextPayslipNo(schoolId, run.periodMonth);
    p.status    = "paid";
    p.method    = method ?? p.method;
    p.paidAt    = now;
    p.paidBy    = confirmedBy ?? null;
    await p.save();
  }

  run.status      = "confirmed";
  run.confirmedBy = confirmedBy ?? null;
  run.confirmedAt = now;
  await run.save();

  return { run, paid: drafts.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Undo a confirmed run by appending a mirror payslip for each row.
 *
 * The originals stay exactly as issued; the negatives cancel them in every sum.
 */
const reverseRun = async ({ schoolId, runId, reason, reversedBy }) => {
  const run = await PayrollRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Payroll run not found");
    err.status = 404;
    throw err;
  }
  if (run.status !== "confirmed") {
    const err = new Error("Only a confirmed run can be reversed");
    err.code   = "NOT_CONFIRMED";
    err.status = 409;
    throw err;
  }

  const paid = await SalaryPayment.find({
    schoolId, runId, status: "paid", reversesId: null, deletedAt: null,
  });

  const now = new Date();
  for (const original of paid) {
    const reversal = await SalaryPayment.create({
      schoolId,
      userId:          original.userId,
      // Deliberately not attached to the run: the run is being closed out, and
      // a reversal that shared its runId would trip the one-payslip-per-person
      // unique index.
      runId:           null,
      periodMonth:     original.periodMonth,
      structureId:     original.structureId,
      baseAmount:      -original.baseAmount,
      allowances:      original.allowances.map((a) => ({ ...a.toObject?.() ?? a, amount: -a.amount })),
      deductions:      original.deductions.map((d) => ({ ...d.toObject?.() ?? d, amount: -d.amount })),
      gross:           -original.gross,
      totalDeductions: -original.totalDeductions,
      net:             -original.net,
      status:          "paid",
      method:          original.method,
      payslipNo:       await nextPayslipNo(schoolId, original.periodMonth),
      paidAt:          now,
      paidBy:          reversedBy ?? null,
      reversesId:      String(original._id),
      reversalReason:  reason,
    });

    original.reversedById   = String(reversal._id);
    original.status         = "reversed";
    original.reversalReason = reason;
    await original.save();
  }

  run.status         = "reversed";
  run.reversedBy     = reversedBy ?? null;
  run.reversedAt     = now;
  run.reversalReason = reason;
  await run.save();

  return { run, reversed: paid.length };
};

module.exports = {
  endOfMonth,
  nextPayslipNo,
  computeFromStructure,
  structuresInForce,
  generateRun,
  confirmRun,
  reverseRun,
};
