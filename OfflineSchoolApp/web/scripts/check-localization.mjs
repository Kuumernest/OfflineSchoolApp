// web/scripts/check-localization.mjs
//
// What a francophone admin actually reads, asserted by rendering it.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// The assignment wizard said "Currently assigned to 8 subjects" and "Assigned
// to Mrs. Grace Johnson" on a console set to French, and the sidebar said
// "School Admin". None of it was a missing key: the sentences were assembled
// in the markup — a word, a number, a word, and `count !== 1 ? "s" : ""` for
// the plural — so no key was referenced and the parity check had nothing to
// compare. A check that only inspects the locale files cannot see this.
//
// So this does two things the existing checks do not:
//
//   1. It runs i18next over the real locale files and asserts the rendered
//      sentence, with a count, in both languages. "8 matières déjà affectées"
//      is a different word order from "Currently assigned to 8 subjects", and
//      only the whole sentence being translated makes that possible.
//
//   2. It reads the source and refuses the shapes that bypass the translator:
//      the literal sentences this audit found, and the `? "s" : ""` plural
//      that English lets you get away with and French does not.
//
// Run: npm run check:l10n

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname, relative }    from "node:path";
import { fileURLToPath }                       from "node:url";
import i18next                                 from "i18next";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// The same engine the console runs, over the same files. No fallback
// language: a French key that is missing must come back as the key, not as
// English, or this could not tell the two apart.
await i18next.init({
  lng: "en",
  fallbackLng: false,
  resources: { en: { translation: en }, fr: { translation: fr } },
  interpolation: { escapeValue: false },
  returnNull: false,
});
const T = (lng, key, opts) => i18next.getFixedT(lng)(key, opts);
const frFlatAll = () => {
  const out = {};
  (function walk(o, p = "") {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === "object") walk(v, key); else out[key] = v;
    }
  })(fr);
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the assignment wizard, in both languages ---");

check("en: the badge",              T("en", "subjects.assigned"), "Assigned");
check("fr: the badge",              T("fr", "subjects.assigned"), "Affectées");
check("en: assigned to",            T("en", "assignments.assignedTo"), "Assigned to");
check("fr: assigned to",            T("fr", "assignments.assignedTo"), "Affectée à");

check("en: currently assigned to 8 subjects",
  T("en", "assignments.currentlyAssigned", { count: 8 }), "Currently assigned to 8 subjects");
check("en: and to 1 subject, singular",
  T("en", "assignments.currentlyAssigned", { count: 1 }), "Currently assigned to 1 subject");
check("fr: 8 subjects, in French word order",
  T("fr", "assignments.currentlyAssigned", { count: 8 }), "8 matières déjà affectées");
check("fr: and 1 subject, with feminine singular agreement",
  T("fr", "assignments.currentlyAssigned", { count: 1 }), "1 matière déjà affectée");

check("en: the per-class count",    T("en", "assignments.countAssigned", { count: 3 }), "3 assigned");
check("fr: the per-class count",    T("fr", "assignments.countAssigned", { count: 3 }), "3 affectées");
check("fr: and for one",            T("fr", "assignments.countAssigned", { count: 1 }), "1 affectée");
check("en: the step counter",       T("en", "assignments.stepOf", { step: 2, total: 4 }), "Step 2 of 4");
check("fr: the step counter",       T("fr", "assignments.stepOf", { step: 2, total: 4 }), "Étape 2 sur 4");
check("en: review selections",      T("en", "assignments.reviewSelection", { count: 2 }), "Review 2 selections");
check("fr: review selections",      T("fr", "assignments.reviewSelection", { count: 2 }), "Vérifier 2 sélections");
check("en: a subject count",        T("en", "academic.subjectCount", { count: 1 }), "1 subject");
check("fr: a subject count",        T("fr", "academic.subjectCount", { count: 2 }), "2 matières");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the roles ---");

