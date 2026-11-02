// backend/scripts/check-sibling-accounts.js
"use strict";

/**
 * Approving a child never touches a sibling's login.
 *
 * ── The bug ───────────────────────────────────────────────────────────────
 *
 * POST /sync/push (pushStudentDecisions) found the pupil's login with
 * User.findOne({ email, role: "student" }). Siblings share the parent's email
 * (CLAUDE.md), so approving the second child matched the FIRST child's
 * account and renamed it, reset its password and gave it the second child's
 * admission number: the first child was locked out and the second signed in
 * as them. No client calls /sync/push (both apps only held the constant; the
 * phone drains its outbox through the real routes), so it is retired: 410 Gone
 * with code SYNC_PUSH_RETIRED, and nothing is written.
 *
 * The approve routes link a login by the pupil's OWN record — student.userId,
 * then its enrollmentNo — never by the shared address. That is pinned here for
 * both of them, and for a pending pupil whose own account already exists while
 * a sibling's account is the first one on the address.
 *
 *   node scripts/check-sibling-accounts.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");
const path     = require("path");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  process.env.NODE_ENV   = process.env.NODE_ENV || "test";
  // A replica set: the retired handler used transactions, and the red run of
  // this check has to reach the code it is proving gone.
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ launchTimeout: 180000 }] });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(["User", "Student", "StudentApplication", "Class", "School"].map((n) => M(n).init()));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S   = new mongoose.Types.ObjectId().toString();
  const MUM = "nkwo.family@example.test";
  await M("School").create({ _id: S, name: "Hill Top", code: "HT", email: "ht@example.test" });
  await M("User").create({ _id: "adm", name: "Registrar", email: "adm@ht.example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true });
  await M("Class").create({ _id: "f1", schoolId: S, name: "Form 1" });
  await M("Class").create({ _id: "f2", schoolId: S, name: "Form 2" });

  const pending = (id, name) => M("Student").create({
    _id: id, schoolId: S, studentName: name, email: MUM,
    guardianName: "Mrs Nkwo", guardianEmail: MUM, status: "pending",
  });

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require(path.join(__dirname, "..", "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/students", auth.authenticate, require(path.join(SRC, "routes/students.routes")));
  app.use("/api/admin",    auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use("/api/sync",     auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API   = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call  = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };

  // What a login IS, for "untouched": who it names, what opens it, which
  // number signs in with it, and that it is still live.
  const loginOf = async (studentId) => {
    const s = await M("Student").findById(studentId).lean();
    if (!s?.userId) return null;
    const u = await M("User").findById(s.userId).select("+password").lean();
    return u && { id: String(u._id), name: u.name, password: u.password,
                  enrollmentNo: u.enrollmentNo, isActive: u.isActive };
  };

  try {
    console.log("\n--- sibling A, then sibling B, on one parent email ---");
    await pending("ama", "Ama Nkwo");
    let r = await call("POST", "/students/ama/approve", { classId: "f1", schoolId: S });
    check("A is approved", r.status, 200);
    const amaBefore = await loginOf("ama");
    check("  with a login of her own", [amaBefore?.name, amaBefore?.isActive, !!amaBefore?.enrollmentNo],
      ["Ama Nkwo", true, true]);

    await pending("ben", "Ben Nkwo");
    r = await call("PUT", "/admin/students/ben/approve", { classId: "f2", schoolId: S });
    check("B is approved on the admin route", r.status, 200);
    const ben = await loginOf("ben");
    check("  and gets his own account, his own number",
      [!!ben, ben?.id !== amaBefore.id, ben?.name, ben?.enrollmentNo !== amaBefore.enrollmentNo],
      [true, true, "Ben Nkwo", true]);
    check("  A's login is untouched: name, password hash, number, active",
      await loginOf("ama"), amaBefore);

    await pending("chi", "Chi Nkwo");
    r = await call("POST", "/students/chi/approve", { classId: "f1", schoolId: S });
    const chi = await loginOf("chi");
    check("C is approved on the students route with an account of her own",
      [r.status, !!chi, ![amaBefore.id, ben.id].includes(chi?.id)], [200, true, true]);
    check("  A's login still untouched", await loginOf("ama"), amaBefore);
    check("  three children, three logins, three numbers",
      new Set([amaBefore, ben, chi].map((x) => `${x.id}|${x.enrollmentNo}`)).size, 3);

    // ── POST /sync/push: retired ─────────────────────────────────────────────
    console.log("\n--- POST /sync/push is retired ---");
    await pending("dan", "Dan Nkwo");
    r = await call("POST", "/sync/push", {
      schoolId: S,
      changes: {
        studentDecisions: [{ studentId: "dan", status: "approved", classId: "f2" }],
        periods: [{ operation: "create", data: { _id: "client-uuid-1", name: "P1", startTime: "08:00", endTime: "09:00" } }],
      },
    });
    check("answers 410 Gone with a code an old client can act on",
      [r.status, r.body?.success, r.body?.code], [410, false, "SYNC_PUSH_RETIRED"]);
    check("  and writes nothing: the decision is not applied",
      (await M("Student").findById("dan").lean())?.status, "pending");
    check("  no period is created", await M("Period").countDocuments({ schoolId: S }), 0);
    check("  and A's login is still untouched", await loginOf("ama"), amaBefore);
    r = await call("GET", "/sync/push");
    check("  (the route is still there for POST only)", r.status, 404);
    await M("User").create({ _id: "tea", name: "Teacher", email: "tea@ht.example.test",
      password: "check-only-password", role: "teacher", schoolId: S, isActive: true });
    const teaToken = jwt.sign({ id: "tea", role: "teacher", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const teaRes = await fetch(`${API}/sync/push`, {
      method: "POST", headers: { Authorization: `Bearer ${teaToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ schoolId: S, changes: {} }),
    });
    check("  a caller who never held sync.push keeps the 403 it always got", teaRes.status, 403);

    // ── a pending pupil whose own account already exists ────────────────────
    //
    // Her account was made after Ama's, so findOne({ email }) meets Ama's
    // first. provisionStudentAccount took that as "a sibling holds it" and
    // minted a second login, orphaning hers.
    console.log("\n--- a pupil's own account is found by her record, not the address ---");
    await M("User").create({ _id: "u-eka", name: "Eka Nkwo", email: MUM, role: "student", schoolId: S,
      isActive: false, password: "check-only-password", enrollmentNo: "HT-OLD-0001" });
    await M("Student").create({ _id: "eka", schoolId: S, studentName: "Eka Nkwo", email: MUM,
      guardianEmail: MUM, status: "pending", userId: "u-eka" });
    r = await call("POST", "/students/eka/approve", { classId: "f1", schoolId: S });
    const eka = await loginOf("eka");
    check("approving her keeps her own login", [r.status, eka?.id, eka?.isActive], [200, "u-eka", true]);
    check("  and no stray account is minted for her",
      await M("User").countDocuments({ role: "student", name: "Eka Nkwo" }), 1);
    check("  A's login still untouched", await loginOf("ama"), amaBefore);
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect().catch(() => {});
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
