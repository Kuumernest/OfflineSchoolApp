// src/db/database.js
"use strict";

import * as SQLite from "expo-sqlite";

const DB_NAME = "schoolapp.db";

/** @type {import('expo-sqlite').SQLiteDatabase | null} */
let _db = null;

// ✅ FIX: Promise-based ready queue.
// If getDatabase() is called before _db is initialised (e.g. from a service
// that imports at module load time), the call is queued and resolved once
// openDatabaseAsync completes. Without this, services that called
// getDatabase() concurrently during boot all raced to open the DB,
// causing "database is locked" / "undefined is not a function" errors.
let _initPromise = null;

/**
 * Open (or return cached) SQLite database.
 * Safe to call multiple times and from multiple places concurrently.
 *
 * @returns {Promise<import('expo-sqlite').SQLiteDatabase>}
 */
export const getDatabase = async () => {
  // Fast path — already open
  if (_db) return _db;

  // If init is already in flight, wait for it instead of opening a second
  // connection. This is the key fix for the race condition.
  if (_initPromise) return _initPromise;

  _initPromise = _openDatabase();
  return _initPromise;
};

const _openDatabase = async () => {
  try {
    const db = await SQLite.openDatabaseAsync(DB_NAME);

    // ── Performance + safety pragmas ──────────────────────────────────
    // Each pragma is a separate execAsync call — bundling them into one
    // string works in older expo-sqlite but fails silently in v2.
    await db.execAsync("PRAGMA journal_mode = WAL;").catch(() => {});
    await db.execAsync("PRAGMA foreign_keys = ON;").catch(() => {});

    // ── Core schema ───────────────────────────────────────────────────
    // Tables that every role needs. Role-specific tables (quiz, announcements
    // etc.) are created by SyncManager.runAllMigrations() after login.
    // Each CREATE TABLE is a separate execAsync call — the v2 API does not
    // reliably execute multiple DDL statements in one string.

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS exams (
        id               TEXT PRIMARY KEY,
        schoolId         TEXT,
        classId          TEXT,
        className        TEXT,
        classIds         TEXT,
        classNames       TEXT,
        name             TEXT NOT NULL,
        type             TEXT DEFAULT 'first_test',
        academicYear     TEXT,
        term             TEXT,
        startDate        TEXT,
        endDate          TEXT,
        status           TEXT DEFAULT 'draft',
        description      TEXT,
        instructions     TEXT,
        totalMarks       INTEGER DEFAULT 100,
        passMark         INTEGER DEFAULT 50,
        resultsPublished INTEGER DEFAULT 0,
        createdBy        TEXT,
        updatedBy        TEXT,
        deleted_at       TEXT,
        created_at       TEXT,
        updated_at       TEXT
      )
    `).catch((err) => console.warn("[database] exams:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS exam_subjects (
        id               TEXT PRIMARY KEY,
        examId           TEXT,
        subjectId        TEXT,
        classId          TEXT,
        schoolId         TEXT,
        teacherId        TEXT,
        subjectName      TEXT,
        teacherName      TEXT,
        maxScore         INTEGER DEFAULT 100,
        passMark         INTEGER DEFAULT 50,
        weight           INTEGER DEFAULT 100,
        submissionStatus TEXT DEFAULT 'pending',
        submittedAt      TEXT,
        submittedBy      TEXT,
        approvedAt       TEXT,
        approvedBy       TEXT,
        rejectedAt       TEXT,
        rejectedBy       TEXT,
        rejectReason     TEXT,
        deleted_at       TEXT,
        created_at       TEXT,
        updated_at       TEXT
      )
    `).catch((err) => console.warn("[database] exam_subjects:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS student_scores (
        id             TEXT PRIMARY KEY,
        examId         TEXT,
        examSubjectId  TEXT,
        subjectId      TEXT,
        studentId      TEXT,
        classId        TEXT,
        schoolId       TEXT,
        score          REAL,
        maxScore       REAL DEFAULT 100,
        percentage     REAL,
        grade          TEXT,
        gpaPoints      REAL,
        isPassing      INTEGER DEFAULT 0,
        isAbsent       INTEGER DEFAULT 0,
        isExempt       INTEGER DEFAULT 0,
        teacherRemark  TEXT,
        enteredBy      TEXT,
        enteredAt      TEXT,
        syncStatus     TEXT DEFAULT 'pending',
        deleted_at     TEXT,
        created_at     TEXT,
        updated_at     TEXT
      )
    `).catch((err) => console.warn("[database] student_scores:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS result_summaries (
        id              TEXT PRIMARY KEY,
        examId          TEXT,
        studentId       TEXT,
        classId         TEXT,
        schoolId        TEXT,
        studentName     TEXT,
        admissionNo     TEXT,
        className       TEXT,
        academicYear    TEXT,
        term            TEXT,
        totalScore      REAL DEFAULT 0,
        maxTotalScore   REAL DEFAULT 0,
        percentage      REAL DEFAULT 0,
        average         REAL DEFAULT 0,
        overallGrade    TEXT,
        overallRemark   TEXT,
        gpa             REAL,
        subjectsPassed  INTEGER DEFAULT 0,
        subjectsFailed  INTEGER DEFAULT 0,
        subjectsTotal   INTEGER DEFAULT 0,
        isPassing       INTEGER DEFAULT 0,
        classPosition   INTEGER,
        gradePosition   INTEGER,
        schoolPosition  INTEGER,
        totalInClass    INTEGER,
        totalInGrade    INTEGER,
        totalInSchool   INTEGER,
        isPublished     INTEGER DEFAULT 0,
        isLocked        INTEGER DEFAULT 0,
        publishedAt     TEXT,
        syncStatus      TEXT DEFAULT 'pending',
        deleted_at      TEXT,
        created_at      TEXT,
        updated_at      TEXT
      )
    `).catch((err) => console.warn("[database] result_summaries:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS classes (
        id           TEXT PRIMARY KEY,
        schoolId     TEXT,
        school_id    TEXT,
        name         TEXT,
        level        TEXT,
        section      TEXT,
        studentCount INTEGER DEFAULT 0,
        is_active    INTEGER DEFAULT 1,
        deleted_at   TEXT,
        created_at   TEXT,
        updated_at   TEXT
      )
    `).catch((err) => console.warn("[database] classes:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS students (
        id          TEXT PRIMARY KEY,
        schoolId    TEXT,
        school_id   TEXT,
        classId     TEXT,
        class_id    TEXT,
        user_id     TEXT,
        name        TEXT,
        studentName TEXT,
        admissionNo TEXT,
        email       TEXT,
        gender      TEXT,
        is_active   INTEGER DEFAULT 1,
        status      TEXT DEFAULT 'active',
        deleted_at  TEXT,
        created_at  TEXT,
        updated_at  TEXT
      )
    `).catch((err) => console.warn("[database] students:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS report_templates (
        id         TEXT PRIMARY KEY,
        schoolId   TEXT,
        school_id  TEXT,
        name       TEXT,
        html       TEXT,
        css        TEXT,
        is_default INTEGER DEFAULT 0,
        version    INTEGER DEFAULT 1,
        variables  TEXT,
        _synced    INTEGER DEFAULT 1,
        deleted_at TEXT,
        updated_at TEXT,
        created_at TEXT
      )
    `).catch((err) => console.warn("[database] report_templates:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS generated_reports (
        id              TEXT PRIMARY KEY,
        schoolId        TEXT,
        examId          TEXT,
        studentId       TEXT,
        templateId      TEXT,
        templateVersion INTEGER DEFAULT 1,
        renderedHtml    TEXT,
        term            TEXT,
        academicYear    TEXT,
        isPublished     INTEGER DEFAULT 0,
        publishedAt     TEXT,
        generatedBy     TEXT,
        deleted_at      TEXT,
        created_at      TEXT,
        updated_at      TEXT
      )
    `).catch((err) => console.warn("[database] generated_reports:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS subjects (
        id          TEXT PRIMARY KEY,
        schoolId    TEXT,
        school_id   TEXT,
        classId     TEXT,
        class_id    TEXT,
        name        TEXT,
        code        TEXT,
        teacher_id  TEXT,
        teacher_name TEXT,
        is_active   INTEGER DEFAULT 1,
        deleted_at  TEXT,
        created_at  TEXT,
        updated_at  TEXT,
        _synced     INTEGER DEFAULT 0,
        _synced_at  TEXT
      )
    `).catch((err) => console.warn("[database] subjects:", err.message));

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS teachers (
        id         TEXT PRIMARY KEY,
        schoolId   TEXT,
        school_id  TEXT,
        name       TEXT,
        email      TEXT,
        is_active  INTEGER DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `).catch((err) => console.warn("[database] teachers:", err.message));

    // ── Users table — needed for offline auth ─────────────────────────
    // ✅ FIX: this was missing from the original database.js.
    //    The login() offline path and SyncManager.syncTeachers() both
    //    INSERT into `users`, but the table was only created by
    //    SyncManager.migrateUsersTable() which runs AFTER login.
    //    On a fresh install the offline-cache INSERT threw
    //    "no such table: users" which surfaced as
    //    "Offline cache failed: undefined is not a function" because
    //    expo-sqlite wraps the underlying SQLite error in a way that
    //    loses the original message.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id                  TEXT PRIMARY KEY,
        schoolId            TEXT,
        school_id           TEXT,
        name                TEXT,
        email               TEXT,
        enrollmentNo        TEXT,
        role                TEXT,
        is_active           INTEGER DEFAULT 1,
        must_reset_password INTEGER DEFAULT 0,
        passwordSalt        TEXT,
        passwordHash        TEXT,
        deleted_at          TEXT,
        created_at          TEXT,
        updated_at          TEXT,
        _synced             INTEGER DEFAULT 0,
        _synced_at          TEXT
      )
    `).catch((err) => console.warn("[database] users:", err.message));

    // ── Teacher assignments — needed before SyncManager migrations ────
    // ✅ FIX: SyncManager.syncLocalAssignmentsWithServer() queries this
    //    table during the first sync. If it doesn't exist yet the query
    //    throws and the whole sync aborts. Creating it here with IF NOT
    //    EXISTS is safe — SyncManager.migrateAssignmentsTable() will
    //    just add the missing columns via safeAddColumn.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS teacher_assignments (
        id           TEXT PRIMARY KEY,
        schoolId     TEXT,
        school_id    TEXT,
        teacherId    TEXT,
        teacher_id   TEXT,
        classId      TEXT,
        class_id     TEXT,
        subjectId    TEXT,
        subject_id   TEXT,
        teacher_json TEXT,
        class_json   TEXT,
        subject_json TEXT,
        deleted_at   TEXT,
        created_at   TEXT,
        updated_at   TEXT,
        _synced      INTEGER DEFAULT 0,
        _synced_at   TEXT
      )
    `).catch((err) => console.warn("[database] teacher_assignments:", err.message));

    // ── School info cache ─────────────────────────────────────────────
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS school_info (
        id         TEXT PRIMARY KEY,
        name       TEXT,
        logo       TEXT,
        email      TEXT,
        phone      TEXT,
        address    TEXT,
        city       TEXT,
        state      TEXT,
        country    TEXT,
        website    TEXT,
        motto      TEXT,
        code       TEXT,
        updated_at TEXT
      )
    `).catch((err) => console.warn("[database] school_info:", err.message));

    // ── Indexes ───────────────────────────────────────────────────────
    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_exams_school         ON exams(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_exams_class          ON exams(classId)",
      "CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam   ON exam_subjects(examId)",
      "CREATE INDEX IF NOT EXISTS idx_exam_subjects_subj   ON exam_subjects(subjectId)",
      "CREATE INDEX IF NOT EXISTS idx_scores_exam          ON student_scores(examId)",
      "CREATE INDEX IF NOT EXISTS idx_scores_student       ON student_scores(studentId)",
      "CREATE INDEX IF NOT EXISTS idx_scores_class         ON student_scores(classId)",
      "CREATE INDEX IF NOT EXISTS idx_results_exam         ON result_summaries(examId)",
      "CREATE INDEX IF NOT EXISTS idx_results_student      ON result_summaries(studentId)",
      "CREATE INDEX IF NOT EXISTS idx_classes_school       ON classes(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_students_class       ON students(classId)",
      "CREATE INDEX IF NOT EXISTS idx_students_school      ON students(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_students_user        ON students(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_subjects_class       ON subjects(classId)",
      "CREATE INDEX IF NOT EXISTS idx_subjects_school      ON subjects(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role)",
      "CREATE INDEX IF NOT EXISTS idx_users_school         ON users(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email)",
      "CREATE INDEX IF NOT EXISTS idx_ta_teacher           ON teacher_assignments(teacherId)",
      "CREATE INDEX IF NOT EXISTS idx_ta_class             ON teacher_assignments(classId)",
      "CREATE INDEX IF NOT EXISTS idx_ta_subject           ON teacher_assignments(subjectId)",
      "CREATE INDEX IF NOT EXISTS idx_ta_synced            ON teacher_assignments(_synced)",
    ];
    for (const idx of indexes) {
      await db.execAsync(idx).catch(() => {});
    }

    console.log(`[database] SQLite opened: ${DB_NAME}`);
    _db = db;
    return _db;

  } catch (err) {
    // ✅ FIX: clear _initPromise on failure so the next call retries
    //    rather than returning a rejected promise forever.
    _initPromise = null;
    console.error("[database] Failed to open database:", err.message);
    throw err;
  }
};

/**
 * Close the database connection.
 * Call this only during app cleanup — not during normal operation.
 */
export const closeDatabase = async () => {
  if (_db) {
    await _db.closeAsync().catch(() => {});
    _db           = null;
    _initPromise  = null;
    console.log("[database] SQLite closed");
  }
};

/**
 * Reset the singleton (useful for testing).
 * Does NOT close the database — call closeDatabase() first if needed.
 */
export const resetDatabaseSingleton = () => {
  _db          = null;
  _initPromise = null;
};