// backend/src/routes/finance.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const { authorize } = require("../../middleware/auth");

const ExpenseCategory = require("../db/models/ExpenseCategory");
const Expense         = require("../db/models/Expense");
const SalaryStructure = require("../db/models/SalaryStructure");
const SalaryPayment   = require("../db/models/SalaryPayment");
const PayrollRun      = require("../db/models/PayrollRun");
const User            = require("../db/models/User");

const {
  generateRun,
  confirmRun,
  reverseRun,
} = require("../services/payroll.service");

const financeReports = require("../services/financeReports.service");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const bad = (res, message, code) =>
  res.status(400).json({ success: false, code: code ?? "BAD_REQUEST", message });

const asWholeAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
};

const cleanComponents = (list) => {
  if (!Array.isArray(list)) return { rows: [], error: null };
  const rows = [];
  for (const c of list) {
    if (!c?.code || !c?.label) return { rows: [], error: "Every component needs a code and a label" };
    const amount = asWholeAmount(c.amount);
    if (amount === null || amount < 0) {
      return { rows: [], error: `"${c.label}" must be a whole number of XAF` };
    }
    rows.push({
      code:    String(c.code).trim(),
      label:   String(c.label).trim(),
      labelFr: c.labelFr ? String(c.labelFr).trim() : null,
      amount,
    });
  }
  return { rows, error: null };
};

// Expenses and payroll are back-office work: server-authoritative, admin-only,
// and never queued from a phone.
router.use(authorize("admin", "school_admin", "super_admin"));

// ═════════════════════════════════════════════════════════════════════════════
// EXPENSE CATEGORIES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/expense-categories", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await ExpenseCategory.find({ schoolId, deletedAt: null })
    .sort({ label: 1 }).lean();
  return res.json({ success: true, count: rows.length, data: rows });
}));

router.post("/expense-categories", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { code, label, labelFr = null, parentId = null } = req.body;
  if (!code || !label) return bad(res, "code and label are required");

  try {
    const row = await ExpenseCategory.create({
      _id: req.body._id || uuidv4(),
      schoolId,
      code:  String(code).trim(),
      label: String(label).trim(),
      labelFr: labelFr ? String(labelFr).trim() : null,
      parentId,
      createdBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false, code: "CATEGORY_EXISTS",
        message: "A category with that code already exists",
      });
    }
    throw err;
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// EXPENSES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/finance/expenses?from=&to=&categoryId=
router.get("/expenses", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const filter = { schoolId, deletedAt: null };
  if (req.query.categoryId) filter.categoryId = req.query.categoryId;
  if (req.query.from || req.query.to) {
    filter.incurredAt = {};
    if (req.query.from) filter.incurredAt.$gte = new Date(req.query.from);
    if (req.query.to)   filter.incurredAt.$lte = new Date(req.query.to);
  }

  const rows = await Expense.find(filter).sort({ incurredAt: -1 }).limit(500).lean();
  // Voided rows are returned so the ledger reads honestly, but excluded from
  // the total — the same rule the fee ledger follows.
  const total = rows.filter((r) => !r.voidedAt).reduce((s, r) => s + r.amount, 0);

  return res.json({ success: true, count: rows.length, total, data: rows });
}));

router.post("/expenses", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const {
    categoryId, academicYear = null, description = null,
    vendor = null, method = "cash", reference = null, incurredAt,
  } = req.body;

  if (!categoryId) return bad(res, "categoryId is required");

  const amount = asWholeAmount(req.body.amount);
  if (amount === null || amount <= 0) {
    return bad(res, "amount must be a whole number of XAF greater than zero", "INVALID_AMOUNT");
  }

  const category = await ExpenseCategory.findOne({
    _id: categoryId, schoolId, deletedAt: null,
  }).lean();
  if (!category) {
    return res.status(404).json({
      success: false, code: "CATEGORY_NOT_FOUND",
      message: "No expense category with that id in this school",
    });
  }

  const expenseId = req.body._id || uuidv4();

  // A replay of the same offline row: answer with what is already stored rather
  // than a duplicate-key error, so the phone's outbox can mark the send done.
  // Without this, a create whose response was lost on a bad connection retries
  // forever against a row that is already there.
  const existing = await Expense.findOne({ _id: expenseId, schoolId }).lean();
  if (existing) {
    return res.status(200).json({ success: true, replay: true, data: existing });
  }

  const row = await Expense.create({
    _id: expenseId,
    schoolId, categoryId, academicYear,
    amount, description, vendor, method, reference,
    incurredAt: incurredAt ? new Date(incurredAt) : new Date(),
    recordedBy: req.user?._id ? String(req.user._id) : null,
  });

  return res.status(201).json({ success: true, data: row });
}));

