// mobile/scripts/check-student-fees-screen.js
"use strict";

/**
 * The pupil's Fees screen reads the pupil's own ledger and nothing else.
 *
 * Static, like check-teacher-routes.js: the home offers the tile, the screen
 * exists, the service calls GET /student/fees — the route that answers the
 * signed-in account's own account with no pupil id to ask for — and never a
 * finance route (/fees/students/:id, /fees/outstanding) that a pupil is
 * refused; nothing on the screen records a payment; every string it shows is
 * in both languages. The server side is check-student-fees.js in backend/.
 *
 *   node scripts/check-student-fees-screen.js
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const home    = read("app/student/index.js");
const screen  = read("app/student/fees/index.js");
const service = read("src/services/studentFees.service.js");
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
const get = (obj, key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);

console.log("\n--- the way in ---");
check("the home offers a Fees tile that opens /student/fees", /route:\s*"\/student\/fees"/.test(home) && /studentHome\.qaFees/.test(home), true);

console.log("\n--- the pupil's own, read-only ---");
check("the service reads GET /student/fees", /api\.get\(\s*"\/student\/fees"/.test(service), true);
check("and names no pupil: no studentId is sent", /studentId/.test(service), false);
check("and never a finance route", /\/fees\/students|\/fees\/outstanding|\/fees\/structures|\/fees\/payments/.test(service + screen), false);
check("nothing writes: no POST, no outbox, no payment form", /api\.(post|put|patch|delete)|MutationQueue|recordPayment/.test(service + screen), false);
check("a lapsed sign-in is not answered from the cache", /status === 401\) throw err/.test(service), true);
check("the screen shows what the server answered: items, amounts, what was paid, what is owed, year and term", [
  /ledger\.charges\.map/.test(screen), /ledger\.payments\.map/.test(screen), /totals\.balance/.test(screen),
  /c\.academicYear/.test(screen), /studentFees\.term/.test(screen), /formatMoney\(/.test(screen),
], [true, true, true, true, true, true]);
check("the screen says payments are the office's to record", /studentFees\.askOffice/.test(screen), true);

console.log("\n--- every string in both languages ---");
const keys = [...new Set([...(screen + home).matchAll(/t\("([a-zA-Z.]+)"/g)].map((m) => m[1]))].filter((k) => /^(studentFees|fees|portal|studentHome\.qaFees|common)\./.test(k) || k === "studentHome.qaFees");
const missing = keys.filter((k) => typeof get(en, k) !== "string" || typeof get(fr, k) !== "string");
check(`the ${keys.length} keys the screen and the tile use exist in en and fr`, missing, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
