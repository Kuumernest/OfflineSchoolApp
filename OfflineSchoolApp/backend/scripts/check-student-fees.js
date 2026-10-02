// backend/scripts/check-student-fees.js
"use strict";

/**
 * A pupil reads their own fee account, and only that.
 *
 * GET /api/student/fees answers the signed-in pupil's ledger: the charges that
 * stand, the payments with their receipt numbers, the totals. It is the
 * guardian portal's ledger (fees.service familyLedger) — one redaction, read
 * twice — so a pupil sees exactly what their family sees and nothing the
 * bursar's screen adds: no cashier, no internal note, no voided row. There is
 * no pupil id to ask for; the record is the account's own. The finance routes
 * stay the bursar's: a pupil is refused /api/fees/* as before.
 *
 *   node scripts/check-student-fees.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

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

  const A = "68f0000000000000000000a1";
  const YEAR = "2026-2027";
  await M("School").create({ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" });
  const mk = (id, role) => M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: A, isActive: true });
  await Promise.all([mk("u-a1", "student"), mk("u-a2", "student"), mk("u-none", "student"), mk("teach-a", "teacher"), mk("bursar-a", "bursar")]);
  await M("Class").create({ _id: "form3a", schoolId: A, name: "Form 3A" });
  const pupil = (id, userId, n) => ({ _id: id, userId, schoolId: A, classId: "form3a", studentName: `Pupil ${n}`, enrollmentNo: `A-${n}`, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", "u-a1", 1), pupil("st-a2", "u-a2", 2)]);

  const charge = (id, studentId, code, amount, extra = {}) => ({
    _id: id, schoolId: A, studentId, academicYear: YEAR, term: 1, code, label: code, amount, raisedBy: "bursar-a", ...extra,
  });
  await M("FeeCharge").create([
    // Raised a day apart, so the ledger's chronological order is what is asserted.
    charge("c-a1-tuition", "st-a1", "TUITION", 50000, { dueDate: new Date("2026-10-15"), createdAt: new Date("2026-09-01") }),
    charge("c-a1-books",   "st-a1", "BOOKS",   10000, { waivedAmount: 2000, waiverReason: "sibling", createdAt: new Date("2026-09-02") }),
    charge("c-a1-void",    "st-a1", "LAB",     99999, { voidedAt: new Date(), voidedBy: "bursar-a", voidReason: "raised in error" }),
    charge("c-a2-tuition", "st-a2", "TUITION", 70000),
  ]);
  const payment = (id, studentId, amount, extra = {}) => ({
    _id: id, schoolId: A, studentId, academicYear: YEAR, term: 1, amount, method: "cash", receivedAt: new Date("2026-10-01"), receivedBy: "bursar-a", note: "cashier's private note", source: "web", ...extra,
  });
  await M("FeePayment").create([
    payment("p-a1-1", "st-a1", 30000, { receiptNo: "R-0001" }),
    payment("p-a1-2", "st-a1", -5000, { receiptNo: "R-0002", reversesId: "p-a1-1", reversalReason: "keyed twice", receivedAt: new Date("2026-10-02") }),
    payment("p-a2-1", "st-a2", 20000, { receiptNo: "R-0003" }),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/student", auth.authenticate, require(path.join(SRC, "routes/students.routes")));
  app.use("/api/fees",    auth.authenticate, require(path.join(SRC, "routes/fees.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (url, token) => {
    const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const as = (id, role) => { const token = jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" }); return (url) => call(url, token); };
  const a1 = as("u-a1", "student"), a2 = as("u-a2", "student"), none = as("u-none", "student"), teacher = as("teach-a", "teacher");

  console.log("\n--- the pupil's own account ---");
  let r = await a1("/student/fees");
  const d = r.body?.data ?? {};
  check("200 with the totals: billed 60 000, 2 000 waived, 25 000 paid net of the reversal, 33 000 owing", [r.status, d.totals], [200, { charged: 60000, waived: 2000, paid: 25000, balance: 33000 }]);
  check("the charges that stand, with year, term and due date; the voided one absent", d.charges?.map((c) => [c.code, c.amount, c.waivedAmount ?? 0, c.term, c.academicYear, Boolean(c.dueDate)]),
    [["TUITION", 50000, 0, "1", YEAR, true], ["BOOKS", 10000, 2000, "1", YEAR, false]]);
  check("the payments with receipt numbers; the reversal marked", d.payments?.map((p) => [p.receiptNo, p.amount, p.isReversal]), [["R-0001", 30000, false], ["R-0002", -5000, true]]);
  const text = JSON.stringify(r.body);
  check("nothing the bursar's screen adds: no cashier, no note, no void, no reason", [/receivedBy|note|voidedAt|voidReason|waiverReason|reversalReason|raisedBy/.test(text)], [false]);
  check("the year filter applies; another year is an empty ledger", (await a1(`/student/fees?academicYear=2019-2020`)).body?.data?.totals, { charged: 0, waived: 0, paid: 0, balance: 0 });

  console.log("\n--- only their own ---");
  check("asking for another pupil by query changes nothing — there is no pupil to ask for", (await a1("/student/fees?studentId=st-a2")).body?.data?.totals?.charged, 60000);
  check("the other pupil reads their own, not the first's", (await a2("/student/fees")).body?.data?.totals, { charged: 70000, waived: 0, paid: 20000, balance: 50000 });
  check("the bursar's per-pupil account route is refused to a pupil → 403", (await a1("/fees/students/st-a2")).status, 403);
  check("and so is the arrears list → 403", (await a1("/fees/outstanding")).status, 403);
  check("a teacher is not a pupil → 403", (await teacher("/student/fees")).status, 403);
  check("an account with no pupil record: an empty ledger, not an error", (await none("/student/fees")).body?.data?.totals, { charged: 0, waived: 0, paid: 0, balance: 0 });

  console.log("\n--- one ledger, read twice ---");
  const { familyLedger } = require(path.join(SRC, "services/fees.service"));
  const direct = await familyLedger({ schoolId: A, studentId: "st-a1" });
  check("the route answers what the guardian portal's function answers", JSON.parse(JSON.stringify(direct)).totals, d.totals);
  const portalSrc = fs.readFileSync(path.join(SRC, "routes/portal.routes.js"), "utf8");
  check("and the guardian portal's /fees reads that function, not a copy", /router\.get\("\/fees"[\s\S]{0,600}familyLedger\(/.test(portalSrc), true);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
