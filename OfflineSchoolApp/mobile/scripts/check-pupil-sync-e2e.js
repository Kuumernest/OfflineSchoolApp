// mobile/scripts/check-pupil-sync-e2e.js
"use strict";

/**
 * Pupils and the sync flag, end to end: the REAL phone (peruser-harness.js)
 * against the REAL backend routes (auth, sync, admin, students, the
 * idempotency middleware) over an in-memory MongoDB. The same rules as
 * check-pupil-sync.js (fake server, the pull race itself), here with the
 * server's real answers. Assertions read what reached the server, MongoDB
 * and the phone's tables.
 *
 *   1. an admin phone pulls the roster (a pupil with no class among it):
 *      every pupil is synced and no approve is ever sent
 *   2. the roster left at _synced 0 by an older build is repaired, still
 *      without an approve
 *   3. an application approved offline is approved on the server, once
 *   4. a pupil corrected and one suspended offline land once each
 *   5. a pupil removed on the server leaves the phone's roster
 *   6. a teacher's phone keeps only the pupils of the classes it teaches,
 *      its form class included
 *
 *   node scripts/check-pupil-sync-e2e.js
 */

const path   = require("path");
const Module = require("module");
const { bootDevice, tmpDir, quietly } = require("./peruser-harness");

const ROOT    = path.join(__dirname, "..");
const BACKEND = path.join(ROOT, "..", "backend");
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
  await mongoose.connect(mongo.getUri(), { dbName: "pupil-sync" });

  const S  = "5c0e2e000000000000000010";
  const PW = "Check-only-passw0rd";
  const writes = [];   // every write that reached the server: "METHOD /path"
  const { app, M } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const M = (n) => mongoose.model(n);
    await M("School").create({ _id: S, name: "Pupil School", code: "PPS", email: "pps@example.test" });
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    const emailService = breq(path.join(BACKEND, "src/services/email.service"));
    emailService.sendEmail = async () => ({ success: true });
    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.method !== "GET") writes.push(`${req.method} ${req.path.replace(/^\/api/, "")}`);
      next();
    });
    app.use("/api/auth", breq(path.join(BACKEND, "src/routes/auth.routes")));
    app.use("/api", auth.authenticate, breq(path.join(BACKEND, "middleware/idempotency")));
    app.use("/api/sync",     auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use("/api/admin",    auth.authenticate, breq(path.join(BACKEND, "src/routes/admin.routes")));
    app.use("/api/students", breq(path.join(BACKEND, "src/routes/students.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));
    return { app, M };
  })();

  const T0 = new Date("2026-10-01T08:00:00.000Z");
  const TEA = "8a1f0c52-1b7e-4c3a-9d11-0000000000c1";
  await M("User").create({ _id: "adm", name: "Head", email: "head@pps.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await M("User").create({ _id: TEA, name: "Ama Owusu", email: "ama@pps.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  await M("Class").create({ _id: "cls-a", name: "Form 1", schoolId: S, isActive: true });
  await M("Class").create({ _id: "cls-b", name: "Form 2", schoolId: S, isActive: true });
  await M("Class").create({ _id: "cls-c", name: "Form 3", schoolId: S, isActive: true, classTeacherId: TEA, classTeacherName: "Ama Owusu" });
  await M("Subject").create({ _id: "sub-a", name: "Maths", schoolId: S, class: "cls-a", classId: "cls-a" }).catch(() => {});
  await M("TeacherAssignment").create({ _id: "ta-1", schoolId: S, teacher: TEA, class: "cls-a", subject: "sub-a", isActive: true });
  // Siblings share their guardian's email (CLAUDE.md) — never a duplicate.
  const kid = (id, first, classId) => ({
    _id: id, schoolId: S, classId, firstName: first, lastName: "Boateng", studentName: `${first} Boateng`,
    guardianName: "Efua Boateng", guardianEmail: "efua@family.test", email: "efua@family.test",
    status: "approved", isActive: true, updatedAt: T0, createdAt: T0,
  });
  await M("Student").collection.insertMany([
    kid("st-1", "Kojo", "cls-a"), kid("st-2", "Esi", "cls-a"), kid("st-3", "Yaw", "cls-b"),
    kid("st-4", "Akua", "cls-c"), kid("st-5", "Kofi", "cls-b"), kid("st-nc", "Kwame", null),
    { ...kid("app-1", "Abena", null), status: "pending", isActive: false },
  ]);

  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const axios = require("axios");
  const boot = async (dir) => {
    const http = axios.create({ baseURL: API, timeout: 15_000 });
    let phone = null;
    http.interceptors.request.use((cfg) => {
      if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
      cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
      return cfg;
    });
    phone = await bootDevice({ dir, api: http, apiUrl: API });
    return phone;
  };
  const login = async (phone, email) => {
    const ok = await quietly(() => phone.useAuthStore.getState().login({ email, password: PW }))();
    for (let i = 0; i < 6000 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
    return ok;
  };
  const sync = (phone) => quietly(async () => {
    const { SyncManager } = phone.load("src/services/syncManager");
    await SyncManager.ensureStarted();
    // Wait out a sync already running (the phone starts one 3 s after any
    // save), or syncAll returns at once and the check looks too early.
    const idle = async () => { for (let i = 0; i < 6000 && SyncManager.isSyncing; i++) await new Promise((r) => setTimeout(r, 10)); };
    await idle();
    await SyncManager.syncAll({ force: true });
    await idle();
  })();
  const sql = async (phone, q, p = []) => (await phone.load("src/db/database").getDatabase()).getAllAsync(q, p);
  const run = async (phone, q, p = []) => (await phone.load("src/db/database").getDatabase()).runAsync(q, p);
  const approves = () => writes.filter((w) => /\/(approve|reject)$/.test(w));

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. the admin phone pulls the roster ---");
  const phone = await boot(tmpDir("pupil-sync-admin"));
  check("the administrator signs in online", await login(phone, "head@pps.test"), true);
  await sync(phone);
  await sync(phone);
  check("the pupils are on the phone, every one synced",
    await sql(phone, "SELECT id, _synced FROM students WHERE id LIKE 'st-%' ORDER BY id"),
    ["st-1", "st-2", "st-3", "st-4", "st-5", "st-nc"].map((id) => ({ id, _synced: 1 })));
  check("no approve (or reject) was sent", approves(), []);
  check("nothing waits or needs attention",
    await sql(phone, "SELECT entity_key FROM mutation_outbox WHERE status != 'synced'"), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. a roster an older build left at _synced 0 ---");
  await run(phone, "UPDATE students SET _synced = 0, _local_decision = NULL");
  await sync(phone);
  check("repaired: every pupil synced again",
    (await sql(phone, "SELECT COUNT(*) AS n FROM students WHERE _synced != 1 OR _synced IS NULL"))[0].n, 0);
  check("  and still no approve", approves(), []);
  check("  nothing parked", await sql(phone, "SELECT entity_key FROM mutation_outbox WHERE status != 'synced'"), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. an application approved offline ---");
  const apps = phone.load("src/services/studentApplications.service").StudentApplicationsService;
  await quietly(() => apps.getEnrollmentNo("x"))();
  await run(phone, "INSERT OR REPLACE INTO students (id, schoolId, name, status, is_active, _synced) VALUES ('app-1', ?, 'Abena Boateng', 'pending', 0, 1)", [S]);
  phone.net.connected = false;
  const res = await quietly(() => apps.approveApplication("app-1", "cls-a"))();
  check("approved on the phone, waiting", [res?.synced, (await sql(phone, "SELECT _local_decision FROM students WHERE id = 'app-1'"))[0]?._local_decision], [false, "approved"]);
  phone.net.connected = true;
  await sync(phone);
  await sync(phone);
  check("one approve reached the server", approves(), ["PUT /admin/students/app-1/approve"]);
  const abena = await M("Student").findById("app-1").lean();
  check("  the server approved her into Form 1", [abena.status, String(abena.classId)], ["approved", "cls-a"]);
  check("  the phone's row settled",
    await sql(phone, "SELECT _synced, _local_decision FROM students WHERE id = 'app-1'"), [{ _synced: 1, _local_decision: null }]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. a correction and a suspension made offline ---");
  const svc = phone.load("src/services/student.service").StudentService;
  writes.length = 0;
  phone.net.connected = false;
  await quietly(() => svc.updateStudent("st-1", { lastName: "Boateng-Mensah" }))();
  await quietly(() => svc.suspend("st-3"))();
  check("offline: the rows hold unsent changes",
    await sql(phone, "SELECT id, _synced FROM students WHERE id IN ('st-1', 'st-3') ORDER BY id"),
    [{ id: "st-1", _synced: 0 }, { id: "st-3", _synced: 0 }]);
  phone.net.connected = true;
  await sync(phone);
  await sync(phone);
  check("each landed once", writes.filter((w) => w.startsWith("PATCH /students")).sort(),
    ["PATCH /students/st-1", "PATCH /students/st-3/suspend"]);
  const [kojo, yaw] = [await M("Student").findById("st-1").lean(), await M("Student").findById("st-3").lean()];
  check("  the server holds them", [kojo.lastName, yaw.status], ["Boateng-Mensah", "suspended"]);
  check("  the phone keeps the correction, clean",
    await sql(phone, "SELECT lastName, _synced FROM students WHERE id = 'st-1'"), [{ lastName: "Boateng-Mensah", _synced: 1 }]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. a pupil removed on the server ---");
  await M("Student").updateOne({ _id: "st-2" }, { $set: { deletedAt: new Date(), isActive: false, updatedAt: new Date() } });
  await sync(phone);
  const roster = await quietly(() => svc.getStudentsLocal())();
  const ids = (roster?.students ?? roster?.data ?? roster ?? []).map((s) => String(s.id ?? s._id));
  check("Esi left the phone's roster, her brother is still there", [ids.includes("st-2"), ids.includes("st-1")], [false, true]);
  check("no approve was ever sent but Abena's", approves(), []);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. a teacher's phone ---");
  const tphone = await boot(tmpDir("pupil-sync-teacher"));
  check("the teacher signs in online", await login(tphone, "ama@pps.test"), true);
  await sync(tphone);
  await sync(tphone);
  const kept = (await sql(tphone, "SELECT id FROM students WHERE deleted_at IS NULL OR deleted_at = '' ORDER BY id")).map((r) => r.id);
  // Abena was approved into Form 1 in step 3; Kofi (Form 2) and Kwame (no
  // class) are not this teacher's; Yaw is suspended, Esi removed.
  check("only the pupils of Form 1 (taught) and Form 3 (form class) are kept", kept, ["app-1", "st-1", "st-4"]);

  phone.kill();
  tphone.kill();
  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
