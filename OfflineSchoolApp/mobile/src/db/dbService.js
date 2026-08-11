// src/db/dbService.js
"use strict";

import { getDatabase } from "./database";

// ─────────────────────────────────────────────────────────
// DB — thin wrapper around expo-sqlite getDatabase()
// Provides a consistent query interface used across services.
// ─────────────────────────────────────────────────────────

export const DB = {

  /**
   * Run a SELECT and return all matching rows.
   * Never throws — returns [] on any error.
   *
   * @param {string}  sql
   * @param {any[]}   params
   * @returns {Promise<object[]>}
   */
  async query(sql, params = []) {
    try {
      const db   = await getDatabase();
      const rows = await db.getAllAsync(sql, params);
      return rows ?? [];
    } catch (err) {
      console.warn(
        "[DB.query] failed:", err.message,
        "\nSQL:", sql.slice(0, 120)
      );
      return [];
    }
  },

  /**
   * Run a SELECT and return the first matching row.
   * Returns null if no row found or on error.
   *
   * @param {string}  sql
   * @param {any[]}   params
   * @returns {Promise<object|null>}
   */
  async queryFirst(sql, params = []) {
    try {
      const db  = await getDatabase();
      const row = await db.getFirstAsync(sql, params);
      return row ?? null;
    } catch (err) {
      console.warn(
        "[DB.queryFirst] failed:", err.message,
        "\nSQL:", sql.slice(0, 120)
      );
      return null;
    }
  },

  /**
   * Run an INSERT / UPDATE / DELETE.
   * Returns the result object (changes, lastInsertRowId) or null on error.
   *
   * @param {string}  sql
   * @param {any[]}   params
   * @returns {Promise<object|null>}
   */
  async run(sql, params = []) {
    try {
      const db     = await getDatabase();
      const result = await db.runAsync(sql, params);
      return result ?? null;
    } catch (err) {
      console.warn(
        "[DB.run] failed:", err.message,
        "\nSQL:", sql.slice(0, 120)
      );
      return null;
    }
  },

  /**
   * Execute one or more SQL statements with no return value.
   * Useful for CREATE TABLE, DROP TABLE, etc.
   *
   * @param {string} sql
   * @returns {Promise<void>}
   */
  async exec(sql) {
    try {
      const db = await getDatabase();
      await db.execAsync(sql);
    } catch (err) {
      console.warn(
        "[DB.exec] failed:", err.message,
        "\nSQL:", sql.slice(0, 120)
      );
    }
  },

  /**
   * Return the column names for a table.
   * Returns [] if table doesn't exist or on error.
   *
   * @param {string} tableName
   * @returns {Promise<string[]>}
   */
  async getColumns(tableName) {
    try {
      const db   = await getDatabase();
      const rows = await db.getAllAsync(
        `PRAGMA table_info(${tableName})`, []
      );
      return (rows ?? []).map((r) => r.name);
    } catch {
      return [];
    }
  },

  /**
   * Return true if a table exists in the database.
   *
   * @param {string} tableName
   * @returns {Promise<boolean>}
   */
  async tableExists(tableName) {
    try {
      const db  = await getDatabase();
      const row = await db.getFirstAsync(
        `SELECT COUNT(*) as count
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
      );
      return (row?.count ?? 0) > 0;
    } catch {
      return false;
    }
  },

  /**
   * Return all table names in the database.
   *
   * @returns {Promise<string[]>}
   */
  async getTableNames() {
    try {
      const db   = await getDatabase();
      const rows = await db.getAllAsync(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`,
        []
      );
      return (rows ?? []).map((r) => r.name);
    } catch {
      return [];
    }
  },

  /**
   * Run multiple statements inside a single transaction.
   * Rolls back automatically on error.
   *
   * @param {(db: object) => Promise<void>} fn
   * @returns {Promise<boolean>} true on success, false on error
   */
  async transaction(fn) {
    try {
      const db = await getDatabase();
      await db.withTransactionAsync(async () => {
        await fn(db);
      });
      return true;
    } catch (err) {
      console.warn("[DB.transaction] failed:", err.message);
      return false;
    }
  },
};

export default DB;