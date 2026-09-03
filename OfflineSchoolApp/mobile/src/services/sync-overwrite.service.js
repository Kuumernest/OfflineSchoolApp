// src/services/sync-overwrite.service.js
"use strict";

/**
 * sync-overwrite.service.js
 *
 * Local storage for LWW overwrite records received from the server.
 *
 * When an admin's edit silently overwrites a more recent edit from
 * another admin, the server logs it and returns an `overwrote` object
 * in the response. This service persists those records so the losing
 * admin can review them on the dashboard.
 */

import { getDatabase } from "../db/database";

// ─────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────

const TABLE = "sync_overwrites";

let schemaVerified = false;

const ensureSchema = async (db) => {
  if (schemaVerified) return;

  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id                  TEXT PRIMARY KEY,
        entity_type         TEXT NOT NULL,
        entity_id           TEXT NOT NULL,
        entity_name         TEXT,
        school_id           TEXT,
        overwritten_by      TEXT,
        overwritten_by_name TEXT,
        overwritten_at      TEXT,
        new_action          TEXT,
        lost_edit_by        TEXT,
        lost_edit_by_name   TEXT,
        lost_edit_at        TEXT,
        lost_version        TEXT,
        seen_by_loser       INTEGER DEFAULT 0,
        seen_at             TEXT,
        created_at          TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_overwrites_school
        ON ${TABLE}(school_id, seen_by_loser)
    `).catch(() => {});

    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_overwrites_entity
        ON ${TABLE}(entity_type, entity_id)
    `).catch(() => {});

    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_overwrites_created
        ON ${TABLE}(created_at DESC)
    `).catch(() => {});

    schemaVerified = true;
    console.log("[sync-overwrite] Schema ready");
  } catch (err) {
    console.warn("[sync-overwrite] Schema setup failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

export const SyncOverwriteService = {

  /**
   * Save an overwrite record returned from the server.
   *
   * @param {object} overwrote - The `overwrote` object from server response.
   *   Expected shape: { id, lostEditAt, lostEditBy, ... }
   * @param {object} ctx - Additional context about the mutation.
   * @param {string} ctx.entityType   - e.g. "student"
   * @param {string} ctx.entityId     - The record's ID
   * @param {string} [ctx.entityName] - Display label
   * @param {string} [ctx.schoolId]
   * @param {string} [ctx.action]     - "suspend", "restore", "delete", "move"
   * @returns {Promise<string|null>} The saved record's ID, or null on failure.
   */
  async saveOverwrite(overwrote, ctx = {}) {
    if (!overwrote || !overwrote.id) {
      console.warn("[sync-overwrite] saveOverwrite: missing overwrote or id");
      return null;
    }

    try {
      const db = await getDatabase();
      await ensureSchema(db);

      const id = String(overwrote.id);

      await db.runAsync(
        `INSERT INTO ${TABLE} (
           id, entity_type, entity_id, entity_name, school_id,
           overwritten_by, overwritten_by_name, overwritten_at,
           new_action, lost_edit_by, lost_edit_by_name, lost_edit_at,
           lost_version, seen_by_loser, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO NOTHING`,
        [
          id,
          ctx.entityType || "unknown",
          ctx.entityId   || "",
          ctx.entityName || null,
          ctx.schoolId   || null,
          overwrote.overwrittenBy     || null,
          overwrote.overwrittenByName || null,
          overwrote.overwrittenAt     || new Date().toISOString(),
          ctx.action                  || null,
          overwrote.lostEditBy        || null,
          overwrote.lostEditBy        || null,   // some responses only send one field
          overwrote.lostEditAt        || null,
          overwrote.lostVersion
            ? JSON.stringify(overwrote.lostVersion)
            : null,
          new Date().toISOString(),
        ]
      );

      console.log(
        `[sync-overwrite] 💾 Saved overwrite ${id} for ${ctx.entityType}/${ctx.entityId}`
      );

      return id;
    } catch (err) {
      console.warn("[sync-overwrite] saveOverwrite failed:", err.message);
      return null;
    }
  },

  /**
   * Count unseen overwrites for the dashboard tile.
   *
   * @param {string} [schoolId] - Optional filter by school.
   * @returns {Promise<number>}
   */
  async getUnseenCount(schoolId = null) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);

      let q = `SELECT COUNT(*) AS count FROM ${TABLE} WHERE seen_by_loser = 0`;
      const params = [];
      if (schoolId) {
        q += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }

      const row = await db.getFirstAsync(q, params);
      return row?.count ?? 0;
    } catch (err) {
      console.warn("[sync-overwrite] getUnseenCount failed:", err.message);
      return 0;
    }
  },

  /**
   * List all overwrites, most recent first.
   *
   * @param {object} [opts]
   * @param {string}  [opts.schoolId]
   * @param {boolean} [opts.unseenOnly=false]
   * @param {number}  [opts.limit=100]
   * @returns {Promise<object[]>}
   */
  async getAllOverwrites({
    schoolId    = null,
    unseenOnly  = false,
    limit       = 100,
  } = {}) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);

      let q = `SELECT * FROM ${TABLE} WHERE 1=1`;
      const params = [];

      if (schoolId) {
        q += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }
      if (unseenOnly) {
        q += ` AND seen_by_loser = 0`;
      }

      q += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      const rows = await db.getAllAsync(q, params);

      // Parse lost_version JSON blobs back to objects
      return (rows || []).map((r) => ({
        ...r,
        lost_version: r.lost_version ? safeParseJson(r.lost_version) : null,
      }));
    } catch (err) {
      console.warn("[sync-overwrite] getAllOverwrites failed:", err.message);
      return [];
    }
  },

  /**
   * Fetch a single overwrite by ID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    if (!id) return null;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      const row = await db.getFirstAsync(
        `SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!row) return null;
      return {
        ...row,
        lost_version: row.lost_version ? safeParseJson(row.lost_version) : null,
      };
    } catch (err) {
      console.warn("[sync-overwrite] getById failed:", err.message);
      return null;
    }
  },

  /**
   * Mark an overwrite as seen (removes it from the dashboard tile count).
   *
   * @param {string} id
   */
  async markAsSeen(id) {
    if (!id) return;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      await db.runAsync(
        `UPDATE ${TABLE} SET seen_by_loser = 1, seen_at = ? WHERE id = ?`,
        [new Date().toISOString(), id]
      );
    } catch (err) {
      console.warn("[sync-overwrite] markAsSeen failed:", err.message);
    }
  },

  /**
   * Mark ALL unseen overwrites as seen (bulk dismiss).
   *
   * @param {string} [schoolId]
   */
  async markAllAsSeen(schoolId = null) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);

      let q = `UPDATE ${TABLE} SET seen_by_loser = 1, seen_at = ? WHERE seen_by_loser = 0`;
      const params = [new Date().toISOString()];
      if (schoolId) {
        q += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }

      const result = await db.runAsync(q, params);
      console.log(`[sync-overwrite] Marked ${result?.changes ?? 0} as seen`);
    } catch (err) {
      console.warn("[sync-overwrite] markAllAsSeen failed:", err.message);
    }
  },

  /**
   * Delete an overwrite record permanently.
   *
   * @param {string} id
   */
  async deleteOverwrite(id) {
    if (!id) return;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      await db.runAsync(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    } catch (err) {
      console.warn("[sync-overwrite] deleteOverwrite failed:", err.message);
    }
  },

  /**
   * Cleanup: remove overwrites older than N days that have been seen.
   *
   * @param {number} [daysToKeep=30]
   * @returns {Promise<number>} Number of rows removed.
   */
  async cleanup(daysToKeep = 30) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      const result = await db.runAsync(
        `DELETE FROM ${TABLE}
         WHERE seen_by_loser = 1
           AND created_at < datetime('now', ?)`,
        [`-${daysToKeep} days`]
      );
      const removed = result?.changes ?? 0;
      if (removed > 0) {
        console.log(`[sync-overwrite] 🧹 Cleaned ${removed} old overwrite(s)`);
      }
      return removed;
    } catch (err) {
      console.warn("[sync-overwrite] cleanup failed:", err.message);
      return 0;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const safeParseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export default SyncOverwriteService;