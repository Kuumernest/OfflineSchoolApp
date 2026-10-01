// mobile/src/services/studentFees.service.js
"use strict";

/**
 * The pupil's own fee account, with or without a connection.
 *
 * One read: GET /student/fees, which answers the ledger the signed-in account
 * owns — the same redacted ledger a family sees in the guardian portal — and
 * never anyone else's; there is no pupil id to send. The answer is kept in
 * SQLite under the account's own key, so a pupil opening Fees in a classroom
 * with no signal sees the last balance the school gave them, said to be as of
 * when it was fetched. A 401 is never answered from the cache: a sign-in that
 * has lapsed must reach the screen as such, not as yesterday's figures.
 *
 * Nothing here writes. Payments are the bursar's office's to record.
 */

import api from "./api";
import { getDatabase } from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { getCurrentAuth } from "../utils/authHelpers";

const CACHE = "student_fees_cache";

const ensureSchema = async (db) => {
  await ensureTableSchema(CACHE, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${CACHE} (
      owner_id    TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      _fetched_at TEXT
    )`);
  }, db);
};

const ownerOf = () => {
  const { user } = getCurrentAuth();
  return String(user?._id ?? user?.id ?? "");
};

const cachePut = async (payload) => {
  const db = await getDatabase();
  await ensureSchema(db);
  await db.runAsync(
    `INSERT OR REPLACE INTO ${CACHE} (owner_id, payload, _fetched_at) VALUES (?, ?, ?)`,
    [ownerOf(), JSON.stringify(payload), new Date().toISOString()]
  ).catch(() => {});
};

const cacheGet = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(
    `SELECT payload, _fetched_at FROM ${CACHE} WHERE owner_id = ?`, [ownerOf()]
  ).catch(() => null);
  if (!row) return null;
  try {
    return { data: JSON.parse(row.payload), fetchedAt: row._fetched_at, stale: true };
  } catch {
    return null;
  }
};

/**
 * The ledger: { charges, payments, totals: { charged, waived, paid, balance } }.
 * @returns {Promise<{ data: object, stale: boolean, fetchedAt: string }>}
 */
export const fetchMyFees = async ({ academicYear = null } = {}) => {
  try {
    const { data } = await api.get("/student/fees", {
      params: academicYear ? { academicYear } : undefined,
    });
    const payload = data?.data ?? data;
    await cachePut(payload);
    return { data: payload, stale: false, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err?.response?.status === 401) throw err;
    const cached = await cacheGet();
    if (cached) return cached;
    throw err;
  }
};

export default { fetchMyFees };
