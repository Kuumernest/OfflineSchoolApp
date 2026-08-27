"use strict";

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import {
  safeAddColumn,
  tableExists,
  getTableColumns,
  NOT_DELETED,
  withFkOff,
} from "../db/dbHelpers";
import { generateLocalId } from "../utils/idHelpers";
import { getCurrentAuth }  from "../utils/authHelpers";
import { API }             from "./apiEndpoints";
import api                 from "./api";
import NetInfo             from "@react-native-community/netinfo";
import { appError }        from "../utils/appError";

const TABLE = "classes";

const NOT_DELETED_C =
  "(c.deleted_at IS NULL OR c.deleted_at = '' OR c.deleted_at NOT LIKE '20%')";

const ensureSchema = (db) =>
  ensureTableSchema(
    TABLE,
    async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id         TEXT PRIMARY KEY NOT NULL,
          name       TEXT NOT NULL,
          level      TEXT,
          section    TEXT,
          is_active  INTEGER DEFAULT 1,
          created_at TEXT,
          updated_at TEXT,
          deleted_at TEXT,
          schoolId   TEXT,
          school_id  TEXT,
          _synced    INTEGER DEFAULT 0,
          _synced_at TEXT
        )
      `);

      const COLS = [
        ["is_active",  "INTEGER DEFAULT 1"],
        ["created_at", "TEXT"],
        ["updated_at", "TEXT"],
        ["deleted_at", "TEXT"],
        ["schoolId",   "TEXT"],
        ["school_id",  "TEXT"],
        ["level",      "TEXT"],
        ["section",    "TEXT"],
        ["_synced",    "INTEGER DEFAULT 0"],
        ["_synced_at", "TEXT"],
      ];

      for (const [col, def] of COLS) {
        await safeAddColumn(db, TABLE, col, def);
      }

      await db.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_classes_school ON ${TABLE}(schoolId)`
      ).catch(() => {});
    },
    db
  );

const backfillSchoolId = async (db, schoolId) => {
  if (!schoolId) return;
  try {
    await db.runAsync(
      `UPDATE ${TABLE}
       SET schoolId = ?, school_id = ?
       WHERE (schoolId IS NULL OR schoolId = '')
         AND ${NOT_DELETED}`,
      [schoolId, schoolId]
    );
  } catch (err) {
    console.warn("[ClassService] backfillSchoolId failed:", err.message);
  }
};

const extractDate = (value, fallback = null) => {
  if (!value) return fallback;
  if (typeof value === "object" && value.$date) return value.$date;
  return String(value);
};

const fetchServerClasses = async (schoolId, includeInactive = false) => {
  try {
    const response = await api.get(API.admin.classes.list, {
      params:  { schoolId, includeInactive: String(includeInactive) },
      timeout: 15_000,
    });
    return (
      response.data?.classes ||
      response.data?.data    ||
      (Array.isArray(response.data) ? response.data : [])
    );
  } catch (err) {
    console.warn("[ClassService] Could not fetch from server:", err.message);
    return [];
  }
};

