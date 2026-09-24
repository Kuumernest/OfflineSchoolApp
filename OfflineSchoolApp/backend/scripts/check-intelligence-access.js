// backend/scripts/check-intelligence-access.js
"use strict";

/**
 * Who may see what, across every intelligence surface at once.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 *   teacher        the classes they hold an assignment for
 *   school_admin   every pupil in their school, whoever teaches them
 *   super_admin    the school they have selected, and no school they have not
 *
 * The engine answers the same whoever asks. Section 5 proves that literally:
 * one pupil's profile, fetched as teacher, as head and as operator, is the same
 * bytes once the timestamp is removed.
 *
 * ── Why every route is in one file ────────────────────────────────────────
 *
 * Authorisation fails at the seams. A rule enforced on /insights/student and
 * forgotten on /interventions/:id/evidence is a rule that does not exist,
 * because the pupil is the same pupil and the evidence route is the alternate
 * door. So the matrix here walks EVERY intelligence read and write — insights,
 * guidance, class, interventions, evidence, review cases, calibration summary,
 * reviews — for every role, and the desktop handler's declines besides. Section
 * 7 is specifically the search for an alternate door.
 *
 * ── Reviews are school records ────────────────────────────────────────────
 *
 * A teacher's judgement of an engine conclusion is named and stays named. The
 * head reads it with the teacher's name on it. Section 4 asserts the
 * attribution survives every role that may read it, and that the roles that
 * may not read it get nothing — not an anonymised copy, nothing.
 *
 *   node scripts/check-intelligence-access.js
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

const A = "6a00000000000000000000a1";   // Alpha Academy
const B = "6a00000000000000000000b2";   // Beta College
const NOWHERE = "6a0000000000000000000dead".slice(0, 24);
const YEAR = "2026-2027";

const row = (subjectId, subjectName, normalizedMark, extra = {}) => ({
  subjectId, subjectName, normalizedMark, score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null, isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false, ...extra,
});

/** Strip the one field that is allowed to differ between two identical answers. */
const stable = (body) => JSON.stringify(body, (k, v) => (k === "generatedAt" ? undefined : v));

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Student           = mongoose.model("Student");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Exam              = mongoose.model("Exam");
  const ResultSummary     = mongoose.model("ResultSummary");
  const Intervention      = mongoose.model("Intervention");
  const IntelligenceReview = mongoose.model("IntelligenceReview");

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name: name ?? id, email: `${id}@example.test`,
    password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a",  "teacher",      A, "Mme Ateba"),
    mkUser("admin-a",  "school_admin", A, "Head Alpha"),
    mkUser("admin-b",  "school_admin", B, "Head Beta"),
    mkUser("bursar-a", "bursar",       A, "Bursar Alpha"),
    mkUser("operator", "super_admin",  null, "Platform Operator"),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await TeacherAssignment.create([{ schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st-a1", A, "form3a", "A1"), pupil("st-a2", A, "form4b", "A2"), pupil("st-b1", B, "form1b", "B1"),
  ]);
  const mkExam = (id, schoolId, classId, term, seq, startDate) => ({
    _id: id, schoolId, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate,
    classId, totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
  });
  await Exam.create([
    mkExam("ax1", A, "form3a", 1, 1, "2026-10-05"), mkExam("ax2", A, "form3a", 1, 2, "2026-11-20"),
    mkExam("ax3", A, "form3a", 2, 1, "2027-02-10"),
    mkExam("bx1", B, "form1b", 1, 1, "2026-10-05"), mkExam("bx2", B, "form1b", 1, 2, "2026-11-20"),
  ]);
  const summary = (id, examId, studentId, classId, schoolId, term, rows) => ({
    _id: id, examId, studentId, classId, schoolId, academicYear: YEAR, term: String(term),
    isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows,
  });
  await ResultSummary.create([
    // st-a1: Maths falling, ICT steady — both kinds of case on one pupil.
    summary("s1", "ax1", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 16), row("ict", "ICT", 16)]),
    summary("s2", "ax2", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 15), row("ict", "ICT", 17)]),
    summary("s3", "ax3", "st-a1", "form3a", A, 2, [row("maths", "Mathematics", 9),  row("ict", "ICT", 17)]),
    // st-a2: in the class the teacher does NOT take.
    summary("s4", "ax1", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 8)]),
    summary("s5", "ax2", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 7)]),
    summary("s6", "ax3", "st-a2", "form4b", A, 2, [row("maths", "Mathematics", 6)]),
    // st-b1: another school entirely.
    summary("s7", "bx1", "st-b1", "form1b", B, 1, [row("maths", "Mathematics", 18)]),
    summary("s8", "bx2", "st-b1", "form1b", B, 1, [row("maths", "Mathematics", 18)]),
  ]);
  await Intervention.create([
    { _id: "iv-a1", schoolId: A, studentId: "st-a1", classId: "form3a", createdBy: "teach-a", updatedBy: "teach-a",
      actionCode: "TARGETED_PRACTICE", subjectId: "maths", status: "active", startedAt: new Date("2027-01-15") },
    { _id: "iv-a2", schoolId: A, studentId: "st-a2", classId: "form4b", createdBy: "admin-a", updatedBy: "admin-a",
      actionCode: "ADDITIONAL_SUPPORT", subjectId: "maths", status: "planned" },
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights",      auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/interventions", auth.authenticate, require(path.join(SRC, "routes/interventions.routes")));
  app.use("/api/super-admin",   auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let out = {}; try { out = await res.json(); } catch { /* empty */ }
      return { status: res.status, body: out };
    };
    return { get: (u) => call("GET", u), post: (u, b) => call("POST", u, b), patch: (u, b) => call("PATCH", u, b) };
  };
  const teacher  = as("teach-a",  "teacher",      A);
  const adminA   = as("admin-a",  "school_admin", A);
  const adminB   = as("admin-b",  "school_admin", B);
  const bursar   = as("bursar-a", "bursar",       A);
  const operator = as("operator", "super_admin",  null);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;

  // Every read that names a pupil, and every read that names a class. The
  // matrix below walks all of them so no route can be the alternate door.
  const pupilReads = (id) => [
    `/insights/student/${id}`, `/insights/student/${id}/guidance`,
    `/interventions/student/${id}`, `/insights/reviews/student/${id}`,
  ];
  const classReads = (id) => [`/insights/class/${id}`, `/insights/review-cases?classId=${id}`,
                              `/insights/calibration-summary?classId=${id}`];
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the assigned teacher: their classes and nothing else ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a pupil they teach → 200 on every pupil read",
    await statuses(teacher, pupilReads("st-a1")), [200, 200, 200, 200]);
  check("their class → 200 on every class read",
    await statuses(teacher, classReads("form3a")), [200, 200, 200]);
  check("the evidence behind an intervention on their pupil → 200",
    (await teacher.get("/interventions/iv-a1/evidence")).status, 200);

  check("a pupil in a class they do not teach → 403 on every pupil read",
    await statuses(teacher, pupilReads("st-a2")), [403, 403, 403, 403]);
  check("a class they do not teach → 403 on every class read",
    await statuses(teacher, classReads("form4b")), [403, 403, 403]);
  check("the evidence behind that pupil's intervention → 403, the alternate door is shut",
    (await teacher.get("/interventions/iv-a2/evidence")).status, 403);
  check("another school's pupil → 404, never a hint the id exists",
    await statuses(teacher, pupilReads("st-b1")), [404, 404, 404, 404]);
  check("naming another school in the query → 403 SCHOOL_ACCESS_DENIED at the door",
    (await teacher.get(`/insights/student/st-a1?schoolId=${B}`)).body?.code, "SCHOOL_ACCESS_DENIED");

  let r = await teacher.get("/insights/review-cases");
  check("the unfiltered review sheet is scoped to the classes they take",
    [r.status, [...new Set(r.body.data.cases.map((c) => c.studentId))].sort()], [200, ["st-a1"]]);
  check("and the summary says so", (await teacher.get("/insights/calibration-summary")).body.data.scope.classIds, ["form3a"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the school administrator: the whole school, no other ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a pupil nobody assigned them to → 200 on every pupil read",
    await statuses(adminA, pupilReads("st-a2")), [200, 200, 200, 200]);
  check("a class they hold no assignment in → 200 on every class read",
    await statuses(adminA, classReads("form4b")), [200, 200, 200]);
  r = await adminA.get("/insights/review-cases");
  check("the unfiltered review sheet covers both classes",
    [...new Set(r.body.data.cases.map((c) => c.studentId))].sort(), ["st-a1", "st-a2"]);
  check("and the summary scope is the whole school",
    (await adminA.get("/insights/calibration-summary")).body.data.scope.classIds, null);

  check("another school's pupil → 404 on every pupil read",
    await statuses(adminA, pupilReads("st-b1")), [404, 404, 404, 404]);
  check("another school's class → 404", (await adminA.get("/insights/class/form1b")).status, 404);
  check("naming the other school in the query → 403 SCHOOL_ACCESS_DENIED",
    (await adminA.get(`/insights/review-cases?schoolId=${B}`)).body?.code, "SCHOOL_ACCESS_DENIED");
  r = await adminB.get("/insights/review-cases");
  check("and Beta's head sees none of Alpha's pupils on their own sheet",
    r.body.data.cases.some((c) => ["st-a1", "st-a2"].includes(c.studentId)), false);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the platform operator: the selected school, and only by selecting it ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("having selected Alpha → 200 on every pupil read",
    await statuses(operator, pupilReads("st-a1").map(inA)), [200, 200, 200, 200]);
  check("and every class read",
    await statuses(operator, classReads("form4b").map(inA)), [200, 200, 200]);
  check("and the intervention evidence",
    (await operator.get(inA("/interventions/iv-a2/evidence"))).status, 200);
  r = await operator.get(inA("/insights/review-cases"));
  check("the selected school's whole sheet",
    [...new Set(r.body.data.cases.map((c) => c.studentId))].sort(), ["st-a1", "st-a2"]);

  check("a school that does not exist → 404 SCHOOL_NOT_FOUND at the door",
    (await operator.get(`/insights/student/st-a1?schoolId=${NOWHERE}`)).body?.code, "SCHOOL_NOT_FOUND");
  check("selecting nothing is not selecting everything — no school, no answer",
    (await statuses(operator, pupilReads("st-a1"))).every((s) => s !== 200), true);
  check("having selected Alpha, Beta's pupil is still not there → 404",
    (await operator.get(inA("/insights/student/st-b1"))).status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. reviews: written by a teacher, named, read by the hierarchy ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const form = {
    observedPattern: "YES", classificationAppropriate: "PARTIALLY", evidenceSufficient: "YES",
    guidanceAppropriate: "YES", reason: "The fall is real but the sequence 3 paper was hard for everyone",
    temporal: { interpretationReasonable: "UNCERTAIN", possibleExplanation: "assessment_difficulty" },
  };
  const reviewBody = (studentId) => ({
    studentId, subjectId: "maths", category: "declining",
    classifications: [{ code: "academic_decline", confidence: "strong" }], review: form,
  });

  r = await teacher.post("/insights/reviews", reviewBody("st-a1"));
  check("the assigned teacher records a review → 201, attributed to them",
    [r.status, r.body?.data?.reviewedBy, r.body?.data?.engineVersion], [201, "teach-a", "1.0.0"]);
  check("for a pupil they do not teach → 403", (await teacher.post("/insights/reviews", reviewBody("st-a2"))).status, 403);
  check("Beta's head cannot review Alpha's pupil → 404", (await adminB.post("/insights/reviews", reviewBody("st-a1"))).status, 404);
  check("the bursar holds no review capability → 403", (await bursar.post("/insights/reviews", reviewBody("st-a1"))).status, 403);
  check("a value outside the form contract → 400 with the problem named",
    (await teacher.post("/insights/reviews", { ...reviewBody("st-a1"), review: { ...form, classificationAppropriate: "MAYBE" } })).status, 400);
  r = await operator.post(inA("/insights/reviews"), reviewBody("st-a2"));
  check("the operator, having selected the school, records one too → 201 attributed to them",
    [r.status, r.body?.data?.reviewedBy], [201, "operator"]);

  const seen = async (who, url) => { const x = await who.get(url); return [x.status, (x.body.data ?? []).map((v) => [v.reviewedBy, v.reviewedByName])]; };
  check("the teacher reads their own review, named",
    await seen(teacher, "/insights/reviews/student/st-a1"), [200, [["teach-a", "Mme Ateba"]]]);
  check("the head reads it, still named — not anonymised because a head is reading",
    await seen(adminA, "/insights/reviews/student/st-a1"), [200, [["teach-a", "Mme Ateba"]]]);
  check("the operator reads it, still named",
    await seen(operator, inA("/insights/reviews/student/st-a1")), [200, [["teach-a", "Mme Ateba"]]]);
  check("Beta's head gets nothing — not an anonymised copy, nothing",
    (await adminB.get("/insights/reviews/student/st-a1")).status, 404);
  check("the teacher cannot read the review on the pupil they do not teach",
    (await teacher.get("/insights/reviews/student/st-a2")).status, 403);

  r = await adminA.get("/insights/review-cases");
  const declining = r.body.data.cases.find((c) => c.category === "declining" && c.studentId === "st-a1");
  check("on the head's sheet the teacher's judgement is attached to the case, named",
    declining?.reviews?.map((v) => [v.reviewedBy, v.reviewedByName, v.review.classificationAppropriate]),
    [["teach-a", "Mme Ateba", "PARTIALLY"]]);
  check("and the feedback cross-tabulation counts it, with no accuracy figure",
    [r.body.data.feedback.totals.reviewed >= 1, /accuracy/i.test(JSON.stringify(r.body.data.feedback))], [true, false]);
  check("a persisted review is a school record on the review collection",
    await IntelligenceReview.countDocuments({ schoolId: A }), 2);

  // Stage 7C: the teacher who answered sees their own answer as theirs; a head
  // who has not answered is not a reviewer and is not shielded; and a review is
  // revised by its author or by nobody.
  r = await teacher.get("/insights/review-cases");
  const mineOnSheet = r.body.data.cases.find((c) => c.category === "declining" && c.studentId === "st-a1");
  check("on the teacher's own sheet the review rides on myReview, with the case status",
    [mineOnSheet?.myReview?.reviewedBy, mineOnSheet?.reviewStatus, mineOnSheet?.othersHidden], ["teach-a", "ONE_REVIEW", false]);
  const reviewId = mineOnSheet.myReview.reviewId;
  check("the head may not revise the teacher's review → 403 NOT_AUTHOR",
    (await adminA.patch(`/insights/reviews/${reviewId}`, { version: 1, review: form })).body?.code, "NOT_AUTHOR");
  check("nor the operator, even having selected the school",
    (await operator.patch(inA(`/insights/reviews/${reviewId}`), { version: 1, review: form })).body?.code, "NOT_AUTHOR");
  check("nor the bursar, who holds no review capability → 403",
    (await bursar.patch(`/insights/reviews/${reviewId}`, { version: 1, review: form })).status, 403);
  check("Beta's head cannot even find it → 404",
    (await adminB.patch(`/insights/reviews/${reviewId}`, { version: 1, review: form })).status, 404);
  check("the author may → 200, version 2, engine version kept",
    (({ status, body }) => [status, body.data?.version, body.data?.engineVersion])
      (await teacher.patch(`/insights/reviews/${reviewId}`, { version: 1, review: form })), [200, 2, "1.0.0"]);

  // The cross-school aggregate is a platform figure: platform.dashboard, or nothing.
  check("the cross-school calibration aggregate answers the operator with counts",
    (({ status, body }) => [status, body.schools?.map((s) => [s.schoolName, s.reviews])])
      (await operator.get("/super-admin/intelligence/calibration")), [200, [["Alpha Academy", 2], ["Beta College", 0]]]);
  check("and refuses the head, the teacher and the bursar",
    await statuses(adminA, ["/super-admin/intelligence/calibration"]).then(async (a) =>
      [...a, ...(await statuses(teacher, ["/super-admin/intelligence/calibration"])), ...(await statuses(bursar, ["/super-admin/intelligence/calibration"]))]),
    [403, 403, 403]);
  check("and carries no pupil id or name",
    /st-a1|st-a2|Pupil A/.test(JSON.stringify((await operator.get("/super-admin/intelligence/calibration")).body)), false);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. the engine answers the same whoever asks ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const asTeacher  = stable((await teacher.get("/insights/student/st-a1")).body);
  const asHead     = stable((await adminA.get("/insights/student/st-a1")).body);
  const asOperator = stable((await operator.get(inA("/insights/student/st-a1"))).body);
  check("one pupil's profile is byte-identical for teacher, head and operator",
    [asTeacher === asHead, asHead === asOperator], [true, true]);

  const casesFor = async (who, url) => (await who.get(url)).body.data.cases
    .filter((c) => c.studentId === "st-a1")
    .map((c) => [c.category, c.subjectId, c.classifications, c.metrics]);
  const t1 = JSON.stringify(await casesFor(teacher, "/insights/review-cases"));
  const h1 = JSON.stringify(await casesFor(adminA, "/insights/review-cases"));
  const o1 = JSON.stringify(await casesFor(operator, inA("/insights/review-cases")));
  check("and the pupil's review cases — category, classification, metrics — are identical across roles",
    [t1 === h1, h1 === o1, t1.length > 2], [true, true, true]);

  const gT = stable((await teacher.get("/insights/student/st-a1/guidance")).body);
  const gH = stable((await adminA.get("/insights/student/st-a1/guidance")).body);
  check("as is the guidance", gT === gH, true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. what a summary never carries ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const summaryText = JSON.stringify((await adminA.get("/insights/calibration-summary")).body);
  check("no salt, no export, no download, no raw cohort",
    /salt|CALIBRATION_SALT|export|download|cohortFile|rawCohort/i.test(summaryText), false);
  // Whole words: "fee" is a substring of "feedback", which the summary carries
  // on purpose, and a check that cries wolf gets switched off.
  check("no pupil name, phone or money",
    /Pupil A1|677|\bbalance\b|\bfees?\b|\barrears?\b/i.test(summaryText), false);
  check("but the distributions, flags and thresholds a head needs",
    ["evidence", "distribution", "flags", "sensitivity", "feedback"].every((k) => summaryText.includes(`"${k}"`)), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. the search for an alternate door ---");
  // ═══════════════════════════════════════════════════════════════════════════

  // A review is a named colleague's judgement about a named child — the same
  // class of record as an intervention note. The bursar is out of both, and out
  // of the sheet and the summary that carry them, by default.
  check("the bursar reaches no intervention, evidence, review, sheet or summary route",
    [...(await statuses(bursar, ["/interventions/student/st-a1", "/interventions/iv-a1/evidence",
      "/insights/reviews/student/st-a1", "/insights/review-cases", "/insights/calibration-summary"]))],
    [403, 403, 403, 403, 403]);
  check("the bursar's insights.view does reach subject intelligence — documented, and money-free by construction",
    (await bursar.get("/insights/student/st-a1")).status, 200);

  // The desktop handler is the other consumer. Drive it directly.
  const desktop = require(path.join(ROOT, "..", "desktop", "src", "main", "api", "handlers", "intelligence"));
  const byRoute = Object.fromEntries(desktop.map((h) => [h.route, h.handler]));
  const docsWith = (students) => ({
    find: (collection, filter) => collection === "student"
      ? students.filter((s) => s.classId === filter.classId && s.schoolId === filter.schoolId) : [],
    get: () => null,
  });
  check("a desktop session without an insights capability is declined",
    byRoute["GET /api/insights/class/:classId"]({ params: { classId: "form4b" }, query: {} },
      { docs: docsWith([]), session: { permissions: ["fees.view"], schoolId: A } }), null);
  check("a teacher's desktop, asked for a class its mirror holds no pupils of, declines rather than answering 'empty'",
    byRoute["GET /api/insights/class/:classId"]({ params: { classId: "form4b" }, query: {} },
      { docs: docsWith([{ _id: "st-a1", classId: "form3a", schoolId: A }]), session: { permissions: ["insights.viewTaught"], schoolId: A } }), null);
  check("a desktop guidance read for a pupil not in the mirror declines",
    byRoute["GET /api/insights/student/:studentId/guidance"]({ params: { studentId: "st-b1" }, query: {} },
      { docs: { get: () => null, find: () => [] }, session: { permissions: ["insights.view"], schoolId: A } }), null);

  // Reviews mirror only to those who may read the intelligence they review.
  const feed = require(path.join(SRC, "config/syncFeed"));
  const entry = feed.byCollection.get("intelligenceReview");
  check("the review collection is classified in the sync feed on the intelligence capabilities",
    [Boolean(entry), feed.required(entry)], [true, ["insights.view", "insights.viewTaught"]]);
  check("and scoped to taught pupils for a teacher's machine", typeof entry.scope, "function");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
