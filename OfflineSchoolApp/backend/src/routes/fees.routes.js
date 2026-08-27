// backend/src/routes/fees.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const { requirePermission } = require("../../middleware/permissions");

const FeeStructure = require("../db/models/FeeStructure");
const PaymentPlan  = require("../db/models/PaymentPlan");
const FeeCharge    = require("../db/models/FeeCharge");
const FeePayment   = require("../db/models/FeePayment");
const Student      = require("../db/models/Student");

const {
  nextReceiptNo,
  balanceFor,
  balancesFor,
  applyStructure,
} = require("../services/fees.service");
const { displayName } = require("../utils/studentName");
const approvals = require("../services/approvals.service");
const reminders = require("../services/feeReminders.service");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * A super admin may act on another school; everyone else is pinned to theirs.
 * Every query below goes through this — the markAllRead bug in this codebase
 * ran find({ schoolId: undefined }), which drops the filter and matches every
 * school on the server. In a fee ledger that is a cross-tenant money leak.
 */
const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const bad = (res, message, code) =>
  res.status(400).json({ success: false, code: code ?? "BAD_REQUEST", message });

/** Whole XAF only. Rejects floats, strings that are not numbers, and NaN. */
const asWholeAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
};

// The ledger. Teachers never touch it; the bursar owns it.
//
// This guard was once the admin guard under a variable named "bursar" — the
// role did not exist, so the only way to run a fee desk was to hand somebody
// school_admin, and with it every grade and account in the school.
//
// Now split in two, which the single role set could not express: reading the
// ledger and writing to it are different rights. Both default to the same
// accounts as before — fees.view and fees.manage are FINANCE_ROLES in
// config/permissions.js — so nothing changes until a school decides it should.
// What it buys is a front-desk clerk who can look up what a parent owes and
// take no money, which is a real job and previously unexpressable.
const canRead   = requirePermission("fees.view");
const canWrite  = requirePermission("fees.manage");
const canRefund   = requirePermission("fees.refund");
const canWaive    = requirePermission("fees.waive");
const canPlan     = requirePermission("fees.plan");
const canRemind   = requirePermission("fees.remind");
const canPenalize = requirePermission("fees.penalize");

/**
 * A calendar day from the client, as a Date.
 *
 * Accepts "2026-09-15" and rejects anything else, rather than handing whatever
 * arrived to new Date() — which turns "next friday" into an Invalid Date and
 * stores null, so a structure would silently end up with no deadline and its
 * families would never be reminded.
 */
const asDueDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;   // undefined = invalid
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** The penalty rule from a request body, or an error string. */
const cleanPenalty = (raw) => {
  if (!raw || raw.mode === undefined || raw.mode === null || raw.mode === "none") {
    return { value: { mode: "none", amount: 0, graceDays: 0 }, error: null };
  }

  if (!["fixed", "percent"].includes(raw.mode)) {
    return { value: null, error: `penalty.mode must be none, fixed or percent` };
  }

  const amount = asWholeAmount(raw.amount);
  if (amount === null || amount < 0) {
    return { value: null, error: "penalty.amount must be a whole number" };
  }
  if (raw.mode === "percent" && amount > 100) {
    return { value: null, error: "A percentage penalty cannot exceed 100" };
  }

  const graceDays = asWholeAmount(raw.graceDays ?? 0);
  if (graceDays === null || graceDays < 0 || graceDays > 365) {
    return { value: null, error: "penalty.graceDays must be between 0 and 365" };
  }

  return { value: { mode: raw.mode, amount, graceDays }, error: null };
};

router.use(canRead);

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/fees/structures?academicYear=&classId=
router.get("/structures", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const filter = { schoolId, deletedAt: null };
  if (req.query.academicYear) filter.academicYear = req.query.academicYear;
  // Matches a structure that bills this class among others.
  if (req.query.classId)      filter.classIds     = req.query.classId;

  const rows = await FeeStructure.find(filter).sort({ academicYear: -1, term: 1 }).lean();
  return res.json({ success: true, count: rows.length, data: rows });
}));

