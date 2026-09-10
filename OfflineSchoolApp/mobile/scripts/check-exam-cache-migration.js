// mobile/scripts/check-exam-cache-migration.js
"use strict";

/**
 * A column added to a table definition after devices already had the table.
 *
 * From a real device log, three times in one sync:
 *
 *   WARN [examCache] cacheExams 5e795490-…: Call to function
 *   'NativeDatabase.prepareAsync' has been rejected.
 *   → Caused by: Error code : table exams has no column named extra_json
 *
 * `extra_json` is in the CREATE TABLE in examCache.service, and CREATE TABLE
 * IF NOT EXISTS does exactly what it says: on a phone whose exams table
 * predates that column, the statement is a no-op and the column never
 * appears. Every cache write then failed, behind a `.catch(() => {})`, so
 * nothing surfaced but a warning nobody was reading.
 *
 * The exams still arrive over the network — what breaks is the offline copy,
 * which is the whole purpose of that file. An admin on a phone with no signal
 * saw no exams and no reason why.
 *
 * ── Why this runs against real SQLite ─────────────────────────────────────
 *
 * A hand-written fake would have to implement PRAGMA table_info and ALTER
 * TABLE, and a fake that implements the thing under test proves nothing. Node
 * 22+ ships node:sqlite, so the migration is asserted against an engine that
 * enforces the constraint that broke the device: writing a column that does
 * not exist is an error, exactly as it was on the phone.
 *
 *   node scripts/check-exam-cache-migration.js
 */

const path  = require("path");
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
const note = (label) => console.log(`       ${label}`);

/** expo-sqlite's async surface, over a real synchronous SQLite. */
const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
});

const loadModule = (rel, stubs) => {
  const abs = path.join(MOBILE, rel);
  const { code } = babel.transformFileSync(abs, {
    presets: [require.resolve("babel-preset-expo")],
    caller:  { name: "check", supportsStaticESM: false },
    babelrc: false, configFile: false,
  });
  const dir = path.dirname(abs);
  const mod = { exports: {} };
  const req = (id) => {
    if (id in stubs) return stubs[id];
    return require(id.startsWith(".") ? path.resolve(dir, id) : id);
  };
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

(async () => {
  console.log("--- a device whose exams table predates extra_json ---");

  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  // The old table, as it exists on that phone: everything the current
  // definition has EXCEPT the columns added since.
  raw.exec(`CREATE TABLE exams (
    id            TEXT PRIMARY KEY,
    schoolId      TEXT,
    classId       TEXT,
    className     TEXT,
    name          TEXT,
    type          TEXT,
    academicYear  TEXT,
    term          TEXT,
    startDate     TEXT,
    endDate       TEXT,
    status        TEXT DEFAULT 'draft',
    description   TEXT,
    totalMarks    REAL DEFAULT 100,
    passMark      REAL DEFAULT 50,
    deleted_at    TEXT,
    created_at    TEXT,
    updated_at    TEXT
  )`);

  const columns = () => raw.prepare("PRAGMA table_info(exams)").all().map((r) => r.name);

  const before = columns();
  note(`before: ${before.length} columns, extra_json present: ${before.includes("extra_json")}`);
  if (!before.includes("extra_json")) ok("the old table genuinely lacks the column");
  else bad("the fixture reproduces the device", "extra_json was already there");

  // The write that failed on the phone, against the old table, to prove the
  // engine really does reject it — otherwise the rest of this proves nothing.
  try {
    raw.prepare("INSERT INTO exams (id, extra_json) VALUES (?, ?)").run("x", "{}");
    bad("the old table rejects a write to extra_json",
      "It accepted one, so this fixture is not reproducing the device.");
  } catch (err) {
    if (/no column named extra_json/.test(err.message)) {
      ok("and rejects the write exactly as the device did");
      note(`  "${err.message.split("\n")[0]}"`);
    } else {
      bad("the failure matches the device's", err.message);
    }
  }

  // ── Now run the real schema function over it ────────────────────────────
  const ExamCache = loadModule("src/services/examCache.service.js", {
    "../db/database":      { getDatabase: async () => db },
    "../db/schemaManager": { ensureTableSchema: async (_key, fn, database) => fn(database) },
  });

  // ensureExamTables is the module's own schema entry point and is exported,
  // so this drives the same code path a screen does on first touch.
  if (typeof ExamCache.ensureExamTables !== "function") {
    bad("examCache exposes its schema opener",
      `exports: ${Object.keys(ExamCache).join(", ")}`);
  } else {
    await ExamCache.ensureExamTables(db);

    const after = columns();
    note(`after: ${after.length} columns`);

    const added = after.filter((c) => !before.includes(c));
    note(`added: ${JSON.stringify(added)}`);

    if (after.includes("extra_json")) ok("the migration adds extra_json");
    else bad("extra_json is added to an existing table", `columns: ${after.join(", ")}`);

    for (const col of ["instructions", "resultsPublished", "createdBy", "_synced", "_synced_at"]) {
      if (after.includes(col)) ok(`and ${col}`);
      else bad(`${col} is added`, `columns: ${after.join(", ")}`);
    }

    // The write that failed now works. This is the assertion that matters —
    // the column existing is not the same as the cache being able to write.
    try {
      raw.prepare("INSERT INTO exams (id, extra_json) VALUES (?, ?)").run("ex-1", '{"a":1}');
      const row = raw.prepare("SELECT extra_json FROM exams WHERE id = ?").get("ex-1");
      if (row?.extra_json === '{"a":1}') ok("and the write the device could not make now succeeds");
      else bad("the value round-trips", JSON.stringify(row));
    } catch (err) {
      bad("the cache write succeeds after migrating", err.message);
    }

    // Idempotent: this runs on every database open.
    const countBefore = columns().length;
    await ExamCache.ensureExamTables(db);
    if (columns().length === countBefore) ok("running it again changes nothing");
    else bad("the migration is idempotent",
      `${countBefore} columns became ${columns().length}`);
  }

  // ── And an install with no table at all ────────────────────────────────
  //
  // The migration must not get in the way of the CREATE that already worked.
  console.log("\n--- and a fresh install ---");
  {
    const rawNew = new DatabaseSync(":memory:");
    const dbNew  = adapt(rawNew);
    const Fresh = loadModule("src/services/examCache.service.js", {
      "../db/database":      { getDatabase: async () => dbNew },
      "../db/schemaManager": { ensureTableSchema: async (_k, fn, d) => fn(d) },
    });
    await Fresh.ensureExamTables(dbNew);

    const cols = rawNew.prepare("PRAGMA table_info(exams)").all().map((r) => r.name);
    if (cols.includes("extra_json")) ok("a new table has the column from the CREATE");
    else bad("a fresh install gets extra_json", cols.join(", "));

    const tables = rawNew.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all().map((r) => r.name);
    note(`tables: ${tables.join(", ")}`);
    const expected = ["exam_blobs", "exam_results", "exam_scores", "exam_subjects", "exams"];
    if (expected.every((tbl) => tables.includes(tbl))) ok("and all five tables are created");
    else bad("every exam table is created", `missing: ${expected.filter((tbl) => !tables.includes(tbl))}`);
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
