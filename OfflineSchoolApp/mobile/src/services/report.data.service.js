// src/services/report.data.service.js
"use strict";

import { DB }                                         from "../db/dbService";
import api                                            from "./api";
import { resolveColumns, resolveColumnOptional, COL } from "../db/schemaUtils";
import { appError }                                   from "../utils/appError";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

async function tableExists(tableName) {
  const result = await DB.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    [tableName]
  );
  return result.length > 0;
}

function deletedFilter(col, alias = null) {
  if (!col) return "";
  const ref = alias ? `${alias}.${col}` : col;
  return `AND (${ref} IS NULL OR ${ref} = '')`;
}

function normalizeSchool(row) {
  if (!row) return null;

  const addressParts = [
    row.address || row.schoolAddress || "",
    row.city    || "",
    row.state   || "",
    row.country || "",
  ].filter(Boolean);

  return {
    id:       row.id        || row.server_id  || row._id        || "",
    name:     row.name      || row.schoolName || row.school_name || "",
    address:  addressParts.join(", ") || "",
    phone:    row.phone     || row.schoolPhone || "",
    email:    row.email     || row.schoolEmail || "",
    website:  row.website   || "",
    logo_url: row.logo      || row.logo_url   || row.logoUrl    ||
              row.logoBase64 || "",
    city:     row.city      || "",
    state:    row.state     || "",
    country:  row.country   || "",
    code:     row.code      || "",
  };
}

// ─────────────────────────────────────────────────────────
// SCHOOL LOADER
// ─────────────────────────────────────────────────────────

