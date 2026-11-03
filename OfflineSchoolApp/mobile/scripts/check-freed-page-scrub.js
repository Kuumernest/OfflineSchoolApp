// mobile/scripts/check-freed-page-scrub.js
"use strict";

/**
 * The one-time rebuild of the data files (src/db/freePageScrub.js, docs/14
 * §offline credentials).
 *
 * Older builds stored `password + salt` in `users` and rewrote it at every
 * sign-in, so schoolapp.db and the per-user stores can hold freed clear-text
 * copies no query sees. The rebuild must remove them and change nothing a
 * row is known by.
 *
 * Part 1 — the module, on real node:sqlite FILES:
 *   - the engine facts it relies on: VACUUM renumbers the rowids of a table
 *     with no index (the hazard), keeps them for an indexed one; the canary;
 *   - freed copies (insert, update over, delete) gone from the file and -wal;
 *     every row, rowid included, unchanged — an index-less table too;
 *   - once: a second run does nothing; a new file is marked without a rebuild;
 *   - interrupted after each step (a throw; the connection closed under it):
 *     the file is intact and unmarked, and the next run completes.
 *
 * Part 2 — the REAL app (peruser-harness.js: database.js, perUserData,
 * MutationQueue over real files), on an install an older build left behind:
 * a shared file and a per-user store, both with freed clear-text passwords,
 * an outbox, an id map and the migration journal. A new launch rebuilds both
 * files on open; afterwards no byte of any password is in any file, every
 * row of every table (rowids included) is unchanged, the outbox, id map and
 * journal are intact, the migration accounting is unchanged, and the next
 * launch does not rebuild again. The time is measured on a ~10 MB file.
 *
 *   node scripts/check-freed-page-scrub.js
 */

const fs   = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { bootDevice, tmpDir, quietly } = require("./peruser-harness");
const { makeLoader } = require("./offline-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const SCRUB = makeLoader(new Map(), new Map())("src/db/freePageScrub");

/** expo-sqlite's async surface over a node:sqlite connection. */
const adapt = (raw) => ({
  __raw: raw,
  execAsync:     async (sql) => { raw.exec(sql); },
  runAsync:      async (sql, p = []) => raw.prepare(sql).run(...p),
  getAllAsync:   async (sql, p = []) => raw.prepare(sql).all(...p),
  getFirstAsync: async (sql, p = []) => raw.prepare(sql).get(...p) ?? null,
});

/** How many times each secret occurs in the file and its -wal, raw bytes. */
const hits = (file, secrets) => {
  let n = 0;
  for (const f of [file, `${file}-wal`]) {
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    for (const s of secrets) {
      const needle = Buffer.from(s);
      for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) n++;
    }
  }
  return n;
};

/** Every row of every table, rowid included (where there is one). */
const snapshot = (raw, { skip = [SCRUB.SCRUB_TABLE] } = {}) => {
  const out = {};
  for (const t of raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (skip.includes(t.name)) continue;
    const rowid = !/WITHOUT\s+ROWID/i.test(t.sql);
    const rows = raw.prepare(`SELECT ${rowid ? "rowid AS __rowid, " : ""}* FROM "${t.name}" ORDER BY ${rowid ? "rowid" : 1}`).all();
    out[t.name] = nodeCrypto.createHash("sha256").update(JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? String(v) : v))).digest("hex");
  }
  return out;
};
const indexNames = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((r) => r.name);
const integrity = (raw) => raw.prepare("PRAGMA integrity_check").get().integrity_check;

const SECRETS = ["Hunter2-Ama-pw", "Kofi-Secret-77", "Head-Pass-2026", "Esi-old-pw-xyz"];
const SALT = "c2FsdHNhbHRzYWx0";

/**
 * What an older build did to a file: sign-ins writing `password + salt`,
 * without secure_delete, over and over; a removed account; filler traffic.
 */