check("en: School Admin",  T("en", "settings.schoolAdmin"),    "School Admin");
check("fr: School Admin",  T("fr", "settings.schoolAdmin"),    "Administrateur de l'établissement");
check("en: Super Admin",   T("en", "settings.roleSuperAdmin"), "Super Admin");
check("fr: Super admin",   T("fr", "settings.roleSuperAdmin"), "Super administrateur");
check("en: Bursar",        T("en", "settings.roleBursar"),     "Bursar");
check("fr: Bursar",        T("fr", "settings.roleBursar"),     "Économe");

// One French name for the role, wherever it is a label. The platform pages had
// their own key for it and their own wording; the wording is now the same.
check("fr: the platform's label for the role is the same one",
  T("fr", "platform.schools.roleAdmin"), "Administrateur de l'établissement");
const roleVariants = Object.entries(frFlatAll())
  .filter(([, v]) => /^Administrateur (d['’]|de l['’])(école|établissement)$/i.test(String(v)))
  .filter(([, v]) => v !== "Administrateur de l'établissement")
  .map(([k, v]) => `${k}=${v}`);
check("and no other spelling of it survives in French", roleVariants, []);

// The register toggle on the attendance page said "students" / "teachers" in
// every language: the stored value, capitalised by CSS.
check("en: the register toggle", T("en", "academic.student", { count: 2 }), "Students");
check("fr: the register toggle", T("fr", "academic.teacher", { count: 2 }), "Enseignants");

// Every role the label map names renders in both languages.
const util = read("src/utils/roleLabel.ts");
const roleKeys = [...util.matchAll(/^\s*([a-z_]+):\s*"([a-zA-Z]+\.[\w.]+)",?\s*$/gm)].map((m) => m[2]);
check("the label map names at least five roles", roleKeys.length >= 5, true);
for (const key of roleKeys) {
  check(`fr renders ${key}, not the key or the English`,
    T("fr", key) !== key && T("fr", key) !== T("en", key), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the platform's settings page ---");

// The operator's settings live under platform.settings; every label the page
// reads must exist in both languages, and the two must differ, or a
// francophone operator reads English on the one page that manages who runs
// the platform.
const platformSettings = Object.keys(frFlatAll()).filter((k) => k.startsWith("platform.settings."));
check("the page has its labels", platformSettings.length >= 40, true);
check("every one of them renders in French and differs from English",
  platformSettings.filter((k) => {
    const e = T("en", k), f = T("fr", k);
    return f === k || (e === f && /[a-z]{3}/i.test(e) && !/^(Version|Max|Total|Section|Document)/.test(e));
  }), []);
for (const [key, en, fr] of [
  ["platform.settings.title",          "Settings",          "Paramètres"],
  ["platform.settings.tabProfile",     "My Profile",        "Mon profil"],
  ["platform.settings.tabAdmins",      "Super Admins",      "Super administrateurs"],
  ["platform.settings.addAdmin",       "Add Super Admin",   "Ajouter un super administrateur"],
  ["platform.settings.active",         "Active",            "Actif"],
  ["platform.settings.inactive",       "Inactive",          "Inactif"],
  ["platform.settings.changePassword", "Change Password",   "Modifier le mot de passe"],
  ["nav.platformSettings",             "Platform settings", "Paramètres de la plateforme"],
]) {
  check(`en ${key}`, T("en", key), en);
  check(`fr ${key}`, T("fr", key), fr);
}
check("the role reads Super Admin", T("en", "settings.roleSuperAdmin"), "Super Admin");
for (const a of ["created", "updated", "activated", "deactivated", "passwordReset"]) {
  check(`the audit trail can name superAdmin.${a} in French`,
    T("fr", `platform.audit.actions.superAdmin.${a}`) !== `platform.audit.actions.superAdmin.${a}`, true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- nothing about assignments falls back to English in French ---");

const flat = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" ? flat(v, key) : [[key, v]];
  });
const enFlat = Object.fromEntries(flat(en));
const frFlat = Object.fromEntries(flat(fr));

const assignmentKeys = Object.keys(enFlat).filter((k) =>
  k.startsWith("assignments.") || /assign/i.test(k.split(".").pop()));
check("there are assignment keys to check", assignmentKeys.length > 20, true);
const englishInFrench = assignmentKeys.filter((k) => {
  const e = enFlat[k], f = frFlat[k];
  // A value with no letters — "{{count}}" alone — is allowed to coincide.
  return f == null || (/[a-z]/i.test(e) && f === e);
});
check("no assignment key is missing in French or still English", englishInFrench, []);

// A plural pair is a pair: `x` and `x_other`, in both files.
const orphans = [];
for (const [k] of flat(en)) {
  if (k.endsWith("_other") && !(k.slice(0, -6) in enFlat)) orphans.push(k);
  if (k.endsWith("_other") && !(k in frFlat)) orphans.push(`fr:${k}`);
  if (k.endsWith("_other") && !(k.slice(0, -6) in frFlat)) orphans.push(`fr:${k.slice(0, -6)}`);
}
check("every plural form has its singular, in both languages", orphans, []);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- English is what it was ---");

for (const [key, expected] of [
  ["common.save",                 "Save"],
  ["assignments.title",           "Teaching assignments"],
  ["assignments.alreadyAssigned", "Already assigned"],
  ["assignments.created",         "Assignment created"],
  ["subjects.noTeacher",          "No teacher assigned"],
  ["health.unassignedTeachers",   "Unassigned"],
  ["teachersEdit.assigned",       "Assigned subjects"],
]) check(`en ${key}`, T("en", key), expected);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the source no longer assembles these sentences itself ---");

const sourceFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "locales") walk(full); }
    else if ([".ts", ".tsx"].includes(extname(name))) sourceFiles.push(full);
  }
})(join(ROOT, "src"));

