// src/services/student.service.js

import { getDatabase } from "../db/database";
import api from "./api";
import SyncOverwriteService from "./sync-overwrite.service";
import {
  MutationQueue, outboxRowsForTable, localIdsOf, registerReconciler, registerFailureHandler,
} from "./mutationQueue.service";
import { ensureStudentColumns } from "./studentEnroll.service";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const getSchoolId = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    return useAuthStore.getState()?.user?.schoolId || null;
  } catch {
    return null;
  }
};

const tableExists = async (db, name) => {
  try {
    const result = await db.getFirstAsync(
      `SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [name]
    );
    return (result?.count ?? 0) > 0;
  } catch {
    return false;
  }
};

const getColumns = async (db, tableName) => {
  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(${tableName})`);
    return cols.map((c) => c.name);
  } catch {
    return [];
  }
};

const pickColumn = (columns, candidates) => {
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  return null;
};

const safeAddColumn = async (db, table, col, def) => {
  try {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${def};`);
  } catch (err) {
    if (!err.message?.includes("duplicate column")) {
      console.warn(`safeAddColumn ${col} on ${table}:`, err.message);
    }
  }
};

// ─────────────────────────────────────────────────────────────
// PLACEHOLDER DETECTION
// ─────────────────────────────────────────────────────────────

const PLACEHOLDER_NAMES = new Set([
  "student", "unknown", "unknown student", "n/a", "na", "-", "",
]);

const isPlaceholder = (name) =>
  !name || PLACEHOLDER_NAMES.has(name.trim().toLowerCase());

// ─────────────────────────────────────────────────────────────
// COMPOSE NAME
// ─────────────────────────────────────────────────────────────

const composeName = (r) => {
  if (!r) return null;

  const fromParts = [
    r.firstName || r.first_name,
    r.lastName  || r.last_name,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (fromParts && !isPlaceholder(fromParts)) return fromParts;

  const candidates = [
    r.studentName,
    r.name,
    r.full_name,
    r.fullName,
    r.student_name,
  ];

  for (const c of candidates) {
    const v = c?.trim();
    if (v && !isPlaceholder(v)) return v;
  }

  return null;
};

// ─────────────────────────────────────────────────────────────
// CHECK FOR UNIQUE user_id CONSTRAINT IN TABLE SCHEMA
// ─────────────────────────────────────────────────────────────

const hasUniqueUserIdConstraint = async (db) => {
  try {
    const result = await db.getFirstAsync(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'students'`,
      []
    );
    if (!result?.sql) return false;

    const sql = result.sql.toUpperCase();
    const hasInlineUnique = /USER_ID\s+\w+[^,)]*\bUNIQUE\b/.test(sql);
    const hasTableUnique =
      /UNIQUE\s*\(\s*[`"']?USER_ID[`"']?\s*\)/.test(sql);

    return hasInlineUnique || hasTableUnique;
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────
// VALID STATUS VALUES
// ─────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set([
  "approved",
  "pending",
  "suspended",
  "rejected",
]);

const normaliseStatus = (raw) => {
  const s = (raw ?? "").toString().toLowerCase().trim();
  return VALID_STATUSES.has(s) ? s : "approved";
};

// ─────────────────────────────────────────────────────────────
// FIX STUDENT INDEXES
// ─────────────────────────────────────────────────────────────

