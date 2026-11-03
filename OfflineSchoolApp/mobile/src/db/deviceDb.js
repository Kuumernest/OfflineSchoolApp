// mobile/src/db/deviceDb.js
"use strict";

/**
 * device.db — what a shared phone knows that belongs to no single account
 * (docs/40 §8, per-user local data).
 *
 *   meta          k/v: when the migration started, schema version
 *   journal       one row per migration step; a step is done when its row says
 *                 so, and every step can be re-run (see perUserData.service)
 *   credentials   offline sign-in: salt + hash per account, copied from the
 *                 shared `users` table before anything depends on them
 *   stores        the per-account files: which, when last used, primed,
 *                 switched, evicted
 *   attribution   the owner decided for an existing dirty row, and on what
 *                 evidence (D2)
 *   placements    a legacy row copied into an account's file and verified,
 *                 with the content hash it had when it was copied
 *   review_items  changes nobody could be attributed — a full copy of each,
 *                 held for a person to decide (D2/D4). Never dropped.
 *
 * Created ONLY when the school's switch is on (docs/40 D7). With the switch
 * off nothing here is ever opened, so the phone does exactly what it did.
 * Whether it exists is remembered in SecureStore, so asking never creates it.
 *
 * Not instrumented (db/localWrites.js): nothing written here is anybody's
 * change to send.
 */

import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";

export const DEVICE_DB_NAME = "device.db";
const MARKER_KEY = "peruser_device_db";
const SCHEMA_VERSION = "1";

let _dev = null;
let _devPromise = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS journal (
     step       TEXT PRIMARY KEY,
     status     TEXT NOT NULL,
     started_at TEXT,
     done_at    TEXT,
     detail     TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS credentials (
     user_id       TEXT PRIMARY KEY,
     email         TEXT,
     enrollment_no TEXT,
     role          TEXT,
     school_id     TEXT,
     name          TEXT,
     password_salt TEXT,
     password_hash TEXT,
     profile       TEXT,
     updated_at    TEXT,
     source        TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cred_email ON credentials(email)`,
  `CREATE INDEX IF NOT EXISTS idx_cred_enrol ON credentials(enrollment_no)`,
  `CREATE TABLE IF NOT EXISTS stores (
     user_id      TEXT PRIMARY KEY,
     file         TEXT NOT NULL,
     school_id    TEXT,
     created_at   TEXT,
     last_used_at TEXT,
     primed_at    TEXT,
     switched_at  TEXT,
     evicted_at   TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS attribution (
     tbl        TEXT NOT NULL,
     row_id     TEXT NOT NULL,
     owner_id   TEXT,
     evidence   TEXT NOT NULL,
     decided_at TEXT,
     PRIMARY KEY (tbl, row_id)
   )`,
  `CREATE TABLE IF NOT EXISTS placements (
     kind      TEXT NOT NULL,
     tbl       TEXT NOT NULL,
     row_id    TEXT NOT NULL,
     hash      TEXT NOT NULL,
     dest      TEXT NOT NULL,
     placed_at TEXT,
     PRIMARY KEY (kind, tbl, row_id, hash)
   )`,
  `CREATE TABLE IF NOT EXISTS review_items (
     id          TEXT PRIMARY KEY,
     kind        TEXT NOT NULL,
     tbl         TEXT NOT NULL,
     row_id      TEXT NOT NULL,
     content     TEXT NOT NULL,
     children    TEXT,
     hash        TEXT NOT NULL,
     reason      TEXT,
     summary     TEXT,
     created_at  TEXT,
     status      TEXT NOT NULL DEFAULT 'held',
     assigned_to TEXT,
     decided_by  TEXT,
     decided_at  TEXT,
     action      TEXT,
     placed_at   TEXT
   )`,
];

/** True once device.db has been created on this phone. Never creates it. */
export const deviceDbExists = async () => {
  if (_dev) return true;
  try { return (await SecureStore.getItemAsync(MARKER_KEY)) === "1"; } catch { return false; }
};

/** Opens (creating if need be) device.db. Only the per-user migration calls this. */
export const openDeviceDb = async () => {
  if (_dev) return _dev;
  if (_devPromise) return _devPromise;
  _devPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(DEVICE_DB_NAME);
    await db.execAsync("PRAGMA journal_mode = WAL;").catch(() => {});
    for (const sql of SCHEMA) await db.execAsync(sql);
    await db.runAsync(
      "INSERT OR IGNORE INTO meta (k, v) VALUES ('schema_version', ?)", [SCHEMA_VERSION]
    );
    await SecureStore.setItemAsync(MARKER_KEY, "1");
    _dev = db;
    return db;
  })().catch((err) => { _devPromise = null; throw err; });
  return _devPromise;
};

/** For tests: forget the handle (the file stays). */
export const resetDeviceDbSingleton = () => { _dev = null; _devPromise = null; };

export const getMeta = async (dev, k) =>
  (await dev.getFirstAsync("SELECT v FROM meta WHERE k = ?", [k]))?.v ?? null;
export const setMeta = (dev, k, v) =>
  dev.runAsync("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", [k, v == null ? null : String(v)]);

// ── Journal ────────────────────────────────────────────────────────────────

export const stepDone = async (dev, step) =>
  (await dev.getFirstAsync("SELECT status FROM journal WHERE step = ?", [step]))?.status === "done";

export const stepStart = (dev, step) =>
  dev.runAsync(
    `INSERT INTO journal (step, status, started_at) VALUES (?, 'running', ?)
     ON CONFLICT(step) DO UPDATE SET status = CASE WHEN status = 'done' THEN 'done' ELSE 'running' END`,
    [step, new Date().toISOString()]
  );

export const stepFinish = (dev, step, detail = null) =>
  dev.runAsync(
    `UPDATE journal SET status = 'done', done_at = ?, detail = ? WHERE step = ?`,
    [new Date().toISOString(), detail == null ? null : JSON.stringify(detail), step]
  );

export const stepReset = (dev, prefix) =>
  dev.runAsync("DELETE FROM journal WHERE step LIKE ?", [`${prefix}%`]);

export default {
  DEVICE_DB_NAME, deviceDbExists, openDeviceDb, resetDeviceDbSingleton,
  getMeta, setMeta, stepDone, stepStart, stepFinish, stepReset,
};
