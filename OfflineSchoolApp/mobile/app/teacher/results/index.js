// app/teacher/results/index.js
"use strict";

/**
 * Teacher Results Screen — fixed & improved.
 *
 * Changes vs. original
 * ────────────────────
 * #R1  tableExists wrapper now passes the db instance to _tableExists
 *       instead of calling it with a bare string (was always returning false).
 * #R2  loadTeacherAssignments — added null-guard so the screen still works
 *       when the teacher_assignments table is absent (new installs).
 * #R3  loadExamMarks / loadQuizResults — placeholders in SQL are generated
 *       from the actual filtered arrays, not the raw classIds/subjectIds
 *       arrays. This prevents "wrong number of parameters" errors when the
 *       arrays contain duplicates that were de-duplicated elsewhere.
 * #R4  loadResultsFromAPI — response-shape normalisation now also handles
 *       { data: { data: [...] } } which some API versions return.
 * #R5  groupResults — subjectKey falls back to subjectId first, then to a
 *       constant "General" only as a last resort, preventing multiple
 *       "General" buckets for different unknown subjects.
 * #R6  calculateAnalytics — division-by-zero guard added for passRate when
 *       withPct.length is 0 (was already guarded but the pcts array could be
 *       empty after filtering, making Math.max/min return ±Infinity).
 * #R7  loadResults — results are now deduplicated by composite key
 *       (source + examTitle + studentName) in addition to id, preventing
 *       phantom duplicates when both the local DB and API return the same row
 *       under different IDs (e.g. MongoDB _id vs SQLite rowid).
 * #R8  GroupedResultsView — filterSource prop is now honoured for the
 *       per-class analytics strip as well (was always using all results).
 * #R9  EmptyState — removed flex:1 from the outer View; when it appears
 *       inside a FlatList ListEmptyComponent the flex causes a 0-height
 *       render on Android.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  FlatList,
  ScrollView,
  Modal,
} from "react-native";
import { router }       from "expo-router";
import { Ionicons }     from "@expo/vector-icons";
import { useAuthStore } from "../../../src/store/auth.store";
import { getDatabase }  from "../../../src/db/database";
import api              from "../../../src/services/api";
import { useTranslation } from "../../../src/i18n/useTranslation";
import { tableExists as _tableExists } from "../../../src/db/dbHelpers";

// #R1 — correct wrapper: _tableExists(db, tableName)
const tableExists = async (tableName) => {
  try {
    const db = await getDatabase();
    return _tableExists(db, tableName);
  } catch {
    return false;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═════════════════════════════════════════════════════════════════════════════

const C = {
  primary:   "#4F46E5",
  primaryBg: "#EEF2FF",
  success:   "#059669",
  successBg: "#ECFDF5",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  error:     "#DC2626",
  errorBg:   "#FEF2F2",
  info:      "#2563EB",
  infoBg:    "#DBEAFE",
  purple:    "#7C3AED",
  purpleBg:  "#EDE9FE",
  white:     "#FFFFFF",
  gray50:    "#F9FAFB",
  gray100:   "#F3F4F6",
  gray200:   "#E5E7EB",
  gray300:   "#D1D5DB",
  gray400:   "#9CA3AF",
  gray500:   "#6B7280",
  gray600:   "#4B5563",
  gray700:   "#374151",
  gray900:   "#111827",
};

const CLASS_ACCENT_COLORS = [
  "#4F46E5", "#059669", "#D97706", "#DC2626",
  "#0284C7", "#A855F7", "#EA580C", "#16A34A",
];

// ═════════════════════════════════════════════════════════════════════════════
// GRADE / PERFORMANCE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const getGrade = (percentage) => {
  if (percentage == null) return { grade: "N/A", color: C.gray400 };
  if (percentage >= 90)   return { grade: "A+",  color: "#059669" };
  if (percentage >= 80)   return { grade: "A",   color: "#059669" };
  if (percentage >= 70)   return { grade: "B",   color: "#2563EB" };
  if (percentage >= 60)   return { grade: "C",   color: "#D97706" };
  if (percentage >= 50)   return { grade: "D",   color: "#EA580C" };
  return                         { grade: "F",   color: "#DC2626" };
};

const getPerformanceColor = (percentage) => {
  if (percentage == null) return C.gray400;
  if (percentage >= 70)   return C.success;
  if (percentage >= 50)   return C.warning;
  return C.error;
};

const calcPct = (obtained, total) =>
  obtained != null && total > 0
    ? Math.round((obtained / total) * 100)
    : null;

// ═════════════════════════════════════════════════════════════════════════════
// LOCAL DB HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const dbQuery = async (sql, params = []) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(sql, params);
    return rows ?? [];
  } catch (err) {
    console.warn("[dbQuery]", err.message, "\nSQL:", sql);
    return [];
  }
};

const getColumns = async (table) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(`PRAGMA table_info(${table})`, []);
    return new Set((rows ?? []).map((r) => r.name));
  } catch {
    return new Set();
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// DATA LOADERS
// ═════════════════════════════════════════════════════════════════════════════

const loadTeacherAssignments = async (teacherId) => {
  // #R2 — guard against missing table
  if (!(await tableExists("teacher_assignments"))) {
    console.warn("[loadTeacherAssignments] table absent, skipping");
    return [];
  }

  const cols       = await getColumns("teacher_assignments");
  const teacherCol = cols.has("teacherId") ? "teacherId" : "teacher_id";
  const classCol   = cols.has("classId")   ? "classId"   : "class_id";
  const subjectCol = cols.has("subjectId") ? "subjectId" : "subject_id";

  return dbQuery(
    `SELECT DISTINCT
       ta.${classCol}   AS classId,
       ta.${subjectCol} AS subjectId,
       c.name           AS className,
       s.name           AS subjectName,
       s.code           AS subjectCode
     FROM teacher_assignments ta
     LEFT JOIN classes  c ON c.id = ta.${classCol}
     LEFT JOIN subjects s ON s.id = ta.${subjectCol}
     WHERE ta.${teacherCol} = ?
       AND (ta.deleted_at IS NULL OR ta.deleted_at = '')
     GROUP BY ta.${classCol}, ta.${subjectCol}
     ORDER BY c.name ASC, s.name ASC`,
    [teacherId]
  );
};

// #R3 — helper that builds a safe de-duplicated placeholder string
const makePlaceholders = (arr) => arr.map(() => "?").join(",");

const loadExamMarks = async (teacherId, classIds, subjectIds) => {
  // #R3 — deduplicate to avoid redundant placeholders / params mismatch
  const uniqueClassIds   = [...new Set(classIds.filter(Boolean))];
  const uniqueSubjectIds = [...new Set(subjectIds.filter(Boolean))];

  if (!uniqueClassIds.length || !uniqueSubjectIds.length) return [];

  const hasExams     = await tableExists("exams");
  const hasMarks     = await tableExists("exam_marks");
  const hasStudentM  = await tableExists("student_marks");
  const hasStudentS  = await tableExists("student_scores");
  const hasResultSum = await tableExists("result_summaries");
  const hasExamSub   = await tableExists("exam_subjects");

  let results = [];
  const clsPH = makePlaceholders(uniqueClassIds);
  const subPH = makePlaceholders(uniqueSubjectIds);

  // ── exam_marks ────────────────────────────────────────────────────────────
  if (hasExams && hasMarks) {
    const examCols   = await getColumns("exams");
    const subjectCol = examCols.has("subject_id") ? "subject_id" : "subjectId";
    const classCol   = examCols.has("class_id")   ? "class_id"   : "classId";
    const dateCol    = examCols.has("exam_date")   ? "exam_date"  : "date";

    const rows = await dbQuery(
      `SELECT
         em.id,
         e.title            AS examTitle,
         e.${dateCol}       AS examDate,
         s.name             AS subjectName,
         s.code             AS subjectCode,
         c.name             AS className,
         e.${classCol}      AS classId,
         e.${subjectCol}    AS subjectId,
         st.name            AS studentName,
         COALESCE(st.admissionNo, st.admissionNumber) AS admissionNo,
         em.marks_obtained  AS marksObtained,
         em.total_marks     AS totalMarks,
         em.percentage,
         em.grade,
         em.remarks,
         em.status
       FROM exam_marks em
       JOIN   exams    e  ON e.id  = em.exam_id
       LEFT JOIN subjects s  ON s.id  = e.${subjectCol}
       LEFT JOIN classes  c  ON c.id  = e.${classCol}
       LEFT JOIN students st ON st.id = em.student_id
       WHERE e.${classCol}   IN (${clsPH})
         AND e.${subjectCol} IN (${subPH})
         AND (em.deleted_at IS NULL OR em.deleted_at = '')
       ORDER BY e.${dateCol} DESC, s.name ASC, st.name ASC`,
      [...uniqueClassIds, ...uniqueSubjectIds]
    );
    results = [...results, ...rows.map((r) => ({
      ...r, source: "exam",
      percentage: r.percentage ?? calcPct(r.marksObtained, r.totalMarks),
    }))];
  }

  // ── student_marks ─────────────────────────────────────────────────────────
  if (hasStudentM) {
    const smCols = await getColumns("student_marks");
    const clsCol = smCols.has("class_id")   ? "class_id"   : "classId";
    const subCol = smCols.has("subject_id") ? "subject_id" : "subjectId";

    if (smCols.has(clsCol) && smCols.has(subCol)) {
      const rows = await dbQuery(
        `SELECT
           sm.id,
           COALESCE(sm.exam_name, sm.examName, 'Exam') AS examTitle,
           COALESCE(sm.exam_date, sm.examDate)          AS examDate,
           s.name             AS subjectName,
           c.name             AS className,
           sm.${clsCol}       AS classId,
           sm.${subCol}       AS subjectId,
           st.name            AS studentName,
           COALESCE(st.admissionNo, st.admissionNumber) AS admissionNo,
           sm.marks_obtained  AS marksObtained,
           sm.total_marks     AS totalMarks,
           sm.percentage,
           sm.grade
         FROM student_marks sm
         LEFT JOIN subjects s  ON s.id  = sm.${subCol}
         LEFT JOIN classes  c  ON c.id  = sm.${clsCol}
         LEFT JOIN students st ON st.id = sm.student_id
         WHERE sm.${clsCol} IN (${clsPH})
           AND sm.${subCol} IN (${subPH})
           AND (sm.deleted_at IS NULL OR sm.deleted_at = '')
         ORDER BY examDate DESC, s.name ASC`,
        [...uniqueClassIds, ...uniqueSubjectIds]
      );
      results = [...results, ...rows.map((r) => ({
        ...r, source: "exam",
        percentage: r.percentage ?? calcPct(r.marksObtained, r.totalMarks),
      }))];
    }
  }

  // ── student_scores ────────────────────────────────────────────────────────
  if (hasStudentS) {
    const ssCols   = await getColumns("student_scores");
    const clsCol   = ssCols.has("class_id")   ? "class_id"   : ssCols.has("classId")   ? "classId"   : null;
    const subCol   = ssCols.has("subject_id") ? "subject_id" : ssCols.has("subjectId") ? "subjectId" : null;
    const hasScore = ssCols.has("marks_obtained") || ssCols.has("score") || ssCols.has("marks");

    if (clsCol && subCol && hasScore) {
      const rows = await dbQuery(
        `SELECT
           ss.id,
           COALESCE(ss.exam_title, ss.examTitle, ss.title, 'Score') AS examTitle,
           COALESCE(ss.date, ss.exam_date, ss.created_at)           AS examDate,
           s.name  AS subjectName,
           c.name  AS className,
           ss.${clsCol} AS classId,
           ss.${subCol} AS subjectId,
           st.name AS studentName,
           COALESCE(st.admissionNo, st.admissionNumber)      AS admissionNo,
           COALESCE(ss.marks_obtained, ss.score, ss.marks)   AS marksObtained,
           COALESCE(ss.total_marks, ss.max_score, ss.out_of) AS totalMarks,
           ss.percentage,
           ss.grade
         FROM student_scores ss
         LEFT JOIN subjects s  ON s.id  = ss.${subCol}
         LEFT JOIN classes  c  ON c.id  = ss.${clsCol}
         LEFT JOIN students st ON st.id = ss.student_id
         WHERE ss.${clsCol} IN (${clsPH})
           AND ss.${subCol} IN (${subPH})
           AND (ss.deleted_at IS NULL OR ss.deleted_at = '')
         ORDER BY examDate DESC, s.name ASC`,
        [...uniqueClassIds, ...uniqueSubjectIds]
      );
      results = [...results, ...rows.map((r) => ({
        ...r, source: "exam",
        percentage: r.percentage ?? calcPct(r.marksObtained, r.totalMarks),
      }))];
    }
  }

  // ── result_summaries ──────────────────────────────────────────────────────
  if (hasResultSum) {
    const rsCols = await getColumns("result_summaries");
    const clsCol = rsCols.has("class_id") ? "class_id" : rsCols.has("classId") ? "classId" : null;
    const subCol = rsCols.has("subject_id") ? "subject_id" : rsCols.has("subjectId") ? "subjectId" : null;

    if (clsCol && subCol) {
      const rows = await dbQuery(
        `SELECT
           rs.id,
           COALESCE(rs.exam_title, rs.title, 'Result') AS examTitle,
           COALESCE(rs.date, rs.created_at)             AS examDate,
           s.name  AS subjectName,
           c.name  AS className,
           rs.${clsCol} AS classId,
           rs.${subCol} AS subjectId,
           st.name AS studentName,
           COALESCE(st.admissionNo, st.admissionNumber)    AS admissionNo,
           COALESCE(rs.marks_obtained, rs.score)           AS marksObtained,
           COALESCE(rs.total_marks, rs.max_score)          AS totalMarks,
           rs.percentage,
           rs.grade
         FROM result_summaries rs
         LEFT JOIN subjects s  ON s.id  = rs.${subCol}
         LEFT JOIN classes  c  ON c.id  = rs.${clsCol}
         LEFT JOIN students st ON st.id = rs.student_id
         WHERE rs.${clsCol} IN (${clsPH})
           AND rs.${subCol} IN (${subPH})
           AND (rs.deleted_at IS NULL OR rs.deleted_at = '')
         ORDER BY examDate DESC, s.name ASC`,
        [...uniqueClassIds, ...uniqueSubjectIds]
      );
      results = [...results, ...rows.map((r) => ({
        ...r, source: "exam",
        percentage: r.percentage ?? calcPct(r.marksObtained, r.totalMarks),
      }))];
    }
  }

  // ── exam_subjects ─────────────────────────────────────────────────────────
  if (hasExamSub && hasExams) {
    const esCols   = await getColumns("exam_subjects");
    const clsCol   = esCols.has("class_id")   ? "class_id"   : esCols.has("classId")   ? "classId"   : null;
    const subCol   = esCols.has("subject_id") ? "subject_id" : esCols.has("subjectId") ? "subjectId" : null;
    const hasScore = esCols.has("marks_obtained") || esCols.has("score");

    if (clsCol && subCol && hasScore) {
      const rows = await dbQuery(
        `SELECT
           es.id,
           COALESCE(e.title, 'Exam')                           AS examTitle,
           COALESCE(e.exam_date, e.date, es.created_at)        AS examDate,
           s.name  AS subjectName,
           c.name  AS className,
           es.${clsCol} AS classId,
           es.${subCol} AS subjectId,
           st.name AS studentName,
           COALESCE(es.marks_obtained, es.score)               AS marksObtained,
           COALESCE(es.total_marks, es.max_score)              AS totalMarks,
           es.percentage,
           es.grade
         FROM exam_subjects es
         LEFT JOIN exams    e  ON e.id  = es.exam_id
         LEFT JOIN subjects s  ON s.id  = es.${subCol}
         LEFT JOIN classes  c  ON c.id  = es.${clsCol}
         LEFT JOIN students st ON st.id = es.student_id
         WHERE es.${clsCol} IN (${clsPH})
           AND es.${subCol} IN (${subPH})
           AND (es.deleted_at IS NULL OR es.deleted_at = '')
         ORDER BY examDate DESC`,
        [...uniqueClassIds, ...uniqueSubjectIds]
      );
      results = [...results, ...rows.map((r) => ({
        ...r, source: "exam",
        percentage: r.percentage ?? calcPct(r.marksObtained, r.totalMarks),
      }))];
    }
  }

  console.log(`[loadExamMarks] total: ${results.length}`);
  return results;
};

const loadQuizResults = async (teacherId, classIds) => {
  if (!(await tableExists("quizzes")))       return [];
  if (!(await tableExists("quiz_attempts"))) return [];

  // #R3 — deduplicate class IDs
  const uniqueClassIds = [...new Set(classIds.filter(Boolean))];
  if (!uniqueClassIds.length) return [];

  const quizCols   = await getColumns("quizzes");
  const creatorCol = quizCols.has("created_by") ? "created_by" : "teacher_id";
  const classCol   = quizCols.has("class_id")   ? "class_id"   : "classId";
  const clsPH      = makePlaceholders(uniqueClassIds);

  const rows = await dbQuery(
    `SELECT
       qa.id,
       q.title            AS quizTitle,
       q.passing_score    AS passingScore,
       q.${classCol}      AS classId,
       c.name             AS className,
       s.name             AS subjectName,
       s.id               AS subjectId,
       st.name            AS studentName,
       COALESCE(st.admissionNo, st.admissionNumber) AS admissionNo,
       qa.status,
       qa.raw_score       AS marksObtained,
       qa.max_score       AS totalMarks,
       qa.percentage,
       qa.is_passed       AS isPassed,
       qa.submitted_at    AS examDate,
       qa.time_taken_secs AS timeTaken,
       qa.attempt_number  AS attemptNumber,
       (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS totalQuestions
     FROM quiz_attempts qa
     JOIN   quizzes  q  ON q.id  = qa.quiz_id
     LEFT JOIN classes  c  ON c.id  = q.${classCol}
     LEFT JOIN subjects s  ON s.id  = q.subject_id
     LEFT JOIN students st ON st.id = qa.student_id
       OR st.user_id = qa.user_id
     WHERE q.${creatorCol} = ?
       AND q.${classCol}   IN (${clsPH})
       AND qa.status IN ('submitted', 'timed_out')
       AND (q.deleted_at IS NULL OR q.deleted_at = '')
     ORDER BY qa.submitted_at DESC, q.title ASC`,
    [teacherId, ...uniqueClassIds]
  );

  return rows.map((r) => ({
    ...r,
    source:     "quiz",
    examTitle:  r.quizTitle,
    percentage: r.percentage ?? calcPct(r.marksObtained, r.totalMarks),
  }));
};

// ── API loader ─────────────────────────────────────────────────────────────

const loadResultsFromAPI = async (schoolId, t) => {
  try {
    const res  = await api.get("/teacher/results", {
      params:  { schoolId },
      timeout: 8_000,
    });
    const data = res.data;

    // #R4 — handle more response shapes
    const list =
      Array.isArray(data?.results)            ? data.results            :
      Array.isArray(data?.examResults)        ? data.examResults        :
      Array.isArray(data?.marks)              ? data.marks              :
      Array.isArray(data?.data?.results)      ? data.data.results      :
      Array.isArray(data?.data?.examResults)  ? data.data.examResults  :
      Array.isArray(data?.data)               ? data.data               :
      Array.isArray(data)                     ? data                    : [];

    if (!list.length) return [];

    return list.map((r) => {
      const pct =
        r.percentage ??
        (r.marksObtained != null && r.totalMarks > 0
          ? Math.round((r.marksObtained / r.totalMarks) * 100)
          : r.marks_obtained != null && r.total_marks > 0
          ? Math.round((r.marks_obtained / r.total_marks) * 100)
          : null);

      return {
        id:             r._id || r.id || String(Math.random()),
        source:         r.type === "quiz" ? "quiz" : "exam",
        examTitle:      r.examTitle    || r.title       || r.exam_title || r.quizTitle || t("teacherResults.assessmentFallback"),
        examDate:       r.examDate     || r.date        || r.submitted_at || r.createdAt || null,
        subjectName:    r.subjectName  || r.subject     || r.subject_name || null,
        subjectId:      r.subjectId    || r.subject_id  || null,
        className:      r.className    || r.class       || r.class_name   || null,
        classId:        r.classId      || r.class_id    || null,
        studentName:    r.studentName  || r.student     || r.student_name || null,
        admissionNo:    r.admissionNo  || r.admission_no || null,
        marksObtained:  r.marksObtained  ?? r.marks_obtained  ?? r.score    ?? null,
        totalMarks:     r.totalMarks      ?? r.total_marks      ?? r.maxScore ?? null,
        percentage:     pct,
        grade:          r.grade   ?? null,
        remarks:        r.remarks ?? null,
        status:         r.status  ?? null,
        isPassed:       r.isPassed ?? r.is_passed ?? (pct != null ? pct >= 50 : null),
        timeTaken:      r.timeTaken     ?? r.time_taken_secs ?? null,
        attemptNumber:  r.attemptNumber ?? r.attempt_number  ?? null,
        totalQuestions: r.totalQuestions ?? r.total_questions ?? null,
      };
    });
  } catch (err) {
    if (err?.response?.status !== 404) {
      console.warn("[teacher/results] API error:", err.message);
    }
    return [];
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GROUPING
// ═════════════════════════════════════════════════════════════════════════════

/** Bucket key for rows with no subject — never shown, so never translated. */
const GENERAL_SUBJECT_KEY = "General";