// POST /api/finance/expenses/:id/void   { reason }
router.post("/expenses/:id/void", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const reason   = (req.body.reason || "").trim();
  if (!reason) return bad(res, "A reason is required to void an expense", "REASON_REQUIRED");

  const row = await Expense.findOne({ _id: req.params.id, schoolId });
  if (!row) return res.status(404).json({ success: false, message: "Expense not found" });
  // Already void is the end state the caller asked for, so this answers 200
  // rather than 409. The phone's outbox parks a bare 409 as a conflict for a
  // human to resolve, which would put a retried void — work that is in fact
  // done — in front of an admin as a problem to sort out.
  if (row.voidedAt) {
    return res.status(200).json({ success: true, replay: true, data: row });
  }

  row.voidedAt   = new Date();
  row.voidedBy   = req.user?._id ? String(req.user._id) : null;
  row.voidReason = reason;
  await row.save();

  return res.json({ success: true, data: row });
}));

// ═════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/finance/reports/summary?from=&to=&academicYear=
//
// Income against expenditure for a period, plus arrears as they stand now.
// The two are returned together because they answer the same question from
// opposite ends, but they are NOT the same kind of figure: the summary is a
// flow over an interval, arrears are a position at a moment. The response keeps
// them in separate objects so a caller cannot accidentally add them together.
router.get("/reports/summary", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { from, to, academicYear } = req.query;
  for (const [name, value] of [["from", from], ["to", to]]) {
    if (value && Number.isNaN(new Date(value).getTime())) {
      return bad(res, `${name} is not a valid date`);
    }
  }
  if (from && to && new Date(from) > new Date(to)) {
    return bad(res, "from must not be after to");
  }

  const [summary, arrears] = await Promise.all([
    financeReports.summary({ schoolId, from, to }),
    financeReports.arrears({ schoolId, academicYear }),
  ]);

  return res.json({ success: true, data: { summary, arrears } });
}));

// ═════════════════════════════════════════════════════════════════════════════
// STAFF
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Who can be put on payroll.
 *
 * /admin/teachers only returns role "teacher", which would leave the head and
 * the bursar off the payroll entirely — so payroll asks for its own list.
 */
router.get("/staff", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await User.find({
    schoolId,
    role:     { $in: ["school_admin", "teacher"] },
    isActive: true,
  }).select("name email role").sort({ name: 1 }).lean();

  return res.json({ success: true, count: rows.length, data: rows });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SALARY STRUCTURES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/salary-structures", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const filter = { schoolId, deletedAt: null };
  if (req.query.userId) filter.userId = req.query.userId;
  // By default only what is currently in force; ?history=1 for the full trail.
  if (req.query.history !== "1") filter.effectiveTo = null;

  const rows = await SalaryStructure.find(filter).sort({ effectiveFrom: -1 }).lean();

  const staff = await User.find({
    schoolId, _id: { $in: rows.map((r) => r.userId) },
  }).select("name email role").lean();
  const byId = new Map(staff.map((s) => [String(s._id), s]));

  return res.json({
    success: true,
    count:   rows.length,
    data:    rows.map((r) => ({
      ...r,
      gross: (r.baseAmount ?? 0) + (r.allowances ?? []).reduce((s, a) => s + a.amount, 0),
      staff: byId.get(String(r.userId)) ?? null,
    })),
  });
}));

