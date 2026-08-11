// src/services/syncQueue.service.js
"use strict";

/**
 * syncQueue.service.js
 *
 * A persistent, SQLite-backed queue for operations that need to be
 * sent to the server but may have been created while offline.
 *
 * Fixed issues:
 *  #C2 — schemaVerified flag replaced with ensureTableSchema
 *  #C5 — generateId replaced with generateUUID from idHelpers
 */

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { generateUUID }      from "../utils/idHelpers";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SCHEMA
// ═════════════════════════════════════════════════════════════════════════════

const TABLE = "sync_queue";

/**
 * Ensures the sync_queue table exists.
 * Uses ensureTableSchema so failures are tracked and retried (fixes #C2).
 *
 * NOTE: expo-sqlite does NOT support multi-statement execAsync strings.
 * Each DDL statement is its own call.
 *
 * @param {any} db
 */
const ensureSchema = (db) =>
  ensureTableSchema(
    TABLE,
    async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id          TEXT PRIMARY KEY,
          operation   TEXT NOT NULL,
          collection  TEXT NOT NULL,
          documentId  TEXT,
          payload     TEXT NOT NULL DEFAULT '{}',
          status      TEXT NOT NULL DEFAULT 'pending',
          retryCount  INTEGER DEFAULT 0,
          locked      INTEGER DEFAULT 0,
          created_at  TEXT,
          lastAttempt TEXT,
          error       TEXT
        )
      `);

      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_sync_queue_status
          ON ${TABLE}(status, locked, created_at)
      `).catch(() => {});

      console.log("[syncQueue] Schema ready");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PAYLOAD HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const toJson = (value) => {
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
};

const fromJson = (raw) => {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
};

const hydrateRow = (row) => ({ ...row, payload: fromJson(row.payload) });

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — SERVICE CLASS
// ═════════════════════════════════════════════════════════════════════════════

export class SyncQueueService {

