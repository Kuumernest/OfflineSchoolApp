// backend/src/routes/finance.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const {
  requirePermission,
  requireAnyPermission,
} = require("../../middleware/permissions");

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
  endOfMonth,
  hoursWorkedInMonth,
} = require("../services/payroll.service");

const financeReports = require("../services/financeReports.service");
const approvals      = require("../services/approvals.service");

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

// Expenses and payroll are back-office work: server-authoritative, never
// queued from a phone, and the bursar's job rather than the admin's.
//
// The router-level guard is the union, because this one router serves three
// modules; each route below then names the capability it actually needs. That
// is what lets a school hand somebody the expense book without the payroll.
router.use(requireAnyPermission(
  "expenses.view",
  "payroll.view",
  "finance.reports"
));

const canReadExpenses  = requirePermission("expenses.view");
const canWriteExpenses = requirePermission("expenses.manage");
const canReadPayroll   = requirePermission("payroll.view");
const canRunPayroll    = requirePermission("payroll.process");
const canReadReports   = requirePermission("finance.reports");

/**
 * What the bursar prepares but does not decide.
 *
 * Segregation of duties, at the one point in this router where it can be
 * enforced today: the bursar calculates the payroll and pays it, but what a
 * member of staff is owed is set by the school, not by the person writing the
 * cheque. Someone who can both raise their own salary and pay it has no
 * meaningful control over them at all.
 *
 * payroll.setSalary is marked non-delegable in config/permissions.js, so this
 * is not a default a school can quietly reverse on a busy afternoon.
 *
 * Expense and payroll APPROVAL want the same treatment and still cannot get it
 * from a guard of any kind — an expense has no approval state to gate on. That
 * is the next pass, not something to fake here.
 */
const canSetSalary = requirePermission("payroll.setSalary");

// ═════════════════════════════════════════════════════════════════════════════
// EXPENSE CATEGORIES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/expense-categories", canReadExpenses, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await ExpenseCategory.find({ schoolId, deletedAt: null })
    .sort({ label: 1 }).lean();
  return res.json({ success: true, count: rows.length, data: rows });
}));

