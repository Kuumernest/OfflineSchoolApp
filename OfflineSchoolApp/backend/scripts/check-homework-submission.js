// backend/scripts/check-homework-submission.js
"use strict";

/**
 * Pin the homework submission contract.
 *
 * The mobile app queued three mutations against this feature and every one of
 * them was addressed to something that does not exist:
 *
 *     POST /homework/submissions                 -> no such route
 *     PUT  /homework/submissions/:id             -> no such route
 *     PUT  /homework/submissions/:id/grade       -> wrong path AND wrong verb
 *
 * All three 404. A 404 on a non-DELETE is classified `permanent` by the
 * device's outbox, so each one was written as a failed mutation and never
 * retried: every homework a child submitted and every grade a teacher entered
 * became a permanent red mark in the sync status bar. Nothing about reading
 * either side told you that — the client had plausible-looking URLs and the
 * server had working routes; they simply were not the same routes.
 *
 * So this pins the shape both sides now agree on, by example:
 *
 *   • submissions are nested under their homework, not addressed on their own
 *   • re-submitting is the SAME call as submitting (there is no update route)
 *   • grading is a PATCH, nested the same way
 *   • both bodies are `.strict()` — an extra field is a 422, not a warning
 *   • the submission id is minted by the SERVER, so a client id is refused
 *
 * That last one is the reason the app carries an id-map reconciler for
 * submissions. If this check ever starts passing a client-supplied id, the
 * reconciler has become dead weight and grading is silently addressing rows
 * by luck.
 *
 * Boots mongodb-memory-server. No external services.
 *
 *   node scripts/check-homework-submission.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");

const SCHOOL = "aaaaaaaaaaaaaaaaaaaaaaaa";
const HW_ID  = "homework-1";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "homework-submission" });
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const User     = require("../src/db/models/User");
  const Homework = require("../src/db/models/Homework");

  const account = async (role, id) => {
    await User.collection.insertOne({
      _id: id, name: `Test ${role}`, email: `${id}@x.com`, role,
      schoolId: SCHOOL, isActive: true, password: "x",
      createdAt: new Date(), updatedAt: new Date(),
    });
    return jwt.sign({ id, role, schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };

  const studentToken = await account("student", "student-1");
  const teacherToken = await account("teacher", "teacher-1");

  await Homework.create({
    _id: HW_ID, schoolId: SCHOOL, classId: "class-1", subjectId: "subject-1",
    createdBy: "teacher-1", title: "Fractions", maxScore: 10, isPublished: true,
  });

  const auth = require("../middleware/auth");
  const app  = express();
  app.use(express.json());
  app.use("/api/homework", auth.authenticate, require("../src/routes/homework.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/homework${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json ?? {} };
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a submission is nested under its homework ---");

  const flat = await call("POST", "/submissions", {
    token: studentToken, body: { text: "hello" },
  });
  check("the flat /homework/submissions route does not exist", flat.status, 404);

  const created = await call("POST", `/${HW_ID}/submissions`, {
    token: studentToken, body: { text: "my answer" },
  });
  check("POST /homework/:id/submissions is accepted", created.status, 201);
  check("and it answers with the stored submission",
    typeof created.body?.submission?._id, "string");

  const serverId = created.body?.submission?._id;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- the body is strict, and the student comes from the token ---");

  const extra = await call("POST", `/${HW_ID}/submissions`, {
    token: studentToken,
    body: { text: "x", studentId: "student-1", isLate: false, attachmentName: "a.pdf" },
  });
  check("a body carrying client-side fields is refused", extra.status, 422);

  check("the student is taken from the token, not the body",
    created.body?.submission?.studentId, "student-1");

  const asTeacher = await call("POST", `/${HW_ID}/submissions`, {
    token: teacherToken, body: { text: "not mine to submit" },
  });
  check("only a student may submit", asTeacher.status, 403);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- re-submitting replaces; there is no update route ---");

  const again = await call("POST", `/${HW_ID}/submissions`, {
    token: studentToken, body: { text: "second thoughts" },
  });
  check("submitting again is accepted", again.status, 201);

  const afterResubmit = await Homework.findById(HW_ID).lean();
  check("and leaves one submission for that student, not two",
    afterResubmit.submissions.filter((s) => s.studentId === "student-1").length, 1);
  check("carrying the newer text",
    afterResubmit.submissions.find((s) => s.studentId === "student-1").text,
    "second thoughts");

  const put = await call("PUT", `/submissions/${serverId}`, {
    token: studentToken, body: { text: "via the old route" },
  });
  check("the old PUT /homework/submissions/:id route does not exist", put.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- grading is a PATCH, nested the same way ---");

  // The id changed when the submission was replaced, which is itself the point:
  // a client cannot know it without being told.
  const currentId = afterResubmit.submissions
    .find((s) => s.studentId === "student-1")._id;

  const wrongVerb = await call("PUT", `/${HW_ID}/submissions/${currentId}/grade`, {
    token: teacherToken, body: { score: 8 },
  });
  check("PUT on the grade path is not a route", wrongVerb.status, 404);

  const graded = await call("PATCH", `/${HW_ID}/submissions/${currentId}/grade`, {
    token: teacherToken, body: { score: 8, feedback: "good work" },
  });
  check("PATCH /homework/:id/submissions/:submissionId/grade is accepted", graded.status, 200);
  check("and the score is stored", graded.body?.submission?.score, 8);
  check("with the grader taken from the token",
    graded.body?.submission?.gradedBy, "teacher-1");

  const gradeExtra = await call("PATCH", `/${HW_ID}/submissions/${currentId}/grade`, {
    token: teacherToken, body: { score: 8, gradedBy: "teacher-1" },
  });
  check("a grade body naming its own grader is refused", gradeExtra.status, 422);

  const overMax = await call("PATCH", `/${HW_ID}/submissions/${currentId}/grade`, {
    token: teacherToken, body: { score: 99 },
  });
  check("a score above maxScore is refused", overMax.status, 422);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- the submission id belongs to the server ---");

  // This is what the mobile id-map reconciler exists for. A device generates a
  // local uuid for the row it stores; grading addressed by that id reaches
  // nothing, so the submit response's id has to be adopted before a grade can
  // be sent. If this ever returns 200, that whole mechanism is unnecessary —
  // and something has started trusting an id the client chose.
  const clientId = "8f2c1d90-0000-4000-8000-000000000000";
  const byClientId = await call("PATCH", `/${HW_ID}/submissions/${clientId}/grade`, {
    token: teacherToken, body: { score: 5 },
  });
  check("grading by an id the server never minted is refused", byClientId.status, 404);

  const unknownHomework = await call("POST", "/no-such-homework/submissions", {
    token: studentToken, body: { text: "x" },
  });
  check("submitting to a homework that does not exist is refused",
    unknownHomework.status, 404);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
