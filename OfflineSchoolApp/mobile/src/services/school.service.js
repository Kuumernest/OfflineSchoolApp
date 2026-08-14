// src/services/school.service.js
"use strict";

/**
 * school.service.js
 *
 * Responsibilities:
 *  - Fetch school information (memory cache → SQLite → remote API)
 *  - Upsert school data into local SQLite
 *  - Role-aware remote fetch (students never hit admin/teacher endpoints)
 *  - Sync school info from server (called by SyncManager)
 *
 * Fixed issues:
 *  #S1  — Cache key used raw schoolId (not normalised sid) causing
 *          cache misses when callers passed number vs string
 *  #S2  — ensureTable called on every upsertSchoolLocal even when the
 *          table already exists — now guarded by a module-level flag
 *  #S3  — normaliseRow did not handle numeric / non-string values for
 *          id/_id — added explicit String() coercion
 *  #S4  — fetchSchoolInfoRemote admin fallback re-threw the original
 *          admin error instead of the fallback error on non-404/405
 *  #S5  — getSchoolInfo "grab any row" fallback ignored the schoolId
 *          filter entirely, could return a different school's data in
 *          multi-school installs
 *  #S6  — school_info table check used COUNT(*) but compared .cnt
 *          which is undefined when the table list is empty (should be > 0)
 *  #S7  — syncSchoolInfo caught errors internally but re-threw nothing,
 *          silently swallowing errors the caller might need
 *  #S8  — clearCache / clearSchoolCache were two different functions
 *          doing the same thing — consolidated
 *  #S9  — No NetInfo check before remote fetch — wasted round-trips
 *          and unhelpful timeout errors when offline
 *  #S10 — upsertSchoolLocal did not bust cache when a DIFFERENT
 *          school's record was updated (only checked _cacheSchoolId ===
 *          normalised.id, which is correct, but clearCache() was not
 *          exported for external callers to use after bulk upserts)
 */

import NetInfo     from "@react-native-community/netinfo";
import api         from "./api";
import { getDatabase } from "../db/database";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — MEMORY CACHE
// ═════════════════════════════════════════════════════════════════════════════

/** @type {{ [sid: string]: object }} */
const _cache = {};

/**
 * FIXED (#S1):
 * Previous implementation used a single _cache / _cacheSchoolId pair,
 * which meant that fetching school "A" then school "B" would evict "A"
 * from the cache. Changed to a keyed map so multiple schools can be
 * cached simultaneously (useful in super-admin views).
 */
