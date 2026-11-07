// mobile/src/db/storeMeta.js
"use strict";

/**
 * Small key/value state that belongs to ONE local data file — the sync cursors.
 *
 * On the legacy shared file the cursors live in SecureStore, as they always
 * have (returns null here, and the caller keeps doing exactly that). A
 * per-user store keeps its own in a `local_meta` table inside the file, so a
 * new store starts from the epoch (a full pull for that account) and an
 * evicted store takes its cursor with it — a stale cursor outliving its data
 * would skip everything older than it.
 */

import { getDatabase, activeDatabaseName, LEGACY_DB_NAME } from "./database";

export const activeStoreMeta = async () => {
  if (activeDatabaseName() === LEGACY_DB_NAME) return null;
  const db = await getDatabase();
  await db.execAsync("CREATE TABLE IF NOT EXISTS local_meta (k TEXT PRIMARY KEY, v TEXT)");
  return {
    get: async (k) => (await db.getFirstAsync("SELECT v FROM local_meta WHERE k = ?", [k]))?.v ?? null,
    set: (k, v) => db.runAsync("INSERT OR REPLACE INTO local_meta (k, v) VALUES (?, ?)", [k, String(v)]),
    del: (k) => db.runAsync("DELETE FROM local_meta WHERE k = ?", [k]),
  };
};

export default { activeStoreMeta };
