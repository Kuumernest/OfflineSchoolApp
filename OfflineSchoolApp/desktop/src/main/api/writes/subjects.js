// desktop/src/main/api/writes/subjects.js
"use strict";

/**
 * Subject records, answered from the local mirror when the school office has no
 * connection.
 *
 * Three writes. The server's POST refuses creates without a client id (the mirror
 * stores under that id), and DELETE refuses a subject that still has teacher
 * assignments — both rules reproduced here.
 */

const nowISO = () => new Date().toISOString();

const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

const subjectOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  const row = docs.get("subject", String(id).trim());
  if (!row || String(row.schoolId) !== String(schoolId)) return null;
  return row;
};

const parseCoefficient = (raw) => {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.1 || n > 20) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
};

const classOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  const row = docs.get("class", String(id).trim());
  if (!row || String(row.schoolId) !== String(schoolId)) return null;
  return row;
};

module.exports = [
  {
    route: "POST /api/admin/subjects",
    handler: ({ body }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("subjects.manage")) return null;
      const name = body?.name ? String(body.name).trim() : "";
      if (!name) return null;
      if (!body?.classId) return null;
      const classId = String(body.classId).trim();
      const cls = classOf(docs, schoolId, classId);
      if (!cls) return null;
      if (!body?.id) return null;
      const id = String(body.id).trim();
      if (docs.get("subject", id)) return null;
      const coeff = parseCoefficient(body?.coefficient);
      if (!coeff.ok) return null;
      const clash = docs.find("subject", { name, schoolId, $or: [{ class: classId }, { classId }] })[0];
      if (clash) return null;
      const now = nowISO();
      const subject = { _id: id, name, code: body?.code?.trim() || "", class: classId, classId, schoolId, ...(coeff.value !== undefined && { coefficient: coeff.value }), createdAt: now, updatedAt: now };
      docs.put("subject", subject);
      return { success: true, subject, serverId: id };
    },
  },

  {
    route: "PUT /api/admin/subjects/:id",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("subjects.manage")) return null;
      const subject = subjectOf(docs, schoolId, params.id);
      if (!subject) return null;
      if (body?.classId) {
        const cls = classOf(docs, schoolId, String(body.classId).trim());
        if (!cls) return null;
      }
      const coeff = parseCoefficient(body?.coefficient);
      if (!coeff.ok) return null;
      const u = {};
      if (body?.name !== undefined) { const n = String(body.name).trim(); if (!n) return null; u.name = n; }
      if (body?.code !== undefined) u.code = body.code?.trim() || "";
      if (body?.classId !== undefined) { u.class = String(body.classId).trim(); u.classId = String(body.classId).trim(); }
      if (coeff.value !== undefined) u.coefficient = coeff.value;
      const updated = { ...subject, ...u, updatedAt: nowISO() };
      docs.put("subject", updated);
      return { success: true, subject: updated };
    },
  },

  {
    route: "DELETE /api/admin/subjects/:id",
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("subjects.manage")) return null;
      const subject = subjectOf(docs, schoolId, params.id);
      if (!subject) return null;
      const inUse = docs.find("teacherAssignment", { subject: subject._id })[0];
      if (inUse) return null;
      docs.forget("subject", subject._id);
      return { success: true, message: "Subject deleted" };
    },
  },
];
