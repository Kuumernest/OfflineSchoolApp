// src/services/syncManager.js
"use strict";

import api                              from "./api";
import { setRetryContext, clearRetryContext } from "./api";
import NetInfo                          from "@react-native-community/netinfo";
import { AppState }                     from "react-native";
import { getDatabase }                  from "../db/database";
import * as SecureStore                 from "expo-secure-store";
import {
  safeAddColumn,
  withFkOff,
  withTransaction,
  NOT_DELETED,
  IS_DELETED,
}                                       from "../db/dbHelpers";
import { ensureSchemaColumns }          from "../db/schema";
import { generateUUID }                 from "../utils/idHelpers";
import {
  isAuthenticated,
  getCurrentAuth,
  hasRole,
}                                       from "../utils/authHelpers";
import { API }                          from "./apiEndpoints";
import { MutationQueue }                from "./mutationQueue.service";

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
// SHARED ASSIGNMENT UPSERT
//
// Single SQL statement used by both assignment pull paths (syncAssignments
// from /sync/pull, and pullAssignmentsFromServer) so the fix is applied
// consistently. Assignment pushes go through the outbox and never come here.
//
// KEY FIX: Two ON CONFLICT clauses are needed but SQLite only supports one
// per INSERT.  We handle the composite-key conflict by using
// INSERT OR IGNORE first, then UPDATE — the "upsert-or-update" pattern:
//
//   1. Try INSERT with ON CONFLICT(id) DO UPDATE
//   2. If the composite key (teacher_id, class_id, subject_id) already exists
//      with a DIFFERENT id, step 1 raises UNIQUE on the composite index.
//      We catch that and do a plain UPDATE on the existing row instead.
//
// This is implemented in upsertAssignmentRow() below.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Safely upserts one assignment row into teacher_assignments.
 *
 * Handles two conflict scenarios:
 *   A. Same id   → ON CONFLICT(id) DO UPDATE  (normal re-sync)
 *   B. Same business key, different id → find existing row and UPDATE it
 *      (server sent a corrected id for an already-stored assignment)
 *
 * Always names every column explicitly — immune to future schema additions.
 */
async function upsertAssignmentRow(db, {
  id,
  teacherId, classId, subjectId, schoolId,
  teacherJson, classJson, subjectJson,
  role       = null,
  is_primary = 0,
  _synced    = 1,
  _synced_at,
  created_at,
  updated_at,
  deleted_at = null,
}) {
  const ts = _synced_at || updated_at || new Date().toISOString();
  const ca = created_at || ts;
  const ua = updated_at || ts;

  // Resolve name blobs — preserve existing if server didn't send them
  const existing = await db
    .getFirstAsync(
      `SELECT id, teacher_json, class_json, subject_json
       FROM teacher_assignments
       WHERE id = ?
          OR (
            teacher_id = ? AND class_id = ? AND subject_id = ?
            AND (deleted_at IS NULL OR deleted_at = '')
          )
       LIMIT 1`,
      [id, teacherId, classId, subjectId]
    )
    .catch(() => null);

  // If a row exists with a DIFFERENT id (composite key collision),
  // update that row in-place rather than inserting a new one.
  const existingId = existing?.id || null;
  const targetId   = existingId || id;

  const resolvedTeacherJson =
    (teacherJson && _jsonHasName(teacherJson))
      ? teacherJson
      : existing?.teacher_json || teacherJson || null;

  const resolvedClassJson =
    (classJson && _jsonHasName(classJson))
      ? classJson
      : existing?.class_json || classJson || null;

  const resolvedSubjectJson =
    (subjectJson && _jsonHasName(subjectJson))
      ? subjectJson
      : existing?.subject_json || subjectJson || null;

  if (existingId && existingId !== id) {
    // Scenario B — composite key exists with a different id.
    // Update the existing row to adopt the new server id.
    await db.runAsync(
      `UPDATE teacher_assignments
       SET id           = ?,
           teacherId    = ?,  teacher_id   = ?,
           classId      = ?,  class_id     = ?,
           subjectId    = ?,  subject_id   = ?,
           schoolId     = COALESCE(?, schoolId),
           school_id    = COALESCE(?, school_id),
           teacher_json = ?,
           class_json   = ?,
           subject_json = ?,
           role         = COALESCE(?, role),
           is_primary   = COALESCE(?, is_primary),
           deleted_at   = ?,
           _synced      = ?,
           _synced_at   = ?,
           updated_at   = ?
       WHERE id = ?`,
      [
        id,
        teacherId, teacherId,
        classId,   classId,
        subjectId, subjectId,
        schoolId,  schoolId,
        resolvedTeacherJson,
        resolvedClassJson,
        resolvedSubjectJson,
        role,
        is_primary,
        deleted_at,
        _synced,
        ts,
        ua,
        existingId,
      ]
    );
    return;
  }

  // Scenario A — upsert by primary key
  await db.runAsync(
    `INSERT INTO teacher_assignments (
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
       deleted_at,
       _synced,
       _synced_at,
       created_at,
       updated_at
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
       deleted_at   = excluded.deleted_at,
       _synced      = excluded._synced,
       _synced_at   = excluded._synced_at,
       updated_at   = excluded.updated_at`,
    [
      targetId,
      teacherId, teacherId,
      classId,   classId,
      subjectId, subjectId,
      schoolId,  schoolId,
      resolvedTeacherJson,
      resolvedClassJson,
      resolvedSubjectJson,
      role,
      is_primary ?? 0,
      deleted_at,
      _synced    ?? 1,
      ts,
      ca,
      ua,
    ]
  );
}

