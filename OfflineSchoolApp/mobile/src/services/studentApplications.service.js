// src/services/studentApplications.service.js
// MINIMAL FIX based on confirmed backend logs:
//
// The backend only exposes /admin/students/pending — no separate
// applications collection exists. All previous chain endpoints 404.
//
// Changes vs last version:
//  1. PENDING_CHAIN reduced to ["/admin/students/pending"] only
//  2. APPROVE_CHAIN starts with /admin/students/:id/approve directly
//  3. REJECT_CHAIN  starts with /admin/students/:id/reject  directly
//  4. extractList now checks "students" key first (matches backend shape)
//  5. normaliseServerRecord handles the students-table field shape
//     (which is what /admin/students/pending returns)
//  6. Status filter: backend returns status="pending" so no need to
//     map "submitted"/"new" — but kept for safety
//
// Everything else (schema, enrollment, offline path, push, local query)
// is UNCHANGED from the previous version.

"use strict";

import NetInfo               from "@react-native-community/netinfo";
import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import {
  tableExists,
  getTableColumns,
  safeAddColumn,
}                            from "../db/dbHelpers";
import { getCurrentAuth }    from "../utils/authHelpers";
import { generateLocalId }   from "../utils/idHelpers";
import { fetchWithFallback } from "../utils/syncHelpers";
import { API }               from "./apiEndpoints";
import api                   from "./api";

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1 — SCHEMA  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const ensureSchema = (db) =>
  ensureTableSchema(
    "student_applications_view",
    async (_db) => {
      if (await tableExists(db, "students")) {
        const STUDENT_COLS = [
          ["status",           "TEXT DEFAULT 'pending'"],
          ["class_id",         "TEXT"],
          ["classId",          "TEXT"],
          ["school_id",        "TEXT"],
          ["schoolId",         "TEXT"],
          ["is_active",        "INTEGER DEFAULT 1"],
          ["approved_at",      "TEXT"],
          ["rejected_at",      "TEXT"],
          ["reviewed_at",      "TEXT"],
          ["rejection_reason", "TEXT"],
          ["user_id",          "TEXT"],
          ["updated_at",       "TEXT"],
          ["_synced",          "INTEGER DEFAULT 0"],
          ["name",             "TEXT"],
          ["firstName",        "TEXT"],
          ["lastName",         "TEXT"],
          ["guardianName",     "TEXT"],
          ["guardian_name",    "TEXT"],
          ["guardianPhone",    "TEXT"],
          ["guardian_phone",   "TEXT"],
          ["admissionNo",      "TEXT"],
          ["admissionNumber",  "TEXT"],
          ["enrollmentNo",     "TEXT"],
          ["enrollment_no",    "TEXT"],
        ];
        for (const [col, def] of STUDENT_COLS) {
          await safeAddColumn(db, "students", col, def);
        }
      }
      if (await tableExists(db, "users")) {
        const USER_COLS = [
          ["email",         "TEXT"],
          ["role",          "TEXT DEFAULT 'student'"],
          ["is_active",     "INTEGER DEFAULT 1"],
          ["updated_at",    "TEXT"],
          ["enrollmentNo",  "TEXT"],
          ["enrollment_no", "TEXT"],
          ["student_id",    "TEXT"],
        ];
        for (const [col, def] of USER_COLS) {
          await safeAddColumn(db, "users", col, def);
        }
      }
      if (await tableExists(db, "schools")) {
        await safeAddColumn(db, "schools", "code", "TEXT");
      }
      if (await tableExists(db, "classes")) {
        await safeAddColumn(db, "classes", "is_active", "INTEGER DEFAULT 1");
      }
      console.log("[studentApplications] Schema verified");
    },
    db
  );

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2 — GENERIC DB HELPERS  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const pickExisting = (columns, values, allowNull = true) => {
  const colSet  = new Set(columns);
  const payload = {};
  for (const [key, val] of Object.entries(values)) {
    if (!colSet.has(key))           continue;
    if (val === undefined)          continue;
    if (!allowNull && val === null) continue;
    payload[key] = val;
  }
  return payload;
};

const updateRecord = async (db, tableName, id, values, columns = null) => {
  const cols    = columns ?? await getTableColumns(db, tableName);
  const payload = pickExisting(cols, values);
  const keys    = Object.keys(payload);
  if (!keys.length) return true;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  await db.runAsync(
    `UPDATE ${tableName} SET ${setClause} WHERE id = ?`,
    [...keys.map((k) => payload[k]), id]
  );
  return true;
};

