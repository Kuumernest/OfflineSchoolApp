// src/services/settings.service.js
"use strict";

/**
 * settings.service.js
 *
 * Responsibilities:
 *  - Admin profile fetch / update / password change
 *  - Grading config fetch / save
 *  - School info fetch / save (with local SQLite cache)
 *  - Admin user management (always online)
 *  - Analytics (always online)
 *  - ID card expiry and gate message policy (cached for offline reading)
 */

import api                   from "./api";
import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { getCurrentAuth }    from "../utils/authHelpers";
import NetInfo               from "@react-native-community/netinfo";
import { appError }          from "../utils/appError";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SCHEMA
// ═════════════════════════════════════════════════════════════════════════════

const ensureSchema = (db) =>
  ensureTableSchema(
    "settings",
    async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS settings_profile (
          id         TEXT PRIMARY KEY DEFAULT 'me',
          name       TEXT,
          email      TEXT,
          role       TEXT,
          schoolId   TEXT,
          updated_at TEXT
        )
      `);

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS settings_grading (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT,
          config     TEXT,
          updated_at TEXT
        )
      `);

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS settings_idcard (
          id         TEXT PRIMARY KEY,
          schoolId   TEXT,
          config     TEXT,
          updated_at TEXT
        )
      `);

      console.log("[settings] Schema verified");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — INTERNAL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const updateLocalSchoolCache = async (schoolId, school) => {
  if (!school || !schoolId) return;
  try {
    const { upsertSchoolLocal } = require("./school.service");
    await upsertSchoolLocal({
      id:      schoolId,
      name:    school.name    || "",
      logo:    school.logo    || "",
      email:   school.email   || "",
      phone:   school.phone   || "",
      address: school.address || "",
      city:    school.city    || "",
      state:   school.state   || "",
      country: school.country || "",
      website: school.website || "",
      motto:   school.motto   || "",
      code:    school.code    || "",
    });
    console.log("[settings] Local school cache updated");
  } catch (err) {
    console.warn("[settings] updateLocalSchoolCache (non-fatal):", err.message);
  }
};

const now = () => new Date().toISOString();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — PROFILE
// ═════════════════════════════════════════════════════════════════════════════

export const fetchProfile = async () => {
  const net = await NetInfo.fetch();

  if (net.isConnected) {
    try {
      const res     = await api.get("/admin/settings/profile");
      const profile = res.data?.profile;

      if (profile) {
        const db = await getDatabase();
        await ensureSchema(db);
        await db.runAsync(
          `INSERT INTO settings_profile (id, name, email, role, schoolId, updated_at)
           VALUES ('me', ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name       = excluded.name,
             email      = excluded.email,
             role       = excluded.role,
             schoolId   = excluded.schoolId,
             updated_at = excluded.updated_at`,
          [
            profile.name     || null,
            profile.email    || null,
            profile.role     || null,
            profile.schoolId || null,
            now(),
          ]
        ).catch(() => {});
      }

      return profile;
    } catch (err) {
      console.warn("[settings] fetchProfile API failed, using cache:", err.message);
    }
  }

  // ── Offline fallback ──────────────────────────────────────────────────────
  try {
    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT * FROM settings_profile WHERE id = 'me' LIMIT 1`
    );
    return row || null;
  } catch {
    return null;
  }
};

export const updateProfile = async ({ name, email }) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineProfileUpdate", "Profile update requires an internet connection");
  }

  const res     = await api.put("/admin/settings/profile", { name, email });
  const profile = res.data?.profile;

  if (profile) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      await db.runAsync(
        `UPDATE settings_profile
         SET name = ?, email = ?, updated_at = ?
         WHERE id = 'me'`,
        [profile.name || name, profile.email || email, now()]
      );
    } catch { /* non-critical */ }
  }

  return profile;
};

export const changePassword = async ({ currentPassword, newPassword }) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlinePasswordChange", "Password change requires an internet connection");
  }

  const res = await api.put("/admin/settings/profile/password", {
    currentPassword,
    newPassword,
  });
  return res.data;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — GRADING CONFIG
// ═════════════════════════════════════════════════════════════════════════════

