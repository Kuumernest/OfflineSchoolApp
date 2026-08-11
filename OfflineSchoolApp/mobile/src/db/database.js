// src/db/database.js
"use strict";

import * as SQLite from "expo-sqlite";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DATABASE SINGLETON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns the shared expo-sqlite database instance.
 * Uses the modern expo-sqlite v2 API (openDatabaseAsync).
 *
 * All core tables are created here on first open so every screen
 * that calls getDatabase() is guaranteed to have the schema ready.
 *
 * Design decisions:
 *   - Singleton pattern — only one connection ever open
 *   - WAL journal mode for better concurrent read performance
 *   - Foreign keys enabled
 *   - All tables use TEXT primary keys (UUID strings) to match MongoDB _id
 *   - Soft delete via deleted_at column throughout
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DB_NAME = "schoolapp.db";

/** @type {import('expo-sqlite').SQLiteDatabase | null} */
let _db = null;

/**
 * Open (or return cached) SQLite database.
 * Safe to call multiple times — always returns the same instance.
 *
 * @returns {Promise<import('expo-sqlite').SQLiteDatabase>}
 */
export const getDatabase = async () => {
  if (_db) return _db;

  _db = await SQLite.openDatabaseAsync(DB_NAME);

  // Performance + safety pragmas
  await _db.execAsync("PRAGMA journal_mode = WAL;").catch(() => {});
  await _db.execAsync("PRAGMA foreign_keys = ON;").catch(() => {});

  // ── Schema ─────────────────────────────────────────────────────────────
  await _db.execAsync(`

    -- ── Exams ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS exams (
      id               TEXT PRIMARY KEY,
      schoolId         TEXT,
      classId          TEXT,
      className        TEXT,
      classIds         TEXT,          -- JSON array stored as string
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
    );

    -- ── Exam Subjects ─────────────────────────────────────────────────────
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
    );

    -- ── Student Scores ───────────────────────────────────────────────────
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
    );

    -- ── Result Summaries ─────────────────────────────────────────────────
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
    );

    -- ── Classes ──────────────────────────────────────────────────────────
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
    );

    -- ── Students ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS students (
      id          TEXT PRIMARY KEY,
      schoolId    TEXT,
      school_id   TEXT,
      classId     TEXT,
      class_id    TEXT,
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
    );

    -- ── Report Templates ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS report_templates (
      id          TEXT PRIMARY KEY,
      schoolId    TEXT,
      school_id   TEXT,
      name        TEXT,
      html        TEXT,
      css         TEXT,
      is_default  INTEGER DEFAULT 0,
      version     INTEGER DEFAULT 1,
      variables   TEXT,           -- JSON array stored as string
      _synced     INTEGER DEFAULT 1,
      deleted_at  TEXT,
      updated_at  TEXT,
      created_at  TEXT
    );

    -- ── Generated Reports ────────────────────────────────────────────────
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
    );

    -- ── Subjects ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS subjects (
      id          TEXT PRIMARY KEY,
      schoolId    TEXT,
      school_id   TEXT,
      classId     TEXT,
      class_id    TEXT,
      name        TEXT,
      code        TEXT,
      is_active   INTEGER DEFAULT 1,
      deleted_at  TEXT,
      created_at  TEXT,
      updated_at  TEXT
    );

    -- ── Teachers ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS teachers (
      id          TEXT PRIMARY KEY,
      schoolId    TEXT,
      school_id   TEXT,
      name        TEXT,
      email       TEXT,
      is_active   INTEGER DEFAULT 1,
      deleted_at  TEXT,
      created_at  TEXT,
      updated_at  TEXT
    );

  `).catch((err) => {
    console.warn("[database] Schema creation error:", err.message);
  });

  console.log(`[database] SQLite opened: ${DB_NAME}`);
  return _db;
};

/**
 * Close the database connection.
 * Call this only during app cleanup — not during normal operation.
 */
export const closeDatabase = async () => {
  if (_db) {
    await _db.closeAsync().catch(() => {});
    _db = null;
    console.log("[database] SQLite closed");
  }
};

/**
 * Reset the singleton (useful for testing).
 * Does NOT close the database — call closeDatabase() first if needed.
 */
export const resetDatabaseSingleton = () => {
  _db = null;
};