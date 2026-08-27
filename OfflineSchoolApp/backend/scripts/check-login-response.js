// backend/scripts/check-login-response.js
"use strict";

/**
 * Assert that a real sign-in returns what the client needs to draw a console.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Because it did not. The mounted router built its user payload with
 * `permissions: user.permissions ?? []`, and there is no permissions field on
 * the User schema — capabilities are computed from the role and the school's
 * overrides — so that expression was [] for every user who has ever signed in.
 * The web app's usePermission() hook reads exactly that list, so every
 * capability-gated control in the console was disabled or hidden for
 * everybody, school admins included.
 *
 * The correct resolver was in the project the whole time, in
 * src/controllers/auth.controller.js — a file no other file requires. Reading
 * it is what made the bug invisible: the logic looked present and correct, and
 * was simply never reached.
 *
 * A grep would not have caught that and would not catch its return. So this
 * signs in over HTTP and reads the response.
 *
 *   node scripts/check-login-response.js
 */

const express  = require("express");
const mongoose = require("mongoose");

const SCHOOL = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PASS   = "Sk9-temp-Pass1";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "login-response" });

  // Read when a token is signed, so setting it here is early enough. Left
  // alone if the environment already has one.
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const User  = require("../src/db/models/User");
  const PERMS = require("../src/config/permissions");
  const { ROLES } = require("../src/config/roles");
  const { defaultsFor } = require("../src/services/permissions.service");

  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../src/routes/auth.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  const login = async (email, password = PASS) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: body ?? {} };
  };

  const makeUser = async (role, email, extra = {}) => User.create({
    name: `Test ${role}`, email, role, schoolId: SCHOOL,
    isActive: true, password: PASS, ...extra,
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- signing in returns the caller's capabilities ---");

  await makeUser(ROLES.BURSAR,       "bursar@school.com");
  await makeUser(ROLES.SCHOOL_ADMIN, "head@school.com");
  await makeUser(ROLES.TEACHER,      "teacher@school.com");

  for (const [role, email] of [
    [ROLES.BURSAR,       "bursar@school.com"],
    [ROLES.SCHOOL_ADMIN, "head@school.com"],
    [ROLES.TEACHER,      "teacher@school.com"],
  ]) {
    const { status, body } = await login(email);
    check(`${role} signs in`, status, 200);
    // THE BUG: this was [] for every role.
    check(`${role} is told what they may do`,
      Array.isArray(body.user?.permissions) && body.user.permissions.length > 0, true);
    check(`${role}'s list matches what the server would enforce`,
      body.user?.permissions, defaultsFor(role));
    check(`${role}'s list contains only real capabilities`,
      (body.user?.permissions ?? []).filter((k) => !PERMS.isPermission(k)), []);
  }

  // The four capabilities the web app actually gates on, named individually,
  // because a non-empty list is not the same as a USEFUL one. These are also
  // why the bug had visible consequences: Chase Arrears could not send or
  // penalise, the payment-plan panel was inert, and the salary field on the
  // payroll screen was read-only — for everybody, whatever their role.
  console.log("--- and specifically the ones the console draws with ---");

  const bursar = (await login("bursar@school.com")).body.user?.permissions ?? [];
  for (const key of ["fees.remind", "fees.penalize", "fees.plan"]) {
    check(`a bursar holds ${key}`, bursar.includes(key), true);
  }

  // NOT payroll.setSalary, and the salaries screen gating on it is correct:
  // somebody who can both raise a salary and pay it is not meaningfully
  // supervised. It is a locked capability, so no school can delegate it either.
  check("a bursar does not hold payroll.setSalary",
    bursar.includes("payroll.setSalary"), false);

  const head = (await login("head@school.com")).body.user?.permissions ?? [];
  check("a school admin does — otherwise the field is dead for everyone",
    head.includes("payroll.setSalary"), true);

  const teacher = (await login("teacher@school.com")).body.user?.permissions ?? [];
  for (const key of ["fees.remind", "fees.penalize", "fees.plan", "payroll.setSalary"]) {
    check(`a teacher does not hold ${key}`, teacher.includes(key), false);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a temporary password is announced as one ---");

  await makeUser(ROLES.BURSAR, "fresh@school.com", { mustResetPassword: true });
  const fresh = await login("fresh@school.com");
  check("the flag reaches the client", fresh.body.user?.mustResetPassword, true);
  // The web console gates the whole dashboard shell on this — see
  // web/src/components/auth/StaffOnly.tsx. If it stopped being sent, staff
  // would silently keep working on the password somebody read out to them.
  check("and is a boolean, not a truthy string",
    typeof fresh.body.user?.mustResetPassword, "boolean");

  const settled = await login("bursar@school.com");
  check("an established account is not flagged",
    settled.body.user?.mustResetPassword, false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- /me answers the same way as login ---");

  const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
    headers: { authorization: `Bearer ${settled.body.token}` },
  });
  const meBody = await me.json().catch(() => ({}));
  check("/me succeeds", me.status, 200);
  // Same shape from both, because the client re-hydrates from whichever it
  // last called and a difference between them would surface as capabilities
  // that come and go across a page reload.
  check("/me returns the same capabilities as login",
    meBody.user?.permissions, settled.body.user?.permissions);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and none of this leaks the password ---");

  check("no password field on the login payload",
    Object.keys(settled.body.user ?? {}).filter((k) => /password/i.test(k)),
    ["mustResetPassword"]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
