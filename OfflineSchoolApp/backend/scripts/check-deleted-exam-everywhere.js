// backend/scripts/check-deleted-exam-everywhere.js
"use strict";

/**
 * The remaining readers of a deleted exam's marks ignore them.
 *
 * Deleting an exam only stamps deletedAt on the Exam; its ResultSummary and
 * StudentScore rows stay live. The portal, the watch list and the published
 * history were fixed first (check-portal-home, check-watch-deleted-exam,
 * check-deleted-exam-readers). These read the rows directly too:
 *
 *   intelligence review    reviewCases.liveCohort
 *   class analysis         analysisRuns loadEvidence (what the worker reads)
 *   transcript             GET /documents/transcript/:studentId
 *   teacher class results  GET /teacher/results
 *
 *   ama, Form 1, Mathematics:
 *     ex-live  Sequence 1   published summary sum-live, score 14
 *     ex-gone  Sequence 2   published summary sum-gone, score 3  ← exam DELETED
 *     ex-none  (no exam row at all)  summary sum-orphan — kept: missing ≠ deleted
 *
 *   node scripts/check-deleted-exam-everywhere.js
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

  const S = "68e0000000000000000000d1";
  const YEAR = "2026/2027";
  await M("School").create({ _id: S, name: "Green Valley", code: "GVD", email: "gv-del2@example.test", settings: { academicYear: YEAR } });
  await M("GradingConfig").create({ schoolId: S, passMark: 10 });
  const mk = (id, role) => M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: S, isActive: true });
  await mk("admin-d", "school_admin"); await mk("maths-d", "teacher");
  await M("Class").create({ _id: "f1", schoolId: S, name: "Form 1" });
  await M("Subject").create({ _id: "maths", schoolId: S, name: "Mathematics", classId: "f1" });
  await M("TeacherAssignment").create({ schoolId: S, teacher: "maths-d", class: "f1", subject: "maths" });
  await M("Student").create({
    _id: "ama", userId: "u-ama", schoolId: S, classId: "f1", className: "Form 1",
    studentName: "Pupil ama", enrollmentNo: "EN-ama", status: "approved", isActive: true,
  });

  const exam = (_id, seq, startDate, deletedAt = null) => ({
    _id, schoolId: S, classId: "f1", classIds: ["f1"], name: `Sequence ${seq}`, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, startDate, totalMarks: 20, passMark: 10,
    status: deletedAt ? "archived" : "published", deletedAt,
  });
  await M("Exam").collection.insertMany([exam("ex-live", 1, "2026-09-15"), exam("ex-gone", 2, "2026-10-10", new Date())]);
  const summary = (_id, examId, mark) => ({
    _id, examId, studentId: "ama", classId: "f1", className: "Form 1", schoolId: S, academicYear: YEAR, term: "1",
    average: mark, isPublished: true, publishedAt: new Date(), calcVersion: "exam-process/3",
    subjectBreakdown: [{ subjectId: "maths", subjectName: "Mathematics", score: mark, maxScore: 20,
      normalizedMark: mark, coefficient: 1, isPassing: mark >= 10 }],
  });
  await M("ResultSummary").insertMany([summary("sum-live", "ex-live", 14), summary("sum-gone", "ex-gone", 3), summary("sum-orphan", "ex-none", 11)]);
  const score = (examId, value) => ({
    examId, examSubjectId: `es-${examId}`, studentId: "ama", subjectId: "maths", classId: "f1", schoolId: S,
    score: value, maxScore: 20,
  });
  await M("StudentScore").insertMany([score("ex-live", 14), score("ex-gone", 3)]);

  console.log("\n--- intelligence review: reviewCases.liveCohort ---");
  const reviewCases = require(path.join(SRC, "services/intelligence/reviewCases.service"));
  const live = await reviewCases.liveCohort({ schoolId: S, classIds: ["f1"] });
  const cohortText = JSON.stringify(live.cohort);
  check("the deleted exam's result is not in the cohort", cohortText.includes("sum-gone") || cohortText.includes("ex-gone"), false);
  check("the live result is", cohortText.includes("sum-live") || cohortText.includes("ex-live"), true);

  console.log("\n--- class analysis: the evidence the worker reads ---");
  const { _internals } = require(path.join(SRC, "services/intelligence/analysisRuns.service"));
  const evidence = await _internals.loadEvidence({ schoolId: S, classIds: ["f1"] });
  check("summaries: the live one and the orphan, not the deleted exam's",
    evidence.summaries.map((s) => String(s._id)).sort(), ["sum-live", "sum-orphan"]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/documents", auth.authenticate, require(path.join(SRC, "routes/documents.routes")));
  app.use("/api/teacher",   auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;
  const as = (id, role) => {
    const token = jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return async (url) => {
      const r = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
  };
  const admin = as("admin-d", "school_admin"), teacher = as("maths-d", "teacher");

  console.log("\n--- transcript ---");
  const tr = await admin("/documents/transcript/ama");
  const termExams = (tr.body?.data?.years ?? []).flatMap((y) => y.terms.map((t) => String(t.examId))).sort();
  check("200; the live result and the orphan are on the record, the deleted exam's is not",
    [tr.status, termExams], [200, ["ex-live", "ex-none"]]);

  console.log("\n--- a teacher's class results ---");
  const cr = await teacher("/teacher/results");
  check("200; the live exam's mark only",
    [cr.status, (cr.body?.results ?? []).map((r) => `${r.examId}:${r.score}`)], [200, ["ex-live:14"]]);
  const one = await teacher("/teacher/results?examId=ex-gone");
  check("asking for the deleted exam by id answers nothing", (one.body?.results ?? []).length, 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
