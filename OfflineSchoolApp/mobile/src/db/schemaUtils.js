// src/db/schemaUtils.js
"use strict";

/**
 * schemaUtils.js
 *
 * Runtime column name resolver.
 *
 * Purpose:
 *  The SQLite tables in this app were created at different points in time.
 *  Some columns ended up snake_case (school_id) and some camelCase (schoolId)
 *  with no consistency between tables.
 *
 *  Rather than hardcoding one convention per query and crashing with
 *  "no such column", every query that touches an ambiguous column should
 *  resolve it here first.
 *
 * Relationship with schema.js / dbHelpers.js:
 *  - schema.js defines what SHOULD exist (canonical definition)
 *  - schemaUtils.js resolves what DOES exist at runtime (adapter)
 */

import { DB } from "./dbService";

// ─── Column cache ─────────────────────────────────────────────────────────────

/**
 * In-memory column cache.
 * Shape: { [tableName: string]: Set<string> }
 * @type {Record<string, Set<string>>}
 */
const columnCache = {};

/**
 * In-flight PRAGMA promises, keyed by table name.
 * Prevents duplicate concurrent PRAGMA calls for the same table.
 * @type {Record<string, Promise<Set<string>>>}
 */
const pendingPragma = {};

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Returns a Set of column names for the given table.
 * Uses in-memory cache and deduplicates concurrent callers.
 *
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function getTableColumns(table) {
  // Cache hit
  if (columnCache[table]) return columnCache[table];

  // In-flight deduplication
  if (pendingPragma[table]) return pendingPragma[table];

  // Run PRAGMA
  const promise = (async () => {
    try {
      const info = await DB.query(`PRAGMA table_info(${table})`, []);
      const cols = new Set((info ?? []).map((c) => c.name));
      columnCache[table] = cols;
      return cols;
    } catch (err) {
      // Do NOT cache the error — allow retry on next call
      throw new Error(
        `[schemaUtils] Failed to read column info for "${table}": ${err.message}`
      );
    } finally {
      delete pendingPragma[table];
    }
  })();

  pendingPragma[table] = promise;
  return promise;
}

// ─── Public resolvers ─────────────────────────────────────────────────────────

/**
 * Resolves the actual column name for `table` from an ordered list of
 * candidates. Throws a descriptive error if none match.
 *
 * @param {string}   table
 * @param {string[]} candidates
 * @returns {Promise<string>}
 * @throws  {Error}
 *
 * @example
 * const col = await resolveColumn("students", COL.SCHOOL_ID);
 * const rows = await db.getAllAsync(
 *   `SELECT * FROM students WHERE ${col} = ?`, [schoolId]
 * );
 */
export async function resolveColumn(table, candidates) {
  const cols  = await getTableColumns(table);
  const found = candidates.find((c) => cols.has(c));

  if (!found) {
    throw new Error(
      `[schemaUtils] Table "${table}" has none of the expected columns: ` +
      `[${candidates.join(" | ")}]. ` +
      `Actual columns: [${[...cols].join(", ")}]. ` +
      `Run a migration or update the COL candidates list.`
    );
  }

  return found;
}

/**
 * Same as resolveColumn but returns null instead of throwing when no
 * candidate matches. Use for truly optional columns (e.g. deleted_at).
 *
 * @param {string}   table
 * @param {string[]} candidates
 * @returns {Promise<string|null>}
 */
export async function resolveColumnOptional(table, candidates) {
  try {
    return await resolveColumn(table, candidates);
  } catch {
    return null;
  }
}

/**
 * Resolves several candidate groups for one table in a single call.
 *
 * @param {string}                       table
 * @param {Record<string, string[]>}     groups
 * @param {string[]}                     [optionalKeys]
 * @returns {Promise<Record<string, string|null>>}
 *
 * @example
 * const cols = await resolveColumns("teacher_assignments", {
 *   schoolCol:  COL.SCHOOL_ID,
 *   classCol:   COL.CLASS_ID,
 *   teacherCol: COL.TEACHER_ID,
 *   deletedCol: COL.DELETED_AT,
 * }, ["deletedCol"]);
 */
