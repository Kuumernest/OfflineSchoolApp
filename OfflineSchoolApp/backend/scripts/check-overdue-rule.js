// backend/scripts/check-overdue-rule.js
"use strict";

/**
 * Overdue is judged on the first charge the payments have not covered — not
 * on the earliest charge on the account (owner, 2026-10-27).
 *
 * The rule took the earliest due date of ANY charge, so a family who paid
 * First Term in full and owed a Second Term not yet due was "overdue" since
 * First Term's date: reminded, flagged in Students to watch, counted in To do.
 *
 *   fay  T1 85,000 due 60 days ago, T2 85,000 due in 10 days; paid 135,000
 *        → owes 35,000, NOT overdue, due in 10 days (due soon)
 *   eve  T1 85,000 due 60 days ago, T2 85,000 due 6 days ago; paid 85,000
 *        → overdue since T2's date (6 days), not T1's (60)
 *   ken  T1 50,000 due 10 days ago, fully waived; T2 30,000 due in 5 days
 *        → a waived charge is covered: not overdue
 *   ama  T1 60,000 due 20 days ago; paid 30,000 → overdue since T1 (20 days)
 *   bih  T1 40,000 due 30 days ago, paid; undated levy 10,000 this year
 *        → the undated charge is due at once: overdue
 *
 *   node scripts/check-overdue-rule.js
 */

const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);
  const reminders = require("../src/services/feeReminders.service");
  const { watchlist } = require("../src/services/earlyWarning.service");
  const { actionItemsFor } = require("../src/services/actionItems.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";
  const TODAY = new Date("2026-10-27T10:00:00Z");
  const DAY = 86_400_000;
  const days = (n) => new Date(TODAY.getTime() + n * DAY);
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Rule School", email: "rule@example.test", settings: { academicYear: YEAR } });

  console.log("\n--- firstUnpaid ---");
  const fu = reminders.firstUnpaid;
  const c = (amount, due, waived = 0) => ({ amount, waivedAmount: waived, dueDate: due });
  check("paid the first: the second is owed", fu([c(100, days(-60)), c(100, days(14))], 150, TODAY)?.dueDate, days(14));
  check("payments settle the oldest first, whatever order the charges come in",
    fu([c(100, days(14)), c(100, days(-60))], 100, TODAY)?.dueDate, days(14));
  check("a part-paid first charge is still owed", fu([c(100, days(-60)), c(100, days(14))], 40, TODAY)?.dueDate, days(-60));
  check("a waived charge is covered", fu([c(100, days(-10), 100), c(50, days(5))], 0, TODAY)?.dueDate, days(5));
  check("an undated charge counts as due today", fu([c(100, days(-30)), c(10, null)], 100, TODAY)?.dueDate, null);
  check("all covered: nothing owed", fu([c(100, days(-30))], 100, TODAY), null);

  console.log("\n--- the families ---");
  let n = 0;
  const pupil = (id) => M("Student").create({
    _id: id, userId: `u-${id}`, schoolId: S, classId: "f1", className: "Form 1", studentName: `Pupil ${id}`,
    enrollmentNo: `EN-${id}`, status: "approved", isActive: true, guardianEmail: `${id}@example.test`,
  });
  const charge = (studentId, amount, dueDate, waivedAmount = 0) => M("FeeCharge").create({
    schoolId: S, studentId, academicYear: YEAR, code: `C${++n}`, label: "Tuition", amount, dueDate, waivedAmount,
  });
  const pay = (studentId, amount) => M("FeePayment").create({ schoolId: S, studentId, academicYear: YEAR, amount });

  await pupil("fay"); await charge("fay", 85000, days(-60)); await charge("fay", 85000, days(10)); await pay("fay", 135000);
  await pupil("eve"); await charge("eve", 85000, days(-60)); await charge("eve", 85000, days(-6)); await pay("eve", 85000);
  await pupil("ken"); await charge("ken", 50000, days(-10), 50000); await charge("ken", 30000, days(5));
  await pupil("ama"); await charge("ama", 60000, days(-20)); await pay("ama", 30000);
  await pupil("bih"); await charge("bih", 40000, days(-30)); await pay("bih", 40000); await charge("bih", 10000, null);

  const all = await reminders.candidates({ schoolId: S, mode: "all", asOf: TODAY });
  const row = (id) => all.find((r) => r.studentId === id) ?? {};
  const daysTo = (d) => (d ? Math.round((new Date(d) - TODAY) / DAY) : null);

  check("fay: owes 35,000, not overdue, due in 10 days",
    [row("fay").balance, row("fay").isOverdue, daysTo(row("fay").earliestDue)], [35000, false, 10]);
  check("eve: overdue since Second Term's date, not First Term's",
    [row("eve").isOverdue, daysTo(row("eve").earliestDue), row("eve").daysOverdue], [true, -6, 6]);
  check("ken: the waived charge is covered, the next is not yet due", [row("ken").isOverdue, daysTo(row("ken").earliestDue)], [false, 5]);
  check("ama: part-paid, overdue since the charge's date", [row("ama").isOverdue, row("ama").daysOverdue], [true, 20]);
  check("bih: the undated charge is due at once", [row("bih").isOverdue, row("bih").earliestDue], [true, null]);

  const overdue = await reminders.candidates({ schoolId: S, mode: "overdue", asOf: TODAY });
  check("reminders chase only the overdue", overdue.map((r) => r.studentId).sort(), ["ama", "bih", "eve"]);
  const soon = await reminders.candidates({ schoolId: S, mode: "dueSoon", asOf: TODAY });
  check("and remind the not-yet-due as due soon", soon.map((r) => r.studentId).sort(), ["fay", "ken"]);

  console.log("\n--- the screens that read it ---");
  const list = await watchlist({ schoolId: S, asOf: TODAY });
  const flagged = list.students.filter((s) => s.signals.some((x) => x.code === "fees_outstanding")).map((s) => s.studentId).sort();
  check("Students to watch flags the same three", flagged, ["ama", "bih", "eve"]);
  const items = await actionItemsFor({ schoolId: S, can: { marks: false, publish: false, fees: true }, asOf: TODAY });
  check("To do counts the same three", items.find((i) => i.key === "overdueFees")?.count, 3);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
