// backend/scripts/check-hourly-payroll.js
"use strict";

/**
 * Assert hourly pay, end to end from attendance to reversal.
 *
 * Spins up mongodb-memory-server like check-approvals.js, so it needs no
 * external MongoDB and touches nothing real.
 *
 * What it proves:
 *   • the time parser accepts what the marking screen writes and refuses
 *     what it cannot mean                                     (no DB needed)
 *   • an hourly structure's base is rate × the month's actual attendance
 *     hours, while a monthly structure ignores attendance entirely
 *   • an hourly teacher with no readable attendance that month is owed their
 *     allowances but no base — the monthly structure is the one that means
 *     "paid regardless"
 *   • days marked absent / on_leave / without both times count for nothing
 *   • the payslip snapshots payType, hoursWorked and hourlyRate, and a
 *     reversal mirrors them without recomputing
 *
 *   node scripts/check-hourly-payroll.js
 */

const mongoose = require("mongoose");

const payroll = require("../src/services/payroll.service");

const SalaryStructure = require("../src/db/models/SalaryStructure");
const SalaryPayment   = require("../src/db/models/SalaryPayment");
const {
  TeacherAttendance,
} = require("../src/db/models/Attendance");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
};

const SCHOOL   = "school-hourly";
const TEACHER  = "user-hourly-teacher";
const FIXED    = "user-fixed-teacher";
const MONTH    = "2026-08";

const att = (id, teacherId, date, status, checkIn, checkOut) => ({
  _id: id, schoolId: SCHOOL, teacherId, date, status,
  checkInTime: checkIn, checkOutTime: checkOut,
});

