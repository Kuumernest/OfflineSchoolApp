// desktop/src/main/api/handlers/timetable.js
"use strict";

/**
 * The timetable, answered from the mirror.
 *
 * The sync feed mirrors TimetableSlot as collection "timetableSlot", so the
 * mirror holds the school's slots exactly as the server stores them — including
 * the nested subject/teacher/class objects the GET endpoints populate, because
 * the feed delivers the lean document and the server populates them at read
 * time. So the mirror holds the flat ids, and the handlers populate from the
 * subject, user and class collections just as the server does.
 *
 * ── Who sees what ─────────────────────────────────────────────────────────
 *
 * The server has two distinct read scopes: an admin asking for a class's week,
 * and a teacher asking for their own. The scope check is a ROLE check, not a
 * permission one — `isAdmin(user.role)` decides whether the query's teacherId
 * is honoured or the caller's own id replaces it. Reproduced: a session that is
 * not an admin gets their own schedule, and ?teacherId is ignored.
 */

const TT = require("../../../../../shared/timetableConflicts");
const { conflictContext } = require("../timetableConflicts");

const DAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

const toDay = (raw) => {
  if (!raw) return null;
  const code = String(raw).trim().slice(0, 3).toUpperCase();
  return DAYS.has(code) ? code : null;
};

const ok = (slots) => ({ status: 200, data: { success: true, slots, count: slots.length } });

const adminRole = (session) =>
  session?.role === "school_admin" || session?.role === "super_admin";

const langOf = (query) => (String(query?.lang ?? "").toLowerCase().startsWith("fr") ? "fr" : "en");

const localise = (list, lang) =>
  lang === "fr" ? list.map((c) => ({ ...c, message: TT.conflictMessage(c, "fr") })) : list;

const canManage = (session) => session?.permissions?.includes("timetable.manage");

module.exports = [
  {
    route: "GET /api/admin/timetable/conflicts",
    handler: ({ query }, { docs, session }) => {
      const schoolId = session?.schoolId || (query.schoolId ? String(query.schoolId).trim() : null);
      if (!schoolId || !canManage(session)) return null;
      const conflicts = localise(TT.detectConflicts(conflictContext(docs, schoolId)), langOf(query));
      return { status: 200, data: { success: true, conflicts, count: conflicts.length } };
    },
  },

  {
    route: "GET /api/admin/timetable/conflicts/options/:id",
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = session?.schoolId || (query.schoolId ? String(query.schoolId).trim() : null);
      if (!schoolId || !canManage(session)) return null;
      const ctx = conflictContext(docs, schoolId);
      if (!ctx.slots.some((s) => s._id === String(params.id))) {
        return { status: 404, data: { success: false, error: "Timetable slot not found" } };
      }
      return { status: 200, data: { success: true, ...TT.resolutionOptions(ctx, params.id) } };
    },
  },

  {
    // A read despite the verb: it answers, and stores nothing.
    route: "POST /api/admin/timetable/check",
    handler: ({ body, query }, { docs, session }) => {
      const schoolId = session?.schoolId || (body?.schoolId ? String(body.schoolId).trim() : null);
      if (!schoolId || !canManage(session)) return null;
      const conflicts = localise(TT.checkSlot(conflictContext(docs, schoolId), body ?? {}), langOf(query));
      return { status: 200, data: { success: true, conflicts, canForce: adminRole(session) } };
    },
  },

  {
    route: "GET /api/admin/timetable",
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // The server's role check: a non-admin is narrowed to their own slots
      // and the query's teacherId is ignored. A bursar holds timetable.view but
      // is not an admin — they see their own, which is none.
      const teacherId = adminRole(session)
        ? (query.teacherId ? String(query.teacherId).trim() : null)
        : String(session?.userId ?? "").trim();

      const filter = { schoolId, deletedAt: null };
      if (query.classId) filter.classId = String(query.classId).trim();
      if (teacherId) filter.teacherId = teacherId;

      const slots = docs.find("timetableSlot", filter)
        .sort((a, b) =>
          (a.dayOfWeek ?? "").localeCompare(b.dayOfWeek ?? "") ||
          (a.periodId ?? "").localeCompare(b.periodId ?? ""))
        .map((s) => {
          const { _pending, ...clean } = s;
          return clean;
        });

      return ok(slots);
    },
  },

  {
    route: "GET /api/admin/timetable/my-schedule",
    handler: ({ query }, { docs, session }) => {
      const teacherId = String(session?.userId ?? "").trim();
      if (!teacherId) return null;
      const schoolId = session?.schoolId
        ? String(session.schoolId).trim()
        : (query.schoolId ? String(query.schoolId).trim() : null);
      if (!schoolId) return null;

      const slots = docs.find("timetableSlot", { teacherId, schoolId, deletedAt: null })
        .sort((a, b) =>
          (a.dayOfWeek ?? "").localeCompare(b.dayOfWeek ?? "") ||
          (a.periodId ?? "").localeCompare(b.periodId ?? ""))
        .map((s) => {
          const { _pending, ...clean } = s;
          return clean;
        });

      return ok(slots);
    },
  },

  {
    route: "GET /api/admin/timetable/teacher/:teacherId",
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("timetable.view")) return null;

      const teacherId = String(params.teacherId).trim();
      const filter = { teacherId, schoolId, deletedAt: null };
      const day = toDay(query.weekDay);
      if (day) filter.dayOfWeek = day;

      const slots = docs.find("timetableSlot", filter)
        .sort((a, b) =>
          (a.dayOfWeek ?? "").localeCompare(b.dayOfWeek ?? "") ||
          (a.periodId ?? "").localeCompare(b.periodId ?? ""))
        .map((s) => {
          const { _pending, ...clean } = s;
          return clean;
        });

      return ok(slots);
    },
  },
];
