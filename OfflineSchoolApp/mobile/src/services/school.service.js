// src/services/school.service.js
"use strict";

import api             from "./api";
import { getDatabase } from "../db/database";

// ─────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────

let _cache         = null;
let _cacheSchoolId = null;

const clearCache = () => {
  _cache         = null;
  _cacheSchoolId = null;
};

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const safeStr = (v) =>
  v && typeof v === "string" ? v.trim() : "";

const normaliseRow = (row) => {
  if (!row) return null;
  return {
    id:      safeStr(row.id      || row._id),
    name:    safeStr(row.name    || row.school_name),
    logo:    safeStr(row.logo),
    email:   safeStr(row.email),
    phone:   safeStr(row.phone),
    address: safeStr(row.address),
    city:    safeStr(row.city),
    state:   safeStr(row.state),
    country: safeStr(row.country),
    website: safeStr(row.website),
    motto:   safeStr(row.motto),
    code:    safeStr(row.code),
  };
};

// ─────────────────────────────────────────────────────────
// ROLE HELPERS
// ─────────────────────────────────────────────────────────

const getCurrentUser = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    return useAuthStore.getState()?.user || null;
  } catch {
    return null;
  }
};

const isAdmin = (user) =>
  user?.role === "super_admin" ||
  user?.role === "school_admin" ||
  user?.role === "admin";

const isTeacher = (user) => user?.role === "teacher";
const isStudent = (user) => user?.role === "student";

// ─────────────────────────────────────────────────────────
// ENSURE TABLE + ALL COLUMNS EXIST
//
// Handles the case where the table was created previously
// without some columns (e.g. logo, motto, code).
// ─────────────────────────────────────────────────────────

