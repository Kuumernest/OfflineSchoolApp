// mobile/scripts/check-sync-feed-phone.js
"use strict";

/**
 * The phone pulls its six collections through GET /sync/changes.
 *
 * The REAL phone (peruser-harness.js: real modules, real SQLite files, the real
 * auth store and SyncManager) against the REAL backend routes (auth, sync,
 * admin) over an in-memory MongoDB:
 *
 *   1. a first sync reads /sync/changes?profile=phone — not /sync/pull — and
 *      lands classes, subjects, teachers, periods, assignments and pupils;
 *   2. a delta: an edit, a soft delete and HARD deletes (a subject, a pupil, an
 *      assignment — tombstones) all reach the phone;
 *   3. pull protection: a class and an assignment with an unsent local change
 *      are not overwritten by the feed, and are refreshed once clean;
 *   4. a large roster arrives in pages, every pupil once;
 *   5. two accounts on one phone with per-user data OFF: the second (another
 *      school) gets ITS rows although they are older than the first's cursor,
 *      and each account has its own feed cursors;
 *   6. a server without the phone profile: the phone falls back to /sync/pull.
 *
 *   node scripts/check-sync-feed-phone.js
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
  await mongoose.connect(mongo.getUri(), { dbName: "sync-feed-phone" });

  const S1 = "5c0e2e0000000000000000e1", S2 = "5c0e2e0000000000000000e2";
  const PW = "Check-only-passw0rd";
  const { app, M } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const M = (n) => mongoose.model(n);
    await M("School").create({ _id: S1, name: "One School", code: "ONE", email: "one@example.test" });
    await M("School").create({ _id: S2, name: "Two School", code: "TWO", email: "two@example.test" });
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    await M("SyncTombstone").createIndexes();
    const emailService = breq(path.join(BACKEND, "src/services/email.service"));
    emailService.sendEmail = async () => ({ success: true });
    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    app.use("/api/auth", breq(path.join(BACKEND, "src/routes/auth.routes")));
    app.use("/api", auth.authenticate, breq(path.join(BACKEND, "middleware/idempotency")));
    app.use("/api/sync",  auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use("/api/admin", auth.authenticate, breq(path.join(BACKEND, "src/routes/admin.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));
    return { app, M };
  })();

  // School one: an administrator, two teachers, two classes, subjects, a period,
  // assignments and a roster of 1 205 pupils (more than two feed pages).
  await M("User").create({ _id: "adm1", name: "Head One", email: "head1@feed.test", password: PW, role: "school_admin", schoolId: S1, isActive: true });
  await M("User").create({ _id: "tea1", name: "Ama Owusu", email: "ama@feed.test", password: PW, role: "teacher", schoolId: S1, isActive: true });
  await M("User").create({ _id: "tea2", name: "Kofi Mensah", email: "kofi@feed.test", password: PW, role: "teacher", schoolId: S1, isActive: true });
  await M("Class").create({ _id: "c1", schoolId: S1, name: "Form 1" });
  await M("Class").create({ _id: "c2", schoolId: S1, name: "Form 2" });
  await M("Subject").create({ _id: "s1", schoolId: S1, name: "Maths", classId: "c1" });
  await M("Subject").create({ _id: "s2", schoolId: S1, name: "Music", classId: "c2" });
  await M("Period").create({ _id: "pe1", schoolId: S1, name: "P1", startTime: "08:00", endTime: "08:40" });
  await M("TeacherAssignment").create({ _id: "as1", schoolId: S1, teacher: "tea1", class: "c1", subject: "s1" });
  await M("TeacherAssignment").create({ _id: "as2", schoolId: S1, teacher: "tea2", class: "c2", subject: "s2" });
  const ROSTER = 1205;
  const old = new Date(Date.now() - 3 * 86400_000);
  const pupils = [];
  for (let i = 0; i < ROSTER; i++) {
    pupils.push({ _id: `p-${String(i).padStart(4, "0")}`, userId: `u-p-${i}`, schoolId: S1, classId: i % 2 ? "c2" : "c1",
      studentName: `Pupil ${i}`, enrollmentNo: `ONE-${i}`, status: "approved", isActive: true, createdAt: old, updatedAt: old });
  }
  await M("Student").collection.insertMany(pupils);
  // School two: older than anything school one's administrator will sync.
  await M("User").create({ _id: "adm2", name: "Head Two", email: "head2@feed.test", password: PW, role: "school_admin", schoolId: S2, isActive: true });
  const older = new Date(Date.now() - 30 * 86400_000);
  await M("Class").collection.insertOne({ _id: "c-two", schoolId: S2, name: "Two Form", isActive: true, deletedAt: null, createdAt: older, updatedAt: older });
  await M("Student").collection.insertOne({ _id: "p-two", userId: "u-two", schoolId: S2, classId: "c-two", studentName: "Two Pupil",
    enrollmentNo: "TWO-1", status: "approved", isActive: true, createdAt: older, updatedAt: older });

  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const axios = require("axios");
  const seen = [];
  const boot = async (dir) => {
    const http = axios.create({ baseURL: API, timeout: 30_000 });
    let phone = null;
    http.interceptors.request.use((cfg) => {
      if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
      cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
      seen.push(cfg.url);
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
    return ok;
  };
  const sync = (phone) => quietly(async () => {
    const { SyncManager } = phone.load("src/services/syncManager");
    await SyncManager.ensureStarted();
    // Wait out a sync already running, or syncAll returns at once.
    const idle = async () => { for (let i = 0; i < 6000 && SyncManager.isSyncing; i++) await new Promise((r) => setTimeout(r, 10)); };
    await idle();
    await SyncManager.syncAll({ force: true });
    await idle();
  })();
  const q = (phone, sql, p = []) => { const d = phone.inspect("schoolapp.db"); try { return d.all(sql, p); } finally { d.close(); } };
  const one = (phone, sql, p = []) => q(phone, sql, p)[0] ?? null;

  const dir = tmpDir("sync-feed-phone");
  const phone = await boot(dir);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. a first sync reads the change feed ---");
  check("the administrator signs in", await login(phone, "head1@feed.test"), true);
  seen.length = 0;
  await sync(phone);
  check("the pull went to /sync/changes", seen.some((u) => String(u).startsWith("/sync/changes")), true);
  check("  and not to /sync/pull", seen.some((u) => String(u).startsWith("/sync/pull")), false);
  check("classes", q(phone, "SELECT id FROM classes WHERE deleted_at IS NULL ORDER BY id").map((r) => r.id), ["c1", "c2"]);
  check("subjects", q(phone, "SELECT id FROM subjects WHERE deleted_at IS NULL ORDER BY id").map((r) => r.id), ["s1", "s2"]);
  check("teachers", q(phone, "SELECT id FROM users WHERE role = 'teacher' AND deleted_at IS NULL ORDER BY id").map((r) => r.id), ["tea1", "tea2"]);
  check("periods", q(phone, "SELECT id FROM periods").map((r) => r.id), ["pe1"]);
  check("assignments, with the joined names",
    q(phone, "SELECT id, teacher_json FROM teacher_assignments WHERE deleted_at IS NULL ORDER BY id").map((r) => [r.id, JSON.parse(r.teacher_json || "{}").name]),
    [["as1", "Ama Owusu"], ["as2", "Kofi Mensah"]]);
  check(`the whole roster, over several pages (${ROSTER})`, one(phone, "SELECT COUNT(*) n FROM students WHERE deleted_at IS NULL AND schoolId = ?", [S1]).n, ROSTER);
  check("several feed pages were read", seen.filter((u) => String(u).startsWith("/sync/changes")).length >= 3, true);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. a delta: edits, a soft delete, hard deletes ---");
  await M("Class").updateOne({ _id: "c1" }, { $set: { name: "Form 1 Gold" } });
  await M("Period").updateOne({ _id: "pe1" }, { $set: { deletedAt: new Date(), isActive: false } });
  await M("Subject").deleteOne({ _id: "s2" });
  await M("Student").deleteOne({ _id: "p-0007" });
  await M("TeacherAssignment").deleteOne({ _id: "as2" });
  seen.length = 0;
  await sync(phone);
  check("the edit", one(phone, "SELECT name FROM classes WHERE id = 'c1'")?.name, "Form 1 Gold");
  check("the soft-deleted period", !!one(phone, "SELECT deletedat FROM periods WHERE id = 'pe1'")?.deletedat, true);
  check("the hard-deleted subject (tombstone)", !!one(phone, "SELECT deleted_at FROM subjects WHERE id = 's2'")?.deleted_at, true);
  check("the hard-deleted pupil (tombstone)", !!one(phone, "SELECT deleted_at FROM students WHERE id = 'p-0007'")?.deleted_at, true);
  check("the hard-deleted assignment (tombstone)", !!one(phone, "SELECT deleted_at FROM teacher_assignments WHERE id = 'as2'")?.deleted_at, true);
  check("a delta does not re-read the roster", seen.filter((u) => String(u).startsWith("/sync/changes")).length <= 2, true);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. a pulled row never overwrites an unsent change ---");
  {
    const { SyncManager } = phone.load("src/services/syncManager");
    const d = phone.load("src/db/database");
    const db = await d.getDatabase();
    await db.runAsync("UPDATE classes SET name = 'local edit', _synced = 0 WHERE id = 'c2'");
    await db.runAsync("UPDATE teacher_assignments SET role = 'local', _synced = 0 WHERE id = 'as1'");
    await M("Class").updateOne({ _id: "c2" }, { $set: { name: "Form 2 server" } });
    await M("TeacherAssignment").updateOne({ _id: "as1" }, { $set: { role: "server" } });
    await quietly(() => SyncManager._pullFeed(S1))();   // the pull alone: nothing sent first
    check("the class keeps its unsent edit", one(phone, "SELECT name, _synced FROM classes WHERE id = 'c2'"), { name: "local edit", _synced: 0 });
    check("the assignment keeps its unsent change", one(phone, "SELECT role, _synced FROM teacher_assignments WHERE id = 'as1'"), { role: "local", _synced: 0 });
    await db.runAsync("UPDATE classes SET _synced = 1 WHERE id = 'c2'");
    await M("Class").updateOne({ _id: "c2" }, { $set: { name: "Form 2 later" } });
    await quietly(() => SyncManager._pullFeed(S1))();
    check("once clean, the next pull refreshes it", one(phone, "SELECT name FROM classes WHERE id = 'c2'")?.name, "Form 2 later");
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4/5. a second account on the same phone, switch off ---");
  await quietly(() => phone.useAuthStore.getState().logout())();
  check("the second administrator (another school) signs in", await login(phone, "head2@feed.test"), true);
  await sync(phone);
  check("their school's class, older than the first account's cursor, arrives",
    one(phone, "SELECT id FROM classes WHERE id = 'c-two'")?.id, "c-two");
  check("  and their pupil", one(phone, "SELECT id FROM students WHERE id = 'p-two'")?.id, "p-two");
  // One per collection that has had a row (school two has no subjects, say).
  const scopes = q(phone, "SELECT scope, COUNT(*) n FROM sync_cursors WHERE k LIKE 'feed_cursor:%' GROUP BY scope ORDER BY scope")
    .map((r) => [r.scope.split("|").slice(1).join("|"), r.n > 0]);
  check("each account keeps its own feed cursors", scopes, [[`${S1}|adm1`, true], [`${S2}|adm2`, true]]);
  check("  the first account's are all still there (seven collections)",
    one(phone, "SELECT COUNT(*) n FROM sync_cursors WHERE k LIKE 'feed_cursor:%' AND scope LIKE ?", [`%|${S1}|adm1`]).n, 7);
  phone.kill();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. a server without the phone profile ---");
  {
    const asked = [];
    const fake = {
      get: async (url, cfg = {}) => {
        asked.push(url);
        if (url === "/sync/changes") {
          const names = String(cfg.params?.collections ?? "").split(",");
          return { status: 200, data: { success: true, collections: {}, refused: names.map((c) => ({ collection: c, reason: "UNKNOWN_COLLECTION" })) } };
        }
        if (url === "/sync/pull") {
          return { status: 200, data: { success: true, timestamp: new Date().toISOString(),
            data: { classes: [{ _id: "c-old", schoolId: S1, name: "From pull", isActive: true }], teachers: [], subjects: [], periods: [], assignments: [], students: [], deletedItems: [] } } };
        }
        return { status: 200, data: {} };
      },
      request: async () => ({ status: 200, data: {} }),
    };
    const p2 = await bootDevice({ dir: tmpDir("sync-feed-fallback"), api: fake });
    p2.setSession({ _id: "adm1", id: "adm1", role: "school_admin", schoolId: S1, name: "Head One" });
    const { SyncManager } = p2.load("src/services/syncManager");
    await quietly(() => SyncManager.pullChanges())();
    check("it tried the feed, then /sync/pull", [asked.includes("/sync/changes"), asked.includes("/sync/pull")], [true, true]);
    const d = p2.inspect("schoolapp.db");
    check("  and applied /sync/pull's answer", d.one("SELECT name FROM classes WHERE id = 'c-old'")?.name, "From pull");
    d.close();
    p2.kill();
  }

  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
