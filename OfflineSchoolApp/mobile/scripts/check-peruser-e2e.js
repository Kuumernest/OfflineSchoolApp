// mobile/scripts/check-peruser-e2e.js
"use strict";

/**
 * Per-user local data, end to end: one shared phone, the REAL backend.
 *
 * The real mobile modules over real SQLite files (peruser-harness.js), the
 * real auth store signing in over HTTP to the real /auth/login (which carries
 * the school's switch), the real SyncManager — its first full sync of a new
 * store included — talking to the real sync, announcement, admin and
 * super-admin routers behind the real authenticate and Idempotency-Key
 * middleware, over an in-memory MongoDB.
 *
 *   1. With the switch off (today), two administrators each write an
 *      announcement offline on the same phone and sign out; an older build
 *      left a third with no owner. Nothing reaches the server.
 *   2. The platform turns the school's switch on (PUT offline-settings).
 *   3. The first signs in: their own store is prepared by a full sync, their
 *      change is placed in it and sent — once, under their account. The other
 *      account's change is not sent. The ownerless one is not sent.
 *   4. The second signs in: the same for theirs.
 *   5. More syncs by both: nothing is sent twice.
 *   6. The held change is sent only when an administrator, confirming, sends
 *      it as themselves — once, under that administrator.
 *
 *   node scripts/check-peruser-e2e.js
 */

const path   = require("path");
const Module = require("module");
const { bootDevice, tmpDir, quietly } = require("./peruser-harness");

