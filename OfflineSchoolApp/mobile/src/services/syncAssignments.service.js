// src/services/syncAssignments.service.js
"use strict";

import api             from "./api";
import { getDatabase } from "../db/database";
import { ensureAssignmentSchema } from "./assignment.service";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const getUserInfo = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const state = useAuthStore.getState();
    const user  = state?.user;
    return {
      schoolId:  user?.schoolId  ?? user?.school_id  ?? state?.schoolId ?? null,
      teacherId: user?._id       ?? user?.id          ?? null,
      role:      user?.role      ?? "",
    };
  } catch {
    return { schoolId: null, teacherId: null, role: "" };
  }
};

const getAssignmentsEndpoint = (role) => {
  const adminRoles = ["admin", "school_admin", "super_admin"];
  return adminRoles.includes(role)
    ? "/admin/teacher-assignments"
    : "/teacher/my-assignments";
};

const extractId = (field) => {
  if (!field) return null;
  if (typeof field === "string") return field;
  return field._id || field.id || null;
};

const tableExists = async (db, name) => {
  try {
    const r = await db.getFirstAsync(
      `SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?`,
      [name]
    );
    return (r?.c ?? 0) > 0;
  } catch {
    return false;
  }
};

const normaliseRow = (raw) => {
  if (!raw) return null;

  const id = raw._id || raw.id;
  if (!id) return null;

  const teacherId =
    extractId(raw.teacher) || raw.teacherId || raw.teacher_id || null;
  const classId =
    extractId(raw.class)   || raw.classId   || raw.class_id   || null;
  const subjectId =
    extractId(raw.subject) || raw.subjectId || raw.subject_id || null;
  const schoolId =
    extractId(raw.school)  || raw.schoolId  || raw.school_id  || null;

  if (!teacherId || !classId || !subjectId) return null;

  return {
    id:        String(id),
    teacherId: String(teacherId),
    classId:   String(classId),
    subjectId: String(subjectId),
    schoolId:  schoolId ? String(schoolId) : null,
  };
};

// ─────────────────────────────────────────────────────────────
// DEDUPLICATE SERVER ROWS
// ─────────────────────────────────────────────────────────────

const deduplicateServerRows = (rows) => {
  const seen = new Set();
  const out  = [];

  for (const row of rows) {
    const key = `${row.teacherId}::${row.classId}::${row.subjectId}`;
    if (seen.has(key)) {
      console.warn(
        `[syncAssignments] duplicate server row skipped — key: ${key}, id: ${row.id}`
      );
      continue;
    }
    seen.add(key);
    out.push(row);
  }

  console.log(
    `[syncAssignments] deduplicateServerRows: ${rows.length} in → ${out.length} out`
  );
  return out;
};

// ─────────────────────────────────────────────────────────────
// UPSERT
// ─────────────────────────────────────────────────────────────

