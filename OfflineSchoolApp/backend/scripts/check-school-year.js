// backend/scripts/check-school-year.js
"use strict";

/**
 * The year every year picker opens on (B5, decided 2026-10-27): the school's
 * own setting, else the calendar's, September to August. Progression opened
 * on 2025/2026 for a school in 2026/2027. Pure; the desktop mirror's
 * school-info is checked against the same rule.
 *
 *   node scripts/check-school-year.js
 */

const { currentAcademicYearOf, calendarAcademicYear } = require("../../shared/academicYear");
const handlers = require("../../desktop/src/main/api/handlers/settings.js");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const OCT_27 = new Date("2026-10-27T10:00:00Z");
check("27 October 2026, no setting: 2026/2027 (not 2025/2026)", currentAcademicYearOf({}, OCT_27), "2026/2027");
check("August is still the year before", calendarAcademicYear(new Date("2026-08-31T10:00:00Z")), "2025/2026");
check("September starts the new year", calendarAcademicYear(new Date("2026-09-01T10:00:00Z")), "2026/2027");
check("the school's own setting wins, in either spelling",
  [currentAcademicYearOf({ settings: { academicYear: "2026-2027" } }, new Date("2027-10-01")),
   currentAcademicYearOf({ settings: { academicYear: "2025/2026" } }, OCT_27)],
  ["2026/2027", "2025/2026"]);

const info = handlers.find((h) => h.route === "GET /api/admin/school-info");
const docs = { get: (_c, id) => (id === "gva" ? { _id: "gva", name: "Green Valley", settings: { academicYear: "2026/2027" } } : null) };
const res = info.handler({ query: { schoolId: "gva" } }, { docs, session: { schoolId: "gva", role: "school_admin" } });
const body = res?.data?.school ?? res?.data;
check("the desktop's school-info carries the school's current year", body?.currentAcademicYear, "2026/2027");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
