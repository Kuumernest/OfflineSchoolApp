// backend/src/services/payroll.service.js
"use strict";

const { v4: uuidv4 }  = require("uuid");
const Counter         = require("../db/models/Counter");
const SalaryStructure = require("../db/models/SalaryStructure");
const SalaryPayment   = require("../db/models/SalaryPayment");
const PayrollRun      = require("../db/models/PayrollRun");
const TeacherAttendance = require("../db/models/Attendance").TeacherAttendance;

/**
 * Payroll arithmetic, in one place — the same reason fees.service exists.
 *
 * The rule this module enforces: generating payroll produces DRAFTS. Nothing
 * here writes a payment. Confirming a run is a separate, deliberate act.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PERIODS
// ─────────────────────────────────────────────────────────────────────────────

/** Last instant of the month, which is when a monthly salary is considered due. */
const endOfMonth = (periodMonth) => {
  const [y, m] = periodMonth.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
};

// ─────────────────────────────────────────────────────────────────────────────
// PAYSLIP NUMBERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gapless payslip number, e.g. "PSL-2026-08-0007".
 *
 * Assigned only on confirmation. A draft has no number because a draft is not
 * a payslip — numbering one that is later discarded leaves a hole an auditor
 * will ask about.
 */
/**
 * Reserve a contiguous block of payslip numbers in one round trip.
 *
 * Bumping the counter once per payslip meant confirming a run of sixty paid
 * sixty round trips before a single row was written, and reversing one paid
 * them again. A single $inc of the whole count yields the same numbers in
 * the same order: the counter still only ever moves forward, and two runs
 * confirming at once cannot be handed overlapping blocks — which is the
 * property that mattered, and the reason this is a counter and not a
 * COUNT(*) + 1.
 */
const reservePayslipNos = async (schoolId, periodMonth, count) => {
  if (!count || count < 1) return [];
  const counter = await Counter.findOneAndUpdate(
    { _id: `payslipNo:${schoolId}:${periodMonth}` },
    { $inc: { seq: count }, $setOnInsert: { schoolId } },
    { upsert: true, returnDocument: 'after' }
  );
  // After the increment seq is the LAST number of the block.
  const first = counter.seq - count + 1;
  return Array.from(
    { length: count },
    (_, i) => `PSL-${periodMonth}-${String(first + i).padStart(4, "0")}`
  );
};

const nextPayslipNo = async (schoolId, periodMonth) =>
  (await reservePayslipNos(schoolId, periodMonth, 1))[0];

// ─────────────────────────────────────────────────────────────────────────────
// HOURS FROM ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "HH:MM" or "HH:MM:SS" → minutes since midnight, or null when unparseable.
 *
 * Attendance times are free strings from the marking screen; a blank or a
 * malformed value means that day simply cannot be counted, not that it counts
 * as zero-length — the caller drops the day either way, but null keeps
 * "absent" and "present without a readable time" distinguishable in tests.
 */
