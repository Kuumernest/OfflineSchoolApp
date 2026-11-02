// mobile/scripts/check-tile-contrast.js
"use strict";

/**
 * Every tile's text is readable on its tile.
 *
 * src/theme/colors.js gives each kind of tile a fill and an ink. Terracotta
 * and olive as the brand gives them miss 4.5:1 with white (4.35 and 3.75), so
 * their tiles use a deeper shade of the same hue; mustard and burnt orange
 * take dark ink. Nudge one hex and that reasoning silently stops holding —
 * this measures every pair (WCAG 2 relative luminance) so it cannot.
 *
 *   node scripts/check-tile-contrast.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label) => { fail++; console.log(`  FAIL ${label}`); };

// colors.js is an ES module and this is plain node: read the values from the
// source rather than importing it.
const src = fs.readFileSync(path.join(ROOT, "src", "theme", "colors.js"), "utf8");
const PALETTE = Object.fromEntries([...src.matchAll(/^\s+(\w+):\s+"(#[0-9A-Fa-f]{6})",/gm)].map((m) => [m[1], m[2]]));
const tones = Object.fromEntries([...src.matchAll(/^const (\w+)\s*=\s*(light|dark)\(PALETTE\.(\w+)\);/gm)]
  .map(([, name, kind, key]) => [name, { bg: PALETTE[key], fg: kind === "light" ? PALETTE.cream : PALETTE.inkWarm }]));
const tile = [...src.matchAll(/^\s+(\w+):\s+(?:([A-Z_]+)|(light|dark)\(PALETTE\.(\w+)\)),/gm)]
  .map(([, kind, tone, fn, key]) => [kind, tone ? tones[tone] : { bg: PALETTE[key], fg: fn === "light" ? PALETTE.cream : PALETTE.inkWarm }]);

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

console.log("--- tile text against its tile ---");
if (tile.length < 10) bad(`read only ${tile.length} tiles from colors.js; the parser no longer matches the file`);
for (const [kind, t] of tile) {
  if (!t?.bg || !t?.fg) { bad(`${kind}: could not resolve its colours`); continue; }
  const r = ratio(t.bg, t.fg);
  if (r >= 4.5) ok(`${kind.padEnd(13)} ${t.fg} on ${t.bg}  ${r.toFixed(2)}:1`);
  else          bad(`${kind.padEnd(13)} ${t.fg} on ${t.bg}  ${r.toFixed(2)}:1 is under 4.5`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