const ensureTable = async (db) => {
  // 1. Create table if it does not exist at all
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
      updated_at TEXT
    )
  `).catch(() => {});

  // 2. Check existing columns and add any that are missing
  //    (handles tables created by older migrations)
  try {
    const cols   = await db.getAllAsync(`PRAGMA table_info(schools)`);
    const colSet = new Set(cols.map((c) => c.name));

    const required = [
      { name: "logo",       def: "TEXT" },
      { name: "email",      def: "TEXT" },
      { name: "phone",      def: "TEXT" },
      { name: "address",    def: "TEXT" },
      { name: "city",       def: "TEXT" },
      { name: "state",      def: "TEXT" },
      { name: "country",    def: "TEXT" },
      { name: "website",    def: "TEXT" },
      { name: "motto",      def: "TEXT" },
      { name: "code",       def: "TEXT" },
      { name: "updated_at", def: "TEXT" },
    ];

    for (const col of required) {
      if (!colSet.has(col.name)) {
        await db.execAsync(
          `ALTER TABLE schools ADD COLUMN ${col.name} ${col.def}`
        ).catch(() => {});
        console.log(`[schools] ✅ Added missing column: ${col.name}`);
      }
    }
  } catch (err) {
    console.warn("[ensureTable/schools] migration check failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────
// UPSERT INTO SQLite
// ─────────────────────────────────────────────────────────

export const upsertSchoolLocal = async (school) => {
  if (!school?.id && !school?._id) return;

  try {
    const db = await getDatabase();

    // Always run ensureTable so missing columns are added first
    await ensureTable(db);

    const normalised = {
      id:      safeStr(school.id      || school._id),
      name:    safeStr(school.name    || school.school_name),
      logo:    safeStr(school.logo),
      email:   safeStr(school.email),
      phone:   safeStr(school.phone),
      address: safeStr(school.address),
      city:    safeStr(school.city),
      state:   safeStr(school.state),
      country: safeStr(school.country),
      website: safeStr(school.website),
      motto:   safeStr(school.motto),
      code:    safeStr(school.code),
    };

    await db.runAsync(
      `INSERT INTO schools
         (id, name, logo, email, phone, address, city, state,
          country, website, motto, code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         updated_at = excluded.updated_at`,
      [
        normalised.id,
        normalised.name,
        normalised.logo,
        normalised.email,
        normalised.phone,
        normalised.address,
        normalised.city,
        normalised.state,
        normalised.country,
        normalised.website,
        normalised.motto,
        normalised.code,
        new Date().toISOString(),
      ]
    );

    // Bust cache so next read picks up fresh data
    if (_cacheSchoolId === normalised.id) clearCache();

  } catch (err) {
    console.warn("[school.service] upsertSchoolLocal:", err.message);
  }
};

// ─────────────────────────────────────────────────────────
// REMOTE FETCH — role-aware
//
// ✅ Students  → NEVER called (returns null immediately)
// ✅ Teachers  → GET /teacher/school/info
// ✅ Admins    → GET /admin/school-info first,
//               falls back to /teacher/school/info on 404/405
//
// Returns null on any failure — caller handles gracefully.
// ─────────────────────────────────────────────────────────

const fetchSchoolInfoRemote = async (schoolId) => {
  const user = getCurrentUser();

  // ── Students must never call teacher/admin school endpoints ──
  if (!user || isStudent(user)) {
    console.log("[school.service] Student role — skipping remote school fetch");
    return null;
  }

  try {
    let response = null;

    if (isAdmin(user)) {
      // ── Admin: try /admin/school-info first ───────────────
      try {
        response = await api.get("/admin/school-info", {
          params:  { schoolId },
          timeout: 6000,
        });
      } catch (adminErr) {
        const status = adminErr?.response?.status;
        if (status === 404 || status === 405) {
          // Endpoint not available on this server — fall back
          console.log(
            "[school.service] /admin/school-info → " +
            `${status}, falling back to /teacher/school/info`
          );
          response = await api.get("/teacher/school/info", { timeout: 6000 });
        } else {
          throw adminErr;
        }
      }

    } else if (isTeacher(user)) {
      // ── Teacher: use /teacher/school/info ─────────────────
      response = await api.get("/teacher/school/info", { timeout: 6000 });
    }

    if (!response) return null;

    const data =
      response.data?.school ||
      response.data?.data   ||
      response.data;

    if (!data?.name) return null;

    // Ensure we have an id — use schoolId from auth if server omits it
    const school = {
      ...data,
      id: data._id || data.id || schoolId,
    };

    // Persist to SQLite so it is available offline
    await upsertSchoolLocal(school);

    console.log(`[school.service] ✅ Remote school info fetched: "${school.name}"`);
    return normaliseRow(school);

  } catch (err) {
    const status = err?.response?.status;
    if (status === 403) {
      console.warn(
        `[school.service] 403 on school info fetch — ` +
        `role "${getCurrentUser()?.role}" not permitted`
      );
    } else if (status === 404) {
      console.log("[school.service] School info endpoint → 404");
    } else {
      console.warn("[school.service] Remote school fetch failed:", err.message);
    }
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// GET SCHOOL INFO  (primary export used by all screens)
//
// Options:
//   skipRemote {boolean} — only read from SQLite, never hit API
//                          (student dashboard passes this to avoid 403)
//
// Read order:
//   1. Memory cache
//   2. SQLite  schools table
//   3. SQLite  school_info table  (alternate schema fallback)
//   4. Remote API  (skipped for students / when skipRemote = true)
// ─────────────────────────────────────────────────────────

export const getSchoolInfo = async (schoolId, options = {}) => {
  if (!schoolId) return null;

  const sid        = String(schoolId);
  const skipRemote = options.skipRemote === true;

  // ── 1. Memory cache ───────────────────────────────────────
  if (_cache && _cacheSchoolId === sid) {
    return _cache;
  }

  try {
    const db = await getDatabase();
    await ensureTable(db);

    // ── 2. SQLite: schools table ──────────────────────────────
    let row = await db.getFirstAsync(
      `SELECT * FROM schools WHERE id = ? LIMIT 1`,
      [sid]
    ).catch(() => null);

    // Fallback: grab any row (single-school apps)
    if (!row?.name) {
      row = await db.getFirstAsync(
        `SELECT * FROM schools LIMIT 1`
      ).catch(() => null);
    }

    if (row?.name) {
      const result   = normaliseRow(row);
      _cache         = result;
      _cacheSchoolId = sid;
      return result;
    }

    // ── 3. SQLite: school_info table (alternate schema) ───────
    try {
      const hasSchoolInfo = await db.getFirstAsync(
        `SELECT COUNT(*) AS cnt FROM sqlite_master
         WHERE type = 'table' AND name = 'school_info'`
      ).catch(() => null);

      if (hasSchoolInfo?.cnt) {
        const siRow = await db.getFirstAsync(
          `SELECT * FROM school_info LIMIT 1`
        ).catch(() => null);

        if (siRow?.name) {
          const result   = normaliseRow({ ...siRow, id: siRow.id || sid });
          _cache         = result;
          _cacheSchoolId = sid;
          return result;
        }
      }
    } catch {
      // Non-fatal — continue to remote
    }

    // ── 4. Remote fetch (role-gated) ──────────────────────────
    if (skipRemote) {
      console.log("[school.service] skipRemote=true — skipping API call");
      return null;
    }

    const remote = await fetchSchoolInfoRemote(sid);
    if (remote) {
      _cache         = remote;
      _cacheSchoolId = sid;
      return remote;
    }

    return null;

  } catch (err) {
    console.warn("[school.service] getSchoolInfo:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// SYNC SCHOOL INFO  (called by SyncManager)
//
// ✅ Role-gated — students are skipped entirely.
//    Teachers and admins trigger the appropriate endpoint.
//    SyncManager also has its own role guard, but this
//    provides a second layer of protection.
// ─────────────────────────────────────────────────────────

export const syncSchoolInfo = async (schoolId) => {
  const user = getCurrentUser();

  // Students must never trigger teacher/admin school endpoints
  if (!user || isStudent(user)) {
    console.log("[syncSchoolInfo] Skipping — student role not permitted");
    return null;
  }

  console.log("[syncSchoolInfo] Starting…");

  try {
    const remote = await fetchSchoolInfoRemote(schoolId);
    if (remote) {
      // Bust cache so next getSchoolInfo() call returns fresh data
      clearCache();
      console.log(`[syncSchoolInfo] ✅ Synced: "${remote.name}"`);
    }
    return remote;
  } catch (err) {
    console.warn("[syncSchoolInfo] failed (non-fatal):", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────
// FORCE REFRESH FROM SQLite  (busts memory cache first)
// ─────────────────────────────────────────────────────────

export const refreshSchoolInfo = async (schoolId) => {
  clearCache();
  return getSchoolInfo(schoolId);
};

// ─────────────────────────────────────────────────────────
// CLEAR CACHE  (call on logout)
// ─────────────────────────────────────────────────────────

export const clearSchoolCache = () => clearCache();

// ─────────────────────────────────────────────────────────
// DEFAULT EXPORT
// ─────────────────────────────────────────────────────────

export default {
  getSchoolInfo,
  refreshSchoolInfo,
  clearSchoolCache,
  upsertSchoolLocal,
  syncSchoolInfo,
};