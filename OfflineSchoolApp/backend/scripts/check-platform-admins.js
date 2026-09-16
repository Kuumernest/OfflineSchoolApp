// backend/scripts/check-platform-admins.js
"use strict";

/**
 * The platform's own administrators, made and managed from the platform.
 *
 * A super_admin has no school and never gets one; the accounts that run the
 * deployment are created, renamed, switched on or off and reset from
 * /api/super-admin/admins, by a super_admin and nobody else. This proves the
 * rules that keep that safe: the role is not read from the request, the
 * password is hashed and never echoed or logged, an address already in use —
 * by anyone, a pupil included — is refused, nobody deactivates themself, and
 * the last active operator cannot be switched off. Alongside, the profile and
 * password routes a super_admin uses for their own account leave role and
 * scope exactly as they were, and a school's own staff management is untouched.
 *
 * Real routers behind the real door, an in-memory database. Never MONGODB_URI.
 *
 *   node scripts/check-platform-admins.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const bcrypt   = require("bcryptjs");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School   = mongoose.model("School");
  const User     = mongoose.model("User");
  const AuditLog = mongoose.model("AuditLog");
  await Promise.all([School.init(), User.init()]);

  const A = "68c0000000000000000000a1";
  const PASSWORD = "Check-only-passw0rd";
  await School.create({ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" });

  const mkUser = (id, role, schoolId, name, extra = {}) => User.create({
    _id: id, name, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true, ...extra,
  });
  await Promise.all([
    mkUser("root",      "super_admin",  null, "Root Operator"),
    mkUser("admin-a",   "school_admin", A,    "Admin A"),
    mkUser("bursar-a",  "bursar",       A,    "Bursar A"),
    mkUser("teacher-a", "teacher",      A,    "Teacher A"),
    mkUser("pupil-a",   "student",      A,    "Pupil A", { enrollmentNo: "A-0001" }),
  ]);

  // Everything written to the console while the suite runs, so a password
  // that leaks into a log line is caught rather than hoped against.
  const logLines = [];
  for (const m of ["log", "info", "warn", "error"]) {
    const orig = console[m].bind(console);
    console[m] = (...args) => { logLines.push(args.map(String).join(" ")); orig(...args); };
  }

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",        require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use("/api/admin",       auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));

  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const sign = (id, role, schoolId) =>
    jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as = (token) => ({
    get:   (url)       => call("GET",   url, { token }),
    post:  (url, body) => call("POST",  url, { token, body }),
    patch: (url, body) => call("PATCH", url, { token, body }),
    put:   (url, body) => call("PUT",   url, { token, body }),
  });

  const login = await call("POST", "/auth/login", { body: { email: "root@example.test", password: PASSWORD } });
  const root     = as(login.body.token);
  const adminA   = as(sign("admin-a",   "school_admin", A));
  const bursarA  = as(sign("bursar-a",  "bursar",       A));
  const teacherA = as(sign("teacher-a", "teacher",      A));

  const NEW_PASSWORD = "Operator-Two-2026";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1–5. the operator lists, creates, and the new one signs in ---");

  check("1. the settings surface answers a super_admin", (await root.get("/super-admin/admins")).status, 200);
  const list0 = await root.get("/super-admin/admins");
  check("2. it lists the platform administrators, and only those",
    list0.body.admins.map((a) => [a.email, a.role, a.schoolId]), [["root@example.test", "super_admin", null]]);
  check("   with no password field in any row", list0.body.admins.some((a) => "password" in a), false);

  const created = await root.post("/super-admin/admins", {
    name: "Second Operator", email: "Second@Example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
  });
  check("3. a super_admin can create another", created.status, 201);
  const stored = await User.findOne({ email: "second@example.test" }).select("+password").lean();
  check("4. the account is a platform account",
    [stored?.role, stored?.schoolId ?? null, stored?.isActive, stored?.mustResetPassword],
    ["super_admin", null, true, false]);
  check("   the email was lower-cased", created.body.admin?.email, "second@example.test");

  const second = await call("POST", "/auth/login", { body: { email: "second@example.test", password: NEW_PASSWORD } });
  check("5. the new operator signs in normally", [second.status, second.body.user?.role, second.body.user?.schoolId], [200, "super_admin", null]);
  const two = as(second.body.token);
  check("   and reaches the platform", (await two.get("/super-admin/dashboard")).status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6–8. nobody else reaches it ---");

  for (const [label, who] of [["6. a school admin", adminA], ["7. a teacher", teacherA], ["8. a bursar", bursarA]]) {
    check(`${label} cannot list platform administrators`, (await who.get("/super-admin/admins")).status, 403);
    check(`   nor create one`,
      (await who.post("/super-admin/admins", { name: "Planted", email: "planted@example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status, 403);
    check(`   nor change one`, (await who.patch("/super-admin/admins/root", { isActive: false })).status, 403);
  }
  check("   nothing was planted", await User.countDocuments({ email: "planted@example.test" }), 0);
  check("   a token claiming super_admin for a school admin's id is still refused",
    (await as(sign("admin-a", "super_admin", null)).get("/super-admin/admins")).status, 403);
  check("   and no token at all is a 401", (await call("GET", "/super-admin/admins")).status, 401);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9–13. what the account may and may not be ---");

  const dupStaff = await root.post("/super-admin/admins", { name: "Dup", email: "admin-a@example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  check("9. an address a school admin holds is refused", [dupStaff.status, dupStaff.body.code], [409, "EMAIL_TAKEN"]);
  const dupPupil = await root.post("/super-admin/admins", { name: "Dup", email: "pupil-a@example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  check("   and so is one a pupil holds", [dupPupil.status, dupPupil.body.code], [409, "EMAIL_TAKEN"]);
  const dupSelf = await root.post("/super-admin/admins", { name: "Dup", email: "SECOND@example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  check("   and one already an operator, whatever the case", dupSelf.status, 409);
  check("   none of which created a row", await User.countDocuments({ role: "super_admin" }), 2);

  check("10. the password is stored hashed",
    stored.password !== NEW_PASSWORD && /^\$2[aby]\$12\$/.test(stored.password) && await bcrypt.compare(NEW_PASSWORD, stored.password), true);

  check("11. the plaintext never came back in a response",
    JSON.stringify([created.body, list0.body, second.body]).includes(NEW_PASSWORD), false);
  check("    nor in anything written to the console", logLines.some((l) => l.includes(NEW_PASSWORD)), false);

  // Weak passwords are refused by the same rules sign-in enforces.
  for (const [why, pw] of [["too short", "Ab1"], ["no uppercase", "operator-2026"], ["no digit", "Operator-Two"]]) {
    check(`    a password that is ${why} is refused`,
      (await root.post("/super-admin/admins", { name: "Weak", email: `weak-${why.replace(/\W/g, "")}@example.test`, password: pw, confirmPassword: pw })).status, 400);
  }
  check("    a mismatched confirmation is refused",
    (await root.post("/super-admin/admins", { name: "Mis", email: "mis@example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD + "x" })).status, 400);

  // The role cannot be smuggled in: the route makes one kind of account.
  const smuggled = await root.post("/super-admin/admins", {
    name: "Third Operator", email: "third@example.test", password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD,
    role: "school_admin", schoolId: A,
  });
  check("13. a role or school in the body is ignored — no school is ever required or accepted",
    [smuggled.status, smuggled.body.admin?.role, smuggled.body.admin?.schoolId], [201, "super_admin", null]);
  check("    and stored that way", (await User.findOne({ email: "third@example.test" }).lean()).schoolId ?? null, null);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 12. the platform stays reachable ---");

  // Three active operators now: root, second, third.
  check("three are active", await User.countDocuments({ role: "super_admin", isActive: true }), 3);
  const off3 = await root.patch("/super-admin/admins/" + created.body.admin._id, { isActive: false });
  check("3 active → deactivate one → allowed", [off3.status, off3.body.admin?.isActive], [200, false]);
  check("   and the deactivated operator can no longer sign in",
    (await call("POST", "/auth/login", { body: { email: "second@example.test", password: NEW_PASSWORD } })).status, 401);

  const thirdId = smuggled.body.admin._id;
  const off2 = await root.patch("/super-admin/admins/" + thirdId, { isActive: false });
  check("2 active → deactivate one → allowed", [off2.status, off2.body.admin?.isActive], [200, false]);

  const self = await root.patch("/super-admin/admins/root", { isActive: false });
  check("1 active → deactivate → rejected", [self.status, self.body.code], [409, "LAST_SUPER_ADMIN"]);
  check("   and the operator is still active", (await User.findById("root").lean()).isActive, true);

  const backOn = await root.patch("/super-admin/admins/" + thirdId, { isActive: true });
  check("reactivation is allowed", [backOn.status, backOn.body.admin?.isActive], [200, true]);
  const selfWithOthers = await root.patch("/super-admin/admins/root", { isActive: false });
  check("even with another operator active, nobody deactivates themself",
    [selfWithOthers.status, selfWithOthers.body.code], [409, "CANNOT_DEACTIVATE_SELF"]);

  const renamed = await root.patch("/super-admin/admins/" + thirdId, { name: "Third Operator, renamed" });
  check("a rename goes through", [renamed.status, renamed.body.admin?.name], [200, "Third Operator, renamed"]);
  const clash = await root.patch("/super-admin/admins/" + thirdId, { email: "admin-a@example.test" });
  check("an email change onto a taken address is refused", [clash.status, clash.body.code], [409, "EMAIL_TAKEN"]);
  check("a school admin's id is not a platform administrator",
    (await root.patch("/super-admin/admins/admin-a", { name: "x" })).status, 404);

  const reset = await root.post("/super-admin/admins/" + thirdId + "/reset-password", {});
  check("a password reset issues a temporary password the person must change",
    [reset.status, typeof reset.body.tempPassword, (await User.findById(thirdId).lean()).mustResetPassword], [200, "string", true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 14. a school's own staff management is unchanged ---");

  const own = await adminA.get("/admin/settings/admins");
  check("14. a school admin still lists their own school's office staff",
    [own.status, (own.body.admins ?? []).map((u) => u.email).sort()], [200, ["admin-a@example.test", "bursar-a@example.test"]]);
  check("    which never includes a platform administrator",
    (own.body.admins ?? []).some((u) => u.role === "super_admin"), false);
  const appoint = await adminA.post("/admin/settings/admins", { name: "New Bursar", email: "bursar-2@example.test", role: "bursar" });
  check("    and can still appoint a bursar", [appoint.status, appoint.body.admin?.role, appoint.body.admin?.schoolId], [201, "bursar", A]);
  const escalate = await adminA.post("/admin/settings/admins", { name: "Sneaky", email: "sneaky@example.test", role: "super_admin" });
  check("    but not a super_admin", escalate.status, 403);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 15–18. the operator's own profile ---");

  const me = await root.get("/auth/me");
  check("15. the operator loads their own profile",
    [me.status, me.body.user?.name, me.body.user?.role, me.body.user?.schoolId], [200, "Root Operator", "super_admin", null]);
  check("    without a password field", "password" in (me.body.user ?? {}), false);

  const profile = await root.put("/admin/settings/profile", { name: "Root Operator, renamed", email: "root@example.test" });
  check("16. the operator updates their name", [profile.status, profile.body.profile?.name], [200, "Root Operator, renamed"]);
  const taken = await root.put("/admin/settings/profile", { name: "Root", email: "admin-a@example.test" });
  check("    but not onto an address someone else holds", taken.status, 409);

  const CHANGED = "Root-Operator-2027";
  const changed = await root.post("/auth/change-password", {
    currentPassword: PASSWORD, newPassword: CHANGED, confirmPassword: CHANGED,
  });
  check("17. the operator changes their password through the existing flow", [changed.status, Boolean(changed.body.token)], [200, true]);
  check("    the old password no longer signs in",
    (await call("POST", "/auth/login", { body: { email: "root@example.test", password: PASSWORD } })).status, 401);
  check("    the new one does",
    (await call("POST", "/auth/login", { body: { email: "root@example.test", password: CHANGED } })).status, 200);
  check("    weak replacements are refused by the shared policy",
    (await as(changed.body.token).post("/auth/change-password", { currentPassword: CHANGED, newPassword: "short", confirmPassword: "short" })).status, 400);

  const after = await User.findById("root").lean();
  check("18. none of that touched the role or the scope", [after.role, after.schoolId ?? null, after.isActive], ["super_admin", null, true]);
  check("    and the plaintext of the changed password was never logged", logLines.some((l) => l.includes(CHANGED)), false);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the trail ---");

  const trail = await AuditLog.find({ action: /^superAdmin\./ }).sort({ at: 1 }).lean();
  check("every action was recorded, in order",
    trail.map((e) => e.action),
    ["superAdmin.created", "superAdmin.created", "superAdmin.deactivated", "superAdmin.deactivated",
     "superAdmin.activated", "superAdmin.updated", "superAdmin.passwordReset"]);
  check("by the operator who did it", new Set(trail.map((e) => e.actorId)).size === 1 && trail[0].actorId === "root", true);
  check("naming the account, not its password",
    JSON.stringify(trail).includes(NEW_PASSWORD) || JSON.stringify(trail).includes(reset.body.tempPassword), false);
  // The password change above invalidated the token root signed in with — the
  // staleness gate at the door — so the trail is read with the new one.
  const audited = await as(changed.body.token).get("/super-admin/audit?action=superAdmin.created");
  check("and the platform audit route lists them",
    [audited.status, audited.body.entries?.length ?? 0, audited.body.actions?.includes("superAdmin.created")],
    [200, 2, true]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("\n  check-platform-admins crashed:", err);
  process.exit(1);
});
