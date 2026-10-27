// OfflineSchoolApp/shared/academicYear.js
"use strict";

/**
 * Which academic year is "now".
 *
 * Cameroonian school years run September–July, so before September the year
 * that began last calendar year is still running. This is the fallback only:
 * a school's own current year (School.settings.academicYear) wins wherever it
 * is set — fees are billed under it.
 *
 * @param {Date} [now]
 * @returns {string} e.g. "2026/2027"
 */
function calendarAcademicYear(now = new Date()) {
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
}

/** "2026-2027" and "2026/2027" are the same year. */
const yearKey = (y) => String(y ?? "").trim().replace("-", "/");

/** A school's current year: its own setting, else the calendar's. */
const currentAcademicYearOf = (school, now = new Date()) =>
  yearKey(school?.settings?.academicYear) || calendarAcademicYear(now);

module.exports = { calendarAcademicYear, currentAcademicYearOf, yearKey };
