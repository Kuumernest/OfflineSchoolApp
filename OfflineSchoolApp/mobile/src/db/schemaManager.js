// src/db/schemaManager.js
"use strict";

/**
 * schemaManager.js
 *
 * Centralised schema verification with retry logic and error tracking.
 *
 * Design:
 *  - State tracked per table-name in a Map
 *  - Transient errors (locked DB, I/O) retry after TRANSIENT_RETRY_MS (2s)
 *  - Permanent errors (bad DDL syntax) retry after RETRY_DELAY_MS (30s)
 *  - Concurrent calls are serialised per table via a promise cache
 *  - getSchemaStatus / getAllSchemaStatuses return copies, never live refs
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SchemaState
 * @property {boolean}     verified     - true only when setup succeeded
 * @property {Error|null}  error        - last error, null if OK
 * @property {number|null} lastAttempt  - Date.now() of last attempt
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * How long (ms) to wait before retrying a permanently-failed schema setup
 * (e.g. DDL syntax error that will not fix itself).
 * Exported so tests can lower it without monkey-patching.
 */
export let RETRY_DELAY_MS = 30_000;

/**
 * How long (ms) to wait before retrying a transiently-failed setup
 * (e.g. "database is locked", disk I/O error).
 */
export let TRANSIENT_RETRY_MS = 2_000;

/**
 * Overrides the retry delays — useful in unit tests.
 * @param {{ permanent?: number, transient?: number }} opts
 */
export const setRetryDelays = ({ permanent, transient } = {}) => {
  if (permanent  !== undefined) RETRY_DELAY_MS     = permanent;
  if (transient  !== undefined) TRANSIENT_RETRY_MS = transient;
};

/**
 * Error message patterns that indicate a transient SQLite condition
 * (the same DDL may succeed if retried quickly).
 */
const TRANSIENT_PATTERNS = [
  /database is locked/i,
  /disk i\/o error/i,
  /unable to open database/i,
  /SQLITE_BUSY/i,
  /SQLITE_IOERR/i,
  /no such table/i,       // can happen during cold-start race
];

const isTransientError = (err) =>
  TRANSIENT_PATTERNS.some((re) => re.test(err?.message || ""));

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, SchemaState>} */
const schemaStates = new Map();

/**
 * In-flight setup promises — prevents duplicate concurrent schema calls.
 * @type {Map<string, Promise<boolean>>}
 */
const pendingSetups = new Map();

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Ensures a table's schema is set up exactly once per session,
 * with automatic retry after transient failures.
 *
 * @param {string}                     tableName - Unique key (usually the table name)
 * @param {(db: any) => Promise<void>} setupFn   - Async function that runs DDL
 * @param {any}                        db        - SQLite database instance
 * @returns {Promise<boolean>}         Resolves true when schema is ready
 * @throws  {Error}                    Re-throws setup errors so the caller can bail
 */
export const ensureTableSchema = async (tableName, setupFn, db) => {
  // ── Already verified ────────────────────────────────────────────────────────
  const state = schemaStates.get(tableName);
  if (state?.verified && !state.error) {
    return true;
  }

  // ── Previous failure — check retry window ───────────────────────────────────
  if (state?.error && state.lastAttempt !== null) {
    const elapsed     = Date.now() - (state.lastAttempt ?? 0);
    const retryWindow = isTransientError(state.error)
      ? TRANSIENT_RETRY_MS
      : RETRY_DELAY_MS;

    if (elapsed < retryWindow) {
      const waitSec = Math.ceil((retryWindow - elapsed) / 1_000);
      console.warn(
        `[schema] "${tableName}" previously failed ` +
        `(${isTransientError(state.error) ? "transient" : "permanent"}). ` +
        `Retry in ${waitSec}s.`
      );
      throw state.error;
    }

    console.log(
      `[schema] "${tableName}" retrying after ${
        isTransientError(state.error) ? "transient" : "permanent"
      } failure…`
    );
  }

  // ── Deduplicate concurrent calls ────────────────────────────────────────────
  if (pendingSetups.has(tableName)) {
    return pendingSetups.get(tableName);
  }

  // ── Run setup ───────────────────────────────────────────────────────────────
  //
  // IMPORTANT: pendingSetups.set() is called BEFORE the promise is awaited
  // so that any concurrent caller that arrives while setup is in progress
  // receives the same promise rather than starting a second setup.
  //
  const setupPromise = (async () => {
    console.log(`[schema] Setting up "${tableName}"…`);

    try {
      await setupFn(db);

      schemaStates.set(tableName, {
        verified:    true,
        error:       null,
        lastAttempt: Date.now(),
      });

      console.log(`[schema] ✅ "${tableName}" ready`);
      return true;
    } catch (err) {
      console.error(
        `[schema] ❌ "${tableName}" setup failed ` +
        `(${isTransientError(err) ? "transient" : "permanent"}): ` +
        err.message
      );

      schemaStates.set(tableName, {
        verified:    false,
        error:       err,
        lastAttempt: Date.now(),
      });

      throw err;
    } finally {
      pendingSetups.delete(tableName);
    }
  })();

  pendingSetups.set(tableName, setupPromise);
  return setupPromise;
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Clears the cached state for a table so the next call to
 * ensureTableSchema() runs the setup function again immediately,
 * regardless of the retry window.
 *
 * Use this after resolving a transient error, or to force a re-migration.
 *
 * @param {string} tableName
 */
export const resetTableSchema = (tableName) => {
  schemaStates.delete(tableName);
  pendingSetups.delete(tableName);
  console.log(`[schema] State reset for "${tableName}"`);
};

/**
 * Alias for resetTableSchema — documents intent when used as an escape hatch
 * after a known-transient error is resolved.
 *
 * @param {string} tableName
 */
export const forceRetrySchema = (tableName) => resetTableSchema(tableName);

/**
 * Clears ALL cached schema states.
 * Call on logout or database reset.
 */
export const resetAllSchemas = () => {
  schemaStates.clear();
  pendingSetups.clear();
  console.log("[schema] All schema states reset");
};

/**
 * Returns a **copy** of the current verification state for a table.
 * The error field is serialised to a string so callers cannot mutate
 * internal state through the returned object.
 *
 * @param {string} tableName
 * @returns {{ verified: boolean, error: string|null, lastAttempt: number|null }}
 */
export const getSchemaStatus = (tableName) => {
  const state = schemaStates.get(tableName);
  if (!state) return { verified: false, error: null, lastAttempt: null };
  return {
    verified:    state.verified,
    error:       state.error?.message ?? null,
    lastAttempt: state.lastAttempt,
  };
};

/**
 * Returns a snapshot of all schema states.
 * Errors are serialised to strings — callers receive copies, not live refs.
 *
 * @returns {Record<string, { verified: boolean, error: string|null, lastAttempt: number|null }>}
 */
export const getAllSchemaStatuses = () => {
  const result = {};
  for (const [key, state] of schemaStates) {
    result[key] = {
      verified:    state.verified,
      error:       state.error?.message ?? null,
      lastAttempt: state.lastAttempt,
    };
  }
  return result;
};

/**
 * Returns true if the given table's schema has been successfully verified.
 *
 * @param {string} tableName
 * @returns {boolean}
 */
export const isSchemaReady = (tableName) =>
  schemaStates.get(tableName)?.verified === true;