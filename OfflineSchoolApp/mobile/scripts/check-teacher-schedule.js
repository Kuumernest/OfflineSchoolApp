// mobile/scripts/check-teacher-schedule.js
"use strict";
/**
 * The staff register on the phone lists who is timetabled.
 *
 * Online, the server decides (its own suite proves the rule); the phone sends
 * the date and the period and merges the marks. Offline, the phone applies the
 * same rule to the timetable it holds — services/teacherStats
 * fetchScheduledTeachersLocal — and, when it holds none, says so instead of
 * answering "nobody is scheduled". Run over a real SQLite with the phone's
 * real service code.
 *
 *   node scripts/check-teacher-schedule.js
 */
const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
};

/** expo-sqlite's async surface, over a real synchronous SQLite. */
const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
});

const makeLoader = (stubs, pkgStubs) => {
  const cache = new Map();
  const load = (abs) => {
    if (stubs.has(abs)) return stubs.get(abs);
    if (cache.has(abs)) return cache.get(abs).exports;
    const file = fs.existsSync(abs) ? abs : `${abs}.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(abs, mod);
    const dir = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.join(dir, id).replace(/\.js$/, ""));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

(async () => {
  const MON = "2026-09-14", TUE = "2026-09-15", SUN = "2026-09-20";
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  const netState = { connected: false };
  const apiLog   = [];
  const fakeApi  = {
    get: async (url, opts = {}) => {
      apiLog.push({ url, params: opts.params ?? null });
      if (!netState.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; }
      if (url === "/attendance/teachers/roster") {
        return { data: {
          success: true, scheduled: true, date: opts.params.date, dayOfWeek: "MON",
          periodId: opts.params.periodId ?? null, period: opts.params.periodId ? { _id: opts.params.periodId, name: "Period 1" } : null,
          teachers: [{ _id: "t1", name: "Server Ama", email: "ama@x.test", role: "teacher",
            slots: [{ classId: "c3a", className: "Form 3A", periodId: "p1" }] }],
          count: 1,
        } };
      }
      if (url === "/attendance/teachers") {
        return { data: { success: true, records: [
          { _id: "r-server", schoolId: opts.params.schoolId, teacherId: "t1", date: opts.params.date, status: "present" },
        ] } };
      }
      if (url === "/admin/periods") {
        return { data: { periods: [
          { _id: "sp2", name: "Server P2", startTime: "10:00", endTime: "11:00", sortOrder: 2 },
          { _id: "sp1", name: "Server P1", startTime: "08:00", endTime: "09:00", sortOrder: 1 },
          { _id: "spb", name: "Break",     startTime: "09:00", endTime: "10:00", sortOrder: 9, isBreak: true },
        ] } };
      }
      const e = new Error(`unexpected ${url}`); e.response = { status: 404 }; throw e;
    },
    post: async () => { const e = new Error("Network Error"); throw e; },
  };

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),  { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"), { DB: {
      query:      async (sql, params = []) => raw.prepare(sql).all(...(params ?? [])),
      queryFirst: async (sql, params = []) => raw.prepare(sql).get(...(params ?? [])) ?? null,
    } }],
    [path.join(MOBILE, "src/services/api"), { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/mutationQueue.service"), { MutationQueue: { enqueue: async () => ({}) } }],
    [path.join(MOBILE, "src/utils/authHelpers"), {
      isAuthenticated: () => true,
      getCurrentAuth:  () => ({ user: { _id: "admin-a", role: "school_admin", schoolId: "sch-a" }, token: "t" }),
    }],
  ]);
  const pkgStubs = new Map([
    ["@react-native-community/netinfo", {
      __esModule: true,
      default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: netState.connected }) },
    }],
  ]);
  const load = makeLoader(stubs, pkgStubs);
  const TS = load("src/services/teacherStats.service.js");
  const { AttendanceService } = load("src/services/attendance.service.js");

  console.log("\n--- the week, read from a date ---");
  check("a calendar day is its own weekday, not the evening before", TS.getDayCandidates(MON)[0], "MON");
  check("a Date is read as it always was", TS.getDayCandidates(new Date(2026, 8, 15))[0], "TUE");
  check("Sunday", TS.getDayCandidates(SUN)[0], "SUN");

  console.log("\n--- a phone that holds no timetable ---");
  let r = await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p1" });
  check("no timetable table at all: not available, and not an empty register", r, { available: false, teachers: [] });

  raw.exec(`
    CREATE TABLE timetable (
      _id TEXT PRIMARY KEY, school_id TEXT, class_id TEXT, subject_id TEXT, teacher_id TEXT,
      day_of_week TEXT, period_id TEXT, room TEXT, version INTEGER DEFAULT 1, deleted_at TEXT,
      _synced INTEGER DEFAULT 0, _synced_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT, schoolId TEXT, school_id TEXT, is_active INTEGER DEFAULT 1, deleted_at TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, schoolId TEXT, school_id TEXT, name TEXT, email TEXT, role TEXT, is_active INTEGER DEFAULT 1, deleted_at TEXT);
    CREATE TABLE periods (id TEXT PRIMARY KEY, schoolId TEXT, name TEXT, starttime TEXT, endtime TEXT,
      sortorder INTEGER DEFAULT 0, isbreak INTEGER DEFAULT 0, isactive INTEGER DEFAULT 1, deletedat TEXT);
    CREATE TABLE teacher_profiles (id TEXT PRIMARY KEY, schoolId TEXT, name TEXT, email TEXT, updated_at TEXT);
  `);
  r = await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p1" });
  check("an empty timetable table: still not available — nothing was ever downloaded", r.available, false);

  const slot = (id, school, cls, teacher, period, day, deleted = null) =>
    raw.prepare(`INSERT INTO timetable (_id, school_id, class_id, subject_id, teacher_id, day_of_week, period_id, deleted_at)
                 VALUES (?, ?, ?, 'subj', ?, ?, ?, ?)`).run(id, school, cls, teacher, day, period, deleted);
  slot("sb", "sch-b", "c1b", "tb", "p1b", "MON");
  r = await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p1" });
  check("another school's timetable is not this school's: still not available here", r.available, false);

  console.log("\n--- the timetable, with everyone the rule must exclude ---");
  const user = (id, school, name, active = 1, role = "teacher") =>
    raw.prepare("INSERT INTO users (id, schoolId, school_id, name, email, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, school, school, name, `${id}@x.test`, role, active);
  user("t1", "sch-a", "Ama"); user("t2", "sch-a", "Bea"); user("t3", "sch-a", "Cy");
  user("t4", "sch-a", "Dee", 0); user("t5", "sch-a", "Eli"); user("t6", "sch-a", "Fay"); user("t8", "sch-a", "Hal");
  user("tb", "sch-b", "Bob");
  const cls = (id, school, name, active = 1) =>
    raw.prepare("INSERT INTO classes (id, name, schoolId, school_id, is_active) VALUES (?, ?, ?, ?, ?)").run(id, name, school, school, active);
  cls("c3a", "sch-a", "Form 3A"); cls("c4b", "sch-a", "Form 4B"); cls("c5c", "sch-a", "Form 5C"); cls("c6d", "sch-a", "Form 6D");
  cls("c7e", "sch-a", "Form 7E"); cls("c8f", "sch-a", "Form 8F"); cls("c9z", "sch-a", "Form 9Z", 0); cls("c1b", "sch-b", "Form 1B");
  const period = (id, school, name, order, active = 1, isBreak = 0) =>
    raw.prepare("INSERT INTO periods (id, schoolId, name, starttime, endtime, sortorder, isbreak, isactive) VALUES (?, ?, ?, '08:00', '09:00', ?, ?, ?)")
      .run(id, school, name, order, isBreak, active);
  period("p1", "sch-a", "Period 1", 1); period("p2", "sch-a", "Period 2", 2); period("p3", "sch-a", "Period 3", 3, 0);
  period("pb", "sch-a", "Break", 4, 1, 1); period("p1b", "sch-b", "Period 1", 1);

  slot("s1", "sch-a", "c3a", "t1", "p1", "MON");
  slot("s2", "sch-a", "c4b", "t1", "p1", "MON");                       // two classes, one period
  slot("s3", "sch-a", "c3a", "t2", "p2", "MON");
  slot("s4", "sch-a", "c5c", "t2", "p1", "MON", "2026-09-01T00:00:00Z"); // deleted
  slot("s5", "sch-a", "c6d", "t4", "p1", "MON");                        // account switched off
  slot("s6", "sch-a", "c9z", "t5", "p1", "MON");                        // class switched off
  slot("s7", "sch-a", "c7e", "t6", "p1", "TUE");                        // Tuesday
  slot("s8", "sch-a", "c8f", "t8", "p3", "MON");                        // period switched off
  slot("s9", "sch-a", "c8f", "ghost", "p1", "MON");                     // an id nobody holds

  const ids = (x) => x.teachers.map((t) => t._id);
  r = await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p1" });
  check("Monday, Period 1: only the teacher timetabled then", [r.available, ids(r)], [true, ["t1"]]);
  check("  two classes in one period are one entry with two slots",
    r.teachers[0].slots.map((s) => `${s.classId}/${s.className}/${s.periodId}/${s.periodName}`),
    ["c3a/Form 3A/p1/Period 1", "c4b/Form 4B/p1/Period 1"]);
  check("  the name comes from the synced account", r.teachers[0].name, "Ama");
  check("  assigned-only, switched off, inactive class, Tuesday, deleted slot, inactive period, stale id: none listed",
    ["t3", "t4", "t5", "t6", "t2", "t8", "ghost"].some((id) => ids(r).includes(id)), false);
  check("Period 2", ids(await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p2" })), ["t2"]);
  check("back to Period 1, nothing kept", ids(await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p1" })), ["t1"]);
  check("a period switched off: nobody, but the timetable IS available",
    await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p3" }), { available: true, teachers: [] });
  check("an unknown period: nobody", ids(await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p99" })), []);
  check("Tuesday, Period 1", ids(await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: TUE, periodId: "p1" })), ["t6"]);
  check("Sunday: nobody, said as an empty available register",
    await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: SUN }), { available: true, teachers: [] });
  r = await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON });
  check("the day without a period: everyone timetabled that day, once each", ids(r), ["t1", "t2"]);
  check("the other school, asked for by its own id, lists its own teacher only",
    ids(await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-b", date: MON, periodId: "p1b" })), ["tb"]);

  console.log("\n--- names the accounts table does not have ---");
  raw.prepare("INSERT INTO teacher_profiles (id, schoolId, name, email) VALUES (?, ?, ?, ?)").run("ghost", "sch-a", "Cached Ghost", "g@x.test");
  raw.prepare("INSERT INTO teacher_profiles (id, schoolId, name, email) VALUES (?, ?, ?, ?)").run("t4", "sch-a", "Cached Dee", "d@x.test");
  r = await TS.fetchScheduledTeachersLocal(db, { schoolId: "sch-a", date: MON, periodId: "p1" });
  check("an id the accounts table never saw is named from the cached roster", ids(r), ["t1", "ghost"]);
  check("  an account the table knows to be switched off is not resurrected by the cache", ids(r).includes("t4"), false);
  raw.prepare("DELETE FROM teacher_profiles WHERE id = 'ghost'").run();

  console.log("\n--- the register, offline ---");
  r = await AttendanceService.getTeacherRegister({ schoolId: "sch-a", date: MON, periodId: "p1" });
  check("offline: the phone's timetable answers, with the same one teacher",
    [r.source, r.available, r.roster.map((x) => x.teacher._id), r.roster[0].attendance], ["local", true, ["t1"], null]);
  raw.prepare(`INSERT INTO teacher_attendance (id, schoolId, teacherId, date, status, _synced) VALUES ('ta1', 'sch-a', 't1', ?, 'late', 1)`).run(MON);
  r = await AttendanceService.getTeacherRegister({ schoolId: "sch-a", date: MON, periodId: "p1" });
  check("  a mark already on the phone shows against the teacher", r.roster[0].attendance?.status, "late");
  r = await AttendanceService.getTeacherRegister({ schoolId: "sch-a", date: MON, periodId: "p3" });
  check("  a period with nobody: an empty, available register", [r.available, r.roster], [true, []]);
  r = await AttendanceService.getTeacherRegister({ schoolId: "sch-c", date: MON, periodId: "p1" });
  check("  a school whose timetable is not on the phone: not available, not empty", [r.available, r.roster], [false, []]);
  check("  and no request went out while offline",
    apiLog.filter((c) => c.url === "/attendance/teachers/roster").every((c) => c.params.date === MON), true);

  console.log("\n--- the register, online ---");
  apiLog.length = 0;
  netState.connected = true;
  r = await AttendanceService.getTeacherRegister({ schoolId: "sch-a", date: MON, periodId: "p1" });
  const rosterCall  = apiLog.find((c) => c.url === "/attendance/teachers/roster");
  const recordsCall = apiLog.find((c) => c.url === "/attendance/teachers");
  check("the roster request carries the school, the date and the period", rosterCall?.params, { schoolId: "sch-a", date: MON, periodId: "p1" });
  check("the marks request carries the school and the date", recordsCall?.params, { schoolId: "sch-a", date: MON });
  check("the server's list is the register, merged with the server's marks",
    [r.source, r.available, r.roster.map((x) => `${x.teacher._id}:${x.teacher.name}:${x.attendance?.status}`), r.dayOfWeek, r.period?.name],
    ["server", true, ["t1:Server Ama:present"], "MON", "Period 1"]);
  check("  the classes travel with the teacher", r.roster[0].teacher.slots.map((s) => s.className), ["Form 3A"]);

  console.log("\n--- the periods to pick from ---");
  const local = await AttendanceService.getPeriods("sch-a");
  check("the synced periods, in order, without the break or the one switched off", local.map((p) => p.id), ["p1", "p2"]);
  const remote = await AttendanceService.getPeriods("sch-none");
  check("a school with none on the phone asks the server, online, and drops its break", remote.map((p) => p.id), ["sp1", "sp2"]);
  netState.connected = false;
  check("and offline, with none on the phone, there is nothing to pick", await AttendanceService.getPeriods("sch-none"), []);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
