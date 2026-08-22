// src/services/report.generator.service.js
"use strict";

/**
 * report.generator.service.js
 *
 * Fixed issues:
 *  #M1 — local tableExists() replaced with import from dbHelpers
 */

import * as Print      from "expo-print";
import * as Sharing    from "expo-sharing";
// SDK 57 moved the default export of expo-file-system to the new File/Directory
// API, and the old helpers imported from the package root now THROW at runtime
// rather than warn. Importing them from "/legacy" is what keeps this working;
// without it every call here fails with a deprecation error at the moment a
// user asks for a PDF.
import * as FileSystem from "expo-file-system/legacy";
import "react-native-get-random-values";
import { v4 as uuidv4 } from "uuid";

import { getDatabase }         from "../db/database";
import { resolvePlaceholders } from "./placeholder.engine";
import {
  DEFAULT_TEMPLATE_HTML,
  DEFAULT_TEMPLATE_CSS,
}                              from "./default.template";
import api                     from "./api";
import { tableExists as _tableExists } from "../db/dbHelpers";

/**
 * One-argument wrapper — preserves the call signature used throughout this file.
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
const tableExists = async (tableName) => {
  try {
    const db = await getDatabase();
    return _tableExists(db, tableName);
  } catch {
    return false;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — GENERIC DB HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const dbQuery = async (sql, params = []) => {
  try {
    const db = await getDatabase();
    return (await db.getAllAsync(sql, params)) ?? [];
  } catch (err) {
    console.warn("[dbQuery]", err.message, "\nSQL:", sql);
    return [];
  }
};

const dbRun = async (sql, params = []) => {
  try {
    const db = await getDatabase();
    return await db.runAsync(sql, params);
  } catch (err) {
    console.warn("[dbRun]", err.message, "\nSQL:", sql);
    return null;
  }
};

const dbFirst = async (sql, params = []) => {
  try {
    const db = await getDatabase();
    return await db.getFirstAsync(sql, params);
  } catch {
    return null;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — SCHEMA HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const getTableCols = async (tableName) => {
  try {
    const db   = await getDatabase();
    const rows = await db.getAllAsync(`PRAGMA table_info(${tableName})`).catch(() => []);
    return new Set((rows ?? []).map((r) => r.name));
  } catch {
    return new Set();
  }
};

const resolveCol = (colSet, candidates) =>
  candidates.find((c) => colSet.has(c)) ?? null;

const SCHOOL_COLS  = ["schoolId", "school_id"];
const CLASS_COLS   = ["classId",  "class_id"];
const DELETED_COLS = ["deleted_at", "deletedAt"];
const STATUS_COLS  = ["status", "is_active", "isActive"];

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — HTML WRAPPER
// ═════════════════════════════════════════════════════════════════════════════

function wrapWithStyles(html, css = "") {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; font-size: 12px; color: #111; padding: 20px; }
        .subjects-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
        .subjects-table th, .subjects-table td { border: 1px solid #333; padding: 6px 8px; text-align: left; }
        .subjects-table th { background-color: #f0f0f0; font-weight: bold; }
        .student-photo { width: 80px; height: 100px; object-fit: cover; border: 1px solid #ccc; }
        .school-logo { max-height: 80px; max-width: 200px; }
        ${css}
      </style>
    </head>
    <body>${html}</body>
    </html>
  `;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — TEMPLATE SYNC
// ═════════════════════════════════════════════════════════════════════════════

export const syncTemplatesFromApi = async (schoolId) => {
  try {
    const res  = await api.get("/templates", { params: { schoolId }, timeout: 8_000 });
    const rows =
      res.data?.templates ||
      res.data?.data      ||
      (Array.isArray(res.data) ? res.data : []);

    if (!rows.length) return;

    const db = await getDatabase();

    const tableRow = await db.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='report_templates'`
    ).catch(() => null);

    if (!tableRow) {
      await db.execAsync(`
        CREATE TABLE report_templates (
          id TEXT PRIMARY KEY, school_id TEXT, name TEXT,
          html TEXT, css TEXT, is_default INTEGER DEFAULT 0,
          version INTEGER DEFAULT 1, _synced INTEGER DEFAULT 1,
          updated_at TEXT, created_at TEXT, deleted_at TEXT
        )
      `).catch((err) => console.warn("[syncTemplates] CREATE TABLE:", err.message));
    }

    const colRows = await db.getAllAsync(`PRAGMA table_info(report_templates)`).catch(() => []);
    const colSet  = new Set(colRows.map((c) => c.name));

    let schoolCol =
      colSet.has("school_id") ? "school_id" :
      colSet.has("schoolId")  ? "schoolId"  :
      colSet.has("schoolid")  ? "schoolid"  : null;

    if (!schoolCol) {
      await db.execAsync("ALTER TABLE report_templates ADD COLUMN school_id TEXT")
        .catch((err) => console.warn("[syncTemplates] ALTER TABLE:", err.message));
      colSet.add("school_id");
    }

    const resolvedSchoolCol =
      colSet.has("school_id") ? "school_id" :
      colSet.has("schoolId")  ? "schoolId"  : "school_id";

    for (const t of rows) {
      const id = t._id || t.id;
      if (!id) continue;

      const fields = ["id", resolvedSchoolCol, "name"];
      const values = [id, schoolId, t.name || "Template"];

      if (colSet.has("html"))       { fields.push("html");       values.push(t.html || ""); }
      if (colSet.has("css"))        { fields.push("css");        values.push(t.css  || ""); }
      if (colSet.has("is_default")) { fields.push("is_default"); values.push((t.isDefault || t.is_default) ? 1 : 0); }
      if (colSet.has("version"))    { fields.push("version");    values.push(t.version || 1); }
      if (colSet.has("_synced"))    { fields.push("_synced");    values.push(1); }
      if (colSet.has("updated_at")) { fields.push("updated_at"); values.push(t.updatedAt || t.updated_at || new Date().toISOString()); }
      if (colSet.has("created_at")) { fields.push("created_at"); values.push(t.createdAt || t.created_at || new Date().toISOString()); }

      const ph  = fields.map(() => "?").join(", ");
      await db.runAsync(
        `INSERT OR REPLACE INTO report_templates (${fields.join(", ")}) VALUES (${ph})`,
        values
      ).catch((err) => console.warn(`[syncTemplates] INSERT failed for id=${id}:`, err.message));
    }

    console.log(`[syncTemplates] Synced ${rows.length} template(s) ✅`);
  } catch (err) {
    console.warn("[syncTemplates] API sync failed (offline?):", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — TEMPLATE LOADER
// ═════════════════════════════════════════════════════════════════════════════

async function loadTemplate(templateId, schoolId) {
  const queryTemplates = async (extraWhere, extraParams = []) => {
    if (!(await tableExists("report_templates"))) return null;
    const db     = await getDatabase();
    const cols   = await db.getAllAsync(`PRAGMA table_info(report_templates)`).catch(() => []);
    const colSet = new Set(cols.map((c) => c.name));
    const schoolCol  = resolveCol(colSet, ["school_id", "schoolId"]);
    const deletedCol = resolveCol(colSet, ["deleted_at", "deletedAt"]);
    const conditions = [extraWhere];
    const params     = [...extraParams];
    if (schoolCol && schoolId) { conditions.push(`${schoolCol} = ?`); params.push(schoolId); }
    if (deletedCol) { conditions.push(`(${deletedCol} IS NULL OR ${deletedCol} = '')`); }
    return db.getFirstAsync(
      `SELECT * FROM report_templates WHERE ${conditions.join(" AND ")} LIMIT 1`, params
    ).catch(() => null);
  };

  if (templateId && templateId !== "__builtin__") {
    const local = await queryTemplates("id = ?", [templateId]);
    if (local?.html) {
      return { id: local.id, html: local.html, css: local.css || DEFAULT_TEMPLATE_CSS, version: local.version || 1, source: "sqlite" };
    }
    try {
      const res  = await Promise.race([
        api.get(`/templates/${templateId}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5_000)),
      ]);
      const tmpl = res.data?.template || res.data?.data || res.data;
      if (tmpl?.html) {
        await syncTemplatesFromApi(schoolId).catch(() => {});
        return { id: tmpl._id || tmpl.id, html: tmpl.html, css: tmpl.css || "", version: tmpl.version || 1, source: "api" };
      }
    } catch (err) { console.warn("[Template] API fetch failed:", err.message); }
  }

  const sqlDef = await queryTemplates("is_default = 1", []);
  if (sqlDef?.html) {
    return { id: sqlDef.id, html: sqlDef.html, css: sqlDef.css || DEFAULT_TEMPLATE_CSS, version: sqlDef.version || 1, source: "sqlite" };
  }

  try {
    const res  = await Promise.race([
      api.get("/templates", { params: { schoolId }, timeout: 5_000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5_000)),
    ]);
    const list = res.data?.templates || res.data?.data || (Array.isArray(res.data) ? res.data : []);
    const def  = list.find((t) => t.isDefault || t.is_default) || list[0];
    if (def?.html) return { id: def._id || def.id, html: def.html, css: def.css || "", version: def.version || 1, source: "api" };
  } catch (err) { console.warn("[Template] Default API failed:", err.message); }

  const anyLocal = await queryTemplates("1=1", []);
  if (anyLocal?.html) {
    return { id: anyLocal.id, html: anyLocal.html, css: anyLocal.css || DEFAULT_TEMPLATE_CSS, version: anyLocal.version || 1, source: "sqlite" };
  }

  console.warn("[Template] Using built-in fallback");
  return { id: "builtin", html: DEFAULT_TEMPLATE_HTML, css: DEFAULT_TEMPLATE_CSS, version: 1, source: "builtin" };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — REPORT DATA ASSEMBLY
// ═════════════════════════════════════════════════════════════════════════════

async function assembleReportData({ studentId, term, academicYear, schoolId, examId }) {
  if (examId) {
    const endpoints = [
      `/results/${examId}/student/${studentId}/reportcard`,
      `/results/${examId}/student/${studentId}`,
    ];
    for (const ep of endpoints) {
      try {
        const res  = await api.get(ep, { params: { schoolId }, timeout: 8_000 });
        const data = res.data?.data || res.data?.result || res.data;
        if (data && (data.studentName || data.summary || data.subjects)) {
          return normaliseReportData(data, { term, academicYear });
        }
      } catch (err) {
        if (err.response?.status === 404) continue;
        console.warn("[ReportData] API endpoint failed:", ep, err.message);
      }
    }
  }
  return buildReportDataFromSqlite({ studentId, term, academicYear, schoolId, examId });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — NORMALISE API RESPONSE
// ═════════════════════════════════════════════════════════════════════════════

function normaliseReportData(apiData, { term, academicYear }) {
  const summary = apiData.summary || apiData;
  const scores  = apiData.scores  || apiData.subjects || apiData.subjectBreakdown || [];
  return {
    reportId:      `${summary.studentId || ""}_${term}_${academicYear}`,
    studentName:   summary.studentName  || summary.name  || "Student",
    studentId:     summary.studentId    || summary._id   || "",
    admissionNo:   summary.admissionNo  || "",
    gender:        summary.gender       || "",
    dateOfBirth:   summary.dateOfBirth  || null,
    photoBase64:   summary.photoBase64  || null,
    schoolName:    summary.schoolName   || "",
    schoolLogo:    summary.schoolLogo   || null,
    className:     summary.className    || "",
    stream:        summary.stream       || "",
    term:          summary.term         || term         || "",
    academicYear:  summary.academicYear || academicYear || "",
    average:       summary.average      ?? 0,
    percentage:    summary.percentage   ?? 0,
    overallGrade:  summary.overallGrade || summary.grade  || "",
    overallRemark: summary.overallRemark || summary.remark || "",
    isPassing:     summary.isPassing    ?? false,
    gpa:           summary.gpa          ?? null,
    classPosition:  summary.classPosition  ?? null,
    gradePosition:  summary.gradePosition  ?? null,
    schoolPosition: summary.schoolPosition ?? null,
    totalInClass:   summary.totalInClass   ?? null,
    totalInGrade:   summary.totalInGrade   ?? null,
    totalInSchool:  summary.totalInSchool  ?? null,
    subjects: scores.map((s) => ({
      subjectId:   s.subjectId   || s.subject_id   || null,
      subjectName: s.subjectName || s.subject?.name || s.name || "—",
      teacherName: s.teacherName || null,
      caScore:     s.caScore     ?? null,
      examScore:   s.examScore   ?? s.score ?? null,
      total:       s.total       ?? s.score ?? null,
      maxScore:    s.maxScore    ?? 100,
      grade:       s.grade       || "",
      remark:      s.remark      || "",
      isPassing:   s.isPassing   ?? false,
      isAbsent:    s.isAbsent    ?? false,
    })),
    classTeacher:     summary.classTeacher     || "",
    teacherComment:   summary.teacherComment   || summary.overallRemark || "",
    principalComment: summary.principalComment || "",
    promotionStatus:  summary.promotionStatus  || "",
    nextTermDate:     summary.nextTermDate      || null,
    attendance: summary.attendance || { daysPresent: 0, daysAbsent: 0, daysOpen: 0, monthly: [] },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — BUILD FROM SQLITE
// ═════════════════════════════════════════════════════════════════════════════

async function buildReportDataFromSqlite({ studentId, term, academicYear, schoolId, examId }) {
  let student = null;
  if (await tableExists("students")) {
    const colSet   = await getTableCols("students");
    const nameCol  = resolveCol(colSet, ["name", "studentName", "fullName", "full_name"]) || "'Unknown'";
    const admCol   = resolveCol(colSet, ["admissionNo", "admissionNumber", "admission_no"]);
    const classCol = resolveCol(colSet, CLASS_COLS);
    student = await dbFirst(
      `SELECT id, ${nameCol} AS name
       ${classCol ? `, ${classCol} AS classId`    : ""}
       ${admCol   ? `, ${admCol}   AS admissionNo` : ""}
       FROM students WHERE id = ? OR id = ? LIMIT 1`,
      [studentId, String(studentId)]
    );
  }

  let className = "";
  if (student?.classId && await tableExists("classes")) {
    const row = await dbFirst(`SELECT name FROM classes WHERE id = ? LIMIT 1`, [student.classId]);
    className = row?.name || "";
  }

  let schoolName = "";
  if (await tableExists("schools")) {
    const colSet    = await getTableCols("schools");
    const schoolCol = resolveCol(colSet, SCHOOL_COLS);
    if (schoolCol && schoolId) {
      const row = await dbFirst(`SELECT name FROM schools WHERE ${schoolCol} = ? LIMIT 1`, [schoolId]);
      schoolName = row?.name || "";
    }
  }

  let subjects = [];

  if (examId && await tableExists("exam_scores")) {
    const colSet     = await getTableCols("exam_scores");
    const studentCol = resolveCol(colSet, ["studentId", "student_id"]) || "studentId";
    const examCol    = resolveCol(colSet, ["examId",    "exam_id"])    || "examId";
    const scores     = await dbQuery(
      `SELECT * FROM exam_scores WHERE ${studentCol} = ? AND ${examCol} = ? ORDER BY rowid`,
      [studentId, examId]
    );
    subjects = scores.map((s) => ({
      subjectId:   s.subjectId   || s.subject_id   || null,
      subjectName: s.subjectName || s.subject_name || "—",
      teacherName: s.teacherName || s.teacher_name || null,
      caScore:     s.caScore     ?? s.ca_score      ?? null,
      examScore:   s.examScore   ?? s.exam_score    ?? s.score ?? null,
      total:       s.total       ?? s.score         ?? null,
      maxScore:    s.maxScore    ?? s.max_score      ?? 100,
      grade:       s.grade       || "",
      remark:      s.remark      || "",
      isPassing:   !!(s.isPassing ?? s.is_passing),
      isAbsent:    !!(s.isAbsent  ?? s.is_absent),
    }));
  }

  if (!subjects.length && examId && await tableExists("scores")) {
    const colSet     = await getTableCols("scores");
    const studentCol = resolveCol(colSet, ["studentId", "student_id"]) || "studentId";
    const examCol    = resolveCol(colSet, ["examId",    "exam_id"])    || "examId";
    const scores     = await dbQuery(
      `SELECT * FROM scores WHERE ${studentCol} = ? AND ${examCol} = ? ORDER BY rowid`,
      [studentId, examId]
    );
    subjects = scores.map((s) => ({
      subjectId:   s.subjectId   || s.subject_id   || null,
      subjectName: s.subjectName || s.subject_name || "—",
      teacherName: s.teacherName || null,
      caScore:     null,
      examScore:   s.score       ?? null,
      total:       s.score       ?? null,
      maxScore:    s.maxScore    ?? s.max_score ?? 100,
      grade:       s.grade       || "",
      remark:      s.remark      || "",
      isPassing:   !!(s.isPassing ?? s.is_passing),
      isAbsent:    !!(s.isAbsent  ?? s.is_absent),
    }));
  }

  const totalScore = subjects.reduce((sum, s) => sum + (s.total    ?? 0),   0);
  const maxTotal   = subjects.reduce((sum, s) => sum + (s.maxScore ?? 100), 0);
  const percentage = maxTotal > 0 ? Math.round((totalScore / maxTotal) * 100) : 0;
  const isPassing  = percentage >= 50;
  const overallGrade =
    percentage >= 90 ? "A+" : percentage >= 80 ? "A" :
    percentage >= 70 ? "B"  : percentage >= 60 ? "C" :
    percentage >= 50 ? "D"  : "F";

  return {
    reportId:         `${studentId}_${term}_${academicYear}`,
    studentName:      student?.name        || "Student",
    studentId,
    admissionNo:      student?.admissionNo || "",
    gender:           "", dateOfBirth: null, photoBase64: null,
    schoolName, schoolLogo: null, className, stream: "",
    term: term || "", academicYear: academicYear || "",
    average: percentage, percentage, overallGrade,
    overallRemark: isPassing ? "Pass" : "Fail", isPassing, gpa: null,
    classPosition: null, gradePosition: null, schoolPosition: null,
    totalInClass: null, totalInGrade: null, totalInSchool: null,
    subjects,
    classTeacher: "", teacherComment: "", principalComment: "",
    promotionStatus: "", nextTermDate: null,
    attendance: { daysPresent: 0, daysAbsent: 0, daysOpen: 0, monthly: [] },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — PDF GENERATION
// ═════════════════════════════════════════════════════════════════════════════

async function generatePdf({ html, studentId, term, academicYear }) {
  const safeTerm = (term         || "term").replace(/[^a-z0-9_\-]/gi, "_");
  const safeYear = (academicYear || "year").replace(/[^a-z0-9_\-]/gi, "_");
  const safeId   = String(studentId).replace(/[^a-z0-9_\-]/gi, "_");
  const folder   = `${FileSystem.documentDirectory}reports/${safeYear}/${safeTerm}/`;

  await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
  const dest   = `${folder}${safeId}.pdf`;
  const result = await Print.printToFileAsync({ html, base64: true });
  const base64 = result?.base64;
  if (!base64) throw new Error("PDF generation returned no base64 data");

  await FileSystem.writeAsStringAsync(dest, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) throw new Error("PDF file was not created successfully");
  console.log("[ReportGenerator] PDF saved:", dest, "—", info.size, "bytes");
  return dest;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — SAVE REPORT RECORD
// ═════════════════════════════════════════════════════════════════════════════

async function saveReportRecord({
  studentId, templateId, templateVersion, term, academicYear, pdfPath,
}) {
  const db = await getDatabase();
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS generated_reports (
      id TEXT PRIMARY KEY, student_id TEXT, pdf_path TEXT,
      template_id TEXT, template_version INTEGER DEFAULT 1,
      term TEXT, academic_year TEXT, is_published INTEGER DEFAULT 0,
      _synced INTEGER DEFAULT 0, created_at TEXT
    )
  `).catch(() => {});

  const colRows = await db.getAllAsync(`PRAGMA table_info(generated_reports)`).catch(() => []);
  const colSet  = new Set(colRows.map((c) => c.name));

  const studentCol = resolveCol(colSet, ["student_id",       "studentId"])       || "student_id";
  const pdfCol     = resolveCol(colSet, ["pdf_path",         "pdfPath"])         || "pdf_path";
  const tmplCol    = resolveCol(colSet, ["template_id",      "templateId"])      || "template_id";
  const tmplVerCol = resolveCol(colSet, ["template_version", "templateVersion"]) || "template_version";
  const yearCol    = resolveCol(colSet, ["academic_year",    "academicYear"])    || "academic_year";
  const pubCol     = resolveCol(colSet, ["is_published",     "isPublished"])     || "is_published";
  const dateCol    = resolveCol(colSet, ["created_at",       "generatedAt"])     || "created_at";

  const id     = uuidv4();
  const now    = new Date().toISOString();
  const fields = ["id", studentCol, pdfCol, tmplCol, tmplVerCol, "term", yearCol, pubCol, dateCol];
  const values = [id, studentId, pdfPath, templateId || null, templateVersion || 1, term, academicYear, 0, now];

  if (colSet.has("_synced")) { fields.push("_synced"); values.push(0); }

  await db.runAsync(
    `INSERT OR REPLACE INTO generated_reports (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
    values
  ).catch((err) => console.warn("[saveReportRecord] INSERT failed:", err.message));

  return id;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — SERVER SYNC
// ═════════════════════════════════════════════════════════════════════════════

async function saveGeneratedReportToServer({
  studentId, examId, templateId, templateVersion,
  renderedHtml, variablePayload, term, academicYear, schoolId,
}) {
  try {
    await api.post("/generated-reports", {
      studentId, examId: examId || null,
      templateId: templateId || null, templateVersion: templateVersion || 1,
      renderedHtml, variablePayload, term, academicYear, schoolId,
    });
    console.log("[ReportGenerator] Saved to server ✅");
  } catch (err) {
    console.warn("[ReportGenerator] Could not save to server:", err.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — PUBLIC API
// ═════════════════════════════════════════════════════════════════════════════

export async function generateStudentReport({
  studentId, term, academicYear, schoolId, templateId = null, examId = null,
}) {
  console.log("[ReportGenerator] ▶ generateStudentReport:", studentId);

  const [template, reportData] = await Promise.all([
    loadTemplate(templateId, schoolId),
    assembleReportData({ studentId, term, academicYear, schoolId, examId }),
  ]);

  const resolvedHtml = resolvePlaceholders(template.html, reportData);
  const fullHtml     = wrapWithStyles(resolvedHtml, template.css);
  const pdfPath      = await generatePdf({ html: fullHtml, studentId, term, academicYear });

  const reportId = await saveReportRecord({
    studentId, templateId: template.id, templateVersion: template.version,
    term, academicYear, pdfPath,
  });

  saveGeneratedReportToServer({
    studentId, examId, templateId: template.id,
    templateVersion: template.version, renderedHtml: resolvedHtml,
    variablePayload: reportData, term, academicYear, schoolId,
  });

  return { pdfPath, reportId, reportData, templateId: template.id, templateVersion: template.version };
}

export async function generateClassReports({
  classId, term, academicYear, schoolId, templateId = null, examId = null, onProgress,
}) {
  if (!(await tableExists("students"))) {
    return { successful: [], errors: [], total: 0, successCount: 0, errorCount: 0 };
  }

  const colSet     = await getTableCols("students");
  const classCol   = resolveCol(colSet, CLASS_COLS);
  const schoolCol  = resolveCol(colSet, SCHOOL_COLS);
  const deletedCol = resolveCol(colSet, DELETED_COLS);
  const statusCol  = resolveCol(colSet, STATUS_COLS);
  const nameCol    = resolveCol(colSet, ["name", "studentName", "fullName", "full_name"]) || "'Unknown'";
  const userIdCol  = resolveCol(colSet, ["userId", "user_id"]);

  if (!classCol) {
    return { successful: [], errors: [], total: 0, successCount: 0, errorCount: 0 };
  }

  const conditions = [`${classCol} = ?`];
  const params     = [classId];
  if (schoolCol && schoolId) { conditions.push(`${schoolCol} = ?`); params.push(schoolId); }
  if (deletedCol) { conditions.push(`(${deletedCol} IS NULL OR ${deletedCol} = '')`); }
  if (statusCol === "is_active" || statusCol === "isActive") {
    conditions.push(`${statusCol} = 1`);
  } else if (statusCol === "status") {
    conditions.push(`(${statusCol} IN ('approved','active','enrolled') OR ${statusCol} IS NULL)`);
  }

  const groupBy  = userIdCol || nameCol;
  const students = await dbQuery(
    `SELECT MIN(id) AS id, ${nameCol} AS name
     FROM students WHERE ${conditions.join(" AND ")}
     GROUP BY ${groupBy} ORDER BY ${nameCol} ASC`,
    params
  );

  const seen   = new Set();
  const unique = students.filter((s) => {
    const key = (s.name || "").toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const successful = [];
  const errors     = [];

  for (let i = 0; i < unique.length; i++) {
    const s = unique[i];
    try {
      const result = await generateStudentReport({
        studentId: s.id, term, academicYear, schoolId, templateId, examId,
      });
      successful.push({ student: s, ...result });
    } catch (err) {
      errors.push({ studentName: s.name, error: err.message });
    }
    onProgress?.(i + 1, unique.length);
  }

  return {
    successful, errors,
    total: unique.length, successCount: successful.length, errorCount: errors.length,
  };
}

export async function sharePdf(pdfPath, studentName) {
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) throw new Error("Sharing is not available on this device");
  const info = await FileSystem.getInfoAsync(pdfPath);
  if (!info.exists) throw new Error("Report file not found. Please regenerate.");
  await Sharing.shareAsync(pdfPath, {
    mimeType: "application/pdf",
    dialogTitle: `${studentName || "Student"} — Report Card`,
    UTI: "com.adobe.pdf",
  });
}

export async function printPdf(pdfPath) {
  const info = await FileSystem.getInfoAsync(pdfPath);
  if (!info.exists) throw new Error("Report file not found. Please regenerate.");
  await Print.printAsync({ uri: pdfPath });
}