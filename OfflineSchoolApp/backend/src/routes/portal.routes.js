// backend/src/routes/portal.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const School        = require("../db/models/School");
const Student       = require("../db/models/Student");
const Class         = require("../db/models/Class");
const FeeCharge     = require("../db/models/FeeCharge");
const FeePayment    = require("../db/models/FeePayment");
const ResultSummary = require("../db/models/ResultSummary");
const GeneratedReport = require("../db/models/GeneratedReport");
// Attendance.js exports TWO models. Importing the module as one silently
// yields an object with no .find, which fails only when the route is called.
const { StudentAttendance } = require("../db/models/Attendance");
const Announcement  = require("../db/models/Announcement");

const portal = require("../services/portal.service");
const { buildReceiptHtml } = require("../print/receipt");
const { labelsFor, formatPrintDate } = require("../print/labels");
const { displayName } = require("../utils/studentName");

/**
 * The guardian portal.
 *
 * Every route here is READ-ONLY, and every one of them reads the student id
 * from the verified token rather than from the request. A guardian cannot ask
 * for another child by changing a parameter, because no route accepts a student
 * id at all.
 *
 * What is exposed is what a parent is already entitled to know about their own
 * child: what has been charged and paid, published results, attendance, and
 * announcements. Nothing about other students, staff, or the school's finances.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, err) =>
  res.status(err.status ?? 500).json({
    success: false,
    code:    err.code ?? "ERROR",
    message: err.message,
    ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
  });

const originOf = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return host ? `${proto}://${host}` : null;
};

const schoolHeading = async (schoolId) => {
  const school = await School.findOne({ _id: schoolId }).lean();
  return {
    name:    school?.name ?? null,
    logo:    school?.logo ?? null,
    address: school?.address ?? null,
    phone:   school?.phone ?? null,
    email:   school?.email ?? null,
    motto:   school?.motto ?? null,
    academicYear: school?.settings?.academicYear ?? null,
    currentTerm:  school?.settings?.currentTerm ?? null,
  };
};

/**
 * Which school a public visitor is signing in to.
 *
 * A guardian standing at a login form does not know a school id, and asking for
 * one would be asking them to read a UUID off a slip. Where the deployment
 * serves a single school — which this one does — that is resolved here. A
 * multi-school deployment must send `schoolId`, and gets a clear error rather
 * than being silently signed in to whichever school happened to be first.
 */
const resolvePublicSchool = async (provided) => {
  if (provided) return String(provided).trim();

  const schools = await School.find({ deletedAt: null }).select("_id").limit(2).lean();
  if (schools.length === 1) return String(schools[0]._id);

  const err = new Error("A school must be specified");
  err.status = 400;
  err.code   = "SCHOOL_REQUIRED";
  throw err;
};

// ═════════════════════════════════════════════════════════════════════════════
// SIGN IN  (public)
// ═════════════════════════════════════════════════════════════════════════════

