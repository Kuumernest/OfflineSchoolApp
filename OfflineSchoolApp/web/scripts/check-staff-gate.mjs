// web/scripts/check-staff-gate.mjs
//
// The web console is for the school office; teachers and students get one
// screen pointing them to the phone app (2026-10-30).
//
// What this pins:
//   - the gate (src/components/auth/StaffOnly.tsx) lets in super_admin,
//     school_admin and bursar — never teacher or student;
//   - it is the ONE gate: in App.tsx every route inside ProtectedRoute, other
//     than /change-password, sits under <StaffOnly>, so a deep link such as
//     /students/new or /exams/new reaches the gate before any page;
//   - the parent portal and /login stay outside ProtectedRoute altogether;
//   - the screen's words exist in English and French, for both roles;
//   - the download links come from configuration only — no URL in the source.
//
//   node scripts/check-staff-gate.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

console.log("--- who the console is for ---");
const gate  = read("src/components/auth/StaffOnly.tsx");
const staff = (gate.match(/const STAFF:\s*UserRole\[\]\s*=\s*\[([^\]]*)\]/) || [])[1] ?? "";
const roles = [...staff.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
check("the office only: super_admin, school_admin, bursar", roles, ["bursar", "school_admin", "super_admin"]);

console.log("--- one gate, in front of every page ---");
const app = read("src/App.tsx");
const protectedStart = app.indexOf("<Route element={<ProtectedRoute />}>");
const gateAt = app.indexOf("<Route element={<StaffOnly><DashboardLayout /></StaffOnly>}>");
check("the dashboard shell is wrapped by StaffOnly inside ProtectedRoute",
  [protectedStart > -1, gateAt > protectedStart], [true, true]);
const between = app.slice(protectedStart, gateAt);
check("the only route before the gate is /change-password",
  [...between.matchAll(/path="([^"]+)"/g)].map((m) => m[1]), ["/change-password"]);
const before = app.slice(0, protectedStart);
check("/login and the parent portal stay outside ProtectedRoute",
  [/path="\/login"/.test(before), /path="\/portal"/.test(before)], [true, true]);
const pagesUnderGate = [...app.slice(gateAt).matchAll(/path="(\/[^"]*)"/g)].map((m) => m[1]);
check("deep links from the report are under the gate",
  ["/students/new", "/exams/new", "/exams/:id", "/dashboard"].filter((p) => !pagesUnderGate.includes(p)), []);

console.log("--- the screen, in both languages ---");
const en = JSON.parse(read("src/i18n/locales/en.json")).staffOnly;
const fr = JSON.parse(read("src/i18n/locales/fr.json")).staffOnly;
const keys = ["signOut", "greeting", "teacher.title", "teacher.explain", "teacher.useApp",
  "student.title", "student.explain", "student.useApp", "getAndroid", "getIos", "askOffice"];
const get = (o, k) => k.split(".").reduce((x, p) => x?.[p], o);
check("every string exists in English", keys.filter((k) => !get(en, k)), []);
check("every string exists in French", keys.filter((k) => !get(fr, k)), []);
check("and the French is not the English", keys.filter((k) => get(en, k) === get(fr, k)), []);
check("the teacher's title says to use the app",
  [/mobile app/i.test(en.teacher.title), /application mobile/i.test(fr.teacher.title)], [true, true]);

console.log("--- the download links are configuration ---");
const cfg = read("src/config/mobileApp.ts");
check("read from VITE_ANDROID_APP_URL and VITE_IOS_APP_URL",
  [/import\.meta\.env\.VITE_ANDROID_APP_URL/.test(cfg), /import\.meta\.env\.VITE_IOS_APP_URL/.test(cfg)], [true, true]);
check("no URL written into the code", (cfg.replace(/\/\/.*$/gm, "").match(/https?:\/\/[^\s"'`]+/g) || []), []);
check("the screen uses the config, not a literal link", [/MOBILE_APP_LINKS/.test(gate), /href="https?:/.test(gate)], [true, false]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
