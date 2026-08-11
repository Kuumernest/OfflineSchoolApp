"use strict";

import { getDatabase }           from "../db/database";
import { ensureTableSchema }     from "../db/schemaManager";
import { createTableFromSchema } from "../db/schema";
import {
  NOT_DELETED,
  buildInClause,
  safeAddColumn,
  tableExists,
  getTableColumns,
} from "../db/dbHelpers";
import { resolveColumns, COL }             from "../db/schemaUtils";
import { generateLocalId }                 from "../utils/idHelpers";
import { isAuthenticated, getCurrentAuth } from "../utils/authHelpers";
import { fetchWithFallback }               from "../utils/syncHelpers";
import { API }                             from "./apiEndpoints";
import api                                 from "./api";

const TABLE = "subjects";

// src/services/subject.service.js

const ensureSchema = async (db) => {
  await db.runAsync("PRAGMA foreign_keys = OFF").catch(() => {});

  // ── Step 1: Create the table if it doesn't exist ──────────────────────────
  // ensureTableSchema is cached — it only runs the callback once per session.
  // We use it purely for the CREATE TABLE call.
  await ensureTableSchema(
    TABLE,
    async (db) => {
      await createTableFromSchema(db, "subjects");
      console.log("[subjects] Table created");
    },
    db
  );

  // ── Step 2: Patch missing columns EVERY time, not just on first run ───────
  // safeAddColumn is idempotent — it checks whether the column exists
  // before issuing ALTER TABLE, so calling it repeatedly is safe.
  await safeAddColumn(db, TABLE, "_synced",      "INTEGER DEFAULT 0");
  await safeAddColumn(db, TABLE, "_synced_at",   "TEXT");
  await safeAddColumn(db, TABLE, "teacher_name", "TEXT");
  await safeAddColumn(db, TABLE, "class_name",   "TEXT");
  await safeAddColumn(db, TABLE, "code",         "TEXT");
  await safeAddColumn(db, TABLE, "teacher_id",   "TEXT");
  await safeAddColumn(db, TABLE, "class_id",     "TEXT");
  await safeAddColumn(db, TABLE, "school_id",    "TEXT");
  await safeAddColumn(db, TABLE, "deleted_at",   "TEXT");
  await safeAddColumn(db, TABLE, "created_at",   "TEXT");
  await safeAddColumn(db, TABLE, "updated_at",   "TEXT");

  await db.runAsync("PRAGMA foreign_keys = ON").catch(() => {});
};

const normaliseServerSubject = (raw, schoolId) => {
  if (!raw) return null;

  const id = String(raw._id || raw.id || "").trim();
  if (!id) return null;

  const classId = String(
    raw.class?._id || raw.classId || raw.class_id || raw.class || ""
  ).trim();

  const teacherId =
    String(
      raw.teacher?._id || raw.teacher?.id || raw.teacherId || raw.teacher_id || ""
    ).trim() || null;

  const teacherName =
    raw.teacher?.name     || raw.teacher?.fullName || raw.teacher?.full_name ||
    raw.teacherName       || raw.teacher_name      || null;

  const className =
    raw.class?.name || raw.className || raw.class_name || null;

  return {
    id,
    school_id:    String(raw.schoolId || raw.school_id || schoolId || "").trim() || null,
    class_id:     classId || null,
    teacher_id:   teacherId,
    teacher_name: teacherName,
    class_name:   className,
    name:         String(raw.name || "").trim(),
    code:         String(raw.code || "").trim() || null,
    _synced:      1,
    _synced_at:   new Date().toISOString(),
    deleted_at:   raw.deletedAt  || raw.deleted_at  || null,
    created_at:   raw.createdAt  || raw.created_at  || new Date().toISOString(),
    updated_at:   raw.updatedAt  || raw.updated_at  || new Date().toISOString(),
  };
};

const persistSubjectsLocally = async (db, subjects) => {
  if (!subjects?.length) return;

  for (const s of subjects) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${TABLE}
       (id, school_id, class_id, teacher_id, teacher_name, class_name,
        name, code, _synced, _synced_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.id,
        s.school_id    ?? null,
        s.class_id     ?? null,
        s.teacher_id   ?? null,
        s.teacher_name ?? null,
        s.class_name   ?? null,
        s.name,
        s.code         ?? null,
        s._synced      ?? 1,
        s._synced_at   ?? new Date().toISOString(),
        s.deleted_at   ?? null,
        s.created_at   ?? new Date().toISOString(),
        s.updated_at   ?? new Date().toISOString(),
      ]
    ).catch((err) => {
      console.warn(`[subjects] Failed to persist "${s.name ?? s.id}":`, err.message);
    });
  }
};

