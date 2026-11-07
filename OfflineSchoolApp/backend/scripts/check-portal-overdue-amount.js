// backend/scripts/check-portal-overdue-amount.js
"use strict";

/**
 * The parent portal and the fee reminder say how much is overdue, not the
 * whole balance, and call a charge overdue only while something is unpaid.
 *
 *   - GET /portal/home coloured the whole balance "Overdue" and carried no
 *     overdue figure: Eunice owes 145,000 of which 50,000 is late.
 *   - GET /portal/fees/reminders decided on its own: every dated charge was
 *     "overdue" the day after its date, even one paid in full (Kofi).
 *   - The fee.reminder message, under "Overdue school fees", quoted only the
 *     balance; it now says "…of which 50,000 is overdue".
 *
 * One guardian, three children on one code (CLAUDE.md):
 *   eunice  50,000 due 10 days ago + 95,000 due in 30 days, paid 0
 *   kofi    60,000 due 10 days ago, paid 60,000
 *   paul    nothing owed
 *
 *   node scripts/check-portal-overdue-amount.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const path     = require("path");

const SRC = path.join(__dirname, "..", "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const now = new Date();
  const days = (n) => new Date(now.getTime() + n * 86_400_000);
  const month = now.getUTCMonth() + 1;
  const start = month >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const YEAR = `${start}/${start + 1}`;

  const S = "68e0000000000000000000e1";
  await M("School").create({ _id: S, name: "Green Valley", code: "GVO", email: "gv-o@example.test", settings: { academicYear: YEAR } });
  await M("Class").create({ _id: "f3", schoolId: S, name: "Form 3" });
  const ashu = { guardianName: "Mrs Ashu", guardianPhone: "+237600000001", guardianEmail: "ashu@example.test" };
  const pupil = (id, name) => M("Student").create({
    _id: id, userId: `u-${id}`, schoolId: S, classId: "f3", className: "Form 3",
    studentName: name, enrollmentNo: `CS-${id}`, status: "approved", isActive: true, ...ashu,
  });
  await pupil("eunice", "Eunice Ashu"); await pupil("kofi", "Kofi Ashu"); await pupil("paul", "Paul Ashu");
  let n = 0;
  const charge = (studentId, amount, dueDate) => M("FeeCharge").create({
    _id: `ch-${studentId}-${++n}`, schoolId: S, studentId, academicYear: YEAR, code: `C${n}`, label: "Tuition", amount, dueDate,
  });
  await charge("eunice", 50000, days(-10)); await charge("eunice", 95000, days(30));
  await charge("kofi", 60000, days(-10));
  await M("FeePayment").create({ schoolId: S, studentId: "kofi", academicYear: YEAR, amount: 60000 });

  const portal = require(path.join(SRC, "services/portal.service"));
  const { code } = await portal.issueAccess({ schoolId: S, studentIds: ["eunice", "kofi", "paul"], label: "Mrs Ashu" });

  const app = express();
  app.use(express.json());
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/portal`;
  const login = await (await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admissionNo: "CS-eunice", code }) })).json();
  const token = login.token ?? login.data?.token ?? login.accessToken ?? login.data?.accessToken;
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  console.log("\n--- Home: owes X, of which Y is overdue ---");
  const home = await get("/home");
  const fees = (id) => (home.body.data?.children ?? []).find((c) => c._id === id)?.fees ?? null;
  check("Eunice: 145,000 owed, 50,000 of it overdue",
    [fees("eunice")?.balance, fees("eunice")?.overdue, fees("eunice")?.isOverdue], [145000, 50000, true]);
  check("Kofi, paid up: nothing overdue", [fees("kofi")?.overdue ?? 0, fees("kofi")?.isOverdue], [0, false]);

  console.log("\n--- Fees reminders: per charge, as payments settle them ---");
  const eu = await get("/fees/reminders?studentId=eunice");
  check("Eunice's account: 50,000 overdue", [eu.status, eu.body.data?.overdue, eu.body.data?.isOverdue], [200, 50000, true]);
  check("the past charge is overdue, the coming one is not",
    (eu.body.data?.reminders ?? []).map((r) => [r.amount, r.unpaid, r.isOverdue]), [[50000, 50000, true], [95000, 95000, false]]);
  const ko = await get("/fees/reminders?studentId=kofi");
  check("Kofi's charge, paid in full, is not overdue though its date passed",
    [(ko.body.data?.reminders ?? []).map((r) => r.isOverdue), ko.body.data?.overdue], [[false], 0]);

  console.log("\n--- the reminder message ---");
  const reminders = require(path.join(SRC, "services/feeReminders.service"));
  await reminders.sendReminders({ schoolId: S, mode: "overdue", requestedBy: "bursar", asOf: now, force: true });
  const note = await M("Notification").findOne({ schoolId: S, kind: "fee.reminder", studentId: "eunice" }).lean();
  check("the queued reminder carries the overdue part", [note?.data?.balance, note?.data?.overdue], [145000, 50000]);
  const { render } = require(path.join(SRC, "services/notification/templates"));
  const msg = render("fee.reminder", { ...note?.data, studentName: "Eunice Ashu", schoolName: "Green Valley" }, "en");
  check("and says so", /of which .*50,000.* is overdue/.test(msg.text), true);
  const fr = render("fee.reminder", { ...note?.data, studentName: "Eunice Ashu", schoolName: "Green Valley" }, "fr");
  check("in French too", /dont .*50.000.* en retard/.test(fr.text.replace(/ | /g, " ")), true);
  const all = render("fee.reminder", { balance: 60000, overdue: 60000, isOverdue: true, dueDate: days(-10), daysOverdue: 10, studentName: "X", schoolName: "Y" }, "en");
  check("all of it late: the plain sentence, no 'of which'", /of which/.test(all.text), false);
  check("Kofi, paid up, gets no reminder",
    await M("Notification").countDocuments({ schoolId: S, kind: "fee.reminder", studentId: "kofi" }), 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
