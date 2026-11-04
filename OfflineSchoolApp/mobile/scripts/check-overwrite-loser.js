// mobile/scripts/check-overwrite-loser.js
"use strict";

/**
 * When Kofi's edit replaces Ama's, AMA's phone is the one that says so.
 *
 * The phone stored only the `overwrote` object a student write answers with —
 * the WINNER's copy — and the sync-overwrites screen and dashboard tile read
 * it as "X's edit replaced yours". So the person who overwrote was told they
 * had been overwritten, and the person whose edit was lost heard nothing.
 *
 * The REAL phone (peruser-harness.js: the app's modules over node:sqlite)
 * against the REAL backend routes (auth, students, sync) over an in-memory
 * MongoDB. Two phones, one per administrator:
 *
 *   1. Ama corrects a pupil; Kofi, from the version before hers, overwrites;
 *   2. Kofi's phone keeps a quiet note with the overwrite's id — not counted;
 *   3. Ama's phone fetches it: counted, her version in the snapshot;
 *   4. Ama marks it seen offline → sent when she is back online;
 *   5. seen on another device → seen here; "mark all" reaches the server;
 *   6. the pupil's two siblings (same guardian) never appear.
 *
 *   node scripts/check-overwrite-loser.js
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
const tick = () => new Promise((r) => setTimeout(r, 15));

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "check-only-refresh-secret";
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

  const express  = breq("express");
  const mongoose = breq("mongoose");
  const { MongoMemoryServer } = breq("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "overwrite-loser" });

  const S  = "5c0e2e000000000000000077";
  const PW = "Check-only-passw0rd";
  const { app, User, Student, SyncOverwrite } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    await mongoose.model("School").create({ _id: S, name: "Overwrite School", code: "OVL", email: "ovl@example.test" });
    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    app.use("/api/auth",     breq(path.join(BACKEND, "src/routes/auth.routes")));
    app.use("/api/students", auth.authenticate, breq(path.join(BACKEND, "src/routes/students.routes")));
    app.use("/api/sync",     auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));
    return { app, User: mongoose.model("User"), Student: mongoose.model("Student"), SyncOverwrite: mongoose.model("SyncOverwrite") };
  })();

  const AMA  = "8a1f0c52-1b7e-4c3a-9d11-0000000000a1";
  const KOFI = "8a1f0c52-1b7e-4c3a-9d11-0000000000a2";
  await User.create({ _id: AMA,  name: "Ama Owusu",   email: "ama@ovl.test",  password: PW, role: "school_admin", schoolId: S, isActive: true });
  await User.create({ _id: KOFI, name: "Kofi Mensah", email: "kofi@ovl.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  // Three children of one guardian (CLAUDE.md): same name, email and phone.
  for (const [id, first] of [["st-1", "Kwesi"], ["st-2", "Yaw"], ["st-3", "Akua"]]) {
    await Student.create({
      _id: id, userId: `u-${id}`, schoolId: S, firstName: first, lastName: "Boateng",
      studentName: `${first} Boateng`, enrollmentNo: `E-${id}`, status: "approved", isActive: true,
      guardianName: "Esi Boateng", guardianEmail: "esi@family.test", guardianPhone: "670000001",
    });
  }

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
  const waitIdle = async (phone) => {
    for (let i = 0; i < 6000 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const login = async (phone, email) => {
    const ok = await quietly(() => phone.useAuthStore.getState().login({ email, password: PW }))();
    await waitIdle(phone);
    return ok;
  };
  const svc      = (phone) => phone.load("src/services/sync-overwrite.service").SyncOverwriteService;
  const students = (phone) => phone.load("src/services/student.service").StudentService;
  const q        = (fn) => quietly(fn)();
  const updatedAt = async (id) => (await Student.findById(id).lean()).updatedAt.toISOString();

  const ama  = await boot(tmpDir("overwrite-ama"));
  const kofi = await boot(tmpDir("overwrite-kofi"));
  check("Ama signs in on her phone",  await login(ama,  "ama@ovl.test"),  true);
  check("Kofi signs in on his phone", await login(kofi, "kofi@ovl.test"), true);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. Kofi overwrites Ama's correction ---");
  const base = await updatedAt("st-1");                         // Kofi's screen loaded this
  await tick();
  await q(() => students(ama).updateStudent("st-1", { address: "4 Palm St" }));
  await tick();
  await q(() => students(kofi).updateStudent("st-1", { address: "9 Oak Ave" }, { baseUpdatedAt: base }));
  check("the server holds Kofi's edit (last write wins)", (await Student.findById("st-1").lean()).address, "9 Oak Ave");
  const row = await SyncOverwrite.findOne({ entityId: "st-1" }).lean();
  check("one overwrite, Ama the loser", [await SyncOverwrite.countDocuments({}), row?.lostEditBy, row?.overwrittenBy], [1, AMA, KOFI]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. the winner's phone: a quiet note, not an alert ---");
  const kofiRows = await q(() => svc(kofi).getAllOverwrites());
  check("Kofi's phone kept the note under the server's id",
    kofiRows.map((r) => [r.id, r.side, r.lost_edit_by_name, r.seen_by_loser]), [[row?._id, "won", "Ama Owusu", 1]]);
  check("Kofi's badge stays at 0", await q(() => svc(kofi).getUnseenCount()), 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. the loser's phone is told ---");
  check("Ama's badge counts it", await q(() => svc(ama).getUnseenCount()), 1);
  const amaRows = await q(() => svc(ama).getAllOverwrites());
  const mine = amaRows[0] || {};
  check("Ama's list: the overwrite, as hers",
    [amaRows.length, mine.id, mine.side, mine.entity_id, mine.overwritten_by_name, mine.new_action, mine.seen_by_loser],
    [1, row?._id, "lost", "st-1", "Kofi Mensah", "edit", 0]);
  check("her own version is in the snapshot", mine.lost_version?.address ?? null, "4 Palm St");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. seen offline, told when back online ---");
  ama.net.connected = false;
  await q(() => svc(ama).markAsSeen(row?._id));
  check("seen on the phone at once", await q(() => svc(ama).getUnseenCount()), 0);
  check("the server has not heard yet", (await SyncOverwrite.findById(row?._id).lean()).seenByLoser, false);
  ama.net.connected = true;
  await q(() => svc(ama).refreshFromServer({ force: true }));
  check("…and has once she is online", (await SyncOverwrite.findById(row?._id).lean()).seenByLoser, true);
  check("still seen on the phone after the refresh", await q(() => svc(ama).getUnseenCount()), 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. another device, and mark-all ---");
  {
    const b = await updatedAt("st-1");
    await tick();
    await q(() => students(ama).updateStudent("st-1", { city: "Kumasi" }));
    await tick();
    await q(() => students(kofi).updateStudent("st-1", { city: "Tamale" }, { baseUpdatedAt: b }));
    await q(() => svc(ama).refreshFromServer({ force: true }));
    check("the second overwrite arrives", await q(() => svc(ama).getUnseenCount()), 1);
    const second = await SyncOverwrite.findOne({ entityId: "st-1", _id: { $ne: row?._id } }).lean();
    await SyncOverwrite.updateOne({ _id: second._id }, { $set: { seenByLoser: true, seenAt: new Date() } });  // seen on the web
    await q(() => svc(ama).refreshFromServer({ force: true }));
    check("seen on another device → seen here", await q(() => svc(ama).getUnseenCount()), 0);

    const b2 = await updatedAt("st-1");
    await tick();
    await q(() => students(ama).updateStudent("st-1", { city: "Wa" }));
    await tick();
    await q(() => students(kofi).updateStudent("st-1", { city: "Bolga" }, { baseUpdatedAt: b2 }));
    await q(() => svc(ama).refreshFromServer({ force: true }));
    check("a third arrives", await q(() => svc(ama).getUnseenCount()), 1);
    await q(() => svc(ama).markAllAsSeen());
    check("mark-all reaches the server", await SyncOverwrite.countDocuments({ lostEditBy: AMA, seenByLoser: false }), 0);
    check("Kofi's phone still counts nothing", await q(() => svc(kofi).getUnseenCount()), 0);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. siblings ---");
  const all = await q(() => svc(ama).getAllOverwrites({ limit: 200 }));
  check("every alert is about the child Kofi overwrote", [...new Set(all.map((r) => r.entity_id))], ["st-1"]);
  const sibs = await Student.find({ _id: { $in: ["st-2", "st-3"] } }).sort({ _id: 1 }).lean();
  check("the siblings keep their shared guardian, untouched",
    sibs.map((s) => [s.guardianName, s.guardianEmail, s.address ?? null]), [["Esi Boateng", "esi@family.test", null], ["Esi Boateng", "esi@family.test", null]]);

  ama.kill();
  kofi.kill();
  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
