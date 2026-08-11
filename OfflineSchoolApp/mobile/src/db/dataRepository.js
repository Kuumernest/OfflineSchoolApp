// src/db/dataRepository.js
"use strict";

import { DB } from "./dbService";

// ─────────────────────────────────────────────────────────
// TRANSFORM HELPERS
// ─────────────────────────────────────────────────────────

const toDB = (obj) => {
  const now = new Date().toISOString();
  return {
    ...obj,
    created_at: obj.created_at || now,
    updated_at: now,
    _synced:    obj._synced ?? 0,
    deleted_at: obj.deleted_at || null,
  };
};

const fromDB = (row) => {
  if (!row) return null;
  return {
    ...row,
    _synced: Boolean(row._synced),
  };
};

// ─────────────────────────────────────────────────────────
// DATA REPOSITORY
// ─────────────────────────────────────────────────────────

export const DataRepository = {

  /**
   * Upsert a record into a table.
   * Requires the object to have an `id` field.
   */
  async save(table, model) {
    if (!model.id) throw new Error(`DataRepository.save: Missing id on ${table}`);

    const data = toDB(model);
    await DB.upsert(table, data);
    return fromDB(data);
  },

  /**
   * Return all non-deleted rows from a table.
   */
  async findAll(table) {
    const rows = await DB.findAll(table);
    return rows
      .map(fromDB)
      .filter((r) => !r.deleted_at);
  },

  /**
   * Return a single non-deleted row by id.
   */
  async findById(table, id) {
    const row    = await DB.findById(table, id);
    const mapped = fromDB(row);
    if (!mapped || mapped.deleted_at) return null;
    return mapped;
  },

  /**
   * Soft-delete a record by setting deleted_at and marking unsynced.
   */
  async delete(table, id) {
    return this.save(table, {
      id,
      deleted_at: new Date().toISOString(),
      _synced:    0,
    });
  },

  /**
   * Run a raw SQL query and return all matching rows.
   */
  async query(sql, params = []) {
    const rows = await DB.query(sql, params);
    return rows.map(fromDB).filter((r) => r && !r.deleted_at);
  },

  /**
   * Run a raw SQL query and return the first matching row.
   */
  async queryFirst(sql, params = []) {
    const row = await DB.findFirst(sql, params);
    const mapped = fromDB(row);
    if (!mapped || mapped.deleted_at) return null;
    return mapped;
  },

  /**
   * Count rows matching a WHERE clause.
   * Example: count("students", "classId = ? AND schoolId = ?", [classId, schoolId])
   */
  async count(table, whereClause = "1=1", params = []) {
    const row = await DB.findFirst(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${whereClause}`,
      params
    );
    return row?.cnt ?? 0;
  },
};