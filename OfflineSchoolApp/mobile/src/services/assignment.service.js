// src/services/assignment.service.js
"use strict";

import { getDatabase }  from "../db/database";
import AsyncStorage     from "@react-native-async-storage/async-storage";
import api              from "./api";               // your axios instance

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA GUARD
// Safe to call multiple times — idempotent.
// ─────────────────────────────────────────────────────────────────────────────

export const ensureAssignmentSchema = async (db) => {
  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS teacher_assignments (
        id          TEXT PRIMARY KEY,

        -- camelCase (primary — used by all query/upsert code)
        teacherId   TEXT,
        classId     TEXT,
        subjectId   TEXT,
        schoolId    TEXT,

        -- snake_case aliases (kept for migration compat)
        teacher_id  TEXT,
        class_id    TEXT,
        subject_id  TEXT,
        school_id   TEXT,

        -- populated blobs (JSON) — filled by syncTeacherAssignments
        teacher_json  TEXT,
        class_json    TEXT,
        subject_json  TEXT,

        -- extra metadata
        role        TEXT,
        is_primary  INTEGER DEFAULT 0,

        -- timestamps & sync
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at  TEXT,
        deleted_at  TEXT DEFAULT NULL,
        _synced     INTEGER DEFAULT 0,
        _synced_at  TEXT DEFAULT NULL
      );
    `);

    // ── Patch any columns missing from older installs ─────────────────────
    const cols   = await db.getAllAsync(`PRAGMA table_info(teacher_assignments)`);
    const colSet = new Set(cols.map((c) => c.name.toLowerCase()));

    const required = [
      ["teacherId",     "TEXT"],
      ["classId",       "TEXT"],
      ["subjectId",     "TEXT"],
      ["schoolId",      "TEXT"],
      ["teacher_id",    "TEXT"],
      ["class_id",      "TEXT"],
      ["subject_id",    "TEXT"],
      ["school_id",     "TEXT"],
      ["teacher_json",  "TEXT"],
      ["class_json",    "TEXT"],
      ["subject_json",  "TEXT"],
      ["role",          "TEXT"],
      ["is_primary",    "INTEGER DEFAULT 0"],
      ["_synced",       "INTEGER DEFAULT 0"],
      ["_synced_at",    "TEXT"],
      ["deleted_at",    "TEXT DEFAULT NULL"],
      ["updated_at",    "TEXT"],
      ["created_at",    "TEXT DEFAULT CURRENT_TIMESTAMP"],
    ];

    for (const [col, def] of required) {
      if (!colSet.has(col.toLowerCase())) {
        await db.execAsync(
          `ALTER TABLE teacher_assignments ADD COLUMN ${col} ${def}`
        );
        console.log(`[ensureAssignmentSchema] ✅ Added: teacher_assignments.${col}`);
      }
    }

    // ── Backfill snake_case ↔ camelCase ───────────────────────────────────
    await db.execAsync(`
      UPDATE teacher_assignments
      SET
        teacher_id = COALESCE(teacher_id, teacherId),
        class_id   = COALESCE(class_id,   classId),
        subject_id = COALESCE(subject_id, subjectId),
        school_id  = COALESCE(school_id,  schoolId),
        teacherId  = COALESCE(teacherId,  teacher_id),
        classId    = COALESCE(classId,    class_id),
        subjectId  = COALESCE(subjectId,  subject_id),
        schoolId   = COALESCE(schoolId,   school_id)
      WHERE
        teacher_id IS NULL OR teacherId IS NULL
        OR class_id IS NULL OR classId IS NULL
    `);

  } catch (err) {
    console.warn("[ensureAssignmentSchema] ⚠️", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses the teacher / class / subject JSON blobs that syncTeacherAssignments
 * stores and returns a normalised assignment object that the UI expects:
 *
 *   assignment.teacher.name
 *   assignment.class.name
 *   assignment.subject.name
 */
const hydrateRow = (row) => {
  if (!row) return null;

  let teacher = null;
  let cls     = null;
  let subject = null;

  try { teacher = row.teacher_json ? JSON.parse(row.teacher_json) : null; } catch { /* ignore */ }
  try { cls     = row.class_json   ? JSON.parse(row.class_json)   : null; } catch { /* ignore */ }
  try { subject = row.subject_json ? JSON.parse(row.subject_json) : null; } catch { /* ignore */ }

  // Fallback so UI never shows "N/A" when JSON blob is missing
  if (!teacher) teacher = { _id: row.teacherId || row.teacher_id, name: row.teacherName || null };
  if (!cls)     cls     = { _id: row.classId   || row.class_id,   name: row.className   || null };
  if (!subject) subject = { _id: row.subjectId || row.subject_id, name: row.subjectName || null };

  return {
    ...row,
    _id:     row.id || row._id,
    id:      row.id || row._id,
    teacher,
    class:   cls,
    subject,
  };
};

/** Reads schoolId from AsyncStorage (same key your app uses at login). */
const getStoredSchoolId = async () => {
  try {
    const raw = await AsyncStorage.getItem("user");
    if (!raw) return null;
    const user = JSON.parse(raw);
    return user?.schoolId || user?.school_id || null;
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — names the assignments screen expects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getAllAssignments()
 *
 * Returns every active assignment for the current school,
 * with teacher / class / subject objects hydrated so the UI
 * can access  assignment.teacher.name  etc.
 *
 * Reads from the local SQLite cache.  The cache is kept fresh
 * by syncTeacherAssignments() which runs on every app focus.
 */
export const getAllAssignments = async () => {
  try {
    const db       = await getDatabase();
    await ensureAssignmentSchema(db);

    const schoolId = await getStoredSchoolId();

    const rows = schoolId
      ? await db.getAllAsync(
          `SELECT *
           FROM   teacher_assignments
           WHERE  (schoolId = ? OR school_id = ?)
             AND  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY created_at DESC`,
          [schoolId, schoolId]
        )
      : await db.getAllAsync(
          `SELECT *
           FROM   teacher_assignments
           WHERE  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY created_at DESC`
        );

    return rows.map(hydrateRow).filter(Boolean);
  } catch (err) {
    console.warn("[assignment.service] getAllAssignments:", err.message);
    return [];
  }
};

/**
 * getTeachersList()
 *
 * Returns every teacher visible to the current school.
 * Reads from the local `users` table that is populated by the sync layer.
 */
export const getTeachersList = async () => {
  try {
    const db       = await getDatabase();
    const schoolId = await getStoredSchoolId();

    // Ensure the users table exists before querying
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id        TEXT PRIMARY KEY,
        _id       TEXT,
        name      TEXT,
        email     TEXT,
        role      TEXT,
        schoolId  TEXT,
        school_id TEXT,
        isActive  INTEGER DEFAULT 1,
        enrollmentNo TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);

    const rows = schoolId
      ? await db.getAllAsync(
          `SELECT *
           FROM   users
           WHERE  role = 'teacher'
             AND  (schoolId = ? OR school_id = ?)
             AND  (isActive = 1 OR isActive IS NULL)
           ORDER  BY name ASC`,
          [schoolId, schoolId]
        )
      : await db.getAllAsync(
          `SELECT *
           FROM   users
           WHERE  role = 'teacher'
             AND  (isActive = 1 OR isActive IS NULL)
           ORDER  BY name ASC`
        );

    // Normalise so every item has both _id and id
    return rows.map((r) => ({
      ...r,
      _id: r._id || r.id,
      id:  r.id  || r._id,
    }));
  } catch (err) {
    console.warn("[assignment.service] getTeachersList:", err.message);
    return [];
  }
};

/**
 * getClassesList()
 *
 * Returns every active class for the current school.
 * Reads from the local `classes` table populated by the sync layer.
 */
export const getClassesList = async () => {
  try {
    const db       = await getDatabase();
    const schoolId = await getStoredSchoolId();

    // Ensure the classes table exists before querying
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS classes (
        id        TEXT PRIMARY KEY,
        _id       TEXT,
        name      TEXT,
        level     TEXT,
        section   TEXT,
        schoolId  TEXT,
        school_id TEXT,
        isActive  INTEGER DEFAULT 1,
        deletedAt TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
    `);

    const rows = schoolId
      ? await db.getAllAsync(
          `SELECT *
           FROM   classes
           WHERE  (schoolId = ? OR school_id = ?)
             AND  (isActive = 1 OR isActive IS NULL)
             AND  (deletedAt IS NULL OR deletedAt = '')
           ORDER  BY name ASC`,
          [schoolId, schoolId]
        )
      : await db.getAllAsync(
          `SELECT *
           FROM   classes
           WHERE  (isActive = 1 OR isActive IS NULL)
             AND  (deletedAt IS NULL OR deletedAt = '')
           ORDER  BY name ASC`
        );

    return rows.map((r) => ({
      ...r,
      _id: r._id || r.id,
      id:  r.id  || r._id,
    }));
  } catch (err) {
    console.warn("[assignment.service] getClassesList:", err.message);
    return [];
  }
};

