// src/db/credentialCache.js
"use strict";

/**
 * The offline sign-in cache in a `users` table: the row an online sign-in
 * writes for its account (profile + passwordSalt/passwordHash), and the
 * replacement of an old clear-text value (security/passwordHash.js).
 *
 * ── Leaving nothing behind ────────────────────────────────────────────────
 *
 * Overwriting a value in SQLite does not by itself erase it: the old cell's
 * bytes stay in the page's free space, and in WAL mode the old page image
 * stays in the -wal file until that is reused. So every credential write here
 *   - runs with `PRAGMA secure_delete = ON` (SQLite zeroes the cell it frees);
 *   - and a replacement of a clear-text value is followed by a TRUNCATE
 *     checkpoint (flushWal): the new pages go into the main file and the
 *     -wal file, which still held the old page images, is emptied.
 *
 * device.db, which only the per-user migration uses, is VACUUMed after such
 * a replacement as well (compactDeviceDb): rebuilt from live rows, which also
 * drops freed copies left by writes made before this build. The data files
 * (schoolapp.db, schoolapp.u_<id>.db) are NOT VACUUMed: VACUUM renumbers the
 * rowids of tables without an INTEGER PRIMARY KEY (seen in node:sqlite
 * 3.53), and a few screens fall back to rowid as an id; and it would rewrite
 * the whole shared file during a sign-in. What a data file can still hold is
 * a freed copy written before this build (each old sign-in rewrote the value)
 * in page space SQLite has not reused yet — no live row (docs/14).
 */

import { isCurrentFormat } from "../security/passwordHash";

const secureDelete = (db) => db.execAsync("PRAGMA secure_delete = ON;").catch(() => {});

/** Is this stored hash an old clear-text value (anything not the current scheme)? */
export const isLegacyValue = (hash) => typeof hash === "string" && hash !== "" && !isCurrentFormat(hash);

const hasUsersTable = async (db) =>
  !!(await db.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").catch(() => null));

/**
 * The online sign-in's cache row in `db` (the active file).
 * @returns {Promise<{ replacedLegacy: boolean }>}
 */
export const upsertCachedCredential = async (db, user, cred) => {
  const prior = await db.getFirstAsync("SELECT passwordHash FROM users WHERE id = ?", [String(user.id)]).catch(() => null);
  const replacedLegacy = isLegacyValue(prior?.passwordHash);
  await secureDelete(db);
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO users
       (id, name, email, enrollmentNo, role, schoolId,
        passwordSalt, passwordHash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name         = excluded.name,
       email        = excluded.email,
       enrollmentNo = excluded.enrollmentNo,
       role         = excluded.role,
       schoolId     = excluded.schoolId,
       passwordSalt = excluded.passwordSalt,
       passwordHash = excluded.passwordHash,
       updated_at   = excluded.updated_at`,
    [
      String(user.id), user.name ?? null, user.email || null,
      user.enrollmentNo || null, user.role ?? null,
      user.schoolId || null, cred.salt, cred.hash, now,
    ]
  );
  return { replacedLegacy };
};

/**
 * Replace this account's clear-text value in `db`, if it holds one: with
 * `cred` (the new-format value), or — `cred` null, the new value could not be
 * made — with nothing, so offline sign-in waits for the next online one rather
 * than keeping clear text. A current-format value is left alone.
 * @returns {Promise<boolean>} whether a clear-text value was replaced
 */
export const replaceLegacyCredential = async (db, userId, cred) => {
  if (!(await hasUsersTable(db))) return false;
  const row = await db.getFirstAsync("SELECT passwordHash FROM users WHERE id = ?", [String(userId)]).catch(() => null);
  if (!isLegacyValue(row?.passwordHash)) return false;
  await secureDelete(db);
  await db.runAsync(
    "UPDATE users SET passwordSalt = ?, passwordHash = ? WHERE id = ?",
    [cred?.salt ?? null, cred?.hash ?? null, String(userId)]
  );
  return true;
};

/** Move the WAL into the main file and empty it. Best effort. */
export const flushWal = async (db) => {
  await db.execAsync("PRAGMA wal_checkpoint(TRUNCATE);").catch(() => {});
};

/**
 * device.db only: rebuild from live rows, then empty the WAL. Best effort —
 * a VACUUM refused (no room for the copy) leaves the file correct, the value
 * already replaced and its cell zeroed; it is not retried.
 */
export const compactDeviceDb = async (dev) => {
  await dev.execAsync("VACUUM;").catch((err) => console.warn("[credentials] VACUUM device.db:", err?.message));
  await flushWal(dev);
};

export default { upsertCachedCredential, replaceLegacyCredential, flushWal, compactDeviceDb, isLegacyValue };
