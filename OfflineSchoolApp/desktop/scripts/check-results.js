// desktop/scripts/check-results.js
"use strict";

/**
 * The results reads, exercised against the real document store.
 *
 * ── Why this script exists ─────────────────────────────────────────────────
 *
 * stats, rankings and the single-student result are the three results reads
 * that can be answered offline — the report-card JSON, its HTML render and
 * the reissue write all run the shared template engine and are deliberately
 * online-only (see the reasons in src/main/api/coverage.js).
 *
 * The mirror's arithmetic must match the server's exactly, so this check does
 * not trust a mock's idea of a filter: it runs against node:sqlite itself, the
 * same store a real desk uses. Every row is checked for the behaviour the
 * server's own code specifies:
 *
 *   stats      fully-absent children are excluded from present/passed and the
 *              averages, and an empty exam is the zeroed shape, not an error.
 *   rankings   the position field decides the scope's column, an absent
 *              position is the server's $ne:null exclusion, and the limit is
 *              applied by slicing AFTER fetch — a NaN or negative limit
 *              behaves the same way here as there.
 *   student    the summary row plus its scores; when the mirror has neither,
 *              the request goes to the server rather than inventing a 404 the
 *              mirror cannot justify (not-yet-processed looks identical to
 *              not-yet-synced).
 *
 * Tenancy is checked the way this project learned to: every happy path runs
 * beside another school's row, and the assertions state that the wrong-school
 * row is invisible — the same answer the fixed server gives.
 *
 * Run by `npm run check:results`, part of the desktop `check` chain.
 */

const api = require("../src/main/api");
const { open, documents } = require("../src/main/db/store");

const db = open(":memory:");
const ctx = {
  docs: documents(db),
  session: { userId: "admin-1", schoolId: "S1", role: "school_admin" },
  queue: { add: (r) => ({ seq: 1, duplicate: false }) },
};

