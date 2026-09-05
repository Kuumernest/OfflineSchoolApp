// src/services/examCache.service.js
"use strict";

/**
 * Local store for exams, mark sheets and computed results.
 *
 * Exams were the one domain with no offline story at all: exam.service and
 * results.service were pure passthroughs to axios, and no SQLite table for
 * them existed anywhere. Entering marks in a classroom with no signal — the
 * single most predictable offline moment in a school — failed outright, and
 * students could not open a result they had already been shown.
 *
 * Division of labour:
 *   - Exams, exam subjects and scores are authored on the device, so they
 *     are cached AND writable offline (writes go through MutationQueue).
 *   - Results, rankings and stats are computed by the server from every
 *     class's marks. They cannot be derived correctly on one device, so
 *     they are read-through cached: fresh when online, last-known when not.
 *     Callers get an `isStale` flag so the UI can say so.
 */

import { getDatabase } from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { generateUUID } from "../utils/idHelpers";

const SCHEMA_KEY = "exam_tables";

// ═════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ═════════════════════════════════════════════════════════════════════════════

export const ensureExamTables = async () => {
  const db = await getDatabase();
  return ensureTableSchema(SCHEMA_KEY, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS exams (
      id            TEXT PRIMARY KEY,
      schoolId      TEXT,
      classId       TEXT,
      className     TEXT,
      name          TEXT,
      type          TEXT,
      academicYear  TEXT,
      term          TEXT,
      startDate     TEXT,
      endDate       TEXT,
      status        TEXT DEFAULT 'draft',
      description   TEXT,
      instructions  TEXT,
      totalMarks    REAL DEFAULT 100,
      passMark      REAL DEFAULT 50,
      resultsPublished INTEGER DEFAULT 0,
      createdBy     TEXT,
      extra_json    TEXT,
      deleted_at    TEXT,
      _synced       INTEGER DEFAULT 1,
      _synced_at    TEXT,
      created_at    TEXT,
      updated_at    TEXT
    )`);

    await database.execAsync(`CREATE TABLE IF NOT EXISTS exam_subjects (
      id               TEXT PRIMARY KEY,
      examId           TEXT NOT NULL,
      subjectId        TEXT,
      classId          TEXT,
      schoolId         TEXT,
      teacherId        TEXT,
      subjectName      TEXT,
      teacherName      TEXT,
      maxScore         REAL DEFAULT 100,
      passMark         REAL DEFAULT 50,
      weight           REAL DEFAULT 100,
      submissionStatus TEXT DEFAULT 'pending',
      submittedAt      TEXT,
      rejectReason     TEXT,
      deleted_at       TEXT,
      _synced          INTEGER DEFAULT 1,
      _synced_at       TEXT,
      updated_at       TEXT
    )`);

    await database.execAsync(`CREATE TABLE IF NOT EXISTS exam_scores (
      id            TEXT PRIMARY KEY,
      examId        TEXT NOT NULL,
      examSubjectId TEXT,
      studentId     TEXT NOT NULL,
      subjectId     TEXT NOT NULL,
      classId       TEXT,
      schoolId      TEXT,
      studentName   TEXT,
      score         REAL,
      maxScore      REAL DEFAULT 100,
      passMark      REAL DEFAULT 50,
      percentage    REAL,
      grade         TEXT,
      remark        TEXT,
      isAbsent      INTEGER DEFAULT 0,
      isExempt      INTEGER DEFAULT 0,
      teacherRemark TEXT,
      enteredBy     TEXT,
      enteredAt     TEXT,
      deleted_at    TEXT,
      _synced       INTEGER DEFAULT 1,
      _synced_at    TEXT,
      updated_at    TEXT
    )`);

    // One score per student per subject per exam. Lets an offline re-entry
    // overwrite the earlier value instead of duplicating the mark sheet.
    await database.execAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_exam_scores_logical
       ON exam_scores(examId, studentId, subjectId)`
    ).catch(() => {});

    await database.execAsync(`CREATE TABLE IF NOT EXISTS exam_results (
      id             TEXT PRIMARY KEY,
      examId         TEXT NOT NULL,
      studentId      TEXT NOT NULL,
      classId        TEXT,
      schoolId       TEXT,
      studentName    TEXT,
      admissionNo    TEXT,
      className      TEXT,
      academicYear   TEXT,
      term           TEXT,
      subject_scores TEXT,
      totalScore     REAL DEFAULT 0,
      totalMaxScore  REAL DEFAULT 0,
      percentage     REAL DEFAULT 0,
      average        REAL DEFAULT 0,
      gpa            REAL DEFAULT 0,
      subjectsPassed INTEGER DEFAULT 0,
      subjectsFailed INTEGER DEFAULT 0,
      classRank      INTEGER,
      isPublished    INTEGER DEFAULT 0,
      cached_at      TEXT,
      updated_at     TEXT
    )`);

    await database.execAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_exam_results_logical
       ON exam_results(examId, studentId)`
    ).catch(() => {});

    // Server-computed aggregates (stats, rankings, report cards) that have no
    // meaningful local representation. Keyed blobs with a cache timestamp.
    await database.execAsync(`CREATE TABLE IF NOT EXISTS exam_blobs (
      key       TEXT PRIMARY KEY,
      payload   TEXT,
      cached_at TEXT
    )`);

    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_exams_school     ON exams(schoolId, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_exams_status     ON exams(status)",
      "CREATE INDEX IF NOT EXISTS idx_exsub_exam       ON exam_subjects(examId)",
      "CREATE INDEX IF NOT EXISTS idx_exsub_teacher    ON exam_subjects(teacherId)",
      "CREATE INDEX IF NOT EXISTS idx_scores_exam      ON exam_scores(examId, classId, subjectId)",
      "CREATE INDEX IF NOT EXISTS idx_scores_student   ON exam_scores(studentId)",
      "CREATE INDEX IF NOT EXISTS idx_scores_synced    ON exam_scores(_synced)",
      "CREATE INDEX IF NOT EXISTS idx_results_exam     ON exam_results(examId, classId)",
      "CREATE INDEX IF NOT EXISTS idx_results_student  ON exam_results(studentId)",
    ];
    for (const sql of indexes) await database.execAsync(sql).catch(() => {});
  }, db);
};

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const idOf = (o) => String(o?._id || o?.id || "");
const bool = (v) => (v ? 1 : 0);
const nowIso = () => new Date().toISOString();

const parseJson = (s, fallback = null) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

/** Percentage a device can compute without the server's grading config. */
export const computePercentage = (score, maxScore) => {
  const s = Number(score);
  const m = Number(maxScore);
  if (!isFinite(s) || !isFinite(m) || m <= 0) return null;
  return Math.round((s / m) * 10000) / 100;
};

// ═════════════════════════════════════════════════════════════════════════════
// EXAMS
// ═════════════════════════════════════════════════════════════════════════════

export const cacheExams = async (exams = []) => {
  if (!exams?.length) return 0;
  await ensureExamTables();
  const db = await getDatabase();
  const ts = nowIso();
  let n = 0;

  for (const e of exams) {
    const id = idOf(e);
    if (!id) continue;
    try {
      if (e.deletedAt || e.deleted_at) {
        await db.runAsync("UPDATE exams SET deleted_at = ?, updated_at = ? WHERE id = ?",
          [e.deletedAt || e.deleted_at, ts, id]);
        n++; continue;
      }

      await db.runAsync(
        `INSERT INTO exams (
           id, schoolId, classId, className, name, type, academicYear, term,
           startDate, endDate, status, description, instructions,
           totalMarks, passMark, resultsPublished, createdBy, extra_json,
           deleted_at, _synced, _synced_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           schoolId = excluded.schoolId, classId = excluded.classId,
           className = excluded.className, name = excluded.name,
           type = excluded.type, academicYear = excluded.academicYear,
           term = excluded.term, startDate = excluded.startDate,
           endDate = excluded.endDate, status = excluded.status,
           description = excluded.description, instructions = excluded.instructions,
           totalMarks = excluded.totalMarks, passMark = excluded.passMark,
           resultsPublished = excluded.resultsPublished,
           extra_json = excluded.extra_json,
           deleted_at = NULL, _synced = 1, _synced_at = excluded._synced_at,
           updated_at = excluded.updated_at
           // Only rows this device has no unsent change to.
           //
           // Without it the server's copy overwrites an exam renamed or re-dated offline,
           // and sets _synced = 1 on the way past, so the outbox stops
           // believing there is anything to send. cacheScores has refused
           // dirty rows all along; these two never did.
           WHERE exams._synced = 1`,
        [
          id, e.schoolId || null,
          e.classId || null, e.className || null,
          e.name || "Untitled exam", e.type || null,
          e.academicYear || null, e.term || null,
          e.startDate || null, e.endDate || null,
          e.status || "draft", e.description || null, e.instructions || null,
          Number(e.totalMarks ?? 100), Number(e.passMark ?? 50),
          bool(e.resultsPublished), e.createdBy || null,
          JSON.stringify({ classIds: e.classIds ?? [], classNames: e.classNames ?? null }),
          ts, e.createdAt || ts, e.updatedAt || ts,
        ]
      );
      n++;
    } catch (err) {
      console.warn(`[examCache] cacheExams ${id}:`, err.message);
    }
  }
  return n;
};

export const getExamsLocal = async ({ schoolId, status, classId, academicYear, term } = {}) => {
  await ensureExamTables();
  const db = await getDatabase();

  const where = ["(deleted_at IS NULL OR deleted_at = '')"];
  const params = [];
  if (schoolId)     { where.push("schoolId = ?");     params.push(schoolId); }
  if (status && status !== "all") { where.push("status = ?"); params.push(status); }
  if (classId)      { where.push("classId = ?");      params.push(classId); }
  if (academicYear) { where.push("academicYear = ?"); params.push(academicYear); }
  if (term)         { where.push("term = ?");         params.push(term); }

  const rows = await db.getAllAsync(
    `SELECT * FROM exams WHERE ${where.join(" AND ")} ORDER BY startDate DESC, created_at DESC`,
    params
  ).catch(() => []);

  return (rows ?? []).map((r) => ({
    ...r,
    resultsPublished: r.resultsPublished === 1,
    ...(parseJson(r.extra_json, {}) ?? {}),
  }));
};

export const getExamByIdLocal = async (examId) => {
  if (!examId) return null;
  await ensureExamTables();
  const db = await getDatabase();
  const row = await db.getFirstAsync("SELECT * FROM exams WHERE id = ?", [String(examId)])
    .catch(() => null);
  if (!row) return null;

  const subjects = await db.getAllAsync(
    `SELECT * FROM exam_subjects WHERE examId = ? AND (deleted_at IS NULL OR deleted_at = '')
     ORDER BY subjectName ASC`,
    [String(examId)]
  ).catch(() => []);

  return {
    ...row,
    resultsPublished: row.resultsPublished === 1,
    ...(parseJson(row.extra_json, {}) ?? {}),
    subjects: subjects ?? [],
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// EXAM SUBJECTS (submissions)
// ═════════════════════════════════════════════════════════════════════════════

export const cacheExamSubjects = async (submissions = [], examId = null) => {
  if (!submissions?.length) return 0;
  await ensureExamTables();
  const db = await getDatabase();
  const ts = nowIso();
  let n = 0;

  for (const s of submissions) {
    const id = idOf(s);
    if (!id) continue;
    try {
      await db.runAsync(
        `INSERT INTO exam_subjects (
           id, examId, subjectId, classId, schoolId, teacherId,
           subjectName, teacherName, maxScore, passMark, weight,
           submissionStatus, submittedAt, rejectReason,
           deleted_at, _synced, _synced_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)
         ON CONFLICT(id) DO UPDATE SET
           subjectId = excluded.subjectId, classId = excluded.classId,
           schoolId = excluded.schoolId, teacherId = excluded.teacherId,
           subjectName = excluded.subjectName, teacherName = excluded.teacherName,
           maxScore = excluded.maxScore, passMark = excluded.passMark,
           weight = excluded.weight,
           submissionStatus = excluded.submissionStatus,
           submittedAt = excluded.submittedAt, rejectReason = excluded.rejectReason,
           deleted_at = NULL, _synced = 1, _synced_at = excluded._synced_at,
           updated_at = excluded.updated_at
           // Only rows this device has no unsent change to.
           //
           // Without it the server's copy overwrites a subject's submission state changed offline,
           // and sets _synced = 1 on the way past, so the outbox stops
           // believing there is anything to send. cacheScores has refused
           // dirty rows all along; these two never did.
           WHERE exam_subjects._synced = 1`,
        [
          id, String(s.examId || examId || ""), s.subjectId || null,
          s.classId || null, s.schoolId || null, s.teacherId || null,
          s.subjectName || null, s.teacherName || null,
          Number(s.maxScore ?? 100), Number(s.passMark ?? 50), Number(s.weight ?? 100),
          s.submissionStatus || "pending",
          s.submittedAt || null, s.rejectReason || null,
          ts, s.updatedAt || ts,
        ]
      );
      n++;
    } catch (err) {
      console.warn(`[examCache] cacheExamSubjects ${id}:`, err.message);
    }
  }
  return n;
};

export const getExamSubjectsLocal = async ({ examId, classId, subjectId, status } = {}) => {
  await ensureExamTables();
  const db = await getDatabase();

  const where = ["(deleted_at IS NULL OR deleted_at = '')"];
  const params = [];
  if (examId)    { where.push("examId = ?");           params.push(String(examId)); }
  if (classId)   { where.push("classId = ?");          params.push(String(classId)); }
  if (subjectId) { where.push("subjectId = ?");        params.push(String(subjectId)); }
  if (status)    { where.push("submissionStatus = ?"); params.push(status); }

  return (await db.getAllAsync(
    `SELECT * FROM exam_subjects WHERE ${where.join(" AND ")} ORDER BY subjectName ASC`,
    params
  ).catch(() => [])) ?? [];
};

/** Local status flip so the submit/approve/reject buttons respond offline. */
export const setExamSubjectStatusLocal = async (examSubjectId, status, extra = {}) => {
  await ensureExamTables();
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE exam_subjects
     SET submissionStatus = ?, submittedAt = COALESCE(?, submittedAt),
         rejectReason = ?, _synced = 0, updated_at = ?
     WHERE id = ?`,
    [status, extra.submittedAt ?? null, extra.rejectReason ?? null, nowIso(), String(examSubjectId)]
  ).catch(() => {});
};