export const fixStudentIndexes = async () => {
  try {
    const db = await getDatabase();

    const needsRebuild = await hasUniqueUserIdConstraint(db);

    if (needsRebuild) {
      console.warn(
        "[fixStudentIndexes] ⚠️ UNIQUE constraint on user_id found — triggering full rebuild"
      );
      const result = await dropAndRecreateStudentTable();
      if (!result.success) {
        console.error("[fixStudentIndexes] Table rebuild failed:", result.error);
      }
      return;
    }

    const indexes = await db
      .getAllAsync(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'students'`,
        []
      )
      .catch(() => []);

    console.log(
      "[fixStudentIndexes] existing indexes:",
      indexes.map((i) => i.name).join(", ")
    );

    const toDrop = [
      "idx_students_user_id",
      "idx_students_user_id_nonuniq",
    ];

    for (const idx of toDrop) {
      await db.execAsync(`DROP INDEX IF EXISTS ${idx};`).catch(() => {});
    }

    await db
      .execAsync(`
        CREATE INDEX IF NOT EXISTS idx_students_user_id_nonuniq
          ON students(user_id);
        CREATE INDEX IF NOT EXISTS idx_students_class_id
          ON students(class_id);
        CREATE INDEX IF NOT EXISTS idx_students_classId
          ON students(classId);
        CREATE INDEX IF NOT EXISTS idx_students_school
          ON students(schoolId);
        CREATE INDEX IF NOT EXISTS idx_students_status
          ON students(status);
        CREATE INDEX IF NOT EXISTS idx_students_active
          ON students(is_active);
        CREATE INDEX IF NOT EXISTS idx_students_email
          ON students(email);
        CREATE INDEX IF NOT EXISTS idx_students_admission
          ON students(admissionNo);
        CREATE INDEX IF NOT EXISTS idx_students_admissionN
          ON students(admissionNumber);
        CREATE INDEX IF NOT EXISTS idx_students_studentName
          ON students(studentName);
      `)
      .catch(() => {});

    console.log("[fixStudentIndexes] ✅ indexes fixed");
  } catch (err) {
    console.warn("[fixStudentIndexes] failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// DROP AND RECREATE STUDENT TABLE
// ─────────────────────────────────────────────────────────────

export const dropAndRecreateStudentTable = async () => {
  const db = await getDatabase();
  console.log("[dropAndRecreateStudentTable] Starting table recreation...");

  try {
    let backupData = [];
    let rowCount   = 0;
    const hasTable = await tableExists(db, "students");

    if (hasTable) {
      // Counted separately, and this is the point of the whole guard below.
      rowCount = await db
        .getFirstAsync(`SELECT COUNT(*) AS n FROM students`)
        .then((r) => Number(r?.n ?? 0))
        .catch(() => -1);

      backupData = await db
        .getAllAsync(`SELECT * FROM students`)
        .catch((err) => {
          console.warn(
            "[dropAndRecreateStudentTable] Backup read failed:",
            err?.message
          );
          return [];
        });

      console.log(
        `[dropAndRecreateStudentTable] Backed up ${backupData.length} of ${rowCount} row(s)`
      );
    }

    // ── The drop does not happen on a backup nobody checked ─────────────────
    //
    // The backup was a SELECT with .catch(() => []) inside a try that only
    // warned, and then the DROP ran regardless. So the one situation this
    // function exists for — a students table too broken to read — was also
    // the situation in which it silently emptied the table and reported
    // success.
    //
    // That is not only a cache: approve, reject, suspend and class-move all
    // write `_synced = 0` onto the row here and rely on the sweeper to push
    // it. Those edits live in this table and nowhere else, so a pupil
    // approved on a phone with no signal would simply never have been
    // approved, and nothing would say so.
    //
    // Refusing leaves the table exactly as it was: still broken, still
    // reporting the UNIQUE error that got us here, and now saying why.
    if (hasTable && rowCount !== 0 && backupData.length === 0) {
      console.error(
        "[dropAndRecreateStudentTable] ABORTED — the table holds " +
        `${rowCount === -1 ? "an unknown number of" : rowCount} row(s) and none ` +
        "could be read. Dropping now would destroy any offline approval or " +
        "class move that has not reached the server."
      );
      return {
        success: false,
        aborted: true,
        reason:  "backup-unreadable",
        rowCount,
      };
    }

    await db.execAsync(`DROP TABLE IF EXISTS students;`).catch(() => {});
    console.log("[dropAndRecreateStudentTable] ✅ Old table dropped");

    studentSchemaVerified = false;

    await ensureStudentSchema(db);
    console.log("[dropAndRecreateStudentTable] ✅ Schema recreated");

    let restored = 0;
    let failed   = 0;

    if (backupData.length > 0) {
      await db.execAsync("PRAGMA foreign_keys = OFF;");

      for (const row of backupData) {
        try {
          await db.runAsync(
            `INSERT INTO students (
               id, user_id, schoolId,
               class_id, classId, class_name,
               name, studentName, firstName, lastName,
               gender, guardian_name, guardian_phone,
               phone, email, grade,
               admissionNo, admissionNumber,
               status, is_active, _synced, updated_at, created_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.id,
              row.user_id,
              row.schoolId,
              row.class_id,
              row.classId,
              row.class_name,
              row.name,
              row.studentName,
              row.firstName,
              row.lastName,
              row.gender,
              row.guardian_name,
              row.guardian_phone,
              row.phone,
              row.email,
              row.grade,
              row.admissionNo,
              row.admissionNumber,
              normaliseStatus(row.status),
              row.is_active ?? 1,
              0,
              row.updated_at,
              row.created_at,
            ]
          );
          restored++;
        } catch (restoreErr) {
          failed++;
          if (!restoreErr.message?.includes("UNIQUE constraint")) {
            console.warn(
              `[dropAndRecreateStudentTable] Row ${row.id} failed:`,
              restoreErr.message
            );
          }
        }
      }

      await db.execAsync("PRAGMA foreign_keys = ON;").catch(() => {});

      console.log(
        `[dropAndRecreateStudentTable] ✅ Restored ${restored}/${backupData.length} rows (${failed} skipped)`
      );
    }

    console.log(
      "[dropAndRecreateStudentTable] ✅ Complete — table is clean"
    );
    // restored, not backupData.length. Rows that failed to come back were
    // being counted as restored, so the one number a caller could check said
    // the rebuild was clean whatever had actually happened to the data.
    return { success: true, restored, failed, backedUp: backupData.length };
  } catch (err) {
    console.error("[dropAndRecreateStudentTable] failed:", err.message);
    return { success: false, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────

let studentSchemaVerified = false;

const ensureStudentSchema = async (db) => {
  if (studentSchemaVerified) return;

  try {
    const exists = await tableExists(db, "students");
    if (exists) {
      const needsRebuild = await hasUniqueUserIdConstraint(db);
      if (needsRebuild) {
        console.warn(
          "[ensureStudentSchema] UNIQUE user_id detected — rebuilding table"
        );
        studentSchemaVerified = false;
        await dropAndRecreateStudentTable();
        return;
      }
    }

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS students (
        id              TEXT PRIMARY KEY NOT NULL,
        user_id         TEXT,
        schoolId        TEXT,
        class_id        TEXT,
        classId         TEXT,
        class_name      TEXT,
        name            TEXT,
        studentName     TEXT,
        firstName       TEXT,
        lastName        TEXT,
        gender          TEXT,
        guardian_name   TEXT,
        guardian_phone  TEXT,
        phone           TEXT,
        email           TEXT,
        grade           TEXT,
        admissionNo     TEXT,
        admissionNumber TEXT,
        status          TEXT DEFAULT 'approved',
        is_active       INTEGER DEFAULT 1,
        deleted_at      TEXT,
        _synced         INTEGER DEFAULT 0,
        created_at      TEXT DEFAULT NULL,
        updated_at      TEXT
      );
    `);

    const existingCols = await getColumns(db, "students");

    const toAdd = [
      { name: "user_id",         def: "TEXT" },
      { name: "schoolId",        def: "TEXT" },
      { name: "class_id",        def: "TEXT" },
      { name: "classId",         def: "TEXT" },
      { name: "class_name",      def: "TEXT" },
      { name: "name",            def: "TEXT" },
      { name: "studentName",     def: "TEXT" },
      { name: "firstName",       def: "TEXT" },
      { name: "lastName",        def: "TEXT" },
      { name: "gender",          def: "TEXT" },
      { name: "guardian_name",   def: "TEXT" },
      { name: "guardian_phone",  def: "TEXT" },
      { name: "phone",           def: "TEXT" },
      { name: "email",           def: "TEXT" },
      { name: "grade",           def: "TEXT" },
      { name: "admissionNo",     def: "TEXT" },
      { name: "admissionNumber", def: "TEXT" },
      { name: "status",          def: "TEXT DEFAULT 'approved'" },
      { name: "is_active",       def: "INTEGER DEFAULT 1" },
      { name: "deleted_at",      def: "TEXT" },
      { name: "_synced",         def: "INTEGER DEFAULT 0" },
      { name: "created_at",      def: "TEXT DEFAULT NULL" },
      { name: "updated_at",      def: "TEXT" },
    ];

    for (const col of toAdd) {
      if (!existingCols.includes(col.name)) {
        await safeAddColumn(db, "students", col.name, col.def);
      }
    }

    await db
      .execAsync(`DROP INDEX IF EXISTS idx_students_user_id;`)
      .catch(() => {});

    await db
      .execAsync(`
        CREATE INDEX IF NOT EXISTS idx_students_user_id_nonuniq
          ON students(user_id);
        CREATE INDEX IF NOT EXISTS idx_students_class_id
          ON students(class_id);
        CREATE INDEX IF NOT EXISTS idx_students_classId
          ON students(classId);
        CREATE INDEX IF NOT EXISTS idx_students_school
          ON students(schoolId);
        CREATE INDEX IF NOT EXISTS idx_students_status
          ON students(status);
        CREATE INDEX IF NOT EXISTS idx_students_active
          ON students(is_active);
        CREATE INDEX IF NOT EXISTS idx_students_email
          ON students(email);
        CREATE INDEX IF NOT EXISTS idx_students_admission
          ON students(admissionNo);
        CREATE INDEX IF NOT EXISTS idx_students_admissionN
          ON students(admissionNumber);
        CREATE INDEX IF NOT EXISTS idx_students_studentName
          ON students(studentName);
      `)
      .catch(() => {});

    studentSchemaVerified = true;
  } catch (err) {
    console.warn("ensureStudentSchema failed:", err.message);
  }
};

// ─────────────────────────────────────────────────────────────
// NORMALISE
// ─────────────────────────────────────────────────────────────

const normaliseStudent = (r) => {
  if (!r) return null;

  const id = r._id || r.id;
  if (!id) return null;

  const classId =
    (typeof r.class === "string" ? r.class : null) ||
    r.class?._id    ||
    r.class?.id     ||
    r.classId       ||
    r.class_id      ||
    null;

  const className =
    r.className        ||
    r.class?.name      ||
    r._joinedClassName ||
    r.class_name       ||
    null;

  const name = composeName(r);

  const userId =
    r.userId                                     ||
    r.user_id                                    ||
    (typeof r.user === "string" ? r.user : null) ||
    r.user?._id                                  ||
    r.user?.id                                   ||
    null;

  // Same chain as the writer, for the same reason: this normalises rows that
  // came straight from the API as well as rows read back out of SQLite.
  const admissionNo =
    r.enrollmentNo     ||
    r.enrollment_no    ||
    r.admissionNo      ||
    r.admissionNumber  ||
    r.admission_no     ||
    r.admission_number ||
    r.admNo            ||
    r.rollNo           ||
    null;

  return {
    id,
    userId,
    name,
    studentName:   r.studentName || name,
    firstName:     r.firstName   || r.first_name  || null,
    lastName:      r.lastName    || r.last_name   || null,
    gender:        r.gender      || null,
    guardianName:  r.guardianName  || r.guardian_name  || r.parent_name  || null,
    guardianPhone: r.guardianPhone || r.guardian_phone || r.parent_phone || null,
    phone:         r.phone         || null,
    email:         r.email         || r.guardian_email || null,
    grade:         r.grade         || r.class_grade    || r.className    || null,
    admissionNo,
    admissionNumber: admissionNo,
    // Under the server's name too. Screens written against the API — the fee
    // screen reads student?.enrollmentNo — were asking for a field this
    // normaliser has never produced, and got undefined every time.
    enrollmentNo:    admissionNo,
    isActive:      r.isActive      ?? r.is_active      ?? true,
    schoolId:      r.schoolId      || null,
    classId,
    className,
    class:         className ? { name: className, _id: classId } : null,
    studentId:     r.studentId     || null,
    status:        normaliseStatus(r.status),
    notes:         r.notes         || null,
    updatedAt:     r.updatedAt     || r.updated_at || null,
    createdAt:     r.createdAt     || r.created_at || null,
  };
};

// ─────────────────────────────────────────────────────────────
// ACTIVE CHECK (used only by legacy getApprovedStudents)
// ─────────────────────────────────────────────────────────────

const isApproved = (r) => {
  if (r.status === "suspended") return false;
  if (r.status === "rejected")  return false;
  if (r.status === "pending")   return false;

  if (r.isActive  !== undefined) return r.isActive  !== false;
  if (r.is_active !== undefined) return r.is_active === 1 || r.is_active === true;

  return true;
};

// ─────────────────────────────────────────────────────────────
// CACHE WRITE
// ─────────────────────────────────────────────────────────────

const cacheStudentsLocally = async (
  db,
  students,
  schoolId,
  forceApproved = false
) => {
  if (!students?.length) return;

  await ensureStudentSchema(db);

  const now    = new Date().toISOString();
  let   cached = 0;
  let   failed = 0;

  // A pupil with a change still in the outbox (made offline, or refused and
  // waiting on the pending-changes screen) keeps the phone's copy: this list
  // may have left the server before the change was made, and writing it over
  // the row would undo the change on screen. The change goes first; the next
  // fetch after it refreshes the row.
  const busy = new Set();
  for (const r of await outboxRowsForTable("students").catch(() => [])) {
    for (const id of localIdsOf(r.payload?.__local)) busy.add(String(id));
  }

  try {
    await db.execAsync("PRAGMA foreign_keys = OFF;");

    for (const s of students) {
      if (!s.id) continue;
      if (busy.has(String(s.id))) continue;

      const fromParts = [s.firstName, s.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();

      const rawName =
        fromParts     ||
        s.name        ||
        s.studentName ||
        null;

      let finalName =
        rawName && !isPlaceholder(rawName) ? rawName : null;

      if (!finalName) {
        const userId =
          s.userId    ||
          s.user_id   ||
          (typeof s.user === "string" ? s.user : null) ||
          s.user?._id ||
          s.user?.id  ||
          null;

        if (userId) {
          const userRow = await db
            .getFirstAsync(
              `SELECT name FROM users WHERE id = ? LIMIT 1`,
              [userId]
            )
            .catch(() => null);
          const uName = userRow?.name?.trim();
          if (uName && !isPlaceholder(uName)) finalName = uName;
        }
      }

      const userId =
        s.userId    ||
        s.user_id   ||
        (typeof s.user === "string" ? s.user : null) ||
        s.user?._id ||
        s.user?.id  ||
        null;

      const resolvedClassId =
        s.classId    ||
        s.class_id   ||
        (typeof s.class === "string" ? s.class : null) ||
        s.class?._id ||
        s.class?.id  ||
        null;

      /*
       * The server calls it enrollmentNo, and this chain never looked.
       *
       * Six aliases for "admission number" and not one of them the name the
       * API actually sends, so every student synced to this phone stored NULL
       * — and every screen showing or searching by admission number showed
       * and matched nothing. The fee screen's header printed "—" where a
       * bursar looks to confirm they have the right pupil before taking
       * money.
       *
       * enrollmentNo first, which is the same precedence the backend itself
       * uses: results.controller reads `s.enrollmentNo || s.admissionNo`, the
       * legacy field being the fallback rather than the other way round.
       */
      const admNo =
        s.enrollmentNo     ||
        s.enrollment_no    ||
        s.admissionNo      ||
        s.admissionNumber  ||
        s.admission_no     ||
        s.admission_number ||
        s.admNo            ||
        null;

      const statusToWrite = forceApproved
        ? "approved"
        : normaliseStatus(s.status);

      const isActiveToWrite =
        forceApproved || statusToWrite === "approved" ? 1 : 0;

      try {
        await db.runAsync(
          `INSERT INTO students (
             id, user_id, schoolId,
             class_id, classId, class_name,
             name, studentName, firstName, lastName,
             gender, guardian_name, guardian_phone,
             phone, email, grade,
             admissionNo, admissionNumber,
             status, is_active, _synced, updated_at
           )
           VALUES (
             ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?,
             ?, ?,
             ?, ?, 1, ?
           )
           ON CONFLICT(id) DO UPDATE SET
             user_id         = excluded.user_id,
             schoolId        = excluded.schoolId,
             class_id        = excluded.class_id,
             classId         = excluded.classId,
             class_name      = excluded.class_name,
             name            = excluded.name,
             studentName     = excluded.studentName,
             firstName       = excluded.firstName,
             lastName        = excluded.lastName,
             gender          = excluded.gender,
             guardian_name   = excluded.guardian_name,
             guardian_phone  = excluded.guardian_phone,
             phone           = excluded.phone,
             email           = excluded.email,
             grade           = excluded.grade,
             admissionNo     = excluded.admissionNo,
             admissionNumber = excluded.admissionNumber,
             status          = excluded.status,
             is_active       = excluded.is_active,
             _synced         = 1,
             updated_at      = excluded.updated_at`,
          [
            String(s.id),
            userId,
            s.schoolId      || schoolId || null,
            resolvedClassId,
            resolvedClassId,
            s.className     || null,
            finalName,
            s.studentName   || finalName || null,
            s.firstName     || null,
            s.lastName      || null,
            s.gender        || null,
            s.guardianName  || null,
            s.guardianPhone || null,
            s.phone         || null,
            s.email         || null,
            s.grade         || s.className || null,
            admNo,
            admNo,
            statusToWrite,
            isActiveToWrite,
            // The server's version stamp, not the time of caching: an offline
            // change is sent with it as baseUpdatedAt.
            s.updatedAt     || now,
          ]
        );
        cached++;
      } catch (err) {
        failed++;
        console.warn(`⚠️  Cache student ${s.id} failed:`, err.message);
      }
    }
  } finally {
    await db.execAsync("PRAGMA foreign_keys = ON;").catch(() => {});
  }

  if (cached > 0) console.log(`💾 Cached ${cached} student(s) locally`);
  if (failed > 0) console.warn(`⚠️  ${failed} student(s) failed to cache`);
};

// ─────────────────────────────────────────────────────────────
// ONE-TIME REPAIR
// ─────────────────────────────────────────────────────────────

export const repairStudentNames = async () => {
  const db = await getDatabase();
  console.log("[repairStudentNames] starting…");

  const cols           = await getColumns(db, "students");
  const hasFirst       = cols.includes("firstName") || cols.includes("first_name");
  const hasLast        = cols.includes("lastName")  || cols.includes("last_name");
  const hasStudentName = cols.includes("studentName");

  let totalFixed = 0;

  if (hasStudentName) {
    const fromStudentName = await db
      .getAllAsync(
        `SELECT id, studentName
         FROM   students
         WHERE  studentName IS NOT NULL
           AND  studentName != ''
           AND  (
             name IS NULL OR name = '' OR
             LOWER(TRIM(name)) IN ('student','unknown','unknown student','n/a','na','-')
           )`,
        []
      )
      .catch(() => []);

    console.log(
      `[repairStudentNames] ${fromStudentName.length} rows need studentName repair`
    );

    for (const row of fromStudentName) {
      if (row.studentName && !isPlaceholder(row.studentName)) {
        await db.runAsync(
          `UPDATE students SET name = ? WHERE id = ?`,
          [row.studentName.trim(), row.id]
        );
        totalFixed++;
      }
    }
  }

  if (hasFirst && hasLast) {
    const firstCol = cols.includes("firstName") ? "firstName" : "first_name";
    const lastCol  = cols.includes("lastName")  ? "lastName"  : "last_name";

    const broken = await db
      .getAllAsync(
        `SELECT id, ${firstCol} AS fn, ${lastCol} AS ln, name
         FROM   students
         WHERE  (
           name IS NULL OR name = '' OR
           LOWER(TRIM(name)) IN ('student','unknown','unknown student','n/a','na','-')
         )
           AND  (${firstCol} IS NOT NULL OR ${lastCol} IS NOT NULL)`,
        []
      )
      .catch(() => []);

    console.log(
      `[repairStudentNames] ${broken.length} rows need parts-based repair`
    );

    for (const row of broken) {
      const composed = [row.fn, row.ln].filter(Boolean).join(" ").trim();
      if (composed && !isPlaceholder(composed)) {
        await db.runAsync(
          `UPDATE students SET name = ? WHERE id = ?`,
          [composed, row.id]
        );
        totalFixed++;
      }
    }
  }

  const stillBroken = await db
    .getAllAsync(
      `SELECT s.id, s.user_id, s.name
       FROM   students s
       WHERE  s.user_id IS NOT NULL
         AND  (
           s.name IS NULL OR s.name = '' OR
           LOWER(TRIM(s.name)) IN ('student','unknown','unknown student','n/a','na','-')
         )`,
      []
    )
    .catch(() => []);

  console.log(
    `[repairStudentNames] ${stillBroken.length} rows need users-table repair`
  );

  for (const row of stillBroken) {
    const userRow = await db
      .getFirstAsync(
        `SELECT name FROM users WHERE id = ? LIMIT 1`,
        [row.user_id]
      )
      .catch(() => null);

    const realName = userRow?.name?.trim();
    if (realName && !isPlaceholder(realName)) {
      await db.runAsync(
        `UPDATE students SET name = ? WHERE id = ?`,
        [realName, row.id]
      );
      totalFixed++;
    }
  }

  if (cols.includes("class_id") && cols.includes("classId")) {
    await db
      .execAsync(
        `UPDATE students SET classId = class_id
         WHERE class_id IS NOT NULL AND class_id != ''
           AND (classId IS NULL OR classId = '')`
      )
      .catch(() => {});

    await db
      .execAsync(
        `UPDATE students SET class_id = classId
         WHERE classId IS NOT NULL AND classId != ''
           AND (class_id IS NULL OR class_id = '')`
      )
      .catch(() => {});

    console.log("[repairStudentNames] ✅ class_id ↔ classId synced");
  }

  if (cols.includes("admissionNo") && cols.includes("admissionNumber")) {
    await db
      .execAsync(
        `UPDATE students SET admissionNumber = admissionNo
         WHERE admissionNo IS NOT NULL AND admissionNo != ''
           AND (admissionNumber IS NULL OR admissionNumber = '')`
      )
      .catch(() => {});

    await db
      .execAsync(
        `UPDATE students SET admissionNo = admissionNumber
         WHERE admissionNumber IS NOT NULL AND admissionNumber != ''
           AND (admissionNo IS NULL OR admissionNo = '')`
      )
      .catch(() => {});

    console.log("[repairStudentNames] ✅ admissionNo ↔ admissionNumber synced");
  }

  console.log(`[repairStudentNames] ✅ total repaired: ${totalFixed} rows`);
  return totalFixed;
};

// ─────────────────────────────────────────────────────────────
// STUDENT SELF-LOOKUP
// ─────────────────────────────────────────────────────────────

export const getStudentProfileByUserId = async (userId) => {
  if (!userId) return null;

  const db = await getDatabase();
  await ensureStudentSchema(db);

  try {
    const byUserId = await db.getFirstAsync(
      `SELECT * FROM students WHERE user_id = ? LIMIT 1`,
      [userId]
    );
    if (byUserId) return normaliseStudent(byUserId);

    const byId = await db.getFirstAsync(
      `SELECT * FROM students WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (byId) return normaliseStudent(byId);

    const userRow = await db.getFirstAsync(
      `SELECT email FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (userRow?.email) {
      const byEmail = await db.getFirstAsync(
        `SELECT * FROM students WHERE email = ? LIMIT 1`,
        [userRow.email]
      );
      if (byEmail) return normaliseStudent(byEmail);
    }

    return null;
  } catch (err) {
    console.warn("getStudentProfileByUserId failed:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// STUDENT CLASS RESOLVER
// ─────────────────────────────────────────────────────────────

export const resolveStudentClassId = async (userId) => {
  if (!userId) return null;

  const db = await getDatabase();

  try {
    await ensureStudentSchema(db);

    const row = await db
      .getFirstAsync(
        `SELECT COALESCE(class_id, classId) AS resolved_class_id
         FROM   students
         WHERE  user_id = ? OR id = ?
         LIMIT  1`,
        [userId, userId]
      )
      .catch(() => null);

    if (row?.resolved_class_id) {
      console.log(
        `[resolveStudentClassId] ✅ Local students table → ${row.resolved_class_id}`
      );
      return row.resolved_class_id;
    }

    try {
      const userCols     = await db
        .getAllAsync(`PRAGMA table_info(users)`, [])
        .catch(() => []);
      const userColNames = new Set(userCols.map((c) => c.name));
      const hasClassId   = userColNames.has("class_id");
      const hasClassIdC  = userColNames.has("classId");

      if (hasClassId || hasClassIdC) {
        const selectParts = [
          hasClassId  ? "class_id" : "NULL AS class_id",
          hasClassIdC ? "classId"  : "NULL AS classId",
        ].join(", ");

        const userRow = await db
          .getFirstAsync(
            `SELECT ${selectParts} FROM users WHERE id = ? LIMIT 1`,
            [userId]
          )
          .catch(() => null);

        const cid = userRow?.class_id || userRow?.classId || null;
        if (cid) {
          console.log(
            `[resolveStudentClassId] ✅ Local users table → ${cid}`
          );
          return cid;
        }
      }
    } catch { /* Non-fatal */ }

    try {
      const res  = await api.get("/students/me");
      const data = res.data?.data || res.data;

      const classId =
        (typeof data?.class === "string" ? data.class : null) ||
        data?.class?._id ||
        data?.class?.id  ||
        data?.classId    ||
        data?.class_id   ||
        null;

      if (classId) {
        console.log(
          `[resolveStudentClassId] ✅ Server /students/me → ${classId}`
        );

        await db
          .runAsync(
            `UPDATE students
             SET class_id = ?, classId = ?
             WHERE user_id = ? OR id = ?`,
            [classId, classId, userId, userId]
          )
          .catch(() => {});

        const exists = await db
          .getFirstAsync(
            `SELECT id FROM students WHERE user_id = ? OR id = ? LIMIT 1`,
            [userId, userId]
          )
          .catch(() => null);

        if (!exists) {
          const schoolId = data?.schoolId || getSchoolId() || null;
          await db
            .runAsync(
              `INSERT OR IGNORE INTO students
                 (id, user_id, class_id, classId, name, schoolId, status, is_active, _synced)
               VALUES (?, ?, ?, ?, ?, ?, 'approved', 1, 1)`,
              [
                data?.id || userId,
                userId,
                classId,
                classId,
                data?.name || null,
                schoolId,
              ]
            )
            .catch(() => {});
        }
      }

      return classId;
    } catch (apiErr) {
      const status = apiErr?.response?.status;
      if (status === 404)
        console.log("[resolveStudentClassId] /students/me → 404");
      else if (status === 403)
        console.log("[resolveStudentClassId] /students/me → 403");
      else
        console.warn(
          "[resolveStudentClassId] /students/me failed:",
          apiErr.message
        );
      return null;
    }
  } catch (err) {
    console.warn("resolveStudentClassId failed:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// STUDENT ATTENDANCE
// ─────────────────────────────────────────────────────────────

export const getStudentAttendance = async (userId, limit = 30) => {
  const db = await getDatabase();

  try {
    const hasTable = await tableExists(db, "attendance");
    if (!hasTable) {
      return { records: [], stats: { total: 0, present: 0, percentage: null } };
    }

    const cols       = await getColumns(db, "attendance");
    const studentCol = pickColumn(cols, ["student_id", "user_id", "studentId"]);
    const statusCol  = pickColumn(cols, ["status"]);
    const dateCol    = pickColumn(cols, ["date", "attendance_date", "created_at"]);

    if (!studentCol) {
      return { records: [], stats: { total: 0, present: 0, percentage: null } };
    }

    const records = await db.getAllAsync(
      `SELECT * FROM attendance
       WHERE  ${studentCol} = ?
       ORDER  BY ${dateCol || "rowid"} DESC
       LIMIT  ?`,
      [userId, limit]
    );

    const total   = records.length;
    const present = records.filter(
      (r) => r[statusCol] === "present" || r[statusCol] === "P"
    ).length;

    return {
      records,
      stats: {
        total,
        present,
        absent:     total - present,
        percentage: total > 0 ? Math.round((present / total) * 100) : null,
      },
    };
  } catch (err) {
    console.warn("getStudentAttendance failed:", err.message);
    return { records: [], stats: { total: 0, present: 0, percentage: null } };
  }
};

// ─────────────────────────────────────────────────────────────
// STUDENT TIMETABLE
// ─────────────────────────────────────────────────────────────

export const getStudentTimetable = async (classId) => {
  const db = await getDatabase();
  if (!classId) return [];

  try {
    const hasTable = await tableExists(db, "timetable");
    if (!hasTable) return [];

    // The periods table has carried different shapes across releases, so its
    // columns are checked rather than assumed. Hardcoding them threw
    // "no such column: p.name" on any device whose table predates them, and the
    // student saw an empty timetable with nothing to explain it.
    const pCols = await db.getAllAsync(`PRAGMA table_info(periods)`, []).catch(() => []);
    const pSet  = new Set(pCols.map((c) => c.name));
    const pName = pSet.has("name")      ? "p.name"      : "NULL";
    const pSort = pSet.has("sortorder") ? "p.sortorder" : "0";

    return await db.getAllAsync(
      `SELECT
         t.id, t.day,
         t.start_time  AS startTime,
         t.end_time    AS endTime,
         t.room,
         s.name        AS subjectName,
         s.code        AS subjectCode,
         u.name        AS teacherName,
         ${pName}      AS periodName,
         ${pSort}      AS sortOrder
       FROM timetable t
       LEFT JOIN subjects s ON s.id = t.subject_id
       LEFT JOIN users    u ON u.id = t.teacher_id
       LEFT JOIN periods  p ON p.id = t.period_id
       WHERE t.class_id = ?
         AND (t.deleted_at IS NULL OR t.deleted_at = '')
       ORDER BY
         CASE LOWER(t.day)
           WHEN 'monday'    THEN 1
           WHEN 'tuesday'   THEN 2
           WHEN 'wednesday' THEN 3
           WHEN 'thursday'  THEN 4
           WHEN 'friday'    THEN 5
           WHEN 'saturday'  THEN 6
           WHEN 'sunday'    THEN 7
           ELSE 8
         END,
         ${pSort} ASC,
         t.start_time ASC`,
      [classId]
    );
  } catch (err) {
    console.warn("getStudentTimetable failed:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────
// STUDENT QUIZZES
// ─────────────────────────────────────────────────────────────

export const getStudentAvailableQuizzes = async (userId, classId) => {
  const db = await getDatabase();
  if (!classId) return [];

  try {
    const now = new Date().toISOString();
    return await db.getAllAsync(
      `SELECT
         q.id, q.title, q.description,
         q.time_limit_minutes, q.max_attempts, q.passing_score,
         q.show_score, q.available_from, q.available_until,
         s.name AS subjectName,
         u.name AS teacherName,
         (SELECT COUNT(*) FROM quiz_questions qq
          WHERE qq.quiz_id = q.id) AS questionCount,
         (SELECT COUNT(*) FROM quiz_attempts qa
          WHERE qa.quiz_id = q.id
            AND qa.user_id = ?
            AND qa.status != 'abandoned') AS attemptsMade,
         (SELECT MAX(qa.percentage) FROM quiz_attempts qa
          WHERE qa.quiz_id = q.id
            AND qa.user_id = ?
            AND qa.status IN ('submitted','timed_out')) AS bestScore
       FROM quizzes q
       LEFT JOIN subjects s ON s.id = q.subject_id
       LEFT JOIN users    u ON u.id = q.created_by
       WHERE q.class_id    = ?
         AND q.is_published = 1
         AND (q.deleted_at IS NULL OR q.deleted_at = '')
         AND (q.available_from  IS NULL OR q.available_from  <= ?)
         AND (q.available_until IS NULL OR q.available_until >= ?)
       ORDER BY q.created_at DESC`,
      [userId, userId, classId, now, now]
    );
  } catch (err) {
    console.warn("getStudentAvailableQuizzes failed:", err.message);
    return [];
  }
};

export const getStudentQuizHistory = async (userId, limit = 20) => {
  const db = await getDatabase();
  try {
    return await db.getAllAsync(
      `SELECT
         qa.id, qa.quiz_id, qa.attempt_number, qa.status,
         qa.raw_score, qa.max_score, qa.percentage, qa.is_passed,
         qa.started_at, qa.submitted_at, qa.time_taken_secs,
         q.title        AS quizTitle,
         q.passing_score,
         s.name         AS subjectName,
         c.name         AS className
       FROM   quiz_attempts qa
       JOIN   quizzes        q ON q.id = qa.quiz_id
       LEFT JOIN subjects    s ON s.id = q.subject_id
       LEFT JOIN classes     c ON c.id = q.class_id
       WHERE  qa.user_id = ?
         AND  qa.status IN ('submitted', 'timed_out')
       ORDER  BY qa.submitted_at DESC
       LIMIT  ?`,
      [userId, limit]
    );
  } catch (err) {
    console.warn("getStudentQuizHistory failed:", err.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────
// LOOKUP BY ID — new helper used by detail screens
// ─────────────────────────────────────────────────────────────

/**
 * Looks up a single student by their primary id in the local DB.
 * Returns a normalised student object with updatedAt preserved,
 * or null if not found.
 */
export const getStudentById = async (studentId) => {
  if (!studentId) return null;
  const db = await getDatabase();
  await ensureStudentSchema(db);

  try {
    const row = await db.getFirstAsync(
      `SELECT * FROM students WHERE id = ? LIMIT 1`,
      [studentId]
    );
    return row ? normaliseStudent(row) : null;
  } catch (err) {
    console.warn("getStudentById failed:", err.message);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────
// OFFLINE CHANGES — the phone's copy first, the outbox sends them
// ─────────────────────────────────────────────────────────────

const CHANGE_KIND    = "studentChange";
const CHANGE_ACTIONS = ["edit", "suspend", "restore", "move", "delete"];
const changeKey      = (action, id) => `student-${action}:${id}`;

/**
 * Editable field → the local columns that hold it. The table carries both
 * spellings for some (the pull writes guardian_name, enrolment guardianName);
 * a correction writes every one that exists, so no screen reads a stale copy.
 */
const EDIT_COLUMNS = {
  firstName:      ["firstName", "first_name"],
  lastName:       ["lastName", "last_name"],
  dateOfBirth:    ["dateOfBirth", "date_of_birth"],
  gender:         ["gender"],
  email:          ["email"],
  phone:          ["phone"],
  alternatePhone: ["alternatePhone"],
  address:        ["address"],
  city:           ["city"],
  guardianName:   ["guardianName", "guardian_name"],
  guardianPhone:  ["guardianPhone", "guardian_phone"],
  guardianEmail:  ["guardianEmail", "guardian_email"],
};

/** The columns the offline writes need; returns the table's column list. */
const ensureChangeColumns = async (db) => {
  await ensureStudentSchema(db);
  await ensureStudentColumns(db).catch(() => {});
  const cols = await getColumns(db, "students");
  for (const col of ["alternatePhone", "city", "className", "class_name", "deleted_at"]) {
    if (!cols.includes(col)) await safeAddColumn(db, "students", col, "TEXT");
  }
  return getColumns(db, "students");
};

/** Outbox entries (not yet synced) that carry this pupil, the create included. */
const pendingChangesFor = async (studentId) => {
  const rows = await outboxRowsForTable("students").catch(() => []);
  return rows.filter((r) => localIdsOf(r.payload?.__local).map(String).includes(String(studentId)));
};

/**
 * The server version a change is made against: the one the first change
 * still queued for this pupil was made against (the phone's copy has moved
 * on since, under its own clock), else the caller's, else the row's.
 */
const baseFor = (pending, given, row) => {
  const queued = pending.find((p) => p.payload?.__reconcile?.kind === CHANGE_KIND && p.payload?.baseUpdatedAt);
  return queued?.payload?.baseUpdatedAt ?? given ?? row?.updated_at ?? row?.updatedAt ?? null;
};

/** A pupil enrolled on this phone whose create the server cannot have. */
const neverSent = async (row, id) => {
  const state = await MutationQueue.createState(`student-create:${id}`);
  if (state === "unsent") return true;
  if (state !== "none") return false;
  return row?._operation === "create" && !(Number(row?._synced) === 1);
};

/** Writes the named columns that exist, plus updated_at. */
const writeLocal = async (db, id, fields, now) => {
  const cols = await getColumns(db, "students");
  const sets = [];
  const values = [];
  for (const [col, value] of Object.entries(fields)) {
    if (!cols.includes(col)) continue;
    sets.push(`${col} = ?`);
    values.push(value ?? null);
  }
  if (now) { sets.push("updated_at = ?"); values.push(now); }
  if (!sets.length) return;
  await db.runAsync(`UPDATE students SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
};

const queueChange = async ({ id, action, method, endpoint, body = {}, resolve, base, since, before, merge = false }) => {
  await MutationQueue.enqueue({
    entityKey: changeKey(action, id),
    method,
    endpoint,
    merge,
    payload: {
      ...body,
      // In the body, not the query string: the id map rewrites path segments,
      // and "<id>?baseUpdatedAt=…" would not be recognised as one.
      ...(base ? { baseUpdatedAt: base } : {}),
      ...(resolve ? { __resolve: resolve } : {}),
      // Names the row, so the backfill's student sweeps leave it alone while
      // this waits (coveredIds) and a success marks it clean.
      __local:     { table: "students", ids: [id] },
      __reconcile: { kind: CHANGE_KIND, action, localId: id, since, before },
    },
  });
};

const STATUS_FIELDS = {
  suspend: { status: "suspended", is_active: 0 },
  restore: { status: "approved",  is_active: 1 },
};

/** Suspend or restore; the opposite one still unsent is cancelled instead. */
const setStatus = async (studentId, action, { baseUpdatedAt } = {}) => {
  if (!studentId) throw new Error("studentId is required");
  const db  = await getDatabase();
  await ensureChangeColumns(db);
  const id  = String(studentId);
  const row = await db.getFirstAsync(`SELECT * FROM students WHERE id = ?`, [id]).catch(() => null);
  const opposite = action === "suspend" ? "restore" : "suspend";
  const pending  = await pendingChangesFor(id);
  const now = new Date().toISOString();

  await writeLocal(db, id, STATUS_FIELDS[action], now);

  // Suspended then restored before anything was sent: the server never needs
  // to hear about either (and would answer the restore "already active").
  if ((await MutationQueue.createState(changeKey(opposite, id))) === "unsent") {
    await MutationQueue.cancelUnsent(changeKey(opposite, id));
    return { queued: false, cancelled: true };
  }

  await queueChange({
    id, action, method: "PATCH", endpoint: `/students/${id}/${action}`,
    base: baseFor(pending, baseUpdatedAt, row), since: now,
    before: { status: row?.status ?? null, is_active: row?.is_active ?? null },
  });
  return { queued: true };
};

/** The correction form's fields from the phone's copy. */
const readLocalEditable = async (id, pending) => {
  const db   = await getDatabase();
  const cols = await ensureChangeColumns(db);
  const row  = await db.getFirstAsync(`SELECT * FROM students WHERE id = ?`, [id]).catch(() => null);
  if (!row) return null;
  const out = { _id: row.id };
  for (const [field, candidates] of Object.entries(EDIT_COLUMNS)) {
    const col = candidates.find((c) => cols.includes(c) && row[c] != null && row[c] !== "");
    out[field] = col ? row[col] : null;
  }
  return {
    ...out,
    updatedAt:    baseFor(pending, null, row),
    studentName:  row.studentName ?? row.name ?? null,
    enrollmentNo: row.enrollmentNo ?? row.enrollment_no ?? row.admissionNo ?? null,
    className:    row.className ?? row.class_name ?? null,
    status:       row.status ?? null,
  };
};

/**
 * What a sent change settles, and what a refused one puts back. Registered
 * from syncBackfill.registerReconcilers so a drain finds them even when no
 * student screen has been opened since the app started.
 */
let _changeHandlersRegistered = false;
export const registerStudentReconcilers = () => {
  if (_changeHandlersRegistered) return;
  _changeHandlersRegistered = true;

  registerReconciler(CHANGE_KIND, async ({ response, args }) => {
    const db = await getDatabase();
    const id = args.localId;
    if (!id) return;
    if (args.action === "delete") {
      // Done upstream (or already gone: 404/410) — the tombstone can go.
      await db.runAsync(`DELETE FROM students WHERE id = ?`, [id]).catch(() => {});
    } else {
      // The server's version stamp, so the next change is made against it —
      // unless the phone's copy moved on while this was in flight.
      const stamp = response?.data?.data?.updatedAt;
      if (stamp) {
        await db.runAsync(
          `UPDATE students SET updated_at = ? WHERE id = ? AND COALESCE(updated_at, '') = COALESCE(?, '')`,
          [String(stamp), id, args.since ?? null]
        ).catch(() => {});
      }
    }
    const overwrote = response?.data?.overwrote;
    if (overwrote?.id) {
      await SyncOverwriteService.saveOverwrite(overwrote, {
        entityType: "student",
        entityId:   id,
        entityName: response?.data?.data?.studentName || response?.data?.data?.name || null,
        schoolId:   getSchoolId(),
        action:     args.action,
      });
    }
  });

  // Refused (403, 400, 404 on a PATCH…): the phone shows what the school
  // holds again; the refusal waits, with the server's reason, on the
  // pending-changes screen.
  registerFailureHandler(CHANGE_KIND, async ({ args }) => {
    const db = await getDatabase();
    if (!args?.localId || !args.before) return;
    await writeLocal(db, args.localId, args.before, null).catch(() => {});
  });
};

// ─────────────────────────────────────────────────────────────
// SERVICE (admin-facing)
// ─────────────────────────────────────────────────────────────

export const StudentService = {

  // ── GET ALL STUDENTS (any status) ──────────────────────────────────────
  async getStudents({
    page    = 1,
    limit   = 200,
    status  = "all",
    classId = "",
    search  = "",
  } = {}) {
    const schoolId = getSchoolId();

    const params = { page, limit, schoolId };

    if (status && status !== "all") {
      params.status = status;
    }
    if (classId) params.classId = classId;
    if (search)  params.search  = search;

    try {
      await fixStudentIndexes();

      const response = await api.get("/admin/students", {
        params,
        timeout: 15_000,
      });

      console.log(
        `[getStudents] status=${status} page=${page} → HTTP ${response.status}`
      );

      const raw =
        response.data?.students ||
        response.data?.data     ||
        (Array.isArray(response.data) ? response.data : null);

      const serverTotal =
        response.data?.total            ??
        response.data?.pagination?.total ??
        null;

      console.log(
        `[getStudents] raw=${raw?.length ?? "null"} serverTotal=${serverTotal}`
      );

      if (raw && raw.length > 0) {
        const normalised = raw.map(normaliseStudent).filter(Boolean);

        console.log(`[getStudents] ${normalised.length} students from server`);

        const db = await getDatabase();
        await cacheStudentsLocally(db, normalised, schoolId, false);
        await repairStudentNames();

        return normalised;
      }

      if (raw && raw.length === 0) {
        console.warn("[getStudents] Server returned 0 — falling back to local");
        return this.getStudentsLocal({ status });
      }

    } catch (err) {
      console.warn("[getStudents] server failed:", err.message);

      if (err.message?.includes("UNIQUE constraint")) {
        console.warn("[getStudents] ⚠️ UNIQUE constraint — triggering rebuild");
        await dropAndRecreateStudentTable();
      }
    }

    return this.getStudentsLocal({ status });
  },

  // ── LOCAL FALLBACK (any status) ──────────────────────────────────────────
  async getStudentsLocal({ status = "all", classId = "" } = {}) {
    const db       = await getDatabase();
    const schoolId = getSchoolId();

    try {
      if (!(await tableExists(db, "students"))) {
        console.log("[getStudentsLocal] No local students table yet");
        return [];
      }

      await ensureStudentSchema(db);

      const stuCols    = await getColumns(db, "students");
      const hasClasses = await tableExists(db, "classes");

      const deletedCol      = pickColumn(stuCols, ["deleted_at", "deletedAt"]);
      const classCol        = pickColumn(stuCols, ["class_id",   "classId"]);
      const schoolCol       = pickColumn(stuCols, ["schoolId",   "school_id"]);
      const hasClassNameCol = stuCols.includes("class_name");

      let q = `SELECT s.*`;
      if (hasClasses && classCol && !hasClassNameCol) {
        q += `, c.name AS _joinedClassName`;
      }
      q += ` FROM students s`;
      if (hasClasses && classCol && !hasClassNameCol) {
        q += ` LEFT JOIN classes c ON c.id = s.${classCol}`;
      }

      const where  = [];
      const params = [];

      if (status && status !== "all" && VALID_STATUSES.has(status)) {
        where.push(`s.status = ?`);
        params.push(status);
      }

      if (deletedCol) {
        where.push(
          `(s.${deletedCol} IS NULL OR s.${deletedCol} = '')`
        );
      }

      if (schoolId && schoolCol) {
        where.push(
          `(s.${schoolCol} = ? OR s.${schoolCol} IS NULL OR s.${schoolCol} = '')`
        );
        params.push(schoolId);
      }

      if (classId && classCol) {
        where.push(`s.${classCol} = ?`);
        params.push(classId);
      }

      if (where.length > 0) q += ` WHERE ${where.join(" AND ")}`;

      q += ` ORDER BY COALESCE(s.studentName, s.name, '') ASC`;

      const rows = await db.getAllAsync(q, params);
      console.log(
        `[getStudentsLocal] status=${status} → ${rows.length} rows from local DB`
      );
      return rows.map(normaliseStudent).filter(Boolean);
    } catch (err) {
      console.error("[getStudentsLocal] error:", err.message);
      return [];
    }
  },

  // ── GET APPROVED STUDENTS (legacy) ───────────────────────────────────────
  async getApprovedStudents() {
    const schoolId = getSchoolId();

    try {
      await fixStudentIndexes();

      const response = await api.get("/admin/students/approved", {
        params:  { schoolId },
        timeout: 15_000,
      });

      console.log("🔍 response.data keys  :", Object.keys(response.data || {}));
      console.log("🔍 response.data.count :", response.data?.count);
      console.log("🔍 response.data.total :", response.data?.total);

      const raw =
        response.data?.students ||
        response.data?.data     ||
        (Array.isArray(response.data) ? response.data : null);

      console.log("🔍 raw length:", raw?.length ?? "null");

      if (raw && raw.length > 0) {
        console.log("📦 Raw student[0]:", JSON.stringify(raw[0], null, 2));

        const approved = raw
          .filter(isApproved)
          .map(normaliseStudent)
          .filter(Boolean);

        console.log(`📋 ${approved.length} approved students from server`);

        const db = await getDatabase();
        await cacheStudentsLocally(db, approved, schoolId, true);
        await repairStudentNames();

        return approved;
      }

      if (raw && raw.length === 0) {
        console.warn("⚠️ Server returned 0 students — checking local cache");
        const local = await this.getApprovedStudentsLocal();
        if (local.length > 0) {
          console.log(`📋 Using ${local.length} students from local cache`);
          return local;
        }
        return [];
      }

    } catch (err) {
      console.warn("getApprovedStudents — server failed:", err.message);

      if (err.message?.includes("UNIQUE constraint")) {
        console.warn(
          "⚠️ UNIQUE constraint error — triggering emergency table rebuild"
        );
        await dropAndRecreateStudentTable();
      }
    }

    return this.getApprovedStudentsLocal();
  },

  async getApprovedStudentsLocal() {
    return this.getStudentsLocal({ status: "approved" });
  },

  async getApprovedStudentsByClass() {
    const students = await this.getApprovedStudents();
    const grouped  = {};

    for (const student of students) {
      const key     = student.className || "Unassigned";
      const classId = student.classId   || null;

      if (!grouped[key]) {
        grouped[key] = { className: key, classId, students: [] };
      }
      grouped[key].students.push(student);
    }

    for (const key of Object.keys(grouped)) {
      grouped[key].students.sort((a, b) =>
        (a.name || a.studentName || "").localeCompare(
          b.name || b.studentName || ""
        )
      );
    }

    return Object.values(grouped).sort((a, b) => {
      if (a.className === "Unassigned") return  1;
      if (b.className === "Unassigned") return -1;
      return a.className.localeCompare(b.className, undefined, {
        numeric: true,
      });
    });
  },

  async getApprovedStudentsByClassId(classId) {
    const students = await this.getApprovedStudents();
    return students.filter((s) => s.classId === classId);
  },

  async getApprovedCount() {
    const students = await this.getApprovedStudents();
    return students.length;
  },

  // ── APPROVE ─────────────────────────────────────────────────────────────
  async approve(studentId) {
    if (!studentId) throw new Error("studentId is required");
    const db  = await getDatabase();
    await ensureStudentSchema(db);
    const response = await api.patch(`/admin/students/${studentId}/approve`);
    const now = new Date().toISOString();
    await db
      .runAsync(
        `UPDATE students
         SET status = 'approved', is_active = 1, updated_at = ?, _synced = 0
         WHERE id = ?`,
        [now, studentId]
      )
      .catch(() => {});
    return response.data;
  },

  // ── REJECT ──────────────────────────────────────────────────────────────
  async reject(studentId, reason = "") {
    if (!studentId) throw new Error("studentId is required");
    const db  = await getDatabase();
    await ensureStudentSchema(db);
    const response = await api.patch(`/admin/students/${studentId}/reject`, { reason });
    const now = new Date().toISOString();
    await db
      .runAsync(
        `UPDATE students
         SET status = 'rejected', is_active = 0, updated_at = ?, _synced = 0
         WHERE id = ?`,
        [now, studentId]
      )
      .catch(() => {});
    return response.data;
  },

  // ── SUSPEND / RESTORE / MOVE / DELETE / CORRECT — written here, sent later ──
  //
  // Each of these used to call the API and only then touch SQLite, so offline
  // they failed and the screen disabled them. Now the phone's copy changes at
  // once and the request waits in the outbox (Idempotency-Key, retry, the
  // pending-changes screen), sent once when there is a connection. The version
  // the change was made against goes with it as baseUpdatedAt, so the server
  // still records an overwrite when somebody else edited the pupil meanwhile
  // (last write wins, and the loser can see what happened).
  //
  // Each returns { queued: true, ... } as soon as the phone holds the change.

  /** Suspend. A restore of the same pupil still unsent is cancelled instead. */
  async suspend(studentId, { baseUpdatedAt } = {}) {
    return setStatus(studentId, "suspend", { baseUpdatedAt });
  },

  /** Restore. A suspension of the same pupil still unsent is cancelled instead. */
  async restore(studentId, { baseUpdatedAt } = {}) {
    return setStatus(studentId, "restore", { baseUpdatedAt });
  },

  /**
   * Remove a pupil.
   *
   * One created on this phone and never sent is simply dropped, with every
   * change queued for it: the server has never heard of it, so nothing goes
   * on the wire. Otherwise the row is hidden here and DELETE is queued; a
   * 404/410 counts as done (the pupil is already gone).
   */
  async delete(studentId, { baseUpdatedAt } = {}) {
    if (!studentId) throw new Error("studentId is required");
    const db  = await getDatabase();
    await ensureChangeColumns(db);
    const id  = String(studentId);
    const row = await db.getFirstAsync(`SELECT * FROM students WHERE id = ?`, [id]).catch(() => null);

    if (await neverSent(row, id)) {
      for (const key of [`student-create:${id}`, ...CHANGE_ACTIONS.map((a) => changeKey(a, id))]) {
        await MutationQueue.cancelUnsent(key);
      }
      await db.runAsync(`DELETE FROM students WHERE id = ?`, [id]).catch(() => {});
      return { queued: false, dropped: true };
    }

    // Anything else still waiting for this pupil is moot once it is removed.
    const pending = await pendingChangesFor(id);
    const base = baseFor(pending, baseUpdatedAt, row);
    for (const action of ["edit", "suspend", "restore", "move"]) {
      await MutationQueue.cancelUnsent(changeKey(action, id));
    }

    const now = new Date().toISOString();
    await writeLocal(db, id, { deleted_at: now, is_active: 0 }, now);
    await queueChange({
      id, action: "delete", method: "DELETE", endpoint: `/students/${id}`,
      base, since: now, before: { deleted_at: null, is_active: row?.is_active ?? 1 },
    });
    return { queued: true };
  },

  /** Move to another class. Moving back before the first move is sent cancels it. */
  async moveToClass(studentId, classId, { baseUpdatedAt } = {}) {
    if (!studentId) throw new Error("studentId is required");
    if (!classId)   throw new Error("classId is required");
    const db  = await getDatabase();
    await ensureChangeColumns(db);
    const id  = String(studentId);
    const cid = String(classId);
    const row = await db.getFirstAsync(`SELECT * FROM students WHERE id = ?`, [id]).catch(() => null);
    const cls = await db.getFirstAsync(`SELECT name FROM classes WHERE id = ?`, [cid]).catch(() => null);

    const pending  = await pendingChangesFor(id);
    const queued   = pending.find((p) => p.payload?.__reconcile?.action === "move" && p.status === "pending");
    const original = queued?.payload?.__reconcile?.before ?? {
      class_id:   row?.class_id  ?? row?.classId    ?? null,
      classId:    row?.classId   ?? row?.class_id   ?? null,
      className:  row?.className ?? row?.class_name ?? null,
      class_name: row?.class_name ?? row?.className ?? null,
    };
    const now = new Date().toISOString();
    await writeLocal(db, id, {
      class_id: cid, classId: cid,
      ...(cls?.name ? { className: cls.name, class_name: cls.name } : {}),
    }, now);

    if (queued && String(original.class_id ?? original.classId ?? "") === cid
        && (await MutationQueue.createState(changeKey("move", id))) === "unsent") {
      await MutationQueue.cancelUnsent(changeKey("move", id));
      return { queued: false, cancelled: true };
    }

    await queueChange({
      id, action: "move", method: "PATCH", endpoint: `/students/${id}/move`,
      body: { classId: cid }, resolve: ["classId"],
      base: baseFor(pending, baseUpdatedAt, row), since: now, before: original,
    });
    return { queued: true, data: { classId: cid, className: cls?.name ?? null } };
  },

  /**
   * Fix details that were mistyped when the pupil was admitted.
   *
   * The office had no way to do this at all: the only student writes were
   * approve, reject, suspend, restore, move and delete, so a misspelled surname
   * was permanent — and it is the surname that prints on report cards, identity
   * cards and receipts. Deleting the pupil to re-enter them is not a way round
   * it: twenty server collections carry a studentId, so a fresh record detaches
   * their marks, register, fees and every card already issued.
   *
   * Written to the phone's copy and queued as PATCH /students/:id carrying only
   * the fields that moved. A second correction before the first is sent is
   * merged into it. The server writes only what differs from what it holds, so
   * a replay changes nothing twice. Sibling rule (CLAUDE.md): an email or
   * phone shared with another pupil is never a reason to refuse.
   */
  async updateStudent(studentId, patch, { baseUpdatedAt, changeReason } = {}) {
    if (!studentId) throw new Error("studentId is required");
    if (!patch || Object.keys(patch).length === 0) throw new Error("nothing to update");

    const db   = await getDatabase();
    const cols = await ensureChangeColumns(db);
    const id   = String(studentId);
    const row  = await db.getFirstAsync(`SELECT * FROM students WHERE id = ?`, [id]).catch(() => null);

    const fields = {};
    for (const [field, value] of Object.entries(patch)) {
      if (!EDIT_COLUMNS[field]) continue;
      fields[field] = value === undefined ? null : value;
    }
    if (Object.keys(fields).length === 0) throw new Error("nothing to update");

    // What the phone held before, column by column, so a refusal can put it back.
    const pending = await pendingChangesFor(id);
    const earlier = pending.find((p) => p.payload?.__reconcile?.action === "edit")?.payload?.__reconcile?.before ?? {};
    const local  = {};
    const before = {};
    for (const [field, value] of Object.entries(fields)) {
      for (const col of EDIT_COLUMNS[field]) {
        if (!cols.includes(col)) continue;
        local[col]  = value;
        before[col] = row ? row[col] ?? null : null;
      }
    }
    if (fields.firstName !== undefined || fields.lastName !== undefined) {
      const first = fields.firstName !== undefined ? fields.firstName : (row?.firstName ?? row?.first_name ?? "");
      const last  = fields.lastName  !== undefined ? fields.lastName  : (row?.lastName  ?? row?.last_name  ?? "");
      const full  = `${first ?? ""} ${last ?? ""}`.trim();
      if (full) {
        local.name = full; local.studentName = full;
        before.name = row?.name ?? null; before.studentName = row?.studentName ?? null;
      }
    }

    const now = new Date().toISOString();
    await writeLocal(db, id, local, now);
    await queueChange({
      id, action: "edit", method: "PATCH", endpoint: `/students/${id}`,
      body: { ...fields, ...(changeReason ? { changeReason } : {}) },
      base: baseFor(pending, baseUpdatedAt, row), since: now,
      before: { ...before, ...earlier }, merge: true,
    });

    return { queued: true, changed: Object.keys(fields), data: { id, ...fields } };
  },

  /**
   * The record as the correction form needs it.
   *
   * From the server when it can answer and nothing is waiting to be sent for
   * this pupil — GET /students/:id/editable carries every editable field and
   * the version stamp. Otherwise (offline, or a change of ours still queued)
   * from the phone's copy, which is where that queued change already is.
   */
  async getStudentForEdit(studentId) {
    if (!studentId) throw new Error("studentId is required");
    const id      = String(studentId);
    const pending = await pendingChangesFor(id);
    const local   = await readLocalEditable(id, pending);
    if (pending.length && local) return local;
    try {
      const response = await api.get(`/students/${id}/editable`);
      const body = response.data || {};
      return body.data ?? body;
    } catch (err) {
      if (!err?.response && local) return local;
      throw err;
    }
  },

  /**
   * Where this pupil's queued changes stand: "failed" when the server refused
   * one (it waits on the pending-changes screen), "pending" while any is still
   * to be sent, otherwise null.
   */
  async getPendingState(studentId) {
    if (!studentId) return null;
    const rows = await pendingChangesFor(String(studentId));
    const failed = rows.find((r) => r.status === "failed" || r.status === "conflict");
    if (failed) return { state: "failed", error: failed.error ?? null };
    return rows.length ? { state: "pending", error: null } : null;
  },

  /** A pupil's correction history, newest first. Needs students.viewFull. */
  async getStudentHistory(studentId, limit = 100) {
    if (!studentId) throw new Error("studentId is required");
    const response = await api.get(`/students/${studentId}/history`, { params: { limit } });
    const body = response.data || {};
    return body.data?.changes ?? body.changes ?? [];
  },
};

export default StudentService;