// POST /api/fees/structures
router.post("/structures", canWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { academicYear, term = null, items } = req.body;
  if (!academicYear) return bad(res, "academicYear is required");

  // Required, and this is the one new obligation on this endpoint.
  //
  // Everything downstream — which families to remind, who has earned a late
  // fee — is derived from this date, and a structure published without one is
  // a bill nobody can ever be chased for. Asked for at setup, when the person
  // entering the price list knows the answer, rather than inferred later from
  // a term calendar the school may not keep.
  //
  // Old structures have none and stay valid; only new ones must say.
  const dueDate = asDueDate(req.body.dueDate);
  if (dueDate === undefined) {
    return bad(res, "dueDate must be a calendar date like 2026-09-15", "INVALID_DATE");
  }
  if (dueDate === null) {
    return bad(
      res,
      "A due date is required: it is what fee reminders and late fees are " +
      "calculated from.",
      "DUE_DATE_REQUIRED"
    );
  }

  const penalty = cleanPenalty(req.body.penalty);
  if (penalty.error) return bad(res, penalty.error, "INVALID_PENALTY");

  // A structure may bill several classes. `classId` is still accepted as a
  // single value so an older client is not broken by the change; an empty list
  // means every class in the school.
  const classIds = Array.isArray(req.body.classIds)
    ? [...new Set(req.body.classIds.map(String).map((s) => s.trim()).filter(Boolean))]
    : req.body.classId
      ? [String(req.body.classId).trim()]
      : [];
  if (!Array.isArray(items) || items.length === 0) {
    return bad(res, "At least one fee item is required");
  }

  const clean = [];
  for (const item of items) {
    const amount = asWholeAmount(item?.amount);
    if (!item?.code || !item?.label) {
      return bad(res, "Every fee item needs a code and a label");
    }
    if (amount === null || amount < 0) {
      return bad(
        res,
        `"${item.label}" must be a whole number of XAF — the currency has no minor unit`,
        "INVALID_AMOUNT"
      );
    }
    clean.push({
      code:       String(item.code).trim(),
      label:      String(item.label).trim(),
      labelFr:    item.labelFr ? String(item.labelFr).trim() : null,
      amount,
      isOptional: Boolean(item.isOptional),
    });
  }

  try {
    const structure = await FeeStructure.create({
      _id: req.body._id || uuidv4(),
      schoolId, academicYear, classIds, term,
      items:     clean,
      dueDate,
      penalty:   penalty.value,
      createdBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({ success: true, data: structure });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        code:    "STRUCTURE_EXISTS",
        message: "One of those classes is already billed by an active structure for that year and term. Deactivate it before publishing a replacement.",
      });
    }
    throw err;
  }
}));

// PATCH /api/fees/structures/:id/deactivate
router.patch("/structures/:id/deactivate", canWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const updated = await FeeStructure.findOneAndUpdate(
    { _id: req.params.id, schoolId },
    { isActive: false },
    { new: true }
  );
  if (!updated) return res.status(404).json({ success: false, message: "Structure not found" });
  return res.json({ success: true, data: updated });
}));

