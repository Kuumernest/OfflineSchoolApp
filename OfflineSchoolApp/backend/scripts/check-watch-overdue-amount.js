// backend/scripts/check-watch-overdue-amount.js
"use strict";

/**
 * Students to watch quotes the Fees page's owed AND overdue, not one as the other.
 *
 * The fee flag printed the whole balance as "(overdue)": Eunice Ashu "owes
 * FCFA 145,000 (overdue)" while the Fees page (GET /fees/outstanding) said
 * 145,000 owed, 50,000 overdue; Alain Onana 200,000 against 105,000. The
 * signal now carries both figures from the Fees page's function
 * (arrears.service), and its weight is the overdue part.
 *
 * Worked by hand, "today" = 2026-10-27, current year 2026/2027:
 *
 *   eunice  50,000 due 10 days ago + 95,000 due in 30 days, paid 0
 *           → owes 145,000, of which 50,000 overdue; 50/145 < half → 1 point
 *   alain   105,000 due 15 days ago + 95,000 due in 30 days, paid 0
 *           → owes 200,000, of which 105,000 overdue; 105/200 ≥ half → 2 points
 *   paul    Eunice's brother, same guardian, 60,000 due 10 days ago, paid
 *           → not flagged; a sibling's debt is not his (fees are per child)
 *
 *   node scripts/check-watch-overdue-amount.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const { watchlist }  = require("../src/services/earlyWarning.service");
  const { arrearsFor } = require("../src/services/arrears.service");

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
  await M("School").create({ _id: S, name: "Green Valley", email: "gv-owe@example.test", settings: { academicYear: NOW } });

  const pupil = (id, name, guardian = {}) => M("Student").create({
    _id: id, userId: `u-${id}`, schoolId: S, classId: "f3", className: "Form 3",
    studentName: name, enrollmentNo: `EN-${id}`, status: "approved", isActive: true, ...guardian,
  });
  let n = 0;
  const charge = (studentId, amount, dueDate) => M("FeeCharge").create({
    schoolId: S, studentId, academicYear: NOW, code: `C${++n}`, label: "Tuition", amount, dueDate,
  });
  const pay = (studentId, amount) => M("FeePayment").create({ schoolId: S, studentId, academicYear: NOW, amount });

  const ashu = { guardianName: "Mrs Ashu", guardianPhone: "+237600000001", guardianEmail: "ashu@example.test" };
  await pupil("eunice", "Eunice Ashu", ashu);
  await charge("eunice", 50000, daysFrom(-10)); await charge("eunice", 95000, daysFrom(30));
  await pupil("alain", "Alain Onana");
  await charge("alain", 105000, daysFrom(-15)); await charge("alain", 95000, daysFrom(30));
  await pupil("paul", "Paul Ashu", ashu);
  await charge("paul", 60000, daysFrom(-10)); await pay("paul", 60000);

  const [list, fees] = await Promise.all([
    watchlist({ schoolId: S, asOf: TODAY }),
    arrearsFor({ schoolId: S, asOf: TODAY }), // what GET /fees/outstanding answers
  ]);
  const flag = (id) => list.students.find((s) => s.studentId === id)
    ?.signals.find((s) => s.code === "fees_outstanding") ?? null;
  const page = (id) => {
    const r = fees.rows.find((x) => String(x.studentId) === id);
    return r ? { balance: r.owed, overdue: r.overdue } : null;
  };

  console.log("\n--- the Fees page, as worked by hand ---");
  check("Eunice owes 145,000, 50,000 of it overdue", page("eunice"), { balance: 145000, overdue: 50000 });
  check("Alain owes 200,000, 105,000 of it overdue", page("alain"), { balance: 200000, overdue: 105000 });

  console.log("\n--- Students to watch says the same ---");
  for (const id of ["eunice", "alain"]) {
    const f = flag(id);
    check(`${id}: owed and overdue are the Fees page's`,
      f ? { balance: f.data.balance, overdue: f.data.overdue } : null, page(id));
  }
  check("the overdue figure is not the balance", flag("eunice")?.data.overdue === flag("eunice")?.data.balance, false);

  console.log("\n--- weighed by what is overdue ---");
  check("Eunice: 50,000 of 145,000 overdue → 1 point", flag("eunice")?.points, 1);
  check("Alain: 105,000 of 200,000 overdue → 2 points", flag("alain")?.points, 2);

  console.log("\n--- one guardian, two children ---");
  check("Paul, paid up, is not flagged for his sister's fees", flag("paul"), null);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
