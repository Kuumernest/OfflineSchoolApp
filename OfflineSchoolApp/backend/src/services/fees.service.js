// backend/src/services/fees.service.js
"use strict";

const Counter     = require("../db/models/Counter");
const FeeCharge   = require("../db/models/FeeCharge");
const FeePayment  = require("../db/models/FeePayment");
const FeeStructure = require("../db/models/FeeStructure");
const School       = require("../db/models/School");
const Student      = require("../db/models/Student");
const { yearKey, yearForms } = require("./rankingScope.service");
const { currentAcademicYearOf } = require("../../../shared/academicYear");

/** What a late fee is raised as (feeReminders.service PENALTY_CODE). */
const LATE_CODE = "LATE";

/**
 * Everything that knows how a balance is calculated.
 *
 * Kept in one module on purpose: the moment a second screen works out
 * "charged minus paid" for itself, the two answers drift and nobody can say
 * which is right. Routes ask this service; it does the arithmetic.
 */

// ─────────────────────────────────────────────────────────────────────────────
// RECEIPT NUMBERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Next gapless receipt number for a school and year, e.g. "RCT-2026-0042".
 *
 * findOneAndUpdate with $inc is atomic, so two bursars syncing at the same
 * instant get different numbers. This is deliberately server-side only — a
 * phone that has been offline for two days cannot know what the last number
 * was, and two phones guessing would both mint the same one.
 */
