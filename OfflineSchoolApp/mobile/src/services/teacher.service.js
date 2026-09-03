// src/services/teacher.service.js
"use strict";

/**
 * teacher.service.js
 *
 * Fixed issues:
 *  #C1   — Ghost ID detection uses idHelpers
 *  #C2   — Schema uses ensureTableSchema with retry logic
 *  #C3   — snake_case columns; runtime resolver bridges old camelCase rows
 *  #C5   — ID generation uses generateLocalId / generateUUID
 *  #C6   — Auth uses authHelpers
 *  #M1   — DB helpers imported from dbHelpers
 *  #M2   — Server fetch pattern uses fetchWithFallback / syncFromServer
 *  #M3   — Soft-delete filter uses NOT_DELETED constant
 *  #M5   — Endpoint strings use API constants
 *  #Mod2 — resolveTeacherId returns null, never an unresolved raw ID
 *  #AMB  — All column references in JOIN queries are table-alias-qualified
 *  #ROLE — Admin users excluded from teacher queries by checking role is
 *           exactly 'teacher' and not any admin variant
 *  #ADMIN-SYNC    — syncOwnProfile skips admin users before persisting
 *  #ADMIN-NORM    — normaliseServerTeacher rejects admin roles at the
 *                   normalisation layer so no admin reaches the DB
 *  #ADMIN-CLEANUP — repairTeacherRoles now also removes the currently
 *                   logged-in admin's row if it was mistakenly inserted
 *                   as role='teacher' by a previous app version
 */

import NetInfo                                        from "@react-native-community/netinfo";
import { getDatabase }                                from "../db/database";
import { ensureTableSchema }                          from "../db/schemaManager";
import { createTableFromSchema }                      from "../db/schema";
import {
  tableExists,
  getTableColumns,
  safeAddColumn,
  withFkOff,
  withTransaction,
  NOT_DELETED,
}                                                     from "../db/dbHelpers";
import { resolveColumns, COL } from "../db/schemaUtils";
import {
  isServerGeneratedId,
  isLocalId,
  isGhostId,
  generateLocalId,
  generateUUID,
}                                                     from "../utils/idHelpers";
import {
  isAuthenticated,
  getCurrentAuth,
}                                                     from "../utils/authHelpers";
import { fetchWithFallback }                          from "../utils/syncHelpers";
import { API, callWithFallback }                      from "./apiEndpoints";
import api                                            from "./api";
import { appError }                                   from "../utils/appError";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

const USERS_TABLE       = "users";
const ASSIGNMENTS_TABLE = "teacher_assignments";
const SUBJECTS_TABLE    = "subjects";
const CLASSES_TABLE     = "classes";
const TIMETABLE_TABLE   = "timetable";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every role string that identifies an admin user.
 * Used in both SQL fragments and JavaScript role checks so the two stay
 * in sync — change this array and both are updated automatically.
 */
const ADMIN_ROLES = ["admin", "school_admin", "super_admin", "superadmin"];

/**
 * #ROLE — SQL fragment that matches ONLY pure teacher rows.
 * Explicitly excludes every known admin-role variant so admins never
 * appear in teacher lists regardless of casing or how the row was inserted.
 */
const TEACHER_ROLE_FILTER = `
  LOWER(role) = 'teacher'
  AND LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
`;

/**
 * Helper — returns true when a role string identifies an admin user.
 * Centralised so every check in this file uses the same list.
 *
 * @param {string|undefined} role
 * @returns {boolean}
 */
const isAdminRole = (role) =>
  ADMIN_ROLES.includes(String(role || "").toLowerCase().trim());

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — SCHEMA SETUP
// ═════════════════════════════════════════════════════════════════════════════

let _migrationDone = false;

