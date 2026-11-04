// mobile/scripts/check-credential-rows.js
"use strict";

/**
 * A sign-in's credential cache must never be sent as a teacher create.
 *
 * The online sign-in caches its account in `users` (auth.store.js →
 * db/credentialCache.js). The row used to be inserted with the column's
 * default `_synced = 0`, and the backfill's "teacher" spec
 * (syncBackfill.service.js) matched every dirty `users` row with
 * role = 'teacher'. So on a shared phone, once a teacher had signed in, the
 * next administrator's sync POSTed that teacher to /admin/teachers as a new
 * account. On the real server (admin.routes.js claimStaffEmail):
 *   - an active teacher → 409 "Email already registered" → an outbox row
 *     parked as a conflict ("needs attention") that nothing resolves;
 *   - a teacher the school had since REMOVED (deactivated) → the account is
 *     RESTORED: reactivated, given a new temporary password (their own stops
 *     working) and emailed it.
 *
 * The REAL phone (peruser-harness.js: the real auth store signing in over
 * HTTP, the real SyncManager, outbox and backfill over real SQLite files)
 * against the REAL backend routes (auth, sync, admin) over an in-memory
 * MongoDB. Assertions read the requests the phone sent and MongoDB.
 *
 *   1. teachers sign in on the phone; one is removed by the school; the
 *      administrator signs in and syncs → nothing is POSTed for them, the
 *      removed teacher stays removed with their password unchanged, nothing
 *      parked;
 *   2. a teacher created offline by the administrator is still sent, once;
 *   3. a phone the old build already left behind (dirty credential rows and
 *      a parked POST for one of them) is repaired: the parked credential POST
 *      is dropped, the flag cleared, while a genuine unsent create alongside
 *      it is kept and lands.
 *
 *   node scripts/check-credential-rows.js
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
  const { MongoMemoryServer } = breq("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "credential-rows" });

  const S = "5c0e2e000000000000000001";
  const PW = "Check-only-passw0rd";
  const { app, User } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const User = mongoose.model("User");
    await mongoose.model("School").create({ _id: S, name: "Shared Phone School", code: "SPS", email: "sps@example.test" });
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    app.use("/api/auth", breq(path.join(BACKEND, "src/routes/auth.routes")));
    app.use("/api", auth.authenticate, breq(path.join(BACKEND, "middleware/idempotency")));
    app.use("/api/sync",  auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use("/api/admin", auth.authenticate, breq(path.join(BACKEND, "src/routes/admin.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));
    return { app, User };
  })();

  await User.create({ _id: "adm", name: "Head", email: "head@e2e.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await User.create({ _id: "tea-live", name: "Ama Owusu", email: "ama@e2e.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  await User.create({ _id: "tea-gone", name: "Kofi Mensah", email: "kofi@e2e.test", password: PW, role: "teacher", schoolId: S, isActive: true });

  const server = app.listen(0);
  // Node's fetch reuses keep-alive sockets; the server's default 5 s idle close
  // can land on a socket the client is just reusing, and the request dies as
  // "fetch failed" (seen here as a sign-in refused under load). The phone uses
  // React Native's networking, not undici, so this is the harness's race —
  // keep idle sockets open longer than any pause in the script.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const axios = require("axios");
  const sent = [];
  const boot = async (dir) => {
    const http = axios.create({ baseURL: API, timeout: 15_000 });
    let phone = null;
    http.interceptors.request.use((cfg) => {
      if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
      cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
      if (!["get", "head"].includes(String(cfg.method).toLowerCase())) {
        sent.push({ m: String(cfg.method).toUpperCase(), url: cfg.url, email: (typeof cfg.data === "string" ? JSON.parse(cfg.data) : cfg.data)?.email ?? null });
      }
      return cfg;
    });
    phone = await bootDevice({ dir, api: http, apiUrl: API });
    return phone;
  };
  const waitIdle = async (phone) => {
    for (let i = 0; i < 6000 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const login = async (phone, email) => {
    const ok = await quietly(() => phone.useAuthStore.getState().login({ email, password: PW }))();
    await waitIdle(phone);
    if (ok !== true) {
      // Say why, so a refused sign-in is a diagnosis rather than "got false".
      const st = phone.useAuthStore.getState();
      console.log(`       sign-in of ${email} returned ${ok}: isLoading=${st.isLoading} error=${st.errorKey ?? ""} ${st.error ?? ""}`);
    }
    return ok;
  };
  const logout = (phone) => quietly(() => phone.useAuthStore.getState().logout())();
  const sync = (phone) => quietly(async () => {
    const { SyncManager } = phone.load("src/services/syncManager");
    await SyncManager.ensureStarted();
    // Wait out a sync already running (the phone starts one 3 s after any
    // save), or syncAll returns at once ("Already syncing") and the check
    // looks before anything was sent. Waiting again after covers one that
    // started in between — it began after the change, so it carries it.
    const idle = async () => { for (let i = 0; i < 6000 && SyncManager.isSyncing; i++) await new Promise((r) => setTimeout(r, 10)); };
    await idle();
    await SyncManager.syncAll({ force: true });
    await idle();
  })();
  const teacherPosts = () => sent.filter((s) => s.m === "POST" && /\/admin\/teachers\/?$/.test(s.url));
  const parked = (phone) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.all("SELECT entity_key, status, last_status FROM mutation_outbox WHERE status != 'synced' ORDER BY entity_key"); } finally { d.close(); }
  };
  const usersRow = (phone, id) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.one("SELECT id, role, _synced, passwordHash IS NOT NULL AS cached FROM users WHERE id = ?", [id]); } finally { d.close(); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. teachers sign in on a shared phone; the administrator syncs ---");
  const dir = tmpDir("credrows");
  const phone = await boot(dir);
  check("Ama (teacher) signs in online", await login(phone, "ama@e2e.test"), true);
  await logout(phone);
  check("Kofi (teacher) signs in online", await login(phone, "kofi@e2e.test"), true);
  await logout(phone);
  // The school removes Kofi from the web console while the phone sits idle.
  await User.updateOne({ _id: "tea-gone" }, { isActive: false });
  const kofiPasswordBefore = (await User.findById("tea-gone").select("+password").lean()).password;

  const ama = usersRow(phone, "tea-live");
  check("the sign-in cached Ama's row: role teacher, with a credential", [ama?.role, ama?.cached], ["teacher", 1]);
  check("…and it is not marked as a local change (_synced = 1)", ama?._synced, 1);

  sent.length = 0;
  check("the administrator signs in online", await login(phone, "head@e2e.test"), true);
  await sync(phone);
  await sync(phone);
  check("no POST /admin/teachers was sent for the cached teachers", teacherPosts().map((s) => s.email), []);
  const kofi = await User.findById("tea-gone").select("+password").lean();
  check("the removed teacher is still removed, password unchanged", [kofi.isActive, kofi.password === kofiPasswordBefore], [false, true]);
  check("one account per teacher email on the server",
    [await User.countDocuments({ email: "ama@e2e.test" }), await User.countDocuments({ email: "kofi@e2e.test" })], [1, 1]);
  check("nothing parked in the outbox", parked(phone), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. a teacher created offline is still sent ---");
  phone.net.connected = false;
  const { TeacherService } = phone.load("src/services/teacher.service");
  const localId = await quietly(() => TeacherService.create("Esi Boateng", "esi@e2e.test"))();
  check("created locally under a local id", /^local_/.test(String(localId)), true);
  phone.net.connected = true;
  sent.length = 0;
  await sync(phone);
  await sync(phone);
  check("POST /admin/teachers sent once, for Esi", teacherPosts().map((s) => s.email), ["esi@e2e.test"]);
  check("Esi exists on the server once, active",
    (await User.find({ email: "esi@e2e.test" }).lean()).map((u) => [u.role, u.isActive]), [["teacher", true]]);
  check("nothing parked in the outbox", parked(phone), []);
  await logout(phone);
  phone.kill();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. a phone the old build already left dirty is repaired ---");
  {
    const dir3 = tmpDir("credrows-old");
    let p = await boot(dir3);
    check("Ama signs in online", await login(p, "ama@e2e.test"), true);
    await logout(p);
    await quietly(() => p.load("src/services/mutationQueue.service").MutationQueue.getStats())();   // the outbox table
    p.kill();
    // What the old build left: the credential row dirty, a parked POST for
    // it, and alongside a genuine offline create still unsent.
    {
      const { DatabaseSync } = require("node:sqlite");
      const w = new DatabaseSync(path.join(dir3, "schoolapp.db"));
      w.exec("UPDATE users SET _synced = 0 WHERE id = 'tea-live'");
      const ins = w.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, silent, owner_id, last_status, error)
                             VALUES (?, ?, 'POST', '/admin/teachers', ?, ?, ?, '2026-10-01T08:00:00.000Z', 0, 'adm', ?, ?)`);
      ins.run("old-1", "teacher:tea-live",
        JSON.stringify({ id: "tea-live", name: "Ama Owusu", email: "ama@e2e.test", role: "teacher", schoolId: S,
          __local: { table: "users", ids: ["tea-live"], idColumn: "id" }, __reconcile: { kind: "teacher", localId: "tea-live", table: "users" } }),
        "conflict", 1, 409, "Email already registered");
      w.prepare(`INSERT INTO users (id, name, email, role, schoolId, school_id, is_active, created_at, _synced)
                 VALUES ('local_old_esi2', 'Yaw Darko', 'yaw@e2e.test', 'teacher', ?, ?, 1, '2026-10-01', 0)`).run(S, S);
      w.close();
    }
    p = await boot(dir3);
    check("before: the parked credential POST is there", parked(p).map((r) => [r.entity_key, r.status]), [["teacher:tea-live", "conflict"]]);
    sent.length = 0;
    check("the administrator signs in online", await login(p, "head@e2e.test"), true);
    await sync(p);
    await sync(p);
    check("the parked credential POST is gone; nothing parked", parked(p), []);
    check("its row is no longer marked as a local change", usersRow(p, "tea-live")?._synced, 1);
    check("the genuine offline create was sent once (and nothing for Ama)", teacherPosts().map((s) => s.email), ["yaw@e2e.test"]);
    check("Yaw exists on the server once", await User.countDocuments({ email: "yaw@e2e.test" }), 1);
    await logout(p);
    p.kill();
  }

  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
