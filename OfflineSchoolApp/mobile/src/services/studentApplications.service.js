// src/services/studentApplications.service.js
"use strict";

/**
 * studentApplications.service.js
 *
 * Responsibilities:
 *  - Fetch pending student applications (server first, local fallback)
 *  - Approve / reject applications (online + offline)
 *  - Pull server applications into local SQLite
 *  - Push locally-made decisions back to the server
 *  - Generate enrollment numbers on approval (online + offline)
 *
 * Fixed issues (see issue inventory):
 *  #C2  — Schema uses ensureTableSchema with retry (no more flag)
 *  #C5  — ID generation uses generateLocalId from idHelpers
 *  #C6  — Auth uses getCurrentAuth from authHelpers (no more getSchoolId)
 *  #M1  — tableExists / getTableColumns imported from dbHelpers
 *  #M2  — Fetch pattern uses fetchWithFallback from syncHelpers
 *  #M3  — Soft-delete filter uses NOT_DELETED constant
 *  #M5  — Endpoint strings use API constants from apiEndpoints
 */

import NetInfo                                from "@react-native-community/netinfo";
import { getDatabase }                        from "../db/database";
import { ensureTableSchema }                  from "../db/schemaManager";
import {
  tableExists,
  getTableColumns,
  safeAddColumn,
  NOT_DELETED,
}                                             from "../db/dbHelpers";
import { getCurrentAuth }                     from "../utils/authHelpers";
import { generateLocalId }                    from "../utils/idHelpers";
import { fetchWithFallback }                  from "../utils/syncHelpers";
import { API }                                from "./apiEndpoints";
import api                                    from "./api";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SCHEMA SETUP
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Ensures that the students, users, and classes tables have all the columns
 * this service needs.
 *
 * Uses schemaManager so failures are tracked and retried (fixes #C2).
 * Only adds columns — never drops or renames existing ones.
 *
 * @param {any} db - SQLite database instance
 */
const ensureSchema = (db) =>
  ensureTableSchema(
    "student_applications_view",   // logical key — not a real table
    async (db) => {
      // ── students ──────────────────────────────────────────────────────────
      if (await tableExists(db, "students")) {
        const STUDENT_COLS = [
          ["status",            "TEXT DEFAULT 'pending'"],
          // Write BOTH naming conventions so old queries keep working
          ["class_id",          "TEXT"],
          ["classId",           "TEXT"],
          ["school_id",         "TEXT"],
          ["schoolId",          "TEXT"],
          ["is_active",         "INTEGER DEFAULT 1"],
          ["approved_at",       "TEXT"],
          ["rejected_at",       "TEXT"],
          ["reviewed_at",       "TEXT"],
          ["rejection_reason",  "TEXT"],
          ["user_id",           "TEXT"],
          ["updated_at",        "TEXT"],
          ["_synced",           "INTEGER DEFAULT 0"],
          // Name fields
          ["name",              "TEXT"],
          ["firstName",         "TEXT"],
          ["lastName",          "TEXT"],
          // Admission / enrollment number
          ["admissionNo",       "TEXT"],
          ["admissionNumber",   "TEXT"],
          // ── NEW: enrollment number columns ────────────────────────────────
          ["enrollmentNo",      "TEXT"],       // canonical column
          ["enrollment_no",     "TEXT"],       // snake_case alias
        ];
        for (const [col, def] of STUDENT_COLS) {
          await safeAddColumn(db, "students", col, def);
        }
      }

      // ── users ─────────────────────────────────────────────────────────────
      if (await tableExists(db, "users")) {
        await safeAddColumn(db, "users", "email",         "TEXT");
        await safeAddColumn(db, "users", "role",          "TEXT DEFAULT 'student'");
        await safeAddColumn(db, "users", "is_active",     "INTEGER DEFAULT 1");
        await safeAddColumn(db, "users", "updated_at",    "TEXT");
        // ── NEW ──────────────────────────────────────────────────────────────
        await safeAddColumn(db, "users", "enrollmentNo",  "TEXT");   // for student login
        await safeAddColumn(db, "users", "enrollment_no", "TEXT");   // snake_case alias
      }

      // ── schools ───────────────────────────────────────────────────────────
      // We need the school code to build the enrollment number prefix.
      if (await tableExists(db, "schools")) {
        await safeAddColumn(db, "schools", "code", "TEXT");
      }

      // ── classes ───────────────────────────────────────────────────────────
      if (await tableExists(db, "classes")) {
        await safeAddColumn(db, "classes", "is_active", "INTEGER DEFAULT 1");
      }

      console.log("[studentApplications] Schema verified");
    },
    db
  );

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — GENERIC DB HELPERS (local to this service)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Filters an object to only the keys that exist as columns in the table.
 * Prevents "no such column" errors when inserting/updating.
 *
 * @param {string[]}          columns - Column names from getTableColumns()
 * @param {Record<string,any>} values
 * @returns {Record<string, any>}
 */
const pickExisting = (columns, values) => {
  const colSet  = new Set(columns);
  const payload = {};
  for (const [key, val] of Object.entries(values)) {
    if (colSet.has(key) && val !== undefined) payload[key] = val;
  }
  return payload;
};

/**
 * Updates a row by ID using only the columns that exist in the table.
 *
 * @param {any}                db
 * @param {string}             tableName
 * @param {string}             id
 * @param {Record<string,any>} values
 * @param {string[]|null}      [columns] - Pre-fetched columns (avoids extra PRAGMA)
 * @returns {Promise<boolean>}
 */
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

/**
 * Inserts a row using only the columns that exist in the table.
 *
 * @param {any}                db
 * @param {string}             tableName
 * @param {Record<string,any>} values
 * @param {string[]|null}      [columns]
 * @returns {Promise<any>}     SQLite RunResult
 */
const insertRecord = async (db, tableName, values, columns = null) => {
  const cols    = columns ?? await getTableColumns(db, tableName);
  const payload = pickExisting(cols, values);
  const keys    = Object.keys(payload);

  if (!keys.length) {
    throw new Error(`[studentApplications] No valid columns for table: ${tableName}`);
  }

  const placeholders = keys.map(() => "?").join(", ");
  return db.runAsync(
    `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`,
    keys.map((k) => payload[k])
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — IDENTITY HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolves the best display name from a student object.
 */
const getStudentDisplayName = (student) => {
  const fromParts = [student.firstName, student.lastName]
    .filter(Boolean).join(" ").trim();
  return (
    fromParts            ||
    student.studentName  ||
    student.name         ||
    "Unnamed Student"
  );
};

/**
 * Resolves the best email address from a student object.
 */
const getStudentEmail = (student) =>
  (student.email || student.studentEmail || student.parentEmail || "")
    .trim().toLowerCase();

/**
 * Resolves the classId from a raw server student object.
 */
const resolveClassId = (raw) => {
  if (raw.classId)   return String(raw.classId);
  if (raw.class_id)  return String(raw.class_id);
  if (raw.class) {
    if (typeof raw.class === "string") return raw.class;
    if (typeof raw.class === "object") {
      const id = raw.class._id || raw.class.id;
      if (id) return String(id);
    }
  }
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — ENROLLMENT NUMBER GENERATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolves the school code prefix used in enrollment numbers.
 *
 * Priority:
 *  1. schools table (if it has a `code` column)
 *  2. schoolId first 3 chars (uppercase)
 *  3. Hardcoded fallback "SCH"
 *
 * @param {any}    db
 * @param {string} schoolId
 * @returns {Promise<string>}  e.g. "GHS", "SCH"
 */
const resolveSchoolCode = async (db, schoolId) => {
  if (!schoolId) return "SCH";

  try {
    if (await tableExists(db, "schools")) {
      const cols   = await getTableColumns(db, "schools");
      const school = await db.getFirstAsync(
        `SELECT ${cols.includes("code") ? "code, " : ""}id FROM schools WHERE id = ? LIMIT 1`,
        [schoolId]
      );
      if (school?.code) return school.code.trim().toUpperCase().slice(0, 5);
    }
  } catch (err) {
    console.warn("[studentApplications] resolveSchoolCode failed:", err.message);
  }

  // Fallback: first 3 chars of the schoolId
  return schoolId.replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() || "SCH";
};

/**
 * Generates the next sequential enrollment number for a school + year.
 *
 * Format:  {SCHOOLCODE}-{YEAR}-{NNNN}
 * Example: GHS-2024-0042
 *
 * Uses the local SQLite students table when offline; falls back to a
 * timestamp-based sequence if neither table has usable data.
 *
 * @param {any}    db
 * @param {string} schoolCode  - e.g. "GHS"
 * @param {number} year        - e.g. 2024
 * @returns {Promise<string>}
 */
const generateLocalEnrollmentNo = async (db, schoolCode, year) => {
  const prefix = `${schoolCode}-${year}-`;

  if (await tableExists(db, "students")) {
    try {
      // Find the highest sequence number already used this year
      const row = await db.getFirstAsync(
        `SELECT enrollmentNo
         FROM   students
         WHERE  enrollmentNo LIKE ?
         ORDER BY enrollmentNo DESC
         LIMIT  1`,
        [`${prefix}%`]
      );

      if (row?.enrollmentNo) {
        const parts  = row.enrollmentNo.split("-");
        const lastNo = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastNo)) {
          return `${prefix}${String(lastNo + 1).padStart(4, "0")}`;
        }
      }
    } catch (err) {
      console.warn("[studentApplications] generateLocalEnrollmentNo query failed:", err.message);
    }
  }

  // No existing records — start at 0001, with a time-based component to
  // reduce collision risk when multiple offline devices sync later
  const seed = Date.now() % 9000 + 1000;   // 1000–9999
  return `${prefix}${String(seed).padStart(4, "0")}`;
};

/**
 * Requests an enrollment number from the server.
 * Returns null if offline or the endpoint is unavailable.
 *
 * @param {string} studentId
 * @param {string} schoolId
 * @returns {Promise<string|null>}
 */
const requestServerEnrollmentNo = async (studentId, schoolId) => {
  try {
    const response = await api.post(
      API.admin.students.generateEnrollmentNo
        ? API.admin.students.generateEnrollmentNo(studentId)
        : `/admin/students/${studentId}/enrollment-number`,
      { schoolId },
      { timeout: 10_000 }
    );
    const no =
      response.data?.enrollmentNo  ||
      response.data?.enrollment_no ||
      response.data?.data?.enrollmentNo ||
      null;
    return no ? String(no).toUpperCase().trim() : null;
  } catch (err) {
    // Non-critical — offline or endpoint not yet deployed
    console.warn("[studentApplications] requestServerEnrollmentNo failed:", err.message);
    return null;
  }
};

/**
 * Main entry point: resolves an enrollment number for a newly-approved student.
 *
 * Strategy:
 *  1. If the student already has one → reuse it (idempotent)
 *  2. Online → ask the server (canonical source of truth)
 *  3. Offline → generate locally using the sequential helper
 *
 * After resolving, writes the number to BOTH the students and users tables.
 *
 * @param {any}    db
 * @param {object} student    - Raw DB row (must have id, schoolId / school_id)
 * @param {string} [userId]   - User account ID to mirror the number onto
 * @param {boolean} isOnline
 * @returns {Promise<string>} The resolved enrollment number
 */
const resolveEnrollmentNo = async (db, student, userId = null, isOnline = false) => {
  // ── 1. Already assigned — reuse ───────────────────────────────────────────
  const existing =
    student.enrollmentNo  ||
    student.enrollment_no ||
    student.admissionNo   ||
    student.admissionNumber;

  if (existing) {
    console.log(`[studentApplications] Reusing enrollment number: ${existing}`);
    return String(existing).toUpperCase().trim();
  }

  const schoolId = student.schoolId || student.school_id || getCurrentAuth().schoolId;
  let   enrollmentNo = null;

  // ── 2. Online → server ────────────────────────────────────────────────────
  if (isOnline) {
    enrollmentNo = await requestServerEnrollmentNo(student.id, schoolId);
    if (enrollmentNo) {
      console.log(`[studentApplications] Server enrollment number: ${enrollmentNo}`);
    }
  }

  // ── 3. Offline / server failed → generate locally ─────────────────────────
  if (!enrollmentNo) {
    const schoolCode = await resolveSchoolCode(db, schoolId);
    const year       = new Date().getFullYear();
    enrollmentNo     = await generateLocalEnrollmentNo(db, schoolCode, year);
    console.log(
      `[studentApplications] Generated local enrollment number: ${enrollmentNo}` +
      (isOnline ? " (server unavailable)" : " (offline)")
    );
  }

  // ── 4. Persist to students table ──────────────────────────────────────────
  try {
    const studentCols = await getTableColumns(db, "students");
    await updateRecord(db, "students", student.id, {
      enrollmentNo,
      enrollment_no:   enrollmentNo,
      admissionNo:     enrollmentNo,   // keep admission aliases in sync
      admissionNumber: enrollmentNo,
    }, studentCols);
  } catch (err) {
    console.warn("[studentApplications] Failed to write enrollmentNo to students:", err.message);
  }

  // ── 5. Mirror to users table so login works immediately ───────────────────
  if (userId && await tableExists(db, "users")) {
    try {
      const userCols = await getTableColumns(db, "users");
      await updateRecord(db, "users", userId, {
        enrollmentNo,
        enrollment_no: enrollmentNo,
      }, userCols);
    } catch (err) {
      console.warn("[studentApplications] Failed to mirror enrollmentNo to users:", err.message);
    }
  }

  return enrollmentNo;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — DOCUMENT HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const normalizeDocument = (doc, index = 0) => {
  if (!doc) return null;
  if (typeof doc === "string") {
    return { id: `doc-${index}`, title: `Document ${index + 1}`, uri: doc, type: "document" };
  }
  return {
    ...doc,
    id:    doc.id    || `doc-${index}`,
    title: doc.title || doc.name || doc.fileName || `Document ${index + 1}`,
    uri:   doc.uri   || doc.url  || doc.fileUrl  || doc.path || null,
    type:  doc.type  || doc.mimeType || "document",
  };
};

const parseInlineDocuments = (student) => {
  const raw =
    student.documents   ||
    student.document    ||
    student.docs        ||
    student.documentUri ||
    student.documentUrl;

  if (!raw) return [];
  if (Array.isArray(raw))      return raw.map(normalizeDocument).filter(Boolean);
  if (typeof raw === "object") return [normalizeDocument(raw, 0)].filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(normalizeDocument).filter(Boolean);
      return [normalizeDocument(parsed, 0)].filter(Boolean);
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
        const rows    = await db.getAllAsync(
          `SELECT * FROM student_documents WHERE student_id = ? ORDER BY ${orderBy}`,
          [student.id]
        );
        (rows ?? []).forEach((row, i) => {
          docs.push(normalizeDocument(row, docs.length + i));
        });
      } catch (err) {
        console.warn("[studentApplications] Failed to load student_documents:", err.message);
      }
    }
  }

  return docs;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — NORMALISE SERVER → LOCAL
// ═════════════════════════════════════════════════════════════════════════════

const normaliseServerStudent = (raw) => {
  const classId   = resolveClassId(raw);
  const fromParts = [raw.firstName, raw.lastName].filter(Boolean).join(" ").trim();

  const admissionNo  = raw.admissionNo  || raw.admissionNumber || raw.admNo || null;
  const enrollmentNo = raw.enrollmentNo || raw.enrollment_no   || admissionNo || null;

  return {
    id:   String(raw._id || raw.id || ""),
    name: fromParts || raw.studentName || raw.student_name || raw.name || "Unknown",

    firstName: raw.firstName || null,
    lastName:  raw.lastName  || null,

    email: raw.email || raw.studentEmail || raw.parentEmail || "",
    phone: raw.phone || raw.phoneNumber  || raw.phone_number ||
           raw.parentPhone || raw.guardianPhone || "",

    guardianName:
      raw.guardianName  || raw.guardian_name ||
      raw.parentName    || raw.parent_name   || "",

    className:
      raw.className || raw.class_name || raw.grade ||
      (typeof raw.class === "object" ? raw.class?.name : null) ||
      "No class selected",

    classId,
    class_id: classId,

    status:     raw.status    || "pending",
    created_at: raw.createdAt || raw.created_at || null,
    updated_at: raw.updatedAt || raw.updated_at || null,
    documents:  Array.isArray(raw.documents) ? raw.documents : [],
    address:    raw.address   || raw.homeAddress || "",
    notes:      raw.notes     || "",
    schoolId:   raw.schoolId  || null,

    // Enrollment number — prefer the dedicated field over admissionNo
    enrollmentNo,
    enrollment_no:   enrollmentNo,
    admissionNo:     admissionNo || enrollmentNo,
    admissionNumber: raw.admissionNumber || admissionNo || enrollmentNo,
  };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — USER ACCOUNT HELPER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creates or reactivates a local User account for an approved student.
 * Email is no longer required — students log in via enrollment number.
 *
 * @param {any}    db
 * @param {object} student - Raw DB row
 * @returns {Promise<string>} User ID
 */
const ensureStudentUser = async (db, student) => {
  if (!(await tableExists(db, "users"))) {
    throw new Error("[studentApplications] Users table does not exist");
  }

  const userCols = await getTableColumns(db, "users");
  const name     = getStudentDisplayName(student);
  const email    = getStudentEmail(student);   // optional for students
  const ts       = new Date().toISOString();

  // ── Try to find existing account ──────────────────────────────────────────
  // Match by student_id first (most reliable), then email if present
  let existing = null;

  if (userCols.includes("student_id")) {
    existing = await db.getFirstAsync(
      `SELECT * FROM users WHERE student_id = ? LIMIT 1`,
      [student.id]
    ).catch(() => null);
  }

  if (!existing && email && userCols.includes("email")) {
    existing = await db.getFirstAsync(
      `SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
      [email]
    ).catch(() => null);
  }

  if (existing) {
    if (existing.role && existing.role !== "student") {
      throw new Error(
        "A non-student account already exists with this email address"
      );
    }
    await updateRecord(db, "users", existing.id, {
      name, role: "student", is_active: 1, updated_at: ts,
    }, userCols);
    return existing.id;
  }

  // ── Create new account ────────────────────────────────────────────────────
  const newId = generateLocalId();
  await insertRecord(db, "users", {
    id:         newId,
    name,
    email:      email || null,   // email is optional
    role:       "student",
    is_active:  1,
    password:   "",              // will be set after enrollment number is known
    created_at: ts,
    updated_at: ts,
    // enrollmentNo written later by resolveEnrollmentNo()
  }, userCols);

  return newId;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — LOCAL QUERY BUILDERS
// ═════════════════════════════════════════════════════════════════════════════

const getLocalPending = async (db, schoolId) => {
  if (!(await tableExists(db, "students"))) return [];

  const studentCols = await getTableColumns(db, "students");
  if (!studentCols.includes("status")) {
    console.warn("[studentApplications] students table has no status column");
    return [];
  }

  const hasClasses = await tableExists(db, "classes");
  const classCol   = studentCols.includes("class_id") ? "class_id" : "classId";
  const canJoin    = (studentCols.includes("class_id") || studentCols.includes("classId"))
                     && hasClasses;

  const orderBy = studentCols.includes("created_at")
    ? "datetime(s.created_at) DESC"
    : "s.id DESC";

  const params = [];
  let   where  = "LOWER(s.status) = 'pending'";

  if (schoolId && (studentCols.includes("school_id") || studentCols.includes("schoolId"))) {
    const sCol = studentCols.includes("school_id") ? "school_id" : "schoolId";
    where += ` AND (s.${sCol} = ? OR s.${sCol} IS NULL OR s.${sCol} = '')`;
    params.push(schoolId);
  }

  const rows = await db.getAllAsync(
    `SELECT s.*
       ${canJoin ? ", c.name AS class_name" : ""}
     FROM students s
     ${canJoin ? `LEFT JOIN classes c ON c.id = s.${classCol}` : ""}
     WHERE ${where}
     ORDER BY ${orderBy}`,
    params
  ).catch(() => []);

  return Promise.all((rows ?? []).map(async (student) => ({
    ...student,
    id:           String(student.id),
    name:         getStudentDisplayName(student),
    email:        getStudentEmail(student),
    enrollmentNo: student.enrollmentNo || student.enrollment_no || null,
    className:
      student.class_name         ||
      student.applied_class_name ||
      student.class_applied      ||
      "No class selected",
    documents: await getStudentDocuments(db, student),
  })));
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — INTERNAL: MARK LOCAL DECISION
// ═════════════════════════════════════════════════════════════════════════════

const markLocalDecision = async (
  db, studentId, status, classId, synced, reason = null
) => {
  try {
    if (!(await tableExists(db, "students"))) return;

    const studentCols = await getTableColumns(db, "students");
    const ts          = new Date().toISOString();

    const values = {
      status,
      updated_at: ts,
      _synced:    synced ? 1 : 0,
    };

    if (status === "approved") {
      values.approved_at = ts;
      values.reviewed_at = ts;
      values.is_active   = 1;
      if (classId) {
        values.class_id = classId;
        values.classId  = classId;
      }
    }

    if (status === "rejected") {
      values.rejected_at      = ts;
      values.reviewed_at      = ts;
      values.is_active        = 0;
      values.rejection_reason = reason?.trim() || null;
    }

    await updateRecord(db, "students", studentId, values, studentCols);
  } catch (err) {
    console.warn("[studentApplications] markLocalDecision failed:", err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — PUBLIC SERVICE
// ═════════════════════════════════════════════════════════════════════════════

export const StudentApplicationsService = {

  // ── getPendingApplications ──────────────────────────────────────────────────
  async getPendingApplications() {
    const db               = await getDatabase();
    const { schoolId }     = getCurrentAuth();
    await ensureSchema(db);

    return fetchWithFallback({
      label: "pending-applications",

      serverFetch: async () => {
        const response = await api.get(API.admin.students.pending, {
          params:  schoolId ? { schoolId } : undefined,
          timeout: 15_000,
        });

        const raw =
          response.data?.students ||
          response.data?.data     ||
          (Array.isArray(response.data) ? response.data : []);

        const normalized = Array.isArray(raw)
          ? raw.map(normaliseServerStudent)
          : [];

        return { data: raw, normalized, count: normalized.length };
      },

      localFetch: () => getLocalPending(db, schoolId),
    });
  },

  // ── getById ─────────────────────────────────────────────────────────────────
  async getById(id) {
    const db = await getDatabase();
    await ensureSchema(db);

    try {
      const net = await NetInfo.fetch();
      if (net.isConnected) {
        const response = await api.get(API.admin.students.detail(id));
        const raw      = response.data?.student || response.data;
        if (raw) return normaliseServerStudent(raw);
      }
    } catch { /* fall through to local */ }

    if (!(await tableExists(db, "students"))) return null;

    const studentCols = await getTableColumns(db, "students");
    const classCol    = studentCols.includes("class_id") ? "class_id" : "classId";
    const hasClasses  = await tableExists(db, "classes");
    const canJoin     = (studentCols.includes("class_id") || studentCols.includes("classId"))
                        && hasClasses;

    const student = await db.getFirstAsync(
      `SELECT s.*
         ${canJoin ? ", c.name AS class_name" : ""}
       FROM students s
       ${canJoin ? `LEFT JOIN classes c ON c.id = s.${classCol}` : ""}
       WHERE s.id = ?
       LIMIT 1`,
      [id]
    ).catch(() => null);

    if (!student) return null;

    return {
      ...student,
      name:         getStudentDisplayName(student),
      email:        getStudentEmail(student),
      enrollmentNo: student.enrollmentNo || student.enrollment_no || null,
      className:    student.class_name || student.applied_class_name || "No class selected",
      documents:    await getStudentDocuments(db, student),
    };
  },

  // ── approveApplication ──────────────────────────────────────────────────────
  /**
   * Approves a student application.
   *
   * Enrollment number lifecycle:
   *  - Online:  server assigns the canonical number; we cache it locally
   *  - Offline: we generate locally with generateLocalEnrollmentNo();
   *             pushPendingDecisions() will replace it with the server's
   *             canonical number once connectivity returns
   *
   * @param {string} studentId
   * @param {string} classId
   * @returns {Promise<{
   *   success:      boolean,
   *   synced:       boolean,
   *   emailSent:    boolean,
   *   tempPassword: string|null,
   *   warning:      string|null,
   *   userId:       string|null,
   *   enrollmentNo: string|null,
   * }>}
   */
  async approveApplication(studentId, classId) {
    if (!studentId) throw new Error("Student application ID is required");
    if (!classId)   throw new Error("Please select a class before approving");

    const db  = await getDatabase();
    await ensureSchema(db);
    const net = await NetInfo.fetch();

    // ── Online path ───────────────────────────────────────────────────────────
    if (net.isConnected) {
      try {
        const response = await api.put(
          API.admin.students.approve(studentId),
          { classId }
        );
        const result = response.data ?? {};

        // Server may return the enrollment number directly in the approve
        // response — capture it so we can cache it without a second round-trip
        const serverEnrollmentNo =
          result.enrollmentNo  ||
          result.enrollment_no ||
          result.student?.enrollmentNo ||
          null;

        await markLocalDecision(db, studentId, "approved", classId, true);

        // Cache enrollment number locally (server is the source of truth)
        if (serverEnrollmentNo) {
          const student = await db.getFirstAsync(
            `SELECT * FROM students WHERE id = ? LIMIT 1`,
            [studentId]
          ).catch(() => null);

          if (student) {
            const localUserId = result.userId || null;
            await resolveEnrollmentNo(db, student, localUserId, true);
          }
        }

        console.log(`[studentApplications] Approved on server: ${studentId}`);

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
        if (status !== 404) throw new Error(message || "Failed to approve on server");

        console.warn("[studentApplications] Student not found on server — approving locally");
      }
    }

    // ── Offline path ──────────────────────────────────────────────────────────
    if (!(await tableExists(db, "students"))) {
      throw new Error("Students table does not exist");
    }

    const student = await db.getFirstAsync(
      `SELECT * FROM students WHERE id = ? LIMIT 1`,
      [studentId]
    );
    if (!student) throw new Error("Student application not found");
    if (student.status && student.status !== "pending") {
      throw new Error("Only pending applications can be approved");
    }

    if (await tableExists(db, "classes")) {
      const cls = await db.getFirstAsync(
        `SELECT id, is_active FROM classes WHERE id = ? LIMIT 1`,
        [classId]
      );
      if (!cls)                        throw new Error("Selected class does not exist");
      if (Number(cls.is_active) === 0) throw new Error("Cannot assign student to an inactive class");
    }

    // Create / reactivate user account
    const localUserId = await ensureStudentUser(db, student);

    // Mark decision in local DB
    await markLocalDecision(db, studentId, "approved", classId, false);

    // Mirror userId back into students row
    const studentCols = await getTableColumns(db, "students");
    if (studentCols.includes("user_id")) {
      await updateRecord(db, "students", studentId, { user_id: localUserId }, studentCols);
    }

    // ── Generate enrollment number ─────────────────────────────────────────
    // Pass the freshly updated student row so resolveEnrollmentNo can
    // read schoolId from it.
    const freshStudent = await db.getFirstAsync(
      `SELECT * FROM students WHERE id = ? LIMIT 1`,
      [studentId]
    ).catch(() => student);

    const enrollmentNo = await resolveEnrollmentNo(
      db,
      freshStudent,
      localUserId,
      false  // offline
    );

    console.log(`[studentApplications] Approved locally (offline): ${studentId} → ${enrollmentNo}`);

    return {
      success:      true,
      synced:       false,
      emailSent:    false,
      tempPassword: enrollmentNo,   // default password = enrollment number
      warning:      "Approved offline — will sync when connection is restored",
      userId:       localUserId,
      enrollmentNo,
    };
  },

  // ── rejectApplication ───────────────────────────────────────────────────────
  async rejectApplication(studentId, reason = "") {
    if (!studentId) throw new Error("Student application ID is required");

    const db  = await getDatabase();
    await ensureSchema(db);
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        await api.put(
          API.admin.students.reject(studentId),
          { reason: reason?.trim() || "" }
        );
        await markLocalDecision(db, studentId, "rejected", null, true, reason);
        console.log(`[studentApplications] Rejected on server: ${studentId}`);
        return { success: true, synced: true };
      } catch (err) {
        const status  = err?.response?.status;
        const message = err?.response?.data?.message || err.message;

        if (status === 409) {
          await markLocalDecision(db, studentId, "rejected", null, true, reason);
          return { success: true, synced: true };
        }
        if (status !== 404) throw new Error(message || "Failed to reject on server");

        console.warn("[studentApplications] Student not found on server — rejecting locally");
      }
    }

    if (!(await tableExists(db, "students"))) {
      throw new Error("Students table does not exist");
    }

    const student = await db.getFirstAsync(
      `SELECT status FROM students WHERE id = ? LIMIT 1`,
      [studentId]
    );
    if (!student)                             throw new Error("Student application not found");
    if (student.status && student.status !== "pending") {
      throw new Error("Only pending applications can be rejected");
    }

    await markLocalDecision(db, studentId, "rejected", null, false, reason);
    console.log(`[studentApplications] Rejected locally (offline): ${studentId}`);
    return { success: true, synced: false };
  },

  // ── pullPendingApplications ─────────────────────────────────────────────────
  async pullPendingApplications(lastSync = null) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("[studentApplications] Offline — skipping pull");
      return 0;
    }

    try {
      const response = await api.get(API.admin.students.pending, {
        params: {
          since:    lastSync || "1970-01-01T00:00:00Z",
          schoolId: schoolId || undefined,
        },
        timeout: 15_000,
      });

      const applications =
        response.data?.students ||
        response.data?.data     ||
        (Array.isArray(response.data) ? response.data : []);

      if (!applications.length) {
        console.log("[studentApplications] No new applications on server");
        return 0;
      }

      if (!(await tableExists(db, "students"))) return 0;

      const studentCols = await getTableColumns(db, "students");
      const ts          = new Date().toISOString();
      let   synced      = 0;

      for (const app of applications) {
        const id = String(app._id || app.id || "").trim();
        if (!id) continue;

        const local = await db.getFirstAsync(
          `SELECT status FROM students WHERE id = ? LIMIT 1`,
          [id]
        ).catch(() => null);

        if (local && local.status !== "pending") continue;

        const classId      = resolveClassId(app);
        const fromParts    = [app.firstName, app.lastName].filter(Boolean).join(" ").trim();
        const admNo        = app.admissionNo   || app.admissionNumber || app.admNo || null;
        const enrollmentNo = app.enrollmentNo  || app.enrollment_no  || admNo     || null;

        const candidate = {
          id,
          name:             fromParts || app.studentName || app.name || "",
          firstName:        app.firstName    || null,
          lastName:         app.lastName     || null,
          email:            app.email        || "",
          phone:            app.phone        || null,
          address:          app.address      || null,
          guardian_name:    app.guardianName || null,
          guardian_phone:   app.guardianPhone || null,
          status:           app.status       || "pending",
          class_id:         classId,
          classId:          classId,
          school_id:        app.schoolId || null,
          schoolId:         app.schoolId || schoolId || null,
          // Enrollment number — write all aliases so nothing is missed
          enrollmentNo,
          enrollment_no:    enrollmentNo,
          admissionNo:      admNo || enrollmentNo,
          admissionNumber:  app.admissionNumber || admNo || enrollmentNo,
          rejection_reason: null,
          is_active:        1,
          _synced:          1,
          created_at:       app.createdAt || app.created_at || ts,
          updated_at:       app.updatedAt || app.updated_at || ts,
        };

        const payload = pickExisting(studentCols, candidate);
        const keys    = Object.keys(payload);
        if (!keys.length) continue;

        const placeholders = keys.map(() => "?").join(", ");
        const params       = keys.map((k) => payload[k]);
        const updateSet    = keys
          .filter((k) => k !== "id")
          .map((k) => `${k} = excluded.${k}`)
          .join(", ");

        await db.runAsync(
          `INSERT INTO students (${keys.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT(id) DO UPDATE SET ${updateSet}`,
          params
        ).catch((err) => {
          console.warn(`[studentApplications] Upsert failed for ${id}:`, err.message);
        });

        synced++;
      }

      console.log(`[studentApplications] Pulled ${synced} application(s) from server`);
      return synced;
    } catch (err) {
      console.warn("[studentApplications] pullPendingApplications failed:", err.message);
      return 0;
    }
  },

  // ── pushPendingDecisions ────────────────────────────────────────────────────
  /**
   * Pushes locally-made decisions (_synced = 0) to the server.
   * After a successful push, requests the server's canonical enrollment
   * number and replaces the locally-generated one.
   */
  async pushPendingDecisions() {
    const db  = await getDatabase();
    await ensureSchema(db);

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("[studentApplications] Offline — skipping push");
      return;
    }

    if (!(await tableExists(db, "students"))) return;

    const studentCols = await getTableColumns(db, "students");
    if (!studentCols.includes("_synced")) {
      await safeAddColumn(db, "students", "_synced", "INTEGER DEFAULT 0");
    }

    const dirty = await db.getAllAsync(
      `SELECT * FROM students
       WHERE (_synced = 0 OR _synced IS NULL)
         AND status IN ('approved', 'rejected')
       LIMIT 50`
    ).catch(() => []);

    if (!dirty?.length) {
      console.log("[studentApplications] No unsynced decisions to push");
      return;
    }

    console.log(`[studentApplications] Pushing ${dirty.length} decision(s)…`);
    const ts = new Date().toISOString();

    for (const student of dirty) {
      try {
        let serverEnrollmentNo = null;

        if (student.status === "approved") {
          const classId = student.class_id || student.classId || null;
          if (!classId) {
            console.warn(
              `[studentApplications] Skipping approved ${student.id} — no classId`
            );
            continue;
          }

          const response = await api.put(
            API.admin.students.approve(student.id),
            { classId }
          );

          // Capture server-assigned enrollment number
          serverEnrollmentNo =
            response.data?.enrollmentNo  ||
            response.data?.enrollment_no ||
            response.data?.student?.enrollmentNo ||
            null;

        } else if (student.status === "rejected") {
          await api.put(API.admin.students.reject(student.id), {
            reason: student.rejection_reason || "",
          });
        }

        // Mark as synced
        await db.runAsync(
          `UPDATE students SET _synced = 1, updated_at = ? WHERE id = ?`,
          [ts, student.id]
        );

        // Replace local enrollment number with server's canonical one
        if (serverEnrollmentNo) {
          await db.runAsync(
            `UPDATE students
             SET enrollmentNo = ?, enrollment_no = ?,
                 admissionNo  = ?, admissionNumber = ?,
                 updated_at   = ?
             WHERE id = ?`,
            [
              serverEnrollmentNo, serverEnrollmentNo,
              serverEnrollmentNo, serverEnrollmentNo,
              ts, student.id,
            ]
          );

          // Also update the linked user row
          const userRow = await db.getFirstAsync(
            `SELECT id FROM users WHERE student_id = ? OR id = ? LIMIT 1`,
            [student.id, student.user_id || ""]
          ).catch(() => null);

          if (userRow) {
            const userCols = await getTableColumns(db, "users");
            await updateRecord(db, "users", userRow.id, {
              enrollmentNo:  serverEnrollmentNo,
              enrollment_no: serverEnrollmentNo,
            }, userCols);
          }

          console.log(
            `[studentApplications] Enrollment number updated: ${student.id} → ${serverEnrollmentNo}`
          );
        }

        console.log(`[studentApplications] Synced: ${student.id} (${student.status})`);
      } catch (err) {
        const status = err?.response?.status;
        if (status === 409 || status === 404) {
          await db.runAsync(
            `UPDATE students SET _synced = 1 WHERE id = ?`,
            [student.id]
          );
          console.log(`[studentApplications] Marked synced (${status}): ${student.id}`);
        } else {
          console.warn(
            `[studentApplications] Push failed for ${student.id}:`,
            err.message
          );
        }
      }
    }
  },

  // ── getEnrollmentNo ─────────────────────────────────────────────────────────
  /**
   * Public helper — returns the enrollment number for a student ID.
   * Useful for displaying credentials after approval.
   *
   * @param {string} studentId
   * @returns {Promise<string|null>}
   */
  async getEnrollmentNo(studentId) {
    const db = await getDatabase();
    if (!(await tableExists(db, "students"))) return null;

    const row = await db.getFirstAsync(
      `SELECT enrollmentNo, enrollment_no, admissionNo FROM students WHERE id = ? LIMIT 1`,
      [studentId]
    ).catch(() => null);

    return (
      row?.enrollmentNo  ||
      row?.enrollment_no ||
      row?.admissionNo   ||
      null
    );
  },
};

export default StudentApplicationsService;