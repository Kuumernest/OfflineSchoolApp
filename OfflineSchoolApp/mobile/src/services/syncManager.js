// src/services/syncManager.js
"use strict";

import api                              from "./api";
import { setRetryContext, clearRetryContext } from "./api";
import NetInfo                          from "@react-native-community/netinfo";
import { getDatabase }                  from "../db/database";
import * as SecureStore                 from "expo-secure-store";
import {
  safeAddColumn,
  withFkOff,
  withTransaction,
  NOT_DELETED,
  IS_DELETED,
}                                       from "../db/dbHelpers";
import { generateUUID }                 from "../utils/idHelpers";
import {
  isAuthenticated,
  getCurrentAuth,
  hasRole,
}                                       from "../utils/authHelpers";
import { API }                          from "./apiEndpoints";



// ═════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

const LAST_SYNC_KEY      = "sync_last_timestamp";
const QUIZ_LAST_SYNC_KEY = "quiz_last_sync";
const EPOCH              = "1970-01-01T00:00:00.000Z";

const NOT_DELETED_TA   = "(ta.deleted_at IS NULL OR ta.deleted_at = '')";
const NOT_DELETED_Q    = "(q.deleted_at  IS NULL OR q.deleted_at  = '')";
const NOT_DELETED_BARE = "(deleted_at    IS NULL OR deleted_at    = '')";

// ═════════════════════════════════════════════════════════════════════════════
// SYNC MANAGER CLASS
// ═════════════════════════════════════════════════════════════════════════════

