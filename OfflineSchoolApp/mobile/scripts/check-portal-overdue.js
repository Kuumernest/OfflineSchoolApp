"use strict";

/**
 * The phone's parent portal says how much of a balance is overdue.
 *
 * Home and Fees coloured the whole balance "Overdue" when only part of it was
 * late (Eunice: 145,000 owed, 50,000 overdue). The server's /portal/home now
 * carries `fees.overdue`; the screens say "of which 50,000 is overdue" through
 * src/utils/overdueShare.js, and keep the plain "Overdue" when all of it is
 * late or a reply has no figure.
 *
 *   node scripts/check-portal-overdue.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");

const MOBILE = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(MOBILE, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// As scripts/check-portal-client.js loads a module: preset-expo to CommonJS.
const loadMobileModule = (relPath) => {
  const { code } = babel.transformFileSync(path.join(MOBILE, relPath), {
    presets: [require.resolve("babel-preset-expo")],
    caller:  { name: "check", supportsStaticESM: false },
    babelrc: false,
    configFile: false,
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
};

let overdueShare = null;
try { ({ overdueShare } = loadMobileModule("src/utils/overdueShare.js")); } catch { /* reported below */ }

console.log("--- how much of it is late ---");
check("the helper exists", typeof overdueShare, "function");
if (overdueShare) {
  check("Eunice: part of it", overdueShare(145000, 50000), "part");
  check("all of it", overdueShare(60000, 60000), "all");
  check("no figure: unknown, never 'all'", [overdueShare(145000, undefined), overdueShare(145000, null)], ["unknown", "unknown"]);
}

console.log("--- the screens ---");
const home = read("src/components/portal/HomeScreen.js");
const fees = read("src/components/portal/FeesScreen.js");
check("Home's pill names the overdue part", /overdueShare\(fees\.balance, fees\.overdue\)/.test(home) && /portal\.home\.overdueOfIt/.test(home), true);
check("Fees' pill names it too", /overdueShare\(totals\.balance, status\?\.overdue\)/.test(fees) && /portal\.feesScreen\.overdueOfIt/.test(fees), true);

console.log("--- the words, both languages ---");
const en = JSON.parse(read("src/i18n/locales/en.json")).portal;
const fr = JSON.parse(read("src/i18n/locales/fr.json")).portal;
check("English", [en.home.overdueOfIt, en.feesScreen.overdueOfIt], ["of which {{amount}} overdue", "of which {{amount}} is overdue"]);
check("French", [fr.home.overdueOfIt, fr.feesScreen.overdueOfIt], ["dont {{amount}} en retard", "dont {{amount}} en retard"]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
