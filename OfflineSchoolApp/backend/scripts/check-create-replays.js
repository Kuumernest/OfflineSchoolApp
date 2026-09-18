// backend/scripts/check-create-replays.js
//
// A retried create must be a replay, not a second record.
//
// The offline queues retry a request until they hear back. The idempotency
// middleware answers a repeat from memory only when the first attempt
// completed; a 5xx after the database write deletes the key, and the retry
// reaches the handler again. So the handler itself has to recognise the
// client's id: these are the creates that used to assign their own and made
// a second record on every such retry — a gate event (and a second message
// to the guardian), a quiz question, a quiz, a report template.
//
// Sent WITHOUT an Idempotency-Key on purpose: this proves the handler, not
// the middleware.
//
//   node scripts/check-create-replays.js
"use strict";

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
  const School         = mongoose.model("School");
  const User           = mongoose.model("User");
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const Subject        = mongoose.model("Subject");
  const GateEvent      = mongoose.model("GateEvent");
  const Question       = mongoose.model("Question");
  const Quiz           = mongoose.model("Quiz");
  const ReportTemplate = mongoose.model("ReportTemplate");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const PASSWORD = "Check-only-passw0rd";
  await Promise.all([
    User.create({ _id: "admin-a", name: "Admin A", email: "admin-a@example.test", password: PASSWORD, role: "school_admin", schoolId: A, isActive: true }),
    User.create({ _id: "admin-b", name: "Admin B", email: "admin-b@example.test", password: PASSWORD, role: "school_admin", schoolId: B, isActive: true }),
  ]);
  await Class.create([{ _id: "cls-a", schoolId: A, name: "Form 1A" }, { _id: "cls-b", schoolId: B, name: "Form 1B" }]);
  await Subject.create([{ _id: "sub-a", schoolId: A, name: "Mathematics", classId: "cls-a" }, { _id: "sub-b", schoolId: B, name: "Mathematics", classId: "cls-b" }]);
  await Student.create({
    _id: "st-a1", userId: "u-st-a1", schoolId: A, classId: "cls-a", studentName: "Pupil One",
    enrollmentNo: "A-001", isActive: true, status: "approved", gateToken: "TOK-A1",
  });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/gate",      auth.authenticate, require(path.join(SRC, "routes/gate.routes")));
  app.use("/api/quiz",      auth.authenticate, require(path.join(SRC, "routes/quiz.routes")));
  app.use("/api/templates", auth.authenticate, require(path.join(SRC, "routes/template.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const sign = (id, schoolId) => jwt.sign({ id, role: "school_admin", schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const adminA = sign("admin-a", A), adminB = sign("admin-b", B);
  const post = async (url, body, token = adminA) => {
    const res = await fetch(`${API}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let out = {}; try { out = await res.json(); } catch { /* none */ }
    if (res.status >= 500) console.log(`       (server ${res.status} for ${url}: ${out.message || out.error || JSON.stringify(out).slice(0, 200)})`);
    return { status: res.status, body: out };
  };

  console.log("\n--- a gate scan retried with the same id is the same event ---");
  let r = await post("/gate/scan", { _id: "scan-1", schoolId: A, token: "TOK-A1", at: "2026-09-18T08:00:00.000Z" });
  check("first scan recorded", [r.status, r.body.success, r.body.replay, r.body.duplicate], [200, true, false, false]);
  // Four hours later, so the time-based debounce cannot be what stops it.
  r = await post("/gate/scan", { _id: "scan-1", schoolId: A, token: "TOK-A1", at: "2026-09-18T12:00:00.000Z" });
  check("the same id again answers the recorded event as a replay", [r.status, r.body.replay, r.body.duplicate, r.body.at], [200, true, true, "2026-09-18T08:00:00.000Z"]);
  check("  one event on file, with the id the phone gave it", (await GateEvent.find({ schoolId: A }).lean()).map((e) => e._id), ["scan-1"]);
  r = await post("/gate/scan", { _id: "scan-1", schoolId: B, token: "TOK-A1" }, adminB);
  check("  another school cannot reuse that id", [r.status, r.body.code], [409, "SCAN_ID_TAKEN"]);
  r = await post("/gate/scan", { schoolId: A, token: "TOK-A1", at: "2026-09-18T16:00:00.000Z" });
  check("  a scan without an id still records as before", [r.status, r.body.replay, await GateEvent.countDocuments({ schoolId: A })], [200, false, 2]);

  console.log("\n--- a quiz question retried with the same id is the same question ---");
  const question = { id: "q-1", schoolId: A, subject_id: "sub-a", question_text: "2 + 2 = ?", question_type: "true_false" };
  r = await post("/quiz/questions", question);
  const q1 = r.body.question?._id;
  check("first create keeps the server key and remembers the client id", [r.status, typeof q1, r.body.question?.client_id], [201, "string", "q-1"]);
  r = await post("/quiz/questions", question);
  check("the same client id again is a replay of that question", [r.status, r.body.replay, r.body.question?._id], [200, true, q1]);
  check("  one question on file", await Question.countDocuments({ schoolId: A }), 1);
  r = await post("/quiz/questions", { ...question, schoolId: B, subject_id: "sub-b" }, adminB);
  check("  another school's device may use the same id for its own question", [r.status, r.body.replay, await Question.countDocuments({ client_id: "q-1" })], [201, undefined, 2]);

  console.log("\n--- a quiz retried with the same id is the same quiz ---");
  const quiz = { id: "quiz-1", schoolId: A, title: "Fractions", class_id: "cls-a", subject_id: "sub-a" };
  r = await post("/quiz/quizzes", quiz);
  const z1 = r.body.quiz?._id;
  check("first create keeps the server key and remembers the client id", [r.status, typeof z1, r.body.quiz?.client_id], [201, "string", "quiz-1"]);
  r = await post("/quiz/quizzes", quiz);
  check("the same client id again is a replay of that quiz", [r.status, r.body.replay, r.body.quiz?._id], [200, true, z1]);
  check("  one quiz on file", await Quiz.countDocuments({ schoolId: A }), 1);
  r = await post("/quiz/quizzes", { ...quiz, schoolId: B, class_id: "cls-b", subject_id: "sub-b" }, adminB);
  check("  another school's device may use the same id for its own quiz", [r.status, await Quiz.countDocuments({ client_id: "quiz-1" })], [201, 2]);

  console.log("\n--- a report template retried with the same id is the same template ---");
  const template = { _id: "tpl-1", schoolId: A, name: "Term card", html: "<p>{{studentName}}</p>" };
  r = await post("/templates", template);
  check("first create", [r.status, r.body.template?._id], [201, "tpl-1"]);
  r = await post("/templates", template);
  check("the same id again is a replay", [r.status, r.body.replay, r.body.template?._id], [200, true, "tpl-1"]);
  check("  one template on file", await ReportTemplate.countDocuments({ schoolId: A }), 1);
  r = await post("/templates", { ...template, schoolId: B }, adminB);
  check("  another school cannot reuse that id", [r.status, r.body.code], [409, "TEMPLATE_ID_TAKEN"]);
  r = await post("/templates", { schoolId: A, name: "Plain", html: "<p>x</p>" });
  check("  a create without an id still gets a server id", [r.status, typeof r.body.template?._id, r.body.template?._id !== "tpl-1"], [201, "string", true]);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.closeAllConnections?.();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
