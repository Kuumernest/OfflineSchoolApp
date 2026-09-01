// backend/src/services/fees.service.js
"use strict";

const Counter     = require("../db/models/Counter");
const FeeCharge   = require("../db/models/FeeCharge");
const FeePayment  = require("../db/models/FeePayment");
const FeeStructure = require("../db/models/FeeStructure");

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
// BILLING A NEWCOMER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bill one student from every active structure that covers their class.
 *
 * A structure is applied from a button, to the approved students who exist at
 * that moment. Anyone admitted — or moved into a class — afterwards missed it,
 * and their account stayed at zero until a bursar noticed and re-applied the
 * structure by hand. This closes that gap: every entry point that puts a
 * student into a class calls this.
 *
 * Self-limiting, not new arithmetic: it reuses applyStructure(), whose unique
 * (studentId, structureId, code, term) index means a student already billed by
 * a structure is not billed again by it. A structure that covers several
 * classes bills the student's own class items exactly as the button would.
 *
 * Never throws: a billing failure must not fail an admission. Whatever goes
 * wrong is logged and reported in the returned counts instead.
 *
 * @returns {Promise<{structures:number, raised:number, skipped:number}>}
 */
const applyActiveStructuresForStudent = async ({ schoolId, student, raisedBy }) => {
  const classId   = student?.classId ?? null;
  const studentId = student?._id     ? String(student._id) : null;
  if (!schoolId || !studentId || !classId) {
    return { structures: 0, raised: 0, skipped: 0 };
  }

  try {
    const structures = await FeeStructure.find({
      schoolId,
      isActive:  true,
      deletedAt: null,
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

    if (raised > 0) {
      console.log(
        `[fees] ${raised} charge(s) raised for student ${studentId} ` +
        `from ${structures.length} active structure(s)`
      );
    }
    return { structures: structures.length, raised, skipped };
  } catch (err) {
    console.warn(`[fees] Auto-billing student ${studentId} failed:`, err.message);
    return { structures: 0, raised: 0, skipped: 0, error: err.message };
  }
};

module.exports = {
  nextReceiptNo,
  balanceFor,
  balancesFor,
  applyStructure,
  applyActiveStructuresForStudent,
};

