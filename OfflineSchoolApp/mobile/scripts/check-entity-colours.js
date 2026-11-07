// mobile/scripts/check-entity-colours.js
"use strict";

/**
 * The phone colours an entity the same way the web console does, and every
 * piece of src/components/Tinted.js is readable and never grey.
 *
 *   1. levelAccent / termAccent / roleAccent / categoryAccent give the same
 *      accent as web/src/config/dashboardTint.ts for the same input;
 *   2. every accent badge and status badge is WCAG AA (4.5:1) text;
 *   3. every SCREEN_IDENTITY entry names a real accent and a real Ionicons
 *      glyph, and every screen folder under app/ has a header colour;
 *   4. Tinted.js uses the theme only: no hex, no grey.
 *
 *   node scripts/check-entity-colours.js      (Node 22.18+ / 24)
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WEB  = path.join(ROOT, "..", "web", "src", "config", "dashboardTint.ts");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const src = fs.readFileSync(path.join(ROOT, "src", "theme", "colors.js"), "utf8").replace(/^export /gm, "");
const T = new Function(`${src}\nreturn { COLORS, ACCENT, SEMANTIC, ENTITY_ACCENTS, levelAccent, termAccent, roleAccent, categoryAccent, kindAccent, accentBadge, statusBadge };`)();

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
  // ── 1. Same colours as the web ───────────────────────────────────────────
  const SAMPLES = {
    level:    ["1", "2", "3", "4", "5", "6", "7", "8", "JHS 2", "Form 3", "Basic 9", "Nursery", "KG", "", null],
    term:     ["Term 1", "Term 2", "Term 3", "2", "Second", "Third term", "Whole year", "", null],
    role:     ["teacher", "student", "pupil", "bursar", "accountant", "parent", "guardian", "school_admin", "super_admin", "admin", "TEACHER", "visitor", null],
    category: ["Science", "Arts", "Mathematics", "core", "elective", "Mid-term", "End of term", "", null],
  };
  let web = null;
  if (fs.existsSync(WEB)) {
    try { web = await import(WEB); } catch (e) { console.log(`  note web tint not loadable here (${e.message})`); }
  }
  if (web) {
    for (const [what, inputs] of Object.entries(SAMPLES)) {
      const fn = `${what}Accent`;
      check(`${fn} matches the web for ${inputs.length} inputs`, inputs.map(T[fn]), inputs.map(web[fn]));
    }
    check("the same entity accents, in the same order", T.ENTITY_ACCENTS, [...web.ENTITY_ACCENTS]);
  } else {
    console.log("  note web/ not present — parity skipped");
  }
  check("an entity colour is never red", [...Array(60)].map((_, i) => T.categoryAccent(`name ${i}`)).includes("red"), false);
  check("kinds map to the dashboard accents",
    ["students", "teachers", "classes", "subjects", "exams", "attendance", "fees", "announcements", "results"].map(T.kindAccent),
    ["blue", "violet", "indigo", "slate", "amber", "green", "teal", "sky", "slate"]);

  // ── 2. Badges are readable ───────────────────────────────────────────────
  const low = [];
  for (const a of Object.keys(T.ACCENT)) {
    const b = T.accentBadge(a);
    if (ratio(b.text, b.bg) < 4.5) low.push(`${a} ${ratio(b.text, b.bg).toFixed(2)}`);
  }
  for (const tone of Object.keys(T.SEMANTIC)) {
    const b = T.statusBadge(tone);
    if (ratio(b.text, b.bg) < 4.5) low.push(`${tone} ${ratio(b.text, b.bg).toFixed(2)}`);
  }
  check("every accent and status badge is WCAG AA text", low, []);
  check("white on every solid icon square is WCAG AA",
    Object.entries(T.ACCENT).filter(([, a]) => ratio("#FFFFFF", a.solid) < 4.5).map(([k]) => k), []);

  // ── 3. Every screen has a header colour and icon ─────────────────────────
  const tinted = fs.readFileSync(path.join(ROOT, "src", "components", "Tinted.js"), "utf8");
  const block = tinted.slice(tinted.indexOf("SCREEN_IDENTITY = {"), tinted.indexOf("};", tinted.indexOf("SCREEN_IDENTITY = {")));
  const ids = [...block.matchAll(/"(\/[^"]*)":\s*\{\s*accent:\s*"(\w+)",\s*icon:\s*"([\w-]+)"/g)]
    .map(([, p, accent, icon]) => ({ p, accent, icon }));
  const glyphs = JSON.parse(fs.readFileSync(require.resolve(
    "@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json", { paths: [ROOT] }), "utf8"));
  check("every header accent is a theme accent", ids.filter((i) => !T.ACCENT[i.accent]).map((i) => i.p), []);
  check("every header icon is a real Ionicons glyph", ids.filter((i) => !(i.icon in glyphs)).map((i) => `${i.p}:${i.icon}`), []);
  const prefixes = ids.map((i) => i.p);
  const screens = [];
  for (const area of ["admin", "teacher", "student"]) {
    for (const e of fs.readdirSync(path.join(ROOT, "app", area), { withFileTypes: true })) {
      const name = e.name.replace(/\.js$/, "");
      if (name.startsWith("_") || name === "index" || name === "components") continue;
      screens.push(`/${area}/${name}`);
    }
  }
  check("every screen folder has its own header colour",
    screens.filter((s) => !prefixes.includes(s) && !["/admin/dashboard"].includes(s)).filter((s) => !prefixes.some((p) => s.startsWith(`${p}/`))), []);

  // ── 4. Tinted.js is theme-only ───────────────────────────────────────────
  const code = tinted.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
  check("Tinted.js has no hex and no grey", [/#[0-9A-Fa-f]{3,8}\b/.test(code), /textMuted|textSubtle|gray\d|\bgray\b/i.test(code)], [false, false]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