/**
 * deleteAssignment(id)
 *
 * Soft-deletes locally, then fires the server DELETE in the background.
 * If the server call fails the row stays soft-deleted locally and will
 * be retried on the next push cycle.
 */
export const deleteAssignment = async (id) => {
  if (!id) throw new Error("deleteAssignment: id is required");

  const db  = await getDatabase();
  const now = new Date().toISOString();

  // ── 1. Soft-delete locally first so the UI updates instantly ─────────
  await db.runAsync(
    `UPDATE teacher_assignments
     SET    deleted_at = ?,
            updated_at = ?,
            _synced    = 0
     WHERE  id = ?`,
    [now, now, id]
  );

  // ── 2. Fire server DELETE in the background ───────────────────────────
  try {
    await api.delete(`/admin/teacher-assignments/${id}`);

    // Mark as synced so the push cycle skips it
    await db.runAsync(
      `UPDATE teacher_assignments
       SET    _synced = 1, _synced_at = ?
       WHERE  id = ?`,
      [now, id]
    );
  } catch (serverErr) {
    // Non-fatal — the push cycle will retry
    console.warn(
      `[assignment.service] deleteAssignment: server call failed for ${id}:`,
      serverErr.message
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING EXPORTS (unchanged — kept for other callers)
// ─────────────────────────────────────────────────────────────────────────────

export const getAssignmentsForTeacher = async (teacherId) => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    const rows = await db.getAllAsync(
      `SELECT *
       FROM   teacher_assignments
       WHERE  teacherId = ?
         AND  (deleted_at IS NULL OR deleted_at = '')
       ORDER  BY created_at DESC`,
      [teacherId]
    );
    return rows.map(hydrateRow).filter(Boolean);
  } catch (err) {
    console.warn("[assignment.service] getAssignmentsForTeacher:", err.message);
    return [];
  }
};

export const getAssignmentsForClass = async (classId) => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    const rows = await db.getAllAsync(
      `SELECT *
       FROM   teacher_assignments
       WHERE  classId = ?
         AND  (deleted_at IS NULL OR deleted_at = '')
       ORDER  BY created_at DESC`,
      [classId]
    );
    return rows.map(hydrateRow).filter(Boolean);
  } catch (err) {
    console.warn("[assignment.service] getAssignmentsForClass:", err.message);
    return [];
  }
};

