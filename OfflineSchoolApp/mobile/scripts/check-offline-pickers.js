// mobile/scripts/check-offline-pickers.js
"use strict";
/**
 * The pickers in front of offline-capable work must work offline.
 *
 * The attendance register's class picker, the exam wizard's class / teacher /
 * subject pickers and the teacher's notes-upload subject picker used to ask
 * the server only — so offline they were empty or showed an error, and the
 * queue behind them (AttendanceService, ExamService.createExam, uploadContent)
 * could not be reached. This loads the real picker reads
 * (services/pickerData, services/content) over a real SQLite, with every
 * network request failing, and proves they answer from the phone.
 *
 *   node scripts/check-offline-pickers.js
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
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  // Every request fails the way axios fails with no network; NetInfo agrees
  // for the "offline" case and disagrees (captive portal, dead link) for the
  // "connected but nothing answers" case.
  const netState = { connected: false };
  const apiLog   = [];
  const refuse = (url) => { apiLog.push(url); const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = true; throw e; };
  const fakeApi = {
    get:    async (url) => refuse(url),
    post:   async (url) => refuse(url),
    put:    async (url) => refuse(url),
    patch:  async (url) => refuse(url),
    delete: async (url) => refuse(url),
  };
  const auth = { user: { _id: "admin-a", role: "school_admin", schoolId: "sch-a" }, token: "t" };

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"), { getDatabase: async () => db }],
    [path.join(MOBILE, "src/services/api"), { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/mutationQueue.service"), { MutationQueue: { enqueue: async () => ({}) } }],
    [path.join(MOBILE, "src/utils/authHelpers"), {
      isAuthenticated: () => true,
      getCurrentAuth:  () => ({ ...auth, role: auth.user.role, schoolId: auth.user.schoolId }),
    }],
  ]);
  const pkgStubs = new Map([
    ["@react-native-community/netinfo", {
      __esModule: true,
      default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: netState.connected }) },
    }],
  ]);
  const load = makeLoader(stubs, pkgStubs);
  const P = load("src/services/pickerData.service.js");
  const C = load("src/services/content.service.js");
  const TS = load("src/services/teacherScope.service.js");

  // What the sync leaves on an admin's phone.
  raw.exec(`
    CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT, level TEXT, section TEXT, schoolId TEXT, school_id TEXT,
      is_active INTEGER DEFAULT 1, deleted_at TEXT, created_at TEXT, updated_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, schoolId TEXT, school_id TEXT, name TEXT, email TEXT, role TEXT,
      is_active INTEGER DEFAULT 1, deleted_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE subjects (id TEXT PRIMARY KEY, schoolId TEXT, school_id TEXT, classId TEXT, class_id TEXT, name TEXT,
      code TEXT, teacher_id TEXT, teacher_name TEXT, coefficient REAL DEFAULT NULL, is_active INTEGER DEFAULT 1,
      deleted_at TEXT, created_at TEXT, updated_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT);
  `);
  const cls = (id, school, name, active = 1, deleted = null) =>
    raw.prepare("INSERT INTO classes (id, name, schoolId, school_id, is_active, deleted_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, school, school, active, deleted);
  cls("c2", "sch-a", "Form 2"); cls("c1", "sch-a", "Form 1"); cls("c9", "sch-a", "Old Form", 0);
  cls("cx", "sch-a", "Gone", 1, "2026-01-01T00:00:00Z"); cls("cb", "sch-b", "Other School");
  const user = (id, school, name, role = "teacher", active = 1) =>
    raw.prepare("INSERT INTO users (id, schoolId, school_id, name, email, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, school, school, name, `${id}@x.test`, role, active);
  user("t2", "sch-a", "Bea"); user("t1", "sch-a", "Ama"); user("t3", "sch-a", "Off", "teacher", 0);
  user("admin-a", "sch-a", "Head", "school_admin"); user("st1", "sch-a", "Pupil", "student"); user("tb", "sch-b", "Bob");
  const sub = (id, school, classId, name, coeff = null, deleted = null) =>
    raw.prepare("INSERT INTO subjects (id, school_id, class_id, name, coefficient, deleted_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, school, classId, name, coeff, deleted);
  sub("s2", "sch-a", "c1", "Physics", 3); sub("s1", "sch-a", "c1", "Maths", 2); sub("s3", "sch-a", "c2", "History");
  sub("s4", "sch-a", "c1", "Dropped", null, "2026-01-01T00:00:00Z"); sub("sb", "sch-b", "c1", "Foreign");

  for (const mode of [false, true]) {
    netState.connected = mode;
    console.log(`\n--- admin pickers, ${mode ? "connected but nothing answers" : "offline"} ---`);
    apiLog.length = 0;

    const classes = await P.getPickerClasses();
    check("classes: this school's active classes from the phone, by name",
      classes.map((c) => `${c._id}:${c.name}`), ["c1:Form 1", "c2:Form 2"]);

    const teachers = await P.getPickerTeachers();
    check("teachers: this school's active teachers from the phone (no admin, pupil or other school)",
      teachers.map((t) => `${t._id}:${t.name}`), ["t1:Ama", "t2:Bea"]);

    const subjects = await P.getPickerSubjects("c1");
    check("subjects of Form 1 from the phone, with their own coefficient",
      subjects.map((s) => `${s._id}:${s.name}:${s.coefficient}`), ["s1:Maths:2", "s2:Physics:3"]);
    check("subjects of Form 2", (await P.getPickerSubjects("c2")).map((s) => s.name), ["History"]);
    check("no class, no subjects (and no request)", await P.getPickerSubjects(null), []);
    if (mode) check("the server was asked first", apiLog.includes("/admin/teachers") && apiLog.includes("/admin/subjects"), true);
  }

  console.log("\n--- teacher notes upload: the subject picker ---");
  auth.user = { _id: "tch-1", role: "teacher", schoolId: "sch-a" };
  netState.connected = false;
  TS.clearTeacherScopeMemo();
  let r = await C.loadTeacherSubjectsForContent("tch-1");
  check("a phone that never loaded this teacher's subjects says so (not 'no subjects assigned')",
    [r.subjects, r.neverLoaded], [[], true]);

  // The mirror's own assignment rows (an admin who also teaches, or an older sync).
  raw.exec(`CREATE TABLE teacher_assignments (id TEXT PRIMARY KEY, teacherId TEXT, classId TEXT, subjectId TEXT,
    schoolId TEXT, deleted_at TEXT)`);
  raw.prepare("INSERT INTO teacher_assignments VALUES ('a1', 'tch-1', 'c1', 's1', 'sch-a', NULL)").run();
  raw.prepare("INSERT INTO teacher_assignments VALUES ('a2', 'tch-1', 'c2', 's3', 'sch-a', NULL)").run();
  raw.prepare("INSERT INTO teacher_assignments VALUES ('a3', 'tch-2', 'c1', 's2', 'sch-a', NULL)").run();
  TS.clearTeacherScopeMemo();
  r = await C.loadTeacherSubjectsForContent("tch-1");
  check("offline, the mirror's assignments answer: only this teacher's subjects, with their classes",
    [r.neverLoaded, r.subjects.map((s) => `${s.subjectId}:${s.subjectName}:${s.classes.map((c) => c.className).join("+")}`)],
    [false, ["s3:History:Form 2", "s1:Maths:Form 1"]]);

  // The cached /teacher/my-subjects answer wins over the mirror.
  raw.prepare(`INSERT OR REPLACE INTO teacher_scope (teacher_id, school_id, payload, fetched_at) VALUES (?, ?, ?, ?)`).run(
    "tch-1", "sch-a",
    JSON.stringify({
      classes: [{ id: "c1", name: "Form 1" }, { id: "c2", name: "Form 2" }],
      subjectsByClassId: { c1: [{ id: "s2", name: "Physics" }], c2: [{ id: "s2", name: "Physics" }] },
    }),
    "2026-10-01T00:00:00Z"
  );
  TS.clearTeacherScopeMemo();
  r = await C.loadTeacherSubjectsForContent("tch-1");
  check("the cached server answer: one subject taught in two classes",
    [r.source, r.subjects.map((s) => `${s.subjectId}:${s.classes.map((c) => c.classId).join("+")}`)],
    ["cache", ["s2:c1+c2"]]);
  check("  the list-only wrapper the content index uses answers the same",
    (await C.getTeacherSubjectsForContent("tch-1")).map((s) => s.subjectId), ["s2"]);

  raw.prepare(`UPDATE teacher_scope SET payload = ? WHERE teacher_id = 'tch-1'`)
    .run(JSON.stringify({ classes: [], subjectsByClassId: {} }));
  TS.clearTeacherScopeMemo();
  r = await C.loadTeacherSubjectsForContent("tch-1");
  check("a cached server answer that is empty is a real 'no subjects assigned'", [r.subjects, r.neverLoaded], [[], false]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
