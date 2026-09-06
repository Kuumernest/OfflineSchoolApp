"use strict";

/**
 * The single durable outbox for mutations that cannot be lost when the
 * application is offline.  A row is written before any network attempt.
 * The server should honour Idempotency-Key and may use If-Match to reject a
 * stale edit with 409; those responses are retained for user resolution.
 *
 * Retry policy
 * ------------
 * Not every 409 means "your edit lost a race". The backend's idempotency
 * middleware answers a *concurrent duplicate* with
 * 409 { code: "IDEMPOTENCY_IN_PROGRESS" }, which is transient — the very
 * same request will succeed moments later. Parking those as conflicts (the
 * old behaviour) silently discarded offline attendance and homework.
 *
 * So errors are classified:
 *   transient  → retry with exponential backoff (network, 5xx, 408, 429,
 *                and 409/IDEMPOTENCY_IN_PROGRESS)
 *   conflict   → 412, or a 409 that genuinely reports a version clash;
 *                parked for user resolution
 *   permanent  → other 4xx; parked as failed
 *   resolved   → 404/410 on DELETE (already gone server-side) counts as done
 *
 * Nothing is ever dropped without a row the UI can show: listUnresolved()
 * and getStats() back the pending-changes surface, and retry()/discard()
 * let the user act on a parked row.
 *
 * The single write path
 * ---------------------
 * Every mutation in the app goes through this table. Entity services no
 * longer POST on their own: they write locally, mark the row dirty, and a
 * backfill pass (syncBackfill.service) enqueues anything dirty that has no
 * outbox row yet. That removes the second, key-less sender each entity used
 * to run beside the outbox — attendance, for instance, was POSTed once by
 * the outbox with an Idempotency-Key and again by its own sweeper without
 * one, so a backed-off retry could double-write.
 *
 * Two mechanisms make one queue enough for entities the server re-ids:
 *
 *   Reconcilers (`__reconcile`) run domain-specific work after a successful
 *   send — adopting a server id, cascading it to child rows. Registered by
 *   name so this module stays domain-free.
 *
 *   The id map (`__resolve`) rewrites payload fields and endpoints at SEND
 *   time. A subject queued while its class still had a local id would
 *   otherwise ship that dead id; the class's reconciler records
 *   local→server, and the subject's send substitutes it.
 */
import api from "./api";
import { getDatabase } from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { generateUUID } from "../utils/idHelpers";
import { remapPayload } from "./idMap";

const TABLE = "mutation_outbox";
const ID_MAP = "sync_id_map";
const MAX_RETRIES = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const ensureSchema = (db) => ensureTableSchema(TABLE, async (database) => {
  await database.execAsync(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    entity_key TEXT NOT NULL,
    method TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    base_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT,
    next_attempt_at TEXT,
    error TEXT,
    conflict TEXT,
    silent INTEGER NOT NULL DEFAULT 0
  )`);
  await database.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_mutation_outbox_pending
     ON ${TABLE}(status, next_attempt_at, created_at)`
  ).catch(() => {});
  // Pre-existing installs won't have these.
  await database.execAsync(
    `ALTER TABLE ${TABLE} ADD COLUMN next_attempt_at TEXT`
  ).catch(() => {});
  await database.execAsync(
    `ALTER TABLE ${TABLE} ADD COLUMN silent INTEGER NOT NULL DEFAULT 0`
  ).catch(() => {});

  await database.execAsync(`CREATE TABLE IF NOT EXISTS ${ID_MAP} (
    local_id   TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL,
    entity     TEXT,
    created_at TEXT
  )`);
}, db);

const json = (value) => JSON.stringify(value ?? {});
const parse = (value) => { try { return JSON.parse(value || "{}"); } catch { return {}; } };

/** Strips client-only metadata so it never reaches the server. */
const wireBody = (payload) => {
  if (!payload || typeof payload !== "object") return payload;
  const { __local, __reconcile, __resolve, __endpoints, ...rest } = payload;
  return rest;
};

/**
 * Tables whose dirty flag this queue may clear via `payload.__local`.
 *
 * An allowlist because the table name is interpolated into SQL. It lives here
 * rather than in the orchestrator so that ANY caller of drain() gets correct
 * flag-clearing — a direct drain from a screen must not silently leave rows
 * marked dirty forever.
 *
 * `periods` is deliberately absent: it has no `_synced` column and tracks
 * pending work with `dirty`, which its reconciler clears.
 */
