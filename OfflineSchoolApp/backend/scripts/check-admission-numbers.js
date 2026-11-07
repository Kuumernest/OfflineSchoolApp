// backend/scripts/check-admission-numbers.js
"use strict";

/**
 * Every way a pupil gets an admission number gives one shape, from one
 * sequence, and never a number somebody already holds.
 *
 * ── The bug ───────────────────────────────────────────────────────────────
 *
 * A pupil added by the office got GVA00-2026-0001; an applicant admitted the
 * same day got GVA00/2026/001. Five generators, two shapes, and each counted
 * only its own — so the sequences ran side by side, and the next applicant
 * could not see the office's numbers at all (services/admissionNumber.service.js).
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 *   added directly, admitted from an application, a login provisioned, and
 *   the console's "give a number": all CODE-YEAR-NNN, one sequence
 *   the sequence continues past numbers already issued in the old shapes
 *   a pupil who already has a number keeps it
 *   twenty admissions at once take twenty different numbers
 *   another school's code is another sequence
 *
 *   node scripts/check-admission-numbers.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");
  const M       = (n) => mongoose.model(n);
  const admission = require("../src/services/admissionNumber.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = new Date().getFullYear();
  const A = new mongoose.Types.ObjectId().toString();
  const B = new mongoose.Types.ObjectId().toString();
  await M("School").create([
    { _id: A, name: "Alpha", code: "GVA00", email: "a@example.test" },
    { _id: B, name: "Beta",  code: "BETA",  email: "b@example.test" },
  ]);
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: A, isActive: true });
  await M("Class").create({ _id: "f1", schoolId: A, name: "Form 1" });

  const app = express(); app.use(express.json());
  app.use("/api/students", auth.authenticate, require("../src/routes/students.routes"));
  app.use("/api/admin",    auth.authenticate, require("../src/routes/admin.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const numberOf = async (studentId) => {
    const s = await M("Student").findById(studentId).lean()
      ?? await M("StudentApplication").findById(studentId).lean();
    return s?.enrollmentNo ?? s?.admissionNo ?? null;
  };
  const SHAPE = new RegExp(`^GVA00-${YEAR}-\\d{3,}$`);

  try {
    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- the format ---");
    check("three digits", admission.formatAdmissionNo("GVA00", 2026, 1), "GVA00-2026-001");
    check("and more when the year runs past 999", admission.formatAdmissionNo("GVA00", 2026, 1234), "GVA00-2026-1234");
    check("every old shape is read",
      ["GVA00/2026/007", "GVA00-2026-0012", "GVA00-2026-003", "OTHER-2026-099", "GVA00-2025-050"]
        .map((v) => admission.sequenceOf(v, "GVA00", 2026)), [7, 12, 3, null, null]);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- added directly, and admitted from an application ---");
    let r = await call("POST", "/students", { name: "Office Pupil", classId: "f1", schoolId: A });
    check("a pupil added by the office", r.status, 201);
    const direct = r.body?.enrollmentNo ?? r.body?.data?.enrollmentNo ?? await numberOf(r.body?.student?._id ?? r.body?.data?.student?._id);
    check("  is numbered CODE-YEAR-NNN", SHAPE.test(direct), true);

    await M("StudentApplication").create({ _id: "app-1", schoolId: A, studentName: "Applicant Pupil",
      email: "parent1@example.test", guardianName: "P1", phone: "+237600000011", classId: "f1", status: "pending" });
    r = await call("PUT", "/admin/students/app-1/approve", { classId: "f1", schoolId: A });
    check("an applicant is admitted", r.status, 200);
    const admitted = await numberOf("app-1");
    check("  in the same shape", SHAPE.test(admitted), true);
    check("  and the next number in the same sequence",
      admission.sequenceOf(admitted, "GVA00", YEAR), admission.sequenceOf(direct, "GVA00", YEAR) + 1);

    // Through the driver: a pupil approved before numbers existed is exactly
    // the record the schema would now refuse.
    await M("Student").collection.insertOne({ _id: "st-nonum", schoolId: A, classId: "f1", studentName: "No Number",
      status: "approved", isActive: true, deletedAt: null });
    r = await call("POST", "/admin/students/st-nonum/enrollment-number", { schoolId: A });
    check("the console's \"give a number\" continues it",
      [r.status, admission.sequenceOf(r.body?.enrollmentNo ?? r.body?.data?.enrollmentNo, "GVA00", YEAR)],
      [200, admission.sequenceOf(admitted, "GVA00", YEAR) + 1]);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- numbers already issued in the old shapes ---");
    await M("Student").collection.insertOne({ _id: "st-old-slash", schoolId: A, classId: "f1", studentName: "Old Slash",
      admissionNo: `GVA00/${YEAR}/040`, enrollmentNo: `GVA00/${YEAR}/040`, status: "approved", isActive: true, deletedAt: null });
    await M("User").create({ _id: "u-old-dash", name: "Old Dash", role: "student", schoolId: A,
      enrollmentNo: `GVA00-${YEAR}-0041`, password: "check-only-password", isActive: true });
    await M("StudentApplication").create({ _id: "app-2", schoolId: A, studentName: "Second Applicant",
      email: "parent2@example.test", guardianName: "P2", phone: "+237600000012", classId: "f1", status: "pending" });
    r = await call("PUT", "/admin/students/app-2/approve", { classId: "f1", schoolId: A });
    check("the next is one past the highest, whatever its shape", await numberOf("app-2"), `GVA00-${YEAR}-042`);
    check("the old numbers are untouched",
      [(await M("Student").findById("st-old-slash").lean()).admissionNo, (await M("User").findById("u-old-dash").lean()).enrollmentNo],
      [`GVA00/${YEAR}/040`, `GVA00-${YEAR}-0041`]);

    console.log("--- a pupil who already has a number keeps it ---");
    await M("StudentApplication").create({ _id: "app-3", schoolId: A, studentName: "Numbered Applicant",
      email: "parent3@example.test", guardianName: "P3", phone: "+237600000013", classId: "f1", status: "pending",
      admissionNo: `GVA00/${YEAR}/009` });
    r = await call("PUT", "/admin/students/app-3/approve", { classId: "f1", schoolId: A });
    check("approval keeps the number on the application", [r.status, await numberOf("app-3")], [200, `GVA00/${YEAR}/009`]);
    r = await call("POST", "/admin/students/st-old-slash/enrollment-number", { schoolId: A });
    check("and asking for one returns the one held", r.body?.enrollmentNo ?? r.body?.data?.enrollmentNo, `GVA00/${YEAR}/040`);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- at the same moment ---");
    const many = await Promise.all(Array.from({ length: 20 }, () => admission.nextAdmissionNo(A)));
    check("twenty at once are twenty different numbers", new Set(many).size, 20);
    check("  all in the one shape", many.every((n) => SHAPE.test(n)), true);
    const seqs = many.map((n) => admission.sequenceOf(n, "GVA00", YEAR)).sort((x, y) => x - y);
    check("  and consecutive", seqs[19] - seqs[0], 19);

    const fresh = await Promise.all(Array.from({ length: 5 }, () => admission.nextAdmissionNo(B)));
    check("another school's first numbers, also at once", fresh.sort(),
      [1, 2, 3, 4, 5].map((n) => `BETA-${YEAR}-00${n}`));
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