// ─────────────────────────────────────────────────────────────────────────────
// APPLYING A STRUCTURE — raises the charges
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/fees/structures/:id/apply   { classId? }
router.post("/structures/:id/apply", canWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const structure = await FeeStructure.findOne({
    _id: req.params.id, schoolId, deletedAt: null,
  }).lean();
  if (!structure) {
    return res.status(404).json({ success: false, message: "Structure not found" });
  }

  // Bill every class the structure covers, unless the caller narrows it to one.
  // An empty classIds means the structure applies school-wide.
  const only     = req.body.classId ? [String(req.body.classId)] : null;
  const classIds = only ?? (structure.classIds ?? []);

  const filter = { schoolId, deletedAt: null, status: "approved" };
  if (classIds.length) filter.classId = { $in: classIds };

  const students = await Student.find(filter).select("_id classId").lean();
  if (!students.length) {
    return bad(res, "No approved students match those classes", "NO_STUDENTS");
  }

  const result = await applyStructure({
    structure,
    students,
    raisedBy: req.user?._id ? String(req.user._id) : null,
  });

  return res.status(201).json({
    success:  true,
    students: students.length,
    ...result,
    message: result.skipped
      ? `${result.raised} charge(s) raised; ${result.skipped} already existed and were left alone.`
      : `${result.raised} charge(s) raised.`,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// A STUDENT'S ACCOUNT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/fees/students/:studentId?academicYear=
router.get("/students/:studentId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { studentId }    = req.params;
  const { academicYear } = req.query;

  const scope = { schoolId, studentId, deletedAt: null };
  if (academicYear) scope.academicYear = academicYear;

  const [charges, payments, totals, plan] = await Promise.all([
    FeeCharge.find(scope).sort({ createdAt: 1 }).lean(),
    FeePayment.find(scope).sort({ receivedAt: 1 }).lean(),
    balanceFor({ schoolId, studentId, academicYear }),
    // The active plan, if there is one. Returned with the ledger rather than
    // from a second call because the two are read together every time: what a
    // family owes is meaningless on this screen without knowing what they
    // agreed to pay and when.
    PaymentPlan.findOne({
      schoolId, studentId, status: "active", deletedAt: null,
      ...(academicYear ? { academicYear } : {}),
    }).lean(),
  ]);

  // Where they stand against it, computed here so the browser never has to do
  // the cumulative arithmetic — and so the ledger screen and the arrears list
  // cannot disagree about whether a family is behind.
  const planStatus = plan
    ? reminders.planStatus(plan, totals.paid, new Date())
    : null;

  return res.json({
    success: true,
    data: { charges, payments, totals, plan, planStatus },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/fees/payments
//
// The phone generates _id before it ever reaches the network, so a retry
// upserts the same row instead of taking the money twice.
router.post("/payments", canWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const {
    _id, studentId, academicYear, term = null,
    method = "cash", reference = null, note = null,
    receivedAt, source = "web",
  } = req.body;

  if (!studentId)    return bad(res, "studentId is required");
  if (!academicYear) return bad(res, "academicYear is required");

  const amount = asWholeAmount(req.body.amount);
  if (amount === null) {
    return bad(res, "amount must be a whole number of XAF", "INVALID_AMOUNT");
  }
  if (amount <= 0) {
    return bad(res, "A payment must be greater than zero. Use the reversal endpoint to undo one.", "INVALID_AMOUNT");
  }

  // The student must exist and belong to this school. Without this a typo in a
  // studentId creates a payment nobody can find, and money that reconciles
  // against nothing.
  const student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null })
    .select("_id classId").lean();
  if (!student) {
    return res.status(404).json({
      success: false, code: "STUDENT_NOT_FOUND",
      message: "No student with that id in this school",
    });
  }

  const paymentId = _id || uuidv4();

  // A replay of the same offline row: return the row already stored rather
  // than a duplicate-key error, so the outbox can mark it done.
  const existing = await FeePayment.findById(paymentId).lean();
  if (existing) {
    return res.status(200).json({ success: true, replay: true, data: existing });
  }

  const receiptNo = await nextReceiptNo(schoolId, academicYear);

  const payment = await FeePayment.create({
    _id:        paymentId,
    schoolId, studentId, academicYear, term,
    classId:    student.classId ?? null,
    amount, method, reference, note,
    receiptNo,
    receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
    receivedBy: req.user?._id ? String(req.user._id) : null,
    source,
  });

  const totals = await balanceFor({ schoolId, studentId, academicYear });

  return res.status(201).json({ success: true, data: payment, totals });
}));

// POST /api/fees/payments/:id/reverse   { reason }
router.post("/payments/:id/reverse", canWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const reason   = (req.body.reason || "").trim();
  if (!reason) {
    return bad(res, "A reason is required to reverse a payment", "REASON_REQUIRED");
  }

  const original = await FeePayment.findOne({ _id: req.params.id, schoolId });
  if (!original) {
    return res.status(404).json({ success: false, message: "Payment not found" });
  }
  if (original.reversedById) {
    return res.status(409).json({
      success: false, code: "ALREADY_REVERSED",
      message: "That payment has already been reversed",
    });
  }
  if (original.reversesId) {
    return res.status(409).json({
      success: false, code: "IS_REVERSAL",
      message: "That row is itself a reversal and cannot be reversed",
    });
  }

  // The correction is a new row with the opposite sign — the original stays
  // exactly as it was written.
  const reversal = await FeePayment.create({
    _id:          uuidv4(),
    schoolId,
    studentId:    original.studentId,
    academicYear: original.academicYear,
    term:         original.term,
    classId:      original.classId,
    amount:       -original.amount,
    method:       original.method,
    reference:    original.reference,
    receiptNo:    await nextReceiptNo(schoolId, original.academicYear),
    receivedAt:   new Date(),
    receivedBy:   req.user?._id ? String(req.user._id) : null,
    reversesId:   String(original._id),
    reversalReason: reason,
    source:       "web",
  });

  original.reversedById   = String(reversal._id);
  original.reversalReason = reason;
  await original.save();

  const totals = await balanceFor({
    schoolId,
    studentId:    original.studentId,
    academicYear: original.academicYear,
  });

  return res.status(201).json({ success: true, data: reversal, totals });
}));

