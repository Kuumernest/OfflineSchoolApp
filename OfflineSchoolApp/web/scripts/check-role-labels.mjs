// web/scripts/check-role-labels.mjs
//
// A role is stored as one thing and shown as another, and only the second is
// translated.
//
// A francophone school admin switched the console to French and read "School
// Admin" under their own name in the sidebar and in the profile menu. The
// staff table on the settings page said "Administrateur de l'établissement"
// for the same person. The two rails were not translating anything: they
// printed the stored value, "school_admin", with its underscore swapped for a
// space and CSS capitalising each word. That reads as English in any language
// the console is set to, and no i18n check could see it, because nothing was
// missing — no key was referenced, so no key could be absent.
//
// So this pins the arrangement from both ends. The stored value stays what
// the API and the sync feed agree on. What a person reads comes from one map,
// utils/roleLabel, in both languages, and no rendered surface reaches for the
// stored value or a literal instead.
//
//   node scripts/check-role-labels.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  a === e ? ok(label) : bad(label, `got ${a}, expected ${e}`);
};

// ── The two locales, addressable by dotted key ──────────────────────────────
const locale = (lang) => JSON.parse(read(`src/i18n/locales/${lang}.json`));
const en = locale("en"), fr = locale("fr");
const get = (obj, key) => key.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// ── The one map ─────────────────────────────────────────────────────────────
const util = read("src/utils/roleLabel.ts");
const keyOf = (role) => (util.match(new RegExp(`^\\s*${role}:\\s*"([^"]+)"`, "m")) || [])[1];
const ROLE_KEYS = Object.fromEntries(
  [...util.matchAll(/^\s*([a-z_]+):\s*"([a-zA-Z]+\.[\w.]+)",?\s*$/gm)].map((m) => [m[1], m[2]])
);

console.log("--- the stored role and the shown role ---");

// 1. The internal value is untouched: it is what the types, the routes and the
//    backend enum all say, and the map is keyed by it rather than renaming it.
const INTERNAL = "school_admin";
check("the web's role union still carries the stored value",
  new RegExp(`\\|\\s*"${INTERNAL}"`).test(read("src/types/index.ts")), true);
check("and so does the backend's role list",
  read("../backend/src/config/roles.js").includes(INTERNAL), true);
check("the label map is keyed by the stored value, not a display name",
  Object.hasOwn(ROLE_KEYS, INTERNAL), true);

// 2. The key it maps to exists in both locales and says the right thing.
const KEY = keyOf(INTERNAL);
check("school_admin maps to a real key", typeof KEY, "string");
check("en displays School Admin",
  get(en, KEY), "School Admin");
check("fr displays Administrateur de l'établissement",
  get(fr, KEY), "Administrateur de l'établissement");

// 3. Every role the map names resolves in both languages — a key present in
//    en and missing in fr is exactly the half-translated screen this is for.
for (const [role, key] of Object.entries(ROLE_KEYS)) {
  check(`${role} → ${key} exists in en`, typeof get(en, key), "string");
  check(`${role} → ${key} exists in fr`, typeof get(fr, key), "string");
}
check("every stored role has a label",
  ["super_admin", "school_admin", "bursar", "teacher", "student"]
    .filter((r) => !ROLE_KEYS[r]), []);

// 4. One French wording for the role. The settings page and the two rails read
//    settings.schoolAdmin; the platform pages, which appoint the role, keep
//    their own key but say the same thing. Any third spelling — "d'école",
//    "de l'école", "d'établissement" — is what this catches.
const frValues = [], variants = [];
(function walk(obj, prefix = "") {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") walk(v, key);
    else if (/^Administrateur de l['’]établissement$/.test(String(v))) frValues.push(key);
    else if (/^Administrateur (d['’]|de l['’])(école|établissement)$/i.test(String(v))) variants.push(`${key}=${v}`);
  }
})(fr);
check("the French label for the role lives under the two keys that name it",
  frValues, [KEY, "platform.schools.roleAdmin"]);
check("and under no other spelling", variants, []);

console.log("--- every surface reads the map ---");

// The surfaces a school admin sees themself on. Each must import the shared
// label and none may fall back to the stored value dressed up as a word.
const SURFACES = [
  "src/components/layout/Sidebar.tsx",
  "src/components/layout/TopBar.tsx",
  "src/pages/settings/SettingsPage.tsx",
];
for (const file of SURFACES) {
  const src = read(file);
  check(`${file} imports roleLabel`,
    /import\s*\{\s*roleLabel\s*\}\s*from\s*"@\/utils\/roleLabel"/.test(src), true);
  check(`${file} does not print the stored value with the underscore swapped out`,
    /role\??\.replace\(\s*["']_["']/.test(src), false);
  check(`${file} keeps no label map of its own`,
    /const ROLE_LABEL_KEYS/.test(src), false);
}

// No literal "School Admin" anywhere in rendered code. Comments are stripped
// first: this codebase explains itself in prose, and the prose is allowed to
// name the bug. The brand mark in the sidebar, "SchoolAdmin" as one word, is
// the product's name and not a role, and is not what this looks for.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const offenders = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { if (name !== "locales") walk(full); continue; }
    if (![".ts", ".tsx"].includes(path.extname(name))) continue;
    const code = stripComments(fs.readFileSync(full, "utf8"));
    if (/["'>]School [Aa]dmin["'<]/.test(code)) offenders.push(path.relative(ROOT, full));
  }
})(path.join(ROOT, "src"));
check("no hard-coded \"School Admin\" survives in the translated UI", offenders, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
