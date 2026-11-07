// web/scripts/check-active-nav.mjs
//
// One sidebar row is lit for the page you are on — never two.
//
// The failure this pins: every link decided for itself by prefix (NavLink), so
// on /students/admissions both Students and Admissions were highlighted, on
// /exams/results both Exams and Results, and so on for every entry that is a
// prefix of another. The rail now decides once (src/utils/activeNav.ts).
//
// Runs the real helper against the real nav paths (src/config/navigation.ts):
// for every entry, its own page and a page beneath it light exactly that entry.
//
//   node scripts/check-active-nav.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";
import ts   from "typescript";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// The helper, compiled as it is — it imports nothing, on purpose.
const { outputText } = ts.transpileModule(read("src/utils/activeNav.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { activeNavPath, isWithin } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const NAV = [...read("src/config/navigation.ts").matchAll(/\bpath:\s*"([^"]+)"/g)].map((m) => m[1]);

console.log("--- segment boundaries ---");
check("a page is within itself", isWithin("/exams", "/exams"), true);
check("and a page beneath it", isWithin("/exams/123", "/exams"), true);
check("not a sibling that shares letters", isWithin("/exams-archive", "/exams"), false);
check("a trailing slash on the URL still matches", isWithin("/students/", "/students"), true);

console.log("--- every entry in the rail ---");
check("the nav config was read", NAV.length > 20, true);
for (const p of NAV) {
  check(`${p} lights only itself`, activeNavPath(p, NAV), p);
}

console.log("--- the pairs that used to light together ---");
const PAIRS = [
  ["/students/admissions", "/students/admissions"],
  ["/students/abc123", "/students"],
  ["/exams/results", "/exams/results"],
  ["/exams/42/marks", "/exams"],
  ["/reports/cards", "/reports/cards"],
  ["/fees/structures/new", "/fees/structures"],
  ["/messages/audit", "/messages/audit"],
  ["/messages/thread-1", "/messages"],
  ["/teachers/assignments", "/teachers/assignments"],
  ["/platform/schools/abc", "/platform/schools"],
  ["/dashboard", "/dashboard"],
];
for (const [at, want] of PAIRS) check(`on ${at} → ${want}`, activeNavPath(at, NAV), want);

check("a page the rail does not list lights nothing", activeNavPath("/profile", NAV), null);
check("an entry the person cannot see falls back to its visible parent",
  activeNavPath("/exams/results", NAV.filter((p) => p !== "/exams/results")), "/exams");

console.log("--- the sidebar uses it ---");
const sidebar = read("src/components/layout/Sidebar.tsx");
check("no NavLink: its per-link prefix match is what lit two rows", /<NavLink\b|import\s*{[^}]*\bNavLink\b/.test(sidebar), false);
check("rows are active by the one computed path", /item\.path === activePath/.test(sidebar), true);
check("a group is active only when it holds that path", /c\.path === activePath/.test(sidebar), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