// ═════════════════════════════════════════════════════════════════════════════
// INSTALMENT PLANS
//
// An arrangement with ONE family: they cannot pay the term in one go, so the
// school agrees a schedule of dated amounts instead.
//
// Not a school-wide payment schedule — a school billing in three tranches
// already has that in three fee structures, one per term, each with its own due
// date. Two mechanisms for the same thing would give one deadline two homes.
//
// A plan changes WHEN, never HOW MUCH. Nothing here writes to the ledger, and
// balanceFor() does not know this collection exists. A school that wants to
// reduce a bill uses a waiver, which is a different act with an approval behind
// it. What a plan changes is the date reminders and late fees measure against.
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/fees/plans?academicYear=&studentId=&status=
router.get("/plans", canPlan, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const filter = { schoolId, deletedAt: null };
  if (req.query.studentId)    filter.studentId    = req.query.studentId;
  if (req.query.academicYear) filter.academicYear = req.query.academicYear;
  filter.status = req.query.status && req.query.status !== "all"
    ? req.query.status
    : { $in: ["active", "completed", "cancelled"] };

  const rows = await PaymentPlan.find(filter)
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  return res.json({ success: true, count: rows.length, data: rows });
}));

// POST /api/fees/plans
router.post("/plans", canPlan, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { studentId, academicYear, term = null } = req.body;
  if (!studentId)    return bad(res, "studentId is required");
  if (!academicYear) return bad(res, "academicYear is required");

  const reason = req.body.reason ? String(req.body.reason).trim() : null;
  if (!reason) {
    // Required, like a refund and a waiver. A plan is a concession the school
    // granted, and "why" is the question asked about it a year later — by an
    // auditor, or by the next bursar wondering whether to grant another.
    return bad(res, "A reason is required for an instalment plan", "REASON_REQUIRED");
  }

  if (!Array.isArray(req.body.instalments) || req.body.instalments.length < 2) {
    return bad(
      res,
      "A plan needs at least two instalments — one is just a due date",
      "TOO_FEW_INSTALMENTS"
    );
  }

  const student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null })
    .select("_id").lean();
  if (!student) {
    return res.status(404).json({
      success: false, code: "STUDENT_NOT_FOUND",
      message: "No student with that id in this school",
    });
  }

  const instalments = [];
  for (const [i, raw] of req.body.instalments.entries()) {
    const amount = asWholeAmount(raw?.amount);
    if (amount === null || amount <= 0) {
      return bad(
        res,
        `Instalment ${i + 1} must be a whole number of XAF greater than zero`,
        "INVALID_AMOUNT"
      );
    }

    const dueDate = asDueDate(raw?.dueDate);
    if (dueDate === undefined || dueDate === null) {
      return bad(
        res,
        `Instalment ${i + 1} needs a date like 2026-09-15`,
        "INVALID_DATE"
      );
    }

    instalments.push({ seq: i + 1, amount, dueDate });
  }

  // The schedule has to add up to what is actually owed. A plan for less would
  // quietly forgive the difference — which is a waiver, and waivers go through
  // approval. A plan for more would have the family chased for money the
  // ledger says they do not owe.
  const totals = await balanceFor({ schoolId, studentId, academicYear });
  const planned = instalments.reduce((s, i) => s + i.amount, 0);

  if (totals.balance <= 0) {
    return bad(
      res,
      "This family has nothing outstanding for that year",
      "NOTHING_OUTSTANDING"
    );
  }
  if (planned !== totals.balance) {
    return bad(
      res,
      `The instalments add up to ${planned}, but ${totals.balance} is outstanding. ` +
      `A plan reschedules what is owed; it cannot change the amount — use a waiver for that.`,
      "PLAN_TOTAL_MISMATCH"
    );
  }

  try {
    const plan = await PaymentPlan.create({
      schoolId, studentId, academicYear, term,
      instalments, reason,
      agreedBy: req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({ success: true, data: plan });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        code:    "PLAN_EXISTS",
        message: "This family already has an active plan for that year and term. " +
                 "Cancel it before agreeing a new one.",
      });
    }
    throw err;
  }
}));