class SyncManagerClass {
  constructor() {
    this.isSyncing             = false;
    this.lastSync              = null;
    this.syncInterval          = null;
    this._initTimeout          = null;
    this.SYNC_INTERVAL_MS      = 30_000;
    this._staleSubjectsCleared = false;
    this._destroyed            = false;
    this._migrationsDone       = false;
    this.MAX_RETRIES           = 3;
    this.RETRY_DELAY_MS        = 1_000;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — RETRY HELPER
  // ═══════════════════════════════════════════════════════════════════════════

  async _withRetry(label, fn, attempt = 1) {
    setRetryContext(attempt, this.MAX_RETRIES);

    try {
      const result = await fn();
      clearRetryContext();
      return result;
    } catch (err) {
      clearRetryContext();

      const status      = err?.response?.status;
      const isNetErr    = !err.response;
      const isServerErr = status >= 500 && status <= 599;
      const isTimeout   =
        err.code === "ECONNABORTED" || err.message?.includes("timeout");

      // ── Hard-fail: auth errors and 4xx won't heal on retry ────────────
      // ✅ NOTE: 401 is now handled by api.js token refresh interceptor.
      //    If we still get a 401 here, the refresh already failed — don't retry.
      if (status === 401 || status === 403) throw err;
      if (status >= 400 && status < 500)   throw err;

      // ── Connectivity check before waiting ─────────────────────────────
      if (isNetErr && attempt > 1) {
        try {
          const net = await NetInfo.fetch();
          if (!net.isConnected) {
            console.warn(
              `[SyncManager] ${label} — device offline, stopping retries`
            );
            throw err;
          }
        } catch (netErr) {
          if (netErr === err) throw err;
        }
      }

      const shouldRetry =
        (isNetErr || isServerErr || isTimeout) &&
        attempt < this.MAX_RETRIES;

      if (shouldRetry) {
        const base   = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 300;
        const delay  = Math.min(base + jitter, 8_000);

        console.warn(
          `[SyncManager] ${label} — attempt ${attempt} failed ` +
          `(${err.message}). Retrying in ${Math.round(delay)}ms…`
        );
        await new Promise((r) => setTimeout(r, delay));
        return this._withRetry(label, fn, attempt + 1);
      }

      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — AUTH HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _isUnauthenticated() {
    if (this._destroyed) return true;
    return !isAuthenticated();
  }

  isAdmin()   { return hasRole(["super_admin", "school_admin", "admin"]); }
  isTeacher() { return hasRole("teacher"); }
  isStudent() { return hasRole("student"); }

  async getSchoolId() {
    const { schoolId } = getCurrentAuth();
    if (schoolId) return schoolId;

    try {
      const userJson = await SecureStore.getItemAsync("user");
      if (userJson) {
        const parsed = JSON.parse(userJson);
        if (parsed?.schoolId) return parsed.schoolId;
      }
    } catch { /* ignore */ }

    try {
      const db  = await getDatabase();
      const row = await db.getFirstAsync(
        `SELECT schoolId FROM users
         WHERE role IN ('super_admin', 'school_admin', 'admin')
         LIMIT 1`
      );
      if (row?.schoolId) return row.schoolId;
    } catch (err) {
      console.warn("[SyncManager] getSchoolId failed:", err.message);
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3 — LAST-SYNC PERSISTENCE
  // ═══════════════════════════════════════════════════════════════════════════

  async getLastSync() {
    try { return (await SecureStore.getItemAsync(LAST_SYNC_KEY)) || EPOCH; }
    catch { return EPOCH; }
  }

  async setLastSync(timestamp) {
    try { await SecureStore.setItemAsync(LAST_SYNC_KEY, timestamp); }
    catch (err) {
      console.warn("[SyncManager] Could not persist lastSync:", err.message);
    }
    this.lastSync = timestamp;
  }

  async resetLastSync() {
    try { await SecureStore.deleteItemAsync(LAST_SYNC_KEY); } catch { /* ignore */ }
    this.lastSync = null;
  }

  async getLastQuizSync() {
    try { return (await SecureStore.getItemAsync(QUIZ_LAST_SYNC_KEY)) || EPOCH; }
    catch { return EPOCH; }
  }

  async setLastQuizSync(timestamp) {
    try { await SecureStore.setItemAsync(QUIZ_LAST_SYNC_KEY, timestamp); }
    catch (err) {
      console.warn("[SyncManager] Could not persist quiz lastSync:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4 — LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  async initialize() {
    if (this._initTimeout) { clearTimeout(this._initTimeout);  this._initTimeout = null; }
    if (this.syncInterval)  { clearInterval(this.syncInterval); this.syncInterval  = null; }

    this._destroyed            = false;
    this.isSyncing             = false;
    this._staleSubjectsCleared = false;

    if (!this._migrationsDone) {
      await this.runAllMigrations();
      this._migrationsDone = true;
    }

    this.startAutoSync();
    console.log("[SyncManager] Initialized");
  }

  destroy() {
    if (this._destroyed) return;

    if (this._initTimeout) { clearTimeout(this._initTimeout);  this._initTimeout = null; }
    if (this.syncInterval)  { clearInterval(this.syncInterval); this.syncInterval  = null; }

    this.isSyncing             = false;
    this._staleSubjectsCleared = false;
    this._destroyed            = true;

    console.log("[SyncManager] Destroyed");
  }

  startAutoSync() {
    if (this._destroyed) return;

    this._initTimeout = setTimeout(() => {
      if (!this._destroyed) this.syncAll().catch(console.warn);
    }, 2_000);

    this.syncInterval = setInterval(() => {
      if (!this._destroyed) this.syncAll().catch(console.warn);
    }, this.SYNC_INTERVAL_MS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — MIGRATIONS (unchanged — keeping all original migration code)
  // ═══════════════════════════════════════════════════════════════════════════

  async runAllMigrations() {
    console.log("[SyncManager] Running migrations…");
    const start = Date.now();
    try {
      await this.migrateLocalDatabase();
      await this.migrateUsersTable();
      await this.migrateClassesTable();
      await this.migrateSubjectsTable();
      await this.migrateAssignmentsTable();
      await this.migrateAnnouncementsTable();
      await this.migrateStudentApplicationsTable();
      await this.migrateQuizTables();
      console.log(`[SyncManager] Migrations complete (${Date.now() - start}ms)`);
    } catch (err) {
      console.warn("[SyncManager] Migration batch failed:", err.message);
    }
  }

  async migrateQuizTables() {
    const db = await getDatabase();

    const creates = [
      `CREATE TABLE IF NOT EXISTS question_categories (
        id          TEXT PRIMARY KEY,
        schoolId    TEXT,
        name        TEXT NOT NULL,
        description TEXT,
        parent_id   TEXT,
        is_active   INTEGER DEFAULT 1,
        deleted_at  TEXT,
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS questions (
        id            TEXT PRIMARY KEY,
        schoolId      TEXT,
        category_id   TEXT,
        question_text TEXT NOT NULL,
        question_type TEXT NOT NULL,
        media_url     TEXT,
        difficulty    TEXT DEFAULT 'medium',
        points        REAL  DEFAULT 1.0,
        explanation   TEXT,
        is_active     INTEGER DEFAULT 1,
        created_by    TEXT,
        deleted_at    TEXT,
        _synced       INTEGER DEFAULT 0,
        _synced_at    TEXT,
        created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS question_options (
        id            TEXT PRIMARY KEY,
        question_id   TEXT NOT NULL,
        option_text   TEXT NOT NULL,
        is_correct    INTEGER DEFAULT 0,
        match_pair    TEXT,
        display_order INTEGER DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS question_analytics (
        id            TEXT PRIMARY KEY,
        question_id   TEXT NOT NULL,
        times_seen    INTEGER DEFAULT 0,
        times_correct INTEGER DEFAULT 0,
        avg_time_secs REAL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS quizzes (
        id                  TEXT PRIMARY KEY,
        schoolId            TEXT,
        title               TEXT NOT NULL,
        description         TEXT,
        instructions        TEXT,
        subject_id          TEXT,
        class_id            TEXT,
        created_by          TEXT,
        time_limit_minutes  INTEGER,
        time_per_question   INTEGER,
        shuffle_questions   INTEGER DEFAULT 0,
        shuffle_options     INTEGER DEFAULT 0,
        questions_per_page  INTEGER DEFAULT 1,
        allow_backtrack     INTEGER DEFAULT 1,
        max_attempts        INTEGER DEFAULT 1,
        passing_score       REAL    DEFAULT 70,
        available_from      TEXT,
        available_until     TEXT,
        show_answers_after  TEXT    DEFAULT 'on_completion',
        show_score          INTEGER DEFAULT 1,
        show_explanation    INTEGER DEFAULT 1,
        is_published        INTEGER DEFAULT 0,
        deleted_at          TEXT,
        _synced             INTEGER DEFAULT 0,
        _synced_at          TEXT,
        created_at          TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at          TEXT DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS quiz_questions (
        id              TEXT PRIMARY KEY,
        quiz_id         TEXT NOT NULL,
        question_id     TEXT NOT NULL,
        display_order   INTEGER DEFAULT 0,
        points_override REAL
      )`,
      `CREATE TABLE IF NOT EXISTS quiz_attempts (
        id              TEXT PRIMARY KEY,
        quiz_id         TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        attempt_number  INTEGER DEFAULT 1,
        status          TEXT    DEFAULT 'in_progress',
        raw_score       REAL    DEFAULT 0,
        max_score       REAL    DEFAULT 0,
        percentage      REAL    DEFAULT 0,
        is_passed       INTEGER DEFAULT 0,
        started_at      TEXT,
        submitted_at    TEXT,
        time_taken_secs INTEGER,
        deleted_at      TEXT,
        _synced         INTEGER DEFAULT 0,
        _synced_at      TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS quiz_analytics (
        id             TEXT PRIMARY KEY,
        quiz_id        TEXT NOT NULL,
        total_attempts INTEGER DEFAULT 0,
        avg_score      REAL    DEFAULT 0,
        pass_rate      REAL    DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS attempt_answers (
        id          TEXT PRIMARY KEY,
        attempt_id  TEXT NOT NULL,
        question_id TEXT NOT NULL,
        time_taken  INTEGER,
        is_correct  INTEGER DEFAULT 0,
        points      REAL    DEFAULT 0,
        _synced     INTEGER DEFAULT 0,
        _synced_at  TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS attempt_answer_selections (
        id                TEXT PRIMARY KEY,
        attempt_answer_id TEXT NOT NULL,
        option_id         TEXT,
        text_response     TEXT,
        match_response    TEXT
      )`,
    ];

    for (const sql of creates) {
      await db.execAsync(sql).catch((err) =>
        console.warn("[migrateQuizTables] CREATE failed:", err.message)
      );
    }

    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_questions_school    ON questions(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_questions_category  ON questions(category_id)",
      "CREATE INDEX IF NOT EXISTS idx_questions_synced    ON questions(_synced)",
      "CREATE INDEX IF NOT EXISTS idx_q_options_question  ON question_options(question_id)",
      "CREATE INDEX IF NOT EXISTS idx_quizzes_school      ON quizzes(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_quizzes_class       ON quizzes(class_id)",
      "CREATE INDEX IF NOT EXISTS idx_quizzes_subject     ON quizzes(subject_id)",
      "CREATE INDEX IF NOT EXISTS idx_quizzes_synced      ON quizzes(_synced)",
      "CREATE INDEX IF NOT EXISTS idx_quiz_q_quiz         ON quiz_questions(quiz_id)",
      "CREATE INDEX IF NOT EXISTS idx_attempts_quiz       ON quiz_attempts(quiz_id)",
      "CREATE INDEX IF NOT EXISTS idx_attempts_user       ON quiz_attempts(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_attempts_synced     ON quiz_attempts(_synced)",
      "CREATE INDEX IF NOT EXISTS idx_answers_attempt     ON attempt_answers(attempt_id)",
      "CREATE INDEX IF NOT EXISTS idx_answer_sel_answer   ON attempt_answer_selections(attempt_answer_id)",
    ];
    for (const idx of indexes) {
      await db.execAsync(idx).catch(() => {});
    }

    const patches = {
      questions:       [["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"], ["deleted_at", "TEXT"]],
      quizzes:         [["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"], ["deleted_at", "TEXT"]],
      quiz_attempts:   [["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"], ["deleted_at", "TEXT"]],
      attempt_answers: [["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"]],
    };
    for (const [table, cols] of Object.entries(patches)) {
      for (const [col, def] of cols) {
        await safeAddColumn(db, table, col, def);
      }
    }

    console.log("[SyncManager] Quiz tables ready");
  }

  async migrateLocalDatabase() {
    const db = await getDatabase();
    try {
      const tableInfo = await db.getAllAsync("PRAGMA table_info(periods)");
      if (!tableInfo.length) return;

      const col = (name) => tableInfo.some((c) => c.name === name);

      if (col("_id") && !col("id")) {
        console.log("[SyncManager] Rebuilding periods table: _id → id");
        await db.execAsync("DROP TABLE IF EXISTS periods");
        await db.execAsync(`
          CREATE TABLE periods (
            id TEXT PRIMARY KEY, schoolId TEXT,
            name TEXT NOT NULL, starttime TEXT NOT NULL, endtime TEXT NOT NULL,
            sortorder INTEGER DEFAULT 0, isbreak INTEGER DEFAULT 0,
            isactive INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
            dirty INTEGER DEFAULT 0, operation TEXT, deletedat TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await db.execAsync(
          "CREATE INDEX IF NOT EXISTS idx_periods_dirty  ON periods(dirty)"
        ).catch(() => {});
        await db.execAsync(
          "CREATE INDEX IF NOT EXISTS idx_periods_school ON periods(schoolId)"
        ).catch(() => {});
        return;
      }

      if (col("id")) {
        await safeAddColumn(db, "periods", "dirty",     "INTEGER DEFAULT 0");
        await safeAddColumn(db, "periods", "operation", "TEXT");
        await safeAddColumn(db, "periods", "schoolId",  "TEXT");
      }
    } catch (err) {
      console.log("[SyncManager] Periods migration skipped:", err.message);
    }
  }

  async migrateUsersTable() {
    const db = await getDatabase();
    try {
      const info = await db.getAllAsync("PRAGMA table_info(users)");
      if (!info.length) return;

      await safeAddColumn(db, "users", "_synced",             "INTEGER DEFAULT 0");
      await safeAddColumn(db, "users", "_synced_at",          "TEXT");
      await safeAddColumn(db, "users", "deleted_at",          "TEXT");
      await safeAddColumn(db, "users", "is_active",           "INTEGER DEFAULT 1");
      await safeAddColumn(db, "users", "must_reset_password", "INTEGER DEFAULT 0");
      await safeAddColumn(db, "users", "created_at",          "TEXT DEFAULT NULL");
      await safeAddColumn(db, "users", "schoolId",            "TEXT");
      await safeAddColumn(db, "users", "school_id",           "TEXT");
      await safeAddColumn(db, "users", "passwordSalt",        "TEXT");
      await safeAddColumn(db, "users", "passwordHash",        "TEXT");
      await safeAddColumn(db, "users", "enrollmentNo",        "TEXT");
    } catch (err) {
      console.log("[SyncManager] users migration skipped:", err.message);
    }
  }

  async migrateClassesTable() {
    const db = await getDatabase();
    try {
      const info = await db.getAllAsync("PRAGMA table_info(classes)");
      if (!info.length) return;

      await safeAddColumn(db, "classes", "_synced",    "INTEGER DEFAULT 0");
      await safeAddColumn(db, "classes", "_synced_at", "TEXT");
      await safeAddColumn(db, "classes", "deleted_at", "TEXT");
      await safeAddColumn(db, "classes", "schoolId",   "TEXT");
      await safeAddColumn(db, "classes", "school_id",  "TEXT");
      await safeAddColumn(db, "classes", "level",      "TEXT");
      await safeAddColumn(db, "classes", "is_active",  "INTEGER DEFAULT 1");
      await safeAddColumn(db, "classes", "created_at", "TEXT DEFAULT NULL");
      await safeAddColumn(db, "classes", "updated_at", "TEXT");
    } catch (err) {
      console.log("[SyncManager] classes migration skipped:", err.message);
    }
  }

  async migrateSubjectsTable() {
    const db = await getDatabase();
    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS subjects (
          id           TEXT PRIMARY KEY,
          schoolId     TEXT,
          school_id    TEXT,
          classId      TEXT,
          class_id     TEXT,
          name         TEXT NOT NULL,
          code         TEXT,
          teacher_id   TEXT,
          teacher_name TEXT,
          deleted_at   TEXT,
          _synced      INTEGER DEFAULT 0,
          _synced_at   TEXT,
          created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await safeAddColumn(db, "subjects", "_synced",      "INTEGER DEFAULT 0");
      await safeAddColumn(db, "subjects", "_synced_at",   "TEXT");
      await safeAddColumn(db, "subjects", "deleted_at",   "TEXT");
      await safeAddColumn(db, "subjects", "schoolId",     "TEXT");
      await safeAddColumn(db, "subjects", "school_id",    "TEXT");
      await safeAddColumn(db, "subjects", "code",         "TEXT");
      await safeAddColumn(db, "subjects", "class_id",     "TEXT");
      await safeAddColumn(db, "subjects", "classId",      "TEXT");
      await safeAddColumn(db, "subjects", "teacher_id",   "TEXT");
      await safeAddColumn(db, "subjects", "teacher_name", "TEXT");
      await safeAddColumn(db, "subjects", "created_at",   "TEXT DEFAULT NULL");
      await safeAddColumn(db, "subjects", "updated_at",   "TEXT");
    } catch (err) {
      console.log("[SyncManager] subjects migration skipped:", err.message);
    }
  }

  async migrateAssignmentsTable() {
    const db = await getDatabase();
    try {
      const saInfo = await db.getAllAsync(
        "PRAGMA table_info(subject_assignments)"
      );
      if (saInfo.length) {
        await safeAddColumn(db, "subject_assignments", "_synced",    "INTEGER DEFAULT 0");
        await safeAddColumn(db, "subject_assignments", "_synced_at", "TEXT");
        await safeAddColumn(db, "subject_assignments", "deleted_at", "TEXT");
        await safeAddColumn(db, "subject_assignments", "schoolId",   "TEXT");
        await safeAddColumn(db, "subject_assignments", "created_at", "TEXT DEFAULT NULL");
        await safeAddColumn(db, "subject_assignments", "updated_at", "TEXT");
      }

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
      `);

      await safeAddColumn(db, "teacher_assignments", "_synced",      "INTEGER DEFAULT 0");
      await safeAddColumn(db, "teacher_assignments", "_synced_at",   "TEXT");
      await safeAddColumn(db, "teacher_assignments", "created_at",   "TEXT DEFAULT NULL");
      await safeAddColumn(db, "teacher_assignments", "teacher_id",   "TEXT");
      await safeAddColumn(db, "teacher_assignments", "class_id",     "TEXT");
      await safeAddColumn(db, "teacher_assignments", "subject_id",   "TEXT");
      await safeAddColumn(db, "teacher_assignments", "school_id",    "TEXT");
      await safeAddColumn(db, "teacher_assignments", "teacher_json", "TEXT");
      await safeAddColumn(db, "teacher_assignments", "class_json",   "TEXT");
      await safeAddColumn(db, "teacher_assignments", "subject_json", "TEXT");
    } catch (err) {
      console.log("[SyncManager] assignments migration skipped:", err.message);
    }
  }

  async migrateAnnouncementsTable() {
    const db = await getDatabase();
    try {
      const info     = await db.getAllAsync("PRAGMA table_info(announcements)");
      const existing = new Set(info.map((c) => c.name));

      const critical = ["id", "title", "body"];
      const broken   = info.length > 0 && critical.some((c) => !existing.has(c));
      if (broken) {
        await db.execAsync("DROP TABLE IF EXISTS announcements");
        existing.clear();
      }

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS announcements (
          id              TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          author_id       TEXT,
          author_name     TEXT,
          author_role     TEXT,
          school_id       TEXT,
          audience        TEXT DEFAULT 'all',
          target_classes  TEXT DEFAULT '[]',
          priority        TEXT DEFAULT 'normal',
          is_pinned       INTEGER DEFAULT 0,
          is_read         INTEGER DEFAULT 0,
          is_acknowledged INTEGER DEFAULT 0,
          is_active       INTEGER DEFAULT 1,
          version         INTEGER DEFAULT 1,
          publish_at      TEXT,
          expires_at      TEXT,
          deleted_at      TEXT,
          _synced         INTEGER DEFAULT 0,
          _synced_at      TEXT,
          _operation      TEXT,
          _read_pending   INTEGER DEFAULT 0,
          _ack_pending    INTEGER DEFAULT 0,
          created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const cols = [
        ["school_id",       "TEXT"],
        ["author_id",       "TEXT"],
        ["author_name",     "TEXT"],
        ["author_role",     "TEXT"],
        ["audience",        "TEXT DEFAULT 'all'"],
        ["target_classes",  "TEXT DEFAULT '[]'"],
        ["priority",        "TEXT DEFAULT 'normal'"],
        ["is_pinned",       "INTEGER DEFAULT 0"],
        ["is_read",         "INTEGER DEFAULT 0"],
        ["is_acknowledged", "INTEGER DEFAULT 0"],
        ["is_active",       "INTEGER DEFAULT 1"],
        ["version",         "INTEGER DEFAULT 1"],
        ["publish_at",      "TEXT"],
        ["expires_at",      "TEXT"],
        ["deleted_at",      "TEXT"],
        ["_synced",         "INTEGER DEFAULT 0"],
        ["_synced_at",      "TEXT"],
        ["_operation",      "TEXT"],
        ["_read_pending",   "INTEGER DEFAULT 0"],
        ["_ack_pending",    "INTEGER DEFAULT 0"],
      ];
      for (const [col, def] of cols) {
        await safeAddColumn(db, "announcements", col, def);
      }

      const indexes = [
        "CREATE INDEX IF NOT EXISTS idx_ann_school   ON announcements(school_id)",
        "CREATE INDEX IF NOT EXISTS idx_ann_audience ON announcements(audience)",
        "CREATE INDEX IF NOT EXISTS idx_ann_author   ON announcements(author_id)",
        "CREATE INDEX IF NOT EXISTS idx_ann_synced   ON announcements(_synced)",
        "CREATE INDEX IF NOT EXISTS idx_ann_active   ON announcements(is_active, deleted_at)",
        "CREATE INDEX IF NOT EXISTS idx_ann_read     ON announcements(is_read)",
        "CREATE INDEX IF NOT EXISTS idx_ann_pending  ON announcements(_read_pending, _ack_pending)",
        "CREATE INDEX IF NOT EXISTS idx_ann_pinned   ON announcements(is_pinned, created_at)",
      ];
      for (const idx of indexes) {
        await db.execAsync(idx).catch(() => {});
      }

      console.log("[SyncManager] Announcements table ready");
    } catch (err) {
      console.log("[SyncManager] announcements migration skipped:", err.message);
    }
  }

  async migrateStudentApplicationsTable() {
    const db = await getDatabase();
    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS student_applications (
          id            TEXT PRIMARY KEY,
          school_id     TEXT,
          student_name  TEXT,
          guardian_name TEXT,
          email         TEXT,
          phone         TEXT,
          grade         TEXT,
          status        TEXT DEFAULT 'pending',
          notes         TEXT,
          deleted_at    TEXT,
          _synced       INTEGER DEFAULT 0,
          _synced_at    TEXT,
          _operation    TEXT,
          created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await safeAddColumn(db, "student_applications", "school_id",  "TEXT");
      await safeAddColumn(db, "student_applications", "deleted_at", "TEXT");
      await safeAddColumn(db, "student_applications", "_synced",    "INTEGER DEFAULT 0");
      await safeAddColumn(db, "student_applications", "_synced_at", "TEXT");
      await safeAddColumn(db, "student_applications", "_operation", "TEXT");

      await db.execAsync(
        "CREATE INDEX IF NOT EXISTS idx_apps_school ON student_applications(school_id)"
      ).catch(() => {});
      await db.execAsync(
        "CREATE INDEX IF NOT EXISTS idx_apps_status ON student_applications(status)"
      ).catch(() => {});
      await db.execAsync(
        "CREATE INDEX IF NOT EXISTS idx_apps_synced ON student_applications(_synced)"
      ).catch(() => {});
    } catch (err) {
      console.log(
        "[SyncManager] student_applications migration skipped:", err.message
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — MAIN SYNC ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════════════════════

  async syncAll() {
    if (this._destroyed)    { console.log("[SyncManager] Destroyed — skipping sync");         return; }
    if (this.isSyncing)     { console.log("[SyncManager] Already syncing — skipping");        return; }
    if (!isAuthenticated()) { console.log("[SyncManager] Not authenticated — skipping sync"); return; }

    const { acquireSyncLock, releaseSyncLock } = require("../store/auth.store");
    if (!acquireSyncLock()) {
      console.log("[SyncManager] Global sync lock held — skipping");
      return;
    }

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      releaseSyncLock();
      console.log("[SyncManager] Offline — skipping sync");
      return;
    }

    const { user } = getCurrentAuth();
    if (user?.mustResetPassword) {
      releaseSyncLock();
      console.log("[SyncManager] mustResetPassword — skipping sync");
      return;
    }

    this.isSyncing = true;
    console.log("[SyncManager] Starting full sync…");

    try {
      if (this._isUnauthenticated()) {
        console.log("[SyncManager] User logged out — aborting");
        return;
      }

      if (!this.isStudent()) {
        await this.markOrphanedRecordsAsSynced();
      } else if (!this._staleSubjectsCleared) {
        await this.repairClassIds();
        await this.clearStaleSubjectsAndRepull();
        this._staleSubjectsCleared = true;
      }

      if (this._isUnauthenticated()) return;
      await this.pushChanges();
      if (this._isUnauthenticated()) return;
      await this.pullChanges();
      if (this._isUnauthenticated()) return;
      await this.syncQuizData();

      await this.setLastSync(new Date().toISOString());
      console.log("[SyncManager] Sync completed at", this.lastSync);
    } catch (err) {
      console.warn("[SyncManager] Sync incomplete:", err.message);
    } finally {
      this.isSyncing = false;
      releaseSyncLock();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — REPAIR HELPERS (unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

  async repairClassIds() {
    const db       = await getDatabase();
    const schoolId = await this.getSchoolId();
    if (!schoolId) return;

    await withFkOff(db, async () => {
      try {
        const response = await this._withRetry(
          "repairClassIds",
          () => api.get(API.admin.classes.list, { params: { schoolId } })
        );

        const serverClasses =
          response.data?.classes ||
          response.data?.data    ||
          (Array.isArray(response.data) ? response.data : []);

        if (!serverClasses.length) return;

        const serverIdByName = {};
        for (const sc of serverClasses) {
          const sid  = String(sc._id || sc.id || "");
          const name = (sc.name || "").trim().toLowerCase();
          if (sid && name) serverIdByName[name] = sid;
        }

        const localClasses = await db
          .getAllAsync("SELECT id, name FROM classes")
          .catch(() => []);
        let fixed = 0;

        for (const local of localClasses) {
          const key      = (local.name || "").trim().toLowerCase();
          const serverId = serverIdByName[key];
          if (!serverId) continue;
          if (local.id === serverId) {
            await db
              .runAsync("UPDATE classes SET _synced = 1 WHERE id = ?", [local.id])
              .catch(() => {});
            continue;
          }
          await this._reconcileClassId(db, local.id, serverId);
          fixed++;
        }

        console.log(
          fixed > 0
            ? `[SyncManager] repairClassIds: fixed ${fixed} class ID(s)`
            : "[SyncManager] repairClassIds: all IDs already correct"
        );
      } catch (err) {
        console.warn("[SyncManager] repairClassIds failed:", err.message);
      }
    });
  }

  async clearStaleSubjectsAndRepull() {
    const db = await getDatabase();

    await withFkOff(db, async () => {
      try {
        const allClasses    = await db.getAllAsync("SELECT id FROM classes").catch(() => []);
        const knownClassIds = new Set(allClasses.map((c) => c.id));
        const allSubjects   = await db
          .getAllAsync("SELECT id, class_id, classId FROM subjects")
          .catch(() => []);

        if (!allSubjects.length) return;

        const stale = allSubjects.filter((s) => {
          const cid = s.class_id || s.classId;
          return !cid || !knownClassIds.has(cid);
        });

        if (!stale.length) {
          console.log("[SyncManager] All subjects have valid class references");
          return;
        }

        console.log(`[SyncManager] Clearing ${stale.length} stale subject(s)…`);
        for (const s of stale) {
          await db.runAsync("DELETE FROM subjects WHERE id = ?", [s.id]).catch(() => {});
        }

        await this.resetLastSync();
        console.log("[SyncManager] lastSync reset — next pull fetches fresh data");
      } catch (err) {
        console.warn("[SyncManager] clearStaleSubjectsAndRepull failed:", err.message);
      }
    });
  }

  async markOrphanedRecordsAsSynced() {
    const db = await getDatabase();
    const ts = new Date().toISOString();
    try {
      const classR = await db
        .runAsync(
          "UPDATE classes  SET _synced = 1, _synced_at = ? WHERE (_synced = 0 OR _synced IS NULL)",
          [ts]
        )
        .catch(() => ({ changes: 0 }));
      const subjectR = await db
        .runAsync(
          "UPDATE subjects SET _synced = 1, _synced_at = ? WHERE (_synced = 0 OR _synced IS NULL)",
          [ts]
        )
        .catch(() => ({ changes: 0 }));

      const cc = classR?.changes   ?? 0;
      const sc = subjectR?.changes ?? 0;
      if (cc > 0 || sc > 0) {
        console.log(
          `[SyncManager] Orphaned records marked synced — classes: ${cc}, subjects: ${sc}`
        );
      }
    } catch (err) {
      console.warn("[SyncManager] markOrphanedRecordsAsSynced failed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8-16 — PUSH (unchanged from original)
  // ═══════════════════════════════════════════════════════════════════════════

  async pushChanges() {
    if (this._isUnauthenticated()) return;

    if (this.isAdmin()) {
      const classIdMap = await this.pushUnsyncedClasses();
      await this.pushUnsyncedSubjects(classIdMap);
    }

    const tasks = [
      this.pushDirtyPeriods(),
      this.pushLocalAnnouncements(),
    ];

    if (this.isAdmin()) {
      tasks.push(this.pushLocalTeachers());
      tasks.push(this.syncLocalAssignmentsWithServer());
      tasks.push(this.pushLocalStudentApplications());
    }

    await Promise.allSettled(tasks);
    if (this.isAdmin()) await this.pushDeletedRecords();
  }

  async pushDeletedRecords() {
    if (this._isUnauthenticated()) return;

    const db = await getDatabase();
    const ts = new Date().toISOString();

    const sections = [
      { table: "users",               endpoint: API.admin.teachers.list,    role: "teacher" },
      { table: "subjects",            endpoint: API.admin.subjects.list,    role: null       },
      { table: "classes",             endpoint: API.admin.classes.list,     role: null       },
      { table: "teacher_assignments", endpoint: API.admin.assignments.list, role: null       },
      { table: "quizzes",             endpoint: API.quiz.list,              role: null       },
      { table: "questions",           endpoint: API.quiz.questions,         role: null       },
    ];

    for (const { table, endpoint, role } of sections) {
      try {
        let whereClause = `${IS_DELETED} AND (_synced = 0 OR _synced IS NULL)`;
        let params      = [];

        if (role) {
          whereClause = `${IS_DELETED} AND role = ? AND (_synced = 0 OR _synced IS NULL)`;
          params      = [role];
        }

        const rows = await db
          .getAllAsync(`SELECT id FROM ${table} WHERE ${whereClause}`, params)
          .catch(() => []);

        for (const row of rows) {
          try {
            await this._withRetry(
              `DELETE ${table}/${row.id}`,
              () => api.delete(`${endpoint}/${row.id}`)
            );
          } catch (err) {
            if (err?.response?.status !== 404) {
              console.warn(
                `[SyncManager] Delete ${table}/${row.id} failed:`, err.message
              );
              continue;
            }
          }
          await db
            .runAsync(
              `UPDATE ${table} SET _synced = 1, _synced_at = ? WHERE id = ?`,
              [ts, row.id]
            )
            .catch(() => {});
        }
      } catch (err) {
        console.warn(`[SyncManager] pushDeletedRecords (${table}):`, err.message);
      }
    }

    try {
      const deleted = await db
        .getAllAsync(
          "SELECT id FROM periods WHERE deletedat IS NOT NULL AND deletedat != '' AND dirty = 1"
        )
        .catch(() => []);

      for (const p of deleted) {
        try {
          await this._withRetry(
            `DELETE period/${p.id}`,
            () => api.delete(`${API.admin.periods.list}/${p.id}`)
          );
        } catch (err) {
          if (err?.response?.status !== 404) {
            console.warn(`[SyncManager] Delete period/${p.id} failed:`, err.message);
            continue;
          }
        }
        await db
          .runAsync("UPDATE periods SET dirty = 0, operation = NULL WHERE id = ?", [p.id])
          .catch(() => {});
      }
    } catch (err) {
      console.warn("[SyncManager] pushDeletedRecords (periods):", err.message);
    }
  }

  async pushDirtyPeriods() {
    if (this._isUnauthenticated()) return;

    const db = await getDatabase();
    let dirty = [];

    try {
      dirty = await db.getAllAsync(
        "SELECT * FROM periods WHERE dirty = 1 AND (deletedat IS NULL OR deletedat = '')"
      );
    } catch { return; }

    if (!dirty.length) return;

    const schoolId = await this.getSchoolId();
    console.log(`[SyncManager] Pushing ${dirty.length} dirty period(s)…`);

    const changes = {
      periods: dirty.map((p) => ({
        id:        p.id,
        operation: p.operation || "create",
        data: {
          id:        p.id,
          name:      p.name,
          startTime: p.starttime,
          endTime:   p.endtime,
          isBreak:   p.isbreak  === 1,
          sortOrder: p.sortorder,
          isActive:  p.isactive !== 0,
          schoolId:  p.schoolId || schoolId,
        },
      })),
    };

    try {
      const response = await this._withRetry(
        "pushDirtyPeriods",
        () => api.post(API.sync.push, { changes })
      );
      if (response.data?.success) {
        for (const p of dirty) {
          await db.runAsync(
            "UPDATE periods SET dirty = 0, operation = NULL WHERE id = ?", [p.id]
          );
        }
        console.log("[SyncManager] Periods push complete");
      }
    } catch (err) {
      console.warn("[SyncManager] pushDirtyPeriods failed:", err.message);
    }
  }

  async _reconcileClassId(db, localId, serverId) {
    const ts = new Date().toISOString();
    if (localId === serverId) {
      await db
        .runAsync(
          "UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?",
          [ts, localId]
        )
        .catch(() => {});
      return;
    }

    try {
      const existing = await db
        .getFirstAsync("SELECT id FROM classes WHERE id = ?", [serverId])
        .catch(() => null);

      const cascade = async () => {
        await db.runAsync(
          "UPDATE subjects SET class_id = ?, classId = ? WHERE class_id = ? OR classId = ?",
          [serverId, serverId, localId, localId]
        ).catch(() => {});
        await db.runAsync(
          "UPDATE students SET class_id = ? WHERE class_id = ?",
          [serverId, localId]
        ).catch(() => {});
        await db.runAsync(
          "UPDATE teacher_assignments SET classId = ?, class_id = ? WHERE classId = ? OR class_id = ?",
          [serverId, serverId, localId, localId]
        ).catch(() => {});
        await db.runAsync(
          "UPDATE quizzes SET class_id = ? WHERE class_id = ?",
          [serverId, localId]
        ).catch(() => {});
      };

      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          if (existing) {
            await cascade();
            await db.runAsync(
              "UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?",
              [ts, serverId]
            );
            await db.runAsync("DELETE FROM classes WHERE id = ?", [localId]).catch(() => {});
          } else {
            await db.runAsync(
              "UPDATE classes SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?",
              [serverId, ts, localId]
            );
            await cascade();
          }
        });
      });
    } catch (err) {
      console.error(
        `[SyncManager] _reconcileClassId (${localId} → ${serverId}):`, err.message
      );
      await db
        .runAsync(
          "UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?",
          [ts, localId]
        )
        .catch(() => {});
    }
  }

  async pushUnsyncedClasses() {
    if (this._isUnauthenticated()) return {};

    const db          = await getDatabase();
    const schoolId    = await this.getSchoolId();
    const syncedIdMap = {};

    await withFkOff(db, async () => {
      try {
        const unsynced = await db
          .getAllAsync(
            `SELECT * FROM classes
             WHERE (_synced = 0 OR _synced IS NULL) AND ${NOT_DELETED_BARE}`
          )
          .catch(() => []);

        if (!unsynced.length) return;
        console.log(`[SyncManager] Pushing ${unsynced.length} unsynced class(es)…`);

        for (const cls of unsynced) {
          try {
            const response = await this._withRetry(
              `pushClass "${cls.name}"`,
              () => api.post(API.admin.classes.list, {
                id:       cls.id,
                name:     cls.name,
                level:    cls.level || null,
                schoolId: cls.schoolId || cls.school_id || schoolId,
              })
            );

            const raw =
              response.data?._id        || response.data?.id        ||
              response.data?.serverId   ||
              response.data?.class?._id || response.data?.class?.id ||
              response.data?.data?._id  || response.data?.data?.id  || null;
            const finalId = raw ? String(raw) : cls.id;

            syncedIdMap[cls.id] = finalId;
            await this._reconcileClassId(db, cls.id, finalId);
          } catch (err) {
            if (err?.response?.status === 409) {
              const data     = err.response.data;
              const raw      =
                data?.class?._id || data?.class?.id ||
                data?.serverId   || data?._id        || data?.id || null;
              const serverId = raw ? String(raw) : null;

              if (serverId) {
                syncedIdMap[cls.id] = serverId;
                await this._reconcileClassId(db, cls.id, serverId);
              } else {
                syncedIdMap[cls.id] = cls.id;
                await db
                  .runAsync(
                    "UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?",
                    [new Date().toISOString(), cls.id]
                  )
                  .catch(() => {});
              }
            } else {
              console.warn(`[SyncManager] pushClass "${cls.name}" failed:`, err.message);
            }
          }
        }
      } catch (err) {
        console.warn("[SyncManager] pushUnsyncedClasses failed:", err.message);
      }
    });

    return syncedIdMap;
  }

  async pushUnsyncedSubjects(freshClassIdMap = {}) {
    if (this._isUnauthenticated()) return;

    const db       = await getDatabase();
    const schoolId = await this.getSchoolId();

    await withFkOff(db, async () => {
      try {
        const unsynced = await db
          .getAllAsync(
            `SELECT * FROM subjects
             WHERE (_synced = 0 OR _synced IS NULL) AND ${NOT_DELETED_BARE}`
          )
          .catch(() => []);

        if (!unsynced.length) return;
        console.log(`[SyncManager] Pushing ${unsynced.length} unsynced subject(s)…`);

        for (const subj of unsynced) {
          try {
            let classId = subj.class_id || subj.classId || null;
            if (!classId) {
              console.warn(`[SyncManager] Subject "${subj.name}" has no classId — skipping`);
              continue;
            }
            if (freshClassIdMap[classId]) classId = freshClassIdMap[classId];

            const classRow = await db
              .getFirstAsync("SELECT id, _synced FROM classes WHERE id = ?", [classId])
              .catch(() => null);

            if (!classRow?._synced) {
              console.log(`[SyncManager] Subject "${subj.name}" skipped — class not confirmed`);
              continue;
            }

            const response = await this._withRetry(
              `pushSubject "${subj.name}"`,
              () => api.post(API.admin.subjects.list, {
                id:       subj.id,
                name:     subj.name,
                code:     subj.code || "",
                classId,
                schoolId: subj.schoolId || subj.school_id || schoolId,
              })
            );

            const raw =
              response.data?._id          || response.data?.id          ||
              response.data?.subject?._id || response.data?.subject?.id || null;
            const finalId = raw ? String(raw) : subj.id;
            const ts      = new Date().toISOString();

            if (finalId !== subj.id) {
              await db.runAsync(
                "UPDATE subjects SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?",
                [finalId, ts, subj.id]
              );
            } else {
              await db.runAsync(
                "UPDATE subjects SET _synced = 1, _synced_at = ? WHERE id = ?",
                [ts, subj.id]
              );
            }
          } catch (err) {
            if (err?.response?.status !== 409 && err?.response?.status !== 422) {
              console.warn(`[SyncManager] pushSubject "${subj.name}" failed:`, err.message);
            }
          }
        }
      } catch (err) {
        console.warn("[SyncManager] pushUnsyncedSubjects failed:", err.message);
      }
    });
  }

  async pushLocalTeachers() {
    if (this._isUnauthenticated()) return;

    const db       = await getDatabase();
    const schoolId = await this.getSchoolId();

    try {
      const unsynced = await db
        .getAllAsync(
          `SELECT id, name, email, role, schoolId, school_id, created_at
           FROM users
           WHERE role = 'teacher'
             AND (_synced = 0 OR _synced IS NULL)
             AND ${NOT_DELETED_BARE}`
        )
        .catch(() => []);

      if (!unsynced.length) return;
      console.log(`[SyncManager] Pushing ${unsynced.length} unsynced teacher(s)…`);

      for (const teacher of unsynced) {
        try {
          const response = await this._withRetry(
            `pushTeacher "${teacher.name}"`,
            () => api.post(API.admin.teachers.list, {
              id:       teacher.id,
              name:     teacher.name,
              email:    teacher.email,
              role:     "teacher",
              schoolId: teacher.schoolId || teacher.school_id || schoolId,
            })
          );

          const raw      = response.data?.teacher || response.data?.user || response.data?.data;
          const serverId = raw?._id || raw?.id || null;

          if (serverId && String(serverId) !== teacher.id) {
            await this._replaceTeacherId(db, teacher.id, String(serverId));
          } else {
            await db.runAsync(
              "UPDATE users SET _synced = 1, _synced_at = ? WHERE id = ?",
              [new Date().toISOString(), teacher.id]
            );
          }
        } catch (err) {
          if (err?.response?.status === 409) {
            await this._reconcileTeacherByEmail(db, teacher, schoolId);
          } else {
            console.warn(`[SyncManager] pushTeacher "${teacher.name}" failed:`, err.message);
          }
        }
      }
    } catch (err) {
      console.warn("[SyncManager] pushLocalTeachers failed:", err.message);
    }
  }

  async _reconcileTeacherByEmail(db, localTeacher, schoolId) {
    try {
      const response = await this._withRetry(
        `reconcileTeacher "${localTeacher.email}"`,
        () => api.get(API.admin.teachers.list, {
          params: { email: localTeacher.email, schoolId: localTeacher.schoolId || schoolId },
        })
      );

      const list =
        response.data?.teachers ||
        response.data?.data     ||
        (Array.isArray(response.data) ? response.data : null);

      const serverTeacher = list
        ? list.find((t) => t.email?.toLowerCase() === localTeacher.email?.toLowerCase())
        : response.data?.teacher || response.data || null;

      if (!serverTeacher) {
        await db.runAsync(
          "UPDATE users SET _synced = 1, _synced_at = ? WHERE id = ?",
          [new Date().toISOString(), localTeacher.id]
        );
        return;
      }

      const serverId = String(serverTeacher._id || serverTeacher.id || "");
      if (!serverId || serverId === localTeacher.id) {
        await db.runAsync(
          "UPDATE users SET _synced = 1, _synced_at = ? WHERE id = ?",
          [new Date().toISOString(), localTeacher.id]
        );
        return;
      }

      await this._replaceTeacherId(db, localTeacher.id, serverId);
    } catch (err) {
      console.warn("[SyncManager] _reconcileTeacherByEmail failed:", err.message);
      await db
        .runAsync(
          "UPDATE users SET _synced = 1, _synced_at = ? WHERE id = ?",
          [new Date().toISOString(), localTeacher.id]
        )
        .catch(() => {});
    }
  }

  async _replaceTeacherId(db, oldId, newId) {
    const ts = new Date().toISOString();
    try {
      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          const alreadyExists = await db
            .getFirstAsync("SELECT id FROM users WHERE id = ?", [newId])
            .catch(() => null);

          if (alreadyExists) {
            await db.runAsync("DELETE FROM users WHERE id = ?", [oldId]);
          } else {
            await db.runAsync(
              "UPDATE users SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?",
              [newId, ts, oldId]
            );
          }

          const cascades = [
            ["teacher_assignments", "teacherId"],
            ["teacher_assignments", "teacher_id"],
            ["subject_assignments", "teacher_id"],
            ["subjects",            "teacher_id"],
            ["timetable",           "teacher_id"],
            ["quizzes",             "created_by"],
            ["questions",           "created_by"],
            ["announcements",       "author_id"],
          ];
          for (const [table, col] of cascades) {
            await db
              .runAsync(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [newId, oldId])
              .catch(() => {});
          }
        });
      });
    } catch (err) {
      console.error(`[SyncManager] _replaceTeacherId (${oldId} → ${newId}):`, err.message);
    }
  }

  async syncLocalAssignmentsWithServer() {
    if (this._isUnauthenticated()) return;

    const db       = await getDatabase();
    const schoolId = await this.getSchoolId();
    const ts       = new Date().toISOString();

    try {
      const response = await this._withRetry(
        "syncAssignments/GET",
        () => api.get(API.admin.assignments.list)
      );

      const serverAssignments =
        response.data?.assignments ||
        response.data?.data        ||
        (Array.isArray(response.data) ? response.data : []);

      for (const a of serverAssignments) {
        const serverId = String(a._id || a.id || "");
        if (!serverId) continue;

        const teacherObj = a.teacher && typeof a.teacher === "object" ? a.teacher : null;
        const classObj   = a.class   && typeof a.class   === "object" ? a.class   : null;
        const subjectObj = a.subject && typeof a.subject === "object" ? a.subject : null;

        const teacherId =
          teacherObj?._id?.toString() ||
          teacherObj?.id?.toString()  ||
          (typeof a.teacher === "string" ? a.teacher : null) ||
          a.teacherId || null;

        const classId =
          classObj?._id?.toString() ||
          classObj?.id?.toString()  ||
          (typeof a.class === "string" ? a.class : null) ||
          a.classId || null;

        const subjectId =
          subjectObj?._id?.toString() ||
          subjectObj?.id?.toString()  ||
          (typeof a.subject === "string" ? a.subject : null) ||
          a.subjectId || null;

        if (!subjectId) continue;

        let teacherName  = teacherObj?.name  || null;
        let teacherEmail = teacherObj?.email || null;

        if (!teacherName && teacherId) {
          try {
            const localTeacher = await db.getFirstAsync(
              "SELECT name, email FROM users WHERE id = ? LIMIT 1",
              [teacherId]
            ).catch(() => null);
            if (localTeacher?.name) {
              teacherName  = localTeacher.name;
              teacherEmail = localTeacher.email || null;
            }
          } catch { /* non-fatal */ }
        }

        const teacherJson = teacherId
          ? JSON.stringify({ _id: teacherId, id: teacherId, name: teacherName, email: teacherEmail })
          : null;
        const classJson = classId
          ? JSON.stringify({ _id: classId, id: classId, name: classObj?.name || null, level: classObj?.level || null, section: classObj?.section || null })
          : null;
        const subjectJson = subjectId
          ? JSON.stringify({ _id: subjectId, id: subjectId, name: subjectObj?.name || null, code: subjectObj?.code || null })
          : null;

        if (__DEV__ && !teacherName) {
          console.warn(
            `[SyncManager] teacher name missing for assignment ${serverId}`,
            `teacherId=${teacherId}`
          );
        }

        await db.runAsync(
          `INSERT INTO teacher_assignments
             (id, teacherId, teacher_id, classId, class_id,
              subjectId, subject_id, schoolId, school_id,
              teacher_json, class_json, subject_json,
              _synced, _synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             teacherId    = excluded.teacherId,
             teacher_id   = excluded.teacher_id,
             classId      = excluded.classId,
             class_id     = excluded.class_id,
             subjectId    = excluded.subjectId,
             subject_id   = excluded.subject_id,
             schoolId     = excluded.schoolId,
             school_id    = excluded.school_id,
             teacher_json = CASE
               WHEN excluded.teacher_json IS NOT NULL
                 AND json_extract(excluded.teacher_json, '$.name') IS NOT NULL
               THEN excluded.teacher_json
               ELSE COALESCE(teacher_assignments.teacher_json, excluded.teacher_json)
             END,
             class_json   = COALESCE(excluded.class_json,   teacher_assignments.class_json),
             subject_json = COALESCE(excluded.subject_json, teacher_assignments.subject_json),
             _synced      = 1,
             _synced_at   = excluded._synced_at,
             updated_at   = excluded.updated_at`,
          [
            serverId,
            teacherId, teacherId,
            classId,   classId,
            subjectId, subjectId,
            a.schoolId || schoolId, a.schoolId || schoolId,
            teacherJson, classJson, subjectJson,
            ts, a.createdAt || ts, a.updatedAt || ts,
          ]
        ).catch((err) =>
          console.warn(`[SyncManager] Upsert assignment ${serverId}:`, err.message)
        );

        if (teacherId && subjectId) {
          await db
            .runAsync(
              `UPDATE subjects SET teacher_id = ?, updated_at = ?, _synced = 1
               WHERE id = ? AND (teacher_id IS NULL OR teacher_id = '' OR teacher_id != ?)`,
              [teacherId, ts, subjectId, teacherId]
            )
            .catch(() => {});
        }
      }

      const serverLookup = new Set(
        serverAssignments.map((a) => {
          const t = (typeof a.teacher === "string" ? a.teacher : a.teacher?._id || a.teacher?.id) || "";
          const c = (typeof a.class   === "string" ? a.class   : a.class?._id   || a.class?.id)   || "";
          const s = (typeof a.subject === "string" ? a.subject : a.subject?._id || a.subject?.id) || "";
          return `${t}|${c}|${s}`;
        })
      );

      const unsynced = await db
        .getAllAsync(
          `SELECT ta.*, u._synced AS teacherSynced
           FROM teacher_assignments ta
           LEFT JOIN users u ON u.id = ta.teacherId OR u.id = ta.teacher_id
           WHERE (ta._synced = 0 OR ta._synced IS NULL) AND ${NOT_DELETED_TA}`
        )
        .catch(() => []);

      for (const a of unsynced) {
        if (!a.teacherSynced) continue;

        const tid = a.teacherId  || a.teacher_id;
        const cid = a.classId    || a.class_id;
        const sid = a.subjectId  || a.subject_id;
        const key = `${tid}|${cid}|${sid}`;

        if (serverLookup.has(key)) {
          await db
            .runAsync(
              "UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?",
              [ts, a.id]
            )
            .catch(() => {});
          continue;
        }

        try {
          const pushResponse = await this._withRetry(
            `pushAssignment ${a.id}`,
            () => api.post(API.admin.assignments.list, { teacherId: tid, classId: cid, subjectId: sid, schoolId })
          );

          const raw =
            pushResponse.data?.assignment?._id ||
            pushResponse.data?.assignment?.id  ||
            pushResponse.data?._id             ||
            pushResponse.data?.id              || null;
          const finalId = raw ? String(raw) : a.id;

          if (finalId !== a.id) {
            await db
              .runAsync(
                "UPDATE teacher_assignments SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?",
                [finalId, ts, a.id]
              )
              .catch(() =>
                db.runAsync(
                  "UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?",
                  [ts, a.id]
                ).catch(() => {})
              );
          } else {
            await db
              .runAsync(
                "UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?",
                [ts, a.id]
              )
              .catch(() => {});
          }
        } catch (err) {
          if (err?.response?.status === 409) {
            await db
              .runAsync(
                "UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?",
                [ts, a.id]
              )
              .catch(() => {});
          } else {
            console.warn(`[SyncManager] pushAssignment ${a.id} failed:`, err.message);
          }
        }
      }

      console.log("[SyncManager] Assignment sync complete");
    } catch (err) {
      console.warn("[SyncManager] syncLocalAssignmentsWithServer failed:", err.message);
    }
  }

  async pushLocalAnnouncements() {
    if (this._isUnauthenticated()) return;
    try {
      const svc = require("./announcement.service").default;
      await svc.pushUnsyncedAnnouncements();
    } catch (err) {
      console.warn("[SyncManager] pushLocalAnnouncements failed:", err.message);
    }
  }

  async pushLocalStudentApplications() {
    if (this._isUnauthenticated()) return;
    try {
      const { StudentApplicationsService } = require("./studentApplications.service");
      await StudentApplicationsService.pushPendingDecisions();
    } catch (err) {
      console.warn("[SyncManager] pushLocalStudentApplications failed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 17 — PULL ORCHESTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async pullChanges() {
    if (this._isUnauthenticated()) return;

    const schoolId = await this.getSchoolId();
    if (!schoolId) {
      console.warn("[SyncManager] No schoolId — skipping pull");
      return;
    }

    let lastSyncTime   = await this.getLastSync();
    const lastSyncDate = new Date(lastSyncTime);
    const now          = new Date();

    if (isNaN(lastSyncDate.getTime())) {
      console.warn("[SyncManager] lastSync is not a valid date — resetting to epoch");
      await this.resetLastSync();
      lastSyncTime = EPOCH;
    } else if (lastSyncDate > now) {
      console.warn(`[SyncManager] lastSync (${lastSyncTime}) is in the future — resetting`);
      await this.resetLastSync();
      lastSyncTime = EPOCH;
    }

    console.log(`[SyncManager] Pulling since ${lastSyncTime}…`);

    try {
      if (!this.isStudent()) {
        const response = await this._withRetry(
          "pullChanges",
          () => api.get(API.sync.pull, { params: { schoolId, lastSync: lastSyncTime } })
        );
        const data = response.data?.data;
        if (data) {
          await this.syncClasses(data.classes);
          await this.syncSubjects(data.subjects);
          await Promise.all([
            this.syncTeachers(data.teachers),
            this.syncPeriods(data.periods),
          ]);
          await this.syncAssignments(data.assignments);
        }
      }

      await this.pullAnnouncements(lastSyncTime);
      if (this.isAdmin()) await this.pullStudentApplications(lastSyncTime);

      // ✅ syncSchoolInfo is now non-throwing — errors are caught internally
      await this.syncSchoolInfo();

      console.log("[SyncManager] Pull complete");
    } catch (err) {
      console.warn("[SyncManager] Pull failed (using cached data):", err.message);
      throw err;
    }
  }

  async pullAnnouncements(lastSyncTime) {
    if (this._isUnauthenticated()) return;
    try {
      const svc   = require("./announcement.service").default;
      const count = await svc.pullAnnouncements(lastSyncTime);
      if (count > 0) console.log(`[SyncManager] Pulled ${count} announcement(s)`);
    } catch (err) {
      console.warn("[SyncManager] pullAnnouncements failed:", err.message);
    }
  }

  async pullStudentApplications(lastSyncTime) {
    if (this._isUnauthenticated()) return;
    try {
      const { StudentApplicationsService } = require("./studentApplications.service");
      const count = await StudentApplicationsService.pullPendingApplications(lastSyncTime);
      if (count > 0) console.log(`[SyncManager] Pulled ${count} student application(s)`);
    } catch (err) {
      console.warn("[SyncManager] pullStudentApplications failed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 18 — PULL: SCHOOL INFO  ← ONLY SECTION CHANGED
  // ═══════════════════════════════════════════════════════════════════════════

  async syncSchoolInfo() {
    // ✅ Guards
    if (this._isUnauthenticated() || this.isStudent()) return;

    const schoolId = await this.getSchoolId();
    if (!schoolId) return;

    // ✅ Try to load from local cache first so the UI is never empty
    let cachedSchool = null;
    try {
      const { getSchoolLocal } = require("./school.service");
      cachedSchool = await getSchoolLocal(schoolId);
    } catch { /* school.service may not have getSchoolLocal — non-fatal */ }

    let response = null;

    try {
      if (this.isAdmin()) {
        try {
          // ✅ No _withRetry here — api.js already handles one token-refresh
          //    retry internally. Adding _withRetry on top would mean up to
          //    3 × (1 refresh + 1 retry) = 6 requests on a bad token.
          //    A single direct call is enough; failure is non-fatal.
          response = await api.get(API.admin.school, {
            params:  { schoolId },
            timeout: 8_000,
          });
        } catch (err) {
          const status = err?.response?.status;

          if (status === 404 || status === 405) {
            // Admin school endpoint not registered — fall back to teacher route
            response = await api.get("/teacher/school/info", { timeout: 8_000 });
          } else if (status === 401 || status === 403) {
            // Auth error survived the refresh attempt in api.js — give up quietly
            console.warn(
              `[SyncManager] syncSchoolInfo: ${status} after refresh — skipping`
            );
            return;
          } else {
            // Network / 5xx — non-fatal, use cached data
            throw err;
          }
        }
      } else if (this.isTeacher()) {
        response = await api.get("/teacher/school/info", { timeout: 8_000 });
      }

      if (!response) return;

      const school =
        response.data?.school ||
        response.data?.data   ||
        response.data         || null;

      if (!school?.name) return;

      const { upsertSchoolLocal } = require("./school.service");
      const id = String(
        school._id?.$oid || school._id || school.id || schoolId
      ).trim();
      if (!id) return;

      await upsertSchoolLocal({
        id,
        name:    school.name    || "",
        logo:    school.logo    || "",
        email:   school.email   || "",
        phone:   school.phone   || "",
        address: school.address || "",
        city:    school.city    || "",
        state:   school.state   || "",
        country: school.country || "",
        website: school.website || "",
        motto:   school.motto   || "",
        code:    school.code    || "",
      });

      console.log(`[SyncManager] School info saved: "${school.name}"`);

    } catch (err) {
      // ✅ Always non-fatal — the app works fine with cached school data
      const status = err?.response?.status;

      if (status === 403) {
        console.warn("[SyncManager] syncSchoolInfo: 403 — role not permitted");
      } else if (cachedSchool) {
        console.log(
          "[SyncManager] syncSchoolInfo: network error — using cached school data"
        );
      } else {
        console.warn(
          "[SyncManager] syncSchoolInfo failed (non-fatal):", err.message
        );
      }
      // ✅ Never re-throw — don't let school info failure abort the whole pull
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 19-21 — ENTITY SYNC + QUIZ (unchanged from original)
  // ═══════════════════════════════════════════════════════════════════════════

  async syncPeriods(periods) {
    if (!periods?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS periods (
        id TEXT PRIMARY KEY, schoolId TEXT, name TEXT NOT NULL,
        starttime TEXT NOT NULL, endtime TEXT NOT NULL,
        sortorder INTEGER DEFAULT 0, isbreak INTEGER DEFAULT 0,
        isactive INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
        dirty INTEGER DEFAULT 0, operation TEXT, deletedat TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    for (const p of periods) {
      try {
        const id = p._id || p.id;
        if (!id) continue;

        const local = await db
          .getFirstAsync("SELECT dirty FROM periods WHERE id = ?", [id])
          .catch(() => null);
        if (local?.dirty) continue;

        await db.runAsync(
          `INSERT OR REPLACE INTO periods
             (id, schoolId, name, starttime, endtime, sortorder,
              isbreak, isactive, version, dirty, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [
            id, p.schoolId || p.school_id, p.name,
            p.startTime || p.starttime, p.endTime || p.endtime,
            p.sortOrder ?? 0, p.isBreak ? 1 : 0,
            p.isActive !== false ? 1 : 0, p.version ?? 1,
            p.updatedAt || ts,
          ]
        );
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncPeriods row ${p._id || p.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Periods: ${ok} synced, ${fail} failed`);
  }

  async syncClasses(classes) {
    if (!classes?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const c of classes) {
      try {
        const id = c._id || c.id;
        if (!id) continue;

        if (c.deletedAt || c.deleted_at) {
          await db.runAsync(
            "UPDATE classes SET deleted_at = ?, is_active = 0, _synced = 1, updated_at = ? WHERE id = ?",
            [c.deletedAt || c.deleted_at, ts, String(id)]
          );
          ok++; continue;
        }

        await db.runAsync(
          `INSERT INTO classes
             (id, schoolId, school_id, name, level, section, is_active,
              _synced, deleted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET
             name       = excluded.name,
             level      = excluded.level,
             section    = excluded.section,
             is_active  = excluded.is_active,
             _synced    = 1,
             deleted_at = NULL,
             updated_at = excluded.updated_at`,
          [
            String(id), c.schoolId, c.schoolId,
            c.name, c.level || null, c.section || "",
            c.isActive !== false ? 1 : 0, c.updatedAt || ts,
          ]
        );
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncClasses row ${c._id || c.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Classes: ${ok} synced, ${fail} failed`);
  }

  async syncTeachers(teachers) {
    if (!teachers?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const t of teachers) {
      try {
        const id = t._id || t.id;
        if (!id || !t.email) continue;

        if (t.deletedAt || t.deleted_at) {
          await db.runAsync(
            "UPDATE users SET deleted_at = ?, is_active = 0, _synced = 1, updated_at = ? WHERE id = ?",
            [t.deletedAt || t.deleted_at, ts, String(id)]
          );
          ok++; continue;
        }

        await db.runAsync(
          `INSERT INTO users
             (id, schoolId, school_id, name, email, role, is_active,
              must_reset_password, _synced, _synced_at,
              deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'teacher', ?, ?, 1, ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             schoolId            = excluded.schoolId,
             school_id           = excluded.school_id,
             name                = excluded.name,
             email               = excluded.email,
             is_active           = excluded.is_active,
             must_reset_password = excluded.must_reset_password,
             _synced             = 1,
             _synced_at          = excluded._synced_at,
             deleted_at          = NULL,
             updated_at          = excluded.updated_at`,
          [
            String(id), t.schoolId, t.schoolId,
            t.name || "Unknown", t.email.toLowerCase().trim(),
            t.isActive          !== false ? 1 : 0,
            t.mustResetPassword ? 1 : 0,
            ts,
            t.createdAt?.$date || t.createdAt || ts,
            t.updatedAt?.$date || t.updatedAt || ts,
          ]
        );
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncTeachers row ${t._id || t.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Teachers: ${ok} synced, ${fail} failed`);
  }

  async syncSubjects(subjects) {
    if (!subjects?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const s of subjects) {
      try {
        const id = s._id || s.id;
        if (!id) continue;

        if (s.deletedAt || s.deleted_at) {
          await db.runAsync(
            "UPDATE subjects SET deleted_at = ?, teacher_id = NULL, _synced = 1, updated_at = ? WHERE id = ?",
            [s.deletedAt || s.deleted_at, ts, String(id)]
          );
          ok++; continue;
        }

        const classId =
          (typeof s.class === "string" && s.class ? s.class : null) ||
          s.class?._id || s.class?.id || s.classId || s.class_id || null;
        if (!classId) { fail++; continue; }

        const teacherId   = s.teacherId || s.teacher?._id || s.teacher_id || null;
        const teacherName = s.teacher?.name || s.teacherName || null;

        await db.runAsync(
          `INSERT INTO subjects
             (id, schoolId, school_id, classId, class_id, name, code,
              teacher_id, teacher_name, _synced, deleted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET
             schoolId     = excluded.schoolId,
             school_id    = excluded.school_id,
             classId      = excluded.classId,
             class_id     = excluded.class_id,
             name         = excluded.name,
             code         = excluded.code,
             teacher_id   = excluded.teacher_id,
             teacher_name = excluded.teacher_name,
             _synced      = 1,
             deleted_at   = NULL,
             updated_at   = excluded.updated_at`,
          [
            String(id), s.schoolId, s.schoolId,
            String(classId), String(classId),
            s.name, s.code || "", teacherId, teacherName,
            s.updatedAt || ts,
          ]
        );
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncSubjects row ${s._id || s.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Subjects: ${ok} synced, ${fail} failed`);
  }

  async syncAssignments(assignments) {
    if (!assignments?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const a of assignments) {
      try {
        const id = a._id || a.id;
        if (!id) continue;

        const teacherId =
          (typeof a.teacher === "string" ? a.teacher : null) ||
          a.teacher?._id || a.teacher?.id || a.teacherId || null;
        const classId =
          (typeof a.class === "string" ? a.class : null) ||
          a.class?._id || a.class?.id || a.classId || null;
        const subjectId =
          (typeof a.subject === "string" ? a.subject : null) ||
          a.subject?._id || a.subject?.id || a.subjectId || null;

        if (a.deletedAt || a.deleted_at) {
          await db.runAsync(
            "UPDATE teacher_assignments SET deleted_at = ?, _synced = 1, updated_at = ? WHERE id = ?",
            [a.deletedAt || a.deleted_at, ts, String(id)]
          );
          if (subjectId) {
            await db
              .runAsync(
                "UPDATE subjects SET teacher_id = NULL, updated_at = ? WHERE id = ?",
                [ts, subjectId]
              )
              .catch(() => {});
          }
          ok++; continue;
        }

        const teacherJson =
          a.teacher && typeof a.teacher === "object"
            ? JSON.stringify({ _id: teacherId, name: a.teacher.name, email: a.teacher.email })
            : null;
        const classJson =
          a.class && typeof a.class === "object"
            ? JSON.stringify({ _id: classId, name: a.class.name })
            : null;
        const subjectJson =
          a.subject && typeof a.subject === "object"
            ? JSON.stringify({ _id: subjectId, name: a.subject.name })
            : null;

        await db.runAsync(
          `INSERT INTO teacher_assignments
             (id, schoolId, school_id, teacherId, teacher_id,
              classId, class_id, subjectId, subject_id,
              teacher_json, class_json, subject_json,
              deleted_at, updated_at, _synced, _synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             schoolId     = excluded.schoolId,
             school_id    = excluded.school_id,
             teacherId    = excluded.teacherId,
             teacher_id   = excluded.teacher_id,
             classId      = excluded.classId,
             class_id     = excluded.class_id,
             subjectId    = excluded.subjectId,
             subject_id   = excluded.subject_id,
             teacher_json = excluded.teacher_json,
             class_json   = excluded.class_json,
             subject_json = excluded.subject_json,
             deleted_at   = NULL,
             updated_at   = excluded.updated_at,
             _synced      = 1,
             _synced_at   = excluded._synced_at`,
          [
            String(id), a.schoolId, a.schoolId,
            teacherId, teacherId,
            classId,   classId,
            subjectId, subjectId,
            teacherJson, classJson, subjectJson,
            a.updatedAt || ts, ts,
          ]
        );

        if (subjectId && teacherId) {
          await db
            .runAsync(
              `UPDATE subjects SET teacher_id = ?, updated_at = ?, _synced = 1
               WHERE id = ? AND (teacher_id IS NULL OR teacher_id = '' OR teacher_id != ?)`,
              [teacherId, ts, subjectId, teacherId]
            )
            .catch(() => {});
        }
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncAssignments row ${a._id || a.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Assignments: ${ok} synced, ${fail} failed`);
  }

  async syncQuizData() {
    if (this._isUnauthenticated()) return;

    const schoolId = await this.getSchoolId();
    if (!schoolId) return;

    console.log("[SyncManager] Quiz sync starting…");

    try {
      if (this.isStudent()) {
        await this.pullQuizData(schoolId);
      } else {
        await this._deduplicateQuestions();
        await this._deduplicateQuestionOptions();
        await this._repairQuizzesWithoutClassId(schoolId);
        await this.pushQuizData(schoolId);
        await this.pullQuizData(schoolId);
      }

      await this.setLastQuizSync(new Date().toISOString());
      console.log("[SyncManager] Quiz sync complete");
    } catch (err) {
      console.warn("[SyncManager] Quiz sync incomplete:", err.message);
    }
  }

  async _deduplicateQuestions() {
    const db = await getDatabase();

    const exists = await db
      .getFirstAsync(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'questions'`)
      .catch(() => null);

    if (!exists) {
      console.warn("[SyncManager] 'questions' table missing — running migrateQuizTables first");
      await this.migrateQuizTables();
    }

    await withFkOff(db, async () => {
      try {
        const result = await db.runAsync(
          `DELETE FROM questions
           WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM questions
             GROUP BY schoolId, question_text, question_type, created_by
           ) AND ${NOT_DELETED_BARE}`
        );
        if (result.changes > 0) {
          console.log(`[SyncManager] Removed ${result.changes} duplicate question(s)`);
        }
        await db.runAsync("DELETE FROM question_options   WHERE question_id NOT IN (SELECT id FROM questions)").catch(() => {});
        await db.runAsync("DELETE FROM question_analytics WHERE question_id NOT IN (SELECT id FROM questions)").catch(() => {});
      } catch (err) {
        console.warn("[SyncManager] _deduplicateQuestions failed:", err.message);
      }
    });
  }

  async _deduplicateQuestionOptions() {
    const db = await getDatabase();

    const exists = await db
      .getFirstAsync(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'question_options'`)
      .catch(() => null);

    if (!exists) {
      console.warn("[SyncManager] 'question_options' table missing — running migrateQuizTables first");
      await this.migrateQuizTables();
    }

    await withFkOff(db, async () => {
      try {
        const result = await db.runAsync(
          `DELETE FROM question_options
           WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM question_options
             GROUP BY question_id, display_order, option_text
           )`
        );
        if (result.changes > 0) {
          console.log(`[SyncManager] Removed ${result.changes} duplicate question option(s)`);
        }
      } catch (err) {
        console.warn("[SyncManager] _deduplicateQuestionOptions failed:", err.message);
      }
    });
  }

  async _repairQuizzesWithoutClassId(schoolId) {
    if (this._isUnauthenticated()) return;

    const db = await getDatabase();
    try {
      const broken = await db
        .getAllAsync(
          `SELECT id, title, subject_id, created_by, class_id
           FROM quizzes
           WHERE (
             (class_id   IS NULL OR class_id   = '') OR
             (subject_id IS NULL OR subject_id = '')
           ) AND ${NOT_DELETED_BARE} AND schoolId = ?`,
          [schoolId]
        )
        .catch(() => []);

      if (!broken.length) return;
      console.log(`[SyncManager] Repairing ${broken.length} quiz(zes) missing class/subject…`);

      let serverAssignmentCache = null;
      const fetchServerAssignments = async () => {
        if (serverAssignmentCache) return serverAssignmentCache;
        try {
          const endpoints = this.isTeacher()
            ? [API.teacher.myAssignments]
            : this.isAdmin()
              ? [API.admin.assignments.list]
              : [];

          for (const ep of endpoints) {
            try {
              const res  = await api.get(ep, { params: { schoolId } });
              const list =
                res.data?.assignments ||
                res.data?.data        ||
                (Array.isArray(res.data) ? res.data : []);
              serverAssignmentCache = list;
              return list;
            } catch (err) {
              if (err?.response?.status === 404) continue;
              throw err;
            }
          }
          return [];
        } catch (err) {
          console.warn("[SyncManager] fetchServerAssignments failed:", err.message);
          return [];
        }
      };

      for (const quiz of broken) {
        if (quiz.class_id && quiz.subject_id) continue;

        let recoveredClassId   = quiz.class_id  || null;
        let recoveredSubjectId = quiz.subject_id || null;

        if (!recoveredClassId && quiz.subject_id) {
          const subj = await db
            .getFirstAsync("SELECT class_id, classId FROM subjects WHERE id = ? LIMIT 1", [quiz.subject_id])
            .catch(() => null);
          recoveredClassId = subj?.class_id || subj?.classId || null;
        }

        if ((!recoveredClassId || !recoveredSubjectId) && quiz.created_by) {
          const assign = await db
            .getFirstAsync(
              `SELECT classId, class_id, subjectId, subject_id
               FROM teacher_assignments
               WHERE (teacherId = ? OR teacher_id = ?) AND ${NOT_DELETED_BARE} LIMIT 1`,
              [quiz.created_by, quiz.created_by]
            )
            .catch(() => null);

          if (!recoveredClassId)   recoveredClassId   = assign?.classId   || assign?.class_id   || null;
          if (!recoveredSubjectId) recoveredSubjectId = assign?.subjectId || assign?.subject_id || null;
        }

        if ((!recoveredClassId || !recoveredSubjectId) && quiz.created_by) {
          const list = await fetchServerAssignments();
          if (list.length) {
            const first = list[0];
            if (!recoveredClassId) {
              recoveredClassId =
                (typeof first.class === "string" ? first.class : null) ||
                first.class?._id || first.class?.id || first.classId || null;
            }
            if (!recoveredSubjectId) {
              recoveredSubjectId =
                (typeof first.subject === "string" ? first.subject : null) ||
                first.subject?._id || first.subject?.id || first.subjectId || null;
            }
            if (recoveredClassId) {
              await this.syncAssignments(list).catch(() => {});
            }
          }
        }

        if (recoveredClassId || recoveredSubjectId) {
          const sets   = [];
          const params = [];
          if (recoveredClassId   && !quiz.class_id)   { sets.push("class_id = ?");   params.push(recoveredClassId); }
          if (recoveredSubjectId && !quiz.subject_id) { sets.push("subject_id = ?"); params.push(recoveredSubjectId); }
          sets.push("_synced = 0");
          params.push(quiz.id);

          await db
            .runAsync(`UPDATE quizzes SET ${sets.join(", ")} WHERE id = ?`, params)
            .catch((err) => console.warn(`[SyncManager] Repair quiz ${quiz.id}:`, err.message));
        }
      }
    } catch (err) {
      console.warn("[SyncManager] _repairQuizzesWithoutClassId failed:", err.message);
    }
  }

  async pushQuizData(schoolId) {
    if (this._isUnauthenticated()) return;
    await this.pushUnsyncedQuestions(schoolId);
    await this.pushUnsyncedQuizzes(schoolId);
    await this.pushUnsyncedAttempts(schoolId);
  }

  async pushUnsyncedQuestions(schoolId) {
    if (this._isUnauthenticated()) return;

    const db = await getDatabase();
    const ts = new Date().toISOString();

    try {
      const unsynced = await db
        .getAllAsync(
          `SELECT * FROM questions WHERE _synced = 0 AND ${NOT_DELETED_BARE} AND schoolId = ?`,
          [schoolId]
        )
        .catch(() => []);

      if (!unsynced.length) return;
      console.log(`[SyncManager] Pushing ${unsynced.length} question(s)…`);

      for (const q of unsynced) {
        try {
          const options = await db
            .getAllAsync(
              "SELECT * FROM question_options WHERE question_id = ? ORDER BY display_order ASC",
              [q.id]
            )
            .catch(() => []);

          const response = await this._withRetry(
            `pushQuestion ${q.id}`,
            () => api.post(API.quiz.questions, {
              id:            q.id,
              schoolId:      q.schoolId || schoolId,
              category_id:   q.category_id  || null,
              question_text: q.question_text,
              question_type: q.question_type,
              media_url:     q.media_url     || null,
              difficulty:    q.difficulty    || "medium",
              points:        q.points        || 1.0,
              explanation:   q.explanation   || null,
              is_active:     q.is_active     === 1,
              created_by:    q.created_by    || null,
              options: options.map((o) => ({
                id:            o.id,
                option_text:   o.option_text,
                is_correct:    o.is_correct === 1,
                match_pair:    o.match_pair || null,
                display_order: o.display_order ?? 0,
              })),
            })
          );

          const raw =
            response.data?.question?._id || response.data?.question?.id ||
            response.data?._id           || response.data?.id           || null;
          const finalId = raw ? String(raw) : q.id;

          if (finalId !== q.id) {
            await withFkOff(db, async () => {
              await withTransaction(db, async () => {
                await db.runAsync("UPDATE questions SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?", [finalId, ts, q.id]);
                await db.runAsync("UPDATE question_options   SET question_id = ? WHERE question_id = ?", [finalId, q.id]).catch(() => {});
                await db.runAsync("UPDATE quiz_questions     SET question_id = ? WHERE question_id = ?", [finalId, q.id]).catch(() => {});
                await db.runAsync("UPDATE attempt_answers    SET question_id = ? WHERE question_id = ?", [finalId, q.id]).catch(() => {});
                await db.runAsync("UPDATE question_analytics SET question_id = ? WHERE question_id = ?", [finalId, q.id]).catch(() => {});
              });
            });
          } else {
            await db.runAsync("UPDATE questions SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, q.id]);
          }
        } catch (err) {
          if (err?.response?.status === 409) {
            await db.runAsync("UPDATE questions SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, q.id]);
          } else {
            console.warn(`[SyncManager] pushQuestion ${q.id}:`, err.message);
          }
        }
      }
      console.log("[SyncManager] Questions push complete");
    } catch (err) {
      console.warn("[SyncManager] pushUnsyncedQuestions failed:", err.message);
    }
  }

  async pushUnsyncedQuizzes(schoolId) {
    if (this._isUnauthenticated()) return;

    const db = await getDatabase();
    const ts = new Date().toISOString();

    try {
      const unsynced = await db
        .getAllAsync(
          `SELECT q.*, c._synced AS class_synced, s._synced AS subject_synced
           FROM   quizzes q
           LEFT JOIN classes  c ON c.id = q.class_id
           LEFT JOIN subjects s ON s.id = q.subject_id
           WHERE  q._synced = 0 AND ${NOT_DELETED_Q} AND q.schoolId = ?`,
          [schoolId]
        )
        .catch(() => []);

      if (!unsynced.length) return;
      console.log(`[SyncManager] Pushing ${unsynced.length} quiz(zes)…`);

      for (const quiz of unsynced) {
        try {
          if (!quiz.class_id)     { console.warn(`[SyncManager] Quiz "${quiz.title}" skipped — no class_id`);    continue; }
          if (!quiz.subject_id)   { console.warn(`[SyncManager] Quiz "${quiz.title}" skipped — no subject_id`);  continue; }
          if (!quiz.class_synced) { console.warn(`[SyncManager] Quiz "${quiz.title}" skipped — class unsynced`); continue; }
          if (!quiz.subject_synced) { console.warn(`[SyncManager] Quiz "${quiz.title}" skipped — subj unsynced`); continue; }

          const questions = await db
            .getAllAsync(
              "SELECT question_id, display_order, points_override FROM quiz_questions WHERE quiz_id = ? ORDER BY display_order ASC",
              [quiz.id]
            )
            .catch(() => []);

          const response = await this._withRetry(
            `pushQuiz "${quiz.title}"`,
            () => api.post(API.quiz.list, {
              id:                 quiz.id,
              schoolId:           quiz.schoolId || schoolId,
              title:              quiz.title,
              description:        quiz.description        || null,
              instructions:       quiz.instructions       || null,
              class_id:           quiz.class_id,
              subject_id:         quiz.subject_id,
              time_limit_minutes: quiz.time_limit_minutes || null,
              time_per_question:  quiz.time_per_question  || null,
              shuffle_questions:  quiz.shuffle_questions  === 1,
              shuffle_options:    quiz.shuffle_options    === 1,
              questions_per_page: quiz.questions_per_page || 1,
              allow_backtrack:    quiz.allow_backtrack    === 1,
              max_attempts:       quiz.max_attempts       || 1,
              passing_score:      quiz.passing_score      || 70,
              available_from:     quiz.available_from     || null,
              available_until:    quiz.available_until    || null,
              show_answers_after: quiz.show_answers_after || "on_completion",
              show_score:         quiz.show_score         === 1,
              show_explanation:   quiz.show_explanation   === 1,
              is_published:       quiz.is_published       === 1,
              created_by:         quiz.created_by         || null,
              questions,
            })
          );

          const raw =
            response.data?.quiz?._id || response.data?.quiz?.id ||
            response.data?._id       || response.data?.id       || null;
          const finalId = raw ? String(raw) : quiz.id;

          if (finalId !== quiz.id) {
            await withFkOff(db, async () => {
              await withTransaction(db, async () => {
                await db.runAsync("UPDATE quizzes SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?", [finalId, ts, quiz.id]);
                await db.runAsync("UPDATE quiz_questions SET quiz_id = ? WHERE quiz_id = ?", [finalId, quiz.id]).catch(() => {});
                await db.runAsync("UPDATE quiz_attempts  SET quiz_id = ? WHERE quiz_id = ?", [finalId, quiz.id]).catch(() => {});
                await db.runAsync("UPDATE quiz_analytics SET quiz_id = ? WHERE quiz_id = ?", [finalId, quiz.id]).catch(() => {});
              });
            });
          } else {
            await db.runAsync("UPDATE quizzes SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, quiz.id]);
          }
        } catch (err) {
          if (err?.response?.status === 409) {
            await db.runAsync("UPDATE quizzes SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, quiz.id]);
          } else {
            console.warn(`[SyncManager] pushQuiz "${quiz.title}" failed:`, err.message);
          }
        }
      }
      console.log("[SyncManager] Quizzes push complete");
    } catch (err) {
      console.warn("[SyncManager] pushUnsyncedQuizzes failed:", err.message);
    }
  }

  async pushUnsyncedAttempts(schoolId) {
    if (this._isUnauthenticated()) return;

    const db = await getDatabase();
    const ts = new Date().toISOString();

    try {
      const unsynced = await db
        .getAllAsync(
          `SELECT qa.* FROM quiz_attempts qa
           JOIN quizzes q ON q.id = qa.quiz_id
           WHERE qa._synced = 0 AND qa.status IN ('submitted', 'timed_out') AND q.schoolId = ?`,
          [schoolId]
        )
        .catch(() => []);

      if (!unsynced.length) return;
      console.log(`[SyncManager] Pushing ${unsynced.length} attempt(s)…`);

      for (const attempt of unsynced) {
        try {
          const answers = await db
            .getAllAsync("SELECT * FROM attempt_answers WHERE attempt_id = ?", [attempt.id])
            .catch(() => []);

          for (const answer of answers) {
            answer.selections = await db
              .getAllAsync("SELECT * FROM attempt_answer_selections WHERE attempt_answer_id = ?", [answer.id])
              .catch(() => []);
          }

          await this._withRetry(
            `pushAttempt ${attempt.id}`,
            () => api.post(API.quiz.attempts, { ...attempt, answers })
          );

          await db.runAsync("UPDATE quiz_attempts SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, attempt.id]);

          const answerIds = answers.map((a) => a.id);
          if (answerIds.length) {
            const ph = answerIds.map(() => "?").join(",");
            await db
              .runAsync(
                `UPDATE attempt_answers SET _synced = 1, _synced_at = ? WHERE id IN (${ph})`,
                [ts, ...answerIds]
              )
              .catch(() => {});
          }
        } catch (err) {
          if (err?.response?.status === 409) {
            await db.runAsync("UPDATE quiz_attempts SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, attempt.id]);
          } else {
            console.warn(`[SyncManager] pushAttempt ${attempt.id} failed:`, err.message);
          }
        }
      }
      console.log("[SyncManager] Attempts push complete");
    } catch (err) {
      console.warn("[SyncManager] pushUnsyncedAttempts failed:", err.message);
    }
  }

  async pullQuizData(schoolId) {
    if (this._isUnauthenticated()) return;

    const lastSync = await this.getLastQuizSync();

    try {
      const response = await this._withRetry(
        "pullQuizData",
        () => api.get(API.quiz.sync, { params: { schoolId, since: lastSync } })
      );

      const data = response.data?.data;
      if (!data) return;

      await this.syncQuizCategories(data.categories);
      await this.syncQuizQuestions(data.questions);
      await this.syncQuizzes(data.quizzes);
      await this.syncQuizAttempts(data.attempts);

      console.log("[SyncManager] Quiz pull complete");
    } catch (err) {
      console.warn("[SyncManager] pullQuizData failed:", err.message);
      throw err;
    }
  }

  async syncQuizCategories(categories) {
    if (!categories?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const c of categories) {
      try {
        const id = c._id || c.id;
        if (!id) continue;

        if (c.deletedAt || c.deleted_at) {
          await db.runAsync(
            "UPDATE question_categories SET deleted_at = ?, is_active = 0 WHERE id = ?",
            [c.deletedAt || c.deleted_at, String(id)]
          );
          ok++; continue;
        }

        await db.runAsync(
          `INSERT INTO question_categories
             (id, schoolId, name, description, parent_id, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name        = excluded.name,
             description = excluded.description,
             parent_id   = excluded.parent_id,
             is_active   = excluded.is_active,
             updated_at  = excluded.updated_at`,
          [
            String(id), c.schoolId, c.name, c.description || null,
            c.parent_id || c.parentId || null,
            c.isActive !== false ? 1 : 0,
            c.createdAt || ts, c.updatedAt || ts,
          ]
        );
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncQuizCategories row ${c._id || c.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Quiz categories: ${ok} synced, ${fail} failed`);
  }

  async syncQuizQuestions(questions) {
    if (!questions?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const q of questions) {
      try {
        const id = q._id || q.id;
        if (!id) continue;

        if (q.deletedAt || q.deleted_at) {
          await db.runAsync(
            "UPDATE questions SET deleted_at = ?, is_active = 0 WHERE id = ?",
            [q.deletedAt || q.deleted_at, String(id)]
          );
          ok++; continue;
        }

        let categoryId = q.category_id || q.categoryId || null;
        if (categoryId) {
          const catOk = await db
            .getFirstAsync("SELECT id FROM question_categories WHERE id = ? LIMIT 1", [String(categoryId)])
            .catch(() => null);
          if (!catOk) categoryId = null;
        }

        await db.runAsync(
          `INSERT INTO questions (
             id, schoolId, category_id, question_text, question_type,
             media_url, difficulty, points, explanation,
             is_active, created_by, _synced, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             category_id   = excluded.category_id,
             question_text = excluded.question_text,
             question_type = excluded.question_type,
             media_url     = excluded.media_url,
             difficulty    = excluded.difficulty,
             points        = excluded.points,
             explanation   = excluded.explanation,
             is_active     = excluded.is_active,
             _synced       = 1,
             updated_at    = excluded.updated_at`,
          [
            String(id), q.schoolId, categoryId,
            q.question_text || q.questionText,
            q.question_type || q.questionType,
            q.media_url     || q.mediaUrl    || null,
            q.difficulty    || "medium",
            q.points        ?? 1.0,
            q.explanation   || null,
            q.isActive      !== false ? 1 : 0,
            q.created_by    || q.createdBy  || null,
            q.createdAt     || ts,
            q.updatedAt     || ts,
          ]
        );

        const options = q.options || [];
        if (options.length) {
          await withTransaction(db, async () => {
            await db.runAsync("DELETE FROM question_options WHERE question_id = ?", [String(id)]);
            for (const opt of options) {
              const optId = opt._id || opt.id || generateUUID();
              await db.runAsync(
                `INSERT INTO question_options
                   (id, question_id, option_text, is_correct, match_pair, display_order)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   option_text   = excluded.option_text,
                   is_correct    = excluded.is_correct,
                   match_pair    = excluded.match_pair,
                   display_order = excluded.display_order`,
                [
                  String(optId), String(id),
                  opt.option_text  || opt.optionText,
                  (opt.is_correct  || opt.isCorrect) ? 1 : 0,
                  opt.match_pair   || opt.matchPair   || null,
                  opt.display_order ?? opt.displayOrder ?? 0,
                ]
              );
            }
          });
        }

        await db
          .runAsync("INSERT OR IGNORE INTO question_analytics (id, question_id) VALUES (?, ?)", [generateUUID(), String(id)])
          .catch(() => {});

        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncQuizQuestion ${q._id || q.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Quiz questions: ${ok} synced, ${fail} failed`);
  }

  async syncQuizzes(quizzes) {
    if (!quizzes?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const q of quizzes) {
      try {
        const id = String(q._id || q.id || "");
        if (!id) continue;

        if (q.deletedAt || q.deleted_at) {
          await db.runAsync(
            "UPDATE quizzes SET deleted_at = ?, is_published = 0, _synced = 1 WHERE id = ?",
            [q.deletedAt || q.deleted_at, id]
          );
          ok++; continue;
        }

        const schoolId_  = String(q.schoolId   || q.school_id   || "");
        const class_id   = String(q.class_id   || q.classId     || q.class   || "");
        const subject_id = String(q.subject_id || q.subjectId   || q.subject || "");
        const created_by = String(q.created_by || q.createdBy   || "");

        await db.runAsync(
          `INSERT INTO quizzes (
             id, schoolId, title, description, instructions,
             subject_id, class_id, created_by,
             time_limit_minutes, time_per_question,
             shuffle_questions, shuffle_options, questions_per_page,
             allow_backtrack, max_attempts, passing_score,
             available_from, available_until,
             show_answers_after, show_score, show_explanation,
             is_published, _synced, created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET
             schoolId           = excluded.schoolId,
             title              = excluded.title,
             description        = excluded.description,
             instructions       = excluded.instructions,
             subject_id         = excluded.subject_id,
             class_id           = excluded.class_id,
             created_by         = excluded.created_by,
             time_limit_minutes = excluded.time_limit_minutes,
             time_per_question  = excluded.time_per_question,
             shuffle_questions  = excluded.shuffle_questions,
             shuffle_options    = excluded.shuffle_options,
             questions_per_page = excluded.questions_per_page,
             allow_backtrack    = excluded.allow_backtrack,
             max_attempts       = excluded.max_attempts,
             passing_score      = excluded.passing_score,
             available_from     = excluded.available_from,
             available_until    = excluded.available_until,
             show_answers_after = excluded.show_answers_after,
             show_score         = excluded.show_score,
             show_explanation   = excluded.show_explanation,
             is_published       = excluded.is_published,
             updated_at         = excluded.updated_at,
             deleted_at         = NULL,
             _synced            = 1`,
          [
            id, schoolId_, q.title,
            q.description || null, q.instructions || null,
            subject_id || null, class_id || null, created_by || null,
            q.time_limit_minutes ?? q.timeLimitMinutes ?? null,
            q.time_per_question  ?? q.timePerQuestion  ?? null,
            (q.shuffle_questions ?? q.shuffleQuestions ?? false) ? 1 : 0,
            (q.shuffle_options   ?? q.shuffleOptions   ?? false) ? 1 : 0,
            Number(q.questions_per_page ?? q.questionsPerPage ?? 1),
            (q.allow_backtrack   ?? q.allowBacktrack   ?? true)  ? 1 : 0,
            Number(q.max_attempts   ?? q.maxAttempts   ?? 1),
            Number(q.passing_score  ?? q.passingScore  ?? 70),
            (q.available_from  || q.availableFrom)
              ? new Date(q.available_from  || q.availableFrom).toISOString()  : null,
            (q.available_until || q.availableUntil)
              ? new Date(q.available_until || q.availableUntil).toISOString() : null,
            q.show_answers_after || q.showAnswersAfter || "on_completion",
            (q.show_score       ?? q.showScore       ?? true)  ? 1 : 0,
            (q.show_explanation ?? q.showExplanation ?? true)  ? 1 : 0,
            (q.is_published     ?? q.isPublished     ?? false) ? 1 : 0,
            q.createdAt || q.created_at || ts,
            q.updatedAt || q.updated_at || ts,
          ]
        );

        const links = q.questions || q.questionIds || [];
        for (const link of links) {
          const qId    = link.question_id || link.questionId || link._id || link.id;
          if (!qId) continue;
          const linkId = link.id && link.id !== qId ? String(link.id) : `${id}_${String(qId)}`;
          await db
            .runAsync(
              `INSERT OR IGNORE INTO quiz_questions
                 (id, quiz_id, question_id, display_order, points_override)
               VALUES (?, ?, ?, ?, ?)`,
              [linkId, id, String(qId), link.display_order ?? link.displayOrder ?? 0, link.points_override ?? link.pointsOverride ?? null]
            )
            .catch(() => {});
        }

        await db
          .runAsync("INSERT OR IGNORE INTO quiz_analytics (id, quiz_id) VALUES (?, ?)", [generateUUID(), id])
          .catch(() => {});

        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncQuiz ${q._id || q.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Quizzes: ${ok} synced, ${fail} failed`);
  }

  async syncQuizAttempts(attempts) {
    if (!attempts?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    for (const a of attempts) {
      try {
        const id = a._id || a.id;
        if (!id) continue;

        const local = await db
          .getFirstAsync("SELECT status FROM quiz_attempts WHERE id = ?", [String(id)])
          .catch(() => null);
        if (local?.status === "in_progress") continue;

        await db.runAsync(
          `INSERT INTO quiz_attempts (
             id, quiz_id, user_id, attempt_number, status,
             raw_score, max_score, percentage, is_passed,
             started_at, submitted_at, time_taken_secs, _synced, _synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             status          = excluded.status,
             raw_score       = excluded.raw_score,
             max_score       = excluded.max_score,
             percentage      = excluded.percentage,
             is_passed       = excluded.is_passed,
             submitted_at    = excluded.submitted_at,
             time_taken_secs = excluded.time_taken_secs,
             _synced         = 1,
             _synced_at      = excluded._synced_at`,
          [
            String(id),
            a.quiz_id        || a.quizId,
            a.user_id        || a.userId,
            a.attempt_number || a.attemptNumber || 1,
            a.status         || "submitted",
            a.raw_score      ?? a.rawScore      ?? 0,
            a.max_score      ?? a.maxScore      ?? 0,
            a.percentage     ?? 0,
            (a.is_passed     ?? a.isPassed      ?? false) ? 1 : 0,
            a.started_at     || a.startedAt     || ts,
            a.submitted_at   || a.submittedAt   || null,
            a.time_taken_secs || a.timeTakenSecs || null,
            ts,
          ]
        );
        ok++;
      } catch (err) {
        console.warn(`[SyncManager] syncAttempt ${a._id || a.id}:`, err.message);
        fail++;
      }
    }
    console.log(`[SyncManager] Quiz attempts: ${ok} synced, ${fail} failed`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 21 — PUBLIC UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  async forceSync() {
    this._staleSubjectsCleared = false;
    await this.resetLastSync();
    return this.syncAll();
  }
}

// ✅ Export singleton.
export const SyncManager = new SyncManagerClass();
export default SyncManager;