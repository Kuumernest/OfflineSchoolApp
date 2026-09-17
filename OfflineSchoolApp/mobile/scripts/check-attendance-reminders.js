// mobile/scripts/check-attendance-reminders.js
"use strict";

/**
 * Tap the attendance reminder → the right class, its pupils, its date.
 *
 * The dashboard's "attendance not marked" card sent the teacher to the
 * register screen with no class in the route, so the screen — which takes its
 * class from the route and nothing else — opened empty. This runs the phone's
 * real code for the three decisions on that path, over a real SQLite:
 *
 *   utils/attendanceReminders   the day's classes → one reminder per unmarked
 *                               class → the route it pushes → the class the
 *                               register screen may open for that route
 *   services/teacherStats       the reminders a dashboard receives, offline,
 *                               from the timetable the phone has
 *   services/attendance         the register for a class and a DATE, online
 *                               (the date reaches the server) and offline (the
 *                               roster comes from the phone's students, and a
 *                               roster the phone does not hold is said so)
 *
 * What is not here: the OS. These reminders are cards on the dashboard, not
 * push notifications; the app has no notification handler, so "app closed /
 * backgrounded" reduces to expo-router carrying the route's parameters, which
 * the register screen reads at mount through resolveRegisterTarget — tested
 * below as a pure function of those parameters.
 *
 *   node scripts/check-attendance-reminders.js
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

// Relative imports are resolved and either answered from `stubs` (by absolute
// path) or transformed and loaded the same way; packages are answered from
// `pkgStubs` or fall through to Node.
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
      if (id.startsWith(".")) return load(path.resolve(dir, id).replace(/\.js$/, ""));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

(async () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  const DAY   = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][new Date().getDay()];

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. The pure decisions
  // ═══════════════════════════════════════════════════════════════════════════
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);
  const netState = { connected: false };
  const apiLog   = [];
  const fakeApi  = {
    get: async (url, opts = {}) => {
      apiLog.push({ url, params: opts.params ?? null });
      if (!netState.connected) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; }
      if (url === "/attendance/students/today") {
        return { data: {
          success: true, date: opts.params.date, periodId: opts.params.periodId ?? null,
          records: [{ studentId: "st-1", classId: opts.params.classId, date: opts.params.date, status: "late" }],
          roster:  [{ student: { _id: "st-1", studentName: "Server Pupil" }, attendance: { status: "late" } }],
          summary: { total: 1, marked: 1, present: 0, absent: 0, late: 1, excused: 0 },
        } };
      }
      const e = new Error(`unexpected ${url}`); e.response = { status: 404 }; throw e;
    },
    post: async () => { const e = new Error("Network Error"); throw e; },
  };
  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),      { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"),     { DB: {
      query:      async (sql, params = []) => raw.prepare(sql).all(...(params ?? [])),
      queryFirst: async (sql, params = []) => raw.prepare(sql).get(...(params ?? [])) ?? null,
    } }],
    [path.join(MOBILE, "src/services/api"),     { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/mutationQueue.service"), { MutationQueue: { enqueue: async () => ({}) } }],
    [path.join(MOBILE, "src/utils/authHelpers"), {
      isAuthenticated: () => true,
      getCurrentAuth:  () => ({ user: { _id: "teacher-a", role: "teacher", schoolId: "sch-a" }, token: "t" }),
    }],
  ]);
  const pkgStubs = new Map([
    ["@react-native-community/netinfo", {
      __esModule: true,
      default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: netState.connected }) },
    }],
  ]);
  const load = makeLoader(stubs, pkgStubs);

  const R = load("src/utils/attendanceReminders.js");

  console.log("\n--- one reminder per class without a register ---");
  const todayClasses = [
    { slotId: "s1", classId: "c3a", className: "Form 3A", subjectName: "Mathematics", periodId: "p1", startTime: "8:00 AM",  endTime: "9:00 AM",  status: "past" },
    { slotId: "s2", classId: "c3a", className: "Form 3A", subjectName: "Mathematics", periodId: "p2", startTime: "10:00 AM", endTime: "11:00 AM", status: "upcoming" },
    { slotId: "s3", classId: "c4b", className: "Form 4B", subjectName: "Physics",     periodId: "p2", startTime: "10:00 AM", endTime: "11:00 AM", status: "current" },
    { slotId: "s4", classId: "c5c", className: "Form 5C", subjectName: "Biology",     periodId: "p3", startTime: "2:00 PM",  endTime: "3:00 PM",  status: "upcoming", attendanceMarked: true },
    { slotId: "s5", classId: "c6d", className: "Form 6D", subjectName: "Chemistry",   periodId: "p4", startTime: "3:00 PM",  endTime: "4:00 PM",  status: "upcoming" },
    { slotId: "s6", classId: null,  className: "Ghost",   subjectName: "Nothing",     startTime: "4:00 PM", endTime: "5:00 PM", status: "upcoming" },
  ];
  let reminders = R.buildAttendanceReminders({ todayClasses, markedClassIds: ["c6d"], date: TODAY });
  check("two slots of 3A are one reminder; a class marked on the server and one marked on the phone are none; a slot with no class is none",
    reminders.map((r) => r.classId), ["c3a", "c4b"]);
  check("  3A's reminder keeps the overdue slot, its period and time", [reminders[0].status, reminders[0].periodId, reminders[0].endTime, reminders[0].date], ["past", "p1", "9:00 AM", TODAY]);
  check("  the current class follows the overdue one", reminders[1].status, "current");
  check("no date given → today", R.buildAttendanceReminders({ todayClasses: [todayClasses[2]] })[0].date, TODAY);
  check("a specific date is kept, never moved", R.buildAttendanceReminders({ todayClasses: [todayClasses[2]], date: "2026-09-01" })[0].date, "2026-09-01");
  check("nothing today → no reminders", R.buildAttendanceReminders({ todayClasses: [] }), []);

  console.log("\n--- the route a reminder pushes ---");
  const route = R.reminderRoute(reminders[0]);
  check("the register screen, told the class, the date, the period and the names (strings only)", route, {
    pathname: "/teacher/attendance/mark",
    params: { classId: "c3a", date: TODAY, source: "reminder", className: "Form 3A", periodId: "p1", subjectName: "Mathematics" },
  });
  check("two reminders → two routes to two classes", [R.reminderRoute(reminders[0]).params.classId, R.reminderRoute(reminders[1]).params.classId], ["c3a", "c4b"]);
  check("the wording follows how late the class is", [R.reminderMessageKey("past"), R.reminderMessageKey("current"), R.reminderMessageKey("upcoming")],
    ["teacherHome.attendanceReminderPast", "teacherHome.attendanceReminderCurrent", "teacherHome.attendanceReminderUpcoming"]);

  console.log("\n--- what the register screen may open, from the route and the teacher's scope ---");
  const scope = { classes: [{ id: "c3a", name: "Form 3A (scope)" }, { id: "c4b", name: "Form 4B" }], subjectsByClassId: {} };
  let target = R.resolveRegisterTarget({ params: route.params, scope, role: "teacher", today: TODAY });
  check("a reminder for an assigned class → that class, its name from the scope, its date", [target.authorized, target.classId, target.className, target.date, target.periodId], [true, "c3a", "Form 3A (scope)", TODAY, "p1"]);
  target = R.resolveRegisterTarget({ params: { classId: "c9z", className: "Form 9Z", date: TODAY }, scope, role: "teacher", today: TODAY });
  check("a class the scope does not list (stale reminder, typed route) → refused, not_assigned", [target.authorized, target.reason, target.classId], [false, "not_assigned", "c9z"]);
  target = R.resolveRegisterTarget({ params: { classId: "c3a" }, scope: { classes: [] }, role: "teacher", today: TODAY });
  check("a teacher whose scope is empty (assignment removed) → refused", target.authorized, false);
  target = R.resolveRegisterTarget({ params: { classId: "c9z", className: "Form 9Z" }, scope: { classes: [] }, role: "school_admin", today: TODAY });
  check("an administrator is not confined to assignments → the named class", [target.authorized, target.className], [true, "Form 9Z"]);
  target = R.resolveRegisterTarget({ params: { classId: "c9z" }, scope: { classes: [] }, role: "super_admin", today: TODAY });
  check("  a super admin too", target.authorized, true);
  target = R.resolveRegisterTarget({ params: {}, scope, role: "teacher", today: TODAY });
  check("no class in the route (the old dashboard card) → refused, no_class — never a register with no class", [target.authorized, target.reason], [false, "no_class"]);
  target = R.resolveRegisterTarget({ params: { classId: "c3a", date: "2026-09-01" }, scope, role: "teacher", today: TODAY });
  check("a reminder's own date is kept", target.date, "2026-09-01");
  target = R.resolveRegisterTarget({ params: { classId: "c3a", date: "yesterday-ish" }, scope, role: "teacher", today: TODAY });
  check("  a value that is not a date → today", target.date, TODAY);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. The reminders a dashboard receives, offline, from the phone's timetable
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- offline: the dashboard's reminders from the phone's own timetable ---");
  raw.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, school_id TEXT, name TEXT, role TEXT)`);
  raw.exec(`INSERT INTO users VALUES ('teacher-a', 'sch-a', 'Teacher A', 'teacher')`);
  raw.exec(`CREATE TABLE teacher_assignments (id TEXT PRIMARY KEY, school_id TEXT, teacher_id TEXT, class_id TEXT, subject_id TEXT, deleted_at TEXT)`);
  raw.exec(`INSERT INTO teacher_assignments VALUES ('ta1','sch-a','teacher-a','c3a','sub-m',NULL), ('ta2','sch-a','teacher-a','c4b','sub-p',NULL)`);
  raw.exec(`CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT, level TEXT, section TEXT, schoolId TEXT, school_id TEXT, is_active INTEGER DEFAULT 1, deleted_at TEXT, _synced INTEGER DEFAULT 1)`);
  raw.exec(`INSERT INTO classes (id, name, school_id) VALUES ('c3a','Form 3A','sch-a'), ('c4b','Form 4B','sch-a')`);
  raw.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY, school_id TEXT, class_id TEXT, name TEXT, code TEXT, deleted_at TEXT, _synced INTEGER DEFAULT 1)`);
  raw.exec(`INSERT INTO subjects (id, school_id, class_id, name) VALUES ('sub-m','sch-a','c3a','Mathematics'), ('sub-p','sch-a','c4b','Physics')`);
  raw.exec(`CREATE TABLE periods (id TEXT PRIMARY KEY, schoolId TEXT, name TEXT NOT NULL, starttime TEXT NOT NULL, endtime TEXT NOT NULL,
    sortorder INTEGER DEFAULT 0, isbreak INTEGER DEFAULT 0, isactive INTEGER DEFAULT 1, version INTEGER DEFAULT 1, deleted_at TEXT)`);
  raw.exec(`INSERT INTO periods (id, schoolId, name, starttime, endtime, sortorder) VALUES ('p1','sch-a','Period 1','08:00','09:00',1), ('p2','sch-a','Period 2','10:00','11:00',2)`);
  // The timetable table as timetableService creates it, with the server's day code.
  raw.exec(`CREATE TABLE timetable (_id TEXT PRIMARY KEY, school_id TEXT, class_id TEXT, subject_id TEXT, teacher_id TEXT,
    day_of_week TEXT, period_id TEXT, room TEXT, version INTEGER DEFAULT 1, deleted_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT, created_at TEXT, updated_at TEXT)`);
  raw.exec(`INSERT INTO timetable (_id, school_id, class_id, subject_id, teacher_id, day_of_week, period_id) VALUES
    ('t1','sch-a','c3a','sub-m','teacher-a','${DAY}','p1'),
    ('t2','sch-a','c3a','sub-m','teacher-a','${DAY}','p2'),
    ('t3','sch-a','c4b','sub-p','teacher-a','${DAY}','p2'),
    ('t4','sch-a','c4b','sub-p','teacher-a','${DAY === "MON" ? "TUE" : "MON"}','p1')`);
  raw.exec(`CREATE TABLE students (id TEXT PRIMARY KEY, schoolId TEXT, school_id TEXT, classId TEXT, class_id TEXT, studentName TEXT, name TEXT,
    firstName TEXT, lastName TEXT, email TEXT, admissionNo TEXT, admissionNumber TEXT, enrollmentNo TEXT, is_active INTEGER DEFAULT 1, status TEXT DEFAULT 'approved', deleted_at TEXT)`);
  raw.exec(`INSERT INTO students (id, school_id, class_id, studentName, admissionNo) VALUES
    ('st-1','sch-a','c3a','Amara Ndi','A-001'), ('st-2','sch-a','c3a','Bello Tchoupo','A-002'), ('st-3','sch-a','c4b','Chi Fon','A-003')`);

  const Att = load("src/services/attendance.service.js").AttendanceService;
  // Form 3A's register for today exists on the phone (synced from the server).
  await Att.markClassAttendanceBulk({ schoolId: "sch-a", classId: "c3a", date: TODAY, records: [{ studentId: "st-1", status: "present" }] });

  const { getTeacherStats } = load("src/services/teacherStats.service.js");
  const stats = await getTeacherStats("teacher-a");
  check("offline, today's classes come from the phone's timetable with their ids", (stats.todayClasses ?? []).map((c) => [c.classId, c.periodId, c.startTime]),
    [["c3a", "p1", "8:00 AM"], ["c3a", "p2", "10:00 AM"], ["c4b", "p2", "10:00 AM"]]);
  check("one reminder: Form 4B — 3A already has a register, and its two slots were one class", (stats.todayAttendanceReminders ?? []).map((r) => [r.classId, r.className, r.subjectName, r.date]),
    [["c4b", "Form 4B", "Physics", TODAY]]);
  check("  and the count agrees with the list", stats.todayAttendanceMissing, 1);
  check("  the reminder's route opens Form 4B's register for today", stats.todayAttendanceReminders[0] ? R.reminderRoute(stats.todayAttendanceReminders[0]).params.classId : null, "c4b");

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. The register for a class and a date
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- offline: the roster comes from the phone's students ---");
  let reg = await Att.getStudentAttendanceForDate("c4b", "sch-a", TODAY, null);
  check("Form 4B's register offline: its one pupil, unmarked, from the phone", [reg.source, reg.rosterKnown, reg.roster.map((r) => r.student._id), reg.roster[0]?.attendance], ["local", true, ["st-3"], null]);
  reg = await Att.getStudentAttendanceForDate("c3a", "sch-a", TODAY, null);
  check("Form 3A's register offline: both pupils, one already marked present", [reg.roster.map((r) => [r.student._id, r.attendance?.status ?? null]), reg.summary.total, reg.summary.marked],
    [[["st-1", "present"], ["st-2", null]], 2, 1]);
  reg = await Att.getStudentAttendanceForDate("c3a", "sch-a", "2026-09-01", null);
  check("another date offline: the same pupils, none marked on that day", [reg.date, reg.roster.length, reg.summary.marked], ["2026-09-01", 2, 0]);
  reg = await Att.getStudentAttendanceForDate("c-empty", "sch-a", TODAY, null);
  check("a class with no pupils while the school's pupils ARE on the phone → an empty roster, rosterKnown", [reg.roster.length, reg.rosterKnown], [0, true]);
  reg = await Att.getStudentAttendanceForDate("c1b", "sch-b", TODAY, null);
  check("a school whose pupils are not on the phone → empty AND rosterKnown false: 'not downloaded', not 'no pupils'", [reg.roster.length, reg.rosterKnown], [0, false]);
  // The service tries the network first (its flag comes from a NetInfo listener
  // the stub never fires) and every attempt above failed; each answer came
  // from the phone, which is the fallback this section is about.
  check("every network failure above fell back to the phone", apiLog.filter((c) => c.url === "/attendance/students/today").length > 0, true);

  console.log("\n--- offline: marking from the reminder queues the register ---");
  const saved = await Att.markClassAttendanceBulk({ schoolId: "sch-a", classId: "c4b", periodId: "p2", date: TODAY, records: [{ studentId: "st-3", status: "absent" }] });
  check("the mark is saved locally and queued", [saved.count, saved.source], [1, "local"]);
  const unsynced = raw.prepare(`SELECT status, _synced FROM attendance WHERE class_id = 'c4b' AND date = ?`).all(TODAY);
  check("  the row waits for the sync (_synced = 0)", unsynced, [{ status: "absent", _synced: 0 }]);
  const after = await getTeacherStats("teacher-a");
  check("  and the dashboard no longer reminds about Form 4B", [after.todayAttendanceMissing, after.todayAttendanceReminders], [0, []]);

  console.log("\n--- online: the date travels to the server ---");
  netState.connected = true;
  // attendance.service reads its connectivity from NetInfo's listener; with the
  // stub it stays at its initial true, so the flag above only gates the fake.
  reg = await Att.getStudentAttendanceForDate("c3a", "sch-a", "2026-09-01", "p1");
  const lastCall = apiLog.filter((c) => c.url === "/attendance/students/today").pop();
  check("the server is asked for that class, that date, that period", lastCall?.params, { classId: "c3a", schoolId: "sch-a", date: "2026-09-01", periodId: "p1" });
  check("  and its register is what the screen receives, marked as the server's", [reg.source, reg.rosterKnown, reg.date, reg.roster[0]?.student?.studentName], ["api", true, "2026-09-01", "Server Pupil"]);
  reg = await Att.getStudentAttendanceForDate("c3a", "sch-a", "garbage", null);
  check("a date that is not one → today is asked for", apiLog.filter((c) => c.url === "/attendance/students/today").pop()?.params?.date, TODAY);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