// POST /api/fees/plans/:id/cancel
router.post("/plans/:id/cancel", canPlan, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const reason = req.body.reason ? String(req.body.reason).trim() : null;
  if (!reason) {
    return bad(res, "A reason is required to cancel a plan", "REASON_REQUIRED");
  }

  const plan = await PaymentPlan.findOne({
    _id: req.params.id, schoolId, deletedAt: null,
  });
  if (!plan) {
    return res.status(404).json({
      success: false, code: "NOT_FOUND", message: "Plan not found",
    });
  }
  if (plan.status !== "active") {
    return bad(res, `This plan is already ${plan.status}`, "NOT_ACTIVE");
  }

  // Cancelled, never deleted. "We gave them a plan and they broke it" is
  // something a school needs to be able to see next year — and from the moment
  // it is cancelled the family is measured against the original due date again.
  plan.status          = "cancelled";
  plan.cancelledBy     = req.user?._id ? String(req.user._id) : null;
  plan.cancelledAt     = new Date();
  plan.cancelledReason = reason;
  await plan.save();

  return res.json({ success: true, data: plan });
}));

// ═════════════════════════════════════════════════════════════════════════════
// REMINDERS
//
// Built entirely on the due date entered when the structure was set up. A
// charge with no due date is invisible here, which is the right reading of a
// bill with no deadline and is what every charge raised before this feature
// existed looks like — no school gets a surprise batch of reminders for last
// year on the day it upgrades.
//
// Preview and send are separate calls on purpose. These are messages to
// families about money, and the bursar should see the list, including who has
// no phone number on file, before any of them go out.
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/fees/reminders?academicYear=&classId=&mode=overdue|dueSoon|all
router.get("/reminders", canRemind, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const mode = ["overdue", "dueSoon", "all"].includes(req.query.mode)
    ? req.query.mode
    : "overdue";

  const rows = await reminders.candidates({
    schoolId,
    academicYear: req.query.academicYear || null,
    classId:      req.query.classId || null,
    mode,
  });

  // Who was reminded lately, so the preview can grey them out rather than the
  // bursar pressing send and being told afterwards that nothing happened.
  const recent = await reminders.recentlyReminded(
    schoolId, rows.map((r) => r.studentId)
  );

  return res.json({
    success: true,
    count:   rows.length,
    mode,
    cooldownDays: reminders.REMINDER_COOLDOWN_DAYS,
    data: rows.map((r) => ({ ...r, recentlyReminded: recent.has(r.studentId) })),
  });
}));

// POST /api/fees/reminders   { academicYear?, classId?, mode?, studentIds?, force? }
router.post("/reminders", canRemind, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const mode = ["overdue", "dueSoon", "all"].includes(req.body.mode)
    ? req.body.mode
    : "overdue";

  try {
    const result = await reminders.sendReminders({
      schoolId,
      academicYear: req.body.academicYear || null,
      classId:      req.body.classId || null,
      studentIds:   Array.isArray(req.body.studentIds) ? req.body.studentIds : null,
      mode,
      force:        req.body.force === true,
      requestedBy:  req.user?._id ? String(req.user._id) : null,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "ERROR", message: err.message,
    });
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// LATE FEES
//
// The penalty rule lives on the structure next to the due date, so two classes
// on different price lists can have different late fees and different grace
// periods.
//
// Never automatic. A late fee is money added to a family's bill, and it is
// raised by the bursar from a preview. Applying twice is harmless: the unique
// index on FeeCharge means a second run can only collide with the row the first
// one wrote.
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/fees/penalties?academicYear=&structureId=
router.get("/penalties", canPenalize, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await reminders.penaltyPreview({
    schoolId,
    academicYear: req.query.academicYear || null,
    structureId:  req.query.structureId || null,
  });

  return res.json({
    success: true,
    count:   rows.length,
    total:   rows.reduce((s, r) => s + r.amount, 0),
    data:    rows,
  });
}));

