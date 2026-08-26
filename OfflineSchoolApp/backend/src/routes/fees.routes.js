// backend/src/routes/fees.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const { authorize } = require("../../middleware/auth");

const FeeStructure = require("../db/models/FeeStructure");
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

// Money is staff-only throughout. Teachers do not touch the ledger.
const bursar = authorize("admin", "school_admin", "super_admin");

router.use(bursar);

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
router.post("/structures", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const { academicYear, term = null, items } = req.body;
  if (!academicYear) return bad(res, "academicYear is required");

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
router.patch("/structures/:id/deactivate", asyncHandler(async (req, res) => {
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
router.post("/structures/:id/apply", asyncHandler(async (req, res) => {
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

  const [charges, payments, totals] = await Promise.all([
    FeeCharge.find(scope).sort({ createdAt: 1 }).lean(),
    FeePayment.find(scope).sort({ receivedAt: 1 }).lean(),
    balanceFor({ schoolId, studentId, academicYear }),
  ]);

  return res.json({ success: true, data: { charges, payments, totals } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/fees/payments
//
// The phone generates _id before it ever reaches the network, so a retry
// upserts the same row instead of taking the money twice.
router.post("/payments", asyncHandler(async (req, res) => {
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
router.post("/payments/:id/reverse", asyncHandler(async (req, res) => {
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
