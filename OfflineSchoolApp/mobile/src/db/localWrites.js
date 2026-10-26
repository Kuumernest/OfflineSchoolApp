// mobile/src/db/localWrites.js
"use strict";

/**
 * "Something was written to the local database", for whoever wants to know.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A change made on the phone left the device only at the next reconnect,
 * foreground or five-minute tick. Nothing reacted to the change itself.
 *
 * The obvious fix — call "sync soon" after every save — needs a call at each
 * of the ~80 places that mark a row dirty, across twenty services, and the
 * next save somebody writes would forget it. A dirty row is already picked up
 * by the backfill whoever wrote it (syncBackfill.service.js), so what is
 * missing is only the nudge. That can come from the one place every write
 * passes through: the database handle.
 *
 * ── What it reports, and what it does not ─────────────────────────────────
 *
 * Every data-changing statement through runAsync or execAsync, minus the
 * outbox's own bookkeeping (a drain writing its own status would otherwise
 * wake itself up). It does not try to tell a user's edit from a screen caching
 * what it fetched: the listener's response is a local backfill scan, which
 * finds nothing to send in the second case and costs no network.
 *
 * Not the SQLite update hook (enableChangeListener): that fires once per ROW,
 * so a pull of five thousand students would cross the bridge five thousand
 * times. This fires once per statement, and listeners debounce.
 */

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Tables whose writes are the sync's own machinery, never a user's change. */
const IGNORED = /\b(mutation_outbox|sync_id_map)\b/i;

const listeners = new Set();

/** Is this statement a change worth reporting? Exported for the check script. */
export const isReportableWrite = (sql) => {
  const text = String(sql ?? "");
  return WRITE.test(text) && !IGNORED.test(text);
};

export const onLocalWrite = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const noteStatement = (sql) => {
  if (!listeners.size || !isReportableWrite(sql)) return;
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener must never fail a write */ }
  }
};

/**
 * Wrap a database handle's write methods so each statement is reported.
 * Reported after the statement succeeds; a failed write changed nothing.
 */
export const instrument = (db) => {
  if (!db || db.__localWritesInstrumented) return db;
  for (const method of ["runAsync", "execAsync"]) {
    const original = db[method]?.bind(db);
    if (!original) continue;
    db[method] = async (sql, ...rest) => {
      const result = await original(sql, ...rest);
      noteStatement(sql);
      return result;
    };
  }
  db.__localWritesInstrumented = true;
  return db;
};

export default { onLocalWrite, noteStatement, instrument, isReportableWrite };
