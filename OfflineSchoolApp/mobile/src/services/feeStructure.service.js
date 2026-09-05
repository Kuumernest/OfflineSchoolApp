// src/services/feeStructure.service.js
"use strict";

/**
 * Fee structures on the phone: what the school charges, and raising it.
 *
 * ── Why this did not exist ───────────────────────────────────────────────────
 *
 * The phone syncs through /sync/pull, which answers with six collections —
 * classes, teachers, subjects, periods, assignments, students. The desktop
 * syncs through /sync/changes, which answers with thirty-six, fee structures
 * among them. So a structure written in the office appeared on the desktop and
 * never on a phone, and the phone had no table to put one in if it had.
 *
 * The gap was survivable because the fees screen demand-fetches a student's
 * charges when you open them. That works with a connection and for students
 * somebody has already opened; it is nothing at all otherwise.
 *
 * ── Reads ────────────────────────────────────────────────────────────────────
 *
 * Mirrored from GET /fees/structures rather than the generic feed. A school has
 * a handful of structures, not a stream of them, so a whole-list pull is both
 * simpler than cursors and self-healing: every sync replaces the mirror, so a
 * row deleted on the server disappears here rather than lingering because no
 * tombstone arrived.
 *
 * ── Writes ───────────────────────────────────────────────────────────────────
 *
 * Through the outbox, like every other write on this device. Applying a
 * structure is the one that would frighten you — it raises a charge against
 * every pupil in the classes it covers, and a queued request can be replayed —
 * but the server holds a unique index on
 * (studentId, structureId, code, term), so a second apply inserts nothing and
 * reports the rows it skipped. Replaying it is free, which is what makes it
 * safe to queue from a device that may be offline for a day.
 *
 * Validation here is deliberately the minimum that catches a typing mistake.
 * The full rules — overlapping structures, penalty shapes — live in
 * shared/feeStructures.js, which Metro cannot resolve from this package, and a
 * second copy of financial validation is worse than none: it would drift, and
 * the copy that matters is the server's. A structure the server refuses lands
 * in the pending-changes screen with its reason, where the bursar can see it.
 */

import api from "./api";
import { getDatabase } from "../db/database";
import { createTableFromSchema, ensureSchemaColumns } from "../db/schema";
import { withTransaction } from "../db/dbHelpers";
import { MutationQueue } from "./mutationQueue.service";

const TABLE = "fee_structures";

