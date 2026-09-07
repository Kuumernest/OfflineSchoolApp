// web/scripts/check-i18n.mjs
//
// Two failure modes that are invisible at runtime, because i18next falls back
// silently instead of throwing:
//
//   1. A key in en.json with no counterpart in fr.json. A francophone user
//      sees one English word in an otherwise French screen and reads it as a
//      bug, not as a missing translation.
//
//   2. A key referenced by t("…") that exists in neither file. The UI renders
//      the raw key — "quickActions.addStudter" — which is how a typo ships.
//
// Run: npm run i18n:check   (and in CI before a release)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname }                       from "node:path";
import { fileURLToPath }                       from "node:url";
import { dirname }                             from "node:path";

const root      = join(dirname(fileURLToPath(import.meta.url)), "..");
const localeDir = join(root, "src", "i18n", "locales");
const srcDir    = join(root, "src");

const BASE = "en";

// ── Load locales ─────────────────────────────────────────────────────────────
const load = (lang) =>
  JSON.parse(readFileSync(join(localeDir, `${lang}.json`), "utf8"));

const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v)
      ? flatten(v, key)
      : [key];
  });

const languages = readdirSync(localeDir)
  .filter((f) => extname(f) === ".json")
  .map((f) => f.replace(/\.json$/, ""));

const keysByLang = Object.fromEntries(
  languages.map((lang) => [lang, new Set(flatten(load(lang)))])
);

// ── Walk source for t("…") references ────────────────────────────────────────
const sourceFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "locales") walk(full);
    } else if ([".ts", ".tsx"].includes(extname(name))) {
      sourceFiles.push(full);
    }
  }
})(srcDir);

// t("a.b"), labelKey: "a.b" — only literals; a computed key cannot be checked
// statically and is deliberately out of scope.
const REF = /(?:\bt\(\s*|labelKey:\s*)["'`]([a-zA-Z][\w.]*\.[\w.]+)["'`]/g;

const referenced = new Map();
for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(REF)) {
    if (!referenced.has(m[1])) referenced.set(m[1], file.replace(root + "\\", "").replace(root + "/", ""));
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
let problems = 0;
const baseKeys = keysByLang[BASE];

for (const lang of languages.filter((l) => l !== BASE)) {
  const missing = [...baseKeys].filter((k) => !keysByLang[lang].has(k));
  const extra   = [...keysByLang[lang]].filter((k) => !baseKeys.has(k));

  if (missing.length) {
    problems += missing.length;
    console.error(`\n  ${lang}.json is missing ${missing.length} key(s) present in ${BASE}.json:`);
    for (const k of missing) console.error(`      ${k}`);
  }
  if (extra.length) {
    problems += extra.length;
    console.error(`\n  ${lang}.json has ${extra.length} key(s) not in ${BASE}.json:`);
    for (const k of extra) console.error(`      ${k}`);
  }
}

// ── Hard-coded English in the three places it actually hid ──────────────────
//
// Key parity and reference resolution are both about keys. Neither can see a
// string that never became a key, which is how "Name is required." shipped on
// the Edit Teacher page while the identical sentence sat translated in both
// locale files under teachersAdd.errNameRequired.
//
// A general "no string literals" rule over 300 files would be mostly false
// positives and would be switched off within a week. These three patterns are
// narrow on purpose: they are the positions this audit actually found defects
// in, and a capitalised literal in any of them is user-visible by construction.
//
//   errors.field = "…"      a validation message
//   toast({ title: "…" })   a notification somebody reads
//   setError("…")           an inline form or page error
//
// A literal that genuinely never reaches a user opts out with a comment on the
// same line or the line above:   // i18n-exempt: <reason>
const LITERAL_PATTERNS = [
  [/\b(?:errors|next)\.[A-Za-z_$][\w$]*\s*=\s*"([A-Z][^"]{3,})"/g, "validation message"],
  [/\btoast\(\s*\{[^{}]*?\btitle:\s*"([A-Z][^"]{3,})"/g,           "toast title"],
  [/\b(?:setError|setLoadError)\(\s*"([A-Z][^"]{3,})"/g,           "inline error"],

  /*
   * The two that let the classes screen through.
   *
   * Its Zod schemas sat at module scope, where there is no translator, so every
   * validation message on it was English whatever the app was set to. And its
   * buttons and modal titles were ternaries — {editing ? "Edit Class" : "Add
   * Class"} — which is not an assignment, not a toast and not a setError, so
   * none of the three rules above could see them.
   *
   * Both are narrow enough to be worth failing on. A Zod message is
   * user-visible by construction. A ternary whose BOTH branches are quoted
   * sentences is a rendered string in all but the rarest case, and the rare
   * case can say so with i18n-exempt.
   */
  [/\.(?:min|max|length|email|url|regex)\([^)]*?,\s*"([A-Z][^"]{3,})"\s*\)/g, "validation rule"],
  [/\brequired_error:\s*"([A-Z][^"]{3,})"/g,                                  "validation rule"],
  [/\?\s*"([A-Z][^"]{2,})"\s*:\s*"[A-Z][^"]{2,}"/g,                           "ternary label"],
];

const literals = [];
for (const file of sourceFiles) {
  const text  = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (const [re, kind] of LITERAL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const lineNo = text.slice(0, m.index).split(/\r?\n/).length;
      const here   = lines[lineNo - 1] ?? "";
      const above  = lines[lineNo - 2] ?? "";
      if (/i18n-exempt/.test(here) || /i18n-exempt/.test(above)) continue;
      literals.push({
        file: file.replace(root + "\\", "").replace(root + "/", ""),
        line: lineNo,
        kind,
        text: m[1],
      });
    }
  }
}

if (literals.length) {
  problems += literals.length;
  console.error(
    `\n  ${literals.length} hard-coded user-visible string(s) bypassing the translation system:`
  );
  for (const l of literals) {
    console.error(`      ${l.file}:${l.line}  (${l.kind})  ${JSON.stringify(l.text)}`);
  }
  console.error(`\n  Add the key to en.json and fr.json and call t(), or mark the line`);
  console.error(`  // i18n-exempt: <reason>  if it genuinely never reaches a user.`);
}

const unknown = [...referenced].filter(([key]) => !baseKeys.has(key));
if (unknown.length) {
  problems += unknown.length;
  console.error(`\n  ${unknown.length} key(s) used in code but defined in no locale file:`);
  for (const [key, file] of unknown) console.error(`      ${key}   ${file}`);
}

const total = baseKeys.size;
if (problems === 0) {
  console.log(`  i18n OK - ${total} keys, ${languages.length} languages, ${referenced.size} references resolved`);
  process.exit(0);
}
console.error(`\n  ${problems} problem(s) found\n`);
process.exit(1);
