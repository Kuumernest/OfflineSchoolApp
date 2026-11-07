// backend/scripts/check-app-version-policy.js
"use strict";

/**
 * "Never downgrade a school with the per-user switch on" (docs/40 §8.9),
 * enforced by the server.
 *
 *   - switch ON + a phone build older than the per-user data format, or a
 *     phone that sends no version at all (every build before this policy):
 *     426 APP_UPDATE_REQUIRED on /auth/login, on both /auth/refresh modes, on
 *     /sync/* and on writes — no session, no sync;
 *   - switch ON + a current build: everything as before;
 *   - switch OFF + an old build: never refused, a warning header only;
 *   - web, desktop, scripts (not a phone): never refused;
 *   - super_admin: no school switch, never refused;
 *   - the mounts in server.js are in place.
 *
 * Real auth and sync routers behind the real authenticate middleware, over an
 * in-memory MongoDB.
 *
 *   node scripts/check-app-version-policy.js
 */

process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

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
  const School = mongoose.model("School");
  const User   = mongoose.model("User");
  await School.init();

  const ON  = "68c0000000000000000000a1";
  const OFF = "68c0000000000000000000b2";
  const PASSWORD = "Check-only-passw0rd";
  await School.create([
    { _id: ON,  name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test", settings: { offline: { perUserLocalData: true } } },
    { _id: OFF, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("root",       "super_admin", null),
    mkUser("teacher-on", "teacher",     ON),
    mkUser("teacher-off","teacher",     OFF),
  ]);

  let policy = null;
  try { policy = require(path.join(SRC, "services/appVersionPolicy.service")); } catch { /* red */ }
  const gate = policy ? policy.requireSupportedMobileBuild : () => (_q, _s, n) => n();

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const optionalAuthenticate = (req, res, next) =>
    (req.headers.authorization || "").startsWith("Bearer ") ? auth.authenticate(req, res, next) : next();

  // The same mounts as src/server.js (asserted at the end).
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require(path.join(SRC, "routes/auth.routes")));
  app.use("/api", optionalAuthenticate, gate({ writesOnly: true }));
  app.use("/api/sync", auth.authenticate, gate(), require(path.join(SRC, "routes/sync.routes")));
  app.post("/api/things", auth.authenticate, (_req, res) => res.status(201).json({ success: true }));
  app.get("/api/things",  auth.authenticate, (_req, res) => res.json({ success: true }));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  // What each client sends.
  const CLIENTS = {
    current:   { "X-App-Platform": "android", "X-App-Version": "0.3.0", "X-App-Data-Format": "1" },
    currentIos:{ "X-App-Platform": "ios",     "X-App-Version": "0.3.0", "X-App-Data-Format": "1" },
    oldFormat: { "X-App-Platform": "android", "X-App-Version": "0.1.0", "X-App-Data-Format": "0" },
    noFormat:  { "X-App-Platform": "android", "X-App-Version": "0.2.0" },
    legacyAndroid: { "User-Agent": "okhttp/4.12.0" },
    legacyIos:     { "User-Agent": "mobile/1 CFNetwork/1494.0.7 Darwin/23.4.0" },
    browser:   { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0" },
    web:       { "X-App-Platform": "web", "User-Agent": "Mozilla/5.0" },
    desktop:   { "X-App-Platform": "desktop", "X-App-Data-Format": "0", "User-Agent": "node" },
  };

  const call = async (method, url, { token, body, client = {} } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...client,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: out, warn: res.headers.get("x-app-update-recommended") };
  };
  const login = (email, client) => call("POST", "/auth/login", { body: { email, password: PASSWORD }, client });
  const sign  = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // A refresh token minted the ordinary way (a current build signed in).
  const seed = await login("teacher-on@example.test", CLIENTS.current);
  const RT_ON  = seed.body.refreshToken;
  const RT_OFF = (await login("teacher-off@example.test", CLIENTS.current)).body.refreshToken;
  const AT_ON  = sign("teacher-on", "teacher", ON);
  const AT_OFF = sign("teacher-off", "teacher", OFF);

  const refuse = (r) => [r.status, r.body.code];
  const REFUSED = [426, "APP_UPDATE_REQUIRED"];

  console.log("--- switch ON: an old or silent phone build is refused ---");
  for (const who of ["oldFormat", "noFormat", "legacyAndroid", "legacyIos"]) {
    const client = CLIENTS[who];
    check(`${who}: sign-in → 426 APP_UPDATE_REQUIRED`, refuse(await login("teacher-on@example.test", client)), REFUSED);
    const a = await call("POST", "/auth/refresh", { body: { refreshToken: RT_ON }, client });
    check(`${who}: refresh (refresh token) → 426`, refuse(a), REFUSED);
    const b = await call("POST", "/auth/refresh", { token: AT_ON, client });
    check(`${who}: refresh (access token) → 426`, refuse(b), REFUSED);
    const p = await call("GET", `/sync/pull?schoolId=${ON}`, { token: AT_ON, client });
    check(`${who}: /sync/pull → 426`, refuse(p), REFUSED);
    const w = await call("POST", "/things", { token: AT_ON, client, body: { x: 1 } });
    check(`${who}: a write → 426`, refuse(w), REFUSED);
  }
  {
    const r = await login("teacher-on@example.test", CLIENTS.legacyAndroid);
    check("the answer says what to do, and the format it needs",
      [r.body.message?.startsWith("Update the app to keep syncing"), r.body.minDataFormat, r.body.token], [true, 1, undefined]);
    const wrong = await call("POST", "/auth/login", { body: { email: "teacher-on@example.test", password: "wrong-Passw0rd" }, client: CLIENTS.legacyAndroid });
    check("a wrong password is still 401 (the version is not an oracle before the password)", wrong.status, 401);
  }

  console.log("--- switch ON: a current build is served as before ---");
  for (const who of ["current", "currentIos"]) {
    const client = CLIENTS[who];
    const l = await login("teacher-on@example.test", client);
    check(`${who}: sign-in 200 with a token and localData on`, [l.status, !!l.body.token, l.body.localData], [200, true, { perUserLocalData: true }]);
    check(`${who}: no warning header`, l.warn, null);
    check(`${who}: refresh (refresh token) 200`, (await call("POST", "/auth/refresh", { body: { refreshToken: RT_ON }, client })).status, 200);
    check(`${who}: refresh (access token) 200`, (await call("POST", "/auth/refresh", { token: AT_ON, client })).status, 200);
    check(`${who}: /sync/pull 200`, (await call("GET", `/sync/pull?schoolId=${ON}`, { token: AT_ON, client })).status, 200);
    check(`${who}: a write 201`, (await call("POST", "/things", { token: AT_ON, client, body: {} })).status, 201);
  }

  console.log("--- switch ON: not a phone, never refused ---");
  for (const who of ["browser", "web", "desktop"]) {
    const client = CLIENTS[who];
    check(`${who}: sign-in 200`, (await login("teacher-on@example.test", client)).status, 200);
    check(`${who}: /sync/pull 200`, (await call("GET", `/sync/pull?schoolId=${ON}`, { token: AT_ON, client })).status, 200);
    check(`${who}: a write 201`, (await call("POST", "/things", { token: AT_ON, client, body: {} })).status, 201);
  }
  check("no headers at all (a script, node fetch): sign-in 200", (await login("teacher-on@example.test", {})).status, 200);

  console.log("--- switch ON: an old phone may still read outside /sync (only writes are gated app-wide) ---");
  check("GET elsewhere 200", (await call("GET", "/things", { token: AT_ON, client: CLIENTS.legacyAndroid })).status, 200);

  console.log("--- switch OFF: an old build is never refused, only warned ---");
  for (const who of ["oldFormat", "noFormat", "legacyAndroid", "legacyIos"]) {
    const client = CLIENTS[who];
    const l = await login("teacher-off@example.test", client);
    check(`${who}: sign-in 200, warning header`, [l.status, !!l.body.token, l.warn], [200, true, "1"]);
    const a = await call("POST", "/auth/refresh", { body: { refreshToken: RT_OFF }, client });
    check(`${who}: refresh 200, warning header`, [a.status, a.warn], [200, "1"]);
    const b = await call("POST", "/auth/refresh", { token: AT_OFF, client });
    check(`${who}: refresh (access token) 200, warning header`, [b.status, b.warn], [200, "1"]);
    const p = await call("GET", `/sync/pull?schoolId=${OFF}`, { token: AT_OFF, client });
    check(`${who}: /sync/pull 200, warning header`, [p.status, p.warn], [200, "1"]);
    const w = await call("POST", "/things", { token: AT_OFF, client, body: {} });
    check(`${who}: a write 201`, w.status, 201);
  }
  check("current build, switch off: no warning", (await login("teacher-off@example.test", CLIENTS.current)).warn, null);

  console.log("--- super_admin has no school switch ---");
  check("an old phone build signs a super_admin in", (await login("root@example.test", CLIENTS.legacyAndroid)).status, 200);

  console.log("--- the switch turned on while an old build holds a session ---");
  {
    await School.updateOne({ _id: OFF }, { $set: { "settings.offline.perUserLocalData": true } });
    check("its next refresh is refused", refuse(await call("POST", "/auth/refresh", { body: { refreshToken: RT_OFF }, client: CLIENTS.legacyAndroid })), REFUSED);
    check("its next sync is refused", refuse(await call("GET", `/sync/pull?schoolId=${OFF}`, { token: AT_OFF, client: CLIENTS.legacyAndroid })), REFUSED);
    check("its next write is refused", refuse(await call("POST", "/things", { token: AT_OFF, client: CLIENTS.legacyAndroid, body: {} })), REFUSED);
    await School.updateOne({ _id: OFF }, { $set: { "settings.offline.perUserLocalData": false } });
  }

  console.log("--- server.js mounts the gate ---");
  {
    const src = fs.readFileSync(path.join(SRC, "server.js"), "utf8");
    check("on /api/sync, after authenticate", /app\.use\("\/api\/sync",\s*auth\.authenticate,\s*requireSupportedMobileBuild\(\),/.test(src), true);
    check("app-wide on writes, with the idempotency mount",
      /app\.use\("\/api", optionalAuthenticate, requireSupportedMobileBuild\(\{ writesOnly: true \}\), require\("\.\.\/middleware\/idempotency"\)\)/.test(src), true);
  }

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