// Comments may name the bug; rendered code may not.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const sources = sourceFiles
  .map((f) => [relative(ROOT, f).replace(/\\/g, "/"), stripComments(readFileSync(f, "utf8"))])
  // The navigation, module and health-metric tables carry an English `label`
  // beside a `labelKey` (or a key derived from their `key`) and are rendered
  // through t(key, { defaultValue: label }). The label there is the fallback
  // the translator is handed, not a string that reaches the screen untranslated.
  .filter(([file]) => !/^src\/(constants|config)\//.test(file));

// The literals the audit found, as they were written. A match on any of them
// means a sentence went back to being English in every language.
const LITERALS = [
  "Currently assigned to {", "Assigned to{", `"Partial Success"`, ">Loading teachers…<",
  `"No teachers found."`, "Step {step} of 4", "Select All (${", `"Deselect All"`,
  `role.replace("_"`, `role?.replace("_"`, `"No email provided"`, `"Not provided"`,
  `"Attached document"`, `"Failed to approve submission"`, `"Post announcement"`,
  `"Period added"`, `"Unknown date"`, `"pending application"`, `: "No teacher assigned"`,
  `label: "Choose a class…"`, `"That clashes"`, `: "Pin to the top"`, `: "Layout Preview"`,
  `: "Sign In"`, `: "Show inactive"`, `: "Put back in use"`, `: "Hidden"`,
  `"Nothing matches that search"`, "All Subjects (${", " subject(s)", " class(es)",
  `label: "Assigned"`, `label: "Unassigned"`, `label: "Total"`, `"Approving…"`,
  `>Level {`, `>Section {`, "Version {template", `"Announcement posted"`,
  // The attendance register toggle rendering its stored value.
  `capitalize transition-colors",\n                      subject === s\n                        ? "bg-primary-600 text-white"\n                        : "bg-white text-gray-600 hover:bg-gray-50",\n                    )}\n                  >\n                    {s}`,
];
const found = [];
for (const [file, text] of sources) {
  for (const lit of LITERALS) if (text.includes(lit)) found.push(`${file}: ${lit}`);
}
check("none of the audited literals survive in rendered code", found, []);

// The English plural, hand-rolled. `n !== 1 ? "s" : ""` reads fine in English
// and produces "1 matières" or "2 matière" in French; every count now goes
// through a key with an _other form.
const handRolled = [];
for (const [file, text] of sources) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/\?\s*""\s*:\s*"s"|\?\s*"s"\s*:\s*""|\?\s*"es"\s*:\s*""|\?\s*""\s*:\s*"es"/.test(line)) {
      handRolled.push(`${file}:${i + 1}`);
    }
  });
}
check("no hand-rolled English plural remains", handRolled, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
