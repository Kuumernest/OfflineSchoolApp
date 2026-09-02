// desktop/src/main/api/writes/subjects.js
"use strict";

/**
 * Subjects, answered from the local mirror when the office has no connection.
 *
 * One write. The other two in this domain are not here:
 *
 *   PUT /admin/subjects/:id is registered in writes/structure.js, which is
 *   pushed onto the route table first and wins. A second copy here was dead
 *   code that could only ever diverge from the one that runs.
 *
 *   DELETE /admin/subjects/:id is a HARD delete on the server. This layer
 *   describes rows to WRITE and has no way to say "this row is gone"; the sync
 *   feed cannot say it either, because the feed sends documents that exist. A
 *   local copy would sit on the machine for ever, and marking it deleted does
 *   not help — GET /admin/subjects applies no deleted filter, so the subject
 *   would keep appearing on the screen that had just deleted it. The reason is
 *   recorded in writes/structure.js too.
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
      // The store's filter language has equality, in, not and the comparisons —
      // no $or, which threw "Unsupported filter" on every call and sent the
      // create to the network. Two reads and a union say the same thing.
      const clash = [...docs.find("subject", { name, schoolId, class: classId }),
                     ...docs.find("subject", { name, schoolId, classId })][0];
      if (clash) return null;
      const now = nowISO();
      const subject = { _id: id, name, code: body?.code?.trim() || "", class: classId, classId, schoolId, ...(coeff.value !== undefined && { coefficient: coeff.value }), createdAt: now, updatedAt: now };
      return {
        collection: "subject",
        doc:        subject,
        request: { method: "POST", path: "/api/admin/subjects", body },
        response: {
          status: 201,
          data: { success: true, subject, serverId: id, clientId: id },
        },
      };
    },
  },
];
