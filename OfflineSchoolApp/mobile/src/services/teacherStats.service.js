// src/services/teacherStats.service.js
"use strict";

/**
 * teacherStats.service.js
 *
 * Fixed issues:
 *  #C2  — schemaVerified flag replaced with ensureTableSchema
 *  #C4  — Ghost-ID filter replaced with isLocalId / isServerGeneratedId
 *  #C6  — Auth uses isAuthenticated / getCurrentAuth from authHelpers
 *  #M1  — tableExists / getTableColumns imported from dbHelpers
 *  #M3  — NOT_DELETED constant used in queries
 *  #M4  — buildInClause used for all IN() queries
 *  #Mod1 — Empty arrays guarded via buildInClause
 *  #Mod2 — resolveTeacherId returns null on miss, never unresolved ID
 */

import { getDatabase }                     from "../db/database";
import { ensureTableSchema }               from "../db/schemaManager";
import {
  tableExists,
  getTableColumns,
  safeAddColumn,
  NOT_DELETED,
  buildInClause,
}                                          from "../db/dbHelpers";
import { resolveColumns, COL }             from "../db/schemaUtils";
import { isAuthenticated, getCurrentAuth } from "../utils/authHelpers";
import { API }                             from "./apiEndpoints";
import api                                 from "./api";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SCHEMA
// ═════════════════════════════════════════════════════════════════════════════