const upsertAssignmentRows = async (db, rows) => {
  if (!rows.length) return 0;

  const now    = new Date().toISOString();
  let inserted = 0;

  try {
    await db.execAsync("PRAGMA foreign_keys = OFF;");

    for (const row of rows) {
      try {
        const existing = await db.getFirstAsync(
          `SELECT id FROM teacher_assignments
           WHERE teacherId = ? AND classId = ? AND subjectId = ?
           LIMIT 1`,
          [row.teacherId, row.classId, row.subjectId]
        );

        if (existing) {
          const result = await db.runAsync(
            `UPDATE teacher_assignments
             SET id         = ?,
                 schoolId   = COALESCE(?, schoolId),
                 deleted_at = NULL,
                 _synced    = 1,
                 _synced_at = ?,
                 updated_at = ?
             WHERE teacherId = ? AND classId = ? AND subjectId = ?`,
            [
              row.id, row.schoolId,
              now, now,
              row.teacherId, row.classId, row.subjectId,
            ]
          );
          if (result?.changes > 0) inserted++;
        } else {
          const result = await db.runAsync(
            `INSERT INTO teacher_assignments
               (id, teacherId, classId, subjectId, schoolId,
                deleted_at, _synced, _synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
            [
              row.id, row.teacherId, row.classId,
              row.subjectId, row.schoolId,
              now, now, now,
            ]
          );
          if (result?.changes > 0) inserted++;
        }
      } catch (err) {
        console.warn(
          `[syncAssignments] upsertRow failed [${row.id}]:`, err.message
        );
      }
    }
  } finally {
    await db.execAsync("PRAGMA foreign_keys = ON;").catch(() => {});
  }

  return inserted;
};

// ─────────────────────────────────────────────────────────────
// DEDUPLICATE LOCAL DB
// ─────────────────────────────────────────────────────────────

const deduplicateLocally = async (db) => {
  try {
    const ghostResult = await db.runAsync(
      `DELETE FROM teacher_assignments
       WHERE (id LIKE 'server_%' OR id LIKE 'local_%' OR id LIKE 'legacy_%')
         AND (deleted_at IS NULL OR deleted_at = '')
         AND _synced = 1`
    );
    if (ghostResult?.changes > 0) {
      console.log(`[syncAssignments] removed ${ghostResult.changes} ghost rows`);
    }

    const before = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM teacher_assignments
       WHERE (deleted_at IS NULL OR deleted_at = '')`
    );

    await db.execAsync(`
      DELETE FROM teacher_assignments
      WHERE (deleted_at IS NULL OR deleted_at = '')
        AND rowid NOT IN (
          SELECT MIN(rowid)
          FROM   teacher_assignments
          WHERE  (deleted_at IS NULL OR deleted_at = '')
          GROUP  BY teacherId, classId, subjectId
        )
    `);

    const after = await db.getFirstAsync(
      `SELECT COUNT(*) AS cnt FROM teacher_assignments
       WHERE (deleted_at IS NULL OR deleted_at = '')`
    );

    const removed = (before?.cnt ?? 0) - (after?.cnt ?? 0);
    if (removed > 0) {
      console.log(
        `[syncAssignments] deduplicateLocally: removed ${removed} rows`,
        `(${before?.cnt} → ${after?.cnt})`
      );
    }
  } catch (err) {
    console.warn("[syncAssignments] deduplicateLocally failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// ENSURE UNIQUE INDEX
// ─────────────────────────────────────────────────────────────

const ensureUniqueIndex = async (db) => {
  try {
    await db.execAsync(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_teacher_assignments_logical
      ON teacher_assignments (teacherId, classId, subjectId)
    `);
    console.log("[syncAssignments] unique index ensured");
  } catch (err) {
    console.warn("[syncAssignments] ensureUniqueIndex failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// SYNC subjects.teacher_id
// ─────────────────────────────────────────────────────────────

const syncSubjectTeacherIds = async (db) => {
  try {
    const hasSubjects = await tableExists(db, "subjects");
    const hasTA       = await tableExists(db, "teacher_assignments");
    if (!hasSubjects || !hasTA) return;

    const subjCols        = await db.getAllAsync(`PRAGMA table_info(subjects)`);
    const hasTeacherIdCol = subjCols.some((c) => c.name === "teacher_id");
    if (!hasTeacherIdCol) return;

    await db.execAsync("PRAGMA foreign_keys = OFF;");
    try {
      await db.execAsync(`
        UPDATE subjects
        SET teacher_id = (
          SELECT teacherId
          FROM   teacher_assignments
          WHERE  teacher_assignments.subjectId = subjects.id
            AND  (teacher_assignments.deleted_at IS NULL
                  OR teacher_assignments.deleted_at = '')
          ORDER  BY teacher_assignments.created_at DESC
          LIMIT  1
        )
        WHERE (deleted_at IS NULL OR deleted_at = '')
      `);

      await db.execAsync(`
        UPDATE subjects
        SET teacher_id = NULL
        WHERE (deleted_at IS NULL OR deleted_at = '')
          AND NOT EXISTS (
            SELECT 1 FROM teacher_assignments
            WHERE  teacher_assignments.subjectId = subjects.id
              AND  (teacher_assignments.deleted_at IS NULL
                    OR teacher_assignments.deleted_at = '')
          )
      `);
    } finally {
      await db.execAsync("PRAGMA foreign_keys = ON;").catch(() => {});
    }
  } catch (err) {
    console.warn("[syncAssignments] syncSubjectTeacherIds failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// MAIN SYNC
// ─────────────────────────────────────────────────────────────

let _syncInProgress    = false;
let _lastSyncAt        = 0;
const SYNC_THROTTLE_MS = 30_000;

export const syncTeacherAssignments = async (force = false) => {
  if (!force && Date.now() - _lastSyncAt < SYNC_THROTTLE_MS) {
    console.log("⏭️  syncTeacherAssignments: throttled");
    return { synced: 0, total: 0 };
  }
  if (_syncInProgress) {
    console.log("⏭️  syncTeacherAssignments: already running");
    return { synced: 0, total: 0 };
  }

  _syncInProgress = true;

  try {
    const { schoolId, role } = getUserInfo();

    const endpoint = getAssignmentsEndpoint(role);
    console.log(
      `🔄 syncTeacherAssignments: role="${role}" → endpoint="${endpoint}"`
    );

    // ── 1. Fetch ──────────────────────────────────────────
    let raw = [];
    try {
      const response = await api.get(endpoint, {
        params:  schoolId ? { schoolId } : undefined,
        timeout: 30_000,
      });
      raw =
        response.data?.assignments ||
        response.data?.data        ||
        (Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      console.warn("[syncAssignments] server fetch failed:", err.message);
      return { synced: 0, total: 0 };
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      console.log("[syncAssignments] server returned 0 rows");
      _lastSyncAt = Date.now();
      return { synced: 0, total: 0 };
    }

    console.log(`📋 Server has ${raw.length} assignments`);

    // ── 2. Normalise ──────────────────────────────────────
    const normalised = raw.map(normaliseRow).filter(Boolean);
    console.log(
      `[syncAssignments] ${normalised.length} valid rows (of ${raw.length} from server)`
    );

    // ── 3. Deduplicate server rows ────────────────────────
    const rows = deduplicateServerRows(normalised);

    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    // ── 4. Dedup FIRST (before unique index creation) ─────
    await deduplicateLocally(db);

    // ── 5. Ensure unique index ────────────────────────────
    await ensureUniqueIndex(db);

    // ── 6. Upsert ─────────────────────────────────────────
    const inserted = await upsertAssignmentRows(db, rows);

    // ── 7. Final dedup pass ───────────────────────────────
    await deduplicateLocally(db);

    // ── 8. Sync subjects.teacher_id ───────────────────────
    await syncSubjectTeacherIds(db);

    _lastSyncAt = Date.now();
    console.log(
      `✅ syncTeacherAssignments: ${inserted} upserted / ${rows.length} total`
    );

    return { synced: inserted, total: rows.length };
  } catch (err) {
    console.error("[syncAssignments] unexpected error:", err);
    return { synced: 0, total: 0 };
  } finally {
    _syncInProgress = false;
  }
};

// ─────────────────────────────────────────────────────────────
// SYNC AND GET COUNTS
// ─────────────────────────────────────────────────────────────

export const syncAndGetCounts = async (force = false) => {
  const result = await syncTeacherAssignments(force);

  try {
    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    const hasSubjects = await tableExists(db, "subjects");

    const [assigned, total] = await Promise.all([
      db.getFirstAsync(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT DISTINCT subjectId
          FROM   teacher_assignments
          WHERE  (deleted_at IS NULL OR deleted_at = '')
            AND  teacherId  IS NOT NULL AND teacherId  != ''
            AND  subjectId  IS NOT NULL AND subjectId  != ''
        )
      `),
      hasSubjects
        ? db.getFirstAsync(`
            SELECT COUNT(*) AS count
            FROM subjects
            WHERE (deleted_at IS NULL OR deleted_at = '')
          `)
        : Promise.resolve({ count: 0 }),
    ]);

    return {
      ...result,
      assignedSubjects: assigned?.count ?? 0,
      totalSubjects:    total?.count    ?? 0,
    };
  } catch (err) {
    console.warn(
      "[syncAssignments] syncAndGetCounts local count failed:", err.message
    );
    return { ...result, assignedSubjects: 0, totalSubjects: 0 };
  }
};