export const fetchGradingConfig = async (schoolId) => {
  const { schoolId: authSchoolId } = getCurrentAuth();
  const resolvedSchoolId           = schoolId || authSchoolId;

  const net = await NetInfo.fetch();

  if (net.isConnected) {
    try {
      const res     = await api.get("/admin/settings/grading", {
        params: { schoolId: resolvedSchoolId },
      });
      const grading = res.data?.grading;

      if (grading && resolvedSchoolId) {
        const db = await getDatabase();
        await ensureSchema(db);
        await db.runAsync(
          `INSERT INTO settings_grading (id, schoolId, config, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             config     = excluded.config,
             updated_at = excluded.updated_at`,
          [resolvedSchoolId, resolvedSchoolId, JSON.stringify(grading), now()]
        ).catch(() => {});
      }

      return grading;
    } catch (err) {
      console.warn("[settings] fetchGradingConfig API failed, using cache:", err.message);
    }
  }

  // ── Offline fallback ──────────────────────────────────────────────────────
  if (!resolvedSchoolId) return null;

  try {
    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT config FROM settings_grading WHERE schoolId = ? LIMIT 1`,
      [resolvedSchoolId]
    );
    return row?.config ? JSON.parse(row.config) : null;
  } catch {
    return null;
  }
};

export const saveGradingConfig = async (config) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineGradingConfig", "Saving grading config requires an internet connection");
  }

  const res     = await api.put("/admin/settings/grading", config);
  const grading = res.data?.grading;

  if (grading) {
    const { schoolId: authSchoolId } = getCurrentAuth();
    const schoolId                   = config.schoolId || authSchoolId;

    if (schoolId) {
      try {
        const db = await getDatabase();
        await ensureSchema(db);
        await db.runAsync(
          `INSERT INTO settings_grading (id, schoolId, config, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             config     = excluded.config,
             updated_at = excluded.updated_at`,
          [schoolId, schoolId, JSON.stringify(grading), now()]
        );
      } catch { /* non-critical */ }
    }
  }

  return grading;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — SCHOOL INFO
// ═════════════════════════════════════════════════════════════════════════════

export const fetchSchoolSettings = async (schoolId) => {
  const net = await NetInfo.fetch();

  if (net.isConnected) {
    try {
      const res    = await api.get("/admin/school-info", { params: { schoolId } });
      const school = res.data?.school || res.data;

      if (school) {
        await updateLocalSchoolCache(schoolId, school);
      }

      return school;
    } catch (err) {
      console.warn("[settings] fetchSchoolSettings API failed, using cache:", err.message);
    }
  }

  // ── Offline fallback ──────────────────────────────────────────────────────
  try {
    const { getSchoolInfo } = require("./school.service");
    return await getSchoolInfo(schoolId);
  } catch {
    return null;
  }
};

export const saveSchoolSettings = async (payload) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineSchoolSettings", "Saving school settings requires an internet connection");
  }

  const res    = await api.put("/admin/school-info", payload);
  const school = res.data?.school || res.data;

  if (school) {
    const { schoolId: authSchoolId } = getCurrentAuth();
    const schoolId                   = payload.schoolId || authSchoolId;

    await updateLocalSchoolCache(schoolId, school);

    try {
      const { clearSchoolCache } = require("./school.service");
      clearSchoolCache();
    } catch { /* non-critical */ }
  }

  return school;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ADMIN MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

export const fetchAdmins = async (schoolId) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineAdminList", "Admin list requires an internet connection");
  }

  const res = await api.get("/admin/settings/admins", { params: { schoolId } });
  return res.data?.admins || [];
};

export const createAdmin = async ({ name, email, role, schoolId }) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineCreateAdmin", "Creating an admin requires an internet connection");
  }

  const res = await api.post("/admin/settings/admins", { name, email, role, schoolId });
  return res.data;
};

export const removeAdmin = async (adminId) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineRemoveAdmin", "Removing an admin requires an internet connection");
  }

  const res = await api.delete(`/admin/settings/admins/${adminId}`);
  return res.data;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — ANALYTICS
// ═════════════════════════════════════════════════════════════════════════════

export const fetchAnalytics = async (schoolId) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineAnalytics", "Analytics require an internet connection");
  }

  const res = await api.get("/admin/settings/analytics", { params: { schoolId } });
  return res.data?.analytics;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — ID CARDS AND THE GATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What the card says, and what happens when somebody scans it.
 *
 * Cached like the grading config, so an admin can at least SEE the current
 * policy with no signal. Saving needs a connection: this is office work at a
 * desk, and a queued change to a notification policy would be applied to scans
 * that had already happened by the time it synced.
 */
export const fetchIdCardSettings = async (schoolId) => {
  const { schoolId: authSchoolId } = getCurrentAuth();
  const resolvedSchoolId           = schoolId || authSchoolId;

  const net = await NetInfo.fetch();

  if (net.isConnected) {
    try {
      const res    = await api.get("/admin/settings/id-card", {
        params: { schoolId: resolvedSchoolId },
      });
      const config = { idCard: res.data?.idCard, gate: res.data?.gate };

      if (config.idCard && resolvedSchoolId) {
        const db = await getDatabase();
        await ensureSchema(db);
        await db.runAsync(
          `INSERT INTO settings_idcard (id, schoolId, config, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             config     = excluded.config,
             updated_at = excluded.updated_at`,
          [resolvedSchoolId, resolvedSchoolId, JSON.stringify(config), now()]
        ).catch(() => {});
      }

      return config;
    } catch (err) {
      console.warn("[settings] fetchIdCardSettings API failed, using cache:", err.message);
    }
  }

  if (!resolvedSchoolId) return null;

  try {
    const db  = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT config FROM settings_idcard WHERE schoolId = ? LIMIT 1`,
      [resolvedSchoolId]
    );
    return row?.config ? JSON.parse(row.config) : null;
  } catch {
    return null;
  }
};

export const saveIdCardSettings = async ({
  schoolId, validUntil, gateNotify, gateLateAfter, gateEarlyBefore,
}) => {
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw appError("svcErr.onlineSaveSettings", "Saving these settings requires an internet connection");
  }

  const { schoolId: authSchoolId } = getCurrentAuth();
  const resolvedSchoolId           = schoolId || authSchoolId;

  const res    = await api.put("/admin/settings/id-card", {
    schoolId: resolvedSchoolId,
    validUntil, gateNotify, gateLateAfter, gateEarlyBefore,
  });
  const config = { idCard: res.data?.idCard, gate: res.data?.gate };

  if (config.idCard && resolvedSchoolId) {
    try {
      const db = await getDatabase();
      await ensureSchema(db);
      await db.runAsync(
        `INSERT INTO settings_idcard (id, schoolId, config, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           config     = excluded.config,
           updated_at = excluded.updated_at`,
        [resolvedSchoolId, resolvedSchoolId, JSON.stringify(config), now()]
      );
    } catch {
      // The server has it; a stale cache is corrected on the next read.
    }
  }

  return config;
};
