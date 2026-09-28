// backend/scripts/check-development-planning.js
"use strict";

/**
 * Development Planning Engine 1.0.0 — from guidance to a plan a pupil and a
 * teacher work on together.
 *
 * Eligibility (never from weak evidence); the plan contract (bounded
 * objective, observable milestones, the explanation); every lifecycle move
 * and every invalid one; roles; duplicate prevention; milestones (create,
 * complete, skip with a reason, block, unblock, roles, replay);
 * reconstruction as of a date; privacy and the forbidden vocabulary — then
 * the routes as every role: create, idempotent replay, propose, accept,
 * decline, activate, milestones, reflection, pause, resume, close, the
 * pupil's limited view, the guardian's view, historical replay, live =
 * offline.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-development-planning.js
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
const dp = require(path.join(ROOT, "..", "shared", "developmentPlanning"));
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
const P = { EST: build(STRONG), EST_C: build(STRONG, { learningEvidence: learning({ homework: [hw("h1", "2027-04-01", 16), hw("h2", "2027-04-15", 17)] }) }), INS: build({ Mathematics: [16] }, { exams: 1 }) };
const DATES = ["2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15"];
const snap = (v, p) => ({ profileVersion: v, asOf: DATES[v - 1], generatedAt: DATES[v - 1], periodLabel: `T${v}`, evidenceBoundary: { hash: `h${v}` }, academicEngineVersion: "1.0.0", strengthEngineVersion: "1.2.0", explorationEngineVersion: "1.0.0", learningIntegrationVersion: "1.0.0", learningEvidenceVersion: "1.0.0", profile: strengthsSvc.readingOf(p) });
const guideOf = (ps) => guidance.buildGuidance({ development: dev.buildDevelopmentHistory({ snapshots: ps.map((p, i) => snap(i + 1, p)), asOf: ASOF }), asOf: ASOF });
const item = (g, c) => g.items.find((i) => i.dimension === Q && i.category === c) ?? null;

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. eligibility: never from weak evidence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const gS = guideOf([P.EST, P.EST]), gI = guidance.buildGuidance({ development: dev.buildDevelopmentHistory({ snapshots: [], current: { profile: P.EST, asOf: ASOF, boundaryHash: "c" }, asOf: ASOF }), asOf: ASOF });
  check("versions: planning 1.0.0; the eight beneath unchanged", [dp.DEVELOPMENT_PLANNING_ENGINE_VERSION, strengths.STRENGTH_ENGINE_VERSION, dev.DEVELOPMENT_ENGINE_VERSION, guidance.GUIDANCE_ENGINE_VERSION], ["1.0.0", "1.2.0", "1.0.0", "1.0.0"]);
  check("MAINTAIN on a sufficient history opens STRENGTHEN_CONSISTENCY; MONITOR opens nothing", [dp.eligibility({ guidanceItem: item(gS, "MAINTAIN") }), dp.eligibility({ guidanceItem: { category: "MONITOR", explanation: { uncertain: { historySufficient: true } } } }).eligible], [{ eligible: true, reason: "HISTORY_SUFFICIENT", objectiveCategory: "STRENGTHEN_CONSISTENCY" }, false]);
  check("on one observation, MAINTAIN opens no plan (INSUFFICIENT_HISTORY) but BUILD_EVIDENCE opens an evidence-gap plan — that is what an insufficient history calls for",
    [dp.eligibility({ guidanceItem: item(gI, "MAINTAIN") }), dp.eligibility({ guidanceItem: item(gI, "BUILD_EVIDENCE") })], [{ eligible: false, reason: "INSUFFICIENT_HISTORY", objectiveCategory: "STRENGTHEN_CONSISTENCY" }, { eligible: true, reason: "EVIDENCE_GAP_OBJECTIVE", objectiveCategory: "RESOLVE_EVIDENCE_GAP" }]);
  check("every guidance category maps to a documented objective or to none; every objective is in the taxonomy", [Object.keys(dp.GUIDANCE_TO_OBJECTIVE).length, Object.values(dp.GUIDANCE_TO_OBJECTIVE).every((o) => o === null || dp.OBJECTIVE_CATEGORIES.includes(o)), Object.keys(dp.OBJECTIVES).length], [10, true, 10]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the plan contract ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const plan = dp.buildPlan({ guidanceItem: item(gS, "MAINTAIN"), startDate: "2027-02-20", evidenceBoundaryHash: "h2", engineVersions: { guidance: "1.0.0", development: "1.0.0" } });
  check("a plan: bounded objective, controlled actions, observable milestones, review schedule, owner, participation required, DRAFT, versions, boundary referenced (not copied)",
    [plan.objective.category, plan.objective.code, plan.actions.map((a) => a.actionType), plan.milestones.map((m) => [m.milestoneId, m.kind, m.owner, m.state]), plan.reviewSchedule.reviewDate.slice(0, 10), plan.ownerRole, plan.studentParticipation.required, plan.status, plan.engineVersions, plan.evidenceBoundaryHash, "evidence" in plan],
    ["STRENGTHEN_CONSISTENCY", "BUILD_CONSISTENCY_IN_COMPLETING_COURSEWORK", ["MORE_PRACTICE"], [["m1", "coursework_submitted", "STUDENT", "AVAILABLE"], ["m2", "coursework_submitted", "STUDENT", "PENDING"], ["m3", "teacher_observation_recorded", "TEACHER", "PENDING"]], "2027-04-03", "TEACHER", true, "DRAFT", { planning: "1.0.0", guidance: "1.0.0", development: "1.0.0" }, "h2", false]);
  check("the plan answers why, what evidence, which objective, what the pupil will do, which milestones, what evidence, when reviewed", Object.keys(plan.explanation), ["why", "evidence", "objective", "experience", "milestones", "evidenceToCollect", "review"]);
  check("objectives are evidence-oriented, never a future identity or a trait; milestones are observable events", [/become|engineer|career|top of the class|personality|confident|intelligent/i.test(JSON.stringify(dp.OBJECTIVES)), Object.values(dp.OBJECTIVES).every((o) => o.milestones.every(([k]) => dp.MILESTONE_KINDS.includes(k)))], [false, true]);
  check("an unknown action, an unknown owner and a missing start date are refused; review days are clamped",
    [(() => { try { dp.buildPlan({ guidanceItem: item(gS, "MAINTAIN"), startDate: ASOF, actions: ["MAGIC"] }); } catch (e) { return e.code; } })(), (() => { try { dp.buildPlan({ guidanceItem: item(gS, "MAINTAIN"), startDate: ASOF, ownerRole: "SYSTEM" }); } catch (e) { return e.code; } })(),
     (() => { try { dp.buildPlan({ guidanceItem: item(gS, "MAINTAIN") }); } catch (e) { return e.code; } })(), dp.buildPlan({ guidanceItem: item(gS, "MAINTAIN"), startDate: ASOF, reviewDays: 999 }).reviewSchedule.intervalDays],
    ["INVALID_ACTION", "INVALID_OWNER", "INVALID_PLAN", 120]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the lifecycle ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const walk = (moves) => { let s = "DRAFT"; const out = []; for (const [a, r] of moves) { s = dp.transition({ status: s, action: a, actorRole: r }).status; out.push(s); } return out; };
  check("propose → accept (pupil) → activate → review due → adapt → apply → pause (pupil) → resume → review due → complete",
    walk([["propose", "TEACHER"], ["accept", "STUDENT"], ["activate", "TEACHER"], ["mark_review_due", "TEACHER"], ["adapt", "TEACHER"], ["apply_adaptation", "TEACHER"], ["pause", "STUDENT"], ["resume", "STUDENT"], ["mark_review_due", "SCHOOL_ADMIN"], ["complete", "SCHOOL_ADMIN"]]),
    ["PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "ACTIVE", "PAUSED", "ACTIVE", "REVIEW_DUE", "COMPLETED"]);
  check("decline ends a proposal; close ends an accepted or active plan; the pupil's decline is a decision and nothing else", [walk([["propose", "TEACHER"], ["decline", "STUDENT"]]), walk([["propose", "TEACHER"], ["accept", "TEACHER"], ["close", "TEACHER"]]), /negative|trait|risk/i.test(JSON.stringify(dp.PLAN_TRANSITIONS))], [["PROPOSED", "DECLINED"], ["PROPOSED", "ACCEPTED", "CLOSED"], false]);
  const bad = (status, action, actorRole) => { try { dp.transition({ status, action, actorRole }); return "allowed"; } catch (e) { return e.code; } };
  check("invalid moves fail deterministically: activate a draft, complete an active plan, resume an accepted plan, anything from COMPLETED or DECLINED, an unknown action",
    [bad("DRAFT", "activate", "TEACHER"), bad("ACTIVE", "complete", "TEACHER"), bad("ACCEPTED", "resume", "TEACHER"), bad("COMPLETED", "pause", "TEACHER"), bad("DECLINED", "accept", "STUDENT"), bad("ACTIVE", "escalate", "TEACHER")],
    ["INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION", "INVALID_TRANSITION"]);
  check("roles: a pupil accepts, declines, pauses, resumes — never activates, reviews, completes or closes; a parent accepts or declines only",
    [bad("ACCEPTED", "activate", "STUDENT"), bad("ACTIVE", "mark_review_due", "STUDENT"), bad("REVIEW_DUE", "complete", "STUDENT"), bad("ACTIVE", "close", "STUDENT"), bad("PROPOSED", "accept", "PARENT"), bad("ACTIVE", "pause", "PARENT")],
    ["ROLE_NOT_ALLOWED", "ROLE_NOT_ALLOWED", "ROLE_NOT_ALLOWED", "ROLE_NOT_ALLOWED", "allowed", "ROLE_NOT_ALLOWED"]);
  check("a replayed move is a no-op", dp.transition({ status: "ACCEPTED", action: "accept", actorRole: "STUDENT" }), { status: "ACCEPTED", changed: false });
  const open = { status: "ACTIVE", dimension: Q, subjectId: null, objective: { category: "STRENGTHEN_CONSISTENCY" } }, closed = { ...open, status: "CLOSED" };
  check("duplicate prevention: an open plan for the same dimension and objective is found; a closed one is not; another objective is not",
    [dp.duplicateOf([open], { dimension: Q, subjectId: null, objectiveCategory: "STRENGTHEN_CONSISTENCY" }) === open, dp.duplicateOf([closed], { dimension: Q, subjectId: null, objectiveCategory: "STRENGTHEN_CONSISTENCY" }), dp.duplicateOf([open], { dimension: Q, subjectId: null, objectiveCategory: "EXPLORE" })], [true, null, null]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. milestones ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let ms = plan.milestones;
  ms = dp.milestoneTransition(ms, { milestoneId: "m1", action: "start", actorRole: "STUDENT", at: "2027-03-01", by: "S" }).milestones;
  ms = dp.milestoneTransition(ms, { milestoneId: "m1", action: "complete", actorRole: "STUDENT", at: "2027-03-02", by: "S" }).milestones;
  check("start then complete the first: COMPLETED, the second becomes AVAILABLE with an advance entry, the third stays PENDING; the history keeps who and when",
    [ms.map((m) => m.state), ms[1].history.map((h) => [h.action, h.role]), ms[0].history.map((h) => h.action)], [["COMPLETED", "AVAILABLE", "PENDING"], [["advance", "SYSTEM"]], ["start", "complete"]]);
  check("a skip needs a documented reason; with one it is recorded and the next opens; a skip is not a failure", [(() => { try { dp.milestoneTransition(ms, { milestoneId: "m2", action: "skip", actorRole: "STUDENT", reason: "BECAUSE" }); } catch (e) { return e.code; } })(),
    (() => { const r = dp.milestoneTransition(ms, { milestoneId: "m2", action: "skip", actorRole: "STUDENT", reason: "TIME_CONSTRAINT", at: "2027-03-03" }).milestones; return [r[1].state, r[1].reason, r[2].state]; })(), /fail/i.test(JSON.stringify(dp.MILESTONE_STATES))], ["INVALID_SKIP_REASON", ["SKIPPED", "TIME_CONSTRAINT", "AVAILABLE"], false]);
  const blocked = dp.milestoneTransition(ms, { milestoneId: "m2", action: "block", actorRole: "TEACHER", reason: "RESOURCE_UNAVAILABLE", at: "2027-03-03" }).milestones;
  check("block and unblock", [blocked[1].state, dp.milestoneTransition(blocked, { milestoneId: "m2", action: "unblock", actorRole: "TEACHER", at: "2027-03-04" }).milestones[1].state], ["BLOCKED", "AVAILABLE"]);
  check("a pupil cannot move a teacher's milestone; staff can move any; completing a completed one is a no-op; an unknown milestone is refused",
    [(() => { try { dp.milestoneTransition(ms, { milestoneId: "m3", action: "complete", actorRole: "STUDENT" }); } catch (e) { return e.code; } })(), dp.milestoneTransition(dp.milestoneTransition(ms, { milestoneId: "m2", action: "complete", actorRole: "TEACHER", at: "x" }).milestones, { milestoneId: "m3", action: "complete", actorRole: "SCHOOL_ADMIN", at: "y" }).milestones[2].state,
     dp.milestoneTransition(ms, { milestoneId: "m1", action: "complete", actorRole: "STUDENT" }).changed, (() => { try { dp.milestoneTransition(ms, { milestoneId: "zz", action: "complete", actorRole: "STUDENT" }); } catch (e) { return e.code; } })()],
    ["ROLE_NOT_ALLOWED", "COMPLETED", false, "MILESTONE_NOT_FOUND"]);
  check("progress is counts, never a percentage", [dp.progressOf(ms), /percent|%/.test(JSON.stringify(dp.progressOf(ms)))], [{ total: 3, completed: 1, skipped: 0, blocked: 0, started: 0, available: 1, pending: 1, next: ms[1] }, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. reconstruction as of a date; privacy; vocabulary ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const stored = { ...plan, _id: "p1", createdAt: "2027-02-20T00:00:00.000Z", milestones: ms, statusHistory: [{ from: null, to: "DRAFT", at: "2027-02-20T00:00:00.000Z" }, { from: "DRAFT", to: "PROPOSED", at: "2027-02-21T00:00:00.000Z" }, { from: "PROPOSED", to: "ACCEPTED", at: "2027-02-22T00:00:00.000Z" }, { from: "ACCEPTED", to: "ACTIVE", at: "2027-02-23T00:00:00.000Z" }],
    reviews: [{ reviewId: "r1", at: "2027-04-01T00:00:00.000Z" }], adaptations: [{ index: 1, at: "2027-04-01T00:00:00.000Z" }], reflections: [{ at: "2027-03-05T00:00:00.000Z", codes: ["USEFUL"] }], constraints: [] };
  const r1 = dp.reconstruct(stored, "2027-02-21T12:00:00Z"), r2 = dp.reconstruct(stored, "2027-03-01T12:00:00Z"), r3 = dp.reconstruct(stored, "2027-05-01T00:00:00Z");
  check("as of 21 Feb: PROPOSED, the first milestone available, nothing else; as of 1 Mar: ACTIVE, m1 started; as of May: complete history",
    [[r1.status, r1.milestones.map((m) => m.state), r1.reflections.length, r1.reviews.length], [r2.status, r2.milestones.map((m) => m.state), r2.reflections.length], [r3.status, r3.milestones.map((m) => m.state), r3.reflections.length, r3.reviews.length, r3.adaptations.length]],
    [["PROPOSED", ["AVAILABLE", "PENDING", "PENDING"], 0, 0], ["ACTIVE", ["STARTED", "PENDING", "PENDING"], 0], ["ACTIVE", ["COMPLETED", "AVAILABLE", "PENDING"], 1, 1, 1]]);
  check("a plan did not exist before it was created; the same asOf twice is byte-identical", [dp.reconstruct(stored, "2027-02-19"), JSON.stringify(dp.reconstruct(stored, "2027-03-01")) === JSON.stringify(dp.reconstruct(stored, "2027-03-01"))], [null, true]);
  const srcDir = path.join(ROOT, "..", "shared", "developmentPlanning");
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n").replace(/const FORBIDDEN_KEYS = [^\n]*\n/, "");
  const strip = (o) => JSON.stringify(o).replace(/"notInferred":\[[^\]]*\]/g, "");
  check("no plan score, goal score, risk, probability, readiness or aptitude key in the engine; pure; name-free; none in a plan",
    [/\b(planScore|goalScore|riskScore|successProbability|completionProbability|aptitudeScore|readinessScore|score|probability|ranking)\s*[:=(]/.test(src), /require\(["'](fs|http|https|mongoose|axios|crypto)["']\)/.test(src), /Date\.now\(\)|new Date\(\)/.test(src), /studentName|\bemail\b/.test(src), /score|probability|career|personality|readiness/i.test(strip(plan))],
    [false, false, false, false, false]);
  check("constraints are explicit operational facts; no socioeconomic term in any vocabulary a plan carries", [dp.CONSTRAINTS.length, /income|poverty|wealth|socio/i.test(JSON.stringify([dp.CONSTRAINTS, dp.OBJECTIVES, dp.REFLECTION_CODES, dp.SKIP_REASONS, dp.ACTION_TYPES, dp.MILESTONE_KINDS]))], [7, false]);

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
    { _id: "hw1", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Fractions", dueDate: "2027-04-01", maxScore: 20, isPublished: true, submissions: [gradedSub(16, "2027-04-01")] },
    { _id: "hw2", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Ratios", dueDate: "2027-04-08", maxScore: 20, isPublished: true, submissions: [gradedSub(18, "2027-04-10")] },
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
  const teacherA = as("teach-a", "teacher", A), teacherC = as("teach-c", "teacher", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A), guardian = call(portalToken);
  const U = "/insights/student/st-a1/development-plans", ME = "/insights/student/me/development-plans";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. the routes: from guidance to a plan, through the lifecycle ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.post(U, { guidanceId: `${Q}:MAINTAIN` });
  check("on one observation, MAINTAIN opens no plan: 409 PLAN_NOT_ELIGIBLE with the reason", [rr.status, rr.body.code, rr.body.reason], [409, "PLAN_NOT_ELIGIBLE", "INSUFFICIENT_HISTORY"]);
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 1" });
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { "submissions.0.score": 17 } });
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 2" });
  rr = await teacherA.post(U, { guidanceId: `${Q}:MAINTAIN`, _id: "plan-1" });
  const created = rr.body.data;
  check("two snapshots later the teacher creates a plan from MAINTAIN: 201, DRAFT, STRENGTHEN_CONSISTENCY, three milestones, the evidence boundary referenced, versions",
    [rr.status, rr.body.created, created.status, created.objective.category, created.milestones.map((m) => m.state), typeof created.evidenceBoundaryHash, created.engineVersions.planning, created.engineVersions.adaptive], [201, true, "DRAFT", "STRENGTHEN_CONSISTENCY", ["AVAILABLE", "PENDING", "PENDING"], "string", "1.0.0", "1.0.0"]);
  check("a replayed POST with the same client id returns the same row; a second plan for the same objective is a duplicate (409) naming the existing one",
    [(await teacherA.post(U, { guidanceId: `${Q}:MAINTAIN`, _id: "plan-1" })).body.created, (await teacherA.post(U, { guidanceId: `${Q}:MAINTAIN` })).status, (await teacherA.post(U, { guidanceId: `${Q}:MAINTAIN` })).body.existingPlanId, await M("DevelopmentPlan").countDocuments({ studentId: "st-a1" })], [false, 409, "plan-1", 1]);
  check("a pupil may create only a plan they own: a teacher-owned objective → 403", [(await pupilA1.post(ME, { guidanceId: `${Q}:MAINTAIN` })).status, (await pupilA1.post(ME, { guidanceId: `${Q}:MAINTAIN` })).body.code], [403, "ROLE_NOT_ALLOWED"]);
  check("the bursar cannot create; a teacher of another class cannot; Beta's head finds no pupil; the operator needs a school",
    [(await bursar.post(U, { guidanceId: `${Q}:MAINTAIN` })).status, (await teacherC.post(U, { guidanceId: `${Q}:MAINTAIN` })).status, (await headB.post(U, { guidanceId: `${Q}:MAINTAIN` })).status, (await operator.post(U, { guidanceId: `${Q}:MAINTAIN` })).status !== 201], [403, 403, 404, true]);
  rr = await teacherA.patch(`${U}/plan-1`, { action: "propose" });
  check("propose → PROPOSED; the pupil sees it, without any staff note or actor id", [rr.body.data.status, (await pupilA1.get(ME)).body.data.plans[0].status, /"by"|"note"|teach-a|Mme/.test(JSON.stringify((await pupilA1.get(ME)).body.data.plans))], ["PROPOSED", "PROPOSED", false]);
  check("the pupil cannot activate (403); the pupil accepts (ACCEPTED, participation recorded); accepting again changes nothing",
    [(await pupilA1.patch(`${ME}/plan-1`, { action: "activate" })).status, (await pupilA1.post(`${ME}/plan-1/accept`, {})).body.data.status, typeof (await pupilA1.get(`${ME}/plan-1`)).body.data.plan.studentParticipation.acceptedAt, (await pupilA1.post(`${ME}/plan-1/accept`, {})).body.changed], [403, "ACCEPTED", "string", false]);
  rr = await teacherA.patch(`${U}/plan-1`, { action: "activate" });
  const tActive = new Date().toISOString();
  await sleep(20);
  check("the teacher activates: ACTIVE; a system reading is attached to an active plan", [rr.body.data.status, (await teacherA.get(`${U}/plan-1`)).body.data.plan.systemReview?.outcome ?? null], ["ACTIVE", "CONTINUE"]);
  rr = await pupilA1.post(`${ME}/plan-1/milestones/m1`, { action: "complete" });
  check("the pupil completes the first milestone (a student milestone): COMPLETED, the second available; a teacher milestone is refused to the pupil",
    [rr.status, rr.body.data.milestones.map((m) => m.state), (await pupilA1.post(`${ME}/plan-1/milestones/m3`, { action: "complete" })).status], [200, ["COMPLETED", "AVAILABLE", "PENDING"], 403]);
  check("a skip needs a documented reason: 409 without, SKIPPED with, the third available", [(await pupilA1.post(`${ME}/plan-1/milestones/m2`, { action: "skip" })).status, (await pupilA1.post(`${ME}/plan-1/milestones/m2`, { action: "skip", reason: "TIME_CONSTRAINT" })).body.data.milestones.map((m) => [m.state, m.reason])], [409, [["COMPLETED", null], ["SKIPPED", "TIME_CONSTRAINT"], ["AVAILABLE", null]]]);
  rr = await pupilA1.post(`${ME}/plan-1/reflect`, { codes: ["USEFUL", "TOO_EASY"], note: "I liked it" });
  check("the pupil reflects with controlled codes: 201, one reflection; an unknown code is refused; a teacher cannot reflect for the pupil",
    [rr.status, rr.body.data.reflections.length, rr.body.data.studentParticipation.reflections, (await pupilA1.post(`${ME}/plan-1/reflect`, { codes: ["BRILLIANT"] })).status, (await teacherA.post(`${U}/plan-1/reflect`, { codes: ["USEFUL"] })).status], [201, 1, 1, 400, 403]);
  rr = await teacherA.get(`${U}/plan-1?asOf=${tActive}`);
  check("historical replay: as of the moment of activation, the milestones were untouched and there was no reflection; the same asOf twice is identical; before creation → 404",
    [rr.body.data.plan.milestones.map((m) => m.state), rr.body.data.plan.reflections.length, rr.body.data.plan.status, JSON.stringify((await teacherA.get(`${U}/plan-1?asOf=${tActive}`)).body.data.plan) === JSON.stringify(rr.body.data.plan), (await teacherA.get(`${U}/plan-1?asOf=2020-01-01`)).status],
    [["AVAILABLE", "PENDING", "PENDING"], 0, "ACTIVE", true, 404]);
  check("the pupil pauses (PAUSED) and the teacher resumes (ACTIVE); the pupil cannot close", [(await pupilA1.post(`${ME}/plan-1/pause`, {})).body.data.status, (await teacherA.patch(`${U}/plan-1`, { action: "resume" })).body.data.status, (await pupilA1.patch(`${ME}/plan-1`, { action: "close" })).status], ["PAUSED", "ACTIVE", 403]);
  rr = await teacherA.post(`${U}/plan-1/review`, { teacherReview: { code: "OBSERVED_STABILITY", note: "steady" }, decision: "continue" });
  check("a review by the teacher: the system reading recorded beside the observation and the decision; the plan continues ACTIVE; the pupil sees the outcome and not the note",
    [rr.status, rr.body.data.status, rr.body.data.reviews.length, rr.body.data.reviews[0].decision, rr.body.data.reviews[0].teacherReview.code, typeof rr.body.data.reviews[0].outcome, /steady/.test(JSON.stringify((await pupilA1.get(`${ME}/plan-1`)).body.data.plan))], [200, "ACTIVE", 1, "continue", "OBSERVED_STABILITY", "string", false]);
  check("a pupil cannot review", (await pupilA1.post(`${ME}/plan-1/review`, { decision: "continue" })).status, 403);
  rr = await teacherA.post(`${U}/plan-1/constraints`, { code: "NO_DEVICE", note: "no laptop at home this term" });
  check("a documented constraint is recorded as an explicit fact; the pupil sees the code, never the note; an unknown constraint is refused", [rr.status, (await pupilA1.get(`${ME}/plan-1`)).body.data.plan.constraints.map((c) => c.code), /laptop/.test(JSON.stringify((await pupilA1.get(`${ME}/plan-1`)).body.data.plan)), (await teacherA.post(`${U}/plan-1/constraints`, { code: "POOR" })).status], [201, ["NO_DEVICE"], false, 400]);
  rr = await teacherA.post(U, { guidanceId: `${Q}:BUILD_EVIDENCE`, _id: "plan-2" });
  await teacherA.patch(`${U}/plan-2`, { action: "propose" });
  rr = await pupilA1.post(`${ME}/plan-2/decline`, {});
  check("a second plan (another objective) proposed and declined by the pupil: DECLINED, recorded as a decision, and nothing about the pupil", [rr.body.data.status, rr.body.data.statusHistory.slice(-1)[0].role, /negative|trait|risk/i.test(JSON.stringify(rr.body.data))], ["DECLINED", "STUDENT", false]);
  check("after a decline, a new plan for that objective is allowed (the declined one is not open)", (await teacherA.post(U, { guidanceId: `${Q}:BUILD_EVIDENCE`, _id: "plan-3" })).status, 201);
  check("close from ACTIVE: CLOSED; nothing moves afterwards", [(await teacherA.patch(`${U}/plan-1`, { action: "close" })).body.data.status, (await teacherA.patch(`${U}/plan-1`, { action: "resume" })).status], ["CLOSED", 409]);
  check("authorisation on the reads: the pupil their own; another pupil, the bursar, a teacher of another class → 403; Beta's head → 404; the operator with a school",
    [(await pupilA2.get(U)).status, (await bursar.get(U)).status, (await teacherC.get(U)).status, (await headB.get(U)).status, (await operator.get(`${U}?schoolId=${A}`)).status, (await operator.get(U)).status !== 200], [403, 403, 403, 404, 200, true]);
  rr = await guardian.get("/portal/children/st-a1/development-plans");
  check("the guardian: objective, how the pupil is supported, completed milestones, upcoming support, review status — no reflection, no note, no reason code",
    [rr.status, rr.body.data.plans.map((p) => [p.status, p.objective.category, p.completedMilestones.length]), Object.keys(rr.body.data.plans[0]), /reflection|note|reasons|liked it|laptop/.test(JSON.stringify(rr.body.data))],
    [200, [["CLOSED", "STRENGTHEN_CONSISTENCY", 1], ["DRAFT", "RESOLVE_EVIDENCE_GAP", 0]].filter((x) => x[0] !== "DRAFT"), ["planId", "dimension", "subjectId", "objective", "status", "supportedBy", "completedMilestones", "upcoming", "review"], false]);
  check("a child the access does not unlock → 404", (await guardian.get("/portal/children/st-a2/development-plans")).status, 404);
  check("historical integrity: the snapshots are untouched by the plans", await M("StrengthProfileSnapshot").countDocuments({ studentId: "st-a1" }), 2);
  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("live = offline: every plan's review is identical through both roads; the plan classes are named and false; the mismatch list is empty",
    [rr.status, rr.body.data.plans.identical, rr.body.data.plans.count, ["planState", "planObjective", "planMilestone", "planEvidenceBoundary", "planReview", "planAdaptation", "planVersion"].every((k) => rr.body.data.plans.summary[k] === false), rr.body.data.mismatches, rr.body.data.identical], [200, true, 3, true, [], true]);
  const feed = require(path.join(SRC, "config/syncFeed"));
  check("the plan collection is registered as read-online with a reason, never mirrored", typeof feed.EXCLUDED.DevelopmentPlan, "string");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
