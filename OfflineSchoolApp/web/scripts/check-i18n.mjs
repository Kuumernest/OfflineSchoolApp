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
