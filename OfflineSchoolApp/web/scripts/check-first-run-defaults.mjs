// web/scripts/check-first-run-defaults.mjs
//
// Two first-run gaps on the web:
//
//   - Expense categories now arrive seeded with an English label and a French
//     labelFr (backend services/expenseCategories.service.js), and the
//     Expenses page shows the one in the reader's language
//     (src/utils/categoryLabel.ts). It used to show `label` only.
//
//   - The Announcements composer offers "Parents" to an administrator. The
//     server already stored and delivered audience:"parents" to the guardian
//     portal; the picker never offered it.
//
//   node scripts/check-first-run-defaults.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";
import ts   from "typescript";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return null; }
};

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const load = async (rel) => {
  const src = read(rel);
  if (src === null) return {};
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};

console.log("--- expense category labels ---");
const { categoryLabel } = await load("src/utils/categoryLabel.ts");
check("the helper exists", typeof categoryLabel, "function");
if (typeof categoryLabel === "function") {
  const seeded = { label: "Maintenance", labelFr: "Entretien" };
  check("French reader → labelFr", categoryLabel(seeded, "fr"), "Entretien");
  check("fr-CM counts as French", categoryLabel(seeded, "fr-CM"), "Entretien");
  check("English reader → label", categoryLabel(seeded, "en"), "Maintenance");
  check("no labelFr → label, in French too", categoryLabel({ label: "General", labelFr: null }, "fr"), "General");
  check("blank labelFr → label", categoryLabel({ label: "General", labelFr: "  " }, "fr"), "General");
  check("no category → undefined", categoryLabel(undefined, "fr"), undefined);
}
const expenses = read("src/pages/finance/expenses.tsx") ?? "";
check("the Expenses page names categories through it (list and picker)",
  (expenses.match(/categoryLabel\(/g) ?? []).length >= 2, true);
check("and no longer prints the raw label in the list",
  /byId\.get\(e\.categoryId\)\?\.label/.test(expenses), false);

console.log("--- the Parents audience ---");
const types = await load("src/types/announcement.types.ts");
check("AUDIENCES includes parents", (types.AUDIENCES ?? []).includes("parents"), true);
check("an administrator may address parents", (types.allowedAudiences?.("school_admin") ?? []).includes("parents"), true);
check("a super_admin too", (types.allowedAudiences?.("super_admin") ?? []).includes("parents"), true);
check("a teacher keeps students and classes only", types.allowedAudiences?.("teacher"), ["students", "class"]);

const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
check("English label", en.announcements?.audienceOpt?.parents, "Parents only");
check("French label", fr.announcements?.audienceOpt?.parents, "Parents uniquement");
check("every audience has a label in both languages",
  (types.AUDIENCES ?? []).every((a) => en.announcements?.audienceOpt?.[a] && fr.announcements?.audienceOpt?.[a]), true);

const page = read("src/pages/announcements/index.tsx") ?? "";
check("the teacher hint no longer counts options (5 for an admin now)",
  /audiences\.length < 4/.test(page), false);

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