let schemaReady = null;
const ensureSchema = async (db) => {
  if (!schemaReady) {
    schemaReady = (async () => {
      const database = db ?? (await getDatabase());
      await createTableFromSchema(database, "feeStructures");
      await ensureSchemaColumns(database, "feeStructures");
    })().catch((err) => {
      // Do not cache a failure: a table that could not be made this time must
      // be attempted again rather than reported ready for the session.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
};

const parse = (raw, fallback) => {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

const rowToStructure = (r) => ({
  _id:          r.id,
  schoolId:     r.schoolId || r.school_id || null,
  academicYear: r.academicYear || null,
  term:         r.term || null,
  items:        parse(r.items, []),
  classIds:     parse(r.classIds, []),
  dueDate:      r.dueDate || null,
  penalty:      parse(r.penalty, null),
  isActive:     r.isActive === 1,
  // A structure this device created and has not yet had accepted. The list
  // shows it so nobody types it twice while the phone is offline.
  pending:      r._synced === 0,
  createdAt:    r.created_at || null,
  updatedAt:    r.updated_at || null,
});

/** Everything this device knows the school charges. */
export const listLocal = async (schoolId) => {
  const db = await getDatabase();
  await ensureSchema(db);

  const rows = await db.getAllAsync(
    `SELECT * FROM ${TABLE}
      WHERE (schoolId = ? OR school_id = ?) AND deleted_at IS NULL
      ORDER BY academicYear DESC, term ASC, created_at DESC`,
    [String(schoolId ?? ""), String(schoolId ?? "")]
  ).catch(() => []);

  return rows.map(rowToStructure);
};

/** One structure, by id. */
export const getLocal = async (id) => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(
    `SELECT * FROM ${TABLE} WHERE id = ?`, [String(id)]
  ).catch(() => null);
  return row ? rowToStructure(row) : null;
};

const upsert = async (db, s, schoolId, synced) => {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO ${TABLE}
       (id, schoolId, school_id, academicYear, term, items, classIds,
        dueDate, penalty, isActive, _synced, _synced_at, deleted_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schoolId     = excluded.schoolId,
       school_id    = excluded.school_id,
       academicYear = excluded.academicYear,
       term         = excluded.term,
       items        = excluded.items,
       classIds     = excluded.classIds,
       dueDate      = excluded.dueDate,
       penalty      = excluded.penalty,
       isActive     = excluded.isActive,
       _synced      = excluded._synced,
       _synced_at   = excluded._synced_at,
       deleted_at   = NULL,
       updated_at   = excluded.updated_at`,
    [
      String(s._id),
      String(s.schoolId ?? schoolId ?? ""),
      String(s.schoolId ?? schoolId ?? ""),
      s.academicYear ?? null,
      s.term ?? null,
      JSON.stringify(s.items ?? []),
      JSON.stringify(s.classIds ?? []),
      s.dueDate ? String(s.dueDate).slice(0, 10) : null,
      s.penalty ? JSON.stringify(s.penalty) : null,
      s.isActive === false ? 0 : 1,
      synced ? 1 : 0,
      synced ? now : null,
      s.createdAt ?? now,
      s.updatedAt ?? now,
    ]
  );
};

/**
 * Replace the mirror with what the server has.
 *
 * A whole-list replace, not a merge. Rows this device created and has not yet
 * pushed are kept: they are not absent from the server because they were
 * deleted, they are absent because they have not arrived yet, and dropping
 * them would lose a bursar's work.
 */
export const syncFromServer = async (schoolId) => {
  const { data } = await api.get("/fees/structures", { params: { schoolId } });
  const list = data?.data ?? data?.structures ?? [];
  if (!Array.isArray(list)) return { count: 0 };

  const db = await getDatabase();
  await ensureSchema(db);

  const serverIds = new Set(list.map((s) => String(s._id)));

  // The shared helper, not db.withTransactionAsync directly: it carries a
  // nesting guard, and this runs inside a sync cycle that may already be in a
  // transaction of its own.
  await withTransaction(db, async () => {
    for (const s of list) await upsert(db, s, schoolId, true);

    // Anything the mirror holds that the server does not, and that this device
    // did not create itself, has been deleted elsewhere.
    const local = await db.getAllAsync(
      `SELECT id FROM ${TABLE}
        WHERE (schoolId = ? OR school_id = ?) AND _synced = 1 AND deleted_at IS NULL`,
      [String(schoolId ?? ""), String(schoolId ?? "")]
    ).catch(() => []);

    for (const row of local) {
      if (!serverIds.has(String(row.id))) {
        await db.runAsync(
          `UPDATE ${TABLE} SET deleted_at = ? WHERE id = ?`,
          [new Date().toISOString(), row.id]
        );
      }
    }
  });

  return { count: list.length };
};

/** The little that is worth refusing before the server sees it. */
export const validate = (draft) => {
  if (!draft.academicYear)         return "feeStructures.errYear";
  if (!draft.dueDate)              return "feeStructures.errDueDate";
  const items = (draft.items ?? []).filter((i) => i.code?.trim() && i.label?.trim());
  if (!items.length)               return "feeStructures.errNoItems";
  for (const i of items) {
    const amount = Number(i.amount);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
      return "feeStructures.errAmount";
    }
  }
  return null;
};

/**
 * Create a structure: written locally, queued for the server.
 *
 * The id is minted here and sent with the request, so a replay finds the row it
 * already made rather than creating a second one — the same contract the fee
 * payment and exam endpoints use.
 */
export const create = async (schoolId, draft) => {
  const db = await getDatabase();
  await ensureSchema(db);

  const id  = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();

  const body = {
    _id:          id,
    schoolId,
    academicYear: draft.academicYear,
    term:         draft.term || null,
    dueDate:      draft.dueDate,
    classIds:     draft.classIds ?? [],
    items:        (draft.items ?? []).filter((i) => i.code?.trim() && i.label?.trim()),
  };

  await upsert(db, { ...body, isActive: true, createdAt: now, updatedAt: now }, schoolId, false);

  await MutationQueue.enqueue({
    entityKey: `fee-structure:${id}`,
    method:    "POST",
    endpoint:  "/fees/structures",
    payload:   { ...body, __local: { table: TABLE, id } },
  });

  return id;
};

/** Activate or deactivate, locally and on the server. */
export const setActive = async (id, isActive) => {
  const db = await getDatabase();
  await ensureSchema(db);

  await db.runAsync(
    `UPDATE ${TABLE} SET isActive = ?, updated_at = ? WHERE id = ?`,
    [isActive ? 1 : 0, new Date().toISOString(), String(id)]
  );

  await MutationQueue.enqueue({
    // Keyed on the structure, so flipping it twice before a sync sends the
    // final state once rather than both states in order.
    entityKey: `fee-structure-active:${id}`,
    method:    "PATCH",
    endpoint:  `/fees/structures/${id}/${isActive ? "activate" : "deactivate"}`,
    payload:   {},
  });
};

/**
 * Raise this structure's charges against the pupils it covers.
 *
 * Queued rather than sent, and safe to queue: the server's unique index on
 * (studentId, structureId, code, term) means a replay raises nothing and
 * reports what it skipped. Two bursars applying the same structure on two
 * phones bill each pupil once.
 */
export const apply = async (id, { classId = null } = {}) => {
  await MutationQueue.enqueue({
    entityKey: `fee-structure-apply:${id}:${classId ?? "all"}`,
    method:    "POST",
    endpoint:  `/fees/structures/${id}/apply`,
    payload:   classId ? { classId } : {},
  });
};

export default {
  listLocal, getLocal, syncFromServer, validate, create, setActive, apply,
};
