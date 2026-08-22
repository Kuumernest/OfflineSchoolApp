// backend/src/export/exports.js
"use strict";

const Student         = require("../db/models/Student");
const Class           = require("../db/models/Class");
const FeeCharge       = require("../db/models/FeeCharge");
const FeePayment      = require("../db/models/FeePayment");
const Expense         = require("../db/models/Expense");
const ExpenseCategory = require("../db/models/ExpenseCategory");
const SalaryPayment   = require("../db/models/SalaryPayment");
const PayrollRun      = require("../db/models/PayrollRun");
const User            = require("../db/models/User");
const Enrollment      = require("../db/models/Enrollment");

const { text, money, number, date, buildWorkbook, safeFileName } = require("./workbook");
const { labelsFor } = require("./labels");
const { displayName, byName } = require("../utils/studentName");

/**
 * What can be exported, and how each is put together.
 *
 * Every export is defined as one object with a `build` that returns sheets, so
 * adding a new one is a definition rather than a new endpoint. The route below
 * looks the kind up here and knows nothing else about it.
 *
 * Two rules run through all of them, and both come from the ledgers:
 *
 *   · Voided and reversed rows are EXPORTED, not filtered out, and marked as
 *     such. A spreadsheet a bursar reconciles against the books has to contain
 *     the same rows the books do — silently dropping a reversal produces a file
 *     that disagrees with the system and looks like the system is wrong.
 *
 *   · Every total is summed here from the same rows, so the figure at the top
 *     of the file always reconciles with the rows beneath it.
 */

const asDate = (v) => (v ? new Date(v) : null);

const dateRange = (from, to) => {
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to)   range.$lte = new Date(to);
  return Object.keys(range).length ? range : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENTS
// ─────────────────────────────────────────────────────────────────────────────

