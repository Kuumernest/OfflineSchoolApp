// mobile/scripts/check-offline-admin-edits-e2e.js
"use strict";

/**
 * The same offline admin work as check-offline-admin-edits.js, against the
 * REAL backend routes (auth, sync, admin, students, the idempotency
 * middleware) over an in-memory MongoDB, from the REAL phone
 * (peruser-harness.js). Assertions read the requests the phone sent, its
 * outbox and MongoDB.
 *
 *   1. offline: a pupil corrected (to the guardian email a sibling already
 *      has), one suspended, one moved, one removed; a subject created and a
 *      teacher assigned to it. Meanwhile another administrator edits the
 *      corrected pupil on the server.
 *   2. reconnect: each operation reaches the server exactly once; the server
 *      holds the result; the correction made against the older version
 *      left a SyncOverwrite record (last write wins, and it is recorded);
 *      the subject and the assignment exist under the phone's ids, in order.
 *   3. a pupil enrolled and removed offline: nothing sent, nothing on the
 *      server.
 *
 *   node scripts/check-offline-admin-edits-e2e.js
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
  await mongoose.connect(mongo.getUri(), { dbName: "offline-admin-edits" });

  const S  = "5c0e2e000000000000000006";
  const PW = "Check-only-passw0rd";
  const writes = [];   // every write that reached the server: "METHOD /path"
  const { app, M } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const M = (n) => mongoose.model(n);
    await M("School").create({ _id: S, name: "Offline School", code: "OFS", email: "ofs@example.test" });
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
  await M("User").create({ _id: "adm", name: "Head", email: "head@ofs.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await M("User").create({ _id: "adm2", name: "Deputy", email: "deputy@ofs.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await M("User").create({ _id: "tea-1", name: "Ama Owusu", email: "ama@ofs.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  await M("Class").create({ _id: "cls-a", name: "Form 1", schoolId: S, isActive: true });
  await M("Class").create({ _id: "cls-b", name: "Form 2", schoolId: S, isActive: true });
  // Two siblings: the guardian's email is on both (CLAUDE.md).
  const kid = (id, first, email) => ({
    _id: id, schoolId: S, classId: "cls-a", className: "Form 1", firstName: first, lastName: "Boateng",
    studentName: `${first} Boateng`, guardianName: "Efua Boateng", guardianEmail: "efua@family.test",
    email, status: "approved", isActive: true, updatedAt: T0,
  });
  await M("Student").collection.insertMany([
    kid("st-1", "Kojo",  "kojo@family.test"),
    kid("st-2", "Esi",   "efua@family.test"),
    kid("st-3", "Yaw",   "yaw@family.test"),
    kid("st-4", "Akua",  "akua@family.test"),
    kid("st-5", "Kwame", "kwame@family.test"),
  ].map((d) => ({ ...d, createdAt: T0 })));

  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const axios = require("axios");
  const http = axios.create({ baseURL: API, timeout: 15_000 });
  let phone = null;
  http.interceptors.request.use((cfg) => {
    if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
    cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
    return cfg;
  });
  phone = await bootDevice({ dir: tmpDir("offline-admin-edits"), api: http, apiUrl: API });
  const waitIdle = async () => {
    for (let i = 0; i < 6000 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const sync = () => quietly(async () => {
    const { SyncManager } = phone.load("src/services/syncManager");
    await SyncManager.ensureStarted();
    // Wait out a sync already running (the phone starts one 3 s after any
    // save), or syncAll returns at once and the check looks too early.
    const idle = async () => { for (let i = 0; i < 6000 && SyncManager.isSyncing; i++) await new Promise((r) => setTimeout(r, 10)); };
    await idle();
    await SyncManager.syncAll({ force: true });
    await idle();
  })();
  const local = (sql, p = []) => { const d = phone.inspect("schoolapp.db"); try { return d.all(sql, p); } finally { d.close(); } };
  // An action that throws is a failure, not the end of the check.
  const run = (fn) => quietly(fn)().catch((err) => {
    fail++; console.log(`  FAIL an action threw: ${err?.message}`); return {};
  });

  check("the administrator signs in online", await run(() => phone.useAuthStore.getState().login({ email: "head@ofs.test", password: PW })), true);
  await waitIdle();
  await sync();
  check("the pupils, classes and the teacher are on the phone",
    [local("SELECT COUNT(*) AS n FROM students")[0].n >= 5, local("SELECT id FROM users WHERE id = 'tea-1'").length], [true, 1]);
  const pulledBase = local("SELECT updated_at FROM students WHERE id = 'st-1'")[0]?.updated_at;
  check("the pull keeps the server's version stamp", pulledBase, T0.toISOString());

  const Students = phone.load("src/services/student.service").StudentService;
  const Subjects = phone.load("src/services/subject.service").SubjectService;
  const { createAssignment } = phone.load("src/services/assignment.service");
  const { enrollStudentLocally } = phone.load("src/services/studentEnroll.service");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. offline ---");
  phone.net.connected = false;
  writes.length = 0;
  // Kojo's email corrected to his mother's, which his sister Esi already has.
  await run(() => Students.updateStudent("st-1", { lastName: "Boateng-Mensah", email: "efua@family.test" }, { changeReason: "typo" }));
  await run(() => Students.suspend("st-3"));
  await run(() => Students.moveToClass("st-4", "cls-b"));
  await run(() => Students.delete("st-5"));
  const sub = await run(() => Subjects.create({ name: "Physics", classId: "cls-a", code: "PHY", schoolId: S }));
  const asg = await run(() => createAssignment({ teacherId: "tea-1", classId: "cls-a", subjectId: sub.id }));
  const ghost = (await run(() => enrollStudentLocally({ schoolId: S, classId: "cls-a", firstName: "Ghost", lastName: "Pupil" }))).id;
  await run(() => Students.updateStudent(ghost, { firstName: "Gone" }));
  await run(() => Students.delete(ghost));

  check("the phone shows every change at once",
    local(`SELECT id, lastName, status, class_id, deleted_at IS NOT NULL AS gone FROM students WHERE id IN ('st-1','st-3','st-4','st-5') ORDER BY id`)
      .map((r) => [r.id, r.lastName, r.status, r.class_id, r.gone]),
    // (the pull carries no lastName, so only the corrected pupil has one here)
    [["st-1", "Boateng-Mensah", "approved", "cls-a", 0], ["st-3", null, "suspended", "cls-a", 0],
     ["st-4", null, "approved", "cls-b", 0], ["st-5", null, "approved", "cls-a", 1]]);
  check("  nothing reached the server while offline", writes, []);

  // Meanwhile the deputy corrects Kojo on the console.
  await new Promise((r) => setTimeout(r, 5));
  await M("Student").updateOne({ _id: "st-1" }, { $set: { guardianName: "Efua A. Boateng", updatedAt: new Date(), updatedBy: "adm2", updatedByName: "Deputy" } });

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. reconnect ---");
  phone.net.connected = true;
  await sync();

  const count = (w) => writes.filter((x) => x === w).length;
  check("each operation reached the server exactly once",
    [count("PATCH /students/st-1"), count("PATCH /students/st-3/suspend"), count("PATCH /students/st-4/move"),
     count("DELETE /students/st-5"), count("POST /admin/subjects"), count("POST /admin/teacher-assignments")],
    [1, 1, 1, 1, 1, 1]);
  check("  the subject before the assignment that names it",
    writes.indexOf("POST /admin/subjects") < writes.indexOf("POST /admin/teacher-assignments"), true);
  check("  nothing for the pupil enrolled and removed offline", writes.filter((w) => w.includes(ghost) || w === "POST /students"), []);

  const kojo = await M("Student").findById("st-1").lean();
  check("Kojo: the correction landed, sharing his sister's (his mother's) email",
    [kojo.lastName, kojo.email, kojo.studentName], ["Boateng-Mensah", "efua@family.test", "Kojo Boateng-Mensah"]);
  check("  the deputy's own field is kept (only what moved was written)", kojo.guardianName, "Efua A. Boateng");
  const overwrites = await M("SyncOverwrite").find({ entityId: "st-1" }).lean();
  check("  the overwrite of the deputy's edit is recorded",
    overwrites.map((o) => [o.entityType, o.newAction, o.lostEditBy, o.overwrittenBy]), [["student", "edit", "adm2", "adm"]]);
  check("Yaw is suspended", (await M("Student").findById("st-3").lean()).status, "suspended");
  check("Akua is in Form 2", (await M("Student").findById("st-4").lean()).classId, "cls-b");
  check("Kwame is removed", await M("Student").findById("st-5").lean(), null);
  check("no record of the dropped pupil", await M("Student").findById(ghost).lean(), null);
  const sOnServer = await M("Subject").findById(sub.id).lean();
  check("the subject exists under the phone's id", [sOnServer?.name, sOnServer?.classId], ["Physics", "cls-a"]);
  const aOnServer = await M("TeacherAssignment").findById(asg.assignment?.id).lean();
  check("the assignment exists under the phone's id, naming that subject",
    [aOnServer?.teacher, aOnServer?.class, aOnServer?.subject], ["tea-1", "cls-a", sub.id]);
  check("the phone's outbox is empty", local("SELECT entity_key, status, error FROM mutation_outbox WHERE status != 'synced'"), []);
  check("the phone: Kwame's tombstone is gone, the subject and the assignment are clean",
    [local("SELECT id FROM students WHERE id = 'st-5'").length,
     local("SELECT _synced FROM subjects WHERE id = ?", [sub.id])[0]?._synced,
     local("SELECT _synced FROM teacher_assignments WHERE id = ?", [asg.assignment?.id ?? null])[0]?._synced],
    [0, 1, 1]);

  const before = writes.length;
  await sync();
  check("a second sync sends nothing", writes.slice(before), []);

  phone.kill();
  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
