// backend/scripts/check-school-types.js
"use strict";

/**
 * C9 — Settings: Cameroon school types, the logo, the pass mark on /20.
 *
 *   - the School model accepts Collège / Lycée, general / technical, and still
 *     accepts the older types a school may have saved
 *   - the printed header names the right ministry and line for each
 *   - the settings screen offers the Cameroon types, asks for the logo it
 *     shows (includeLogo), falls back when the file is missing, and labels
 *     the pass mark /20
 *
 *   node scripts/check-school-types.js
 */

const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

require("../src/db/models");
const School = mongoose.model("School");
const accepts = (schoolType) =>
  !new School({ name: "X", email: "x@example.test", schoolType }).validateSync()?.errors?.schoolType;

console.log("--- the model ---");
const CAMEROON = ["primary", "college_general", "college_technical", "lycee_general", "lycee_technical", "combined", "other"];
check("every Cameroon type is accepted", CAMEROON.every(accepts), true);
check("the older types still validate, so no school is locked out of saving",
  ["jhs", "shs", "vocational", "university"].every(accepts), true);
check("a made-up type is refused", accepts("grammar"), false);

console.log("--- the printed header ---");
const { officialHeader } = require("../../shared/officialHeader");
const head = (schoolType) => {
  const h = officialHeader({ schoolType });
  return [h.en.ministry, h.en.schoolType, h.fr.schoolType];
};
check("a general lycée → Secondary Education, general",
  head("lycee_general"),
  ["Ministry of Secondary Education", "General Secondary Education", "Enseignement Secondaire Général"]);
check("a technical collège → Secondary Education, technical",
  head("college_technical"),
  ["Ministry of Secondary Education", "Technical Secondary Education", "Enseignement Secondaire Technique"]);
check("a primary school is still Basic Education", head("primary")[0], "Ministry of Basic Education");

console.log("--- the settings screen ---");
const WEB = path.join(__dirname, "..", "..", "web", "src");
const page = fs.readFileSync(path.join(WEB, "pages/settings/SettingsPage.tsx"), "utf8");
const offered = page.slice(page.indexOf("const SCHOOL_TYPES"), page.indexOf("const LEGACY_SCHOOL_TYPES"));
check("it offers exactly the Cameroon types",
  [...offered.matchAll(/value: "([a-z_]+)"/g)].map((m) => m[1]), CAMEROON);
check("it asks for the logo it shows", /school-info", \{ params: \{ schoolId, includeLogo: 1 \} \}/.test(page), true);
check("a logo that fails to load falls back to the placeholder", /onError=\{\(\) => \{ setLogoPreview\(null\); setLogoBroken\(true\); \}\}/.test(page), true);
const en = JSON.parse(fs.readFileSync(path.join(WEB, "i18n/locales/en.json"), "utf8"));
check("the pass mark is labelled /20", [page.includes('t("settings.passMarkOn20")'), en.settings.passMarkOn20], [true, "Pass mark (/20)"]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