// ═════════════════════════════════════════════════════════════════════════════
// SCORES
// ═════════════════════════════════════════════════════════════════════════════

export const cacheScores = async (scores = [], context = {}) => {
  if (!scores?.length) return 0;
  await ensureExamTables();
  const db = await getDatabase();
  const ts = nowIso();
  let n = 0;

  for (const s of scores) {
    const examId    = String(s.examId    || context.examId    || "");
    const studentId = String(s.studentId || s.student?._id || s.student?.id || "");
    const subjectId = String(s.subjectId || context.subjectId || "");
    if (!examId || !studentId || !subjectId) continue;

    try {
      // Never let a server row clobber an edit that has not been pushed yet.
      const local = await db.getFirstAsync(
        "SELECT id, _synced FROM exam_scores WHERE examId = ? AND studentId = ? AND subjectId = ?",
        [examId, studentId, subjectId]
      ).catch(() => null);
      if (local && local._synced === 0) continue;

      const id = local?.id || idOf(s) || generateUUID();

      await db.runAsync(
        `INSERT INTO exam_scores (
           id, examId, examSubjectId, studentId, subjectId, classId, schoolId,
           studentName, score, maxScore, passMark, percentage, grade, remark,
           isAbsent, isExempt, teacherRemark, enteredBy, enteredAt,
           deleted_at, _synced, _synced_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)
         ON CONFLICT(examId, studentId, subjectId) DO UPDATE SET
           examSubjectId = excluded.examSubjectId, classId = excluded.classId,
           schoolId = excluded.schoolId, studentName = excluded.studentName,
           score = excluded.score, maxScore = excluded.maxScore,
           passMark = excluded.passMark, percentage = excluded.percentage,
           grade = excluded.grade, remark = excluded.remark,
           isAbsent = excluded.isAbsent, isExempt = excluded.isExempt,
           teacherRemark = excluded.teacherRemark,
           _synced = 1, _synced_at = excluded._synced_at,
           updated_at = excluded.updated_at`,
        [
          id, examId, s.examSubjectId || context.examSubjectId || null,
          studentId, subjectId,
          s.classId || context.classId || null,
          s.schoolId || context.schoolId || null,
          s.studentName || s.student?.name || null,
          s.score ?? null, Number(s.maxScore ?? 100), Number(s.passMark ?? 50),
          s.percentage ?? computePercentage(s.score, s.maxScore ?? 100),
          s.grade || null, s.remark || null,
          bool(s.isAbsent), bool(s.isExempt),
          s.teacherRemark || null, s.enteredBy || null, s.enteredAt || null,
          ts, s.updatedAt || ts,
        ]
      );
      n++;
    } catch (err) {
      console.warn("[examCache] cacheScores row:", err.message);
    }
  }
  return n;
};

