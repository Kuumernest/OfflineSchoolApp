// src/utils/syncHelpers.js
"use strict";

/**
 * syncHelpers.js
 *
 * Reusable async patterns for data synchronisation.
 *
 * Problem solved:
 *  - The "try server → fall back to local" pattern was copied verbatim
 *    into studentApplications, subject, timetable, and teacher services
 *  - Timeout values, error logging, and response parsing all differed
 *  - Bugs had to be fixed in 4+ places
 *
 * Three exported patterns:
 *  1. fetchWithFallback  — server first, local on failure
 *  2. syncFromServer     — pull from server and persist locally
 *  3. pushUnsynced       — push local-only changes to server
 */

import NetInfo from "@react-native-community/netinfo";
import api     from "../services/api";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000;

// ─── Network check ────────────────────────────────────────────────────────────

/**
 * Returns true if the device currently has a network connection.
 * Defaults to false on error so offline behaviour is safe.
 *
 * @returns {Promise<boolean>}
 */
const isConnected = async () => {
  try {
    const info = await NetInfo.fetch();
    return info.isConnected === true;
  } catch {
    return false;
  }
};

// ─── Response normaliser ──────────────────────────────────────────────────────

/**
 * Extracts a data array from a variety of server response shapes.
 *
 * Handles:
 *  { data: [...] }
 *  { items: [...] }
 *  { students: [...] }
 *  { subjects: [...] }
 *  [...] (raw array)
 *
 * @param {any}    responseData - The response.data object from axios
 * @param {string} [hint]       - Key to try first (e.g. "subjects")
 * @returns {any[]}
 */
const extractArray = (responseData, hint) => {
  if (Array.isArray(responseData)) return responseData;
  if (!responseData || typeof responseData !== "object") return [];

  // Try the hinted key first
  if (hint && Array.isArray(responseData[hint])) return responseData[hint];

  // Try common wrapper keys in priority order
  for (const key of ["data", "items", "results", "records"]) {
    if (Array.isArray(responseData[key])) return responseData[key];
  }

  // Last resort: first array-valued key found
  for (const key of Object.keys(responseData)) {
    if (Array.isArray(responseData[key])) return responseData[key];
  }

  return [];
};

// ═════════════════════════════════════════════════════════════════════════════
// PATTERN 1 — fetchWithFallback
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetches data from the server and falls back to a local source on failure.
 *
 * Flow:
 *  1. Check network connectivity
 *  2. If offline → skip to step 4
 *  3. Call `serverFetch()`
 *     - If successful → optionally persist → return normalised data
 *     - If it throws  → log warning → fall to step 4
 *  4. Call `localFetch()` and return its result
 *
 * @template T
 * @param {object}  opts
 * @param {string}  opts.label              - Used in log messages
 * @param {() => Promise<{ data: any, normalized: T[], count?: number }>} opts.serverFetch
 * @param {((data: any) => Promise<void>)=} opts.persistLocal
 * @param {() => Promise<T[]>}              opts.localFetch
 * @param {number=}  opts.timeoutMs
 * @returns {Promise<T[]>}
 *
 * @example
 * return fetchWithFallback({
 *   label: "pending applications",
 *   serverFetch: async () => {
 *     const res  = await api.get("/admin/students/pending", { params });
 *     const raw  = res.data?.students ?? [];
 *     return { data: raw, normalized: raw.map(normalise), count: raw.length };
 *   },
 *   persistLocal: (raw) => persistLocally(raw),
 *   localFetch:   () => getLocalPending(db),
 * });
 */
