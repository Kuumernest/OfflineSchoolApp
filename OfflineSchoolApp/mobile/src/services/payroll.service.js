// mobile/src/services/payroll.service.js
"use strict";

/**
 * Payroll on the phone — read-only, on purpose.
 *
 * Generating and confirming a run stays in the web console, and this is a
 * correctness decision rather than a scoping one. Payslip numbers come from a
 * server-side counter, and "which salary was in force in March" is a date query
 * against rows the server closes to the millisecond. Two phones generating the
 * same month offline would mint colliding payslip numbers against a salary
 * history neither could reconstruct — so there is no offline write path here,
 * and no outbox entry to lose.
 *
 * Reads are cached so the screen opens with last-known figures when there is no
 * signal. A cached run is history, not a live figure: it is stamped with when
 * it was fetched so the screen can say so rather than implying it is current.
 */

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import api                   from "./api";

const RUNS = "payroll_runs_cache";

const ensureSchema = async (db) => {
  await ensureTableSchema(RUNS, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${RUNS} (
      id               TEXT PRIMARY KEY,
      school_id        TEXT,
      period_month     TEXT,
      status           TEXT,
      staff_count      INTEGER NOT NULL DEFAULT 0,
      total_gross      INTEGER NOT NULL DEFAULT 0,
      total_deductions INTEGER NOT NULL DEFAULT 0,
      total_net        INTEGER NOT NULL DEFAULT 0,
      _fetched_at      TEXT
    )`);
  }, db);
};

const mapRun = (row) => ({
  _id:             row.id,
  periodMonth:     row.period_month,
  status:          row.status,
  staffCount:      row.staff_count,
  totalGross:      row.total_gross,
  totalDeductions: row.total_deductions,
  totalNet:        row.total_net,
  fetchedAt:       row._fetched_at,
});

/** Last-known runs, straight from the cache. Works with no signal. */
export const listCachedRuns = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const rows = await db.getAllAsync(
    `SELECT * FROM ${RUNS} ORDER BY period_month DESC`
  );
  return (rows ?? []).map(mapRun);
};

/** Refresh the cache from the server. Throws when offline — callers decide. */
export const pullRuns = async ({ schoolId }) => {
  const { data } = await api.get("/finance/payroll", { params: { schoolId } });
  const runs = data?.data ?? [];

  const db = await getDatabase();
  await ensureSchema(db);
  const now = new Date().toISOString();

  for (const r of runs) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${RUNS}
         (id, school_id, period_month, status, staff_count,
          total_gross, total_deductions, total_net, _fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r._id, schoolId, r.periodMonth, r.status, r.staffCount ?? 0,
       r.totalGross ?? 0, r.totalDeductions ?? 0, r.totalNet ?? 0, now]
    ).catch(() => {});
  }

  return runs.length;
};

/**
 * One run with its payslips.
 *
 * Not cached: a payslip list is long, rarely looked at twice, and only useful
 * when it is current. The screen asks for it on demand and says plainly when
 * there is no signal to fetch it.
 */
export const fetchRunDetail = async ({ schoolId, runId }) => {
  const { data } = await api.get(`/finance/payroll/${runId}`, { params: { schoolId } });
  return data?.data ?? { run: null, payslips: [] };
};

/** Salaries currently in force. Online — this is a reference lookup. */
export const fetchSalaries = async ({ schoolId }) => {
  const { data } = await api.get("/finance/salary-structures", { params: { schoolId } });
  return data?.data ?? [];
};

export default {
  listCachedRuns,
  pullRuns,
  fetchRunDetail,
  fetchSalaries,
};