const groupResults = (results, t) => {
  const classMap = new Map();

  for (const r of results) {
    const classId   = r.classId   || "unknown";
    const className = r.className || t("teacherResults.unknownClass");
    // #R5 — use subjectId as tie-breaker before falling back to "General"
    const subjectKey = r.subjectName || r.subjectId || GENERAL_SUBJECT_KEY;

    if (!classMap.has(classId)) {
      classMap.set(classId, { classId, className, subjects: new Map() });
    }
    const cls = classMap.get(classId);

    if (!cls.subjects.has(subjectKey)) {
      cls.subjects.set(subjectKey, {
        subjectKey,
        subjectName:
          r.subjectName ||
          (subjectKey === GENERAL_SUBJECT_KEY
            ? t("teacherResults.generalSubject")
            : String(subjectKey)),
        results: [],
      });
    }
    cls.subjects.get(subjectKey).results.push(r);
  }

  return [...classMap.values()]
    .sort((a, b) => a.className.localeCompare(b.className))
    .map((cls) => ({
      classId:   cls.classId,
      className: cls.className,
      subjects: [...cls.subjects.values()]
        .sort((a, b) => a.subjectName.localeCompare(b.subjectName))
        .map((sub) => ({
          subjectKey:  sub.subjectKey,
          subjectName: sub.subjectName,
          results:     sub.results,
          analytics:   calculateAnalytics(sub.results),
        })),
    }));
};

