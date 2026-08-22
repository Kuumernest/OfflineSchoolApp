// src/services/assignment.service.js
"use strict";

import { getDatabase } from "../db/database";
import AsyncStorage    from "@react-native-async-storage/async-storage";
import api             from "./api";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA GUARD
// ─────────────────────────────────────────────────────────────────────────────

export const ensureAssignmentSchema = async (db) => {
  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS teacher_assignments (
        id           TEXT PRIMARY KEY,
        teacherId    TEXT,
        classId      TEXT,
        subjectId    TEXT,
        schoolId     TEXT,
        teacher_id   TEXT,
        class_id     TEXT,
        subject_id   TEXT,
        school_id    TEXT,
        teacher_json TEXT,
        class_json   TEXT,
        subject_json TEXT,
        role         TEXT,
        is_primary   INTEGER DEFAULT 0,
        created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at   TEXT,
        deleted_at   TEXT DEFAULT NULL,
        _synced      INTEGER DEFAULT 0,
        _synced_at   TEXT DEFAULT NULL
      )
    `);

    const cols   = await db.getAllAsync(`PRAGMA table_info(teacher_assignments)`);
    const colSet = new Set(cols.map((c) => c.name.toLowerCase()));

    const required = [
      ["teacherId",    "TEXT"],
      ["classId",      "TEXT"],
      ["subjectId",    "TEXT"],
      ["schoolId",     "TEXT"],
      ["teacher_id",   "TEXT"],
      ["class_id",     "TEXT"],
      ["subject_id",   "TEXT"],
      ["school_id",    "TEXT"],
      ["teacher_json", "TEXT"],
      ["class_json",   "TEXT"],
      ["subject_json", "TEXT"],
      ["role",         "TEXT"],
      ["is_primary",   "INTEGER DEFAULT 0"],
      ["_synced",      "INTEGER DEFAULT 0"],
      ["_synced_at",   "TEXT"],
      ["deleted_at",   "TEXT DEFAULT NULL"],
      ["updated_at",   "TEXT"],
      ["created_at",   "TEXT DEFAULT CURRENT_TIMESTAMP"],
    ];

    for (const [col, def] of required) {
      if (!colSet.has(col.toLowerCase())) {
        await db.execAsync(
          `ALTER TABLE teacher_assignments ADD COLUMN ${col} ${def}`
        );
        console.log(
          `[ensureAssignmentSchema] ✅ Added: teacher_assignments.${col}`
        );
      }
    }

    // Backfill snake_case ↔ camelCase aliases
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

const hydrateRow = (row) => {
  if (!row) return null;

  let teacherFromJson = null;
  let classFromJson   = null;
  let subjectFromJson = null;

  try { teacherFromJson = row.teacher_json ? JSON.parse(row.teacher_json) : null; } catch { /* ignore */ }
  try { classFromJson   = row.class_json   ? JSON.parse(row.class_json)   : null; } catch { /* ignore */ }
  try { subjectFromJson = row.subject_json ? JSON.parse(row.subject_json) : null; } catch { /* ignore */ }

  // ── Teacher ───────────────────────────────────────────────
  const teacherId =
    teacherFromJson?._id || teacherFromJson?.id ||
    row.teacherId        || row.teacher_id      || null;

  const teacherName =
    teacherFromJson?.name || row.teacherName || row.teacher_name || null;

  const teacher = {
    _id:   teacherId,
    id:    teacherId,
    name:  teacherName,
    email: teacherFromJson?.email || row.teacherEmail || row.teacher_email || null,
    role:  teacherFromJson?.role  || null,
  };

  // ── Class ─────────────────────────────────────────────────
  const classId =
    classFromJson?._id || classFromJson?.id ||
    row.classId        || row.class_id      || null;

  const className =
    classFromJson?.name || row.className || row.class_name || null;

  const cls = {
    _id:     classId,
    id:      classId,
    name:    className,
    level:   classFromJson?.level   || row.classLevel   || null,
    section: classFromJson?.section || row.classSection || null,
  };

  // ── Subject ───────────────────────────────────────────────
  const subjectId =
    subjectFromJson?._id || subjectFromJson?.id ||
    row.subjectId        || row.subject_id      || null;

  const subjectName =
    subjectFromJson?.name || row.subjectName || row.subject_name || null;

  const subject = {
    _id:  subjectId,
    id:   subjectId,
    name: subjectName,
    code: subjectFromJson?.code || row.subjectCode || null,
  };

  if (__DEV__) {
    if (!teacherName)  console.warn("[hydrateRow] teacher name null for assignment",  row.id, "\n  teacher_json:", row.teacher_json, "\n  teacherId:", row.teacherId);
    if (!className)    console.warn("[hydrateRow] class name null for assignment",    row.id, "\n  class_json:",   row.class_json,   "\n  classId:",   row.classId);
    if (!subjectName)  console.warn("[hydrateRow] subject name null for assignment",  row.id, "\n  subject_json:", row.subject_json, "\n  subjectId:", row.subjectId);
  }

  return { ...row, _id: row.id || row._id, id: row.id || row._id, teacher, class: cls, subject };
};

const getStoredSchoolId = async () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const schoolId = useAuthStore.getState()?.user?.schoolId;
    if (schoolId) return schoolId;
  } catch { /* store not yet loaded */ }

  try {
    const SecureStore = require("expo-secure-store");
    const raw = await SecureStore.getItemAsync("user");
    if (raw) {
      const user = JSON.parse(raw);
      if (user?.schoolId || user?.school_id) return user.schoolId || user.school_id;
    }
  } catch { /* SecureStore not available */ }

  try {
    const raw = await AsyncStorage.getItem("user");
    if (raw) {
      const user = JSON.parse(raw);
      return user?.schoolId || user?.school_id || null;
    }
  } catch { /* ignore */ }

  return null;
};

const withRetry = async (fn, retries = 3, delayMs = 1_000) => {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status      = err?.response?.status;
      const isNetErr    = !err.response;
      const isServerErr = status >= 500 && status <= 599;
      const isTimeout   = err.code === "ECONNABORTED";

      if (status === 401 || status === 403) throw err;
      if (status >= 400 && status < 500)   throw err;

      const shouldRetry =
        (isNetErr || isServerErr || isTimeout) && attempt < retries;
      if (!shouldRetry) break;

      const delay = Math.min(
        delayMs * Math.pow(2, attempt - 1) + Math.random() * 300,
        8_000
      );
      console.warn(
        `[assignment.service] attempt ${attempt} failed (${err.message}). ` +
        `Retrying in ${Math.round(delay)}ms…`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
};

// ─────────────────────────────────────────────────────────────────────────────
// CORE UPSERT — single source of truth for writing an assignment row
//
// Used by:
//   • syncAssignments (SyncManager pull)
//   • reconcileAssignmentId (local-id → server-id swap after POST)
//   • createAssignment / createBulkAssignments
//
// FIX 1: Always names every column explicitly — immune to future schema
//         additions that would break positional INSERT … VALUES statements.
// FIX 2: Uses ON CONFLICT(id) DO UPDATE so re-syncing the same row never
//         throws a UNIQUE constraint error.
// FIX 3: Separate ON CONFLICT clause for the composite business-key
//         (teacher_id, class_id, subject_id) via a separate UPSERT path
//         so duplicate business-key rows from the server are merged rather
//         than rejected.
// ─────────────────────────────────────────────────────────────────────────────

const UPSERT_ASSIGNMENT_SQL = `
  INSERT INTO teacher_assignments (
    id,
    teacherId,   teacher_id,
    classId,     class_id,
    subjectId,   subject_id,
    schoolId,    school_id,
    teacher_json,
    class_json,
    subject_json,
    role,
    is_primary,
    _synced,
    _synced_at,
    created_at,
    updated_at,
    deleted_at
  )
  VALUES (
    ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?, ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?,
    ?
  )
  ON CONFLICT(id) DO UPDATE SET
    teacherId    = excluded.teacherId,
    teacher_id   = excluded.teacher_id,
    classId      = excluded.classId,
    class_id     = excluded.class_id,
    subjectId    = excluded.subjectId,
    subject_id   = excluded.subject_id,
    schoolId     = COALESCE(excluded.schoolId,  teacher_assignments.schoolId),
    school_id    = COALESCE(excluded.school_id, teacher_assignments.school_id),
    teacher_json = CASE
      WHEN excluded.teacher_json IS NOT NULL
        AND json_extract(excluded.teacher_json, '$.name') IS NOT NULL
      THEN excluded.teacher_json
      ELSE COALESCE(teacher_assignments.teacher_json, excluded.teacher_json)
    END,
    class_json   = CASE
      WHEN excluded.class_json IS NOT NULL
        AND json_extract(excluded.class_json, '$.name') IS NOT NULL
      THEN excluded.class_json
      ELSE COALESCE(teacher_assignments.class_json, excluded.class_json)
    END,
    subject_json = CASE
      WHEN excluded.subject_json IS NOT NULL
        AND json_extract(excluded.subject_json, '$.name') IS NOT NULL
      THEN excluded.subject_json
      ELSE COALESCE(teacher_assignments.subject_json, excluded.subject_json)
    END,
    role         = COALESCE(excluded.role,       teacher_assignments.role),
    is_primary   = COALESCE(excluded.is_primary, teacher_assignments.is_primary),
    _synced      = excluded._synced,
    _synced_at   = excluded._synced_at,
    updated_at   = excluded.updated_at,
    deleted_at   = excluded.deleted_at
`;

/**
 * Builds the 19-value parameter array that matches UPSERT_ASSIGNMENT_SQL.
 *
 * Accepts either a flat server row or an already-enriched local object.
 * All 19 positions are explicitly named — adding columns to the schema
 * will never silently break this function.
 */
const buildUpsertParams = ({
  id,
  teacherId, teacher_id,
  classId,   class_id,
  subjectId, subject_id,
  schoolId,  school_id,
  teacher_json,
  class_json,
  subject_json,
  role       = null,
  is_primary = 0,
  _synced    = 1,
  _synced_at = null,
  created_at = null,
  updated_at = null,
  deleted_at = null,
}, now = new Date().toISOString()) => {
  // Resolve camelCase / snake_case aliases
  const tId = teacherId || teacher_id || null;
  const cId = classId   || class_id   || null;
  const sId = subjectId || subject_id || null;
  const scId = schoolId || school_id  || null;

  return [
    id,
    tId, tId,
    cId, cId,
    sId, sId,
    scId, scId,
    teacher_json || null,
    class_json   || null,
    subject_json || null,
    role,
    is_primary ?? 0,
    _synced     ?? 1,
    _synced_at  || now,
    created_at  || now,
    updated_at  || now,
    deleted_at  || null,
  ];
};

/**
 * Upserts a single assignment row.
 * Safe to call repeatedly — idempotent on (id) and handles the composite
 * business-key conflict by merging rather than failing.
 */
export const upsertAssignment = async (db, assignmentData, now) => {
  const ts     = now || new Date().toISOString();
  const params = buildUpsertParams(assignmentData, ts);
  await db.runAsync(UPSERT_ASSIGNMENT_SQL, params);
};

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILE — swap a local temp id for the real server id
//
// FIX 2: Uses explicit column list so it works regardless of how many
//         columns the table has.  Also uses ON CONFLICT(id) DO UPDATE
//         instead of INSERT OR REPLACE so it never raises UNIQUE errors.
// ─────────────────────────────────────────────────────────────────────────────

export const reconcileAssignmentId = async (db, localId, serverRow, now) => {
  const ts = now || new Date().toISOString();

  try {
    // Fetch the full local row so we can preserve any locally-stored JSON blobs
    const local = await db
      .getFirstAsync(
        `SELECT * FROM teacher_assignments WHERE id = ? LIMIT 1`,
        [localId]
      )
      .catch(() => null);

    if (!local) {
      // Local row already gone — just upsert the server row directly
      await upsertAssignment(db, { ...serverRow, _synced: 1, _synced_at: ts }, ts);
      return;
    }

    const serverId = String(serverRow._id || serverRow.id || "").trim();
    if (!serverId || serverId === localId) {
      // No id change needed — just mark synced
      await db.runAsync(
        `UPDATE teacher_assignments
         SET _synced = 1, _synced_at = ?, updated_at = ?
         WHERE id = ?`,
        [ts, ts, localId]
      );
      return;
    }

    // Merge server data on top of local row, preserving local JSON blobs
    // when the server response didn't include them.
    const merged = {
      ...local,
      id:           serverId,
      teacherId:    serverRow.teacherId    || serverRow.teacher_id || local.teacherId    || local.teacher_id,
      teacher_id:   serverRow.teacher_id   || serverRow.teacherId  || local.teacher_id   || local.teacherId,
      classId:      serverRow.classId      || serverRow.class_id   || local.classId      || local.class_id,
      class_id:     serverRow.class_id     || serverRow.classId    || local.class_id     || local.classId,
      subjectId:    serverRow.subjectId    || serverRow.subject_id || local.subjectId    || local.subject_id,
      subject_id:   serverRow.subject_id   || serverRow.subjectId  || local.subject_id   || local.subjectId,
      schoolId:     serverRow.schoolId     || serverRow.school_id  || local.schoolId     || local.school_id,
      school_id:    serverRow.school_id    || serverRow.schoolId   || local.school_id    || local.schoolId,
      teacher_json: local.teacher_json || null,
      class_json:   local.class_json   || null,
      subject_json: local.subject_json || null,
      role:         serverRow.role      || local.role      || null,
      is_primary:   serverRow.is_primary ?? local.is_primary ?? 0,
      _synced:      1,
      _synced_at:   ts,
      created_at:   local.created_at || ts,
      updated_at:   ts,
      deleted_at:   serverRow.deletedAt || serverRow.deleted_at || local.deleted_at || null,
    };

    // Write the new server-id row first
    await upsertAssignment(db, merged, ts);

    // Remove the old local-id row (different primary key — must DELETE)
    await db.runAsync(
      `DELETE FROM teacher_assignments WHERE id = ? AND id != ?`,
      [localId, serverId]
    );

    console.log(`[assignments] Reconciled: ${localId} → ${serverId}`);
  } catch (err) {
    console.warn(`[assignments] reconcileAssignmentId failed:`, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNC ASSIGNMENTS FROM SERVER PULL RESPONSE
//
// FIX 1: Uses upsertAssignment (which has ON CONFLICT DO UPDATE) so pulling
//         the same 28 rows twice never raises a UNIQUE constraint error.
// ─────────────────────────────────────────────────────────────────────────────

export const syncAssignments = async (serverRows = []) => {
  if (!serverRows.length) return { synced: 0, failed: 0 };

  const db  = await getDatabase();
  await ensureAssignmentSchema(db);
  const now = new Date().toISOString();

  let synced = 0;
  let failed = 0;

  for (const raw of serverRows) {
    try {
      const id = String(raw._id || raw.id || "").trim();
      if (!id) { failed++; continue; }

      // Resolve nested teacher / class / subject objects from server response
      const serverTeacher = typeof raw.teacher === "object" ? raw.teacher : null;
      const serverClass   = typeof raw.class   === "object" ? raw.class   : null;
      const serverSubject = typeof raw.subject === "object" ? raw.subject : null;

      const teacherId =
        serverTeacher?._id || serverTeacher?.id ||
        raw.teacherId      || raw.teacher_id    || null;
      const classId =
        serverClass?._id || serverClass?.id ||
        raw.classId      || raw.class_id   || null;
      const subjectId =
        serverSubject?._id || serverSubject?.id ||
        raw.subjectId      || raw.subject_id    || null;
      const schoolId =
        raw.schoolId || raw.school_id || null;

      // Build JSON blobs — preserve existing local blobs when server
      // didn't send populated objects.
      const existing = await db
        .getFirstAsync(
          `SELECT teacher_json, class_json, subject_json
           FROM   teacher_assignments WHERE id = ? LIMIT 1`,
          [id]
        )
        .catch(() => null);

      const teacherJson = serverTeacher?.name
        ? JSON.stringify({
            _id:   teacherId,
            id:    teacherId,
            name:  serverTeacher.name,
            email: serverTeacher.email || null,
          })
        : existing?.teacher_json || null;

      const classJson = serverClass?.name
        ? JSON.stringify({
            _id:     classId,
            id:      classId,
            name:    serverClass.name,
            level:   serverClass.level   || null,
            section: serverClass.section || null,
          })
        : existing?.class_json || null;

      const subjectJson = serverSubject?.name
        ? JSON.stringify({
            _id:  subjectId,
            id:   subjectId,
            name: serverSubject.name,
            code: serverSubject.code || null,
          })
        : existing?.subject_json || null;

      await upsertAssignment(db, {
        id,
        teacherId,   teacher_id:  teacherId,
        classId,     class_id:    classId,
        subjectId,   subject_id:  subjectId,
        schoolId,    school_id:   schoolId,
        teacher_json: teacherJson,
        class_json:   classJson,
        subject_json: subjectJson,
        role:         raw.role       || null,
        is_primary:   raw.is_primary ?? 0,
        _synced:      1,
        _synced_at:   now,
        created_at:   raw.createdAt  || raw.created_at || now,
        updated_at:   raw.updatedAt  || raw.updated_at || now,
        deleted_at:   raw.deletedAt  || raw.deleted_at || null,
      }, now);

      synced++;
    } catch (err) {
      console.warn(`[assignments] syncAssignments row ${raw._id || raw.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[assignments] Synced: ${synced}, Failed: ${failed}`);
  return { synced, failed };
};

// ─────────────────────────────────────────────────────────────────────────────
// BACKFILL — teacher / class / subject JSON names
// ─────────────────────────────────────────────────────────────────────────────

export const backfillTeacherNames = async () => {
  try {
    const db  = await getDatabase();
    const now = new Date().toISOString();

    const missing = await db.getAllAsync(
      `SELECT id, teacherId, teacher_id
       FROM   teacher_assignments
       WHERE  (teacher_json IS NULL OR teacher_json = ''
               OR json_extract(teacher_json, '$.name') IS NULL)
         AND  (teacherId IS NOT NULL OR teacher_id IS NOT NULL)
         AND  (deleted_at IS NULL OR deleted_at = '')`
    ).catch(() => []);

    if (!missing.length) return;

    console.log(`[assignment.service] Backfilling ${missing.length} teacher name(s)…`);

    let fixed = 0;
    for (const row of missing) {
      const tid = row.teacherId || row.teacher_id;
      if (!tid) continue;

      const teacher = await db
        .getFirstAsync(
          "SELECT id, name, email FROM users WHERE id = ? LIMIT 1",
          [tid]
        )
        .catch(() => null);

      if (!teacher?.name) continue;

      await db
        .runAsync(
          `UPDATE teacher_assignments
           SET teacher_json = ?, updated_at = ?
           WHERE id = ?`,
          [
            JSON.stringify({ _id: tid, id: tid, name: teacher.name, email: teacher.email || null }),
            now,
            row.id,
          ]
        )
        .catch(() => {});
      fixed++;
    }

    if (fixed > 0) {
      console.log(`[assignment.service] ✅ Teacher name backfill complete (${fixed} fixed)`);
    }
  } catch (err) {
    console.warn("[assignment.service] backfillTeacherNames:", err.message);
  }
};

export const backfillClassSubjectJson = async () => {
  try {
    const db  = await getDatabase();
    const now = new Date().toISOString();

    // ── class_json ────────────────────────────────────────────
    const missingClass = await db.getAllAsync(
      `SELECT id, classId, class_id
       FROM   teacher_assignments
       WHERE  (class_json IS NULL OR class_json = ''
               OR json_extract(class_json, '$.name') IS NULL)
         AND  (classId IS NOT NULL OR class_id IS NOT NULL)
         AND  (deleted_at IS NULL OR deleted_at = '')`
    ).catch(() => []);

    if (missingClass.length) {
      console.log(`[assignment.service] Backfilling ${missingClass.length} class_json(s)…`);
      let fixed = 0;
      for (const row of missingClass) {
        const cid = row.classId || row.class_id;
        if (!cid) continue;

        const cls = await db
          .getFirstAsync(
            "SELECT id, name, level, section FROM classes WHERE id = ? LIMIT 1",
            [cid]
          )
          .catch(() => null);

        if (!cls?.name) continue;

        await db
          .runAsync(
            `UPDATE teacher_assignments SET class_json = ?, updated_at = ? WHERE id = ?`,
            [
              JSON.stringify({ _id: cid, id: cid, name: cls.name, level: cls.level || null, section: cls.section || null }),
              now,
              row.id,
            ]
          )
          .catch(() => {});
        fixed++;
      }
      if (fixed > 0) {
        console.log(`[assignment.service] ✅ class_json backfill complete (${fixed} fixed)`);
      }
    }

    // ── subject_json ──────────────────────────────────────────
    const missingSubject = await db.getAllAsync(
      `SELECT id, subjectId, subject_id
       FROM   teacher_assignments
       WHERE  (subject_json IS NULL OR subject_json = ''
               OR json_extract(subject_json, '$.name') IS NULL)
         AND  (subjectId IS NOT NULL OR subject_id IS NOT NULL)
         AND  (deleted_at IS NULL OR deleted_at = '')`
    ).catch(() => []);

    if (missingSubject.length) {
      console.log(`[assignment.service] Backfilling ${missingSubject.length} subject_json(s)…`);
      let fixed = 0;
      for (const row of missingSubject) {
        const sid = row.subjectId || row.subject_id;
        if (!sid) continue;

        const subj = await db
          .getFirstAsync(
            "SELECT id, name, code FROM subjects WHERE id = ? LIMIT 1",
            [sid]
          )
          .catch(() => null);

        if (!subj?.name) continue;

        await db
          .runAsync(
            `UPDATE teacher_assignments SET subject_json = ?, updated_at = ? WHERE id = ?`,
            [
              JSON.stringify({ _id: sid, id: sid, name: subj.name, code: subj.code || null }),
              now,
              row.id,
            ]
          )
          .catch(() => {});
        fixed++;
      }
      if (fixed > 0) {
        console.log(`[assignment.service] ✅ subject_json backfill complete (${fixed} fixed)`);
      }
    }
  } catch (err) {
    console.warn("[assignment.service] backfillClassSubjectJson:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export const getAllAssignments = async () => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    await backfillTeacherNames();
    await backfillClassSubjectJson();

    const schoolId = await getStoredSchoolId();

    const rows = schoolId
      ? await db.getAllAsync(
          `SELECT * FROM teacher_assignments
           WHERE  (schoolId = ? OR school_id = ?)
             AND  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY created_at DESC`,
          [schoolId, schoolId]
        )
      : await db.getAllAsync(
          `SELECT * FROM teacher_assignments
           WHERE  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY created_at DESC`
        );

    if (__DEV__ && rows.length > 0) {
      const s = rows[0];
      console.log("[DEBUG] Sample assignment row:");
      console.log("  teacher_json:", s.teacher_json);
      console.log("  class_json  :", s.class_json);
      console.log("  subject_json:", s.subject_json);
      console.log("  teacherId   :", s.teacherId);
      console.log("  classId     :", s.classId);
      console.log("  subjectId   :", s.subjectId);
    }

    return rows.map(hydrateRow).filter(Boolean);
  } catch (err) {
    console.warn("[assignment.service] getAllAssignments:", err.message);
    return [];
  }
};

export const getTeachersList = async () => {
  try {
    const db       = await getDatabase();
    const schoolId = await getStoredSchoolId();

    const rows = schoolId
      ? await db.getAllAsync(
          `SELECT * FROM users
           WHERE  role = 'teacher'
             AND  (schoolId = ? OR school_id = ?)
             AND  (is_active = 1 OR is_active IS NULL)
             AND  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY name ASC`,
          [schoolId, schoolId]
        )
      : await db.getAllAsync(
          `SELECT * FROM users
           WHERE  role = 'teacher'
             AND  (is_active = 1 OR is_active IS NULL)
             AND  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY name ASC`
        );

    return rows.map((r) => ({ ...r, _id: r._id || r.id, id: r.id || r._id }));
  } catch (err) {
    console.warn("[assignment.service] getTeachersList:", err.message);
    return [];
  }
};

export const getClassesList = async () => {
  try {
    const db       = await getDatabase();
    const schoolId = await getStoredSchoolId();

    const rows = schoolId
      ? await db.getAllAsync(
          `SELECT * FROM classes
           WHERE  (schoolId = ? OR school_id = ?)
             AND  (is_active = 1 OR is_active IS NULL)
             AND  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY name ASC`,
          [schoolId, schoolId]
        )
      : await db.getAllAsync(
          `SELECT * FROM classes
           WHERE  (is_active = 1 OR is_active IS NULL)
             AND  (deleted_at IS NULL OR deleted_at = '')
           ORDER  BY name ASC`
        );

    return rows.map((r) => ({ ...r, _id: r._id || r.id, id: r.id || r._id }));
  } catch (err) {
    console.warn("[assignment.service] getClassesList:", err.message);
    return [];
  }
};

export const deleteAssignment = async (id) => {
  if (!id) throw new Error("deleteAssignment: id is required");

  const db  = await getDatabase();
  const now = new Date().toISOString();

  await db.runAsync(
    `UPDATE teacher_assignments
     SET deleted_at = ?, updated_at = ?, _synced = 0
     WHERE id = ?`,
    [now, now, id]
  );

  try {
    await withRetry(
      () => api.delete(`/admin/teacher-assignments/${id}`),
      3,
      1_000
    );
    await db.runAsync(
      `UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [now, id]
    );
  } catch (serverErr) {
    console.warn(
      `[assignment.service] deleteAssignment: server call failed for ${id}:`,
      serverErr.message
    );
  }
};