export const getAllAssignmentsForSchool = async (schoolId) => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    const rows = await db.getAllAsync(
      `SELECT *
       FROM   teacher_assignments
       WHERE  (schoolId = ? OR school_id = ?)
         AND  (deleted_at IS NULL OR deleted_at = '')
       ORDER  BY created_at DESC`,
      [schoolId, schoolId]
    );
    return rows.map(hydrateRow).filter(Boolean);
  } catch (err) {
    console.warn("[assignment.service] getAllAssignmentsForSchool:", err.message);
    return [];
  }
};

export const getAssignmentCounts = async (schoolId = null) => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    const whereSchool = schoolId ? `AND (schoolId = ? OR school_id = ?)` : "";
    const params      = schoolId ? [schoolId, schoolId] : [];

    const [total, withTeacher] = await Promise.all([
      db.getFirstAsync(
        `SELECT COUNT(DISTINCT subjectId) AS count
         FROM   teacher_assignments
         WHERE  (deleted_at IS NULL OR deleted_at = '')
           AND  subjectId IS NOT NULL AND subjectId != ''
           ${whereSchool}`,
        params
      ),
      db.getFirstAsync(
        `SELECT COUNT(DISTINCT subjectId) AS count
         FROM   teacher_assignments
         WHERE  (deleted_at IS NULL OR deleted_at = '')
           AND  teacherId IS NOT NULL AND teacherId != ''
           AND  subjectId IS NOT NULL AND subjectId != ''
           ${whereSchool}`,
        params
      ),
    ]);

    return {
      total:       total?.count       ?? 0,
      withTeacher: withTeacher?.count ?? 0,
      unassigned:  (total?.count ?? 0) - (withTeacher?.count ?? 0),
    };
  } catch (err) {
    console.warn("[assignment.service] getAssignmentCounts:", err.message);
    return { total: 0, withTeacher: 0, unassigned: 0 };
  }
};

export const hasAssignment = async (teacherId, classId, subjectId) => {
  try {
    const db  = await getDatabase();
    await ensureAssignmentSchema(db);

    const row = await db.getFirstAsync(
      `SELECT id FROM teacher_assignments
       WHERE  teacherId = ?
         AND  classId   = ?
         AND  subjectId = ?
         AND  (deleted_at IS NULL OR deleted_at = '')
       LIMIT 1`,
      [teacherId, classId, subjectId]
    );
    return !!row;
  } catch (err) {
    console.warn("[assignment.service] hasAssignment:", err.message);
    return false;
  }
};

export const softDeleteAssignment = async (id) => {
  try {
    const db  = await getDatabase();
    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE teacher_assignments
       SET    deleted_at = ?,
              updated_at = ?,
              _synced    = 0
       WHERE  id = ?`,
      [now, now, id]
    );
  } catch (err) {
    console.warn("[assignment.service] softDeleteAssignment:", err.message);
  }
};

export const clearLocalAssignments = async (schoolId = null) => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    if (schoolId) {
      await db.runAsync(
        `DELETE FROM teacher_assignments WHERE schoolId = ? OR school_id = ?`,
        [schoolId, schoolId]
      );
    } else {
      await db.runAsync(`DELETE FROM teacher_assignments`);
    }

    console.log("[assignment.service] ✅ clearLocalAssignments done");
  } catch (err) {
    console.warn("[assignment.service] clearLocalAssignments:", err.message);
  }
};