router.post("/expense-categories", canWriteExpenses, asyncHandler(async (req, res) => {
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
router.get("/expenses", canReadExpenses, asyncHandler(async (req, res) => {
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

router.post("/expenses", canWriteExpenses, asyncHandler(async (req, res) => {
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

  // ── Does this need a second signature? ─────────────────────────────────
  //
  // The row is written either way, with its category, its reference and its
  // receipt — the money has already left, and asking a bursar to hold a paper
  // receipt until the head is next in the building is not a workflow. What
  // approval gates is whether it COUNTS: a pending expense is excluded from
  // every total until somebody signs it off.
  //
  // With no threshold set — the shipped default — this is false and the row is
  // written approved, exactly as before.
  const { required, threshold } = await approvals.requiresApproval({
    schoolId, kind: "expense", amount,
  });

  const row = await Expense.create({
    _id: expenseId,
    schoolId, categoryId, academicYear,
    amount, description, vendor, method, reference,
    incurredAt: incurredAt ? new Date(incurredAt) : new Date(),
    recordedBy: req.user?._id ? String(req.user._id) : null,
    status: required ? "pending" : "approved",
  });

  let approval = null;
  if (required) {
    try {
      approval = await approvals.raise({
        schoolId,
        kind:        "expense",
        targetId:    row._id,
        amount,
        threshold,
        reason:      req.body.reason ?? null,
        summary:     [category.label, vendor, description]
                       .filter(Boolean).join(" — ") || "Expense",
        requestedBy: req.user?._id ? String(req.user._id) : null,
      });
      row.approvalId = approval._id;
      await row.save();
    } catch (err) {
      // The expense exists and is pending, and raising the request failed. Left
      // pending rather than quietly promoted to approved: a row that nobody can
      // see waiting is better than one that slipped into the accounts without
      // the signature the school asked for. The message says what to do.
      console.error(`[finance] expense ${row._id} pending with no request: ${err.message}`);
      return res.status(201).json({
        success: true,
        data:    row,
        warning: "The expense was recorded but the approval request could not be " +
                 "raised. It will not count until that is resolved.",
      });
    }
  }

  return res.status(201).json({
    success:  true,
    data:     row,
    approval: approval,
    /** So the client can say "recorded, waiting for approval" rather than "saved". */
    pendingApproval: required,
  });
}));

// POST /api/finance/expenses/:id/void   { reason }
router.post("/expenses/:id/void", canWriteExpenses, asyncHandler(async (req, res) => {
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
router.get("/reports/summary", canReadReports, asyncHandler(async (req, res) => {
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
router.get("/staff", canReadPayroll, asyncHandler(async (req, res) => {
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

router.get("/salary-structures", canReadPayroll, asyncHandler(async (req, res) => {
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

// adminOnly: what a member of staff is owed is the school's decision. The
// bursar reads the structure, calculates against it, and pays it — the three
// steps below in this router — but does not get to set the figure.
/**
 * The parts of a salary structure a client may state, validated.
 *
 * Shared by POST and PATCH deliberately. Two copies of "an hourly rate may
 * not be zero" is one copy away from a structure that can be created legally
 * and then edited into a state the creator would have refused.
 *
 * @returns {{ error?: string, code?: string, fields?: object }}
 */
const readStructureFields = (body) => {
  // Absent means monthly: every client that predates hourly pay, and every
  // structure written before the field existed, must keep their meaning.
  const payType = body.payType ?? "monthly";
  if (!["monthly", "hourly"].includes(payType)) {
    return { error: "payType must be \"monthly\" or \"hourly\"", code: "INVALID_PAY_TYPE" };
  }

  const baseAmount = asWholeAmount(body.baseAmount);
  if (baseAmount === null || baseAmount < 0) {
    return { error: "baseAmount must be a whole number of XAF", code: "INVALID_AMOUNT" };
  }
  // An hourly rate of zero would silently pay nobody; the same figure on a
  // monthly structure is legal (a volunteer on allowances only).
  if (payType === "hourly" && baseAmount <= 0) {
    return { error: "An hourly rate must be a positive whole number of XAF", code: "INVALID_AMOUNT" };
  }

  const allow = cleanComponents(body.allowances);
  if (allow.error) return { error: allow.error, code: "INVALID_AMOUNT" };
  const deduct = cleanComponents(body.deductions);
  if (deduct.error) return { error: deduct.error, code: "INVALID_AMOUNT" };

  return {
    fields: {
      payType,
      baseAmount,
      allowances: allow.rows,
      deductions: deduct.rows,
    },
  };
};

router.post("/salary-structures", canSetSalary, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { userId, effectiveFrom } = req.body;
  if (!userId)        return bad(res, "userId is required");
  if (!effectiveFrom) return bad(res, "effectiveFrom is required");

  const parsed = readStructureFields(req.body);
  if (parsed.error) return bad(res, parsed.error, parsed.code);
  const { payType, baseAmount, allowances, deductions } = parsed.fields;

  const staff = await User.findOne({ _id: userId, schoolId }).select("_id").lean();
  if (!staff) {
    return res.status(404).json({
      success: false, code: "STAFF_NOT_FOUND",
      message: "No staff member with that id in this school",
    });
  }

  const from = new Date(effectiveFrom);

  /**
   * ── A replay, checked BEFORE anything is closed ──────────────────────────
   *
   * This endpoint accepts a client _id, which is what lets an offline machine
   * queue a raise. What it did not do was look for that id first, and the order
   * mattered more here than anywhere else in this file.
   *
   * On a second arrival of the same request, the row the FIRST attempt created
   * still has effectiveTo: null, so it matches the updateMany below and is
   * closed at effectiveFrom minus one millisecond — a salary structure that
   * exists and is never in force at any instant. The create that follows then
   * hits the unique index, throws 11000, and answers 500. A 500 is retryable, so
   * the offline queue tries again for ever, and every attempt leaves the row
   * closed.
   *
   * A payslip computed in that window reads no structure at all. So: find the id
   * first and answer with what is stored, exactly as POST /api/fees/payments and
   * POST /api/exams do.
   */
  const claimedId = req.body._id || null;
  if (claimedId) {
    const already = await SalaryStructure.findById(claimedId).lean();
    if (already) {
      if (String(already.schoolId) !== String(schoolId)) {
        return res.status(409).json({
          success: false, code: "STRUCTURE_ID_TAKEN",
          message: "That salary structure id already belongs to another school",
        });
      }
      return res.status(200).json({ success: true, replay: true, data: already });
    }
  }

  // A raise closes the previous row rather than overwriting it, so an old
  // payslip still reproduces the figures that were in force when it was issued.
  await SalaryStructure.updateMany(
    { schoolId, userId, effectiveTo: null, deletedAt: null },
    { effectiveTo: new Date(from.getTime() - 1) }
  );

  const row = await SalaryStructure.create({
    _id: claimedId || uuidv4(),
    schoolId, userId,
    payType,
    baseAmount,
    allowances,
    deductions,
    effectiveFrom: from,
    createdBy:     req.user?._id ? String(req.user._id) : null,
  });

  return res.status(201).json({ success: true, data: row });
}));

// PATCH /finance/salary-structures/:id
//
// Correct the salary that is in force. For adding an allowance NEXT month,
// POST a new one — that is what effective dating is for.
//
// ── Why this is not simply an update ────────────────────────────────────────
//
// A salary structure is effective-dated history, not a record of the current
// figure. A raise closes the old row and opens a new one precisely so that a
// payslip issued in March still reproduces March's numbers in December. Any
// edit that can reach a row a payslip was computed from would rewrite what
// somebody was paid, after they were paid it.
//
// So two guards, and they are the whole point of this endpoint:
//
//   • the row must still be in force (effectiveTo null). A superseded version
//     is closed history and is never editable.
//   • no payslip may reference it. A structure that has produced a payslip is
//     evidence, and the answer is a new version from a new date.
//
// What is left is the case this exists for: a structure entered today with the
// wrong figure, or one that needs the allowance somebody forgot, before any
// payroll has run against it.
router.patch("/salary-structures/:id", canSetSalary, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const row = await SalaryStructure.findOne({
    _id: String(req.params.id), schoolId, deletedAt: null,
  });
  if (!row) {
    return res.status(404).json({
      success: false, code: "STRUCTURE_NOT_FOUND",
      message: "No salary structure with that id in this school",
    });
  }

  if (row.effectiveTo) {
    return res.status(409).json({
      success: false, code: "STRUCTURE_SUPERSEDED",
      message: "That salary structure has already been replaced. Set a new one instead.",
    });
  }

  // deletedAt: null on the payslip too — a reversed or voided run must not
  // freeze a structure for ever.
  const usedBy = await SalaryPayment.countDocuments({
    schoolId, structureId: String(row._id), deletedAt: null,
  });
  if (usedBy > 0) {
    return res.status(409).json({
      success: false, code: "STRUCTURE_IN_USE",
      message:
        `This salary has already been paid on ${usedBy} payslip(s). ` +
        "Set a new salary from a new date instead, so the earlier payslips keep their figures.",
      payslips: usedBy,
    });
  }

  const parsed = readStructureFields({
    // Absent fields keep what is stored, so a client that only wants to add a
    // deduction need not resend the base amount and risk mistyping it.
    payType:    req.body.payType    ?? row.payType,
    baseAmount: req.body.baseAmount ?? row.baseAmount,
    allowances: req.body.allowances ?? row.allowances,
    deductions: req.body.deductions ?? row.deductions,
  });
  if (parsed.error) return bad(res, parsed.error, parsed.code);

  Object.assign(row, parsed.fields);

  // The start date may move while nothing has been paid against it, but it
  // may not cross the row that precedes it — two structures in force at once
  // is a figure payroll would have to choose between.
  if (req.body.effectiveFrom) {
    const from = new Date(req.body.effectiveFrom);
    if (Number.isNaN(from.getTime())) {
      return bad(res, "effectiveFrom is not a date", "INVALID_DATE");
    }
    const previous = await SalaryStructure.findOne({
      schoolId, userId: row.userId, deletedAt: null,
      _id: { $ne: String(row._id) },
      effectiveFrom: { $lt: from },
    }).sort({ effectiveFrom: -1 }).select("effectiveTo").lean();

    if (previous && previous.effectiveTo && new Date(previous.effectiveTo) >= from) {
      return res.status(409).json({
        success: false, code: "OVERLAPPING_STRUCTURE",
        message: "That date overlaps the salary before it.",
      });
    }
    row.effectiveFrom = from;
  }

  await row.save();
  return res.json({ success: true, data: row.toObject() });
}));

// GET /finance/payroll/hours-preview?periodMonth=YYYY-MM
//
// The hours each hourly teacher actually worked in a month, as payroll will
// read them when it generates that month's run. Shown before generation so a
// bursar can see that "162.5 h" is attendance and not arithmetic — and fix a
// mis-marked register BEFORE it becomes a payslip.
router.get("/payroll/hours-preview", canReadPayroll, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const periodMonth = (req.query.periodMonth || "").trim();
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
    return bad(res, "periodMonth must be \"YYYY-MM\"", "INVALID_PERIOD");
  }

  const structures = await SalaryStructure.find({
    schoolId,
    deletedAt: null,
    payType:   "hourly",
    // Who is hourly as of the END of the month — the same question the
    // generator asks, so the preview cannot disagree with the run.
    effectiveFrom: { $lte: endOfMonth(periodMonth) },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: endOfMonth(periodMonth) } }],
  }).select("userId baseAmount").lean();

  const hoursByTeacher = await hoursWorkedInMonth(
    schoolId,
    structures.map((s) => String(s.userId)),
    periodMonth
  );

  return res.json({
    success: true,
    count:   structures.length,
    data:    structures.map((s) => {
      const slot  = hoursByTeacher.get(String(s.userId));
      const hours = slot ? Math.round((slot.minutes / 60) * 100) / 100 : 0;
      return {
        userId:       String(s.userId),
        hourlyRate:   s.baseAmount,
        hours,
        daysWorked:   slot?.days ?? 0,
        estimatedPay: Math.round(s.baseAmount * hours),
      };
    }),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// PAYROLL
// ═════════════════════════════════════════════════════════════════════════════

router.get("/payroll", canReadPayroll, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await PayrollRun.find({ schoolId, deletedAt: null })
    .sort({ periodMonth: -1 }).lean();
  return res.json({ success: true, count: rows.length, data: rows });
}));

router.get("/payroll/:runId", canReadPayroll, asyncHandler(async (req, res) => {
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
router.post("/payroll/generate", canRunPayroll, asyncHandler(async (req, res) => {
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
/**
 * POST /api/finance/payroll/:runId/request-approval
 *
 * Put a draft run up for signature. Separate from generate because a run is
 * reviewed and corrected first — the point of a draft — and because a school
 * with payroll approval turned off never needs this at all.
 */
router.post("/payroll/:runId/request-approval", canRunPayroll, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const run = await PayrollRun.findOne({
    _id: req.params.runId, schoolId, deletedAt: null,
  }).lean();

  if (!run) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Payroll run not found",
    });
  }
  if (run.status !== "draft") {
    return res.status(409).json({
      success: false, code: "NOT_DRAFT",
      message: `This run is already ${run.status}`,
    });
  }

  try {
    const approval = await approvals.raise({
      schoolId,
      kind:        "payroll",
      targetId:    run._id,
      amount:      run.totalNet ?? 0,
      reason:      req.body.reason ?? null,
      summary:     `Payroll ${run.periodMonth} — ${run.staffCount} staff`,
      requestedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({ success: true, data: approval });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "ERROR", message: err.message,
    });
  }
}));

router.post("/payroll/:runId/confirm", canRunPayroll, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  // ── The §4 separation, at the one point where money actually moves ───────
  //
  // With payroll approval on, a draft cannot be confirmed: it has to be
  // approved by somebody who did not prepare it, and only then paid. Checked
  // here rather than inside confirmRun because the service is also reachable
  // from a script, and "was this school asking for a signature" is a request-
  // level question.
  const { required } = await approvals.requiresApproval({
    schoolId, kind: "payroll", amount: 0,
  });

  if (required) {
    const run = await PayrollRun.findOne({
      _id: req.params.runId, schoolId, deletedAt: null,
    }).select("status approvedBy").lean();

    if (run && run.status === "draft") {
      return res.status(409).json({
        success: false,
        code:    "APPROVAL_REQUIRED",
        message: "This school requires payroll to be approved before it is paid. " +
                 "Request approval, then confirm once it has been given.",
      });
    }

    // Four eyes at the point of payment as well as at the point of signature.
    // Approving your own run and then paying it would satisfy the state machine
    // and defeat the purpose.
    if (
      run?.approvedBy &&
      String(run.approvedBy) === String(req.user?._id ?? "")
    ) {
      return res.status(403).json({
        success: false,
        code:    "SELF_APPROVAL",
        message: "You approved this run, so somebody else has to be the one to pay it.",
      });
    }
  }

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
router.post("/payroll/:runId/reverse", canRunPayroll, asyncHandler(async (req, res) => {
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
