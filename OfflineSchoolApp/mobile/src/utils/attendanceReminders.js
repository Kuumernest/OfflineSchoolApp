// mobile/src/utils/attendanceReminders.js
//
// The attendance reminder, from the day's classes to the register it opens.
//
// ── What went wrong ─────────────────────────────────────────────────────────
//
// The dashboard showed one card, "Attendance not marked for N classes today",
// and sent the teacher to /teacher/attendance/mark with no parameters. That
// screen takes its class from its parameters and nothing else, so it opened
// with no class, no pupils and a heading that said "Class". The card knew a
// count; it had thrown away which classes.
//
// ── What this module decides ────────────────────────────────────────────────
//
// Pure functions, so the check suite can run them without a screen:
//
//   buildAttendanceReminders  the day's classes → one reminder per class that
//                             has no register yet, carrying the class id, its
//                             names, the period and the DATE it is for
//   reminderRoute             a reminder → the navigation the dashboard pushes
//   resolveRegisterTarget     the register screen's parameters + the teacher's
//                             scope → the class it may open, or the reason not
//
// Authorisation is not decided here. The server refuses a register for a class
// the teacher holds no active assignment to (attendance.routes.js,
// utils/teacherScope.js). resolveRegisterTarget decides what the SCREEN
// offers: a teacher tapping a stale reminder — or a hand-built route — for a
// class no longer theirs is shown a safe state rather than a register the
// server would refuse on save.

export const REGISTER_ROUTE = "/teacher/attendance/mark";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (s) => ISO_DATE.test(String(s ?? ""));

export const todayIso = () => new Date().toISOString().slice(0, 10);

/** past outranks current outranks upcoming: the class most overdue leads. */
const URGENCY = { past: 0, current: 1, upcoming: 2 };

const minutesOf = (time) => {
  const m = String(time ?? "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  let h = parseInt(m[1], 10);
  const ampm = (m[3] || "").toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
};

/**
 * One reminder per class that has no register for the day.
 *
 * @param {object}   args
 * @param {Array}    args.todayClasses     the day's slots, each with at least
 *                                         classId; className, subjectName,
 *                                         subjectId, periodId, startTime,
 *                                         endTime, status, attendanceMarked
 *                                         are carried when present
 * @param {Iterable} [args.markedClassIds] classes that already have a register
 *                                         for the date (the phone's own rows)
 * @param {string}   [args.date]           the register's date, YYYY-MM-DD
 * @returns {Array<{classId:string, className:string|null, subjectName:string|null,
 *   subjectId:string|null, periodId:string|null, startTime:string|null,
 *   endTime:string|null, status:string, date:string}>}
 */
export const buildAttendanceReminders = ({ todayClasses, markedClassIds, date } = {}) => {
  const marked = new Set([...(markedClassIds ?? [])].map(String));
  const day    = isIsoDate(date) ? date : todayIso();
  const byClass = new Map();

  for (const slot of Array.isArray(todayClasses) ? todayClasses : []) {
    const classId = slot?.classId ? String(slot.classId) : null;
    if (!classId) continue;                       // a slot with no class opens nothing
    if (slot.attendanceMarked === true) continue; // the server says the register exists
    if (marked.has(classId)) continue;            // the phone's own rows say so

    const candidate = {
      classId,
      className:   slot.className   || null,
      subjectName: slot.subjectName || null,
      subjectId:   slot.subjectId ? String(slot.subjectId) : null,
      periodId:    slot.periodId  ? String(slot.periodId)  : null,
      startTime:   slot.startTime || null,
      endTime:     slot.endTime   || null,
      status:      URGENCY[slot.status] !== undefined ? slot.status : "upcoming",
      date:        day,
    };

    // Two slots of one class on one day are one register: keep the more
    // overdue, then the earlier.
    const held = byClass.get(classId);
    if (!held) { byClass.set(classId, candidate); continue; }
    const a = URGENCY[candidate.status], b = URGENCY[held.status];
    if (a < b || (a === b && minutesOf(candidate.startTime) < minutesOf(held.startTime))) {
      byClass.set(classId, candidate);
    }
  }

  return [...byClass.values()].sort((x, y) => {
    const u = URGENCY[x.status] - URGENCY[y.status];
    return u !== 0 ? u : minutesOf(x.startTime) - minutesOf(y.startTime);
  });
};

/** The translation key for a reminder's wording, by how late it is. */
export const reminderMessageKey = (status) =>
  status === "past"    ? "teacherHome.attendanceReminderPast"
  : status === "current" ? "teacherHome.attendanceReminderCurrent"
  :                        "teacherHome.attendanceReminderUpcoming";

/**
 * The navigation a reminder pushes: the register screen, told which class,
 * which date and which period it is for. Strings only — expo-router
 * parameters are strings — and nothing the screen cannot use.
 */
export const reminderRoute = (reminder) => {
  const params = { classId: String(reminder.classId), date: reminder.date, source: "reminder" };
  if (reminder.className)   params.className   = String(reminder.className);
  if (reminder.periodId)    params.periodId    = String(reminder.periodId);
  if (reminder.subjectName) params.subjectName = String(reminder.subjectName);
  return { pathname: REGISTER_ROUTE, params };
};

const ADMIN_ROLES = new Set(["super_admin", "school_admin"]);

/**
 * Which register the screen may open, from its parameters and the teacher's
 * canonical scope (teacherScope.service: the server's TeacherAssignment rows,
 * cached for offline).
 *
 * A teacher is offered a class only if their scope lists it — the same rows
 * the server checks on save, so a stale reminder for a class that is no longer
 * theirs, or a route somebody typed, is refused here before a register is
 * drawn. An administrator holds attendance.mark for the whole school and is
 * assigned to no class; they pass on the class the route named.
 *
 * The date is the reminder's own when it is a real date; anything else is
 * today. A register is never silently moved to another day.
 *
 * @returns {{classId:string|null, className:string|null, date:string,
 *   periodId:string|null, authorized:boolean, reason:string|null}}
 */
export const resolveRegisterTarget = ({ params, scope, role, today } = {}) => {
  const classId = params?.classId ? String(params.classId) : null;
  const date    = isIsoDate(params?.date) ? String(params.date) : (isIsoDate(today) ? today : todayIso());
  const periodId = params?.periodId ? String(params.periodId) : null;
  const named   = params?.className ? String(params.className) : null;

  if (!classId) {
    return { classId: null, className: named, date, periodId, authorized: false, reason: "no_class" };
  }

  if (ADMIN_ROLES.has(String(role ?? ""))) {
    return { classId, className: named, date, periodId, authorized: true, reason: null };
  }

  const inScope = (scope?.classes ?? []).find((c) => String(c?.id ?? c?._id ?? "") === classId);
  if (!inScope) {
    return { classId, className: named, date, periodId, authorized: false, reason: "not_assigned" };
  }

  return {
    classId,
    className:  inScope.name || named,
    date,
    periodId,
    authorized: true,
    reason:     null,
  };
};

export default {
  REGISTER_ROUTE, isIsoDate, todayIso,
  buildAttendanceReminders, reminderMessageKey, reminderRoute, resolveRegisterTarget,
};
