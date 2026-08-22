// web/scripts/i18n-add.mjs
//
// Adds keys to en.json and fr.json in one go, keeping the two files in the
// same order so a diff between them stays readable.
//
// Usage:  node scripts/i18n-add.mjs '{"section.key": ["English", "Français"]}'
//     or  node scripts/i18n-add.mjs path/to/batch.json
//
// Refuses to overwrite an existing key — changing a translation is an edit
// someone should make deliberately, not a side effect of adding a new string.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname }                           from "node:path";
import { fileURLToPath }                           from "node:url";

const root      = join(dirname(fileURLToPath(import.meta.url)), "..");
const localeDir = join(root, "src", "i18n", "locales");

const arg = process.argv[2];
if (!arg) { console.error("usage: i18n-add.mjs <json | file>"); process.exit(2); }

const batch = JSON.parse(existsSync(arg) ? readFileSync(arg, "utf8") : arg);

const setDeep = (obj, path, value) => {
  const parts = path.split(".");
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
    node = node[p];
  }
  const leaf = parts[parts.length - 1];
  if (leaf in node) return false;      // never clobber
  node[leaf] = value;
  return true;
};

const files = { en: join(localeDir, "en.json"), fr: join(localeDir, "fr.json") };
const data  = Object.fromEntries(
  Object.entries(files).map(([lang, f]) => [lang, JSON.parse(readFileSync(f, "utf8"))])
);

let added = 0, skipped = 0;
for (const [key, value] of Object.entries(batch)) {
  const [en, fr] = Array.isArray(value) ? value : [value, value];
  const a = setDeep(data.en, key, en);
  const b = setDeep(data.fr, key, fr);
  if (a || b) added++; else skipped++;
}

for (const [lang, f] of Object.entries(files)) {
  writeFileSync(f, JSON.stringify(data[lang], null, 2) + "\n", "utf8");
}

console.log(`  keys added: ${added}${skipped ? `, already present: ${skipped}` : ""}`);
