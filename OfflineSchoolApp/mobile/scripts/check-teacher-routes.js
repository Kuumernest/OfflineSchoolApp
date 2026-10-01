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

// The ways a screen names a destination. Literals, and template literals
// whose ${…} parts are read as one dynamic segment each: `/admin/teachers/${id}`
// is /admin/teachers/[x], which an [id].js would answer and nothing else
// does. A route held in a variable cannot be checked statically and is out
// of scope on purpose.
const ROUTE = /(?:route|pathname|href):\s*["'](\/[a-zA-Z0-9\-_/[\]?=&.]+)["']|router\.(?:push|replace|navigate)\(\s*["'](\/[a-zA-Z0-9\-_/[\]?=&.]+)["']|(?:route|pathname|href):\s*`(\/[^`]+)`|router\.(?:push|replace|navigate)\(\s*`(\/[^`]+)`/g;
const asRoute = (raw) => raw.split("?")[0].replace(/\$\{[^}]*\}/g, "[x]");

console.log("--- every literal route under app/ opens a screen ---");
const seen = new Map();
for (const file of walk(APP)) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(ROUTE)) {
    const route = asRoute(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
    if (!route || route.startsWith("/(")) continue;
    if (!seen.has(route)) seen.set(route, path.relative(ROOT, file).replace(/\\/g, "/"));
  }
}
// Dead routes this check tolerates. None: the roster row that pointed at a
// pupil screen no teacher has is a row now, the subject pencil opens the form
// on the subject, and "view profile" after adding a teacher opens the
// teacher's edit screen (docs/35). The set stays so a future entry is a
// deliberate, visible decision rather than a silent failure.
const KNOWN_DEAD = new Set([]);
const dead  = [...seen].filter(([route]) => !resolves(route));
const fresh = dead.filter(([route]) => !KNOWN_DEAD.has(route));
const known = dead.filter(([route]) =>  KNOWN_DEAD.has(route));
if (fresh.length === 0) ok(`${seen.size} distinct routes; every one not already known dead resolves to a screen`);
else bad("routes that open nothing", fresh.map(([r, f]) => `${r}   (first seen in ${f})`).join("\n"));
for (const [r, f] of known) console.log(`  note  ${r} is still dead (first seen in ${f}) — known, outside this check's scope`);
const healed = [...KNOWN_DEAD].filter((r) => resolves(r));
if (healed.length) bad("known-dead routes that now resolve — remove them from KNOWN_DEAD", healed.join("\n"));

console.log("--- the three links the parity audit found dead, and the orphan, in particular ---");
for (const [route, label] of [
  ["/admin/subjects/add", "the subject pencil's destination"],
  ["/admin/teachers/edit", "the destination of \"view profile\" after adding a teacher"],
  ["/teacher/explorations/[studentId]", "the pupil's explorations, from the class intelligence card"],
  ["/student/fees", "the pupil's fees"],
]) { if (resolves(route)) ok(`${route} is a screen (${label})`); else bad(`${route} is not a screen (${label})`); }
const roster = fs.readFileSync(path.join(APP, "teacher", "students", "index.js"), "utf8");
if (!/\/teacher\/students\/\[id\]/.test(roster)) ok("the teacher's roster no longer points at a pupil screen that does not exist");
else bad("the teacher's roster still points at /teacher/students/[id]");
if (!fs.existsSync(path.join(APP, "admin", "timetable", "periods.js"))) ok("the unlinked duplicate of /admin/periods is gone");
else bad("app/admin/timetable/periods.js is back: an orphan duplicate of the linked /admin/periods screens");

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
