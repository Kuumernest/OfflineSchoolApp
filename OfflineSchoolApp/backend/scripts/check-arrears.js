// backend/scripts/check-arrears.js
"use strict";

/**
 * Owed and overdue — one definition (shared/arrears.js, arrears.service).
 *
 * The bell said "7 families overdue (1,025,000)" while the Fees page said
 * 3,125,000 owed: the bell summed late pupils' WHOLE balances (next term's
 * fees included) and called each pupil a family. Now:
 *
 *   owed     everything unpaid this year            — the Fees page total
 *   overdue  the part of that past its due date     — the bell's amount
 *   families pupils joined by a portal access code  — siblings count once
 *
 *   ada   First Term 100,000 due 25 days ago, paid 60,000; Second Term 80,000
 *         due in 70 days                        → owes 120,000, 40,000 overdue
 *   ben   Ada's brother (one access code): 50,000 due 10 days ago, unpaid
 *                                               → owes 50,000, all overdue
 *   cy    paid First Term in full; Second Term not yet due
 *                                               → owes 80,000, nothing overdue
 *   dee   on a plan, keeping to it; the charge's own date has passed
 *                                               → owes 90,000, nothing overdue
 *   eli   on a plan, one instalment missed       → 30,000 overdue (the shortfall)
 *   fay   an undated charge this year            → due at once, 20,000 overdue
 *   gus   a debt from LAST year only             → not in this year's figures
 *
 *   node scripts/check-arrears.js
 */