// ═════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═════════════════════════════════════════════════════════════════════════════

const calculateAnalytics = (results) => {
  if (!results?.length) return null;

  const withPct = results.filter((r) => r.percentage != null);
  // #R6 — guard: nothing to compute when no graded rows exist
  if (!withPct.length) return null;

  const pcts     = withPct.map((r) => r.percentage);
  const sum      = pcts.reduce((a, b) => a + b, 0);
  const avg      = sum / pcts.length;
  const max      = Math.max(...pcts);   // safe: pcts.length >= 1
  const min      = Math.min(...pcts);
  const passed   = pcts.filter((p) => p >= 50).length;
  const failed   = pcts.length - passed;
  const passRate = Math.round((passed / pcts.length) * 100);

  const gradeDist = { "A+": 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const p of pcts) {
    const { grade } = getGrade(p);
    if (grade in gradeDist) gradeDist[grade]++;
  }

  const ranges = {
    "90-100": pcts.filter((p) => p >= 90).length,
    "70-89":  pcts.filter((p) => p >= 70 && p < 90).length,
    "50-69":  pcts.filter((p) => p >= 50 && p < 70).length,
    "0-49":   pcts.filter((p) => p < 50).length,
  };

  return {
    total:    results.length,
    graded:   withPct.length,
    avg:      Math.round(avg * 10) / 10,
    max, min, passed, failed, passRate, gradeDist, ranges,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// MINI COMPONENTS
// ═════════════════════════════════════════════════════════════════════════════

function StatBox({ label, value, color, bg }) {
  return (
    <View style={[sb.box, { backgroundColor: bg || C.gray100 }]}>
      <Text style={[sb.value, { color: color || C.gray900 }]}>{value}</Text>
      <Text style={sb.label}>{label}</Text>
    </View>
  );
}

const sb = StyleSheet.create({
  box:   { flex: 1, alignItems: "center", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 4 },
  value: { fontSize: 18, fontWeight: "800" },
  label: { fontSize: 10, color: C.gray500, fontWeight: "600", marginTop: 2, textAlign: "center" },
});

function ProgressBar({ value, color, max = 100 }) {
  const pct = Math.min(100, Math.max(0, max > 0 ? (value / max) * 100 : 0));
  return (
    <View style={pb.track}>
      <View style={[pb.fill, { width: `${pct}%`, backgroundColor: color }]} />
    </View>
  );
}

const pb = StyleSheet.create({
  track: { height: 6, backgroundColor: C.gray100, borderRadius: 3, overflow: "hidden", flex: 1 },
  fill:  { height: "100%", borderRadius: 3 },
});

function TabBar({ tabs, active, onSelect }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={tb.wrap}
      contentContainerStyle={tb.content}
    >
      {tabs.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={[tb.tab, active === tab.key && tb.tabActive]}
          onPress={() => onSelect(tab.key)}
          activeOpacity={0.7}
        >
          <Text style={[tb.label, active === tab.key && tb.labelActive]}>
            {tab.label}
          </Text>
          {tab.count != null && (
            <View style={[tb.badge, active === tab.key && tb.badgeActive]}>
              <Text style={[tb.badgeText, active === tab.key && tb.badgeTextActive]}>
                {tab.count}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const tb = StyleSheet.create({
  wrap:            { backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.gray100 },
  content:         { paddingHorizontal: 16, paddingVertical: 10, gap: 8, flexDirection: "row" },
  tab:             { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: C.gray100 },
  tabActive:       { backgroundColor: C.primaryBg },
  label:           { fontSize: 13, fontWeight: "600", color: C.gray500 },
  labelActive:     { color: C.primary },
  badge:           { backgroundColor: C.gray300, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1, minWidth: 18, alignItems: "center" },
  badgeActive:     { backgroundColor: C.primary },
  badgeText:       { fontSize: 10, fontWeight: "700", color: C.gray600 },
  badgeTextActive: { color: C.white },
});

// ═════════════════════════════════════════════════════════════════════════════
// SUBJECT ANALYTICS STRIP
// ═════════════════════════════════════════════════════════════════════════════

function SubjectAnalyticsStrip({ analytics }) {
  const { t } = useTranslation();
  if (!analytics) return null;
  return (
    <View style={sas.wrap}>
      {[
        { id: "avg",   label: t("teacherResults.stats.avg"),   value: `${analytics.avg}%`,      color: getPerformanceColor(analytics.avg) },
        { id: "pass",  label: t("teacherResults.stats.pass"),  value: `${analytics.passRate}%`, color: analytics.passRate >= 70 ? C.success : C.warning },
        { id: "high",  label: t("teacherResults.stats.high"),  value: `${analytics.max}%`,      color: C.success },
        { id: "low",   label: t("teacherResults.stats.low"),   value: `${analytics.min}%`,      color: analytics.min < 50 ? C.error : C.gray700 },
        { id: "total", label: t("teacherResults.stats.total"), value: analytics.total,          color: C.primary },
      ].map(({ id, label, value, color }, i, arr) => (
        <React.Fragment key={id}>
          <View style={sas.item}>
            <Text style={[sas.value, { color }]}>{value}</Text>
            <Text style={sas.label}>{label}</Text>
          </View>
          {i < arr.length - 1 && <View style={sas.divider} />}
        </React.Fragment>
      ))}
    </View>
  );
}

const sas = StyleSheet.create({
  wrap:    { flexDirection: "row", alignItems: "center", backgroundColor: C.gray50, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 10 },
  item:    { flex: 1, alignItems: "center" },
  value:   { fontSize: 13, fontWeight: "800" },
  label:   { fontSize: 9, color: C.gray400, fontWeight: "600", marginTop: 1 },
  divider: { width: 1, height: 24, backgroundColor: C.gray200 },
});

// ═════════════════════════════════════════════════════════════════════════════
// RESULT ROW
// ═════════════════════════════════════════════════════════════════════════════

function ResultRow({ result, onPress }) {
  const { t }   = useTranslation();
  const pct     = result.percentage;
  const grade   = getGrade(pct);
  const perfCol = getPerformanceColor(pct);
  const isQuiz  = result.source === "quiz";

  return (
    <TouchableOpacity style={rr.row} onPress={() => onPress?.(result)} activeOpacity={0.7}>
      <View style={[rr.gradeBadge, { backgroundColor: grade.color + "18" }]}>
        <Text style={[rr.gradeText, { color: grade.color }]}>{grade.grade}</Text>
      </View>
      <View style={rr.info}>
        <View style={rr.nameRow}>
          <Text style={rr.studentName} numberOfLines={1}>
            {result.studentName || t("teacherResults.unknown")}
          </Text>
          {isQuiz && (
            <View style={rr.quizTag}>
              <Text style={rr.quizTagText}>Q</Text>
            </View>
          )}
        </View>
        <Text style={rr.examTitle} numberOfLines={1}>
          {result.examTitle || t("teacherResults.assessment")}
          {result.examDate
            ? `  ·  ${new Date(result.examDate).toLocaleDateString()}`
            : ""}
        </Text>
      </View>
      <View style={rr.scoreCol}>
        <Text style={[rr.pct, { color: perfCol }]}>
          {pct != null ? `${pct}%` : "—"}
        </Text>
        {result.marksObtained != null && (
          <Text style={rr.marks}>
            {result.marksObtained}/{result.totalMarks ?? "—"}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const rr = StyleSheet.create({
  row:         { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.gray100, gap: 10 },
  gradeBadge:  { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  gradeText:   { fontSize: 12, fontWeight: "800" },
  info:        { flex: 1 },
  nameRow:     { flexDirection: "row", alignItems: "center", gap: 6 },
  studentName: { fontSize: 13, fontWeight: "700", color: C.gray900, flex: 1 },
  quizTag:     { backgroundColor: C.purpleBg, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  quizTagText: { fontSize: 9, fontWeight: "800", color: C.purple },
  examTitle:   { fontSize: 11, color: C.gray400, marginTop: 2 },
  scoreCol:    { alignItems: "flex-end" },
  pct:         { fontSize: 14, fontWeight: "800" },
  marks:       { fontSize: 10, color: C.gray400, marginTop: 1 },
});

// ═════════════════════════════════════════════════════════════════════════════
// RESULT CARD
// ═════════════════════════════════════════════════════════════════════════════

function ResultCard({ result, onPress }) {
  const { t }   = useTranslation();
  const pct     = result.percentage;
  const grade   = getGrade(pct);
  const perfCol = getPerformanceColor(pct);
  const isQuiz  = result.source === "quiz";

  return (
    <TouchableOpacity style={rc.card} onPress={() => onPress?.(result)} activeOpacity={0.7}>
      <View style={[rc.accent, { backgroundColor: isQuiz ? C.purple : C.primary }]} />
      <View style={rc.body}>
        <View style={rc.headerRow}>
          <View style={rc.titleWrap}>
            <View style={[rc.sourceTag, { backgroundColor: isQuiz ? C.purpleBg : C.primaryBg }]}>
              <Ionicons
                name={isQuiz ? "help-circle-outline" : "document-text-outline"}
                size={10}
                color={isQuiz ? C.purple : C.primary}
              />
              <Text style={[rc.sourceText, { color: isQuiz ? C.purple : C.primary }]}>
                {isQuiz
                  ? t("teacherResults.sourceQuiz")
                  : t("teacherResults.sourceExam")}
              </Text>
            </View>
            <Text style={rc.examTitle} numberOfLines={1}>
              {result.examTitle || t("teacherResults.assessment")}
            </Text>
          </View>
          <View style={[rc.gradeBadge, { backgroundColor: grade.color + "18" }]}>
            <Text style={[rc.gradeText, { color: grade.color }]}>{grade.grade}</Text>
          </View>
        </View>
        <Text style={rc.studentName} numberOfLines={1}>
          {result.studentName || t("teacherResults.unknownStudent")}
        </Text>
        <View style={rc.metaRow}>
          {!!result.subjectName && (
            <View style={rc.metaChip}>
              <Ionicons name="book-outline" size={10} color={C.gray400} />
              <Text style={rc.metaText}>{result.subjectName}</Text>
            </View>
          )}
          {!!result.className && (
            <View style={rc.metaChip}>
              <Ionicons name="school-outline" size={10} color={C.gray400} />
              <Text style={rc.metaText}>{result.className}</Text>
            </View>
          )}
          {!!result.examDate && (
            <View style={rc.metaChip}>
              <Ionicons name="calendar-outline" size={10} color={C.gray400} />
              <Text style={rc.metaText}>
                {new Date(result.examDate).toLocaleDateString()}
              </Text>
            </View>
          )}
        </View>
        <View style={rc.scoreRow}>
          <ProgressBar value={pct ?? 0} color={perfCol} />
          <Text style={[rc.scoreText, { color: perfCol }]}>
            {pct != null ? `${pct}%` : "—"}
          </Text>
        </View>
        {result.marksObtained != null && (
          <Text style={rc.marks}>
            {t("teacherResults.marks", {
              obtained: result.marksObtained,
              total:    result.totalMarks ?? "—",
            })}
          </Text>
        )}
        {isQuiz && result.timeTaken != null && (
          <Text style={rc.marks}>
            {t("teacherResults.minutes", {
              minutes: Math.round(result.timeTaken / 60),
            })}
            {"  "}
            {result.isPassed
              ? t("teacherResults.quizPassed")
              : t("teacherResults.quizFailed")}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const rc = StyleSheet.create({
  card:        { flexDirection: "row", backgroundColor: C.white, borderRadius: 12, marginBottom: 8, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 2 },
  accent:      { width: 4 },
  body:        { flex: 1, padding: 12, gap: 6 },
  headerRow:   { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  titleWrap:   { flex: 1, gap: 4, marginRight: 8 },
  sourceTag:   { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, alignSelf: "flex-start" },
  sourceText:  { fontSize: 9, fontWeight: "700" },
  examTitle:   { fontSize: 13, fontWeight: "700", color: C.gray900 },
  gradeBadge:  { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  gradeText:   { fontSize: 14, fontWeight: "800" },
  studentName: { fontSize: 12, color: C.gray600, fontWeight: "600" },
  metaRow:     { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  metaChip:    { flexDirection: "row", alignItems: "center", gap: 3 },
  metaText:    { fontSize: 10, color: C.gray400, fontWeight: "500" },
  scoreRow:    { flexDirection: "row", alignItems: "center", gap: 8 },
  scoreText:   { fontSize: 12, fontWeight: "700", minWidth: 36, textAlign: "right" },
  marks:       { fontSize: 11, color: C.gray500 },
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUPED RESULTS VIEW
// ═════════════════════════════════════════════════════════════════════════════

function GroupedResultsView({ grouped, onResultPress, filterSource }) {
  const { t } = useTranslation();
  const [expandedClasses,  setExpandedClasses]  = useState({});
  const [expandedSubjects, setExpandedSubjects] = useState({});

  const toggleClass   = (id) => setExpandedClasses((p)  => ({ ...p, [id]: !p[id] }));
  const toggleSubject = (k)  => setExpandedSubjects((p) => ({ ...p, [k]:  !p[k] }));

  if (!grouped.length) return null;

  return (
    <ScrollView
      style={{ flex: 1 }}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
    >
      {grouped.map((cls, ci) => {
        const accentColor = CLASS_ACCENT_COLORS[ci % CLASS_ACCENT_COLORS.length];
        const isClassOpen = expandedClasses[cls.classId] !== false;

        const classResults = cls.subjects.flatMap((s) => s.results);
        const filteredCls  = filterSource === "all"
          ? classResults
          : classResults.filter((r) => r.source === filterSource);

        // #R8 — pass filtered results to analytics (was always using classResults)
        const classAnalytics = calculateAnalytics(filteredCls);

        return (
          <View key={cls.classId} style={gv.classCard}>
            <TouchableOpacity
              style={[gv.classHeader, { borderLeftColor: accentColor }]}
              onPress={() => toggleClass(cls.classId)}
              activeOpacity={0.8}
            >
              <View style={[gv.classIconBg, { backgroundColor: accentColor + "18" }]}>
                <Ionicons name="school-outline" size={18} color={accentColor} />
              </View>
              <View style={gv.classHeaderText}>
                <Text style={gv.className}>{cls.className}</Text>
                <Text style={gv.classMeta}>
                  {t("teacherResults.subjectCount", {
                    count: cls.subjects.length,
                  })}
                  {"  ·  "}
                  {t("teacherResults.resultCount", {
                    count: filteredCls.length,
                  })}
                  {classAnalytics
                    ? `  ·  ${t("teacherResults.avgInline", {
                        avg: classAnalytics.avg,
                      })}`
                    : ""}
                </Text>
              </View>
              <Ionicons
                name={isClassOpen ? "chevron-up" : "chevron-down"}
                size={18}
                color={C.gray400}
              />
            </TouchableOpacity>

            {isClassOpen && (
              <View style={gv.classBody}>
                {cls.subjects.map((sub) => {
                  const subKey    = `${cls.classId}::${sub.subjectKey}`;
                  const isSubOpen = expandedSubjects[subKey] !== false;

                  const subResults = filterSource === "all"
                    ? sub.results
                    : sub.results.filter((r) => r.source === filterSource);

                  // #R8 — recalculate analytics when a source filter is active
                  const subAnalytics = filterSource === "all"
                    ? sub.analytics
                    : calculateAnalytics(subResults);

                  if (!subResults.length) return null;

                  return (
                    <View key={sub.subjectKey} style={gv.subjectBlock}>
                      <TouchableOpacity
                        style={gv.subjectHeader}
                        onPress={() => toggleSubject(subKey)}
                        activeOpacity={0.7}
                      >
                        <View style={[gv.subjectDot, { backgroundColor: accentColor }]} />
                        <Text style={gv.subjectName}>{sub.subjectName}</Text>
                        <Text style={gv.subjectCount}>{subResults.length}</Text>
                        <Ionicons
                          name={isSubOpen ? "chevron-up" : "chevron-down"}
                          size={14}
                          color={C.gray400}
                        />
                      </TouchableOpacity>

                      {isSubOpen && (
                        <View style={gv.subjectResults}>
                          <SubjectAnalyticsStrip analytics={subAnalytics} />
                          {subResults.map((r, idx) => (
                            <ResultRow
                              key={String(r.id || idx)}
                              result={r}
                              onPress={onResultPress}
                            />
                          ))}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const gv = StyleSheet.create({
  classCard:       { backgroundColor: C.white, borderRadius: 16, marginBottom: 16, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  classHeader:     { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderLeftWidth: 4 },
  classIconBg:     { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  classHeaderText: { flex: 1 },
  className:       { fontSize: 16, fontWeight: "700", color: C.gray900 },
  classMeta:       { fontSize: 11, color: C.gray400, marginTop: 2 },
  classBody:       { borderTopWidth: 1, borderTopColor: C.gray100 },
  subjectBlock:    { borderBottomWidth: 1, borderBottomColor: C.gray100 },
  subjectHeader:   { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14, gap: 8, backgroundColor: C.gray50 },
  subjectDot:      { width: 8, height: 8, borderRadius: 4 },
  subjectName:     { flex: 1, fontSize: 13, fontWeight: "700", color: C.gray700 },
  subjectCount:    { fontSize: 11, fontWeight: "700", color: C.gray400, backgroundColor: C.gray100, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  subjectResults:  { backgroundColor: C.white },
});

// ═════════════════════════════════════════════════════════════════════════════
// ANALYTICS PANEL
// ═════════════════════════════════════════════════════════════════════════════

function AnalyticsPanel({ analytics }) {
  const { t } = useTranslation();

  if (!analytics) {
    return (
      <View style={ap.empty}>
        <Ionicons name="bar-chart-outline" size={32} color={C.gray300} />
        <Text style={ap.emptyText}>{t("teacherResults.panel.noData")}</Text>
      </View>
    );
  }

  const gradeColors = {
    "A+": "#059669", A: "#059669", B: "#2563EB",
    C: "#D97706", D: "#EA580C", F: "#DC2626",
  };
  const rangeColors = {
    "90-100": "#059669", "70-89": "#2563EB",
    "50-69":  "#D97706", "0-49":  "#DC2626",
  };

  const maxGrade = Math.max(...Object.values(analytics.gradeDist), 1);
  const maxRange = Math.max(...Object.values(analytics.ranges), 1);

  return (
    <View style={ap.wrap}>
      <View style={ap.row}>
        <StatBox label={t("teacherResults.stats.average")} value={`${analytics.avg}%`}
          color={getPerformanceColor(analytics.avg)}
          bg={getPerformanceColor(analytics.avg) + "15"} />
        <StatBox label={t("teacherResults.stats.highest")} value={`${analytics.max}%`} color={C.success} bg={C.successBg} />
        <StatBox label={t("teacherResults.stats.lowest")}  value={`${analytics.min}%`}
          color={analytics.min < 50 ? C.error : C.warning}
          bg={analytics.min < 50 ? C.errorBg : C.warningBg} />
      </View>
      <View style={[ap.row, { marginTop: 8 }]}>
        <StatBox label={t("teacherResults.stats.total")}    value={analytics.total}  color={C.primary} bg={C.primaryBg} />
        <StatBox label={t("teacherResults.stats.passed")}   value={analytics.passed} color={C.success} bg={C.successBg} />
        <StatBox label={t("teacherResults.stats.failed")}   value={analytics.failed} color={C.error}   bg={C.errorBg}   />
        <StatBox label={t("teacherResults.stats.passRate")} value={`${analytics.passRate}%`}
          color={analytics.passRate >= 70 ? C.success : C.warning}
          bg={analytics.passRate >= 70 ? C.successBg : C.warningBg} />
      </View>
      <View style={ap.section}>
        <Text style={ap.sectionTitle}>
          {t("teacherResults.panel.gradeDistribution")}
        </Text>
        {Object.entries(analytics.gradeDist).map(([grade, count]) => (
          <View key={grade} style={ap.barRow}>
            <Text style={[ap.barLabel, { color: gradeColors[grade] }]}>{grade}</Text>
            <View style={ap.barTrack}>
              <ProgressBar value={count} max={maxGrade} color={gradeColors[grade]} />
            </View>
            <Text style={ap.barCount}>{count}</Text>
          </View>
        ))}
      </View>
      <View style={ap.section}>
        <Text style={ap.sectionTitle}>
          {t("teacherResults.panel.scoreRanges")}
        </Text>
        {Object.entries(analytics.ranges).map(([range, count]) => (
          <View key={range} style={ap.barRow}>
            <Text style={[ap.barLabel, { color: rangeColors[range], fontSize: 10 }]}>
              {range}%
            </Text>
            <View style={ap.barTrack}>
              <ProgressBar value={count} max={maxRange} color={rangeColors[range]} />
            </View>
            <Text style={ap.barCount}>{count}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const ap = StyleSheet.create({
  wrap:         { gap: 0 },
  row:          { flexDirection: "row", gap: 8 },
  section:      { marginTop: 20 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: C.gray700, marginBottom: 10 },
  barRow:       { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  barLabel:     { width: 34, fontSize: 11, fontWeight: "700", textAlign: "center" },
  barTrack:     { flex: 1 },
  barCount:     { width: 24, fontSize: 11, color: C.gray500, textAlign: "right" },
  empty:        { alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 40 },
  emptyText:    { fontSize: 14, color: C.gray400, fontWeight: "500" },
});

// ═════════════════════════════════════════════════════════════════════════════
// RESULT DETAIL MODAL
// ═════════════════════════════════════════════════════════════════════════════

function ResultDetailModal({ result, visible, onClose }) {
  const { t } = useTranslation();

  if (!result) return null;

  const pct    = result.percentage;
  const grade  = getGrade(pct);
  const isQuiz = result.source === "quiz";

  const rows = [
    { id: "student",   label: t("teacherResults.detail.student"),   value: result.studentName || "—" },
    { id: "admission", label: t("teacherResults.detail.admission"), value: result.admissionNo  || "—" },
    { id: "subject",   label: t("teacherResults.detail.subject"),   value: result.subjectName  || "—" },
    { id: "class",     label: t("teacherResults.detail.class"),     value: result.className    || "—" },
    {
      id:    "type",
      label: t("teacherResults.detail.type"),
      value: isQuiz
        ? t("teacherResults.sourceQuiz")
        : t("teacherResults.sourceExam"),
    },
    {
      id:    "date",
      label: t("teacherResults.detail.date"),
      value: result.examDate
        ? new Date(result.examDate).toLocaleDateString("en-GB", {
            day: "2-digit", month: "short", year: "numeric",
          })
        : "—",
    },
    ...(isQuiz ? [
      {
        id:    "timeTaken",
        label: t("teacherResults.detail.timeTaken"),
        value: result.timeTaken
          ? `${Math.floor(result.timeTaken / 60)}m ${result.timeTaken % 60}s`
          : "—",
      },
      {
        id:    "passed",
        label: t("teacherResults.detail.passed"),
        value: result.isPassed
          ? t("teacherResults.detail.yes")
          : t("teacherResults.detail.no"),
      },
      { id: "attempt",   label: t("teacherResults.detail.attempt"),   value: result.attemptNumber ? `#${result.attemptNumber}` : "—" },
      { id: "questions", label: t("teacherResults.detail.questions"), value: String(result.totalQuestions ?? "—") },
    ] : [
      { id: "remarks", label: t("teacherResults.detail.remarks"), value: result.remarks || "—" },
      { id: "status",  label: t("teacherResults.detail.status"),  value: result.status  || "—" },
    ]),
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={dm.wrap}>
        <View style={dm.header}>
          <Text style={dm.title} numberOfLines={2}>
            {result.examTitle || t("teacherResults.assessmentDetail")}
          </Text>
          <TouchableOpacity onPress={onClose} style={dm.closeBtn}>
            <Ionicons name="close" size={22} color={C.gray900} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={dm.body}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: 16, paddingBottom: 40 }}
        >
          <View style={dm.hero}>
            <View style={[dm.gradeCircle, { borderColor: grade.color }]}>
              <Text style={[dm.gradeCircleText, { color: grade.color }]}>
                {grade.grade}
              </Text>
            </View>
            <Text style={[dm.pctText, { color: grade.color }]}>
              {pct != null ? `${pct}%` : "N/A"}
            </Text>
            {result.marksObtained != null && (
              <Text style={dm.marksText}>
                {t("teacherResults.marks", {
                  obtained: result.marksObtained,
                  total:    result.totalMarks ?? "—",
                })}
              </Text>
            )}
          </View>
          <View style={dm.infoCard}>
            {rows.map(({ id, label, value }) => (
              <View key={id} style={dm.infoRow}>
                <Text style={dm.infoLabel}>{label}</Text>
                <Text style={dm.infoValue}>{String(value)}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const dm = StyleSheet.create({
  wrap:            { flex: 1, backgroundColor: C.white },
  header:          { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: C.gray100 },
  title:           { flex: 1, fontSize: 17, fontWeight: "700", color: C.gray900, marginRight: 12 },
  closeBtn:        { width: 36, height: 36, borderRadius: 10, backgroundColor: C.gray100, alignItems: "center", justifyContent: "center" },
  body:            { flex: 1, paddingHorizontal: 20, paddingTop: 20 },
  hero:            { alignItems: "center", gap: 8, paddingVertical: 12 },
  gradeCircle:     { width: 72, height: 72, borderRadius: 36, borderWidth: 3, alignItems: "center", justifyContent: "center" },
  gradeCircleText: { fontSize: 26, fontWeight: "900" },
  pctText:         { fontSize: 32, fontWeight: "800", color: C.gray900 },
  marksText:       { fontSize: 14, color: C.gray500 },
  infoCard:        { backgroundColor: C.gray50, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 8 },
  infoRow:         { flexDirection: "row", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.gray100 },
  infoLabel:       { fontSize: 13, color: C.gray500, fontWeight: "500" },
  infoValue:       { fontSize: 13, color: C.gray900, fontWeight: "600", textAlign: "right", flex: 1, marginLeft: 16 },
});

// ═════════════════════════════════════════════════════════════════════════════
// EMPTY STATE
// ═════════════════════════════════════════════════════════════════════════════

// #R9 — removed flex:1 so this renders correctly inside FlatList on Android
function EmptyState({ message }) {
  const { t } = useTranslation();

  return (
    <View style={styles.empty}>
      <View style={styles.emptyIconBg}>
        <Ionicons name="document-outline" size={48} color={C.gray300} />
      </View>
      <Text style={styles.emptyTitle}>{t("teacherResults.empty.title")}</Text>
      <Text style={styles.emptyText}>
        {message || t("teacherResults.empty.default")}
      </Text>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ═════════════════════════════════════════════════════════════════════════════

export default function TeacherResultsScreen() {
  const { t }     = useTranslation();
  const user      = useAuthStore((s) => s.user);
  const schoolId  = String(user?.schoolId || "");
  const teacherId = String(user?._id || user?.id || "");

  const [allResults,     setAllResults]     = useState([]);
  const [assignments,    setAssignments]    = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [error,          setError]          = useState(null);
  const [activeTab,      setActiveTab]      = useState("grouped");
  const [selectedResult, setSelectedResult] = useState(null);
  const [modalVisible,   setModalVisible]   = useState(false);

  const loadedRef = useRef(false);

  const loadResults = useCallback(async (isRefresh = false) => {
    if (!teacherId) { setLoading(false); return; }
    if (loadedRef.current && !isRefresh) return;

    try {
      if (isRefresh) setRefreshing(true);
      else           setLoading(true);
      setError(null);

      const assignmentRows = await loadTeacherAssignments(teacherId);
      setAssignments(assignmentRows);

      const classIds   = [...new Set(assignmentRows.map((a) => a.classId).filter(Boolean))];
      const subjectIds = [...new Set(assignmentRows.map((a) => a.subjectId).filter(Boolean))];

      let combined = [];

      if (classIds.length > 0) {
        const [examResults, quizResults] = await Promise.all([
          loadExamMarks(teacherId, classIds, subjectIds),
          loadQuizResults(teacherId, classIds),
        ]);
        combined = [...examResults, ...quizResults];
      }

      // #R7 — merge API results with composite-key dedup
      const apiResults = await loadResultsFromAPI(schoolId, t);
      if (apiResults.length > 0) {
        const existingIds = new Set(combined.map((r) => String(r.id)));
        // Composite key: source + examTitle + studentName prevents phantom
        // duplicates when the same row has a different ID in DB vs API.
        const compositeKeys = new Set(
          combined.map(
            (r) =>
              `${r.source}||${(r.examTitle || "").toLowerCase()}||${(r.studentName || "").toLowerCase()}`
          )
        );

        combined = [
          ...combined,
          ...apiResults.filter((r) => {
            if (existingIds.has(String(r.id))) return false;
            const ck = `${r.source}||${(r.examTitle || "").toLowerCase()}||${(r.studentName || "").toLowerCase()}`;
            if (compositeKeys.has(ck)) return false;
            compositeKeys.add(ck);
            return true;
          }),
        ];
      }

      // Sort by date descending
      combined.sort((a, b) => {
        const da = a.examDate ? new Date(a.examDate).getTime() : 0;
        const db = b.examDate ? new Date(b.examDate).getTime() : 0;
        return db - da;
      });

      setAllResults(combined);
      loadedRef.current = true;
    } catch (err) {
      console.error("[results] load error:", err.message);
      setError(t("teacherResults.error"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // `t` is intentionally not a dependency: i18n.t() reads the live locale at
    // call time, and listing it here would reload every result on a language
    // switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherId, schoolId]);

  useEffect(() => {
    loadedRef.current = false;
    loadResults();
  }, [loadResults]);

  // Derived data — memoised to avoid recalculating on every render
  const grouped       = useMemo(() => groupResults(allResults, t),               [allResults, t]);
  const examResults   = useMemo(() => allResults.filter((r) => r.source === "exam"), [allResults]);
  const quizResults   = useMemo(() => allResults.filter((r) => r.source === "quiz"), [allResults]);
  const analytics     = useMemo(() => calculateAnalytics(allResults),               [allResults]);
  const examAnalytics = useMemo(() => calculateAnalytics(examResults),              [examResults]);
  const quizAnalytics = useMemo(() => calculateAnalytics(quizResults),              [quizResults]);

  const tabs = [
    { key: "grouped",  label: t("teacherResults.tabs.grouped"),  count: allResults.length },
    { key: "exams",    label: t("teacherResults.tabs.exams"),    count: examResults.length },
    { key: "quizzes",  label: t("teacherResults.tabs.quizzes"),  count: quizResults.length },
    { key: "analysis", label: t("teacherResults.tabs.analysis") },
  ];

  const openDetail = useCallback((r) => {
    setSelectedResult(r);
    setModalVisible(true);
  }, []);

  const flatListData = useMemo(() =>
    activeTab === "exams"   ? examResults  :
    activeTab === "quizzes" ? quizResults  :
    allResults,
  [activeTab, examResults, quizResults, allResults]);

  // Inline analytics for the active flat-list tab (memoised)
  const flatListAnalytics = useMemo(
    () => calculateAnalytics(flatListData),
    [flatListData]
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.primary} />
        <Text style={styles.loadingText}>{t("teacherResults.loading")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>

      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={C.gray900} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>{t("teacherResults.title")}</Text>
          <Text style={styles.headerSub}>
            {t("teacherResults.resultCount", { count: allResults.length })}
            {assignments.length > 0
              ? `  ·  ${t("teacherResults.subjectCount", {
                  count: assignments.length,
                })}`
              : ""}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => loadResults(true)}
          style={styles.refreshBtn}
          disabled={refreshing}
        >
          <Ionicons
            name={refreshing ? "hourglass-outline" : "refresh"}
            size={22}
            color={C.primary}
          />
        </TouchableOpacity>
      </View>

      {/* TABS */}
      <TabBar tabs={tabs} active={activeTab} onSelect={setActiveTab} />

      {/* ERROR */}
      {!!error && (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle-outline" size={16} color={C.error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => loadResults(true)}>
            <Text style={styles.retryText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* GROUPED VIEW */}
      {activeTab === "grouped" && (
        allResults.length === 0
          ? <EmptyState />
          : <GroupedResultsView
              grouped={grouped}
              onResultPress={openDetail}
              filterSource="all"
            />
      )}

      {/* FLAT LIST (exams / quizzes) */}
      {(activeTab === "exams" || activeTab === "quizzes") && (
        flatListData.length === 0 ? (
          <EmptyState
            message={
              activeTab === "exams"
                ? t("teacherResults.empty.noExamResults")
                : t("teacherResults.empty.noQuizResults")
            }
          />
        ) : (
          <FlatList
            data={flatListData}
            keyExtractor={(item, idx) => String(item.id || idx)}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => loadResults(true)}
                tintColor={C.primary}
                colors={[C.primary]}
              />
            }
            ListHeaderComponent={
              flatListAnalytics ? (
                <View style={styles.summaryStrip}>
                  {[
                    { id: "average",  label: t("teacherResults.stats.average"),  value: `${flatListAnalytics.avg}%` },
                    { id: "passRate", label: t("teacherResults.stats.passRate"), value: `${flatListAnalytics.passRate}%`, color: C.success },
                    { id: "results",  label: t("teacherResults.stats.results"),  value: flatListData.length },
                    { id: "topScore", label: t("teacherResults.stats.topScore"), value: `${flatListAnalytics.max}%`,      color: C.primary },
                  ].map(({ id, label, value, color }, i, arr) => (
                    <React.Fragment key={id}>
                      <View style={styles.summaryItem}>
                        <Text style={[styles.summaryValue, color ? { color } : {}]}>{value}</Text>
                        <Text style={styles.summaryLabel}>{label}</Text>
                      </View>
                      {i < arr.length - 1 && <View style={styles.summaryDivider} />}
                    </React.Fragment>
                  ))}
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <ResultCard result={item} onPress={openDetail} />
            )}
            ListFooterComponent={
              <Text style={styles.footer}>
                {t("teacherResults.resultCount", {
                  count: flatListData.length,
                })}
              </Text>
            }
          />
        )
      )}

      {/* ANALYSIS TAB */}
      {activeTab === "analysis" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadResults(true)}
              tintColor={C.primary}
            />
          }
        >
          {allResults.length === 0 ? (
            <EmptyState message={t("teacherResults.empty.analysis")} />
          ) : (
            <>
              <View style={styles.analysisSection}>
                <Text style={styles.analysisSectionTitle}>
                  {t("teacherResults.sections.overall")}
                </Text>
                <AnalyticsPanel analytics={analytics} />
              </View>
              {examAnalytics && (
                <View style={styles.analysisSection}>
                  <Text style={styles.analysisSectionTitle}>
                    {t("teacherResults.sections.exam")}
                  </Text>
                  <AnalyticsPanel analytics={examAnalytics} />
                </View>
              )}
              {quizAnalytics && (
                <View style={styles.analysisSection}>
                  <Text style={styles.analysisSectionTitle}>
                    {t("teacherResults.sections.quiz")}
                  </Text>
                  <AnalyticsPanel analytics={quizAnalytics} />
                </View>
              )}
              {grouped.length > 0 && (
                <View style={styles.analysisSection}>
                  <Text style={styles.analysisSectionTitle}>
                    {t("teacherResults.sections.perClass")}
                  </Text>
                  {grouped.map((cls, ci) => {
                    const clsResults   = cls.subjects.flatMap((s) => s.results);
                    const clsAnalytics = calculateAnalytics(clsResults);
                    if (!clsAnalytics) return null;
                    const accent = CLASS_ACCENT_COLORS[ci % CLASS_ACCENT_COLORS.length];
                    return (
                      <View key={cls.classId} style={styles.classBreakdown}>
                        <View style={[styles.classBreakdownDot, { backgroundColor: accent }]} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.classBreakdownTitle}>{cls.className}</Text>
                          <View style={styles.classBreakdownStats}>
                            <StatBox
                              label={t("teacherResults.stats.avg")}
                              value={`${clsAnalytics.avg}%`}
                              color={getPerformanceColor(clsAnalytics.avg)}
                              bg={getPerformanceColor(clsAnalytics.avg) + "15"}
                            />
                            <StatBox
                              label={t("teacherResults.stats.passRate")}
                              value={`${clsAnalytics.passRate}%`}
                              color={clsAnalytics.passRate >= 70 ? C.success : C.warning}
                              bg={clsAnalytics.passRate >= 70 ? C.successBg : C.warningBg}
                            />
                            <StatBox
                              label={t("teacherResults.stats.total")}
                              value={clsAnalytics.total}
                              color={C.primary}
                              bg={C.primaryBg}
                            />
                          </View>
                          {cls.subjects.map((sub) => (
                            <View key={sub.subjectKey} style={styles.subjectBreakdown}>
                              <View style={[styles.subjectBreakdownDot, { backgroundColor: accent }]} />
                              <Text style={styles.subjectBreakdownName}>{sub.subjectName}</Text>
                              {sub.analytics ? (
                                <Text style={styles.subjectBreakdownStats}>
                                  {t("teacherResults.subjectStats", {
                                    avg:  sub.analytics.avg,
                                    pass: sub.analytics.passRate,
                                  })}
                                </Text>
                              ) : null}
                            </View>
                          ))}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* DETAIL MODAL */}
      <ResultDetailModal
        result={selectedResult}
        visible={modalVisible}
        onClose={() => { setModalVisible(false); setSelectedResult(null); }}
      />
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// STYLES
// ═════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: C.gray50 },
  centered:    { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: C.gray500 },

  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14,
    backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.gray100, gap: 10,
  },
  backBtn:      { width: 40, height: 40, borderRadius: 12, backgroundColor: C.gray100, alignItems: "center", justifyContent: "center" },
  headerCenter: { flex: 1 },
  headerTitle:  { fontSize: 20, fontWeight: "700", color: C.gray900 },
  headerSub:    { fontSize: 12, color: C.gray500, marginTop: 2 },
  refreshBtn:   { padding: 8 },

  summaryStrip:   { flexDirection: "row", backgroundColor: C.white, borderRadius: 14, padding: 14, marginBottom: 12, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  summaryItem:    { flex: 1, alignItems: "center" },
  summaryValue:   { fontSize: 16, fontWeight: "800", color: C.gray900 },
  summaryLabel:   { fontSize: 10, color: C.gray400, fontWeight: "600", marginTop: 2 },
  summaryDivider: { width: 1, backgroundColor: C.gray200, marginVertical: 4 },

  errorBanner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginVertical: 8, padding: 12, backgroundColor: C.errorBg, borderRadius: 10, borderWidth: 1, borderColor: "#FECACA" },
  errorText:   { flex: 1, fontSize: 13, color: C.error },
  retryText:   { fontSize: 13, fontWeight: "700", color: C.primary },

  list:   { padding: 16, paddingBottom: 40 },
  footer: { textAlign: "center", fontSize: 12, color: C.gray400, fontWeight: "500", marginTop: 8, marginBottom: 8 },

  // #R9 — no flex:1 so EmptyState renders correctly inside FlatList
  empty:       { alignItems: "center", justifyContent: "center", paddingHorizontal: 40, gap: 16, paddingVertical: 60 },
  emptyIconBg: { width: 88, height: 88, borderRadius: 24, backgroundColor: C.gray100, alignItems: "center", justifyContent: "center" },
  emptyTitle:  { fontSize: 18, fontWeight: "700", color: C.gray700 },
  emptyText:   { fontSize: 14, color: C.gray500, textAlign: "center", lineHeight: 22 },

  analysisSection:      { marginHorizontal: 16, marginTop: 16, backgroundColor: C.white, borderRadius: 16, padding: 16, shadowColor: "#000", shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  analysisSectionTitle: { fontSize: 15, fontWeight: "700", color: C.gray900, marginBottom: 12 },

  classBreakdown:      { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: C.gray50, borderRadius: 12, padding: 12, marginBottom: 10 },
  classBreakdownDot:   { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  classBreakdownTitle: { fontSize: 13, fontWeight: "700", color: C.gray700, marginBottom: 8 },
  classBreakdownStats: { flexDirection: "row", gap: 8, marginBottom: 8 },

  subjectBreakdown:      { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  subjectBreakdownDot:   { width: 6, height: 6, borderRadius: 3 },
  subjectBreakdownName:  { fontSize: 12, fontWeight: "600", color: C.gray600, flex: 1 },
  subjectBreakdownStats: { fontSize: 11, color: C.gray400 },
});