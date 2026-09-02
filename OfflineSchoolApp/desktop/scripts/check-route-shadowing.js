// desktop/scripts/check-route-shadowing.js
"use strict";

/**
 * No literal route may sit behind a pattern that already matches it.
 *
 * ── The failure this exists to catch ──────────────────────────────────────
 *
 * index.js matches its table in order and returns on the first hit. So
 * GET /api/exams/:id registered before GET /api/exams/dashboard swallows the
 * dashboard entirely: "dashboard" is a perfectly good id as far as a pattern is
 * concerned, the :id handler looks for an exam called "dashboard", finds none,
 * and declines. The request goes to the network and the screen works — until
 * the office loses its connection, at which point a whole page has no offline
 * answer even though somebody wrote one.
 *
 * That is what makes it worth a check rather than a comment. A shadowed route
 * is invisible from outside: it looks exactly like a route nobody mirrored, and
 * the handler sitting there passes review because there is nothing wrong with
 * it. Two of them had been shadowed for as long as they had existed, and both
 * were found only by going looking.
 *
 * ── What it checks ────────────────────────────────────────────────────────
 *
 * For every literal route, whether any EARLIER route of the same method has a
 * pattern that matches it. Only literals can be shadowed — a pattern behind
 * another pattern is a design decision (structure.js deliberately relies on
 * winning ahead of the newer modules), and this does not second-guess it.
 *
 *   node scripts/check-route-shadowing.js
 */

const path = require("path");
const fs   = require("fs");

const API_DIR = path.join(__dirname, "..", "src", "main", "api");

/**
 * The table in the order index.js builds it: reads first, then writes, module
 * by module as they are required. Read out of index.js rather than hardcoded,
 * so a module added there is covered here without anybody remembering to.
 */
const routeTable = () => {
  const src  = fs.readFileSync(path.join(API_DIR, "index.js"), "utf8");
  const mods = [...src.matchAll(/require\("\.\/(handlers\/[A-Za-z]+|writes)"\)/g)]
    .map((m) => m[1]);

  const seen = new Set();
  const table = [];
  for (const rel of mods) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const mod = require(path.join(API_DIR, rel));
    for (const entry of Array.isArray(mod) ? mod : []) {
      if (entry && typeof entry.route === "string") {
        table.push({ route: entry.route, from: rel });
      }
    }
  }
  return table;
};

/** A route pattern as the matcher sees it: one path segment per parameter. */
const patternRe = (p) =>
  new RegExp("^" + p
    .split("/")
    .map((seg) => (seg.startsWith(":")
      ? "[^/]+"
      : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/") + "$");

let pass = 0, fail = 0;
const check = (label, ok) => {
  if (ok) { pass++; }
  else { fail++; console.log(`  FAIL ${label}`); }
};

const table = routeTable();
check(`the table is populated (${table.length} routes)`, table.length > 50);

const shadowed = [];
table.forEach((entry, i) => {
  const [method, p] = entry.route.split(" ");
  if (!p || p.includes(":")) return;

  for (let j = 0; j < i; j++) {
    const [m2, p2] = table[j].route.split(" ");
    if (m2 !== method || !p2 || !p2.includes(":")) continue;
    if (patternRe(p2).test(p)) {
      shadowed.push({ route: entry.route, from: entry.from, by: table[j] });
      return;
    }
  }
});

for (const s of shadowed) {
  console.log(`  FAIL ${s.route} (${s.from})`);
  console.log(`         unreachable: ${s.by.route} (${s.by.from}) matches it first`);
  console.log(`         move it above that route in its module, or the module earlier in index.js`);
}
check("no literal route is shadowed by an earlier pattern", shadowed.length === 0);
fail += shadowed.length;

// The two that were shadowed, named so a regression is recognisable rather
// than just a count going up.
for (const route of ["GET /api/exams/dashboard", "GET /api/exams/reports/results"]) {
  check(`${route} is reachable`, !shadowed.some((s) => s.route === route));
}

// And the same question asked of the matcher itself, since the check above is
// only as good as its idea of how a pattern matches.
check("a parameter matches one segment, not several",
  !patternRe("/api/exams/:id").test("/api/exams/1/scores"));
check("a literal segment matches itself",
  patternRe("/api/exams/:id").test("/api/exams/dashboard"));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
