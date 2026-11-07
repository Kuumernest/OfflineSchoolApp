// web/scripts/check-watch-source.mjs
//
// A Students to watch flag that rests on a mark says which exam, and when.
//
// The failure this pins: "Failed the last exam (8/20, pass mark 10)" named no
// exam, so a teacher could not check it. The server now sends `exam` (and
// `fromExam` on a drop); src/utils/watchSource.ts picks the words and the
// watch list appends them: "… · 2nd Sequence, 10 Oct 2026".
//
//   node scripts/check-watch-source.mjs

import fs      from "node:fs";
import path    from "node:path";
import url     from "node:url";
import ts      from "typescript";
import i18next from "i18next";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

let watchSource = null;
try {
  const { outputText } = ts.transpileModule(read("src/utils/watchSource.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  ({ watchSource } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`));
} catch { /* reported below */ }

const S2 = { examId: "s2", name: "2nd Sequence", date: "2026-10-10" };
const S1 = { examId: "s1", name: "1st Sequence", date: "2026-09-15" };

console.log("--- which words ---");
check("the helper exists", typeof watchSource, "function");
if (watchSource) {
  check("an exam with a date", watchSource({ exam: S2 }), { key: "dated", exam: "2nd Sequence", date: "2026-10-10" });
  check("a drop names both", watchSource({ exam: S2, fromExam: S1 }),
    { key: "dropDated", exam: "2nd Sequence", from: "1st Sequence", date: "2026-10-10" });
  check("no date: the name alone", watchSource({ exam: { ...S2, date: null } }), { key: "named", exam: "2nd Sequence" });
  check("an exam with no name (row gone): nothing appended", watchSource({ exam: { examId: "x", name: null, date: null } }), null);
  check("a flag that rests on no mark: nothing", watchSource({}), null);
}

console.log("--- the sentence, both languages ---");
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
await i18next.init({ lng: "en", resources: { en: { translation: en }, fr: { translation: fr } } });
check("English", i18next.getFixedT("en")("watch.source.dropDated", { from: "1st Sequence", exam: "2nd Sequence", date: "10 Oct 2026" }),
  "1st Sequence → 2nd Sequence, 10 Oct 2026");
check("French", i18next.getFixedT("fr")("watch.source.dated", { exam: "2e séquence", date: "10 oct. 2026" }),
  "2e séquence, 10 oct. 2026");

console.log("--- the page ---");
const page = read("src/pages/insights/watchlist.tsx");
check("the watch list appends the source to every flag", /watchSource\(s\)/.test(page) && /watch\.source\./.test(page), true);
check("and formats the date with the page's own formatter", /fmt\.date\(src\.date\)/.test(page), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