// POST /api/fees/penalties   { academicYear?, structureId?, studentIds? }
router.post("/penalties", canPenalize, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const result = await reminders.applyPenalties({
      schoolId,
      academicYear: req.body.academicYear || null,
      structureId:  req.body.structureId || null,
      studentIds:   Array.isArray(req.body.studentIds) ? req.body.studentIds : null,
      raisedBy:     req.user?._id ? String(req.user._id) : null,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "ERROR", message: err.message,
    });
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// REFUNDS
//
// Money going back to a family, and NOT the same thing as a reversal.
//
//   A reversal says the payment should never have been recorded — a mistyped
//   amount, the wrong student — and appends a row pointing at the original with
//   reversesId. Both rows stay, and they cancel.
//
//   A refund says the payment was real and the money is being returned. It
//   stands alone as a negative payment, and the student's balance rises by what
//   went back, which is exactly right: they no longer have that credit.
//
// Above the school's refund threshold, nothing is written until somebody else
// agrees. The intent is held on the approval request and the payment row is
// created when it is approved — see approvals.service.js, which explains why
// the refund defers creation where the expense does not.
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/fees/refunds
router.post("/refunds", canRefund, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { studentId, academicYear, term = null, method = "cash", reference = null } = req.body;

  if (!studentId)    return bad(res, "studentId is required");
  if (!academicYear) return bad(res, "academicYear is required");

  const amount = asWholeAmount(req.body.amount);
  if (amount === null || amount <= 0) {
    return bad(res, "amount must be a whole number of XAF greater than zero", "INVALID_AMOUNT");
  }

  const reason = req.body.reason ? String(req.body.reason).trim() : null;
  if (!reason) {
    // Required, unlike on a payment. Money leaving the school towards a family
    // is the transaction most likely to be asked about a year later, and "why"
    // is not reconstructable from the ledger afterwards.
    return bad(res, "A reason is required for a refund", "REASON_REQUIRED");
  }

  const student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null })
    .select("_id studentName name firstName lastName classId enrollmentNo")
    .lean();
  if (!student) {
    return res.status(404).json({
      success: false, code: "STUDENT_NOT_FOUND",
      message: "No student with that id in this school",
    });
  }

  // Refunding more than the family has actually paid would put the account into
  // a credit that never existed. Checked against the ledger as it stands now.
  const totals = await balanceFor({ schoolId, studentId, academicYear });
  if (amount > totals.paid) {
    return bad(
      res,
      `Cannot refund ${amount} — only ${totals.paid} has been paid this year`,
      "REFUND_EXCEEDS_PAID"
    );
  }

  const { required, threshold } = await approvals.requiresApproval({
    schoolId, kind: "refund", amount,
  });

  if (required) {
    try {
      const approval = await approvals.raise({
        schoolId,
        kind:    "refund",
        amount,
        threshold,
        reason,
        summary: `Refund to ${displayName(student) ?? "student"} — ${academicYear}`,
        payload: { studentId, academicYear, term, amount, method, reference, note: reason },
        requestedBy: req.user?._id ? String(req.user._id) : null,
      });
      return res.status(202).json({
        success: true,
        pendingApproval: true,
        data: approval,
        message: "The refund needs approval before the money can go back.",
      });
    } catch (err) {
      return res.status(err.status ?? 500).json({
        success: false, code: err.code ?? "ERROR", message: err.message,
      });
    }
  }

  // Under the threshold, or no threshold set: written immediately, exactly as a
  // payment is.
  const payment = await FeePayment.create({
    schoolId,
    studentId,
    academicYear,
    term,
    classId:    student.classId ?? null,
    amount:     -amount,
    method,
    reference,
    receiptNo:  await nextReceiptNo(schoolId, academicYear),
    receivedAt: new Date(),
    receivedBy: req.user?._id ? String(req.user._id) : null,
    note:       reason,
    source:     "web",
  });

  return res.status(201).json({
    success: true,
    data:    payment,
    totals:  await balanceFor({ schoolId, studentId, academicYear }),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// WAIVERS
//
// Reducing or writing off a charge — a scholarship, a hardship case, a sibling
// discount. The FeeCharge has carried waivedAmount and waiverReason since it
// was written, and until now NO ROUTE COULD SET THEM: every screen read the
// field and nothing wrote it, so the reduction had to be done by editing the
// database. This is that missing endpoint, gated from the start.
//
// Discounts and scholarships are not separate concepts here on purpose. Both
// are "this family owes less than the structure says, for a stated reason",
// which is precisely a waiver with the reason filled in. A parallel model would
// duplicate the arithmetic in balancesFor and give the same number two names.
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/fees/charges/:chargeId/waive
router.post("/charges/:chargeId/waive", canWaive, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const waived = asWholeAmount(req.body.waivedAmount);
  if (waived === null || waived <= 0) {
    return bad(res, "waivedAmount must be a whole number of XAF greater than zero", "INVALID_AMOUNT");
  }

  const reason = req.body.reason ? String(req.body.reason).trim() : null;
  if (!reason) return bad(res, "A reason is required for a waiver", "REASON_REQUIRED");

  const charge = await FeeCharge.findOne({
    _id: req.params.chargeId, schoolId, deletedAt: null,
  });
  if (!charge) {
    return res.status(404).json({
      success: false, code: "CHARGE_NOT_FOUND",
      message: "No fee charge with that id in this school",
    });
  }
  if (charge.voidedAt) {
    return bad(res, "That charge has been voided", "CHARGE_VOID");
  }
  if (waived > charge.amount) {
    return bad(
      res,
      `A waiver of ${waived} exceeds the charge of ${charge.amount}`,
      "WAIVER_TOO_LARGE"
    );
  }

  const { required, threshold } = await approvals.requiresApproval({
    schoolId, kind: "waiver", amount: waived,
  });

  if (required) {
    try {
      const approval = await approvals.raise({
        schoolId,
        kind:     "waiver",
        targetId: charge._id,
        amount:   waived,
        threshold,
        reason,
        summary:  `Waive ${waived} of ${charge.label} (${charge.academicYear})`,
        payload:  { waivedAmount: waived, waiverReason: reason },
        requestedBy: req.user?._id ? String(req.user._id) : null,
      });
      return res.status(202).json({
        success: true,
        pendingApproval: true,
        data: approval,
        message: "The waiver needs approval before it reduces the bill.",
      });
    } catch (err) {
      return res.status(err.status ?? 500).json({
        success: false, code: err.code ?? "ERROR", message: err.message,
      });
    }
  }

  charge.waivedAmount = waived;
  charge.waiverReason = reason;
  await charge.save();

  return res.json({
    success: true,
    data:    charge,
    totals:  await balanceFor({
      schoolId, studentId: charge.studentId, academicYear: charge.academicYear,
    }),
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// ARREARS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/fees/outstanding?academicYear=&classId=
router.get("/outstanding", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { academicYear, classId } = req.query;

  const filter = { schoolId, deletedAt: null, status: "approved" };
  if (classId) filter.classId = classId;

  const students = await Student.find(filter)
    .select("_id studentName name firstName lastName enrollmentNo classId")
    .lean();

  const balances = await balancesFor({
    schoolId,
    studentIds: students.map((s) => String(s._id)),
    academicYear,
  });

  const rows = students
    .map((s) => ({
      studentId:    String(s._id),
      name:         displayName(s) || null,
      enrollmentNo: s.enrollmentNo ?? null,
      classId:      s.classId ?? null,
      ...(balances.get(String(s._id)) ?? { charged: 0, waived: 0, paid: 0, balance: 0 }),
    }))
    // Only those who actually owe; a zero balance is not an arrears row.
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  const totalOutstanding = rows.reduce((sum, r) => sum + r.balance, 0);

  return res.json({
    success: true,
    count:   rows.length,
    totalOutstanding,
    data:    rows,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

router.use((err, req, res, _next) => {
  console.error("fees.routes error:", err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

module.exports = router;
