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

// ─────────────────────────────────────────────────────────────
// NORMALISE ROW
// ✅ Extracts name blobs for teacher / class / subject
//    from the server-populated nested objects
// ─────────────────────────────────────────────────────────────

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

  // ── Extract nested objects sent by the server ─────────────
  const teacherObj = raw.teacher && typeof raw.teacher === "object"
    ? raw.teacher : null;
  const classObj   = raw.class   && typeof raw.class   === "object"
    ? raw.class   : null;
  const subjectObj = raw.subject && typeof raw.subject === "object"
    ? raw.subject : null;

  // ── Build JSON blobs (null when no name available yet) ────
  const teacherJson = teacherObj
    ? JSON.stringify({
        _id:   teacherId,
        id:    teacherId,
        name:  teacherObj.name  || null,
        email: teacherObj.email || null,
        role:  teacherObj.role  || null,
      })
    : null;

  const classJson = classObj
    ? JSON.stringify({
        _id:     classId,
        id:      classId,
        name:    classObj.name    || null,
        level:   classObj.level   || null,
        section: classObj.section || null,
      })
    : null;

  const subjectJson = subjectObj
    ? JSON.stringify({
        _id:  subjectId,
        id:   subjectId,
        name: subjectObj.name || null,
        code: subjectObj.code || null,
      })
    : null;

  return {
    id:           String(id),
    teacherId:    String(teacherId),
    classId:      String(classId),
    subjectId:    String(subjectId),
    schoolId:     schoolId ? String(schoolId) : null,
    teacherJson,
    classJson,
    subjectJson,
    // ── Helpers used by upsert for local-DB name fallback ──
    _teacherName: teacherObj?.name  || null,
    _className:   classObj?.name    || null,
    _subjectName: subjectObj?.name  || null,
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
// RESOLVE JSON BLOBS FROM LOCAL DB
// Falls back to local classes / subjects / users tables when
// the server did not populate the nested objects.
// ─────────────────────────────────────────────────────────────

const resolveJsonBlobs = async (db, row) => {
  // ── teacher_json ──────────────────────────────────────────
  let teacherJson = row.teacherJson;

  if (!row._teacherName && row.teacherId) {
    try {
      const u = await db
        .getFirstAsync(
          "SELECT name, email FROM users WHERE id = ? LIMIT 1",
          [row.teacherId]
        )
        .catch(() => null);

      if (u?.name) {
        teacherJson = JSON.stringify({
          _id:   row.teacherId,
          id:    row.teacherId,
          name:  u.name,
          email: u.email || null,
        });
      }
    } catch { /* non-fatal */ }
  }

  // ── class_json ────────────────────────────────────────────
  let classJson = row.classJson;

  if (!row._className && row.classId) {
    try {
      const c = await db
        .getFirstAsync(
          "SELECT name, level, section FROM classes WHERE id = ? LIMIT 1",
          [row.classId]
        )
        .catch(() => null);

      if (c?.name) {
        classJson = JSON.stringify({
          _id:     row.classId,
          id:      row.classId,
          name:    c.name,
          level:   c.level   || null,
          section: c.section || null,
        });
      }
    } catch { /* non-fatal */ }
  }

  // ── subject_json ──────────────────────────────────────────
  let subjectJson = row.subjectJson;

  if (!row._subjectName && row.subjectId) {
    try {
      const s = await db
        .getFirstAsync(
          "SELECT name, code FROM subjects WHERE id = ? LIMIT 1",
          [row.subjectId]
        )
        .catch(() => null);

      if (s?.name) {
        subjectJson = JSON.stringify({
          _id:  row.subjectId,
          id:   row.subjectId,
          name: s.name,
          code: s.code || null,
        });
      }
    } catch { /* non-fatal */ }
  }

  return { teacherJson, classJson, subjectJson };
};

// ─────────────────────────────────────────────────────────────
// UPSERT
// ✅ Persists teacher_json / class_json / subject_json
//    Uses CASE guards so a null-named blob never overwrites
//    a previously stored name.
// ─────────────────────────────────────────────────────────────

const upsertAssignmentRows = async (db, rows) => {
  if (!rows.length) return 0;

  const now    = new Date().toISOString();
  let inserted = 0;

  // ── Ensure JSON columns exist ─────────────────────────────
  const cols    = await db.getAllAsync("PRAGMA table_info(teacher_assignments)");
  const colNames = new Set(cols.map((c) => c.name));

  const requiredCols = [
    "teacher_json",
    "class_json",
    "subject_json",
    "teacher_id",
    "class_id",
    "subject_id",
  ];

  for (const col of requiredCols) {
    if (!colNames.has(col)) {
      await db
        .execAsync(`ALTER TABLE teacher_assignments ADD COLUMN ${col} TEXT`)
        .catch(() => {});
    }
  }

  try {
    await db.execAsync("PRAGMA foreign_keys = OFF;");

    for (const row of rows) {
      try {
        // ── Resolve blobs (server obj → local DB fallback) ──
        const { teacherJson, classJson, subjectJson } =
          await resolveJsonBlobs(db, row);

        // ── Check for existing row ───────────────────────────
        const existing = await db.getFirstAsync(
          `SELECT id, teacher_json, class_json, subject_json
           FROM   teacher_assignments
           WHERE  teacherId = ? AND classId = ? AND subjectId = ?
           LIMIT  1`,
          [row.teacherId, row.classId, row.subjectId]
        ).catch(() => null);

        if (existing) {
          // ── Preserve stored name when new blob has no name ─
          const resolvedTeacherJson =
            teacherJson && JSON.parse(teacherJson)?.name != null
              ? teacherJson
              : existing.teacher_json ?? teacherJson;

          const resolvedClassJson =
            classJson && JSON.parse(classJson)?.name != null
              ? classJson
              : existing.class_json ?? classJson;

          const resolvedSubjectJson =
            subjectJson && JSON.parse(subjectJson)?.name != null
              ? subjectJson
              : existing.subject_json ?? subjectJson;

          const result = await db.runAsync(
            `UPDATE teacher_assignments
             SET id           = ?,
                 teacher_id   = ?,
                 class_id     = ?,
                 subject_id   = ?,
                 schoolId     = COALESCE(?, schoolId),
                 school_id    = COALESCE(?, school_id),
                 teacher_json = ?,
                 class_json   = ?,
                 subject_json = ?,
                 deleted_at   = NULL,
                 _synced      = 1,
                 _synced_at   = ?,
                 updated_at   = ?
             WHERE teacherId = ? AND classId = ? AND subjectId = ?`,
            [
              row.id,
              row.teacherId,
              row.classId,
              row.subjectId,
              row.schoolId,
              row.schoolId,
              resolvedTeacherJson,
              resolvedClassJson,
              resolvedSubjectJson,
              now,
              now,
              row.teacherId,
              row.classId,
              row.subjectId,
            ]
          );
          if (result?.changes > 0) inserted++;

        } else {
          // ── Fresh insert ─────────────────────────────────────
          const result = await db.runAsync(
            `INSERT INTO teacher_assignments
               (id, teacherId, teacher_id, classId, class_id,
                subjectId, subject_id, schoolId, school_id,
                teacher_json, class_json, subject_json,
                deleted_at, _synced, _synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
            [
              row.id,
              row.teacherId, row.teacherId,
              row.classId,   row.classId,
              row.subjectId, row.subjectId,
              row.schoolId,  row.schoolId,
              teacherJson,
              classJson,
              subjectJson,
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
      console.log(
        `[syncAssignments] removed ${ghostResult.changes} ghost rows`
      );
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
// BACKFILL MISSING JSON NAMES
// ✅ After upsert, any rows still missing teacher / class /
//    subject names are filled from the local SQLite tables.
// ─────────────────────────────────────────────────────────────

const backfillMissingJsonNames = async (db) => {
  const now = new Date().toISOString();

  // ── teacher_json ──────────────────────────────────────────
  try {
    const missing = await db.getAllAsync(
      `SELECT id, teacherId
       FROM   teacher_assignments
       WHERE  (deleted_at IS NULL OR deleted_at = '')
         AND  (
           teacher_json IS NULL
           OR json_extract(teacher_json, '$.name') IS NULL
         )
         AND  teacherId IS NOT NULL AND teacherId != ''`
    ).catch(() => []);

    if (missing.length) {
      console.log(
        `[syncAssignments] Backfilling ${missing.length} teacher_json name(s)…`
      );
      let fixed = 0;
      for (const row of missing) {
        const u = await db
          .getFirstAsync(
            "SELECT name, email FROM users WHERE id = ? LIMIT 1",
            [row.teacherId]
          )
          .catch(() => null);
        if (!u?.name) continue;

        await db.runAsync(
          `UPDATE teacher_assignments
           SET teacher_json = ?, updated_at = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              _id:   row.teacherId,
              id:    row.teacherId,
              name:  u.name,
              email: u.email || null,
            }),
            now,
            row.id,
          ]
        ).catch(() => {});
        fixed++;
      }
      if (fixed > 0) {
        console.log(
          `[syncAssignments] ✅ teacher_json backfill complete (${fixed} fixed)`
        );
      }
    }
  } catch (err) {
    console.warn("[syncAssignments] backfill teacher_json failed:", err.message);
  }

  // ── class_json ────────────────────────────────────────────
  try {
    const missing = await db.getAllAsync(
      `SELECT id, classId
       FROM   teacher_assignments
       WHERE  (deleted_at IS NULL OR deleted_at = '')
         AND  (
           class_json IS NULL
           OR json_extract(class_json, '$.name') IS NULL
         )
         AND  classId IS NOT NULL AND classId != ''`
    ).catch(() => []);

    if (missing.length) {
      console.log(
        `[syncAssignments] Backfilling ${missing.length} class_json name(s)…`
      );
      let fixed = 0;
      for (const row of missing) {
        const c = await db
          .getFirstAsync(
            "SELECT name, level, section FROM classes WHERE id = ? LIMIT 1",
            [row.classId]
          )
          .catch(() => null);
        if (!c?.name) continue;

        await db.runAsync(
          `UPDATE teacher_assignments
           SET class_json = ?, updated_at = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              _id:     row.classId,
              id:      row.classId,
              name:    c.name,
              level:   c.level   || null,
              section: c.section || null,
            }),
            now,
            row.id,
          ]
        ).catch(() => {});
        fixed++;
      }
      if (fixed > 0) {
        console.log(
          `[syncAssignments] ✅ class_json backfill complete (${fixed} fixed)`
        );
      }
    }
  } catch (err) {
    console.warn("[syncAssignments] backfill class_json failed:", err.message);
  }

  // ── subject_json ──────────────────────────────────────────
  try {
    const missing = await db.getAllAsync(
      `SELECT id, subjectId
       FROM   teacher_assignments
       WHERE  (deleted_at IS NULL OR deleted_at = '')
         AND  (
           subject_json IS NULL
           OR json_extract(subject_json, '$.name') IS NULL
         )
         AND  subjectId IS NOT NULL AND subjectId != ''`
    ).catch(() => []);

    if (missing.length) {
      console.log(
        `[syncAssignments] Backfilling ${missing.length} subject_json name(s)…`
      );
      let fixed = 0;
      for (const row of missing) {
        const s = await db
          .getFirstAsync(
            "SELECT name, code FROM subjects WHERE id = ? LIMIT 1",
            [row.subjectId]
          )
          .catch(() => null);
        if (!s?.name) continue;

        await db.runAsync(
          `UPDATE teacher_assignments
           SET subject_json = ?, updated_at = ?
           WHERE id = ?`,
          [
            JSON.stringify({
              _id:  row.subjectId,
              id:   row.subjectId,
              name: s.name,
              code: s.code || null,
            }),
            now,
            row.id,
          ]
        ).catch(() => {});
        fixed++;
      }
      if (fixed > 0) {
        console.log(
          `[syncAssignments] ✅ subject_json backfill complete (${fixed} fixed)`
        );
      }
    }
  } catch (err) {
    console.warn(
      "[syncAssignments] backfill subject_json failed:", err.message
    );
  }
};

// ─────────────────────────────────────────────────────────────
// MAIN SYNC
// ─────────────────────────────────────────────────────────────

let _lastSyncAt        = 0;
const SYNC_THROTTLE_MS = 30_000;

// The private worker. Both gates that used to live here — the throttle and
// a boolean in-progress flag — now sit in the exported wrapper below, which
// holds the in-flight promise itself. One place decides whether a request
// happens, and a second caller gets the first caller's result rather than
// an empty one.
const runSyncTeacherAssignments = async () => {
  try {
    const { schoolId, role } = getUserInfo();

    const endpoint = getAssignmentsEndpoint(role);
    console.log(
      `🔄 syncTeacherAssignments: role="${role}" → endpoint="${endpoint}"`
    );

    // ── 1. Fetch from server ──────────────────────────────
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

    // ── 2. Normalise (extract IDs + server-populated blobs) ──
    const normalised = raw.map(normaliseRow).filter(Boolean);
    console.log(
      `[syncAssignments] ${normalised.length} valid rows (of ${raw.length} from server)`
    );

    // ── 3. Deduplicate server rows ────────────────────────
    const rows = deduplicateServerRows(normalised);

    const db = await getDatabase();
    await ensureAssignmentSchema(db);

    // ── 4. Dedup local DB BEFORE unique index creation ────
    await deduplicateLocally(db);

    // ── 5. Ensure unique index ────────────────────────────
    await ensureUniqueIndex(db);

    // ── 6. Upsert (resolves local-DB names inside) ────────
    const inserted = await upsertAssignmentRows(db, rows);

    // ── 7. Final local dedup pass ─────────────────────────
    await deduplicateLocally(db);

    // ── 8. Backfill any still-missing JSON names ──────────
    //    (runs for all three: teacher / class / subject)
    await backfillMissingJsonNames(db);

    // ── 9. Sync subjects.teacher_id foreign key ───────────
    await syncSubjectTeacherIds(db);

    _lastSyncAt = Date.now();
    console.log(
      `✅ syncTeacherAssignments: ${inserted} upserted / ${rows.length} total`
    );

    return { synced: inserted, total: rows.length };
  } catch (err) {
    console.error("[syncAssignments] unexpected error:", err);
    return { synced: 0, total: 0 };
  }
};

let _inFlight = null;

/**
 * One request, however many callers.
 *
 * The admin dashboard and the admin-stats service both ask for assignments
 * the moment that screen mounts, and both pass force — which skips the
 * throttle by design, so a pull-to-refresh is never swallowed. The result
 * was the same GET going out three or four times per launch. On a LAN that
 * was invisible; over a WAN it is several real round trips for one answer.
 *
 * Callers now share the request already in flight and get its result,
 * rather than the empty { synced: 0 } the in-progress guard used to hand
 * back — which read as "no assignments" to whoever asked second.
 */
export const syncTeacherAssignments = async (force = false) => {
  // The throttle is checked before anything is shared. Checked afterwards,
  // a throttled background call would be the promise a pull-to-refresh
  // adopted, and the refresh would report "0 synced" without ever asking
  // the server.
  if (!force && Date.now() - _lastSyncAt < SYNC_THROTTLE_MS) {
    console.log("⏭️  syncTeacherAssignments: throttled");
    return { synced: 0, total: 0 };
  }

  if (_inFlight) return _inFlight;

  _inFlight = runSyncTeacherAssignments().finally(() => {
    _inFlight = null;
  });

  return _inFlight;
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