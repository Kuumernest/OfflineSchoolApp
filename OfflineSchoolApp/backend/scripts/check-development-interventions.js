// backend/scripts/check-development-interventions.js
"use strict";

/**
 * Intervention Engine 1.0.0 — proposed from evidence, owned by a person,
 * run through a closed lifecycle, reviewed against observed change.
 *
 * (Named apart from check-interventions.js, which covers the Stage 4
 * intervention record and its routes, unchanged.)
 *
 * Triggers; no trigger from one weak observation; the proposal contract;
 * every lifecycle move and every invalid one; owner roles; evidence to
 * collect; outcome classification and insufficient evidence; historical
 * integrity — then the routes as every role: propose, accept, activate,
 * review, complete, decline, pause, cancel, idempotency, privacy, the
 * guardian's agreed support, live = offline, no new model.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-development-interventions.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
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
const iv = require(path.join(ROOT, "..", "shared", "interventions"));
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
const twoHw = [hw("h1", "2027-04-01", 16), hw("h2", "2027-04-15", 17)];
const weak = [hw("w1", "2027-04-01", 6), hw("w2", "2027-04-15", 7)];
const P = { EST: build(STRONG), EST_C: build(STRONG, { learningEvidence: learning({ homework: twoHw }) }), EST_X: build(STRONG, { learningEvidence: learning({ homework: weak }) }), DEC: build({ Mathematics: [17, 17, 16, 10, 9] }), DEC_L: build({ Mathematics: [17, 17, 16, 10, 9] }, { learningEvidence: learning({ homework: weak }) }) };
const DATES = ["2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15", "2027-05-15"];
const snap = (v, profile) => ({ _id: `snap-${v}`, profileVersion: v, asOf: DATES[v - 1], generatedAt: DATES[v - 1], periodLabel: `T${v}`, evidenceBoundary: { hash: `h${v}` }, academicEngineVersion: "1.0.0", strengthEngineVersion: "1.2.0", explorationEngineVersion: "1.0.0", learningIntegrationVersion: "1.0.0", learningEvidenceVersion: "1.0.0", profile: strengthsSvc.readingOf(profile) });
const hist = (profiles) => dev.buildDevelopmentHistory({ snapshots: profiles.map((p, i) => snap(i + 1, p)), asOf: ASOF });
const trig = (profiles) => { const h = hist(profiles); return iv.triggersFor({ development: h, guidance: guidance.buildGuidance({ development: h, asOf: ASOF }) }).map((t) => t.trigger); };

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. triggers: patterns, never one observation ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("one observation: no trigger, whatever it says", [trig([P.DEC]), trig([P.EST_X])], [[], []]);
  check("one decline after an established reading: still no trigger — one poor period is not a pattern", trig([P.EST, P.DEC]), []);
  check("declining in two consecutive observations: PERSISTENT_DECLINE — and, on a marks-only record three observations long, the two evidence-gap triggers", trig([P.EST, P.DEC, P.DEC]), ["EVIDENCE_COVERAGE_GAP", "INSUFFICIENT_EVIDENCE", "PERSISTENT_DECLINE"]);
  check("declining twice with learning evidence contradicting: the persistent contradiction, PERSISTENT_DECLINE, REPEATED_DIFFICULTY, and support signalled from two directions",
    trig([P.EST, P.DEC_L, P.DEC_L]), ["LEARNING_CONTRADICTION", "PERSISTENT_DECLINE", "REPEATED_DIFFICULTY", "REPEATED_SUPPORT_SIGNAL"]);
  check("one contradicting observation: no trigger; two consecutive: LEARNING_CONTRADICTION and REPEATED_DIFFICULTY", [trig([P.EST_C, P.EST_X]), trig([P.EST_C, P.EST_X, P.EST_X])], [[], ["LEARNING_CONTRADICTION", "REPEATED_DIFFICULTY"]]);
  check("a long-established strength (three observations) meets its first contradicted reading: ACADEMIC_LEARNING_MISMATCH; two observations are not enough", [trig([P.EST_C, P.EST_C, P.EST_X]), trig([P.EST_C, P.EST_X])], [["ACADEMIC_LEARNING_MISMATCH"], []]);
  check("marks only, across two observations: no gap trigger yet; across three: INSUFFICIENT_EVIDENCE and EVIDENCE_COVERAGE_GAP", [trig([P.EST, P.EST]), trig([P.EST, P.EST, P.EST])], [[], ["EVIDENCE_COVERAGE_GAP", "INSUFFICIENT_EVIDENCE"]]);
  check("every trigger the engine can emit is documented", trig([P.EST, P.DEC_L, P.DEC_L]).every((t) => iv.TRIGGERS.includes(t)), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the proposal contract and the lifecycle ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const prop = iv.buildIntervention({ trigger: "PERSISTENT_DECLINE", dimension: Q, startDate: ASOF, triggerEvidence: { consecutiveDeclining: 2 }, engineVersions: { development: "1.0.0", guidance: "1.0.0" } });
  check("a proposal has trigger, objective, action, owner, duration, evidence to collect, review point, outcome (null) — and starts PROPOSED",
    [prop.trigger, prop.objective, prop.action, prop.ownerRole, prop.durationDays, prop.evidenceToCollect, prop.reviewDate.slice(0, 10), prop.outcome, prop.lifecycle, prop.engineVersions],
    ["PERSISTENT_DECLINE", "STABILISE_AND_UNDERSTAND_THE_DECLINE", "WEEKLY_CHECK_IN_WITH_SUBJECT_TEACHER", "TEACHER", 42, ["ACADEMIC", "ASSIGNMENT", "TEACHER_OBSERVATION"], "2027-07-13", null, "PROPOSED", { intervention: "1.0.0", development: "1.0.0", guidance: "1.0.0" }]);
  check("it answers why, who, what for, what evidence, when reviewed", Object.keys(prop.explanation), ["why", "owner", "objective", "evidence", "review"]);
  check("owner roles are explicit and bounded; an unknown owner, trigger or action is refused; duration is clamped",
    [iv.OWNER_ROLES, (() => { try { iv.buildIntervention({ trigger: "PERSISTENT_DECLINE", dimension: Q, startDate: ASOF, ownerRole: "SYSTEM" }); } catch (e) { return e.code; } })(),
     (() => { try { iv.buildIntervention({ trigger: "MAGIC", dimension: Q, startDate: ASOF }); } catch (e) { return e.code; } })(), (() => { try { iv.buildIntervention({ trigger: "PERSISTENT_DECLINE", dimension: Q, startDate: ASOF, action: "SEND_TO_COUNSELLOR" }); } catch (e) { return e.code; } })(),
     iv.buildIntervention({ trigger: "PERSISTENT_DECLINE", dimension: Q, startDate: ASOF, durationDays: 999 }).durationDays],
    [["STUDENT", "TEACHER", "PARENT", "SCHOOL_ADMIN"], "INVALID_OWNER", "INVALID_TRIGGER", "INVALID_ACTION", 120]);
  const walk = (moves) => { let s = "PROPOSED"; const out = []; for (const [action, role] of moves) { s = iv.transition({ lifecycle: s, action, actorRole: role }).lifecycle; out.push(s); } return out; };
  check("the full lifecycle: accept (pupil) → activate → review (stays active) → mark review due → pause → resume → complete",
    walk([["accept", "STUDENT"], ["activate", "TEACHER"], ["review", "TEACHER"], ["mark_review_due", "TEACHER"], ["pause", "TEACHER"], ["resume", "TEACHER"], ["complete", "SCHOOL_ADMIN"]]),
    ["ACCEPTED", "ACTIVE", "ACTIVE", "REVIEW_DUE", "PAUSED", "ACTIVE", "COMPLETED"]);
  check("decline and cancel end it; the proposal is not an active intervention until a person activates it", [walk([["decline", "STUDENT"]]), walk([["accept", "TEACHER"], ["cancel", "TEACHER"]]), walk([["accept", "STUDENT"]])], [["DECLINED"], ["ACCEPTED", "CANCELLED"], ["ACCEPTED"]]);
  const bad = (lifecycle, action, actorRole) => { try { iv.transition({ lifecycle, action, actorRole }); return "allowed"; } catch (e) { return e.code; } };
  check("invalid moves fail deterministically: activate a proposal, complete a proposal, activate a paused one, anything from COMPLETED, accept a declined one, an unknown action",
    [bad("PROPOSED", "activate", "TEACHER"), bad("PROPOSED", "complete", "TEACHER"), bad("PAUSED", "activate", "TEACHER"), bad("COMPLETED", "pause", "TEACHER"), bad("DECLINED", "accept", "STUDENT"), bad("ACTIVE", "escalate", "TEACHER")],
    ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"]);
  check("roles: a pupil may accept or decline and nothing else; a parent likewise; staff do the rest", [bad("ACCEPTED", "activate", "STUDENT"), bad("ACTIVE", "complete", "PARENT"), bad("PROPOSED", "accept", "PARENT"), bad("ACTIVE", "cancel", "TEACHER")], ["ROLE_NOT_ALLOWED", "ROLE_NOT_ALLOWED", "allowed", "allowed"]);
  check("a replayed move is a no-op, not an error", iv.transition({ lifecycle: "ACCEPTED", action: "accept", actorRole: "STUDENT" }), { lifecycle: "ACCEPTED", changed: false });
  check("review due is a fact about a date, derived, never a decision", [iv.reviewDue({ lifecycle: "ACTIVE", reviewDate: "2027-07-13", asOf: "2027-07-13" }), iv.reviewDue({ lifecycle: "ACTIVE", reviewDate: "2027-07-13", asOf: "2027-07-12" }), iv.reviewDue({ lifecycle: "PAUSED", reviewDate: "2027-07-13", asOf: "2027-08-01" })], [true, false, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. outcome: observed change, never cause ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const o = (academic, before, after) => iv.interpretOutcome({ academicOutcome: academic ? { reading: academic, status: "compared" } : null, developmentBefore: before ? { state: before, observedAt: "a" } : null, developmentAfter: after ? { state: after, observedAt: "b" } : null });
  check("academic up and development up: IMPROVED; both flat: STABLE; both down: DECLINED", [o("INCREASED_AFTER", "DECLINING", "EMERGING").outcome, o("NO_CHANGE_OBSERVED", "EMERGING", "EMERGING").outcome, o("DECREASED_AFTER", "ESTABLISHED", "DECLINING").outcome], ["IMPROVED", "STABLE", "DECLINED"]);
  check("they disagree: MIXED; only one available: that one; neither: INSUFFICIENT_EVIDENCE", [o("DECREASED_AFTER", "EMERGING", "ESTABLISHED").outcome, o(null, "EMERGING", "ESTABLISHED").outcome, o("INCREASED_AFTER", null, null).outcome, o(null, null, null).outcome, o("AWAITING_POST_EVIDENCE", "EMERGING", null).outcome], ["MIXED", "IMPROVED", "IMPROVED", "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE"]);
  check("the statement is 'observed after the period', explicitly not causal; the categories are the five documented", [o("INCREASED_AFTER", null, null).statement, o("INCREASED_AFTER", null, null).causal, iv.OUTCOMES], [{ code: "OBSERVED_AFTER_PERIOD", outcome: "IMPROVED" }, false, ["IMPROVED", "STABLE", "DECLINED", "MIXED", "INSUFFICIENT_EVIDENCE"]]);
  const srcDir = path.join(ROOT, "..", "shared", "interventions");
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n").replace(/const FORBIDDEN_KEYS = [^\n]*\n/, "");
  check("no score, probability, ranking, best-intervention or success rate key in the engine; pure; name-free", [/\b(score|probability|ranking|bestIntervention|successRate|successProbability|careerFit|personality|interventionScore)\s*[:=(]/.test(src), /require\(["'](fs|http|https|mongoose|axios|crypto)["']\)/.test(src), /Date\.now\(\)|new Date\(\)/.test(src), /studentName|\bemail\b/.test(src)], [false, false, false, false]);
  check("the legacy status is derived from the lifecycle, so older readers keep working", [iv.LEGACY_STATUS.PROPOSED, iv.LEGACY_STATUS.ACTIVE, iv.LEGACY_STATUS.REVIEW_DUE, iv.LEGACY_STATUS.COMPLETED, iv.LEGACY_STATUS.DECLINED], ["planned", "active", "active", "completed", "cancelled"]);

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
  const A = "6a00000000000000000000a1", B = "6a00000000000000000000b2", YEAR = "2026-2027";
  await M("School").create([{ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" }, { _id: B, name: "Beta College", code: "BETA", email: "beta@example.test" }]);
  const mkUser = (id, role, schoolId, name) => M("User").create({ _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true });
  await Promise.all([mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("teach-c", "teacher", A, "Mme Chantal"), mkUser("admin-a", "school_admin", A, "Head Alpha"), mkUser("admin-b", "school_admin", B, "Head Beta"),
    mkUser("bursar-a", "bursar", A, "Bursar Alpha"), mkUser("operator", "super_admin", null, "Operator"), mkUser("stu-a1", "student", A, "Pupil A1"), mkUser("stu-a2", "student", A, "Pupil A2")]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" }]);
  await M("TeacherAssignment").create([{ schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }, { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" }]);
  const pupil = (id, classId, n) => ({ _id: id, userId: `stu-${id.slice(3)}`, schoolId: A, classId, studentName: `Pupil ${n}`, enrollmentNo: n, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", "form3a", "A1"), pupil("st-a2", "form4b", "A2")]);
  await M("Subject").create({ _id: "maths", schoolId: A, name: "Mathematics", code: "MAT", classId: "form3a" });
  const mkExam = (id, term, seq, startDate) => ({ _id: id, schoolId: A, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate, classId: "form3a", totalMarks: 20, passMark: 10, status: "published", resultsPublished: true });
  await M("Exam").create([mkExam("t1", 1, 1, "2027-01-10"), mkExam("t2", 1, 2, "2027-02-10"), mkExam("t3", 2, 1, "2027-03-10"), mkExam("t4", 2, 2, "2027-04-10")]);
  const row = (m) => ({ subjectId: "maths", subjectName: "Mathematics", normalizedMark: m, score: m, maxScore: 20, coefficient: 1, grade: null, points: 0, remark: null, isPassing: m >= 10, isAbsent: false, isExempt: false });
  const summary = (id, examId, term, m) => ({ _id: id, examId, studentId: "st-a1", classId: "form3a", schoolId: A, academicYear: YEAR, term: String(term), isPublished: true, percentage: 80, isPassing: true, subjectsFailed: 0, subjectBreakdown: [row(m)] });
  await M("ResultSummary").create([summary("rs1", "t1", 1, 16), summary("rs2", "t2", 1, 17), summary("rs3", "t3", 2, 16), summary("rs4", "t4", 2, 17)]);
  const gradedSub = (score, submittedAt) => ({ studentId: "st-a1", text: "done", submittedAt, score, gradedAt: submittedAt, gradedBy: "teach-a" });
  await M("Homework").create([
    { _id: "hw1", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Fractions", dueDate: "2027-04-01", maxScore: 20, isPublished: true, submissions: [gradedSub(6, "2027-04-01")] },
    { _id: "hw2", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Ratios", dueDate: "2027-04-08", maxScore: 20, isPublished: true, submissions: [gradedSub(7, "2027-04-10")] },
  ]);
  const access = await M("GuardianAccess").create({ schoolId: A, studentIds: ["st-a1"], codeHash: "x", label: "Parent", sessions: [{ _id: "s1", tokenHash: crypto.createHash("sha256").update("r").digest("hex"), createdAt: new Date(), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) }] });
  const portalToken = jwt.sign({ aud: "portal", accessId: String(access._id), schoolId: A, sid: "s1" }, process.env.JWT_SECRET, { expiresIn: "20m" });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const call = (token) => { const c = async (method, url, body) => { const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); let out = {}; try { out = await res.json(); } catch { /* empty */ } return { status: res.status, body: out }; }; return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b), patch: (u, b) => c("PATCH", u, b) }; };
  const as = (id, role, schoolId) => call(jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" }));
  const teacherA = as("teach-a", "teacher", A), teacherC = as("teach-c", "teacher", A), head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A), guardian = call(portalToken);
  const U = "/insights/student/st-a1/interventions";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. the routes: a history that supports a trigger, then the whole lifecycle ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.post(U, { trigger: "LEARNING_CONTRADICTION", dimension: Q });
  check("with no history, nothing can be proposed: 409 TRIGGER_NOT_SUPPORTED, the supported list empty", [rr.status, rr.body.code, rr.body.supported], [409, "TRIGGER_NOT_SUPPORTED", []]);
  // Two snapshots with the contradiction, from the same failing homework (the marks are established; the homework contradicts).
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 1" });
  await M("Homework").updateOne({ _id: "hw1" }, { $set: { "submissions.0.score": 5 } });          // a correction changes the boundary
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 2" });
  rr = await teacherA.get(U);
  check("the history now supports LEARNING_CONTRADICTION and REPEATED_DIFFICULTY; previews are proposals, not records; nothing exists yet",
    [rr.status, rr.body.data.triggers.map((t) => t.trigger), rr.body.data.previews.every((p) => p.lifecycle === "PROPOSED"), rr.body.data.interventions, rr.body.data.interventionEngineVersion], [200, ["LEARNING_CONTRADICTION", "REPEATED_DIFFICULTY"], true, [], "1.0.0"]);
  check("the bursar cannot propose; a teacher of another class cannot; Beta's head sees no such pupil; the operator needs a school",
    [(await bursar.post(U, { trigger: "LEARNING_CONTRADICTION", dimension: Q })).status, (await teacherC.post(U, { trigger: "LEARNING_CONTRADICTION", dimension: Q })).status, (await headB.post(U, { trigger: "LEARNING_CONTRADICTION", dimension: Q })).status, (await operator.post(U, { trigger: "LEARNING_CONTRADICTION", dimension: Q })).status !== 201],
    [403, 403, 404, true]);
  rr = await pupilA1.post("/insights/student/me/interventions", { trigger: "LEARNING_CONTRADICTION", dimension: Q });
  check("a pupil may propose only what they would own themselves: a teacher-owned trigger → 403", [rr.status, rr.body.code], [403, "ROLE_NOT_ALLOWED"]);
  rr = await teacherA.post(U, { _id: "iv-1", trigger: "LEARNING_CONTRADICTION", dimension: Q, notes: "teacher's private note" });
  const one = rr.body.data;
  check("the teacher proposes: 201, PROPOSED, owner TEACHER, objective and evidence from the taxonomy, a review date, the legacy status planned, versions recorded",
    [rr.status, one.lifecycle, one.ownerRole, one.objective, one.evidenceToCollect, typeof one.reviewDate, one.legacyStatus, one.engineVersions.intervention, one.notes], [201, "PROPOSED", "TEACHER", "EXAMINE_WHY_CLASS_AND_INDEPENDENT_WORK_DISAGREE", ["ASSIGNMENT", "QUIZ", "TEACHER_OBSERVATION"], "string", "planned", "1.0.0", "teacher's private note"]);
  rr = await teacherA.post(U, { _id: "iv-1", trigger: "LEARNING_CONTRADICTION", dimension: Q, notes: "resent" });
  check("a replayed POST with the same client id returns the same row and writes nothing", [rr.status, rr.body.created, rr.body.data.notes, await M("Intervention").countDocuments({ studentId: "st-a1" })], [201, false, "teacher's private note", 1]);
  rr = await pupilA1.get("/insights/student/me/interventions");
  check("the pupil sees the proposal made to them — without the teacher's note, the trigger evidence or any name", [rr.body.data.interventions.length, "notes" in rr.body.data.interventions[0], "triggerEvidence" in rr.body.data.interventions[0], /teacher's private note|Mme|teach-a/.test(JSON.stringify(rr.body.data.interventions))], [1, false, false, false]);
  rr = await pupilA1.patch("/insights/student/me/interventions/iv-1", { action: "activate" });
  check("the pupil cannot activate: 403 ROLE_NOT_ALLOWED", [rr.status, rr.body.code], [403, "ROLE_NOT_ALLOWED"]);
  rr = await pupilA1.patch("/insights/student/me/interventions/iv-1", { action: "accept" });
  check("the pupil accepts: ACCEPTED, recorded in the lifecycle history with the role; still not active", [rr.status, rr.body.changed, rr.body.data.lifecycle, rr.body.data.lifecycleHistory.map((h) => [h.to, h.role]), rr.body.data.legacyStatus], [200, true, "ACCEPTED", [["PROPOSED", "TEACHER"], ["ACCEPTED", "STUDENT"]], "planned"]);
  check("accepting again changes nothing", (await pupilA1.patch("/insights/student/me/interventions/iv-1", { action: "accept" })).body.changed, false);
  check("completing an accepted intervention is invalid: 409", [(await teacherA.patch(`${U}/iv-1`, { action: "complete" })).status, (await teacherA.patch(`${U}/iv-1`, { action: "complete" })).body.code], [409, "INVALID_TRANSITION"]);
  rr = await teacherA.patch(`${U}/iv-1`, { action: "activate" });
  check("the teacher activates: ACTIVE, legacy active, startedAt set", [rr.body.data.lifecycle, rr.body.data.legacyStatus, (await M("Intervention").findById("iv-1").lean()).startedAt !== undefined], ["ACTIVE", "active", true]);
  rr = await teacherA.get(`${U}/iv-1?asOf=2027-06-01`);
  check("the outcome so far: development before and after the start are the same reading → not enough evidence; not causal", [rr.status, rr.body.data.intervention.outcome.outcome, rr.body.data.intervention.outcome.causal, rr.body.data.intervention.outcome.statement.code], [200, "INSUFFICIENT_EVIDENCE", false, "OBSERVED_AFTER_PERIOD"]);
  rr = await pupilA1.post("/insights/student/me/interventions/iv-1/review", { note: "x" });
  check("a pupil cannot record a review", rr.status, 403);
  rr = await teacherA.post(`${U}/iv-1/review`, { note: "First review: agreed how independent work is done." });
  check("the teacher reviews: the outcome of the day is recorded with the note; the intervention stays ACTIVE", [rr.status, rr.body.data.lifecycle, rr.body.data.reviews.length, rr.body.data.reviews[0].outcome.outcome, rr.body.data.reviews[0].note], [200, "ACTIVE", 1, "INSUFFICIENT_EVIDENCE", "First review: agreed how independent work is done."]);
  rr = await teacherA.patch(`${U}/iv-1`, { action: "pause" });
  check("pause → PAUSED; resume → ACTIVE", [rr.body.data.lifecycle, (await teacherA.patch(`${U}/iv-1`, { action: "resume" })).body.data.lifecycle], ["PAUSED", "ACTIVE"]);
  rr = await head.post(`${U}/iv-1/review`, { note: "Closing.", complete: true });
  check("a completing review by the head: COMPLETED, legacy completed with an outcome code, two reviews on record", [rr.body.data.lifecycle, rr.body.data.legacyStatus, rr.body.data.reviews.length, (await M("Intervention").findById("iv-1").lean()).outcomeCode], ["COMPLETED", "completed", 2, "not_assessed"]);
  check("nothing moves from COMPLETED", (await teacherA.patch(`${U}/iv-1`, { action: "pause" })).status, 409);
  rr = await teacherA.post(U, { _id: "iv-2", trigger: "REPEATED_DIFFICULTY", dimension: Q });
  check("a second proposal, declined by the pupil: DECLINED, legacy cancelled, and it is not agreed support", [(await pupilA1.patch("/insights/student/me/interventions/iv-2", { action: "decline" })).body.data.lifecycle, (await M("Intervention").findById("iv-2").lean()).status], ["DECLINED", "cancelled"]);
  rr = await teacherA.post(U, { _id: "iv-3", trigger: "REPEATED_DIFFICULTY", dimension: Q });
  await teacherA.patch(`${U}/iv-3`, { action: "accept" }); await teacherA.patch(`${U}/iv-3`, { action: "activate" });
  check("cancel from ACTIVE: CANCELLED", (await teacherA.patch(`${U}/iv-3`, { action: "cancel" })).body.data.lifecycle, "CANCELLED");
  check("historical integrity: the snapshots are untouched by the interventions", await M("StrengthProfileSnapshot").countDocuments({ studentId: "st-a1" }), 2);
  check("authorisation on the reads: the pupil their own; another pupil, the bursar, a teacher of another class → 403; Beta's head → 404; the operator with a school",
    [(await pupilA2.get(U)).status, (await bursar.get(U)).status, (await teacherC.get(U)).status, (await headB.get(U)).status, (await operator.get(`${U}?schoolId=${A}`)).status, (await operator.get(U)).status !== 200], [403, 403, 403, 404, 200, true]);
  rr = await guardian.get("/portal/children/st-a1/guidance");
  check("the guardian sees agreed support only (the completed one; not the declined or cancelled), with owner, objective, review date and progress — no note, no reviewer",
    [rr.status, rr.body.data.agreedSupport.map((s) => [s.lifecycle, s.ownerRole, s.objective]), rr.body.data.agreedSupport[0].progress.outcome, /note|teach-a|Mme|by"/.test(JSON.stringify(rr.body.data.agreedSupport))],
    [200, [["COMPLETED", "TEACHER", "EXAMINE_WHY_CLASS_AND_INDEPENDENT_WORK_DISAGREE"]], "INSUFFICIENT_EVIDENCE", false]);
  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("live = offline: the intervention interpretation (triggers) is identical through both roads; the mismatch list is empty; the classes are named and false",
    [rr.body.data.interventions.identical, rr.body.data.mismatches, ["interventionTrigger", "interventionRule"].every((k) => rr.body.data.interventions.summary[k] === false), rr.body.data.identical], [true, [], true, true]);
  const feed = require(path.join(SRC, "config/syncFeed"));
  check("no new model: development interventions live in the existing Intervention collection, already in the feed", [mongoose.modelNames().filter((n) => /Intervention/.test(n)), feed.byCollection.has("intervention")], [["Intervention"], true]);
  check("the legacy intervention list still serves them (planned/active/completed/cancelled)", (await M("Intervention").find({ studentId: "st-a1" }).lean()).map((d) => d.status).sort(), ["cancelled", "cancelled", "completed"]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
