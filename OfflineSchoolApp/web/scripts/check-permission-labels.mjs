// web/scripts/check-permission-labels.mjs
//
// The permissions screen shows words, never its own translation keys.
//
// The failure this pins: under most permissions the screen printed
// "permissions.note.fees.view", "permissions.note.expenses.manage" and so on.
// Only 30 of the 77 permissions carry a note, and the rest were looked up with
// `defaultValue: ""` — which i18n/index.ts turns into the key itself, because
// it sets returnEmptyString: false. A lookup that may legitimately find nothing
// has to ask whether the key exists.
//
// check-i18n.mjs resolves the literal keys in the source; it cannot see keys
// built from a template (`permissions.key.${r.key}`), which is every key on
// this screen. So this checks them against the server's own catalogue.
//
//   node scripts/check-permission-labels.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { PERMISSION_DEFS } = require(path.join(ROOT, "../backend/src/config/permissions.js"));
const modules = [...new Set(PERMISSION_DEFS.map((d) => d.module))];
const locked  = PERMISSION_DEFS.filter((d) => !d.delegable).map((d) => d.key);

for (const lang of ["en", "fr"]) {
  const p = JSON.parse(read(`src/i18n/locales/${lang}.json`)).permissions;
  console.log(`--- ${lang} ---`);
  check("every permission has a name", PERMISSION_DEFS.map((d) => d.key).filter((k) => !p.key?.[k]), []);
  check("every module has a heading", modules.filter((m) => !p.module?.[m]), []);
  check("every lock says why", locked.filter((k) => !p.note?.[k]), []);
  check("no note for a permission that does not exist",
    Object.keys(p.note ?? {}).filter((k) => !PERMISSION_DEFS.some((d) => d.key === k)), []);
}

console.log("--- the lookups ---");
const section = read("src/pages/settings/PermissionsSection.tsx");
check("a note is shown only when one exists", /i18n\.exists\(noteKey\)/.test(section), true);

// Anywhere in the console: with returnEmptyString: false an empty default is
// the key, so `defaultValue: ""` is always this bug waiting for a missing key.
const offenders = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && /defaultValue:\s*(""|'')/.test(fs.readFileSync(full, "utf8"))) {
      offenders.push(path.relative(ROOT, full));
    }
  }
};
walk(path.join(ROOT, "src"));
check("no translation is looked up with an empty default", offenders, []);
check("and the setting that makes it the key is still there",
  /returnEmptyString:\s*false/.test(read("src/i18n/index.ts")), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
