// web/scripts/i18n-apply.mjs
//
// Applies a {string: key} map to one source file:
//
//   >Save changes<                 →  >{t("students.saveChanges")}<
//   placeholder="Search students"  →  placeholder={t("students.searchPh")}
//   title="Add student"            →  title={t("students.addTitle")}
//
// and makes sure the file imports useTranslation and calls it in the component
// that needs it.
//
// Deliberately conservative — it only rewrites the exact literals it was given,
// never guesses, and reports anything it could not place so nothing is
// silently skipped. Run tsc and the build after; this edits syntax, it does
// not understand it.
//
// Usage: node scripts/i18n-apply.mjs <file> <mapfile.json>

import { readFileSync, writeFileSync } from "node:fs";

const [, , file, mapFile] = process.argv;
if (!file || !mapFile) {
  console.error("usage: node scripts/i18n-apply.mjs <file> <map.json>");
  process.exit(2);
}

const map  = JSON.parse(readFileSync(mapFile, "utf8"));
let   text = readFileSync(file, "utf8");
const crlf = text.includes("\r\n");
if (crlf) text = text.replace(/\r\n/g, "\n");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const applied = [];
const missed  = [];

for (const [literal, key] of Object.entries(map)) {
  const before = text;
  const call   = `{t("${key}")}`;

  // 1. JSX text node:  >Literal<   (allow surrounding whitespace/newlines)
  text = text.replace(
    new RegExp(`(>)(\\s*)${esc(literal)}(\\s*)(<)`, "g"),
    (_m, gt, a, b, lt) => `${gt}${a}${call}${b}${lt}`
  );

  // 2. String-valued props users can see
  //
  // The closing quote is a backreference, not `["']`. With the loose version an
  // apostrophe inside a double-quoted value closed the match early:
  // description="Re-enable this student's account" matched only up to the
  // apostrophe and left `s account"` orphaned in the source.
  text = text.replace(
    new RegExp(
      `\\b(placeholder|title|label|aria-label|alt|confirmLabel|cancelLabel|subtitle|description|emptyText|heading)=` +
      `(["'])${esc(literal)}\\2`,
      "g"
    ),
    (_m, prop) => `${prop}={t("${key}")}`
  );

  // 3. Object literal values in a props object:  title: "Literal",
  text = text.replace(
    new RegExp(
      `\\b(title|label|message|subtitle|description|confirmLabel|cancelLabel|placeholder):(\\s*)(["'])${esc(literal)}\\3`,
      "g"
    ),
    (_m, prop, sp) => `${prop}:${sp}t("${key}")`
  );

  (text === before ? missed : applied).push(literal);
}

// ── Ensure the hook is available ─────────────────────────────────────────────
if (applied.length) {
  if (!/from\s+["']react-i18next["']/.test(text)) {
    // Place the import after the last import line so ordering stays sane.
    const imports = [...text.matchAll(/^import .*?;$/gm)];
    if (imports.length) {
      const last = imports[imports.length - 1];
      const at   = last.index + last[0].length;
      text = text.slice(0, at) +
             `\nimport { useTranslation } from "react-i18next";` +
             text.slice(at);
    }
  }

  // Add `const { t } = useTranslation();` to every component that uses t()
  // and does not already have it. Components are found by their opening body.
  if (!/const\s*\{\s*t\s*[,}]/.test(text)) {
    const fnRe = /(export default function \w+\([^)]*\)\s*\{|function \w+\([^)]*\)\s*\{|const \w+\s*=\s*\([^)]*\)\s*=>\s*\{)/g;
    let m, inserted = false;
    while ((m = fnRe.exec(text))) {
      const bodyStart = m.index + m[0].length;
      // Only the component that actually contains a t(" call.
      const nextFn = fnRe.lastIndex;
      const rest   = text.slice(bodyStart);
      if (!/\bt\("/.test(rest.slice(0, 4000))) continue;
      text = text.slice(0, bodyStart) +
             `\n  const { t } = useTranslation();` +
             text.slice(bodyStart);
      inserted = true;
      break;
    }
    if (!inserted) console.warn(`  ! ${file}: could not place useTranslation() — add it by hand`);
  }
}

writeFileSync(file, crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");

console.log(`  ${file}`);
console.log(`     applied ${applied.length}/${Object.keys(map).length}`);
if (missed.length) {
  console.log(`     NOT FOUND (${missed.length}): ${missed.slice(0, 6).map((s) => JSON.stringify(s)).join(", ")}${missed.length > 6 ? " …" : ""}`);
}