router.post("/salary-structures", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { userId, effectiveFrom } = req.body;
  if (!userId)        return bad(res, "userId is required");
  if (!effectiveFrom) return bad(res, "effectiveFrom is required");

  const baseAmount = asWholeAmount(req.body.baseAmount);
  if (baseAmount === null || baseAmount < 0) {
    return bad(res, "baseAmount must be a whole number of XAF", "INVALID_AMOUNT");
  }

  const allow = cleanComponents(req.body.allowances);
  if (allow.error) return bad(res, allow.error, "INVALID_AMOUNT");
  const deduct = cleanComponents(req.body.deductions);
  if (deduct.error) return bad(res, deduct.error, "INVALID_AMOUNT");

  const staff = await User.findOne({ _id: userId, schoolId }).select("_id").lean();
  if (!staff) {
    return res.status(404).json({
      success: false, code: "STAFF_NOT_FOUND",
      message: "No staff member with that id in this school",
    });
  }

  const from = new Date(effectiveFrom);

  // A raise closes the previous row rather than overwriting it, so an old
  // payslip still reproduces the figures that were in force when it was issued.
  await SalaryStructure.updateMany(
    { schoolId, userId, effectiveTo: null, deletedAt: null },
    { effectiveTo: new Date(from.getTime() - 1) }
  );

  const row = await SalaryStructure.create({
    _id: req.body._id || uuidv4(),
    schoolId, userId,
    baseAmount,
    allowances:    allow.rows,
    deductions:    deduct.rows,
    effectiveFrom: from,
    createdBy:     req.user?._id ? String(req.user._id) : null,
  });

  return res.status(201).json({ success: true, data: row });
}));

// ═════════════════════════════════════════════════════════════════════════════
// PAYROLL
// ═════════════════════════════════════════════════════════════════════════════

router.get("/payroll", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await PayrollRun.find({ schoolId, deletedAt: null })
    .sort({ periodMonth: -1 }).lean();
  return res.json({ success: true, count: rows.length, data: rows });
}));

router.get("/payroll/:runId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const run = await PayrollRun.findOne({
    _id: req.params.runId, schoolId, deletedAt: null,
  }).lean();
  if (!run) return res.status(404).json({ success: false, message: "Run not found" });

  const payslips = await SalaryPayment.find({
    schoolId, runId: run._id, deletedAt: null,
  }).lean();

  const staff = await User.find({
    schoolId, _id: { $in: payslips.map((p) => p.userId) },
  }).select("name email role").lean();
  const byId = new Map(staff.map((s) => [String(s._id), s]));

  return res.json({
    success: true,
    data: {
      run,
      payslips: payslips.map((p) => ({ ...p, staff: byId.get(String(p.userId)) ?? null })),
    },
  });
}));

// POST /api/finance/payroll/generate   { periodMonth }
router.post("/payroll/generate", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { periodMonth } = req.body;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodMonth || ""))) {
    return bad(res, "periodMonth must look like 2026-08");
  }

  try {
    const result = await generateRun({
      schoolId, periodMonth,
      generatedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({
      success: true,
      ...result,
      message: `${result.payslips.length} draft payslip(s) generated. Review them before confirming.`,
    });
  } catch (err) {
    if (err.code === "NO_STRUCTURES") {
      return bad(res, err.message, err.code);
    }
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false, code: "RUN_EXISTS",
        message: "A payroll run already exists for that month. Reverse it before generating another.",
      });
    }
    throw err;
  }
}));

// POST /api/finance/payroll/:runId/confirm   { method }
router.post("/payroll/:runId/confirm", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const result = await confirmRun({
      schoolId,
      runId:       req.params.runId,
      method:      req.body.method,
      confirmedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    throw err;
  }
}));

// POST /api/finance/payroll/:runId/reverse   { reason }
router.post("/payroll/:runId/reverse", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const reason   = (req.body.reason || "").trim();
  if (!reason) return bad(res, "A reason is required to reverse a payroll run", "REASON_REQUIRED");

  try {
    const result = await reverseRun({
      schoolId,
      runId:      req.params.runId,
      reason,
      reversedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    throw err;
  }
}));

// ─────────────────────────────────────────────────────────────────────────────

router.use((err, req, res, _next) => {
  console.error("finance.routes error:", err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

module.exports = router;
