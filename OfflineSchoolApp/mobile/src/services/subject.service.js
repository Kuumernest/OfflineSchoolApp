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
import { MutationQueue }                   from "./mutationQueue.service";

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
  // NULL = no coefficient held, which reads as 1 (as SyncManager's migration).
  await safeAddColumn(db, TABLE, "coefficient",  "REAL DEFAULT NULL");

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
    coefficient:  Number(raw.coefficient) > 0 ? Number(raw.coefficient) : null,
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
    // A row from the server never replaces one with an unsent local change
    // (_synced != 1): the list may have left the server before the change was
    // made. The same rule as SyncManager.syncSubjects. A local write (a
    // create, _synced 0) replaces as before.
    const fromServer = (s._synced ?? 1) === 1;
    await db.runAsync(
      fromServer
        ? `INSERT INTO ${TABLE}
           (id, school_id, class_id, teacher_id, teacher_name, class_name,
            name, code, _synced, _synced_at, deleted_at, created_at, updated_at, coefficient)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             school_id = excluded.school_id, class_id = excluded.class_id,
             teacher_id = excluded.teacher_id, teacher_name = excluded.teacher_name,
             class_name = excluded.class_name, name = excluded.name, code = excluded.code,
             _synced = 1, _synced_at = excluded._synced_at, deleted_at = excluded.deleted_at,
             updated_at = excluded.updated_at,
             coefficient = COALESCE(excluded.coefficient, ${TABLE}.coefficient)
           WHERE ${TABLE}._synced = 1`
        : `INSERT OR REPLACE INTO ${TABLE}
           (id, school_id, class_id, teacher_id, teacher_name, class_name,
            name, code, _synced, _synced_at, deleted_at, created_at, updated_at, coefficient)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        s.coefficient  ?? null,
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

      // Answered from the phone's table after the server's rows are written
      // into it: a subject created or edited here and still queued is shown
      // as the phone holds it (the write above leaves those rows alone), not
      // as the server held it a moment before the change went out.
      await persistSubjectsLocally(db, normalised).catch((err) =>
        console.warn("⚠️ [subjects] persist error:", err.message)
      );
      const merged = await getLocalSubjects(db, schoolId, filterClassId);
      return { data: raw, normalized: merged, count: merged.length };
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

/**
 * Written locally and queued, online or not.
 *
 * This used to POST first without an id and fall back to a local row when
 * the request failed. Offline that local row was only marked dirty, and the
 * sync cleared every dirty subject flag (markOrphanedRecordsAsSynced) before
 * the backfill could queue it — the subject never reached the server. And a
 * POST that landed but lost its answer left a second, local copy behind.
 * Now the subject carries the id this device chose (POST /admin/subjects
 * keeps a client id and answers a repeat with the row it holds), and the
 * outbox sends it once its class exists upstream: the class is queued
 * first, and the id map rewrites classId if it was ever re-issued.
 */
const cleanCoefficient = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const createSubject = async ({ name, classId, code, schoolId, coefficient }) => {
  if (!name?.trim()) throw new Error("[subjects] name is required");
  if (!classId)      throw new Error("[subjects] classId is required");

  const db             = await getDatabase();
  await ensureSchema(db);
  const auth           = getCurrentAuth();
  const resolvedSchool = schoolId ?? auth.schoolId;

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
    coefficient:  cleanCoefficient(coefficient),
    _synced:      0,
    _synced_at:   null,
    deleted_at:   null,
    created_at:   now,
    updated_at:   now,
  };

  await persistSubjectsLocally(db, [subject]);
  await queueCreate(subject, classId, resolvedSchool);

  return subject;
};

/** The create for a subject made here — re-queued under the same key on an edit before it is sent. */
const queueCreate = async (subject, classId, schoolId) => {
  await MutationQueue.enqueue({
    entityKey: `subject:${subject.id}`,
    method:    "POST",
    endpoint:  API.admin.subjects.list,
    payload:   {
      id:       subject.id,
      name:     subject.name,
      code:     subject.code || "",
      classId,
      schoolId,
      ...(subject.coefficient ? { coefficient: subject.coefficient } : {}),
      __resolve:   ["classId"],
      __local:     { table: TABLE, ids: [subject.id] },
      __reconcile: { kind: "subject", localId: subject.id, table: TABLE },
    },
  });
};

/**
 * Renamed / re-coded / re-weighted locally and queued.
 *
 * This used to be a PUT from the screen, online only. Now the row changes
 * here at once and PUT /admin/subjects/:id waits in the outbox; a second
 * edit before it is sent is merged into it. A subject created on this phone
 * and not sent yet has no server row to PUT: its queued create is rewritten
 * with the new values instead, so the server hears of it once.
 *
 * A blank coefficient leaves the stored one alone, as the server does.
 */
export const updateSubject = async (id, { name, code, coefficient } = {}) => {
  if (!id) throw new Error("[subjects] id is required");
  if (name !== undefined && !String(name).trim()) throw new Error("[subjects] name is required");

  const db  = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(`SELECT * FROM ${TABLE} WHERE id = ?`, [String(id)]).catch(() => null);
  if (!row) throw new Error("[subjects] subject not found");

  const now   = new Date().toISOString();
  const coeff = cleanCoefficient(coefficient);
  const next  = {
    name: name !== undefined ? String(name).trim() : row.name,
    code: code !== undefined ? (String(code ?? "").trim() || null) : row.code,
    coefficient: coeff ?? row.coefficient ?? null,
  };

  await db.runAsync(
    `UPDATE ${TABLE} SET name = ?, code = ?, coefficient = ?, _synced = 0, updated_at = ? WHERE id = ?`,
    [next.name, next.code, next.coefficient, now, String(id)]
  );

  if ((await MutationQueue.createState(`subject:${id}`)) === "unsent") {
    await queueCreate(
      { ...row, ...next, id: String(id) },
      row.class_id ?? row.classId,
      row.school_id ?? row.schoolId ?? getCurrentAuth().schoolId
    );
    return { ...row, ...next, updated_at: now, _synced: 0 };
  }

  await MutationQueue.enqueue({
    entityKey: `subject-update:${id}`,
    method:    "PUT",
    endpoint:  API.admin.subjects.detail(id),
    merge:     true,
    payload:   {
      ...(name !== undefined ? { name: next.name } : {}),
      ...(code !== undefined ? { code: next.code || "" } : {}),
      ...(coeff ? { coefficient: coeff } : {}),
      // `since`: an edit made while this is in flight keeps the row dirty.
      __local: { table: TABLE, ids: [String(id)], since: now },
    },
  });

  return { ...row, ...next, updated_at: now, _synced: 0 };
};

/**
 * Removed locally and queued.
 *
 * A subject this phone created and never sent is undone instead: its queued
 * create is cancelled and the row goes, with nothing sent. Otherwise the
 * DELETE goes through the outbox. This used to call the server directly
 * when signed in (offline: a failed request and a warning) and then mark the
 * row dirty either way, so a delete the server had already taken was sent a
 * second time, and an offline one was lost when the sync cleared the flag.
 */
export const deleteSubject = async (id) => {
  if (!id) throw new Error("[subjects] id is required");

  const db  = await getDatabase();
  await ensureSchema(db);
  const now = new Date().toISOString();

  if ((await MutationQueue.createState(`subject:${id}`)) === "unsent") {
    await MutationQueue.cancelUnsent(`subject:${id}`);
    await MutationQueue.cancelUnsent(`subject-update:${id}`);
    // Assignments made to it on this phone and not sent either go with it:
    // they name a subject the server will never have.
    const deps = (await db.getAllAsync(
      `SELECT id FROM teacher_assignments WHERE subject_id = ? OR subjectId = ?`, [id, id]
    ).catch(() => [])) ?? [];
    for (const dep of deps) {
      if ((await MutationQueue.createState(`assignment:${dep.id}`)) !== "unsent") continue;
      await MutationQueue.cancelUnsent(`assignment:${dep.id}`);
      await db.runAsync(`DELETE FROM teacher_assignments WHERE id = ?`, [dep.id]).catch(() => {});
    }
    const result = await db.runAsync(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    return (result?.changes ?? 0) > 0;
  }

  const result = await db.runAsync(
    `UPDATE ${TABLE} SET deleted_at = ?, _synced = 0, updated_at = ? WHERE id = ? AND ${NOT_DELETED}`,
    [now, now, id]
  );
  if ((result?.changes ?? 0) === 0) return false;

  await MutationQueue.enqueue({
    entityKey: `subject-delete:${id}`,
    method:    "DELETE",
    endpoint:  API.admin.subjects.detail(id),
    payload:   {
      __local:     { table: TABLE, ids: [id] },
      __reconcile: { kind: "softDelete", table: TABLE, localId: id },
    },
  });

  return true;
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

  create: ({ name, classId, code, schoolId, coefficient }) =>
    createSubject({ name, classId, code, schoolId, coefficient }),

  update: (id, changes) => updateSubject(id, changes),

  delete: (id) => deleteSubject(id),
};