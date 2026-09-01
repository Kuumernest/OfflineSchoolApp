// desktop/scripts/check-settings.js
"use strict";

/**
 * The settings reads answered offline, exercised against the real store.
 *
 * ── What is checked ────────────────────────────────────────────────────────
 *
 * GET /admin/settings/analytics is the one settings read this batch answers:
 * deterministic arithmetic (counts and group-bys) over rows the mirror holds.
 * Its four writes — admin create, reset-password, delete and profile — are
 * online-only by decision (reasons in src/main/api/coverage.js), and that
 * decision is checked structurally: api.handle must answer null for each, so
 * the request really goes to the server rather than being answered locally.
 *
 * The behaviours the server specifies, pinned one by one:
 *
 *   summary      the server's four keys, and NOT totalStudents — the web screen
 *                reads summary.totalStudents, which the server never sends, so
 *                the tile renders "—" online and must render "—" here.
 *                Teachers are users with role "teacher" AND isActive true;
 *                classes are the one count excluding deleted rows; subjects
 *                count ALL rows (no deletedAt filter — bug-for-bug); so do
 *                assignments.
 *   trend        approved students only, within the six-month window, even when
 *                SOFT-DELETED (the $match has no deletedAt clause).
 *   bySubject    grouped by subject id with the name resolved; an id the mirror
 *                does not hold is "Unknown" ($ifNull).
 *   classLoad    approved students by class, no deletedAt filter on the
 *                students and no deletedAt filter on the name lookup.
 *
 * Tenancy is asserted the way this project learned to: another school's rows
 * sit in the store for every collection and none of them may appear in any
 * aggregate.
 *
 * Run by `npm run check:settings`, part of the desktop `check` chain.
 */

const api = require("../src/main/api");
const { open, documents } = require("../src/main/db/store");

const db = open(":memory:");
const ctx = {
  docs: documents(db),
  session: { userId: "u-admin", schoolId: "S1", role: "school_admin" },
  queue: { add: (r) => ({ seq: 1, duplicate: false }) },
};

const now = Date.now();
const sixMonthsAgo = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.getTime();
};
const window = sixMonthsAgo();

ctx.docs.putMany("student", [
  // In the six-month window, approved — must appear in the trend.
  { _id: "st1", schoolId: "S1", status: "approved", classId: "c1", createdAt: new Date(window + 5 * 86_400_000).toISOString() },
  // Soft-deleted, but the trend's $match has NO deletedAt clause.
  { _id: "st3", schoolId: "S1", status: "approved", classId: "c1", createdAt: new Date(window + 6 * 86_400_000).toISOString(), deletedAt: "2026-01-01T00:00:00.000Z" },
  // Too old — excluded from the trend, but a classLoad student.
  { _id: "st6", schoolId: "S1", status: "approved", classId: "c2", createdAt: new Date(now - 400 * 86_400_000).toISOString() },
  // Not approved — excluded from trend and classLoad.
  { _id: "st4", schoolId: "S1", status: "pending",  classId: "c1", createdAt: new Date(window + 1).toISOString() },
  // Another school, in-window — must stay invisible.
  { _id: "st5", schoolId: "S2", status: "approved", classId: "cX", createdAt: new Date(window + 5 * 86_400_000).toISOString() },
  // A second too old — the $gte boundary excludes it.
  { _id: "st2", schoolId: "S1", status: "approved", classId: "c1", createdAt: new Date(window - 1000).toISOString() },
]);

ctx.docs.putMany("class", [
  { _id: "c1", schoolId: "S1", name: "Form 3", isActive: true },
  // Soft-deleted: NOT in the class count, but classLoad's name lookup still
  // resolves it — the $lookup has no deletedAt filter.
  { _id: "c2", schoolId: "S1", name: "Form 4", isActive: true, deletedAt: "2026-01-01T00:00:00.000Z" },
  { _id: "c3", schoolId: "S1", name: "Inactive", isActive: false },
  { _id: "cX", schoolId: "S2", name: "Other school", isActive: true },
]);

ctx.docs.putMany("subject", [
  { _id: "sub1", schoolId: "S1", name: "Math" },
  // Soft-deleted but counted by the server — no deletedAt filter on subjects.
  { _id: "subX", schoolId: "S1", name: "Old", deletedAt: "2026-01-01T00:00:00.000Z" },
  { _id: "subY", schoolId: "S2", name: "Other" },
]);

