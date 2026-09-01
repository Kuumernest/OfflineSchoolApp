// desktop/src/main/api/writes/staff.js
"use strict";

/**
 * Teacher records, answered from the local mirror when the school office has no
 * connection.
 *
 * Six writes on the teacher screens. Four are queued here:
 *   POST   /admin/teachers                 create a teacher account
 *   PUT    /admin/teachers/:id             update name / email / active flag
 *   DELETE /admin/teachers/:id             deactivate the account
 *   POST   /admin/teachers/:id/reset-password  reissue credentials
 *
 * Two are online-only (file uploads � nothing local to queue).
 * Every lookup carries schoolId from the SESSION. A teacher not in this
 * school's mirror is not found here. Creates require a client id.
 */

const nowISO = () => new Date().toISOString();

const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

const teacherOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  const rows = docs.find("user", { _id: String(id).trim(), schoolId, role: "teacher" });
  return rows[0] ?? null;
};

const isValidEmail = (email) =>
  typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const emailTaken = (docs, schoolId, email, exceptId) => {
  const rows = docs.find("user", { schoolId, role: "teacher", email: String(email).toLowerCase().trim() });
  return rows.find((r) => String(r._id) !== String(exceptId)) ?? null;
};

module.exports = [
  {
    route: "POST /api/admin/teachers",
    handler: ({ body }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("teachers.manage")) return null;
      const name = body?.name ? String(body.name).trim() : "";
      if (!name) return null;
      const email = body?.email ? String(body.email).toLowerCase().trim() : "";
      if (!email || !isValidEmail(email)) return null;
      if (!body?.id) return null;
      const id = String(body.id).trim();
      if (docs.get("user", id)) return null;
      if (emailTaken(docs, schoolId, email)) return null;
      const now = nowISO();
      const teacher = { _id: id, name, email, role: "teacher", isActive: true, schoolId, mustResetPassword: true, createdAt: now, updatedAt: now };
      docs.put("user", teacher);
      return { success: true, data: teacher, teacher, emailSent: false, message: "Teacher created. Email failed." };
    },
  },
  {
    route: "PUT /api/admin/teachers/:id",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("teachers.manage")) return null;
      const teacher = teacherOf(docs, schoolId, params.id);
      if (!teacher) return null;
      const u = {};
      if (body?.name !== undefined) { const n = String(body.name).trim(); if (!n) return null; u.name = n; }
      if (body?.email !== undefined) { const e = String(body.email).toLowerCase().trim(); if (!isValidEmail(e)) return null; if (emailTaken(docs, schoolId, e, teacher._id)) return null; u.email = e; }
      if (body?.isActive !== undefined) u.isActive = !!body.isActive;
      const updated = { ...teacher, ...u, updatedAt: nowISO() };
      docs.put("user", updated);
      return { success: true, data: { ...updated, password: undefined, tempPassword: undefined } };
    },
  },
  {
    route: "DELETE /api/admin/teachers/:id",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("teachers.manage")) return null;
      const teacher = teacherOf(docs, schoolId, params.id);
      if (!teacher) return null;
      docs.put("user", { ...teacher, isActive: false, updatedAt: nowISO() });
      return { success: true, message: "Teacher deactivated" };
    },
  },
  {
    // Password reset is online-only: the server generates the temp password,
    // hashes it, stores it, and emails it. A locally-invented password would
    // not match the server's hash and the teacher could not sign in. Declining
    // sends the request to the server where the real password is minted.
    route: "POST /api/admin/teachers/:id/reset-password",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("teachers.manage")) return null;
      const teacher = teacherOf(docs, schoolId, params.id);
      if (!teacher) return null;
      return null;
    },
  },
];