router.post("/login", asyncHandler(async (req, res) => {
  try {
    const schoolId = await resolvePublicSchool(req.body.schoolId);
    const result = await portal.login({
      schoolId,
      admissionNo: req.body.admissionNo,
      code:        req.body.code,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return fail(res, err);
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// Everything below needs a portal token
// ═════════════════════════════════════════════════════════════════════════════

router.use(portal.portalAuth);

/**
 * The school heading, EVERY child this code covers, and which one is selected.
 *
 * All of them, not just the selected one: a parent with three at the school
 * needs to switch between them, and a screen that has to fetch the list
 * separately shows an empty switcher on first paint.
 */
router.get("/me", asyncHandler(async (req, res) => {
  const { student, schoolId, studentIds } = req.portal;

  const children = await portal.childrenOf(schoolId, studentIds);

  const classIds = children.map((c) => c.classId).filter(Boolean);
  const classes  = await Class.find({ _id: { $in: classIds }, schoolId })
    .select("name").lean();
  const className = new Map(classes.map((c) => [String(c._id), c.name]));

  return res.json({
    success: true,
    data: {
      school: await schoolHeading(schoolId),
      children: children.map((c) => ({
        ...c,
        className: c.classId ? (className.get(String(c.classId)) ?? null) : null,
      })),
      selectedId: String(student._id),
      student: {
        _id:          String(student._id),
        name:         displayName(student) || null,
        enrollmentNo: student.enrollmentNo ?? null,
        className:    student.classId
          ? (className.get(String(student.classId)) ?? null)
          : null,
        status:       student.status,
      },
    },
  });
}));

/** The fee account: what was charged, what has been paid, what is left. */
router.get("/fees", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;
  const filter = { schoolId, studentId, deletedAt: null };
  if (req.query.academicYear) filter.academicYear = req.query.academicYear;

  const [charges, payments] = await Promise.all([
    FeeCharge.find({ ...filter, voidedAt: null }).sort({ createdAt: 1 }).lean(),
    FeePayment.find(filter).sort({ receivedAt: 1 }).lean(),
  ]);

  const charged = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const waived  = charges.reduce((s, c) => s + (c.waivedAmount ?? 0), 0);
  // Reversals are negative rows, so a plain sum is already net of them.
  const paid    = payments.reduce((s, p) => s + (p.amount ?? 0), 0);

  return res.json({
    success: true,
    data: {
      charges: charges.map((c) => ({
        _id: c._id, label: c.label, code: c.code,
        amount: c.amount, waivedAmount: c.waivedAmount,
        academicYear: c.academicYear, term: c.term,
      })),
      payments: payments.map((p) => ({
        _id: p._id, receiptNo: p.receiptNo, amount: p.amount,
        method: p.method, reference: p.reference, receivedAt: p.receivedAt,
        academicYear: p.academicYear,
        isReversal: Boolean(p.reversesId) || (p.amount ?? 0) < 0,
      })),
      totals: { charged, waived, paid, balance: charged - waived - paid },
    },
  });
}));

/**
 * A printable receipt for one payment.
 *
 * The payment is looked up with the token's student id in the filter, so a
 * guardian who edits the id in the URL gets a 404 rather than someone else's
 * receipt.
 */
router.get("/receipt/:paymentId", asyncHandler(async (req, res) => {
  const { studentId, schoolId, student } = req.portal;

  const payment = await FeePayment.findOne({
    _id: req.params.paymentId, studentId, schoolId, deletedAt: null,
  }).lean();

  if (!payment) {
    return res.status(404).json({ success: false, message: "Receipt not found" });
  }

  const [charges, payments, klass] = await Promise.all([
    FeeCharge.find({ schoolId, studentId, deletedAt: null, voidedAt: null }).lean(),
    FeePayment.find({ schoolId, studentId, deletedAt: null }).lean(),
    student.classId
      ? Class.findOne({ _id: student.classId, schoolId }).select("name").lean()
      : null,
  ]);

  const charged = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const waived  = charges.reduce((s, c) => s + (c.waivedAmount ?? 0), 0);
  const paid    = payments.reduce((s, p) => s + (p.amount ?? 0), 0);

  const data = {
    school: await schoolHeading(schoolId),
    student: {
      name: displayName(student) || null,
      enrollmentNo: student.enrollmentNo ?? null,
      className: klass?.name ?? null,
    },
    payment,
    totals: { charged, waived, paid, balance: charged - waived - paid },
  };

  const lang = req.query.lang;
  const html = buildReceiptHtml({
    data,
    labels:    labelsFor(lang),
    lang,
    // The date the money changed hands, not today — a receipt reprinted in
    // March for a payment made in October is still October's receipt.
    printedOn: formatPrintDate(new Date(payment.receivedAt ?? Date.now()), lang),
    origin:    originOf(req),
  });

  res.type("html");
  return res.send(html);
}));

/** Published results only — a draft is a teacher's working copy. */
router.get("/results", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const rows = await ResultSummary.find({
    schoolId, studentId, isPublished: true, deletedAt: null,
  }).sort({ academicYear: -1, term: -1 }).lean();

  return res.json({
    success: true,
    data: rows.map((r) => ({
      _id: r._id, academicYear: r.academicYear, term: r.term,
      className: r.className, average: r.average, percentage: r.percentage,
      overallGrade: r.overallGrade, classPosition: r.classPosition,
      totalInClass: r.totalInClass, isPassing: r.isPassing,
      subjects: (r.subjectBreakdown ?? []).map((s) => ({
        subjectName: s.subjectName, normalizedMark: s.normalizedMark,
        grade: s.grade, isPassing: s.isPassing, isAbsent: s.isAbsent,
      })),
    })),
  });
}));

/**
 * GET /api/portal/results/:summaryId/report-card
 *
 * The printable card for one published result.
 *
 * Serves the FROZEN copy the school issued, never a re-render. A parent
 * opening this two years from now must see the card as issued, even after the
 * school has edited its template or corrected another student's marks — which
 * is the whole reason GeneratedReport stores renderedHtml.
 *
 * Scoped to this guardian's own student and to published results, so the
 * summary id alone cannot be used to read another child's card.
 */
router.get("/results/:summaryId/report-card", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const summary = await ResultSummary.findOne({
    _id:         req.params.summaryId,
    studentId,
    schoolId,
    isPublished: true,
    deletedAt:   null,
  }).select("examId term academicYear").lean();

  if (!summary) {
    return res.status(404).json({
      success: false,
      error:   "Result not found",
    });
  }

  const report = await GeneratedReport.findOne({
    examId:    summary.examId,
    studentId,
    deletedAt: null,
  }).select("renderedHtml templateVersion updatedAt").lean();

  if (!report?.renderedHtml) {
    // Published marks but no issued card: the school has not printed one yet.
    // Say so plainly rather than inventing a layout the school never approved.
    return res.status(404).json({
      success: false,
      error:   "No report card has been issued for this result yet",
      code:    "NOT_ISSUED",
    });
  }

  return res.json({
    success: true,
    data: {
      html:         report.renderedHtml,
      term:         summary.term,
      academicYear: summary.academicYear,
      issuedAt:     report.updatedAt,
    },
  });
}));

