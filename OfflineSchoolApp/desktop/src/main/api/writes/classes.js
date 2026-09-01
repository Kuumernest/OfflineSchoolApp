// desktop/src/main/api/writes/classes.js
"use strict";

/**
 * Class records, answered from the local mirror when the school office has no
 * connection.
 *
 * POST /admin/online-classes and PUT /admin/online-classes/:id are online-only —
 * they spin up a live session on the server and have no local meaning.
 *
 * ── Two writes are deliberately NOT here ──────────────────────────────────
 *
 * PATCH /admin/classes/:id/toggle-active does not exist on the server. The
 * console calls it and gets the admin router's 404 catch-all. Queueing it would
 * put a request in the outbox that can only ever fail, and a 4xx there stops
 * the whole queue — including work from other parts of the school. So the
 * toggle goes over the network and fails there, affecting nothing else.
 *
 * DELETE /admin/classes/:id HARD-deletes the class and every subject under it
 * (Subject.deleteMany). This layer describes rows to WRITE; it has no way to say
 * "this row is gone", and the sync feed cannot say it either — the feed sends
 * documents that exist, so a hard-deleted row is never mentioned again and a
 * local copy would sit on the machine for ever. Marking it deleted locally does
 * not help: GET /admin/subjects applies no deleted filter, so the subject would
 * keep appearing on the screen that had just deleted it.
 *
 * Both reasons are the ones already recorded in writes/structure.js.
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
      // Every field Class.js defaults, spelled out. The server answers with the
      // whole document, so a key missing here is a key the mirror reports as
      // undefined where the server reports null or false — which the promotion
      // page reads, and which the parity diff counts one field at a time.
      const cls = {
        _id:              id,
        name,
        level:            body?.level || null,
        section:          body?.section?.trim() || "",
        schoolId,
        school:           null,
        nextClassId:      null,
        isFinalYear:      false,
        promotionAverage: null,
        description:      null,
        capacity:         null,
        isActive:         true,
        deletedAt:        null,
        createdAt:        now,
        updatedAt:        now,
      };
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

];