export const getScoresLocal = async ({ examId, subjectId, classId } = {}) => {
  await ensureExamTables();
  const db = await getDatabase();

  const where = ["examId = ?", "(deleted_at IS NULL OR deleted_at = '')"];
  const params = [String(examId)];
  if (subjectId) { where.push("subjectId = ?"); params.push(String(subjectId)); }
  if (classId)   { where.push("classId = ?");   params.push(String(classId)); }

  const rows = await db.getAllAsync(
    `SELECT * FROM exam_scores WHERE ${where.join(" AND ")} ORDER BY studentName ASC`,
    params
  ).catch(() => []);

  return (rows ?? []).map((r) => ({
    ...r,
    isAbsent: r.isAbsent === 1,
    isExempt: r.isExempt === 1,
    isPending: r._synced === 0,
  }));
};

/**
 * Writes a mark sheet locally and returns the row ids, so the caller can
 * attach them to the outbox mutation as `__local`.
 */
export const saveScoresLocal = async ({
  examId, classId, subjectId, examSubjectId, schoolId, scores = [], enteredBy = null,
}) => {
  await ensureExamTables();
  const db = await getDatabase();
  const ts = nowIso();
  const ids = [];

  for (const s of scores) {
    const studentId = String(s.studentId || "");
    if (!studentId) continue;

    const existing = await db.getFirstAsync(
      "SELECT id FROM exam_scores WHERE examId = ? AND studentId = ? AND subjectId = ?",
      [String(examId), studentId, String(subjectId)]
    ).catch(() => null);

    const id = existing?.id || generateUUID();
    const maxScore = Number(s.maxScore ?? 100);

    await db.runAsync(
      `INSERT INTO exam_scores (
         id, examId, examSubjectId, studentId, subjectId, classId, schoolId,
         studentName, score, maxScore, passMark, percentage,
         isAbsent, isExempt, teacherRemark, enteredBy, enteredAt,
         deleted_at, _synced, _synced_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,NULL,?)
       ON CONFLICT(examId, studentId, subjectId) DO UPDATE SET
         examSubjectId = excluded.examSubjectId,
         score = excluded.score, maxScore = excluded.maxScore,
         percentage = excluded.percentage,
         isAbsent = excluded.isAbsent, isExempt = excluded.isExempt,
         teacherRemark = excluded.teacherRemark,
         enteredBy = excluded.enteredBy, enteredAt = excluded.enteredAt,
         _synced = 0, _synced_at = NULL, updated_at = excluded.updated_at`,
      [
        id, String(examId), examSubjectId || null, studentId, String(subjectId),
        classId ? String(classId) : null, schoolId || null,
        s.studentName || null,
        s.score ?? null, maxScore, Number(s.passMark ?? 50),
        computePercentage(s.score, maxScore),
        bool(s.isAbsent), bool(s.isExempt),
        s.teacherRemark ?? null, enteredBy, ts, ts,
      ]
    );
    ids.push(id);
  }

  return ids;
};