/** Attendance, summarised. A parent wants the pattern, not 180 rows. */
router.get("/attendance", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const filter = { schoolId, studentId };
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = String(req.query.from);
    if (req.query.to)   filter.date.$lte = String(req.query.to);
  }

  const rows = await StudentAttendance.find(filter).sort({ date: -1 }).limit(400).lean();

  const tally = rows.reduce((acc, r) => {
    const k = String(r.status ?? "unknown");
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const present = tally.present ?? 0;
  const total   = rows.length;

  return res.json({
    success: true,
    data: {
      tally,
      total,
      // Null rather than 0 when nothing is recorded: "0% attendance" is a
      // frightening thing to show a parent when the truth is "not yet marked".
      rate: total > 0 ? Math.round((present / total) * 100) : null,
      recent: rows.slice(0, 30).map((r) => ({
        date: r.date, status: r.status, subjectId: r.subjectId ?? null,
      })),
    },
  });
}));

/** School announcements a parent should see. */
router.get("/announcements", asyncHandler(async (req, res) => {
  const { schoolId, student } = req.portal;

  const rows = await Announcement.find({
    schoolId,
    deletedAt: null,
    $or: [
      { audience: { $in: ["all", "parents", "students"] } },
      { audience: { $exists: false } },
      { classId: student.classId },
    ],
  }).sort({ createdAt: -1 }).limit(30).lean();

  return res.json({
    success: true,
    data: rows.map((a) => ({
      _id: a._id, title: a.title, body: a.body ?? a.message ?? null,
      createdAt: a.createdAt, priority: a.priority ?? null,
    })),
  });
}));

module.exports = router;
