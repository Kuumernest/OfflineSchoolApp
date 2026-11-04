// web/scripts/check-dashboard-colours.mjs
//
// The school dashboard's tinted cards (config/dashboardTint.ts):
//   1. every token the tint classes name exists in index.css's @theme;
//   2. the colours pass WCAG AA (4.5:1) — the figure on its wash, the white
//      glyph on its solid square, label text on the wash;
//   3. the kinds take the agreed colours;
//   4. a warning tile is neutral at 0, amber above it, red for a timetable
//      conflict; notices stay info; plain counts take their kind's tint;
//   5. Create exam is the only primary quick action and every other action
//      names a kind;
//   6. no raw hex in the dashboard components, and the tint is opt-in
//      (only DashboardPage passes `tinted`).
//
//   node scripts/check-dashboard-colours.mjs     (Node 22.18+ / 24: strips TS types)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { DASH_ACCENT, DASH_TINT, dashTint, healthLook } =
  await import(path.join(ROOT, "src/config/dashboardTint.ts"));

// ── 1. Tokens ──────────────────────────────────────────────────────────────
const css = read("src/index.css");
const tokens = Object.fromEntries(
  [...css.matchAll(/--color-([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2]])
);
const used = new Set();
for (const t of Object.values(DASH_TINT)) {
  for (const cls of `${t.card} ${t.box} ${t.number}`.split(/\s+/)) {
    const m = cls.match(/^(?:bg|text|border-t)-(accent-[\w-]+)$/);
    if (m) used.add(m[1]);
  }
}
const missing = [...used].filter((n) => !tokens[n]);
check(`all ${used.size} accent tokens the tints use are defined`, missing, []);

// ── 2. Contrast ────────────────────────────────────────────────────────────
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const low = [];
for (const accent of Object.keys(DASH_TINT)) {
  const soft = tokens[`accent-${accent}-soft`];
  const pairs = [
    ["deep on soft",      tokens[`accent-${accent}-deep`], soft],
    ["white on solid",    "#FFFFFF",                      tokens[`accent-${accent}-solid`]],
    ["ink on soft",       tokens["ink"],                  soft],
    ["ink-muted on soft", tokens["ink-muted"],            soft],
  ];
  for (const [what, fg, bg] of pairs) {
    if (!fg || !bg) { low.push(`${accent}: ${what} (token missing)`); continue; }
    const r = ratio(fg, bg);
    if (r < 4.5) low.push(`${accent}: ${what} ${r.toFixed(2)}`);
  }
}
check("every tinted pairing is WCAG AA (≥ 4.5:1)", low, []);

// ── 3. Mapping ─────────────────────────────────────────────────────────────
check("headline kinds take the agreed colours", {
  students: DASH_ACCENT.students, teachers: DASH_ACCENT.teachers, classes: DASH_ACCENT.classes,
  subjects: DASH_ACCENT.subjects, exams: DASH_ACCENT.exams, attendance: DASH_ACCENT.attendance,
}, {
  students: "blue", teachers: "violet", classes: "indigo",
  subjects: "slate", exams: "amber", attendance: "green",
});
check("a tint is a wash, a 3px top edge, a solid square and a deep figure", dashTint("teachers"), {
  card:   "rounded-card border border-line border-t-[3px] border-t-accent-violet bg-accent-violet-soft shadow-card",
  box:    "bg-accent-violet-solid text-white",
  number: "text-accent-violet-deep",
});

// ── 4. Overview tiles ──────────────────────────────────────────────────────
const consts = read("src/constants/dashboard.constants.ts");
const rows = [...consts.matchAll(/\{\s*key:\s*"(\w+)"[^}]*\}/g)].map((m) => ({
  key: m[1],
  alertOnNonZero: /alertOnNonZero:\s*true/.test(m[0]),
  semantic: m[0].match(/semantic:\s*"(\w+)"/)?.[1],
  tone: m[0].match(/tone:\s*"(\w+)"/)?.[1],
}));
const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
const WARN = ["pendingApplications", "unassignedTeachers", "unassignedClassSubjects",
  "incompleteTimetableSlots", "timetableConflicts", "classesWithoutSubjects"];
check("the six warning tiles are alertOnNonZero",
  WARN.filter((k) => !byKey[k]?.alertOnNonZero), []);
check("a warning tile at 0 is neutral",
  WARN.map((k) => healthLook(byKey[k], 0).kind), WARN.map(() => "neutral"));
check("above 0 it is amber, a timetable conflict red",
  WARN.map((k) => healthLook(byKey[k], 3)),
  WARN.map((k) => ({ kind: "status", status: k === "timetableConflicts" ? "error" : "warning" })));
check("notices stay info", healthLook(byKey.activeAnnouncements, 4), { kind: "status", status: "info" });
check("plain counts take their kind's tint",
  ["approvedStudents", "totalTeachers", "totalClasses", "totalSubjects", "totalPeriods"]
    .map((k) => [k, healthLook(byKey[k], 7).kind, DASH_ACCENT[byKey[k].tone]]),
  [["approvedStudents", "kind", "blue"], ["totalTeachers", "kind", "violet"],
   ["totalClasses", "kind", "indigo"], ["totalSubjects", "kind", "slate"],
   ["totalPeriods", "kind", "teal"]]);

// ── 5. Quick actions ───────────────────────────────────────────────────────
const qa = consts.slice(consts.indexOf("QUICK_ACTIONS: QuickAction[]"));
const actions = [...qa.slice(0, qa.indexOf("];")).matchAll(/\{ label: "([^"]+)"[^}]*\}/g)].map((m) => m[0]);
check("Create exam is the only primary action",
  actions.filter((a) => /primary:\s*true/.test(a)).map((a) => a.match(/label: "([^"]+)"/)[1]), ["Create exam"]);
check("every quick action names a kind", actions.filter((a) => !/tone:\s*"\w+"/.test(a)).length, 0);
const qaSrc = read("src/components/dashboard/QuickActions.tsx");
check("the primary button stays solid primary blue",
  qaSrc.includes('"bg-primary-600 text-white shadow-card hover:bg-primary-700"'), true);

// ── 6. Hygiene ─────────────────────────────────────────────────────────────
const files = [
  "src/config/dashboardTint.ts",
  "src/components/dashboard/StatCard.tsx",
  "src/components/dashboard/SystemHealthGrid.tsx",
  "src/components/dashboard/QuickActions.tsx",
  "src/pages/dashboard/DashboardPage.tsx",
];
check("no raw hex colours in the dashboard components",
  files.filter((f) => /#[0-9A-Fa-f]{3,8}\b/.test(read(f).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))), []);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);
const tintedUsers = walk(path.join(ROOT, "src"))
  .filter((f) => /<StatCard\b[^>]*\btinted\b/s.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f));
check("only the school dashboard opts into tinted cards", tintedUsers, ["src/pages/dashboard/DashboardPage.tsx"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
