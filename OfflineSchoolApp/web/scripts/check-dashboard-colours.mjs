// web/scripts/check-dashboard-colours.mjs
//
// The app's tinted cards (config/dashboardTint.ts):
//   1. every token the tint classes name exists in index.css's @theme;
//   2. the colours pass WCAG AA — text 4.5:1 (the figure on its wash, white
//      on a solid square, labels, amber/red figures), borders 3:1;
//   3. the kinds take the agreed colours;
//   4. every Setup health tile has the same solid icon square; a warning tile
//      has a navy figure at 0, amber above it, red for a timetable conflict;
//      notices take the full sky tint like any count;
//   5. every quick action is a tinted card in its own colour; Create exam is
//      highlighted (blue), and no tile in the grid is solid;
//   6. no grey or pale icon squares: the shared helpers (iconBox, StatCard,
//      MetricTile, EmptyTable) give the solid look by default, and no raw hex
//      or bare grey palette on the dashboards.
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

const { ALERT_NUMBER, DASH_ACCENT, DASH_TINT, dashTint, healthLook } =
  await import(path.join(ROOT, "src/config/dashboardTint.ts"));

// ── 1. Tokens ──────────────────────────────────────────────────────────────
const css = read("src/index.css");
const tokens = Object.fromEntries(
  [...css.matchAll(/--color-([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2]])
);
const used = new Set();
for (const t of Object.values(DASH_TINT)) {
  for (const cls of Object.values(t).join(" ").split(/\s+/)) {
    const m = cls.match(/^(?:bg|text|border-t|border|ring|ring-offset)-(accent-[\w-]+?)(?:\/\d+)?$/);
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
    // [what, foreground, background, minimum]
    ["deep on soft",          tokens[`accent-${accent}-deep`],  soft,   4.5],
    ["white on solid",        "#FFFFFF",                        tokens[`accent-${accent}-solid`], 4.5],
    ["ink on soft",           tokens["ink"],                    soft,   4.5],
    ["ink-muted on soft",     tokens["ink-muted"],              soft,   4.5],
    ["amber figure on soft",  tokens["warning-text"],           soft,   4.5],
    ["red figure on soft",    tokens["danger-text"],            soft,   4.5],
    ["amber border on soft",  tokens["accent-amber-solid"],     soft,   3],
    ["red border on soft",    tokens["danger"],                 soft,   3],
  ];
  for (const [what, fg, bg, min] of pairs) {
    if (!fg || !bg) { low.push(`${accent}: ${what} (token missing)`); continue; }
    const r = ratio(fg, bg);
    if (r < min) low.push(`${accent}: ${what} ${r.toFixed(2)} < ${min}`);
  }
}
check("every tinted pairing is WCAG AA (text 4.5:1, borders 3:1)", low, []);

// ── 3. Mapping ─────────────────────────────────────────────────────────────
check("headline kinds take the agreed colours", {
  students: DASH_ACCENT.students, teachers: DASH_ACCENT.teachers, classes: DASH_ACCENT.classes,
  subjects: DASH_ACCENT.subjects, exams: DASH_ACCENT.exams, attendance: DASH_ACCENT.attendance,
}, {
  students: "blue", teachers: "violet", classes: "indigo",
  subjects: "slate", exams: "amber", attendance: "green",
});
const tt = dashTint("teachers");
check("a tint is a wash, a 3px top edge, a solid square and a deep figure",
  { card: tt.card, box: tt.box, number: tt.number }, {
  card:    "rounded-card border border-line border-t-[3px] border-t-accent-violet bg-accent-violet-soft shadow-card",
  box:     "bg-accent-violet-solid text-white",
  number:  "text-accent-violet-deep",
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
check("a warning tile at 0 is calm (its kind's tint, a navy figure)",
  WARN.map((k) => healthLook(byKey[k], 0)), WARN.map(() => ({ kind: "alert", level: "ok" })));
check("above 0 it is amber, a timetable conflict red",
  WARN.map((k) => healthLook(byKey[k], 3)),
  WARN.map((k) => ({ kind: "alert", level: k === "timetableConflicts" ? "error" : "warning" })));
check("the figure is navy at 0, amber or red above it",
  ALERT_NUMBER, { ok: "text-ink", warning: "text-warning-text", error: "text-danger-text" });
check("an amber/red tile keeps its kind's wash, only the border changes",
  [dashTint("teachers").warnCard, dashTint("timetable").errorCard], [
    "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-violet-soft shadow-card",
    "rounded-card border border-danger border-t-[3px] bg-accent-teal-soft shadow-card",
  ]);
const grid = read("src/components/dashboard/SystemHealthGrid.tsx");
check("no tile falls back to a white card, a grey box or a status tint",
  [/CARD_SHELL/.test(grid), /accent-slate-soft/.test(grid), /SEMANTIC\[/.test(grid)], [false, false, false]);
check("every health tile has the same solid icon square", /const box\s*=\s*tint\.box;/.test(grid), true);
check("notices take the full sky treatment, not the info tint",
  [healthLook(byKey.activeAnnouncements, 4), DASH_ACCENT[byKey.activeAnnouncements.tone]], [{ kind: "kind" }, "sky"]);
check("no pale icon square variant is left", Object.values(DASH_TINT).some((t) => "softBox" in t), false);
check("plain counts take their kind's tint",
  ["approvedStudents", "totalTeachers", "totalClasses", "totalSubjects", "totalPeriods"]
    .map((k) => [k, healthLook(byKey[k], 7).kind, DASH_ACCENT[byKey[k].tone]]),
  [["approvedStudents", "kind", "blue"], ["totalTeachers", "kind", "violet"],
   ["totalClasses", "kind", "indigo"], ["totalSubjects", "kind", "slate"],
   ["totalPeriods", "kind", "teal"]]);

// ── 5. Quick actions ───────────────────────────────────────────────────────
const qa = consts.slice(consts.indexOf("QUICK_ACTIONS: QuickAction[]"));
const actions = [...qa.slice(0, qa.indexOf("];")).matchAll(/\{ label: "([^"]+)"[^}]*\}/g)].map((m) => m[0]);
check("Create exam is the one highlighted action",
  actions.filter((a) => /primary:\s*true/.test(a)).map((a) => a.match(/label: "([^"]+)"/)[1]), ["Create exam"]);
check("each quick action takes its agreed colour",
  Object.fromEntries(actions.map((a) => [a.match(/label: "([^"]+)"/)[1], a.match(/accent:\s*"(\w+)"/)?.[1]])), {
    "Add student": "blue", "Add teacher": "violet", "Create exam": "blue", "Take attendance": "green",
    "Post announcement": "sky", "View reports": "slate", "Add class": "indigo",
    "Assign teacher": "violet", "Report templates": "teal",
  });
const qaSrc = read("src/components/dashboard/QuickActions.tsx");
check("no solid tile in the quick-action grid",
  [/bg-primary-\d|bg-white\/15/.test(qaSrc), /DASH_TINT\[accent\]\.card/.test(qaSrc)], [false, true]);
check("Create exam is the blue tint with a blue border, not a fill",
  /"rounded-card border border-accent-blue-solid border-t-\[3px\] bg-accent-blue-soft shadow-card"/.test(qaSrc), true);

// ── 6. Hygiene ─────────────────────────────────────────────────────────────
const files = [
  "src/config/dashboardTint.ts",
  ...fs.readdirSync(path.join(ROOT, "src/components/dashboard")).map((f) => `src/components/dashboard/${f}`),
  "src/components/platform/MetricTile.tsx",
  "src/pages/dashboard/DashboardPage.tsx",
  "src/pages/platform/PlatformDashboardPage.tsx",
];
const code = (f) => read(f).replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
check("no raw hex colours in the dashboard components",
  files.filter((f) => /#[0-9A-Fa-f]{3,8}\b/.test(code(f))), []);
check("no bare grey palette (bg-gray-*, bg-line-strong) on the dashboards",
  files.filter((f) => /\b(?:bg|text)-gray-\d|\bbg-line-strong\b/.test(code(f))), []);
// An icon element (<SomeIcon className="…text-ink-faint…">) is grey; text in
// ink-faint on white is fine.
check("no grey icons on the dashboards",
  files.filter((f) => /<(?!p\b|span\b|div\b|dt\b|dd\b)[A-Z]\w*\s+className="[^"]*text-ink-faint/.test(code(f))), []);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);
// The shared pieces give every screen the tinted look by default.
check("StatCard and MetricTile are tinted unless told otherwise", [
  /tinted = true,/.test(read("src/components/dashboard/StatCard.tsx")),
  /tinted = true,/.test(read("src/components/platform/MetricTile.tsx")),
], [true, true]);
const sections = read("src/config/sections.ts");
check("iconBox() is the solid square and the shared mapping is the dashboards'",
  [/iconBox = \(tone: TileTone\): string => DASH_TINT\[DASH_ACCENT\[tone\]\]\.box/.test(sections),
   /CARD_ACCENT: Record<TileTone, Accent> = DASH_ACCENT/.test(sections), /ACCENT_BOX/.test(sections)],
  [true, true, false]);
check("the empty-table icon is a solid square with a white icon",
  /bg-accent-blue-solid text-white \[&_svg\]:h-5 \[&_svg\]:w-5 \[&_svg\]:text-white/.test(read("src/components/ui/DataTable.tsx")), true);
const opted = walk(path.join(ROOT, "src"))
  .filter((f) => /<(?:StatCard|MetricTile)\b[^>]*\btinted=\{false\}/s.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f));
check("no screen opts out of the tinted cards", opted, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
