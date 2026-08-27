// mobile/scripts/check.js
"use strict";

/**
 * The mobile app's only automated safety net.
 *
 * There is no test runner here, no tsc pass over the JS, and no eslint config —
 * so until this existed, nothing checked the phone app at all. A syntax error in
 * a screen was found by opening that screen, and a French string missing from
 * the bundle was found by a francophone user.
 *
 * Two checks, both cheap and both catching real classes of mistake:
 *
 *   PARSE      every .js under app/ and src/ through babel-preset-expo. This is
 *              what the bundler will do, so a file that fails here cannot load
 *              on a device. It is the floor, not a type check.
 *
 *   LOCALES    en.json against fr.json, key for key. The web package has had
 *              this check for a while (scripts/check-i18n.mjs) and mobile never
 *              did, which is the more consequential gap of the two: on a phone
 *              a missing key renders as the raw key on screen, offline, with no
 *              console to notice it in.
 *
 *   node scripts/check.js
 */

const fs   = require("fs");
const path = require("path");
const babel = require("@babel/core");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok   = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad  = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(detail.split("\n").map((l) => "       " + l).join("\n"));
};

// ─────────────────────────────────────────────────────────────────────────────
// PARSE
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".expo", "assets", "scripts"]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|jsx)$/.test(e.name) ? [full] : [];
  });

const checkParse = () => {
  console.log("--- every screen and service parses ---");

  const preset = require.resolve("babel-preset-expo");
  const files  = ["app", "src"]
    .map((d) => path.join(ROOT, d))
    .filter((d) => fs.existsSync(d))
    .flatMap(walk);

  const broken = [];

  for (const file of files) {
    try {
      babel.parseSync(fs.readFileSync(file, "utf8"), {
        filename:   file,
        presets:    [preset],
        babelrc:    false,
        configFile: false,
      });
    } catch (err) {
      broken.push(
        `${path.relative(ROOT, file)}\n  ${err.message.split("\n")[0]}`
      );
    }
  }

  if (broken.length) bad(`${files.length} files, ${broken.length} will not parse`, broken.join("\n"));
  else ok(`${files.length} files parse`);
};

// ─────────────────────────────────────────────────────────────────────────────
// LOCALES
// ─────────────────────────────────────────────────────────────────────────────

/** Every leaf path in a nested object, as "a.b.c". */
const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v)
      ? flatten(v, key)
      : [key];
  });

const checkLocales = () => {
  console.log("--- en and fr say the same things ---");

  const dir = path.join(ROOT, "src", "i18n", "locales");
  const load = (lang) => {
    const file = path.join(dir, `${lang}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      bad(`${lang}.json is not valid JSON`, err.message);
      return undefined;
    }
  };

  const en = load("en");
  const fr = load("fr");

  if (en === null || fr === null) { bad("both en.json and fr.json must exist"); return; }
  if (!en || !fr) return;   // invalid JSON, already reported

  ok("both files are valid JSON");

  const enKeys = new Set(flatten(en));
  const frKeys = new Set(flatten(fr));

  // A key in en and not fr is the one that matters: i18n-js falls back to
  // English, so a francophone user gets one English line in a French screen and
  // reads it as a bug rather than a missing translation.
  const missingFr = [...enKeys].filter((k) => !frKeys.has(k));
  const missingEn = [...frKeys].filter((k) => !enKeys.has(k));

  if (missingFr.length) bad(`${missingFr.length} key(s) missing from fr.json`, missingFr.slice(0, 40).join("\n"));
  else ok("fr.json covers every English key");

  if (missingEn.length) bad(`${missingEn.length} key(s) missing from en.json`, missingEn.slice(0, 40).join("\n"));
  else ok("en.json covers every French key");

  // An empty string renders as nothing at all on screen, which reads as a
  // layout bug rather than a missing translation.
  const empties = [];
  const scan = (obj, lang, prefix = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) scan(v, lang, key);
      else if (typeof v === "string" && v.trim() === "") empties.push(`${lang}: ${key}`);
    }
  };
  scan(en, "en");
  scan(fr, "fr");

  if (empties.length) bad(`${empties.length} empty string(s)`, empties.slice(0, 20).join("\n"));
  else ok("no empty strings");

  console.log(`       ${enKeys.size} keys, 2 languages`);
};

// ─────────────────────────────────────────────────────────────────────────────

checkParse();
checkLocales();

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
