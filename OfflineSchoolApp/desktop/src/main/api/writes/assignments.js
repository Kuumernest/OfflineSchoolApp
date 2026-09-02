// desktop/src/main/api/writes/assignments.js
"use strict";

/**
 * Teacher assignments — who teaches what to which class — from the mirror.
 *
 * One write, registered under BOTH of the server's paths. admin.routes.js points
 * /admin/assignments and /admin/teacher-assignments at the same handlers, and
 * the console uses whichever the screen was written against — EditTeacherPage
 * posts to /admin/assignments while the endpoint table names
 * /admin/teacher-assignments. Registering one of them means the other silently
 * goes to the network, which is how this handler came to be unreachable from
 * the screen that actually creates assignments.
 *
 * The create takes the client's id: the server accepts req.body.id as _id now,
 * so both sides agree about identity.
 *
 * The DELETE is not here. It is a hard delete on the server — findOneAndDelete,
 * no tombstone — and this layer describes rows to WRITE: it has no way to say
 * "this row is gone", and the sync feed cannot say it either, because the feed
 * only sends documents that exist. The same reason keeps the subject and class
 * deletes out, and it is recorded in writes/structure.js.
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
  // No $or in the store's filter language — it threw "Unsupported filter" on
  // every call, so this create has never once been queued. Two equality reads
  // and a union say the same thing. Both spellings, because the collection
  // carries the ids under teacher/class/subject and under the *Id names.
  const clash = [
    ...docs.find("teacherAssignment", { teacher: teacherId, class: classId, subject: subjectId }),
    ...docs.find("teacherAssignment", { teacherId, classId, subjectId }),
  ][0];
  if (clash) return null;
  const now = nowISO();
  const doc = { _id: id, schoolId, teacher: teacherId, class: classId, subject: subjectId, teacherId, classId, subjectId, assignedBy: session?.userId ?? null, isActive: true, validFrom: null, validUntil: null, createdAt: now, updatedAt: now };
  return {
    collection: "teacherAssignment",
    doc,
    request: { method: "POST", path: "/api/admin/assignments", body },
    response: {
      status: 201,
      data: { success: true, assignment: doc, serverId: id, clientId: id, data: doc },
    },
  };
};

// Both server paths, same handlers — see the header.
module.exports = [
  { route: "POST /api/admin/teacher-assignments",       handler: createHandler },
  { route: "POST /api/admin/assignments",               handler: createHandler },
];
