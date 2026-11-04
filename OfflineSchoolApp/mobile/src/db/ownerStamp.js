// mobile/src/db/ownerStamp.js
"use strict";

/**
 * Who made a local change, recorded at the moment it is made.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * A row edited on the phone is marked dirty (_synced = 0) and nothing else.
 * The outbox records who queued a request (owner_id), but a dirty row that has
 * not been queued yet records nobody, so on a phone two teachers share the
 * next account to sync picks it up as its own (syncBackfill.service.js).
 * Deciding what to do about that is the owner's call (docs/40-per-user-local-
 * data.md); this module only makes sure that from now on the evidence exists.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 *
 *   - adds a nullable `_owner_id` column to each table the backfill reads
 *     dirty rows from. ADD COLUMN only: SQLite does not rewrite a single
 *     existing row, and every existing row reads NULL there;
 *   - creates TEMP triggers that set `_owner_id` to the signed-in account
 *     when a row is INSERTED dirty, or turns from clean (_synced = 1) to
 *     dirty. A row that is already dirty and edited again keeps whatever it
 *     had — a legacy ownerless row stays ownerless; nothing here decides
 *     whose it is.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────
 *
 *   - It does not touch any existing row's values, the outbox, the sync
 *     cursor, or what any screen reads.
 *   - Nothing reads `_owner_id` yet. The backfill still queues dirty rows
 *     under whoever is signed in, exactly as before.
 *
 * ── Why TEMP triggers ─────────────────────────────────────────────────────
 *
 * TEMP triggers and the TEMP owner table live in this connection only and
 * vanish when it closes. An older build installed over this one (a downgrade)
 * therefore finds no trigger at all, rather than a trigger that keeps
 * stamping whoever this build last saw signed in. The column stays; an older
 * build never names it.
 *
 * Every step is best effort: a failure to arm a table means that table's new
 * rows are ownerless, which is what they are today. It must never fail a
 * write.
 */

export const OWNER_COLUMN = "_owner_id";

/**
 * The tables syncBackfill.service.js turns dirty rows from (SPECS and
 * DELETE_SPECS). A table not on this list has no dirty-row path to the server.
 */
export const STAMPED_TABLES = Object.freeze([
  "fee_payments", "expenses", "gate_events",
  "classes", "subjects", "users", "teacher_assignments", "periods", "timetable",
  "attendance", "teacher_attendance",
  "questions", "quizzes", "quiz_attempts",
  "announcements", "students", "exams",
]);

const STAMPED = new Set(STAMPED_TABLES);
const OWNER_TABLE = "local_owner";

