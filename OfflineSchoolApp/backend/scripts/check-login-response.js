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
 * The correct resolver was in the project the whole time, in an auth
 * controller no other file required. Reading it is what made the bug
 * invisible: the logic looked present and correct, and was simply never
 * reached. That file is gone; what was worth keeping moved into the router.
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

  // ═══════════════════════════════════════════════════════════════════════
  // A temporary password is worth less than a chosen one
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a flagged account gets a short-lived token ---");

  const jwt    = require("jsonwebtoken");
  const life   = (token) => {
    const { iat, exp } = jwt.decode(token);
    return exp - iat;
  };

  // Fifteen minutes while a password that was read aloud across an office is
  // still in force; the ordinary thirty days once it has been changed. The
  // reasoning was written in a controller nothing mounted, so the running app
  // signed thirty days for everybody.
  check("fifteen minutes while the flag is set", life(fresh.body.token), 15 * 60);
  check("and the ordinary lifetime once it is not",
    life(settled.body.token), 30 * 24 * 60 * 60);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and cannot be 'changed' to itself ---");

  const changePassword = async (token, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
      method:  "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json ?? {} };
  };

  // The reuse check used to sit inside the "not flagged" branch, so an account
  // on a temporary password could submit that same string: the flag cleared,
  // the screen said success, and the credential that had been shared over a
  // phone went on working with nothing left to prompt a real change.
  const reuse = await changePassword(fresh.body.token, {
    newPassword: PASS, confirmPassword: PASS,
  });
  check("reusing the temporary password is refused", reuse.status, 400);
  check("and says why",
    /different from your current password/.test(reuse.body.message ?? ""), true);

  const stillFlagged = await User.findOne({ email: "fresh@school.com" }).lean();
  check("the flag survives the refusal — otherwise nothing asks again",
    stillFlagged.mustResetPassword, true);

  console.log("--- but a real change works without the old password ---");

  // Waived on purpose for a forced reset: the user was signed in with something
  // they may never have typed themselves.
  const chosen = "Chosen-Pass-42";
  const done   = await changePassword(fresh.body.token, {
    newPassword: chosen, confirmPassword: chosen,
  });
  check("accepted with no currentPassword", done.status, 200);
  check("the flag is cleared", done.body.user?.mustResetPassword, false);
  check("and the replacement token is a normal one",
    life(done.body.token), 30 * 24 * 60 * 60);
  check("capabilities come back with it, not an empty list",
    (done.body.user?.permissions ?? []).length > 0, true);

  const after = await login("fresh@school.com", chosen);
  check("the new password works", after.status, 200);
  const old = await login("fresh@school.com", PASS);
  check("the temporary one no longer does", old.status, 401);

  // ═══════════════════════════════════════════════════════════════════════
  // Two failures that must not be told apart
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an unknown address costs what a wrong password costs ---");

  // Both answer "Invalid email or password", but they used to take markedly
  // different times: a real account meant a bcrypt comparison at cost 12, an
  // unknown address returned immediately. That gap is measurable over a network
  // and turns the login form into a way of asking whether an address holds an
  // account — worth knowing for a bursar or head teacher, whose addresses are
  // often public.
  const timeOf = async (email, password) => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      await login(email, password);
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return runs.sort((a, b) => a - b)[1];   // median of three
  };

  const wrongPassword = await timeOf("bursar@school.com", "Definitely-Wrong-9");
  const unknownEmail  = await timeOf("nobody@school.com", "Definitely-Wrong-9");
  const ratio         = unknownEmail / wrongPassword;

  // A generous floor. Without the guard the ratio is around 0.01 — an unknown
  // address skips the hash entirely — so this fails hard on a regression while
  // leaving room for a loaded CI runner.
  check("comparable, within an order of magnitude", ratio > 0.3, true);
  if (ratio <= 0.3) {
    console.log(`       wrong password ${wrongPassword.toFixed(1)}ms vs ` +
                `unknown address ${unknownEmail.toFixed(1)}ms (ratio ${ratio.toFixed(3)})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a legacy role name is canonicalised on the way out ---");

  // "admin" was never a value the User enum could store, but a row predating
  // the enum can hold it. The payload is what both clients route on, and the
  // web app's staff list does not contain "admin" — so such a user would be
  // shown the not-for-you wall.
  await User.collection.insertOne({
    _id: "legacy-1", name: "Legacy Head", email: "legacy@school.com",
    role: "admin", schoolId: SCHOOL, isActive: true,
    password: (await User.findOne({ email: "head@school.com" }).select("+password").lean()).password,
    mustResetPassword: false,
  });
  const legacy = await login("legacy@school.com");
  check("the legacy row can sign in", legacy.status, 200);
  check("and is reported as a school_admin",
    legacy.body.user?.role, ROLES.SCHOOL_ADMIN);
  check("with a school admin's capabilities",
    legacy.body.user?.permissions, defaultsFor(ROLES.SCHOOL_ADMIN));

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
