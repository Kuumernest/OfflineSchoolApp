// web/scripts/check-line-icons.mjs
//
// C7 — line icons only. Icons on screen are lucide line icons; colour emoji
// (📊 🖨️ ✅ ❌ 🗑️ 🏆 …) used as icons are not. Checks the web sources and
// both apps' locale files, ignoring comments. Single-colour text marks
// (✓ ✕ ✎ ★) are allowed.
//
//   node scripts/check-line-icons.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EMOJI = /[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]\u{FE0F}|\u{26A0}|\u{2705}|\u{274C}|\u{267B}|\u{23F3}/u;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx$/.test(e.name)) files.push(p);
  }
};
walk(path.join(ROOT, "src"));

const isComment = (line) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line) || /\/\/.*$/.test(line) && !EMOJI.test(line.replace(/\/\/.*$/, ""));
const inSources = [];
for (const f of files) {
  // Block comments blanked out, keeping their line breaks so numbers hold.
  const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  src.split("\n").forEach((line, i) => {
    if (EMOJI.test(line) && !isComment(line)) inSources.push(`${path.relative(ROOT, f)}:${i + 1}`);
  });
}
check("no colour emoji in web screens", inSources, []);

for (const rel of ["src/i18n/locales/en.json", "src/i18n/locales/fr.json",
                   "../mobile/src/i18n/locales/en.json", "../mobile/src/i18n/locales/fr.json"]) {
  const keys = [];
  const visit = (o, at) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") { if (EMOJI.test(v)) keys.push(`${at}${k}`); }
      else if (v && typeof v === "object") visit(v, `${at}${k}.`);
    }
  };
  visit(JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")), "");
  check(`no colour emoji in ${rel}`, keys, []);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
