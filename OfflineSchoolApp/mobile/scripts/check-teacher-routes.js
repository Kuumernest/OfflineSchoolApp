// mobile/scripts/check-teacher-routes.js
"use strict";

/**
 * Every route a screen navigates to is a screen that exists.
 *
 * The teacher dashboard listed a Homework module at /teacher/homework and a
 * quick action at /teacher/homework/create. Both had been there since the
 * dashboard was written, and neither screen existed: expo-router is
 * file-based, so a route is a file, and app/teacher/homework/ was not there.
 * A teacher who tapped either got the dashboard's navigation-error alert.
 * Nothing static could see it — the strings were well-formed, the translator
 * had labels for them, the parser was happy — and a dead link ships looking
 * exactly like a live one.
 *
 * So this resolves every literal route under app/ the way expo-router would:
 * "/teacher/homework" is app/teacher/homework.js or app/teacher/homework/
 * index.js, "/teacher/homework/[id]" is that file, and a query string is not
 * part of the path. Any that resolves to nothing fails here.
 *
 *   node scripts/check-teacher-routes.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP  = path.join(ROOT, "app");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full) : /\.jsx?$/.test(e.name) ? [full] : [];
});

/** Does a file-based route exist for this path? */
const resolves = (route) => {
  const clean = route.split("?")[0].replace(/\/+$/, "");
  const segments = clean.split("/").filter(Boolean);
  let dir = APP;
  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i];
    const last = i === segments.length - 1;
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const exact   = names.find((n) => n === seg || n === `${seg}.js` || n === `${seg}.jsx`);
    const dynamic = names.find((n) => /^\[.+\]/.test(n));
    const hit = exact ?? dynamic;
    if (!hit) return false;
    const full = path.join(dir, hit);
    if (last) {
      if (fs.statSync(full).isFile()) return true;
      return ["index.js", "index.jsx"].some((f) => fs.existsSync(path.join(full, f)));
    }
    if (!fs.statSync(full).isDirectory()) return false;
    dir = full;
  }
  return false;
};

// The ways a screen names a destination. Only literals; a computed route
// cannot be checked statically and is out of scope on purpose.
const ROUTE = /(?:route|pathname|href):\s*["'`](\/[a-zA-Z0-9\-_/[\]?=&.]+)["'`]|router\.(?:push|replace|navigate)\(\s*["'`](\/[a-zA-Z0-9\-_/[\]?=&.]+)["'`]/g;

console.log("--- every literal route under app/ opens a screen ---");
const seen = new Map();
for (const file of walk(APP)) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(ROUTE)) {
    const route = m[1] ?? m[2];
    if (!route || route.startsWith("/(")) continue;
    if (!seen.has(route)) seen.set(route, path.relative(ROOT, file).replace(/\\/g, "/"));
  }
}
// Dead routes this check found on its first run that are somebody else's
// feature. Listed so the check is a ratchet — a NEW dead route fails, these
// are reported — rather than a bar nobody can clear. Remove an entry the day
// its screen is written.
const KNOWN_DEAD = new Set([
  "/teacher/students/[id]",   // the teacher's student list links to a detail screen that does not exist
]);
const dead  = [...seen].filter(([route]) => !resolves(route));
const fresh = dead.filter(([route]) => !KNOWN_DEAD.has(route));
const known = dead.filter(([route]) =>  KNOWN_DEAD.has(route));
if (fresh.length === 0) ok(`${seen.size} distinct routes; every one not already known dead resolves to a screen`);
else bad("routes that open nothing", fresh.map(([r, f]) => `${r}   (first seen in ${f})`).join("\n"));
for (const [r, f] of known) console.log(`  note  ${r} is still dead (first seen in ${f}) — known, outside this check's scope`);
const healed = [...KNOWN_DEAD].filter((r) => resolves(r));
if (healed.length) bad("known-dead routes that now resolve — remove them from KNOWN_DEAD", healed.join("\n"));

console.log("--- the teacher's homework, in particular ---");
for (const route of ["/teacher/homework", "/teacher/homework/create", "/teacher/homework/[id]"]) {
  if (resolves(route)) ok(`${route} is a screen`); else bad(`${route} is not a screen`);
}
const dashboard = fs.readFileSync(path.join(APP, "teacher", "dashboard.js"), "utf8");
if (/route:\s*["']\/teacher\/homework["']/.test(dashboard) && /route:\s*["']\/teacher\/homework\/create["']/.test(dashboard)) {
  ok("the dashboard still links the module and the quick action");
} else {
  bad("the dashboard no longer links homework the way it did");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
