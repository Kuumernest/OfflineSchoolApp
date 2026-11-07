// backend/scripts/check-offline-switch.js
"use strict";

/**
 * The per-school switch for per-user local data on phones (docs/40 D7).
 *
 *   - default OFF: a new school, and a school created before the field existed,
 *     both answer false — and the phone is told so at sign-in and refresh;
 *   - only the platform can turn it on: a school admin, bursar, teacher and
 *     student get 403 from the toggle, and their school is unchanged;
 *   - a super_admin turns it on for ONE school; the other school stays off;
 *   - the change is audited, and the phone learns it at the next sign-in and
 *     token refresh (the two moments every phone talks to the server);
 *   - bad input (not a boolean, unknown school) is refused without a write.
 *
 * Real routers (auth, super-admin) behind the real authenticate middleware,
 * over an in-memory MongoDB.
 *
 *   node scripts/check-offline-switch.js
 */

process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-only-refresh-secret-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School   = mongoose.model("School");
  const User     = mongoose.model("User");
  const AuditLog = mongoose.model("AuditLog");
  await School.init();

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const PASSWORD = "Check-only-passw0rd";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  // A school stored before settings.offline existed: the field is absent.
  await School.collection.updateOne({ _id: new mongoose.Types.ObjectId(B) }, { $unset: { "settings.offline": "" } });

  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("root",      "super_admin",  null),
    mkUser("admin-a",   "school_admin", A),
    mkUser("bursar-a",  "bursar",       A),
    mkUser("teacher-a", "teacher",      A),
    mkUser("teacher-b", "teacher",      B),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",        require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: out };
  };
  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const login = (email) => call("POST", "/auth/login", { body: { email, password: PASSWORD } });
  const stored = async (id) => (await School.findById(id).lean())?.settings?.offline?.perUserLocalData ?? null;
  const toggle = (id, token, body) => call("PUT", `/super-admin/schools/${id}/offline-settings`, { token, body });

  console.log("--- default off, and the phone is told so ---");
  {
    const a = await login("teacher-a@example.test");
    check("sign-in answers 200", a.status, 200);
    check("a new school's phones are told: off", a.body.localData, { perUserLocalData: false });
    const b = await login("teacher-b@example.test");
    check("a school stored before the field existed: off", b.body.localData, { perUserLocalData: false });
    const root = await login("root@example.test");
    check("a super_admin (no school) is always off", root.body.localData, { perUserLocalData: false });
    check("the model default is false", await stored(A), false);
  }

  console.log("--- only the platform can switch it ---");
  for (const [who, token] of [
    ["school admin", sign("admin-a", "school_admin", A)],
    ["bursar",       sign("bursar-a", "bursar", A)],
    ["teacher",      sign("teacher-a", "teacher", A)],
  ]) {
    const r = await toggle(A, token, { perUserLocalData: true });
    check(`a ${who} is refused (403)`, r.status, 403);
  }
  check("…and the school is unchanged", await stored(A), false);
  {
    const r = await call("PUT", `/super-admin/schools/${A}/offline-settings`, { body: { perUserLocalData: true } });
    check("no token: 401", r.status, 401);
  }

  console.log("--- bad input writes nothing ---");
  const ROOT_T = sign("root", "super_admin", null);
  check("a string is refused (400)", (await toggle(A, ROOT_T, { perUserLocalData: "yes" })).status, 400);
  check("a missing value is refused (400)", (await toggle(A, ROOT_T, {})).status, 400);
  check("an unknown school is 404", (await toggle("68c0000000000000000000ff", ROOT_T, { perUserLocalData: true })).status, 404);
  check("a non-id is 404", (await toggle("nope", ROOT_T, { perUserLocalData: true })).status, 404);
  check("still off", await stored(A), false);

  console.log("--- a super_admin turns it on for one school ---");
  {
    const r = await toggle(A, ROOT_T, { perUserLocalData: true, reason: "pilot" });
    check("200", r.status, 200);
    check("answers the new value, changed", [r.body.offline, r.body.changed], [{ perUserLocalData: true }, true]);
    check("stored on school A", await stored(A), true);
    check("school B untouched", (await School.findById(B).lean())?.settings?.offline?.perUserLocalData ?? false, false);
    const again = await toggle(A, ROOT_T, { perUserLocalData: true });
    check("repeating it is a no-op (changed: false)", again.body.changed, false);
    const audit = await AuditLog.find({ action: "school.offlineSettingsChanged" }).lean();
    check("audited once, with before/after and the reason",
      audit.map((x) => [x.schoolId, x.before, x.after, x.reason, x.actorId]),
      [[A, { perUserLocalData: false }, { perUserLocalData: true }, "pilot", "root"]]);
    const read = await call("GET", `/super-admin/schools/${A}/offline-settings`, { token: ROOT_T });
    check("GET reads it back", read.body.offline, { perUserLocalData: true });
    const readAdmin = await call("GET", `/super-admin/schools/${A}/offline-settings`, { token: sign("admin-a", "school_admin", A) });
    check("a school admin cannot read the platform route either", readAdmin.status, 403);
  }

  console.log("--- delivered to the phone at sign-in and refresh ---");
  {
    const a = await login("teacher-a@example.test");
    check("school A's teacher is told: on", a.body.localData, { perUserLocalData: true });
    const b = await login("teacher-b@example.test");
    check("school B's teacher is still told: off", b.body.localData, { perUserLocalData: false });
    const r = await call("POST", "/auth/refresh", { body: { refreshToken: a.body.refreshToken } });
    check("refresh answers 200", r.status, 200);
    check("refresh carries it too", r.body.localData, { perUserLocalData: true });
  }

  console.log("--- and back off ---");
  {
    const r = await toggle(A, ROOT_T, { perUserLocalData: false });
    check("turned off", [r.status, r.body.offline], [200, { perUserLocalData: false }]);
    check("the phone is told: off", (await login("teacher-a@example.test")).body.localData, { perUserLocalData: false });
  }

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
