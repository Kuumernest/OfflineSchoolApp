// src/db/dedupHelpers.js
"use strict";

/**
 * dedupHelpers.js
 *
 * Functions for deduplicating SQLite rows and removing ghost records.
 *
 * Problem solved:
 *  - syncAssignments.service.js had invalid SQL with wrong column names
 *    (teacherId, classId instead of teacher_id, class_id)
 *  - Ghost row detection used inconsistent LIKE patterns
 *  - No generic dedup utility existed
 */

import { isServerGeneratedId, isLocalId } from "../utils/idHelpers";
import { withFkOff, NOT_DELETED }         from "./dbHelpers";

// ─── Assignment deduplication ─────────────────────────────────────────────────

/**
 * Removes duplicate rows from `teacher_assignments` where two or more rows
 * share the same (teacher_id, class_id, subject_id) logical key.
 *
 * Strategy: keep the row with the newest `updated_at`, delete the rest.
 *
 * @param {any} db
 * @returns {Promise<number>} Number of rows removed
 */
export const deduplicateAssignments = async (db) => {
  return withFkOff(db, async () => {
    const groups = await db.getAllAsync(`
      SELECT teacher_id, class_id, subject_id, COUNT(*) AS cnt
      FROM   teacher_assignments
      WHERE  ${NOT_DELETED}
      GROUP  BY teacher_id, class_id, subject_id
      HAVING COUNT(*) > 1
    `);

    if (!groups?.length) {
      console.log("[dedup] teacher_assignments: no duplicates");
      return 0;
    }

    console.log(`[dedup] teacher_assignments: ${groups.length} duplicate group(s)`);

    let removed = 0;

    for (const group of groups) {
      const { teacher_id, class_id, subject_id } = group;

      const keeper = await db.getFirstAsync(
        `SELECT id FROM teacher_assignments
         WHERE  teacher_id = ? AND class_id = ? AND subject_id = ?
           AND  ${NOT_DELETED}
         ORDER  BY updated_at DESC, id DESC
         LIMIT  1`,
        [teacher_id, class_id, subject_id]
      );

      if (!keeper) continue;

      const result = await db.runAsync(
        `DELETE FROM teacher_assignments
         WHERE  teacher_id = ? AND class_id = ? AND subject_id = ?
           AND  ${NOT_DELETED}
           AND  id != ?`,
        [teacher_id, class_id, subject_id, keeper.id]
      );

      removed += result?.changes ?? 0;
    }

    console.log(`[dedup] teacher_assignments: removed ${removed} duplicate row(s)`);
    return removed;
  });
};

// ─── Ghost row removal ────────────────────────────────────────────────────────

/**
 * Removes "ghost" rows from `teacher_assignments`.
 *
 * A ghost row:
 *  1. Has never been synced (_synced = 0)
 *  2. Was created more than `maxAgeMs` ago
 *  3. Has an ID that is NOT a valid local ID AND NOT a valid server ID
 *
 * @param {any}    db
 * @param {number} [maxAgeMs=86400000] - 24 hours default
 * @returns {Promise<number>}
 */
export const removeGhostAssignments = async (
  db,
  maxAgeMs = 24 * 60 * 60 * 1000
) => {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const candidates = await db.getAllAsync(
    `SELECT id, created_at FROM teacher_assignments
     WHERE  (_synced = 0 OR _synced IS NULL)
       AND  ${NOT_DELETED}
       AND  created_at < ?`,
    [cutoff]
  );

  if (!candidates?.length) {
    console.log("[ghost] No old unsynced assignments found");
    return 0;
  }

  let removed = 0;

  for (const row of candidates) {
    if (isLocalId(row.id)) {
      // Properly formatted local ID — still waiting for sync, leave it
      continue;
    }

    if (isServerGeneratedId(row.id)) {
      // Has a server-shaped ID but is marked unsynced — fix corrupted state
      await db.runAsync(
        `UPDATE teacher_assignments SET _synced = 1 WHERE id = ?`,
        [row.id]
      );
      console.log(`[ghost] Fixed corrupted sync state: ${row.id}`);
      continue;
    }

    // Malformed ID + old + unsynced = ghost
    await db.runAsync(
      `DELETE FROM teacher_assignments WHERE id = ?`,
      [row.id]
    );
    removed++;
    console.log(`[ghost] Removed ghost row: ${row.id}`);
  }

  console.log(`[ghost] Total ghost rows removed: ${removed}`);
  return removed;
};

// ─── Generic deduplicator ─────────────────────────────────────────────────────

/**
 * Removes duplicate rows from any table using a logical key.
 *
 * @param {any}      db
 * @param {string}   tableName
 * @param {string[]} logicalKey      - Columns that form the unique logical key
 * @param {boolean}  [keepNewest]    - Keep newest by updated_at (default true)
 * @returns {Promise<number>}
 *
 * @example
 * await deduplicateTable(db, "subjects", ["school_id", "name", "class_id"]);
 */
export const deduplicateTable = async (
  db,
  tableName,
  logicalKey,
  keepNewest = true
) => {
  return withFkOff(db, async () => {
    const groupBy = logicalKey.join(", ");
    const orderBy = keepNewest
      ? "updated_at DESC, id DESC"
      : "created_at ASC, id ASC";

    const groups = await db.getAllAsync(`
      SELECT ${groupBy}, COUNT(*) AS cnt
      FROM   ${tableName}
      WHERE  ${NOT_DELETED}
      GROUP  BY ${groupBy}
      HAVING COUNT(*) > 1
    `);

    if (!groups?.length) {
      console.log(`[dedup] ${tableName}: no duplicates`);
      return 0;
    }

    console.log(`[dedup] ${tableName}: ${groups.length} group(s) with duplicates`);

    let removed = 0;

    for (const group of groups) {
      const whereConditions = logicalKey.map((col) => `${col} = ?`).join(" AND ");
      const whereValues     = logicalKey.map((col) => group[col]);

      const keeper = await db.getFirstAsync(
        `SELECT id FROM ${tableName}
         WHERE  ${whereConditions}
           AND  ${NOT_DELETED}
         ORDER  BY ${orderBy}
         LIMIT  1`,
        whereValues
      );

      if (!keeper) continue;

      const result = await db.runAsync(
        `DELETE FROM ${tableName}
         WHERE  ${whereConditions}
           AND  ${NOT_DELETED}
           AND  id != ?`,
        [...whereValues, keeper.id]
      );

      removed += result?.changes ?? 0;
    }

    console.log(`[dedup] ${tableName}: removed ${removed} row(s)`);
    return removed;
  });
};

// ─── Convenience export ───────────────────────────────────────────────────────

/**
 * Runs all cleanup operations for teacher assignments.
 * Call before and after a sync cycle.
 *
 * @param {any} db
 * @returns {Promise<{ ghosts: number, duplicates: number }>}
 */
export const cleanupAssignments = async (db) => {
  const ghosts     = await removeGhostAssignments(db);
  const duplicates = await deduplicateAssignments(db);
  return { ghosts, duplicates };
};