const timeToMinutes = (value) => {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

/**
 * Minutes a teacher was present on one attendance record, or null.
 *
 * Both ends of the day must be readable, and check-out must be after check-in
 * (a swapped or equal pair is a marking mistake, not a 24-hour shift — schools
 * do not run past midnight, so no overnight wrap). Absent and on_leave days
 * never reach this function; the caller filters on status first.
 */
const dayMinutes = (record) => {
  const inMin  = timeToMinutes(record.checkInTime);
  const outMin = timeToMinutes(record.checkOutTime);
  if (inMin === null || outMin === null || outMin <= inMin) return null;
  return outMin - inMin;
};

/**
 * Hours each teacher was actually present during a month.
 *
 * Reads TeacherAttendance directly — the same register the school already
 * keeps — rather than inventing an hours log nobody fills in. A day counts
 * when its status is present or late (late still means they came) and both
 * times are readable. Days that fail that contribute nothing but do not
 * poison the rest of the month.
 *
 * @returns {Promise<Map<string, { minutes: number, days: number }>>} keyed by
 *   teacherId. `days` counts only the days that contributed minutes, so the
 *   payslip can show "22 days, 162.5 h" honestly.
 */
const hoursWorkedInMonth = async (schoolId, teacherIds, periodMonth) => {
  const result = new Map();
  if (!teacherIds.length) return result;

  // Date is a "YYYY-MM-DD" string, so a prefix match is the whole month and
  // cannot leak into the neighbours the way a $gte/$lte on day ranges can.
  // periodMonth arrives from a request body, so it is escaped before it meets
  // the regex engine — a period of "2026-0(.*" would otherwise match far more
  // than its own month.
  const monthPrefix = String(periodMonth).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const records = await TeacherAttendance.find({
    schoolId,
    teacherId: { $in: teacherIds },
    date:      { $regex: `^${monthPrefix}-` },
    status:    { $in: ["present", "late"] },
  }).select("teacherId checkInTime checkOutTime").lean();

  for (const rec of records) {
    const minutes = dayMinutes(rec);
    if (minutes === null) continue;
    const key  = String(rec.teacherId);
    const slot = result.get(key) ?? { minutes: 0, days: 0 };
    slot.minutes += minutes;
    slot.days    += 1;
    result.set(key, slot);
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTING A PAYSLIP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a structure into the figures for one month.
 *
 * Pure — no database, no clock. That is what makes payroll testable and what
 * lets the same function serve both the preview and the saved snapshot.
 *
 * `hoursWorked` only matters for an hourly structure: base becomes rate ×
 * hours, rounded to whole XAF. It is the caller's job (generateRun) to have
 * looked the hours up; a null here means "no attendance found", and an hourly
 * teacher with no readable attendance is owed nothing for the month rather
 * than their full rate — a fixed monthly salary is the structure that means
 * "paid regardless".
 */
const computeFromStructure = (structure, hoursWorked = null) => {
  const allowances = (structure.allowances ?? []).map((a) => ({
    code: a.code, label: a.label, amount: a.amount ?? 0,
  }));
  const deductions = (structure.deductions ?? []).map((d) => ({
    code: d.code, label: d.label, amount: d.amount ?? 0,
  }));

  const hourly = (structure.payType ?? "monthly") === "hourly";
  const base = hourly
    ? Math.round((structure.baseAmount ?? 0) * (hoursWorked ?? 0))
    : structure.baseAmount ?? 0;

  const gross           = base + allowances.reduce((s, a) => s + a.amount, 0);
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);

  return {
    payType:     hourly ? "hourly" : "monthly",
    hoursWorked: hourly ? hoursWorked : null,
    hourlyRate:  hourly ? (structure.baseAmount ?? 0) : null,
    baseAmount: base,
    allowances,
    deductions,
    gross,
    totalDeductions,
    net: gross - totalDeductions,
  };
};

/**
 * The structure in force for a person at the end of a given month.
 *
 * "In force" means it had started and had not yet been closed. Asking by date
 * rather than taking the latest row is what makes a payslip for March still
 * reproduce March's figures after a June raise.
 */
const structuresInForce = async (schoolId, periodMonth) => {
  const asOf = endOfMonth(periodMonth);
  return SalaryStructure.find({
    schoolId,
    deletedAt:     null,
    effectiveFrom: { $lte: asOf },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: asOf } }],
  }).lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a draft run for a month.
 *
 * Idempotent: the unique index on (schoolId, userId, periodMonth, runId) means
 * re-running against the same run cannot produce a second payslip for anyone.
 *
 * @returns {Promise<{run: object, payslips: object[]}>}
 */
