// mobile/src/db/freePageScrub.js
"use strict";

/**
 * One-time rebuild of a data file (schoolapp.db, schoolapp.u_<id>.db), so the
 * freed page space older builds left behind is gone (docs/14 §offline
 * credentials).
 *
 * Older builds stored the offline sign-in value as `password + salt` in
 * `users` and rewrote it at every sign-in, without secure_delete: each
 * rewrite left the previous clear-text copy in a freed cell, a freeblock of a
 * live page or a page on the freelist. No query reads those bytes, but they
 * are in the file. Overwriting only the freelist would miss the copies inside
 * pages still in use; VACUUM rebuilds every page from the live rows.
 *
 * ── Identifiers ────────────────────────────────────────────────────────────
 *
 * VACUUM may change the ROWID of a table without an INTEGER PRIMARY KEY
 * (sqlite.org/lang_vacuum.html). What SQLite actually does (vacuum.c +
 * insert.c xferOptimization, confirmed on node:sqlite 3.53): rowids are kept
 * for every table that has at least one index, and renumbered 1..n (in the
 * same order) for a table with none. Every table this app creates has a
 * TEXT PRIMARY KEY — an automatic index — and no code persists a rowid; but
 * a table left by some older build might have no key at all. So, before the
 * VACUUM:
 *   - the engine is tested on a scratch in-memory database (the canary): a
 *     table with a gap and an index must keep its rowids. If the phone's
 *     SQLite does otherwise, nothing is done and the file is left as it is;
 *   - a table with no index gets a temporary one (`_scrub_keep_*`), dropped
 *     afterwards;
 *   - each rowid table's rowids are fingerprinted, and compared after.
 *
 * ── Once, and crash-safe ───────────────────────────────────────────────────
 *
 * Runs in the open path of db/database.js, before the handle is handed to
 * anything — no screen, sync or outbox drain can be using this connection,
 * and no transaction is open. VACUUM is itself atomic: a crash or a refusal
 * (no room for the copy) leaves the file as it was, and the flag is not
 * written, so the next launch tries again. The flag (`_scrub_state`) lives in
 * the file it describes; a file that had no tables when first opened is
 * new — written only by this build, which never stores clear text — and is
 * marked without a rebuild.
 *
 * In WAL mode the -wal file holds page images too: it is checkpointed with
 * TRUNCATE (emptied) before and after.
 */

export const SCRUB_TABLE = "_scrub_state";
export const SCRUB_KEY   = "freed_pages_v1";
const KEEP_PREFIX = "_scrub_keep_";
const PROBE = "_scrub_probe";

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const one = (db, sql, p = []) => db.getFirstAsync(sql, p);
const all = async (db, sql, p = []) => (await db.getAllAsync(sql, p)) ?? [];

const checkpoint = async (db) => {
  const r = await one(db, "PRAGMA wal_checkpoint(TRUNCATE)").catch(() => null);
  // Not in WAL mode: nothing to do. busy = 1: a reader held it — not done.
  if (r && Number(r.busy) !== 0) throw new Error("wal checkpoint busy");
};

/** Is this file's scrub already recorded? */
export const scrubDone = async (db) => {
  const t = await one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [SCRUB_TABLE]).catch(() => null);
  if (!t) return false;
  const r = await one(db, `SELECT v FROM ${SCRUB_TABLE} WHERE k = ?`, [SCRUB_KEY]).catch(() => null);
  return !!r;
};

const mark = async (db, value) => {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${SCRUB_TABLE} (k TEXT PRIMARY KEY, v TEXT, at TEXT)`);
  await db.runAsync(
    `INSERT OR REPLACE INTO ${SCRUB_TABLE} (k, v, at) VALUES (?, ?, ?)`,
    [SCRUB_KEY, value, new Date().toISOString()]
  );
};

/**
 * Does this SQLite keep the rowids of an indexed table through VACUUM?
 * On an attached in-memory database: nothing of the real file is touched.
 */
export const engineKeepsRowids = async (db) => {
  await db.execAsync(`ATTACH DATABASE ':memory:' AS ${PROBE}`);
  try {
    await db.execAsync(`
      CREATE TABLE ${PROBE}.c (x TEXT);
      INSERT INTO ${PROBE}.c (x) VALUES ('a'), ('b'), ('c'), ('d');
      DELETE FROM ${PROBE}.c WHERE rowid IN (1, 3);
      CREATE INDEX ${PROBE}.c_x ON c (x);
    `);
    await db.execAsync(`VACUUM ${PROBE}`);
    const rows = await all(db, `SELECT rowid AS r FROM ${PROBE}.c ORDER BY rowid`);
    return rows.map((r) => Number(r.r)).join(",") === "2,4";
  } finally {
    await db.execAsync(`DETACH DATABASE ${PROBE}`).catch(() => {});
  }
};

/** Tables of `main` that have a rowid of their own (not an alias of an INTEGER PRIMARY KEY). */
const rowidTables = async (db) => {
  const tables = await all(db,
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`);
  const out = [];
  for (const t of tables) {
    const sql = String(t.sql);
    if (/^\s*CREATE\s+VIRTUAL/i.test(sql) || /WITHOUT\s+ROWID/i.test(sql)) continue;
    const cols = await all(db, `PRAGMA table_info(${qi(t.name)})`);
    const pk = cols.filter((c) => Number(c.pk) > 0);
    if (pk.length === 1 && String(pk[0].type).toUpperCase() === "INTEGER") continue;   // rowid alias: VACUUM keeps it
    const indexes = await all(db, `PRAGMA index_list(${qi(t.name)})`);
    out.push({ name: t.name, firstColumn: cols[0]?.name, indexed: indexes.length > 0 });
  }
  return out;
};

