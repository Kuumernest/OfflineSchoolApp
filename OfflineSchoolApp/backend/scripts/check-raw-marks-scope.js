// backend/scripts/check-raw-marks-scope.js
"use strict";

/**
 * Raw marks: who reads which rows, on every path that carries a StudentScore.
 *
 * The policy as the repository states it (docs/20 §7b, §11.7; docs/22 §4;
 * docs/36), asserted so it is not mistaken for a gap and so a change to it is
 * a visible decision:
 *
 *   - a TEACHER writes the marks of their own (class, subject) pairs and
 *     reads the whole school's sheets, draft or not — the recorded policy, a
 *     product decision still open; their own pairs come back through
 *     /teacher/results, the school through /exams/:examId/scores and the
 *     sync feed; never another school's, by id or by name;
 *   - a BURSAR holds results.view and not exams.view: a raw mark reaches them
 *     only inside a PUBLISHED result, online and in the mirror alike; the
 *     mark sheet and the teacher's results are not theirs;
 *   - an ADMINISTRATOR reads the school, published or not;
 *   - an OPERATOR names a school first; no school is no school, never every
 *     school — on the routes and on the feed;
 *   - a PUPIL and a GUARDIAN never reach a staff route; a pupil's own marks
 *     come through /results/my-results, published only;
 *   - an unpublished RESULT reaches nobody but an administrator on every
 *     list, including the two the exam router kept for exports.
 *
 *   node scripts/check-raw-marks-scope.js
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

  const A = "69a0000000000000000000a1";
  const B = "69a0000000000000000000b2";
  const YEAR = "2026-2027";
  await M("School").create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const mk = (id, role, schoolId) => M("User").create({
    _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mk("maths-a", "teacher", A), mk("bursar-a", "bursar", A), mk("bursar-b", "bursar", B),
    mk("admin-a", "school_admin", A), mk("admin-b", "school_admin", B), mk("root", "super_admin", null),
    mk("u-st-a1", "student", A),
  ]);
  await M("Class").create([
    { _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await M("Subject").create([
    { _id: "maths-3a",   schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "physics-4b", schoolId: A, name: "Physics",     classId: "form4b" },
    { _id: "maths-1b",   schoolId: B, name: "Mathematics", classId: "form1b" },
  ]);
  // maths-a teaches Mathematics in 3A and nothing else.
  await M("TeacherAssignment").create({ schoolId: A, teacher: "maths-a", class: "form3a", subject: "maths-3a" });
  const pupil = (id, userId, schoolId, classId, n) => ({
    _id: id, userId, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await M("Student").create([pupil("st-a1", "u-st-a1", A, "form3a", 1), pupil("st-a3", "u-st-a3", A, "form4b", 3), pupil("st-b1", "u-st-b1", B, "form1b", 1)]);
  const exam = (id, schoolId, classId, status) => ({
    _id: id, schoolId, name: `Sequence ${id}`, type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 1, status, classId, totalMarks: 20, passMark: 10,
  });
  // ex-a: results published. ex-a4: marked, processed, NOT published. ex-b: Beta's.
  await M("Exam").create([exam("ex-a", A, "form3a", "published"), exam("ex-a4", A, "form4b", "completed"), exam("ex-b", B, "form1b", "published")]);
  await M("ExamSubject").create([
    { _id: "es-a-maths", examId: "ex-a",  subjectId: "maths-3a",   classId: "form3a", schoolId: A, subjectName: "Mathematics", maxScore: 20 },
    { _id: "es-a4-phys", examId: "ex-a4", subjectId: "physics-4b", classId: "form4b", schoolId: A, subjectName: "Physics",     maxScore: 20 },
    { _id: "es-b-maths", examId: "ex-b",  subjectId: "maths-1b",   classId: "form1b", schoolId: B, subjectName: "Mathematics", maxScore: 20 },
  ]);
  await M("StudentScore").create([
    { _id: "sc-a1", examId: "ex-a",  examSubjectId: "es-a-maths", studentId: "st-a1", subjectId: "maths-3a",   classId: "form3a", schoolId: A, score: 15, maxScore: 20 },
    { _id: "sc-a3", examId: "ex-a4", examSubjectId: "es-a4-phys", studentId: "st-a3", subjectId: "physics-4b", classId: "form4b", schoolId: A, score: 12, maxScore: 20 },
    { _id: "sc-b1", examId: "ex-b",  examSubjectId: "es-b-maths", studentId: "st-b1", subjectId: "maths-1b",   classId: "form1b", schoolId: B, score: 9,  maxScore: 20 },
  ]);
  const summary = (id, examId, studentId, classId, schoolId, isPublished) => ({
    _id: id, examId, studentId, classId, schoolId, academicYear: YEAR, term: "1",
    average: 12, percentage: 60, isPassing: true, classPosition: 1, isPublished, subjectBreakdown: [],
  });
  await M("ResultSummary").create([
    summary("sum-a1", "ex-a",  "st-a1", "form3a", A, true),
    summary("sum-a3", "ex-a4", "st-a3", "form4b", A, false),
    summary("sum-b1", "ex-b",  "st-b1", "form1b", B, true),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/exams",   auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/results", auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use("/api/teacher", auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
  app.use("/api/sync",    auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return { get: (url) => call("GET", url, { token }), post: (url, body) => call("POST", url, { token, body }) };
  };
  const maths   = as("maths-a",  "teacher",      A);
  const bursar  = as("bursar-a", "bursar",       A);
  const bursarB = as("bursar-b", "bursar",       B);
  const adminA  = as("admin-a",  "school_admin", A);
  const adminB  = as("admin-b",  "school_admin", B);
  const root    = as("root",     "super_admin",  null);
  const student = as("u-st-a1",  "student",      A);
  // A guardian's token: audience "portal", never a staff identity.
  const guardianToken = jwt.sign({ aud: "portal", accessId: "ga-1", schoolId: A, sid: "s1" }, process.env.JWT_SECRET, { expiresIn: "20m" });
  const guardian = { get: (url) => call("GET", url, { token: guardianToken }) };

  const marks   = (r) => (r.body?.scores ?? []).map((s) => s._id).sort();
  const results = (r) => (r.body?.results ?? r.body?.data ?? []).map((s) => s._id).sort();
  const feed    = (r, c) => (r.body?.collections?.[c]?.documents ?? []).map((d) => d._id).sort();
  const refusedFeed = (r, c) => (r.body?.refused ?? []).some((x) => x.collection === c);

  console.log("\n--- the teacher: writes their pair, reads the school (the recorded policy) ---");
  let r = await maths.get("/teacher/results");
  check("their own results route answers their pair and nothing else", (r.body?.results ?? []).map((x) => `${x.classId}|${x.subjectId}|${x.studentId}`), ["form3a|maths-3a|st-a1"]);
  check("their own exam's sheet → 200, their mark", marks(await maths.get("/exams/ex-a/scores")), ["sc-a1"]);
  check("another class's sheet, unpublished → 200: school-wide by recorded policy (docs/20 §7b; a decision still open, docs/22 §4)", marks(await maths.get("/exams/ex-a4/scores")), ["sc-a3"]);
  r = await maths.post("/exams/ex-a4/scores/bulk", { classId: "form4b", subjectId: "physics-4b", scores: [{ studentId: "st-a3", score: 1 }] });
  check("but a mark in that class → 403 SUBJECT_NOT_ASSIGNED: the write is the pair's", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  check("the exports list shows them the published results only", results(await maths.get("/exams/reports/results")), ["sum-a1"]);
  check("and so does its sibling", results(await maths.get("/exams/submissions/results")), ["sum-a1"]);
  r = await maths.get("/sync/changes?collections=studentScore,resultSummary");
  check("the feed mirrors the school's marks (policy) and the published summaries only", [feed(r, "studentScore"), feed(r, "resultSummary")], [["sc-a1", "sc-a3"], ["sum-a1"]]);
  check("Beta's exam by id → nothing", marks(await maths.get("/exams/ex-b/scores")), []);
  check("naming Beta → 403 at the door", (await maths.get(`/exams/ex-b/scores?schoolId=${B}`)).status, 403);

  console.log("\n--- the bursar: a raw mark only inside a published result ---");
  check("a published result list → the published row", results(await bursar.get("/results/ex-a")), ["sum-a1"]);
  r = await bursar.get("/results/ex-a/student/st-a1");
  check("a published pupil result → 200, with its marks", [r.status, (r.body?.data?.scores ?? []).map((s) => s._id)], [200, ["sc-a1"]]);
  check("an unpublished pupil result → 404, marks included", (await bursar.get("/results/ex-a4/student/st-a3")).status, 404);
  check("the mark sheet is not theirs (exams.view) → 403", (await bursar.get("/exams/ex-a4/scores")).status, 403);
  check("the exports list is not theirs either → 403", (await bursar.get("/exams/reports/results")).status, 403);
  check("nor the teacher's results → 403", (await bursar.get("/teacher/results")).status, 403);
  r = await bursar.get("/sync/changes?collections=studentScore,resultSummary");
  check("the feed mirrors the marks of published exams only — what they can read — and the published summaries", [feed(r, "studentScore"), feed(r, "resultSummary")], [["sc-a1"], ["sum-a1"]]);
  check("Beta's bursar naming Alpha → 403", (await bursarB.get(`/results/ex-a?schoolId=${A}`)).status, 403);
  check("Beta's bursar's feed carries Beta's rows only", feed(await bursarB.get("/sync/changes?collections=studentScore"), "studentScore"), ["sc-b1"]);

  console.log("\n--- the administrator: the school, published or not ---");
  check("the unpublished sheet → 200", marks(await adminA.get("/exams/ex-a4/scores")), ["sc-a3"]);
  check("the exports list → both results", results(await adminA.get("/exams/reports/results")), ["sum-a1", "sum-a3"]);
  check("the unpublished pupil result → 200", (await adminA.get("/results/ex-a4/student/st-a3")).status, 200);
  check("the feed mirrors every mark of the school", feed(await adminA.get("/sync/changes?collections=studentScore"), "studentScore"), ["sc-a1", "sc-a3"]);
  check("Beta's administrator naming Alpha → 403", (await adminB.get(`/exams/ex-a/scores?schoolId=${A}`)).status, 403);
  check("Beta's administrator's feed is Beta's", feed(await adminB.get("/sync/changes?collections=studentScore"), "studentScore"), ["sc-b1"]);

  console.log("\n--- the operator: a school first; no school is no school ---");
  check("the sheet with no school → 400", (await root.get("/exams/ex-a/scores")).status, 400);
  check("the exports list with no school → 400", (await root.get("/exams/reports/results")).status, 400);
  check("the feed with no school mirrors nothing — not every school", feed(await root.get("/sync/changes?collections=studentScore"), "studentScore"), []);
  check("Alpha named: Alpha's sheet", marks(await root.get(`/exams/ex-a4/scores?schoolId=${A}`)), ["sc-a3"]);
  check("Alpha named: Alpha's marks on the feed, all of them", feed(await root.get(`/sync/changes?collections=studentScore&schoolId=${A}`), "studentScore"), ["sc-a1", "sc-a3"]);
  check("Beta named: Beta's", feed(await root.get(`/sync/changes?collections=studentScore&schoolId=${B}`), "studentScore"), ["sc-b1"]);

  console.log("\n--- the pupil and the guardian: no staff route ---");
  check("a pupil on the sheet → 403", (await student.get("/exams/ex-a/scores")).status, 403);
  check("a pupil on the result list → 403", (await student.get("/results/ex-a")).status, 403);
  check("a pupil on the teacher's results → 403", (await student.get("/teacher/results")).status, 403);
  r = await student.get("/sync/changes?collections=studentScore");
  check("a pupil's feed refuses the collection", [refusedFeed(r, "studentScore"), feed(r, "studentScore")], [true, []]);
  r = await student.get(`/results/my-results?schoolId=${A}`);
  check("a pupil's own route: their published result, nobody else's", [r.status, (r.body?.data ?? []).map((x) => x._id)], [200, ["sum-a1"]]);
  check("a guardian's token on a staff route → 401", (await guardian.get("/exams/ex-a/scores")).status, 401);
  check("a guardian's token on the feed → 401", (await guardian.get("/sync/changes?collections=studentScore")).status, 401);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
