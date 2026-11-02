// mobile/scripts/check-tile-contrast.js
"use strict";

/**
 * Every card's text is readable on its card.
 *
 * src/theme/colors.js is one brand blue on white cards, with light semantic
 * tints for warnings, errors, info and success. Nudge one hex and a label on a
 * tint can quietly drop under 4.5:1 — this measures every text pair the cards
 * use (WCAG 2 relative luminance) so it cannot.
 *
 * Icons are reported, not enforced: every icon on a card sits next to a text
 * label that says the same thing, and two of the specified icon colours sit
 * near or under 3:1 on their boxes (warning 2.86, success 3.00).
 *
 *   node scripts/check-tile-contrast.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok   = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad  = (label) => { fail++; console.log(`  FAIL ${label}`); };
const note = (label) => console.log(`  note ${label}`);

// colors.js is an ES module with no imports; this is plain node. Evaluate its
// source with `export` dropped, so the check reads the real objects.
const src = fs.readFileSync(path.join(ROOT, "src", "theme", "colors.js"), "utf8").replace(/^export /gm, "");
const { COLORS, ACCENT, TILE, SEMANTIC } =
  new Function(`${src}\nreturn { COLORS, ACCENT, TILE, SEMANTIC };`)();

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const text = (name, fg, bg) => {
  const r = ratio(fg, bg);
  (r >= 4.5 ? ok : bad)(`${name.padEnd(34)} ${fg} on ${bg}  ${r.toFixed(2)}:1${r >= 4.5 ? "" : " is under 4.5"}`);
};

console.log("--- text on white cards and the page ---");
for (const bg of [COLORS.surface, COLORS.page]) {
  text("text", COLORS.text, bg);
  text("textSecondary (labels)", COLORS.textSecondary, bg);
  text("textSubtle (meta)", COLORS.textSubtle, bg);
}
note(`textMuted ${COLORS.textMuted} is ${ratio(COLORS.textMuted, COLORS.surface).toFixed(2)}:1 on white: placeholders and decoration only`);

console.log("--- the primary action and the context bar ---");
text("onPrimary on primary", COLORS.onPrimary, COLORS.primary);
text("onPrimary on primaryHover", COLORS.onPrimary, COLORS.primaryHover);
text("primary link on primaryLight", COLORS.primary, COLORS.primaryLight);
text("contextText on contextBg", COLORS.contextText, COLORS.contextBg);
text("badge text on danger", COLORS.onPrimary, COLORS.danger);

console.log("--- semantic cards: number and label on the tint ---");
for (const [tone, t] of Object.entries(SEMANTIC)) text(`${tone} text`, t.text, t.bg);

console.log("--- every kind of card has an accent ---");
const accents = new Set(Object.values(ACCENT));
const loose = Object.entries(TILE).filter(([, a]) => !accents.has(a)).map(([k]) => k);
if (loose.length === 0) ok(`${Object.keys(TILE).length} kinds, each on one of ${accents.size} accents`);
else bad(`kinds without a named accent: ${loose.join(", ")}`);

console.log("--- icons on their boxes (reported, 3:1 is the target) ---");
for (const [name, a] of Object.entries(ACCENT)) note(`${name.padEnd(8)} ${a.icon} on ${a.box}  ${ratio(a.icon, a.box).toFixed(2)}:1`);
for (const [name, t] of Object.entries(SEMANTIC)) note(`${name.padEnd(8)} ${t.icon} on ${t.box}  ${ratio(t.icon, t.box).toFixed(2)}:1`);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
