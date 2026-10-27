// web/scripts/check-date-format.mjs
//
// C7 — one way to write a date and a time on every screen: DD/MM/YYYY and
// HH:mm (24-hour), in English and in French (shared/dateFormat.js).
//
//   - the shared helpers produce exactly that, with a "—" fallback
//   - a bare "2026-10-27" stays the 27th whatever the time zone
//   - the web formatters (fmt.date, fmt.dateTime, utils/formatDate) use them
//   - no screen formats a date with the browser's own default
//     (toLocaleDateString() / toLocaleString() / toLocaleTimeString() with no
//     options); the only Intl dates left are calendar labels (month, weekday)
//
//   node scripts/check-date-format.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { formatDay, formatTime, formatDayTime } =
  await import(pathToFileURL(path.join(ROOT, "..", "shared", "dateFormat.js")).href);

console.log("--- the shared helpers ---");
const at = new Date(2026, 9, 7, 9, 5);          // 7 Oct 2026, 09:05 local
check("a date is DD/MM/YYYY, zero-padded", formatDay(at), "07/10/2026");
check("a time is HH:mm, 24-hour", formatTime(new Date(2026, 9, 7, 14, 5)), "14:05");
check("a date and time together", formatDayTime(at), "07/10/2026 09:05");
check("a calendar day string stays that day", formatDay("2026-10-27"), "27/10/2026");
check("an ISO timestamp is read", formatDay(at.toISOString()), "07/10/2026");
check("nothing → —", [formatDay(null), formatDay(""), formatDayTime(undefined)], ["—", "—", "—"]);
check("garbage → the fallback given", formatDay("not a date", "Unknown"), "Unknown");

console.log("--- the web formatters use them ---");
const fmt = read("src/i18n/format.ts");
check("fmt.date and fmt.dateTime come from shared/dateFormat.js",
  /from "\.\.\/\.\.\/\.\.\/shared\/dateFormat\.js"/.test(fmt)
    && /formatDate = \([\s\S]*?=> formatDay\(value\)/.test(fmt)
    && /formatDateTime = \([\s\S]*?=> formatDayTime\(value\)/.test(fmt), true);
check("utils/formatDate does too", /formatDay\(value/.test(read("src/utils/formatDate.ts")), true);

console.log("--- no screen falls back on the browser's default ---");
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(ROOT, "src"));
const offenders = files.filter((f) =>
  /\.toLocale(Date|Time)String\(\)|\bDate\([^)]*\)\.toLocaleString\(\)|\bd\.toLocaleString\(\)/.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f));
check("no bare toLocaleDateString() / toLocaleTimeString() / date.toLocaleString()", offenders, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
