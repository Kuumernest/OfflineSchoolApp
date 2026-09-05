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
 * PUT /admin/classes/:id is not here either, for a different reason: it is
 * registered in writes/structure.js, which is pushed onto the route table
 * first and therefore wins. A second copy here was dead code that could only
 * ever diverge from the one that runs.
 *
 * The first two reasons are the ones already recorded in writes/structure.js.
 */

const nowISO = () => new Date().toISOString();

const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

/**
 * classTeacherFields(), reproduced — the form master on a create.
 *
 * On the server: an ABSENT classTeacherId contributes nothing at all, an
 * EMPTY one means "no teacher", and a real id must name a user this school
 * has — anything else is a 403 ("Selected teacher does not exist or access
 * denied"), which is not this layer's to invent. So a teacher the mirror
 * cannot see DECLINES the whole create and the request goes to the network
 * where that check lives. Only a teacher this machine can find in its own
 * mirror is answered offline, with the id AND the name the report card
 * prints, exactly as the endpoint stores them.
 *
 * The school clause is reproduced from structure.js's tenant(): a row whose
 * schoolId differs is invisible here. A super_admin reaching across schools
 * therefore finds nothing on this machine — stricter than the server, which
 * is the safe direction.
 */
const teacherFieldsFor = (docs, rawId, schoolId) => {
  if (rawId === undefined) return { ok: true, fields: {} };

  const id = String(rawId ?? "").trim();
  if (!id) {
    return { ok: true, fields: { classTeacherId: null, classTeacherName: null } };
  }

  const teacher = docs.get("user", id);
  if (!teacher || String(teacher.schoolId ?? "") !== String(schoolId)) {
    return { ok: false };
  }
  return {
    ok: true,
    fields: { classTeacherId: id, classTeacherName: teacher.name || null },
  };
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

      // The form master. A teacher this mirror cannot see declines the create
      // (the server's 403 is its own to give); the other two shapes are
      // answered offline exactly as the endpoint would.
      const teacher = teacherFieldsFor(docs, body?.classTeacherId, schoolId);
      if (!teacher.ok) return null;

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
        classTeacherId:   null,
        classTeacherName: null,
        ...teacher.fields,
        isActive:         true,
        deletedAt:        null,
        createdAt:        now,
        updatedAt:        now,
      };
      // A descriptor, not a response body, and not a docs.put of its own: index.js
      // stores the row and queues the request in one transaction. Returning the
      // body meant `collection` was undefined, docs.put threw on it, and every
      // offline class create went quietly to the network instead.
      return {
        collection: "class",
        doc:        cls,
        request: { method: "POST", path: "/api/admin/classes", body },
        // serverId equals clientId now that the endpoint takes the id it is
        // given — which is what made queueing this create possible at all.
        response: {
          status: 201,
          data: { success: true, class: cls, serverId: id, clientId: id },
        },
      };
    },
  },
];
