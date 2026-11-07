// web/scripts/check-fee-flag.mjs
//
// Students to watch says what a family owes AND how much of it is overdue.
//
// The failure this pins: "Owes FCFA 145,000 (overdue)" for a family whose Fees
// page row said 145,000 owed, 50,000 overdue. The line is now chosen by
// src/utils/feeFlag.ts from the server's two figures, and never calls a
// balance overdue when the server did not say how much was.
//
//   node scripts/check-fee-flag.mjs

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

const { outputText } = ts.transpileModule(read("src/utils/feeFlag.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { feeFlag } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
await i18next.init({ lng: "en", resources: { en: { translation: en }, fr: { translation: fr } } });
// Plain grouping stands in for the page's fmt.money: the sentence is the point.
const money = (v) => `FCFA ${Number(v).toLocaleString("en-US")}`;
const say = (lng, data) => {
  const f = feeFlag(data);
  return i18next.getFixedT(lng)(`watch.sig.${f.key}`, { balance: money(f.balance), overdue: money(f.overdue ?? 0) });
};

console.log("--- the sentence ---");
check("Eunice: owes 145,000, of which 50,000 is overdue",
  say("en", { balance: 145000, overdue: 50000 }), "Owes FCFA 145,000, of which FCFA 50,000 is overdue");
check("Alain: owes 200,000, of which 105,000 is overdue",
  say("en", { balance: 200000, overdue: 105000 }), "Owes FCFA 200,000, of which FCFA 105,000 is overdue");
check("all of it late says so",
  say("en", { balance: 60000, overdue: 60000 }), "Owes FCFA 60,000, all of it overdue");
check("no overdue figure: the balance, never called overdue",
  say("en", { balance: 145000 }), "Owes FCFA 145,000");
check("French",
  [say("fr", { balance: 145000, overdue: 50000 }), say("fr", { balance: 60000, overdue: 60000 })],
  ["Doit FCFA 145,000, dont FCFA 50,000 en retard", "Doit FCFA 60,000, entièrement en retard"]);

console.log("--- the page ---");
const page = read("src/pages/insights/watchlist.tsx");
check("the watch list picks its line with feeFlag", /feeFlag\(s\.data\)/.test(page), true);
check("no string calls the whole balance overdue",
  [en.watch.sig.fees_outstanding.includes("(overdue)"), fr.watch.sig.fees_outstanding.includes("(en retard)")],
  [false, false]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