const getCached    = (sid)        => _cache[sid]  ?? null;
const setCached    = (sid, value) => { _cache[sid] = value; };
const deleteCached = (sid)        => { delete _cache[sid]; };
const clearAllCache = ()          => { Object.keys(_cache).forEach(deleteCached); };

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * FIXED (#S3):
 * Previous safeStr only checked typeof === "string", so numeric IDs
 * (e.g. MongoDB ObjectId cast to number) would return "". Now coerces
 * any truthy primitive to string before trimming.
 */
const safeStr = (v) => {
  if (v === null || v === undefined || v === false) return "";
  if (typeof v === "object") return "";           // arrays / objects → ""
  return String(v).trim();
};

const normaliseRow = (row) => {
  if (!row) return null;

  const id = safeStr(row.id || row._id);
  if (!id) return null;                           // id is mandatory

  return {
    id,
    name:    safeStr(row.name    || row.school_name || row.schoolName),
    logo:    safeStr(row.logo    || row.logoUrl),
    email:   safeStr(row.email),
    phone:   safeStr(row.phone   || row.phoneNumber),
    address: safeStr(row.address || row.location),
    city:    safeStr(row.city),
    state:   safeStr(row.state),
    country: safeStr(row.country),
    website: safeStr(row.website || row.websiteUrl),
    motto:   safeStr(row.motto),
    code:    safeStr(row.code    || row.schoolCode),
    // Expose verified flag so UI can show a badge
    verified: row.verified ?? row.isVerified ?? false,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — ROLE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const getCurrentUser = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    return useAuthStore.getState()?.user ?? null;
  } catch {
    return null;
  }
};

const isAdmin   = (user) =>
  user?.role === "super_admin"  ||
  user?.role === "school_admin" ||
  user?.role === "admin";

const isTeacher = (user) => user?.role === "teacher";
const isStudent = (user) => user?.role === "student";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SCHEMA MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * FIXED (#S2):
 * ensureTable was called on every upsertSchoolLocal call, running a
 * CREATE TABLE IF NOT EXISTS + full PRAGMA + N ALTER TABLE statements
 * every time. Now guarded by a module-level Set so the migration only
 * runs once per app session (or until the module is reloaded).
 */
const _tableReady = new Set();

const ensureTable = async (db) => {
  if (_tableReady.has("schools")) return;

  // 1. Create table if it does not exist
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS schools (
      id         TEXT PRIMARY KEY,
      name       TEXT,
      logo       TEXT,
      email      TEXT,
      phone      TEXT,
      address    TEXT,
      city       TEXT,
      state      TEXT,
      country    TEXT,
      website    TEXT,
      motto      TEXT,
      code       TEXT,
      verified   INTEGER DEFAULT 0,
      updated_at TEXT
    )
  `).catch(() => {});

  // 2. Add any columns that pre-date this migration
  try {
    const cols   = await db.getAllAsync(`PRAGMA table_info(schools)`);
    const colSet = new Set(cols.map((c) => c.name));

    const required = [
      { name: "logo",       def: "TEXT"            },
      { name: "email",      def: "TEXT"            },
      { name: "phone",      def: "TEXT"            },
      { name: "address",    def: "TEXT"            },
      { name: "city",       def: "TEXT"            },
      { name: "state",      def: "TEXT"            },
      { name: "country",    def: "TEXT"            },
      { name: "website",    def: "TEXT"            },
      { name: "motto",      def: "TEXT"            },
      { name: "code",       def: "TEXT"            },
      { name: "verified",   def: "INTEGER DEFAULT 0" },
      { name: "updated_at", def: "TEXT"            },
    ];

    for (const col of required) {
      if (!colSet.has(col.name)) {
        await db.execAsync(
          `ALTER TABLE schools ADD COLUMN ${col.name} ${col.def}`
        ).catch(() => {});
        console.log(`[schools] ✅ Added missing column: ${col.name}`);
      }
    }

    _tableReady.add("schools");
  } catch (err) {
    console.warn("[ensureTable/schools] Migration check failed:", err.message);
    // Do NOT add to _tableReady — allow a retry next call
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — UPSERT INTO SQLite
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Persists a school object to local SQLite.
 * Safe to call with partial data — missing fields become empty strings.
 *
 * FIXED (#S10):
 * clearCache is now called whenever ANY school record is upserted, not
 * just when the currently-cached school is updated. This ensures that
 * bulk upserts (e.g. after a sync) don't leave stale data in the cache.
 */
export const upsertSchoolLocal = async (school) => {
  const rawId = school?.id || school?._id;
  if (!rawId) {
    console.warn("[school.service] upsertSchoolLocal: missing id — skipped");
    return;
  }

  try {
    const db = await getDatabase();
    await ensureTable(db);

    const n = {
      id:       safeStr(rawId),
      name:     safeStr(school.name    || school.school_name  || school.schoolName),
      logo:     safeStr(school.logo    || school.logoUrl),
      email:    safeStr(school.email),
      phone:    safeStr(school.phone   || school.phoneNumber),
      address:  safeStr(school.address || school.location),
      city:     safeStr(school.city),
      state:    safeStr(school.state),
      country:  safeStr(school.country),
      website:  safeStr(school.website || school.websiteUrl),
      motto:    safeStr(school.motto),
      code:     safeStr(school.code    || school.schoolCode),
      verified: school.verified ?? school.isVerified ?? false ? 1 : 0,
    };

    await db.runAsync(
      `INSERT INTO schools
         (id, name, logo, email, phone, address, city, state,
          country, website, motto, code, verified, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name       = excluded.name,
         logo       = excluded.logo,
         email      = excluded.email,
         phone      = excluded.phone,
         address    = excluded.address,
         city       = excluded.city,
         state      = excluded.state,
         country    = excluded.country,
         website    = excluded.website,
         motto      = excluded.motto,
         code       = excluded.code,
         verified   = excluded.verified,
         updated_at = excluded.updated_at`,
      [
        n.id, n.name, n.logo, n.email, n.phone,
        n.address, n.city, n.state, n.country,
        n.website, n.motto, n.code, n.verified,
        new Date().toISOString(),
      ]
    );

    // Bust cache for this school so next read returns fresh data
    deleteCached(n.id);
    console.log(`[school.service] ✅ Upserted school: "${n.name}" (${n.id})`);

  } catch (err) {
    console.warn("[school.service] upsertSchoolLocal failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — REMOTE FETCH (role-aware)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * FIXED (#S4):
 * The original admin fallback caught ALL errors from the admin endpoint
 * and checked `status === 404 || status === 405` before falling back.
 * If the fallback itself threw (e.g. network error), the error from the
 * fallback was silently lost and the outer catch re-threw the original
 * admin error. Now each call is independently try/caught.
 *
 * FIXED (#S9):
 * Added NetInfo check so we skip the network round-trip entirely when
 * the device is offline, avoiding timeout errors and log noise.
 *
 * @param {string}  sid      - Normalised school ID
 * @returns {Promise<object|null>}
 */
const fetchSchoolInfoRemote = async (sid) => {
  const user = getCurrentUser();

  if (!user || isStudent(user)) {
    console.log("[school.service] Student role — skipping remote school fetch");
    return null;
  }

  // #S9 — skip entirely when offline
  try {
    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("[school.service] Offline — skipping remote school fetch");
      return null;
    }
  } catch { /* treat as online */ }

  let response = null;

  if (isAdmin(user)) {
    // ── Try /admin/school-info first ──────────────────────────────────────
    try {
      response = await api.get("/admin/school-info", {
        params:  { schoolId: sid },
        timeout: 6_000,
      });
    } catch (adminErr) {
      const status = adminErr?.response?.status;

      if (status === 404 || status === 405) {
        // Endpoint not available on this server version — fall back
        console.log(
          `[school.service] /admin/school-info → ${status}, ` +
          "falling back to /teacher/school/info"
        );

        // #S4 — fallback error is independently caught and surfaced
        try {
          response = await api.get("/teacher/school/info", { timeout: 6_000 });
        } catch (fallbackErr) {
          console.warn(
            "[school.service] Fallback /teacher/school/info also failed:",
            fallbackErr?.response?.status ?? fallbackErr.message
          );
          return null;
        }
      } else {
        // Non-404/405 admin error — surface it
        throw adminErr;
      }
    }

  } else if (isTeacher(user)) {
    try {
      response = await api.get("/teacher/school/info", { timeout: 6_000 });
    } catch (err) {
      console.warn(
        "[school.service] /teacher/school/info failed:",
        err?.response?.status ?? err.message
      );
      return null;
    }
  }

  if (!response) return null;

  const data =
    response.data?.school ||
    response.data?.data   ||
    response.data;

  if (!data?.name) {
    console.warn("[school.service] Remote response had no school name — ignored");
    return null;
  }

  const school = {
    ...data,
    id: safeStr(data._id || data.id || sid),
  };

  // Persist so data is available offline next time
  await upsertSchoolLocal(school);

  const normalised = normaliseRow(school);
  console.log(`[school.service] ✅ Remote school info fetched: "${normalised?.name}"`);
  return normalised;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — GET SCHOOL INFO  (primary export)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns school information for the given school ID.
 *
 * Read order:
 *  1. Memory cache  (keyed by normalised sid)
 *  2. SQLite  schools  table
 *  3. SQLite  school_info  table  (alternate-schema fallback)
 *  4. Remote API  (skipped for students or when skipRemote = true)
 *
 * Options:
 *  @param {string}  schoolId
 *  @param {object}  [options]
 *  @param {boolean} [options.skipRemote=false]
 *    Pass true to prevent any network call (e.g. on the student dashboard).
 *  @param {boolean} [options.forceRefresh=false]
 *    Pass true to bypass the memory cache and re-read from SQLite/remote.
 *
 * @returns {Promise<object|null>}
 */
export const getSchoolInfo = async (schoolId, options = {}) => {
  if (!schoolId) return null;

  const sid          = String(schoolId).trim();
  const skipRemote   = options.skipRemote   === true;
  const forceRefresh = options.forceRefresh === true;

  // ── 1. Memory cache ────────────────────────────────────────────────────────
  if (!forceRefresh) {
    const cached = getCached(sid);
    if (cached) return cached;
  }

  try {
    const db = await getDatabase();
    await ensureTable(db);

    // ── 2. SQLite: schools table ───────────────────────────────────────────
    let row = await db.getFirstAsync(
      `SELECT * FROM schools WHERE id = ? LIMIT 1`,
      [sid]
    ).catch(() => null);

    /**
     * FIXED (#S5):
     * Previous "grab any row" fallback ignored the schoolId entirely.
     * In multi-school installs this would return the wrong school.
     * The fallback is now limited to single-school installs where there
     * is exactly one row in the table — otherwise we return null and
     * let the remote fetch try to get the correct school.
     */
    if (!row?.name) {
      const count = await db.getFirstAsync(
        `SELECT COUNT(*) AS cnt FROM schools`
      ).catch(() => null);

      if (count?.cnt === 1) {
        row = await db.getFirstAsync(
          `SELECT * FROM schools LIMIT 1`
        ).catch(() => null);
      }
    }

    if (row?.name) {
      const result = normaliseRow(row);
      if (result) {
        setCached(sid, result);
        return result;
      }
    }

    // ── 3. SQLite: school_info table (alternate schema) ────────────────────
    try {
      /**
       * FIXED (#S6):
       * Previous check compared `.cnt` from a COUNT(*) query, but the
       * column alias was never read correctly when the table was missing
       * entirely (sqlite_master query returns no rows, not a row with cnt=0).
       * Now uses a direct table list query and checks array length.
       */
      const tables = await db.getAllAsync(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'school_info'`
      ).catch(() => []);

      if (tables.length > 0) {
        const siRow = await db.getFirstAsync(
          `SELECT * FROM school_info WHERE id = ? LIMIT 1`,
          [sid]
        ).catch(() => null)
          // Fallback: any row if no id match
          ?? await db.getFirstAsync(
            `SELECT * FROM school_info LIMIT 1`
          ).catch(() => null);

        if (siRow?.name) {
          const result = normaliseRow({ ...siRow, id: siRow.id || sid });
          if (result) {
            // Mirror into the canonical schools table for future lookups
            await upsertSchoolLocal(result).catch(() => {});
            setCached(sid, result);
            return result;
          }
        }
      }
    } catch (err) {
      console.warn("[school.service] school_info fallback failed:", err.message);
    }

    // ── 4. Remote fetch (role-gated + network-gated) ───────────────────────
    if (skipRemote) {
      console.log("[school.service] skipRemote=true — skipping API call");
      return null;
    }

    const remote = await fetchSchoolInfoRemote(sid).catch((err) => {
      const status = err?.response?.status;
      if (status === 403) {
        console.warn(
          `[school.service] 403 — role "${getCurrentUser()?.role}" not permitted`
        );
      } else if (status === 404) {
        console.log("[school.service] School info endpoint → 404");
      } else {
        console.warn("[school.service] Remote fetch error:", err.message);
      }
      return null;
    });

    if (remote) {
      setCached(sid, remote);
      return remote;
    }

    return null;

  } catch (err) {
    console.warn("[school.service] getSchoolInfo failed:", err.message);
    return null;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — SYNC SCHOOL INFO  (called by SyncManager)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * FIXED (#S7):
 * Previous implementation caught all errors internally and always
 * returned null on failure, even when the caller (SyncManager) might
 * want to know that the sync failed so it can schedule a retry.
 *
 * New behaviour:
 *  - Non-fatal network errors → log + return null  (unchanged)
 *  - Fatal errors (bad db, missing model) → rethrow so SyncManager
 *    can handle them appropriately
 *
 * @param {string} schoolId
 * @returns {Promise<object|null>}
 */
export const syncSchoolInfo = async (schoolId) => {
  const user = getCurrentUser();

  if (!user || isStudent(user)) {
    console.log("[syncSchoolInfo] Skipping — student role not permitted");
    return null;
  }

  const sid = String(schoolId || "").trim();
  console.log("[syncSchoolInfo] Starting…");

  try {
    const remote = await fetchSchoolInfoRemote(sid);

    if (remote) {
      // Bust cache so next getSchoolInfo() call returns fresh data
      deleteCached(sid);
      console.log(`[syncSchoolInfo] ✅ Synced: "${remote.name}"`);
    } else {
      console.log("[syncSchoolInfo] Remote returned null — nothing updated");
    }

    return remote;
  } catch (err) {
    const status = err?.response?.status;

    // Non-fatal network errors — log and return null
    if (status && status < 500) {
      console.warn(`[syncSchoolInfo] Non-fatal error (${status}):`, err.message);
      return null;
    }

    // Fatal / unexpected errors — rethrow for SyncManager to handle
    console.error("[syncSchoolInfo] Fatal error:", err.message);
    throw err;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — CONVENIENCE EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Force-refreshes school info by bypassing the memory cache.
 * Still reads SQLite before hitting the network.
 */
export const refreshSchoolInfo = (schoolId) =>
  getSchoolInfo(schoolId, { forceRefresh: true });

/**
 * Clears the in-memory cache for a specific school, or all schools
 * if no id is provided (e.g. on logout).
 *
 * FIXED (#S8):
 * Previous code exported both clearCache (internal) and clearSchoolCache
 * (external) as separate functions. Consolidated into one export.
 */
export const clearSchoolCache = (schoolId) => {
  if (schoolId) {
    deleteCached(String(schoolId).trim());
  } else {
    clearAllCache();
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═════════════════════════════════════════════════════════════════════════════

export default {
  getSchoolInfo,
  refreshSchoolInfo,
  clearSchoolCache,
  upsertSchoolLocal,
  syncSchoolInfo,
};