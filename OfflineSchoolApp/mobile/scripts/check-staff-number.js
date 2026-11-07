// mobile/scripts/check-staff-number.js
"use strict";

/**
 * A teacher's staff number on the phone: issued by the server, never made
 * here, stored in users.staff_no and shown read-only.
 *
 * The REAL phone (peruser-harness.js) against the REAL backend routes (auth,
 * sync, admin) over an in-memory MongoDB:
 *
 *   1. the users table gains staff_no additively: a phone with the old table
 *      and a row in it keeps the row and gets the column;
 *   2. the pull brings each teacher's number down (getAll / getById);
 *   3. a teacher created OFFLINE shows "pending" — no number made on the
 *      device — and the server's number once the create syncs;
 *   4. a teacher created online has the number from the create's answer at
 *      once;
 *   5. an administrator's override on the server reaches the phone on the
 *      next pull, and a pull without the field never erases a number;
 *   6. the screens: the profile setup's Staff ID is read-only and no longer
 *      required; the settings, the admin list and the admin edit screen show
 *      the school's number (static, as the UI cannot run here).
 *
 *   node scripts/check-staff-number.js
 */

const fs     = require("fs");
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
  await mongoose.connect(mongo.getUri(), { dbName: "staff-number-phone" });

  const S = "5c0e2e000000000000000003";
  const PW = "Check-only-passw0rd";
  const { app, User } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const User = mongoose.model("User");
    await mongoose.model("School").create({ _id: S, name: "Staff School", code: "STS", email: "sts@example.test" });
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
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
    return { app, User };
  })();
  const { ensureStaffNumbers } = breq(path.join(BACKEND, "src/db/ensureStaffNoIndex"));

  const AMA = "8a1f0c52-1b7e-4c3a-9d11-0000000000b1";
  await User.create({ _id: "adm", name: "Head", email: "head@staff.test", password: PW, role: "school_admin", schoolId: S, isActive: true });
  await User.create({ _id: AMA, name: "Ama Owusu", email: "ama@staff.test", password: PW, role: "teacher", schoolId: S, isActive: true });
  // Ama is from before numbers: the server's boot backfill numbers her.
  await quietly(() => ensureStaffNumbers({ log: () => {}, error: () => {} }))();
  const amaNo = (await User.findById(AMA).lean()).staffNo;
  check("the server numbered the existing teacher", amaNo, "STS-STF-001");

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
  const local = (phone, id) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.one("SELECT id, name, staff_no FROM users WHERE id = ?", [id]); } finally { d.close(); }
  };
  const columns = (phone) => {
    const d = phone.inspect("schoolapp.db");
    try { return d.all("PRAGMA table_info(users)").map((c) => c.name); } finally { d.close(); }
  };
  const svc = (phone) => phone.load("src/services/teacher.service").TeacherService;
  const util = (phone) => phone.load("src/utils/staffNumber");
  const tr = (k) => ({ "staffNo.pending": "PENDING", "staffNo.none": "NONE" })[k] ?? k;
  const shown = (phone, row) => util(phone).staffNoText(tr, util(phone).staffNoStatus(row));

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 1. the column is added to an existing table, rows kept ---");
  const dir = tmpDir("staff-number");
  {
    // The users table as builds before this one made it: no staff_no.
    const { DatabaseSync } = require("node:sqlite");
    const w = new DatabaseSync(path.join(dir, "schoolapp.db"));
    w.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, schoolId TEXT, school_id TEXT, name TEXT, email TEXT, enrollmentNo TEXT,
      role TEXT, is_active INTEGER DEFAULT 1, must_reset_password INTEGER DEFAULT 0, passwordSalt TEXT,
      passwordHash TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT)`);
    w.prepare(`INSERT INTO users (id, name, email, role, schoolId, school_id, is_active, created_at, _synced)
               VALUES ('old-row', 'Old Row', 'old@staff.test', 'teacher', ?, ?, 1, '2026-01-01', 1)`).run(S, S);
    w.close();
    const p = await boot(dir);
    await quietly(() => p.load("src/db/database").getDatabase())();
    check("an old table: the column is back", columns(p).includes("staff_no"), true);
    check("  and the row that was there is intact", local(p, "old-row"), { id: "old-row", name: "Old Row", staff_no: null });
    p.kill();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 2. the pull brings the numbers down ---");
  const phone = await boot(dir);
  check("the administrator signs in online", await login(phone, "head@staff.test"), true);
  await sync(phone);
  check("Ama's number is on the phone", local(phone, AMA)?.staff_no, amaNo);
  const listed = (await quietly(() => svc(phone).getAll())()).find((x) => x.id === AMA);
  check("the teacher list reads it", [listed?.staffNo, shown(phone, listed)], [amaNo, amaNo]);
  const one = await quietly(() => svc(phone).getById(AMA))();
  check("and the teacher's own record", one?.staffNo, amaNo);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 3. created offline: pending, then the server's number ---");
  phone.net.connected = false;
  const kofiId = await quietly(() => svc(phone).create("Kofi Mensah", "kofi@staff.test"))();
  const kofiRow = (await quietly(() => svc(phone).getAll())()).find((x) => x.id === kofiId);
  check("no number is made on the device", [kofiRow?.staffNo ?? null, local(phone, kofiId)?.staff_no], [null, null]);
  check("  and the screen says pending", shown(phone, kofiRow), "PENDING");
  phone.net.connected = true;
  await sync(phone);
  const kofiServer = await User.findById(kofiId).lean();
  check("the create reached the server and was numbered there", kofiServer?.staffNo, "STS-STF-002");
  const kofiAfter = (await quietly(() => svc(phone).getAll())()).find((x) => x.id === kofiId);
  check("the phone now shows the server's number", [kofiAfter?.staffNo, shown(phone, kofiAfter)], ["STS-STF-002", "STS-STF-002"]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 4. created online: the number from the create's answer ---");
  const yawId = await quietly(() => svc(phone).create("Yaw Darko", "yaw@staff.test"))();
  check("numbered at once, before any pull", local(phone, yawId)?.staff_no, "STS-STF-003");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 5. an override on the server reaches the phone ---");
  await User.updateOne({ _id: AMA }, { $set: { staffNo: "HR/2019-07" } });
  await sync(phone);
  check("the new number replaces the old", local(phone, AMA)?.staff_no, "HR/2019-07");
  // A feed row without the field (an older server) keeps what the phone has.
  await quietly(() => phone.load("src/services/syncManager").SyncManager.syncTeachers([
    { _id: AMA, name: "Ama Owusu", email: "ama@staff.test", schoolId: S, isActive: true },
  ]))();
  check("a pull that does not carry it never erases it", local(phone, AMA)?.staff_no, "HR/2019-07");
  check("a teacher the server has with no number reads 'not assigned yet'",
    shown(phone, { id: AMA, staffNo: null, syncedAt: "2026-01-01" }), "NONE");
  phone.kill();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- 6. the screens ---");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const setup = read("app/teacher/profile/setup.js");
  check("profile setup: Staff ID is no longer required input", /errors\.staffId\s*=/.test(setup), false);
  check("  it shows the school's number, read-only",
    /label=\{t\("staffNo\.labelLong"\)\}\s*value=\{staffNoText\(t, staffNo\)\}\s*editable=\{false\}/.test(setup), true);
  check("  nothing types into it", /onChangeText=\{\(v\) => set\("staffId", v\)\}/.test(setup), false);
  const settings = read("app/teacher/settings/index.js");
  check("settings show the school's number, not the typed one",
    [settings.includes("value={staffNoText(t, staffNo)}"), settings.includes("value={profile.staffId}")], [true, false]);
  check("the admin list shows it", read("app/admin/teachers/index.js").includes("staffNoText(t, staffNo)"), true);
  const edit = read("app/admin/teachers/edit.js");
  check("the admin edit screen shows it, read-only (no input for it)",
    [edit.includes("staffNoText(t, staffNoStatus(teacher))"), /FieldInput[^>]*staffNo/.test(edit)], [true, false]);
  for (const lang of ["en", "fr"]) {
    const d = JSON.parse(read(`src/i18n/locales/${lang}.json`));
    check(`${lang}: the staff-number strings`,
      ["label", "labelLong", "pending", "none", "fromSchool"].every((k) => typeof d.staffNo?.[k] === "string" && d.staffNo[k].trim()), true);
  }

  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