const BACKEND = path.join(__dirname, "..", "..", "backend");
const breq = Module.createRequire(path.join(BACKEND, "package.json"));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "check-only-refresh-secret";
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

  const express  = breq("express");
  const mongoose = breq("mongoose");
  const jwt      = breq("jsonwebtoken");
  const { MongoMemoryServer } = breq("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "peruser-e2e" });

  const S = "5c0e2e000000000000000001";
  const PW = "Check-only-passw0rd";
  const { app, models } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const models = {
      User: mongoose.model("User"), School: mongoose.model("School"),
      Announcement: breq(path.join(BACKEND, "src/db/models/Announcement")),
    };
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    app.use("/api/auth", breq(path.join(BACKEND, "src/routes/auth.routes")));
    app.use("/api", auth.authenticate, breq(path.join(BACKEND, "middleware/idempotency")));
    app.use("/api/super-admin",   auth.authenticate, breq(path.join(BACKEND, "src/routes/superAdmin.routes")));
    app.use("/api/sync",          auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use("/api/announcements", auth.authenticate, breq(path.join(BACKEND, "src/routes/announcement.routes")));
    app.use("/api/admin",         auth.authenticate, breq(path.join(BACKEND, "src/routes/admin.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));
    return { app, models };
  })();
  const { User, School, Announcement } = models;
  await School.create({ _id: S, name: "Shared Phone School", code: "SPS", email: "sps@example.test" });
  for (const [id, name] of [["adm-one", "Head"], ["adm-two", "Deputy"]]) {
    await User.create({ _id: id, name, email: `${id}@e2e.test`, password: PW, role: "school_admin", schoolId: S, isActive: true });
  }
  await User.create({ _id: "root", name: "Root", email: "root@e2e.test", password: PW, role: "super_admin", schoolId: null, isActive: true });

  const server = app.listen(0);
  // Node's fetch reuses keep-alive sockets; the server's default 5 s idle close
  // can land on a socket the client is just reusing, and the request dies as
  // "fetch failed" (seen here as a sign-in refused under load). The phone uses
  // React Native's networking, not undici, so this is the harness's race —
  // keep idle sockets open longer than any pause in the script.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const port = server.address().port;
  const API = `http://127.0.0.1:${port}/api`;

  // The phone. api.js is axios plus the bearer and the offline guard.
  const axios = require("axios");
  const http = axios.create({ baseURL: API, timeout: 15_000 });
  let phone = null;
  const sent = [];
  http.interceptors.request.use((cfg) => {
    if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
    cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
    if (!["get", "head"].includes(String(cfg.method).toLowerCase())) sent.push(`${cfg.method} ${cfg.url}`);
    return cfg;
  });
  const dir = tmpDir("e2e");
  phone = await bootDevice({ dir, api: http, apiUrl: API });
  const { load, net, useAuthStore } = phone;
  const { SyncManager } = load("src/services/syncManager");
  const ann = load("src/services/announcement.service");
  const LD = load("src/services/perUserData.service");
  const { activeDatabaseName } = load("src/db/database");

  const waitIdle = async () => {
    for (let i = 0; i < 6000 && useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const login = async (id) => {
    const ok = await quietly(() => useAuthStore.getState().login({ email: `${id}@e2e.test`, password: PW }))();
    await waitIdle();
    return ok;
  };
  const logout = quietly(() => useAuthStore.getState().logout());
  const sync = quietly(async () => { await SyncManager.ensureStarted(); await SyncManager.syncAll({ force: true }); });
  const onServer = async () => (await Announcement.find({ schoolId: S }).lean())
    .map((a) => [a.title, String(a.author?._id ?? a.author ?? a.authorId ?? "")]).sort();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. switch off: two accounts work offline on one phone ---");
  check("first administrator signs in", await login("adm-one"), true);
  check("…the school's switch is off: the shared file, as always", activeDatabaseName(), "schoolapp.db");
  await sync();
  net.connected = false;
  await quietly(() => ann.createAnnouncement({ title: "From one", body: "written offline by Head" }))();
  await quietly(() => SyncManager.backfillOutbox())();
  await logout();
  net.connected = true;
  check("second administrator signs in", await login("adm-two"), true);
  net.connected = false;
  await quietly(() => ann.createAnnouncement({ title: "From two", body: "written offline by Deputy" }))();
  await quietly(() => SyncManager.backfillOutbox())();
  await logout();
  // What an older build left: written while nobody was recorded.
  const legacy = phone.inspect("schoolapp.db");
  legacy.all("SELECT 1");
  legacy.close();
  {
    const { DatabaseSync } = require("node:sqlite");
    const w = new DatabaseSync(path.join(dir, "schoolapp.db"));
    w.prepare(`INSERT INTO announcements (id, title, body, author_id, school_id, audience, _synced, _operation, created_at, updated_at)
               VALUES ('ann-orphan', 'Nobody''s', 'older build', 'left-the-school', ?, 'all', 0, 'create', '2026-09-01', '2026-09-01')`).run(S);
    w.close();
  }
  net.connected = true;
  check("nothing has reached the server", await onServer(), []);
  check("no per-user data exists yet", phone.exists("device.db"), false);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. the platform turns the school's switch on ---");
  const rootToken = jwt.sign({ id: "root", role: "super_admin", schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const put = await fetch(`${API}/super-admin/schools/${S}/offline-settings`, {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${rootToken}` },
    body: JSON.stringify({ perUserLocalData: true }),
  });
  check("PUT offline-settings: 200", put.status, 200);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. the first administrator signs in: own store, own change, once ---");
  sent.length = 0;
  check("signs in", await login("adm-one"), true);
  check("their own store is active after its first full sync", activeDatabaseName(), LD.storeFileFor("adm-one"));
  await sync();
  check("their change is on the server once, under their account", await onServer(), [["From one", "adm-one"]]);
  check("the other account's change was not sent as them", sent.filter((s) => /announcements/.test(s)).length, 1);
  await sync();
  check("a second sync sends nothing more", await onServer(), [["From one", "adm-one"]]);
  await logout();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. the second administrator signs in: the same, for theirs ---");
  check("signs in", await login("adm-two"), true);
  check("their own store is active", activeDatabaseName(), LD.storeFileFor("adm-two"));
  await sync();
  check("each change once, each under the right account", await onServer(), [["From one", "adm-one"], ["From two", "adm-two"]]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. more syncs by both: nothing twice ---");
  await sync();
  await logout();
  await login("adm-one");
  await sync();
  await logout();
  await login("adm-two");
  await sync();
  check("still exactly two announcements", await onServer(), [["From one", "adm-one"], ["From two", "adm-two"]]);
  check("the change with no owner is held, not sent", (await LD.listReview()).map((i) => [i.id, i.status]), [["dirty:announcements:ann-orphan", "held"]]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. a held change goes only when an administrator sends it as themselves ---");
  const me = useAuthStore.getState().user;
  check("send as me (confirmed)", await quietly(LD.sendReviewItemAsMe)("dirty:announcements:ann-orphan", { by: me, confirmed: true }), { ok: true });
  await sync();
  await sync();
  check("it arrives once, under the administrator who sent it",
    await onServer(), [["From one", "adm-one"], ["From two", "adm-two"], ["Nobody's", "adm-two"]]);
  const acc = await LD.accountLegacy({ verifyFiles: true });
  if (acc.totals.unplaced) console.log("UNPLACED", JSON.stringify(acc.items.filter((i) => i.state === "unplaced")));
  check("the shared file's accounting: nothing unplaced, nothing waiting", [acc.totals.unplaced, acc.totals["waiting-owner"]], [0, 0]);
  await logout();

  server.close();
  phone.kill();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
