// web/scripts/check-staff-number.mjs
//
// The teacher's staff number on the console: shown in the list (and found by
// search), shown and overridable on the edit screen, and checked here by the
// same rules the server applies.
//
//   RULES     src/utils/staffNo.ts against the backend's own normaliseStaffNo
//             (services/staffNumber.service.js), input for input: the console
//             must not refuse what the server accepts, nor send what it refuses
//   WIRING    the normaliser carries staffNo; the list shows and searches it;
//             the edit form loads it, sends it only when changed, puts a 409
//             under the field, and is online-only on the desktop like every
//             other teacher edit
//   I18N      every key used, in English and French
//
//   node scripts/check-staff-number.mjs

import fs     from "node:fs";
import path   from "node:path";
import url    from "node:url";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// ── RULES ────────────────────────────────────────────────────────────────────
console.log("--- the console's rules are the server's ---");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const src = read("src/utils/staffNo.ts");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
const web = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const backendRequire = createRequire(path.join(ROOT, "..", "backend", "package.json"));
const server = backendRequire("./src/services/staffNumber.service.js");

const inputs = ["", "   ", "gva00-stf-007", " HR/2019-07 ", "A", "A".repeat(32), "A".repeat(33),
  "GVA 00", "-LEAD", "X#1", "é1", "OK.1_2", "/X"];
for (const raw of inputs) {
  const value = web.normaliseStaffNoInput(raw);
  const webOk = web.staffNoErrorKey(value) === null;
  const srv = server.normaliseStaffNo(raw);
  check(`${JSON.stringify(raw)}: same verdict and value`,
    [webOk, webOk ? value : null], [!srv.error, srv.error ? null : srv.value]);
}
check("the same maximum", web.STAFF_NO_MAX, server.MAX_LENGTH);

// ── WIRING ───────────────────────────────────────────────────────────────────
console.log("--- wiring ---");
const svc   = read("src/services/teacher.service.ts");
const types = read("src/types/index.ts");
const list  = read("src/pages/teachers/TeachersPage.tsx");
const edit  = read("src/pages/teachers/EditTeacherPage.tsx");

check("Teacher declares staffNo", /export interface Teacher \{[\s\S]*?staffNo\?:\s*string \| null;[\s\S]*?\}/.test(types), true);
check("normaliseTeacher carries it", /staffNo:\s*raw\.staffNo\s*\?\?\s*null/.test(svc), true);
check("the list shows it", /\{teacher\.staffNo \|\|/.test(list), true);
check("  or says it is not assigned yet", list.includes('t("teachers.staffNoNone")'), true);
check("  and search finds a teacher by it", /t\.staffNo\?\.toLowerCase\(\)\.includes\(q\)/.test(list), true);
check("the edit form loads it", /setStaffNo\(t\.staffNo \?\? ""\)/.test(edit), true);
check("  has a field for it", /id="teacher-staff-no"[\s\S]{0,200}value=\{staffNo\}/.test(edit), true);
check("  sends it only when changed",
  /staffNoChanged\s*=\s*Boolean\(cleanStaffNo\) && cleanStaffNo !== \(teacher\?\.staffNo \?\? ""\)/.test(edit) &&
  /\.\.\.\(staffNoChanged \? \{ staffNo: cleanStaffNo \} : \{\}\)/.test(edit), true);
check("  validates with the shared rules", edit.includes("staffNoErrorKey(cleanStaffNo)"), true);
check("  puts a 409 under the field", /code === "STAFF_NO_TAKEN"[\s\S]{0,120}setErrors\(\{ staffNo:/.test(edit), true);
check("  is online-only on the desktop (save disabled, form fenced)",
  [/disabled=\{saving \|\| net\.blocked\}/.test(edit), /<NeedsInternet>\s*<section/.test(edit)], [true, true]);

// ── I18N ─────────────────────────────────────────────────────────────────────
console.log("--- i18n ---");
const used = new Set();
for (const text of [list, edit, src]) {
  for (const m of text.matchAll(/["'`]((?:teachers|teachersEdit)\.staffNo[A-Za-z]*|teachersEdit\.errStaffNo[A-Za-z]*)["'`]/g)) used.add(m[1]);
}
check("keys found", used.size >= 8, true);
for (const lang of ["en", "fr"]) {
  const dict = JSON.parse(read(`src/i18n/locales/${lang}.json`));
  const missing = [...used].filter((k) => {
    const [ns, key] = k.split(".");
    return typeof dict[ns]?.[key] !== "string" || !dict[ns][key].trim();
  });
  check(`${lang}: every staff-number key present`, missing, []);
}
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
const en = JSON.parse(read("src/i18n/locales/en.json"));
check("French is French, not a copy", fr.teachersEdit.staffNo !== en.teachersEdit.staffNo, true);
check("the 409 message names the number in both", [en, fr].map((d) => d.teachersEdit.errStaffNoTaken.includes("{{number}}")), [true, true]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
