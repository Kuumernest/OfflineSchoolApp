// backend/scripts/check-marks-scope.js
"use strict";

/**
 * A teacher writes marks for the (class, subject) pairs they are assigned, in
 * their own school, and reads results within it — and nobody reaches another
 * school's marks by knowing an id.
 *
 * docs/20-authorization-audit.md, N2/N3/N4/N5 and the exam/results findings
 * from the sub-audits: the bulk sheet and the single-mark route enforce the
 * TeacherAssignment PAIR, derived from the exam's own ExamSubject row rather
 * than from the request; every per-student read and write in the results
 * controller starts from the exam IN THE CALLER'S SCHOOL; the exam-subject
 * delete carries a guard; the generated-report upsert cannot re-parent another
 * school's card; a template preview and a legacy teacher marks route are
 * scoped the same way.
 *
 * Real routers, real door, in-memory database.
 *
 *   node scripts/check-marks-scope.js
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
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Subject           = mongoose.model("Subject");
  const Student           = mongoose.model("Student");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Exam              = mongoose.model("Exam");
  const ExamSubject       = mongoose.model("ExamSubject");
  const StudentScore      = mongoose.model("StudentScore");
  const ResultSummary     = mongoose.model("ResultSummary");
  const GeneratedReport   = mongoose.model("GeneratedReport");
  const ReportTemplate    = mongoose.model("ReportTemplate");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const YEAR = "2026-2027";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);

  const PASSWORD = "Check-only-passw0rd";
  const mkUser = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true, ...extra,
  });
  await Promise.all([
    mkUser("maths-a",   "teacher",      A),   // Mathematics in 3A, Physics in 4B
    mkUser("physics-a", "teacher",      A),   // Physics in 3A
    mkUser("idle-a",    "teacher",      A),   // no assignments
    mkUser("teacher-b", "teacher",      B),   // Mathematics in 1B
    mkUser("admin-a",   "school_admin", A),
    mkUser("admin-b",   "school_admin", B),
    mkUser("bursar-a",  "bursar",       A),
    mkUser("root",      "super_admin",  null),
    mkUser("pupil-a",   "student",      A, { enrollmentNo: "A-0001" }),
  ]);

  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths-3a",   schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "physics-3a", schoolId: A, name: "Physics",     classId: "form3a" },
    { _id: "maths-4b",   schoolId: A, name: "Mathematics", classId: "form4b" },
    { _id: "physics-4b", schoolId: A, name: "Physics",     classId: "form4b" },
    { _id: "maths-1b",   schoolId: B, name: "Mathematics", classId: "form1b" },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "maths-a",   class: "form3a", subject: "maths-3a" },
    { schoolId: A, teacher: "maths-a",   class: "form4b", subject: "physics-4b" },
    { schoolId: A, teacher: "physics-a", class: "form3a", subject: "physics-3a" },
    // Switched off: must count for nothing.
    { schoolId: A, teacher: "idle-a",    class: "form3a", subject: "maths-3a", isActive: false },
    { schoolId: B, teacher: "teacher-b", class: "form1b", subject: "maths-1b" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st-a1", A, "form3a", 1), pupil("st-a2", A, "form3a", 2), pupil("st-a3", A, "form4b", 3),
    pupil("st-b1", B, "form1b", 1),
  ]);
  const exam = (id, schoolId, classId) => ({
    _id: id, schoolId, name: `Sequence ${id}`, type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 1, status: "ongoing", classId, totalMarks: 20, passMark: 10,
  });
  await Exam.create([exam("ex-a", A, "form3a"), exam("ex-a4", A, "form4b"), exam("ex-b", B, "form1b")]);
  await ExamSubject.create([
    { _id: "es-a-maths", examId: "ex-a",  subjectId: "maths-3a",   classId: "form3a", schoolId: A, subjectName: "Mathematics", maxScore: 20 },
    { _id: "es-a-phys",  examId: "ex-a",  subjectId: "physics-3a", classId: "form3a", schoolId: A, subjectName: "Physics",     maxScore: 20 },
    { _id: "es-a4-maths",examId: "ex-a4", subjectId: "maths-4b",   classId: "form4b", schoolId: A, subjectName: "Mathematics", maxScore: 20 },
    { _id: "es-b-maths", examId: "ex-b",  subjectId: "maths-1b",   classId: "form1b", schoolId: B, subjectName: "Mathematics", maxScore: 20 },
  ]);

  // ── Real routers, behind the real door ──────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/exams",             auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/results",           auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use("/api/generated-reports", auth.authenticate, require(path.join(SRC, "routes/generated.report.routes")));
  app.use("/api/templates",         auth.authenticate, require(path.join(SRC, "routes/template.routes")));
  app.use("/api/teacher",           auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as = (id, role, schoolId) => {
    const token = sign(id, role, schoolId);
    return {
      get:    (url)       => call("GET",    url, { token }),
      post:   (url, body) => call("POST",   url, { token, body }),
      put:    (url, body) => call("PUT",    url, { token, body }),
      delete: (url)       => call("DELETE", url, { token }),
    };
  };
  const maths   = as("maths-a",   "teacher",      A);
  const physics = as("physics-a", "teacher",      A);
  const idle    = as("idle-a",    "teacher",      A);
  const beta    = as("teacher-b", "teacher",      B);
  const adminA  = as("admin-a",   "school_admin", A);
  const adminB  = as("admin-b",   "school_admin", B);
  const bursar  = as("bursar-a",  "bursar",       A);
  const root    = as("root",      "super_admin",  null);
  const pupilA  = as("pupil-a",   "student",      A);

  const sheet = (classId, subjectId, rows, extra = {}) => ({
    classId, subjectId, scores: rows.map(([studentId, score]) => ({ studentId, score })), ...extra,
  });
  const scoreOf = async (studentId, subjectId) =>
    (await StudentScore.findOne({ examId: "ex-a", studentId, subjectId, deletedAt: null }).lean());

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- N2: the bulk sheet asks the (class, subject) pair the exam names ---");

  let r = await maths.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 15]]));
  check("Mathematics in 3A, from its Mathematics teacher → saved", [r.status, (await scoreOf("st-a1", "maths-3a"))?.score], [201, 15]);

  r = await physics.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 3]]));
  check("same class, other subject (Physics teacher writes Mathematics) → 403 SUBJECT_NOT_ASSIGNED", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  check("  and the mark stands", (await scoreOf("st-a1", "maths-3a"))?.score, 15);

  r = await maths.post("/exams/ex-a4/scores/bulk", sheet("form4b", "maths-4b", [["st-a3", 9]]));
  check("same subject, other class (Mathematics teacher of 3A writes 4B) → 403", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);

  r = await idle.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 3]]));
  check("a teacher of the school with no active assignment → 403", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  check("  an assignment switched off counts for nothing", (await scoreOf("st-a1", "maths-3a"))?.score, 15);

  r = await beta.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 3]]));
  check("another school's teacher → 404, the exam is not theirs", r.status, 404);

  r = await physics.post("/exams/ex-a/scores/bulk", sheet("form3a", "physics-3a", [["st-a1", 11]], { examSubjectId: "es-a-maths" }));
  check("the pair comes from the exam's row, not the body: naming the Mathematics row while claiming Physics → 403", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  check("  Mathematics untouched", (await scoreOf("st-a1", "maths-3a"))?.score, 15);

  r = await adminA.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 3]], { examSubjectId: "es-b-maths" }));
  check("another school's examSubjectId → 404 Exam subject not found", r.status, 404);

  r = await adminA.post("/exams/ex-a/scores/bulk", sheet("form3a", "physics-3a", [["st-a2", 12], ["st-b1", 12]]));
  check("the administrator writes any subject of their school", r.status, 201);
  check("  a pupil of another school on the sheet is refused, the rest saved",
    [r.body?.failed, Boolean(await scoreOf("st-a2", "physics-3a")), await StudentScore.countDocuments({ studentId: "st-b1" })],
    [1, true, 0]);

  r = await bursar.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 3]]));
  check("the bursar holds no exams.view → 403", r.status, 403);
  r = await pupilA.post("/exams/ex-a/scores/bulk", sheet("form3a", "maths-3a", [["st-a1", 3]]));
  check("a pupil → 403", r.status, 403);

  r = await root.post(`/exams/ex-a/scores/bulk?schoolId=${A}`, { ...sheet("form3a", "maths-3a", [["st-a2", 17]]), schoolId: A });
  check("the super admin, naming the school, writes", [r.status, (await scoreOf("st-a2", "maths-3a"))?.score], [201, 17]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- N3: the single-mark route, anchored on the exam ---");

  r = await maths.post("/results/score", { examId: "ex-a", studentId: "st-a2", subjectId: "maths-3a", score: 12, maxScore: 20 });
  check("Mathematics teacher corrects a Mathematics mark → 200, class taken from the exam", [r.status, r.body?.data?.classId], [200, "form3a"]);

  r = await physics.post("/results/score", { examId: "ex-a", studentId: "st-a2", subjectId: "maths-3a", score: 1, maxScore: 20 });
  check("Physics teacher on a Mathematics mark → 403 SUBJECT_NOT_ASSIGNED", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  check("  the mark stands", (await scoreOf("st-a2", "maths-3a"))?.score, 12);

  r = await idle.post("/results/score", { examId: "ex-a", studentId: "st-a2", subjectId: "maths-3a", score: 1 });
  check("unassigned teacher → 403", r.status, 403);

  r = await maths.post("/results/score", { examId: "ex-a", studentId: "st-a1", subjectId: "maths-3a", classId: "form4b", score: 14, maxScore: 20 });
  check("a body classId the exam does not sit the subject in is ignored: the exam's class wins", [r.status, (await scoreOf("st-a1", "maths-3a"))?.classId, (await scoreOf("st-a1", "maths-3a"))?.score], [200, "form3a", 14]);

  r = await maths.post("/results/score", { examId: "ex-a", studentId: "st-a1", subjectId: "physics-3a", score: 1 });
  check("a subject the teacher does not teach → 403", r.status, 403);

  r = await beta.post("/results/score", { examId: "ex-a", studentId: "st-a1", subjectId: "maths-3a", score: 1 });
  check("another school's teacher → 404 Exam not found", r.status, 404);
  r = await adminB.post("/results/score", { examId: "ex-a", studentId: "st-a1", subjectId: "maths-3a", score: 1 });
  check("another school's administrator → 404", r.status, 404);
  check("  nothing written for Alpha by Beta", (await scoreOf("st-a1", "maths-3a"))?.score, 14);

  r = await maths.post("/results/score", { examId: "ex-a", studentId: "st-b1", subjectId: "maths-3a", score: 1 });
  check("a pupil of another school → 404 Student not found", r.status, 404);
  check("  and no row was minted for them", await StudentScore.countDocuments({ studentId: "st-b1" }), 0);

  r = await adminA.post("/results/score", { examId: "ex-a", studentId: "st-a1", subjectId: "physics-3a", score: 16, maxScore: 20 });
  check("the administrator corrects any subject → 201", r.status, 201);
  r = await pupilA.post("/results/score", { examId: "ex-a", studentId: "st-a1", subjectId: "maths-3a", score: 20 });
  check("a pupil holds no results.edit → 403", r.status, 403);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- results reads are one school's ---");

  await ResultSummary.create({
    _id: "sum-a1", examId: "ex-a", studentId: "st-a1", classId: "form3a", schoolId: A,
    average: 14.5, classPosition: 1, isPublished: false, subjects: [],
  });

  r = await adminB.get("/results/ex-a/student/st-a1");
  check("another school's admin reads a pupil's result by ids → 404", r.status, 404);
  r = await adminA.get("/results/ex-a/student/st-a1");
  check("  the school's own admin → 200", r.status, 200);

  r = await adminB.get("/results/ex-a/rankings");
  check("another school's admin reads the ranking → 404", r.status, 404);
  r = await adminA.get("/results/ex-a/rankings");
  check("  the school's own → the table", [r.status, r.body?.count], [200, 1]);

  r = await adminB.get("/results/ex-a/student/st-a1/reportcard");
  check("another school's admin builds a report card → 404", r.status, 404);
  r = await adminA.get("/results/ex-a/student/st-a1/reportcard");
  check("  the school's own → 200", r.status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- recomputing a summary: scoped, class-assigned, and guarded ---");

  const calc = (who, examId = "ex-a", studentId = "st-a1", extra = {}) => who.post(
    `/results/${examId}/student/${studentId}/reportcard/calculate`,
    { subjects: [{ subjectId: "maths-3a", subjectName: "Mathematics", score: 12, maxScore: 20, coefficient: 1 }], outOf: 20, passMark: 10, ...extra }
  );
  r = await calc(adminB);
  check("another school's admin → 404", r.status, 404);
  r = await calc(idle);
  check("a teacher not assigned to the pupil's class → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
  r = await calc(physics);
  check("a teacher of the class (any subject) → 200", r.status, 200);
  check("  the summary is the school's and updated", (await ResultSummary.findOne({ _id: "sum-a1" }).lean())?.average, 12);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- N4/N5: publish, retract and delete are one school's ---");

  r = await adminB.put("/results/summary/sum-a1/publish", { publish: true });
  check("another school's admin publishes a summary by id → 404", r.status, 404);
  check("  still unpublished", (await ResultSummary.findOne({ _id: "sum-a1" }).lean())?.isPublished, false);
  r = await adminA.put("/results/summary/sum-a1/publish", { publish: true });
  check("the school's own admin → 200, published", [r.status, (await ResultSummary.findOne({ _id: "sum-a1" }).lean())?.isPublished], [200, true]);

  r = await calc(physics);
  check("a published summary is not recomputed by a teacher → 423", r.status, 423);
  r = await calc(adminA, "ex-a", "st-a1", { changeReason: "Transcription error in Mathematics" });
  check("  an administrator may, with a reason → 200", r.status, 200);

  const a1Maths = await scoreOf("st-a1", "maths-3a");
  r = await adminB.delete(`/results/score/${a1Maths._id}`);
  check("another school's admin deletes a mark by id → 404", r.status, 404);
  check("  the mark stands", Boolean(await scoreOf("st-a1", "maths-3a")), true);
  r = await adminA.delete(`/results/score/${a1Maths._id}?changeReason=entered%20twice`);
  check("the school's own admin, with a reason → 200 or a 423 asking for one", [200, 423].includes(r.status), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- report cards: reissue, upsert and preview are one school's ---");

  await GeneratedReport.create({
    _id: "gr-a1", schoolId: A, examId: "ex-a", studentId: "st-a1", renderedHtml: "<p>Alpha's card</p>",
    templateVersion: 1, isPublished: true,
  });
  r = await adminB.post("/results/ex-a/student/st-a1/reportcard/reissue", {});
  check("another school's admin reissues a frozen card → 404", r.status, 404);
  check("  the card is unchanged", (await GeneratedReport.findOne({ _id: "gr-a1" }).lean())?.renderedHtml, "<p>Alpha's card</p>");

  r = await adminB.post("/generated-reports", { studentId: "st-a1", examId: "ex-a", renderedHtml: "<p>Beta wrote this</p>" });
  check("another school's admin upserts a card for Alpha's exam and pupil → 404", r.status, 404);
  r = await adminB.post("/generated-reports", { studentId: "st-b1", examId: "ex-a", renderedHtml: "<p>Beta wrote this</p>" });
  check("  or for their own pupil under Alpha's exam → 404", r.status, 404);
  const gr = await GeneratedReport.findOne({ _id: "gr-a1" }).lean();
  check("  Alpha's row still Alpha's, html intact", [gr.schoolId, gr.renderedHtml], [A, "<p>Alpha's card</p>"]);
  r = await adminA.post("/generated-reports", { studentId: "st-a1", examId: "ex-a", renderedHtml: "<p>Alpha reprinted</p>" });
  check("Alpha's own admin upserts → 201, same row", [r.status, r.body?.reportId], [201, "gr-a1"]);

  await ReportTemplate.create({ _id: "tpl-b", schoolId: B, name: "Beta layout", html: "<div>{{student_name}}</div>", css: "" });
  r = await adminB.post("/templates/tpl-b/preview", { examId: "ex-a", studentId: "st-a1" });
  check("a template preview cannot render another school's pupil → 404", r.status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the exam-subject delete carries a guard ---");

  for (const [who, name] of [[pupilA, "a pupil"], [bursar, "the bursar"], [maths, "a teacher"]]) {
    r = await who.delete("/exams/ex-a/subjects/es-a-phys");
    check(`${name} → 403`, r.status, 403);
  }
  check("  Physics is still on the exam", (await ExamSubject.findOne({ _id: "es-a-phys" }).lean())?.deletedAt ?? null, null);
  r = await adminB.delete("/exams/ex-a/subjects/es-a-phys");
  check("another school's admin → 404", r.status, 404);
  r = await adminA.delete("/exams/ex-a/subjects/es-a-phys");
  check("the school's own admin → 200", r.status, 200);

  console.log("\n--- references named in an exam write are this school's ---");
  r = await adminA.post("/exams/ex-a/subjects", { subjectId: "maths-1b" });
  check("another school's subject on an exam → 400", r.status, 400);
  r = await adminA.put("/exams/ex-a/subjects/es-a-maths", { teacherId: "teacher-b" });
  check("another school's teacher on an exam subject → 400", r.status, 400);
  r = await adminA.post("/exams", { name: "Cross", type: "test", academicYear: YEAR, term: 2, classId: "form1b", totalMarks: 20, passMark: 10 });
  check("an exam bound to another school's class carries no class", [r.status < 500, r.body?.exam?.classIds ?? r.body?.data?.classIds ?? []], [true, []]);

  console.log("\n--- the legacy teacher marks route ---");
  r = await maths.post("/teacher/exams/ex-b/marks", { marks: [{ studentId: "st-b1", marksObtained: 1, totalMarks: 20 }] });
  check("another school's exam → 404", r.status, 404);
  r = await idle.post("/teacher/exams/ex-a/marks", { marks: [{ studentId: "st-a1", marksObtained: 1, totalMarks: 20 }] });
  check("a teacher not assigned to the exam's class → 403", r.status, 403);
  r = await maths.post("/teacher/exams/ex-a/marks", { marks: [{ studentId: "st-a1", marksObtained: 15, totalMarks: 20 }] });
  check("a teacher of the class → 200", r.status, 200);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