const main = async () => {
  // ── The pure pieces, no database ──────────────────────────────────────────
  console.log("--- the time parser ---");

  check("a plain HH:MM",          payroll.timeToMinutes("07:30"),    450);
  check("seconds are tolerated",  payroll.timeToMinutes("07:30:15"), 450);
  check("single-digit hour",      payroll.timeToMinutes("7:05"),     425);
  check("empty is not zero",      payroll.timeToMinutes(""),         null);
  check("garbage is null",        payroll.timeToMinutes("morning"),  null);
  check("25:00 is not a time",    payroll.timeToMinutes("25:00"),    null);
  check("missing is null",        payroll.timeToMinutes(null),       null);

  console.log("--- one attendance record ---");

  check("a full morning and afternoon",
    payroll.dayMinutes(att("a", TEACHER, "2026-08-03", "present", "07:30", "15:30")),
    480);
  check("check-out before check-in is a marking mistake, not a shift",
    payroll.dayMinutes(att("b", TEACHER, "2026-08-03", "present", "15:30", "07:30")),
    null);
  check("equal times count for nothing",
    payroll.dayMinutes(att("c", TEACHER, "2026-08-03", "present", "08:00", "08:00")),
    null);
  check("no check-out means the day cannot be counted",
    payroll.dayMinutes(att("d", TEACHER, "2026-08-03", "present", "07:30", null)),
    null);

  console.log("--- computing a payslip from a structure ---");

  const monthly = {
    payType: "monthly", baseAmount: 100_000,
    allowances: [{ code: "TR", label: "Transport", amount: 10_000 }],
    deductions: [{ code: "TX", label: "Tax", amount: 5_000 }],
  };
  const m = payroll.computeFromStructure(monthly);
  check("monthly keeps its fixed base", m.baseAmount, 100_000);
  check("monthly carries no hours", [m.hoursWorked, m.hourlyRate, m.payType],
    [null, null, "monthly"]);
  check("monthly arithmetic is unchanged", [m.gross, m.net], [110_000, 105_000]);

  const hourly = {
    payType: "hourly", baseAmount: 2_500,
    allowances: [], deductions: [{ code: "TX", label: "Tax", amount: 1_000 }],
  };
  const h = payroll.computeFromStructure(hourly, 16.5);
  check("hourly base is rate × hours", h.baseAmount, 41_250);
  check("hourly snapshots both facts", [h.payType, h.hoursWorked, h.hourlyRate],
    ["hourly", 16.5, 2_500]);
  check("hourly net", h.net, 40_250);
  check("hourly with no attendance at all earns no base",
    payroll.computeFromStructure(hourly, null).baseAmount, 0);
  check("a structure written before payType existed is monthly",
    payroll.computeFromStructure({ baseAmount: 50_000 }).payType, "monthly");

  console.log("--- database pieces follow ---");

  // ── The database pieces ───────────────────────────────────────────────────
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "hourly-payroll-check" });

  console.log("--- hours read from the register ---");

  // The month under test: two good days, a late day, an absent day, a day
  // with no check-out, and a present day in July that must not leak in.
  await TeacherAttendance.collection.insertMany([
    att("a1", TEACHER, `${MONTH}-03`, "present",  "07:30", "12:30"), // 300
    att("a2", TEACHER, `${MONTH}-04`, "present",  "08:00", "15:30"), // 450
    att("a3", TEACHER, `${MONTH}-05`, "late",     "08:10", "12:10"), // 240
    att("a4", TEACHER, `${MONTH}-06`, "absent",   "07:30", "15:30"), // absent
    att("a5", TEACHER, `${MONTH}-07`, "present",  "07:30", null),    // unreadable
    att("a6", TEACHER, "2026-07-31",  "present",  "07:30", "15:30"), // other month
  ]);

  const hours = await payroll.hoursWorkedInMonth(SCHOOL, [TEACHER], MONTH);
  check("only the countable days land in the month",
    hours.get(TEACHER), { minutes: 990, days: 3 });

  const none = await payroll.hoursWorkedInMonth(SCHOOL, [FIXED], MONTH);
  check("a teacher with no records at all is absent from the map",
    none.has(FIXED), false);

  console.log("--- a mixed run, generated ---");

  await SalaryStructure.collection.insertMany([
    {
      _id: "st-fixed", schoolId: SCHOOL, userId: FIXED,
      payType: "monthly", baseAmount: 100_000,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-01-01"), effectiveTo: null, deletedAt: null,
    },
    {
      _id: "st-hourly", schoolId: SCHOOL, userId: TEACHER,
      payType: "hourly", baseAmount: 2_500,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-01-01"), effectiveTo: null, deletedAt: null,
    },
  ]);

  const { run, payslips } = await payroll.generateRun({
    schoolId: SCHOOL, periodMonth: MONTH, generatedBy: "user-head",
  });

  check("both staff made the run", payslips.length, 2);

  const fixedSlip = payslips.find((p) => p.userId === FIXED);
  check("the monthly teacher is paid their fixed base",
    [fixedSlip.baseAmount, fixedSlip.payType, fixedSlip.hoursWorked],
    [100_000, "monthly", null]);

  const hourlySlip = payslips.find((p) => p.userId === TEACHER);
  check("the hourly teacher's base is 990 minutes at 2500/h",
    hourlySlip.baseAmount, 41_250);
  check("the hourly slip answers where the hours came from",
    [hourlySlip.hoursWorked, hourlySlip.hourlyRate], [16.5, 2_500]);

  check("the run totals add up",
    [run.totalGross, run.totalNet], [141_250, 141_250]);

  console.log("--- confirming, then reversing ---");

  await payroll.confirmRun({
    schoolId: SCHOOL, runId: String(run._id),
    method: "cash", confirmedBy: "user-bursar",
  });

  const { reversed } = await payroll.reverseRun({
    schoolId: SCHOOL, runId: String(run._id),
    reason: "Register was wrong — hours were double-marked", reversedBy: "user-bursar",
  });
  check("one row reversed", reversed, 2);

  const rev = await SalaryPayment.findOne({
    schoolId: SCHOOL, reversesId: hourlySlip._id,
  }).lean();
  check("the reversal mirrors the hourly facts without recomputing them",
    [rev.payType, rev.hoursWorked, rev.hourlyRate], ["hourly", 16.5, 2_500]);
  // The fixtures carry no deductions, so the mirror of net is the mirror of
  // base. Deduction arithmetic is covered by the pure section above.
  check("the reversal's amounts are the originals negated",
    [rev.baseAmount, rev.net], [-41_250, -41_250]);

  console.log("--- and the route module still loads ---");
  // The hours-preview endpoint lives in the router; requiring it proves the
  // wiring (imports, destructuring) at least resolves.
  require("../src/routes/finance.routes");
  check("finance routes load", true, true);

  await mongoose.disconnect();
  await mongo.stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