// ResultSummary is the collection the server reads for results, rankings and
// stats. These rows were seeded as "examResult" — the model deleted when the
// two collections were merged — so every stats and rankings case below was
// querying an empty table.
ctx.docs.putMany("resultSummary", [
  { _id: "r1", examId: "e1", studentId: "s1", classId: "c1", schoolId: "S1",
    studentName: "Ada", admissionNo: "A1", className: "P4",
    classPosition: 1, gradePosition: 1, schoolPosition: 2,
    isPassing: true, average: 16.5, percentage: 82.5, gpa: 3.5,
    maxTotalScore: 20, overallGrade: "A",
    subjectScores: [{ subjectId: "x1", isAbsent: false, score: 18 }],
    subjectBreakdown: [
      { subjectId: "x1", subjectName: "Mathematics", score: 18, maxScore: 20,
        percentage: 90, isPassing: true },
    ] },
  { _id: "r2", examId: "e1", studentId: "s2", classId: "c1", schoolId: "S1",
    studentName: "Ben", admissionNo: "A2", className: "P4",
    classPosition: 2, gradePosition: 2, schoolPosition: 1,
    isPassing: true, average: 15, percentage: 75, gpa: 3.0,
    maxTotalScore: 20, overallGrade: "B",
    subjectScores: [{ subjectId: "x2", isAbsent: false, score: 15 }],
    subjectBreakdown: [
      { subjectId: "x2", subjectName: "English", score: 15, maxScore: 20,
        percentage: 75, isPassing: true },
    ] },
  { _id: "r3", examId: "e1", studentId: "s3", classId: "c1", schoolId: "S1",
    studentName: "Cam", admissionNo: "A3", className: "P4",
    classPosition: null, gradePosition: null, schoolPosition: null,
    isPassing: false, average: 0, percentage: 0, overallGrade: null,
    subjectScores: [{ subjectId: "x3", isAbsent: true }] },
  { _id: "r4", examId: "e1", studentId: "s99", classId: "c9", schoolId: "S2",
    studentName: "Zed", admissionNo: "Z1", className: "Other",
    classPosition: 1, gradePosition: 1, schoolPosition: 1,
    isPassing: true, average: 19, percentage: 95, gpa: 4.0,
    maxTotalScore: 20, overallGrade: "A+",
    subjectScores: [{ subjectId: "x9", isAbsent: false, score: 20 }] },
]);
ctx.docs.putMany("studentScore", [
  { _id: "sc1", examId: "e1", studentId: "s1", subjectId: "x1", classId: "c1", schoolId: "S1", score: 18, maxScore: 100 },
  { _id: "sc2", examId: "e1", studentId: "s1", subjectId: "x2", classId: "c1", schoolId: "S1", score: 15, maxScore: 100 },
  { _id: "sc9", examId: "e1", studentId: "s99", subjectId: "x9", classId: "c9", schoolId: "S2", score: 20, maxScore: 100 },
]);

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}` +
    (ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const call = (method, path, query = {}) =>
  api.handle({ method, path, query, body: {} }, ctx);

// ── stats ────────────────────────────────────────────────────────────────────
const stats = call("GET", "/api/results/e1/stats");
check("stats envelope", [stats.status, stats.data.success, stats.data.data && typeof stats.data.data.passRate], [200, true, "number"]);
const s = stats.data.data;
check("stats counts", [s.totalStudents, s.present, s.absent, s.passed, s.failed], [3, 2, 1, 2, 0]);
// average/highest/lowest are percentages now, not the /20 average:
// (82.5 + 75) / 2 = 78.75 — a 16.5/20 student must not read as 16.5%.
check("stats averages", [s.passRate, s.average, s.highest, s.lowest], [100, 78.75, 82.5, 75]);
check("stats classAverage alias matches average", s.classAverage, s.average);
check("stats gpa", s.averageGpa, 3.25);
check("stats distribution", s.gradeDistribution, { A: 1, B: 1 });
check("stats subjectStats shape", s.subjectStats.map((x) => x.subjectName), ["Mathematics", "English"]);
check("stats subjectStats numbers",
  s.subjectStats.map((x) => [x.average, x.highest, x.lowest, x.passRate, x.total]),
  [[90, 90, 90, 100, 1], [75, 75, 75, 100, 1]]);
const stats2 = call("GET", "/api/results/e1/stats", { classId: "c9" });
check("stats scoped to a class with no rows is the empty shape", stats2.data.data.totalStudents, 0);

// ── rankings ─────────────────────────────────────────────────────────────────
const rk = call("GET", "/api/results/e1/rankings");
check("rankings envelope", [rk.data.success, rk.data.rankBy, rk.data.count], [true, "class", 2]);
check("rankings exclude fully-absent and sort by classPosition", rk.data.data.map((r) => r.studentId), ["s1", "s2"]);
const rkS = call("GET", "/api/results/e1/rankings", { rankBy: "school" });
check("rankings scope=school sorts by schoolPosition", rkS.data.data.map((r) => r.studentId), ["s2", "s1"]);
const rkG = call("GET", "/api/results/e1/rankings", { rankBy: "grade" });
check("rankings scope=grade uses gradePosition", rkG.data.data.map((r) => r.studentId), ["s1", "s2"]);
const rkBad = call("GET", "/api/results/e1/rankings", { rankBy: "bogus" });
check("rankings unknown scope falls back to class", rkBad.data.rankBy, "class");
const rkL = call("GET", "/api/results/e1/rankings", { limit: 1 });
check("rankings limit slices in JS", rkL.data.data.map((r) => r.studentId), ["s1"]);

// ── single student result ────────────────────────────────────────────────────
const single = call("GET", "/api/results/e1/student/s1");
check("student result envelope",
  [single.status, single.data.success, single.data.data.summary.studentName],
  [200, true, "Ada"]);
check("student result carries scores", single.data.data.scores.map((sc) => sc.score), [18, 15]);
// s3 used to be the "neither summary nor scores" case, because its row lived in
// examResult while this read looked at resultSummary. Those are one collection
// now, so s3 HAS a summary — it is a pupil who sat nothing, not a pupil the
// mirror has never heard of. Both cases are worth keeping apart.
check("a pupil who was absent throughout still has a summary to show",
  [call("GET", "/api/results/e1/student/s3").status,
   call("GET", "/api/results/e1/student/s3").data.data.summary.isPassing],
  [200, false]);
check("student result with neither summary nor scores declines (not-found goes to server)",
  call("GET", "/api/results/e1/student/s404"), null);
check("student result for another school's child declines",
  call("GET", "/api/results/e1/student/s99"), null);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);