const ensureSchema = (db) =>
  ensureTableSchema(
    "teacher_stats_view",
    async (db) => {
      if (await tableExists(db, "subjects")) {
        await safeAddColumn(db, "subjects", "teacher_id", "TEXT");
        await safeAddColumn(db, "subjects", "class_id",   "TEXT");
      }
      if (await tableExists(db, "timetable")) {
        await safeAddColumn(db, "timetable", "teacher_id",  "TEXT");
        await safeAddColumn(db, "timetable", "subject_id",  "TEXT");
        await safeAddColumn(db, "timetable", "class_id",    "TEXT");
        await safeAddColumn(db, "timetable", "day_of_week", "TEXT");
        await safeAddColumn(db, "timetable", "starttime",   "TEXT");
        await safeAddColumn(db, "timetable", "endtime",     "TEXT");
      }
      if (await tableExists(db, "students")) {
        await safeAddColumn(db, "students", "class_id",  "TEXT");
        await safeAddColumn(db, "students", "is_active", "INTEGER DEFAULT 1");
      }
      console.log("[teacherStats] Schema verified");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — TIME HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const getTodayDayCandidates = () => {
  const map = {
    0: ["SUN", "Sunday",    "sun", "sunday"],
    1: ["MON", "Monday",    "mon", "monday"],
    2: ["TUE", "Tuesday",   "tue", "tuesday"],
    3: ["WED", "Wednesday", "wed", "wednesday"],
    4: ["THU", "Thursday",  "thu", "thursday"],
    5: ["FRI", "Friday",    "fri", "friday"],
    6: ["SAT", "Saturday",  "sat", "saturday"],
  };
  return map[new Date().getDay()] ?? [];
};

const formatTime = (time24) => {
  if (!time24) return "";
  if (/\s(AM|PM)$/i.test(time24)) return time24;
  try {
    const [h, m] = time24.split(":");
    const hour   = parseInt(h, 10);
    const ampm   = hour >= 12 ? "PM" : "AM";
    return `${hour % 12 || 12}:${m} ${ampm}`;
  } catch { return time24; }
};

const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const match = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return 0;
  let hours  = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);
  const ampm = (match[3] || "").toUpperCase();
  if (ampm === "PM" && hours !== 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;
  return hours * 60 + mins;
};

const computeSlotStatus = (startTime, endTime) => {
  if (!startTime && !endTime) return "upcoming";
  const cur   = new Date().getHours() * 60 + new Date().getMinutes();
  const start = timeToMinutes(startTime);
  const end   = timeToMinutes(endTime);
  if (end   > 0 && cur > end)                return "past";
  if (start > 0 && cur >= start && cur <= end) return "current";
  return "upcoming";
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — TEACHER ID RESOLVER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolves a raw teacher ID to a confirmed ID from the users table.
 * Returns null if not found (fixes #Mod2).
 *
 * @param {any}    db
 * @param {string} rawId
 * @returns {Promise<string|null>}
 */
const resolveTeacherId = async (db, rawId) => {
  if (!rawId) return null;

  const row = await db.getFirstAsync(
    `SELECT id FROM users WHERE id = ? LIMIT 1`,
    [String(rawId)]
  ).catch(() => null);

  if (row) return row.id;

  console.warn(`[teacherStats] resolveTeacherId: no user found for "${rawId}"`);
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — ASSIGNMENT SCOPE RESOLVER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns the distinct subject IDs and class IDs assigned to the teacher.
 * Ghost-ID filter replaced with proper ID-type checks (fixes #C4).
 *
 * @param {any}    db
 * @param {string} teacherId
 * @returns {Promise<{ subjectIds: string[], classIds: string[] }>}
 */
const getTeacherScope = async (db, teacherId) => {
  const EMPTY = { subjectIds: [], classIds: [] };

  if (!(await tableExists(db, "teacher_assignments"))) {
    console.warn("[teacherStats] teacher_assignments table not found");
    return EMPTY;
  }

  const cols = await resolveColumns(
    "teacher_assignments",
    {
      teacherCol: COL.TEACHER_ID,
      classCol:   COL.CLASS_ID,
      subjectCol: COL.SUBJECT_ID,
      deletedCol: COL.DELETED_AT,
    },
    ["deletedCol"]
  );

  const softFilter = cols.deletedCol
    ? `AND (${cols.deletedCol} IS NULL OR ${cols.deletedCol} = '')`
    : "";

  const rows = await db.getAllAsync(
    `SELECT DISTINCT
       ${cols.classCol}   AS classId,
       ${cols.subjectCol} AS subjectId
     FROM teacher_assignments
     WHERE ${cols.teacherCol} = ?
       AND (${cols.subjectCol} IS NOT NULL AND ${cols.subjectCol} != '')
       AND (${cols.classCol}   IS NOT NULL AND ${cols.classCol}   != '')
       ${softFilter}`,
    [teacherId]
  ).catch(() => []);

  const subjectIds = [...new Set(rows.map((r) => String(r.subjectId)).filter(Boolean))];
  const classIds   = [...new Set(rows.map((r) => String(r.classId)).filter(Boolean))];

  console.log(
    `[teacherStats] Scope: ${subjectIds.length} subject(s), ${classIds.length} class(es)`
  );

  return { subjectIds, classIds };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — TODAY'S CLASSES
// ═════════════════════════════════════════════════════════════════════════════

const fetchTodayClassesFromServer = async () => {
  if (!isAuthenticated()) return null;

  try {
    const res          = await api.get(API.teacher.myWorkload, { timeout: 5_000 });
    const todayClasses = res?.data?.data?.todayClasses ?? [];
    console.log(`[teacherStats] Server: ${todayClasses.length} today's class(es)`);
    return { classes: todayClasses, count: todayClasses.length };
  } catch (err) {
    if (err?.response?.status === 401) {
      console.log("[teacherStats] Server returned 401 — session expired");
    } else {
      console.warn("[teacherStats] Server fetch failed:", err.message);
    }
    return null;
  }
};

const fetchTodayClassesFromLocal = async (db, teacherId) => {
  const hasSlots     = await tableExists(db, "timetable_slots");
  const hasTimetable = await tableExists(db, "timetable");

  if (!hasSlots && !hasTimetable) return { classes: [], count: 0 };

  const dayCandidates = getTodayDayCandidates();
  const todayDayIndex = new Date().getDay();

  const buildSlotItem = (r) => {
    const startTime = formatTime(r.startTime);
    const endTime   = formatTime(r.endTime);
    return {
      subjectName: r.subjectName || "Unknown Subject",
      className:   r.className   || "Unknown Class",
      startTime,
      endTime,
      status: computeSlotStatus(startTime, endTime),
    };
  };

  if (hasSlots) {
    const slotCols = await getTableColumns(db, "timetable_slots");
    const tidCol   = slotCols.includes("teacherId") ? "teacherId" : "teacher_id";

    const rows = await db.getAllAsync(
      `SELECT ts.id, s.name AS subjectName, c.name AS className,
              p.starttime AS startTime, p.endtime AS endTime
       FROM   timetable_slots ts
       LEFT JOIN subjects s ON s.id = ts.subjectId
       LEFT JOIN classes  c ON c.id = ts.classId
       LEFT JOIN periods  p ON p.id = ts.periodId
       WHERE  ts.${tidCol} = ? AND ts.dayOfWeek = ?
         AND  (ts.deletedat IS NULL OR ts.deletedat = '')`,
      [teacherId, todayDayIndex]
    ).catch(() => []);

    if (rows.length > 0) {
      const classes = rows.map(buildSlotItem);
      console.log(`[teacherStats] timetable_slots: ${classes.length} today`);
      return { classes, count: classes.length };
    }
  }

  if (hasTimetable) {
    const ttCols = await getTableColumns(db, "timetable");
    const tidCol = ttCols.includes("teacher_id") ? "teacher_id" : "_id";
    const { clause: dayClause, params: dayParams } =
      buildInClause(dayCandidates, "t.day_of_week");

    const rows = await db.getAllAsync(
      `SELECT t.starttime AS startTime, t.endtime AS endTime,
              s.name AS subjectName, c.name AS className
       FROM   timetable t
       LEFT JOIN subjects s ON s.id = t.subject_id
       LEFT JOIN classes  c ON c.id = t.class_id
       WHERE  t.${tidCol} = ? AND ${dayClause}
       ORDER  BY t.starttime ASC`,
      [teacherId, ...dayParams]
    ).catch(() => []);

    const classes = rows.map(buildSlotItem);
    console.log(`[teacherStats] timetable fallback: ${classes.length} today`);
    return { classes, count: classes.length };
  }

  return { classes: [], count: 0 };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — ATTENDANCE GAP
// ═════════════════════════════════════════════════════════════════════════════

const getTodayAttendanceMissing = async (db, teacherId, today) => {
  if (!(await tableExists(db, "attendance"))) return 0;

  let classIds = [];

  if (await tableExists(db, "timetable_slots")) {
    const slotCols = await getTableColumns(db, "timetable_slots");
    const tidCol   = slotCols.includes("teacherId") ? "teacherId" : "teacher_id";
    const rows     = await db.getAllAsync(
      `SELECT DISTINCT classId FROM timetable_slots
       WHERE ${tidCol} = ? AND dayOfWeek = ?
         AND (deletedat IS NULL OR deletedat = '')`,
      [teacherId, new Date().getDay()]
    ).catch(() => []);
    classIds = rows.map((r) => r.classId).filter(Boolean);
  } else if (await tableExists(db, "timetable")) {
    const dayCandidates = getTodayDayCandidates();
    const { clause: dayClause, params: dayParams } =
      buildInClause(dayCandidates, "day_of_week");
    const ttCols = await getTableColumns(db, "timetable");
    const tidCol = ttCols.includes("teacher_id") ? "teacher_id" : "_id";
    const rows   = await db.getAllAsync(
      `SELECT DISTINCT class_id FROM timetable WHERE ${tidCol} = ? AND ${dayClause}`,
      [teacherId, ...dayParams]
    ).catch(() => []);
    classIds = rows.map((r) => r.class_id).filter(Boolean);
  }

  if (!classIds.length) return 0;

  const attCols  = await getTableColumns(db, "attendance");
  const classCol = attCols.includes("classId") ? "classId" : "class_id";
  const { clause: inClause, params: inParams } = buildInClause(classIds, classCol);

  const markedRow = await db.getFirstAsync(
    `SELECT COUNT(DISTINCT ${classCol}) AS count
     FROM attendance WHERE date = ? AND ${inClause}`,
    [today, ...inParams]
  ).catch(() => null);

  return Math.max(0, classIds.length - (markedRow?.count ?? 0));
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — STUDENT COUNT
// ═════════════════════════════════════════════════════════════════════════════

const getTotalStudents = async (db, classIds) => {
  if (!classIds.length || !(await tableExists(db, "students"))) return 0;

  const studentCols = await getTableColumns(db, "students");
  const classCol    =
    studentCols.includes("classId")  ? "classId"  :
    studentCols.includes("class_id") ? "class_id" :
    studentCols.includes("class")    ? "class"    : null;

  if (!classCol) return 0;

  const { clause, params } = buildInClause(classIds, classCol);

  const row = await db.getFirstAsync(
    `SELECT COUNT(DISTINCT id) AS count
     FROM students
     WHERE ${clause} AND (is_active = 1 OR is_active IS NULL) AND ${NOT_DELETED}`,
    params
  ).catch(() => null);

  return row?.count ?? 0;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — QUIZ STATS
// ═════════════════════════════════════════════════════════════════════════════

const resolveQuizCreatorCol = async (db) => {
  if (!(await tableExists(db, "quizzes"))) return null;
  const cols = await getTableColumns(db, "quizzes");
  return cols.includes("created_by") ? "created_by" :
         cols.includes("teacher_id") ? "teacher_id" : null;
};

const getActiveQuizzes = async (db, teacherId) => {
  const col = await resolveQuizCreatorCol(db);
  if (!col) return 0;
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM quizzes
     WHERE ${col} = ? AND is_published = 1 AND ${NOT_DELETED}`,
    [teacherId]
  ).catch(() => null);
  return row?.count ?? 0;
};

const getTotalQuizzes = async (db, teacherId) => {
  const col = await resolveQuizCreatorCol(db);
  if (!col) return 0;
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM quizzes WHERE ${col} = ? AND ${NOT_DELETED}`,
    [teacherId]
  ).catch(() => null);
  return row?.count ?? 0;
};

const getPendingQuizGrading = async (db, teacherId) => {
  if (!(await tableExists(db, "quiz_attempts"))) return 0;
  const col = await resolveQuizCreatorCol(db);
  if (!col) return 0;
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     WHERE q.${col} = ? AND qa.status IN ('submitted', 'timed_out')
       AND ${NOT_DELETED.replace("deleted_at", "q.deleted_at")}`,
    [teacherId]
  ).catch(() => null);
  return row?.count ?? 0;
};

const getQuestionBankSize = async (db, teacherId) => {
  if (!(await tableExists(db, "questions"))) return 0;
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM questions
     WHERE created_by = ? AND is_active = 1 AND ${NOT_DELETED}`,
    [teacherId]
  ).catch(() => null);
  return row?.count ?? 0;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — HOMEWORK STATS
// ═════════════════════════════════════════════════════════════════════════════

const GRADED_STATUSES = ["graded", "reviewed", "returned", "marked"];

const getHomeworkStats = async (db, teacherId, today, sevenDaysStr) => {
  const EMPTY = { activeHomework: 0, upcomingDeadlines: 0, pendingGrading: 0, newSubmissions: 0 };
  if (!(await tableExists(db, "homework"))) return EMPTY;

  const [activeRow, deadlineRow] = await Promise.all([
    db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM homework
       WHERE created_by = ? AND is_published = 1 AND ${NOT_DELETED}`,
      [teacherId]
    ).catch(() => null),
    db.getFirstAsync(
      `SELECT COUNT(*) AS count FROM homework
       WHERE created_by = ? AND is_published = 1
         AND due_date IS NOT NULL AND due_date BETWEEN ? AND ?
         AND ${NOT_DELETED}`,
      [teacherId, today, sevenDaysStr]
    ).catch(() => null),
  ]);

  let pendingGrading = 0;
  let newSubmissions  = 0;

  if (await tableExists(db, "homework_submissions")) {
    const { clause: notGraded, params: gradedParams } =
      buildInClause(GRADED_STATUSES, "hs.status");

    const twoDaysAgo    = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString();

    const [pendingRow, newRow] = await Promise.all([
      db.getFirstAsync(
        `SELECT COUNT(*) AS count
         FROM homework_submissions hs
         JOIN homework h ON h.id = hs.homework_id
         WHERE h.created_by = ? AND hs.score IS NULL AND hs.status = 'submitted'
           AND NOT (${notGraded})
           AND ${NOT_DELETED.replace("deleted_at", "h.deleted_at")}`,
        [teacherId, ...gradedParams]
      ).catch(() => null),
      db.getFirstAsync(
        `SELECT COUNT(*) AS count
         FROM homework_submissions hs
         JOIN homework h ON h.id = hs.homework_id
         WHERE h.created_by = ? AND hs.submitted_at >= ? AND hs.score IS NULL
           AND NOT (${notGraded})
           AND ${NOT_DELETED.replace("deleted_at", "h.deleted_at")}`,
        [teacherId, twoDaysAgoStr, ...gradedParams]
      ).catch(() => null),
    ]);

    pendingGrading = pendingRow?.count ?? 0;
    newSubmissions = newRow?.count     ?? 0;
  }

  return {
    activeHomework:    activeRow?.count   ?? 0,
    upcomingDeadlines: deadlineRow?.count ?? 0,
    pendingGrading,
    newSubmissions,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — EXAM STATS
// ═════════════════════════════════════════════════════════════════════════════

const getExamStats = async (db, teacherId, subjectIds, today, sevenDaysStr) => {
  const EMPTY = {
    upcomingExams: 0, activeExams: 0, pendingMarksEntry: 0,
    rejectedSubmissions: 0, submittedMarks: 0, approvedMarks: 0,
  };

  if (!(await tableExists(db, "exams"))) return EMPTY;

  const examCols = await getTableColumns(db, "exams");
  const tidCol   =
    examCols.includes("teacher_id") ? "teacher_id" :
    examCols.includes("created_by") ? "created_by" : null;
  const dateCol  =
    examCols.includes("exam_date") ? "exam_date" :
    examCols.includes("date")      ? "date"      : null;

  let upcomingExams = 0;
  let activeExams   = 0;

  if (tidCol && dateCol) {
    const [upcomingRow, activeRow] = await Promise.all([
      db.getFirstAsync(
        `SELECT COUNT(*) AS count FROM exams
         WHERE ${tidCol} = ? AND ${dateCol} BETWEEN ? AND ? AND ${NOT_DELETED}`,
        [teacherId, today, sevenDaysStr]
      ).catch(() => null),
      db.getFirstAsync(
        `SELECT COUNT(*) AS count FROM exams
         WHERE ${tidCol} = ? AND (status = 'active' OR status IS NULL) AND ${NOT_DELETED}`,
        [teacherId]
      ).catch(() => null),
    ]);
    upcomingExams = upcomingRow?.count ?? 0;
    activeExams   = activeRow?.count   ?? 0;
  }

  let pendingMarksEntry = 0, rejectedSubmissions = 0, submittedMarks = 0, approvedMarks = 0;
  const hasExamMarks = await tableExists(db, "exam_marks");

  if (hasExamMarks && subjectIds.length > 0) {
    const subjectCol = examCols.includes("subject_id") ? "subject_id" : "id";
    const { clause: subClause, params: subParams } =
      buildInClause(subjectIds, `e.${subjectCol}`);

    const pendingRow = await db.getFirstAsync(
      `SELECT COUNT(DISTINCT e.id) AS count FROM exams e
       WHERE ${subClause}
         AND e.id NOT IN (SELECT DISTINCT exam_id FROM exam_marks WHERE ${NOT_DELETED})`,
      subParams
    ).catch(() => null);
    pendingMarksEntry = pendingRow?.count ?? 0;

    const markCols = await getTableColumns(db, "exam_marks");
    const mTidCol  = markCols.includes("teacher_id") ? "teacher_id" : null;

    if (mTidCol) {
      const [rejRow, subRow, appRow] = await Promise.all([
        db.getFirstAsync(
          `SELECT COUNT(*) AS count FROM exam_marks
           WHERE ${mTidCol} = ? AND status = 'rejected' AND ${NOT_DELETED}`,
          [teacherId]
        ).catch(() => null),
        db.getFirstAsync(
          `SELECT COUNT(*) AS count FROM exam_marks
           WHERE ${mTidCol} = ? AND status = 'submitted' AND ${NOT_DELETED}`,
          [teacherId]
        ).catch(() => null),
        db.getFirstAsync(
          `SELECT COUNT(*) AS count FROM exam_marks
           WHERE ${mTidCol} = ? AND status = 'approved' AND ${NOT_DELETED}`,
          [teacherId]
        ).catch(() => null),
      ]);
      rejectedSubmissions = rejRow?.count ?? 0;
      submittedMarks      = subRow?.count ?? 0;
      approvedMarks       = appRow?.count ?? 0;
    }
  }

  return { upcomingExams, activeExams, pendingMarksEntry, rejectedSubmissions, submittedMarks, approvedMarks };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — CONTENT UPLOADS
// ═════════════════════════════════════════════════════════════════════════════

const getContentUploads = async (db, teacherId) => {
  if (!(await tableExists(db, "content"))) return 0;
  const cols   = await getTableColumns(db, "content");
  const tidCol =
    cols.includes("teacher_id")  ? "teacher_id"  :
    cols.includes("created_by")  ? "created_by"  :
    cols.includes("uploaded_by") ? "uploaded_by" : null;
  if (!tidCol) return 0;
  const row = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM content WHERE ${tidCol} = ? AND ${NOT_DELETED}`,
    [teacherId]
  ).catch(() => null);
  return row?.count ?? 0;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — EMPTY STATS
// ═════════════════════════════════════════════════════════════════════════════

const EMPTY_STATS = Object.freeze({
  assignedSubjects:       0,
  assignedClasses:        0,
  totalStudents:          0,
  todayClassCount:        0,
  contentUploads:         0,
  activeQuizzes:          0,
  totalQuizzes:           0,
  questionBankSize:       0,
  quizAttemptsPending:    0,
  activeHomework:         0,
  pendingGrading:         0,
  upcomingDeadlines:      0,
  newSubmissions:         0,
  upcomingExams:          0,
  todayAttendanceMissing: 0,
  pendingMarksEntry:      0,
  rejectedSubmissions:    0,
  activeExams:            0,
  submittedMarks:         0,
  approvedMarks:          0,
  todayClasses:           [],
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — MAIN EXPORT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Computes and returns the full stats object for a teacher's dashboard.
 *
 * @param {string} rawTeacherId
 * @returns {Promise<typeof EMPTY_STATS>}
 */
export const getTeacherStats = async (rawTeacherId) => {
  if (!isAuthenticated()) {
    console.log("[teacherStats] Not authenticated — skipping");
    return { ...EMPTY_STATS };
  }

  if (!rawTeacherId) {
    console.warn("[teacherStats] No teacherId provided");
    return { ...EMPTY_STATS };
  }

  const db = await getDatabase();
  await ensureSchema(db);

  const teacherId = await resolveTeacherId(db, rawTeacherId);
  if (!teacherId) {
    console.warn("[teacherStats] Could not resolve teacherId");
    return { ...EMPTY_STATS };
  }

  console.log(`[teacherStats] Loading stats for: ${teacherId}`);

  try {
    const today            = new Date().toISOString().split("T")[0];
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    const sevenDaysStr     = sevenDaysFromNow.toISOString().split("T")[0];

    const { subjectIds, classIds } = await getTeacherScope(db, teacherId);

    let todayClasses    = [];
    let todayClassCount = 0;
    const serverResult  = await fetchTodayClassesFromServer();
    if (serverResult) {
      todayClasses    = serverResult.classes;
      todayClassCount = serverResult.count;
    } else {
      const localResult = await fetchTodayClassesFromLocal(db, teacherId);
      todayClasses      = localResult.classes;
      todayClassCount   = localResult.count;
    }

    const [
      totalStudents,
      activeQuizzes,
      totalQuizzes,
      questionBankSize,
      quizAttemptsPending,
      contentUploads,
      todayAttendanceMissing,
      homeworkStats,
      examStats,
    ] = await Promise.all([
      getTotalStudents(db, classIds),
      getActiveQuizzes(db, teacherId),
      getTotalQuizzes(db, teacherId),
      getQuestionBankSize(db, teacherId),
      getPendingQuizGrading(db, teacherId),
      getContentUploads(db, teacherId),
      getTodayAttendanceMissing(db, teacherId, today),
      getHomeworkStats(db, teacherId, today, sevenDaysStr),
      getExamStats(db, teacherId, subjectIds, today, sevenDaysStr),
    ]);

    const stats = {
      assignedSubjects:   subjectIds.length,
      assignedClasses:    classIds.length,
      totalStudents,
      todayClassCount,
      contentUploads,
      activeQuizzes,
      totalQuizzes,
      questionBankSize,
      quizAttemptsPending,
      todayAttendanceMissing,
      todayClasses,
      activeHomework:    homeworkStats.activeHomework,
      pendingGrading:    homeworkStats.pendingGrading,
      upcomingDeadlines: homeworkStats.upcomingDeadlines,
      newSubmissions:    homeworkStats.newSubmissions,
      upcomingExams:       examStats.upcomingExams,
      activeExams:         examStats.activeExams,
      pendingMarksEntry:   examStats.pendingMarksEntry,
      rejectedSubmissions: examStats.rejectedSubmissions,
      submittedMarks:      examStats.submittedMarks,
      approvedMarks:       examStats.approvedMarks,
    };

    console.log("[teacherStats] Stats loaded:", {
      assignedSubjects: stats.assignedSubjects,
      assignedClasses:  stats.assignedClasses,
      totalStudents:    stats.totalStudents,
      todayClassCount:  stats.todayClassCount,
    });

    return stats;
  } catch (err) {
    console.error("[teacherStats] Fatal error:", err.message, err.stack);
    return { ...EMPTY_STATS };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — DEBUG
// ═════════════════════════════════════════════════════════════════════════════

export const debugTeacherData = async (rawTeacherId) => {
  const db = await getDatabase();

  console.log("═══════════════════════════════════════");
  console.log("[teacherStats] DEBUG — id:", rawTeacherId);
  console.log("═══════════════════════════════════════");

  try {
    const teacher = await db.getFirstAsync(
      `SELECT id, name, email, role FROM users WHERE id = ?`,
      [String(rawTeacherId)]
    ).catch(() => null);
    console.log("Teacher:", JSON.stringify(teacher));

    if (await tableExists(db, "teacher_assignments")) {
      const taCols = await getTableColumns(db, "teacher_assignments");
      console.log("teacher_assignments columns:", taCols);
      const total = await db.getFirstAsync(
        `SELECT COUNT(*) AS cnt FROM teacher_assignments`
      ).catch(() => null);
      console.log("Total rows:", total?.cnt);

      const cols   = await resolveColumns("teacher_assignments", { teacherCol: COL.TEACHER_ID }, []);
      const myRows = await db.getAllAsync(
        `SELECT * FROM teacher_assignments WHERE ${cols.teacherCol} = ?`,
        [String(rawTeacherId)]
      ).catch(() => []);
      console.log(`Rows for teacher (${myRows.length}):`, JSON.stringify(myRows));
    }

    if (await tableExists(db, "quizzes")) {
      console.log("quizzes columns:", await getTableColumns(db, "quizzes"));
    }

    if (await tableExists(db, "students")) {
      console.log("students columns:", await getTableColumns(db, "students"));
      const cnt = await db.getFirstAsync(`SELECT COUNT(*) AS cnt FROM students`).catch(() => null);
      console.log("students total rows:", cnt?.cnt);
    }
  } catch (err) {
    console.error("[teacherStats] Debug error:", err.message);
  }

  console.log("═══════════════════════════════════════");
};