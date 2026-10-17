// mobile/scripts/check-sync-deletions.js
"use strict";

/**
 * The phone applies removals from GET /sync/pull.
 *
 * The server now sends, on an incremental pull, a deleted record as a row
 * with deletedAt — either the record itself (soft deletes) or
 * { _id, schoolId, deletedAt } (hard deletes, roster departures). This runs
 * the REAL apply functions (syncManager syncClasses … syncPeriods) and the
 * real table setup (db/database.js) over a real SQLite (node:sqlite), and
 * checks that:
 *   - each removal marks the local copy deleted, and creates nothing for a
 *     record the phone never had;
 *   - applying it twice changes nothing;
 *   - the list queries a screen reads leave it out (the class picker, the
 *     timetable's periods, the class's student count);
 *   - a record that comes back (restored, reactivated) is live again.
 *
 * syncPeriods had no deletedAt branch at all: a deleted period stayed in
 * every timetable.
 *
 *   node scripts/check-sync-deletions.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

/** expo-sqlite's async surface, over a real synchronous SQLite. */
const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
  closeAsync:    async () => {},
});

const makeLoader = (pkgStubs, relStubs) => {
  const cache = new Map();
  const load = (abs) => {
    const key = abs.replace(/\.js$/, "");
    for (const [rel, stub] of relStubs) if (key.endsWith(rel)) return stub;
    if (cache.has(key)) return cache.get(key).exports;
    const file = fs.existsSync(`${key}.js`) ? `${key}.js` : `${key}/index.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(key, mod);
    const dir = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.resolve(dir, id));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel));
};

(async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);
  const noop = () => {};
  const pkg = new Map([
    ["expo-sqlite", { openDatabaseAsync: async () => db, openDatabaseSync: () => db }],
    ["expo-secure-store", { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }],
    ["@react-native-community/netinfo", { addEventListener: () => noop, fetch: async () => ({ isConnected: true }) }],
    ["react-native", { AppState: { addEventListener: () => ({ remove: noop }), currentState: "active" }, Platform: { OS: "android" } }],
  ]);
  const rel = new Map([
    ["src/services/api", { default: { get: async () => ({ data: {} }) }, setRetryContext: noop, clearRetryContext: noop }],
    ["src/services/mutationQueue.service", { MutationQueue: { registerReconciler: noop } }],
    ["src/db/quizSchema", { ensureQuizTables: async () => {} }],
  ]);
  const load = makeLoader(pkg, rel);
  const { getDatabase } = load("src/db/database");
  await getDatabase();                         // the app's own table setup
  const { SyncManager } = load("src/services/syncManager");
  // The migrations the app runs before its first sync (syncManager, the
  // sequence at the top of a sync cycle) for the tables these collections use.
  for (const step of ["migrateLocalDatabase", "migrateUsersTable", "migrateClassesTable",
                      "migrateSubjectsTable", "migrateAssignmentsTable"]) {
    await SyncManager[step]();
  }
  const q = (sql, p = []) => raw.prepare(sql).all(...p);

  const S = "school-a";
  // ── what a first pull delivers ───────────────────────────────────────────
  await SyncManager.syncClasses([
    { _id: "c1", schoolId: S, name: "Form 1", isActive: true },
    { _id: "c2", schoolId: S, name: "Form 2", isActive: true },
  ]);
  await SyncManager.syncSubjects([
    { _id: "s1", schoolId: S, name: "Music", classId: "c1" },
    { _id: "s2", schoolId: S, name: "Maths", classId: "c1" },
  ]);
  await SyncManager.syncStudents([
    { _id: "st1", schoolId: S, name: "Ada", classId: "c1", status: "approved", isActive: true },
    { _id: "st2", schoolId: S, name: "Ben", classId: "c1", status: "approved", isActive: true },
  ]);
  await SyncManager.syncAssignments([
    { _id: "as1", schoolId: S, teacher: "t1", class: "c1", subject: "s2" },
  ]);
  await SyncManager.syncPeriods([
    { _id: "p1", schoolId: S, name: "P1", startTime: "08:00", endTime: "09:00" },
    { _id: "p2", schoolId: S, name: "P2", startTime: "09:00", endTime: "10:00" },
  ]);
  const live = (table, col = "deleted_at") =>
    q(`SELECT id FROM ${table} WHERE (${col} IS NULL OR ${col} = '') ORDER BY id`).map((r) => r.id);
  check("a first pull: everything is live",
    [live("classes"), live("subjects"), live("students"), live("teacher_assignments"), live("periods", "deletedat")],
    [["c1", "c2"], ["s1", "s2"], ["st1", "st2"], ["as1"], ["p1", "p2"]]);

  // ── the removals an incremental pull sends ───────────────────────────────
  const at = "2026-10-17T12:00:00.000Z";
  const removal = (id) => ({ _id: id, id, schoolId: S, deletedAt: at });
  const applyRemovals = async () => {
    await SyncManager.syncClasses([{ _id: "c2", schoolId: S, name: "Form 2", isActive: false, deletedAt: at }]); // soft: the row itself
    await SyncManager.syncSubjects([removal("s1"), removal("ghost-subject")]);   // hard: a tombstone; and one never held
    await SyncManager.syncStudents([removal("st2")]);
    await SyncManager.syncAssignments([removal("as1")]);
    await SyncManager.syncPeriods([{ _id: "p2", schoolId: S, name: "P2", startTime: "09:00", endTime: "10:00", isActive: true, deletedAt: at }]);
  };
  await applyRemovals();
  check("each removal marks the local copy deleted",
    [live("classes"), live("subjects"), live("students"), live("teacher_assignments"), live("periods", "deletedat")],
    [["c1"], ["s2"], ["st1"], [], ["p1"]]);
  check("  the rows are kept (marked, not removed), and a removal for a record never held creates nothing",
    [q("SELECT COUNT(*) AS n FROM subjects")[0].n, q("SELECT id FROM subjects WHERE id = 'ghost-subject'").length], [2, 0]);
  check("  a deleted period is inactive too (the timetable readers' other filter)",
    q("SELECT isactive FROM periods WHERE id = 'p2'")[0].isactive, 0);

  const snapshot = () => JSON.stringify(["classes", "subjects", "students", "teacher_assignments", "periods"]
    .map((t) => q(`SELECT * FROM ${t} ORDER BY id`).map((r) => ({ ...r, updated_at: null, _synced_at: null }))));
  const before = snapshot();
  await applyRemovals();
  check("applying the same removals again changes nothing", snapshot() === before, true);

  // ── what the screens read ────────────────────────────────────────────────
  check("the class picker (admin/subjects/add, admin/students/detail) leaves the deleted class out",
    q("SELECT id FROM classes WHERE schoolId = ? AND (deleted_at IS NULL OR deleted_at = '') ORDER BY name ASC", [S]).map((r) => r.id),
    ["c1"]);
  check("  the class's student count leaves the deleted pupil out",
    q("SELECT COUNT(*) AS n FROM students st WHERE st.class_id = 'c1' AND (st.deleted_at IS NULL OR st.deleted_at = '')")[0].n, 1);
  check("  the timetable's period rows leave the deleted period out",
    q("SELECT id FROM periods WHERE (deletedat IS NULL OR deletedat = '') ORDER BY id").map((r) => r.id), ["p1"]);

  // ── a record that comes back ─────────────────────────────────────────────
  await SyncManager.syncClasses([{ _id: "c2", schoolId: S, name: "Form 2", isActive: true, deletedAt: null }]);
  await SyncManager.syncStudents([{ _id: "st2", schoolId: S, name: "Ben", classId: "c1", status: "approved", isActive: true }]);
  await SyncManager.syncPeriods([{ _id: "p2", schoolId: S, name: "P2", startTime: "09:00", endTime: "10:00", isActive: true }]);
  check("a record restored on the server (class, pupil back on the roster, period) is live again",
    [live("classes"), live("students"), live("periods", "deletedat")], [["c1", "c2"], ["st1", "st2"], ["p1", "p2"]]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