const generateRun = async ({ schoolId, periodMonth, generatedBy }) => {
  const structures = await structuresInForce(schoolId, periodMonth);
  if (!structures.length) {
    const err = new Error("No salary structures are in force for that month");
    err.code = "NO_STRUCTURES";
    throw err;
  }

  // One round trip for every hourly teacher, whatever their number. Monthly
  // structures keep the hours question entirely out of their payslip.
  const hourlyIds = structures
    .filter((s) => (s.payType ?? "monthly") === "hourly")
    .map((s) => String(s.userId));
  const hoursByTeacher = await hoursWorkedInMonth(
    schoolId,
    hourlyIds,
    periodMonth
  );

  const run = await PayrollRun.create({
    schoolId,
    periodMonth,
    status:      "draft",
    generatedBy: generatedBy ?? null,
    staffCount:  structures.length,
  });

  const rows = structures.map((s) => {
    const hourly = (s.payType ?? "monthly") === "hourly";
    // 60 minutes to the hour, kept fractional to two decimals — half hours are
    // real working time, and rounding them off would quietly underpay.
    const slot = hourly ? hoursByTeacher.get(String(s.userId)) : undefined;
    const hoursWorked = slot
      ? Math.round((slot.minutes / 60) * 100) / 100
      : null;
    const figures = computeFromStructure(s, hoursWorked);
    return {
      schoolId,
      userId:      String(s.userId),
      runId:       String(run._id),
      periodMonth,
      structureId: String(s._id),
      ...figures,
      status:      "draft",
    };
  });

  const payslips = await SalaryPayment.insertMany(rows, { ordered: false });

  const totals = payslips.reduce(
    (acc, p) => ({
      gross:      acc.gross + (p.gross ?? 0),
      deductions: acc.deductions + (p.totalDeductions ?? 0),
      net:        acc.net + (p.net ?? 0),
    }),
    { gross: 0, deductions: 0, net: 0 }
  );

  const summary = {
    staffCount:      payslips.length,
    totalGross:      totals.gross,
    totalDeductions: totals.deductions,
    totalNet:        totals.net,
  };

  await PayrollRun.updateOne({ _id: run._id }, summary);

  // Spread the SAME keys the document uses. Spreading `totals` — whose keys are
  // gross/deductions/net — left totalGross/totalNet at their zero defaults, so
  // the response said the run was worth nothing while the payslips beneath it
  // were correct. The stored row was right; only what the caller saw was wrong,
  // which is the kind of mismatch nobody notices until a total is queried.
  return {
    run: { ...run.toObject(), ...summary },
    payslips,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a reviewed draft into payments.
 *
 * Payslip numbers are minted here, one per row, so the sequence contains only
 * payslips that were really issued.
 */
const confirmRun = async ({ schoolId, runId, method, confirmedBy }) => {
  const run = await PayrollRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Payroll run not found");
    err.status = 404;
    throw err;
  }
  // "approved" is confirmable as well as "draft". A school with payroll
  // approval on moves the run draft → approved → confirmed, and this check
  // named only "draft" — which would have refused every run that had just been
  // signed off, the one path the approval step exists to create.
  //
  // Whether approval was REQUIRED is decided at the route, not here: this
  // service is also reachable from a script, and the state machine's job is
  // only to refuse a run that has already been paid or reversed.
  if (!["draft", "approved"].includes(run.status)) {
    const err = new Error(`This run is already ${run.status}`);
    err.code   = "NOT_DRAFT";
    err.status = 409;
    throw err;
  }

  const drafts = await SalaryPayment.find({
    schoolId, runId, status: "draft", deletedAt: null,
  });

  const now     = new Date();
  const numbers = await reservePayslipNos(schoolId, run.periodMonth, drafts.length);

  // Two round trips for the run, whatever its size: the block above, and
  // this. It used to be two per payslip.
  const ops = drafts.map((p, i) => ({
    updateOne: {
      filter: { _id: p._id },
      update: {
        $set: {
          payslipNo: numbers[i],
          status:    "paid",
          method:    method ?? p.method,
          paidAt:    now,
          paidBy:    confirmedBy ?? null,
        },
      },
    },
  }));
  if (ops.length) await SalaryPayment.bulkWrite(ops, { ordered: true });

  run.status      = "confirmed";
  run.confirmedBy = confirmedBy ?? null;
  run.confirmedAt = now;
  await run.save();

  return { run, paid: drafts.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Undo a confirmed run by appending a mirror payslip for each row.
 *
 * The originals stay exactly as issued; the negatives cancel them in every sum.
 */
const reverseRun = async ({ schoolId, runId, reason, reversedBy }) => {
  const run = await PayrollRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Payroll run not found");
    err.status = 404;
    throw err;
  }
  if (run.status !== "confirmed") {
    const err = new Error("Only a confirmed run can be reversed");
    err.code   = "NOT_CONFIRMED";
    err.status = 409;
    throw err;
  }

  const paid = await SalaryPayment.find({
    schoolId, runId, status: "paid", reversesId: null, deletedAt: null,
  });

  const now      = new Date();
  const revNos   = await reservePayslipNos(schoolId, run.periodMonth, paid.length);
  // The reversal ids are settled here rather than by the schema default,
  // because each original has to be pointed at its reversal in the same
  // batch that creates them.
  const revIds   = paid.map(() => uuidv4());
  const reversals = [];
  const originalOps = [];

  paid.forEach((original, i) => {
    reversals.push({
      _id:             revIds[i],
      schoolId,
      userId:          original.userId,
      // Deliberately not attached to the run: the run is being closed out, and
      // a reversal that shared its runId would trip the one-payslip-per-person
      // unique index.
      runId:           null,
      periodMonth:     original.periodMonth,
      structureId:     original.structureId,
      payType:         original.payType,
      // Snapshotted as they were, so the reversal reads as the mirror of the
      // same month's facts rather than a second computation of them.
      hoursWorked:     original.hoursWorked ?? null,
      hourlyRate:      original.hourlyRate  ?? null,
      baseAmount:      -original.baseAmount,
      allowances:      original.allowances.map((a) => ({ ...a.toObject?.() ?? a, amount: -a.amount })),
      deductions:      original.deductions.map((d) => ({ ...d.toObject?.() ?? d, amount: -d.amount })),
      gross:           -original.gross,
      totalDeductions: -original.totalDeductions,
      net:             -original.net,
      status:          "paid",
      method:          original.method,
      payslipNo:       revNos[i],
      paidAt:          now,
      paidBy:          reversedBy ?? null,
      reversesId:      String(original._id),
      reversalReason:  reason,
    });

    originalOps.push({
      updateOne: {
        filter: { _id: original._id },
        update: {
          $set: {
            reversedById:   revIds[i],
            status:         "reversed",
            reversalReason: reason,
          },
        },
      },
    });
  });

  // The reversals first: an original pointing at a row that does not exist
  // yet is the one ordering that would be wrong to leave behind if the
  // second write failed.
  if (reversals.length)   await SalaryPayment.insertMany(reversals, { ordered: true });
  if (originalOps.length) await SalaryPayment.bulkWrite(originalOps, { ordered: false });

  run.status         = "reversed";
  run.reversedBy     = reversedBy ?? null;
  run.reversedAt     = now;
  run.reversalReason = reason;
  await run.save();

  return { run, reversed: paid.length };
};

module.exports = {
  endOfMonth,
  nextPayslipNo,
  timeToMinutes,
  dayMinutes,
  hoursWorkedInMonth,
  computeFromStructure,
  structuresInForce,
  generateRun,
  confirmRun,
  reverseRun,
};
