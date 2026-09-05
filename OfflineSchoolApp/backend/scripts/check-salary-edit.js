// backend/scripts/check-salary-edit.js
"use strict";

/**
 * PATCH /api/finance/salary-structures/:id
 *
 * A salary structure is effective-dated history, not a record of the current
 * figure. A raise closes the old row and opens a new one so that a payslip
 * issued in March still reproduces March's numbers in December — which means
 * an edit that can reach a row a payslip was computed from would rewrite what
 * somebody was paid, after they were paid it.
 *
 * The endpoint exists because the alternative was worse: with no edit at all,
 * a mistyped figure or a forgotten allowance could only be answered by a second
 * version, so a school's salary history filled up with corrections that were
 * never really history. So it edits the row in force and nothing else, and the
 * assertions below are the two guards that make that safe:
 *
 *   • a superseded row is closed history and is never editable
 *   • a row any payslip references is evidence, and is never editable
 *
 *   node scripts/check-salary-edit.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require("../src/db/models");
  const User            = mongoose.model("User");
  const SalaryStructure = mongoose.model("SalaryStructure");
  const SalaryPayment   = mongoose.model("SalaryPayment");

  const SCHOOL = "sch-1";
  const OTHER  = "sch-2";
  const STAFF  = "usr-teacher";

  await User.create({
    _id: "usr-bursar", name: "Bursar", email: "b@example.test",
    password: "check-only-password", role: "school_admin",
    schoolId: SCHOOL, isActive: true,
  });
  await User.create({
    _id: STAFF, name: "A Teacher", email: "t@example.test",
    password: "check-only-password", role: "teacher",
    schoolId: SCHOOL, isActive: true,
  });

  const auth = require("../middleware/auth");
  const app  = express();
  app.use(express.json());
  app.use("/api/finance", auth.authenticate, require("../src/routes/finance.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  const token = jwt.sign(
    { id: "usr-bursar", role: "school_admin", schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );

  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/finance${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  /** A fresh structure in force, with one allowance. */
  const makeStructure = async (id, extra = {}) => {
    await SalaryStructure.deleteMany({ _id: id });
    return SalaryStructure.create({
      _id: id, schoolId: SCHOOL, userId: STAFF,
      payType: "monthly", baseAmount: 100_000,
      allowances: [{ code: "HOUSE", label: "Housing", amount: 20_000 }],
      deductions: [],
      effectiveFrom: new Date("2026-01-01"),
      ...extra,
    });
  };

  // ── The case it exists for ────────────────────────────────────────────────
  console.log("\n--- adding what was forgotten ---");

  await makeStructure("st-1");
  let r = await call("PATCH", "/salary-structures/st-1", {
    schoolId: SCHOOL,
    deductions: [{ code: "CNPS", label: "CNPS", amount: 4_200 }],
  });
  if (r.status === 200) ok("a deduction can be added to a salary nothing has been paid against");
  else bad("a deduction can be added", `${r.status} ${JSON.stringify(r.body)}`);

  let row = await SalaryStructure.findById("st-1").lean();
  if (row?.deductions?.length === 1 && row.deductions[0].amount === 4200) ok("the deduction is stored");
  else bad("the deduction is stored", JSON.stringify(row?.deductions));

  // The whole reason for merging rather than replacing: a client adding a
  // deduction should not have to resend the base and the allowances, because
  // anything it forgets to resend would be silently dropped.
  if (row?.baseAmount === 100_000 && row?.allowances?.length === 1) {
    ok("fields not sent are left alone, not blanked");
  } else {
    bad("fields not sent are left alone", `base ${row?.baseAmount}, allowances ${row?.allowances?.length}`);
  }

  // ── Guard one: already paid ───────────────────────────────────────────────
  console.log("\n--- a salary that has produced a payslip ---");

  await makeStructure("st-2");
  await SalaryPayment.create({
    _id: "pay-1", schoolId: SCHOOL, userId: STAFF, structureId: "st-2",
    periodMonth: "2026-01", baseAmount: 100_000, gross: 120_000,
    totalDeductions: 0, net: 120_000, status: "paid",
  });

  r = await call("PATCH", "/salary-structures/st-2", { schoolId: SCHOOL, baseAmount: 999_999 });
  if (r.status === 409 && r.body?.code === "STRUCTURE_IN_USE") ok("editing a paid salary is refused");
  else bad("editing a paid salary is refused", `${r.status} ${JSON.stringify(r.body)}`);

  row = await SalaryStructure.findById("st-2").lean();
  if (row?.baseAmount === 100_000) ok("and the figure on it is unchanged");
  else bad("and the figure on it is unchanged", String(row?.baseAmount));

  if (typeof r.body?.payslips === "number" && r.body.payslips === 1) {
    ok("the refusal says how many payslips are in the way");
  } else {
    bad("the refusal says how many payslips are in the way", JSON.stringify(r.body));
  }

  // A reversed run must not freeze a structure for ever.
  await SalaryPayment.updateOne({ _id: "pay-1" }, { deletedAt: new Date() });
  r = await call("PATCH", "/salary-structures/st-2", { schoolId: SCHOOL, baseAmount: 110_000 });
  if (r.status === 200) ok("a deleted payslip no longer blocks the edit");
  else bad("a deleted payslip no longer blocks the edit", `${r.status} ${JSON.stringify(r.body)}`);

  // ── Guard two: superseded ─────────────────────────────────────────────────
  console.log("\n--- a salary that has been replaced ---");

  await makeStructure("st-3", { effectiveTo: new Date("2026-05-31") });
  r = await call("PATCH", "/salary-structures/st-3", { schoolId: SCHOOL, baseAmount: 1 });
  if (r.status === 409 && r.body?.code === "STRUCTURE_SUPERSEDED") ok("editing closed history is refused");
  else bad("editing closed history is refused", `${r.status} ${JSON.stringify(r.body)}`);

  // ── Tenancy ───────────────────────────────────────────────────────────────
  console.log("\n--- another school's salary ---");

  await SalaryStructure.create({
    _id: "st-other", schoolId: OTHER, userId: "usr-elsewhere",
    payType: "monthly", baseAmount: 50_000,
    allowances: [], deductions: [], effectiveFrom: new Date("2026-01-01"),
  });
  r = await call("PATCH", "/salary-structures/st-other", { schoolId: SCHOOL, baseAmount: 1 });
  if (r.status === 404) ok("a structure in another school is not found, not edited");
  else bad("a structure in another school is not found", `${r.status} ${JSON.stringify(r.body)}`);

  const untouched = await SalaryStructure.findById("st-other").lean();
  if (untouched?.baseAmount === 50_000) ok("and it is untouched");
  else bad("and it is untouched", String(untouched?.baseAmount));

  // ── Validation is the same as on create ───────────────────────────────────
  console.log("\n--- the rules that apply to a new salary apply to an edited one ---");

  await makeStructure("st-4");
  r = await call("PATCH", "/salary-structures/st-4", {
    schoolId: SCHOOL, payType: "hourly", baseAmount: 0,
  });
  if (r.status === 400 && r.body?.code === "INVALID_AMOUNT") ok("an hourly rate of zero is refused on edit too");
  else bad("an hourly rate of zero is refused on edit too", `${r.status} ${JSON.stringify(r.body)}`);

  r = await call("PATCH", "/salary-structures/st-4", { schoolId: SCHOOL, baseAmount: -5 });
  if (r.status === 400) ok("a negative base is refused");
  else bad("a negative base is refused", `${r.status} ${JSON.stringify(r.body)}`);

  r = await call("PATCH", "/salary-structures/st-4", { schoolId: SCHOOL, payType: "weekly" });
  if (r.status === 400 && r.body?.code === "INVALID_PAY_TYPE") ok("an unknown pay type is refused");
  else bad("an unknown pay type is refused", `${r.status} ${JSON.stringify(r.body)}`);

  r = await call("PATCH", "/salary-structures/st-4", {
    schoolId: SCHOOL, allowances: [{ code: "X", label: "X", amount: 1.5 }],
  });
  if (r.status === 400) ok("a fractional XAF component is refused");
  else bad("a fractional XAF component is refused", `${r.status} ${JSON.stringify(r.body)}`);

  // ── Dates ─────────────────────────────────────────────────────────────────
  console.log("\n--- moving the date it starts ---");

  await SalaryStructure.deleteMany({ userId: STAFF });
  await SalaryStructure.create({
    _id: "st-old", schoolId: SCHOOL, userId: STAFF,
    payType: "monthly", baseAmount: 80_000, allowances: [], deductions: [],
    effectiveFrom: new Date("2026-01-01"),
    effectiveTo:   new Date("2026-06-30"),
  });
  await makeStructure("st-new", { effectiveFrom: new Date("2026-07-01") });

  r = await call("PATCH", "/salary-structures/st-new", {
    schoolId: SCHOOL, effectiveFrom: "2026-03-01",
  });
  if (r.status === 409 && r.body?.code === "OVERLAPPING_STRUCTURE") {
    ok("a start date cannot be pulled back over the salary before it");
  } else {
    bad("a start date cannot be pulled back over the salary before it", `${r.status} ${JSON.stringify(r.body)}`);
  }

  r = await call("PATCH", "/salary-structures/st-new", {
    schoolId: SCHOOL, effectiveFrom: "2026-08-01",
  });
  if (r.status === 200) ok("but it can move where nothing is in the way");
  else bad("but it can move where nothing is in the way", `${r.status} ${JSON.stringify(r.body)}`);

  r = await call("PATCH", "/salary-structures/st-new", { schoolId: SCHOOL, effectiveFrom: "not a date" });
  if (r.status === 400) ok("an unparseable date is refused");
  else bad("an unparseable date is refused", `${r.status} ${JSON.stringify(r.body)}`);

  // ── Missing ───────────────────────────────────────────────────────────────
  r = await call("PATCH", "/salary-structures/nope", { schoolId: SCHOOL, baseAmount: 1 });
  if (r.status === 404) ok("an unknown id is a 404");
  else bad("an unknown id is a 404", `${r.status}`);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
