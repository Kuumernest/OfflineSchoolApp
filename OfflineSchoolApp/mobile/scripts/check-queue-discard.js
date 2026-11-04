// mobile/scripts/check-queue-discard.js
"use strict";

/**
 * Three things the outbox got wrong, on the REAL phone (peruser-harness.js)
 * against the REAL backend routes (auth, idempotency, sync, periods, admin)
 * over an in-memory MongoDB.
 *
 *   A. Period toggle and reorder made offline reach the server. The phone
 *      sends each changed period as its whole record (PUT /admin/periods/:id,
 *      isActive and sortOrder stated); the server ignored both, so the next
 *      pull put the old order and the old switch back. Several reorders, a
 *      sweep in the middle of them, end in the order the phone showed.
 *   B. Discard sticks and undoes the change. MutationQueue.discard deleted the
 *      outbox row only: the local row stayed dirty, the next sweep queued it
 *      again, and the phone kept showing a value the server never took.
 *        B1 a refused period edit, discarded → back to the server's values at
 *           once (offline), never sent again;
 *        B2 a refused period created on this phone, discarded → gone, nothing
 *           created on the server;
 *        B3 a parked teacher edit (no kept copy: the generic path) → clean at
 *           once, the server's name back after the next sync, never sent.
 *   C. 409 IDEMPOTENCY_IN_PROGRESS is transient. A row the server kept
 *      answering "in progress" was parked as failed after eight tries and,
 *      its last status being 409, never re-armed. Now it keeps backing off
 *      under the same key and lands once the server lets the key go; a row an
 *      older build parked so is re-armed when the phone comes back online.
 *
 *   node scripts/check-queue-discard.js
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
  await mongoose.connect(mongo.getUri(), { dbName: "queue-discard" });

  const S = "5c0e2e000000000000000003";
  const PW = "Check-only-passw0rd";
  const { app, M } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const M = (n) => mongoose.model(n);
    await M("School").create({ _id: S, name: "Queue School", code: "QDS", email: "qds@example.test" });
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    app.use("/api/auth", breq(path.join(BACKEND, "src/routes/auth.routes")));
    app.use("/api", auth.authenticate, breq(path.join(BACKEND, "middleware/idempotency")));
    app.use("/api/sync",  auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use("/api/admin/periods", auth.authenticate, breq(path.join(BACKEND, "src/routes/periods.routes")));
    app.use("/api/admin", auth.authenticate, breq(path.join(BACKEND, "src/routes/admin.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));
    return { app, M };
  })();

  const TEACHER = "8a1f0c52-1b7e-4c3a-9d11-0000000000aa";
  await M("User").create({ _id: "adm", name: "Head", email: "head@queue.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await M("User").create({ _id: TEACHER, name: "Ama Owusu", email: "ama@queue.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  const period = (id, sortOrder, startTime, endTime) =>
    M("Period").create({ _id: id, schoolId: S, name: id.toUpperCase(), startTime, endTime, sortOrder });
  await period("p1", 1, "08:00", "09:00");
  await period("p2", 2, "09:00", "10:00");
  await period("p3", 3, "10:00", "11:00");

  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const axios = require("axios");
  const sent = [];
  const http = axios.create({ baseURL: API, timeout: 15_000 });
  let phone = null;
  http.interceptors.request.use((cfg) => {
    if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
    cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
    if (!["get", "head"].includes(String(cfg.method).toLowerCase())) {
      sent.push({ m: String(cfg.method).toUpperCase(), url: String(cfg.url).replace(/^.*\/api/, ""), key: cfg.headers["Idempotency-Key"] ?? null });
    }
    return cfg;
  });
  phone = await bootDevice({ dir: tmpDir("queue-discard"), api: http, apiUrl: API });

  const waitIdle = async () => {
    for (let i = 0; i < 6000 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const ok = await quietly(() => phone.useAuthStore.getState().login({ email: "head@queue.test", password: PW }))();
  await waitIdle();
  check("the administrator signs in online", ok, true);

  const { SyncManager } = phone.load("src/services/syncManager");
  const sync = () => quietly(async () => {
    await SyncManager.ensureStarted();
    // Wait out a sync already running (one starts 3 s after any save), as
    // check-staff-number.js does, then run one that carries what was done.
    const idle = async () => { for (let i = 0; i < 6000 && SyncManager.isSyncing; i++) await new Promise((r) => setTimeout(r, 10)); };
    await idle();
    await SyncManager.syncAll({ force: true, full: true });
    await idle();
  })();
  const { MutationQueue } = phone.load("src/services/mutationQueue.service");
  const { PeriodsService } = phone.load("src/services/periods.service");
  const { TeacherService } = phone.load("src/services/teacher.service");
  const backfill = () => quietly(() => phone.load("src/services/syncBackfill.service").backfillOutbox())();
  const db = await phone.load("src/db/database").getDatabase();
  const all = (sql, p = []) => db.getAllAsync(sql, p);
  const one = (sql, p = []) => db.getFirstAsync(sql, p);
  const outbox = () => all("SELECT id, entity_key, method, status, last_status, idem_key FROM mutation_outbox WHERE status != 'synced' ORDER BY created_at");
  const localPeriods = async () => (await all(
    "SELECT id, name, starttime, sortorder, isactive, dirty FROM periods WHERE deletedat IS NULL OR deletedat = '' ORDER BY sortorder, starttime"
  )).map((r) => `${r.id}:${r.name}:${r.starttime}:${r.sortorder}:${r.isactive}:${r.dirty}`);
  const serverPeriod = async (id) => {
    const p = await M("Period").findById(id).lean();
    return p ? { name: p.name, startTime: p.startTime, sortOrder: p.sortOrder, isActive: p.isActive } : null;
  };
  const serverOrder = async () => (await M("Period").find({ schoolId: S, deletedAt: null, isActive: true }).sort({ sortOrder: 1, startTime: 1 }).lean()).map((p) => p._id);

  await sync();
  check("the pull brought the school day down, clean", await localPeriods(),
    ["p1:P1:08:00:1:1:0", "p2:P2:09:00:2:1:0", "p3:P3:10:00:3:1:0"]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- A. period toggle and reorder made offline ---");
  phone.net.connected = false;
  sent.length = 0;
  await quietly(() => PeriodsService.toggleActive("p2"))();
  await quietly(() => PeriodsService.reorder("p3", "up"))();     // p1, p3, p2
  await backfill();                                              // a sweep between the reorders
  await quietly(() => PeriodsService.reorder("p3", "up"))();     // p3, p1, p2
  check("the phone shows the new order and p2 switched off", await localPeriods(),
    ["p3:P3:10:00:1:1:1", "p1:P1:08:00:2:1:1", "p2:P2:09:00:3:0:1"]);
  phone.net.connected = true;
  await sync();
  await sync();
  await sync();
  check("each change went out as a PUT of the period", [...new Set(sent.map((s) => `${s.m} ${s.url}`))].sort(),
    ["PUT /admin/periods/p1", "PUT /admin/periods/p2", "PUT /admin/periods/p3"]);
  check("the server holds p2 switched off", (await serverPeriod("p2")).isActive, false);
  check("the server's order is the phone's", (await M("Period").find({ schoolId: S }).sort({ sortOrder: 1 }).lean()).map((p) => `${p._id}:${p.sortOrder}`),
    ["p3:1", "p1:2", "p2:3"]);
  check("the active day the server serves: p3, p1", await serverOrder(), ["p3", "p1"]);
  check("the phone is clean and keeps that order after the pulls", await localPeriods(),
    ["p3:P3:10:00:1:1:0", "p1:P1:08:00:2:1:0", "p2:P2:09:00:3:0:0"]);
  check("nothing left in the outbox", await outbox(), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- B1. a refused period edit, discarded ---");
  phone.net.connected = false;
  // 10:30–11:30 overlaps p3 (10:00–11:00): the phone does not check an edit,
  // the server refuses it 409 — parked as a conflict on the pending screen.
  await quietly(() => PeriodsService.update("p1", { name: "Wrong", startTime: "10:30", endTime: "11:30" }))();
  phone.net.connected = true;
  sent.length = 0;
  await sync();
  let parked = (await outbox()).filter((r) => r.entity_key === "period:p1");
  check("the server refused the edit; it is parked", parked.map((r) => [r.method, r.status, r.last_status]), [["PUT", "conflict", 409]]);
  phone.net.connected = false;                                   // the discard needs no network
  const r1 = (await quietly(() => MutationQueue.discard(parked[0]?.id))()) ?? {};
  check("discard says it undid p1 from the kept copy", [r1.reverted, r1.deleted, r1.refresh], [["p1"], [], false]);
  check("p1 is back to the server's values at once, clean", await one("SELECT name, starttime, endtime, dirty, operation FROM periods WHERE id = 'p1'"),
    { name: "P1", starttime: "08:00", endtime: "09:00", dirty: 0, operation: null });
  await backfill();
  check("an offline sweep does not queue it again", (await outbox()).map((r) => r.entity_key), []);
  phone.net.connected = true;
  sent.length = 0;
  await sync();
  await sync();
  check("nothing about p1 is sent", sent.filter((s) => s.url.includes("/periods/p1")), []);
  check("the server's p1 is untouched", await serverPeriod("p1"), { name: "P1", startTime: "08:00", sortOrder: 2, isActive: true });
  check("the phone still shows the server's p1", (await localPeriods()).find((x) => x.startsWith("p1:")), "p1:P1:08:00:2:1:0");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- B2. a period created here, refused, discarded ---");
  await M("Period").create({ _id: "p4", schoolId: S, name: "Clubs", startTime: "14:00", endTime: "15:00", sortOrder: 4 });
  phone.net.connected = false;
  const ghost = await quietly(() => PeriodsService.create({ name: "Ghost", startTime: "14:00", endTime: "15:00", schoolId: S }))();
  phone.net.connected = true;
  sent.length = 0;
  await sync();
  parked = (await outbox()).filter((r) => r.entity_key === `period:${ghost.id}`);
  check("the server refused the create (it overlaps a period the phone had not pulled)",
    parked.map((r) => [r.method, r.status, r.last_status]), [["POST", "conflict", 409]]);
  const r2 = (await quietly(() => MutationQueue.discard(parked[0]?.id))()) ?? {};
  check("discard removed the never-sent period", [r2.deleted, r2.refresh], [[ghost.id], false]);
  check("it is gone from the phone", await one("SELECT id FROM periods WHERE id = ?", [ghost.id]), null);
  sent.length = 0;
  await backfill();
  await sync();
  await sync();
  check("no create is sent again", sent.filter((s) => s.m === "POST" && s.url.endsWith("/admin/periods")), []);
  check("the server has no Ghost", await M("Period").countDocuments({ name: "Ghost" }), 0);
  check("the queue is empty", await outbox(), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- B3. a parked teacher edit, discarded (no kept copy) ---");
  phone.net.connected = false;
  await quietly(() => TeacherService.update(TEACHER, "Ama Wrong", "ama@queue.test"))();
  await backfill();
  // Parked as a refusal would park it (the server is not asked here: what is
  // under test is what discard does with a row that has no kept copy).
  await db.runAsync(
    "UPDATE mutation_outbox SET status = 'failed', last_status = 422, error = 'refused' WHERE entity_key LIKE ?",
    [`teacher%:${TEACHER}`]
  );
  parked = (await outbox()).filter((r) => r.entity_key.endsWith(TEACHER));
  check("one parked teacher edit", parked.map((r) => [r.method, r.status]), [["PUT", "failed"]]);
  const r3 = (await quietly(() => MutationQueue.discard(parked[0]?.id))()) ?? {};
  check("discard settles it and asks for a full pull", [r3.reverted, r3.refresh], [[TEACHER], true]);
  check("the row is clean at once", (await one("SELECT _synced FROM users WHERE id = ?", [TEACHER]))._synced, 1);
  await backfill();
  check("a sweep does not queue it again", (await outbox()).map((r) => r.entity_key), []);
  phone.net.connected = true;
  sent.length = 0;
  await sync();
  check("nothing about the teacher is sent", sent.filter((s) => s.url.includes(TEACHER)), []);
  check("the next sync puts the server's name back", (await one("SELECT name, _synced FROM users WHERE id = ?", [TEACHER])), { name: "Ama Owusu", _synced: 1 });
  check("the server's teacher is untouched", (await M("User").findById(TEACHER).lean()).name, "Ama Owusu");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- C. 409 IDEMPOTENCY_IN_PROGRESS ---");
  phone.net.connected = false;
  await quietly(() => PeriodsService.update("p3", { name: "Assembly" }))();
  await backfill();
  const [row] = (await outbox()).filter((r) => r.entity_key === "period:p3");
  const key = row.idem_key || row.id;
  // The server is "still working" on this key: a fresh processing record.
  const IdempotencyKey = M("IdempotencyKey");
  await IdempotencyKey.create({ key, userId: "adm", method: "PUT", path: "/api/admin/periods/p3", state: "processing" });
  const v0 = (await M("Period").findById("p3").lean()).version;
  phone.net.connected = true;
  sent.length = 0;
  const due = () => db.runAsync("UPDATE mutation_outbox SET next_attempt_at = NULL WHERE id = ?", [row.id]);
  for (let i = 0; i < 12; i++) { await due(); await quietly(() => MutationQueue.drain())(); }
  let now = await one("SELECT status, last_status, retry_count, idem_key FROM mutation_outbox WHERE id = ?", [row.id]);
  check("twelve 'in progress' answers: still retrying, not parked", [now.status, now.last_status], ["retrying", 409]);
  check("…backing off (retry count past the old limit of 8)", now.retry_count >= 9, true);
  check("…under the same key", now.idem_key ?? row.id, key);
  check("…and it waits its backoff rather than going out at once",
    (await one("SELECT next_attempt_at > ? AS later FROM mutation_outbox WHERE id = ?", [new Date().toISOString(), row.id])).later, 1);
  // The server lets the key go (a dead lock is taken over after 11 minutes).
  await IdempotencyKey.collection.updateOne({ key }, { $set: { updatedAt: new Date(Date.now() - 12 * 60_000) } });
  await due();
  await quietly(() => MutationQueue.drain())();
  check("then it lands", (await one("SELECT status FROM mutation_outbox WHERE id = ?", [row.id])).status, "synced");
  check("once: the edit applied, one version step", [(await serverPeriod("p3")).name, (await M("Period").findById("p3").lean()).version - v0], ["Assembly", 1]);
  check("every attempt carried the one key", [...new Set(sent.filter((s) => s.url === "/admin/periods/p3").map((s) => s.key))], [key]);

  console.log("--- C2. a row an older build parked on 409 ---");
  phone.net.connected = false;
  await quietly(() => PeriodsService.update("p3", { name: "Assembly Hall" }))();
  await backfill();
  const [old] = (await outbox()).filter((r) => r.entity_key === "period:p3");
  await db.runAsync(
    "UPDATE mutation_outbox SET status = 'failed', last_status = 409, retry_count = 8, last_attempt_at = ?, error = 'An identical request is already being processed' WHERE id = ?",
    [new Date().toISOString(), old.id]
  );
  await quietly(() => MutationQueue.drain())();                  // offline: nothing
  phone.net.connected = true;
  sent.length = 0;
  await quietly(() => MutationQueue.drain())();                  // back online: re-armed, sent
  check("re-armed when the phone came back, and sent", (await one("SELECT status FROM mutation_outbox WHERE id = ?", [old.id])).status, "synced");
  check("under its own key, once", sent.filter((s) => s.url === "/admin/periods/p3").map((s) => s.key), [old.idem_key || old.id]);
  check("the server holds it", (await serverPeriod("p3")).name, "Assembly Hall");

  phone.kill();
  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
