// Syntax guard for the class-form parity fixes (level leave-alone contract,
// name-length alignment). Parses every touched file with the babel parser the
// mobile app already ships, including JSX/TSX that `node --check` cannot read.
//   node scripts/check-class-form-syntax.js
// Exits 0 when every file parses, 1 with a message otherwise.
const path = require("path");
const fs = require("fs");

const parser = require(path.join(
  __dirname, "..", "mobile", "node_modules", "@babel", "parser"
));

const ROOT = path.join(__dirname, "..");
const FILES = [
  "mobile/src/services/class.service.js",
  "mobile/app/admin/classes/edit.js",
  "mobile/app/admin/classes/add.js",
  "web/src/pages/classes/ClassesPage.tsx",
  // CommonJS, but `module.exports = [...]` parses the same as ESM here.
  "desktop/src/main/api/writes/classes.js",
];
const JSON_FILES = [
  "mobile/src/i18n/locales/en.json",
  "mobile/src/i18n/locales/fr.json",
];

let failed = false;
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, "utf8");
  try {
    parser.parse(src, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
    console.log(`OK   ${rel}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${rel}: ${err.message}`);
  }
}

for (const rel of JSON_FILES) {
  const abs = path.join(ROOT, rel);
  try {
    const data = JSON.parse(fs.readFileSync(abs, "utf8"));
    const keys = ["levelLabel", "levelPh", "sectionLabel", "sectionPh",
      "teacherLabel", "teacherHint", "teacherNone", "teacherPick", "teacherEmpty"];
    const missing = keys.filter((k) => !data.classesAdmin?.[k]);
    if (missing.length) {
      failed = true;
      console.error(`FAIL ${rel}: classesAdmin missing ${missing.join(", ")}`);
    } else {
      console.log(`OK   ${rel} (classesAdmin keys present)`);
    }
  } catch (err) {
    failed = true;
    console.error(`FAIL ${rel}: ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