const getLocalSubjects = async (db, schoolId, classId) => {
  const cols = await resolveColumns(
    TABLE,
    { schoolCol: COL.SCHOOL_ID, classCol: COL.CLASS_ID, deletedCol: COL.DELETED_AT },
    ["deletedCol"]
  );

  const softFilter = cols.deletedCol
    ? `AND (s.${cols.deletedCol} IS NULL OR s.${cols.deletedCol} = '')`
    : "";

  const params = [];
  let where = `WHERE 1=1 ${softFilter}`;

  if (schoolId && cols.schoolCol) {
    where += ` AND s.${cols.schoolCol} = ?`;
    params.push(schoolId);
  }
  if (classId && cols.classCol) {
    where += ` AND s.${cols.classCol} = ?`;
    params.push(classId);
  }

  const hasTeachers = await tableExists(db, "teachers");
  const hasUsers    = await tableExists(db, "users");

  let teacherNameExpr = `COALESCE(s.teacher_name, NULL)`;
  let teacherJoin     = "";

  const sCols     = await getTableColumns(db, TABLE);
  const teacherFk =
    sCols.includes("teacher_id") ? "teacher_id" :
    sCols.includes("teacherId")  ? "teacherId"  : null;

  if (hasTeachers && teacherFk) {
    const tCols   = await getTableColumns(db, "teachers");
    const nameCol =
      tCols.includes("name")      ? "name"      :
      tCols.includes("fullName")  ? "fullName"  :
      tCols.includes("full_name") ? "full_name" : null;

    if (nameCol) {
      teacherNameExpr = `COALESCE(t.${nameCol}, s.teacher_name, NULL)`;
      teacherJoin     = `LEFT JOIN teachers t ON t.id = s.${teacherFk}`;
    }
  } else if (hasUsers && teacherFk) {
    const uCols   = await getTableColumns(db, "users");
    const nameCol =
      uCols.includes("name")      ? "name"      :
      uCols.includes("fullName")  ? "fullName"  :
      uCols.includes("full_name") ? "full_name" : null;

    if (nameCol) {
      teacherNameExpr = `COALESCE(u.${nameCol}, s.teacher_name, NULL)`;
      teacherJoin     = `LEFT JOIN users u ON u.id = s.${teacherFk}`;
    }
  }

  const hasClasses = await tableExists(db, "classes");
  let classNameExpr = `COALESCE(s.class_name, NULL)`;
  let classJoin     = "";

  const classFk =
    sCols.includes("class_id") ? "class_id" :
    sCols.includes("classId")  ? "classId"  : null;

  if (hasClasses && classFk) {
    const cCols   = await getTableColumns(db, "classes");
    const nameCol = cCols.includes("name") ? "name" : null;

    if (nameCol) {
      classNameExpr = `COALESCE(c.${nameCol}, s.class_name, NULL)`;
      classJoin     = `LEFT JOIN classes c ON c.id = s.${classFk}`;
    }
  }

  const rows = await db.getAllAsync(
    `SELECT
       s.id, s.school_id, s.class_id, s.teacher_id,
       s.name, s.code, s._synced, s.created_at, s.updated_at,
       ${teacherNameExpr} AS teacherName,
       ${classNameExpr}   AS className
     FROM ${TABLE} s
     ${teacherJoin}
     ${classJoin}
     ${where}
     ORDER BY s.name ASC`,
    params
  );

  return rows ?? [];
};