  /**
   * Adds a new operation to the queue.
   *
   * @param {string}      operation  - e.g. "CREATE", "UPDATE", "DELETE"
   * @param {string}      collection - e.g. "classes", "subjects"
   * @param {string|null} documentId
   * @param {object}      payload
   * @returns {Promise<string>} New queue entry ID
   */
  static async enqueue(operation, collection, documentId, payload) {
    const db = await getDatabase();
    await ensureSchema(db);

    const id = generateUUID();   // fixes #C5
    const ts = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO ${TABLE}
         (id, operation, collection, documentId, payload,
          status, retryCount, locked, created_at, lastAttempt, error)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, NULL, NULL)`,
      [id, operation, collection, documentId ?? null, toJson(payload), ts]
    );

    return id;
  }

  /**
   * Returns unlocked rows that are ready to be processed.
   *
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  static async getPendingOperations(limit = 50) {
    const db = await getDatabase();
    await ensureSchema(db);

    const rows = await db.getAllAsync(
      `SELECT *
       FROM   ${TABLE}
       WHERE  (status = 'pending' OR status = 'failed')
         AND  locked = 0
       ORDER  BY created_at ASC
       LIMIT  ?`,
      [limit]
    );

    return (rows ?? []).map(hydrateRow);
  }

  /**
   * Marks a row as locked so concurrent sync loops don't double-process it.
   * @param {string} id
   */
  static async lock(id) {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE ${TABLE} SET locked = 1, lastAttempt = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
  }

  /**
   * Releases a lock without changing the row's status.
   * @param {string} id
   */
  static async unlock(id) {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE ${TABLE} SET locked = 0 WHERE id = ?`, [id]
    );
  }

  /**
   * Marks a queue entry as successfully synced.
   * @param {string} id
   */
  static async markSynced(id) {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE ${TABLE} SET status = 'synced', error = NULL, locked = 0 WHERE id = ?`,
      [id]
    );
  }

  /**
   * Records a failure. After MAX_RETRIES the row becomes 'dead'.
   *
   * @param {string} id
   * @param {string} errorMsg
   * @param {number} [retryCount=0]
   */
  static async markFailed(id, errorMsg, retryCount = 0) {
    const MAX_RETRIES = 5;
    const db          = await getDatabase();
    const nextRetry   = retryCount + 1;
    const isDead      = nextRetry >= MAX_RETRIES;

    await db.runAsync(
      `UPDATE ${TABLE}
       SET status = ?, error = ?, retryCount = ?, locked = 0
       WHERE id = ?`,
      [isDead ? "dead" : "failed", errorMsg, nextRetry, id]
    );

    if (isDead) {
      console.warn(`[syncQueue] 💀 Entry ${id} dead after ${nextRetry} retries`);
    }
  }

  /** @returns {Promise<number>} */
  static async getPendingCount() {
    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM ${TABLE} WHERE status = 'pending'`
    );
    return row?.count ?? 0;
  }

  /** @returns {Promise<number>} */
  static async getFailedCount() {
    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM ${TABLE} WHERE status = 'failed'`
    );
    return row?.count ?? 0;
  }

  /** @returns {Promise<number>} */
  static async getDeadCount() {
    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM ${TABLE} WHERE status = 'dead'`
    );
    return row?.count ?? 0;
  }

  /**
   * Returns all status counts in a single DB call.
   * @returns {Promise<{ pending, failed, dead, synced }>}
   */
  static async getCounts() {
    const db   = await getDatabase();
    await ensureSchema(db);
    const rows = await db.getAllAsync(
      `SELECT status, COUNT(*) AS count FROM ${TABLE} GROUP BY status`
    );
    const counts = { pending: 0, failed: 0, dead: 0, synced: 0 };
    for (const row of rows ?? []) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = row.count;
    }
    return counts;
  }

  /**
   * Removes synced rows older than `daysToKeep` days.
   * @param {number} [daysToKeep=7]
   * @returns {Promise<number>}
   */
  static async cleanup(daysToKeep = 7) {
    const db     = await getDatabase();
    await ensureSchema(db);
    const result = await db.runAsync(
      `DELETE FROM ${TABLE}
       WHERE status = 'synced' AND created_at < datetime('now', ?)`,
      [`-${daysToKeep} days`]
    );
    const removed = result?.changes ?? 0;
    if (removed > 0) {
      console.log(`[syncQueue] 🧹 Removed ${removed} synced row(s)`);
    }
    return removed;
  }

  /**
   * Releases locks held longer than `staleMinutes`.
   * @param {number} [staleMinutes=10]
   * @returns {Promise<number>}
   */
  static async unlockStale(staleMinutes = 10) {
    const db     = await getDatabase();
    await ensureSchema(db);
    const result = await db.runAsync(
      `UPDATE ${TABLE} SET locked = 0
       WHERE locked = 1 AND lastAttempt < datetime('now', ?)`,
      [`-${staleMinutes} minutes`]
    );
    const unlocked = result?.changes ?? 0;
    if (unlocked > 0) console.warn(`[syncQueue] 🔓 Released ${unlocked} stale lock(s)`);
    return unlocked;
  }

  /**
   * Logs and returns the 20 most recent queue entries.
   * @returns {Promise<object[]>}
   */
  static async debugAll() {
    const db = await getDatabase();
    await ensureSchema(db);

    const rows = await db.getAllAsync(
      `SELECT id, operation, collection, status, retryCount, locked, created_at, error
       FROM   ${TABLE}
       ORDER  BY created_at DESC
       LIMIT  20`
    );

    console.log(`[syncQueue] 🔍 ${rows.length} most recent entries:`);
    for (const r of rows ?? []) {
      console.log(
        `  [${r.status}] ${r.operation} ${r.collection} | ` +
        `retries=${r.retryCount} | locked=${r.locked} | id=${r.id}`
      );
      if (r.error) console.log(`    error: ${r.error}`);
    }

    return rows ?? [];
  }
}

export default SyncQueueService;