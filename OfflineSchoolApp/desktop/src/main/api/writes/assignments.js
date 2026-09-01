// desktop/src/main/api/writes/assignments.js
"use strict";

/**
 * Teacher assignments — who teaches what to which class — from the mirror.
 *
 * Two writes, each registered under BOTH of the server's paths. admin.routes.js
 * points /admin/assignments and /admin/teacher-assignments at the same two
 * handlers, and the console uses whichever the screen was written against —
 * EditTeacherPage posts to /admin/assignments while the endpoint table names
 * /admin/teacher-assignments. Registering one of them means the other silently
 * goes to the network, which is how these handlers came to be unreachable from
 * the screen that actually creates assignments.
 *
 * The create takes the client's id: the server accepts req.body.id as _id now,
 * so both sides agree about identity. The delete is a real hard delete on the
 * server — findOneAndDelete, no tombstone — so docs.forget is the honest mirror
 * of it rather than a soft delete that would linger.
 *
 * The bulk route stays online-only: its response carries rows under ids the
 * server invents.
 */

const nowISO = () => new Date().toISOString();

const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

/** A teacher, class or subject in the mirror, or null. */
const exists = (docs, collection, id, schoolId) => {
  if (!id || !schoolId) return null;
  const row = docs.get(collection, String(id).trim());
  if (!row || String(row.schoolId) !== String(schoolId)) return null;
  return row;
};

const createHandler = ({ body }, { docs, session }) => {
  const schoolId = schoolOf(body, session);
  if (!schoolId) return null;
  if (!session?.permissions?.includes("teachers.manage")) return null;
  const { teacherId, classId, subjectId } = body ?? {};
  if (!teacherId || !classId || !subjectId) return null;
  const teacher = exists(docs, "user", teacherId, schoolId);
  if (!teacher || teacher.role !== "teacher" || teacher.isActive === false) return null;
  const cls = exists(docs, "class", classId, schoolId);
  if (!cls) return null;
  const subj = exists(docs, "subject", subjectId, schoolId);
  if (!subj) return null;
  if (!body?.id) return null;
  const id = String(body.id).trim();
  if (docs.get("teacherAssignment", id)) return null;
  const clash = docs.find("teacherAssignment", {
    $or: [{ teacher: teacherId, class: classId, subject: subjectId },
          { teacherId, classId, subjectId }],
  })[0];
  if (clash) return null;
  const now = nowISO();
  const doc = { _id: id, schoolId, teacher: teacherId, class: classId, subject: subjectId, teacherId, classId, subjectId, assignedBy: session?.userId ?? null, isActive: true, validFrom: null, validUntil: null, createdAt: now, updatedAt: now };
  docs.put("teacherAssignment", doc);
  return { success: true, assignment: doc, serverId: id, data: doc };
};

const deleteHandler = ({ body, params }, { docs, session }) => {
  const schoolId = schoolOf(body, session);
  if (!schoolId) return null;
  if (!session?.permissions?.includes("teachers.manage")) return null;
  const row = docs.get("teacherAssignment", String(params.id).trim());
  if (!row || String(row.schoolId) !== String(schoolId)) return null;
  docs.forget("teacherAssignment", row._id);
  return { success: true, message: "Assignment deleted" };
};

// Both server paths, same handlers — see the header.
module.exports = [
  { route: "POST /api/admin/teacher-assignments",       handler: createHandler },
  { route: "POST /api/admin/assignments",               handler: createHandler },
  { route: "DELETE /api/admin/teacher-assignments/:id", handler: deleteHandler },
  { route: "DELETE /api/admin/assignments/:id",         handler: deleteHandler },
];
