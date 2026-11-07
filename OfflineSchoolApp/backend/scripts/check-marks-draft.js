// backend/scripts/check-marks-draft.js
"use strict";

/**
 * Marks entry: a draft may be unfinished; submitting and approving may not
 * (2026-10-30).
 *
 *   draft     POST .../scores/bulk { draft: true } with blank rows → the marks
 *             typed are saved, the blanks left alone, the subject NOT submitted
 *   submit    the same sheet without `draft` → refused (every present pupil
 *             needs a mark), as before
 *   approve   PATCH .../approve while a pupil has no mark, no absent and no
 *             exempt → 409 MARKS_INCOMPLETE; once every pupil is marked → 200
 *
 *   node scripts/check-marks-draft.js
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

  const S = "68c0000000000000000000d1";
  await M("School").create({ _id: S, name: "ZZ Test School", code: "ZZDRAFT", email: "zz-draft@example.test" });
  await M("User").create({ _id: "zz-admin", name: "ZZ Test Admin", email: "zz-admin@example.test",
    password: "Check-only-passw0rd", role: "school_admin", schoolId: S, isActive: true });
  await M("Class").create({ _id: "zz-form1", schoolId: S, name: "ZZ Test Form 1" });
  await M("Subject").create({ _id: "zz-maths", schoolId: S, name: "Mathematics", classId: "zz-form1" });
  await M("Student").create(["p1", "p2", "p3"].map((id, i) => ({
    _id: `zz-${id}`, userId: `u-zz-${id}`, schoolId: S, classId: "zz-form1",
    studentName: `ZZ Test Pupil ${i + 1}`, enrollmentNo: `ZZ-${i + 1}`, isActive: true, status: "approved" })));
  await M("Exam").create({ _id: "zz-exam", schoolId: S, name: "ZZ Test Sequence", type: "test",
    academicYear: "2026/2027", term: 1, sequenceNumber: 1, status: "ongoing", classId: "zz-form1", totalMarks: 20, passMark: 10 });
  await M("ExamSubject").create({ _id: "zz-es", examId: "zz-exam", subjectId: "zz-maths", classId: "zz-form1",
    schoolId: S, subjectName: "Mathematics", maxScore: 20 });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/exams", auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const token = jwt.sign({ id: "zz-admin", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const sheet = (rows, extra = {}) => ({ schoolId: S, classId: "zz-form1", subjectId: "zz-maths", examSubjectId: "zz-es",
    scores: rows.map(([id, score, isAbsent = false]) => ({ studentId: `zz-${id}`, score, isAbsent })), ...extra });
  const status = async () => (await M("ExamSubject").findById("zz-es").lean()).submissionStatus;
  const marks  = async () => (await M("StudentScore").find({ examId: "zz-exam", deletedAt: null }).lean())
    .map((r) => [r.studentId, r.score]).sort();

  console.log("--- a draft ---");
  let r = await call("POST", "/exams/zz-exam/scores/bulk", sheet([["p1", 14], ["p2", null], ["p3", ""]], { draft: true }));
  check("a draft with blanks is saved", [r.status, r.body.saved, r.body.draft], [201, 1, true]);
  check("  the mark typed is stored, the blanks are not", await marks(), [["zz-p1", 14]]);
  check("  and the subject is not submitted", (await status()) ?? "pending", "pending");
  r = await call("POST", "/exams/zz-exam/scores/bulk", sheet([["p1", 25]], { draft: true }));
  check("a draft still refuses a mark over the maximum", r.status, 400);

  console.log("--- submitting ---");
  r = await call("POST", "/exams/zz-exam/scores/bulk", sheet([["p1", 14], ["p2", null], ["p3", 9]]));
  check("submitting with a blank is refused, as before", [r.status, await status() ?? "pending"], [400, "pending"]);

  console.log("--- approving ---");
  await call("POST", "/exams/zz-exam/scores/bulk", sheet([["p1", 14], ["p3", 9]], { draft: true }));
  r = await call("PATCH", "/exams/zz-exam/subjects/zz-es/approve", { schoolId: S });
  check("approve while a pupil has no mark → 409, naming who", [r.status, r.body.code, r.body.unmarked], [409, "MARKS_INCOMPLETE", ["zz-p2"]]);
  check("  and nothing is approved", (await status()) ?? "pending", "pending");
  r = await call("POST", "/exams/zz-exam/scores/bulk", sheet([["p1", 14], ["p2", null, true], ["p3", 9]]));
  check("submit once every pupil has a mark or is absent → submitted", [r.status, await status()], [201, "submitted"]);
  r = await call("PATCH", "/exams/zz-exam/subjects/zz-es/approve", { schoolId: S });
  check("approve → 200, approved", [r.status, await status()], [200, "approved"]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
