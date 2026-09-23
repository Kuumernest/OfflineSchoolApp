// mobile/src/services/intervention.service.js
"use strict";

/**
 * Recording a support action from a phone, with or without a connection.
 *
 * ── The one rule this file exists to respect ──────────────────────────────
 *
 * Every mutation in this application goes through the outbox
 * (mutationQueue.service.js). Nothing POSTs on its own. The row is written to
 * SQLite first and enqueued second, so a teacher standing in a corridor with no
 * signal sees the action recorded immediately and the server hears about it
 * whenever the phone next has a connection.
 *
 * ── Why the id is a UUID and not a local id ───────────────────────────────
 *
 * generateLocalId() mints "local_<ts>_<rand>", which is the right thing for a
 * record the SERVER will re-id: the reconcilers swap it for the real one after
 * the first successful send, and isLocalId()/needsServerSync() are how the rest
 * of the app knows a row is still waiting for that swap.
 *
 * An intervention is not re-ided. POST /api/interventions accepts the id the
 * client chose and keeps it for ever, precisely so that a resend after a
 * dropped connection lands on the same row instead of creating a second record
 * about the same child. So a local id here would be a permanent one — and every
 * such row would read as "still needs a server id" to machinery that would then
 * never see it change. A UUID is what the server's own schema defaults to and
 * what the desktop writer uses.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 *
 * A read path. Interventions reach a device through the ordinary document
 * mirror (config/syncFeed.js classifies the collection, scoped to the classes a
 * teacher actually teaches), not through a bespoke fetch here.
 *
 * And no screen calls this yet — Stage 3 deliberately added no UI. It is the
 * write half of the offline story, ready for the screen that will use it.
 */

import { getDatabase } from "../db/database";
import { generateUUID } from "../utils/idHelpers";
import { getCurrentAuth } from "../utils/authHelpers";
import { MutationQueue } from "./mutationQueue.service";

const TABLE = "interventions";

/** The moves the server will accept, mirrored so an offline edit fails here. */
const TRANSITIONS = {
  planned:   ["active", "cancelled"],
  active:    ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const ensureSchema = async (db) => {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY, schoolId TEXT NOT NULL, studentId TEXT NOT NULL,
    classId TEXT NOT NULL, sourceType TEXT NOT NULL, sourceCode TEXT,
    actionCode TEXT NOT NULL, notes TEXT, assignedTo TEXT, status TEXT NOT NULL,
    outcomeCode TEXT, outcomeNotes TEXT, version INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, _synced INTEGER NOT NULL DEFAULT 0
  )`);
  await db.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_interventions_student ON ${TABLE}(studentId, updatedAt)`
  );
};

export const InterventionService = {
  /**
   * Record that somebody decided to act. Local first, queued second.
   *
   * The same validation the server applies, applied here too — not as a
   * substitute for it, but so that a teacher offline is told immediately
   * instead of watching the row sit in the pending-changes screen until a
   * connection arrives to reject it.
   */
  async create({
    studentId, classId, sourceType = "other", sourceCode = null,
    actionCode, notes = null, assignedTo = null,
  }) {
    const db = await getDatabase();
    await ensureSchema(db);

    const { schoolId } = getCurrentAuth();
    if (!schoolId || !studentId || !classId || !actionCode ||
        (sourceType === "guidance" && !sourceCode)) {
      throw new Error("INVALID_INTERVENTION");
    }

    // See the header: the server keeps this id, so it must be a real UUID.
    const id  = generateUUID();
    const now = new Date().toISOString();
    const row = {
      _id: id, schoolId, studentId, classId, sourceType, sourceCode,
      actionCode, notes, assignedTo, status: "planned",
      outcomeCode: null, outcomeNotes: null, version: 1,
      createdAt: now, updatedAt: now,
    };

    await db.runAsync(
      `INSERT INTO ${TABLE} (id,schoolId,studentId,classId,sourceType,sourceCode,` +
      `actionCode,notes,assignedTo,status,outcomeCode,outcomeNotes,version,` +
      `createdAt,updatedAt,_synced) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [id, schoolId, studentId, classId, sourceType, sourceCode, actionCode,
       notes, assignedTo, "planned", null, null, 1, now, now]
    );

    // entityKey is stable per record, so a re-enqueue replaces the pending row
    // rather than stacking a second send for the same intervention.
    await MutationQueue.enqueue({
      entityKey: `intervention-create:${id}`,
      method:    "POST",
      endpoint:  "/interventions",
      payload:   row,
    });

    return row;
  },

  /**
   * Move it along, or record what happened.
   *
   * `version` is sent as the version this device HELD, which is what lets the
   * server answer 409 VERSION_CONFLICT rather than letting whichever device
   * syncs last quietly win.
   */
  async update(id, patch) {
    const db = await getDatabase();
    await ensureSchema(db);

    const row = await db.getFirstAsync(`SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    if (!row) throw new Error("INTERVENTION_NOT_FOUND");

    if (patch.status && patch.status !== row.status &&
        !TRANSITIONS[row.status]?.includes(patch.status)) {
      throw new Error("INVALID_INTERVENTION_TRANSITION");
    }

    const now  = new Date().toISOString();
    const next = { ...row, ...patch, version: row.version + 1, updatedAt: now };

    await db.runAsync(
      `UPDATE ${TABLE} SET assignedTo=?,notes=?,status=?,outcomeCode=?,` +
      `outcomeNotes=?,version=?,updatedAt=?,_synced=0 WHERE id=?`,
      [next.assignedTo ?? null, next.notes ?? null, next.status,
       next.outcomeCode ?? null, next.outcomeNotes ?? null, next.version, now, id]
    );

    await MutationQueue.enqueue({
      entityKey: `intervention-update:${id}`,
      method:    "PATCH",
      endpoint:  `/interventions/${id}`,
      payload:   { ...patch, version: row.version, __local: { table: TABLE, id } },
    });

    return next;
  },
};
