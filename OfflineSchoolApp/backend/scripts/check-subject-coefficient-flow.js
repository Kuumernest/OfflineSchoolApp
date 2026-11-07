// backend/scripts/check-subject-coefficient-flow.js
"use strict";

/**
 * A coefficient typed on a subject is the one the averages use — from the
 * form, through every way a subject reaches an exam, to the ranked result.
 *
 * check-coefficients.js pins the cascade on its own. This walks the path an
 * administrator does, through the routes:
 *
 *   create a subject with a coefficient, reopen it, edit it
 *   a subject from before the field existed reads as 1, and an edit that does
 *   not mention the coefficient does not write one nobody chose
 *   both ways onto an exam — POST /exams with its subjects inline, and
 *   POST /exams/:id/subjects — start from the subject's coefficient. The inline
 *   path used a literal weight of 100, so an exam created in one request counted
 *   every subject as 1 whatever the school had set
 *   the processed average and the class position are the weighted ones
 *   a later edit leaves an exam whose results are published exactly as it was
 *
 *   node scripts/check-subject-coefficient-flow.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");
  const M       = (n) => mongoose.model(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";
  const A = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: A, name: "Coefficient School", email: "coeff@example.test" });
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: A, isActive: true });
  await M("GradingConfig").create({ schoolId: A, caEnabled: false, passMark: 10 });
  await M("AcademicStructure").create({ schoolId: A, academicYear: YEAR });
  await M("Class").create({ _id: "f1", schoolId: A, name: "Form 1" });
  for (const p of ["ama", "zed"]) {
    await M("Student").create({ _id: p, userId: `u-${p}`, schoolId: A, classId: "f1", className: "Form 1",
      studentName: `Pupil ${p}`, enrollmentNo: `CF-${p}`, status: "approved", isActive: true });
  }

  const app = express(); app.use(express.json());
  app.use("/api/exams", auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/admin", auth.authenticate, require("../src/routes/admin.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const listed = async () => {
    const r = await call("GET", `/admin/subjects?schoolId=${A}&classId=f1`);
    const subs = r.body?.subjects ?? r.body?.data?.subjects ?? [];
    return Object.fromEntries(subs.map((s) => [s.name, s.coefficient]));
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- create, reopen, edit ---");
    let r = await call("POST", "/admin/subjects", { name: "Maths", classId: "f1", schoolId: A, coefficient: 3 });
    check("a subject is created with its coefficient", r.status, 201);
    const MATHS = r.body?.subject?._id ?? r.body?.data?.subject?._id;
    r = await call("POST", "/admin/subjects", { name: "English", classId: "f1", schoolId: A });
    const ENG = r.body?.subject?._id ?? r.body?.data?.subject?._id;
    check("a blank coefficient is refused nothing", r.status, 201);
    check("reopened, each reads as saved; blank is 1", await listed(), { English: 1, Maths: 3 });

    for (const bad of [0, -2, 21, "abc"]) {
      r = await call("POST", "/admin/subjects", { name: `Bad ${bad}`, classId: "f1", schoolId: A, coefficient: bad });
      check(`a coefficient of ${JSON.stringify(bad)} is refused`, r.status, 400);
    }
    r = await call("POST", "/admin/subjects", { name: "Physics", classId: "f1", schoolId: A, coefficient: 2.5 });
    check("a decimal coefficient is kept", [r.status, (await listed()).Physics], [201, 2.5]);

    r = await call("PUT", `/admin/subjects/${MATHS}`, { coefficient: 4 });
    check("an edit saves", r.status, 200);
    check("and reopening shows it", (await listed()).Maths, 4);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- a subject from before the field ---");
    await M("Subject").collection.insertOne({ _id: "legacy-hist", schoolId: A, name: "History",
      class: "f1", classId: "f1", isActive: true, deletedAt: null, createdAt: new Date(), updatedAt: new Date() });
    // GET /admin/subjects built its rows without normaliseSubject, so this
    // came back with no coefficient at all and each client guessed.
    check("lists as 1", (await listed()).History, 1);
    r = await call("PUT", "/admin/subjects/legacy-hist", { name: "History & Geography" });
    const raw = await M("Subject").collection.findOne({ _id: "legacy-hist" });
    check("an edit that does not mention it writes none", [r.status, "coefficient" in raw], [200, false]);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- both ways onto an exam start from the subject ---");
    r = await call("POST", "/exams", {
      _id: "seq1", name: "Sequence 1", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 1,
      classId: "f1", schoolId: A, totalMarks: 20, passMark: 10,
      subjects: [{ subjectId: MATHS }, { subjectId: ENG }],
    });
    check("an exam created with its subjects inline", r.status, 201);
    const weights = async (examId) => Object.fromEntries(
      (await M("ExamSubject").find({ examId, deletedAt: null }).lean()).map((es) => [es.subjectId, es.weight]));
    check("  carries each subject's coefficient (Maths 4, English 1)",
      await weights("seq1"), { [MATHS]: 400, [ENG]: 100 });

    r = await call("POST", "/exams", {
      _id: "seq2", name: "Sequence 2", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 2,
      classId: "f1", schoolId: A, totalMarks: 20, passMark: 10,
    });
    r = await call("POST", "/exams/seq2/subjects", { subjectId: MATHS, classId: "f1", maxScore: 20, passMark: 10 });
    check("a subject attached on its own carries it too", (await weights("seq2"))[MATHS], 400);

    r = await call("POST", "/exams", {
      _id: "seq3", name: "Sequence 3", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 3,
      classId: "f1", schoolId: A, totalMarks: 20, passMark: 10,
      subjects: [{ subjectId: MATHS, weight: 200 }],
    });
    check("a weight sent for one paper still wins", (await weights("seq3"))[MATHS], 200);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- the average is the weighted one ---");
    await M("Exam").updateOne({ _id: "seq1" }, { $set: { status: "completed" } });
    await M("ExamSubject").updateMany({ examId: "seq1" }, { $set: { submissionStatus: "approved" } });
    const esId = async (examId, subjectId) => (await M("ExamSubject").findOne({ examId, subjectId }).lean())._id;
    const MARKS = { ama: { [MATHS]: 16, [ENG]: 8 }, zed: { [MATHS]: 8, [ENG]: 16 } };
    for (const [p, marks] of Object.entries(MARKS)) {
      for (const [sub, score] of Object.entries(marks)) {
        await M("StudentScore").create({ examId: "seq1", examSubjectId: await esId("seq1", sub), studentId: p,
          subjectId: sub, classId: "f1", schoolId: A, maxScore: 20, score });
      }
    }
    r = await call("POST", "/exams/seq1/process", { classId: "f1" });
    check("processing succeeds", r.status, 200);
    const summary = async (examId) => Object.fromEntries(
      (await M("ResultSummary").find({ examId, deletedAt: null }).lean())
        .map((s) => [s.studentId, [s.average, s.classPosition]]));
    // ama (16×4 + 8×1) / 5 = 14.4; zed (8×4 + 16×1) / 5 = 9.6. Unweighted both are 12.
    check("[average, position]: Maths counts four times", await summary("seq1"), {
      ama: [14.4, 1], zed: [9.6, 2],
    });

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- a published exam is left as it went home ---");
    await M("Exam").updateOne({ _id: "seq1" }, { $set: { resultsPublished: true, status: "published" } });
    const before = await summary("seq1");
    r = await call("PUT", `/admin/subjects/${MATHS}`, { coefficient: 5 });
    check("a later edit saves", [r.status, (await listed()).Maths], [200, 5]);
    check("  the published exam keeps its weight", (await weights("seq1"))[MATHS], 400);
    check("  and its averages", await summary("seq1"), before);
    check("  while an unfinished exam follows", (await weights("seq2"))[MATHS], 500);
    check("  and the per-paper weight is untouched", (await weights("seq3"))[MATHS], 200);
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