const SYNCABLE_LOCAL_TABLES = new Set([
  "attendance", "teacher_attendance",
  "homework", "homework_submissions",
  "exams", "exam_subjects", "exam_scores",
  "classes", "subjects", "users", "teacher_assignments",
  "timetable", "students", "announcements",
  "questions", "quizzes", "quiz_attempts",
  "fee_structures",
]);

/** Cache of "does this table have a _synced_at column?" — probed once each. */
const syncedAtCache = new Map();

const tableHasSyncedAt = async (db, table) => {
  if (syncedAtCache.has(table)) return syncedAtCache.get(table);
  let has = false;
  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(${table})`);
    has = (cols ?? []).some((c) => c.name === "_synced_at");
  } catch {
    has = false;
  }
  syncedAtCache.set(table, has);
  return has;
};

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILER REGISTRY
// ═════════════════════════════════════════════════════════════════════════════

/** @type {Map<string, (ctx: object) => Promise<void>>} */
const reconcilers = new Map();

/**
 * Registers post-send work for one kind of mutation.
 *
 * The handler receives { response, payload, args, row } and is responsible
 * for whatever the domain needs — adopting a server id, cascading it to
 * dependent tables, clearing extra flags. Keeping these out of the queue is
 * what lets a single transport serve every entity.
 *
 * @param {string} name
 * @param {(ctx: { response: any, payload: object, args: object, row: object }) => Promise<void>} handler
 */
export const registerReconciler = (name, handler) => {
  if (typeof handler !== "function") throw new Error(`Reconciler "${name}" must be a function`);
  reconcilers.set(name, handler);
};

export const hasReconciler = (name) => reconcilers.has(name);

// ═════════════════════════════════════════════════════════════════════════════
// ID MAP — local id → server id, applied at send time
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Records that the server assigned `serverId` to what this device called
 * `localId`. Any queued mutation still carrying the local id is rewritten
 * when it is sent.
 */
export const mapId = async (localId, serverId, entity = null) => {
  if (!localId || !serverId || String(localId) === String(serverId)) return;
  const db = await getDatabase();
  await ensureSchema(db);
  await db.runAsync(
    `INSERT INTO ${ID_MAP} (local_id, server_id, entity, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(local_id) DO UPDATE SET server_id = excluded.server_id`,
    [String(localId), String(serverId), entity, new Date().toISOString()]
  ).catch((err) => console.warn("[MutationQueue] mapId failed:", err.message));
};

/** Follows the map (one hop is enough — reconcilers always write the final id). */
export const resolveId = async (localId) => {
  if (!localId) return localId;
  const db = await getDatabase();
  const row = await db.getFirstAsync(
    `SELECT server_id FROM ${ID_MAP} WHERE local_id = ?`, [String(localId)]
  ).catch(() => null);
  return row?.server_id || localId;
};

/**
 * Applies the id map to a queued row just before it goes out.
 * `__resolve` lists the payload fields that hold foreign ids; the row's own
 * id inside the endpoint path is always rewritten too.
 */
const applyIdMap = async (db, row, payload) => {
  // The rewrite itself lives in idMap.js, which takes a lookup rather than a
  // database so it can be exercised without a device. This supplies the lookup.
  const lookup = async (value) => {
    if (!value) return value;
    const hit = await db.getFirstAsync(
      `SELECT server_id FROM ${ID_MAP} WHERE local_id = ?`, [String(value)]
    ).catch(() => null);
    return hit?.server_id || value;
  };

  const { endpoint, payload: next } = await remapPayload({
    endpoint: row.endpoint,
    payload,
    lookup,
  });

  return { endpoint, payload: next };
};

/**
 * Sends a mutation, walking a fallback chain when one is declared.
 *
 * Some admin routes exist under more than one path depending on backend
 * version, and the app discovers which by trying them. That discovery used
 * to live in a separate sender (callWithFallback); folding it in here keeps
 * a single code path to the wire. Only a 404 advances to the next candidate
 * — any other status is a real answer.
 */
const sendWithFallback = async ({ method, endpoint, fallbacks, data, headers }) => {
  const candidates = [endpoint, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);

  let lastError;
  for (const url of candidates) {
    try {
      return await api.request({ method, url, data, headers });
    } catch (err) {
      lastError = err;
      if (err?.response?.status !== 404) throw err;
    }
  }
  throw lastError;
};

const backoffFor = (retryCount) =>
  Math.min(BASE_BACKOFF_MS * Math.pow(2, Math.max(0, retryCount - 1)), MAX_BACKOFF_MS);

/**
 * Decides how to treat a failed attempt.
 * @returns {"transient" | "conflict" | "permanent" | "resolved"}
 */
export const classifyError = (error, method) => {
  const status = error?.response?.status;
  const code = error?.response?.data?.code;

  // No response at all — offline, DNS, timeout, server unreachable.
  if (!error?.response) return "transient";

  // A duplicate that the server is already working on. Retrying is exactly
  // the right move; the idempotency key guarantees it stays a single write.
  if (status === 409 && code === "IDEMPOTENCY_IN_PROGRESS") return "transient";

  if (status === 408 || status === 425 || status === 429) return "transient";
  if (status >= 500) return "transient";

  // The row is already gone server-side — a delete that has nothing left to
  // do has, in effect, succeeded.
  if ((status === 404 || status === 410) && String(method).toUpperCase() === "DELETE") {
    return "resolved";
  }

  if (status === 412 || status === 409) return "conflict";

  return "permanent";
};

export class MutationQueue {
  /**
   * @param {object}  m
   * @param {string}  m.entityKey  stable per logical record — re-enqueueing
   *                               the same key coalesces onto the pending row
   * @param {boolean} [m.silent]   receipts and other non-user-data pings;
   *                               excluded from the pending-changes UI and
   *                               its counts, so a failed read-receipt never
   *                               reads as "your work didn't save"
   */
  static async enqueue({ entityKey, method, endpoint, payload, baseVersion = null, silent = false }) {
    if (!entityKey || !method || !endpoint) throw new Error("Mutation requires entityKey, method and endpoint");
    const db = await getDatabase();
    await ensureSchema(db);
    const now = new Date().toISOString();
    const id = generateUUID();

    // Coalesce unsent edits to an entity, while preserving the original
    // idempotency key and ordering.  Deletes deliberately replace updates.
    const existing = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} WHERE entity_key = ? AND status IN ('pending', 'retrying') ORDER BY created_at ASC LIMIT 1`,
      [entityKey]
    );
    if (existing?.id) {
      await db.runAsync(
        `UPDATE ${TABLE} SET method = ?, endpoint = ?, payload = ?, base_version = ?,
                status = 'pending', next_attempt_at = NULL, error = NULL WHERE id = ?`,
        [method.toUpperCase(), endpoint, json(payload), baseVersion, existing.id]
      );
      return existing.id;
    }
    await db.runAsync(
      `INSERT INTO ${TABLE} (id, entity_key, method, endpoint, payload, base_version, status, retry_count, created_at, silent)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [id, entityKey, method.toUpperCase(), endpoint, json(payload), baseVersion, now, silent ? 1 : 0]
    );
    return id;
  }

  static async processPending({ limit = 50, onSuccess, onProgress } = {}) {
    const db = await getDatabase();
    await ensureSchema(db);
    const now = new Date().toISOString();

    const rows = await db.getAllAsync(
      `SELECT * FROM ${TABLE}
       WHERE status IN ('pending', 'retrying')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      [now, limit]
    );

    const summary = { synced: 0, retried: 0, conflicts: 0, failed: 0, deferred: 0 };

    // Indexed, and reported at the TOP of each iteration.
    //
    // Every branch of the error handling below ends in `continue`, so a
    // tally at the foot of the loop would skip exactly the rows that went
    // wrong — the ones somebody watching a progress bar most needs counted.
    // Reporting i on entry means "i finished, this is i+1 starting", which
    // no branch can escape.
    const queued = rows?.length ?? 0;
    onProgress?.(0, queued);

    for (let i = 0; i < queued; i++) {
      const row = rows[i];
      onProgress?.(i, queued);
      const payload = parse(row.payload);
      try {
        await db.runAsync(
          `UPDATE ${TABLE} SET status = 'retrying', last_attempt_at = ? WHERE id = ?`,
          [new Date().toISOString(), row.id]
        );
        const headers = { "Idempotency-Key": row.id };
        if (row.base_version) headers["If-Match"] = row.base_version;

        // Substitute any local ids that have since been re-issued by the
        // server, so a mutation queued behind its parent still targets a
        // row that exists.
        const resolved = await applyIdMap(db, row, payload);

        const response = await sendWithFallback({
          method: row.method,
          endpoint: resolved.endpoint,
          fallbacks: payload.__endpoints,
          data: wireBody(resolved.payload),
          headers,
        });

        await this._settle(db, row, resolved.payload, response, onSuccess);
        summary.synced++;
      } catch (error) {
        const kind = classifyError(error, row.method);

        if (kind === "resolved") {
          await this._settle(db, row, payload, error.response, onSuccess);
          summary.synced++;
          continue;
        }

        if (kind === "conflict") {
          await db.runAsync(
            `UPDATE ${TABLE} SET status = 'conflict', conflict = ?, error = ? WHERE id = ?`,
            [json(error.response?.data), error.message, row.id]
          );
          summary.conflicts++;
          continue;
        }

        if (kind === "permanent") {
          await db.runAsync(
            `UPDATE ${TABLE} SET status = 'failed', retry_count = ?, error = ? WHERE id = ?`,
            [(row.retry_count || 0) + 1, error.message, row.id]
          );
          summary.failed++;
          continue;
        }

        // transient — back off and try again later
        const retries = (row.retry_count || 0) + 1;
        const exhausted = retries >= MAX_RETRIES;
        const nextAt = exhausted
          ? null
          : new Date(Date.now() + backoffFor(retries)).toISOString();

        await db.runAsync(
          `UPDATE ${TABLE} SET status = ?, retry_count = ?, error = ?, next_attempt_at = ? WHERE id = ?`,
          [exhausted ? "failed" : "retrying", retries, error.message, nextAt, row.id]
        );
        if (exhausted) summary.failed++;
        else summary.retried++;
      }
    }

    onProgress?.(queued, queued);

    // Report work that exists but isn't due yet, so callers don't read
    // "0 pending" as "nothing left to send".
    const deferred = await db.getFirstAsync(
      `SELECT COUNT(*) AS n FROM ${TABLE}
       WHERE status IN ('pending', 'retrying') AND next_attempt_at > ?`,
      [new Date().toISOString()]
    ).catch(() => null);
    summary.deferred = deferred?.n ?? 0;

    return summary;
  }

  /**
   * Marks a row synced, runs its registered reconciler, then the caller's
   * post-success hook.
   *
   * The reconciler runs first: it is what adopts the server id, and the
   * generic hook that clears `_synced` needs the row to be settled by then.
   */
  static async _settle(db, row, payload, response, onSuccess) {
    await db.runAsync(
      `UPDATE ${TABLE} SET status = 'synced', error = NULL, conflict = NULL, next_attempt_at = NULL WHERE id = ?`,
      [row.id]
    );

    const spec = payload?.__reconcile;
    if (spec?.kind) {
      const handler = reconcilers.get(spec.kind);
      if (handler) {
        try {
          await handler({ response, payload, args: spec, row });
        } catch (err) {
          console.warn(`[MutationQueue] reconciler "${spec.kind}" failed:`, err.message);
        }
      } else {
        console.warn(`[MutationQueue] no reconciler registered for "${spec.kind}"`);
      }
    }

    await this._clearLocalFlag(db, payload);

    try {
      await onSuccess?.({ ...row, payload }, response);
    } catch (err) {
      console.warn("[MutationQueue] onSuccess hook failed:", err.message);
    }
  }

  /**
   * Clears the dirty flag on the rows a mutation covered, as named by
   * `payload.__local`. Runs for every successful send, from any caller.
   *
   * Not every table has `_synced_at` — `homework`, `homework_submissions`
   * and `students` only have `_synced`. Naming a missing column makes SQLite
   * reject the whole statement, so the flag silently stayed dirty forever.
   * The column set is probed once per table and cached.
   */
  static async _clearLocalFlag(db, payload) {
    const meta = payload?.__local;
    if (!meta?.table || !meta?.ids?.length) return;

    if (!SYNCABLE_LOCAL_TABLES.has(meta.table)) {
      console.warn(
        `[MutationQueue] __local names unknown table "${meta.table}" — flag not cleared`
      );
      return;
    }

    const hasSyncedAt = await tableHasSyncedAt(db, meta.table);
    const idCol = meta.idColumn === "_id" ? "_id" : "id";
    const placeholders = meta.ids.map(() => "?").join(",");

    const sql = hasSyncedAt
      ? `UPDATE ${meta.table} SET _synced = 1, _synced_at = ? WHERE ${idCol} IN (${placeholders})`
      : `UPDATE ${meta.table} SET _synced = 1 WHERE ${idCol} IN (${placeholders})`;
    const params = hasSyncedAt
      ? [new Date().toISOString(), ...meta.ids]
      : [...meta.ids];

    await db.runAsync(sql, params).catch((err) =>
      console.warn(`[MutationQueue] could not clear _synced on ${meta.table}:`, err.message)
    );
  }

  /**
   * True when this entity already has work queued, so a backfill pass can
   * skip re-enqueueing a row that is merely waiting its turn.
   */
  static async hasPending(entityKey) {
    const db = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT 1 AS x FROM ${TABLE} WHERE entity_key = ? AND status != 'synced' LIMIT 1`,
      [entityKey]
    ).catch(() => null);
    return !!row;
  }

  /** Bulk variant of hasPending — one query for a whole sweep. */
  static async pendingKeys(prefix = "") {
    const db = await getDatabase();
    await ensureSchema(db);
    const rows = await db.getAllAsync(
      `SELECT entity_key FROM ${TABLE} WHERE status != 'synced' AND entity_key LIKE ?`,
      [`${prefix}%`]
    ).catch(() => []);
    return new Set((rows ?? []).map((r) => r.entity_key));
  }

  // ── Recovery surface ──────────────────────────────────────────────────────

  /**
   * Counts by status plus a single `unsent` total for badge display.
   *
   * Includes the file upload queue. That queue keeps its own table — binary
   * bodies, progress and file-existence checks do not belong in a row of
   * JSON — but it is not a second thing for the user to reason about, so it
   * is drained from one place and counted here.
   *
   * @returns {Promise<{pending:number, retrying:number, conflict:number, failed:number, uploads:number, unsent:number}>}
   */
  static async getStats() {
    const db = await getDatabase();
    await ensureSchema(db);
    const rows = await db.getAllAsync(
      `SELECT status, COUNT(*) AS n FROM ${TABLE}
       WHERE status != 'synced' AND COALESCE(silent, 0) = 0 GROUP BY status`
    ).catch(() => []);

    const stats = { pending: 0, retrying: 0, conflict: 0, failed: 0, uploads: 0, unsent: 0 };
    for (const r of rows ?? []) {
      if (r.status in stats) stats[r.status] = r.n;
    }

    const up = await db.getFirstAsync(
      `SELECT COUNT(*) AS n FROM upload_queue WHERE status IN ('pending', 'failed', 'uploading')`
    ).catch(() => null);
    stats.uploads = up?.n ?? 0;

    stats.unsent =
      stats.pending + stats.retrying + stats.conflict + stats.failed + stats.uploads;
    return stats;
  }

  /**
   * The one call that pushes local work to the server.
   *
   * Order matters: attachments upload before the mutations that reference
   * them, so a homework row never lands pointing at a file the server has
   * not received.
   */
  static async drain({ limit = 50, onSuccess, onProgress, includeUploads = true } = {}) {
    let uploads = null;
    if (includeUploads) {
      try {
        const { processPendingUploads } = require("./content.service");
        // Called, not just awaited. `await processPendingUploads` resolves to
        // the function object — no call, no error, and every queued
        // attachment stayed queued while the summary reported 0 uploads.
        uploads = await processPendingUploads()
      } catch (err) {
        console.warn("[MutationQueue] upload drain failed:", err.message);
      }
    }

    const summary = await this.processPending({ limit, onSuccess, onProgress });
    return { ...summary, uploads: uploads?.succeeded ?? 0, uploadsFailed: uploads?.failed ?? 0 };
  }

  /**
   * Repairs admission-decision outbox rows that were queued before the client
   * knew the backend only exposes PUT /admin/students/:id/approve|reject.
   *
   * Older builds enqueued student decisions with `method: "PATCH"` and a
   * fallback chain starting at /admin/applications/:id/approve and
   * /admin/student-applications/:id/approve — neither of which exists. The
   * rows failed, and because a failed row still occupies its entity_key,
   * the backfill pass would never re-enqueue a corrected version.
   *
   * This rewrites those rows in place: method → PUT, endpoint → the
   * /admin/students/:id/... form, and the payload's __endpoints chain to
   * the working list. Safe to call on every queue migration; it no-ops when
   * no stale row exists.
   *
   * @returns {Promise<number>} how many rows were repaired
   */
  static async repairStudentDecisionRows() {
    const db = await getDatabase();
    await ensureSchema(db);

    const rows = await db.getAllAsync(
      `SELECT id, entity_key, method, endpoint, payload
       FROM ${TABLE}
       WHERE entity_key LIKE 'student-decision:%'
         AND status IN ('pending', 'retrying', 'failed', 'conflict')`
    ).catch(() => []);
    if (!rows?.length) return 0;

    let repaired = 0;
    for (const row of rows ?? []) {
      const payload = parse(row.payload);
      const decision = payload?.status === "rejected" ? "reject" : "approve";
      const isStale =
        String(row.method || "").toUpperCase() !== "PUT" ||
        !/\/admin\/applications\/|\/admin\/student-applications\//.test(
          row.endpoint
        );

      if (!isStale) continue;

      const studentId = row.endpoint.split("/").filter(Boolean).pop();
      const newEndpoint = `/admin/students/${studentId}/${decision}`;
      payload.__endpoints = payload.__endpoints?.length
        ? [
            `/admin/students/${studentId}/${decision}`,
            ...payload.__endpoints.filter((e) =>
              !e.includes("/applications/") &&
              !e.includes("/student-applications/")
            ),
          ]
        : [
            `/admin/students/${studentId}/${decision}`,
            `/admin/applications/${studentId}/${decision}`,
            `/admin/student-applications/${studentId}/${decision}`,
          ];

      await db.runAsync(
        `UPDATE ${TABLE}
         SET method = 'PUT',
             endpoint = ?,
             payload = ?,
             status = 'pending',
             retry_count = 0,
             next_attempt_at = NULL,
             error = NULL,
             conflict = NULL
         WHERE id = ?`,
        [newEndpoint, json(payload), row.id]
      ).catch((err) => {
        console.warn("[MutationQueue] repair student-decision row failed:", err.message);
        return;
      });
      repaired++;
    }

    if (repaired) {
      console.log(`[MutationQueue] Repaired ${repaired} student-decision outbox row(s)`);
    }
    return repaired;
  }

  /**
   * Moves anything left in the abandoned `sync_queue` table into this one.
   *
   * Two modules used to define `sync_queue` with different, incompatible
   * columns, and both are now removed. Rows written by the surviving one
   * (queued quiz syncs) are migrated rather than dropped, then the table
   * goes. Safe to call on every start; it no-ops once the table is gone.
   */
  static async migrateLegacyQueue() {
    const db = await getDatabase();
    await ensureSchema(db);

    const exists = await db.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_queue'`
    ).catch(() => null);
    if (!exists) return 0;

    let migrated = 0;
    let dropped  = 0;
    try {
      // Only the quiz-shaped schema ever produced rows; probe for it.
      const cols = await db.getAllAsync(`PRAGMA table_info(sync_queue)`).catch(() => []);
      const names = new Set((cols ?? []).map((c) => c.name));

      if (names.has("entity") && names.has("payload")) {
        const rows = await db.getAllAsync(
          `SELECT * FROM sync_queue WHERE COALESCE(synced, 0) = 0`
        ).catch(() => []);

        // The real create routes. These used to have "/sync" appended (and
        // "/sync-one" for attempts), which matched nothing on the server: the
        // quiz router only ever exposed POST /questions, /quizzes and
        // /attempts. So every row this migration rescued was re-queued against
        // a 404, and a 404 on a POST is classified permanent — a device
        // carrying legacy rows converted them straight into failed mutations
        // that no retry would ever clear.
        //
        // Anything else returns null rather than a guessed path. A row we
        // cannot address is dropped with a warning, which is honest; inventing
        // an endpoint for it only manufactures another dead mutation.
        const endpointFor = (entity) => {
          switch (entity) {
            case "quiz_attempt":  return "/quiz/attempts";
            case "quiz_question": return "/quiz/questions";
            case "quiz":          return "/quiz/quizzes";
            default:              return null;
          }
        };

        for (const r of rows ?? []) {
          const endpoint = endpointFor(r.entity);
          if (!endpoint) {
            dropped++;
            console.warn(
              `[MutationQueue] legacy sync_queue row for unknown entity ` +
              `"${r.entity}" dropped — there is no route to send it to`
            );
            continue;
          }

          await this.enqueue({
            entityKey: `legacy:${r.entity}:${r.id}`,
            method: "POST",
            endpoint,
            payload: parse(r.payload),
          });
          migrated++;
        }
      }

      await db.execAsync(`DROP TABLE IF EXISTS sync_queue`);
      console.log(
        `[MutationQueue] Legacy sync_queue removed` +
        (migrated ? ` — ${migrated} row(s) migrated into the outbox` : "") +
        (dropped  ? ` — ${dropped} row(s) dropped (unknown entity)` : "") +
        (migrated || dropped ? "" : " (was empty)")
      );
    } catch (err) {
      console.warn("[MutationQueue] legacy queue migration failed:", err.message);
    }
    return migrated;
  }

  /** Rows a human may need to act on, newest first. */
  static async listUnresolved({ limit = 100 } = {}) {
    const db = await getDatabase();
    await ensureSchema(db);
    const rows = await db.getAllAsync(
      `SELECT * FROM ${TABLE}
       WHERE status IN ('conflict', 'failed') AND COALESCE(silent, 0) = 0
       ORDER BY last_attempt_at DESC, created_at DESC LIMIT ?`,
      [limit]
    ).catch(() => []);
    return (rows ?? []).map((r) => ({
      ...r,
      payload: parse(r.payload),
      conflict: r.conflict ? parse(r.conflict) : null,
    }));
  }

  /** Puts a parked row back in the queue with its retry budget reset. */
  static async retry(id) {
    const db = await getDatabase();
    await ensureSchema(db);
    await db.runAsync(
      `UPDATE ${TABLE} SET status = 'pending', retry_count = 0, next_attempt_at = NULL,
              error = NULL, conflict = NULL WHERE id = ?`,
      [id]
    );
  }

  /** Requeues every parked row. Returns how many were requeued. */
  static async retryAllFailed() {
    const db = await getDatabase();
    await ensureSchema(db);
    const result = await db.runAsync(
      `UPDATE ${TABLE} SET status = 'pending', retry_count = 0, next_attempt_at = NULL,
              error = NULL, conflict = NULL WHERE status IN ('conflict', 'failed')`
    );
    return result?.changes ?? 0;
  }

  /** Permanently drops a mutation the user has chosen to abandon. */
  static async discard(id) {
    const db = await getDatabase();
    await ensureSchema(db);
    await db.runAsync(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
  }

  /**
   * Drops still-unsent work for one entity, and reports how much it dropped.
   *
   * For undoing something the server has never seen. Deleting the local row on
   * its own would leave the queued mutation to create it anyway, so the record
   * would reappear on the next sync.
   *
   * Only rows that have not synced are touched — work the server has already
   * accepted is history, and history is corrected by appending, not by
   * deleting. If a send happens to be in flight the server may still store it;
   * the next pull brings it back, which is why callers must treat a zero
   * return as "too late, correct it the normal way".
   */
  static async cancelUnsent(entityKey) {
    const db = await getDatabase();
    await ensureSchema(db);
    const result = await db.runAsync(
      `DELETE FROM ${TABLE} WHERE entity_key = ? AND status != 'synced'`,
      [entityKey]
    ).catch(() => null);
    return result?.changes ?? 0;
  }

  /** Housekeeping — clears synced rows older than the given age. */
  static async pruneSynced({ olderThanMs = 7 * 24 * 60 * 60_000 } = {}) {
    const db = await getDatabase();
    await ensureSchema(db);
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = await db.runAsync(
      `DELETE FROM ${TABLE} WHERE status = 'synced' AND created_at < ?`, [cutoff]
    ).catch(() => ({ changes: 0 }));
    return result?.changes ?? 0;
  }
}

export default MutationQueue;