const path     = require("path");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const { feePosition, familyCount, planStatus } = require("../../shared/arrears");
  const { arrearsFor }     = require(path.join(SRC, "services/arrears.service"));
  const { candidates }     = require(path.join(SRC, "services/feeReminders.service"));
  const { actionItemsFor } = require(path.join(SRC, "services/actionItems.service"));
  const { outstandingFor } = require(path.join(SRC, "services/fees.service"));

  console.log("--- the arithmetic (shared/arrears) ---");
  const asOf = new Date("2026-10-30T12:00:00Z");
  const d = (s) => new Date(s);
  const termly = [{ amount: 100000, dueDate: d("2026-10-05") }, { amount: 80000, dueDate: d("2027-01-11") }];
  const p1 = feePosition({ charges: termly, paid: 60000, asOf });
  check("part-paid First Term, Second Term to come: owed all, overdue only First Term's unpaid part",
    [p1.owed, p1.overdue, p1.notYetDue, p1.isOverdue], [120000, 40000, 80000, true]);
  check("  the date quoted is First Term's; the next one is Second Term's",
    [p1.overdueSince.toISOString().slice(0, 10), p1.nextDue.toISOString().slice(0, 10)], ["2026-10-05", "2027-01-11"]);
  check("not late ON the due date, late the day after",
    [feePosition({ charges: [{ amount: 1, dueDate: d("2026-10-30") }], paid: 0, asOf }).isOverdue,
     feePosition({ charges: [{ amount: 1, dueDate: d("2026-10-29") }], paid: 0, asOf }).isOverdue], [false, true]);
  check("a waiver comes off before anything is late",
    feePosition({ charges: [{ amount: 50000, waivedAmount: 50000, dueDate: d("2026-10-01") }], paid: 0, asOf }).isOverdue, false);
  check("an overpayment is never negative overdue",
    [feePosition({ charges: termly, paid: 500000, asOf }).owed, feePosition({ charges: termly, paid: 500000, asOf }).overdue], [0, 0]);
  check("planStatus is the shared one (cumulative): double the first instalment covers the second",
    planStatus({ instalments: [{ seq: 1, amount: 10, dueDate: d("2026-09-01") }, { seq: 2, amount: 10, dueDate: d("2026-10-01") }] }, 20, asOf).isBehind, false);
  check("families: siblings on one code are one; two codes sharing a child join; no code is one each",
    [familyCount(["a", "b"], [{ studentIds: ["a", "b"] }]),
     familyCount(["a", "b", "c"], [{ studentIds: ["a", "b"] }, { studentIds: ["b", "c"] }]),
     familyCount(["a", "b"], [])], [1, 1, 2]);

  console.log("--- one school, read from the database ---");
  const S = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027", LAST = "2025/2026";
  const day = (n) => new Date(Date.now() + n * 86_400_000);
  await M("School").create({ _id: S, name: "Arrears Check", email: "arrears@example.test", settings: { academicYear: YEAR } });
  for (const id of ["ada", "ben", "cy", "dee", "eli", "fay", "gus"]) {
    await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: S, classId: "f1",
      studentName: id, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
      guardianName: id === "ada" || id === "ben" ? "Mme Tabi" : `Parent of ${id}` });
  }
  let n = 0;
  const charge = (studentId, amount, dueDate, academicYear = YEAR) =>
    M("FeeCharge").create({ schoolId: S, studentId, academicYear, code: `C${++n}`, label: "Tuition", amount, dueDate });
  const pay = (studentId, amount, academicYear = YEAR) =>
    M("FeePayment").collection.insertOne({ schoolId: S, studentId, academicYear, amount, deletedAt: null });

  await charge("ada", 100000, day(-25)); await charge("ada", 80000, day(70)); await pay("ada", 60000);
  await charge("ben", 50000, day(-10));
  await charge("cy", 100000, day(-25));  await charge("cy", 80000, day(70)); await pay("cy", 100000);
  await charge("dee", 90000, day(-20));
  await charge("eli", 90000, day(-20));
  await charge("fay", 20000, null);
  await charge("gus", 40000, day(-300), LAST);
  const plan = (studentId, inst) => M("PaymentPlan").collection.insertOne({
    schoolId: S, studentId, academicYear: YEAR, status: "active", deletedAt: null,
    instalments: inst.map(([amount, offset], i) => ({ seq: i + 1, amount, dueDate: day(offset) })) });
  await plan("dee", [[30000, 30], [30000, 60], [30000, 90]]);               // nothing due yet
  await plan("eli", [[30000, -5], [30000, 30], [30000, 60]]); // first missed
  await M("GuardianAccess").collection.insertOne({ schoolId: S, studentIds: ["ada", "ben"], deletedAt: null });

  const a = await arrearsFor({ schoolId: S });
  const row = (id) => a.rows.find((r) => r.studentId === id) ?? null;
  const fig = (id) => (row(id) ? [row(id).owed, row(id).overdue] : null);
  check("ada: owes 120,000, of which 40,000 overdue (not her whole balance)", fig("ada"), [120000, 40000]);
  check("ben: 50,000 owed and overdue", fig("ben"), [50000, 50000]);
  check("cy: paid First Term — owes Second Term, nothing overdue", [fig("cy"), row("cy")?.isOverdue], [[80000, 0], false]);
  check("dee: on a plan and keeping to it — nothing overdue though the charge's date passed",
    [fig("dee"), row("dee")?.onPlan], [[90000, 0], true]);
  check("eli: behind on the plan — the shortfall is overdue", fig("eli"), [90000, 30000]);
  check("fay: an undated charge this year is due at once", fig("fay"), [20000, 20000]);
  check("gus: last year's debt is not in this year's figures", row("gus"), null);
  check("totals: owed, pupils owing, overdue, pupils overdue, families overdue",
    a.totals, { owed: 450000, owingStudents: 6, overdue: 140000, overdueStudents: 4, overdueFamilies: 3 });
  check("asked for last year, gus's debt is there",
    (await arrearsFor({ schoolId: S, academicYear: LAST })).totals.owed, 40000);

  console.log("--- every screen reads the same figures ---");
  const o = await outstandingFor({ schoolId: S });
  check("Fees page owed (outstandingFor) = arrears owed", [o.outstanding, o.owing], [a.totals.owed, a.totals.owingStudents]);
  const items = await actionItemsFor({ schoolId: S, can: { fees: true } });
  const bell = items.find((i) => i.key === "overdueFees");
  check("the bell: pupils overdue, their families, and only what is past due",
    [bell?.count, bell?.families, bell?.amount], [4, 3, 140000]);
  const late = await candidates({ schoolId: S, mode: "overdue" });
  check("Fee reminders (overdue): the same pupils, with the overdue amount beside the balance",
    late.map((r) => [r.studentId, r.balance, r.overdue]).sort(),
    [["ada", 120000, 40000], ["ben", 50000, 50000], ["eli", 90000, 30000], ["fay", 20000, 20000]]);
  const soon = await candidates({ schoolId: S, mode: "dueSoon", asOf: day(60) });
  check("due soon looks at the next unpaid date (cy's Second Term, 70 days out, from day 60)",
    soon.map((r) => r.studentId).includes("cy"), true);
  const family = await candidates({ schoolId: S, mode: "all", onlyStudentIds: ["ada", "ben"] });
  check("the parent portal (one family's children) gets the same rows",
    family.map((r) => [r.studentId, r.overdue]).sort(), [["ada", 40000], ["ben", 50000]]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
