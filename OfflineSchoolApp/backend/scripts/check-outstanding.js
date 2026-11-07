// backend/scripts/check-outstanding.js
"use strict";

/**
 * One outstanding-fees figure on every screen (decided 2026-10-27).
 *
 * Fees > Outstanding said 1,900,000 for a school whose Financial reports and
 * platform dashboard said 9,820,000. All three now read fees.service
 * outstandingBySchool:
 *
 *   - current students only: approved, active, not deleted;
 *   - one academic year: the one asked for, else the school's current year;
 *   - voided charges out; deleted payments out; a reversal nets off;
 *   - outstanding = the sum of POSITIVE balances (a credit hides no debt).
 *
 * Worked by hand, current year 2026/2027:
 *
 *   ama  approved   charged 100,000, a voided 999 beside it, paid 0  → owes 100,000
 *   bih  approved   charged 50,000, paid 80,000                       → credit 30,000, owes 0
 *   cho  suspended  charged 50,000                                    → not a current student
 *   dan  deleted    charged 40,000                                    → not a current student
 *   eve  pending    charged 20,000                                    → not a current student
 *   fay  approved   charged 10,000, paid 10,000 then reversed         → owes 10,000
 *                   and 70,000 charged in 2025/2026 (another year)
 *   gus  approved   charged 30,000 less 5,000 waived, paid 5,000      → owes 20,000
 *   (another school, same year: one approved pupil owing 1,000)
 *
 *   2026/2027: 100,000 + 10,000 + 20,000 = 130,000, owed by 3.
 *              Netting bih's credit would have said 100,000; counting cho,
 *              dan and eve would have added 110,000.
 *   2025/2026: fay's 70,000.
 *
 *   node scripts/check-outstanding.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const fees     = require("../src/services/fees.service");
  const finance  = require("../src/services/financeReports.service");
  const platform = require("../src/services/platformStats.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const NOW = "2026/2027", LAST = "2025/2026";
  const S = new mongoose.Types.ObjectId().toString();
  const T = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv@example.test", settings: { academicYear: NOW } });
  await M("School").create({ _id: T, name: "Other", email: "other@example.test", settings: { academicYear: NOW } });

  const pupil = (schoolId, id, extra = {}) => M("Student").create({
    _id: id, userId: `u-${id}`, schoolId, classId: "f1", className: "Form 1",
    studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true, ...extra,
  });
  let n = 0;
  const charge = (schoolId, studentId, amount, extra = {}) => M("FeeCharge").create({
    schoolId, studentId, academicYear: NOW, code: `C${++n}`, label: "Tuition", amount, ...extra,
  });
  const pay = (schoolId, studentId, amount, extra = {}) => M("FeePayment").create({
    schoolId, studentId, academicYear: NOW, amount, ...extra,
  });

  await pupil(S, "ama");  await charge(S, "ama", 100000); await charge(S, "ama", 999, { voidedAt: new Date() });
  await pupil(S, "bih");  await charge(S, "bih", 50000);  await pay(S, "bih", 80000);
  await pupil(S, "cho", { status: "suspended", isActive: false }); await charge(S, "cho", 50000);
  await pupil(S, "dan", { deletedAt: new Date() });                await charge(S, "dan", 40000);
  await pupil(S, "eve", { status: "pending" });                    await charge(S, "eve", 20000);
  await pupil(S, "fay");  await charge(S, "fay", 10000);
  const p = await pay(S, "fay", 10000);
  await pay(S, "fay", -10000, { reversesId: String(p._id) });
  await charge(S, "fay", 70000, { academicYear: LAST });
  await pupil(S, "gus");  await charge(S, "gus", 30000, { waivedAmount: 5000 }); await pay(S, "gus", 5000);
  await pupil(T, "oth");  await charge(T, "oth", 1000);

  console.log("--- the rule ---");
  const o = await fees.outstandingFor({ schoolId: S, withRows: true });
  check("no year asked: the school's current year", o.academicYear, NOW);
  check("130,000 owed by ama, gus and fay — largest first",
    [o.outstanding, o.owing, o.rows.map((r) => [r.studentId, r.balance])],
    [130000, 3, [["ama", 100000], ["gus", 20000], ["fay", 10000]]]);
  check("charged, waived, paid are the current students' (ama, bih, fay, gus)",
    [o.charged, o.waived, o.billed, o.paid], [190000, 5000, 185000, 85000]);
  check("a chosen year: 2025/2026 is fay's 70,000",
    [(await fees.outstandingFor({ schoolId: S, academicYear: LAST })).outstanding], [70000]);
  check("the year's other spelling is the same year",
    (await fees.outstandingFor({ schoolId: S, academicYear: "2026-2027" })).outstanding, 130000);

  console.log("--- the three screens agree ---");
  const outstandingPage = o.outstanding;
  const reports = await finance.arrears({ schoolId: S, academicYear: null });
  const stats = await platform.computePlatformStats(platform.parseFilters({}));
  const row = stats.schools.find((s) => s.schoolId === S);
  check("Fees > Outstanding = Financial reports = platform dashboard",
    [outstandingPage, reports.outstanding, row?.fees?.balance], [130000, 130000, 130000]);
  check("  and they name the same year", [reports.academicYear, row?.fees?.academicYear], [NOW, NOW]);
  check("platform total adds each school's own figure", [stats.totals.fees.balance, stats.totals.fees.owing], [131000, 4]);
  const chosen = await platform.computePlatformStats(platform.parseFilters({ academicYear: LAST }));
  check("platform with a year chosen: that year", chosen.schools.find((s) => s.schoolId === S)?.fees?.balance, 70000);
  check("reports with a year chosen: that year",
    (await finance.arrears({ schoolId: S, academicYear: LAST })).outstanding, 70000);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
