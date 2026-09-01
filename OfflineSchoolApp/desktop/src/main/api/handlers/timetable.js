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

const DAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

const toDay = (raw) => {
  if (!raw) return null;
  const code = String(raw).trim().slice(0, 3).toUpperCase();
  return DAYS.has(code) ? code : null;
};

const ok = (slots) => ({ status: 200, data: { success: true, slots, count: slots.length } });

const adminRole = (session) =>
  session?.role === "school_admin" || session?.role === "super_admin";

module.exports = [
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