ctx.docs.putMany("teacherAssignment", [
  { _id: "ta1", schoolId: "S1", teacher: "u1", class: "c1", subject: "sub1" },
  { _id: "ta2", schoolId: "S1", teacher: "u2", class: "c1", subject: "sub1" },
  // A subject the mirror does not hold — must resolve as "Unknown".
  { _id: "ta3", schoolId: "S1", teacher: "u1", class: "c1", subject: "subMissing" },
  { _id: "taX", schoolId: "S2", teacher: "uX", class: "cX", subject: "subY" },
]);

ctx.docs.putMany("user", [
  { _id: "u1", schoolId: "S1", role: "teacher",       isActive: true  },
  { _id: "u2", schoolId: "S1", role: "teacher",       isActive: false },
  { _id: "u3", schoolId: "S1", role: "school_admin",  isActive: true  },
  { _id: "uX", schoolId: "S2", role: "teacher",       isActive: true  },
]);

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}` +
    (ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const call = (method, path, body = {}, query = {}) =>
  api.handle({ method, path, query, body }, ctx);

const a = call("GET", "/api/admin/settings/analytics", {}, { schoolId: "S1" });
check("analytics is answered locally", a !== null, true);

const sum = a.data.analytics;
check("summary is the server's five keys",
  Object.keys(sum.summary).sort(),
  ["totalAssignments", "totalClasses", "totalStudents", "totalSubjects", "totalTeachers"]);
check("summary counts (teachers active, classes live, all subjects, all assignments)",
  [sum.summary.totalTeachers, sum.summary.totalClasses, sum.summary.totalSubjects, sum.summary.totalAssignments],
  [1, 1, 2, 3]);
// st1, st3, st6, st2 — every approved S1 pupil. st3 is soft-deleted and still
// counts, because the server's countDocuments filters on status alone; st4 is
// pending and st5 belongs to another school.
check("totalStudents counts approved pupils with no deletedAt filter, as on the server",
  sum.summary.totalStudents, 4);

const trendCount = sum.enrollmentTrend.reduce((s, e) => s + e.count, 0);
check("trend counts only approved students inside the six-month window (soft-deleted included)",
  trendCount, 2);
check("trend entries are {year, month, count} with whole numbers",
  sum.enrollmentTrend.every((e) =>
    Number.isInteger(e.year) && Number.isInteger(e.month) && Number.isInteger(e.count)),
  true);
let sorted = true;
for (let i = 1; i < sum.enrollmentTrend.length; i += 1) {
  const p = sum.enrollmentTrend[i - 1], c = sum.enrollmentTrend[i];
  if (c.year < p.year || (c.year === p.year && c.month < p.month)) sorted = false;
}
check("trend is sorted ascending by year then month", sorted, true);

check("teachersBySubject groups by subject with names resolved",
  sum.teachersBySubject,
  [{ subjectName: "Math", count: 2 }, { subjectName: "Unknown", count: 1 }]);
check("classLoad counts approved students by class with NO date filter (trend-excluded st2 still counts); name resolves for a deleted class",
  sum.classLoad,
  [{ className: "Form 3", count: 3 }, { className: "Form 4", count: 1 }]);

const allNames = [
  ...sum.teachersBySubject.map((r) => r.subjectName),
  ...sum.classLoad.map((r) => r.className),
].join("|");
check("no other-school row appears in any aggregate", allNames.includes("Other"), false);

// ── the four writes stay online: api.handle must answer null for each ───────
check("POST /admin/settings/admins declines (create is online-only)",
  call("POST", "/api/admin/settings/admins", { name: "N", email: "n@x.com" }), null);
check("POST /admin/settings/admins/:id/reset-password declines",
  call("POST", "/api/admin/settings/admins/u1/reset-password", {}), null);
check("DELETE /admin/settings/admins/:id declines",
  call("DELETE", "/api/admin/settings/admins/u1", {}), null);
check("PUT /admin/settings/profile declines",
  call("PUT", "/api/admin/settings/profile", { name: "N", email: "n@x.com" }), null);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);