const reconcileClassId = async (db, localId, serverId) => {
  if (!localId || !serverId) return localId || serverId;
  if (String(localId) === String(serverId)) {
    await db.runAsync(
      `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [new Date().toISOString(), localId]
    ).catch(() => {});
    return serverId;
  }

  await withFkOff(db, async () => {
    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE subjects SET class_id = ?, classId = ? WHERE class_id = ? OR classId = ?`,
      [serverId, serverId, localId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE students SET class_id = ? WHERE class_id = ?`,
      [serverId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE teacher_assignments SET classId = ?, class_id = ? WHERE classId = ? OR class_id = ?`,
      [serverId, serverId, localId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE timetable SET class_id = ? WHERE class_id = ?`,
      [serverId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE timetable_slots SET classId = ?, class_id = ? WHERE classId = ? OR class_id = ?`,
      [serverId, serverId, localId, localId]
    ).catch(() => {});

    const serverRow = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} WHERE id = ? LIMIT 1`,
      [serverId]
    ).catch(() => null);

    if (serverRow) {
      await db.runAsync(`DELETE FROM ${TABLE} WHERE id = ?`, [localId]).catch(() => {});
    } else {
      await db.runAsync(
        `UPDATE ${TABLE} SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
        [serverId, now, localId]
      ).catch(() => {});
    }

    await db.runAsync(
      `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [now, serverId]
    ).catch(() => {});
  });

  return serverId;
};

const syncServerClassesToLocal = async (db, schoolId, includeInactive = false) => {
  if (!schoolId) return;

  const net = await NetInfo.fetch();
  if (!net.isConnected) return;

  const serverClasses = await fetchServerClasses(schoolId, includeInactive);
  if (!serverClasses.length) return;

  // Step 1: collect server IDs
  const serverIds = serverClasses
    .map(sc => String(sc._id || sc.id || "").trim())
    .filter(Boolean);

  // Step 2: soft-delete stale local rows
  if (serverIds.length) {
    const placeholders = serverIds.map(() => "?").join(",");
    const ts           = new Date().toISOString();

    try {
      const result = await db.runAsync(
        `UPDATE ${TABLE}
         SET deleted_at = ?, updated_at = ?, _synced = 1, _synced_at = ?
         WHERE (schoolId = ? OR schoolId IS NULL OR schoolId = '')
           AND id NOT IN (${placeholders})
           AND (deleted_at IS NULL OR deleted_at = '' OR deleted_at NOT LIKE '20%')`,
        [ts, ts, ts, schoolId, ...serverIds]
      );

      if ((result?.changes ?? 0) > 0) {
        console.log(`[ClassService] Removed ${result.changes} stale class(es)`);
      }
    } catch (err) {
      console.warn("[ClassService] Stale-row cleanup failed:", err.message);
    }
  }

  // Step 3: upsert server classes
  let synced = 0;
  const ts   = new Date().toISOString();

  for (const sc of serverClasses) {
    const serverId = String(sc._id || sc.id || "").trim();
    const name     = String(sc.name || "").trim();
    if (!serverId || !name) continue;

    const schoolIdVal = sc.schoolId || sc.school_id || schoolId;
    const activeValue = (
      sc.isActive  === false || Number(sc.isActive)  === 0 ||
      sc.is_active === false || Number(sc.is_active) === 0
    ) ? 0 : 1;

    const deletedAt = sc.deletedAt  ?? sc.deleted_at  ?? null;
    const createdAt = extractDate(sc.createdAt || sc.created_at) || ts;
    const updatedAt = extractDate(sc.updatedAt || sc.updated_at) || ts;

    try {
      const localDuplicate = await db.getFirstAsync(
        `SELECT id FROM ${TABLE}
         WHERE LOWER(name) = LOWER(?)
           AND id != ?
           AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')
           AND ${NOT_DELETED}
         LIMIT 1`,
        [name, serverId, schoolId]
      ).catch(() => null);

      if (localDuplicate?.id) {
        await reconcileClassId(db, localDuplicate.id, serverId);
      }

      await db.runAsync(
        `INSERT INTO ${TABLE}
           (id, name, level, section, schoolId, school_id, is_active, deleted_at, created_at, updated_at, _synced, _synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           level      = excluded.level,
           section    = excluded.section,
           schoolId   = excluded.schoolId,
           school_id  = excluded.school_id,
           is_active  = excluded.is_active,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at,
           _synced    = 1,
           _synced_at = excluded._synced_at`,
        [serverId, name, sc.level || null, sc.section || "", schoolIdVal, schoolIdVal, activeValue, deletedAt, createdAt, updatedAt, ts]
      );
      synced++;
    } catch (err) {
      console.warn(`[ClassService] Failed to cache "${name}":`, err.message);
    }
  }

  console.log(`[ClassService] Cached ${synced} class(es) from server`);
};

function normaliseRow(row) {
  const id = String(row.id ?? "");
  return {
    ...row,
    _id:          id,
    id,
    isActive:     row.isActive == null ? true : Boolean(Number(row.isActive)),
    subjectCount: Number(row.subjectCount ?? 0),
    studentCount: Number(row.studentCount ?? 0),
  };
}

export const ClassService = {

  async getAll(includeInactive = false) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();

    await ensureSchema(db);
    await backfillSchoolId(db, schoolId);

    if (schoolId) {
      await syncServerClassesToLocal(db, schoolId, includeInactive);
    }

    try {
      const hasSubjects = await tableExists(db, "subjects");
      const hasStudents = await tableExists(db, "students");

      const subjectCols = hasSubjects ? await getTableColumns(db, "subjects") : [];
      const studentCols = hasStudents ? await getTableColumns(db, "students") : [];

      const subjectClassCol =
        subjectCols.includes("class_id") ? "class_id" :
        subjectCols.includes("classId")  ? "classId"  : null;

      const subjectDeletedCol =
        subjectCols.includes("deleted_at") ? "deleted_at" :
        subjectCols.includes("deletedAt")  ? "deletedAt"  : null;

      const studentClassCol =
        studentCols.includes("class_id") ? "class_id" :
        studentCols.includes("classId")  ? "classId"  : null;

      const subjectCountExpr =
        hasSubjects && subjectClassCol
          ? `(SELECT COUNT(*) FROM subjects s WHERE s.${subjectClassCol} = c.id ${
              subjectDeletedCol ? `AND (s.${subjectDeletedCol} IS NULL OR s.${subjectDeletedCol} = '')` : ""
            }) AS subjectCount`
          : "0 AS subjectCount";

      const studentCountExpr =
        hasStudents && studentClassCol
          ? `(SELECT COUNT(*) FROM students st WHERE st.${studentClassCol} = c.id) AS studentCount`
          : "0 AS studentCount";

      const params = [];
      let where = `WHERE ${NOT_DELETED_C}`;

      if (!includeInactive) {
        where += " AND (c.is_active = 1 OR c.is_active IS NULL)";
      }

      if (schoolId) {
        where += " AND (c.schoolId = ? OR c.schoolId IS NULL OR c.schoolId = '')";
        params.push(schoolId);
      }

      const rows = await db.getAllAsync(
        `SELECT
           c.id, c.name, c.level, c.section, c.schoolId,
           c.is_active AS isActive,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           ${subjectCountExpr},
           ${studentCountExpr}
         FROM ${TABLE} c
         ${where}
         ORDER BY LOWER(c.name) ASC, c.id ASC`,
        params
      );

      return (rows ?? []).map(normaliseRow);
    } catch (err) {
      console.error("[ClassService] getAll error:", err.message);
      return [];
    }
  },

  async getById(id) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    try {
      const params = [id];
      let where = `WHERE id = ? AND ${NOT_DELETED}`;
      if (schoolId) {
        where += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
        params.push(schoolId);
      }

      const row = await db.getFirstAsync(
        `SELECT id, name, level, section, schoolId, is_active AS isActive,
                created_at AS createdAt, updated_at AS updatedAt
         FROM ${TABLE}
         ${where}
         LIMIT 1`,
        params
      );

      return row ? normaliseRow(row) : null;
    } catch (err) {
      console.error("[ClassService] getById error:", err.message);
      return null;
    }
  },

  async create(name, level = null) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const trimmed = name?.trim();
    if (!trimmed) throw appError("svcErr.classNameRequired", "Class name is required");

    const dupParams = [trimmed];
    let dupWhere = `WHERE LOWER(name) = LOWER(?) AND ${NOT_DELETED}`;
    if (schoolId) {
      dupWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      dupParams.push(schoolId);
    }

    const exists = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${dupWhere} LIMIT 1`,
      dupParams
    );
    if (exists) throw appError("svcErr.classNameExists", "A class with this name already exists");

    const localId = generateLocalId();
    const now     = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO ${TABLE}
         (id, name, level, is_active, schoolId, school_id, created_at, updated_at, _synced)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0)`,
      [localId, trimmed, level, schoolId, schoolId, now, now]
    );

    const net = await NetInfo.fetch();
    if (!net.isConnected) return localId;

    try {
      const response = await api.post(API.admin.classes.list, {
        id: localId, name: trimmed, level, schoolId,
      });

      const raw =
        response.data?.class?._id || response.data?.class?.id ||
        response.data?.data?._id  || response.data?.data?.id  ||
        response.data?.serverId   || response.data?._id       ||
        response.data?.id         || null;

      const finalId = raw ? String(raw) : localId;

      if (finalId !== localId) {
        await reconcileClassId(db, localId, finalId);
      } else {
        await db.runAsync(
          `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, localId]
        );
      }

      return finalId;
    } catch (err) {
      if (err?.response?.status === 409) {
        const body = err.response.data;
        const raw  = body?.serverId || body?.class?._id || body?.class?.id || body?._id || body?.id || null;

        if (raw) {
          const finalId = String(raw);
          await reconcileClassId(db, localId, finalId);
          return finalId;
        }

        await db.runAsync(
          `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, localId]
        );
      } else {
        console.warn(`[ClassService] Server push failed: ${err.message}`);
      }
    }

    return localId;
  },

  async update(id, name, level = null) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const trimmed = name?.trim();
    if (!trimmed) throw appError("svcErr.classNameRequired", "Class name is required");

    const existParams = [id];
    let existWhere = `WHERE id = ? AND ${NOT_DELETED}`;
    if (schoolId) {
      existWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      existParams.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${existWhere} LIMIT 1`,
      existParams
    );
    if (!existing) throw appError("svcErr.classNotFound", "Class not found");

    const dupParams = [trimmed, id];
    let dupWhere = `WHERE LOWER(name) = LOWER(?) AND id != ? AND ${NOT_DELETED}`;
    if (schoolId) {
      dupWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      dupParams.push(schoolId);
    }

    const duplicate = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${dupWhere} LIMIT 1`,
      dupParams
    );
    if (duplicate) throw appError("svcErr.classNameExists", "A class with this name already exists");

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE ${TABLE} SET name = ?, level = ?, updated_at = ?, _synced = 0 WHERE id = ?`,
      [trimmed, level, now, id]
    );

    const net = await NetInfo.fetch();
    if (!net.isConnected) return true;

    try {
      await api.put(API.admin.classes.detail(id), { name: trimmed, level });
      await db.runAsync(
        `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
        [now, id]
      );
    } catch (err) {
      console.warn(`[ClassService] Update push failed: ${err.message}`);
    }

    return true;
  },

  async toggleActive(id) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const params = [id];
    let where = `WHERE id = ? AND ${NOT_DELETED}`;
    if (schoolId) {
      where += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      params.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id, is_active FROM ${TABLE} ${where} LIMIT 1`,
      params
    );
    if (!existing) throw appError("svcErr.classNotFound", "Class not found");

    const now             = new Date().toISOString();
    const newActive       = existing.is_active === 1 ? 0 : 1;
    const newActiveBool   = Boolean(newActive);

    await db.runAsync(
      `UPDATE ${TABLE} SET is_active = ?, updated_at = ?, _synced = 0 WHERE id = ?`,
      [newActive, now, id]
    );

    const net = await NetInfo.fetch();
    if (!net.isConnected) return { _id: id, id, isActive: newActiveBool };

    try {
      const response = await api.patch(
        API.admin.classes.toggleActive
          ? API.admin.classes.toggleActive(id)
          : `/admin/classes/${id}/toggle-active`
      );

      const raw = response.data?.class ?? response.data?.data ?? response.data;
      const serverActive =
        raw?.isActive  !== undefined ? Boolean(raw.isActive)  :
        raw?.is_active !== undefined ? Boolean(Number(raw.is_active)) :
        newActiveBool;

      await db.runAsync(
        `UPDATE ${TABLE} SET is_active = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
        [serverActive ? 1 : 0, now, id]
      );

      return { _id: id, id, isActive: serverActive };
    } catch (err) {
      console.warn(`[ClassService] toggleActive push failed: ${err.message}`);
      return { _id: id, id, isActive: newActiveBool };
    }
  },

  async delete(id) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const existParams = [id];
    let existWhere = `WHERE id = ? AND ${NOT_DELETED}`;
    if (schoolId) {
      existWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      existParams.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${existWhere} LIMIT 1`,
      existParams
    );
    if (!existing) throw appError("svcErr.classNotFound", "Class not found");

    const hasStudents = await db.getFirstAsync(
      `SELECT id FROM students WHERE class_id = ? LIMIT 1`,
      [id]
    ).catch(() => null);

    if (hasStudents) {
      throw appError(
        "svcErr.classHasStudents",
        "Cannot delete a class that has students enrolled. Move or remove students first."
      );
    }

    const now = new Date().toISOString();
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        const response        = await api.delete(API.admin.classes.detail(id));
        const deletedSubjects = response.data?.deletedSubjects ?? 0;

        await withFkOff(db, async () => {
          await db.runAsync(
            `UPDATE subjects SET deleted_at = ?, updated_at = ?, _synced = 1
             WHERE (class_id = ? OR classId = ?) AND ${NOT_DELETED}`,
            [now, now, id, id]
          ).catch(() => {});

          await db.runAsync(
            `UPDATE teacher_assignments SET deleted_at = ?, updated_at = ?, _synced = 1
             WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
            [now, now, id, id]
          ).catch(() => {});

          await db.runAsync(
            `UPDATE timetable_slots SET deleted_at = ?, updated_at = ?, _synced = 1
             WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
            [now, now, id, id]
          ).catch(() => {});

          await db.runAsync(
            `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
            [now, now, now, id]
          );
        });

        return { deletedSubjects };
      } catch (err) {
        if (err?.response?.status === 404) {
          await db.runAsync(
            `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ?, _synced = 1 WHERE id = ?`,
            [now, now, id]
          );
          return { deletedSubjects: 0 };
        }

        if (err?.response?.status === 409) {
          const serverMessage = err.response.data?.message;
          throw serverMessage
            ? new Error(serverMessage)
            : appError(
                "svcErr.classHasStudentsShort",
                "Cannot delete a class that has students enrolled."
              );
        }

        throw err;
      }
    }

    // Offline path
    await withFkOff(db, async () => {
      await db.runAsync(
        `UPDATE subjects SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE (class_id = ? OR classId = ?) AND ${NOT_DELETED}`,
        [now, now, id, id]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE teacher_assignments SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
        [now, now, id, id]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE timetable_slots SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
        [now, now, id, id]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ?, _synced = 0 WHERE id = ?`,
        [now, now, id]
      );
    });

    return { deletedSubjects: 0 };
  },

  async debugAll() {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();

    const all = await db.getAllAsync(`SELECT * FROM ${TABLE}`).catch(() => []);

    console.log(`[ClassService] 🔍 All rows (${all.length}), schoolId=${schoolId}:`);
    for (const r of all) {
      const match =
        r.schoolId === schoolId ? "✅ mine"         :
        !r.schoolId             ? "⚠️  no schoolId" :
                                  "❌ foreign";
      console.log(
        `  ${match} | id=${r.id} | name=${r.name} | school=${r.schoolId} | synced=${r._synced} | active=${r.is_active} | deleted=${r.deleted_at}`
      );
    }

    return all;
  },
};