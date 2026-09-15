// scripts/check-timetable-i18n.js
//
// Verifies that every timetable surface renders weekdays and periods through
// the i18n layer, and that stored/canonical weekday values remain
// language-neutral. Exits 1 on any failure.
//
//   node scripts/check-timetable-i18n.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", ".."); // OfflineSchoolApp
const fail = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg} (FAIL)`); fail.push(msg); };

const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const EN_WEEK = { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday" };
const FR_WEEK = { monday: "Lundi", tuesday: "Mardi", wednesday: "Mercredi", thursday: "Jeudi", friday: "Vendredi", saturday: "Samedi", sunday: "Dimanche" };
const EN_SHORT = { monShort: "Mon", tueShort: "Tue", wedShort: "Wed", thuShort: "Thu", friShort: "Fri", satShort: "Sat", sunShort: "Sun" };
const FR_SHORT = { monShort: "Lun", tueShort: "Mar", wedShort: "Mer", thuShort: "Jeu", friShort: "Ven", satShort: "Sam", sunShort: "Dim" };
/** Mobile uses the pre-existing uppercase short keys: mon/tue/… */
const EN_SHORT_MOB = { mon: "MON", tue: "TUE", wed: "WED", thu: "THU", fri: "FRI", sat: "SAT", sun: "SUN" };
const FR_SHORT_MOB = { mon: "LUN", tue: "MAR", wed: "MER", thu: "JEU", fri: "VEN", sat: "SAM", sun: "DIM" };
/** i18next-style {{var}} interpolation, matching how the apps render it. */
const interp = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k]));

// ── [1] English locale renders English weekday names ────────────────────────
console.log("\n[1] Weekday keys: English locale renders English names");
for (const app of ["mobile", "web"]) {
  const SHORTS = app === "mobile" ? EN_SHORT_MOB : EN_SHORT;
  const tt = readJSON(path.join(ROOT, app, "src/i18n/locales/en.json")).timetable;
  for (const [k, v] of Object.entries(EN_WEEK)) {
    if (tt[k] !== v) bad(`${app}/en timetable.${k} = "${tt[k]}", expected "${v}"`);
  }
  for (const [k, v] of Object.entries(SHORTS)) {
    if (tt[k] !== v) bad(`${app}/en timetable.${k} = "${tt[k]}", expected "${v}"`);
  }
}
ok("mobile+web en.json weekday keys are the English names");

// ── [2] French locale renders French weekday names ──────────────────────────
console.log("\n[2] Weekday keys: French locale renders French names");
for (const app of ["mobile", "web"]) {
  const SHORTS = app === "mobile" ? FR_SHORT_MOB : FR_SHORT;
  const tt = readJSON(path.join(ROOT, app, "src/i18n/locales/fr.json")).timetable;
  for (const [k, v] of Object.entries(FR_WEEK)) {
    if (tt[k] !== v) bad(`${app}/fr timetable.${k} = "${tt[k]}", expected "${v}"`);
  }
  for (const [k, v] of Object.entries(SHORTS)) {
    if (tt[k] !== v) bad(`${app}/fr timetable.${k} = "${tt[k]}", expected "${v}"`);
  }
}
ok("mobile+web fr.json weekday keys are the French names");

// ── [3] Generic period label: Period 1 / Période 1 ──────────────────────────
console.log("\n[3] Generic period label: Period 1 / Période 1");
for (const app of ["mobile", "web"]) {
  const en = readJSON(path.join(ROOT, app, "src/i18n/locales/en.json")).timetable.periodN;
  const fr = readJSON(path.join(ROOT, app, "src/i18n/locales/fr.json")).timetable.periodN;
  if (interp(en, { n: 1 }) !== "Period 1") bad(`${app}/en periodN(1) = "${interp(en, { n: 1 })}"`);
  if (interp(fr, { n: 1 }) !== "Période 1") bad(`${app}/fr periodN(1) = "${interp(fr, { n: 1 })}"`);
}
ok("periodN interpolates to 'Period 1' (en) and 'Période 1' (fr)");

// ── [4] Switching language changes every weekday/period label ───────────────
console.log("\n[4] Switching language changes every weekday/period label");
for (const app of ["mobile", "web"]) {
  const en = readJSON(path.join(ROOT, app, "src/i18n/locales/en.json")).timetable;
  const fr = readJSON(path.join(ROOT, app, "src/i18n/locales/fr.json")).timetable;
  const SHORT_KEYS = app === "mobile" ? Object.keys(EN_SHORT_MOB) : Object.keys(EN_SHORT);
  for (const k of Object.keys(EN_WEEK).concat(SHORT_KEYS)) {
    if (en[k] === fr[k]) bad(`${app}: timetable.${k} identical in en and fr ("${en[k]}") — label would not change on switch`);
  }
  if (en.periodN === fr.periodN) bad(`${app}: periodN identical in en and fr`);
}
ok("en/fr values differ for all weekday + period keys");

// ── [5] Stored / canonical weekday values stay language-neutral ─────────────
console.log("\n[5] Stored / canonical weekday values stay language-neutral");
{
  // Web canonical codes must be the backend alphabet, never localised text.
  const typesSrc = fs.readFileSync(path.join(ROOT, "web/src/types/timetable.types.ts"), "utf8");
  if (!/DAY_CODES = \["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"\]/.test(typesSrc))
    bad("web DAY_CODES no longer the canonical MON..SUN codes");
  // The key maps must hold translation keys, not labels.
  const keyVals = [...typesSrc.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  keyVals
    .filter((v) => /^(Monday|Lundi|Tuesday|Mardi|Wednesday|Mercredi|Thursday|Jeudi|Friday|Vendredi|Saturday|Samedi|Sunday|Dimanche|Mon|Lun|Tue|Mar|Wed|Mer|Thu|Jeu|Fri|Ven|Sat|Sam|Sun|Dim)$/.test(v))
    .forEach((v) => bad(`web timetable.types.ts contains literal label "${v}"`));
  ok("web DAY_CODES unchanged; label maps hold only translation keys");
  // Mobile admin builder speaks canonical "MON" codes to the DB.
  const builder = fs.readFileSync(path.join(ROOT, "mobile/app/admin/timetable/builder.js"), "utf8");
  if (!["MON", "TUE", "WED", "THU", "FRI"].every((c) => builder.includes(`key: "${c}"`)))
    bad("mobile admin builder no longer sends canonical MON..FRI codes");
  ok("mobile admin builder still stores canonical MON..FRI codes");
}

// ── [6] Source audit: no hardcoded weekday/period labels rendered in UI ─────
console.log("\n[6] Source audit: no hardcoded weekday/period labels rendered in UI");
const UI_FILES = [
  "mobile/app/student/timetable/index.js",
  "mobile/app/teacher/timetable/index.js",
  "mobile/app/admin/timetable/index.js",
  "mobile/app/admin/timetable/periods.js",
  "mobile/app/admin/timetable/builder.js",
  "mobile/app/admin/timetable/components/SlotEditorModal.js",
  "web/src/pages/timetable/index.tsx",
  "web/src/types/timetable.types.ts",
];
const DAY_NAME = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
const DAY_SHORT_LITERAL = /"(Mon|Tue|Wed|Thu|Fri|Sat|Sun)"/;
const PERIOD_LITERAL = /`Period \$\{|"Period \d|'Period \d/;
for (const rel of UI_FILES) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
  let inKeyMap = false; // whitelisted: internal canonical value map, not a label
  lines.forEach((line, i) => {
    const t0 = line.trim();
    if (/const DAY_KEY_MAP = \{/.test(t0)) inKeyMap = true;
    if (inKeyMap && /\};/.test(t0)) inKeyMap = false;
    if (inKeyMap) return;
    const isComment = t0.startsWith("//") || t0.startsWith("*") || t0.startsWith("/*");
    const isCanonicalArray = /const DAYS\s*=/.test(t0); // internal matching keys
    if (isComment || isCanonicalArray) return;
    if (DAY_NAME.test(t0)) bad(`${rel}:${i + 1} literal weekday name: ${t0.slice(0, 90)}`);
    if (DAY_SHORT_LITERAL.test(t0)) bad(`${rel}:${i + 1} literal short day: ${t0.slice(0, 90)}`);
    if (PERIOD_LITERAL.test(t0)) bad(`${rel}:${i + 1} hardcoded "Period N": ${t0.slice(0, 90)}`);
  });
}
ok("no hardcoded weekday/period label remains in the audited timetable files");