export async function resolveColumns(table, groups, optionalKeys = []) {
  const entries = await Promise.all(
    Object.entries(groups).map(async ([key, candidates]) => {
      const value = optionalKeys.includes(key)
        ? await resolveColumnOptional(table, candidates)
        : await resolveColumn(table, candidates);
      return [key, value];
    })
  );
  return Object.fromEntries(entries);
}

// ─── Candidate lists ──────────────────────────────────────────────────────────

/**
 * Canonical candidate lists for ambiguous column names.
 *
 * Ordering: [0] Preferred snake_case, [1] Legacy camelCase alias
 *
 * @type {Record<string, readonly string[]>}
 */
export const COL = Object.freeze({
  // Foreign keys
  SCHOOL_ID:      ["school_id",   "schoolId"],
  CLASS_ID:       ["class_id",    "classId"],
  STUDENT_ID:     ["student_id",  "studentId"],
  SUBJECT_ID:     ["subject_id",  "subjectId"],
  TEACHER_ID:     ["teacher_id",  "teacherId"],
  PERIOD_ID:      ["period_id",   "periodId"],
  EXAM_ID:        ["exam_id",     "examId"],
  USER_ID:        ["user_id",     "userId"],

  // Academic
  ACADEMIC_YEAR:  ["academic_year", "academicYear"],
  CLASS_NAME:     ["class_name",  "className"],
  SUBJECT_NAME:   ["subject_name","subjectName"],

  // Scores
  CA_SCORE:       ["ca_score",    "caScore"],
  EXAM_SCORE:     ["exam_score",  "examScore"],
  TOTAL_SCORE:    ["total_score", "totalScore"],

  // Status / flags
  IS_ACTIVE:      ["is_active",   "isActive"],
  IS_SYNCED:      ["_synced",     "is_synced",  "isSynced"],

  // Timestamps (optional — legacy tables may lack these)
  DELETED_AT:     ["deleted_at",  "deletedAt"],
  CREATED_AT:     ["created_at",  "createdAt"],
  UPDATED_AT:     ["updated_at",  "updatedAt"],
  SYNCED_AT:      ["_synced_at",  "synced_at",  "syncedAt"],

  // Timetable
  DAY_OF_WEEK:    ["day_of_week", "dayOfWeek"],

  // Guardian
  GUARDIAN_NAME:  ["guardian_name",  "guardianName"],
  GUARDIAN_PHONE: ["guardian_phone", "guardianPhone"],
  GUARDIAN_EMAIL: ["guardian_email", "guardianEmail"],

  // Admission
  ADMISSION_NO:   ["admission_no", "admissionNo", "admissionNumber"],
});

// ─── Soft-delete clause builder ───────────────────────────────────────────────

/**
 * Builds a soft-delete WHERE clause fragment for a table.
 * Returns "" if the table has no deleted_at column.
 *
 * @param {string}  table
 * @param {string}  [tableAlias]
 * @returns {Promise<string>}
 *
 * @example
 * const softDelete = await buildSoftDeleteClause("teacher_assignments", "ta");
 * // → "AND (ta.deleted_at IS NULL OR ta.deleted_at = '')"
 * // OR → "" if the table has no deleted_at column
 */
export async function buildSoftDeleteClause(table, tableAlias) {
  const col = await resolveColumnOptional(table, COL.DELETED_AT);
  if (!col) return "";

  const qualified = tableAlias ? `${tableAlias}.${col}` : col;
  return `AND (${qualified} IS NULL OR ${qualified} = '')`;
}

// ─── Cache management ─────────────────────────────────────────────────────────

/**
 * Invalidates the column cache for a single table.
 *
 * @param {string} table
 */
export function invalidateTableCache(table) {
  delete columnCache[table];
  delete pendingPragma[table];
  console.log(`[schemaUtils] Cache invalidated for "${table}"`);
}

/**
 * Clears the entire column cache.
 */
export function clearSchemaCache() {
  for (const key of Object.keys(columnCache)) delete columnCache[key];
  for (const key of Object.keys(pendingPragma)) delete pendingPragma[key];
  console.log("[schemaUtils] Full column cache cleared");
}

/**
 * Returns a snapshot of the current cache contents.
 *
 * @returns {Record<string, string[]>}
 */
export function getCacheSnapshot() {
  return Object.fromEntries(
    Object.entries(columnCache).map(([table, cols]) => [
      table,
      [...cols].sort(),
    ])
  );
}