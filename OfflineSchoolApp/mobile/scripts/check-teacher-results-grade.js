// mobile/scripts/check-teacher-results-grade.js
"use strict";
/**
 * The teacher's class-results screen shows the letter the server graded, and
 * computes none of its own.
 *
 * The screen once carried a scale of its own — 90/80/70/60/50 on the
 * percentage — while every mark is graded once, at entry, on the school's
 * configured scale (shared/gradeScale through the server's grading service).
 * The two disagreed: 14/20 read "B" on the phone and "B+" on the report card,
 * 10/20 read "D" and "C". The rows GET /teacher/results returns carry `grade`;
 * this asserts the screen reads it and holds no threshold table. Static, like
 * check-teacher-routes.js: it reads the source, no device.
 *
 *   node scripts/check-teacher-results-grade.js
 */
const fs   = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const src = fs.readFileSync(path.join(ROOT, "app", "teacher", "results", "index.js"), "utf8");

console.log("\n--- the teacher results screen ---");
check("no local grade scale: no percentage threshold maps to a letter",
  /percentage >= \d+\)\s*return \{ grade:|>= 90[\s\S]{0,40}"A\+"|>= 80[\s\S]{0,40}"A"|>= 70[\s\S]{0,40}"B"/.test(src), false);
check("the letter comes from the row the server graded", [/const letterOf = \(result\) => \(\{\s*\r?\n\s*grade: result\?\.grade \|\| "—"/.test(src), (src.match(/letterOf\(result\)/g) ?? []).length], [true, 3]);
check("the distribution counts the letters the rows carry, with no fixed list of letters",
  [/const gradeDist = \{\};/.test(src), /if \(r\.grade\) gradeDist\[r\.grade\] = \(gradeDist\[r\.grade\] \|\| 0\) \+ 1;/.test(src), /gradeDist = \{ "A\+": 0/.test(src)], [true, true, false]);
check("the API loader keeps the server's grade on every row", /grade:\s+r\.grade\s+\?\? null,/.test(src), true);
// An import or a declared table would be a second scale; a comment naming the shared file is not.
const IMPORTS_SCALE = new RegExp("require\\([^)]*gradeScale|from\\s+[\"'][^\"']*gradeScale|\\bGRADE_SCALE\\b|\\bDEFAULT_GRADES\\b");
check("no scale table is imported or declared to grade on the phone", IMPORTS_SCALE.test(src), false);

// The server side of the contract, read from the repository: the route the
// screen calls is backed by StudentScore and carries `grade`.
const route = fs.readFileSync(path.join(ROOT, "..", "backend", "src", "routes", "teacher.routes.js"), "utf8");
const start = route.indexOf('router.get("/results"');
const handler = start >= 0 ? route.slice(start, route.indexOf("}));", start)) : "";
check("GET /teacher/results answers from StudentScore, scoped to assignment pairs, with the stored grade", [
  /require\("\.\.\/db\/models\/StudentScore"\)/.test(handler), /pairs\.has\(/.test(handler), /grade: sc\.grade \?\? null/.test(handler), /models\/Result"/.test(handler),
], [true, true, true, false]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
