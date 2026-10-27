// backend/scripts/check-watch-fees.js
"use strict";

/**
 * C6 — Students to watch flags fee debt only when it is OVERDUE.
 *
 * It used to flag any positive balance, so on the first day of term every
 * family that had not yet paid fees due next month was a pupil "to watch".
 * The watchlist now asks feeReminders.candidates({ mode: "overdue" }) — the
 * same answer the bursar's Fee reminders screen gives.
 *
 * Worked by hand, "today" = 2026-10-27, current year 2026/2027:
 *
 *   ama  60,000 due 10 days ago, paid 0          → flagged, 2 points (owes all of it), 10 days
 *   bih  60,000 due in 20 days, paid 0           → NOT flagged: not due yet
 *   cho  100,000 due 10 days ago, paid 80,000    → flagged, 1 point (owes a fifth)
 *   dan  40,000 with no due date, this year      → flagged: an undated bill is due at once
 *   eve  50,000 due 10 days ago, paid in full    → NOT flagged: owes nothing
 *   fay  30,000 due today                        → NOT flagged: late tomorrow, not today
 *
 *   node scripts/check-watch-fees.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const { watchlist } = require("../src/services/earlyWarning.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const NOW = "2026/2027";
  const TODAY = new Date("2026-10-27T10:00:00Z");
  const daysFrom = (n) => new Date(TODAY.getTime() + n * 86_400_000);
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv@example.test", settings: { academicYear: NOW } });

  const pupil = (id) => M("Student").create({
    _id: id, userId: `u-${id}`, schoolId: S, classId: "f1", className: "Form 1",
    studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
  });
  let n = 0;
  const charge = (studentId, amount, dueDate) => M("FeeCharge").create({
    schoolId: S, studentId, academicYear: NOW, code: `C${++n}`, label: "Tuition", amount, dueDate,
  });
  const pay = (studentId, amount) => M("FeePayment").create({
    schoolId: S, studentId, academicYear: NOW, amount,
  });

  await pupil("ama"); await charge("ama", 60000, daysFrom(-10));
  await pupil("bih"); await charge("bih", 60000, daysFrom(20));
  await pupil("cho"); await charge("cho", 100000, daysFrom(-10)); await pay("cho", 80000);
  await pupil("dan"); await charge("dan", 40000, null);
  await pupil("eve"); await charge("eve", 50000, daysFrom(-10)); await pay("eve", 50000);
  await pupil("fay"); await charge("fay", 30000, new Date("2026-10-27T00:00:00Z"));

  const list = await watchlist({ schoolId: S, asOf: TODAY });
  const fee = (id) => {
    const row = list.students.find((s) => s.studentId === id);
    return row?.signals.find((s) => s.code === "fees_outstanding") ?? null;
  };

  console.log("\n--- who is flagged for fees ---");
  check("only overdue debt is flagged",
    list.students.filter((s) => s.signals.some((g) => g.code === "fees_outstanding"))
      .map((s) => s.studentId).sort(),
    ["ama", "cho", "dan"]);
  check("fees due in 20 days are not a reason to watch a pupil", fee("bih"), null);
  check("a debt paid in full is not flagged", fee("eve"), null);
  check("fees due today are not overdue yet", fee("fay"), null);

  console.log("\n--- what the flag says ---");
  check("owing all of an overdue bill → 2 points, with the days overdue",
    [fee("ama")?.points, fee("ama")?.data], [2, { balance: 60000, billed: 60000, daysOverdue: 10 }]);
  check("owing a fifth of it → 1 point, billed counts what was paid",
    [fee("cho")?.points, fee("cho")?.data], [1, { balance: 20000, billed: 100000, daysOverdue: 10 }]);
  check("an undated bill this year is overdue at once",
    fee("dan")?.points, 2);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