const plantOldBuildWrites = (raw, { users = ["tea-a", "tea-b", "adm-c", "stu-d"] } = {}) => {
  raw.exec("PRAGMA secure_delete = OFF");
  raw.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT,
            passwordSalt TEXT, passwordHash TEXT, updated_at TEXT, _synced INTEGER DEFAULT 0)`);
  users.forEach((id, i) => {
    for (let k = 0; k < 6; k++) {
      // each sign-in rewrote the row (a different length → a moved cell)
      raw.prepare(`INSERT INTO users (id, name, role, passwordSalt, passwordHash, updated_at) VALUES (?, ?, 'teacher', ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET passwordHash = excluded.passwordHash, passwordSalt = excluded.passwordSalt, updated_at = excluded.updated_at`)
        .run(id, `User ${id}`, SALT, `${SECRETS[i]}${SALT}${"x".repeat(k * 7)}`, `2026-0${k + 1}-01`);
    }
  });
  // this build later replaced the values (a current-format hash), as at an
  // online sign-in — the live rows no longer hold clear text
  for (const id of users.slice(0, 3)) {
    raw.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").run(`pbkdf2-sha256$120000$${SALT}$${"ab".repeat(32)}`, id);
  }
  // the last account removed from the phone altogether
  raw.prepare("DELETE FROM users WHERE id = ?").run(users[3]);
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
};

const legacyTable = (raw) => {
  // A table some old build made with no key and no index — the only kind
  // whose rowids VACUUM would renumber — with gaps in them.
  raw.exec("CREATE TABLE IF NOT EXISTS content (subject_id TEXT, title TEXT, created_at TEXT)");
  for (let i = 0; i < 300; i++) raw.prepare("INSERT INTO content VALUES (?, ?, NULL)").run("sub-1", `Lesson ${i}`);
  raw.exec("DELETE FROM content WHERE rowid % 4 = 0");
};

// ═════════════════════════════════════════════════════════════════════════════
// PART 1 — the module on files
// ═════════════════════════════════════════════════════════════════════════════

const freshFile = (dir, name) => {
  const file = path.join(dir, name);
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("CREATE TABLE students (id TEXT PRIMARY KEY, name TEXT, classId TEXT)");
  raw.exec("CREATE TABLE mutation_outbox (id TEXT PRIMARY KEY, entity_key TEXT, payload TEXT, status TEXT, created_at TEXT)");
  for (let i = 0; i < 500; i++) raw.prepare("INSERT INTO students VALUES (?, ?, 'c1')").run(`s${i}`, `Pupil ${i}`);
  for (let i = 0; i < 50; i++) raw.prepare("INSERT INTO mutation_outbox VALUES (?, ?, ?, 'pending', '2026-10-01')").run(`m${i}`, `homework:h${i}`, JSON.stringify({ __local: { table: "homework", ids: [`h${i}`] } }));
  raw.exec("DELETE FROM students WHERE rowid % 5 = 0");
  legacyTable(raw);
  plantOldBuildWrites(raw);
  return { file, raw };
};

const part1 = async () => {
  console.log("--- 1. the module, on files ---");
  const dir = tmpDir("scrub1");

  // The hazard, and what the rebuild relies on.
  {
    const { raw } = freshFile(dir, "plain.db");
    const before = snapshot(raw);
    raw.exec("VACUUM");
    const after = snapshot(raw);
    check("hazard: a plain VACUUM renumbers the rowids of the index-less table",
      after.content === before.content, false);
    check("…and keeps them for the tables with a TEXT PRIMARY KEY (an automatic index)",
      [after.students === before.students, after.users === before.users, after.mutation_outbox === before.mutation_outbox], [true, true, true]);
    check("the canary: this SQLite keeps an indexed table's rowids", await SCRUB.engineKeepsRowids(adapt(raw)), true);
    raw.close();
  }

  // The rebuild.
  {
    const { file, raw } = freshFile(dir, "a.db");
    check("before: the old build's clear-text copies are in the file", hits(file, SECRETS) > 0, true);
    check("…though no live row holds one",
      raw.prepare("SELECT passwordHash FROM users").all().some((r) => SECRETS.some((s) => String(r.passwordHash).includes(s))), false);
    const before = snapshot(raw);
    const idx = indexNames(raw);
    const r = await SCRUB.scrubFreedPages(adapt(raw));
    check("the rebuild ran", [r.ran, r.reason], [true, "done"]);
    check("after: no byte of any password in the file or its -wal", hits(file, SECRETS), 0);
    check("every row of every table unchanged, rowids included (the index-less table too)", snapshot(raw), before);
    check("no index left behind, none lost", indexNames(raw), [...idx, `sqlite_autoindex_${SCRUB.SCRUB_TABLE}_1`].sort());
    check("the -wal is empty", fs.statSync(`${file}-wal`).size, 0);
    check("recorded", raw.prepare(`SELECT v FROM ${SCRUB.SCRUB_TABLE} WHERE k = ?`).get(SCRUB.SCRUB_KEY).v, "done");
    const again = await SCRUB.scrubFreedPages(adapt(raw));
    check("once: a second run does nothing", [again.ran, again.reason], [false, "already-done"]);
    check("integrity", integrity(raw), "ok");
    raw.close();
  }

  // A new file.
  {
    const raw = new DatabaseSync(path.join(dir, "new.db"));
    const r = await SCRUB.scrubFreedPages(adapt(raw));
    check("a file with no tables yet is marked without a rebuild", [r.ran, r.reason], [false, "new-file"]);
    raw.close();
  }

  // Interrupted after each step: by a throw, and by the connection closing
  // under it (what a killed process leaves).
  for (const how of ["throw", "close"]) {
    for (const at of ["canary", "prepared", "checkpointed", "vacuumed", "marked"]) {
      const { file, raw } = freshFile(dir, `int-${how}-${at}.db`);
      const before = snapshot(raw);
      let threw = false;
      try {
        await SCRUB.scrubFreedPages(adapt(raw), {
          afterStep: async (s) => {
            if (s !== at) return;
            if (how === "close") raw.close();
            throw new Error(`interrupted after ${s}`);
          },
        });
      } catch { threw = true; }
      if (how === "throw") { try { raw.close(); } catch { /* closed */ } }
      const re = new DatabaseSync(file);
      const marked = !!re.prepare(`SELECT name FROM sqlite_master WHERE name = '${SCRUB.SCRUB_TABLE}'`).get()
        && !!re.prepare(`SELECT v FROM ${SCRUB.SCRUB_TABLE} WHERE k = ?`).get(SCRUB.SCRUB_KEY);
      const intact = integrity(re) === "ok" && JSON.stringify(snapshot(re)) === JSON.stringify(before);
      const next = await SCRUB.scrubFreedPages(adapt(re));
      const done = marked ? next.reason === "already-done" : next.reason === "done";
      check(`${how} after "${at}": file intact, ${at === "marked" ? "already marked" : "unmarked"}; the next launch completes; nothing left`,
        [threw, intact, marked, done, hits(file, SECRETS), JSON.stringify(snapshot(re)) === JSON.stringify(before),
         indexNames(re).some((n) => n.startsWith("_scrub_keep_"))],
        [true, true, at === "marked", true, 0, true, false]);
      re.close();
    }
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// PART 2 — the real app over an old build's install
// ═════════════════════════════════════════════════════════════════════════════

const SCHOOL = "5c0e2e000000000000000001";
const noNetworkApi = new Proxy({}, { get: () => async () => { throw Object.assign(new Error("no network in this check"), { code: "ERR_NETWORK" }); } });

const launch = async (dir) => {
  const phone = await bootDevice({ dir, api: noNetworkApi });
  const LD = phone.load("src/services/perUserData.service");
  const { getDatabase } = phone.load("src/db/database");
  LD.__setTestHooks({
    skipQuiesce: true,
    prime: async () => {
      const db = await getDatabase();
      const me = phone.useAuthStore.getState().user?.id;
      await db.runAsync("INSERT OR REPLACE INTO students (id, name, schoolId) VALUES (?, ?, ?)", [`pulled-for-${me}`, `pulled for ${me}`, SCHOOL]);
      return "completed";
    },
  });
  phone.LD = LD;
  phone.getDatabase = getDatabase;
  return phone;
};

const part2 = async () => {
  console.log("--- 2. the real app, over an install an older build left ---");
  const dir = tmpDir("scrub2");
  const A = { _id: "tea-a", id: "tea-a", schoolId: SCHOOL, name: "Ama", role: "teacher", email: "ama@s.test" };
  let storeFile, accBefore, devBefore;

  // Launch 1: the install, built by the real app.
  await quietly(async () => {
    const phone = await launch(dir);
    const db = await phone.getDatabase();
    await phone.load("src/db/quizSchema").ensureQuizTables(db, { log: { log() {}, warn() {} } });
    const { SyncManager } = phone.load("src/services/syncManager");
    for (const s of ["migrateLocalDatabase", "migrateUsersTable", "migrateClassesTable", "migrateSubjectsTable",
                     "migrateAssignmentsTable", "migrateAnnouncementsTable", "migrateQuizTables"]) {
      await SyncManager[s]?.().catch?.(() => {});
    }
    const { MutationQueue } = phone.load("src/services/mutationQueue.service");
    await MutationQueue.getStats();
    // A realistic amount of mirror data (~10 MB), some of it since removed.
    const pad = "p".repeat(300);
    await db.execAsync("BEGIN");
    for (let i = 0; i < 24000; i++) {
      await db.runAsync("INSERT INTO students (id, name, schoolId, classId, email) VALUES (?, ?, ?, 'cls-1', ?)", [`s${i}`, `Pupil ${i} ${pad}`, SCHOOL, `parent${i % 900}@s.test`]);
    }
    await db.execAsync("COMMIT");
    await db.runAsync("DELETE FROM students WHERE CAST(substr(id, 2) AS INTEGER) % 7 = 0");
    // Unsent work: a dirty class, queued requests (one ownerless), an id map.
    phone.setSession(A);
    await db.runAsync("INSERT INTO classes (id, name, schoolId, _synced) VALUES ('cls-a', 'Form 2A', ?, 0)", [SCHOOL]);
    await MutationQueue.enqueue({ entityKey: "homework:h1", method: "POST", endpoint: "/x", payload: { title: "Read" }, ownerId: "tea-a" });
    await MutationQueue.enqueue({ entityKey: "homework:h2", method: "POST", endpoint: "/x", payload: { title: "Essay" }, ownerId: "tea-b" });
    await db.runAsync(
      `INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, silent, owner_id)
       VALUES ('legacy-null', 'attendance:old', 'POST', '/attendance', '{"n":1}', 'pending', 0, '2026-01-01', 0, NULL)`);
    await db.runAsync("INSERT OR REPLACE INTO sync_id_map (local_id, server_id, entity, created_at) VALUES ('local-1', 'srv-1', 'homework', '2026-10-01')").catch(async () => {
      await db.runAsync("INSERT OR REPLACE INTO sync_id_map (local_id, server_id) VALUES ('local-1', 'srv-1')");
    });
    legacyTable(db.__raw);
    // A's per-user store: the migration places A's work in it.
    await phone.LD.rememberSchoolSwitch(SCHOOL, true);
    await phone.LD.prepareSession(A);
    storeFile = phone.LD.storeFileFor("tea-a");
    const store = await phone.load("src/db/database").openDatabaseFile(storeFile);
    await store.runAsync("INSERT INTO classes (id, name, schoolId, _synced) VALUES ('cls-a2', 'Form 3A', ?, 0)", [SCHOOL]);
    accBefore = await phone.LD.accountLegacy({ verifyFiles: true });
    await phone.LD.endSession?.();
    phone.kill();
  })();

  // What the older build left: freed clear-text copies in both files, and no
  // record of a rebuild (it had none).
  const legacyPath = path.join(dir, "schoolapp.db");
  const storePath = path.join(dir, storeFile);
  for (const f of [legacyPath, storePath]) {
    const raw = new DatabaseSync(f);
    raw.exec(`DROP TABLE IF EXISTS ${SCRUB.SCRUB_TABLE}`);
    plantOldBuildWrites(raw);
    raw.close();
  }
  const snap = (f) => { const raw = new DatabaseSync(f); try { return snapshot(raw); } finally { raw.close(); } };
  const before = { legacy: snap(legacyPath), store: snap(storePath) };
  const devRaw = new DatabaseSync(path.join(dir, "device.db"));
  devBefore = snapshot(devRaw, { skip: [] });
  devRaw.close();
  check("before: clear-text copies in the shared file", hits(legacyPath, SECRETS) > 0, true);
  check("before: and in A's store", hits(storePath, SECRETS) > 0, true);
  console.log(`       shared file ${(fs.statSync(legacyPath).size / 1e6).toFixed(1)} MB`);

  // Launch 2: the new build opens the files.
  let opened, accAfter, ms;
  await quietly(async () => {
    const phone = await launch(dir);
    const t0 = Date.now();
    await phone.getDatabase();
    ms = Date.now() - t0;
    await phone.load("src/db/database").openDatabaseFile(storeFile);
    accAfter = await phone.LD.accountLegacy({ verifyFiles: true });
    opened = true;
    phone.kill();
  })();
  console.log(`       first open of the shared file, rebuild included: ${ms} ms`);
  check("the files open", opened, true);
  check("after: no byte of any password in the shared file or its -wal", hits(legacyPath, SECRETS), 0);
  check("after: none in A's store either", hits(storePath, SECRETS), 0);
  const after = { legacy: snap(legacyPath), store: snap(storePath) };
  check("every row of every table of the shared file unchanged, rowids included", after.legacy, before.legacy);
  check("every row of every table of A's store unchanged, rowids included", after.store, before.store);
  check("(that covers the outbox, id map and the index-less legacy table)",
    ["mutation_outbox", "mutation_outbox_migrated", "sync_id_map", "content", "users", "students"].every((t) => t in after.legacy && after.legacy[t] === before.legacy[t]), true);
  const devRaw2 = new DatabaseSync(path.join(dir, "device.db"));
  check("device.db (journal, placements, review items, attribution) untouched", snapshot(devRaw2, { skip: [] }), devBefore);
  devRaw2.close();
  check("the store was made and the accounting has work in it (outbox, dirty rows)",
    [fs.existsSync(storePath), accBefore.items.length >= 4], [true, true]);
  check("the migration accounting is the same, item for item",
    accAfter.items.map((i) => [i.kind, i.tbl, i.id, i.hash, i.state]), accBefore.items.map((i) => [i.kind, i.tbl, i.id, i.hash, i.state]));
  check("…and nothing unplaced", accAfter.totals.unplaced, 0);
  const mark = (f) => { const raw = new DatabaseSync(f); try { return raw.prepare(`SELECT v, at FROM ${SCRUB.SCRUB_TABLE} WHERE k = ?`).get(SCRUB.SCRUB_KEY) ?? null; } catch { return null; } finally { raw.close(); } };
  const m1 = { legacy: mark(legacyPath), store: mark(storePath) };
  check("both files recorded as done", [m1.legacy?.v, m1.store?.v], ["done", "done"]);

  // Launch 3: not again.
  let ms3;
  await quietly(async () => {
    const phone = await launch(dir);
    const t0 = Date.now();
    await phone.getDatabase();
    ms3 = Date.now() - t0;
    await phone.load("src/db/database").openDatabaseFile(storeFile);
    phone.kill();
  })();
  check("the next launch does not rebuild again", [mark(legacyPath), mark(storePath)], [m1.legacy, m1.store]);
  console.log(`       a later open: ${ms3} ms`);

  // Exact time of the rebuild alone, on a copy of the ~10 MB file.
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(legacyPath, copy);
  const raw = new DatabaseSync(copy);
  raw.exec(`DROP TABLE ${SCRUB.SCRUB_TABLE}`);
  const r = await SCRUB.scrubFreedPages(adapt(raw));
  console.log(`       the rebuild alone on ${(fs.statSync(copy).size / 1e6).toFixed(1)} MB: ${r.ms} ms`);
  raw.close();
};

(async () => {
  await part1();
  await part2();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
