// backend/scripts/check-review-workflow.js
"use strict";

/**
 * The review workflow, walked end to end as the people who will use it.
 *
 * ── What is being proved ──────────────────────────────────────────────────
 *
 * That a teacher can open a case, read evidence that is separate from the
 * engine's reading of it, answer the form and have the answer persist — with
 * nothing but the application. That a second teacher can do the same on the
 * same case WITHOUT seeing the first answer, and that the two answers stay
 * distinct and named for the head. That the operator's cross-school view is
 * counts, and never a child. And that every wrong door — a malformed form, a
 * case the engine does not produce, a stale engine version, a second review by
 * the same person, another school's pupil, a teacher without the class, a
 * bursar — is shut with the right code.
 *
 * ── What is NOT being proved ──────────────────────────────────────────────
 *
 * Anything about the engine. The answers the fixture teachers give here are
 * test inputs chosen to exercise the workflow — one says PARTIALLY, one says
 * NO, so that "reviewers differ" has something to show. They are not evidence
 * about a threshold, they are not real teachers, and no report anywhere reads
 * them as either.
 *
 *   node scripts/check-review-workflow.js
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
const YEAR = "2026-2027";

const row = (subjectId, subjectName, normalizedMark, extra = {}) => ({
  subjectId, subjectName, normalizedMark, score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null, isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false, ...extra,
});

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School             = mongoose.model("School");
  const User               = mongoose.model("User");
  const Class              = mongoose.model("Class");
  const Student            = mongoose.model("Student");
  const TeacherAssignment  = mongoose.model("TeacherAssignment");
  const Exam               = mongoose.model("Exam");
  const ResultSummary      = mongoose.model("ResultSummary");
  const IntelligenceReview = mongoose.model("IntelligenceReview");
  await IntelligenceReview.syncIndexes();

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a",  "teacher",      A, "Mme Ateba"),
    mkUser("teach-b",  "teacher",      A, "M. Biya"),
    mkUser("teach-c",  "teacher",      A, "Mme Chantal"),
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
  // Two teachers on the same class — the independent-reviewer case — and one
  // on a different class, who must not reach the first class's pupils.
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
    { schoolId: A, teacher: "teach-b", class: "form3a", subject: "ict" },
    { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `${n}`, isActive: true, status: "approved",
  });
  await Student.create([pupil("st-a1", A, "form3a", "A1"), pupil("st-a2", A, "form4b", "A2"), pupil("st-b1", B, "form1b", "B1")]);
  const mkExam = (id, schoolId, classId, term, seq, startDate) => ({
    _id: id, schoolId, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate,
    classId, totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
  });
  await Exam.create([
    mkExam("ax1", A, "form3a", 1, 1, "2026-10-05"), mkExam("ax2", A, "form3a", 1, 2, "2026-11-20"),
    mkExam("ax3", A, "form3a", 2, 1, "2027-02-10"),
  ]);
  const summary = (id, examId, studentId, classId, schoolId, term, rows) => ({
    _id: id, examId, studentId, classId, schoolId, academicYear: YEAR, term: String(term),
    isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows,
  });
  await ResultSummary.create([
    summary("s1", "ax1", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 16), row("ict", "ICT", 16)]),
    summary("s2", "ax2", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 15), row("ict", "ICT", 17)]),
    summary("s3", "ax3", "st-a1", "form3a", A, 2, [row("maths", "Mathematics", 9),  row("ict", "ICT", 17)]),
    summary("s4", "ax1", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 8)]),
    summary("s5", "ax2", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 7)]),
    summary("s6", "ax3", "st-a2", "form4b", A, 2, [row("maths", "Mathematics", 6)]),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights",    auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
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
  const teacherA = as("teach-a",  "teacher",      A);
  const teacherB = as("teach-b",  "teacher",      A);
  const teacherC = as("teach-c",  "teacher",      A);
  const head     = as("admin-a",  "school_admin", A);
  const headB    = as("admin-b",  "school_admin", B);
  const bursar   = as("bursar-a", "bursar",       A);
  const operator = as("operator", "super_admin",  null);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;

  // The two fixture answers. Different on purpose — see the header.
  const formA = {
    observedPattern: "YES", classificationAppropriate: "PARTIALLY", evidenceSufficient: "YES",
    guidanceAppropriate: "YES", reason: "The fall is real but the sequence 3 paper was hard for everyone",
    dataQuality: ["assessment_unusually_difficult"],
    temporal: { interpretationReasonable: "UNCERTAIN", possibleExplanation: "assessment_difficulty" },
  };
  const formB = {
    observedPattern: "NO", classificationAppropriate: "NO", evidenceSufficient: "NO",
    guidanceAppropriate: "UNCERTAIN", reason: "One mark is not a trend", dataQuality: ["insufficient_history"],
  };

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the first teacher opens the queue ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = await teacherA.get("/insights/review-cases");
  const sheet = r.body.data;
  check("the queue opens → 200 with cases, a form contract and a status block",
    [r.status, sheet.cases.length > 0, Array.isArray(sheet.reviewForm.dataQuality), typeof sheet.reviewStatus.unreviewed],
    [200, true, true, "number"]);
  check("only pupils the teacher takes are on it", [...new Set(sheet.cases.map((c) => c.studentId))], ["st-a1"]);
  check("the queue is in priority order", sheet.cases.every((c, i, a) => i === 0 || a[i - 1].priority <= c.priority), true);
  check("before anybody has answered, every case is UNREVIEWED with nothing attached",
    sheet.cases.every((c) => c.reviewStatus === "UNREVIEWED" && c.reviewCount === 0 && c.reviews.length === 0 && c.myReview === null), true);

  const decline = sheet.cases.find((c) => c.category === "declining" && c.subjectId === "maths");
  check("the declining maths case is there, named for the teacher, with its class",
    [decline?.studentName, decline?.className, decline?.enrollmentNo], ["Pupil A1", "Form 3A", "A1"]);
  check("evidence is carried separately from the engine's interpretation",
    [decline.marks.length, decline.metrics !== null, decline.classifications.map((k) => k.code), decline.explanation.length > 0],
    [3, true, ["academic_decline", "sudden_performance_change"], true]);
  check("and the form starts empty, with the temporal block the codes call for",
    [decline.review.classificationAppropriate, decline.review.dataQuality, "temporal" in decline.review], [null, [], true]);
  check("the marks are strings a teacher can read, not raw documents",
    decline.marks.every((m) => typeof m === "string" && /T\d/.test(m)), true);
  check("the queue can be cut to the first N most worth a look",
    (await teacherA.get("/insights/review-cases?limit=1")).body.data.cases.length, 1);
  check("and says how many there were", (await teacherA.get("/insights/review-cases?limit=1")).body.data.totalCases, sheet.cases.length);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the first teacher submits ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const body = (form, extra = {}) => ({
    studentId: "st-a1", subjectId: "maths", category: "declining", engineVersion: sheet.engineVersion,
    // A client-supplied classification list is ignored: the server stores what
    // the engine says, not what the request claims.
    classifications: [{ code: "made_up", confidence: "strong" }],
    review: form, ...extra,
  });
  r = await teacherA.post("/insights/reviews", body(formA));
  const reviewA = r.body.data;
  check("→ 201, attributed, under the engine version, with the SERVER's classifications",
    [r.status, reviewA.reviewedBy, reviewA.engineVersion, reviewA.classifications.map((k) => k.code), reviewA.version],
    [201, "teach-a", "1.0.0", ["academic_decline", "sudden_performance_change"], 1]);
  check("the data-quality codes are stored", reviewA.review.dataQuality, ["assessment_unusually_difficult"]);
  check("it persists on the review collection",
    (await IntelligenceReview.findById(reviewA._id).lean())?.review?.classificationAppropriate, "PARTIALLY");

  r = await teacherA.get("/insights/review-cases");
  let mine = r.body.data.cases.find((c) => c.caseId === decline.caseId);
  check("back on the queue the case is ONE_REVIEW and the teacher's own answer rides on myReview",
    [mine.reviewStatus, mine.reviewCount, mine.myReview?.reviewedBy, mine.othersHidden], ["ONE_REVIEW", 1, "teach-a", false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the second teacher must not see the first answer ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacherB.get("/insights/review-cases");
  let theirs = r.body.data.cases.find((c) => c.caseId === decline.caseId);
  check("the second teacher sees the same case and that ONE review exists",
    [theirs.reviewStatus, theirs.reviewCount, theirs.reviewerCount], ["ONE_REVIEW", 1, 1]);
  check("but not one word of it, nor who wrote it, nor whether anyone agreed",
    [theirs.reviews, theirs.myReview, theirs.othersHidden, theirs.agreement], [[], null, true, null]);
  check("the whole response carries neither the first teacher's answer text nor their name",
    /hard for everyone|Mme Ateba/.test(JSON.stringify(r.body)), false);
  r = await teacherB.get("/insights/reviews/student/st-a1");
  check("the per-pupil review list is shielded the same way: nothing shown, one hidden",
    [r.status, r.body.data, r.body.hiddenCount], [200, [], 1]);

  r = await teacherB.post("/insights/reviews", body(formB));
  const reviewB = r.body.data;
  check("the second teacher submits independently → 201, attributed to them", [r.status, reviewB.reviewedBy], [201, "teach-b"]);

  r = await teacherB.get("/insights/review-cases");
  theirs = r.body.data.cases.find((c) => c.caseId === decline.caseId);
  check("having answered, they now see both, named, and that the two differ",
    [theirs.reviewStatus, theirs.reviews.map((v) => [v.reviewedByName, v.review.classificationAppropriate]).sort(), theirs.agreement],
    ["MULTIPLE_REVIEWS", [["M. Biya", "NO"], ["Mme Ateba", "PARTIALLY"]], "DIFFER"]);
  r = await teacherA.get("/insights/review-cases");
  mine = r.body.data.cases.find((c) => c.caseId === decline.caseId);
  check("and so does the first teacher", [mine.reviewCount, mine.reviews.length, mine.agreement], [2, 2, "DIFFER"]);
  check("two rows, two reviewers, both distinct on the collection",
    (await IntelligenceReview.find({ schoolId: A }).lean()).map((v) => [v.reviewedBy, v.review.classificationAppropriate]).sort(),
    [["teach-a", "PARTIALLY"], ["teach-b", "NO"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. the head and the operator see the whole picture ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await head.get("/insights/review-cases");
  const headCase = r.body.data.cases.find((c) => c.caseId === decline.caseId);
  check("the head, who is not a reviewer, sees both reviews named from the start",
    [headCase.reviews.length, headCase.othersHidden, headCase.myReview, headCase.agreement], [2, false, null, "DIFFER"]);
  const st = r.body.data.reviewStatus;
  check("the school-wide status block counts it",
    [st.multipleReviews, st.agreement.differ, st.reviewsRecorded, st.reviewers, st.byCategory.declining?.multipleReviews],
    [1, 1, 2, 2, 1]);
  const fb = r.body.data.feedback;
  check("the feedback tally reads both answers and the data-quality citations",
    [fb.totals.reviewed, fb.dataQualityCitations, fb.casesCitingDataQuality],
    [2, { assessment_unusually_difficult: 1, insufficient_history: 1 }, 2]);
  const sum = (await head.get("/insights/calibration-summary")).body.data;
  check("the calibration summary carries the review status and the same tally, no cases",
    [sum.reviewStatus.reviewsRecorded, sum.feedback.totals.reviewed, "cases" in sum], [2, 2, false]);
  check("nothing on the sheet or the summary is called accuracy",
    /accuracy/i.test(JSON.stringify(r.body) + JSON.stringify(sum)), false);

  r = await operator.get(inA("/insights/review-cases"));
  check("the operator, having selected the school, sees the same",
    r.body.data.cases.find((c) => c.caseId === decline.caseId)?.reviews.length, 2);

  r = await operator.get(`/super-admin/intelligence/calibration?schoolId=${A}`);
  check("the cross-school aggregate for the selected school: counts, reviewers, versions, outcomes",
    [r.status, r.body.schools.length, r.body.schools[0].reviews, r.body.schools[0].reviewers,
     r.body.schools[0].engineVersions, r.body.schools[0].byCategory],
    [200, 1, 2, 2, ["1.0.0"], { declining: 2 }]);
  check("and it carries no pupil — no id, no name, no mark",
    /st-a1|Pupil|studentId|marks/.test(JSON.stringify(r.body)), false);
  r = await operator.get("/super-admin/intelligence/calibration");
  check("without a school named it lists every school, Beta at zero",
    r.body.schools.map((s) => [s.schoolName, s.reviews]), [["Alpha Academy", 2], ["Beta College", 0]]);
  check("the head cannot reach the cross-school aggregate",
    (await head.get("/super-admin/intelligence/calibration")).status, 403);
  check("a school that does not exist → 404",
    (await operator.get("/super-admin/intelligence/calibration?schoolId=6a0000000000000000000dea")).status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. the doors that must stay shut ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const code = async (who, b) => { const x = await who.post("/insights/reviews", b); return [x.status, x.body.code]; };
  check("a malformed form → 400 INVALID_REVIEW, the problem named",
    (await teacherA.post("/insights/reviews", body({ ...formA, classificationAppropriate: "MAYBE" }))).body.problems?.length > 0, true);
  check("a data-quality code outside the contract → 400",
    await code(teacherA, body({ ...formA, dataQuality: ["gremlins"] })), [400, "INVALID_REVIEW"]);
  check("no form at all → 400", await code(teacherA, { ...body(formA), review: undefined }), [400, "INVALID_REVIEW"]);
  check("the same teacher on the same case again → 409 DUPLICATE_REVIEW, pointing at the first",
    (await teacherA.post("/insights/reviews", body(formA))).body.reviewId, reviewA._id);
  check("a case the engine does not produce for this pupil → 404 CASE_NOT_FOUND",
    await code(teacherA, body(formA, { category: "zero_heavy" })), [404, "CASE_NOT_FOUND"]);
  check("a subject the pupil has no such case in → 404 CASE_NOT_FOUND",
    await code(teacherA, body(formA, { subjectId: "ict" })), [404, "CASE_NOT_FOUND"]);
  check("a review made against another engine version → 409 STALE_ENGINE_VERSION",
    await code(teacherA, body(formA, { engineVersion: "0.9.0" })), [409, "STALE_ENGINE_VERSION"]);
  check("Beta's head on Alpha's pupil → 404", (await headB.post("/insights/reviews", body(formA))).status, 404);
  check("a teacher without the class → 403, and the pupil is not on their queue",
    [(await teacherC.post("/insights/reviews", body(formA))).status,
     (await teacherC.get("/insights/review-cases")).body.data.cases.some((c) => c.studentId === "st-a1")], [403, false]);
  check("the bursar → 403 on the queue and on a submission",
    [(await bursar.get("/insights/review-cases")).status, (await bursar.post("/insights/reviews", body(formA))).status], [403, 403]);
  check("the operator without a selected school → no queue",
    (await operator.get("/insights/review-cases")).status, 400);
  let dup = null;
  try {
    await IntelligenceReview.create({ schoolId: A, studentId: "st-a1", classId: "form3a", subjectId: "maths",
      category: "declining", engineVersion: "1.0.0", review: formA, reviewedBy: "teach-a" });
  } catch (e) { dup = e.code; }
  check("and the collection itself refuses a second row for one reviewer on one case", dup, 11000);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. revision: the author, the trail, the version ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const revised = { ...formA, classificationAppropriate: "YES", reason: "On reflection the fall is genuine" };
  r = await teacherB.patch(`/insights/reviews/${reviewA._id}`, { version: 1, review: revised });
  check("a colleague cannot revise it → 403 NOT_AUTHOR", [r.status, r.body.code], [403, "NOT_AUTHOR"]);
  r = await head.patch(`/insights/reviews/${reviewA._id}`, { version: 1, review: revised });
  check("nor can the head — they write their own", [r.status, r.body.code], [403, "NOT_AUTHOR"]);
  r = await teacherA.patch(`/insights/reviews/${reviewA._id}`, { version: 7, review: revised });
  check("a stale version → 409 VERSION_CONFLICT with the current row", [r.status, r.body.code, r.body.data.version], [409, "VERSION_CONFLICT", 1]);
  r = await teacherA.patch(`/insights/reviews/${reviewA._id}`, { version: 1, review: { ...revised, evidenceSufficient: "SOMEWHAT" } });
  check("a malformed revision → 400", r.status, 400);

  r = await teacherA.patch(`/insights/reviews/${reviewA._id}`, { version: 1, review: revised });
  check("the author revises → 200, version 2, the new answer in place",
    [r.status, r.body.data.version, r.body.data.review.classificationAppropriate], [200, 2, "YES"]);
  check("the original answer is kept on the trail with when it was replaced",
    [r.body.data.revisions.length, r.body.data.revisions[0].review.classificationAppropriate, typeof r.body.data.revisions[0].replacedAt],
    [1, "PARTIALLY", "string"]);
  check("the engine version and the author are untouched by a revision",
    [r.body.data.engineVersion, r.body.data.reviewedBy, r.body.data.revisedAt !== null], ["1.0.0", "teach-a", true]);
  r = await head.get("/insights/review-cases");
  check("the head's sheet now shows the revised answer and that it was revised",
    r.body.data.cases.find((c) => c.caseId === decline.caseId).reviews
      .filter((v) => v.reviewedBy === "teach-a").map((v) => [v.review.classificationAppropriate, v.version, v.revisedAt !== null]),
    [["YES", 2, true]]);
  check("the bursar cannot revise anything", (await bursar.patch(`/insights/reviews/${reviewA._id}`, { version: 2, review: revised })).status, 403);
  check("a review that does not exist → 404", (await teacherA.patch("/insights/reviews/nope", { version: 1, review: revised })).status, 404);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