async function cacheSchoolLocally(schoolId, data) {
  try {
    const addressParts = [
      data.address || "",
      data.city    || "",
      data.state   || "",
      data.country || "",
    ].filter(Boolean);

    await DB.run(
      `INSERT OR REPLACE INTO schools
         (id, name, address, phone, email, _synced, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [
        schoolId,
        data.name    || data.schoolName || "",
        addressParts.join(", ") || data.address || "",
        data.phone   || "",
        data.email   || "",
        new Date().toISOString(),
      ]
    );
    console.log("[ReportData] School cached locally ✅");
  } catch (e) {
    console.warn("[ReportData] Could not cache school:", e.message);
  }
}

async function loadSchoolData(schoolId) {
  // ── 1. Local schools table ─────────────────────────────
  if (await tableExists("schools")) {
    const schools = await DB.query(
      `SELECT * FROM schools
       WHERE (deleted_at IS NULL OR deleted_at = '')
       LIMIT 10`,
      []
    );
    console.log("[ReportData] Local schools:", schools.length);

    for (const s of schools) {
      if (
        s.id        === schoolId ||
        s.server_id === schoolId ||
        s._id       === schoolId
      ) {
        console.log("[ReportData] School found locally:", s.name);
        return normalizeSchool(s);
      }
    }

    if (schools.length === 1) {
      console.log("[ReportData] Using only local school:", schools[0].name);
      return normalizeSchool(schools[0]);
    }
  }

  // ── 2. Cached in settings_profile ─────────────────────
  if (await tableExists("settings_profile")) {
    const cached = await DB.findFirst(
      `SELECT * FROM settings_profile WHERE id = 'school_info'`,
      []
    );
    if (cached && cached.name && cached.name !== "First Admin") {
      console.log(
        "[ReportData] School from settings_profile cache:", cached.name
      );
      return normalizeSchool(cached);
    }
  }

  // ── 3. GET /api/admin/school-info ──────────────────────
  try {
    const { data } = await api.get("/admin/school-info");
    const schoolData = data?.school || data?.data || null;

    if (schoolData && (schoolData.name || schoolData.schoolName)) {
      console.log(
        "[ReportData] School from /admin/school-info:", schoolData.name
      );
      await cacheSchoolLocally(schoolId, schoolData);
      return normalizeSchool(schoolData);
    }
  } catch (err) {
    console.log("[ReportData] /admin/school-info:", err.message);
  }

  // ── 4. Placeholder ─────────────────────────────────────
  console.warn("[ReportData] School not found — using placeholder");
  return {
    id:       schoolId || "",
    name:     "School",
    address:  "",
    phone:    "",
    email:    "",
    website:  "",
    logo_url: "",
    city:     "",
    state:    "",
    country:  "",
    code:     "",
  };
}

// ─────────────────────────────────────────────────────────
// EXAM FINDER
// ─────────────────────────────────────────────────────────

async function findExamId(classId, term, academicYear, schoolId) {
  if (await tableExists("exams")) {
    let sql    = `SELECT * FROM exams WHERE 1=1`;
    const prms = [];

    if (schoolId) {
      sql += ` AND schoolId = ?`;
      prms.push(schoolId);
    }
    if (term) {
      sql += ` AND term = ?`;
      prms.push(term);
    }
    if (academicYear) {
      sql += ` AND academicYear = ?`;
      prms.push(academicYear);
    }
    if (classId) {
      sql += ` AND (classId = ? OR classIds LIKE ?)`;
      prms.push(classId, `%${classId}%`);
    }

    sql += ` AND (deleted_at IS NULL OR deleted_at = '')
             ORDER BY created_at DESC LIMIT 1`;

    const exams = await DB.query(sql, prms);
    console.log("[ReportData] Local exams (exact):", exams.length);

    if (exams.length > 0) {
      console.log("[ReportData] Exam:", exams[0].id, exams[0].name || "");
      return exams[0].id;
    }

    const anyExam = await DB.query(
      `SELECT * FROM exams
       WHERE schoolId = ?
         AND (deleted_at IS NULL OR deleted_at = '')
       ORDER BY created_at DESC LIMIT 1`,
      [schoolId]
    );

    if (anyExam.length > 0) {
      console.log(
        "[ReportData] Most recent exam:",
        anyExam[0].id, anyExam[0].name || ""
      );
      return anyExam[0].id;
    }
  }

  // API fallback
  try {
    const params = new URLSearchParams();
    if (classId)      params.set("classId",      classId);
    if (term)         params.set("term",          term);
    if (academicYear) params.set("academicYear",  academicYear);
    if (schoolId)     params.set("schoolId",      schoolId);

    const { data } = await api.get(`/exams?${params.toString()}`);

    const exams =
      Array.isArray(data)        ? data           :
      Array.isArray(data?.data)  ? data.data       :
      Array.isArray(data?.exams) ? data.exams      :
      data?.data?.exams          ? data.data.exams :
      [];

    console.log("[ReportData] Exams from API:", exams.length);

    if (exams.length > 0) {
      exams.sort((a, b) =>
        new Date(b.createdAt || b.created_at || 0) -
        new Date(a.createdAt || a.created_at || 0)
      );
      const examId = exams[0]._id || exams[0].id;
      console.log("[ReportData] Exam from API:", examId, exams[0].name || "");

      for (const e of exams) {
        try {
          await DB.run(
            `INSERT OR REPLACE INTO exams
               (id, schoolId, classId, name, type, academicYear,
                term, status, sync_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
            [
              e._id || e.id,
              schoolId,
              e.classId || e.class_id || classId || "",
              e.name    || e.title    || "",
              e.type    || "",
              e.academicYear || e.academic_year || academicYear,
              e.term    || term,
              e.status  || "active",
              e.createdAt || e.created_at || new Date().toISOString(),
              e.updatedAt || e.updated_at || new Date().toISOString(),
            ]
          );
        } catch (saveErr) {
          console.warn("[ReportData] Could not save exam:", saveErr.message);
        }
      }

      return examId;
    }
  } catch (err) {
    console.warn("[ReportData] Exams API failed:", err.message);
  }

  console.warn("[ReportData] No exam found");
  return null;
}

// ─────────────────────────────────────────────────────────
// MARKS LOADER
// ─────────────────────────────────────────────────────────

