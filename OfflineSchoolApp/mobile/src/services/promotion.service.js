// mobile/src/services/promotion.service.js
"use strict";

/**
 * End-of-year rollover on the phone — read-only, on purpose.
 *
 * Generating and committing stays in the web console, and like payroll this is
 * a correctness decision rather than a scoping one. A rollover rewrites the
 * class of every student in the school in one act. Two phones committing the
 * same rollover offline would each move a roster the other had already moved,
 * and the reversal that fixes it restores from decisions neither device could
 * reconcile. There is no offline write path here, so there is nothing to lose.
 *
 * What the phone genuinely needs is the other direction: which class a student
 * was in, year by year. That is a read, it is small, and it is what a parent
 * standing in front of you asks about — so it is cached per student and opens
 * with no signal.
 */

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import api                   from "./api";

const HISTORY = "enrollment_history";

const ensureSchema = async (db) => {
  await ensureTableSchema(HISTORY, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${HISTORY} (
      id            TEXT PRIMARY KEY,
      school_id     TEXT,
      student_id    TEXT NOT NULL,
      academic_year TEXT NOT NULL,
      class_id      TEXT,
      class_name    TEXT,
      outcome       TEXT,
      _fetched_at   TEXT
    )`);
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_enrollment_history_student
       ON ${HISTORY}(student_id, academic_year)`
    ).catch(() => {});
  }, db);
};

const mapRow = (row) => ({
  _id:          row.id,
  studentId:    row.student_id,
  academicYear: row.academic_year,
  classId:      row.class_id,
  className:    row.class_name,
  outcome:      row.outcome,
});

/** Last-known history for a student. Works with no signal. */
export const cachedHistory = async (studentId) => {
  const db = await getDatabase();
  await ensureSchema(db);
  const rows = await db.getAllAsync(
    `SELECT * FROM ${HISTORY} WHERE student_id = ? ORDER BY academic_year ASC`,
    [studentId]
  );
  return (rows ?? []).map(mapRow);
};

/**
 * Refresh one student's history.
 *
 * Rows are replaced rather than merged: the server is the only writer here, so
 * a row this device holds that the server no longer has is not local work worth
 * protecting — it is a reversed rollover that has been undone, and keeping it
 * would show a year the student never completed.
 */
export const pullHistory = async ({ schoolId, studentId }) => {
  const { data } = await api.get(`/promotion/students/${studentId}/history`, {
    params: { schoolId },
  });
  const rows = data?.data ?? [];

  const db = await getDatabase();
  await ensureSchema(db);
  const now = new Date().toISOString();

  await db.runAsync(`DELETE FROM ${HISTORY} WHERE student_id = ?`, [studentId])
    .catch(() => {});

  for (const r of rows) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${HISTORY}
         (id, school_id, student_id, academic_year, class_id, class_name, outcome, _fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [r._id, schoolId, r.studentId, r.academicYear, r.classId ?? null,
       r.className ?? null, r.outcome ?? null, now]
    ).catch(() => {});
  }

  return rows.length;
};

// ─────────────────────────────────────────────────────────────────────────────
// RUNS — online reads, not cached
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rollovers, newest first.
 *
 * Not cached: a rollover is looked at around the one week a year it happens,
 * and a stale copy of something this consequential is worse than an honest
 * "no connection".
 */
export const fetchRuns = async ({ schoolId }) => {
  const { data } = await api.get("/promotion/runs", { params: { schoolId } });
  return data?.data ?? [];
};

export const fetchRun = async ({ schoolId, runId }) => {
  const { data } = await api.get(`/promotion/runs/${runId}`, { params: { schoolId } });
  return data?.data ?? { run: null, decisions: [] };
};

export default { cachedHistory, pullHistory, fetchRuns, fetchRun };
