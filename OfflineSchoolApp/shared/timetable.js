// shared/timetable.js
//
// The week, as the timetable stores it.
//
// TimetableSlot.dayOfWeek is one of seven three-letter codes. The server has
// always matched "today" against them with `new Date().getDay()`; the staff
// register now matches an arbitrary attendance date the same way, and the
// desktop mirror answers the same question offline. One function, required by
// all three, so a Monday register can only ever mean Monday's slots.
"use strict";

const DAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * The timetable day code for a date.
 *
 *   dayCodeFor(new Date())     → the local weekday, as the server's "today"
 *                                has always been computed
 *   dayCodeFor("2026-09-14")   → "MON": the weekday of that calendar day,
 *                                wherever the process happens to run
 *   dayCodeFor("nonsense")     → null
 *
 * A "YYYY-MM-DD" string is read as a calendar day, not as an instant: parsed
 * as a local Date it would be Sunday evening on a server west of Greenwich.
 */
const dayCodeFor = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : DAY_CODES[value.getDay()];
  }
  const str = String(value ?? "").trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (ymd) {
    const d = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    return Number.isNaN(d.getTime()) ? null : DAY_CODES[d.getUTCDay()];
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : DAY_CODES[parsed.getDay()];
};

module.exports = { DAY_CODES, dayCodeFor };
