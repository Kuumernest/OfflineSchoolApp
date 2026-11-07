// mobile/scripts/check-teacher-edits.js
"use strict";

/**
 * An edit of a teacher the server has must reach it as that edit — one PUT
 * /admin/teachers/:id — and never as a teacher create.
 *
 * TeacherService.update() writes the row with `_synced = 0` and queues the
 * PUT. The backfill's teacher spec (syncBackfill.service.js) turned every
 * dirty teacher row into POST /admin/teachers, and did not see the queued
 * PUT because that PUT named its row as `__local.id` while coveredIds() and
 * the queue's flag-clearing read `__local.ids`. So the edit also went out as
 * a create. On the real server (admin.routes.js claimStaffEmail):
 *   - an active teacher → 409 "Email already registered" → an outbox row
 *     parked as a conflict ("needs attention") nothing resolves;
 *   - a teacher the school removed (deactivated) in the meantime → the
 *     account is RESTORED: reactivated, given a new temporary password and
 *     emailed it.
 * And the PUT's success never cleared the flag, so the row stayed dirty and
 * the backfill POSTed it again on every later sync.
 *
 * The REAL phone (peruser-harness.js) against the REAL backend routes (auth,
 * sync, admin) over an in-memory MongoDB. Assertions read the requests the
 * phone sent, its outbox and MongoDB.
 *
 *   1. an online edit of a server teacher → one PUT, no POST, clean row;
 *   2. an offline edit, then the school removes the teacher → one PUT, the
 *      teacher stays removed with their password unchanged;
 *   3. a teacher created on this phone (the server keeps the phone's id),
 *      synced, then edited offline → one PUT, no second create;
 *   4. created and edited offline before any sync → one create carrying the
 *      edited fields, nothing else;
 *   5. a phone an older build left behind (edited rows dirty, a parked
 *      `teacher:<id>` 409 create beside a queued PUT, another with no PUT,
 *      a genuine unsent create) is repaired: no create for a known teacher,
 *      every edit sent once as a PUT, the genuine create still sent once.
 *
 *   node scripts/check-teacher-edits.js
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
  await mongoose.connect(mongo.getUri(), { dbName: "teacher-edits" });

  const S = "5c0e2e000000000000000002";
  const PW = "Check-only-passw0rd";
  const { app, User } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const User = mongoose.model("User");
    await mongoose.model("School").create({ _id: S, name: "Edit School", code: "EDS", email: "eds@example.test" });
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

  // Server-minted ids are UUIDs (User._id defaults to generateUUID).
  const T = {
    ama:  "8a1f0c52-1b7e-4c3a-9d11-000000000001",
    kofi: "8a1f0c52-1b7e-4c3a-9d11-000000000002",
    abena:"8a1f0c52-1b7e-4c3a-9d11-000000000003",
    kwame:"8a1f0c52-1b7e-4c3a-9d11-000000000004",
    akos: "8a1f0c52-1b7e-4c3a-9d11-000000000005",
  };
  await User.create({ _id: "adm", name: "Head", email: "head@edit.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await User.create({ _id: T.ama,   name: "Ama Owusu",    email: "ama@edit.test",   password: PW, role: "teacher", schoolId: S, isActive: true });
  await User.create({ _id: T.kofi,  name: "Kofi Mensah",  email: "kofi@edit.test",  password: PW, role: "teacher", schoolId: S, isActive: true });
  await User.create({ _id: T.abena, name: "Abena Asante", email: "abena@edit.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  await User.create({ _id: T.kwame, name: "Kwame Appiah", email: "kwame@edit.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  await User.create({ _id: T.akos,  name: "Akosua Frimpong", email: "akos@edit.test", password: PW, role: "teacher", schoolId: S, isActive: true });

  const server = app.listen(0);
  // As in check-credential-rows.js: keep idle sockets open longer than any
  // pause in the script, or Node's fetch can reuse one the server is closing.
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
        const body = typeof cfg.data === "string" ? JSON.parse(cfg.data) : cfg.data;
        sent.push({ m: String(cfg.method).toUpperCase(), url: cfg.url, name: body?.name ?? null, email: body?.email ?? null });
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
  const teacherWrites = () => sent
    .filter((s) => /\/admin\/teachers(\/|$)/.test(s.url))
    .map((s) => `${s.m} ${s.url.replace(/^.*\/admin\/teachers/, "")} ${s.name ?? ""}`.trim());
  const outbox = (phone) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.all("SELECT entity_key, method, status, last_status FROM mutation_outbox WHERE status != 'synced' ORDER BY created_at"); } finally { d.close(); }
  };
  const row = (phone, id) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.one("SELECT id, name, _synced FROM users WHERE id = ?", [id]); } finally { d.close(); }
  };
  const teacherSvc = (phone) => phone.load("src/services/teacher.service").TeacherService;

  const dir = tmpDir("teacher-edits");
  const phone = await boot(dir);
  check("the administrator signs in online", await login(phone, "head@edit.test"), true);
  await sync(phone);
  check("the pull brought Ama down, clean", row(phone, T.ama), { id: T.ama, name: "Ama Owusu", _synced: 1 });

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. an online edit of a server teacher ---");
  sent.length = 0;
  await quietly(() => teacherSvc(phone).update(T.ama, "Ama O. Owusu", "ama@edit.test"))();
  await sync(phone);
  await sync(phone);
  check("one PUT for Ama, no create", teacherWrites(), [`PUT /${T.ama} Ama O. Owusu`]);
  check("the server holds the edit", (await User.findById(T.ama).lean()).name, "Ama O. Owusu");
  check("the row is clean", row(phone, T.ama)?._synced, 1);
  check("nothing parked or left in the outbox", outbox(phone), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. an offline edit, then the school removes the teacher ---");
  phone.net.connected = false;
  sent.length = 0;
  await quietly(() => teacherSvc(phone).update(T.kofi, "Kofi A. Mensah", "kofi@edit.test"))();
  await quietly(() => phone.load("src/services/syncBackfill.service").backfillOutbox())();   // an offline sweep
  await User.updateOne({ _id: T.kofi }, { isActive: false });
  const kofiPw = (await User.findById(T.kofi).select("+password").lean()).password;
  phone.net.connected = true;
  await sync(phone);
  await sync(phone);
  check("one PUT for Kofi, no create", teacherWrites(), [`PUT /${T.kofi} Kofi A. Mensah`]);
  const kofi = await User.findById(T.kofi).select("+password").lean();
  check("Kofi stays removed, password unchanged, edit applied",
    [kofi.isActive, kofi.password === kofiPw, kofi.name], [false, true, "Kofi A. Mensah"]);
  check("one account for Kofi's email", await User.countDocuments({ email: "kofi@edit.test" }), 1);
  check("nothing parked", outbox(phone), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. created on this phone, synced, then edited offline ---");
  phone.net.connected = false;
  const esiId = await quietly(() => teacherSvc(phone).create("Esi Boateng", "esi@edit.test"))();
  phone.net.connected = true;
  sent.length = 0;
  await sync(phone);
  check("the create is sent once", teacherWrites(), ["POST  Esi Boateng"]);
  const esiServer = (await User.findOne({ email: "esi@edit.test" }).lean())?._id;
  check("the server kept the phone's id", esiServer, esiId);
  phone.net.connected = false;
  sent.length = 0;
  await quietly(() => teacherSvc(phone).update(esiId, "Esi K. Boateng", "esi@edit.test"))();
  phone.net.connected = true;
  await sync(phone);
  await sync(phone);
  check("one PUT for Esi, no second create", teacherWrites(), [`PUT /${esiId} Esi K. Boateng`]);
  check("the server holds Esi's edit, once", (await User.find({ email: "esi@edit.test" }).lean()).map((u) => u.name), ["Esi K. Boateng"]);
  check("nothing parked", outbox(phone), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. created and edited offline before any sync ---");
  phone.net.connected = false;
  sent.length = 0;
  const yawId = await quietly(() => teacherSvc(phone).create("Yaw Darko", "yaw@edit.test"))();
  await quietly(() => phone.load("src/services/syncBackfill.service").backfillOutbox())();   // the create queued
  await quietly(() => teacherSvc(phone).update(yawId, "Yaw K. Darko", "yaw@edit.test"))();
  phone.net.connected = true;
  await sync(phone);
  await sync(phone);
  check("one create, carrying the edit, and nothing else", teacherWrites(), ["POST  Yaw K. Darko"]);
  check("Yaw exists once, edited", (await User.find({ email: "yaw@edit.test" }).lean()).map((u) => u.name), ["Yaw K. Darko"]);
  check("Yaw's row is clean", row(phone, yawId)?._synced, 1);
  check("nothing parked", outbox(phone), []);
  await logout(phone);
  phone.kill();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. a phone an older build left behind is repaired ---");
  {
    const dir5 = tmpDir("teacher-edits-old");
    let p = await boot(dir5);
    check("the administrator signs in online", await login(p, "head@edit.test"), true);
    await sync(p);
    await logout(p);
    p.kill();
    {
      const { DatabaseSync } = require("node:sqlite");
      const w = new DatabaseSync(path.join(dir5, "schoolapp.db"));
      // Abena: edited; the old PUT (with __local.id) still queued, and the
      // backfill's POST beside it, parked on the server's 409.
      w.prepare("UPDATE users SET name = 'Abena Y. Asante', _synced = 0 WHERE id = ?").run(T.abena);
      // Kwame: edited; the PUT already went (the row stayed dirty because the
      // flag was never cleared) — only the parked POST is left.
      w.prepare("UPDATE users SET name = 'Kwame B. Appiah', _synced = 0 WHERE id = ?").run(T.kwame);
      // A genuine create from the old build, never sent.
      w.prepare(`INSERT INTO users (id, name, email, role, schoolId, school_id, is_active, created_at, _synced)
                 VALUES ('local_old_efua', 'Efua Mensah', 'efua@edit.test', 'teacher', ?, ?, 1, '2026-10-01', 0)`).run(S, S);
      const ins = w.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, silent, owner_id, last_status, error, last_attempt_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'adm', ?, ?, ?)`);
      const post = (id, name, email) => JSON.stringify({ id, name, email, role: "teacher", schoolId: S,
        __local: { table: "users", ids: [id], idColumn: "id" }, __reconcile: { kind: "teacher", localId: id, table: "users" } });
      ins.run("old-put-abena", `teacher-update:${T.abena}`, "PUT", `/admin/teachers/${T.abena}`,
        JSON.stringify({ name: "Abena Y. Asante", email: "abena@edit.test", __local: { table: "users", id: T.abena } }),
        "pending", 0, "2026-10-01T08:00:00.000Z", null, null, null);
      ins.run("old-post-abena", `teacher:${T.abena}`, "POST", "/admin/teachers", post(T.abena, "Abena Y. Asante", "abena@edit.test"),
        "conflict", 1, "2026-10-01T08:00:01.000Z", 409, "Email already registered", "2026-10-01T08:00:05.000Z");
      // Akosua: edited, then a pull overwrote the row (clean, server values);
      // the parked POST is the only copy of the edit — it must become the PUT.
      ins.run("old-post-akos", `teacher:${T.akos}`, "POST", "/admin/teachers", post(T.akos, "Akosua D. Frimpong", "akos@edit.test"),
        "conflict", 1, "2026-10-01T08:00:03.000Z", 409, "Email already registered", "2026-10-01T08:00:05.000Z");
      ins.run("old-post-kwame", `teacher:${T.kwame}`, "POST", "/admin/teachers", post(T.kwame, "Kwame B. Appiah", "kwame@edit.test"),
        "conflict", 1, "2026-10-01T08:00:02.000Z", 409, "Email already registered", "2026-10-01T08:00:05.000Z");
      w.close();
    }
    p = await boot(dir5);
    check("before: the old outbox is there",
      outbox(p).map((r) => [r.entity_key, r.status]),
      [[`teacher-update:${T.abena}`, "pending"], [`teacher:${T.abena}`, "conflict"], [`teacher:${T.kwame}`, "conflict"], [`teacher:${T.akos}`, "conflict"]]);
    sent.length = 0;
    check("the administrator signs in online", await login(p, "head@edit.test"), true);
    await sync(p);
    await sync(p);
    const writes = teacherWrites();
    check("no create for a teacher the server has", writes.filter((w) => w.startsWith("POST") && !/Efua/.test(w)), []);
    check("Abena's edit sent once, as a PUT", writes.filter((w) => w.includes(T.abena)), [`PUT /${T.abena} Abena Y. Asante`]);
    check("Kwame's edit sent once, as a PUT", writes.filter((w) => w.includes(T.kwame)), [`PUT /${T.kwame} Kwame B. Appiah`]);
    check("Akosua's edit (only in the parked POST) sent once, as a PUT",
      writes.filter((w) => w.includes(T.akos)), [`PUT /${T.akos} Akosua D. Frimpong`]);
    check("the genuine offline create sent once", writes.filter((w) => /Efua/.test(w)), ["POST  Efua Mensah"]);
    check("the server holds every edit",
      [(await User.findById(T.abena).lean()).name, (await User.findById(T.kwame).lean()).name, (await User.findById(T.akos).lean()).name],
      ["Abena Y. Asante", "Kwame B. Appiah", "Akosua D. Frimpong"]);
    check("Efua exists on the server once", await User.countDocuments({ email: "efua@edit.test" }), 1);
    check("nothing parked or left in the outbox", outbox(p), []);
    check("the edited rows are clean", [row(p, T.abena)?._synced, row(p, T.kwame)?._synced], [1, 1]);
    await logout(p);
    p.kill();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. every writer names its rows the way the queue reads them ---");
  {
    const p = await boot(tmpDir("teacher-edits-local"));
    p.setSession({ _id: "adm", id: "adm", role: "school_admin", schoolId: S, name: "Head" });
    p.net.connected = false;
    const mq = p.load("src/services/mutationQueue.service");
    const queuedPayload = (key) => {
      const d = p.inspect("schoolapp.db");
      try { return JSON.parse(d.one("SELECT payload FROM mutation_outbox WHERE entity_key LIKE ?", [key])?.payload ?? "{}"); } finally { d.close(); }
    };
    const flag = (table, id) => {
      const d = p.inspect("schoolapp.db");
      try { return d.one(`SELECT _synced FROM ${table} WHERE id = ?`, [id])?._synced; } finally { d.close(); }
    };
    const fs = p.load("src/services/feeStructure.service");
    const fsId = await quietly(() => fs.create(S, { academicYear: "2026/2027", dueDate: "2026-12-01", items: [{ code: "T", label: "Tuition", amount: 100 }] }))();
    const fsPayload = queuedPayload(`fee-structure:${fsId}`);
    check("a fee structure's create names its row in __local.ids", fsPayload.__local, { table: "fee_structures", ids: [fsId] });
    const { InterventionService } = p.load("src/services/intervention.service");
    const iv = await quietly(() => InterventionService.create({ studentId: "stu-1", classId: "cls-1", actionCode: "call_home" }))();
    await quietly(() => InterventionService.update(iv._id, { notes: "called" }))();
    const ivPayload = queuedPayload(`intervention-update:${iv._id}`);
    check("an intervention edit names its row in __local.ids", ivPayload.__local, { table: "interventions", ids: [iv._id] });
    const { getDatabase } = p.load("src/db/database");
    const db = await getDatabase();
    await quietly(() => mq.MutationQueue._clearLocalFlag(db, fsPayload))();
    await quietly(() => mq.MutationQueue._clearLocalFlag(db, ivPayload))();
    check("their success clears the flag", [flag("fee_structures", fsId), flag("interventions", iv._id)], [1, 1]);
    // An entry an older build queued with `id` still settles its row.
    await db.runAsync("UPDATE fee_structures SET _synced = 0 WHERE id = ?", [fsId]);
    await quietly(() => mq.MutationQueue._clearLocalFlag(db, { __local: { table: "fee_structures", id: fsId } }))();
    check("an old `__local.id` entry still clears its row", flag("fee_structures", fsId), 1);
    const { classifyDirtyRows } = p.load("src/services/syncState");
    check("…and counts as carrying it on the pending screen",
      classifyDirtyRows({ table: "users", dirtyIds: ["t1"], outboxRows: [{ status: "pending", payload: { __local: { table: "users", id: "t1" } } }] }).pending, ["t1"]);
    p.kill();
  }

  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