const students = {
  key: "students",
  roles: ["admin", "school_admin", "super_admin", "teacher"],
  build: async ({ schoolId, query, L }) => {
    const filter = { schoolId, deletedAt: null };
    filter.status = query.status || "approved";
    if (query.classId) filter.classId = query.classId;

    const [rows, classes] = await Promise.all([
      Student.find(filter)
        .select("studentName name firstName lastName enrollmentNo gender dateOfBirth phone " +
                "guardianName guardianPhone guardianEmail classId status enrolledAt")
        .lean(),
      Class.find({ schoolId, deletedAt: null }).select("name").lean(),
    ]);

    const className = new Map(classes.map((c) => [String(c._id), c.name]));

    const list = rows
      .map((s) => ({
        ...s,
        _name: displayName(s),
        _class: className.get(String(s.classId)) ?? "",
      }))
      // Unnamed rows last — see utils/studentName.
      .sort(byName);

    return {
      fileName: safeFileName([L.students, query.classId ? className.get(String(query.classId)) : null]),
      sheets: [{
        name: L.students,
        rows: list,
        columns: [
          { label: L.no,           width: 6,  cell: (_r, i) => number(i) },
          { label: L.name,         width: 28, cell: (r) => text(r._name) },
          { label: L.admissionNo,  width: 20, cell: (r) => text(r.enrollmentNo) },
          { label: L.class,        width: 16, cell: (r) => text(r._class) },
          { label: L.gender,       width: 10, cell: (r) => text(r.gender) },
          { label: L.dateOfBirth,  width: 14, cell: (r) => date(r.dateOfBirth) },
          { label: L.phone,        width: 16, cell: (r) => text(r.phone) },
          { label: L.guardian,     width: 24, cell: (r) => text(r.guardianName) },
          { label: L.guardianPhone,width: 16, cell: (r) => text(r.guardianPhone) },
          { label: L.status,       width: 12, cell: (r) => text(r.status) },
          { label: L.enrolledOn,   width: 14, cell: (r) => date(r.enrolledAt) },
        ],
      }],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FEE ARREARS
// ─────────────────────────────────────────────────────────────────────────────

const arrears = {
  key: "arrears",
  roles: ["admin", "school_admin", "super_admin"],
  build: async ({ schoolId, query, L }) => {
    const year = query.academicYear;
    const match = { schoolId, deletedAt: null };
    if (year) match.academicYear = year;

    const [charges, payments, roster, classes] = await Promise.all([
      FeeCharge.find({ ...match, voidedAt: null }).lean(),
      FeePayment.find(match).lean(),
      Student.find({ schoolId, deletedAt: null })
        .select("studentName name firstName lastName enrollmentNo classId").lean(),
      Class.find({ schoolId, deletedAt: null }).select("name").lean(),
    ]);

    const className = new Map(classes.map((c) => [String(c._id), c.name]));
    const byStudent = new Map();

    const slot = (id) => {
      if (!byStudent.has(id)) {
        byStudent.set(id, { studentId: id, charged: 0, waived: 0, paid: 0 });
      }
      return byStudent.get(id);
    };

    for (const c of charges) {
      const s = slot(String(c.studentId));
      s.charged += c.amount ?? 0;
      s.waived  += c.waivedAmount ?? 0;
    }
    // Reversals are stored negative, so a plain sum is already net of them.
    for (const p of payments) slot(String(p.studentId)).paid += p.amount ?? 0;

    const student = new Map(roster.map((s) => [String(s._id), s]));

    const rows = [...byStudent.values()]
      .map((r) => {
        const s = student.get(r.studentId);
        return {
          ...r,
          name:  displayName(s),
          admissionNo: s?.enrollmentNo ?? "",
          className: className.get(String(s?.classId)) ?? "",
          balance: r.charged - r.waived - r.paid,
        };
      })
      .sort((a, b) => b.balance - a.balance);

    return {
      fileName: safeFileName([L.arrears, year]),
      sheets: [{
        name: L.arrears,
        rows,
        columns: [
          { label: L.name,        width: 28, cell: (r) => text(r.name) },
          { label: L.admissionNo, width: 20, cell: (r) => text(r.admissionNo) },
          { label: L.class,       width: 16, cell: (r) => text(r.className) },
          { label: L.charged,     width: 14, cell: (r) => money(r.charged) },
          { label: L.waived,      width: 14, cell: (r) => money(r.waived) },
          { label: L.paid,        width: 14, cell: (r) => money(r.paid) },
          { label: L.balance,     width: 14, cell: (r) => money(r.balance) },
        ],
      }],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FEE PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────

const payments = {
  key: "payments",
  roles: ["admin", "school_admin", "super_admin"],
  build: async ({ schoolId, query, L }) => {
    const filter = { schoolId, deletedAt: null };
    const range = dateRange(query.from, query.to);
    if (range) filter.receivedAt = range;
    if (query.academicYear) filter.academicYear = query.academicYear;

    const rows = await FeePayment.find(filter).sort({ receivedAt: 1 }).lean();

    const roster = await Student.find({
      schoolId, _id: { $in: rows.map((r) => r.studentId) },
    }).select("studentName name firstName lastName enrollmentNo").lean();
    const student = new Map(roster.map((s) => [String(s._id), s]));

    const withNames = rows.map((p) => {
      const s = student.get(String(p.studentId));
      return {
        ...p,
        name: displayName(s),
        admissionNo: s?.enrollmentNo ?? "",
        // A negative row is a correction, and saying so beats leaving a reader
        // to work it out from the minus sign.
        kind: (p.amount ?? 0) < 0 ? L.reversal : L.payment,
      };
    });

    return {
      fileName: safeFileName([L.payments, query.from, query.to]),
      sheets: [{
        name: L.payments,
        rows: withNames,
        columns: [
          { label: L.receiptNo,   width: 20, cell: (r) => text(r.receiptNo) },
          { label: L.date,        width: 14, cell: (r) => date(r.receivedAt) },
          { label: L.name,        width: 28, cell: (r) => text(r.name) },
          { label: L.admissionNo, width: 20, cell: (r) => text(r.admissionNo) },
          { label: L.academicYear,width: 14, cell: (r) => text(r.academicYear) },
          { label: L.amount,      width: 14, cell: (r) => money(r.amount) },
          { label: L.method,      width: 14, cell: (r) => text(r.method) },
          { label: L.reference,   width: 20, cell: (r) => text(r.reference) },
          { label: L.type,        width: 12, cell: (r) => text(r.kind) },
        ],
      }],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPENSES
// ─────────────────────────────────────────────────────────────────────────────

const expenses = {
  key: "expenses",
  roles: ["admin", "school_admin", "super_admin"],
  build: async ({ schoolId, query, L }) => {
    const filter = { schoolId, deletedAt: null };
    const range = dateRange(query.from, query.to);
    if (range) filter.incurredAt = range;

    const [rows, categories] = await Promise.all([
      Expense.find(filter).sort({ incurredAt: 1 }).lean(),
      ExpenseCategory.find({ schoolId, deletedAt: null }).select("label").lean(),
    ]);

    const label = new Map(categories.map((c) => [String(c._id), c.label]));

    return {
      fileName: safeFileName([L.expenses, query.from, query.to]),
      sheets: [{
        name: L.expenses,
        rows,
        columns: [
          { label: L.date,        width: 14, cell: (r) => date(r.incurredAt) },
          { label: L.category,    width: 22, cell: (r) => text(label.get(String(r.categoryId))) },
          { label: L.description, width: 32, cell: (r) => text(r.description) },
          { label: L.vendor,      width: 22, cell: (r) => text(r.vendor) },
          { label: L.amount,      width: 14, cell: (r) => money(r.amount) },
          { label: L.method,      width: 14, cell: (r) => text(r.method) },
          { label: L.reference,   width: 20, cell: (r) => text(r.reference) },
          // Voided rows stay in the file and are marked. A reconciliation
          // against a file that quietly dropped them cannot ever balance.
          { label: L.voided,      width: 12, cell: (r) => text(r.voidedAt ? L.yes : "") },
          { label: L.voidReason,  width: 28, cell: (r) => text(r.voidReason) },
        ],
      }],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PAYROLL
// ─────────────────────────────────────────────────────────────────────────────

const payroll = {
  key: "payroll",
  roles: ["admin", "school_admin", "super_admin"],
  build: async ({ schoolId, query, L }) => {
    const filter = { schoolId, deletedAt: null };
    if (query.periodMonth) filter.periodMonth = query.periodMonth;
    // Drafts are excluded: nobody has been paid from them, so putting them in a
    // payroll export would overstate what the school has spent.
    filter.status = { $ne: "draft" };

    const [slips, runs] = await Promise.all([
      SalaryPayment.find(filter).sort({ periodMonth: 1 }).lean(),
      PayrollRun.find({ schoolId, deletedAt: null }).lean(),
    ]);

    const staffRows = await User.find({
      schoolId, _id: { $in: slips.map((s) => s.userId) },
    }).select("name email role").lean();
    const staff = new Map(staffRows.map((u) => [String(u._id), u]));

    const runStatus = new Map(runs.map((r) => [String(r._id), r.status]));

    return {
      fileName: safeFileName([L.payroll, query.periodMonth]),
      sheets: [{
        name: L.payroll,
        rows: slips,
        columns: [
          { label: L.payslipNo,  width: 20, cell: (r) => text(r.payslipNo) },
          { label: L.month,      width: 12, cell: (r) => text(r.periodMonth) },
          { label: L.staff,      width: 26, cell: (r) => text(staff.get(String(r.userId))?.name) },
          { label: L.role,       width: 14, cell: (r) => text(staff.get(String(r.userId))?.role) },
          { label: L.basePay,    width: 14, cell: (r) => money(r.baseAmount) },
          { label: L.allowances, width: 14,
            cell: (r) => money((r.allowances ?? []).reduce((s, a) => s + (a.amount ?? 0), 0)) },
          { label: L.deductions, width: 14, cell: (r) => money(r.totalDeductions) },
          { label: L.gross,      width: 14, cell: (r) => money(r.gross) },
          { label: L.net,        width: 14, cell: (r) => money(r.net) },
          { label: L.method,     width: 14, cell: (r) => text(r.method) },
          { label: L.paidOn,     width: 14, cell: (r) => date(r.paidAt) },
          // Both halves of a reversal are present so the Net column sums to what
          // was actually paid. The mirror row is labelled rather than left as a
          // bare negative: its own status is "paid" — it IS a payment, just a
          // negative one — and it deliberately carries no runId, so without
          // this column it reads as an unexplained minus with a blank run.
          { label: L.type,       width: 12,
            cell: (r) => text(r.reversesId ? L.reversal : L.payment) },
          { label: L.status,     width: 14, cell: (r) => text(r.status) },
          { label: L.runStatus,  width: 14, cell: (r) => text(runStatus.get(String(r.runId)) ?? "") },
        ],
      }],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CLASS HISTORY
// ─────────────────────────────────────────────────────────────────────────────

const enrollments = {
  key: "enrollments",
  roles: ["admin", "school_admin", "super_admin"],
  build: async ({ schoolId, query, L }) => {
    const filter = { schoolId, deletedAt: null };
    if (query.academicYear) filter.academicYear = query.academicYear;

    const rows = await Enrollment.find(filter)
      .sort({ academicYear: 1, className: 1 }).lean();

    const roster = await Student.find({
      schoolId, _id: { $in: rows.map((r) => r.studentId) },
    }).select("studentName name firstName lastName enrollmentNo").lean();
    const student = new Map(roster.map((s) => [String(s._id), s]));

    return {
      fileName: safeFileName([L.classHistory, query.academicYear]),
      sheets: [{
        name: L.classHistory,
        rows,
        columns: [
          { label: L.academicYear, width: 14, cell: (r) => text(r.academicYear) },
          { label: L.name,         width: 28,
            cell: (r) => {
              return text(displayName(student.get(String(r.studentId))));
            } },
          { label: L.admissionNo,  width: 20,
            cell: (r) => text(student.get(String(r.studentId))?.enrollmentNo) },
          { label: L.class,        width: 18, cell: (r) => text(r.className) },
          { label: L.outcome,      width: 14, cell: (r) => text(r.outcome) },
        ],
      }],
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────

const EXPORTS = { students, arrears, payments, expenses, payroll, enrollments };

const KINDS = Object.keys(EXPORTS);

/**
 * The exports one role may actually run.
 *
 * The client builds its menu from this, so a teacher is never shown a Payroll
 * tile that answers 403 when tapped. Offering a control that cannot work is
 * worse than not offering it — and listing every kind regardless of role would
 * do exactly that.
 */
const kindsFor = (role) =>
  KINDS.filter((k) => EXPORTS[k].roles.includes(role));

/**
 * Build one export.
 *
 * @returns {Promise<{ buffer: Buffer, fileName: string, rowCount: number }>}
 */
const buildExport = async ({ kind, schoolId, query, lang, role }) => {
  const def = EXPORTS[kind];
  if (!def) {
    const err = new Error(`Unknown export: ${kind}`);
    err.status = 404;
    err.code = "UNKNOWN_EXPORT";
    throw err;
  }
  if (!def.roles.includes(role)) {
    const err = new Error("You do not have access to that export");
    err.status = 403;
    err.code = "FORBIDDEN_EXPORT";
    throw err;
  }

  const L = labelsFor(lang);
  const { sheets, fileName } = await def.build({ schoolId, query, L });

  const buffer = await buildWorkbook(sheets);
  const rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);

  return { buffer, fileName: `${fileName}.xlsx`, rowCount };
};

module.exports = { EXPORTS, KINDS, kindsFor, buildExport, asDate };
