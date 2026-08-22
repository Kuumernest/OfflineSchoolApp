// mobile/src/services/financeReport.service.js
"use strict";

/**
 * The income statement on a phone — read-only, cached.
 *
 * There is nothing to write here: every figure is derived from the ledger by
 * the server on each call, so there is no local mutation and no outbox entry.
 * What the phone does need is to open without a signal, which is what the cache
 * is for.
 *
 * One row per period key, not one row per fetch. A head who checks this month
 * repeatedly should get the latest figures for this month, not a pile of
 * historical snapshots — and the fetch stamp is kept so the screen can say how
 * old what it is showing actually is, rather than implying it is current.
 */

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import api                   from "./api";

const CACHE = "finance_report_cache";

const ensureSchema = async (db) => {
  await ensureTableSchema(CACHE, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${CACHE} (
      period_key  TEXT PRIMARY KEY,
      school_id   TEXT,
      payload     TEXT NOT NULL,
      _fetched_at TEXT
    )`);
  }, db);
};

/** Stable key for a period, so a repeat look at the same range replaces it. */
export const periodKey = ({ from, to }) => `${from || "*"}..${to || "*"}`;

/**
 * Fetch and cache. Throws when offline — the caller decides whether to fall
 * back to the cache, because only the screen knows if it has anything to show.
 */
export const pullReport = async ({ schoolId, from, to, academicYear }) => {
  const { data } = await api.get("/finance/reports/summary", {
    params: { schoolId, from, to, academicYear },
  });
  const report = data?.data;
  if (!report) throw new Error("Empty report");

  const db = await getDatabase();
  await ensureSchema(db);
  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT OR REPLACE INTO ${CACHE} (period_key, school_id, payload, _fetched_at)
     VALUES (?, ?, ?, ?)`,
    [periodKey({ from, to }), schoolId, JSON.stringify(report), now]
  ).catch(() => {});

  return { ...report, fetchedAt: now, stale: false };
};

/** Last-known figures for a period. Null when this phone has never had any. */
export const cachedReport = async ({ from, to }) => {
  const db = await getDatabase();
  await ensureSchema(db);

  const row = await db.getFirstAsync(
    `SELECT payload, _fetched_at FROM ${CACHE} WHERE period_key = ?`,
    [periodKey({ from, to })]
  ).catch(() => null);
  if (!row) return null;

  try {
    return { ...JSON.parse(row.payload), fetchedAt: row._fetched_at, stale: true };
  } catch {
    // A payload that will not parse is worse than none — showing half a report
    // is how a wrong number reaches someone who trusts it.
    return null;
  }
};

export default { periodKey, pullReport, cachedReport };
