// src/services/studentFetch.service.js
"use strict";

import api from "./api";

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const toStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return String(v._id || v.id || "").trim();
  return String(v).trim();
};

const isAdminRole = (role) =>
  ["admin", "school_admin", "super_admin"].includes(
    String(role || "").toLowerCase()
  );

// ─────────────────────────────────────────────────────────
// NORMALIZE response → student array
// Handles every known API response shape.
// ─────────────────────────────────────────────────────────

const normalize = (data, endpoint = "") => {
  if (!data) return [];

  if (Array.isArray(data)) return data;

  const keys = [
    "students", "data", "result", "results",
    "roster",   "users", "members", "list",
    "records",  "items", "student",
  ];

  for (const key of keys) {
    if (Array.isArray(data[key]) && data[key].length > 0) {
      return data[key];
    }
  }

  // Nested data.*
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    for (const key of keys) {
      if (Array.isArray(data.data[key]) && data.data[key].length > 0) {
        return data.data[key];
      }
    }
  }

  return [];
};

// ─────────────────────────────────────────────────────────
// SHAPE student record consistently
// ─────────────────────────────────────────────────────────

const shapeStudent = (s) => ({
  _id:         toStr(s._id || s.id),
  studentName: s.studentName || s.name || s.fullName || "Unknown",
  admissionNo: s.admissionNo || s.admissionNumber || s.regNo || null,
  email:       s.email       || null,
  classId:     toStr(s.classId || s.class_id || s.class),
  rollNumber:  s.rollNumber  || s.roll_number || null,
  gender:      s.gender      || null,
  isActive:    s.isActive    ?? true,
  schoolId:    s.schoolId    || null,
});

// ─────────────────────────────────────────────────────────
// MAIN — fetchStudents
// Server handles classId resolution (UUID ↔ ObjectId).
// We trust the server's filtered response.
// ─────────────────────────────────────────────────────────

/**
 * Fetch students accessible to the current teacher.
 *
 * @param {object} opts
 * @param {string} opts.schoolId
 * @param {string} [opts.classId]
 * @param {string} [opts.subjectId]
 * @param {string} [opts.role]
 * @returns {Promise<object[]>}
 */
export const fetchStudents = async ({
  schoolId,
  classId,
  subjectId,
  role = "",
} = {}) => {
  console.log("[fetchStudents] →", { schoolId, classId, subjectId });

  const classIdStr = classId ? String(classId).trim() : null;

  // ── Ordered list of endpoints to try ──────────────────
  const endpoints = [
    // Teacher-specific with classId
    ...(classIdStr ? [
      { url: "/teacher/my-students", params: { schoolId, classId: classIdStr } },
      { url: "/teacher/students",    params: { schoolId, classId: classIdStr } },
      { url: `/classes/${classIdStr}/students`, params: { schoolId } },
    ] : []),

    // Teacher-specific without classId (all classes)
    { url: "/teacher/my-students", params: { schoolId } },
    { url: "/teacher/students",    params: { schoolId } },

    // Admin-only routes
    ...(isAdminRole(role) ? [
      { url: "/admin/students", params: { schoolId, ...(classIdStr ? { classId: classIdStr } : {}) } },
      { url: "/students",       params: { schoolId, ...(classIdStr ? { classId: classIdStr } : {}) } },
    ] : []),

    // Attendance roster — last resort
    ...(classIdStr ? [
      { url: "/attendance/students/roster", params: { schoolId, classId: classIdStr } },
    ] : []),
    { url: "/attendance/students/roster", params: { schoolId } },
  ];

  for (const { url, params } of endpoints) {
    try {
      console.log(`[fetchStudents] trying: ${url}`, params);

      const res  = await api.get(url, { params });
      const raw  = normalize(res.data, url);

      console.log(`[fetchStudents] ${url} → ${raw.length} students`);

      if (raw.length === 0) continue;

      // Remove records that are clearly not students
      const valid = raw.filter((s) => {
        const r = String(s.role || s.userType || "").toLowerCase();
        return !r || r === "student" || r === "pupil" || r === "learner";
      });

      if (valid.length > 0) {
        console.log(`[fetchStudents] ✅ ${valid.length} students from ${url}`);
        return valid.map(shapeStudent);
      }

    } catch (err) {
      const status = err?.response?.status;
      console.log(`[fetchStudents] ${url} → ${status ?? err.message}`);
      if (status === 401 || status === 403 || status === 404) continue;
      if (status >= 500) break;
    }
  }

  console.warn("[fetchStudents] all attempts exhausted — returning []");
  return [];
};

export default fetchStudents;