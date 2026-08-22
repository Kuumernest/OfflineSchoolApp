// backend/src/utils/idCardExpiry.js
"use strict";

/**
 * When a printed student ID card expires.
 *
 * Shared between the printing route and the settings screen so that the date
 * the admin is shown as "the default" is the same date that would actually be
 * printed. Two copies of this arithmetic would drift, and the drift would only
 * show up on a card already in a child's pocket.
 */

/**
 * The end of the academic year a school is currently in.
 *
 * Cameroonian school years run September to July, so a card printed in October
 * and one printed the following May must carry the same date. Taking "a year
 * from today" would give two children in the same class cards that expired
 * seven months apart.
 *
 * Noon UTC rather than midnight: this is a calendar day, and midnight lands on
 * the day before for anyone west of UTC once it is formatted locally.
 */
const academicYearEnd = (academicYear) => {
  const match = /(\d{4})\s*[/-]\s*(\d{4})/.exec(String(academicYear ?? ""));
  if (match) return new Date(Date.UTC(Number(match[2]), 7, 31, 12));

  const now = new Date();
  // September onward is the start of a year that ends the following calendar
  // year; before that, we are in the second half of a year already running.
  const endYear = now.getUTCMonth() >= 8
    ? now.getUTCFullYear() + 1
    : now.getUTCFullYear();
  return new Date(Date.UTC(endYear, 7, 31, 12));
};

/** A YYYY-MM-DD string as a Date at noon UTC, or null if it is not one. */
const parseDay = (value) => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!day) return null;

  const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12));
  // Rejects 2026-02-30, which the constructor would roll forward to 2 March
  // rather than refuse.
  return Number.isNaN(date.getTime())
      || date.getUTCMonth() !== Number(day[2]) - 1
      || date.getUTCDate() !== Number(day[3])
    ? null
    : date;
};

/** The date to print: the school's own if it set one, otherwise the default. */
const expiryFor = (school) =>
  parseDay(school?.settings?.idCardValidUntil) ?? academicYearEnd(school?.academicYear);

/** YYYY-MM-DD, for handing a date back to a date input. */
const toDayString = (date) => date.toISOString().slice(0, 10);

module.exports = { academicYearEnd, parseDay, expiryFor, toDayString };