const nextReceiptNo = async (schoolId, academicYear) => {
  const key = `receiptNo:${schoolId}:${academicYear}`;
  const counter = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 }, $setOnInsert: { schoolId } },
    { upsert: true, returnDocument: 'after' }
  );
  return `RCT-${academicYear}-${String(counter.seq).padStart(4, "0")}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE
// ─────────────────────────────────────────────────────────────────────────────

const NOT_VOID    = { voidedAt: null, deletedAt: null };
const NOT_DELETED = { deletedAt: null };

/**
 * The balance for one student in one academic year.
 *
 * Two aggregations rather than one lookup-join: charges and payments are
 * independent sums, and asking the database for each separately is both faster
 * and far easier to read than a pipeline that tries to do it in one pass.
 *
 * @returns {Promise<{charged:number, waived:number, paid:number, balance:number}>}
 */
const balanceFor = async ({ schoolId, studentId, academicYear }) => {
  const scope = { schoolId, studentId };
  if (academicYear) scope.academicYear = academicYear;

  const [chargeAgg, paymentAgg] = await Promise.all([
    FeeCharge.aggregate([
      { $match: { ...scope, ...NOT_VOID } },
      {
        $group: {
          _id:     null,
          charged: { $sum: "$amount" },
          waived:  { $sum: { $ifNull: ["$waivedAmount", 0] } },
        },
      },
    ]),
    // Reversals are stored as negative rows, so a plain sum already nets them
    // off — there is no special case to forget.
    FeePayment.aggregate([
      { $match: { ...scope, ...NOT_DELETED } },
      { $group: { _id: null, paid: { $sum: "$amount" } } },
    ]),
  ]);

  const charged = chargeAgg[0]?.charged ?? 0;
  const waived  = chargeAgg[0]?.waived  ?? 0;
  const paid    = paymentAgg[0]?.paid   ?? 0;

  return {
    charged,
    waived,
    paid,
    // Never negative in the "owes" sense; an overpayment shows as a credit.
    balance: charged - waived - paid,
  };
};

/**
 * Balances for many students at once — the arrears report.
 *
 * One aggregation per collection for the whole set, then joined in memory.
 * The alternative, calling balanceFor() per student, is a round trip each and
 * turns a 400-student class into 800 queries.
 */
const balancesFor = async ({ schoolId, studentIds, academicYear }) => {
  if (!studentIds?.length) return new Map();

  const scope = { schoolId, studentId: { $in: studentIds } };
  if (academicYear) scope.academicYear = academicYear;

  const [charges, payments] = await Promise.all([
    FeeCharge.aggregate([
      { $match: { ...scope, ...NOT_VOID } },
      {
        $group: {
          _id:     "$studentId",
          charged: { $sum: "$amount" },
          waived:  { $sum: { $ifNull: ["$waivedAmount", 0] } },
        },
      },
    ]),
    FeePayment.aggregate([
      { $match: { ...scope, ...NOT_DELETED } },
      { $group: { _id: "$studentId", paid: { $sum: "$amount" } } },
    ]),
  ]);

  const out = new Map();
  const ensure = (id) =>
    out.get(id) ?? out.set(id, { charged: 0, waived: 0, paid: 0, balance: 0 }).get(id);

  for (const c of charges) {
    const row = ensure(String(c._id));
    row.charged = c.charged ?? 0;
    row.waived  = c.waived  ?? 0;
  }
  for (const p of payments) {
    const row = ensure(String(p._id));
    row.paid = p.paid ?? 0;
  }
  for (const row of out.values()) {
    row.balance = row.charged - row.waived - row.paid;
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// APPLYING A STRUCTURE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raise charges for a set of students from a structure.
 *
 * Idempotent by construction: the (studentId, structureId, code, term) index is
 * unique, so running this twice for the same class raises nothing the second
 * time. Billing a class twice because someone double-clicked is exactly the
 * failure this has to be immune to.
 *
 * @returns {Promise<{raised:number, skipped:number}>}
 */
const applyStructure = async ({ structure, students, raisedBy }) => {
  const rows = [];

  for (const student of students) {
    for (const item of structure.items) {
      if (item.isOptional) continue;   // opt-in items are billed explicitly
      rows.push({
        schoolId:     structure.schoolId,
        studentId:    String(student._id),
        academicYear: structure.academicYear,
        term:         structure.term ?? null,
        structureId:  String(structure._id),
        // Copied onto the charge rather than read back through the structure
        // every time. A charge is the thing that is owed, and it has to keep
        // the deadline it was raised under: a school that publishes a corrected
        // structure next term must not silently move the date on bills already
        // sent to families.
        dueDate:      structure.dueDate ?? null,
        // The student's own class, not the structure's — a structure that
        // covers several classes must still record which one each charge
        // belongs to, or the arrears-by-class report cannot group them.
        classId:      student.classId ?? null,
        code:         item.code,
        label:        item.label,
        amount:       item.amount,
        raisedBy:     raisedBy ?? null,
      });
    }
  }

  if (!rows.length) return { raised: 0, skipped: 0 };

  // ordered:false so one duplicate does not abort the rest of the class.
  try {
    const inserted = await FeeCharge.insertMany(rows, { ordered: false });
    return { raised: inserted.length, skipped: rows.length - inserted.length };
  } catch (err) {
    // A duplicate-key error here is the expected outcome of a replay, not a
    // failure: it means those charges already exist.
    if (err?.code === 11000 || err?.writeErrors) {
      const raised = err.result?.nInserted ?? err.insertedDocs?.length ?? 0;
      return { raised, skipped: rows.length - raised };
    }
    throw err;
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// OUTSTANDING — the one figure for Fees > Outstanding, Financial reports and
// the platform dashboard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who a school's outstanding fees are owed by: its current students —
 * approved, active, not deleted. A withdrawn, suspended, graduated or deleted
 * student's charges are not "outstanding" (decided 2026-10-27).
 */
const CURRENT_STUDENT = { deletedAt: null, status: "approved", isActive: { $ne: false } };

/**
 * What each school is owed, for its current students in one academic year.
 *
 * - charges: not voided, not deleted; minus what was waived;
 * - payments: not deleted; a reversal is a negative row and nets off;
 * - the year: `academicYear` when given, else each school's current year
 *   (School.settings.academicYear, the calendar's when unset);
 * - outstanding: the sum of each student's POSITIVE balance — one family's
 *   credit does not hide another's debt (decided 2026-10-27).
 *
 * Fees > Outstanding and Financial reports showed 1,900,000 and 9,820,000 for
 * the same school: the second counted every charge ever raised, departed and
 * deleted students included, and netted credits against debts.
 *
 * One query for the students, one aggregation each for charges and payments,
 * whatever the number of schools.
 *
 * @param {object} p
 * @param {string[]} p.schoolIds
 * @param {string|null} [p.academicYear]  one year for every school
 * @param {string|null} [p.classId]
 * @param {boolean} [p.withRows]  include each owing student's row
 * @returns {Promise<Map<string, {academicYear, charged, waived, billed, paid,
 *   outstanding, owing, rows?}>>}  keyed by schoolId
 */
const outstandingBySchool = async ({ schoolIds, academicYear = null, classId = null, withRows = false }) => {
  const ids = [...new Set((schoolIds || []).map(String))];
  const out = new Map();
  if (!ids.length) return out;

  const schools = await School.find({ _id: { $in: ids } }).select("_id settings.academicYear").lean();
  const yearOf = new Map(ids.map((id) => {
    const school = schools.find((s) => String(s._id) === id);
    return [id, academicYear ? yearKey(academicYear) : currentAcademicYearOf(school)];
  }));

  const students = await Student.find({
    schoolId: { $in: ids }, ...CURRENT_STUDENT, ...(classId ? { classId } : {}),
  }).select("_id schoolId studentName name firstName lastName enrollmentNo classId").lean();

  const studentIds = students.map((s) => String(s._id));
  const years = [...new Set([...yearOf.values()].flatMap(yearForms))];
  const scope = { schoolId: { $in: ids }, studentId: { $in: studentIds }, academicYear: { $in: years } };

  const [charges, payments] = studentIds.length ? await Promise.all([
    FeeCharge.aggregate([
      { $match: { ...scope, ...NOT_VOID } },
      { $group: {
        _id: { student: "$studentId", year: "$academicYear" },
        charged: { $sum: "$amount" },
        waived:  { $sum: { $ifNull: ["$waivedAmount", 0] } },
      } },
    ]),
    FeePayment.aggregate([
      { $match: { ...scope, ...NOT_DELETED } },
      { $group: { _id: { student: "$studentId", year: "$academicYear" }, paid: { $sum: "$amount" } } },
    ]),
  ]) : [[], []];

  const schoolOf = new Map(students.map((s) => [String(s._id), String(s.schoolId)]));
  // Only the rows in each student's own school's year.
  const inYear = (row) => yearKey(row._id.year) === yearOf.get(schoolOf.get(String(row._id.student)));
  const balances = new Map();
  const ensure = (sid) =>
    balances.get(sid) ?? balances.set(sid, { charged: 0, waived: 0, paid: 0 }).get(sid);
  for (const c of charges.filter(inYear)) {
    const b = ensure(String(c._id.student));
    b.charged += c.charged ?? 0;
    b.waived  += c.waived  ?? 0;
  }
  for (const p of payments.filter(inYear)) ensure(String(p._id.student)).paid += p.paid ?? 0;

  for (const id of ids) {
    out.set(id, { academicYear: yearOf.get(id), charged: 0, waived: 0, billed: 0, paid: 0,
      outstanding: 0, owing: 0, ...(withRows ? { rows: [] } : {}) });
  }
  for (const s of students) {
    const sid = String(s._id);
    const b = balances.get(sid);
    if (!b) continue;
    const total = out.get(String(s.schoolId));
    const balance = b.charged - b.waived - b.paid;
    total.charged += b.charged;
    total.waived  += b.waived;
    total.paid    += b.paid;
    if (balance > 0) {
      total.outstanding += balance;
      total.owing += 1;
      if (withRows) {
        total.rows.push({
          studentId: sid, student: s, enrollmentNo: s.enrollmentNo ?? null, classId: s.classId ?? null,
          charged: b.charged, waived: b.waived, paid: b.paid, balance,
        });
      }
    }
  }
  for (const total of out.values()) {
    total.billed = total.charged - total.waived;
    if (withRows) total.rows.sort((a, b) => b.balance - a.balance);
  }
  return out;
};

/** One school's outstanding fees (outstandingBySchool). */
const outstandingFor = async ({ schoolId, academicYear = null, classId = null, withRows = false }) =>
  (await outstandingBySchool({ schoolIds: [schoolId], academicYear, classId, withRows })).get(String(schoolId));

// ─────────────────────────────────────────────────────────────────────────────
// BILLING A NEWCOMER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The school's current academic year, as School.settings.academicYear keeps it
 * ("2026/2027"; "2026-2027" is the same year), or null when none is set.
 *
 * Nothing is billed automatically without one. Guessing the year from the
 * calendar would bill a family for the wrong year's price list, and an unset
 * year is something the office can see and fix; a wrong bill is not.
 */
const currentYearOf = async (schoolId) => {
  const school = await School.findById(schoolId).select("settings.academicYear").lean().catch(() => null);
  const year   = yearKey(school?.settings?.academicYear);
  return year || null;
};

const voidCharges = async (filter, { by, reason }) => {
  const res = await FeeCharge.updateMany(
    { ...filter, voidedAt: null, deletedAt: null, code: { $ne: LATE_CODE } },
    { $set: { voidedAt: new Date(), voidedBy: by ?? null, voidReason: reason } }
  );
  return res.modifiedCount ?? 0;
};

/**
 * Bill one student from every active structure that covers their class, for
 * the school's CURRENT academic year.
 *
 * A structure is applied from a button, to the approved students who exist at
 * that moment. Anyone admitted, approved, restored or moved into a class
 * afterwards missed it. Every entry point that puts a student into a class
 * calls this, so the class's fees follow the student in. Full amounts: a
 * student who joins mid-year owes the class's fees like everyone in it, and an
 * individual reduction is a waiver, which has an approval behind it.
 *
 * Only the current year's structures. Structures are not switched off when a
 * year ends, so "every active structure for this class" also meant last
 * year's, and a newcomer could be billed for a year they were never here.
 *
 * Only an approved student. The callers all approve first, but the rule lives
 * here so a new caller cannot bill an applicant.
 *
 * leavingOtherClasses (a transfer): the student's charges for the year from
 * class structures that do NOT cover the new class are voided first. Charges
 * from a school-wide structure stay (it bills the new class too), and so do
 * late fees, which were earned. Payments are untouched: they belong to the
 * student and the year, not to a charge, so what was paid counts against the
 * new class's fees.
 *
 * Self-limiting: applyStructure()'s unique (studentId, structureId, code, term)
 * index means a student already billed by a structure is not billed again by
 * it, so replays and double submissions raise nothing.
 *
 * Never throws: a billing failure must not fail an admission or a move.
 *
 * @returns {Promise<{structures:number, raised:number, skipped:number, voided:number, reason?:string, error?:string}>}
 */
const applyActiveStructuresForStudent = async ({ schoolId, student, raisedBy, leavingOtherClasses = false }) => {
  const none      = { structures: 0, raised: 0, skipped: 0, voided: 0 };
  const classId   = student?.classId ? String(student.classId) : null;
  const studentId = student?._id     ? String(student._id)     : null;
  if (!schoolId || !studentId || !classId) return none;

  try {
    const row = await Student.findOne({ _id: studentId, schoolId: String(schoolId) })
      .select("status deletedAt").lean();
    if (!row || row.deletedAt || row.status !== "approved") {
      return { ...none, reason: "NOT_APPROVED" };
    }

    const year = await currentYearOf(schoolId);
    if (!year) {
      console.warn(`[fees] No current academic year for school ${schoolId}: student ${studentId} not billed`);
      return { ...none, reason: "NO_CURRENT_YEAR" };
    }

    let voided = 0;
    if (leavingOtherClasses) {
      const elsewhere = await FeeStructure.find({
        schoolId,
        academicYear: { $in: yearForms(year) },
        deletedAt:    null,
        "classIds.0": { $exists: true },   // class structures only, never school-wide
        classIds:     { $ne: classId },
      }).select("_id").lean();
      if (elsewhere.length) {
        voided = await voidCharges(
          { schoolId, studentId, structureId: { $in: elsewhere.map((x) => String(x._id)) } },
          { by: raisedBy, reason: "Moved to another class" }
        );
      }
    }

    const structures = await FeeStructure.find({
      schoolId,
      academicYear: { $in: yearForms(year) },
      isActive:     true,
      deletedAt:    null,
      $or: [
        { classIds: classId },        // a structure naming this class
        { classIds: { $size: 0 } },   // an empty list means school-wide
      ],
    }).lean();

    let raised  = 0;
    let skipped = 0;
    for (const structure of structures) {
      const result = await applyStructure({
        structure,
        students: [{ _id: studentId, classId }],
        raisedBy,
      });
      raised  += result.raised;
      skipped += result.skipped;
    }

    if (raised > 0 || voided > 0) {
      console.log(
        `[fees] Student ${studentId}: ${raised} charge(s) raised from ` +
        `${structures.length} structure(s) for ${year}` +
        (voided ? `, ${voided} charge(s) from the previous class voided` : "")
      );
    }
    return { structures: structures.length, raised, skipped, voided };
  } catch (err) {
    console.warn(`[fees] Auto-billing student ${studentId} failed:`, err.message);
    return { ...none, error: err.message };
  }
};

/**
 * Applying a replacement structure voids what the one it replaces charged.
 *
 * A price list cannot be edited once published: the school deactivates it and
 * publishes a corrected one. Applying the new one used to leave the old one's
 * charges standing, so the class owed both. Now, for each student this apply
 * covers, the charges from an INACTIVE structure for the same year and term
 * that billed the same student's class (class-specific for class-specific,
 * school-wide for school-wide) are voided. Payments are untouched and count
 * against the new charges. Late fees stay.
 *
 * @returns {Promise<number>} charges voided
 */
const voidReplacedCharges = async ({ structure, students, by }) => {
  const schoolWide = !(structure.classIds ?? []).length;
  const replaced = await FeeStructure.find({
    schoolId:     structure.schoolId,
    academicYear: { $in: yearForms(structure.academicYear) },
    term:         structure.term ?? null,
    _id:          { $ne: String(structure._id) },
    isActive:     false,
    deletedAt:    null,
    ...(schoolWide ? { classIds: { $size: 0 } } : { "classIds.0": { $exists: true } }),
  }).lean();
  if (!replaced.length) return 0;

  let voided = 0;
  for (const old of replaced) {
    const covered = students.filter((s) =>
      schoolWide || (old.classIds ?? []).includes(String(s.classId)));
    if (!covered.length) continue;
    voided += await voidCharges(
      {
        schoolId:    structure.schoolId,
        structureId: String(old._id),
        studentId:   { $in: covered.map((s) => String(s._id)) },
      },
      { by, reason: "Replaced by a new fee structure" }
    );
  }
  return voided;
};

/**
 * The ledger as a family — or the pupil — reads it.
 *
 * Non-voided charges with what was waived, every payment with its receipt
 * number and whether it reverses another, and the totals; no cashier's name,
 * no internal note, no voided row. The redaction lives here once: the guardian
 * portal and the pupil's own route both answer with this, so the two cannot
 * drift into one of them showing what the other hides.
 */
async function familyLedger({ schoolId, studentId, academicYear = null }) {
  const filter = { schoolId: String(schoolId), studentId: String(studentId), deletedAt: null };
  if (academicYear) filter.academicYear = String(academicYear);

  // Ordered by time and then by id: rows raised together (one structure's
  // items share a createdAt) came back in whichever order the chosen index
  // walked them, which changed when an index was added. A ledger a family
  // reads should not reorder itself between two visits.
  const [charges, payments] = await Promise.all([
    FeeCharge.find({ ...filter, voidedAt: null }).sort({ createdAt: 1, _id: 1 }).lean(),
    FeePayment.find(filter).sort({ receivedAt: 1, _id: 1 }).lean(),
  ]);

  const charged = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const waived  = charges.reduce((s, c) => s + (c.waivedAmount ?? 0), 0);
  // Reversals are negative rows, so a plain sum is already net of them.
  const paid    = payments.reduce((s, p) => s + (p.amount ?? 0), 0);

  return {
    charges: charges.map((c) => ({
      _id: c._id, label: c.label, code: c.code,
      amount: c.amount, waivedAmount: c.waivedAmount,
      academicYear: c.academicYear, term: c.term, dueDate: c.dueDate ?? null,
    })),
    payments: payments.map((p) => ({
      _id: p._id, receiptNo: p.receiptNo, amount: p.amount,
      method: p.method, reference: p.reference, receivedAt: p.receivedAt,
      academicYear: p.academicYear,
      isReversal: Boolean(p.reversesId) || (p.amount ?? 0) < 0,
    })),
    totals: { charged, waived, paid, balance: charged - waived - paid },
  };
}

module.exports = {
  nextReceiptNo,
  balanceFor,
  familyLedger,
  balancesFor,
  applyStructure,
  applyActiveStructuresForStudent,
  voidReplacedCharges,
  currentYearOf,
  outstandingBySchool,
  outstandingFor,
  CURRENT_STUDENT,
};