async function loadMarksFromApi({
  examId,
  studentId,
  term,
  academicYear,
  schoolId,
}) {
  if (!examId) {
    console.warn("[ReportData] No examId — cannot fetch marks from API");
    return { subjects: [], summary: null, meta: null };
  }

  console.log("[ReportData] Fetching marks — exam:", examId);

  const endpoints = [
    `/results/${examId}/student/${studentId}/reportcard`,
    `/results/${examId}/student/${studentId}`,
  ];

  for (const endpoint of endpoints) {
    try {
      console.log("[ReportData] Trying:", endpoint);
      const { data } = await api.get(endpoint);

      const payload =
        data?.data       ||
        data?.result     ||
        data?.reportCard ||
        data;

      const subjects =
        Array.isArray(payload?.subjects) ? payload.subjects :
        Array.isArray(payload?.scores)   ? payload.scores   :
        Array.isArray(payload?.marks)    ? payload.marks     :
        [];

      console.log("[ReportData] Subjects in response:", subjects.length);

      if (subjects.length > 0) {
        for (const s of subjects) {
          const rowId =
            s.scoreId || s._id || s.id ||
            `${studentId}-${s.subjectId || ""}-${term}`;

          try {
            await DB.run(
              `INSERT OR REPLACE INTO student_marks
                 (id, schoolId, studentId, subjectId, examId,
                  term, academicYear, caScore, examScore, score,
                  grade, remark, _synced, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
              [
                rowId,
                schoolId,
                studentId,
                s.subjectId  || s.subject_id || "",
                examId,
                term,
                academicYear,
                s.caScore    || s.ca_score   || 0,
                s.examScore  || s.exam_score || s.score || 0,
                s.score      || s.normalizedMark || 0,
                s.grade      || "",
                s.teacherRemark || s.remark || (s.isAbsent ? "Absent" : ""),
                new Date().toISOString(),
              ]
            );
          } catch (saveErr) {
            console.warn("[ReportData] Could not save mark:", saveErr.message);
          }
        }

        console.log("[ReportData] Marks saved to local DB ✅");

        return {
          subjects,
          summary: payload?.summary || null,
          meta: {
            studentName:  payload?.studentName  || "",
            className:    payload?.className    || "",
            examName:     payload?.examName     || "",
            academicYear: payload?.academicYear || academicYear,
            term:         payload?.term         || term,
          },
        };
      }
    } catch (err) {
      console.warn(
        "[ReportData] Marks endpoint failed:", endpoint, "—", err.message
      );
    }
  }

  return { subjects: [], summary: null, meta: null };
}

// ─────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────

export async function assembleReportData({
  studentId,
  term,
  academicYear,
  schoolId,
  examId = null,
}) {
  // ── 1. Student ─────────────────────────────────────────
  const studentDeletedCol = await resolveColumnOptional(
    "students", COL.DELETED_AT
  );

  const student = await DB.findFirst(
    `SELECT * FROM students
     WHERE id = ?
       ${deletedFilter(studentDeletedCol)}`,
    [studentId]
  );

  if (!student) throw appError("svcErr.studentNotFound", `Student not found: ${studentId}`);
  console.log("[ReportData] Student:", student.name);

  // ── 2. Class ───────────────────────────────────────────
  const studentCols = await resolveColumns("students", {
    classCol: COL.CLASS_ID,
  });

  const classId  = student[studentCols.classCol];
  const classRow = classId
    ? await DB.findFirst(`SELECT * FROM classes WHERE id = ?`, [classId])
    : null;

  console.log("[ReportData] Class:", classRow?.name || "No class");

  // ── 3. School ──────────────────────────────────────────
  const school = await loadSchoolData(schoolId);
  console.log("[ReportData] School:", school?.name || "No school");

  // ── 4. Local subjects ──────────────────────────────────
  let localSubjects = [];

  if (await tableExists("subjects")) {
    const subjectClassCol   = await resolveColumnOptional("subjects", COL.CLASS_ID);
    const subjectSchoolCol  = await resolveColumnOptional("subjects", COL.SCHOOL_ID);
    const subjectDeletedCol = await resolveColumnOptional("subjects", COL.DELETED_AT);

    if (subjectClassCol && classId) {
      localSubjects = await DB.query(
        `SELECT * FROM subjects
         WHERE ${subjectClassCol} = ?
           ${deletedFilter(subjectDeletedCol)}
         ORDER BY name`,
        [classId]
      );
    } else if (subjectSchoolCol) {
      localSubjects = await DB.query(
        `SELECT * FROM subjects
         WHERE ${subjectSchoolCol} = ?
           ${deletedFilter(subjectDeletedCol)}
         ORDER BY name`,
        [schoolId]
      );
    } else {
      localSubjects = await DB.query(
        `SELECT * FROM subjects
         WHERE 1=1 ${deletedFilter(subjectDeletedCol)}
         ORDER BY name`,
        []
      );
    }
  }

  console.log(
    "[ReportData] Local subjects:",
    localSubjects.map((s) => s.name).join(", ") || "none"
  );

  // ── 5. Marks ───────────────────────────────────────────
  let apiResult  = { subjects: [], summary: null, meta: null };
  let marksCols  = null;
  let localMarks = [];

  const hasMarksTable = await tableExists("student_marks");

  if (hasMarksTable) {
    marksCols = await resolveColumns(
      "student_marks",
      {
        studentCol: COL.STUDENT_ID,
        subjectCol: COL.SUBJECT_ID,
        caCol:      COL.CA_SCORE,
        examCol:    COL.EXAM_SCORE,
        yearCol:    COL.ACADEMIC_YEAR,
      },
      ["caCol", "examCol", "yearCol"]
    );

    const yearFilter = marksCols.yearCol
      ? `AND ${marksCols.yearCol} = ?`
      : `AND academicYear = ?`;

    localMarks = await DB.query(
      `SELECT * FROM student_marks
       WHERE ${marksCols.studentCol} = ?
         AND term = ?
         ${yearFilter}`,
      [studentId, term, academicYear]
    );

    console.log("[ReportData] Local marks:", localMarks.length);
  }

  if (localMarks.length === 0) {
    const resolvedExamId = examId || await findExamId(
      classId, term, academicYear, schoolId
    );

    apiResult = await loadMarksFromApi({
      examId:      resolvedExamId,
      studentId,
      term,
      academicYear,
      schoolId,
    });

    if (apiResult.subjects.length > 0 && hasMarksTable && marksCols) {
      const yearFilter = marksCols.yearCol
        ? `AND ${marksCols.yearCol} = ?`
        : `AND academicYear = ?`;

      localMarks = await DB.query(
        `SELECT * FROM student_marks
         WHERE ${marksCols.studentCol} = ?
           AND term = ?
           ${yearFilter}`,
        [studentId, term, academicYear]
      );
      console.log("[ReportData] Marks after sync:", localMarks.length);
    }
  }

  const marksBySubjectId = {};
  for (const m of localMarks) {
    const key =
      m[marksCols?.subjectCol] ||
      m.subjectId              ||
      m.subject_id             ||
      "";
    if (key) marksBySubjectId[key] = m;
  }

  const apiSubjectMap = {};
  for (const s of apiResult.subjects) {
    if (s.subjectId) apiSubjectMap[s.subjectId] = s;
  }

  console.log(
    "[ReportData] Marks mapped:", Object.keys(marksBySubjectId).length
  );

  // ── 6. Subject source ──────────────────────────────────
  const subjectSource =
    localSubjects.length > 0
      ? localSubjects
      : apiResult.subjects.map((s) => ({
          id:   s.subjectId,
          name: s.subjectName || "",
        }));

  console.log(
    "[ReportData] Subject source:", subjectSource.length,
    "from", localSubjects.length > 0 ? "local DB" : "API"
  );

  // ── 7. Attendance ──────────────────────────────────────
  let totalDays   = 0;
  let presentDays = 0;
  let absentDays  = 0;

  if (await tableExists("attendance")) {
    const attColInfo  = await DB.query(`PRAGMA table_info(attendance)`, []);
    const attColNames = new Set(attColInfo.map((c) => c.name));
    console.log(
      "[ReportData] attendance columns:", [...attColNames].join(", ")
    );

    const attCols = await resolveColumns(
      "attendance",
      {
        studentCol: COL.STUDENT_ID,
        schoolCol:  COL.SCHOOL_ID,
        yearCol:    COL.ACADEMIC_YEAR,
      },
      ["schoolCol", "yearCol"]
    );

    let attSql    = `SELECT * FROM attendance WHERE ${attCols.studentCol} = ?`;
    const attPrms = [studentId];

    if (attColNames.has("term")) {
      attSql += ` AND term = ?`;
      attPrms.push(term);
    } else {
      console.warn(
        "[ReportData] attendance has no 'term' column — skipping term filter"
      );
    }

    if (attCols.schoolCol) {
      attSql += ` AND ${attCols.schoolCol} = ?`;
      attPrms.push(schoolId);
    }

    if (attCols.yearCol) {
      attSql += ` AND ${attCols.yearCol} = ?`;
      attPrms.push(academicYear);
    } else if (attColNames.has("academic_year")) {
      attSql += ` AND academic_year = ?`;
      attPrms.push(academicYear);
    } else if (attColNames.has("academicYear")) {
      attSql += ` AND academicYear = ?`;
      attPrms.push(academicYear);
    }

    const rows  = await DB.query(attSql, attPrms);
    totalDays   = rows.length;
    presentDays = rows.filter(
      (r) => r.status === "present" || r.status === "P"
    ).length;
    absentDays  = totalDays - presentDays;
    console.log("[ReportData] Attendance:", totalDays, "days");
  }

  // ── 8. Teacher assignments ─────────────────────────────
  const teacherBySubject = {};

  if (await tableExists("teacher_assignments") && classId) {
    try {
      const teacherColInfo  = await DB.query(
        `PRAGMA table_info(teachers)`, []
      );
      const teacherColNames = new Set(teacherColInfo.map((c) => c.name));
      console.log(
        "[ReportData] teachers columns:", [...teacherColNames].join(", ")
      );

      const teacherNameCol =
        teacherColNames.has("name")         ? "name"         :
        teacherColNames.has("full_name")    ? "full_name"    :
        teacherColNames.has("fullName")     ? "fullName"     :
        teacherColNames.has("teacher_name") ? "teacher_name" :
        teacherColNames.has("firstName")    ? "firstName"    :
        null;

      console.log(
        "[ReportData] Teacher name column:", teacherNameCol || "NOT FOUND"
      );

      const asnCols = await resolveColumns(
        "teacher_assignments",
        {
          classCol:   COL.CLASS_ID,
          subjectCol: COL.SUBJECT_ID,
          teacherCol: COL.TEACHER_ID,
          schoolCol:  COL.SCHOOL_ID,
        },
        ["schoolCol"]
      );

      let asnSql;
      const asnPrms = [classId];

      if (teacherNameCol) {
        asnSql = `
          SELECT ta.*, t.${teacherNameCol} AS teacher_name
          FROM teacher_assignments ta
          LEFT JOIN teachers t ON t.id = ta.${asnCols.teacherCol}
          WHERE ta.${asnCols.classCol} = ?`;
      } else {
        asnSql = `
          SELECT ta.*
          FROM teacher_assignments ta
          WHERE ta.${asnCols.classCol} = ?`;
      }

      if (asnCols.schoolCol) {
        asnSql += ` AND ta.${asnCols.schoolCol} = ?`;
        asnPrms.push(schoolId);
      }

      const asns = await DB.query(asnSql, asnPrms);
      for (const a of asns) {
        teacherBySubject[a[asnCols.subjectCol]] = a.teacher_name || "";
      }
      console.log("[ReportData] Teacher assignments:", asns.length);
    } catch (err) {
      console.warn("[ReportData] Teacher assignments failed:", err.message);
    }
  }

  // ── 9. Build subject rows ──────────────────────────────
  const subjectRows = subjectSource.map((sub) => {
    const localMark = marksBySubjectId[sub.id] || {};
    const apiSub    = apiSubjectMap[sub.id]    || {};

    const teacherName =
      teacherBySubject[sub.id] ||
      apiSub.teacherName       ||
      localMark.teacherName    ||
      "";

    if (apiSub.isAbsent) {
      return {
        subjectName: sub.name || apiSub.subjectName || "",
        caScore:     "-",
        examScore:   "-",
        total:       "-",
        grade:       "ABS",
        remark:      "Absent",
        teacherName,
        isAbsent:    true,
      };
    }

    if (apiSub.isExempt) {
      return {
        subjectName: sub.name || apiSub.subjectName || "",
        caScore:     "-",
        examScore:   "-",
        total:       "-",
        grade:       "EXM",
        remark:      "Exempt",
        teacherName,
        isExempt:    true,
      };
    }

    const caScore =
      localMark[marksCols?.caCol] ??
      localMark.caScore           ??
      localMark.ca_score          ??
      apiSub.caScore              ??
      null;

    const examScore =
      localMark[marksCols?.examCol] ??
      localMark.examScore           ??
      localMark.exam_score          ??
      apiSub.examScore              ??
      null;

    const apiScore =
      apiSub.score          != null ? apiSub.score          :
      apiSub.normalizedMark != null ? apiSub.normalizedMark :
      null;

    let total;
    if (caScore != null && examScore != null) {
      total = Number(caScore) + Number(examScore);
    } else if (apiScore != null) {
      total = Number(apiScore);
    } else {
      total = "-";
    }

    const grade =
      total !== "-"
        ? (apiSub.grade || computeGrade(total))
        : (localMark.grade || "-");

    const remark =
      total !== "-"
        ? computeRemark(typeof total === "number" ? total : Number(total))
        : "-";

    return {
      subjectName: sub.name || apiSub.subjectName || "",
      caScore:     caScore   != null ? Number(caScore)   : "-",
      examScore:   examScore != null ? Number(examScore) : "-",
      total,
      grade,
      remark,
      teacherName,
      percentage:  apiSub.percentage ?? null,
      gpaPoints:   apiSub.gpaPoints  ?? null,
      isPassing:   apiSub.isPassing  ?? null,
    };
  });

  // ── 10. Totals ─────────────────────────────────────────
  let overallTotal, overallAverage, overallGrade, overallRemark;
  let promotionStatus = "-";
  let gpa             = null;

  if (apiResult.summary) {
    const s       = apiResult.summary;
    overallTotal    = s.totalScore    ?? 0;
    overallAverage  = s.average       != null
      ? Number(s.average).toFixed(1)  : "-";
    overallGrade    = s.overallGrade  != null ? s.overallGrade  : "-";
    overallRemark   = s.overallRemark != null ? s.overallRemark : "-";
    promotionStatus = s.promotionStatus || "-";
    gpa             = s.gpa           ?? null;
    console.log(
      "[ReportData] API summary — avg:", overallAverage,
      "grade:", overallGrade
    );
  } else {
    const numericTotals = subjectRows
      .map((r) => r.total)
      .filter((t) => t !== "-" && !isNaN(Number(t)))
      .map(Number);

    overallTotal    = numericTotals.reduce((a, b) => a + b, 0);
    overallAverage  = numericTotals.length
      ? (overallTotal / numericTotals.length).toFixed(1)
      : "-";
    overallGrade    = overallAverage !== "-"
      ? computeGrade(Number(overallAverage))  : "-";
    overallRemark   = overallAverage !== "-"
      ? computeRemark(Number(overallAverage)) : "-";
  }

  // ── 11. Final payload ──────────────────────────────────
  const meta = apiResult.meta || {};

  const payload = {
    studentName:     student.name             || meta.studentName || "",
    studentId:       student.id               || "",
    admissionNumber: student.admissionNumber  ||
                     student.admission_number ||
                     student.admissionNo      || "",
    dateOfBirth:     student.dateOfBirth      ||
                     student.date_of_birth    || "",
    gender:          student.gender           || "",
    photoUrl:        student.photoBase64      ||
                     student.photo_url        ||
                     student.photoUrl         || "",

    className: classRow?.name || meta.className || "",
    classId:   classId        || "",

    schoolName:    school?.name     || "",
    schoolAddress: school?.address  || "",
    schoolPhone:   school?.phone    || "",
    schoolEmail:   school?.email    || "",
    schoolLogoUrl: school?.logo_url || "",
    schoolWebsite: school?.website  || "",
    schoolCity:    school?.city     || "",
    schoolState:   school?.state    || "",
    schoolCountry: school?.country  || "",
    schoolCode:    school?.code     || "",

    examName:     meta.examName     || "",
    term:         meta.term         || term,
    academicYear: meta.academicYear || academicYear,

    subjects: subjectRows,

    totalDays,
    presentDays,
    absentDays,
    attendancePercent: totalDays > 0
      ? ((presentDays / totalDays) * 100).toFixed(1)
      : "-",

    overallTotal,
    overallAverage,
    overallGrade,
    overallRemark,
    gpa,
    promotionStatus,

    classPosition:  apiResult.summary?.classPosition  ?? "-",
    gradePosition:  apiResult.summary?.gradePosition  ?? "-",
    schoolPosition: apiResult.summary?.schoolPosition ?? "-",
    totalInClass:   apiResult.summary?.totalInClass   ?? "-",
    totalInGrade:   apiResult.summary?.totalInGrade   ?? "-",
    totalInSchool:  apiResult.summary?.totalInSchool  ?? "-",
    subjectsPassed: apiResult.summary?.subjectsPassed ?? 0,
    subjectsFailed: apiResult.summary?.subjectsFailed ?? 0,

    generatedAt: new Date().toISOString(),
  };

  console.log(
    "[ReportData] ✅ Done —",
    "subjects:", subjectRows.length,
    "marks:", localMarks.length,
    "school:", payload.schoolName,
    "avg:", payload.overallAverage,
    "grade:", payload.overallGrade
  );

  return payload;
}

// ─────────────────────────────────────────────────────────
// GRADING HELPERS
// ─────────────────────────────────────────────────────────

function computeGrade(score) {
  if (score >= 75) return "A";
  if (score >= 65) return "B";
  if (score >= 55) return "C";
  if (score >= 45) return "D";
  if (score >= 40) return "E";
  return "F";
}

function computeRemark(score) {
  if (score >= 75) return "Excellent";
  if (score >= 65) return "Very Good";
  if (score >= 55) return "Good";
  if (score >= 45) return "Fair";
  if (score >= 40) return "Pass";
  return "Fail";
}