// OfflineSchoolApp/shared/students.js
"use strict";

/**
 * One shape for a pupil, used by the server and by the desktop's offline mirror.
 *
 * ── Why this is shared rather than copied ─────────────────────────────────
 *
 * It lived inline in backend/src/routes/admin.routes.js, which was fine while
 * one process answered every request. The desktop application answers the same
 * requests from a local database when there is no connection, and it has to
 * return the SAME shape — every screen that reads a pupil depends on these exact
 * field names, including the several aliases below that exist because two
 * collections and three generations of client all spell things differently.
 *
 * Reimplementing 130 lines of field-aliasing by eye, in a second package, is a
 * guarantee that the two will differ eventually — and the difference would show
 * up as a name rendering as blank on one platform and not the other, which is
 * the kind of bug nobody can reproduce. So there is one copy, and both require
 * it.
 *
 * ── Why it looks like this ───────────────────────────────────────────────
 *
 * The aliasing is not indecision. A pupil may be a Student record or a
 * StudentApplication, the two schemas disagree, and older clients send
 * snake_case. Every fallback chain here is a real shape that has arrived at some
 * point, and the output carries BOTH spellings of several fields because
 * different screens read different ones.
 */

const normaliseStudentDoc = (s) => {
  if (!s) return null;
  const idStr = String(s._id || s.id || "");
  if (!idStr) return null;

  // ── Name ──────────────────────────────────────────────────────────────────
  const fromParts =
    [s.firstName, s.lastName].filter(Boolean).join(" ").trim();

  const name =
    fromParts      ||
    s.studentName  ||   // StudentApplication field
    s.student_name ||
    s.name         ||
    s.full_name    ||
    null;

  // ── Class ─────────────────────────────────────────────────────────────────
  const classId =
    s.classId  ||
    s.class_id ||
    (s.class && typeof s.class === "object"
      ? String(s.class._id || s.class.id || "")
      : typeof s.class === "string" ? s.class : null) ||
    null;

  const className =
    s.className  ||
    s.class_name ||
    (s.class && typeof s.class === "object" ? s.class.name : null) ||
    null;

  // ── Guardian ──────────────────────────────────────────────────────────────
  const guardianName =
    s.guardianName  ||
    s.guardian_name ||
    s.parentName    ||
    s.parent_name   ||
    null;

  const guardianPhone =
    s.guardianPhone  ||
    s.guardian_phone ||
    s.parentPhone    ||
    null;

  // ── Email / Phone ─────────────────────────────────────────────────────────
  const email =
    s.email        ||
    s.studentEmail ||
    s.parentEmail  ||
    null;

  const phone =
    s.phone       ||
    s.phoneNumber ||
    guardianPhone ||   // fallback to guardian phone for application records
    null;

  // ── Admission / Enrollment ────────────────────────────────────────────────
  const admissionNo =
    s.admissionNo     ||
    s.admissionNumber ||
    s.admNo           ||
    null;

  const enrollmentNo =
    s.enrollmentNo  ||
    s.enrollment_no ||
    admissionNo     ||
    null;

  return {
    id:  idStr,
    _id: idStr,

    // Name
    name,
    studentName:  s.studentName || name,
    firstName:    s.firstName   || null,
    lastName:     s.lastName    || null,

    // Contact
    email,
    phone,

    // Personal
    dateOfBirth:  s.dateOfBirth || s.date_of_birth || s.dob || null,
    gender:       s.gender      || null,
    address:      s.address     || s.homeAddress   || null,

    // Class
    classId,
    class_id:    classId,
    className,

    // Guardian — critical for StudentApplication records
    guardianName,
    guardian_name:   guardianName,
    guardianPhone,
    guardian_phone:  guardianPhone,
    guardianEmail:   s.guardianEmail || s.guardian_email || null,

    // Admission
    admissionNo,
    admissionNumber: s.admissionNumber || admissionNo  || null,
    enrollmentNo,
    enrollment_no:   enrollmentNo,

    // Status & flags
    status:        s.status   || "pending",
    isActive:      s.isActive ?? true,
    schoolId:      s.schoolId || null,
    userId:        s.userId   || null,
    studentId:     s.studentId     || null,
    applicationId: s.applicationId || null,

    // Timestamps
    enrolledAt:  s.enrolledAt  || s.approvedAt || null,
    createdAt:   s.createdAt   || null,
    updatedAt:   s.updatedAt   || null,

    // Source tracking (useful for debugging)
    _source: s._source || "unknown",

    // Notes / rejection
    notes:           s.notes           || null,
    rejectionReason: s.rejectionReason || s.rejectReason || null,

    // Documents
    documents: Array.isArray(s.documents) ? s.documents : [],
  };
};

module.exports = { normaliseStudentDoc };