export const countUnsyncedScores = async () => {
  await ensureExamTables();
  const db = await getDatabase();
  const row = await db.getFirstAsync(
    "SELECT COUNT(*) AS n FROM exam_scores WHERE _synced = 0"
  ).catch(() => null);
  return row?.n ?? 0;
};

// ═════════════════════════════════════════════════════════════════════════════
// RESULTS (read-through cache)
// ═════════════════════════════════════════════════════════════════════════════

export const cacheResults = async (results = [], examId = null) => {
  if (!results?.length) return 0;
  await ensureExamTables();
  const db = await getDatabase();
  const ts = nowIso();
  let n = 0;

  for (const r of results) {
    const eId = String(r.examId || examId || "");
    const sId = String(r.studentId || idOf(r.student) || "");
    if (!eId || !sId) continue;

    try {
      const existing = await db.getFirstAsync(
        "SELECT id FROM exam_results WHERE examId = ? AND studentId = ?", [eId, sId]
      ).catch(() => null);
      const id = existing?.id || idOf(r) || generateUUID();

      await db.runAsync(
        `INSERT INTO exam_results (
           id, examId, studentId, classId, schoolId, studentName, admissionNo,
           className, academicYear, term, subject_scores,
           totalScore, totalMaxScore, percentage, average, gpa,
           subjectsPassed, subjectsFailed, classRank, isPublished,
           cached_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(examId, studentId) DO UPDATE SET
           classId = excluded.classId, schoolId = excluded.schoolId,
           studentName = excluded.studentName, admissionNo = excluded.admissionNo,
           className = excluded.className, academicYear = excluded.academicYear,
           term = excluded.term, subject_scores = excluded.subject_scores,
           totalScore = excluded.totalScore, totalMaxScore = excluded.totalMaxScore,
           percentage = excluded.percentage, average = excluded.average,
           gpa = excluded.gpa, subjectsPassed = excluded.subjectsPassed,
           subjectsFailed = excluded.subjectsFailed, classRank = excluded.classRank,
           isPublished = excluded.isPublished,
           cached_at = excluded.cached_at, updated_at = excluded.updated_at`,
        [
          id, eId, sId, r.classId || null, r.schoolId || null,
          r.studentName || null, r.admissionNo || null, r.className || null,
          r.academicYear || null, r.term || null,
          JSON.stringify(r.subjectScores ?? r.subject_scores ?? []),
          Number(r.totalScore ?? 0), Number(r.totalMaxScore ?? 0),
          Number(r.percentage ?? 0), Number(r.average ?? 0), Number(r.gpa ?? 0),
          Number(r.subjectsPassed ?? 0), Number(r.subjectsFailed ?? 0),
          r.classRank ?? null, bool(r.isPublished),
          ts, r.updatedAt || ts,
        ]
      );
      n++;
    } catch (err) {
      console.warn("[examCache] cacheResults row:", err.message);
    }
  }
  return n;
};

