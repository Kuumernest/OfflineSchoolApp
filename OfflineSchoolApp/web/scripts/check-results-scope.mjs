// web/scripts/check-results-scope.mjs
//
// The exam analytics page (/exams/results) opens on every class, and says so
// when it shows one.
//
// The failure this pins: an exam sat by Form 1, Form 2, Lower and Upper Sixth
// opened with the class filter on Form 1, so the student count and pass rate
// covered 10 pupils while the title named four classes and Term Results
// counted all 40. The page now starts on All classes (src/utils/resultsScope.ts)
// and a chosen class reads "Showing Form 1 only".
//
//   node scripts/check-results-scope.mjs

import fs     from "node:fs";
import path   from "node:path";
import url    from "node:url";
import ts     from "typescript";
import i18next from "i18next";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { outputText } = ts.transpileModule(read("src/utils/resultsScope.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { resultsScope } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const CLASSES = [
  { classId: "f1", className: "Form 1" },
  { classId: "f2", className: "Form 2" },
  { classId: "l6", className: "Lower Sixth" },
  { classId: "u6", className: "Upper Sixth" },
];

console.log("--- the scope ---");
check("nothing chosen: every class, no label",
  resultsScope("", CLASSES), { className: null });
check("Form 1 chosen: Form 1, labelled",
  resultsScope("f1", CLASSES), { classId: "f1", className: "Form 1" });
check("a class this exam has no results in: every class, no label",
  resultsScope("gone", CLASSES), { className: null });
check("classes not loaded yet: every class, no label",
  resultsScope("f1", []), { className: null });
check("a class with no name is labelled by its id",
  resultsScope("x", [{ classId: "x", className: null }]), { classId: "x", className: "x" });

console.log("--- the page ---");
const page = read("src/pages/exams/results/index.tsx");
check("the class filter starts on All classes",
  /useState<string>\(""\)/.test(page) && /setClassId\(""\)/.test(page), true);
check("it never falls back to the first class",
  /classOptions\[0\]/.test(page), false);
check("stats and rankings are asked for the same class",
  [/useExamStats\(\s*activeClassId \? selectedExamId \?\? "" : "", activeClassId \|\| undefined/.test(page),
   /useRankings\(selectedExamId \?\? "", rankScope, activeClassId \|\| undefined, rankPage\)/.test(page),
   /classId=\{activeClassId \|\| undefined\}/.test(page)],
  [true, true, true]);
check("the label is shown for a chosen class",
  /scope\.className && /.test(page) && /results\.showingClassOnly/.test(page), true);

console.log("--- the rankings past one page ---");
check("\"N students\" is the table's total, not the rows on this page",
  [/rankingsData\?\.total/.test(page), /studentCount", \{ count: rankingsTotal \}/.test(page),
   /studentCount", \{ count: rankings\.length \}/.test(page)],
  [true, true, false]);
check("the table is paged, Prev/Next like Term Results",
  [/useRankings\(examId, scope, classId, page\)/.test(page), /pagination\.pageOf/.test(page),
   /page=\{rankPage\}/.test(page) && /onPage=\{setRankPage\}/.test(page)],
  [true, true, true]);
check("back to page 1 whenever what is ranked changes (exam, class, scope)",
  (page.match(/setRankPage\(1\)/g) ?? []).length >= 4, true);
const svc = read("src/services/exam.service.ts");
check("the service asks for a page, with the page size",
  /params: \{ schoolId, rankBy, classId, page, limit: RANKINGS_PAGE_SIZE \}/.test(svc), true);
const hook = read("src/hooks/useExamResults.ts");
check("each page has its own cache entry",
  /\["rankings", examId, scope, classId \?\? "all", page\]/.test(hook), true);

console.log("--- the label, in both languages ---");
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
await i18next.init({ lng: "en", resources: { en: { translation: en }, fr: { translation: fr } } });
check("English", i18next.getFixedT("en")("results.showingClassOnly", { className: "Form 1" }), "Showing Form 1 only");
check("French", i18next.getFixedT("fr")("results.showingClassOnly", { className: "Form 1" }), "Affichage : Form 1 uniquement");
check("the way back, both languages",
  [i18next.getFixedT("en")("results.showAllClasses"), i18next.getFixedT("fr")("results.showAllClasses")],
  ["Show all classes", "Afficher toutes les classes"]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
