// src/services/periods.service.js
"use strict";

import api                   from "./api";
import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import {
  safeAddColumn,
  withTransaction,
  tableExists,
}                            from "../db/dbHelpers";
import { generateUUID }      from "../utils/idHelpers";
import NetInfo               from "@react-native-community/netinfo";

// ─── Constants ────────────────────────────────────────────────────────────────
const TABLE = "periods";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SCHEMA
// ═════════════════════════════════════════════════════════════════════════════

const ensureSchema = (db) =>
  ensureTableSchema(
    TABLE,
    async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT,
          name       TEXT NOT NULL,
          starttime  TEXT NOT NULL,
          endtime    TEXT NOT NULL,
          sortorder  INTEGER DEFAULT 0,
          isbreak    INTEGER DEFAULT 0,
          isactive   INTEGER DEFAULT 1,
          version    INTEGER DEFAULT 1,
          dirty      INTEGER DEFAULT 0,
          operation  TEXT,
          deletedat  TEXT,
          _synced    INTEGER DEFAULT 0,
          _synced_at TEXT,
          created_at TEXT,
          updated_at TEXT
        )
      `);

      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_periods_dirty  ON ${TABLE}(dirty)`
      ).catch(() => {});
      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_periods_school ON ${TABLE}(schoolId)`
      ).catch(() => {});

      // Patch columns that may be missing on older installs
      await safeAddColumn(db, TABLE, "_synced",    "INTEGER DEFAULT 0");
      await safeAddColumn(db, TABLE, "_synced_at", "TEXT");
      await safeAddColumn(db, TABLE, "created_at", "TEXT");
      await safeAddColumn(db, TABLE, "updated_at", "TEXT");

      console.log("[periods] Schema verified");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TIME HELPER
// ═════════════════════════════════════════════════════════════════════════════

const toMinutes = (time) => {
  if (!time || typeof time !== "string") return null;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — NORMALISERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * server JSON → db row shape
 * Used when writing to SQLite (INSERT / REPLACE).
 */
const normalizeFromApi = (p) => ({
  id:         p._id       || p.id,
  schoolId:   p.schoolId  || p.school_id || null,
  name:       p.name,
  starttime:  p.startTime || p.starttime,
  endtime:    p.endTime   || p.endtime,
  sortorder:  p.sortOrder ?? p.sort_order ?? 0,
  isbreak:    (p.isBreak  || p.is_break) ? 1 : 0,
  isactive:   p.isActive  !== false      ? 1 : 0,
  version:    p.version   || 1,
  updated_at: p.updatedAt || p.updated_at || new Date().toISOString(),
});

/**
 * db row → UI shape (camelCase)
 * Used when reading from SQLite.
 */
const normalizeFromDb = (row) => {
  if (!row) return null;
  return {
    id:        row.id,
    schoolId:  row.schoolId,
    name:      row.name,
    startTime: row.starttime,
    endTime:   row.endtime,
    sortOrder: row.sortorder,
    isBreak:   row.isbreak  === 1,
    isActive:  row.isactive === 1,
    version:   row.version,
    dirty:     row.dirty    === 1,
  };
};

/**
 * server JSON → UI shape
 * Convenience wrapper for the online path in getAll.
 * Pipeline: server → normalizeFromApi → normalizeFromDb → UI
 */
const normalizeFromServer = (p) => normalizeFromDb(normalizeFromApi(p));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SERVICE
// ═════════════════════════════════════════════════════════════════════════════

export const PeriodsService = {

  /**
   * Returns all active (or all) periods.
   * Online: fetches from server and back-fills SQLite.
   * Offline: reads SQLite.
   */
  async getAll(includeInactive = false) {
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        const params   = includeInactive ? "?includeInactive=true" : "";
        const response = await api.get(`/admin/periods${params}`);
        const data     = response.data?.data;
        if (!Array.isArray(data)) throw new Error("Response 'data' is not an array");

        // Back-fill SQLite in the background — do not await
        this._syncToSQLite(data).catch(console.error);

        return data.map(normalizeFromServer);
      } catch (err) {
        console.warn("[periods] API fetch failed, using SQLite:", err.message);
      }
    }

    return this.getAllFromSQLite(includeInactive);
  },

  async getAllFromSQLite(includeInactive = false) {
    const db = await getDatabase();
    await ensureSchema(db);

    const activeFilter = includeInactive ? "" : "AND isactive = 1";
    const rows = await db.getAllAsync(
      `SELECT * FROM ${TABLE}
       WHERE (deletedat IS NULL OR deletedat = '')
       ${activeFilter}
       ORDER BY sortorder ASC, starttime ASC`
    ).catch(() => []);

    return (rows ?? []).map(normalizeFromDb);
  },

  /**
   * Writes server periods into local SQLite.
   * Wrapped in a single transaction for atomicity and performance.
   */
  async _syncToSQLite(periods) {
    if (!Array.isArray(periods) || !periods.length) return;

    const db = await getDatabase();
    await ensureSchema(db);

    await withTransaction(db, async () => {
      for (const p of periods) {
        const n         = normalizeFromApi(p);
        const isDeleted = !!(p.deletedAt || p.deleted_at || p.deletedat);

        try {
          if (isDeleted) {
            await db.runAsync(
              `UPDATE ${TABLE}
               SET deletedat = ?, isactive = 0, _synced = 1, updated_at = ?
               WHERE id = ?`,
              [p.deletedAt || p.deleted_at || p.deletedat, n.updated_at, n.id]
            );
          } else {
            await db.runAsync(
              `INSERT OR REPLACE INTO ${TABLE}
                 (id, schoolId, name, starttime, endtime, sortorder,
                  isbreak, isactive, version, dirty, _synced, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
              [
                n.id, n.schoolId, n.name,
                n.starttime, n.endtime, n.sortorder,
                n.isbreak, n.isactive, n.version, n.updated_at,
              ]
            );
          }
        } catch (err) {
          console.error(`[periods] Failed to cache period ${p?.id}:`, err.message);
          // Do not rethrow — one bad row should not abort the whole batch
        }
      }
    });
  },

  async create({ name, startTime, endTime, isBreak = false, schoolId }) {
    if (!name?.trim())          throw new Error("Period name is required");
    if (!startTime || !endTime) throw new Error("Start and end time are required");

    const startMin = toMinutes(startTime);
    const endMin   = toMinutes(endTime);
    if (startMin === null || endMin === null) throw new Error("Invalid time format — use HH:MM");
    if (endMin <= startMin) throw new Error("End time must be after start time");

    const id  = generateUUID();
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        const response = await api.post("/admin/periods", {
          id, name, startTime, endTime, isBreak, schoolId,
        });
        const created = response.data?.data;
        if (created) {
          await this._syncToSQLite([created]);
          return normalizeFromServer(created);
        }
        return { id, name, startTime, endTime, isBreak, isActive: true };
      } catch (err) {
        if (err.response) throw err;
        console.warn("[periods] API create failed — saving offline");
      }
    }

    // ── Offline path ───────────────────────────────────────────────────────
    const db = await getDatabase();
    await ensureSchema(db);

    // Overlap check — exclude break periods since they can coexist with lessons
    const existing = await db.getAllAsync(
      `SELECT starttime, endtime FROM ${TABLE}
       WHERE (deletedat IS NULL OR deletedat = '')
         AND isactive = 1
         AND (isbreak = 0 OR isbreak IS NULL)`
    ).catch(() => []);

    for (const p of existing) {
      const pStart = toMinutes(p.starttime);
      const pEnd   = toMinutes(p.endtime);
      if (pStart !== null && pEnd !== null && startMin < pEnd && endMin > pStart) {
        throw new Error(`Time overlaps with existing period ${p.starttime}–${p.endtime}`);
      }
    }

    const maxRow = await db.getFirstAsync(
      `SELECT MAX(sortorder) AS maxOrder
       FROM ${TABLE} WHERE (deletedat IS NULL OR deletedat = '')`
    ).catch(() => null);
    const sortorder = (maxRow?.maxOrder ?? 0) + 1;
    const now       = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO ${TABLE}
         (id, schoolId, name, starttime, endtime, sortorder,
          isbreak, isactive, version, dirty, operation,
          _synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 'create', 0, ?, ?)`,
      [id, schoolId, name.trim(), startTime, endTime, sortorder, isBreak ? 1 : 0, now, now]
    );

    return {
      id, name, startTime, endTime, isBreak,
      sortOrder: sortorder, isActive: true, dirty: true,
    };
  },

  async update(id, updates) {
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        const response = await api.put(`/admin/periods/${id}`, updates);
        const updated  = response.data?.data;
        if (updated) await this._syncToSQLite([updated]);
        return updated ? normalizeFromServer(updated) : null;
      } catch (err) {
        if (err.response) throw err;
        console.warn("[periods] API update failed — saving offline");
      }
    }

    const db  = await getDatabase();
    await ensureSchema(db);
    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE ${TABLE}
       SET name       = COALESCE(?, name),
           starttime  = COALESCE(?, starttime),
           endtime    = COALESCE(?, endtime),
           isbreak    = COALESCE(?, isbreak),
           updated_at = ?,
           dirty      = 1,
           _synced    = 0,
           -- COALESCE preserves 'create' for offline-created periods
           -- so the push cycle knows to POST rather than PUT.
           operation  = COALESCE(operation, 'update')
       WHERE id = ?`,
      [
        updates.name      ?? null,
        updates.startTime ?? null,
        updates.endTime   ?? null,
        updates.isBreak !== undefined ? (updates.isBreak ? 1 : 0) : null,
        now, id,
      ]
    );

    return { id, ...updates, dirty: true };
  },

  async toggleActive(id) {
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        const response = await api.patch(`/admin/periods/${id}/toggle`);
        const toggled  = response.data?.data;
        if (toggled) await this._syncToSQLite([toggled]);
        return toggled ? normalizeFromServer(toggled) : null;
      } catch (err) {
        if (err.response) throw err;
      }
    }

    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT isactive FROM ${TABLE} WHERE id = ?`, [id]
    ).catch(() => null);
    if (!row) throw new Error("Period not found");

    const next = row.isactive ? 0 : 1;
    const now  = new Date().toISOString();

    await db.runAsync(
      `UPDATE ${TABLE}
       SET isactive  = ?,
           updated_at = ?,
           dirty      = 1,
           _synced    = 0,
           operation  = COALESCE(operation, 'update')
       WHERE id = ?`,
      [next, now, id]
    );

    return { id, isActive: next === 1, dirty: true };
  },

  async reorder(id, direction) {
    const db  = await getDatabase();
    await ensureSchema(db);
    const all = await this.getAllFromSQLite(true);

    const index = all.findIndex((p) => p.id === id);
    if (index === -1) return false;

    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= all.length) return false;

    const a   = all[index];
    const b   = all[swapIndex];
    const now = new Date().toISOString();

    // Swap sort orders atomically
    await withTransaction(db, async () => {
      await db.runAsync(
        `UPDATE ${TABLE}
         SET sortorder = ?, updated_at = ?, dirty = 1, _synced = 0,
             operation = COALESCE(operation, 'update')
         WHERE id = ?`,
        [b.sortOrder, now, a.id]
      );
      await db.runAsync(
        `UPDATE ${TABLE}
         SET sortorder = ?, updated_at = ?, dirty = 1, _synced = 0,
             operation = COALESCE(operation, 'update')
         WHERE id = ?`,
        [a.sortOrder, now, b.id]
      );
    });

    const net = await NetInfo.fetch();
    if (net.isConnected) {
      try {
        await api.post(`/admin/periods/${id}/reorder`, { direction });

        // Re-pull to make sure local sort order matches server truth
        const response = await api.get("/admin/periods");
        const fresh    = response.data?.data;
        if (Array.isArray(fresh)) {
          await this._syncToSQLite(fresh);
        } else {
          await db.runAsync(
            `UPDATE ${TABLE}
             SET dirty = 0, _synced = 1, operation = NULL
             WHERE id IN (?, ?)`,
            [a.id, b.id]
          );
        }
      } catch {
        // Non-fatal — SyncManager will retry dirty rows on next cycle
      }
    }

    return true;
  },

  async delete(id) {
    const db = await getDatabase();
    await ensureSchema(db);

    // ── Check if period is referenced in the timetable ──────────────────────
    const inUseLegacy = await db.getFirstAsync(
      `SELECT _id FROM timetable
       WHERE period_id = ? AND (deleted_at IS NULL OR deleted_at = '') LIMIT 1`,
      [id]
    ).catch(() => null);

    // Only query timetable_slots if the table actually exists
    // so a missing table is not silently treated as "not in use"
    let inUseNew = null;
    const slotsExists = await tableExists(db, "timetable_slots");
    if (slotsExists) {
      inUseNew = await db.getFirstAsync(
        `SELECT id FROM timetable_slots
         WHERE periodId = ? AND (deletedat IS NULL OR deletedat = '') LIMIT 1`,
        [id]
      ).catch(() => null);
    }

    if (inUseLegacy || inUseNew) {
      throw new Error(
        "Period is referenced in the timetable. Remove those slots first."
      );
    }

    const now = new Date().toISOString();
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        await api.delete(`/admin/periods/${id}`);
        await db.runAsync(
          `UPDATE ${TABLE}
           SET deletedat = ?, updated_at = ?, dirty = 0, _synced = 1, operation = NULL
           WHERE id = ?`,
          [now, now, id]
        );
        console.log(`[periods] Deleted: ${id}`);
        return true;
      } catch (err) {
        if (err?.response?.status === 404) {
          await db.runAsync(
            `UPDATE ${TABLE}
             SET deletedat = ?, updated_at = ?, dirty = 0, _synced = 1
             WHERE id = ?`,
            [now, now, id]
          );
          return true;
        }
        throw err;
      }
    }

    // ── Offline soft-delete — will be pushed by SyncManager ─────────────────
    await db.runAsync(
      `UPDATE ${TABLE}
       SET deletedat = ?, updated_at = ?, dirty = 1, _synced = 0, operation = 'delete'
       WHERE id = ?`,
      [now, now, id]
    );
    console.log(`[periods] Soft-deleted offline: ${id}`);
    return true;
  },

  async getDirtyItems() {
    const db = await getDatabase();
    await ensureSchema(db);
    return db.getAllAsync(`SELECT * FROM ${TABLE} WHERE dirty = 1`).catch(() => []);
  },

  async clearDirty(id) {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE ${TABLE}
       SET dirty = 0, _synced = 1, operation = NULL
       WHERE id = ?`,
      [id]
    );
  },

  async processIncomingSync(periodsFromServer) {
    return this._syncToSQLite(periodsFromServer);
  },
};

export default PeriodsService;