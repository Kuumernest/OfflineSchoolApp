// backend/src/services/financeReports.service.js
"use strict";

const FeeCharge     = require("../db/models/FeeCharge");
const FeePayment    = require("../db/models/FeePayment");
const Expense       = require("../db/models/Expense");
const SalaryPayment = require("../db/models/SalaryPayment");

/**
 * What the school took in and what it paid out, over a period.
 *
 * Every figure here is derived on read. Nothing is stored and nothing is
 * cached, for the same reason the fee balance never was: a stored total is a
 * second source of truth that drifts from the ledger the moment anything is
 * reversed, and money is the last place to accept drift.
 *
 * Three rules decide what counts, and each one has already caught a wrong
 * answer:
 *
 *   1. Fee payments net themselves. A reversal is stored as a negative row, so
 *      a plain $sum is already net of corrections — filtering reversals out
 *      would count the original twice over.
 *
 *   2. Voided expenses are excluded but not deleted. They stay in the ledger
 *      listing and out of every total.
 *
 *   3. Payroll must be summed with `status: { $ne: "draft" }` — NOT
 *      `status: "paid"`. Reversing a run flips each original row to "reversed"
 *      and appends a mirror row that is itself "paid" and negative. Summing
 *      only "paid" therefore keeps the mirror and drops the original, and a
 *      reversed month reports as a large NEGATIVE expenditure. Excluding
 *      drafts instead keeps both halves, which cancel to zero as they should.
 */

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sum = async (Model, match, field) => {
  const [row] = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: `$${field}` }, count: { $sum: 1 } } },
  ]);
  return { total: row?.total ?? 0, count: row?.count ?? 0 };
};

const between = (from, to) => {
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to)   range.$lte = new Date(to);
  return Object.keys(range).length ? range : null;
};

/** "2026-03" from a Date, in UTC — the same key payroll periods already use. */
const monthKey = { $dateToString: { format: "%Y-%m", date: "$__d", timezone: "UTC" } };

// ─────────────────────────────────────────────────────────────────────────────
// THE REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.schoolId
 * @param {string} [opts.from]  ISO date, inclusive
 * @param {string} [opts.to]    ISO date, inclusive
 */
const summary = async ({ schoolId, from, to }) => {
  const range = between(from, to);

  const feeMatch = { schoolId, deletedAt: null };
  if (range) feeMatch.receivedAt = range;

  const expMatch = { schoolId, deletedAt: null, voidedAt: null };
  if (range) expMatch.incurredAt = range;

  // See rule 3 above. This filter is load-bearing.
  const payMatch = { schoolId, deletedAt: null, status: { $ne: "draft" } };
  if (range) payMatch.paidAt = range;

  const [fees, expenses, payroll] = await Promise.all([
    sum(FeePayment, feeMatch, "amount"),
    sum(Expense, expMatch, "amount"),
    sum(SalaryPayment, payMatch, "net"),
  ]);

  // ── Expenditure split by category ─────────────────────────────────────────
  const byCategory = await Expense.aggregate([
    { $match: expMatch },
    { $group: { _id: "$categoryId", total: { $sum: "$amount" }, count: { $sum: 1 } } },
    { $lookup: {
        from: "expensecategories",
        localField: "_id",
        foreignField: "_id",
        as: "category",
    } },
    { $project: {
        _id: 0,
        categoryId: "$_id",
        total: 1,
        count: 1,
        label: { $ifNull: [{ $first: "$category.label" }, "—"] },
    } },
    { $sort: { total: -1 } },
  ]);

  // ── Month-by-month, so a trend is visible rather than a single figure ─────
  const monthlySeries = async (Model, match, dateField, valueField) => {
    const rows = await Model.aggregate([
      { $match: match },
      { $addFields: { __d: `$${dateField}` } },
      { $group: { _id: monthKey, total: { $sum: `$${valueField}` } } },
      { $sort: { _id: 1 } },
    ]);
    return new Map(rows.map((r) => [r._id, r.total]));
  };

  const [feeMonths, expMonths, payMonths] = await Promise.all([
    monthlySeries(FeePayment, feeMatch, "receivedAt", "amount"),
    monthlySeries(Expense, expMatch, "incurredAt", "amount"),
    monthlySeries(SalaryPayment, payMatch, "paidAt", "net"),
  ]);

  const months = [...new Set([...feeMonths.keys(), ...expMonths.keys(), ...payMonths.keys()])]
    .sort()
    .map((month) => {
      const income = feeMonths.get(month) ?? 0;
      const out    = (expMonths.get(month) ?? 0) + (payMonths.get(month) ?? 0);
      return { month, income, expenditure: out, net: income - out };
    });

  const expenditureTotal = expenses.total + payroll.total;

  return {
    period: { from: from ?? null, to: to ?? null },
    income: {
      fees:  fees.total,
      count: fees.count,
      total: fees.total,
    },
    expenditure: {
      expenses: expenses.total,
      payroll:  payroll.total,
      total:    expenditureTotal,
    },
    net: fees.total - expenditureTotal,
    byCategory,
    months,
  };
};

/**
 * What is still owed, school-wide.
 *
 * Deliberately NOT bounded by the report period. Arrears are a position at a
 * moment, not a flow over an interval — a debt raised in October is still owed
 * in March, and clipping it to the period would report it as settled.
 */
const arrears = async ({ schoolId, academicYear }) => {
  const match = { schoolId, deletedAt: null };
  if (academicYear) match.academicYear = academicYear;

  const [charged, payments] = await Promise.all([
    (async () => {
      const [row] = await FeeCharge.aggregate([
        { $match: { ...match, voidedAt: null } },
        { $group: {
            _id: null,
            charged: { $sum: "$amount" },
            waived:  { $sum: "$waivedAmount" },
        } },
      ]);
      return { charged: row?.charged ?? 0, waived: row?.waived ?? 0 };
    })(),
    sum(FeePayment, match, "amount"),
  ]);

  const billed = charged.charged - charged.waived;

  return {
    academicYear: academicYear ?? null,
    charged: charged.charged,
    waived:  charged.waived,
    billed,
    paid:    payments.total,
    // Negative would mean the school holds more than it billed — possible after
    // an overpayment, so it is reported rather than clamped to zero.
    outstanding: billed - payments.total,
    collectionRate: billed > 0 ? Math.round((payments.total / billed) * 100) : null,
  };
};

module.exports = { summary, arrears };
