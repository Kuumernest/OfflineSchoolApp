// mobile/scripts/check-l10n-strings.js
"use strict";

/**
 * The sentences the assignment screens render, asserted in both languages.
 *
 * The web audit found "Currently assigned to 8 subjects" assembled in the
 * markup — a word, a count, a word and `n !== 1 ? "s" : ""` — and the same
 * three screens exist on the phone with the same sentences in them. Key parity
 * (scripts/check-i18n.js) cannot see a sentence that never became a key, so
 * this renders the keys through i18n-js the way the app does and asserts what
 * a francophone teacher reads, then refuses the hand-rolled plural anywhere
 * under app/.
 *
 *   node scripts/check-l10n-strings.js
 */

const fs   = require("fs");
const path = require("path");
const { I18n } = require("i18n-js");

const ROOT = path.join(__dirname, "..");
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/locales/en.json"), "utf8"));
const fr = JSON.parse(fs.readFileSync(path.join(ROOT, "src/i18n/locales/fr.json"), "utf8"));

const i18n = new I18n({ en, fr });
i18n.enableFallback = false;
const T = (lng, key, opts) => { i18n.locale = lng; return i18n.t(key, opts); };

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

console.log("--- the assignment wizard, in both languages ---");
check("en: assigned",                 T("en", "assignList.assigned"), "Assigned");
check("en: 8 subjects",               T("en", "assignWork.currentlyAssigned", { count: 8 }), "Currently assigned to 8 subjects");
check("en: 1 subject",                T("en", "assignWork.currentlyAssigned", { count: 1 }), "Currently assigned to 1 subject");
check("fr: 8 subjects",               T("fr", "assignWork.currentlyAssigned", { count: 8 }), "8 matières déjà affectées");
check("fr: 1 subject",                T("fr", "assignWork.currentlyAssigned", { count: 1 }), "1 matière déjà affectée");
check("en: assigned to a teacher",    T("en", "assignWork.successBody", { count: 2, teacher: "Mrs. Grace Johnson" }), "2 subjects assigned to Mrs. Grace Johnson");
check("fr: assigned to a teacher, not English",
  T("fr", "assignWork.successBody", { count: 2, teacher: "X" }) !== T("en", "assignWork.successBody", { count: 2, teacher: "X" }), true);
check("en: the step counter",         T("en", "assignWork.stepOf", { step: 2, total: 4 }), "Step 2 of 4");
check("fr: the step counter",         T("fr", "assignWork.stepOf", { step: 2, total: 4 }), "Étape 2 sur 4");
check("fr: subjects assigned count",  T("fr", "assignList.subjectsAssignedCount", { count: 3 }), "3 matières affectées");
check("fr: one subject assigned",     T("fr", "assignList.subjectsAssignedCount", { count: 1 }), "1 matière affectée");

console.log("--- the roles ---");
check("en: School Admin", T("en", "adminSettings.roleSchoolAdmin") !== undefined && !/missing/.test(T("en", "adminSettings.roleSchoolAdmin")), true);
check("fr: School Admin is French", /Administrateur/.test(T("fr", "adminSettings.roleSchoolAdmin")), true);
check("fr: Super Admin is French",  /administrateur/i.test(T("fr", "adminSettings.roleSuperAdmin")), true);

console.log("--- the source no longer assembles these itself ---");
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (/\.jsx?$/.test(name)) files.push(full);
  }
})(path.join(ROOT, "app"));
// Comments and developer log lines may say "3 subject(s)"; rendered text may not.
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
  // A log statement, including one whose text runs onto the next lines.
  .replace(/console\.(?:log|warn|error|info|debug)\((?:[^()]|\([^()]*\))*\)/g, "");
const literals = ["Currently assigned to {", "Step {step.id} of 4", "Review {selectedSubjects.length} Selection", "this teacher\"", " subject(s)", " student(s)", " teacher(s)"];
const found = [], plurals = [];
for (const f of files) {
  const text = strip(fs.readFileSync(f, "utf8"));
  const rel  = path.relative(ROOT, f).replace(/\\/g, "/");
  for (const lit of literals) if (text.includes(lit)) found.push(`${rel}: ${lit}`);
  text.split("\n").forEach((line, i) => {
    if (/\?\s*""\s*:\s*"s"|\?\s*"s"\s*:\s*""|\?\s*"es"\s*:\s*""|\?\s*""\s*:\s*"es"/.test(line)) plurals.push(`${rel}:${i + 1}`);
  });
}
check("none of the audited literals survive", found, []);
check("no hand-rolled English plural remains", plurals, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
