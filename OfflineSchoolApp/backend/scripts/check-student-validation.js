// backend/scripts/check-student-validation.js
"use strict";

/**
 * B3 (decided 2026-10-27), the pure rules: dates of birth, the age range per
 * class level (Form 1 9–14; each level up the minimum +1 and the maximum +2),
 * Cameroon phones as +237 and nine digits. The routes are exercised in
 * check-student-edit.js.
 *
 *   node scripts/check-student-validation.js
 */

const v = require("../../shared/studentValidation");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};
const NOW = new Date("2026-10-27T10:00:00Z");

console.log("--- date of birth ---");
check("in the future: refused", v.checkDateOfBirth("2026-10-28", NOW).error, "dateOfBirth cannot be in the future");
check("31 February: refused", v.checkDateOfBirth("2015-02-31", NOW).error, "dateOfBirth is not a real date");
check("an ISO timestamp from an older client: its date", v.checkDateOfBirth("2014-03-05T00:00:00.000Z", NOW).value, "2014-03-05");
check("blank: nothing to check", v.checkDateOfBirth("", NOW), { value: null });
check("age counts the birthday", [v.ageOn("2012-10-27", NOW), v.ageOn("2012-10-28", NOW)], [14, 13]);

console.log("--- the ranges (option b) ---");
check("Form 1 … Upper Sixth",
  ["Form 1", "Form 2", "Form 3", "Form 4", "Form 5", "Lower Sixth", "Upper Sixth"].map((c) => { const r = v.ageRangeFor(c); return `${r.min}-${r.max}`; }),
  ["9-14", "10-16", "11-18", "12-20", "13-22", "14-24", "15-26"]);
check("French names and streams read the same level",
  ["6ème", "5e B", "4e", "3e", "2nde C", "1ère D", "Tle A4", "Form 1A", "FORM TWO"].map((c) => v.levelOfClassName(c)),
  [1, 2, 3, 4, 5, 6, 7, 1, 2]);
check("a name with no level: no range, no warning", [v.ageRangeFor("Class 3"), v.ageRangeFor("Form 10"), v.ageWarning("2000-01-01", "Nursery", null, NOW)], [null, null, null]);
check("a school's own range wins for that level only",
  [v.ageRangeFor("Form 1", { 1: { min: 10, max: 13 } }), v.ageRangeFor("Form 2", { 1: { min: 10, max: 13 } })],
  [{ level: 1, min: 10, max: 13 }, { level: 2, min: 10, max: 16 }]);
check("17 in Upper Sixth: no warning", v.ageWarning("2009-01-01", "Upper Sixth", null, NOW), null);
check("4 in Form 1: a warning, never a refusal",
  (({ code, age, min, max }) => ({ code, age, min, max }))(v.ageWarning("2022-01-01", "Form 1", null, NOW)),
  { code: "age_out_of_range", age: 4, min: 9, max: 14 });

check("Settings' ranges: whole years 3–40, min ≤ max, levels 1–7; empty resets",
  [v.checkAgeRanges({ 1: { min: 10, max: 13 } }).value, Boolean(v.checkAgeRanges({ 1: { min: 14, max: 9 } }).error),
   Boolean(v.checkAgeRanges({ 8: { min: 9, max: 14 } }).error), v.checkAgeRanges({}).value, v.checkAgeRanges(null).value],
  [{ 1: { min: 10, max: 13 } }, true, true, null, null]);

console.log("--- phones ---");
check("every way a Cameroon number is typed → +237 and nine digits",
  ["677 12 34 56", "+237 677-123-456", "00237 677123456", "237677123456", "(+237) 222 12 34 56"].map((p) => v.normalisePhone(p).value),
  ["+237677123456", "+237677123456", "+237677123456", "+237677123456", "+237222123456"]);
check("too short, or not starting 6 or 2: refused",
  ["6771234", "123456789", "+237 67712"].map((p) => Boolean(v.normalisePhone(p).error)), [true, true, true]);
check("a foreign number keeps its own code", v.normalisePhone("+33 6 12 34 56 78").value, "+33612345678");

console.log("--- a whole form ---");
const r = v.checkStudentInput({ dateOfBirth: "2022-01-01", phone: "677123456", guardianPhone: "" }, { className: "Form 1", now: NOW });
check("stored forms, one warning, no errors",
  [r.errors, r.values, r.warnings.map((w) => w.code)],
  [[], { dateOfBirth: "2022-01-01", phone: "+237677123456", guardianPhone: null }, ["age_out_of_range"]]);
check("an error stops the warning",
  v.checkStudentInput({ dateOfBirth: "2099-01-01" }, { className: "Form 1", now: NOW }).warnings, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
