// desktop/scripts/coverage.js
"use strict";

/**
 * How much of the console works offline.
 *
 *   npm run coverage
 *
 * ── Why a script rather than a number in a commit message ─────────────────
 *
 * Because the goal is every endpoint the console calls, there are 180 of them,
 * and the work is long enough that a figure quoted from memory goes stale within
 * a day. This reads the web app's own call sites, so the denominator is what the
 * application actually asks for rather than what somebody wrote down.
 *
 * It also keeps three numbers apart that are easy to blur over a long job:
 * answered offline, deliberately online-only, and still to do. The middle one is
 * a set of decisions with reasons in src/main/api/coverage.js, not a backlog.
 *
 * ── What it cannot see ────────────────────────────────────────────────────
 *
 * Calls whose path is composed at runtime from something other than a per-file
 * BASE constant. An earlier version of this count missed every BASE-composed
 * call and reported 100 endpoints where there are 180 — so the number here is a
 * floor, and it says so rather than implying precision.
 */

const fs   = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "..", "web", "src");

const { ONLINE_ONLY, PARTIAL } = require("../src/main/api/coverage");
const { routes }      = require("../src/main/api");

// ─────────────────────────────────────────────────────────────────────────────

/** Every endpoint the console calls, as "METHOD /path" with :id for parameters. */
const consoleCalls = () => {
  const found = new Map();   // endpoint -> Set(files)

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;

      const src = fs.readFileSync(p, "utf8");

      // Per-file path constants. Missing these is what made the first count
      // wrong by 80 endpoints.
      const bases = {};
      for (const m of src.matchAll(/const\s+(BASE|ROOT|URL|PREFIX)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
        bases[m[1]] = m[2];
      }

      for (const m of src.matchAll(/\bapi\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]*)\2/g)) {
        let route = m[3];
        for (const [name, value] of Object.entries(bases)) {
          if (route.startsWith(`\${${name}}`)) {
            route = value + route.slice(`\${${name}}`.length);
            break;
          }
        }
        route = route.replace(/\$\{[^}]*\}/g, ":id").replace(/\?.*$/, "").replace(/\/+$/, "");

        // A call composed with the qs() helper — api.get(`${BASE}${qs({...})}`) —
        // leaves a tail once the template holes become :id, giving paths like
        // "/approvals:id)}" that no route has. Trimmed to the real endpoint
        // rather than reported as two phantom entries in the backlog.
        route = route.replace(/:id\)\}?$/, "").replace(/\/+$/, "");

        if (!route.startsWith("/")) continue;

        const key = `${m[1].toUpperCase()} ${route}`;
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(path.relative(WEB, p));
      }
    }
  };
  walk(WEB);
  return found;
};

/** What the local API answers, normalised to match the call sites. */
const answered = () => new Set(
  routes().map((r) => {
    const [, method, p] = r.match(/^(?:read|queue)\s+(\w+)\s+(.+)$/) ?? [];
    return `${method} ${p.replace(/^\/api/, "").replace(/:[A-Za-z]+/g, ":id")}`;
  })
);

// ─────────────────────────────────────────────────────────────────────────────

const calls    = consoleCalls();
const offline  = answered();
const declared = new Set(ONLINE_ONLY.map((e) => e.endpoint));

const all       = [...calls.keys()].sort();
const done      = all.filter((c) => offline.has(c));
const onlineOnly = all.filter((c) => declared.has(c) && !offline.has(c));
const todo      = all.filter((c) => !offline.has(c) && !declared.has(c));

const pct = (n) => `${Math.round((n / all.length) * 100)}%`;

console.log("");
console.log(`  endpoints the console calls   ${all.length}`);
console.log(`  answered offline              ${String(done.length).padStart(3)}   ${pct(done.length)}`);
console.log(`  deliberately online-only      ${String(onlineOnly.length).padStart(3)}   ${pct(onlineOnly.length)}`);
console.log(`  still to do                   ${String(todo.length).padStart(3)}   ${pct(todo.length)}`);

// Answered, but with a case that still goes to the network. Counted above as
// answered, because they are — and listed here so the count does not quietly
// become a claim it cannot support.
if (PARTIAL.length) {
  console.log("");
  console.log("  answered offline except in one case:");
  for (const p of PARTIAL) {
    console.log(`    ${p.endpoint.padEnd(30)} ${p.except}`);
  }
}

// Declared online-only but no longer called: worth knowing, because a reason
// recorded for an endpoint nobody calls is a reason nobody will ever read.
const stale = [...declared].filter((e) => !calls.has(e)).sort();
if (stale.length) {
  console.log("");
  console.log("  declared online-only but not called by the console any more:");
  for (const e of stale) console.log(`    ${e}`);
}

// The remaining work, grouped, so a batch can be chosen rather than guessed at.
const byDomain = new Map();
for (const c of todo) {
  const p = c.split(" ")[1];
  const m = /^\/([^/]+)(?:\/([^/]+))?/.exec(p);
  const d = m ? (m[1] === "admin" ? `admin/${m[2] ?? ""}`.replace(/\/$/, "") : m[1]) : "other";
  if (!byDomain.has(d)) byDomain.set(d, []);
  byDomain.get(d).push(c);
}

console.log("");
console.log("  still to do, by area:");
for (const [domain, list] of [...byDomain].sort((a, b) => b[1].length - a[1].length)) {
  const reads = list.filter((c) => c.startsWith("GET")).length;
  console.log(`    ${domain.padEnd(24)} ${String(list.length).padStart(3)}  (${reads} read, ${list.length - reads} write)`);
}

if (process.argv.includes("--list")) {
  console.log("");
  for (const [domain, list] of [...byDomain].sort()) {
    console.log(`  ${domain}`);
    for (const c of list) console.log(`    ${c}`);
  }
}

console.log("");
console.log("  A floor, not a census: calls composed at runtime from anything other");
console.log("  than a per-file BASE constant are invisible here.");
console.log("");
