// src/services/sync-overwrite.service.js
"use strict";

/**
 * sync-overwrite.service.js
 *
 * Local storage for LWW overwrite records.
 *
 * When an admin's edit silently overwrites a more recent edit from another
 * admin, the server logs it (a SyncOverwrite). Two copies reach phones, and
 * they are not the same thing:
 *
 *   side = "lost"  the signed-in user's OWN edit was replaced by somebody
 *                  else. Fetched from GET /sync/overwrites/mine. These are
 *                  what the dashboard badge counts and the screen leads with;
 *                  marking one seen is sent back to the server.
 *   side = "won"   this user's request did the replacing — the `overwrote`
 *                  object a student write answers with. Kept as a quiet note
 *                  ("you replaced X's change"): stored already seen and never
 *                  counted, so the person who overwrote is not told they were
 *                  overwritten.
 *
 * Before the server route existed only the "won" copy was stored, and the
 * screen read it as "X's edit replaced yours" — telling the WINNER, in the
 * loser's words, and the loser nothing. Rows from that time have no side and
 * are treated as "won".
 */

import { getDatabase } from "../db/database";
import api from "./api";

// ─────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────

const TABLE = "sync_overwrites";

// Per database: each signed-in user has their own file (perUserData), and a
// flag for the whole module skipped the table on every file after the first.
const schemaVerified = new WeakSet();