const insertRecord = async (db, tableName, values, columns = null) => {
  const cols    = columns ?? await getTableColumns(db, tableName);
  const payload = pickExisting(cols, values);
  const keys    = Object.keys(payload);
  if (!keys.length) {
    throw new Error(`[studentApplications] No valid columns for: ${tableName}`);
  }
  const placeholders = keys.map(() => "?").join(", ");
  return db.runAsync(
    `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`,
    keys.map((k) => payload[k])
  );
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3 — IDENTITY HELPERS  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const getStudentDisplayName = (s) => {
  const fromParts = [s.firstName, s.lastName].filter(Boolean).join(" ").trim();
  return fromParts || s.studentName || s.name || "Unnamed Student";
};

const getStudentEmail = (s) =>
  (s.email || s.studentEmail || s.parentEmail || "").trim().toLowerCase();

const resolveClassId = (raw) => {
  if (raw.classId)  return String(raw.classId);
  if (raw.class_id) return String(raw.class_id);
  if (raw.class) {
    if (typeof raw.class === "string") return raw.class;
    if (typeof raw.class === "object") {
      const id = raw.class._id || raw.class.id;
      if (id) return String(id);
    }
  }
  return null;
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4 — ENROLLMENT  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const resolveSchoolCode = async (db, schoolId) => {
  if (!schoolId) return "SCH";
  try {
    if (await tableExists(db, "schools")) {
      const cols   = await getTableColumns(db, "schools");
      const school = await db.getFirstAsync(
        `SELECT ${cols.includes("code") ? "code, id" : "id"}
         FROM schools WHERE id = ? LIMIT 1`,
        [schoolId]
      );
      if (school?.code) return school.code.trim().toUpperCase().slice(0, 5);
    }
  } catch (err) {
    console.warn("[studentApplications] resolveSchoolCode:", err.message);
  }
  return schoolId.replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() || "SCH";
};

const generateLocalEnrollmentNo = async (db, schoolCode, year) => {
  const prefix = `${schoolCode}-${year}-`;
  if (await tableExists(db, "students")) {
    try {
      const cols = await getTableColumns(db, "students");
      const col  = cols.includes("enrollmentNo") ? "enrollmentNo"
                 : cols.includes("enrollment_no") ? "enrollment_no" : null;
      if (col) {
        const row = await db.getFirstAsync(
          `SELECT ${col} AS enrollmentNo FROM students
           WHERE  ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`,
          [`${prefix}%`]
        );
        if (row?.enrollmentNo) {
          const parts  = row.enrollmentNo.split("-");
          const lastNo = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(lastNo)) {
            return `${prefix}${String(lastNo + 1).padStart(4, "0")}`;
          }
        }
      }
    } catch (err) {
      console.warn("[studentApplications] generateLocalEnrollmentNo:", err.message);
    }
  }
  return `${prefix}${String(Date.now() % 9000 + 1000).padStart(4, "0")}`;
};

const requestServerEnrollmentNo = async (studentId, schoolId) => {
  try {
    const endpoint =
      typeof API?.admin?.students?.generateEnrollmentNo === "function"
        ? API.admin.students.generateEnrollmentNo(studentId)
        : `/admin/students/${studentId}/enrollment-number`;
    const res = await api.post(endpoint, { schoolId }, { timeout: 10_000 });
    const no  =
      res.data?.enrollmentNo       ||
      res.data?.enrollment_no      ||
      res.data?.data?.enrollmentNo ||
      null;
    return no ? String(no).toUpperCase().trim() : null;
  } catch (err) {
    console.warn("[studentApplications] requestServerEnrollmentNo:", err.message);
    return null;
  }
};

const resolveEnrollmentNo = async (db, student, userId = null, isOnline = false) => {
  const existing =
    student.enrollmentNo || student.enrollment_no ||
    student.admissionNo  || student.admissionNumber;
  if (existing) return String(existing).toUpperCase().trim();

  const schoolId =
    student.schoolId || student.school_id || getCurrentAuth().schoolId || "";

  let enrollmentNo = isOnline
    ? await requestServerEnrollmentNo(student.id, schoolId)
    : null;

  if (!enrollmentNo) {
    const code = await resolveSchoolCode(db, schoolId);
    enrollmentNo = await generateLocalEnrollmentNo(db, code, new Date().getFullYear());
  }

  try {
    const cols = await getTableColumns(db, "students");
    await updateRecord(db, "students", student.id, {
      enrollmentNo, enrollment_no: enrollmentNo,
      admissionNo: enrollmentNo, admissionNumber: enrollmentNo,
    }, cols);
  } catch (err) {
    console.warn("[studentApplications] write enrollmentNo:", err.message);
  }

  if (userId && await tableExists(db, "users")) {
    try {
      const cols = await getTableColumns(db, "users");
      await updateRecord(db, "users", userId, {
        enrollmentNo, enrollment_no: enrollmentNo,
      }, cols);
    } catch (err) {
      console.warn("[studentApplications] mirror enrollmentNo to users:", err.message);
    }
  }

  return enrollmentNo;
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5 — DOCUMENT HELPERS  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const normalizeDocument = (doc, index = 0) => {
  if (!doc) return null;
  if (typeof doc === "string") {
    return {
      id: `doc-${index}`, title: `Document ${index + 1}`,
      uri: doc, type: "document",
    };
  }
  return {
    ...doc,
    id:    doc.id    || `doc-${index}`,
    title: doc.title || doc.name || doc.fileName || `Document ${index + 1}`,
    uri:   doc.uri   || doc.url  || doc.fileUrl  || doc.path || null,
    type:  doc.type  || doc.mimeType || "document",
  };
};

const parseInlineDocuments = (s) => {
  const raw = s.documents || s.document || s.docs || s.documentUri || s.documentUrl;
  if (!raw) return [];
  if (Array.isArray(raw))      return raw.map(normalizeDocument).filter(Boolean);
  if (typeof raw === "object") return [normalizeDocument(raw, 0)].filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map(normalizeDocument).filter(Boolean)
        : [normalizeDocument(parsed, 0)].filter(Boolean);
    } catch {
      return [normalizeDocument(raw, 0)].filter(Boolean);
    }
  }
  return [];
};