const hydrateResult = (r) => ({
  ...r,
  subjectScores: parseJson(r.subject_scores, []),
  isPublished: r.isPublished === 1,
});

/**
 * Every cached result on this device.
 *
 * For the pupil's own results screen when there is no connection. It needs no
 * examId — the caller does not know which exams exist offline, which is the
 * whole problem — and on a pupil's device the cache holds only their own
 * results, because their own is all the server will ever hand them.
 */
export const getAllResultsLocal = async () => {
  await ensureExamTables();
  const db = await getDatabase();
  const rows = await db.getAllAsync(
    `SELECT * FROM exam_results ORDER BY average DESC`
  ).catch(() => []);
  return (rows ?? []).map(hydrateResult);
};

export const getResultsLocal = async ({ examId, classId } = {}) => {
  await ensureExamTables();
  const db = await getDatabase();

  const where = ["examId = ?"];
  const params = [String(examId)];
  if (classId) { where.push("classId = ?"); params.push(String(classId)); }

  const rows = await db.getAllAsync(
    `SELECT * FROM exam_results WHERE ${where.join(" AND ")}
     ORDER BY classRank ASC, average DESC`,
    params
  ).catch(() => []);

  return (rows ?? []).map(hydrateResult);
};

export const getStudentResultLocal = async (examId, studentId) => {
  await ensureExamTables();
  const db = await getDatabase();
  const row = await db.getFirstAsync(
    "SELECT * FROM exam_results WHERE examId = ? AND studentId = ?",
    [String(examId), String(studentId)]
  ).catch(() => null);
  return row ? hydrateResult(row) : null;
};

