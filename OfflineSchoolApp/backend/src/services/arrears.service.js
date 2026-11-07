// backend/src/services/arrears.service.js
"use strict";

/**
 * Owed and overdue, for every screen that shows either.
 *
 * The Fees page, the bell's "overdue fees" item, Fee reminders, Students to
 * watch and the parent portal each used to work the figure out their own way,
 * and they disagreed: the bell's "7 families overdue (1,025,000)" was seven
 * pupils' whole balances, while only 420,000 of it was past due. They all read
 * this now. The arithmetic is shared/arrears.js; this loads the ledger for it.
 *
 *   owed     everything unpaid, one academic year — outstandingFor, the Fees
 *            page's own figure, so the two cannot drift apart
 *   overdue  the part of that past its due date (shared/arrears feePosition)
 *
 * One academic year, always: the one asked for, else the school's current
 * year. A debt from an earlier year is read by asking for that year.
 */

const FeeCharge      = require("../db/models/FeeCharge");
const PaymentPlan    = require("../db/models/PaymentPlan");
const GuardianAccess = require("../db/models/GuardianAccess");
const { outstandingFor }  = require("./fees.service");
const { yearForms }       = require("./rankingScope.service");
const { feePosition, familyCount } = require("../../../shared/arrears");

/**
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string} [p.academicYear]    default: the school's current year
 * @param {string} [p.classId]
 * @param {string[]} [p.onlyStudentIds] one family's children (the parent portal)
 * @param {Date}   [p.asOf]
 * @returns {Promise<{
 *   academicYear: string|null,
 *   rows: Array<{ studentId, student, classId, enrollmentNo, charged, waived, paid,
 *                 owed, overdue, notYetDue, isOverdue, overdueSince, nextDue,
 *                 latestDue, datedCharges, undatedCharges, onPlan, plan }>,
 *   totals: { owed, owingStudents, overdue, overdueStudents, overdueFamilies }
 * }>}  rows: every pupil who owes, largest balance first
 */
async function arrearsFor({ schoolId, academicYear = null, classId = null, onlyStudentIds = null, asOf = new Date() }) {
  const base = await outstandingFor({ schoolId, academicYear, classId, withRows: true, onlyStudentIds });
  const year = base?.academicYear ?? null;
  const owing = base?.rows ?? [];
  const empty = { owed: 0, owingStudents: 0, overdue: 0, overdueStudents: 0, overdueFamilies: 0 };
  if (!owing.length || !year) return { academicYear: year, rows: [], totals: empty };

  const ids = owing.map((r) => r.studentId);
  const inYear = { schoolId: String(schoolId), studentId: { $in: ids }, academicYear: { $in: yearForms(year) } };

  const [charges, plans] = await Promise.all([
    FeeCharge.find({ ...inYear, voidedAt: null, deletedAt: null })
      .select("studentId amount waivedAmount dueDate createdAt").lean(),
    PaymentPlan.find({ ...inYear, status: "active", deletedAt: null }).lean(),
  ]);

  const chargesBy = new Map();
  for (const c of charges) {
    const k = String(c.studentId);
    if (!chargesBy.has(k)) chargesBy.set(k, []);
    chargesBy.get(k).push(c);
  }
  const planBy = new Map(plans.map((p) => [String(p.studentId), p]));

  const rows = owing.map((r) => {
    const mine = chargesBy.get(r.studentId) ?? [];
    const pos  = feePosition({ charges: mine, paid: r.paid, plan: planBy.get(r.studentId) ?? null, asOf });
    const dated = mine.filter((c) => c.dueDate);
    return {
      studentId:    r.studentId,
      student:      r.student,
      classId:      r.classId,
      enrollmentNo: r.enrollmentNo,
      charged: r.charged, waived: r.waived, paid: r.paid,
      ...pos,
      latestDue: dated.length ? new Date(Math.max(...dated.map((c) => new Date(c.dueDate).getTime()))) : null,
      datedCharges:   dated.length,
      undatedCharges: mine.length - dated.length,
    };
  });

  const late = rows.filter((r) => r.isOverdue);
  const accesses = late.length
    ? await GuardianAccess.find({
        schoolId: String(schoolId), deletedAt: null, studentIds: { $in: late.map((r) => r.studentId) },
      }).select("studentIds").lean()
    : [];

  return {
    academicYear: year,
    rows,
    totals: {
      owed:            base.outstanding,
      owingStudents:   rows.length,
      overdue:         late.reduce((s, r) => s + r.overdue, 0),
      overdueStudents: late.length,
      overdueFamilies: familyCount(late.map((r) => r.studentId), accesses),
    },
  };
}

module.exports = { arrearsFor };
