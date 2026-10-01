// backend/scripts/check-period-results-scope.js
"use strict";

/**
 * Term and annual results: who reads which rows, who computes which class.
 *
 * The decision (docs/35): a teacher reads the term and annual results of the
 * classes they hold an active assignment in, and only the published ones —
 * the rule the sync feed already applied to the same collections; a bursar
 * reads what is published, school-wide; an administrator reads everything and
 * computes the school; a teacher computes one of their classes at a time; an
 * operator names a school first, and no school is never every school.
 *
 * Before this, both routers answered every row in the school to any holder of
 * results.view and let a teacher recompute the whole school.
 *
 *   node scripts/check-period-results-scope.js
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

  const A = "68d0000000000000000000a1";
  const B = "68d0000000000000000000b2";
  const YEAR = "2026-2027";
  await M("School").create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const mk = (id, role, schoolId) => M("User").create({
    _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mk("maths-a", "teacher", A), mk("idle-a", "teacher", A), mk("bursar-a", "bursar", A),
    mk("admin-a", "school_admin", A), mk("admin-b", "school_admin", B), mk("root", "super_admin", null),
    mk("pupil-a1", "student", A),
  ]);
  await M("Class").create([
    { _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  // maths-a teaches 3A. 4B is another teacher's class. idle-a teaches nothing.
  await M("TeacherAssignment").create([
    { schoolId: A, teacher: "maths-a", class: "form3a", subject: "maths-3a" },
    { schoolId: A, teacher: "maths-a", class: "form4b", subject: "maths-4b", isActive: false },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await M("Student").create([pupil("st-a1", A, "form3a", 1), pupil("st-a2", A, "form3a", 2), pupil("st-a3", A, "form4b", 3), pupil("st-b1", B, "form1b", 1)]);
  // Compute needs the year's layout; with no marks it computes nothing, which is still a 200.
  await M("AcademicStructure").create({
    schoolId: A, academicYear: YEAR,
    terms: [{ number: 1, name: "First Term", weight: 33, sequences: [
      { number: 1, name: "First Sequence", weight: 50, assessment: { type: "test" } },
      { number: 2, name: "Second Sequence", weight: 50, assessment: { type: "test" } },
    ] }],
    annualAverageMethod: "terms", promotionExams: [], promotionThreshold: 10, passMark: 10, maxAbsences: null,
  });

  const term = (id, schoolId, classId, studentId, isPublished) => ({
    _id: id, schoolId, academicYear: YEAR, term: 1, classId, studentId, termAverage: 12, overallGrade: "B", isPassing: true, isPublished,
  });
  await M("TermResult").create([
    term("tr-a1", A, "form3a", "st-a1", true),
    term("tr-a2", A, "form3a", "st-a2", false),
    term("tr-a3", A, "form4b", "st-a3", true),
    term("tr-b1", B, "form1b", "st-b1", true),
  ]);
  const annual = (id, schoolId, classId, studentId, isPublished) => ({
    _id: id, schoolId, academicYear: YEAR, classId, studentId, annualAverage: 12, overallGrade: "B", isPassing: true, isPublished,
  });
  await M("AnnualResult").create([
    annual("ar-a1", A, "form3a", "st-a1", true),
    annual("ar-a2", A, "form3a", "st-a2", false),
    annual("ar-a3", A, "form4b", "st-a3", true),
    annual("ar-b1", B, "form1b", "st-b1", true),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/term-results",   auth.authenticate, require(path.join(SRC, "routes/termResults.routes")));
  app.use("/api/annual-results", auth.authenticate, require(path.join(SRC, "routes/annualResults.routes")));
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
  const maths  = as("maths-a",  "teacher",      A);
  const idle   = as("idle-a",   "teacher",      A);
  const bursar = as("bursar-a", "bursar",       A);
  const adminA = as("admin-a",  "school_admin", A);
  const adminB = as("admin-b",  "school_admin", B);
  const root   = as("root",     "super_admin",  null);
  const student = as("pupil-a1", "student",     A);

  const ids = (r) => (r.body?.results ?? []).map((x) => x.studentId).sort();
  const T = `/term-results?academicYear=${YEAR}&term=1`;
  const N = `/annual-results?academicYear=${YEAR}`;

  for (const [label, LIST, STUDENT, COMPUTE, CARD, idOf] of [
    ["term",   T, (s) => `/term-results/student/${s}`,   "/term-results/compute",   (s, c) => `/term-results/${s}/report-card?academicYear=${YEAR}&term=1&classId=${c}`, ids],
    ["annual", N, (s) => `/annual-results/student/${s}`, "/annual-results/compute", (s, c) => `/annual-results/${s}/report-card?academicYear=${YEAR}&classId=${c}`, ids],
  ]) {
    const one = (r) => (label === "term" ? (r.body?.results ?? []).map((x) => x._id) : (r.body?.result ? [r.body.result._id] : []));
    const body = label === "term" ? { academicYear: YEAR, term: 1 } : { academicYear: YEAR };

    console.log(`\n--- ${label} results: the assigned teacher reads their class, published only ---`);
    let r = await maths.get(LIST);
    check("the list is their class's published rows, not the school's", [r.status, idOf(r), r.body?.total], [200, ["st-a1"], 1]);
    r = await maths.get(`${LIST}&classId=form3a`);
    check("asking for their class by id gives the same", idOf(r), ["st-a1"]);
    r = await maths.get(`${LIST}&classId=form4b`);
    check("asking for a class they do not teach gives an empty page, not the class", [r.status, idOf(r), r.body?.total], [200, [], 0]);
    check("one pupil of theirs, published → the row", one(await maths.get(STUDENT("st-a1"))).length, 1);
    check("one pupil of theirs, not yet published → nothing", one(await maths.get(STUDENT("st-a2"))).length, 0);
    check("a pupil of another class → nothing", one(await maths.get(STUDENT("st-a3"))).length, 0);
    check("the inactive assignment to 4B grants nothing (4B's card → 404)", (await maths.get(CARD("st-a3", "form4b"))).status, 404);
    check("the unpublished card of their own pupil → 404", (await maths.get(CARD("st-a2", "form3a"))).status, 404);

    console.log(`\n--- ${label} results: a teacher computes one of their classes, never the school ---`);
    r = await maths.post(COMPUTE, body);
    check("the whole school → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
    r = await maths.post(COMPUTE, { ...body, classId: "form4b" });
    check("a class they do not teach → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
    r = await maths.post(COMPUTE, { ...body, classId: "form3a" });
    check("their own class → 200", [r.status, r.body?.success], [200, true]);

    console.log(`\n--- ${label} results: the unassigned teacher, the bursar, the pupil ---`);
    r = await idle.get(LIST);
    check("a teacher with no assignment reads nothing", [r.status, idOf(r)], [200, []]);
    r = await idle.post(COMPUTE, { ...body, classId: "form3a" });
    check("and computes nothing", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
    r = await bursar.get(LIST);
    check("the bursar reads the published rows of the school, every class", idOf(r), ["st-a1", "st-a3"]);
    check("the bursar does not compute (results.edit is a teaching capability)", (await bursar.post(COMPUTE, { ...body, classId: "form3a" })).status, 403);
    check("a pupil is refused the staff list", (await student.get(LIST)).status, 403);

    console.log(`\n--- ${label} results: the office reads everything and computes the school ---`);
    r = await adminA.get(LIST);
    check("the administrator sees every row, published or not", idOf(r), ["st-a1", "st-a2", "st-a3"]);
    check("and the unpublished pupil's rows", one(await adminA.get(STUDENT("st-a2"))).length, 1);
    r = await adminA.post(COMPUTE, body);
    check("and computes the school", [r.status, r.body?.success], [200, true]);

    console.log(`\n--- ${label} results: the operator names a school first ---`);
    check("no school selected: the list → 400", (await root.get(LIST)).status, 400);
    check("no school selected: one pupil → 400, not that pupil's rows from whichever school holds them", (await root.get(STUDENT("st-a1"))).status, 400);
    r = await root.get(`${LIST}&schoolId=${A}`);
    check("Alpha selected: Alpha's rows, all of them", idOf(r), ["st-a1", "st-a2", "st-a3"]);
    r = await root.get(`${LIST}&schoolId=${B}`);
    check("Beta selected: Beta's", idOf(r), ["st-b1"]);
    r = await adminB.get(`${LIST}&schoolId=${A}`);
    check("Beta's administrator naming Alpha → 403 at the door", [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);
    check("Beta's administrator reads Beta", idOf(await adminB.get(LIST)), ["st-b1"]);
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
