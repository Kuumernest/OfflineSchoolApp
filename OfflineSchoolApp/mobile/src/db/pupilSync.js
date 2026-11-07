// mobile/src/db/pupilSync.js
"use strict";

/**
 * Whether a pupil row on this phone holds a change the server has not had.
 *
 * `students._synced` used to mean nothing: the pull wrote pupils without it,
 * the column was added with DEFAULT 0, so every pulled pupil read as unsent.
 * The admission-decision sweep then PUT /approve for every approved pupil the
 * phone had ever pulled, and the pull itself could not protect a pupil with a
 * real unsent change (any guard on the flag would have frozen the roster).
 *
 * A pupil change is GENUINE, and only then, when one of these holds:
 *   - a row in the outbox (not yet synced) names the pupil: `__local` (the
 *     enrolment, suspend / restore / move / delete / correct), `__reconcile`
 *     on the students table (the enrolment, an admission decision), or an
 *     entity key `student-…:<id>`; through the id map too;
 *   - the pupil was enrolled here and not yet sent (`_operation = 'create'`);
 *   - an admission decision was made here offline and not yet sent
 *     (`_local_decision`, written by the applications screen's offline path).
 *
 * Everything else at `_synced = 0` (or NULL) is a flag nobody meant, and
 * repairPupilSyncFlags marks it synced. After that, `_synced = 1` is what the
 * pull checks before writing over a pupil, like classes, teachers, subjects.
 */

import { tableExists, getTableColumns, safeAddColumn } from "./dbHelpers";
import { localIdsOf } from "../services/syncState";

const OUTBOX = "mutation_outbox";
const ID_MAP = "sync_id_map";

/** The reconciler kinds whose `localId` is a pupil. */
const PUPIL_KINDS = new Set(["studentEnroll", "studentDecision", "studentChange"]);
/** student-create:<id>, student-decision:<id>, student-edit:<id>, … */
const PUPIL_KEY = /^student-[a-z-]+:(.+)$/;

/** The stray decision the old sweep sent for a class-less pulled pupil. */
const STRAY_CLASS_REFUSAL = /classId is required/i;

const parse = (raw) => { try { return JSON.parse(raw || "{}"); } catch { return null; } };

/**
 * Adds the columns the flag rule reads. The decision marker is added here and
 * nowhere else on purpose: the moment it is added is the moment an older
 * install is first seen, and its offline decisions (written before the marker
 * existed) are marked then — once — from the review stamps the applications
 * screen wrote with them.
 *
 * @returns {Promise<boolean>} false when there is no students table
 */
export const ensurePupilSyncColumns = async (db) => {
  if (!(await tableExists(db, "students"))) return false;
  await safeAddColumn(db, "students", "_synced", "INTEGER DEFAULT 0");
  await safeAddColumn(db, "students", "_operation", "TEXT");
  const added = await safeAddColumn(db, "students", "_local_decision", "TEXT");
  if (added) await adoptLegacyDecisions(db);
  return true;
};

/**
 * Offline admission decisions made by a build without the marker: unsent,
 * approved or rejected, not an enrolment, and reviewed on this phone (the
 * applications screen stamps reviewed_at / approved_at / rejected_at; the pull
 * never does). When unsure this marks: a decision sent twice is answered
 * "already approved", one never sent is lost.
 */
const adoptLegacyDecisions = async (db) => {
  const cols = new Set(await getTableColumns(db, "students"));
  const stamps = ["reviewed_at", "approved_at", "rejected_at"].filter((c) => cols.has(c));
  if (!stamps.length) return;
  await db.runAsync(
    `UPDATE students SET _local_decision = status
     WHERE (_synced IS NULL OR _synced != 1)
       AND status IN ('approved', 'rejected')
       AND COALESCE(_operation, '') != 'create'
       AND (${stamps.map((c) => `COALESCE(${c}, '') != ''`).join(" OR ")})`
  ).catch((err) => console.warn("[pupilSync] legacy decisions:", err?.message));
};

/**
 * Ids of pupils the outbox still has work for (any status but synced: a
 * refused change waits on the pending-changes screen and still owns the row).
 */