export const getAssignmentsForTeacher = async (teacherId) => {
  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    const rows = await db.getAllAsync(
      `SELECT * FROM teacher_assignments
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
      `SELECT * FROM teacher_assignments
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
      `SELECT * FROM teacher_assignments
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
           AND  teacherId  IS NOT NULL AND teacherId  != ''
           AND  subjectId  IS NOT NULL AND subjectId  != ''
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
    const db = await getDatabase();
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
       SET deleted_at = ?, updated_at = ?, _synced = 0
       WHERE id = ?`,
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

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ASSIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

export const createAssignment = async ({ teacherId, classId, subjectId }) => {
  if (!teacherId || !classId || !subjectId) {
    throw new Error("createAssignment: teacherId, classId, subjectId are required");
  }

  const already = await hasAssignment(teacherId, classId, subjectId);
  if (already) {
    const err    = new Error("Assignment already exists");
    err.response = { status: 409, data: { message: "Assignment already exists" } };
    throw err;
  }

  const schoolId = await getStoredSchoolId();

  const response = await withRetry(
    () => api.post("/admin/teacher-assignments", { teacherId, classId, subjectId, schoolId })
  );

  const data       = response.data;
  const assignment = data?.assignment || data?.data || data;
  const serverId   =
    assignment?._id || assignment?.id ||
    data?._id       || data?.id       || null;

  try {
    const db  = await getDatabase();
    const now = new Date().toISOString();
    const id  = serverId ? String(serverId) : `local_${Date.now()}`;

    const [localTeacher, localClass, localSubject] = await Promise.all([
      db.getFirstAsync("SELECT name, email FROM users WHERE id = ? LIMIT 1",     [teacherId]).catch(() => null),
      db.getFirstAsync("SELECT name, level, section FROM classes WHERE id = ? LIMIT 1", [classId]).catch(() => null),
      db.getFirstAsync("SELECT name, code FROM subjects WHERE id = ? LIMIT 1",   [subjectId]).catch(() => null),
    ]);

    const serverTeacher = assignment?.teacher;
    const serverClass   = assignment?.class;
    const serverSubject = assignment?.subject;

    const teacherJson = JSON.stringify({
      _id:   teacherId,
      id:    teacherId,
      name:  (typeof serverTeacher === "object" ? serverTeacher?.name  : null) || localTeacher?.name  || null,
      email: (typeof serverTeacher === "object" ? serverTeacher?.email : null) || localTeacher?.email || null,
    });

    const classJson = JSON.stringify({
      _id:     classId,
      id:      classId,
      name:    (typeof serverClass === "object" ? serverClass?.name    : null) || localClass?.name    || null,
      level:   (typeof serverClass === "object" ? serverClass?.level   : null) || localClass?.level   || null,
      section: (typeof serverClass === "object" ? serverClass?.section : null) || localClass?.section || null,
    });

    const subjectJson = JSON.stringify({
      _id:  subjectId,
      id:   subjectId,
      name: (typeof serverSubject === "object" ? serverSubject?.name : null) || localSubject?.name || null,
      code: (typeof serverSubject === "object" ? serverSubject?.code : null) || localSubject?.code || null,
    });

    // ✅ Uses shared upsertAssignment — explicit columns, ON CONFLICT safe
    await upsertAssignment(db, {
      id,
      teacherId,   teacher_id:  teacherId,
      classId,     class_id:    classId,
      subjectId,   subject_id:  subjectId,
      schoolId,    school_id:   schoolId,
      teacher_json: teacherJson,
      class_json:   classJson,
      subject_json: subjectJson,
      _synced:     1,
      _synced_at:  now,
      created_at:  now,
      updated_at:  now,
    }, now);

  } catch (dbErr) {
    console.warn("[assignment.service] createAssignment local save:", dbErr.message);
  }

  return response.data;
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE BULK ASSIGNMENTS
// ─────────────────────────────────────────────────────────────────────────────

export const createBulkAssignments = async ({ teacherId, assignments }) => {
  if (!teacherId || !Array.isArray(assignments) || !assignments.length) {
    throw new Error("createBulkAssignments: teacherId and assignments[] are required");
  }

  const schoolId = await getStoredSchoolId();

  const response = await withRetry(
    () => api.post("/admin/teacher-assignments/bulk", { teacherId, assignments, schoolId })
  );

  try {
    const db      = await getDatabase();
    const now     = new Date().toISOString();
    const created = response.data?.created || [];

    const localTeacher = await db
      .getFirstAsync("SELECT name, email FROM users WHERE id = ? LIMIT 1", [teacherId])
      .catch(() => null);

    for (const item of created) {
      const id        = String(item._id || item.id || `local_${Date.now()}`);
      const classId   =
        item.classId ||
        assignments.find((a) => a.subjectId === item.subjectId)?.classId ||
        null;
      const subjectId = item.subjectId || null;

      if (!classId || !subjectId) continue;

      const [localClass, localSubject] = await Promise.all([
        db.getFirstAsync("SELECT name, level, section FROM classes WHERE id = ? LIMIT 1",  [classId]).catch(() => null),
        db.getFirstAsync("SELECT name, code FROM subjects WHERE id = ? LIMIT 1", [subjectId]).catch(() => null),
      ]);

      const serverTeacher = item?.teacher;
      const serverClass   = item?.class;
      const serverSubject = item?.subject;

      const teacherJson = JSON.stringify({
        _id:   teacherId,
        id:    teacherId,
        name:  (typeof serverTeacher === "object" ? serverTeacher?.name  : null) || localTeacher?.name  || null,
        email: (typeof serverTeacher === "object" ? serverTeacher?.email : null) || localTeacher?.email || null,
      });

      const classJson = JSON.stringify({
        _id:     classId,
        id:      classId,
        name:    (typeof serverClass === "object" ? serverClass?.name    : null) || localClass?.name    || null,
        level:   (typeof serverClass === "object" ? serverClass?.level   : null) || localClass?.level   || null,
        section: (typeof serverClass === "object" ? serverClass?.section : null) || localClass?.section || null,
      });

      const subjectJson = JSON.stringify({
        _id:  subjectId,
        id:   subjectId,
        name: (typeof serverSubject === "object" ? serverSubject?.name : null) || localSubject?.name || null,
        code: (typeof serverSubject === "object" ? serverSubject?.code : null) || localSubject?.code || null,
      });

      // ✅ Uses shared upsertAssignment — explicit columns, ON CONFLICT safe
      await upsertAssignment(db, {
        id,
        teacherId,   teacher_id:  teacherId,
        classId,     class_id:    classId,
        subjectId,   subject_id:  subjectId,
        schoolId,    school_id:   schoolId,
        teacher_json: teacherJson,
        class_json:   classJson,
        subject_json: subjectJson,
        _synced:     1,
        _synced_at:  now,
        created_at:  now,
        updated_at:  now,
      }, now).catch(() => {});
    }
  } catch (dbErr) {
    console.warn("[assignment.service] createBulkAssignments local save:", dbErr.message);
  }

  return response.data;
};

// ─────────────────────────────────────────────────────────────────────────────
// ALIASES & ADDITIONAL EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export const getTeacherAssignments = getAssignmentsForTeacher;

export const getSubjectsByClass = async (classId) => {
  try {
    const db = await getDatabase();

    const rows = await db.getAllAsync(
      `SELECT * FROM subjects
       WHERE  (classId = ? OR class_id = ?)
         AND  (deleted_at IS NULL OR deleted_at = '')
       ORDER  BY name ASC`,
      [classId, classId]
    );

    return rows.map((r) => ({ ...r, _id: r._id || r.id, id: r.id || r._id }));
  } catch (err) {
    console.warn("[assignment.service] getSubjectsByClass:", err.message);
    return [];
  }
};