export const fetchWithFallback = async ({
  label,
  serverFetch,
  persistLocal,
  localFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const online = await isConnected();

  if (!online) {
    console.log(`📴 [${label}] Offline — using local data`);
    try {
      return (await localFetch()) ?? [];
    } catch (localErr) {
      console.error(`❌ [${label}] Local fetch failed:`, localErr.message);
      return [];
    }
  }

  // ── Try server ──────────────────────────────────────────────────────────────
  try {
    console.log(`📡 [${label}] Fetching from server…`);

    const result = await Promise.race([
      serverFetch(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs)
      ),
    ]);

    // Persist to local DB for offline use
    if (persistLocal && result?.data) {
      try {
        await persistLocal(result.data);
      } catch (persistErr) {
        // Non-fatal — we still return the server data
        console.warn(`⚠️ [${label}] Persist failed:`, persistErr.message);
      }
    }

    const count = result?.count ?? result?.normalized?.length ?? 0;
    console.log(`✅ [${label}] Got ${count} item(s) from server`);
    return result?.normalized ?? [];
  } catch (serverErr) {
    console.warn(
      `⚠️ [${label}] Server failed (${serverErr.message}), falling back to local`
    );
  }

  // ── Fall back to local ──────────────────────────────────────────────────────
  try {
    const local = (await localFetch()) ?? [];
    console.log(`✅ [${label}] Got ${local.length} item(s) from local DB`);
    return local;
  } catch (localErr) {
    console.error(`❌ [${label}] Local fallback failed:`, localErr.message);
    return [];
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// PATTERN 2 — syncFromServer
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Pulls a collection from the server, normalises it, and persists locally.
 *
 * @param {object}  opts
 * @param {string}  opts.label
 * @param {string}  opts.endpoint
 * @param {object=} opts.params
 * @param {string=} opts.responseKey      - Hint key for extractArray()
 * @param {(raw: any) => any} opts.normalise
 * @param {(items: any[]) => Promise<void>} opts.persist
 * @param {number=} opts.timeoutMs
 * @returns {Promise<number>}             Items synced (0 on failure)
 */
export const syncFromServer = async ({
  label,
  endpoint,
  params      = {},
  responseKey,
  normalise,
  persist,
  timeoutMs   = DEFAULT_TIMEOUT_MS,
}) => {
  const online = await isConnected();
  if (!online) {
    console.log(`📴 [${label}] Offline — skipping server sync`);
    return 0;
  }

  try {
    console.log(`🔄 [${label}] Syncing from server…`);

    const response = await Promise.race([
      api.get(endpoint, { params, timeout: timeoutMs }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), timeoutMs)
      ),
    ]);

    const raw        = extractArray(response.data, responseKey);
    const normalised = raw.map(normalise).filter(Boolean);

    await persist(normalised);

    console.log(`✅ [${label}] Synced ${normalised.length} item(s)`);
    return normalised.length;
  } catch (err) {
    console.warn(`⚠️ [${label}] Server sync failed:`, err.message);
    return 0;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// PATTERN 3 — pushUnsynced
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Pushes locally-created records to the server, then marks them as synced.
 *
 * @param {object}   opts
 * @param {string}   opts.label
 * @param {(db: any) => Promise<any[]>}   opts.getUnsynced
 * @param {(row: any) => Promise<any>}    opts.pushOne
 * @param {(id: string, serverId: string, db: any) => Promise<void>} opts.markSynced
 * @param {any}      opts.db
 * @returns {Promise<{ pushed: number, failed: number }>}
 */
export const pushUnsynced = async ({
  label,
  getUnsynced,
  pushOne,
  markSynced,
  db,
}) => {
  const online = await isConnected();
  if (!online) {
    console.log(`📴 [${label}] Offline — queuing changes for later`);
    return { pushed: 0, failed: 0 };
  }

  let pushed = 0;
  let failed = 0;

  try {
    const unsynced = (await getUnsynced(db)) ?? [];

    if (!unsynced.length) {
      console.log(`✅ [${label}] Nothing to push`);
      return { pushed: 0, failed: 0 };
    }

    console.log(`📤 [${label}] Pushing ${unsynced.length} record(s)…`);

    for (const row of unsynced) {
      try {
        const serverRecord = await pushOne(row);
        const serverId     = serverRecord?._id ?? serverRecord?.id ?? row.id;
        await markSynced(row.id, serverId, db);
        pushed++;
      } catch (err) {
        console.warn(`⚠️ [${label}] Failed to push "${row.id}":`, err.message);
        failed++;
      }
    }

    console.log(`✅ [${label}] Pushed ${pushed}/${unsynced.length} (${failed} failed)`);
  } catch (err) {
    console.error(`❌ [${label}] Push operation failed:`, err.message);
  }

  return { pushed, failed };
};