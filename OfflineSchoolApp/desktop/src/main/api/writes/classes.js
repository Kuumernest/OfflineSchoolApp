// desktop/src/main/api/writes/classes.js
"use strict";

/**
 * Class records, answered from the local mirror when the school office has no
 * connection.
 *
 * POST /admin/online-classes and PUT /admin/online-classes/:id are online-only —
 * they spin up a live session on the server and have no local meaning.
 * The four queued writes below are the ones the class manager actually uses.
 */

const nowISO = () => new Date().toISOString();

const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

const classOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  const row = docs.get("class", String(id).trim());
  if (!row || String(row.schoolId) !== String(schoolId)) return null;
  return row;
};

module.exports = [
  {
    route: "POST /api/admin/classes",
    handler: ({ body }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("classes.manage")) return null;
      const name = body?.name ? String(body.name).trim() : "";
      if (!name) return null;
      if (!body?.id) return null;
      const id = String(body.id).trim();
      if (docs.get("class", id)) return null;
      const existing = docs.find("class", { name, schoolId, isActive: true })[0];
      if (existing) return null;
      const now = nowISO();
      const cls = { _id: id, name, level: body?.level || null, section: body?.section?.trim() || "", schoolId, isActive: true, deletedAt: null, createdAt: now, updatedAt: now };
      docs.put("class", cls);
      return { success: true, class: cls, serverId: id, clientId: id };
    },
  },

  {
    route: "PUT /api/admin/classes/:id",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("classes.manage")) return null;
      const cls = classOf(docs, schoolId, params.id);
      if (!cls) return null;
      if (body?.name !== undefined && typeof body.name !== "string") return null;
      const u = {};
      if (body?.name !== undefined) { const n = String(body.name).trim(); if (!n) return null; u.name = n; }
      if (body?.level !== undefined) u.level = body.level;
      if (body?.section !== undefined) u.section = body.section;
      if (body?.isActive !== undefined) u.isActive = !!body.isActive;
      const updated = { ...cls, ...u, updatedAt: nowISO() };
      docs.put("class", updated);
      return { success: true, class: updated };
    },
  },

  {
    route: "DELETE /api/admin/classes/:id",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("classes.manage")) return null;
      const cls = classOf(docs, schoolId, params.id);
      if (!cls) return null;
      const studentCount = docs.find("student", { classId: cls._id, schoolId }).length;
      if (studentCount > 0) return null;
      const subjects = docs.find("subject", { $or: [{ class: cls._id }, { classId: cls._id }] });
      for (const s of subjects) docs.put("subject", { ...s, deletedAt: nowISO() });
      docs.put("class", { ...cls, isActive: false, deletedAt: nowISO() });
      return { success: true, message: `Class and ${subjects.length} subject(s) deleted successfully`, deletedSubjects: subjects.length };
    },
  },

  {
    route: "PATCH /api/admin/classes/:id/toggle-active",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("classes.manage")) return null;
      const cls = classOf(docs, schoolId, params.id);
      if (!cls) return null;
      const updated = { ...cls, isActive: !cls.isActive, updatedAt: nowISO() };
      docs.put("class", updated);
      return { success: true, class: updated };
    },
  },
];
