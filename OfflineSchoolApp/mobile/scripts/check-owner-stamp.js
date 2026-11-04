// mobile/scripts/check-owner-stamp.js
"use strict";

/**
 * Per-user local data, the additive part (docs/40-per-user-local-data.md).
 *
 * Two things shipped, and the one property both must have: NOTHING ALREADY ON
 * THE PHONE CHANGES. Not a value, not an owner, not a queued request.
 *
 *   owner stamp      a new local change records the account that made it
 *                    (_owner_id). A row already on the phone keeps exactly
 *                    the bytes it had; a legacy ownerless dirty row stays
 *                    ownerless even when edited again; a downgrade finds no
 *                    trigger left behind.
 *   held changes     the pending screen counts queued work that belongs to
 *                    another account or to nobody, and counting touches
 *                    nothing.
 *
 * Runs the real modules over node:sqlite on a file, so closing and reopening
 * it is a real downgrade.
 *
 *   node scripts/check-owner-stamp.js
 */

const path  = require("path");
const fs    = require("fs");
const os    = require("os");
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

/** An expo-sqlite-shaped handle, withTransactionAsync included (BEGIN/COMMIT/ROLLBACK through execAsync, as expo does). */
const adapt = (db) => {
  const h = {
    execAsync:     async (sql) => { db.exec(sql); },
    runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
    getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  };
  h.withTransactionAsync = async (task) => {
    try {
      await h.execAsync("BEGIN");
      await task();
      await h.execAsync("COMMIT");
    } catch (e) {
      await h.execAsync("ROLLBACK");
      throw e;
    }
  };
  return h;
};