// ── [7] Timetable locale parity (en vs fr key sets) ─────────────────────────
console.log("\n[7] Timetable locale parity (en vs fr key sets)");
for (const app of ["mobile", "web"]) {
  const flat = (o, p = "", r = []) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") flat(v, p ? `${p}.${k}` : k, r);
      else r.push(p ? `${p}.${k}` : k);
    }
    return r;
  };
  const en = new Set(flat(readJSON(path.join(ROOT, app, "src/i18n/locales/en.json"))));
  const fr = new Set(flat(readJSON(path.join(ROOT, app, "src/i18n/locales/fr.json"))));
  const missingFr = [...en].filter((k) => !fr.has(k) && k.startsWith("timetable"));
  const missingEn = [...fr].filter((k) => !en.has(k) && k.startsWith("timetable"));
  if (missingFr.length) bad(`${app}: keys missing in fr.json: ${missingFr.join(", ")}`);
  if (missingEn.length) bad(`${app}: keys missing in en.json: ${missingEn.join(", ")}`);
}
ok("timetable namespace keys match across en/fr");

// ── [8] Key-map references resolve (web DAY_*_KEYS → locale keys) ───────────
console.log("\n[8] Key-map references resolve (web DAY_*_KEYS → locale keys)");
{
  const typesSrc = fs.readFileSync(path.join(ROOT, "web/src/types/timetable.types.ts"), "utf8");
  const keys = [...typesSrc.matchAll(/"(timetable\.[a-zA-Z]+)"/g)].map((m) => m[1]);
  const en = readJSON(path.join(ROOT, "web/src/i18n/locales/en.json")).timetable;
  const fr = readJSON(path.join(ROOT, "web/src/i18n/locales/fr.json")).timetable;
  keys.forEach((k) => {
    const short = k.replace("timetable.", "");
    if (!(short in en)) bad(`web en.json missing "${k}" (referenced from timetable.types.ts)`);
    if (!(short in fr)) bad(`web fr.json missing "${k}" (referenced from timetable.types.ts)`);
  });
  ok(`${keys.length} key-map references resolve in both locales`);
}

console.log(fail.length === 0
  ? "\ntimetable i18n OK — all checks passed\n"
  : `\ntimetable i18n FAILED — ${fail.length} problem(s)\n`);
process.exit(fail.length === 0 ? 0 : 1);
