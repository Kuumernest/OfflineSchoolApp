// shared/dateFormat.js
//
// How a date and a time are written on every screen (C7, decided 2026-10-27):
//
//   date       27/10/2026         DD/MM/YYYY
//   time       14:05              HH:mm, 24-hour
//   date+time  27/10/2026 14:05
//
// The same in English and French — this is how a Cameroonian school writes a
// date on a register, a receipt or a report card, and "10/27/2026" from an
// en-US browser default is a different day to the person reading it.
//
// Plain functions, no Intl: the output must not depend on which locale data a
// browser or an Android build happens to ship.
//
// ES module so the web bundle can import it directly (see requestPath.js).

const pad = (n) => String(n).padStart(2, "0");

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A Date, or null for anything that is not one.
 *
 * A bare "2026-10-27" is a calendar day, not an instant: `new Date()` reads it
 * as UTC midnight, which west of Greenwich is the evening before. It is kept as
 * the local day it names.
 */
const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const m = DAY_ONLY.exec(value);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 27/10/2026, or the fallback ("—") when there is no date. */
const formatDay = (value, fallback = "—") => {
  const d = toDate(value);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : fallback;
};

/** 14:05, or the fallback. */
const formatTime = (value, fallback = "—") => {
  const d = toDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : fallback;
};

/** 27/10/2026 14:05, or the fallback. */
const formatDayTime = (value, fallback = "—") => {
  const d = toDate(value);
  return d ? `${formatDay(d)} ${formatTime(d)}` : fallback;
};

export { formatDay, formatTime, formatDayTime };
