// backend/scripts/check-teacher-read-scope.js
"use strict";

/**
 * A teacher reads their school's academic records and writes their own.
 *
 * The policy, stated so it is not mistaken for a gap (docs/20 §7b, §11.7;
 * docs/22): teachers' READS of marks, results, registers and the academic
 * sync collections are SCHOOL-wide — results.view, exams.view and
 * attendance.view are defined that way and every teacher screen relies on it
 * — while their WRITES are confined to the classes and (class, subject) pairs
 * they hold active assignments for. What must never be true is a teacher
 * reading another school's records, by naming the school, by knowing an id,
 * or through the sync feed.
 *
 *   node scripts/check-teacher-read-scope.js
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
  const Register          = mongoose.model("StudentAttendance");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const YEAR = "2026-2027";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const mk = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([mk("maths-a", "teacher", A), mk("teacher-b", "teacher", B), mk("admin-a", "school_admin", A)]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths-3a",   schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "physics-4b", schoolId: A, name: "Physics",     classId: "form4b" },
    { _id: "maths-1b",   schoolId: B, name: "Mathematics", classId: "form1b" },
  ]);
  // maths-a teaches Mathematics in 3A only. 4B is another teacher's class.
  await TeacherAssignment.create([
    { schoolId: A, teacher: "maths-a",   class: "form3a", subject: "maths-3a" },
    { schoolId: B, teacher: "teacher-b", class: "form1b", subject: "maths-1b" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([pupil("st-a1", A, "form3a", 1), pupil("st-a3", A, "form4b", 3), pupil("st-b1", B, "form1b", 1)]);
  const exam = (id, schoolId, classId) => ({
    _id: id, schoolId, name: `Sequence ${id}`, type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 1, status: "published", classId, totalMarks: 20, passMark: 10, resultsPublished: true,
  });
  await Exam.create([exam("ex-a", A, "form3a"), exam("ex-a4", A, "form4b"), exam("ex-b", B, "form1b")]);
  await ExamSubject.create([
    { _id: "es-a-maths",  examId: "ex-a",  subjectId: "maths-3a",   classId: "form3a", schoolId: A, subjectName: "Mathematics", maxScore: 20 },
    { _id: "es-a4-phys",  examId: "ex-a4", subjectId: "physics-4b", classId: "form4b", schoolId: A, subjectName: "Physics",     maxScore: 20 },
    { _id: "es-b-maths",  examId: "ex-b",  subjectId: "maths-1b",   classId: "form1b", schoolId: B, subjectName: "Mathematics", maxScore: 20 },
  ]);
  await StudentScore.create([
    { examId: "ex-a",  examSubjectId: "es-a-maths", studentId: "st-a1", subjectId: "maths-3a",   classId: "form3a", schoolId: A, score: 15, maxScore: 20 },
    { examId: "ex-a4", examSubjectId: "es-a4-phys", studentId: "st-a3", subjectId: "physics-4b", classId: "form4b", schoolId: A, score: 12, maxScore: 20 },
    { examId: "ex-b",  examSubjectId: "es-b-maths", studentId: "st-b1", subjectId: "maths-1b",   classId: "form1b", schoolId: B, score: 9,  maxScore: 20 },
  ]);
  await ResultSummary.create([
    { _id: "sum-a3", examId: "ex-a4", studentId: "st-a3", classId: "form4b", schoolId: A, average: 12, isPublished: true, classPosition: 1, subjects: [] },
    { _id: "sum-b1", examId: "ex-b",  studentId: "st-b1", classId: "form1b", schoolId: B, average: 9,  isPublished: true, classPosition: 1, subjects: [] },
  ]);
  const TODAY = new Date().toISOString().slice(0, 10);
  await Register.create([
    { schoolId: A, classId: "form4b", studentId: "st-a3", markedBy: "admin-a", date: TODAY, status: "absent" },
    { schoolId: B, classId: "form1b", studentId: "st-b1", markedBy: "teacher-b", date: TODAY, status: "present" },
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/exams",      auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/results",    auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use("/api/attendance", auth.authenticate, require(path.join(SRC, "routes/attendance.routes")));
  app.use("/api/sync",       auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
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
  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as = (id, role, schoolId) => { const token = sign(id, role, schoolId); return {
    get: (url) => call("GET", url, { token }), post: (url, body) => call("POST", url, { token, body }) }; };
  const maths = as("maths-a", "teacher", A);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the policy: school-wide reads ---");
  let r = await maths.get("/exams/ex-a4/scores");
  check("a teacher reads the score sheet of a class they do not teach (own school) → 200", [r.status, r.body?.scores?.length], [200, 1]);
  r = await maths.get("/results/ex-a4");
  check("and its published results → 200", r.status, 200);
  r = await maths.get("/results/ex-a4/student/st-a3");
  check("and one pupil's result in that class → 200", r.status, 200);
  r = await maths.get("/attendance/students/today?classId=form4b");
  check("and that class's register → 200, the pupil listed", [r.status, r.body?.roster?.length], [200, 1]);
  r = await maths.get("/sync/changes?collections=studentScore,studentAttendance,resultSummary");
  const feed = r.body?.collections ?? {};
  const schoolsIn = (docs) => [...new Set((docs ?? []).map((d) => d.schoolId))];
  check("the sync feed mirrors the school's scores, registers and summaries", [
    feed.studentScore?.documents?.length, feed.studentAttendance?.documents?.length, feed.resultSummary?.documents?.length,
  ], [2, 1, 1]);

  console.log("\n--- the boundary: never another school's ---");
  r = await maths.get(`/exams/ex-b/scores?schoolId=${B}`);
  check("naming Beta → 403 SCHOOL_ACCESS_DENIED at the door", [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);
  r = await maths.get("/exams/ex-b/scores");
  check("Beta's exam by id → nothing (scoped query)", [r.status, r.body?.scores?.length], [200, 0]);
  r = await maths.get("/results/ex-b");
  check("Beta's results by id → 404 or empty, never Beta's rows", r.status === 404 || (r.body?.data ?? r.body?.results ?? []).length === 0, true);
  r = await maths.get("/results/ex-b/student/st-b1");
  check("Beta's pupil's result by ids → 404", r.status, 404);
  r = await maths.get("/results/ex-b/rankings");
  check("Beta's ranking by exam id → 404", r.status, 404);
  r = await maths.get("/attendance/students/today?classId=form1b");
  check("Beta's class register by class id → an empty roster", r.body?.roster ?? [], []);
  check("the sync feed carries only Alpha's rows", [
    schoolsIn(feed.studentScore?.documents), schoolsIn(feed.studentAttendance?.documents), schoolsIn(feed.resultSummary?.documents),
  ], [[A], [A], [A]]);

  console.log("\n--- writes stay assignment-scoped ---");
  r = await maths.post("/exams/ex-a4/scores/bulk", { classId: "form4b", subjectId: "physics-4b", scores: [{ studentId: "st-a3", score: 1 }] });
  check("a mark in the class they read but do not teach → 403 SUBJECT_NOT_ASSIGNED", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  r = await maths.post("/attendance/students/bulk", { classId: "form4b", date: TODAY, records: [{ studentId: "st-a3", status: "present" }] });
  check("a register for the class they read but do not teach → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
  r = await maths.post("/exams/ex-a/scores/bulk", { classId: "form3a", subjectId: "maths-3a", scores: [{ studentId: "st-a1", score: 16 }] });
  check("their own pair → 201", r.status, 201);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
