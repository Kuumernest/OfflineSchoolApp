// mobile/src/db/syncCursors.js
"use strict";

/**
 * Where the phone keeps its sync positions — one set per ACCOUNT.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 *
 * The cursors used to be one value per phone, in SecureStore. On a shared
 * phone with per-user local data switched OFF (docs/40), a second account
 * signing in pulled "everything since the first account's last sync" — and
 * so never received the older rows in ITS scope that the first account was
 * not allowed to see (a bursar after a teacher), nor anything of another
 * school after a super_admin changed school.
 *
 * Now:
 *   - per-user file (switch ON): the file's own `local_meta` table, exactly as
 *     before — the file belongs to one account, so its cursors do too;
 *   - shared legacy file (switch OFF): a `sync_cursors` table in that file,
 *     keyed by (server, school, account). Another account on the phone starts
 *     from its own cursor, or from the beginning. Kept in the SAME file as the
 *     data it describes, so a wiped file never leaves a cursor behind that
 *     would skip everything older than it.
 *
 * ── The cursor that was already there ────────────────────────────────────
 *
 * The old phone-wide SecureStore cursor says nothing about which account
 * pulled up to it: the last sign-in is not necessarily the last sync (an
 * offline sign-in never syncs). So it is not handed to anyone — it is
 * dropped once, and every account's next pull is a full one. A full pull is
 * always safe (every row applies as an upsert, and unsent local changes are
 * protected); a borrowed cursor is not.
 */

import * as SecureStore from "expo-secure-store";
import { getDatabase, activeDatabaseName, LEGACY_DB_NAME } from "./database";
import { activeStoreMeta } from "./storeMeta";
import { getCurrentAuth } from "../utils/authHelpers";

/** The keys the old builds kept phone-wide in SecureStore. */
export const LEGACY_SECURESTORE_KEYS = ["sync_last_timestamp", "quiz_last_sync"];
const MIGRATED_FLAG = "sync_cursors_per_account_v1";

/** Prefix of the per-collection feed cursors (syncFeed.client.js). */
export const FEED_PREFIX = "feed_cursor:";

const serverKey = () => {
  try {
    const { API_URL } = require("../services/api");
    return String(API_URL || "").trim().replace(/\/+$/, "").toLowerCase();
  } catch { return ""; }
};

/** Which account a cursor belongs to on the shared file, or null when nobody is signed in. */
export const cursorScope = () => {
  const { user, schoolId } = getCurrentAuth();
  const userId = user?._id ?? user?.id ?? null;
  if (!userId) return null;
  return `${serverKey()}|${schoolId ?? ""}|${userId}`;
};

let _migrated = false;
/** Drop the phone-wide SecureStore cursors once (see the header). */
export const migrateLegacyCursors = async () => {
  if (_migrated) return;
  try {
    if (!(await SecureStore.getItemAsync(MIGRATED_FLAG))) {
      for (const k of LEGACY_SECURESTORE_KEYS) await SecureStore.deleteItemAsync(k).catch(() => {});
      await SecureStore.setItemAsync(MIGRATED_FLAG, "1");
    }
    _migrated = true;
  } catch { /* retried next time */ }
};

/**
 * The cursor store for the account signed in now, or null (nobody signed in
 * on the shared file: nothing is read or written, a pull starts from the
 * beginning).
 */
export const cursorStore = async () => {
  if (activeDatabaseName() !== LEGACY_DB_NAME) {
    const meta = await activeStoreMeta();
    if (!meta) return null;
    return {
      ...meta,
      clear: async () => {
        const db = await getDatabase();
        await db.runAsync(
          "DELETE FROM local_meta WHERE k IN (?, ?) OR k LIKE ?",
          [...LEGACY_SECURESTORE_KEYS, `${FEED_PREFIX}%`]
        );
      },
    };
  }

  await migrateLegacyCursors();
  const scope = cursorScope();
  if (!scope) return null;
  const db = await getDatabase();
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS sync_cursors (scope TEXT NOT NULL, k TEXT NOT NULL, v TEXT, updated_at TEXT, PRIMARY KEY (scope, k))"
  );
  return {
    scope,
    get: async (k) => (await db.getFirstAsync("SELECT v FROM sync_cursors WHERE scope = ? AND k = ?", [scope, k]))?.v ?? null,
    set: (k, v) => db.runAsync(
      "INSERT OR REPLACE INTO sync_cursors (scope, k, v, updated_at) VALUES (?, ?, ?, ?)",
      [scope, k, String(v), new Date().toISOString()]
    ),
    del: (k) => db.runAsync("DELETE FROM sync_cursors WHERE scope = ? AND k = ?", [scope, k]),
    clear: () => db.runAsync("DELETE FROM sync_cursors WHERE scope = ?", [scope]),
  };
};

export default { cursorStore, cursorScope, migrateLegacyCursors, FEED_PREFIX };