export const queuedPupilIds = async (db) => {
  const ids = new Set();
  if (!(await tableExists(db, OUTBOX))) return ids;
  const rows = (await db.getAllAsync(
    `SELECT entity_key, payload FROM ${OUTBOX} WHERE status != 'synced'`
  ).catch(() => null)) ?? [];
  for (const r of rows) {
    const key = PUPIL_KEY.exec(String(r.entity_key ?? ""));
    if (key) ids.add(key[1]);
    const p = parse(r.payload);
    if (!p) continue;
    if (p.__local?.table === "students") for (const id of localIdsOf(p.__local)) ids.add(String(id));
    const rec = p.__reconcile;
    if (rec?.localId && (rec.table === "students" || PUPIL_KINDS.has(rec.kind))) ids.add(String(rec.localId));
  }
  // A queued change made under an id the server has since replaced.
  if (ids.size && (await tableExists(db, ID_MAP))) {
    for (const m of (await db.getAllAsync(`SELECT local_id, server_id FROM ${ID_MAP}`).catch(() => null)) ?? []) {
      if (ids.has(String(m.local_id)) && m.server_id) ids.add(String(m.server_id));
    }
  }
  return ids;
};

/**
 * Settles what the old flag left behind. Idempotent; runs before every
 * backfill, so it also covers a phone updated in the middle of the old bug.
 *
 *   1. a decision marker on a row that is synced is stale (sent, or its
 *      change discarded) — cleared, so it can never send again;
 *   2. parked "classId is required" refusals of a decision that was never
 *      made here (the old sweep's PUT /approve for a pulled class-less pupil)
 *      are removed;
 *   3. a pupil at _synced 0 / NULL with no genuine change is marked synced.
 *
 * @returns {Promise<{ settled: number, strays: number }>}
 */
export const repairPupilSyncFlags = async (db) => {
  const out = { settled: 0, strays: 0 };
  if (!(await ensurePupilSyncColumns(db))) return out;

  await db.runAsync(
    "UPDATE students SET _local_decision = NULL WHERE _local_decision IS NOT NULL AND _synced = 1"
  ).catch(() => {});

  if (await tableExists(db, OUTBOX)) {
    const parked = (await db.getAllAsync(
      `SELECT id, entity_key, error FROM ${OUTBOX}
       WHERE status IN ('failed', 'conflict') AND entity_key LIKE 'student-decision:%'`
    ).catch(() => null)) ?? [];
    for (const r of parked) {
      if (!STRAY_CLASS_REFUSAL.test(String(r.error ?? ""))) continue;
      const pupilId = PUPIL_KEY.exec(r.entity_key)?.[1];
      const pupil = pupilId
        ? await db.getFirstAsync("SELECT _local_decision FROM students WHERE id = ?", [pupilId]).catch(() => undefined)
        : undefined;
      if (pupil === undefined) continue;                   // could not look: leave it
      if (pupil?._local_decision) continue;                // a real decision: a person decides
      await db.runAsync(`DELETE FROM ${OUTBOX} WHERE id = ?`, [r.id]).catch(() => {});
      out.strays++;
    }
  }

  const busy = await queuedPupilIds(db);
  const dirty = (await db.getAllAsync(
    `SELECT id FROM students
     WHERE (_synced IS NULL OR _synced != 1)
       AND COALESCE(_operation, '') != 'create'
       AND _local_decision IS NULL`
  ).catch(() => null)) ?? [];
  for (const { id } of dirty) {
    if (busy.has(String(id))) continue;
    await db.runAsync(
      "UPDATE students SET _synced = 1 WHERE id = ? AND (_synced IS NULL OR _synced != 1) AND _local_decision IS NULL",
      [id]
    ).catch(() => {});
    out.settled++;
  }
  if (out.settled || out.strays) {
    console.log(`[pupilSync] ${out.settled} pupil(s) marked synced, ${out.strays} stray decision(s) removed`);
  }
  return out;
};

export default { ensurePupilSyncColumns, queuedPupilIds, repairPupilSyncFlags };
