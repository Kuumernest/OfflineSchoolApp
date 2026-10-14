// backend/scripts/check-quiz-scope.js
"use strict";

/**
 * The question bank is one teacher's questions in one subject — on the server.
 *
 * The phone filters its own SQLite the same way (mobile/scripts/check-quiz-bank.js);
 * this proves the server refuses what the client might ask for anyway: another
 * teacher's questions by naming their id, a question filed under a subject the
 * teacher is not assigned, a quiz for a class they do not teach. Data in every
 * bucket, so an empty answer cannot pass for a scoped one.
 *
 *   node scripts/check-quiz-scope.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School  = mongoose.model("School");
  const User    = mongoose.model("User");
  const Class   = mongoose.model("Class");
  const Subject = mongoose.model("Subject");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const { Question } = require(path.join(SRC, "db/models/QuizModule"));

  const S = "68c0000000000000000000a1";
  const A = "teacher-a", B = "teacher-b";
  const C1 = "cls-1", C2 = "cls-2";
  const MATH = "sub-math", PHYS = "sub-phys", BIO = "sub-bio";
  const Q = (n) => `68c00000000000000000000${n}`;

  await School.create({ _id: S, name: "Alpha Academy", code: "ALPHA" });
  const mkUser = (id, role, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: S, isActive: true,
  });
  await Promise.all([mkUser(A, "teacher", "Teacher A"), mkUser(B, "teacher", "Teacher B"),
    mkUser("admin", "school_admin", "Admin"), mkUser("student", "student", "Pupil")]);
  await Class.create([{ _id: C1, schoolId: S, name: "Form 5A" }, { _id: C2, schoolId: S, name: "Form 4B" }]);
  await Subject.create([
    { _id: MATH, schoolId: S, name: "Mathematics", code: "MAT", classId: C1 },
    { _id: PHYS, schoolId: S, name: "Physics",     code: "PHY", classId: C1 },
    { _id: BIO,  schoolId: S, name: "Biology",     code: "BIO", classId: C2 },
  ]);
  // A teaches Mathematics and Physics in Form 5A; B teaches Mathematics there.
  await TeacherAssignment.create([
    { schoolId: S, teacher: A, class: C1, subject: MATH },
    { schoolId: S, teacher: A, class: C1, subject: PHYS },
    { schoolId: S, teacher: B, class: C1, subject: MATH },
  ]);
  const mkQ = (id, created_by, subject_id, text) => Question.create({
    _id: id, schoolId: S, created_by, subject_id, question_text: text, question_type: "multiple_choice",
    options: [{ option_text: "yes", is_correct: true }, { option_text: "no" }],
  });
  await mkQ(Q(1), A, MATH, "A math 1");
  await mkQ(Q(2), A, MATH, "A math 2");
  await mkQ(Q(3), A, PHYS, "A physics 1");
  await mkQ(Q(4), A, PHYS, "A physics 2");
  await mkQ(Q(5), B, MATH, "B math private");
  await mkQ(Q(6), A, null, "A legacy, no subject");

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/quiz",    auth.authenticate, require(path.join(SRC, "routes/quiz.routes")));
  app.use("/api/teacher", auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
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
  const sign = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as   = (token) => ({
    get:  (u)    => call("GET",  u, { token }),
    post: (u, b) => call("POST", u, { token, body: b }),
    put:  (u, b) => call("PUT",  u, { token, body: b }),
    del:  (u)    => call("DELETE", u, { token }),
  });
  const tA = as(sign(A, "teacher")), tB = as(sign(B, "teacher")), adm = as(sign("admin", "school_admin")), stu = as(sign("student", "student"));
  const ids = (r) => (r.body?.questions ?? []).map((q) => String(q._id)).sort();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the teacher's context, from their assignments ---");
  let r = await tA.get("/teacher/my-classes");
  check("1. GET /teacher/my-classes → Form 5A only", (r.body?.classes ?? []).map((c) => c.name), ["Form 5A"]);
  r = await tA.get("/teacher/my-subjects?grouped=true");
  const g = (r.body?.subjectsByClass ?? []).find((x) => x.classId === C1);
  check("2. GET /teacher/my-subjects?grouped=true → Mathematics and Physics in Form 5A", (g?.subjects ?? []).map((s) => s.name).sort(), ["Mathematics", "Physics"]);
  check("3/4. Biology is not offered — Teacher A is not assigned it", (r.body?.subjectsByClass ?? []).some((x) => x.subjects.some((s) => s._id === BIO)), false);
  r = await tB.get("/teacher/my-subjects?grouped=true");
  check("  Teacher B is offered Mathematics alone", (r.body?.subjectsByClass ?? []).flatMap((x) => x.subjects.map((s) => s.name)), ["Mathematics"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the bank, by subject ---");
  check("5. A: subject_id=Mathematics → q1, q2", ids(await tA.get(`/quiz/questions?subject_id=${MATH}`)), [Q(1), Q(2)]);
  check("6. A: subject_id=Physics → q3, q4", ids(await tA.get(`/quiz/questions?subject_id=${PHYS}`)), [Q(3), Q(4)]);
  check("7. A's Mathematics bank holds no Physics question", ids(await tA.get(`/quiz/questions?subject_id=${MATH}`)).some((id) => [Q(3), Q(4)].includes(id)), false);
  check("8. A's Mathematics bank holds none of B's", ids(await tA.get(`/quiz/questions?subject_id=${MATH}`)).includes(Q(5)), false);
  check("  B: Mathematics → q5 only", ids(await tB.get(`/quiz/questions?subject_id=${MATH}`)), [Q(5)]);
  check("  B: Physics → nothing (B has none)", ids(await tB.get(`/quiz/questions?subject_id=${PHYS}`)), []);
  check("11. a question with no subject is in no subject's bank", ids(await tA.get(`/quiz/questions?subject_id=${MATH}`)).includes(Q(6)), false);
  check("  without a subject filter A sees their own five and none of B's", ids(await tA.get("/quiz/questions")), [Q(1), Q(2), Q(3), Q(4), Q(6)]);
  check("9a. naming B in created_by changes nothing for A", ids(await tA.get(`/quiz/questions?created_by=${B}`)).includes(Q(5)), false);
  check("9b. naming B AND Mathematics still yields A's Mathematics", ids(await tA.get(`/quiz/questions?created_by=${B}&subject_id=${MATH}`)), [Q(1), Q(2)]);
  check("  an administrator sees every teacher's Mathematics", ids(await adm.get(`/quiz/questions?subject_id=${MATH}`)), [Q(1), Q(2), Q(5)]);
  check("  and may narrow to one teacher", ids(await adm.get(`/quiz/questions?subject_id=${MATH}&created_by=${B}`)), [Q(5)]);
  check("  a pupil is refused the bank", (await stu.get("/quiz/questions")).status, 403);
  r = await tA.get("/quiz/sync");
  check("  /quiz/sync hands a teacher only their own questions", (r.body?.data?.questions ?? []).some((q) => String(q._id) === Q(5)), false);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- writing into the bank ---");
  const body = { question_text: "New", question_type: "true_false", options: [{ option_text: "T", is_correct: true }, { option_text: "F" }] };
  r = await tA.post("/quiz/questions", { ...body });
  check("a question without a subject → 400 SUBJECT_REQUIRED", [r.status, r.body?.code], [400, "SUBJECT_REQUIRED"]);
  r = await tA.post("/quiz/questions", { ...body, subject_id: BIO });
  check("9c. A filing under Biology, which A does not teach → 403 SUBJECT_NOT_ASSIGNED", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  r = await tA.post("/quiz/questions", { ...body, subject_id: MATH, created_by: B });
  check("  under Mathematics → 201, owned by A whatever the body said", [r.status, r.body?.question?.created_by, r.body?.question?.subject_id, r.body?.question?.schoolId], [201, A, MATH, S]);
  const newId = String(r.body?.question?._id);
  r = await tA.post("/quiz/questions", { ...body, subject_id: MATH, schoolId: "68c00000000000000000ffff" });
  check("  naming another school in the body is refused at the door", [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);

  check("  and it is in A's Mathematics bank now", ids(await tA.get(`/quiz/questions?subject_id=${MATH}`)).includes(newId), true);
  check("  and not in B's", ids(await tB.get(`/quiz/questions?subject_id=${MATH}`)).includes(newId), false);
  r = await adm.post("/quiz/questions", { ...body, subject_id: BIO });
  check("  an administrator may file under any subject of the school", r.status, 201);

  r = await tA.put(`/quiz/questions/${Q(5)}`, { question_text: "hijacked" });
  check("A editing B's question → 404", [r.status, r.body?.message], [404, "Question not found"]);
  check("  and it is untouched", (await Question.findById(Q(5)).lean()).question_text, "B math private");
  r = await tA.put(`/quiz/questions/${Q(1)}`, { subject_id: BIO });
  check("A moving their question to Biology → 403", [r.status, r.body?.code], [403, "SUBJECT_NOT_ASSIGNED"]);
  r = await tA.put(`/quiz/questions/${Q(1)}`, { subject_id: PHYS });
  check("  to Physics → 200, and it leaves the Mathematics bank", [r.status, r.body?.message ?? null, ids(await tA.get(`/quiz/questions?subject_id=${MATH}`)).includes(Q(1))], [200, null, false]);
  await tA.put(`/quiz/questions/${Q(1)}`, { subject_id: MATH });
  r = await tA.del(`/quiz/questions/${Q(5)}`);
  check("A deleting B's question → 404, still there", [r.status, Boolean(await Question.findOne({ _id: Q(5), deleted_at: null }))], [404, true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the quiz itself ---");
  r = await tA.post("/quiz/quizzes", { title: "Bio quiz", class_id: C1, subject_id: BIO });
  check("a quiz for a subject the teacher is not assigned → 403", r.status, 403);
  r = await tA.post("/quiz/quizzes", { title: "Maths in 4B", class_id: C2, subject_id: MATH });
  check("  or a class they do not teach → 403", r.status, 403);
  r = await tA.post("/quiz/quizzes", { title: "Maths quiz", class_id: C1, subject_id: MATH });
  check("  Mathematics in Form 5A → 201", [r.status, r.body?.quiz?.subject_id], [201, MATH]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
