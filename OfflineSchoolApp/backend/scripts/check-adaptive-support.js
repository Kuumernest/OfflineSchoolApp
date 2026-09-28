// backend/scripts/check-adaptive-support.js
"use strict";

/**
 * Adaptive Support Engine 1.0.0 — the review of a plan against the evidence
 * that became available and what the people reported.
 *
 * Continue, adapt, complete, pause, insufficient evidence; improving,
 * stable, declining, contradictory evidence; a changed context; missing
 * evidence; the pupil's feedback; the teacher's feedback; a resource
 * constraint; the intervention outcome; the evidence-boundary rule; the
 * "expected change not shown" rule; the adaptation record; deterministic
 * replay and historical asOf — then the routes: a review with a decision,
 * an adaptation applied, the history kept, live = offline.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-adaptive-support.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const fs       = require("fs");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { runEngine } = require(path.join(ROOT, "scripts/calibration/analyseCohort"));
const strengths = require(path.join(ROOT, "..", "shared", "strengths"));
const le = require(path.join(ROOT, "..", "shared", "learningEvidence"));
const dev = require(path.join(ROOT, "..", "shared", "development"));
const guidance = require(path.join(ROOT, "..", "shared", "guidance"));
const dp = require(path.join(ROOT, "..", "shared", "developmentPlanning"));
const asup = require(path.join(ROOT, "..", "shared", "adaptiveSupport"));
const strengthsSvc = require(path.join(SRC, "services/intelligence/strengths.service"));

const Q = "quantitative_reasoning";
const ASOF = "2027-06-01";
const EXAMS = [["X1", 1, 1, "2026-10-05"], ["X2", 1, 2, "2026-11-20"], ["X3", 2, 1, "2027-02-10"], ["X4", 2, 2, "2027-03-20"], ["X5", 3, 1, "2027-05-10"]].map(([examId, term, sequenceNumber, startDate]) => ({ examId, type: "test", academicYear: "2026-2027", term, sequenceNumber, startDate }));
const profileOf = (marks, { exams = 5 } = {}) => runEngine({ format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" }, grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 }, exams: EXAMS.slice(0, exams), students: [{ studentId: "S", classId: "C" }],
  results: EXAMS.slice(0, exams).map((e, i) => ({ resultId: `S-${e.examId}`, studentId: "S", classId: "C", examId: e.examId, isPublished: true, subjects: Object.keys(marks).filter((n) => marks[n][i] !== undefined).map((n) => ({ subjectId: n.toLowerCase(), subjectName: n, normalizedMark: marks[n][i], score: marks[n][i], maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false })) })), interventions: [] }).profiles.get("S");
const hw = (id, due, score) => ({ _id: id, subjectId: "mathematics", classId: "c", dueDate: due, maxScore: 20, isPublished: true, createdAt: due, version: 1, submission: { submittedAt: due, score, gradedAt: due } });
const learning = (s) => le.buildLearningEvidence({ pupilId: "S", schoolId: "A", sources: s, asOf: ASOF });
const build = (marks, o = {}) => strengths.buildStrengthProfile({ academicProfile: profileOf(marks, o), explorationEvidence: [], learningEvidence: o.learningEvidence ?? null, asOf: ASOF });
const STRONG = { Mathematics: [16, 17, 16, 17, 16] };
const P = { EST: build(STRONG), EST_C: build(STRONG, { learningEvidence: learning({ homework: [hw("h1", "2027-04-01", 16), hw("h2", "2027-04-15", 17)] }) }), EST_X: build(STRONG, { learningEvidence: learning({ homework: [hw("w1", "2027-04-01", 6), hw("w2", "2027-04-15", 7)] }) }), DEC: build({ Mathematics: [17, 17, 16, 10, 9] }) };
const DATES = ["2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15", "2027-05-15"];
const snap = (v, p, hash = `h${v}`) => ({ profileVersion: v, asOf: DATES[v - 1], generatedAt: DATES[v - 1], periodLabel: `T${v}`, evidenceBoundary: { hash }, academicEngineVersion: "1.0.0", strengthEngineVersion: "1.2.0", explorationEngineVersion: "1.0.0", learningIntegrationVersion: "1.0.0", learningEvidenceVersion: "1.0.0", profile: strengthsSvc.readingOf(p) });
const hist = (ps, { asOf = ASOF, hashes = [] } = {}) => dev.buildDevelopmentHistory({ snapshots: ps.map((p, i) => snap(i + 1, p, hashes[i])), asOf });
const g0 = guidance.buildGuidance({ development: hist([P.EST, P.EST]), asOf: ASOF });
const base = dp.buildPlan({ guidanceItem: g0.items.find((i) => i.dimension === Q && i.category === "MAINTAIN"), startDate: "2027-02-20", evidenceBoundaryHash: "h2", engineVersions: { guidance: "1.0.0", development: "1.0.0" } });
const done = (ms, ids, role = "STUDENT") => ids.reduce((acc, id) => dp.milestoneTransition(acc, { milestoneId: id, action: "complete", actorRole: role, at: "2027-03-01" }).milestones, ms);
const stored = (over = {}) => ({ ...base, _id: "p", createdAt: "2027-02-20T00:00:00.000Z", statusHistory: [{ from: null, to: "ACTIVE", at: "2027-02-21T00:00:00.000Z" }], status: "ACTIVE", reviews: [], adaptations: [], reflections: [], constraints: [], ...over });
const review = (plan, ps, extra = {}) => asup.reviewPlan({ plan, development: hist(ps, extra.hist), asOf: extra.asOf ?? ASOF, ...extra });

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the five outcomes, from the evidence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = review(stored({ milestones: done(base.milestones, ["m1"]) }), [P.EST, P.EST, P.EST_C, P.EST_C]);
  check("versions: adaptive 1.0.0; improving evidence with milestones in progress → CONTINUE, the reasons named, the reading IMPROVING, two independent observations since the boundary",
    [r.adaptiveSupportEngineVersion, r.outcome, r.reasons, r.contract.changed.reading, r.contract.evidence.independentObservations, r.statement.causal], ["1.0.0", "CONTINUE", ["NEW_INDEPENDENT_EVIDENCE", "EVIDENCE_IMPROVING", "MILESTONES_REQUIRED_NOT_MET", "MILESTONES_IN_PROGRESS"], "IMPROVING", 2, false]);
  r = review(stored({ milestones: done(done(base.milestones, ["m1", "m2"]), ["m3"], "TEACHER") }), [P.EST, P.EST, P.EST_C, P.EST_C]);
  check("all required milestones done and new independent evidence: COMPLETE — the completion criteria, not the marks, decide", [r.outcome, r.reasons.includes("COMPLETION_CRITERIA_MET"), r.statement.code], ["COMPLETE", true, "OBJECTIVE_ADDRESSED_PER_CRITERIA"]);
  r = review(stored({ milestones: done(done(base.milestones, ["m1", "m2"]), ["m3"], "TEACHER") }), [P.EST, P.EST]);
  check("all milestones done but no new independent evidence: not complete — INSUFFICIENT_EVIDENCE (the objective needs an observation)", [r.outcome, r.reasons.includes("NO_NEW_INDEPENDENT_EVIDENCE"), r.reasons.includes("COMPLETION_CRITERIA_MET")], ["INSUFFICIENT_EVIDENCE", true, false]);
  r = review(stored({ milestones: done(base.milestones, ["m1"]) }), [P.EST, P.EST, P.EST_X, P.EST_X]);
  check("contradictory evidence: ADAPT, the contradiction explained, the original evidence kept, bounded actions suggested", [r.outcome, r.reasons.includes("CONTRADICTORY_EVIDENCE"), r.contradiction.code, r.contradiction.originalEvidenceKept, r.adaptation.suggestedActions], ["ADAPT", true, "NEW_EVIDENCE_CONFLICTS_WITH_RATIONALE", true, ["REPEAT_OBSERVATION", "DIFFERENT_PRACTICE"]]);
  r = review(stored({ milestones: done(base.milestones, ["m1"]) }), [P.EST, P.EST, P.DEC, P.DEC]);
  check("declining development: ADAPT with teacher support or different practice — no word of failure", [r.outcome, r.reasons.includes("EVIDENCE_DECLINING"), r.adaptation.suggestedActions, /fail/i.test(JSON.stringify(r))], ["ADAPT", true, ["TEACHER_SUPPORT", "DIFFERENT_PRACTICE"], false]);
  r = review(stored({ milestones: done(base.milestones, ["m1"]) }), [P.EST, P.EST, P.EST, P.EST]);
  check("stable evidence with milestones in progress: CONTINUE", [r.outcome, r.contract.changed.reading], ["CONTINUE", "STABLE"]);
  r = review(stored(), [P.EST, P.EST]);
  check("nothing new and the first milestone still open: CONTINUE — the plan is still gathering evidence", [r.outcome, r.reasons.includes("PLAN_STILL_GATHERING_EVIDENCE")], ["CONTINUE", true]);
  r = review(stored({ milestones: done(base.milestones, ["m1"]) }), [P.EST, P.EST, P.EST_C], { constraints: [{ code: "NO_DEVICE", at: "2027-05-01" }] });
  check("a documented constraint: PAUSE, with resource substitution suggested", [r.outcome, r.reasons.includes("CONSTRAINT_DOCUMENTED"), r.adaptation.suggestedActions[0], r.contract.uncertain.constraints], ["PAUSE", true, "RESOURCE_SUBSTITUTION", ["NO_DEVICE"]]);
  check("every outcome the engine can give is one of the documented five; 'failed' is not among them", [asup.REVIEW_OUTCOMES, asup.REVIEW_OUTCOMES.includes("FAILED")], [["CONTINUE", "ADAPT", "COMPLETE", "PAUSE", "INSUFFICIENT_EVIDENCE"], false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. what the people report; the intervention outcome; the boundary rule ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const plan = stored({ milestones: done(base.milestones, ["m1"]) }), good = [P.EST, P.EST, P.EST_C, P.EST_C];
  check("the pupil says not useful → ADAPT (different practice / new context); too difficult → lower complexity; too easy → higher; needs support → teacher support; resource problem → PAUSE",
    [review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["NOT_USEFUL"] }] }).adaptation.suggestedActions, review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["TOO_DIFFICULT"] }] }).adaptation.suggestedActions[0], review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["TOO_EASY"] }] }).adaptation.suggestedActions[0],
     review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["NEED_MORE_SUPPORT"] }] }).adaptation.suggestedActions[0], review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["RESOURCE_PROBLEM"] }] }).outcome],
    [["DIFFERENT_PRACTICE", "NEW_CONTEXT"], "LOWER_COMPLEXITY", "HIGHER_COMPLEXITY", "TEACHER_SUPPORT", "PAUSE"]);
  check("a reflection is evidence about the experience: 'useful' is recorded and changes no outcome; nothing converts it into a strength", [review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["USEFUL"] }] }).outcome, review(plan, good, { reflections: [{ at: "2027-05-01", codes: ["USEFUL"] }] }).reasons.includes("STUDENT_REPORTED_USEFUL"), /strength.*score|ability/i.test(JSON.stringify(asup.ADAPTATIONS))], ["CONTINUE", true, false]);
  check("the teacher observes difficulty → ADAPT (teacher support); reports no new evidence with none on record → INSUFFICIENT_EVIDENCE; reports a changed context → ADAPT (new context); observes progress → CONTINUE",
    [review(plan, good, { teacherReview: { code: "OBSERVED_DIFFICULTY" } }).adaptation.suggestedActions[0], review(stored({ milestones: done(base.milestones, ["m1"]) }), [P.EST, P.EST], { teacherReview: { code: "NO_NEW_EVIDENCE" } }).outcome, review(plan, good, { teacherReview: { code: "CONTEXT_CHANGED" } }).adaptation.suggestedActions, review(plan, good, { teacherReview: { code: "OBSERVED_PROGRESS" } }).outcome],
    ["TEACHER_SUPPORT", "INSUFFICIENT_EVIDENCE", ["NEW_CONTEXT"], "CONTINUE"]);
  check("the linked intervention's outcome is read through the existing engine's categories: DECLINED → ADAPT; IMPROVED is a reason; nothing is recomputed here",
    [review(plan, good, { interventionOutcomes: [{ outcome: "DECLINED" }] }).outcome, review(plan, good, { interventionOutcomes: [{ outcome: "IMPROVED" }] }).reasons.includes("INTERVENTION_OUTCOME_IMPROVED"), /before\.average|after\.average/.test(fs.readFileSync(path.join(ROOT, "..", "shared", "adaptiveSupport", "rules.js"), "utf8"))], ["ADAPT", true, false]);
  r = review(plan, [P.EST, P.EST, P.EST_C, P.EST_C], { hist: { hashes: ["h1", "h2", "h2", "h2"] } });
  check("the evidence-boundary rule: snapshots on the plan's own boundary are not new independent evidence", [r.contract.evidence.independentObservations, r.outcome], [0, "CONTINUE"]);
  const twice = { ...plan, reviews: [{ reviewId: "r1", at: "2027-04-20T00:00:00.000Z", system: { reasons: ["NEW_INDEPENDENT_EVIDENCE", "EVIDENCE_STABLE"] } }] };
  r = review(twice, [P.EST, P.EST, P.EST, P.EST]);
  check("after a second review with new evidence and no change, the available evidence does not show the expected change → ADAPT; the sentence is about evidence, never 'did not work'",
    [r.outcome, r.reasons.includes("EXPECTED_CHANGE_NOT_SHOWN"), r.statement.code, /did not work|failed/i.test(JSON.stringify(r))], ["ADAPT", true, "AVAILABLE_EVIDENCE_DOES_NOT_SHOW_THE_EXPECTED_CHANGE_OR_A_CHANGE_WAS_REQUESTED", false]);
  check("the review answers the nine questions as structured fields", Object.keys(r.contract), ["objective", "attempted", "milestones", "evidence", "changed", "studentReported", "teacherObserved", "uncertain", "next"]);
  check("the review names its boundaries", [r.evidenceBoundaryHash, typeof r.developmentObservationBoundary, r.asOf], ["h2", "string", "2027-06-01T00:00:00.000Z"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. adaptation; replay; purity ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const rv = review(plan, [P.EST, P.EST, P.EST_X, P.EST_X]);
  const ad = asup.adaptPlan({ plan, review: { ...rv, reviewId: "r1" }, actionType: "DIFFERENT_PRACTICE", actorRole: "TEACHER", by: "t", at: ASOF });
  check("an adaptation replaces the action without deleting it, adds fresh milestones after the existing ones, and records previous, next, reason, boundary, reviewer, time, versions",
    [ad.actions.map((a) => [a.actionType, Boolean(a.replacedAt)]), ad.milestones.map((m) => m.milestoneId), ad.adaptation.previous, ad.adaptation.next, ad.adaptation.reason.outcome, ad.adaptation.reason.chosenWasSuggested, ad.adaptation.evidenceBoundaryHash, ad.adaptation.role, ad.adaptation.at, ad.adaptation.engineVersions.adaptive],
    [[["MORE_PRACTICE", true], ["DIFFERENT_PRACTICE", false]], ["m1", "m2", "m3", "a1m1", "a1m2", "a1m3"], { actions: ["MORE_PRACTICE"] }, { actions: ["DIFFERENT_PRACTICE"] }, "ADAPT", true, "h2", "TEACHER", "2027-06-01T00:00:00.000Z", "1.0.0"]);
  check("the adaptation answers what changed, why, what is uncertain, what is changing", Object.keys(ad.adaptation.explanation), ["changed", "because", "uncertain", "changing"]);
  check("an action outside the vocabulary is refused; the vocabulary is the documented twelve", [(() => { try { asup.adaptPlan({ plan, review: rv, actionType: "MAGIC", actorRole: "TEACHER", at: ASOF }); } catch (e) { return e.code; } })(), dp.ACTION_TYPES.length], ["INVALID_ACTION", 12]);
  check("deterministic: the same plan, history and asOf give byte-identical reviews", JSON.stringify(review(plan, good)) === JSON.stringify(review(plan, good)), true);
  check("historical asOf: reviewed as of 1 March, later snapshots do not exist and the outcome is the early one; future evidence never leaks", [review(plan, good, { asOf: "2027-03-01" }).contract.evidence.independentObservations, review(plan, good, { asOf: "2027-03-01" }).outcome, review(plan, good).contract.evidence.independentObservations], [0, "CONTINUE", 2]);
  let threw = false; try { asup.reviewPlan({ plan, development: hist(good) }); } catch { threw = true; }
  check("asOf is required — the engine never reaches for the clock", threw, true);
  const srcDir = path.join(ROOT, "..", "shared", "adaptiveSupport");
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n").replace(/const FORBIDDEN_KEYS = [^\n]*\n/, "");
  check("no plan score, probability, ranking or readiness key in the engine; pure; name-free; no causal claim in the output", [/\b(planScore|goalScore|riskScore|successProbability|completionProbability|aptitudeScore|readinessScore|score|probability|ranking)\s*[:=(]/.test(src), /require\(["'](fs|http|https|mongoose|axios|crypto)["']\)/.test(src), /Date\.now\(\)|new Date\(\)/.test(src), /studentName|\bemail\b/.test(src), /because the|caused/i.test(JSON.stringify(rv))], [false, false, false, false, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: the application.
  // ═══════════════════════════════════════════════════════════════════════════

  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const A = "6a00000000000000000000a1", YEAR = "2026-2027";
  await M("School").create([{ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" }]);
  const mkUser = (id, role, schoolId, name) => M("User").create({ _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true });
  await Promise.all([mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("stu-a1", "student", A, "Pupil A1")]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }]);
  await M("TeacherAssignment").create([{ schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }]);
  await M("Student").create([{ _id: "st-a1", userId: "stu-a1", schoolId: A, classId: "form3a", studentName: "Pupil A1", enrollmentNo: "A1", isActive: true, status: "approved" }]);
  await M("Subject").create({ _id: "maths", schoolId: A, name: "Mathematics", code: "MAT", classId: "form3a" });
  const mkExam = (id, term, seq, startDate) => ({ _id: id, schoolId: A, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate, classId: "form3a", totalMarks: 20, passMark: 10, status: "published", resultsPublished: true });
  await M("Exam").create([mkExam("t1", 1, 1, "2027-01-10"), mkExam("t2", 1, 2, "2027-02-10"), mkExam("t3", 2, 1, "2027-03-10"), mkExam("t4", 2, 2, "2027-04-10")]);
  const row = (m) => ({ subjectId: "maths", subjectName: "Mathematics", normalizedMark: m, score: m, maxScore: 20, coefficient: 1, grade: null, points: 0, remark: null, isPassing: m >= 10, isAbsent: false, isExempt: false });
  const summary = (id, examId, term, m) => ({ _id: id, examId, studentId: "st-a1", classId: "form3a", schoolId: A, academicYear: YEAR, term: String(term), isPublished: true, percentage: 80, isPassing: true, subjectsFailed: 0, subjectBreakdown: [row(m)] });
  await M("ResultSummary").create([summary("rs1", "t1", 1, 16), summary("rs2", "t2", 1, 17), summary("rs3", "t3", 2, 16), summary("rs4", "t4", 2, 17)]);
  const gradedSub = (score, submittedAt) => ({ studentId: "st-a1", text: "done", submittedAt, score, gradedAt: submittedAt, gradedBy: "teach-a" });
  await M("Homework").create([
    { _id: "hw1", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Fractions", dueDate: "2027-04-01", maxScore: 20, isPublished: true, submissions: [gradedSub(16, "2027-04-01")] },
    { _id: "hw2", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Ratios", dueDate: "2027-04-08", maxScore: 20, isPublished: true, submissions: [gradedSub(18, "2027-04-10")] },
  ]);
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const call = (token) => { const c = async (method, url, body) => { const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); let out = {}; try { out = await res.json(); } catch { /* empty */ } return { status: res.status, body: out }; }; return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b), patch: (u, b) => c("PATCH", u, b) }; };
  const as = (id, role, schoolId) => call(jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" }));
  const teacherA = as("teach-a", "teacher", A), pupilA1 = as("stu-a1", "student", A);
  const U = "/insights/student/st-a1/development-plans", ME = "/insights/student/me/development-plans";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. the routes: a review with a decision; an adaptation applied; the history kept ---");
  // ═══════════════════════════════════════════════════════════════════════════

  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 1" });
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { "submissions.0.score": 17 } });
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 2" });
  let rr = await teacherA.post(U, { guidanceId: `${Q}:MAINTAIN`, _id: "plan-1" });
  await teacherA.patch(`${U}/plan-1`, { action: "propose" }); await pupilA1.post(`${ME}/plan-1/accept`, {}); await teacherA.patch(`${U}/plan-1`, { action: "activate" });
  await pupilA1.post(`${ME}/plan-1/milestones/m1`, { action: "complete" });
  rr = await teacherA.get(`${U}/plan-1`);
  check("an active plan carries the system's reading: one earlier snapshot dated today counts as one independent observation, milestones in progress → CONTINUE", [rr.body.data.plan.systemReview.outcome, rr.body.data.plan.systemReview.contract.evidence.independentObservations], ["CONTINUE", 1]);
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { "submissions.0.score": 5 } });   // a correction: new boundary, a contradiction
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 3" });
  rr = await teacherA.get(`${U}/plan-1`);
  check("a new snapshot on a new boundary with contradicting work: the reading turns to ADAPT with the contradiction explained; the original rationale kept",
    [rr.body.data.plan.systemReview.outcome, rr.body.data.plan.systemReview.contract.evidence.independentObservations, rr.body.data.plan.systemReview.contradiction?.code ?? null, rr.body.data.plan.rationale.observed.state], ["ADAPT", 2, "NEW_EVIDENCE_CONFLICTS_WITH_RATIONALE", "ESTABLISHED"]);
  rr = await teacherA.post(`${U}/plan-1/review`, { teacherReview: { code: "OBSERVED_DIFFICULTY", note: "struggled with ratios" }, decision: "adapt", actionType: "DIFFERENT_PRACTICE" });
  const p1 = rr.body.data;
  check("the teacher reviews and decides to adapt with a chosen action: the review keeps the system outcome, the observation and the decision; the action is replaced, fresh milestones follow, ACTIVE again",
    [rr.status, p1.status, p1.reviews.length, p1.reviews[0].outcome, p1.reviews[0].decision, p1.reviews[0].teacherReview.code, p1.actions.map((a) => [a.actionType, Boolean(a.replacedAt)]), p1.milestones.length, p1.adaptations.length, p1.adaptations[0].reason.chosenWasSuggested],
    [200, "ACTIVE", 1, "ADAPT", "adapt", "OBSERVED_DIFFICULTY", [["MORE_PRACTICE", true], ["DIFFERENT_PRACTICE", false]], 6, 1, true]);
  check("the pupil sees the outcome and the adaptation but not the teacher's note; the review's boundaries are recorded for staff", [/struggled/.test(JSON.stringify((await pupilA1.get(`${ME}/plan-1`)).body.data.plan)), (await pupilA1.get(`${ME}/plan-1`)).body.data.plan.adaptations.length, typeof p1.reviews[0].evidenceBoundaryHash, typeof p1.reviews[0].developmentObservationBoundary], [false, 1, "string", "string"]);
  check("an unknown decision, an unknown teacher code and an unknown action are refused", [(await teacherA.post(`${U}/plan-1/review`, { decision: "escalate" })).status, (await teacherA.post(`${U}/plan-1/review`, { teacherReview: { code: "GREAT" }, decision: "continue" })).status, (await teacherA.post(`${U}/plan-1/review`, { decision: "adapt", actionType: "MAGIC" })).status], [400, 400, 400]);
  rr = await teacherA.post(`${U}/plan-1/review`, { decision: "pause" });
  check("a second review with the decision to pause: PAUSED, two reviews on record; the first is untouched", [rr.body.data.status, rr.body.data.reviews.length, rr.body.data.reviews[0].decision], ["PAUSED", 2, "adapt"]);
  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("live = offline: the plan's review through both roads is identical; the mismatch list is empty", [rr.body.data.plans.identical, rr.body.data.mismatches, rr.body.data.identical], [true, [], true]);
  const svc = require(path.join(SRC, "services/intelligence/developmentPlans.service"));
  const doc = await svc.oneFor({ schoolId: A, studentId: "st-a1", planId: "plan-1" });
  const at = new Date(ASOF);
  check("and directly: JSON-identical reviews from the live loader and the mirrored documents", JSON.stringify(await svc.systemReview({ doc, schoolId: A, studentId: "st-a1", asOf: at })) === JSON.stringify(await svc.offlineSystemReview({ doc, schoolId: A, studentId: "st-a1", asOf: at })), true);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