export const getSubjects = async (filterClassId) => {
  const db           = await getDatabase();
  await ensureSchema(db);
  const { schoolId } = getCurrentAuth();

  return fetchWithFallback({
    label: "subjects",

    serverFetch: async () => {
      const params = {};
      if (schoolId)      params.schoolId = schoolId;
      if (filterClassId) params.classId  = filterClassId;

      const response = await api.get(API.admin.subjects.list, { params, timeout: 15_000 });
      const raw = response.data?.subjects || response.data?.data || [];

      const normalised = Array.isArray(raw)
        ? raw.map((s) => normaliseServerSubject(s, schoolId)).filter(Boolean)
        : [];

      return { data: raw, normalized: normalised, count: normalised.length };
    },

    persistLocal: async (raw) => {
      const normalised = Array.isArray(raw)
        ? raw.map((s) => normaliseServerSubject(s, schoolId)).filter(Boolean)
        : [];
      persistSubjectsLocally(db, normalised).catch((err) =>
        console.warn("⚠️ [subjects] Background persist error:", err.message)
      );
    },

    localFetch: () => getLocalSubjects(db, schoolId, filterClassId),
  });
};

export const getSubjectsForClasses = async (classIds) => {
  if (!classIds?.length) return [];

  const db           = await getDatabase();
  await ensureSchema(db);
  const { schoolId } = getCurrentAuth();

  const { clause, params } = buildInClause(classIds, "class_id");
  if (schoolId) params.push(schoolId);

  const rows = await db.getAllAsync(
    `SELECT id, school_id, class_id, teacher_id, teacher_name, class_name, name, code
     FROM ${TABLE}
     WHERE ${clause}
       AND ${NOT_DELETED}
       ${schoolId ? "AND school_id = ?" : ""}
     ORDER BY name ASC`,
    params
  );

  return rows ?? [];
};

export const createSubject = async ({ name, classId, code, schoolId }) => {
  if (!name?.trim()) throw new Error("[subjects] name is required");
  if (!classId)      throw new Error("[subjects] classId is required");

  const db             = await getDatabase();
  await ensureSchema(db);
  const auth           = getCurrentAuth();
  const resolvedSchool = schoolId ?? auth.schoolId;

  if (isAuthenticated()) {
    try {
      const response = await api.post(API.admin.subjects.list, {
        name: name.trim(), classId,
        code: code?.trim() || null,
        schoolId: resolvedSchool,
      });

      const raw        = response.data?.subject || response.data?.data || response.data;
      const normalised = normaliseServerSubject(raw, resolvedSchool);

      if (normalised) {
        await persistSubjectsLocally(db, [normalised]);
        return normalised;
      }
    } catch (err) {
      console.warn("[subjects] Server create failed, creating locally:", err.message);
    }
  }

  const localId = generateLocalId();
  const now     = new Date().toISOString();
  const subject = {
    id: localId,
    school_id:    resolvedSchool ?? null,
    class_id:     classId,
    teacher_id:   null,
    teacher_name: null,
    class_name:   null,
    name:         name.trim(),
    code:         code?.trim() || null,
    _synced:      0,
    _synced_at:   null,
    deleted_at:   null,
    created_at:   now,
    updated_at:   now,
  };

  await persistSubjectsLocally(db, [subject]);
  return subject;
};

export const deleteSubject = async (id) => {
  if (!id) throw new Error("[subjects] id is required");

  const db  = await getDatabase();
  const now = new Date().toISOString();

  if (isAuthenticated() && !id.startsWith("local_")) {
    try {
      await api.delete(API.admin.subjects.detail(id));
    } catch (err) {
      console.warn("[subjects] Server delete failed:", err.message);
    }
  }

  const result = await db.runAsync(
    `UPDATE ${TABLE} SET deleted_at = ?, _synced = 0, updated_at = ? WHERE id = ? AND ${NOT_DELETED}`,
    [now, now, id]
  );

  return (result?.changes ?? 0) > 0;
};

export const SubjectService = {
  getAll: (classId) => getSubjects(classId),

  getById: async (id) => {
    const db = await getDatabase();
    await ensureSchema(db);

    const row = await db.getFirstAsync(
      `SELECT * FROM ${TABLE} WHERE id = ? AND ${NOT_DELETED}`,
      [id]
    ).catch(() => null);

    if (row) return row;

    try {
      const res  = await api.get(API.admin.subjects.detail(id));
      const raw  = res.data?.subject || res.data?.data || res.data;
      const norm = normaliseServerSubject(raw);
      if (norm) await persistSubjectsLocally(db, [norm]);
      return norm;
    } catch {
      return null;
    }
  },

  create: ({ name, classId, code, schoolId }) =>
    createSubject({ name, classId, code, schoolId }),

  delete: (id) => deleteSubject(id),
};