/** Returns true when a JSON blob string contains a non-null $.name field. */
function _jsonHasName(jsonStr) {
  if (!jsonStr) return false;
  try {
    return !!JSON.parse(jsonStr)?.name;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SYNC MANAGER CLASS
// ═════════════════════════════════════════════════════════════════════════════

class SyncManagerClass {
  constructor() {
    this.isSyncing             = false;
    this.lastSync              = null;
    this.syncInterval          = null;
    this._initTimeout          = null;
    // The periodic tick is a safety net, not the primary freshness
    // mechanism — reconnect, foreground, and enqueue-then-drain all push
    // sooner. At 30 s a full backfill + pull + quiz sweep ran twice a minute
    // forever, which is what made the app feel sluggish while idle.
    // Five minutes, not two. The schools run over the public internet, so a
    // pull that is going to fail can spend most of a minute failing, and at
    // 120s the next tick landed almost on top of the last one — the device
    // spent its life syncing. This interval is only the safety net anyway:
    // the reconnect and foreground triggers below are what make the app
    // feel live, and they are immediate.
    this.SYNC_INTERVAL_MS      = 300_000;
    this._staleSubjectsCleared = false;
    this._classIdsRepaired     = false;
    this._destroyed            = false;
    this._migrationsDone       = false;
    this._netUnsubscribe       = null;
    this._appStateSub          = null;
    this._initInFlight         = null;
    // Last known connectivity, so the NetInfo listener can fire only on the
    // offline→online EDGE. It used to sync on every emission, which on
    // Android means every radio/type change while already online.
    this._wasConnected         = true;
    this._lastAppState         = AppState.currentState ?? "active";
    this._backgroundedAt       = null;
    // A foreground sync is only worth forcing if the app was actually away.
    // On iOS a permission dialog or a pulled-down notification shade bounces
    // inactive→active, and forcing a full sync on each of those would be
    // worse than the 30 s loop this replaces.
    this.FOREGROUND_MIN_AWAY_MS = 60_000;
    // One-time-per-session repair sweeps (dedup, orphan repair). These are
    // migrations, not sync work — running them on every tick was the single
    // most expensive thing the 30 s loop did.
    this._repairsDone          = false;
    // Two attempts, not three. With the per-request timeout raised for the
    // pull below, three attempts could occupy ~3 minutes before the sync
    // gave up — longer than the old interval, so cycles overlapped and the
    // lock rejected the next one. A link that fails twice in a row is
    // reliably down; the reconnect trigger will fire the moment it is not.
    this.MAX_RETRIES           = 2;
    this.RETRY_DELAY_MS        = 1_000;
    // School details barely change; re-reading them every sync cycle meant
    // re-downloading a ~160 KB base64 logo every 30 seconds.
    this.SCHOOL_INFO_TTL_MS    = 6 * 60 * 60 * 1_000;   // 6 hours
    this._lastSchoolInfoAt     = null;
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

      if (status === 401 || status === 403) throw err;
      if (status >= 400 && status < 500)   throw err;

      if (isNetErr && attempt > 1) {
        try {
          const net = await NetInfo.fetch();
          if (!net.isConnected) {
            console.warn(`[SyncManager] ${label} — device offline, stopping retries`);
            throw err;
          }
        } catch (netErr) {
          if (netErr === err) throw err;
        }
      }

      const shouldRetry =
        (isNetErr || isServerErr || isTimeout) && attempt < this.MAX_RETRIES;

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

  /**
   * Exchanges an offline-login sentinel token for a real one when the
   * network is back. Returns true only if the session is now usable.
   */
  async _tryUpgradeOfflineSession() {
    try {
      const { isOfflineMode } = require("../utils/authHelpers");
      if (!isOfflineMode()) return false;

      const { useAuthStore } = require("../store/auth.store");
      const upgrade = useAuthStore.getState()?.upgradeOfflineSession;
      if (typeof upgrade !== "function") return false;

      const ok = await upgrade();
      if (ok) console.log("[SyncManager] Offline session upgraded — resuming sync");
      return ok && isAuthenticated();
    } catch (err) {
      console.warn("[SyncManager] Offline session upgrade failed:", err.message);
      return false;
    }
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
         WHERE role IN ('super_admin', 'school_admin', 'admin') LIMIT 1`
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
    catch (err) { console.warn("[SyncManager] Could not persist lastSync:", err.message); }
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
    catch (err) { console.warn("[SyncManager] Could not persist quiz lastSync:", err.message); }
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
    this._classIdsRepaired     = false;

    if (!this._migrationsDone) {
      await this.runAllMigrations();
      this._migrationsDone = true;
    }

    // Register outbox reconcilers up front. backfillOutbox() registers them
    // too, but a drain can be triggered without a backfill (a screen pushing
    // after an edit), and a mutation whose reconciler is missing would sync
    // without ever adopting its server id.
    try {
      require("./syncBackfill.service").registerReconcilers();
    } catch (err) {
      console.warn("[SyncManager] Could not register reconcilers:", err.message);
    }

    // Messaging registers separately: a queued message that syncs without its
    // reconciler would stay stuck showing as "queued" in the thread even
    // though the server already has it.
    try {
      require("./message.service").registerMessageReconcilers();
    } catch (err) {
      console.warn("[SyncManager] Could not register message reconciler:", err.message);
    }

    this.startAutoSync();
    this.startTriggers();
    console.log("[SyncManager] Initialized");
  }

  /**
   * Idempotent, concurrency-safe wrapper around initialize().
   *
   * The root layout calls this on every session, and initialize() runs the
   * whole migration batch — so a double mount (or a re-render while the first
   * call is still awaiting) must not run it twice.
   */
  async ensureStarted() {
    if (!this._destroyed && this.syncInterval && this._netUnsubscribe) return;
    if (this._initInFlight) return this._initInFlight;

    this._initInFlight = this.initialize()
      .catch((err) => console.warn("[SyncManager] initialize failed:", err.message))
      .finally(() => { this._initInFlight = null; });

    return this._initInFlight;
  }

  destroy() {
    if (this._destroyed) return;
    if (this._initTimeout) { clearTimeout(this._initTimeout);  this._initTimeout = null; }
    if (this.syncInterval)  { clearInterval(this.syncInterval); this.syncInterval  = null; }
    this._netUnsubscribe?.();
    this._netUnsubscribe = null;
    this._appStateSub?.remove?.();
    this._appStateSub          = null;
    this.isSyncing             = false;
    this._staleSubjectsCleared = false;
    this._classIdsRepaired     = false;
    this._repairsDone          = false;
    this._destroyed            = true;
    console.log("[SyncManager] Destroyed");
  }

  startAutoSync() {
    if (this._destroyed) return;
    if (this._initTimeout) clearTimeout(this._initTimeout);
    if (this.syncInterval) clearInterval(this.syncInterval);

    this._initTimeout = setTimeout(() => {
      if (!this._destroyed) this.syncAll({ force: true }).catch(console.warn);
    }, 2_000);
    this.syncInterval = setInterval(() => {
      if (!this._destroyed) this.syncAll().catch(console.warn);
    }, this.SYNC_INTERVAL_MS);
  }

  /**
   * Event-driven syncs. These, not the interval, are what make the app feel
   * live: the periodic tick is now only a safety net, so it can be slow.
   *
   *   reconnect  — fires once on the offline→online edge, forced past the
   *                rate-limit gap so a queued write leaves the device
   *                immediately instead of after up to a full interval.
   *   foreground — the user is looking at the screen right now; whatever is
   *                on it should not be an hour stale.
   */
  startTriggers() {
    this._netUnsubscribe?.();
    this._netUnsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false;
      const wasConnected = this._wasConnected;
      this._wasConnected = connected;

      if (this._destroyed) return;
      if (!connected || wasConnected) return;   // only the offline→online edge

      console.log("[SyncManager] Back online — syncing now");
      this.syncAll({ force: true }).catch(console.warn);
    });

    this._appStateSub?.remove?.();
    this._appStateSub = AppState.addEventListener("change", (next) => {
      if (this._destroyed) return;

      if (next !== "active") {
        if (this._lastAppState === "active") this._backgroundedAt = Date.now();
        this._lastAppState = next;
        return;
      }

      const away = this._backgroundedAt ? Date.now() - this._backgroundedAt : 0;
      this._lastAppState = next;
      if (away < this.FOREGROUND_MIN_AWAY_MS) return;

      console.log(`[SyncManager] Foregrounded after ${Math.round(away / 1000)}s — syncing`);
      this.syncAll({ force: true }).catch(console.warn);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5 — MIGRATIONS
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
      await this.migrateExamTables();
      await this.migrateStudentEnrollColumns();
      await MutationQueue.migrateLegacyQueue();
      console.log(`[SyncManager] Migrations complete (${Date.now() - start}ms)`);
    } catch (err) {
      console.warn("[SyncManager] Migration batch failed:", err.message);
    }
  }

  /**
   * Adds the enrollment columns to `students`.
   *
   * Must run at migration time, not lazily on first enrollment: the backfill
   * sweeps filter on `_operation` to tell a locally-created student apart
   * from a pulled application awaiting a decision. If that column is absent
   * the whole query fails, and admission decisions would quietly stop syncing
   * on any device that has not enrolled anyone yet.
   */
  async migrateStudentEnrollColumns() {
    try {
      const db = await getDatabase();
      const { ensureStudentColumns } = require("./studentEnroll.service");
      await ensureStudentColumns(db);
      console.log("[SyncManager] Student enrollment columns ready");
    } catch (err) {
      console.log("[SyncManager] student columns migration skipped:", err.message);
    }
  }

  /**
   * Creates the exams / exam_subjects / exam_scores / exam_results tables.
   * Done at migration time (not lazily) so the outbox can clear `_synced`
   * on exam_scores even if no exam screen has been opened this session.
   */
  async migrateExamTables() {
    try {
      const { ensureExamTables } = require("./examCache.service");
      await ensureExamTables();
      console.log("[SyncManager] Exam tables ready");
    } catch (err) {
      console.log("[SyncManager] exam tables migration skipped:", err.message);
    }
  }

  async migrateQuizTables() {
    const db = await getDatabase();

    const creates = [
      `CREATE TABLE IF NOT EXISTS question_categories (
        id TEXT PRIMARY KEY, schoolId TEXT, name TEXT NOT NULL,
        description TEXT, parent_id TEXT, is_active INTEGER DEFAULT 1,
        deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, schoolId TEXT, category_id TEXT,
        question_text TEXT NOT NULL, question_type TEXT NOT NULL,
        media_url TEXT, difficulty TEXT DEFAULT 'medium', points REAL DEFAULT 1.0,
        explanation TEXT, is_active INTEGER DEFAULT 1, created_by TEXT,
        deleted_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS question_options (
        id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
        option_text TEXT NOT NULL, is_correct INTEGER DEFAULT 0,
        match_pair TEXT, display_order INTEGER DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS question_analytics (
        id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
        times_seen INTEGER DEFAULT 0, times_correct INTEGER DEFAULT 0,
        avg_time_secs REAL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS quizzes (
        id TEXT PRIMARY KEY, schoolId TEXT, title TEXT NOT NULL,
        description TEXT, instructions TEXT, subject_id TEXT, class_id TEXT,
        created_by TEXT, time_limit_minutes INTEGER, time_per_question INTEGER,
        shuffle_questions INTEGER DEFAULT 0, shuffle_options INTEGER DEFAULT 0,
        questions_per_page INTEGER DEFAULT 1, allow_backtrack INTEGER DEFAULT 1,
        max_attempts INTEGER DEFAULT 1, passing_score REAL DEFAULT 70,
        available_from TEXT, available_until TEXT,
        show_answers_after TEXT DEFAULT 'on_completion',
        show_score INTEGER DEFAULT 1, show_explanation INTEGER DEFAULT 1,
        is_published INTEGER DEFAULT 0, deleted_at TEXT,
        _synced INTEGER DEFAULT 0, _synced_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS quiz_questions (
        id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, question_id TEXT NOT NULL,
        display_order INTEGER DEFAULT 0, points_override REAL)`,
      `CREATE TABLE IF NOT EXISTS quiz_attempts (
        id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id TEXT NOT NULL,
        attempt_number INTEGER DEFAULT 1, status TEXT DEFAULT 'in_progress',
        raw_score REAL DEFAULT 0, max_score REAL DEFAULT 0,
        percentage REAL DEFAULT 0, is_passed INTEGER DEFAULT 0,
        started_at TEXT, submitted_at TEXT, time_taken_secs INTEGER,
        deleted_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS quiz_analytics (
        id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL,
        total_attempts INTEGER DEFAULT 0, avg_score REAL DEFAULT 0, pass_rate REAL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS attempt_answers (
        id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, question_id TEXT NOT NULL,
        time_taken INTEGER, is_correct INTEGER DEFAULT 0, points REAL DEFAULT 0,
        _synced INTEGER DEFAULT 0, _synced_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS attempt_answer_selections (
        id TEXT PRIMARY KEY, attempt_answer_id TEXT NOT NULL,
        option_id TEXT, text_response TEXT, match_response TEXT)`,
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
        await db.execAsync("CREATE INDEX IF NOT EXISTS idx_periods_dirty  ON periods(dirty)").catch(() => {});
        await db.execAsync("CREATE INDEX IF NOT EXISTS idx_periods_school ON periods(schoolId)").catch(() => {});
        return;
      }

      if (col("id")) {
        await safeAddColumn(db, "periods", "dirty",     "INTEGER DEFAULT 0");
        await safeAddColumn(db, "periods", "operation", "TEXT");
        await safeAddColumn(db, "periods", "schoolId",  "TEXT");

        // The columns every query on this table assumes. CREATE TABLE IF NOT
        // EXISTS does nothing to a table that already exists, so a device that
        // first created `periods` under an older schema kept the old shape for
        // ever — and the student timetable failed with "no such column: p.name"
        // on every open, showing an empty week with no explanation.
        //
        // NOT NULL is deliberately omitted: SQLite refuses to ADD COLUMN with a
        // NOT NULL constraint and no default, so requiring it here would make
        // the repair itself throw on the devices that need it.
        await safeAddColumn(db, "periods", "name",      "TEXT");
        await safeAddColumn(db, "periods", "starttime", "TEXT");
        await safeAddColumn(db, "periods", "endtime",   "TEXT");
        await safeAddColumn(db, "periods", "sortorder", "INTEGER DEFAULT 0");
        await safeAddColumn(db, "periods", "isbreak",   "INTEGER DEFAULT 0");
        await safeAddColumn(db, "periods", "isactive",  "INTEGER DEFAULT 1");
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

  /**
   * Bring an existing classes table up to SCHEMAS.classes.
   *
   * This used to be a hand-written list of safeAddColumn calls, which is a
   * copy of the schema that has to be remembered separately every time a
   * field is added. The class teacher is what happens when it is not.
   */
  async migrateClassesTable() {
    const db = await getDatabase();
    try {
      await ensureSchemaColumns(db, "classes");
    } catch (err) {
      console.log("[SyncManager] classes migration skipped:", err.message);
    }
  }

  async migrateSubjectsTable() {
    const db = await getDatabase();
    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS subjects (
          id TEXT PRIMARY KEY, schoolId TEXT, school_id TEXT,
          classId TEXT, class_id TEXT, name TEXT NOT NULL, code TEXT,
          teacher_id TEXT, teacher_name TEXT, deleted_at TEXT,
          _synced INTEGER DEFAULT 0, _synced_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP)
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
      const saInfo = await db.getAllAsync("PRAGMA table_info(subject_assignments)");
      if (saInfo.length) {
        await safeAddColumn(db, "subject_assignments", "_synced",    "INTEGER DEFAULT 0");
        await safeAddColumn(db, "subject_assignments", "_synced_at", "TEXT");
        await safeAddColumn(db, "subject_assignments", "deleted_at", "TEXT");
        await safeAddColumn(db, "subject_assignments", "schoolId",   "TEXT");
        await safeAddColumn(db, "subject_assignments", "created_at", "TEXT DEFAULT NULL");
        await safeAddColumn(db, "subject_assignments", "updated_at", "TEXT");
      }

      // ✅ CREATE includes role + is_primary so the table is always fully
      //    populated on first creation — avoids the "20 columns but 14 values"
      //    error that occurred when INSERT did not name columns explicitly.
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
          role         TEXT,
          is_primary   INTEGER DEFAULT 0,
          deleted_at   TEXT,
          created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at   TEXT,
          _synced      INTEGER DEFAULT 0,
          _synced_at   TEXT
        )
      `);

      // Patch any existing tables that were created before role/is_primary existed
      await safeAddColumn(db, "teacher_assignments", "role",         "TEXT");
      await safeAddColumn(db, "teacher_assignments", "is_primary",   "INTEGER DEFAULT 0");
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
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
          author_id TEXT, author_name TEXT, author_role TEXT, school_id TEXT,
          audience TEXT DEFAULT 'all', target_classes TEXT DEFAULT '[]',
          priority TEXT DEFAULT 'normal', is_pinned INTEGER DEFAULT 0,
          is_read INTEGER DEFAULT 0, is_acknowledged INTEGER DEFAULT 0,
          is_active INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
          publish_at TEXT, expires_at TEXT, deleted_at TEXT,
          _synced INTEGER DEFAULT 0, _synced_at TEXT, _operation TEXT,
          _read_pending INTEGER DEFAULT 0, _ack_pending INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP)
      `);

      const cols = [
        ["school_id","TEXT"],["author_id","TEXT"],["author_name","TEXT"],
        ["author_role","TEXT"],["audience","TEXT DEFAULT 'all'"],
        ["target_classes","TEXT DEFAULT '[]'"],["priority","TEXT DEFAULT 'normal'"],
        ["is_pinned","INTEGER DEFAULT 0"],["is_read","INTEGER DEFAULT 0"],
        ["is_acknowledged","INTEGER DEFAULT 0"],["is_active","INTEGER DEFAULT 1"],
        ["version","INTEGER DEFAULT 1"],["publish_at","TEXT"],["expires_at","TEXT"],
        ["deleted_at","TEXT"],["_synced","INTEGER DEFAULT 0"],["_synced_at","TEXT"],
        ["_operation","TEXT"],["_read_pending","INTEGER DEFAULT 0"],["_ack_pending","INTEGER DEFAULT 0"],
      ];
      for (const [col, def] of cols) await safeAddColumn(db, "announcements", col, def);

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
      for (const idx of indexes) await db.execAsync(idx).catch(() => {});

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
          id TEXT PRIMARY KEY, school_id TEXT, student_name TEXT,
          guardian_name TEXT, email TEXT, phone TEXT, grade TEXT,
          status TEXT DEFAULT 'pending', notes TEXT, deleted_at TEXT,
          _synced INTEGER DEFAULT 0, _synced_at TEXT, _operation TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP)
      `);
      await safeAddColumn(db, "student_applications", "school_id",  "TEXT");
      await safeAddColumn(db, "student_applications", "deleted_at", "TEXT");
      await safeAddColumn(db, "student_applications", "_synced",    "INTEGER DEFAULT 0");
      await safeAddColumn(db, "student_applications", "_synced_at", "TEXT");
      await safeAddColumn(db, "student_applications", "_operation", "TEXT");
      await db.execAsync("CREATE INDEX IF NOT EXISTS idx_apps_school ON student_applications(school_id)").catch(() => {});
      await db.execAsync("CREATE INDEX IF NOT EXISTS idx_apps_status ON student_applications(status)").catch(() => {});
      await db.execAsync("CREATE INDEX IF NOT EXISTS idx_apps_synced ON student_applications(_synced)").catch(() => {});
    } catch (err) {
      console.log("[SyncManager] student_applications migration skipped:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6 — MAIN SYNC ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @param {{force?: boolean}} opts  `force` bypasses the global rate-limit
   *   gap. Reconnect and foreground are edge events — the user has just done
   *   something that makes stale data visible — so they must not be dropped
   *   because a periodic tick ran a few seconds earlier.
   *
   * Precondition order matters. Everything that can decide "there is nothing
   * to do" is checked BEFORE the global lock is taken, so a no-op tick never
   * consumes the rate-limit window that the next real sync needs.
   */
  async syncAll({ force = false } = {}) {
    if (this._destroyed)    { console.log("[SyncManager] Destroyed — skipping sync");         return; }
    if (this.isSyncing)     { console.log("[SyncManager] Already syncing — skipping");        return; }

    // Cheapest check first: no radio, no point attempting a token refresh or
    // taking the lock.
    const net = await NetInfo.fetch().catch(() => ({ isConnected: true }));
    if (net.isConnected === false) {
      console.log("[SyncManager] Offline — skipping sync");
      return;
    }

    // A session created by an offline login carries the "offline_mode"
    // sentinel, which isAuthenticated() rejects. Try to exchange it for a
    // real token before giving up — otherwise everything queued during that
    // session would sit in the outbox until the user manually re-logged in.
    if (!isAuthenticated()) {
      const upgraded = await this._tryUpgradeOfflineSession();
      if (!upgraded) {
        console.log("[SyncManager] Not authenticated — skipping sync");
        return;
      }
    }

    const { user } = getCurrentAuth();
    if (user?.mustResetPassword) {
      console.log("[SyncManager] mustResetPassword — skipping sync");
      return;
    }

    const { acquireSyncLock, releaseSyncLock } = require("../store/auth.store");
    if (!acquireSyncLock({ force })) {
      console.log("[SyncManager] Global sync lock held — skipping");
      return;
    }

    this.isSyncing = true;
    console.log(`[SyncManager] Starting full sync…${force ? " (forced)" : ""}`);

    try {
      if (this._isUnauthenticated()) { console.log("[SyncManager] User logged out — aborting"); return; }

      if (!this.isStudent()) {
        await this.markOrphanedRecordsAsSynced();

        // Class-ID repair needs /admin/classes, so it belongs here rather than
        // in the student branch it used to sit in — where it could only 403.
        if (!this._classIdsRepaired) {
          await this.repairClassIds();
          this._classIdsRepaired = true;
        }
      } else if (!this._staleSubjectsCleared) {
        // Students keep the stale-subject sweep, which reads only local tables.
        await this.clearStaleSubjectsAndRepull();
        this._staleSubjectsCleared = true;
      }

      // ── PUSH ──────────────────────────────────────────────────────────────
      // Two steps, one direction of data flow:
      //   1. backfill  — turn every dirty local row into a queued mutation
      //   2. drain     — the ONLY code that sends writes to the server
      // Entity services no longer push on their own, so a mutation can no
      // longer be sent twice or escape the outbox's retry policy.
      if (this._isUnauthenticated()) return;
      await this.backfillOutbox();
      if (this._isUnauthenticated()) return;
      await this.drainOutbox();

      // ── PULL ──────────────────────────────────────────────────────────────
      if (this._isUnauthenticated()) return;
      const cursor = await this.pullChanges();

      // Commit the cursor the moment the pull itself has succeeded.
      //
      // It used to be written only after syncQuizData(), at the very end of
      // syncAll. Any throw after this point — a failing quiz sync, a dropped
      // connection, a 500 — left the cursor untouched, so the next run asked
      // for everything since 1970 again. Each retry was therefore larger and
      // slower than the one before it, and on a link flaky enough to fail
      // once it would never converge: the sync that keeps failing is the one
      // that keeps re-downloading the whole school.
      //
      // Quiz sync keeps its own cursor (getLastQuizSync), so it is not
      // covered by this one and loses nothing by being moved below it.
      if (cursor) await this.setLastSync(cursor);

      if (this._isUnauthenticated()) return;
      await this.syncQuizData();

      console.log("[SyncManager] Sync completed at", this.lastSync);
    } catch (err) {
      console.warn("[SyncManager] Sync incomplete:", err.message);
    } finally {
      this.isSyncing = false;
      releaseSyncLock();
    }
  }

  /**
   * Step 1 of the push: convert dirty local rows into queued mutations.
   * Local-only, so it is safe and cheap even with no connection.
   */
  async backfillOutbox() {
    try {
      const { backfillOutbox } = require("./syncBackfill.service");
      return await backfillOutbox();
    } catch (err) {
      console.warn("[SyncManager] backfillOutbox failed:", err.message);
      return { total: 0, byKey: {} };
    }
  }

  /**
   * Step 2 of the push, and the ONLY code in the app that sends a write to
   * the server. Attachments go first, then the mutations that reference
   * them, then the local dirty flag is cleared for whichever table the
   * mutation named in `payload.__local`.
   *
   * Every entity used to run its own pusher next to this one. Attendance was
   * the clearest casualty: enqueued here with an Idempotency-Key and swept
   * separately without one, so a row in backoff could still be sent twice.
   */
  async drainOutbox() {
    const result = await MutationQueue.drain();

    if (result.synced || result.conflicts || result.failed || result.uploads) {
      console.log("[SyncManager] Outbox", result);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 7 — REPAIR HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reconcile local class IDs against the server's, matching on class name.
   *
   * Reads /admin/classes, which is admin-only — so this can only ever run for
   * an admin session. It used to be called from the STUDENT branch of sync(),
   * where it answered 403 every time: the repair never ran for anybody, and it
   * printed a red error on the first sync of every student session, which is
   * the kind of noise that trains people to ignore real failures.
   *
   * The guard is here rather than only at the call site so the next caller
   * cannot reintroduce it by accident.
   */
  async repairClassIds() {
    if (!this.isAdmin()) {
      console.log("[SyncManager] repairClassIds: skipped — needs an admin session");
      return;
    }

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
          response.data?.classes || response.data?.data ||
          (Array.isArray(response.data) ? response.data : []);
        if (!serverClasses.length) return;

        const serverIdByName = {};
        for (const sc of serverClasses) {
          const sid  = String(sc._id || sc.id || "");
          const name = (sc.name || "").trim().toLowerCase();
          if (sid && name) serverIdByName[name] = sid;
        }

        const localClasses = await db.getAllAsync("SELECT id, name FROM classes").catch(() => []);
        let fixed = 0;
        for (const local of localClasses) {
          const key      = (local.name || "").trim().toLowerCase();
          const serverId = serverIdByName[key];
          if (!serverId) continue;
          if (local.id === serverId) {
            await db.runAsync("UPDATE classes SET _synced = 1 WHERE id = ?", [local.id]).catch(() => {});
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
        const allSubjects   = await db.getAllAsync("SELECT id, class_id, classId FROM subjects").catch(() => []);
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
      const classR = await db.runAsync(
        "UPDATE classes  SET _synced = 1, _synced_at = ? WHERE (_synced = 0 OR _synced IS NULL)", [ts]
      ).catch(() => ({ changes: 0 }));
      const subjectR = await db.runAsync(
        "UPDATE subjects SET _synced = 1, _synced_at = ? WHERE (_synced = 0 OR _synced IS NULL)", [ts]
      ).catch(() => ({ changes: 0 }));

      const cc = classR?.changes   ?? 0;
      const sc = subjectR?.changes ?? 0;
      if (cc > 0 || sc > 0) {
        console.log(`[SyncManager] Orphaned records marked synced — classes: ${cc}, subjects: ${sc}`);
      }
    } catch (err) {
      console.warn("[SyncManager] markOrphanedRecordsAsSynced failed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 8 — PUSH ORCHESTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async _reconcileClassId(db, localId, serverId) {
    const ts = new Date().toISOString();
    if (localId === serverId) {
      await db.runAsync("UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, localId]).catch(() => {});
      return;
    }

    try {
      const existing = await db.getFirstAsync("SELECT id FROM classes WHERE id = ?", [serverId]).catch(() => null);
      const cascade  = async () => {
        await db.runAsync("UPDATE subjects SET class_id = ?, classId = ? WHERE class_id = ? OR classId = ?",          [serverId, serverId, localId, localId]).catch(() => {});
        await db.runAsync("UPDATE students SET class_id = ? WHERE class_id = ?",                                       [serverId, localId]).catch(() => {});
        await db.runAsync("UPDATE teacher_assignments SET classId = ?, class_id = ? WHERE classId = ? OR class_id = ?", [serverId, serverId, localId, localId]).catch(() => {});
        await db.runAsync("UPDATE quizzes SET class_id = ? WHERE class_id = ?",                                        [serverId, localId]).catch(() => {});
      };

      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          if (existing) {
            await cascade();
            await db.runAsync("UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, serverId]);
            await db.runAsync("DELETE FROM classes WHERE id = ?", [localId]).catch(() => {});
          } else {
            await db.runAsync("UPDATE classes SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?", [serverId, ts, localId]);
            await cascade();
          }
        });
      });
    } catch (err) {
      console.error(`[SyncManager] _reconcileClassId (${localId} → ${serverId}):`, err.message);
      await db.runAsync("UPDATE classes SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, localId]).catch(() => {});
    }
  }

  async _replaceTeacherId(db, oldId, newId) {
    const ts = new Date().toISOString();
    try {
      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          const alreadyExists = await db.getFirstAsync("SELECT id FROM users WHERE id = ?", [newId]).catch(() => null);

          if (alreadyExists) {
            await db.runAsync("DELETE FROM users WHERE id = ?", [oldId]);
          } else {
            await db.runAsync("UPDATE users SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?", [newId, ts, oldId]);
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
            await db.runAsync(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [newId, oldId]).catch(() => {});
          }
        });
      });
    } catch (err) {
      console.error(`[SyncManager] _replaceTeacherId (${oldId} → ${newId}):`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 9 — ASSIGNMENT PULL
  //
  // Uses upsertAssignmentRow(), which handles BOTH the PK conflict and the
  // composite-key conflict — eliminating both UNIQUE errors.
  // ═══════════════════════════════════════════════════════════════════════════

  async pullAssignmentsFromServer() {
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

      // ── Pull server rows into SQLite ──────────────────────────────────────
      for (const a of serverAssignments) {
        const serverId = String(a._id || a.id || "");
        if (!serverId) continue;

        const teacherObj = a.teacher && typeof a.teacher === "object" ? a.teacher : null;
        const classObj   = a.class   && typeof a.class   === "object" ? a.class   : null;
        const subjectObj = a.subject && typeof a.subject === "object" ? a.subject : null;

        const teacherId =
          teacherObj?._id?.toString() || teacherObj?.id?.toString() ||
          (typeof a.teacher === "string" ? a.teacher : null) || a.teacherId || null;
        const classId =
          classObj?._id?.toString() || classObj?.id?.toString() ||
          (typeof a.class === "string" ? a.class : null) || a.classId || null;
        const subjectId =
          subjectObj?._id?.toString() || subjectObj?.id?.toString() ||
          (typeof a.subject === "string" ? a.subject : null) || a.subjectId || null;

        if (!subjectId) continue;

        let teacherName  = teacherObj?.name  || null;
        let teacherEmail = teacherObj?.email  || null;

        if (!teacherName && teacherId) {
          const localTeacher = await db.getFirstAsync(
            "SELECT name, email FROM users WHERE id = ? LIMIT 1", [teacherId]
          ).catch(() => null);
          if (localTeacher?.name) {
            teacherName  = localTeacher.name;
            teacherEmail = localTeacher.email || null;
          }
        }

        if (__DEV__ && !teacherName) {
          console.warn(`[SyncManager] teacher name missing for assignment ${serverId}`, `teacherId=${teacherId}`);
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

        // ✅ Uses upsertAssignmentRow — handles both PK and composite-key conflicts
        await upsertAssignmentRow(db, {
          id:          serverId,
          teacherId,   classId,   subjectId,
          schoolId:    a.schoolId || schoolId,
          teacherJson, classJson, subjectJson,
          _synced:     1,
          _synced_at:  ts,
          created_at:  a.createdAt || ts,
          updated_at:  a.updatedAt || ts,
        }).catch((err) =>
          console.warn(`[SyncManager] upsertAssignmentRow ${serverId}:`, err.message)
        );

        if (teacherId && subjectId) {
          await db.runAsync(
            `UPDATE subjects SET teacher_id = ?, updated_at = ?, _synced = 1
             WHERE id = ? AND (teacher_id IS NULL OR teacher_id = '' OR teacher_id != ?)`,
            [teacherId, ts, subjectId, teacherId]
          ).catch(() => {});
        }
      }

      // ── Push unsynced local rows to server ────────────────────────────────
      const serverLookup = new Set(
        serverAssignments.map((a) => {
          const t = (typeof a.teacher === "string" ? a.teacher : a.teacher?._id || a.teacher?.id) || "";
          const c = (typeof a.class   === "string" ? a.class   : a.class?._id   || a.class?.id)   || "";
          const s = (typeof a.subject === "string" ? a.subject : a.subject?._id || a.subject?.id) || "";
          return `${t}|${c}|${s}`;
        })
      );

      // ── Retire local rows the server already has ─────────────────────────
      //
      // Purely local bookkeeping: if an equivalent assignment already exists
      // upstream, clear the dirty flag so the backfill does not queue a
      // duplicate POST. Assignments that genuinely need creating are queued
      // by the backfill sweep and sent by drainOutbox — this function no
      // longer pushes anything itself.
      const unsynced = await db.getAllAsync(
        `SELECT ta.id, ta.teacherId, ta.teacher_id, ta.classId, ta.class_id,
                ta.subjectId, ta.subject_id
         FROM teacher_assignments ta
         WHERE (ta._synced = 0 OR ta._synced IS NULL) AND ${NOT_DELETED_TA}`
      ).catch(() => []);

      let retired = 0;
      for (const a of unsynced) {
        const key = [
          a.teacherId || a.teacher_id,
          a.classId   || a.class_id,
          a.subjectId || a.subject_id,
        ].join("|");

        if (serverLookup.has(key)) {
          await db.runAsync(
            "UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, a.id]
          ).catch(() => {});
          retired++;
        }
      }

      console.log(
        `[SyncManager] Assignment pull complete` +
        (retired ? ` — ${retired} local row(s) already upstream` : "")
      );
    } catch (err) {
      console.warn("[SyncManager] pullAssignmentsFromServer failed:", err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 10 — PULL ORCHESTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async pullChanges() {
    if (this._isUnauthenticated()) return;

    const schoolId = await this.getSchoolId();
    if (!schoolId) { console.warn("[SyncManager] No schoolId — skipping pull"); return; }

    // Cursor for the NEXT pull. Seeded from the device clock and replaced
    // by the server's own timestamp below; the seed only survives for a
    // student, whose branch never calls /sync/pull at all.
    let cursor = new Date().toISOString();

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
          () => api.get(API.sync.pull, {
            params: { schoolId, lastSync: lastSyncTime },
            // Longer than the 30s default: the first pull after an install
            // carries the whole school in a single response, and over a WAN
            // that can legitimately outlast 30s while the server is working
            // perfectly well. Every later pull is incremental — the cursor
            // is committed as soon as this call succeeds — so this ceiling
            // is reached once, not routinely.
            timeout: 60_000,
          })
        );
        // Prefer the server's clock over this device's. A phone running
        // even a minute fast would otherwise store a cursor ahead of the
        // server and skip every record stamped in the gap, for good.
        const serverTs = response.data?.timestamp;
        if (serverTs) cursor = serverTs;

        const data = response.data?.data;
        if (data) {
          // Sequential, not Promise.all: these all write through the one
          // SQLite connection, so running two of them at once bought no
          // parallelism and would interleave their transactions.
          await this.syncClasses(data.classes);
          await this.syncSubjects(data.subjects);
          await this.syncTeachers(data.teachers);
          await this.syncPeriods(data.periods);
          await this.syncAssignments(data.assignments);
          await this.syncStudents(data.students);
        }
      }

      // Full assignment list — richer than the /sync/pull slice (it carries
      // teacher/class/subject name blobs) and it retires local rows the
      // server already has so the backfill won't queue duplicates.
      if (this.isAdmin()) await this.pullAssignmentsFromServer();

      await this.pullAnnouncements(lastSyncTime);
      if (this.isAdmin()) await this.pullStudentApplications(lastSyncTime);
      await this.syncSchoolInfo();
      console.log("[SyncManager] Pull complete");
      return cursor;
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
  // SECTION 11 — SCHOOL INFO
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Refreshes the cached school record.
   *
   * School details are effectively static, but this ran on every sync cycle
   * and the response carried the logo — an inline base64 string of ~160 KB
   * that took the server seconds to read from the remote cluster. The result
   * was a 160 KB download every 30 s that regularly exceeded the 8 s timeout
   * and logged "No response ← /admin/school-info".
   *
   * Now: the light record is fetched at most once per SCHOOL_INFO_TTL_MS, the
   * logo is requested only when the server's fingerprint says our cached copy
   * is missing or stale, and a failure never discards what we already have.
   */
  async syncSchoolInfo({ force = false } = {}) {
    if (this._isUnauthenticated() || this.isStudent()) return;

    const schoolId = await this.getSchoolId();
    if (!schoolId) return;

    // Throttle — static data does not need re-fetching every cycle.
    if (!force && this._lastSchoolInfoAt) {
      const age = Date.now() - this._lastSchoolInfoAt;
      if (age < this.SCHOOL_INFO_TTL_MS) return;
    }

    let cachedSchool = null;
    try {
      const { getSchoolLocal } = require("./school.service");
      cachedSchool = await getSchoolLocal(schoolId);
    } catch { /* non-fatal */ }

    const cachedLogo    = cachedSchool?.logo || "";
    const cachedLogoLen = cachedLogo.length;

    const fetch = async (includeLogo) => {
      const params  = { schoolId, ...(includeLogo ? { includeLogo: 1 } : {}) };
      // The light call is small; the logo call needs room to move ~160 KB.
      const timeout = includeLogo ? 45_000 : 12_000;

      if (this.isAdmin()) {
        try {
          return await api.get(API.admin.school, { params, timeout });
        } catch (err) {
          const status = err?.response?.status;
          if (status === 404 || status === 405) {
            return await api.get("/teacher/school/info", { params, timeout });
          }
          throw err;
        }
      }
      if (this.isTeacher()) {
        return await api.get("/teacher/school/info", { params, timeout });
      }
      return null;
    };

    try {
      const response = await fetch(false);
      if (!response) return;

      const school =
        response.data?.school || response.data?.data || response.data || null;
      if (!school?.name) return;

      const id = String(
        school._id?.$oid || school._id || school.id || schoolId
      ).trim();
      if (!id) return;

      const { isRemoteLogo } = require("../utils/logoUri");
      const { cacheLogo, pruneLogos, isCached } =
        require("./logoCache.service");

      let logo      = cachedLogo;
      let logoLocal = cachedSchool?.logoLocal || "";
      let note      = "";

      if (isRemoteLogo(school.logo)) {
        // Migrated school: the logo is a URL whose filename carries a content
        // hash, so a changed image means a changed URL. Compare strings and
        // download only when the cached file is missing or for a different URL.
        logo = String(school.logo).trim();
        const urlChanged = logo !== cachedLogo;

        if (urlChanged || !isCached(logoLocal)) {
          const cached = await cacheLogo(id, logo, { force: urlChanged });
          if (cached) {
            logoLocal = cached;
            note = urlChanged ? " (logo updated)" : " (logo cached)";
            await pruneLogos(id, cached);
          } else if (urlChanged) {
            // Keep the old file: a stale logo beats no logo offline.
            note = " (logo download pending)";
          }
        }
      } else {
        // Legacy inline logo, still opt-in behind a fingerprint. `logoLen:
        // null` means the server could not determine it — treat that as
        // "unchanged" so a probe failure never discards a good cached logo.
        const serverLogoLen = school.logoLen;
        const needsLogo =
          typeof serverLogoLen === "number" &&
          serverLogoLen > 0 &&
          serverLogoLen !== cachedLogoLen;

        if (needsLogo) {
          console.log(
            `[SyncManager] School logo changed (${cachedLogoLen}B → ${serverLogoLen}B) — downloading`
          );
          try {
            const full = await fetch(true);
            const withLogo = full?.data?.school || full?.data?.data || null;
            if (withLogo?.logo) {
              logo = withLogo.logo;
              note = " (logo refreshed)";
            }
          } catch (err) {
            console.warn(
              "[SyncManager] Logo download failed — keeping cached copy:", err.message
            );
          }
        } else if (typeof serverLogoLen === "number" && serverLogoLen === 0) {
          logo = "";        // genuinely removed upstream
          logoLocal = "";
        }
      }

      const { upsertSchoolLocal } = require("./school.service");
      await upsertSchoolLocal({
        id,
        name:      school.name    || "",
        logo,
        logoLocal,
        email:     school.email   || "",
        phone:     school.phone   || "",
        address:   school.address || "",
        city:      school.city    || "",
        state:     school.state   || "",
        country:   school.country || "",
        website:   school.website || "",
        motto:     school.motto   || "",
        code:      school.code    || "",
      });

      this._lastSchoolInfoAt = Date.now();
      console.log(`[SyncManager] School info saved: "${school.name}"${note}`);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        console.warn(`[SyncManager] syncSchoolInfo: ${status} — skipping`);
        // Don't hammer a route this role cannot use.
        this._lastSchoolInfoAt = Date.now();
      } else if (cachedSchool) {
        console.log("[SyncManager] syncSchoolInfo: network error — using cached school data");
      } else {
        console.warn("[SyncManager] syncSchoolInfo failed (non-fatal):", err.message);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 12 — ENTITY SYNC (PULL)
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
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP)
    `).catch(() => {});

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
      for (const p of periods) {
        try {
          const id = p._id || p.id;
          if (!id) continue;
          const local = await db.getFirstAsync("SELECT dirty FROM periods WHERE id = ?", [id]).catch(() => null);
          if (local?.dirty) continue;

          await db.runAsync(
            `INSERT OR REPLACE INTO periods
               (id, schoolId, name, starttime, endtime, sortorder, isbreak, isactive, version, dirty, updated_at)
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
    });
    console.log(`[SyncManager] Periods: ${ok} synced, ${fail} failed`);
  }

  async syncClasses(classes) {
    if (!classes?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
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
               (id, schoolId, school_id, name, level, section,
                classTeacherId, classTeacherName,
                is_active, _synced, deleted_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, level = excluded.level, section = excluded.section,
               classTeacherId   = excluded.classTeacherId,
               classTeacherName = excluded.classTeacherName,
               is_active = excluded.is_active, _synced = 1, deleted_at = NULL,
               updated_at = excluded.updated_at`,
            [
              String(id), c.schoolId, c.schoolId,
              c.name, c.level || null, c.section || "",
              // Both spellings, because /admin/classes answers with the
              // Mongoose document and /sync/pull answers with the mirrored
              // row, and the two have differed before.
              c.classTeacherId   ?? c.class_teacher_id   ?? null,
              c.classTeacherName ?? c.class_teacher_name ?? null,
              c.isActive !== false ? 1 : 0, c.updatedAt || ts,
            ]
          );
          ok++;
        } catch (err) {
          console.warn(`[SyncManager] syncClasses row ${c._id || c.id}:`, err.message);
          fail++;
        }
      }
    });
    console.log(`[SyncManager] Classes: ${ok} synced, ${fail} failed`);
  }

  async syncTeachers(teachers) {
    if (!teachers?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
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
                must_reset_password, _synced, _synced_at, deleted_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'teacher', ?, ?, 1, ?, NULL, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               schoolId = excluded.schoolId, school_id = excluded.school_id,
               name = excluded.name, email = excluded.email,
               is_active = excluded.is_active,
               must_reset_password = excluded.must_reset_password,
               _synced = 1, _synced_at = excluded._synced_at,
               deleted_at = NULL, updated_at = excluded.updated_at`,
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
    });
    console.log(`[SyncManager] Teachers: ${ok} synced, ${fail} failed`);
  }

  async syncSubjects(subjects) {
    if (!subjects?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
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
               schoolId = excluded.schoolId, school_id = excluded.school_id,
               classId = excluded.classId, class_id = excluded.class_id,
               name = excluded.name, code = excluded.code,
               teacher_id = excluded.teacher_id, teacher_name = excluded.teacher_name,
               _synced = 1, deleted_at = NULL, updated_at = excluded.updated_at`,
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
    });
    console.log(`[SyncManager] Subjects: ${ok} synced, ${fail} failed`);
  }

  /**
   * Persists the `students` array from /sync/pull.
   *
   * The backend has always returned this (sync.controller.js normalises it),
   * but the client discarded it — so the local roster only ever filled in
   * when someone happened to open the admin students screen, which fetches
   * /admin/students separately.
   */
  async syncStudents(students) {
    if (!students?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
      for (const s of students) {
        try {
          const id = s.id || s._id;
          if (!id) { fail++; continue; }

          if (s.deletedAt || s.deleted_at) {
            await db.runAsync(
              "UPDATE students SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ?",
              [s.deletedAt || s.deleted_at, ts, String(id)]
            );
            ok++; continue;
          }

          const classId = s.classId || s.class_id || null;

          await db.runAsync(
            `INSERT INTO students
               (id, schoolId, school_id, classId, class_id, user_id,
                name, studentName, admissionNo, admissionNumber, enrollmentNo,
                email, is_active, status, deleted_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               schoolId        = COALESCE(excluded.schoolId, students.schoolId),
               school_id       = COALESCE(excluded.school_id, students.school_id),
               classId         = COALESCE(excluded.classId, students.classId),
               class_id        = COALESCE(excluded.class_id, students.class_id),
               user_id         = COALESCE(excluded.user_id, students.user_id),
               name            = excluded.name,
               studentName     = excluded.studentName,
               admissionNo     = COALESCE(excluded.admissionNo, students.admissionNo),
               admissionNumber = COALESCE(excluded.admissionNumber, students.admissionNumber),
               enrollmentNo    = COALESCE(excluded.enrollmentNo, students.enrollmentNo),
               email           = COALESCE(excluded.email, students.email),
               is_active       = excluded.is_active,
               status          = excluded.status,
               deleted_at      = NULL,
               updated_at      = excluded.updated_at`,
            [
              String(id),
              s.schoolId || null, s.schoolId || null,
              classId ? String(classId) : null,
              classId ? String(classId) : null,
              s.userId || null,
              s.name || s.studentName || "Unknown",
              s.studentName || s.name || "Unknown",
              s.admissionNo || null, s.admissionNo || null,
              s.enrollmentNo || null,
              s.email || null,
              s.isActive !== false ? 1 : 0,
              s.status || "approved",
              s.createdAt || ts,
              s.updatedAt || ts,
            ]
          );
          ok++;
        } catch (err) {
          console.warn(`[SyncManager] syncStudents row ${s.id || s._id}:`, err.message);
          fail++;
        }
      }
    });
    console.log(`[SyncManager] Students: ${ok} synced, ${fail} failed`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 13 — ASSIGNMENT PULL
  //
  // FIX: Uses upsertAssignmentRow() — handles composite-key UNIQUE conflicts
  // that previously caused "UNIQUE constraint failed" on every second sync.
  // ═══════════════════════════════════════════════════════════════════════════

  async syncAssignments(assignments) {
    if (!assignments?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
      for (const a of assignments) {
        try {
          const id = a._id || a.id;
          if (!id) { fail++; continue; }

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
              await db.runAsync(
                "UPDATE subjects SET teacher_id = NULL, updated_at = ? WHERE id = ?", [ts, subjectId]
              ).catch(() => {});
            }
            ok++; continue;
          }

          const teacherJson =
            a.teacher && typeof a.teacher === "object"
              ? JSON.stringify({ _id: teacherId, id: teacherId, name: a.teacher.name, email: a.teacher.email })
              : null;
          const classJson =
            a.class && typeof a.class === "object"
              ? JSON.stringify({ _id: classId, id: classId, name: a.class.name })
              : null;
          const subjectJson =
            a.subject && typeof a.subject === "object"
              ? JSON.stringify({ _id: subjectId, id: subjectId, name: a.subject.name })
              : null;

          // ✅ upsertAssignmentRow handles both PK and composite-key conflicts
          await upsertAssignmentRow(db, {
            id:          String(id),
            teacherId,   classId,   subjectId,
            schoolId:    a.schoolId || null,
            teacherJson, classJson, subjectJson,
            _synced:     1,
            _synced_at:  ts,
            created_at:  a.createdAt || a.created_at || ts,
            updated_at:  a.updatedAt || a.updated_at || ts,
            deleted_at:  null,
          });

          if (subjectId && teacherId) {
            await db.runAsync(
              `UPDATE subjects SET teacher_id = ?, updated_at = ?, _synced = 1
               WHERE id = ? AND (teacher_id IS NULL OR teacher_id = '' OR teacher_id != ?)`,
              [teacherId, ts, subjectId, teacherId]
            ).catch(() => {});
          }
          ok++;
        } catch (err) {
          console.warn(`[SyncManager] syncAssignments row ${a._id || a.id}:`, err.message);
          fail++;
        }
      }
    });
    console.log(`[SyncManager] Assignments: ${ok} synced, ${fail} failed`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 14 — QUIZ SYNC (pull only)
  //
  // Quiz pushes are no longer here: questions, quizzes and attempts are
  // queued by the backfill sweep and sent by drainOutbox() like every other
  // mutation. What remains is repair plus pull.
  // ═══════════════════════════════════════════════════════════════════════════

  async syncQuizData() {
    if (this._isUnauthenticated()) return;
    const schoolId = await this.getSchoolId();
    if (!schoolId) return;

    console.log("[SyncManager] Quiz sync starting…");

    try {
      if (this.isStudent()) {
        await this.pullQuizData(schoolId);
      } else {
        // Repairs, not sync. Each is a full-table scan — the two dedups
        // GROUP BY unindexed TEXT columns and the option cleanup is a
        // NOT IN anti-join — so they ran as an O(n) sweep on every tick.
        // Once per session is enough: nothing after the first pass can
        // reintroduce a duplicate that pullQuizData's upserts would not
        // have overwritten anyway.
        if (!this._repairsDone) {
          await this._deduplicateQuestions();
          await this._deduplicateQuestionOptions();
          await this._repairQuizzesWithoutClassId(schoolId);
          this._repairsDone = true;
        }
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
    const exists = await db.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'questions'`
    ).catch(() => null);
    if (!exists) await this.migrateQuizTables();

    await withFkOff(db, async () => {
      try {
        const result = await db.runAsync(
          `DELETE FROM questions
           WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM questions
             GROUP BY schoolId, question_text, question_type, created_by
           ) AND ${NOT_DELETED_BARE}`
        );
        if (result.changes > 0) console.log(`[SyncManager] Removed ${result.changes} duplicate question(s)`);
        await db.runAsync("DELETE FROM question_options   WHERE question_id NOT IN (SELECT id FROM questions)").catch(() => {});
        await db.runAsync("DELETE FROM question_analytics WHERE question_id NOT IN (SELECT id FROM questions)").catch(() => {});
      } catch (err) {
        console.warn("[SyncManager] _deduplicateQuestions failed:", err.message);
      }
    });
  }

  async _deduplicateQuestionOptions() {
    const db = await getDatabase();
    const exists = await db.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'question_options'`
    ).catch(() => null);
    if (!exists) await this.migrateQuizTables();

    await withFkOff(db, async () => {
      try {
        const result = await db.runAsync(
          `DELETE FROM question_options
           WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM question_options
             GROUP BY question_id, display_order, option_text
           )`
        );
        if (result.changes > 0) console.log(`[SyncManager] Removed ${result.changes} duplicate question option(s)`);
      } catch (err) {
        console.warn("[SyncManager] _deduplicateQuestionOptions failed:", err.message);
      }
    });
  }

  async _repairQuizzesWithoutClassId(schoolId) {
    if (this._isUnauthenticated()) return;
    const db = await getDatabase();

    try {
      const broken = await db.getAllAsync(
        `SELECT id, title, subject_id, created_by, class_id FROM quizzes
         WHERE ((class_id IS NULL OR class_id = '') OR (subject_id IS NULL OR subject_id = ''))
           AND ${NOT_DELETED_BARE} AND schoolId = ?`,
        [schoolId]
      ).catch(() => []);

      if (!broken.length) return;
      console.log(`[SyncManager] Repairing ${broken.length} quiz(zes) missing class/subject…`);

      let serverAssignmentCache = null;
      const fetchServerAssignments = async () => {
        if (serverAssignmentCache) return serverAssignmentCache;
        try {
          const endpoints = this.isTeacher()
            ? [API.teacher.myAssignments]
            : this.isAdmin() ? [API.admin.assignments.list] : [];

          for (const ep of endpoints) {
            try {
              const res  = await api.get(ep, { params: { schoolId } });
              const list = res.data?.assignments || res.data?.data || (Array.isArray(res.data) ? res.data : []);
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
          const subj = await db.getFirstAsync(
            "SELECT class_id, classId FROM subjects WHERE id = ? LIMIT 1", [quiz.subject_id]
          ).catch(() => null);
          recoveredClassId = subj?.class_id || subj?.classId || null;
        }

        if ((!recoveredClassId || !recoveredSubjectId) && quiz.created_by) {
          const assign = await db.getFirstAsync(
            `SELECT classId, class_id, subjectId, subject_id FROM teacher_assignments
             WHERE (teacherId = ? OR teacher_id = ?) AND ${NOT_DELETED_BARE} LIMIT 1`,
            [quiz.created_by, quiz.created_by]
          ).catch(() => null);
          if (!recoveredClassId)   recoveredClassId   = assign?.classId   || assign?.class_id   || null;
          if (!recoveredSubjectId) recoveredSubjectId = assign?.subjectId || assign?.subject_id || null;
        }

        if ((!recoveredClassId || !recoveredSubjectId) && quiz.created_by) {
          const list = await fetchServerAssignments();
          if (list.length) {
            const first = list[0];
            if (!recoveredClassId) {
              recoveredClassId = (typeof first.class === "string" ? first.class : null) || first.class?._id || first.class?.id || first.classId || null;
            }
            if (!recoveredSubjectId) {
              recoveredSubjectId = (typeof first.subject === "string" ? first.subject : null) || first.subject?._id || first.subject?.id || first.subjectId || null;
            }
            if (recoveredClassId) await this.syncAssignments(list).catch(() => {});
          }
        }

        if (recoveredClassId || recoveredSubjectId) {
          const sets = [], params = [];
          if (recoveredClassId   && !quiz.class_id)   { sets.push("class_id = ?");   params.push(recoveredClassId); }
          if (recoveredSubjectId && !quiz.subject_id) { sets.push("subject_id = ?"); params.push(recoveredSubjectId); }
          sets.push("_synced = 0");
          params.push(quiz.id);
          await db.runAsync(`UPDATE quizzes SET ${sets.join(", ")} WHERE id = ?`, params)
            .catch((err) => console.warn(`[SyncManager] Repair quiz ${quiz.id}:`, err.message));
        }
      }
    } catch (err) {
      console.warn("[SyncManager] _repairQuizzesWithoutClassId failed:", err.message);
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

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
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
               name = excluded.name, description = excluded.description,
               parent_id = excluded.parent_id, is_active = excluded.is_active,
               updated_at = excluded.updated_at`,
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
    });
    console.log(`[SyncManager] Quiz categories: ${ok} synced, ${fail} failed`);
  }

  async syncQuizQuestions(questions) {
    if (!questions?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
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
            const catOk = await db.getFirstAsync(
              "SELECT id FROM question_categories WHERE id = ? LIMIT 1", [String(categoryId)]
            ).catch(() => null);
            if (!catOk) categoryId = null;
          }

          await db.runAsync(
            `INSERT INTO questions (
               id, schoolId, category_id, question_text, question_type,
               media_url, difficulty, points, explanation,
               is_active, created_by, _synced, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               category_id = excluded.category_id, question_text = excluded.question_text,
               question_type = excluded.question_type, media_url = excluded.media_url,
               difficulty = excluded.difficulty, points = excluded.points,
               explanation = excluded.explanation, is_active = excluded.is_active,
               _synced = 1, updated_at = excluded.updated_at`,
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
                     option_text = excluded.option_text, is_correct = excluded.is_correct,
                     match_pair = excluded.match_pair, display_order = excluded.display_order`,
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

          await db.runAsync(
            "INSERT OR IGNORE INTO question_analytics (id, question_id) VALUES (?, ?)",
            [generateUUID(), String(id)]
          ).catch(() => {});

          ok++;
        } catch (err) {
          console.warn(`[SyncManager] syncQuizQuestion ${q._id || q.id}:`, err.message);
          fail++;
        }
      }
    });
    console.log(`[SyncManager] Quiz questions: ${ok} synced, ${fail} failed`);
  }

  async syncQuizzes(quizzes) {
    if (!quizzes?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
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
               schoolId = excluded.schoolId, title = excluded.title,
               description = excluded.description, instructions = excluded.instructions,
               subject_id = excluded.subject_id, class_id = excluded.class_id,
               created_by = excluded.created_by,
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
               deleted_at         = NULL, _synced = 1`,
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
              (q.available_from  || q.availableFrom)  ? new Date(q.available_from  || q.availableFrom).toISOString()  : null,
              (q.available_until || q.availableUntil) ? new Date(q.available_until || q.availableUntil).toISOString() : null,
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
            await db.runAsync(
              `INSERT OR IGNORE INTO quiz_questions
                 (id, quiz_id, question_id, display_order, points_override)
               VALUES (?, ?, ?, ?, ?)`,
              [linkId, id, String(qId), link.display_order ?? link.displayOrder ?? 0, link.points_override ?? link.pointsOverride ?? null]
            ).catch(() => {});
          }

          await db.runAsync(
            "INSERT OR IGNORE INTO quiz_analytics (id, quiz_id) VALUES (?, ?)", [generateUUID(), id]
          ).catch(() => {});

          ok++;
        } catch (err) {
          console.warn(`[SyncManager] syncQuiz ${q._id || q.id}:`, err.message);
          fail++;
        }
      }
    });
    console.log(`[SyncManager] Quizzes: ${ok} synced, ${fail} failed`);
  }

  async syncQuizAttempts(attempts) {
    if (!attempts?.length) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    let ok = 0, fail = 0;

    // One commit for the whole batch. expo-sqlite autocommits (and in WAL
    // mode fsyncs) every loose statement, so a pull of 500 rows meant 500
    // commits on the JS thread — the main reason a sync visibly stalled the
    // UI. Row-level try/catch still skips a bad row.
    await withTransaction(db, async () => {
      for (const a of attempts) {
        try {
          const id = a._id || a.id;
          if (!id) continue;

          const local = await db.getFirstAsync(
            "SELECT status FROM quiz_attempts WHERE id = ?", [String(id)]
          ).catch(() => null);
          if (local?.status === "in_progress") continue;

          await db.runAsync(
            `INSERT INTO quiz_attempts (
               id, quiz_id, user_id, attempt_number, status,
               raw_score, max_score, percentage, is_passed,
               started_at, submitted_at, time_taken_secs, _synced, _synced_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(id) DO UPDATE SET
               status = excluded.status, raw_score = excluded.raw_score,
               max_score = excluded.max_score, percentage = excluded.percentage,
               is_passed = excluded.is_passed, submitted_at = excluded.submitted_at,
               time_taken_secs = excluded.time_taken_secs, _synced = 1, _synced_at = excluded._synced_at`,
            [
              String(id), a.quiz_id || a.quizId, a.user_id || a.userId,
              a.attempt_number || a.attemptNumber || 1,
              a.status         || "submitted",
              a.raw_score      ?? a.rawScore  ?? 0,
              a.max_score      ?? a.maxScore  ?? 0,
              a.percentage     ?? 0,
              (a.is_passed     ?? a.isPassed  ?? false) ? 1 : 0,
              a.started_at     || a.startedAt   || ts,
              a.submitted_at   || a.submittedAt || null,
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
    });
    console.log(`[SyncManager] Quiz attempts: ${ok} synced, ${fail} failed`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 15 — PUBLIC UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  async forceSync() {
    this._staleSubjectsCleared = false;
    this._classIdsRepaired     = false;
    this._lastSchoolInfoAt     = null;   // let school info refresh too
    await this.resetLastSync();
    return this.syncAll();
  }
}

export const SyncManager = new SyncManagerClass();
export default SyncManager;