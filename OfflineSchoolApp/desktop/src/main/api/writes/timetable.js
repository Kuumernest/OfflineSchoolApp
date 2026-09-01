// desktop/src/main/api/writes/timetable.js
"use strict";

/**
 * Timetable slot writes — creating, editing and retiring a lesson.
 *
 * ── POST /admin/timetable ─────────────────────────────────────────────────
 *
 * The endpoint now honours a client-supplied _id (like POST /api/exams and
 * POST /api/fees/payments already do), so a queued request from an offline
 * machine can be replayed without creating a duplicate. The mirror stores under
 * the id the caller chose, and the server keeps it on replay.
 *
 * ── The two writes that were already here ──────────────────────────────────
 *
 *   PUT /admin/timetable/:id   update a slot (subject, teacher, day, period,
 *                              room), with the endpoint's optimistic version
 *                              check — a stale version means somebody else
 *                              changed the slot while the user had it open.
 *
 *   DELETE /admin/timetable/:id  soft delete: deletedAt is set, the version
 *                              bumps, and the row stays so the feed can
 *                              deliver the deletion to every other device.
 *
 * ── The two 409s ──────────────────────────────────────────────────────────
 *
 * Both endpoints check the same two constraints before writing:
 *   class conflict   no other non-deleted slot for the same class, day and
 *                    period
 *   teacher conflict no other non-deleted slot for the same teacher, day and
 *                    period
 * Either one is a 409 with a `conflict` kind, and both stop the outbox. So they
 * are checked here, against the mirror — the same rows the server would look at,
 * possibly a sync behind. A conflict the mirror cannot see is a conflict the
 * replayed request will hit on the server; the queue stops and a person clears
 * it, which is the same outcome the online screen gives.
 *
 * ── The version check ─────────────────────────────────────────────────────
 *
 * The web sends `version` when moving a slot by drag. If the mirror's version
 * differs from the client's, somebody else saved since the page was loaded, and
 * the endpoint answers 409 with `conflict: "version"` carrying the server's
 * current copy. Reproduced so the screen can show it.
 */

const { randomUUID } = require("crypto");

const DAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

const nowISO = () => new Date().toISOString();

const toDay = (raw) => {
  if (!raw) return null;
  const code = String(raw).trim().slice(0, 3).toUpperCase();
  return DAYS.has(code) ? code : null;
};

const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

const slotOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  const row = docs.get("timetableSlot", String(id).trim());
  if (!row || String(row.schoolId) !== String(schoolId)) return null;
  if (row.deletedAt) return null;
  return row;
};

/**
 * Is there a non-deleted slot in the mirror for the same (class, day, period)
 * or the same (teacher, day, period)? Returns the kind of conflict, or null.
 */
const conflictFor = (docs, { classId, teacherId, dayOfWeek, periodId }, excludeId) => {
  const peers = docs.find("timetableSlot", {
    dayOfWeek,
    periodId,
    deletedAt: null,
  });

  for (const p of peers) {
    if (excludeId && String(p._id) === String(excludeId)) continue;
    if (String(p.classId) === String(classId)) return "class";
    if (String(p.teacherId) === String(teacherId)) return "teacher";
  }
  return null;
};

module.exports = [
  {
    route: "POST /api/admin/timetable",

    /**
     * Creating a new timetable slot offline.
     *
     * The server endpoint now accepts a client-supplied _id, making this an
     * ordinary queued write. Class and teacher conflicts are checked against
     * the mirror — the same rows the server would look at.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("timetable.manage")) return null;

      const classId   = body?.classId   ? String(body.classId).trim()   : null;
      const subjectId = body?.subjectId ? String(body.subjectId).trim() : null;
      const teacherId = body?.teacherId ? String(body.teacherId).trim() : null;
      const dayOfWeek = toDay(body?.dayOfWeek);
      const periodId  = body?.periodId  ? String(body.periodId).trim()  : null;

      if (!classId || !subjectId || !teacherId || !dayOfWeek || !periodId) return null;

      const clash = conflictFor(docs, { classId, teacherId, dayOfWeek, periodId }, null);
      if (clash) return null;

      const id  = body._id ? String(body._id) : randomUUID();
      const now = nowISO();

      const doc = {
        _id:       id,
        schoolId,
        classId,
        subjectId,
        teacherId,
        dayOfWeek,
        periodId,
        room:      body?.room?.trim() || null,
        version:   1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return {
        collection: "timetableSlot",
        doc,
        request: {
          method: "POST",
          path:   "/api/admin/timetable",
          body:   { ...body, _id: id, schoolId },
        },
        response: {
          status: 201,
          data:   { success: true, slot: doc },
        },
      };
    },
  },

  {
    route: "PUT /api/admin/timetable/:id",

    /**
     * Editing a slot offline. Only what the caller sent — merged, not replaced.
     *
     * The existing handler called docs.put() directly, bypassing the outbox.
     * Fixed to queue the request so the change reaches the server.
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("timetable.manage")) return null;

      const slot = slotOf(docs, schoolId, params.id);
      if (!slot) return null;

      const clientVersion = body?.version;
      if (clientVersion !== undefined && slot.version !== Number(clientVersion)) {
        return null;
      }

      const newDay = body?.dayOfWeek !== undefined ? toDay(body.dayOfWeek) : slot.dayOfWeek;
      if (body?.dayOfWeek !== undefined && !newDay) return null;

      const next = {
        classId:   body?.classId   !== undefined ? String(body.classId).trim()  : slot.classId,
        subjectId: body?.subjectId !== undefined ? String(body.subjectId).trim() : slot.subjectId,
        teacherId: body?.teacherId !== undefined ? String(body.teacherId).trim()  : slot.teacherId,
        periodId:  body?.periodId  !== undefined ? String(body.periodId).trim()  : slot.periodId,
        dayOfWeek: newDay,
        room:      body?.room      !== undefined ? (body.room?.trim() || null)    : slot.room,
      };

      const clash = conflictFor(docs, next, slot._id);
      if (clash) return null;

      const doc = {
        ...slot,
        ...next,
        version:   slot.version + 1,
        updatedAt: nowISO(),
      };

      return {
        collection: "timetableSlot",
        doc,
        request: {
          method: "PUT",
          path:   `/api/admin/timetable/${slot._id}`,
          body:   { ...body, schoolId },
        },
        response: {
          status: 200,
          data:   { success: true, slot: doc },
        },
      };
    },
  },

  {
    route: "DELETE /api/admin/timetable/:id",

    /**
     * Soft-deleting a slot offline. deletedAt is stamped, version bumps.
     *
     * The existing handler called docs.put() directly, bypassing the outbox.
     * Fixed to queue the request so the deletion reaches the server.
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;
      if (!session?.permissions?.includes("timetable.manage")) return null;

      const slot = slotOf(docs, schoolId, params.id);
      if (!slot) return null;

      const when = nowISO();
      const doc = {
        ...slot,
        deletedAt: when,
        version:   slot.version + 1,
        updatedAt: when,
      };

      return {
        collection: "timetableSlot",
        doc,
        request: {
          method: "DELETE",
          path:   `/api/admin/timetable/${slot._id}` +
            (schoolId ? `?schoolId=${encodeURIComponent(schoolId)}` : ""),
          body:   null,
        },
        response: {
          status: 200,
          data:   { success: true, message: "Slot removed from timetable" },
        },
      };
    },
  },
];
