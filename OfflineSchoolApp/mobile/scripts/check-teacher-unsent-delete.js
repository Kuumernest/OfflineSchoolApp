// mobile/scripts/check-teacher-unsent-delete.js
"use strict";

/**
 * A teacher created on this phone and deleted before its create was sent is
 * dropped here, with nothing sent. It used to be soft-deleted with its create
 * still queued, so the next sync CREATED the teacher on the server and then
 * deactivated them — or, online, sent DELETE first (a 404) and the create
 * after it, leaving the teacher live on the server.
 *
 * The REAL phone (peruser-harness.js) against the REAL backend routes (auth,
 * sync, admin) over an in-memory MongoDB. Assertions read the requests the
 * phone sent, its outbox, its local rows and MongoDB.
 *
 *   1. created offline, never queued, deleted          → nothing sent, row gone
 *   2. created offline, create queued (never attempted),
 *      deleted                                         → nothing sent, queue empty
 *   3. as 2, with an assignment made against it (queued, then unassigned)
 *                                                      → the assignment goes too
 *   4. the create was attempted and the answer lost (it landed), then
 *      deleted                                         → create kept, DELETE
 *                                                        behind it: removed on
 *                                                        the server
 *   4b. the create timed out before reaching the server and its DELETE
 *      overtook the backed-off retry (a 404)          → when the create lands,
 *                                                        a DELETE follows it
 *   5. the same through create()'s own direct POST    → DELETE sent, removed
 *   6. created and synced, then deleted                → the normal DELETE
 *   7. a row an older build soft-deleted beside a queued, never-sent create
 *                                                      → the sweep drops both
 *   8. an assignment against it may have landed        → not dropped: DELETE
 *
 *   node scripts/check-teacher-unsent-delete.js
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
  await mongoose.connect(mongo.getUri(), { dbName: "teacher-unsent-delete" });

  const S = "5c0e2e000000000000000003";
  const PW = "Check-only-passw0rd";
  const { app, User } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const User = mongoose.model("User");
    await mongoose.model("School").create({ _id: S, name: "Drop School", code: "DRS", email: "drs@example.test" });
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    // No mail leaves the process.
    breq(path.join(BACKEND, "src/services/email.service")).sendEmail = async () => ({ success: true });
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

  await User.create({ _id: "adm", name: "Head", email: "head@drop.test", password: PW, role: "school_admin", schoolId: S, isActive: true });

  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const axios = require("axios");
  const sent = [];
  // Set to lose the answer to the next teacher create: the server stores it,
  // the phone hears nothing — a dropped connection on the way back.
  const lose = { nextTeacherCreate: false, nextTeacherCreateRequest: false };
  const isTeacherCreate = (cfg) =>
    String(cfg.method).toUpperCase() === "POST" && /\/admin\/teachers\/?$/.test(cfg.url);
  const boot = async (dir) => {
    const http = axios.create({ baseURL: API, timeout: 15_000 });
    let phone = null;
    http.interceptors.request.use((cfg) => {
      if (!phone.net.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; }
      cfg.headers.Authorization = `Bearer ${phone.useAuthStore.getState().token}`;
      // A request that times out before it reaches the server: the phone
      // cannot tell this from a lost answer.
      if (lose.nextTeacherCreateRequest && isTeacherCreate(cfg)) {
        lose.nextTeacherCreateRequest = false;
        const e = new Error("timeout of 15000ms exceeded"); e.code = "ECONNABORTED"; e.config = cfg;
        throw e;
      }
      if (!["get", "head"].includes(String(cfg.method).toLowerCase())) {
        const body = typeof cfg.data === "string" ? JSON.parse(cfg.data) : cfg.data;
        sent.push({ m: String(cfg.method).toUpperCase(), url: cfg.url, name: body?.name ?? null });
      }
      return cfg;
    });
    http.interceptors.response.use((res) => {
      if (lose.nextTeacherCreate && isTeacherCreate(res.config)) {
        lose.nextTeacherCreate = false;
        const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.config = res.config;
        throw e;
      }
      return res;
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
  const logout = (phone) => quietly(() => phone.useAuthStore.getState().logout())();
  const sync = (phone) => quietly(async () => {
    const { SyncManager } = phone.load("src/services/syncManager");
    await SyncManager.ensureStarted();
    await SyncManager.syncAll({ force: true });
  })();
  // Due now: what a later sync would find once its backoff has passed.
  const dueNow = async (phone) => {
    const { getDatabase } = phone.load("src/db/database");
    const db = await getDatabase();
    await db.runAsync("UPDATE mutation_outbox SET next_attempt_at = NULL WHERE status IN ('pending', 'retrying')");
  };
  const settle = async (phone) => {
    for (let i = 0; i < 4; i++) { await dueNow(phone); await sync(phone); }
  };
  const backfill = (phone) => quietly(() => phone.load("src/services/syncBackfill.service").backfillOutbox())();
  const writes = (re) => sent.filter((s) => re.test(s.url)).map((s) => `${s.m} ${s.url.replace(/^.*\/admin/, "")}`);
  const teacherWrites = () => writes(/\/admin\/teachers(\/|$)/);
  const outbox = (phone) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.all("SELECT entity_key, method, status FROM mutation_outbox WHERE status != 'synced' ORDER BY created_at"); } finally { d.close(); }
  };
  const localTeacher = (phone, id) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.one("SELECT id, deleted_at IS NOT NULL AND deleted_at != '' AS deleted FROM users WHERE id = ?", [id]) ?? null; } finally { d.close(); }
  };
  const localAssignment = (phone, id) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.one("SELECT id FROM teacher_assignments WHERE id = ?", [id]) ?? null; } finally { d.close(); }
  };
  const serverTeacher = async (email) => {
    const u = await User.findOne({ email }).lean();
    return u ? { active: u.isActive } : null;
  };
  const teacherSvc = (phone) => phone.load("src/services/teacher.service").TeacherService;
  const create = (phone, name, email) => quietly(() => teacherSvc(phone).create(name, email))();
  const del = (phone, id) => quietly(async () => {
    try { return await teacherSvc(phone).delete(id); } catch (e) { return `threw: ${e.message}`; }
  })();

  const phone = await boot(tmpDir("teacher-unsent-delete"));
  check("the administrator signs in online", await login(phone, "head@drop.test"), true);
  await sync(phone);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. created offline, never queued, deleted ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama One", "ama1@drop.test");
    check("the delete succeeds", await del(phone, id), true);
    check("the local row is gone", localTeacher(phone, id), null);
    phone.net.connected = true;
    await settle(phone);
    check("nothing about this teacher is sent", teacherWrites(), []);
    check("the server never had them", await serverTeacher("ama1@drop.test"), null);
    check("nothing left in the outbox", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. created offline, create queued (never attempted), deleted ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama Two", "ama2@drop.test");
    await backfill(phone);
    check("the create is queued", outbox(phone).map((r) => r.entity_key), [`teacher:${id}`]);
    check("the delete succeeds", await del(phone, id), true);
    check("the local row is gone", localTeacher(phone, id), null);
    check("and the queued create with it", outbox(phone), []);
    phone.net.connected = true;
    await settle(phone);
    check("nothing about this teacher is sent", teacherWrites(), []);
    check("the server never had them", await serverTeacher("ama2@drop.test"), null);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. as 2, with an assignment made against it ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama Three", "ama3@drop.test");
    const { getDatabase } = phone.load("src/db/database");
    const db = await getDatabase();
    const aid = "local_assign_ama3";
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO teacher_assignments (id, teacher_id, teacherId, class_id, classId, subject_id, subjectId,
         school_id, schoolId, _synced, created_at, updated_at)
       VALUES (?, ?, ?, 'local_cls_x', 'local_cls_x', 'local_sub_x', 'local_sub_x', ?, ?, 0, ?, ?)`,
      [aid, id, id, S, S, now, now]
    );
    await backfill(phone);
    check("the teacher and the assignment creates are queued",
      outbox(phone).map((r) => r.entity_key).sort(), [`assignment:${aid}`, `teacher:${id}`].sort());
    // Unassigned (as TeacherService.unassignSubject does offline), then deleted.
    await db.runAsync("UPDATE teacher_assignments SET deleted_at = ?, _synced = 0 WHERE id = ?", [now, aid]);
    check("the delete succeeds", await del(phone, id), true);
    check("the teacher row is gone", localTeacher(phone, id), null);
    check("the assignment row is gone", localAssignment(phone, aid), null);
    check("nothing left in the outbox — no orphan assignment create", outbox(phone), []);
    phone.net.connected = true;
    await settle(phone);
    check("nothing sent for the teacher", teacherWrites(), []);
    check("nothing sent for the assignment", writes(/teacher-assignments/), []);
    check("nothing left in the outbox after the sync", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. create attempted, answer lost (it landed), then deleted ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama Four", "ama4@drop.test");
    await backfill(phone);
    phone.net.connected = true;
    lose.nextTeacherCreate = true;
    const { MutationQueue } = phone.load("src/services/mutationQueue.service");
    await quietly(() => MutationQueue.processPending())();
    check("the create reached the server", await serverTeacher("ama4@drop.test"), { active: true });
    check("the phone does not know it landed",
      outbox(phone).map((r) => [r.entity_key, r.status]), [[`teacher:${id}`, "retrying"]]);
    phone.net.connected = false;
    check("the delete succeeds", await del(phone, id), true);
    check("the create is kept and the DELETE queued behind it",
      outbox(phone).map((r) => r.entity_key), [`teacher:${id}`, `teacher-delete:${id}`]);
    phone.net.connected = true;
    await settle(phone);
    check("the teacher is removed on the server", await serverTeacher("ama4@drop.test"), { active: false });
    check("one account under that email", await User.countDocuments({ email: "ama4@drop.test" }), 1);
    check("the DELETE was sent", teacherWrites().filter((w) => w.startsWith("DELETE")), [`DELETE /teachers/${id}`]);
    check("nothing left in the outbox", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4b. the create timed out unsent, and the DELETE overtakes its retry ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama Four B", "ama4b@drop.test");
    await backfill(phone);
    phone.net.connected = true;
    lose.nextTeacherCreateRequest = true;
    const { MutationQueue } = phone.load("src/services/mutationQueue.service");
    await quietly(() => MutationQueue.processPending())();
    phone.net.connected = false;
    check("the delete succeeds", await del(phone, id), true);
    phone.net.connected = true;
    // The create is still backing off; only the DELETE is due.
    const { getDatabase } = phone.load("src/db/database");
    const db = await getDatabase();
    await db.runAsync("UPDATE mutation_outbox SET next_attempt_at = ? WHERE entity_key = ?",
      [new Date(Date.now() + 3_600_000).toISOString(), `teacher:${id}`]);
    await quietly(() => MutationQueue.processPending())();
    check("the DELETE went first", teacherWrites().filter((w) => !w.startsWith("POST")), [`DELETE /teachers/${id}`]);
    check("it met nothing to delete", await serverTeacher("ama4b@drop.test"), null);
    // The create's retry comes due and a drain sends it (a drain alone — a
    // full sync's backfill would drop it first, the row now settled as
    // deleted). It lands; its reconciler sees the row deleted with no DELETE
    // waiting, and queues one behind it.
    await dueNow(phone);
    await quietly(() => MutationQueue.processPending())();
    check("the create lands", (await serverTeacher("ama4b@drop.test"))?.active, true);
    check("a DELETE is queued behind it", outbox(phone).map((r) => r.entity_key), [`teacher-delete:${id}`]);
    await quietly(() => MutationQueue.processPending())();
    check("and is sent",
      teacherWrites().filter((w) => w.startsWith("DELETE")), [`DELETE /teachers/${id}`, `DELETE /teachers/${id}`]);
    check("so the teacher ends removed on the server",
      await serverTeacher("ama4b@drop.test"), { active: false });
    check("one account under that email", await User.countDocuments({ email: "ama4b@drop.test" }), 1);
    check("nothing left in the outbox", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. create()'s own POST, answer lost, then deleted ---");
  {
    sent.length = 0;
    lose.nextTeacherCreate = true;
    const id = await create(phone, "Ama Five", "ama5@drop.test");
    check("the create reached the server", await serverTeacher("ama5@drop.test"), { active: true });
    phone.net.connected = false;
    check("the delete succeeds", await del(phone, id), true);
    check("the DELETE is queued, not dropped", outbox(phone).map((r) => r.entity_key), [`teacher-delete:${id}`]);
    phone.net.connected = true;
    await settle(phone);
    check("the teacher is removed on the server", await serverTeacher("ama5@drop.test"), { active: false });
    check("nothing left in the outbox", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. created and synced, then deleted ---");
  {
    sent.length = 0;
    const id = await create(phone, "Ama Six", "ama6@drop.test");
    check("created on the server", await serverTeacher("ama6@drop.test"), { active: true });
    check("the delete succeeds (online)", await del(phone, id), true);
    check("the normal DELETE was sent", teacherWrites(), ["POST /teachers", `DELETE /teachers/${id}`]);
    check("the teacher is removed on the server", await serverTeacher("ama6@drop.test"), { active: false });

    sent.length = 0;
    const id2 = await create(phone, "Ama Six B", "ama6b@drop.test");
    phone.net.connected = false;
    check("an offline delete of a synced teacher succeeds", await del(phone, id2), true);
    check("the row is kept, marked deleted, for the sync", localTeacher(phone, id2)?.deleted, 1);
    phone.net.connected = true;
    await settle(phone);
    check("the sweep sends the DELETE", teacherWrites(), ["POST /teachers", `DELETE /teachers/${id2}`]);
    check("removed on the server", await serverTeacher("ama6b@drop.test"), { active: false });
    check("nothing left in the outbox", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 7. an older build's soft-deleted row beside a never-sent create ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama Seven", "ama7@drop.test");
    await backfill(phone);
    // What the old delete did: soft-deleted the row, left the create queued.
    const { getDatabase } = phone.load("src/db/database");
    const db = await getDatabase();
    await db.runAsync("UPDATE users SET deleted_at = ?, _synced = 0 WHERE id = ?", [new Date().toISOString(), id]);
    phone.net.connected = true;
    await settle(phone);
    check("nothing about this teacher is sent", teacherWrites(), []);
    check("the server never had them", await serverTeacher("ama7@drop.test"), null);
    check("the local row is gone", localTeacher(phone, id), null);
    check("nothing left in the outbox", outbox(phone), []);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 8. an assignment against it may have landed ---");
  {
    phone.net.connected = false;
    sent.length = 0;
    const id = await create(phone, "Ama Eight", "ama8@drop.test");
    const { getDatabase } = phone.load("src/db/database");
    const db = await getDatabase();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO teacher_assignments (id, teacher_id, teacherId, subject_id, subjectId, school_id, schoolId,
         _synced, _synced_at, deleted_at, created_at, updated_at)
       VALUES ('local_assign_ama8', ?, ?, 'local_sub_y', 'local_sub_y', ?, ?, 0, ?, ?, ?, ?)`,
      [id, id, S, S, now, now, now, now]
    );
    check("the delete succeeds", await del(phone, id), true);
    check("the teacher is not dropped", localTeacher(phone, id)?.deleted, 1);
    check("its DELETE is queued instead",
      outbox(phone).map((r) => r.entity_key).filter((k) => k.startsWith("teacher")), [`teacher-delete:${id}`]);
  }

  await logout(phone);
  phone.kill();
  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
