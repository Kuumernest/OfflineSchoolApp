// backend/scripts/check-unpublished-results.js
"use strict";

/**
 * An unpublished exam result reaches nobody but an administrator.
 *
 * One rule, in one place (config/syncFeed publishedUnlessAdmin), applied to
 * every read of a ResultSummary: the sync feed, the exam's result list on both
 * routers, the statistics, the rankings, the single pupil and the report card.
 * Before this the feed mirrored every summary to a teacher's or a bursar's
 * desk, and the statistics, rankings and single-pupil reads answered drafts,
 * while only GET /api/results/:examId filtered — so a desk showed, and a
 * browser's results page ranked, grades the school had not decided.
 *
 *   node scripts/check-unpublished-results.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const A = "68e0000000000000000000a1";
  const YEAR = "2026-2027";
  await M("School").create({ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" });
  const mk = (id, role) => M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: A, isActive: true });
  await Promise.all([mk("maths-a", "teacher"), mk("bursar-a", "bursar"), mk("admin-a", "school_admin")]);
  await M("Class").create({ _id: "form3a", schoolId: A, name: "Form 3A" });
  await M("Subject").create({ _id: "maths-3a", schoolId: A, name: "Mathematics", classId: "form3a" });
  await M("TeacherAssignment").create({ schoolId: A, teacher: "maths-a", class: "form3a", subject: "maths-3a" });
  const pupil = (id, n) => ({ _id: id, userId: `u-${id}`, schoolId: A, classId: "form3a", studentName: `Pupil ${n}`, enrollmentNo: `A-${n}`, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", 1), pupil("st-a2", 2)]);
  await M("Exam").create({
    _id: "ex-a", schoolId: A, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 1,
    status: "completed", classId: "form3a", totalMarks: 20, passMark: 10,
  });
  await M("ExamSubject").create({ _id: "es-a", examId: "ex-a", subjectId: "maths-3a", classId: "form3a", schoolId: A, subjectName: "Mathematics", maxScore: 20 });
  await M("StudentScore").create([
    { examId: "ex-a", examSubjectId: "es-a", studentId: "st-a1", subjectId: "maths-3a", classId: "form3a", schoolId: A, score: 15, maxScore: 20 },
    { examId: "ex-a", examSubjectId: "es-a", studentId: "st-a2", subjectId: "maths-3a", classId: "form3a", schoolId: A, score: 12, maxScore: 20 },
  ]);
  const summary = (id, studentId, pos, isPublished) => ({
    _id: id, examId: "ex-a", studentId, classId: "form3a", schoolId: A, academicYear: YEAR, term: "1",
    average: 12, percentage: 60, isPassing: true, classPosition: pos, schoolPosition: pos, isPublished, subjectBreakdown: [],
  });
  await M("ResultSummary").create([summary("sum-1", "st-a1", 1, true), summary("sum-2", "st-a2", 2, false)]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/exams",   auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/results", auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use("/api/sync",    auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (url, token) => {
    const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const as = (id, role) => { const token = jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" }); return (url) => call(url, token); };
  const teacher = as("maths-a", "teacher"), bursar = as("bursar-a", "bursar"), admin = as("admin-a", "school_admin");
  const ids = (rows) => (rows ?? []).map((r) => r._id ?? r.studentId).sort();

  for (const [who, get] of [["a teacher", teacher], ["a bursar", bursar]]) {
    console.log(`\n--- ${who} reads published results and nothing else ---`);
    let r = await get("/sync/changes?collections=resultSummary");
    check("the sync feed mirrors the published summary only", ids(r.body?.collections?.resultSummary?.documents), ["sum-1"]);
    r = await get("/results/ex-a");
    check("GET /results/:examId lists the published one", ids(r.body?.data), ["sum-1"]);
    r = await get("/results/ex-a/stats");
    check("the statistics count the published one", [r.status, r.body?.data?.totalStudents], [200, 1]);
    r = await get("/results/ex-a/rankings");
    check("the rankings rank the published one", ids(r.body?.data), ["sum-1"]);
    check("the published pupil's result → 200", (await get("/results/ex-a/student/st-a1")).status, 200);
    check("the unpublished pupil's result → 404, as if it were not there", (await get("/results/ex-a/student/st-a2")).status, 404);
    check("and no report card for it → 404", (await get("/results/ex-a/student/st-a2/reportcard")).status, 404);
  }
  let r = await teacher("/exams/ex-a/results");
  check("the exam router's result list, for a teacher: the published one", [r.status, ids(r.body?.results)], [200, ["sum-1"]]);
  check("the exam router's result list is not the bursar's to read at all (exams.view)", (await bursar("/exams/ex-a/results")).status, 403);

  console.log("\n--- the administrator reads both, published or not ---");
  r = await admin("/sync/changes?collections=resultSummary");
  check("the feed mirrors both", ids(r.body?.collections?.resultSummary?.documents), ["sum-1", "sum-2"]);
  check("the list has both", ids((await admin("/results/ex-a")).body?.data), ["sum-1", "sum-2"]);
  check("the statistics count both", (await admin("/results/ex-a/stats")).body?.data?.totalStudents, 2);
  check("the rankings rank both", ids((await admin("/results/ex-a/rankings")).body?.data), ["sum-1", "sum-2"]);
  check("the unpublished pupil's result → 200", (await admin("/results/ex-a/student/st-a2")).status, 200);
  check("the exam router's list has both", ids((await admin("/exams/ex-a/results")).body?.results), ["sum-1", "sum-2"]);

  console.log("\n--- one rule, stated once ---");
  const feed = require(path.join(SRC, "config/syncFeed"));
  check("the feed entry for resultSummary carries the same scope as termResult and annualResult",
    ["resultSummary", "termResult", "annualResult"].map((c) => feed.byCollection.get(c).scope === feed.scopes.publishedUnlessAdmin), [true, true, true]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