const makeLoader = (stubs) => {
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
    const req = (id) => (id.startsWith(".")
      ? load(path.resolve(dir, id).replace(/\.js$/, ""))
      : require(id));
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

/** Every row of a table, every column with its storage class — the "bytes" a reader can observe. */
const snapshot = (db, table, { without = [] } = {}) => {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
    .map((c) => c.name).filter((c) => !without.includes(c));
  const sel = cols.map((c) => `typeof("${c}") || ':' || quote("${c}")`).join(", ");
  return db.prepare(`SELECT ${sel} FROM "${table}" ORDER BY rowid`).all()
    .map((r) => Object.values(r).join(" | "));
};

(async () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "owner-stamp-"));
  const file = path.join(dir, "schoolapp.db");

  // ── An install from before this change ───────────────────────────────────
  let raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE students (id TEXT PRIMARY KEY NOT NULL, name TEXT, class_id TEXT,
      _synced INTEGER DEFAULT 0, _synced_at TEXT, updated_at TEXT);
    CREATE TABLE fee_payments (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, amount INTEGER NOT NULL,
      _synced INTEGER NOT NULL DEFAULT 0, _synced_at TEXT);
    CREATE TABLE timetable (_id TEXT PRIMARY KEY, class_id TEXT, _synced INTEGER DEFAULT 0);
    CREATE TABLE attendance (student_id TEXT, date TEXT, status TEXT, _synced INTEGER DEFAULT 0,
      PRIMARY KEY (student_id, date));
    CREATE TABLE exams (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE mutation_outbox (id TEXT PRIMARY KEY, entity_key TEXT, method TEXT, endpoint TEXT,
      payload TEXT, status TEXT, created_at TEXT, owner_id TEXT);

    -- clean mirror rows, and dirty rows nobody recorded an author for
    INSERT INTO students VALUES ('s-clean', 'Ada', 'c1', 1, '2026-01-01', '2026-01-01');
    INSERT INTO students VALUES ('s-dirty', 'Ben', 'c1', 0, NULL, '2026-02-01');
    INSERT INTO students VALUES ('s-null',  'Cy',  'c2', NULL, NULL, NULL);
    INSERT INTO students VALUES ('s-keep',  'Di',  'c2', 0, NULL, '2026-02-02');
    INSERT INTO fee_payments VALUES ('p-dirty', 's-clean', 5000, 0, NULL);
    INSERT INTO fee_payments VALUES ('p-clean', 's-clean', 2500, 1, '2026-01-03');
    INSERT INTO timetable VALUES ('t1', 'c1', 0);
    INSERT INTO attendance VALUES ('s-clean', '2026-03-01', 'present', 0);
    INSERT INTO exams VALUES ('e1', 'Mock');

    INSERT INTO mutation_outbox VALUES ('o1', 'attendance:x', 'POST', '/a', '{}', 'pending',  '2026-03-01', 'teacher-a');
    INSERT INTO mutation_outbox VALUES ('o2', 'homework:y',   'POST', '/h', '{}', 'failed',   '2026-03-02', 'teacher-b');
    INSERT INTO mutation_outbox VALUES ('o3', 'legacy:z',     'POST', '/l', '{}', 'pending',  '2026-03-03', NULL);
    INSERT INTO mutation_outbox VALUES ('o4', 'attendance:w', 'POST', '/a', '{}', 'synced',   '2026-03-04', NULL);
  `);
  const before = {
    students:     snapshot(raw, "students"),
    fee_payments: snapshot(raw, "fee_payments"),
    timetable:    snapshot(raw, "timetable"),
    attendance:   snapshot(raw, "attendance"),
    exams:        snapshot(raw, "exams"),
    outbox:       snapshot(raw, "mutation_outbox"),
  };

  // ── The new build opens it ───────────────────────────────────────────────
  let signedIn = "teacher-b";
  const stubs = new Map([
    [path.join(MOBILE, "src/utils/authHelpers"), {
      getCurrentAuth: () => ({ user: signedIn ? { _id: signedIn } : null }),
    }],
  ]);
  const load = makeLoader(stubs);
  const { instrument, onLocalWrite } = load("src/db/localWrites.js");
  const { tableOfWrite, STAMPED_TABLES } = load("src/db/ownerStamp.js");
  const { countHeldChanges } = load("src/db/heldChanges.js");

  check("tableOfWrite reads INSERT OR REPLACE / UPDATE / REPLACE",
    [tableOfWrite("INSERT OR REPLACE INTO students (id) VALUES (?)"),
     tableOfWrite("  update fee_payments SET _synced = 0"),
     tableOfWrite('REPLACE INTO "timetable" VALUES (1)'),
     tableOfWrite("SELECT * FROM students")],
    ["students", "fee_payments", "timetable", null]);
  check("every table the backfill reads dirty rows from is stamped",
    ["fee_payments", "expenses", "gate_events", "classes", "subjects", "users", "teacher_assignments",
     "periods", "timetable", "attendance", "teacher_attendance", "questions", "quizzes",
     "quiz_attempts", "announcements", "students", "exams"].filter((t) => !STAMPED_TABLES.includes(t)),
    []);

  let reported = 0;
  onLocalWrite(() => { reported++; });
  const db = instrument(adapt(raw));

  // Counting changes nothing.
  const held = await countHeldChanges(db, { ownerId: "teacher-b" });
  check("held: one other account's row, one ownerless; synced rows not counted",
    held, { otherAccounts: 1, ownerlessQueued: 1 });
  check("held: nobody signed in → every owned unsent row is another account's",
    await countHeldChanges(db, { ownerId: null }), { otherAccounts: 2, ownerlessQueued: 1 });
  check("counting held rows leaves the outbox as it was",
    snapshot(raw, "mutation_outbox"), before.outbox);

  // ── New writes ───────────────────────────────────────────────────────────
  await db.runAsync("INSERT INTO students (id, name, class_id, _synced) VALUES (?, ?, ?, 0)", ["s-new", "Eve", "c1"]);
  await db.runAsync("INSERT INTO students (id, name, class_id) VALUES (?, ?, ?)", ["s-default", "Fay", "c1"]);
  await db.runAsync("INSERT INTO students (id, name, class_id, _synced) VALUES (?, ?, ?, 1)", ["s-pulled", "Gus", "c3"]);
  await db.runAsync("INSERT INTO fee_payments (id, student_id, amount) VALUES (?, ?, ?)", ["p-new", "s-new", 100]);
  await db.runAsync("INSERT INTO timetable (_id, class_id) VALUES (?, ?)", ["t2", "c2"]);
  // An upsert that turns a clean row dirty — a new change by this account.
  await db.runAsync(
    "INSERT INTO students (id, name, _synced) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET name = excluded.name, _synced = 0",
    ["s-clean", "Ada L."]);
  // A legacy ownerless dirty row edited again: stays ownerless.
  await db.runAsync("UPDATE students SET name = ?, _synced = 0 WHERE id = ?", ["Ben K.", "s-dirty"]);
  // Tables the stamp cannot key: written as before, never armed.
  await db.runAsync("INSERT INTO attendance (student_id, date, status) VALUES (?, ?, ?)", ["s-new", "2026-03-02", "absent"]);
  await db.runAsync("INSERT INTO exams (id, name) VALUES (?, ?)", ["e2", "Final"]);

  const owner = (t, k, id) => raw.prepare(`SELECT _owner_id AS o FROM ${t} WHERE ${k} = ?`).get(id)?.o ?? null;
  check("a new dirty row records who made it",                  owner("students", "id", "s-new"), "teacher-b");
  check("a new row dirty by column default records who made it", owner("students", "id", "s-default"), "teacher-b");
  check("a row pulled clean records nobody",                     owner("students", "id", "s-pulled"), null);
  check("fee payment stamped",                                   owner("fee_payments", "id", "p-new"), "teacher-b");
  check("a table keyed on _id is stamped by its key",            owner("timetable", "_id", "t2"), "teacher-b");
  check("clean → dirty records who made the change",            owner("students", "id", "s-clean"), "teacher-b");
  check("a legacy ownerless dirty row edited again STAYS ownerless", owner("students", "id", "s-dirty"), null);
  check("a composite-key table is not given the column",
    raw.prepare("PRAGMA table_info(attendance)").all().some((c) => c.name === "_owner_id"), false);
  check("a table with no _synced is not given the column",
    raw.prepare("PRAGMA table_info(exams)").all().some((c) => c.name === "_owner_id"), false);
  check("the stamper's own statements are not reported as changes (9 writes → 9 reports)", reported, 9);

  // ── Existing rows: byte for byte ─────────────────────────────────────────
  const untouched = (table, key, ids) => {
    const keep = (rows) => rows.filter((r) => ids.some((id) => r.includes(`'${id}'`)));
    return keep(snapshot(raw, table, { without: ["_owner_id"] }));
  };
  check("existing students untouched (but the two this test wrote)",
    untouched("students", "id", ["s-null", "s-keep"]),
    before.students.filter((r) => r.includes("'s-null'") || r.includes("'s-keep'")));
  check("existing fee payments untouched",
    untouched("fee_payments", "id", ["p-dirty", "p-clean"]), before.fee_payments);
  check("existing timetable untouched", untouched("timetable", "_id", ["t1"]), before.timetable);
  check("unarmed tables: existing rows untouched",
    [snapshot(raw, "attendance").slice(0, 1), snapshot(raw, "exams").slice(0, 1)],
    [before.attendance, before.exams]);
  check("every existing row reads NULL owner (none assigned)",
    raw.prepare(`SELECT
       (SELECT COUNT(*) FROM students WHERE id IN ('s-null','s-keep','s-dirty') AND _owner_id IS NOT NULL) +
       (SELECT COUNT(*) FROM fee_payments WHERE id IN ('p-dirty','p-clean') AND _owner_id IS NOT NULL) +
       (SELECT COUNT(*) FROM timetable WHERE _id = 't1' AND _owner_id IS NOT NULL) AS n`).get().n, 0);
  check("the outbox is byte-for-byte what it was", snapshot(raw, "mutation_outbox"), before.outbox);
  check("the schema change is ADD COLUMN only (old columns, same order)",
    raw.prepare("PRAGMA table_info(students)").all().map((c) => c.name),
    ["id", "name", "class_id", "_synced", "_synced_at", "updated_at", "_owner_id"]);

  // ── Account switch, sign-out, rollback ───────────────────────────────────
  signedIn = "teacher-c";
  await db.runAsync("INSERT INTO students (id, name) VALUES (?, ?)", ["s-c", "Hal"]);
  check("after an account switch, the next change is the new account's", owner("students", "id", "s-c"), "teacher-c");
  signedIn = null;
  await db.runAsync("INSERT INTO students (id, name) VALUES (?, ?)", ["s-out", "Ivy"]);
  check("signed out: no owner invented", owner("students", "id", "s-out"), null);

  signedIn = "teacher-d";
  try {
    await db.withTransactionAsync(async () => {
      await db.runAsync("INSERT INTO students (id, name) VALUES (?, ?)", ["s-rolled", "Jo"]);
      throw new Error("abort");
    });
  } catch { /* expected */ }
  check("rolled back write left nothing", raw.prepare("SELECT COUNT(*) AS n FROM students WHERE id='s-rolled'").get().n, 0);
  await db.runAsync("INSERT INTO students (id, name) VALUES (?, ?)", ["s-after", "Kim"]);
  check("after a rollback the stamp still names the signed-in account", owner("students", "id", "s-after"), "teacher-d");

  // ── Downgrade: an older build opens the same file ────────────────────────
  raw.close();
  raw = new DatabaseSync(file);
  check("no trigger persists in the file",
    raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n, 0);
  raw.prepare("INSERT INTO students (id, name, _synced) VALUES (?, ?, 0)").run("s-old-build", "Lu");
  check("an older build's write is stored, ownerless, and nothing fails",
    raw.prepare("SELECT name, _owner_id AS o FROM students WHERE id = 's-old-build'").get(),
    { name: "Lu", o: null });
  check("stamps made before the downgrade are kept", owner("students", "id", "s-new"), "teacher-b");
  check("the outbox survives the downgrade untouched", snapshot(raw, "mutation_outbox"), before.outbox);
  raw.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