/** count, sum and a mixed sum of a table's rowids: any renumbering of a table with a gap changes it. */
const rowidPrint = async (db, table) => {
  const r = await one(db,
    `SELECT count(*) AS n, total(rowid) AS s, total((rowid % 65521) * (rowid % 65519)) AS q FROM ${qi(table)}`);
  return `${r?.n}:${r?.s}:${r?.q}`;
};

const dropKeepIndexes = async (db) => {
  const idx = await all(db,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE ? ESCAPE '\\'",
    [`${KEEP_PREFIX.replace(/_/g, "\\_")}%`]).catch(() => []);
  for (const i of idx) await db.execAsync(`DROP INDEX IF EXISTS ${qi(i.name)}`);
};

/**
 * Rebuild `db` once. Must be called on a connection nothing else is using,
 * outside any transaction. Throws on failure (the file is left intact and
 * unmarked, so the caller retries at the next launch).
 * @param {object}   db                expo-sqlite handle
 * @param {object}  [o]
 * @param {Function}[o.afterStep]      test hook: called with each step's name
 * @returns {Promise<{ ran: boolean, reason: string, ms: number }>}
 */
export const scrubFreedPages = async (db, { afterStep = null } = {}) => {
  const t0 = Date.now();
  const step = async (name) => { if (afterStep) await afterStep(name); };
  const done = (ran, reason) => ({ ran, reason, ms: Date.now() - t0 });

  if (await scrubDone(db)) return done(false, "already-done");

  const n = await one(db, "SELECT count(*) AS n FROM sqlite_master WHERE name != ?", [SCRUB_TABLE]);
  if (!Number(n?.n)) {
    await mark(db, "new-file");
    return done(false, "new-file");
  }

  if (!(await engineKeepsRowids(db))) return done(false, "engine-renumbers");
  await step("canary");

  const prev = await one(db, "PRAGMA secure_delete").catch(() => null);
  await db.execAsync("PRAGMA secure_delete = ON");
  try {
    // The flag's table exists before the rebuild, so marking afterwards is
    // one small row in a page the rebuild has already laid out.
    await db.execAsync(`CREATE TABLE IF NOT EXISTS ${SCRUB_TABLE} (k TEXT PRIMARY KEY, v TEXT, at TEXT)`);

    const tables = await rowidTables(db);
    let k = 0;
    for (const t of tables) {
      if (t.indexed || !t.firstColumn) continue;
      await db.execAsync(`CREATE INDEX IF NOT EXISTS ${qi(`${KEEP_PREFIX}${k++}`)} ON ${qi(t.name)} (${qi(t.firstColumn)})`);
    }
    const before = new Map();
    for (const t of tables) before.set(t.name, await rowidPrint(db, t.name));
    await step("prepared");

    await checkpoint(db);
    await step("checkpointed");
    await db.execAsync("VACUUM");
    await step("vacuumed");

    await dropKeepIndexes(db);
    const moved = [];
    for (const t of tables) if ((await rowidPrint(db, t.name)) !== before.get(t.name)) moved.push(t.name);
    // Cannot be undone by running again; recorded and reported, not retried.
    if (moved.length) console.error("[scrub] rowids changed in:", moved.join(", "));

    await mark(db, moved.length ? `done; rowids changed: ${moved.join(",")}` : "done");
    await checkpoint(db);
    await step("marked");
    return done(true, moved.length ? "rowids-changed" : "done");
  } finally {
    await dropKeepIndexes(db).catch(() => {});
    if (prev && Number(prev.secure_delete) === 0) await db.execAsync("PRAGMA secure_delete = OFF").catch(() => {});
  }
};

export default { scrubFreedPages, scrubDone, engineKeepsRowids, SCRUB_TABLE, SCRUB_KEY };