const ensureSchema = (db) =>
  ensureTableSchema(
    USERS_TABLE,
    async (db) => {
      await createTableFromSchema(db, "users");

      await safeAddColumn(db, USERS_TABLE, "school_id",           "TEXT");
      await safeAddColumn(db, USERS_TABLE, "schoolId",            "TEXT");
      await safeAddColumn(db, USERS_TABLE, "is_active",           "INTEGER DEFAULT 1");
      await safeAddColumn(db, USERS_TABLE, "must_reset_password", "INTEGER DEFAULT 0");
      await safeAddColumn(db, USERS_TABLE, "_synced_at",          "TEXT");

      await createTableFromSchema(db, "teacher_assignments");

      await safeAddColumn(db, ASSIGNMENTS_TABLE, "teacherId",   "TEXT");
      await safeAddColumn(db, ASSIGNMENTS_TABLE, "classId",     "TEXT");
      await safeAddColumn(db, ASSIGNMENTS_TABLE, "subjectId",   "TEXT");
      await safeAddColumn(db, ASSIGNMENTS_TABLE, "schoolId",    "TEXT");
      await safeAddColumn(db, ASSIGNMENTS_TABLE, "_synced_at",  "TEXT");
      await safeAddColumn(db, ASSIGNMENTS_TABLE, "assigned_by", "TEXT");

      if (await tableExists(db, SUBJECTS_TABLE)) {
        await safeAddColumn(db, SUBJECTS_TABLE, "teacher_id", "TEXT");
        await safeAddColumn(db, SUBJECTS_TABLE, "class_id",   "TEXT");
        await safeAddColumn(db, SUBJECTS_TABLE, "school_id",  "TEXT");
        await safeAddColumn(db, SUBJECTS_TABLE, "deleted_at", "TEXT");
      }

      if (await tableExists(db, CLASSES_TABLE)) {
        await safeAddColumn(db, CLASSES_TABLE, "is_active",  "INTEGER DEFAULT 1");
        await safeAddColumn(db, CLASSES_TABLE, "deleted_at", "TEXT");
        await safeAddColumn(db, CLASSES_TABLE, "school_id",  "TEXT");
      }

      if (await tableExists(db, TIMETABLE_TABLE)) {
        await safeAddColumn(db, TIMETABLE_TABLE, "teacher_id", "TEXT");
        await safeAddColumn(db, TIMETABLE_TABLE, "subject_id", "TEXT");
        await safeAddColumn(db, TIMETABLE_TABLE, "deleted_at", "TEXT");
      }

      console.log("✅ TeacherService schema verified");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — RUNTIME COLUMN RESOLVER
// ═════════════════════════════════════════════════════════════════════════════

const resolveUserCols = (db) =>
  resolveColumns(
    USERS_TABLE,
    { schoolCol: COL.SCHOOL_ID, deletedCol: COL.DELETED_AT },
    ["schoolCol", "deletedCol"]
  );

const resolveAssignmentCols = () =>
  resolveColumns(
    ASSIGNMENTS_TABLE,
    {
      teacherCol: COL.TEACHER_ID,
      classCol:   COL.CLASS_ID,
      subjectCol: COL.SUBJECT_ID,
      schoolCol:  COL.SCHOOL_ID,
      deletedCol: COL.DELETED_AT,
    },
    ["schoolCol", "deletedCol"]
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — FILTER BUILDERS
// ═════════════════════════════════════════════════════════════════════════════

const buildTeacherConditions = (cols, schoolId, alias = "u") => {
  const a = alias ? `${alias}.` : "";

  const roleFilter = `
    LOWER(${a}role) = 'teacher'
    AND LOWER(${a}role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
  `;

  const softDelete = cols.deletedCol
    ? `AND (${a}${cols.deletedCol} IS NULL OR ${a}${cols.deletedCol} = '')`
    : "";

  const activeFilter = `AND (${a}is_active = 1 OR ${a}is_active IS NULL)`;

  let conditions = `${roleFilter} ${softDelete} ${activeFilter}`;
  const params   = [];

  if (schoolId && cols.schoolCol) {
    conditions +=
      ` AND (${a}${cols.schoolCol} = ? OR ${a}${cols.schoolCol} IS NULL OR ${a}${cols.schoolCol} = '')`;
    params.push(schoolId);
  }

  return { conditions, params };
};

const buildAssignmentFilter = (cols, schoolId, alias = "ta") => {
  const a          = alias ? `${alias}.` : "";
  const softDelete = cols.deletedCol
    ? `(${a}${cols.deletedCol} IS NULL OR ${a}${cols.deletedCol} = '')`
    : "1=1";

  const conditions = [softDelete];
  const params     = [];

  if (schoolId && cols.schoolCol) {
    conditions.push(
      `(${a}${cols.schoolCol} = ? OR ${a}${cols.schoolCol} IS NULL OR ${a}${cols.schoolCol} = '')`
    );
    params.push(schoolId);
  }

  return { filter: conditions.join(" AND "), params };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — NORMALISE SERVER → LOCAL
// ═════════════════════════════════════════════════════════════════════════════

const normaliseServerTeacher = (raw, schoolId) => {
  if (!raw) return null;

  const id = String(raw._id || raw.id || "").trim();
  if (!id || !isServerGeneratedId(id)) return null;

  // #ADMIN-NORM — reject admin users at the normalisation layer
  if (isAdminRole(raw.role)) {
    console.log(
      `[teachers] normaliseServerTeacher: skipping admin "${raw.name}" (role=${raw.role})`
    );
    return null;
  }

  return {
    id,
    name:       (raw.name  || "").trim(),
    email:      (raw.email || "").toLowerCase().trim(),
    role:       "teacher",
    school_id:  String(raw.schoolId || raw.school_id || schoolId || "").trim() || null,
    is_active:  raw.isActive ?? raw.is_active ?? 1,
    _synced:    1,
    _synced_at: new Date().toISOString(),
    deleted_at: raw.deletedAt || raw.deleted_at || null,
    created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
    updated_at: raw.updatedAt || raw.updated_at || new Date().toISOString(),
  };
};

const normaliseServerAssignment = (raw, fallbackTeacherId, fallbackSchoolId) => {
  if (!raw) return null;

  const id = String(raw._id || raw.id || raw.serverId || "").trim();
  if (!id) return null;

  const teacherId = String(
    raw.teacher?._id || raw.teacher?.id ||
    raw.teacherId    || raw.teacher_id  ||
    fallbackTeacherId || ""
  ).trim();

  const classId = String(
    raw.class?._id || raw.class?.id ||
    raw.classId    || raw.class_id  || ""
  ).trim();

  const subjectId = String(
    raw.subject?._id || raw.subject?.id ||
    raw.subjectId    || raw.subject_id  || ""
  ).trim();

  if (!teacherId || !classId || !subjectId) {
    console.warn(`[assignments] Skipping incomplete server record: ${id}`);
    return null;
  }

  return {
    id,
    teacher_id: teacherId,
    class_id:   classId,
    subject_id: subjectId,
    school_id:  String(raw.schoolId || raw.school_id || fallbackSchoolId || "").trim() || null,
    _synced:    1,
    _synced_at: new Date().toISOString(),
    deleted_at: raw.deletedAt || raw.deleted_at || null,
    created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
    updated_at: raw.updatedAt || raw.updated_at || new Date().toISOString(),
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — LOCAL PERSISTENCE
// ═════════════════════════════════════════════════════════════════════════════

const persistTeachersLocally = async (db, teachers) => {
  if (!teachers?.length) return;

  await withFkOff(db, () =>
    withTransaction(db, async () => {
      for (const t of teachers) {
        await db.runAsync(
          `INSERT OR REPLACE INTO ${USERS_TABLE}
           (id, name, email, role, school_id, schoolId,
            is_active, _synced, _synced_at, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, 'teacher', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            t.id,
            t.name,
            t.email,
            t.school_id  ?? null,
            t.school_id  ?? null,
            t.is_active  ?? 1,
            t._synced    ?? 1,
            t._synced_at ?? new Date().toISOString(),
            t.deleted_at ?? null,
            t.created_at ?? new Date().toISOString(),
            t.updated_at ?? new Date().toISOString(),
          ]
        );
      }
    })
  );
};

const persistAssignmentsLocally = async (db, assignments) => {
  if (!assignments?.length) return;

  await withFkOff(db, () =>
    withTransaction(db, async () => {
      for (const a of assignments) {
        await db.runAsync(
          `INSERT OR REPLACE INTO ${ASSIGNMENTS_TABLE}
           (id,
            teacher_id, teacherId,
            class_id,   classId,
            subject_id, subjectId,
            school_id,  schoolId,
            _synced, _synced_at, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.id,
            a.teacher_id, a.teacher_id,
            a.class_id,   a.class_id,
            a.subject_id, a.subject_id,
            a.school_id ?? null, a.school_id ?? null,
            a._synced    ?? 1,
            a._synced_at ?? new Date().toISOString(),
            a.deleted_at ?? null,
            a.created_at ?? new Date().toISOString(),
            a.updated_at ?? new Date().toISOString(),
          ]
        );
      }
    })
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — REPAIR / BACKFILL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const repairTeacherRoles = async (db) => {
  try {
    // Step 1 — fix casing
    await db.runAsync(
      `UPDATE ${USERS_TABLE}
       SET role = 'teacher'
       WHERE LOWER(role) = 'teacher' AND role != 'teacher'`
    );

    // Step 2 — #ADMIN-CLEANUP: remove the current admin user's row if it
    // was inserted as role='teacher' by syncOwnProfile in a previous version
    try {
      const { user } = getCurrentAuth();
      if (!user) return;

      if (isAdminRole(user.role)) {
        const currentId = String(user._id || user.id || "").trim();
        if (!currentId) return;

        const bogusRow = await db.getFirstAsync(
          `SELECT id FROM ${USERS_TABLE}
           WHERE id = ? AND LOWER(role) = 'teacher'
           LIMIT 1`,
          [currentId]
        ).catch(() => null);

        if (bogusRow) {
          await db.runAsync(
            `DELETE FROM ${USERS_TABLE}
             WHERE id = ? AND LOWER(role) = 'teacher'`,
            [currentId]
          );
          console.log(
            `[teachers] repairTeacherRoles: removed admin "${user.name}" ` +
            `from teacher list (was mistakenly inserted as role='teacher')`
          );
        }
      }
    } catch (innerErr) {
      console.warn("[teachers] admin cleanup step failed:", innerErr.message);
    }
  } catch (err) {
    console.warn("[teachers] repairTeacherRoles failed:", err.message);
  }
};

const backfillSchoolId = async (db, schoolId) => {
  if (!schoolId) return;

  const cols = await resolveColumns(
    USERS_TABLE,
    { schoolCol: COL.SCHOOL_ID, deletedCol: COL.DELETED_AT },
    ["schoolCol", "deletedCol"]
  );

  if (!cols.schoolCol) return;

  const softFilter = cols.deletedCol
    ? `AND (${cols.deletedCol} IS NULL OR ${cols.deletedCol} = '')`
    : "";

  try {
    const result = await db.runAsync(
      `UPDATE ${USERS_TABLE}
       SET ${cols.schoolCol} = ?
       WHERE LOWER(role) = 'teacher'
         AND LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
         AND (${cols.schoolCol} IS NULL OR ${cols.schoolCol} = '')
         ${softFilter}`,
      [schoolId]
    );
    if ((result?.changes ?? 0) > 0) {
      console.log(`[teachers] Backfilled school_id on ${result.changes} row(s)`);
    }
  } catch (err) {
    console.warn("[teachers] backfillSchoolId failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — LEGACY MIGRATION
// ═════════════════════════════════════════════════════════════════════════════

const migrateLegacyAssignments = async (db, schoolId) => {
  if (_migrationDone) return;
  _migrationDone = true;

  try {
    if (!(await tableExists(db, "subject_assignments"))) return;

    const srcCols    = await getTableColumns(db, "subject_assignments");
    const idCol      = srcCols.includes("id")  ? "id"  : "_id";
    const teacherCol = srcCols.find((c) => ["teacher_id", "teacherId"].includes(c));
    const classCol   = srcCols.find((c) => ["class_id",   "classId"  ].includes(c));
    const subjectCol = srcCols.find((c) => ["subject_id", "subjectId"].includes(c));
    const schoolCol  = srcCols.find((c) => ["school_id",  "schoolId" ].includes(c));
    const deletedCol = srcCols.find((c) => ["deleted_at", "deletedAt"].includes(c));

    if (!teacherCol || !classCol || !subjectCol) {
      console.log("[migrate] subject_assignments has unexpected schema — skipping");
      return;
    }

    let sql = `
      SELECT
        ${idCol}      AS id,
        ${teacherCol} AS teacher_id,
        ${classCol}   AS class_id,
        ${subjectCol} AS subject_id,
        ${schoolCol ? schoolCol : "NULL"} AS school_id
      FROM subject_assignments
    `;
    if (deletedCol) {
      sql += ` WHERE (${deletedCol} IS NULL OR ${deletedCol} = '')`;
    }

    const rows     = await db.getAllAsync(sql).catch(() => []);
    const dstCols  = await resolveAssignmentCols();
    let   migrated = 0;

    for (const row of rows) {
      if (!row.teacher_id || !row.class_id || !row.subject_id) continue;
      if (isGhostId(row.id)) {
        console.log(`[migrate] skipping ghost id: ${row.id}`);
        continue;
      }

      const exists = await db.getFirstAsync(
        `SELECT 1 FROM ${ASSIGNMENTS_TABLE}
         WHERE ${dstCols.teacherCol} = ?
           AND ${dstCols.classCol}   = ?
           AND ${dstCols.subjectCol} = ?
         LIMIT 1`,
        [row.teacher_id, row.class_id, row.subject_id]
      ).catch(() => null);

      if (!exists) {
        const now = new Date().toISOString();
        await db.runAsync(
          `INSERT INTO ${ASSIGNMENTS_TABLE}
             (id, teacher_id, teacherId, class_id, classId,
              subject_id, subjectId, school_id, schoolId,
              _synced, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            String(row.id),
            row.teacher_id, row.teacher_id,
            row.class_id,   row.class_id,
            row.subject_id, row.subject_id,
            row.school_id ?? schoolId,
            row.school_id ?? schoolId,
            now, now,
          ]
        ).catch(() => {});
        migrated++;
      }
    }

    if (migrated > 0) {
      console.log(`[migrate] copied ${migrated} rows from subject_assignments`);
    }
  } catch (err) {
    console.warn("[migrate] migrateLegacyAssignments failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — ID RECONCILIATION
// ═════════════════════════════════════════════════════════════════════════════

const reconcileTeacherId = async (db, localId, serverId) => {
  if (!localId || !serverId || localId === serverId) return serverId;

  const now = new Date().toISOString();

  try {
    await withFkOff(db, async () => {
      await db.runAsync(
        `UPDATE ${USERS_TABLE}
         SET id = ?, _synced = 1, _synced_at = ?
         WHERE id = ?`,
        [serverId, now, localId]
      );

      const dstCols = await resolveAssignmentCols();

      await db.runAsync(
        `UPDATE ${ASSIGNMENTS_TABLE}
         SET ${dstCols.teacherCol} = ?, teacherId = ?
         WHERE ${dstCols.teacherCol} = ?`,
        [serverId, serverId, localId]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE ${SUBJECTS_TABLE} SET teacher_id = ? WHERE teacher_id = ?`,
        [serverId, localId]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE ${TIMETABLE_TABLE} SET teacher_id = ? WHERE teacher_id = ?`,
        [serverId, localId]
      ).catch(() => {});
    });

    console.log(`[teachers] ID reconciled: ${localId} → ${serverId}`);
    return serverId;
  } catch (err) {
    console.error("[teachers] reconcileTeacherId failed:", err.message);
    return localId;
  }
};

const reconcileAssignmentId = async (db, localId, serverId) => {
  if (!localId || !serverId || localId === serverId) return;

  const now = new Date().toISOString();

  try {
    await withFkOff(db, async () => {
      await db.runAsync(
        `INSERT OR REPLACE INTO ${ASSIGNMENTS_TABLE}
         SELECT ?, teacher_id, teacherId, class_id, classId,
                subject_id, subjectId, school_id, schoolId,
                1, ?, deleted_at, created_at, updated_at
         FROM   ${ASSIGNMENTS_TABLE}
         WHERE  id = ?`,
        [serverId, now, localId]
      );
      await db.runAsync(
        `DELETE FROM ${ASSIGNMENTS_TABLE} WHERE id = ? AND id != ?`,
        [localId, serverId]
      );
    });

    console.log(`[assignments] ID reconciled: ${localId} → ${serverId}`);
  } catch (err) {
    console.warn("[assignments] reconcileAssignmentId failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — SERVER SYNC (PULL)
// ═════════════════════════════════════════════════════════════════════════════

const syncOwnProfile = async (db, schoolId) => {
  try {
    const response = await callWithFallback(api, "GET", [
      API.teacher.profile,
      API.auth.me,
    ], { timeout: 10_000 });

    const data = response.data;
    const raw  = data?.teacher || data?.user || data?.data || data;

    if (!raw || !(raw._id || raw.id)) return;

    // #ADMIN-SYNC — check the actual role from the server before persisting
    if (isAdminRole(raw.role)) {
      console.log(
        `[teachers] syncOwnProfile: skipping admin "${raw.name}" (role=${raw.role})`
      );
      return;
    }

    const normalised = normaliseServerTeacher(raw, schoolId);
    if (normalised) {
      await persistTeachersLocally(db, [normalised]);
      console.log(`[teachers] Profile synced: ${normalised.name}`);
    }
  } catch (err) {
    console.warn("[teachers] syncOwnProfile failed:", err.message);
  }
};

const syncAssignmentsFromServer = async (db, schoolId, teacherId) => {
  try {
    const { role } = getCurrentAuth();
    const isAdmin  = isAdminRole(role);

    const endpoints = isAdmin
      ? [API.admin.assignments.list]
      : [API.teacher.myAssignments];

    let rawList = null;

    for (const ep of endpoints) {
      try {
        const res  = await api.get(ep, {
          params:  { schoolId },
          timeout: 10_000,
        });
        const data = res.data;
        const list =
          Array.isArray(data?.assignments) ? data.assignments :
          Array.isArray(data?.data)        ? data.data        :
          Array.isArray(data)              ? data             : null;

        if (list?.length) {
          rawList = list;
          console.log(`[assignments] ${ep} → ${list.length} row(s)`);
          break;
        }
      } catch (err) {
        console.log(`[assignments] ${ep} → ${err.response?.status ?? "ERR"}`);
      }
    }

    if (!rawList?.length) return;

    const normalised = rawList
      .map((a) => normaliseServerAssignment(a, teacherId, schoolId))
      .filter(Boolean);

    await persistAssignmentsLocally(db, normalised);
    console.log(`[assignments] Persisted ${normalised.length} row(s)`);
  } catch (err) {
    console.warn("[assignments] syncAssignmentsFromServer failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — PUBLIC SERVICE OBJECT
// ═════════════════════════════════════════════════════════════════════════════

export const TeacherService = {

  async syncFromServer() {
    if (!isAuthenticated()) {
      console.log("[teachers] Not authenticated — skipping sync");
      return;
    }

    try {
      const net = await NetInfo.fetch();
      if (!net.isConnected) return;

      const db                 = await getDatabase();
      await ensureSchema(db);
      const { schoolId, user } = getCurrentAuth();
      const teacherId          = String(user?._id || user?.id || "");

      await syncOwnProfile(db, schoolId);
      await syncAssignmentsFromServer(db, schoolId, teacherId);
    } catch (err) {
      console.warn("[teachers] syncFromServer failed:", err.message);
    }
  },

  async getAll() {
    const db               = await getDatabase();
    await ensureSchema(db);
    const { schoolId }     = getCurrentAuth();

    await repairTeacherRoles(db);
    await backfillSchoolId(db, schoolId);
    await migrateLegacyAssignments(db, schoolId);
    await TeacherService.syncFromServer();

    try {
      const userCols = await resolveUserCols(db);
      const taCols   = await resolveAssignmentCols();

      const { conditions, params: whereParams } =
        buildTeacherConditions(userCols, schoolId, "u");
      const { filter: taFilter, params: taParams } =
        buildAssignmentFilter(taCols, schoolId, "ta");

      const hasSubjects = await tableExists(db, SUBJECTS_TABLE);

      const subjectJoin = hasSubjects
        ? `LEFT JOIN ${SUBJECTS_TABLE} s
             ON s.id = ta.${taCols.subjectCol}
            AND (s.deleted_at IS NULL OR s.deleted_at = '')`
        : "";

      const subjectExpr = hasSubjects
        ? "GROUP_CONCAT(DISTINCT s.name) AS subjectsCsv"
        : "'' AS subjectsCsv";

      const schoolColExpr = userCols.schoolCol
        ? `u.${userCols.schoolCol}`
        : "u.school_id";

      const rows = await db.getAllAsync(
        `SELECT
           u.id,
           u.name,
           u.email,
           ${schoolColExpr}                         AS schoolId,
           u.created_at,
           COUNT(DISTINCT ta.${taCols.subjectCol}) AS subjectCount,
           COUNT(DISTINCT ta.${taCols.classCol})   AS classCount,
           ${subjectExpr}
         FROM ${USERS_TABLE} u
         LEFT JOIN ${ASSIGNMENTS_TABLE} ta
           ON  ta.${taCols.teacherCol} = u.id
           AND ${taFilter}
         ${subjectJoin}
         WHERE ${conditions}
         GROUP BY u.id
         ORDER BY u.name ASC`,
        [...taParams, ...whereParams]
      );

      return rows ?? [];
    } catch (err) {
      console.error("[teachers] getAll error:", err.message);
      return [];
    }
  },

  async getCounts() {
    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    await repairTeacherRoles(db);
    await backfillSchoolId(db, schoolId);
    await migrateLegacyAssignments(db, schoolId);
    await TeacherService.syncFromServer();

    try {
      const userCols = await resolveUserCols(db);
      const taCols   = await resolveAssignmentCols();

      const { conditions, params: whereParams } =
        buildTeacherConditions(userCols, schoolId, "u");
      const { filter: taFilter, params: taParams } =
        buildAssignmentFilter(taCols, schoolId, "ta");

      const [totalRow, unassignedRow] = await Promise.all([
        db.getFirstAsync(
          `SELECT COUNT(*) AS count
           FROM ${USERS_TABLE} u
           WHERE ${conditions}`,
          whereParams
        ),
        db.getFirstAsync(
          `SELECT COUNT(*) AS count
           FROM ${USERS_TABLE} u
           WHERE ${conditions}
             AND NOT EXISTS (
               SELECT 1 FROM ${ASSIGNMENTS_TABLE} ta
               WHERE ta.${taCols.teacherCol} = u.id
                 AND ${taFilter}
             )`,
          [...whereParams, ...taParams]
        ),
      ]);

      const total      = totalRow?.count      ?? 0;
      const unassigned = unassignedRow?.count ?? 0;

      console.log(`[teachers] counts — total: ${total}, unassigned: ${unassigned}`);
      return { total, unassigned };
    } catch (err) {
      console.error("[teachers] getCounts error:", err.message);
      return { total: 0, unassigned: 0 };
    }
  },

  async getById(id) {
    if (!id) return null;

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    try {
      const cols = await resolveUserCols(db);

      const softFilter = cols.deletedCol
        ? `AND (${cols.deletedCol} IS NULL OR ${cols.deletedCol} = '')`
        : "";

      const params = [id];
      let   schoolFilter = "";

      if (schoolId && cols.schoolCol) {
        schoolFilter =
          `AND (${cols.schoolCol} = ? OR ${cols.schoolCol} IS NULL OR ${cols.schoolCol} = '')`;
        params.push(schoolId);
      }

      return await db.getFirstAsync(
        `SELECT id, name, email, role,
                ${cols.schoolCol ?? "school_id"} AS schoolId,
                created_at
         FROM   ${USERS_TABLE}
         WHERE  id = ?
           AND  LOWER(role) = 'teacher'
           AND  LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
           ${softFilter}
           ${schoolFilter}
         LIMIT  1`,
        params
      ) ?? null;
    } catch (err) {
      console.error("[teachers] getById error:", err.message);
      throw err;
    }
  },

  async getAssignedSubjects(teacherId) {
    if (!teacherId) return [];

    const db                 = await getDatabase();
    await ensureSchema(db);
    const { schoolId, user } = getCurrentAuth();

    await migrateLegacyAssignments(db, schoolId);

    const taCols = await resolveAssignmentCols();
    const { filter: taFilter, params: taParams } =
      buildAssignmentFilter(taCols, schoolId, "ta");

    const query = `
      SELECT
        ta.id                                 AS assignmentId,
        ta.${taCols.subjectCol}               AS subjectId,
        ta.${taCols.classCol}                 AS classId,
        ta.${taCols.teacherCol}               AS teacherId,
        COALESCE(s.name, 'Unknown Subject')   AS name,
        COALESCE(c.name, 'Unknown Class')     AS className
      FROM ${ASSIGNMENTS_TABLE} ta
      LEFT JOIN ${SUBJECTS_TABLE} s
        ON  s.id = ta.${taCols.subjectCol}
        AND (s.deleted_at IS NULL OR s.deleted_at = '')
      LEFT JOIN ${CLASSES_TABLE} c
        ON  c.id = ta.${taCols.classCol}
        AND (c.deleted_at IS NULL OR c.deleted_at = '')
      WHERE ta.${taCols.teacherCol} = ?
        AND ${taFilter}
      ORDER BY className ASC, name ASC
    `;

    const rows = await db.getAllAsync(query, [teacherId, ...taParams])
      .catch(() => []);

    if (rows.length > 0) return rows;

    console.log("[teachers] getAssignedSubjects — local empty, syncing…");
    const uid = String(user?._id || user?.id || "");
    await syncAssignmentsFromServer(db, schoolId, uid);

    return await db.getAllAsync(query, [teacherId, ...taParams])
      .catch(() => []);
  },

  async getAvailableSubjects() {
    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    await migrateLegacyAssignments(db, schoolId);

    if (
      !(await tableExists(db, SUBJECTS_TABLE)) ||
      !(await tableExists(db, CLASSES_TABLE))
    ) {
      return [];
    }

    try {
      const taCols = await resolveAssignmentCols();
      const { filter: taFilter, params: taParams } =
        buildAssignmentFilter(taCols, schoolId, "ta");

      const subjectCols = await getTableColumns(db, SUBJECTS_TABLE);
      const classCol    = subjectCols.includes("class_id")   ? "class_id"   : "classId";
      const teacherCol  = subjectCols.includes("teacher_id") ? "teacher_id" : "teacherId";
      const schoolColS  = subjectCols.includes("school_id")  ? "school_id"  : "schoolId";

      const params  = [...taParams];
      let   schoolF = "";

      if (schoolId && schoolColS) {
        schoolF = `AND (s.${schoolColS} = ? OR s.${schoolColS} IS NULL OR s.${schoolColS} = '')`;
        params.push(schoolId);
      }

      const rows = await db.getAllAsync(
        `SELECT
           s.id,
           s.name,
           s.${classCol} AS classId,
           c.name        AS className
         FROM ${SUBJECTS_TABLE} s
         INNER JOIN ${CLASSES_TABLE} c
           ON  c.id = s.${classCol}
           AND (c.deleted_at IS NULL OR c.deleted_at = '')
         WHERE (s.deleted_at IS NULL OR s.deleted_at = '')
           AND (s.${teacherCol} IS NULL OR s.${teacherCol} = '')
           AND NOT EXISTS (
             SELECT 1 FROM ${ASSIGNMENTS_TABLE} ta
             WHERE ta.${taCols.subjectCol} = s.id
               AND ta.${taCols.classCol}   = s.${classCol}
               AND ${taFilter}
           )
           ${schoolF}
         ORDER BY c.name ASC, s.name ASC`,
        params
      );

      return rows ?? [];
    } catch (err) {
      console.error("[teachers] getAvailableSubjects error:", err.message);
      return [];
    }
  },

  async getTeachersBySubjectAndClass(classId, subjectId) {
    if (!classId || !subjectId) return [];

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    try {
      const taCols = await resolveAssignmentCols();
      const { filter: taFilter, params: taParams } =
        buildAssignmentFilter(taCols, schoolId, "ta");

      const rows = await db.getAllAsync(
        `SELECT
           ta.${taCols.teacherCol}  AS teacherId,
           u.name                   AS teacherName,
           u.email                  AS teacherEmail,
           ta.id                    AS assignmentId
         FROM ${ASSIGNMENTS_TABLE} ta
         INNER JOIN ${USERS_TABLE} u
           ON  u.id = ta.${taCols.teacherCol}
           AND LOWER(u.role) = 'teacher'
           AND LOWER(u.role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
           AND (u.deleted_at IS NULL OR u.deleted_at = '')
         WHERE ta.${taCols.classCol}   = ?
           AND ta.${taCols.subjectCol} = ?
           AND ${taFilter}
         ORDER BY u.name ASC`,
        [classId, subjectId, ...taParams]
      );

      return rows ?? [];
    } catch (err) {
      console.error("[teachers] getTeachersBySubjectAndClass error:", err.message);
      return [];
    }
  },

  async getUnassigned() {
    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    await migrateLegacyAssignments(db, schoolId);

    try {
      const userCols = await resolveUserCols(db);
      const taCols   = await resolveAssignmentCols();

      const { conditions, params: whereParams } =
        buildTeacherConditions(userCols, schoolId, "u");
      const { filter: taFilter, params: taParams } =
        buildAssignmentFilter(taCols, schoolId, "ta");

      const rows = await db.getAllAsync(
        `SELECT u.id, u.name, u.email, u.created_at
         FROM ${USERS_TABLE} u
         WHERE ${conditions}
           AND NOT EXISTS (
             SELECT 1 FROM ${ASSIGNMENTS_TABLE} ta
             WHERE ta.${taCols.teacherCol} = u.id
               AND ${taFilter}
           )
         ORDER BY u.name ASC`,
        [...whereParams, ...taParams]
      );

      return rows ?? [];
    } catch (err) {
      console.error("[teachers] getUnassigned error:", err.message);
      return [];
    }
  },

  async create(name, email) {
    const cleanName  = name?.trim();
    const cleanEmail = email?.trim().toLowerCase();

    if (!cleanName)  throw appError("svcErr.teacherNameRequired", "Teacher name is required");
    if (!cleanEmail) throw appError("svcErr.teacherEmailRequired", "Teacher email is required");
    if (!EMAIL_REGEX.test(cleanEmail)) {
      throw appError("svcErr.invalidEmail", "Please enter a valid email address");
    }

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    const duplicateTeacher = await db.getFirstAsync(
      `SELECT id FROM ${USERS_TABLE}
       WHERE LOWER(email) = ? AND LOWER(role) = 'teacher' AND ${NOT_DELETED}
       LIMIT 1`,
      [cleanEmail]
    );
    if (duplicateTeacher) throw appError("svcErr.teacherEmailExists", "A teacher with this email already exists");

    const otherRoleUser = await db.getFirstAsync(
      `SELECT id, role FROM ${USERS_TABLE}
       WHERE LOWER(email) = ? AND LOWER(role) != 'teacher' AND ${NOT_DELETED}
       LIMIT 1`,
      [cleanEmail]
    );
    if (otherRoleUser) {
      throw appError(
        "svcErr.emailUsedByOtherRole",
        `This email is already used by a ${otherRoleUser.role ?? "user"} account`
      );
    }

    const localId = generateLocalId();
    const now     = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO ${USERS_TABLE}
         (id, name, email, role, school_id, schoolId, is_active,
          created_at, deleted_at, _synced)
       VALUES (?, ?, ?, 'teacher', ?, ?, 1, ?, NULL, 0)`,
      [localId, cleanName, cleanEmail, schoolId, schoolId, now]
    );

    console.log(`[teachers] Saved locally: ${cleanName} [${localId}]`);

    if (!isAuthenticated()) return localId;

    const net = await NetInfo.fetch();
    if (!net.isConnected) return localId;

    try {
      const response = await api.post(API.admin.teachers.list, {
        id:       localId,
        name:     cleanName,
        email:    cleanEmail,
        role:     "teacher",
        schoolId,
      });

      const serverId = String(
        response.data?.teacher?._id ||
        response.data?.teacher?.id  ||
        response.data?.data?._id    ||
        response.data?.data?.id     ||
        response.data?._id          ||
        response.data?.id           ||
        localId
      );

      if (serverId !== localId) {
        return reconcileTeacherId(db, localId, serverId);
      }

      await db.runAsync(
        `UPDATE ${USERS_TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
        [now, localId]
      );
      console.log(`[teachers] Synced to server: ${cleanName} [${serverId}]`);
      return serverId;
    } catch (err) {
      if (err?.response?.status === 409) {
        const data     = err.response.data;
        const serverId = String(
          data?.teacher?._id || data?.teacher?.id ||
          data?._id          || data?.id          || localId
        );

        if (serverId !== localId) {
          return reconcileTeacherId(db, localId, serverId);
        }
        await db.runAsync(
          `UPDATE ${USERS_TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, localId]
        );
        return serverId;
      }

      console.warn(`[teachers] Server push failed: ${err.message}`);
      return localId;
    }
  },

  async update(id, name, email) {
    const cleanName  = name?.trim();
    const cleanEmail = email?.trim().toLowerCase();

    if (!cleanName)  throw appError("svcErr.teacherNameRequired", "Teacher name is required");
    if (!cleanEmail) throw appError("svcErr.teacherEmailRequired", "Teacher email is required");
    if (!EMAIL_REGEX.test(cleanEmail)) {
      throw appError("svcErr.invalidEmail", "Please enter a valid email address");
    }

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    const cols       = await resolveUserCols(db);
    const softFilter = cols.deletedCol
      ? `AND (${cols.deletedCol} IS NULL OR ${cols.deletedCol} = '')`
      : "";

    const existParams = [id];
    let   schoolF     = "";
    if (schoolId && cols.schoolCol) {
      schoolF = `AND (${cols.schoolCol} = ? OR ${cols.schoolCol} IS NULL OR ${cols.schoolCol} = '')`;
      existParams.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id FROM ${USERS_TABLE}
       WHERE id = ? AND LOWER(role) = 'teacher' ${softFilter} ${schoolF}
       LIMIT 1`,
      existParams
    );
    if (!existing) throw appError("svcErr.teacherNotFound", "Teacher not found");

    const duplicate = await db.getFirstAsync(
      `SELECT 1 FROM ${USERS_TABLE}
       WHERE LOWER(email) = ? AND id != ? AND ${NOT_DELETED}
       LIMIT 1`,
      [cleanEmail, id]
    );
    if (duplicate) throw appError("svcErr.userEmailExists", "A user with this email already exists");

    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE ${USERS_TABLE}
       SET name = ?, email = ?, updated_at = ?, _synced = 0
       WHERE id = ? AND LOWER(role) = 'teacher'`,
      [cleanName, cleanEmail, now, id]
    );

    if (!isAuthenticated()) return true;

    const net = await NetInfo.fetch();
    if (!net.isConnected) return true;

    try {
      await api.put(API.admin.teachers.detail(id), {
        name: cleanName, email: cleanEmail,
      });
      await db.runAsync(
        `UPDATE ${USERS_TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
        [now, id]
      );
      console.log(`[teachers] Update synced: ${cleanName}`);
    } catch (err) {
      console.warn(`[teachers] Update server push failed: ${err.message}`);
    }

    return true;
  },

  async assignSubject(teacherId, subjectId) {
    if (!teacherId || !subjectId) {
      throw new Error("teacherId and subjectId are required");
    }

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    const teacher = await db.getFirstAsync(
      `SELECT id FROM ${USERS_TABLE}
       WHERE id = ?
         AND LOWER(role) = 'teacher'
         AND LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
         AND ${NOT_DELETED}
       LIMIT 1`,
      [teacherId]
    );
    if (!teacher) throw appError("svcErr.teacherNotExist", "Teacher does not exist");

    const subjectCols = await getTableColumns(db, SUBJECTS_TABLE);
    const classCol    = subjectCols.includes("class_id") ? "class_id" : "classId";

    const subject = await db.getFirstAsync(
      `SELECT id, ${classCol} AS classId
       FROM ${SUBJECTS_TABLE}
       WHERE id = ? AND ${NOT_DELETED}
       LIMIT 1`,
      [subjectId]
    );
    if (!subject?.classId) {
      throw appError("svcErr.subjectNotExist", "Subject does not exist or has no valid class");
    }

    const taCols = await resolveAssignmentCols();
    const { filter: taFilter, params: taCheckParams } =
      buildAssignmentFilter(taCols, schoolId, "ta");

    const existing = await db.getFirstAsync(
      `SELECT id, ${taCols.teacherCol} AS teacherId
       FROM ${ASSIGNMENTS_TABLE} ta
       WHERE ta.${taCols.subjectCol} = ?
         AND ta.${taCols.classCol}   = ?
         AND ${taFilter}
       LIMIT 1`,
      [subjectId, subject.classId, ...taCheckParams]
    );

    if (existing) {
      if (existing.teacherId === teacherId) return true;
      throw appError("svcErr.subjectAlreadyAssigned", "Subject is already assigned to another teacher");
    }

    const localAssignId = generateLocalId();
    const now           = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO ${ASSIGNMENTS_TABLE}
         (id,
          teacher_id, teacherId,
          class_id,   classId,
          subject_id, subjectId,
          school_id,  schoolId,
          _synced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        localAssignId,
        teacherId, teacherId,
        subject.classId, subject.classId,
        subjectId, subjectId,
        schoolId, schoolId,
        now, now,
      ]
    );

    await db.runAsync(
      `UPDATE ${SUBJECTS_TABLE} SET teacher_id = ? WHERE id = ?`,
      [teacherId, subjectId]
    ).catch(() => {});

    if (!isAuthenticated()) return true;

    const net = await NetInfo.fetch();
    if (!net.isConnected) return true;

    try {
      const response = await api.post(API.admin.assignments.list, {
        teacherId,
        classId:  subject.classId,
        subjectId,
        schoolId,
      });

      const serverId = String(
        response.data?.assignment?._id ||
        response.data?.assignment?.id  ||
        response.data?.data?._id       ||
        response.data?.data?.id        ||
        response.data?._id             ||
        response.data?.id              ||
        localAssignId
      );

      await reconcileAssignmentId(db, localAssignId, serverId);
      console.log(`[assignments] Synced: ${serverId}`);
    } catch (err) {
      if (err?.response?.status === 409) {
        await db.runAsync(
          `UPDATE ${ASSIGNMENTS_TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, localAssignId]
        );
      } else {
        console.warn(`[assignments] Server push failed: ${err.message}`);
      }
    }

    return true;
  },

  async unassignSubject(teacherId, subjectId) {
    if (!teacherId || !subjectId) {
      throw new Error("teacherId and subjectId are required");
    }

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    const taCols = await resolveAssignmentCols();
    const { filter: taFilter, params: taParams } =
      buildAssignmentFilter(taCols, schoolId, "ta");

    const assignment = await db.getFirstAsync(
      `SELECT id, ${taCols.classCol} AS classId
       FROM ${ASSIGNMENTS_TABLE} ta
       WHERE ta.${taCols.teacherCol} = ?
         AND ta.${taCols.subjectCol} = ?
         AND ${taFilter}
       LIMIT 1`,
      [teacherId, subjectId, ...taParams]
    );

    if (!assignment) {
      const subjectCols = await getTableColumns(db, SUBJECTS_TABLE);
      const teacherCol  = subjectCols.includes("teacher_id") ? "teacher_id" : "teacherId";
      const subject     = await db.getFirstAsync(
        `SELECT id FROM ${SUBJECTS_TABLE}
         WHERE id = ? AND ${teacherCol} = ? LIMIT 1`,
        [subjectId, teacherId]
      ).catch(() => null);

      if (subject) {
        const col = subjectCols.includes("teacher_id") ? "teacher_id" : "teacherId";
        await db.runAsync(
          `UPDATE ${SUBJECTS_TABLE} SET ${col} = NULL WHERE id = ?`,
          [subjectId]
        ).catch(() => {});
        return true;
      }

      throw appError("svcErr.subjectNotAssigned", "Subject is not assigned to this teacher");
    }

    const inTimetable = await db.getFirstAsync(
      `SELECT 1 FROM ${TIMETABLE_TABLE}
       WHERE subject_id = ? AND teacher_id = ? LIMIT 1`,
      [subjectId, teacherId]
    ).catch(() => null);

    if (inTimetable) {
      throw appError("svcErr.subjectInTimetable", "Cannot unassign — subject is used in the timetable");
    }

    const now = new Date().toISOString();
    const net = await NetInfo.fetch().catch(() => ({ isConnected: false }));

    if (net.isConnected && isAuthenticated() && isServerGeneratedId(assignment.id)) {
      try {
        await api.delete(API.admin.assignments.detail(assignment.id));
        await db.runAsync(
          `DELETE FROM ${ASSIGNMENTS_TABLE} WHERE id = ?`,
          [assignment.id]
        );
        console.log(`[assignments] Deleted: ${assignment.id}`);
      } catch (err) {
        if (err?.response?.status === 404) {
          await db.runAsync(
            `DELETE FROM ${ASSIGNMENTS_TABLE} WHERE id = ?`,
            [assignment.id]
          );
        } else {
          await db.runAsync(
            `UPDATE ${ASSIGNMENTS_TABLE}
             SET deleted_at = ?, updated_at = ?, _synced = 0
             WHERE id = ?`,
            [now, now, assignment.id]
          );
          console.warn(`[assignments] Server delete failed: ${err.message}`);
        }
      }
    } else {
      await db.runAsync(
        `UPDATE ${ASSIGNMENTS_TABLE}
         SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE id = ?`,
        [now, now, assignment.id]
      );
    }

    const subjectCols = await getTableColumns(db, SUBJECTS_TABLE);
    const teacherCol  = subjectCols.includes("teacher_id") ? "teacher_id" : "teacherId";
    await db.runAsync(
      `UPDATE ${SUBJECTS_TABLE} SET ${teacherCol} = NULL WHERE id = ?`,
      [subjectId]
    ).catch(() => {});

    return true;
  },

  async delete(id) {
    if (!id) throw new Error("Teacher ID is required");

    const db           = await getDatabase();
    await ensureSchema(db);
    const { schoolId } = getCurrentAuth();

    const cols       = await resolveUserCols(db);
    const softFilter = cols.deletedCol
      ? `AND (${cols.deletedCol} IS NULL OR ${cols.deletedCol} = '')`
      : "";

    const existParams = [id];
    let   schoolF     = "";
    if (schoolId && cols.schoolCol) {
      schoolF = `AND (${cols.schoolCol} = ? OR ${cols.schoolCol} IS NULL)`;
      existParams.push(schoolId);
    }

    const teacher = await db.getFirstAsync(
      `SELECT id FROM ${USERS_TABLE}
       WHERE id = ?
         AND LOWER(role) = 'teacher'
         AND LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')
         ${softFilter} ${schoolF}
       LIMIT 1`,
      existParams
    );
    if (!teacher) throw appError("svcErr.teacherNotFound", "Teacher not found");

    const taCols = await resolveAssignmentCols();
    const { filter: taFilter, params: taParams } =
      buildAssignmentFilter(taCols, schoolId, "ta");

    const hasAssignments = await db.getFirstAsync(
      `SELECT 1 FROM ${ASSIGNMENTS_TABLE} ta
       WHERE ta.${taCols.teacherCol} = ? AND ${taFilter} LIMIT 1`,
      [id, ...taParams]
    );
    if (hasAssignments) {
      throw appError("svcErr.teacherHasSubjects", "Cannot delete — teacher has assigned subjects. Unassign first.");
    }

    const inTimetable = await db.getFirstAsync(
      `SELECT 1 FROM ${TIMETABLE_TABLE} WHERE teacher_id = ? LIMIT 1`,
      [id]
    ).catch(() => null);
    if (inTimetable) {
      throw appError("svcErr.teacherInTimetable", "Cannot delete — teacher is referenced in the timetable");
    }

    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE ${USERS_TABLE}
       SET deleted_at = ?, updated_at = ?, _synced = 0
       WHERE id = ?
         AND LOWER(role) = 'teacher'
         AND LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')`,
      [now, now, id]
    );

    if (!isAuthenticated()) return true;

    const net = await NetInfo.fetch();
    if (!net.isConnected) return true;

    try {
      await api.delete(API.admin.teachers.detail(id));
      await db.runAsync(
        `UPDATE ${USERS_TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
        [now, id]
      );
      console.log(`[teachers] Deleted: ${id}`);
    } catch (err) {
      if (err?.response?.status === 404) {
        await db.runAsync(
          `UPDATE ${USERS_TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, id]
        );
      } else {
        console.warn(`[teachers] Server delete failed: ${err.message}`);
      }
    }

    return true;
  },

  async debugAll() {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();

    const teachers    = await db.getAllAsync(
      `SELECT id, name, email, role, school_id, schoolId, deleted_at
       FROM ${USERS_TABLE}
       WHERE LOWER(role) = 'teacher'
         AND LOWER(role) NOT IN ('admin', 'school_admin', 'super_admin', 'superadmin')`
    );
    const assignments = await db.getAllAsync(
      `SELECT * FROM ${ASSIGNMENTS_TABLE} WHERE ${NOT_DELETED}`
    ).catch(() => []);

    console.log(`[debug] Teachers: ${teachers.length}, schoolId: ${schoolId}`);

    for (const t of teachers) {
      const sid    = t.school_id || t.schoolId;
      const marker =
        sid === schoolId ? "✅" :
        !sid             ? "⚠️ no-sid" : "❌ foreign";

      const mine = assignments.filter(
        (a) => a.teacher_id === t.id || a.teacherId === t.id
      );

      console.log(
        `  ${marker} id=${t.id} name=${t.name} ` +
        `assignments=${mine.length} deleted=${t.deleted_at ?? "—"}`
      );

      mine.forEach((a) => {
        const idSource = isGhostId(a.id) ? "👻 GHOST" :
                         isLocalId(a.id) ? "📱 local" : "☁️ server";
        console.log(
          `    └─ ${idSource} id=${a.id} ` +
          `class=${a.class_id ?? a.classId} ` +
          `subject=${a.subject_id ?? a.subjectId}`
        );
      });
    }

    const ghosts = assignments.filter((a) => isGhostId(a.id));
    console.log(
      ghosts.length > 0
        ? `⚠️ Ghost assignments: ${ghosts.length}`
        : "✅ No ghost assignments"
    );

    return { teachers, assignments };
  },
};

export default TeacherService;