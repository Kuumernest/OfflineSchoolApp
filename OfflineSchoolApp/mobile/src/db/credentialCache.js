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
 * (schoolapp.db, schoolapp.u_<id>.db) are rebuilt once, at app start, by
 * db/freePageScrub.js — not here, during a sign-in — keeping every rowid.
 */

// security/passwordHash (and through it expo-crypto) is loaded only when a
// value is inspected: the backfill imports this file for CREDENTIAL_ROW.
const isCurrentFormat = (h) => require("../security/passwordHash").isCurrentFormat(h);

/**
 * ── Not a local change ────────────────────────────────────────────────────
 *
 * The cache row is a copy of the server's account, written because the
 * server just answered a sign-in for it. It used to be inserted with the
 * column's default `_synced = 0`, and the backfill's teacher spec sent every
 * dirty `role = 'teacher'` row as POST /admin/teachers: on a shared phone the
 * next administrator's sync tried to create every teacher who had signed in —
 * a parked 409 for an active one, and for one the school had removed, the
 * server RESTORED the account with a new password (check-credential-rows.js).
 * So the row is inserted as synced, and the spec skips any row carrying a
 * credential (CREDENTIAL_ROW) — no create made on a screen ever writes one.
 */
export const CREDENTIAL_ROW = "(passwordHash IS NOT NULL AND passwordHash != '')";

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
    // _synced = 1 on insert: the server's own account, not a local create.
    // An existing row keeps its flag — it may carry a real pending edit.
    `INSERT INTO users
       (id, name, email, enrollmentNo, role, schoolId,
        passwordSalt, passwordHash, updated_at, _synced, _synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
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
      user.schoolId || null, cred.salt, cred.hash, now, now,
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
  // Removing the value (cred null) also removes what marks the row as a
  // credential cache (CREDENTIAL_ROW), so its dirty flag — left by an older
  // build, see repairCredentialRows — is cleared in the same statement.
  await db.runAsync(
    cred
      ? "UPDATE users SET passwordSalt = ?, passwordHash = ? WHERE id = ?"
      : `UPDATE users SET passwordSalt = ?, passwordHash = ?,
           _synced = CASE WHEN deleted_at IS NULL OR deleted_at = '' THEN 1 ELSE _synced END
         WHERE id = ?`,
    [cred?.salt ?? null, cred?.hash ?? null, String(userId)]
  );
  return true;
};

/**
 * Older builds inserted the cache row with `_synced = 0`. Clear that flag on
 * every row that is provably a credential cache — it carries a password hash,
 * which only an online sign-in for that id writes, so the server has the
 * account — unless it is soft-deleted (a real pending delete) or `keep`
 * names it (a real pending edit queued for it). A genuine offline teacher
 * create carries no hash and is never touched.
 * @param {Set<string>} [keep] ids with queued work of their own
 * @returns {Promise<string[]>} the ids cleared
 */
export const repairCredentialRows = async (db, keep = new Set()) => {
  if (!(await hasUsersTable(db))) return [];
  const rows = await db.getAllAsync(
    `SELECT id FROM users
     WHERE ${CREDENTIAL_ROW} AND (_synced = 0 OR _synced IS NULL)
       AND (deleted_at IS NULL OR deleted_at = '')`
  ).catch(() => []);
  const ids = (rows ?? []).map((r) => String(r.id)).filter((id) => !keep.has(id));
  const ts = new Date().toISOString();
  for (const id of ids) {
    await db.runAsync("UPDATE users SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, id]).catch(() => {});
  }
  return ids;
};

/** Ids of every row in `users` that is a credential cache. */
export const credentialRowIds = async (db) => {
  if (!(await hasUsersTable(db))) return new Set();
  const rows = await db.getAllAsync(`SELECT id FROM users WHERE ${CREDENTIAL_ROW}`).catch(() => []);
  return new Set((rows ?? []).map((r) => String(r.id)));
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

export default {
  upsertCachedCredential, replaceLegacyCredential, repairCredentialRows, credentialRowIds,
  flushWal, compactDeviceDb, isLegacyValue, CREDENTIAL_ROW,
};