const ensureSchema = async (db) => {
  if (schemaVerified.has(db)) return;

  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id                  TEXT PRIMARY KEY,
        entity_type         TEXT NOT NULL,
        entity_id           TEXT NOT NULL,
        entity_name         TEXT,
        school_id           TEXT,
        overwritten_by      TEXT,
        overwritten_by_name TEXT,
        overwritten_at      TEXT,
        new_action          TEXT,
        lost_edit_by        TEXT,
        lost_edit_by_name   TEXT,
        lost_edit_at        TEXT,
        lost_version        TEXT,
        seen_by_loser       INTEGER DEFAULT 0,
        seen_at             TEXT,
        created_at          TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Added after the first release; an existing table gains them here.
    for (const col of [
      "side TEXT",                        // "lost" | "won" | NULL (= won, older build)
      "owner_id TEXT",                    // whose list this row belongs to
      "seen_pending INTEGER DEFAULT 0",   // seen here, not yet told to the server
      "hidden INTEGER DEFAULT 0",         // removed from this phone's list
    ]) {
      await db.execAsync(`ALTER TABLE ${TABLE} ADD COLUMN ${col}`).catch(() => {});
    }

    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_overwrites_school
        ON ${TABLE}(school_id, seen_by_loser)
    `).catch(() => {});

    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_overwrites_entity
        ON ${TABLE}(entity_type, entity_id)
    `).catch(() => {});

    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_overwrites_created
        ON ${TABLE}(created_at DESC)
    `).catch(() => {});

    schemaVerified.add(db);
    console.log("[sync-overwrite] Schema ready");
  } catch (err) {
    console.warn("[sync-overwrite] Schema setup failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// WHO IS SIGNED IN
// ─────────────────────────────────────────────────────────────

const currentUser = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const st = useAuthStore.getState();
    const u  = st?.user ?? null;
    const id = u?._id ?? u?.id ?? null;
    return { id: id ? String(id) : null, name: u?.name ?? null, hasToken: Boolean(st?.token) };
  } catch {
    return { id: null, name: null, hasToken: false };
  }
};

// A row is in the signed-in user's list when it names them, or when it
// predates the owner column (an older build's winner copy on this phone).
const ownerClause = (userId) =>
  userId
    ? { sql: " AND (owner_id = ? OR owner_id IS NULL)", params: [userId] }
    : { sql: "", params: [] };

// ─────────────────────────────────────────────────────────────
// SERVER — the loser's own list
// ─────────────────────────────────────────────────────────────

const REFRESH_EVERY_MS = 60_000;
const REFRESH_WAIT_MS  = 4_000;
let lastRefresh = { userId: null, at: 0 };
let inFlight    = null;

/** Tell the server about rows marked seen here while it could not be reached. */
const pushPendingSeen = async (db, userId) => {
  const rows = await db.getAllAsync(
    `SELECT id FROM ${TABLE} WHERE seen_pending = 1 AND side = 'lost' AND owner_id = ?`,
    [userId]
  );
  for (const { id } of rows || []) {
    try {
      await api.post(`/sync/overwrites/${encodeURIComponent(id)}/seen`);
      await db.runAsync(`UPDATE ${TABLE} SET seen_pending = 0 WHERE id = ?`, [id]);
    } catch (err) {
      // 404: not this user's, or gone — there is nothing more to tell.
      if (err?.response?.status === 404) {
        await db.runAsync(`UPDATE ${TABLE} SET seen_pending = 0 WHERE id = ?`, [id]);
      } else {
        throw err;   // offline: stop, and try again next time
      }
    }
  }
};

const fetchMine = async (db, user) => {
  await pushPendingSeen(db, user.id);

  const res  = await api.get("/sync/overwrites/mine", { params: { limit: 100 } });
  const body = res?.data ?? {};
  const list = body?.data?.overwrites ?? body?.overwrites ?? [];

  for (const o of list) {
    if (!o?.id) continue;
    // Seen is one-way: seen here (and not yet pushed) or seen on another
    // device both stay seen. Everything else is the server's word.
    await db.runAsync(
      `INSERT INTO ${TABLE} (
         id, entity_type, entity_id, entity_name, school_id,
         overwritten_by, overwritten_by_name, overwritten_at,
         new_action, lost_edit_by, lost_edit_by_name, lost_edit_at,
         lost_version, seen_by_loser, seen_at, created_at, side, owner_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lost', ?)
       ON CONFLICT(id) DO UPDATE SET
         entity_type         = excluded.entity_type,
         entity_id           = excluded.entity_id,
         entity_name         = excluded.entity_name,
         school_id           = excluded.school_id,
         overwritten_by      = excluded.overwritten_by,
         overwritten_by_name = excluded.overwritten_by_name,
         overwritten_at      = excluded.overwritten_at,
         new_action          = excluded.new_action,
         lost_edit_by        = excluded.lost_edit_by,
         lost_edit_by_name   = excluded.lost_edit_by_name,
         lost_edit_at        = excluded.lost_edit_at,
         lost_version        = excluded.lost_version,
         seen_by_loser       = MAX(COALESCE(${TABLE}.seen_by_loser, 0), excluded.seen_by_loser),
         seen_at             = COALESCE(${TABLE}.seen_at, excluded.seen_at),
         side                = 'lost',
         owner_id            = excluded.owner_id`,
      [
        String(o.id),
        o.entityType        || "unknown",
        o.entityId          || "",
        o.entityName        ?? null,
        o.schoolId          ?? null,
        o.overwrittenBy     ?? null,
        o.overwrittenByName ?? null,
        o.overwrittenAt     ?? null,
        o.newAction         ?? null,
        o.lostEditBy        ?? null,
        o.lostEditByName    ?? null,
        o.lostEditAt        ?? null,
        o.lostVersion ? JSON.stringify(o.lostVersion) : null,
        o.seenByLoser ? 1 : 0,
        o.seenAt            ?? null,
        o.createdAt         ?? new Date().toISOString(),
        user.id,
      ]
    );
  }
  return list.length;
};

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

export const SyncOverwriteService = {

  /**
   * Bring down the signed-in user's own overwritten edits from the server.
   *
   * At most once a minute unless `force`. Never throws — offline, signed out
   * or a server without the route all leave the local list as it is.
   *
   * @returns {Promise<boolean>} true when the server was reached.
   */
  async refreshFromServer({ force = false } = {}) {
    const user = currentUser();
    if (!user.id || !user.hasToken) return false;
    if (!force && lastRefresh.userId === user.id && Date.now() - lastRefresh.at < REFRESH_EVERY_MS) {
      return false;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const db = await getDatabase();
        await ensureSchema(db);
        await fetchMine(db, user);
        lastRefresh = { userId: user.id, at: Date.now() };
        return true;
      } catch (err) {
        console.warn("[sync-overwrite] refresh failed:", err?.message);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  /**
   * Save the `overwrote` object a student write answered with: this user's
   * request replaced somebody else's change (the WINNER's note).
   *
   * Stored already seen — it is not news to the person who did it, and the
   * badge is for edits of yours that were lost.
   *
   * @param {object} overwrote - The `overwrote` object from server response.
   *   Expected shape: { id, lostEditAt, lostEditById, lostEditByName, ... }
   * @param {object} ctx - Additional context about the mutation.
   * @param {string} ctx.entityType   - e.g. "student"
   * @param {string} ctx.entityId     - The record's ID
   * @param {string} [ctx.entityName] - Display label
   * @param {string} [ctx.schoolId]
   * @param {string} [ctx.action]     - "edit", "suspend", "restore", "delete", "move"
   * @returns {Promise<string|null>} The saved record's ID, or null on failure.
   */
  async saveOverwrite(overwrote, ctx = {}) {
    if (!overwrote || !overwrote.id) {
      console.warn("[sync-overwrite] saveOverwrite: missing overwrote or id");
      return null;
    }

    try {
      const db = await getDatabase();
      await ensureSchema(db);

      const id  = String(overwrote.id);
      const me  = currentUser();
      const now = new Date().toISOString();

      await db.runAsync(
        `INSERT INTO ${TABLE} (
           id, entity_type, entity_id, entity_name, school_id,
           overwritten_by, overwritten_by_name, overwritten_at,
           new_action, lost_edit_by, lost_edit_by_name, lost_edit_at,
           lost_version, seen_by_loser, seen_at, created_at, side, owner_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'won', ?)
         ON CONFLICT(id) DO NOTHING`,
        [
          id,
          ctx.entityType || "unknown",
          ctx.entityId   || "",
          ctx.entityName || null,
          ctx.schoolId   || null,
          overwrote.overwrittenBy     || me.id   || null,
          overwrote.overwrittenByName || me.name || null,
          overwrote.overwrittenAt     || now,
          ctx.action                  || null,
          overwrote.lostEditById      || null,
          // Older servers sent only `lostEditBy`, and it held the name.
          overwrote.lostEditByName    || overwrote.lostEditBy || null,
          overwrote.lostEditAt        || null,
          overwrote.lostVersion
            ? JSON.stringify(overwrote.lostVersion)
            : null,
          now,
          now,
          me.id,
        ]
      );

      console.log(
        `[sync-overwrite] 💾 Saved overwrite ${id} for ${ctx.entityType}/${ctx.entityId}`
      );

      return id;
    } catch (err) {
      console.warn("[sync-overwrite] saveOverwrite failed:", err.message);
      return null;
    }
  },

  /**
   * Count the signed-in user's own unseen overwritten edits, for the
   * dashboard tile. Online, the server's list is brought down first (at most
   * once a minute, and never waited on for more than a few seconds).
   *
   * @param {string} [schoolId] - Optional filter by school.
   * @returns {Promise<number>}
   */
  async getUnseenCount(schoolId = null) {
    try {
      let timer = null;
      await Promise.race([
        this.refreshFromServer(),
        new Promise((r) => { timer = setTimeout(r, REFRESH_WAIT_MS); }),
      ]);
      clearTimeout(timer);

      const db = await getDatabase();
      await ensureSchema(db);

      const own = ownerClause(currentUser().id);
      let q = `SELECT COUNT(*) AS count FROM ${TABLE}
               WHERE seen_by_loser = 0 AND side = 'lost'
                 AND COALESCE(hidden, 0) = 0${own.sql}`;
      const params = [...own.params];
      if (schoolId) {
        q += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }

      const row = await db.getFirstAsync(q, params);
      return row?.count ?? 0;
    } catch (err) {
      console.warn("[sync-overwrite] getUnseenCount failed:", err.message);
      return 0;
    }
  },

  /**
   * The signed-in user's list: their lost edits first (unseen first), then
   * the notes of changes they replaced.
   *
   * @param {object} [opts]
   * @param {string}  [opts.schoolId]
   * @param {boolean} [opts.unseenOnly=false]
   * @param {number}  [opts.limit=100]
   * @returns {Promise<object[]>}
   */
  async getAllOverwrites({
    schoolId    = null,
    unseenOnly  = false,
    limit       = 100,
  } = {}) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);

      const own = ownerClause(currentUser().id);
      let q = `SELECT * FROM ${TABLE} WHERE COALESCE(hidden, 0) = 0${own.sql}`;
      const params = [...own.params];

      if (schoolId) {
        q += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }
      if (unseenOnly) {
        q += ` AND seen_by_loser = 0`;
      }

      q += ` ORDER BY CASE WHEN side = 'lost' THEN 0 ELSE 1 END,
                      seen_by_loser ASC, created_at DESC LIMIT ?`;
      params.push(limit);

      const rows = await db.getAllAsync(q, params);

      // Parse lost_version JSON blobs back to objects
      return (rows || []).map((r) => ({
        ...r,
        side:         r.side === "lost" ? "lost" : "won",
        lost_version: r.lost_version ? safeParseJson(r.lost_version) : null,
      }));
    } catch (err) {
      console.warn("[sync-overwrite] getAllOverwrites failed:", err.message);
      return [];
    }
  },

  /**
   * Fetch a single overwrite by ID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    if (!id) return null;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      const row = await db.getFirstAsync(
        `SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`,
        [id]
      );
      if (!row) return null;
      return {
        ...row,
        side:         row.side === "lost" ? "lost" : "won",
        lost_version: row.lost_version ? safeParseJson(row.lost_version) : null,
      };
    } catch (err) {
      console.warn("[sync-overwrite] getById failed:", err.message);
      return null;
    }
  },

  /**
   * Mark an overwrite as seen (removes it from the dashboard tile count).
   * A lost edit is the server's record too: it is flagged to be told, and
   * told now when it can be — offline, the next refresh sends it.
   *
   * @param {string} id
   */
  async markAsSeen(id) {
    if (!id) return;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      await db.runAsync(
        `UPDATE ${TABLE}
         SET seen_pending  = CASE WHEN side = 'lost' AND seen_by_loser = 0 THEN 1 ELSE seen_pending END,
             seen_by_loser = 1,
             seen_at       = COALESCE(seen_at, ?)
         WHERE id = ?`,
        [new Date().toISOString(), id]
      );
      await this.pushSeen();
    } catch (err) {
      console.warn("[sync-overwrite] markAsSeen failed:", err.message);
    }
  },

  /**
   * Mark ALL of the signed-in user's unseen overwrites as seen (bulk
   * dismiss). Each lost one is sent by id, not as "all": one that reached the
   * server after this list was loaded has not been seen.
   *
   * @param {string} [schoolId]
   */
  async markAllAsSeen(schoolId = null) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);

      const own = ownerClause(currentUser().id);
      let q = `UPDATE ${TABLE}
               SET seen_pending  = CASE WHEN side = 'lost' THEN 1 ELSE seen_pending END,
                   seen_by_loser = 1,
                   seen_at       = ?
               WHERE seen_by_loser = 0${own.sql}`;
      const params = [new Date().toISOString(), ...own.params];
      if (schoolId) {
        q += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }

      const result = await db.runAsync(q, params);
      console.log(`[sync-overwrite] Marked ${result?.changes ?? 0} as seen`);
      await this.pushSeen();
    } catch (err) {
      console.warn("[sync-overwrite] markAllAsSeen failed:", err.message);
    }
  },

  /** Send rows marked seen on this phone to the server. Never throws. */
  async pushSeen() {
    const user = currentUser();
    if (!user.id || !user.hasToken) return false;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      await pushPendingSeen(db, user.id);
      return true;
    } catch (err) {
      console.warn("[sync-overwrite] seen not sent yet:", err?.message);
      return false;
    }
  },

  /**
   * Remove an overwrite from this phone's list.
   *
   * A lost edit is kept by the server and would come back on the next
   * refresh, so it is marked seen and hidden here instead of deleted.
   *
   * @param {string} id
   */
  async deleteOverwrite(id) {
    if (!id) return;
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      const row = await db.getFirstAsync(`SELECT side FROM ${TABLE} WHERE id = ?`, [id]);
      if (row?.side === "lost") {
        await this.markAsSeen(id);
        await db.runAsync(`UPDATE ${TABLE} SET hidden = 1 WHERE id = ?`, [id]);
        return;
      }
      await db.runAsync(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    } catch (err) {
      console.warn("[sync-overwrite] deleteOverwrite failed:", err.message);
    }
  },

  /**
   * Cleanup: remove the winner's notes older than N days that have been
   * seen. Lost edits stay: the server would only bring them back.
   *
   * @param {number} [daysToKeep=30]
   * @returns {Promise<number>} Number of rows removed.
   */
  async cleanup(daysToKeep = 30) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      const result = await db.runAsync(
        `DELETE FROM ${TABLE}
         WHERE seen_by_loser = 1
           AND COALESCE(side, 'won') = 'won'
           AND created_at < datetime('now', ?)`,
        [`-${daysToKeep} days`]
      );
      const removed = result?.changes ?? 0;
      if (removed > 0) {
        console.log(`[sync-overwrite] 🧹 Cleaned ${removed} old overwrite(s)`);
      }
      return removed;
    } catch (err) {
      console.warn("[sync-overwrite] cleanup failed:", err.message);
      return 0;
    }
  },
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const safeParseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export default SyncOverwriteService;
