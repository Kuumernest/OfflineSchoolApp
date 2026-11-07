// shared/attendance.js
"use strict";

/**
 * What identifies one attendance mark, defined once.
 *
 * ── The identity problem this solves ──────────────────────────────────────
 *
 * A student's attendance is stored one row per (school, class, subject,
 * period, student, day), and StudentAttendance has a unique index on exactly
 * that. So the endpoints upsert on those six fields: marking a register twice
 * corrects the row rather than adding one, which is right.
 *
 * But the row's _id was a fresh uuid, invented by whoever inserted first. That
 * is harmless while the server is the only writer and becomes a duplicate the
 * moment it is not:
 *
 *   a teacher marks a register on a desktop with no connection. The row goes
 *   into the local mirror with an id that machine invented, and the request is
 *   queued. Meanwhile somebody in the office marks the same class from the web,
 *   so the server already holds that row under a DIFFERENT id.
 *
 *   the queued request arrives. The upsert matches on the natural key and
 *   updates the server's row — correctly. Then the next pull delivers it, and
 *   now the mirror holds two rows for one child on one day: the one it wrote and
 *   the one it was sent.
 *
 * A register showing a pupil twice is bad, but a report counting them twice is
 * worse, because nobody sees it. So the id is DERIVED from the natural key
 * instead of invented. Both sides compute the same one, whoever writes first,
 * and the duplicate is not something to reconcile afterwards — it cannot happen.
 *
 * Existing rows are untouched: the upsert has always matched on the natural key
 * rather than the id, so a row inserted years ago under a uuid is still found
 * and updated. Only newly inserted rows get a derived id.
 *
 * Required by backend/src/routes/attendance.routes.js and by the desktop's
 * attendance handlers, so a change here changes both at once.
 */

const crypto = require("crypto");

/**
 * The statuses a mark may have — and there are TWO sets, not one.
 *
 * A pupil may be excused; a member of staff may be on leave. Neither value is
 * valid for the other, and both models enforce it with an enum, so using the
 * wrong set means either refusing a mark the server accepts or queueing one it
 * will reject.
 *
 * Named for whose they are rather than sharing one ambiguous STATUSES, because
 * the two code paths are otherwise near-identical and a constant that reads as
 * "the statuses" is exactly how the wrong one gets used.
 */
const STUDENT_STATUSES = ["present", "absent", "late", "excused"];
const TEACHER_STATUSES = ["present", "absent", "late", "on_leave"];

/** Today, as the calendar day the register is for. */
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * A calendar day from a request, as "YYYY-MM-DD".
 *
 * ── Forgiving on purpose, and identically on both sides ───────────────────
 *
 * Nothing supplied means today, and so does anything unparseable. That is the
 * endpoint's behaviour and it is deliberately reproduced rather than tightened:
 * if the desktop refused what the server accepts, a queued register would be
 * written locally against one day and applied on the server against another, and
 * the two would disagree about who was present with nothing to show why.
 */
const dateStr = (d) => {
  if (!d) return todayStr();
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? todayStr() : parsed.toISOString().slice(0, 10);
};

/**
 * The seven days a weekly report covers, oldest first and ending today.
 *
 * ── Shared because the arithmetic is stranger than it looks ───────────────
 *
 * setDate() moves a LOCAL calendar day; toISOString() then reads the result in
 * UTC. In a timezone east of Greenwich those disagree for part of every day, so
 * the window is not simply "today minus six" in either clock — it is whatever
 * this exact sequence produces.
 *
 * Two implementations of that, however carefully written, would differ for a few
 * hours a day and agree the rest of the time, which is the worst way for
 * anything to be wrong. One function instead.
 */
const lastSevenDays = () => {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
};

/**
 * The six fields that identify one mark, normalised.
 *
 * subjectId and periodId are null rather than absent when there is none — a
 * register taken for the whole day and one taken for a lesson are different
 * rows, and null is the value the unique index holds for the first.
 */
const naturalKey = ({ schoolId, classId, subjectId, periodId, studentId, date }) => ({
  schoolId:  String(schoolId),
  classId:   String(classId),
  subjectId: subjectId ? String(subjectId) : null,
  periodId:  periodId  ? String(periodId)  : null,
  studentId: String(studentId),
  date:      dateStr(date),
});

/**
 * The id for a mark, derived from its natural key.
 *
 * Shaped like a uuid so it sits beside the ones already stored without anything
 * having to tell them apart, and version-5-flavoured — a hash of the key rather
 * than randomness — because the whole point is that two machines computing it
 * from the same register arrive at the same answer.
 *
 * The separator is a character that cannot appear in an id or a date, so no two
 * different keys can join into the same string.
 */
const attendanceId = (key) => {
  const k = naturalKey(key);
  const joined = [k.schoolId, k.classId, k.subjectId ?? "", k.periodId ?? "", k.studentId, k.date].join(" ");
  const hex = crypto.createHash("sha1").update(joined).digest("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // Version nibble 5: a name-based hash, which is what this is.
    "5" + hex.slice(13, 16),
    // Variant bits, as a uuid requires.
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
};

/**
 * The same, for a member of staff.
 *
 * TeacherAttendance is keyed on (school, teacher, day) — there is no subject,
 * because a teacher is present for the day rather than for a lesson. Given its
 * own function rather than a flag on the one above, so neither key can be built
 * with the wrong shape and quietly produce an id that belongs to the other.
 */
const teacherAttendanceId = ({ schoolId, teacherId, date }) => {
  const joined = ["teacher", String(schoolId), String(teacherId), dateStr(date)].join(" ");
  const hex = crypto.createHash("sha1").update(joined).digest("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "5" + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
};

/**
 * The days of a window the school is open (C3, decided 2026-10-27). The
 * weekly chart counted Saturday and Sunday as days nobody came. The school's
 * own `schoolDays` ("Monday" … "Sunday"), Monday to Friday when it has set
 * none. The weekday is the calendar date's, read in UTC as the date is stored.
 */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const schoolDaysOnly = (days, schoolDays) => {
  const open = new Set((Array.isArray(schoolDays) && schoolDays.length
    ? schoolDays : DAY_NAMES.slice(1, 6)).map((d) => String(d).trim().toLowerCase()));
  return (days || []).filter((day) =>
    open.has(DAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()].toLowerCase()));
};

/**
 * A day's attendance rate: present over the roster — or null when nobody was
 * marked (C3). 0% claims every pupil was away; "–" says the register was not
 * taken.
 */
const dayRate = (present, marked, roster) =>
  marked > 0 && roster > 0 ? Math.round((present / roster) * 100) : null;

module.exports = {
  schoolDaysOnly,
  dayRate,
  STUDENT_STATUSES,
  TEACHER_STATUSES,
  todayStr,
  dateStr,
  naturalKey,
  lastSevenDays,
  attendanceId,
  teacherAttendanceId,
};