/** Timestamp of the newest cached result for an exam, or null. */
export const getResultsCachedAt = async (examId) => {
  await ensureExamTables();
  const db = await getDatabase();
  const row = await db.getFirstAsync(
    "SELECT MAX(cached_at) AS at FROM exam_results WHERE examId = ?", [String(examId)]
  ).catch(() => null);
  return row?.at ?? null;
};

// ═════════════════════════════════════════════════════════════════════════════
// BLOBS — server-computed aggregates with no local equivalent
// ═════════════════════════════════════════════════════════════════════════════

export const putBlob = async (key, payload) => {
  await ensureExamTables();
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO exam_blobs (key, payload, cached_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at`,
    [key, JSON.stringify(payload ?? null), nowIso()]
  ).catch((err) => console.warn(`[examCache] putBlob ${key}:`, err.message));
};

export const getBlob = async (key) => {
  await ensureExamTables();
  const db = await getDatabase();
  const row = await db.getFirstAsync(
    "SELECT payload, cached_at FROM exam_blobs WHERE key = ?", [key]
  ).catch(() => null);
  if (!row) return null;
  return { data: parseJson(row.payload, null), cachedAt: row.cached_at };
};

export default {
  ensureExamTables,
  cacheExams, getExamsLocal, getExamByIdLocal,
  cacheExamSubjects, getExamSubjectsLocal, setExamSubjectStatusLocal,
  cacheScores, getScoresLocal, saveScoresLocal, countUnsyncedScores,
  cacheResults, getResultsLocal, getAllResultsLocal, getStudentResultLocal, getResultsCachedAt,
  putBlob, getBlob,
  computePercentage,
};