const getStudentDocuments = async (db, student) => {
  const docs = [...parseInlineDocuments(student)];
  if (await tableExists(db, "student_documents")) {
    const cols = await getTableColumns(db, "student_documents");
    if (cols.includes("student_id")) {
      try {
        const orderBy = cols.includes("created_at") ? "created_at DESC" : "id DESC";
        const rows = await db.getAllAsync(
          `SELECT * FROM student_documents
           WHERE student_id = ? ORDER BY ${orderBy}`,
          [student.id]
        );
        (rows ?? []).forEach((row, i) =>
          docs.push(normalizeDocument(row, docs.length + i))
        );
      } catch (err) {
        console.warn("[studentApplications] load student_documents:", err.message);
      }
    }
  }
  return docs;
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6 — NORMALISE
// Handles the /admin/students/pending response shape confirmed by logs.
// ═══════════════════════════════════════════════════════════════════════

const normaliseServerRecord = (raw) => {
  if (!raw) return null;
  const id = String(raw._id || raw.id || "").trim();
  if (!id) return null;

  // /admin/students/pending returns students-table records:
  // firstName + lastName (or name/studentName), email, class object or classId
  const fromParts = [raw.firstName, raw.lastName].filter(Boolean).join(" ").trim();
  const name =
    fromParts        ||
    raw.studentName  ||
    raw.student_name ||
    raw.name         ||
    "Unknown Applicant";

  const email = (
    raw.email        ||
    raw.studentEmail ||
    raw.parentEmail  ||
    raw.parent_email ||
    ""
  ).trim().toLowerCase();

  const phone =
    raw.phone         || raw.phoneNumber   || raw.phone_number ||
    raw.parentPhone   || raw.guardianPhone || raw.guardian_phone || "";

  const guardianName =
    raw.guardianName  || raw.guardian_name ||
    raw.parentName    || raw.parent_name   || "";

  const classId   = resolveClassId(raw);
  const className =
    raw.className    || raw.class_name    ||
    raw.appliedClass || raw.applied_class ||
    raw.grade        ||
    (raw.class && typeof raw.class === "object" ? raw.class?.name : null) ||
    "";

  const admissionNo  = raw.admissionNo || raw.admissionNumber || raw.admNo || null;
  const enrollmentNo = raw.enrollmentNo || raw.enrollment_no  || admissionNo || null;

  // Normalise status — backend sends "pending" but handle variants for safety
  const rawStatus = (raw.status || "pending").toLowerCase();
  const status =
    rawStatus === "submitted" || rawStatus === "new" || rawStatus === "received"
      ? "pending"
      : rawStatus;

  return {
    id, name, email, phone,
    guardianName,
    guardian_name:   guardianName,
    guardianPhone:   raw.guardianPhone  || raw.guardian_phone || raw.parentPhone || "",
    guardian_phone:  raw.guardianPhone  || raw.guardian_phone || raw.parentPhone || "",
    firstName:       raw.firstName      || null,
    lastName:        raw.lastName       || null,
    className, classId,
    class_id:        classId,
    status,
    created_at:      raw.createdAt      || raw.created_at     || null,
    updated_at:      raw.updatedAt      || raw.updated_at     || null,
    documents:       Array.isArray(raw.documents) ? raw.documents : [],
    address:         raw.address        || raw.homeAddress    || "",
    notes:           raw.notes          || "",
    schoolId:        raw.schoolId       || null,
    school_id:       raw.schoolId       || null,
    enrollmentNo,
    enrollment_no:   enrollmentNo,
    admissionNo:     admissionNo        || enrollmentNo,
    admissionNumber: raw.admissionNumber || admissionNo       || enrollmentNo,
  };
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 7 — SERVER FETCH
// Confirmed working endpoint: /admin/students/pending
// No chain needed — backend has exactly one endpoint for this.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extracts an array from the /admin/students/pending response.
 * Backend returns: { success, students: [...], total, ... }
 */
const extractList = (data) => {
  if (!data) return null;
  if (Array.isArray(data)) return data;
  // "students" first — that's what /admin/students/pending returns (confirmed)
  return (
    data.students     ||
    data.applications ||
    data.data         ||
    data.items        ||
    data.results      ||
    null
  );
};

/**
 * Fetches from the confirmed working endpoint.
 * Returns { data, normalized, count } — the shape fetchWithFallback expects.
 */
const fetchFromServer = async (schoolId) => {
  // Confirmed working by logs — no chain needed
  const endpoint = API.admin.students.pending; // "/admin/students/pending"

  const response = await api.get(endpoint, {
    params:  schoolId ? { schoolId } : undefined,
    timeout: 15_000,
  });

  const raw = extractList(response.data);

  if (!Array.isArray(raw)) {
    throw new Error(
      `[studentApplications] ${endpoint} returned non-array: ` +
      typeof raw
    );
  }

  console.log(
    `[studentApplications] ✅ ${endpoint} → ${raw.length} record(s)`
  );

  const normalized = raw
    .map(normaliseServerRecord)
    .filter(Boolean)
    .filter((r) => r.status === "pending");

  // fetchWithFallback reads result.normalized — MUST return this shape
  return {
    data:       raw,
    normalized,
    count:      normalized.length,
  };
};

// ── Approve: confirmed endpoint from apiEndpoints.js ─────────────────────────
// /admin/students/:id/approve  — no chain needed, this is what works
const approveOnServer = async (studentId, classId) => {
  const response = await api.put(
    API.admin.students.approve(studentId),
    { classId }
  );
  console.log(`[studentApplications] ✅ Approved: ${studentId}`);
  return response;
};

// ── Reject: confirmed endpoint ────────────────────────────────────────────────
const rejectOnServer = async (studentId, reason) => {
  const response = await api.put(
    API.admin.students.reject(studentId),
    { reason: reason?.trim() || "" }
  );
  console.log(`[studentApplications] ✅ Rejected: ${studentId}`);
  return response;
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 8 — USER ACCOUNT HELPER  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const ensureStudentUser = async (db, student) => {
  if (!(await tableExists(db, "users"))) {
    throw new Error("[studentApplications] Users table does not exist");
  }
  const userCols = await getTableColumns(db, "users");
  const name     = getStudentDisplayName(student);
  const email    = getStudentEmail(student);
  const ts       = new Date().toISOString();

  let existing = null;
  if (userCols.includes("student_id")) {
    existing = await db.getFirstAsync(
      `SELECT * FROM users WHERE student_id = ? LIMIT 1`, [student.id]
    ).catch(() => null);
  }
  if (!existing && email && userCols.includes("email")) {
    existing = await db.getFirstAsync(
      `SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`, [email]
    ).catch(() => null);
  }

  if (existing) {
    if (existing.role && existing.role !== "student") {
      throw new Error("A non-student account already exists with this email");
    }
    await updateRecord(db, "users", existing.id, {
      name, role: "student", is_active: 1, updated_at: ts, student_id: student.id,
    }, userCols);
    return existing.id;
  }

  const newId = generateLocalId();
  await insertRecord(db, "users", {
    id: newId, name, email: email || null, role: "student",
    is_active: 1, password: "", student_id: student.id,
    created_at: ts, updated_at: ts,
  }, userCols);
  return newId;
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 9 — LOCAL QUERY  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const getLocalPending = async (db, schoolId) => {
  if (!(await tableExists(db, "students"))) return [];

  const studentCols = await getTableColumns(db, "students");
  if (!studentCols.includes("status")) {
    console.warn("[studentApplications] students table has no status column");
    return [];
  }

  const hasClasses  = await tableExists(db, "classes");
  const classColKey = studentCols.includes("class_id") ? "class_id" : "classId";
  const hasClassCol = studentCols.includes("class_id") || studentCols.includes("classId");
  const canJoin     = hasClassCol && hasClasses;

  const orderBy = studentCols.includes("created_at")
    ? "datetime(s.created_at) DESC" : "s.id DESC";

  const params = [];
  let   where  = "LOWER(s.status) = 'pending'";

  if (schoolId) {
    const sCol = studentCols.includes("school_id") ? "school_id" : "schoolId";
    if (studentCols.includes("school_id") || studentCols.includes("schoolId")) {
      where += ` AND (s.${sCol} = ? OR s.${sCol} IS NULL OR s.${sCol} = '')`;
      params.push(schoolId);
    }
  }

  const rows = await db.getAllAsync(
    `SELECT s.*
       ${canJoin ? ", c.name AS cls_name" : ""}
     FROM students s
     ${canJoin ? `LEFT JOIN classes c ON c.id = s.${classColKey}` : ""}
     WHERE ${where}
     ORDER BY ${orderBy}`,
    params
  ).catch(() => []);

  return Promise.all(
    (rows ?? []).map(async (student) => ({
      ...student,
      id:           String(student.id),
      name:         getStudentDisplayName(student),
      email:        getStudentEmail(student),
      enrollmentNo: student.enrollmentNo || student.enrollment_no || null,
      className:
        student.cls_name           ||
        student.class_name         ||
        student.applied_class_name ||
        student.class_applied      ||
        "No class selected",
      documents: await getStudentDocuments(db, student),
    }))
  );
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 10 — MARK LOCAL DECISION  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const markLocalDecision = async (
  db, studentId, status, classId, synced, reason = null
) => {
  try {
    if (!(await tableExists(db, "students"))) return;
    const cols = await getTableColumns(db, "students");
    const ts   = new Date().toISOString();
    const vals = { status, updated_at: ts, _synced: synced ? 1 : 0 };

    if (status === "approved") {
      vals.approved_at = ts; vals.reviewed_at = ts; vals.is_active = 1;
      if (classId) { vals.class_id = classId; vals.classId = classId; }
    }
    if (status === "rejected") {
      vals.rejected_at = ts; vals.reviewed_at = ts; vals.is_active = 0;
      vals.rejection_reason = reason?.trim() || null;
    }

    await updateRecord(db, "students", studentId, vals, cols);
  } catch (err) {
    console.warn("[studentApplications] markLocalDecision:", err.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 11 — CACHE SERVER RECORDS LOCALLY  (unchanged)
// ═══════════════════════════════════════════════════════════════════════

const cacheApplicationsLocally = async (db, records, schoolId) => {
  if (!(await tableExists(db, "students"))) return 0;
  const cols = await getTableColumns(db, "students");
  const ts   = new Date().toISOString();
  let synced = 0;

  for (const app of records) {
    if (!app.id) continue;

    const local = await db.getFirstAsync(
      `SELECT status FROM students WHERE id = ? LIMIT 1`, [app.id]
    ).catch(() => null);

    if (local && local.status !== "pending") continue;

    const candidate = {
      id:              app.id,
      name:            app.name            || null,
      firstName:       app.firstName       || null,
      lastName:        app.lastName        || null,
      email:           app.email           || null,
      phone:           app.phone           || null,
      address:         app.address         || null,
      guardianName:    app.guardianName    || null,
      guardian_name:   app.guardianName    || null,
      guardianPhone:   app.guardianPhone   || null,
      guardian_phone:  app.guardianPhone   || null,
      status:          "pending",
      class_id:        app.classId         || null,
      classId:         app.classId         || null,
      school_id:       app.schoolId        || null,
      schoolId:        app.schoolId        || schoolId || null,
      enrollmentNo:    app.enrollmentNo    || null,
      enrollment_no:   app.enrollmentNo    || null,
      admissionNo:     app.admissionNo     || null,
      admissionNumber: app.admissionNumber || null,
      is_active:       1,
      _synced:         1,
      created_at:      app.created_at      || ts,
      updated_at:      app.updated_at      || ts,
    };

    const payload = pickExisting(cols, candidate);
    const keys    = Object.keys(payload);
    if (!keys.length) continue;

    const placeholders = keys.map(() => "?").join(", ");
    const updateSet    = keys
      .filter((k) => k !== "id")
      .map((k) => `${k} = excluded.${k}`)
      .join(", ");

    await db.runAsync(
      `INSERT INTO students (${keys.join(", ")})
       VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateSet}`,
      keys.map((k) => payload[k])
    ).catch((err) => {
      console.warn(
        `[studentApplications] cache failed for ${app.id}:`, err.message
      );
    });

    synced++;
  }

  console.log(`[studentApplications] Cached ${synced} application(s) locally`);
  return synced;
};

// ═══════════════════════════════════════════════════════════════════════
// SECTION 12 — PUBLIC SERVICE
// ═══════════════════════════════════════════════════════════════════════

export const StudentApplicationsService = {

  // ── getPendingApplications ────────────────────────────────────────────

  async getPendingApplications() {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    return fetchWithFallback({
      label: "pending-applications",

      serverFetch: async () => {
        // fetchFromServer returns { data, normalized, count }
        // which is exactly what fetchWithFallback expects
        return fetchFromServer(schoolId);
      },

      persistLocal: async (rawArray) => {
        if (!Array.isArray(rawArray) || rawArray.length === 0) return;
        const normalised = rawArray
          .map(normaliseServerRecord)
          .filter(Boolean)
          .filter((r) => r.status === "pending");
        await cacheApplicationsLocally(db, normalised, schoolId);
      },

      localFetch: () => getLocalPending(db, schoolId),
    });
  },

  // ── getById  (unchanged) ──────────────────────────────────────────────

  async getById(id) {
    const db = await getDatabase();
    await ensureSchema(db);

    let isOnline = false;
    try {
      const net = await NetInfo.fetch();
      isOnline  = Boolean(net.isConnected);
    } catch { /* offline */ }

    if (isOnline) {
      try {
        const res = await api.get(API.admin.students.detail(id));
        const raw = res.data?.student || res.data;
        if (raw) return normaliseServerRecord(raw);
      } catch (err) {
        if (err?.response?.status !== 404) {
          console.warn("[studentApplications] getById server:", err.message);
        }
      }
    }

    if (!(await tableExists(db, "students"))) return null;

    const studentCols = await getTableColumns(db, "students");
    const classColKey = studentCols.includes("class_id") ? "class_id" : "classId";
    const hasClasses  = await tableExists(db, "classes");
    const hasClassCol = studentCols.includes("class_id") || studentCols.includes("classId");
    const canJoin     = hasClassCol && hasClasses;

    const student = await db.getFirstAsync(
      `SELECT s.*
         ${canJoin ? ", c.name AS cls_name" : ""}
       FROM students s
       ${canJoin ? `LEFT JOIN classes c ON c.id = s.${classColKey}` : ""}
       WHERE s.id = ? LIMIT 1`,
      [id]
    ).catch(() => null);

    if (!student) return null;
    return {
      ...student,
      name:         getStudentDisplayName(student),
      email:        getStudentEmail(student),
      enrollmentNo: student.enrollmentNo || student.enrollment_no || null,
      className:    student.cls_name || student.class_name || "No class selected",
      documents:    await getStudentDocuments(db, student),
    };
  },

  // ── approveApplication ────────────────────────────────────────────────

  async approveApplication(studentId, classId) {
    if (!studentId) throw new Error("Student application ID is required");
    if (!classId)   throw new Error("Please select a class before approving");

    const db = await getDatabase();
    await ensureSchema(db);

    let isOnline = false;
    try {
      const net = await NetInfo.fetch();
      isOnline  = Boolean(net.isConnected);
    } catch { /* offline */ }

    if (isOnline) {
      try {
        const response = await approveOnServer(studentId, classId);
        const result   = response.data ?? {};

        const serverEnrollmentNo =
          result.enrollmentNo          ||
          result.enrollment_no         ||
          result.student?.enrollmentNo ||
          null;

        await markLocalDecision(db, studentId, "approved", classId, true);

        if (serverEnrollmentNo) {
          const fresh = await db.getFirstAsync(
            `SELECT * FROM students WHERE id = ? LIMIT 1`, [studentId]
          ).catch(() => null);
          if (fresh) {
            await resolveEnrollmentNo(db, fresh, result.userId || null, true);
          }
        }

        return {
          success:      true,
          synced:       true,
          emailSent:    result.emailSent    ?? false,
          tempPassword: result.tempPassword ?? null,
          warning:      result.warning      ?? null,
          userId:       result.userId       ?? null,
          enrollmentNo: serverEnrollmentNo  ?? null,
        };
      } catch (err) {
        const status  = err?.response?.status;
        const message = err?.response?.data?.message || err.message;

        if (status === 409) {
          await markLocalDecision(db, studentId, "approved", classId, true);
          return {
            success: true, synced: true, emailSent: false,
            tempPassword: null, warning: null, userId: null, enrollmentNo: null,
          };
        }
        if (status === 400) throw new Error(message || "Invalid class selection");

        // Other errors → offline path
        console.warn("[studentApplications] approveOnServer failed:", message);
        isOnline = false;
      }
    }

    // ── Offline ──────────────────────────────────────────────────────────
    if (!(await tableExists(db, "students"))) {
      throw new Error("Students table does not exist");
    }
    const student = await db.getFirstAsync(
      `SELECT * FROM students WHERE id = ? LIMIT 1`, [studentId]
    );
    if (!student) throw new Error("Student application not found");
    if (student.status && student.status !== "pending") {
      throw new Error("Only pending applications can be approved");
    }

    if (await tableExists(db, "classes")) {
      const cls = await db.getFirstAsync(
        `SELECT id, is_active FROM classes WHERE id = ? LIMIT 1`, [classId]
      );
      if (!cls)                        throw new Error("Selected class does not exist");
      if (Number(cls.is_active) === 0) throw new Error("Cannot assign to inactive class");
    }

    const localUserId = await ensureStudentUser(db, student);
    await markLocalDecision(db, studentId, "approved", classId, false);

    const cols = await getTableColumns(db, "students");
    if (cols.includes("user_id")) {
      await updateRecord(db, "students", studentId, { user_id: localUserId }, cols);
    }

    const fresh = await db.getFirstAsync(
      `SELECT * FROM students WHERE id = ? LIMIT 1`, [studentId]
    ).catch(() => student);

    const enrollmentNo = await resolveEnrollmentNo(db, fresh, localUserId, false);

    return {
      success:      true,
      synced:       false,
      emailSent:    false,
      tempPassword: enrollmentNo,
      warning:      "Approved offline — will sync when connection is restored",
      userId:       localUserId,
      enrollmentNo,
    };
  },

  // ── rejectApplication ─────────────────────────────────────────────────

  async rejectApplication(studentId, reason = "") {
    if (!studentId) throw new Error("Student application ID is required");

    const db = await getDatabase();
    await ensureSchema(db);

    let isOnline = false;
    try {
      const net = await NetInfo.fetch();
      isOnline  = Boolean(net.isConnected);
    } catch { /* offline */ }

    if (isOnline) {
      try {
        await rejectOnServer(studentId, reason);
        await markLocalDecision(db, studentId, "rejected", null, true, reason);
        return { success: true, synced: true };
      } catch (err) {
        const status  = err?.response?.status;
        const message = err?.response?.data?.message || err.message;

        if (status === 409) {
          await markLocalDecision(db, studentId, "rejected", null, true, reason);
          return { success: true, synced: true };
        }
        console.warn("[studentApplications] rejectOnServer failed:", message);
        // fall through to offline
      }
    }

    if (!(await tableExists(db, "students"))) {
      throw new Error("Students table does not exist");
    }
    const student = await db.getFirstAsync(
      `SELECT status FROM students WHERE id = ? LIMIT 1`, [studentId]
    );
    if (!student) throw new Error("Student application not found");
    if (student.status && student.status !== "pending") {
      throw new Error("Only pending applications can be rejected");
    }

    await markLocalDecision(db, studentId, "rejected", null, false, reason);
    return { success: true, synced: false };
  },

  // ── pullPendingApplications ───────────────────────────────────────────

  async pullPendingApplications() {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    let isOnline = false;
    try {
      const net = await NetInfo.fetch();
      isOnline  = Boolean(net.isConnected);
    } catch { /* offline */ }

    if (!isOnline) {
      console.log("[studentApplications] Offline — skipping pull");
      return 0;
    }

    try {
      const result = await fetchFromServer(schoolId);
      if (!result || result.normalized.length === 0) {
        console.log("[studentApplications] No applications to pull");
        return 0;
      }
      return cacheApplicationsLocally(db, result.normalized, schoolId);
    } catch (err) {
      console.warn("[studentApplications] pullPendingApplications:", err.message);
      return 0;
    }
  },

  // ── pushPendingDecisions ──────────────────────────────────────────────

  async pushPendingDecisions() {
    const db = await getDatabase();
    await ensureSchema(db);

    let isOnline = false;
    try {
      const net = await NetInfo.fetch();
      isOnline  = Boolean(net.isConnected);
    } catch { /* offline */ }

    if (!isOnline) {
      console.log("[studentApplications] Offline — skipping push");
      return;
    }

    if (!(await tableExists(db, "students"))) return;

    const cols = await getTableColumns(db, "students");
    if (!cols.includes("_synced")) {
      await safeAddColumn(db, "students", "_synced", "INTEGER DEFAULT 0");
    }

    const dirty = await db.getAllAsync(
      `SELECT * FROM students
       WHERE  (_synced = 0 OR _synced IS NULL)
         AND  status IN ('approved', 'rejected')
       LIMIT  50`
    ).catch(() => []);

    if (!dirty?.length) {
      console.log("[studentApplications] No unsynced decisions to push");
      return;
    }

    const ts = new Date().toISOString();

    for (const student of dirty) {
      try {
        let serverEnrollmentNo = null;

        if (student.status === "approved") {
          const classId = student.class_id || student.classId || null;
          if (!classId) {
            console.warn(
              `[studentApplications] Skipping ${student.id} — no classId`
            );
            continue;
          }
          const response = await approveOnServer(student.id, classId);
          serverEnrollmentNo =
            response.data?.enrollmentNo          ||
            response.data?.enrollment_no         ||
            response.data?.student?.enrollmentNo ||
            null;

        } else if (student.status === "rejected") {
          await rejectOnServer(student.id, student.rejection_reason || "");
        }

        await db.runAsync(
          `UPDATE students SET _synced = 1, updated_at = ? WHERE id = ?`,
          [ts, student.id]
        );

        if (serverEnrollmentNo) {
          await db.runAsync(
            `UPDATE students
             SET enrollmentNo = ?, enrollment_no = ?,
                 admissionNo  = ?, admissionNumber = ?, updated_at = ?
             WHERE id = ?`,
            [
              serverEnrollmentNo, serverEnrollmentNo,
              serverEnrollmentNo, serverEnrollmentNo,
              ts, student.id,
            ]
          );

          if (await tableExists(db, "users")) {
            const userCols = await getTableColumns(db, "users");
            let userRow = null;

            if (userCols.includes("student_id")) {
              userRow = await db.getFirstAsync(
                `SELECT id FROM users WHERE student_id = ? LIMIT 1`,
                [student.id]
              ).catch(() => null);
            }
            if (!userRow && student.user_id) {
              userRow = await db.getFirstAsync(
                `SELECT id FROM users WHERE id = ? LIMIT 1`,
                [student.user_id]
              ).catch(() => null);
            }
            if (userRow) {
              await updateRecord(db, "users", userRow.id, {
                enrollmentNo:  serverEnrollmentNo,
                enrollment_no: serverEnrollmentNo,
              }, userCols);
            }
          }
        }

        console.log(
          `[studentApplications] Synced: ${student.id} (${student.status})`
        );
      } catch (err) {
        const status = err?.response?.status;
        if (status === 409 || status === 404) {
          await db.runAsync(
            `UPDATE students SET _synced = 1 WHERE id = ?`, [student.id]
          );
        } else {
          console.warn(
            `[studentApplications] Push failed for ${student.id}:`,
            err.message
          );
        }
      }
    }
  },

  // ── getEnrollmentNo  (unchanged) ──────────────────────────────────────

  async getEnrollmentNo(studentId) {
    const db = await getDatabase();
    if (!(await tableExists(db, "students"))) return null;
    const row = await db.getFirstAsync(
      `SELECT enrollmentNo, enrollment_no, admissionNo
       FROM   students WHERE id = ? LIMIT 1`,
      [studentId]
    ).catch(() => null);
    return row?.enrollmentNo || row?.enrollment_no || row?.admissionNo || null;
  },
};

export default StudentApplicationsService;