/** "INSERT OR REPLACE INTO students (…)" → "students". First statement only. */
export const tableOfWrite = (sql) => {
  const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+(?:main\.)?["`[]?(\w+)/i
    .exec(String(sql ?? ""));
  return m ? m[1] : null;
};

/** The signed-in account's id, or null. Same rule as the outbox's owner. */
const signedInAccount = () => {
  try {
    const { getCurrentAuth } = require("../utils/authHelpers");
    const user = getCurrentAuth()?.user;
    const id = user?._id ?? user?.id ?? null;
    return id ? String(id) : null;
  } catch {
    return null;
  }
};

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * One stamper per database handle. `raw` is the handle's ORIGINAL methods, so
 * the stamper's own statements are not reported as user changes.
 *
 * @param {{ execAsync: Function, runAsync: Function, getAllAsync: Function }} raw
 * @param {{ currentOwner?: () => string|null }} [options]
 */
export const createOwnerStamp = (raw, { currentOwner = signedInAccount } = {}) => {
  /** table → Promise<boolean> (armed or not). A false is retried later. */
  const arming = new Map();
  let ready = null;
  /** The owner last written to the TEMP table; undefined = unknown. */
  let written;

  const ensureOwnerTable = () => {
    if (!ready) {
      ready = raw.execAsync(
        `CREATE TEMP TABLE IF NOT EXISTS ${OWNER_TABLE} (
           k        TEXT PRIMARY KEY,
           owner_id TEXT
         )`
      ).then(() => true, () => { ready = null; return false; });
    }
    return ready;
  };

  const arm = async (table) => {
    if (!(await ensureOwnerTable())) return false;
    const cols = await raw.getAllAsync(`PRAGMA main.table_info(${quote(table)})`).catch(() => []);
    if (!cols?.length) return false;                       // not created yet — try again later
    const names = cols.map((c) => c.name);
    if (!names.includes("_synced")) return false;          // nothing to stamp against
    const pks = cols.filter((c) => Number(c.pk) > 0);
    if (pks.length !== 1) return false;                    // keyed on one column or not at all
    const pk = quote(pks[0].name);

    if (!names.includes(OWNER_COLUMN)) {
      // Additive. Existing rows read NULL; their stored bytes are not touched.
      await raw.execAsync(`ALTER TABLE main.${quote(table)} ADD COLUMN ${OWNER_COLUMN} TEXT`)
        .catch(() => {});
      const again = await raw.getAllAsync(`PRAGMA main.table_info(${quote(table)})`).catch(() => []);
      if (!again?.some((c) => c.name === OWNER_COLUMN)) return false;
    }

    const T = quote(table);
    const who = `(SELECT owner_id FROM temp.${OWNER_TABLE} WHERE k = 'current')`;
    const dirty = "(NEW._synced = 0 OR NEW._synced IS NULL)";
    try {
      await raw.execAsync(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${quote(`owner_stamp_ins_${table}`)}
         AFTER INSERT ON main.${T}
         WHEN NEW.${OWNER_COLUMN} IS NULL AND ${dirty}
         BEGIN
           UPDATE main.${T} SET ${OWNER_COLUMN} = ${who} WHERE ${pk} = NEW.${pk};
         END`
      );
      await raw.execAsync(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${quote(`owner_stamp_dirty_${table}`)}
         AFTER UPDATE OF _synced ON main.${T}
         WHEN OLD._synced = 1 AND ${dirty}
         BEGIN
           UPDATE main.${T} SET ${OWNER_COLUMN} = ${who} WHERE ${pk} = NEW.${pk};
         END`
      );
    } catch {
      return false;
    }
    return true;
  };

  const armOnce = (table) => {
    let p = arming.get(table);
    if (!p) {
      p = arm(table).catch(() => false).then((armed) => {
        if (!armed) arming.delete(table);
        return armed;
      });
      arming.set(table, p);
    }
    return p;
  };

  return {
    /**
     * Called before a write statement runs. Arms the table on first use and
     * records who is signed in, so the triggers stamp the right account.
     * Never throws.
     */
    async beforeWrite(sql) {
      try {
        // A rollback can undo a trigger, the owner row or the column this
        // stamper believes it created. Forget all of it and re-check: every
        // step is idempotent.
        if (/^\s*ROLLBACK\b/i.test(String(sql ?? ""))) {
          arming.clear(); ready = null; written = undefined;
          return;
        }
        const table = tableOfWrite(sql);
        if (!table || !STAMPED.has(table)) return;
        if (!(await armOnce(table))) return;
        // Written only when it changes: a pull writes thousands of rows and
        // must not pay a second statement for each. A rollback resets the
        // cache (above), so an undone write is written again.
        const owner = currentOwner();
        if (owner === written) return;
        await raw.runAsync(
          `INSERT OR REPLACE INTO temp.${OWNER_TABLE} (k, owner_id) VALUES ('current', ?)`,
          [owner]
        );
        written = owner;
      } catch {
        /* a stamp must never fail a write */
      }
    },
    /** For the check script. */
    armOnce,
  };
};

export default { createOwnerStamp, tableOfWrite, STAMPED_TABLES, OWNER_COLUMN };
