// src/db/dbHelpers.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DATABASE HELPERS — expo-sqlite utilities
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Shared SQLite utility functions used across all service files.
 *
 * Transaction design:
 *
 *   #TX1 — withTransaction uses db.withTransactionAsync (expo-sqlite's
 *           own transaction manager) where available, falling back to
 *           manual BEGIN/COMMIT for older versions.
 *
 *   #TX2 — withFkOff does NOT open a transaction itself. FK pragmas and
 *           transactions are orthogonal concerns. Callers that need both
 *           should call withFkOff first, then withTransaction inside fn.
 *
 *   #TX5 — Nesting guard is checked BEFORE withTransactionAsync is called.
 *           If this connection already has an open transaction, fn() runs
 *           directly inside it rather than opening a nested transaction.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Table Introspection ───────────────────────────────────────────────────

/**
 * Returns true if the named table exists in the database.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
export const tableExists = async (db, tableName) => {
  try {
    const row = await db.getFirstAsync(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = ? LIMIT 1`,
      [tableName]
    );
    return !!row;
  } catch {
    return false;
  }
};

/**
 * Returns an array of column names for the given table.
 * Returns [] if the table does not exist or the query fails.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {string} tableName
 * @returns {Promise<string[]>}
 */
export const getTableColumns = async (db, tableName) => {
  try {
    const rows = await db.getAllAsync(`PRAGMA table_info(${tableName})`);
    return (rows ?? []).map((r) => r.name);
  } catch {
    return [];
  }
};

/**
 * Finds the first column name from `candidates` that actually exists
 * in the table's column list.
 *
 * @param {string[]} existingColumns - Column names from getTableColumns()
 * @param {string[]} candidates      - Ordered list of possible column names
 * @returns {string | null}
 */
export const pickColumn = (existingColumns, candidates) => {
  const colSet = new Set(existingColumns);
  for (const candidate of candidates) {
    if (colSet.has(candidate)) return candidate;
  }
  return null;
};

// ── Schema Mutation Helpers ───────────────────────────────────────────────

/**
 * Adds a column to an existing table.
 * Silently succeeds if the column already exists.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {string} table
 * @param {string} col
 * @param {string} def   SQLite type + constraint, e.g. "TEXT DEFAULT NULL"
 * @returns {Promise<boolean>} true if added, false if already existed
 */
export const safeAddColumn = async (db, table, col, def) => {
  try {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    return true;
  } catch (err) {
    if (err?.message?.toLowerCase().includes("duplicate column")) {
      return false;
    }
    console.warn(
      `[db] Could not add column "${col}" to "${table}":`,
      err.message
    );
    return false;
  }
};

/**
 * Ensure a table exists. Pass the full CREATE TABLE IF NOT EXISTS SQL.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {string} createSql
 * @returns {Promise<void>}
 */
export const ensureTable = async (db, createSql) => {
  try {
    await db.execAsync(createSql);
  } catch (err) {
    console.warn("[ensureTable] failed:", err.message);
  }
};

// ── Transaction Wrapper ───────────────────────────────────────────────────

/**
 * Runs `fn` with PRAGMA foreign_keys = OFF and restores it afterwards.
 *
 * #TX2 — Does NOT open a transaction. If the caller also needs a
 * transaction it should call withTransaction inside fn.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {(db: any) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export const withFkOff = async (db, fn) => {
  try {
    await db.execAsync("PRAGMA foreign_keys = OFF");
    return await fn(db);
  } finally {
    await db.execAsync("PRAGMA foreign_keys = ON").catch(() => {});
  }
};

/**
 * Runs `fn` inside a single SQLite transaction.
 * Rolls back automatically if `fn` throws.
 *
 * #TX1 — Uses db.withTransactionAsync where available.
 * #TX5 — Nesting guard checked BEFORE any transaction API is called.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {(db: any) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export const withTransaction = async (db, fn) => {
  // ── Nesting guard ─────────────────────────────────────────────────────
  // MUST be checked before any SQLite API call.
  // Keyed on the db instance so each connection tracks state independently.
  if (!withTransaction._locks) {
    withTransaction._locks = new WeakMap();
  }

  if (withTransaction._locks.get(db)) {
    // Already inside a transaction on this connection.
    // Run fn() directly — its writes join the existing transaction.
    return fn(db);
  }

  // Acquire lock before opening transaction
  withTransaction._locks.set(db, true);

  try {
    // Preferred path: expo-sqlite native transaction manager
    if (typeof db.withTransactionAsync === "function") {
      return await db.withTransactionAsync(() => fn(db));
    }

    // Fallback: manual BEGIN / COMMIT (expo-sqlite < 13)
    await db.execAsync("BEGIN");
    try {
      const result = await fn(db);
      await db.execAsync("COMMIT");
      return result;
    } catch (err) {
      await db.execAsync("ROLLBACK").catch(() => {});
      throw err;
    }

  } finally {
    // Always release lock so future calls on this connection work correctly
    withTransaction._locks.set(db, false);
  }
};

// ── Query Building ────────────────────────────────────────────────────────

/**
 * Standard soft-delete filter clause.
 * Covers three storage patterns:
 *   - deleted_at absent  (old rows before soft-delete was added)
 *   - deleted_at = NULL  (normal active records)
 *   - deleted_at = ''    (legacy — some services stored empty string)
 */
export const NOT_DELETED =
  "(deleted_at IS NULL OR deleted_at = '' OR deleted_at NOT LIKE '20%')";

/**
 * Filter clause for soft-deleted records (inverse of NOT_DELETED).
 */
export const IS_DELETED =
  "(deleted_at IS NOT NULL AND deleted_at != '' AND deleted_at LIKE '20%')";

/**
 * Builds a safe SQL IN clause with its parameter array.
 * Handles the empty-array case (SQLite crashes on `IN ()`).
 *
 * @param {unknown[]} values
 * @param {string}    [colName]
 * @returns {{ clause: string, params: unknown[] }}
 *
 * @example
 * const { clause, params } = buildInClause(classIds, "class_id");
 * // []    → { clause: "1=0",              params: [] }
 * // ["a"] → { clause: "class_id IN (?)", params: ["a"] }
 */
export const buildInClause = (values, colName) => {
  if (!Array.isArray(values) || values.length === 0) {
    return { clause: "1=0", params: [] };
  }
  const placeholders = values.map(() => "?").join(",");
  const clause = colName
    ? `${colName} IN (${placeholders})`
    : `IN (${placeholders})`;
  return { clause, params: [...values] };
};

// ── Safe Query Wrappers ───────────────────────────────────────────────────

/**
 * Run a SELECT and return all rows.
 * Returns [] on error instead of throwing.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {string}    sql
 * @param {unknown[]} params
 * @param {string}    [label]  Optional label for debug logging
 * @returns {Promise<any[]>}
 */
export const safeQuery = async (db, sql, params = [], label) => {
  try {
    const rows = await db.getAllAsync(sql, params);
    if (label) {
      console.log(`[db] ${label}: ${rows?.length ?? 0} row(s)`);
    }
    return rows ?? [];
  } catch (err) {
    console.warn("[safeQuery] failed:", err.message, "\nSQL:", sql);
    return [];
  }
};

/**
 * Run an INSERT / UPDATE / DELETE statement.
 * Returns null on error instead of throwing.
 *
 * @param {import('expo-sqlite').SQLiteDatabase} db
 * @param {string}    sql
 * @param {unknown[]} params
 * @returns {Promise<import('expo-sqlite').SQLiteRunResult | null>}
 */
export const safeRun = async (db, sql, params = []) => {
  try {
    return await db.runAsync(sql, params);
  } catch (err) {
    console.warn("[safeRun] failed:", err.message);
    return null;
  }
};