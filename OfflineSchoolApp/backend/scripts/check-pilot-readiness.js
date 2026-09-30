// backend/scripts/check-pilot-readiness.js
"use strict";

/**
 * Is the application ready to run a controlled pilot without a developer?
 *
 * ── What is being proved ──────────────────────────────────────────────────
 *
 *   1. The pilot state machine: every legal move, every illegal one, and that
 *      CALIBRATED cannot be reached by clicking — it needs the server's own
 *      evidence snapshot to clear the gate and a written decision.
 *   2. The record captures the engine version and the school scope, and
 *      carries no salt, no credential, no pupil, no mark, no reviewer's words.
 *   3. Who may open, advance, read and conclude a pilot follows the one
 *      hierarchy: teacher (read, lean), head (everything, own school), operator
 *      (everything, selected school), bursar (nothing).
 *   4. Reviewer independence survives inside a pilot exactly as outside one.
 *   5. Live == offline: one pupil through /insights and through the exporter's
 *      mapping and the calibration runner gives the same engine version,
 *      classification, confidence, metrics, evidence and guidance — and the
 *      comparison reports a planted difference rather than smoothing it over.
 *
 * ── What is NOT being proved ──────────────────────────────────────────────
 *
 * Anything about the engine, and anything about a real school. The pilot
 * opened here is of kind "development"; the two teachers are fixtures; the
 * decision recorded is INSUFFICIENT_EVIDENCE, which is what two reviews of one
 * case deserve. Nothing in this file is validation.
 *
 *   node scripts/check-pilot-readiness.js
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

const A = "6a00000000000000000000a1";
const B = "6a00000000000000000000b2";
const YEAR = "2026-2027";
const row = (subjectId, subjectName, normalizedMark, extra = {}) => ({
  subjectId, subjectName, normalizedMark, score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null, isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false, ...extra,
});

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the state machine, on its own ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const pilots = require(path.join(SRC, "services/intelligence/pilot.service"));
  const { compareProfiles, diff } = require(path.join(ROOT, "scripts/calibration/consistency"));

  check("seven states, in the order the brief names them",
    pilots.STATES, ["READY", "ACTIVE", "REVIEWING", "ANALYSIS_READY", "CALIBRATED", "INSUFFICIENT_EVIDENCE", "CLOSED"]);
  check("the happy path is legal, one step at a time",
    ["READY→ACTIVE", "ACTIVE→REVIEWING", "REVIEWING→ANALYSIS_READY", "ANALYSIS_READY→CALIBRATED",
     "ANALYSIS_READY→INSUFFICIENT_EVIDENCE", "CALIBRATED→CLOSED", "INSUFFICIENT_EVIDENCE→CLOSED"]
      .every((s) => pilots.canTransition(...s.split("→"))), true);
  check("every state may close", pilots.STATES.filter((s) => s !== "CLOSED").every((s) => pilots.canTransition(s, "CLOSED")), true);
  check("no skipping, no going back, nothing after CLOSED",
    ["READY→REVIEWING", "READY→CALIBRATED", "ACTIVE→CALIBRATED", "REVIEWING→CALIBRATED", "ACTIVE→READY",
     "CALIBRATED→ANALYSIS_READY", "CLOSED→READY", "CLOSED→ACTIVE", "INSUFFICIENT_EVIDENCE→CALIBRATED"]
      .some((s) => pilots.canTransition(...s.split("→"))), false);
  check("the minimum evidence gate is built from the existing minimums plus two reviewers",
    pilots.MINIMUM_EVIDENCE, { reviewers: 2, casesReviewed: 30, casesWithMultipleReviews: 3 });
  check("and names each shortfall with the number",
    pilots.evidenceShortfalls({ reviewers: 2, casesReviewed: 4, casesWithMultipleReviews: 1 }),
    [{ requirement: "casesReviewed", minimum: 30, actual: 4 }, { requirement: "casesWithMultipleReviews", minimum: 3, actual: 1 }]);
  check("the comparison reports a planted difference, path and both values",
    diff({ a: { code: "x", confidence: "strong" } }, { a: { code: "x", confidence: "emerging" } }),
    [{ path: "$.a.confidence", live: "strong", offline: "emerging" }]);
  check("and a null against an undefined is a difference, not a normalisation",
    diff({ v: null }, {}), [{ path: "$.v", live: null, offline: undefined }]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Fixture: one school, two teachers on one class, a pupil with a decline.
  // ═══════════════════════════════════════════════════════════════════════════

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await M("IntelligencePilot").syncIndexes();
  await M("IntelligenceReview").syncIndexes();

  await M("School").create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId, name) => M("User").create({
    _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("teach-b", "teacher", A, "M. Biya"),
    mkUser("admin-a", "school_admin", A, "Head Alpha"), mkUser("admin-b", "school_admin", B, "Head Beta"),
    mkUser("bursar-a", "bursar", A, "Bursar Alpha"), mkUser("operator", "super_admin", null, "Platform Operator"),
  ]);
  await M("Class").create([
    { _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await M("TeacherAssignment").create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
    { schoolId: A, teacher: "teach-b", class: "form3a", subject: "ict" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`, enrollmentNo: `${n}`, isActive: true, status: "approved",
  });
  await M("Student").create([pupil("st-a1", A, "form3a", "A1"), pupil("st-a2", A, "form4b", "A2"), pupil("st-b1", B, "form1b", "B1")]);
  const mkExam = (id, schoolId, classId, term, seq, startDate) => ({
    _id: id, schoolId, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate,
    classId, totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
  });
  await M("Exam").create([
    mkExam("ax1", A, "form3a", 1, 1, "2026-10-05"), mkExam("ax2", A, "form3a", 1, 2, "2026-11-20"), mkExam("ax3", A, "form3a", 2, 1, "2027-02-10"),
  ]);
  const summary = (id, examId, studentId, classId, schoolId, term, rows) => ({
    _id: id, examId, studentId, classId, schoolId, academicYear: YEAR, term: String(term),
    isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows,
  });
  await M("ResultSummary").create([
    summary("s1", "ax1", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 16), row("ict", "ICT", 16)]),
    summary("s2", "ax2", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 15), row("ict", "ICT", 17)]),
    summary("s3", "ax3", "st-a1", "form3a", A, 2, [row("maths", "Mathematics", 9),  row("ict", "ICT", 17)]),
    summary("s4", "ax1", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 8)]),
    summary("s5", "ax2", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 7)]),
    summary("s6", "ax3", "st-a2", "form4b", A, 2, [row("maths", "Mathematics", 6)]),
  ]);
  await M("Intervention").create({ _id: "iv-a1", schoolId: A, studentId: "st-a1", classId: "form3a", createdBy: "teach-a", updatedBy: "teach-a",
    actionCode: "TARGETED_PRACTICE", subjectId: "maths", status: "active", startedAt: new Date("2027-01-15") });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights",    auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let out = {}; try { out = await res.json(); } catch { /* empty */ }
      return { status: res.status, body: out };
    };
    return { get: (u) => call("GET", u), post: (u, b) => call("POST", u, b), patch: (u, b) => call("PATCH", u, b) };
  };
  const teacherA = as("teach-a", "teacher", A), teacherB = as("teach-b", "teacher", A);
  const head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. opening a pilot: who, and what the record captures ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a teacher cannot open one → 403", (await teacherA.post("/insights/pilot", { kind: "development" })).status, 403);
  check("nor the bursar", (await bursar.post("/insights/pilot", { kind: "development" })).status, 403);
  check("an unknown kind → 400 INVALID_PILOT_KIND",
    (await head.post("/insights/pilot", { kind: "production" })).body.code, "INVALID_PILOT_KIND");
  check("a class outside the school → 404 CLASS_NOT_FOUND",
    (await head.post("/insights/pilot", { kind: "development", classIds: ["form1b"] })).body.code, "CLASS_NOT_FOUND");

  let r = await head.post("/insights/pilot", { kind: "development", classIds: ["form3a"], label: "Form 3A, first try", engineVersion: "9.9.9" });
  let pilot = r.body.data;
  check("the head opens one → 201 READY, kind and scope captured, the SERVER's engine version",
    [r.status, pilot.status, pilot.kind, pilot.schoolId, pilot.classIds, pilot.engineVersion, pilot.createdBy],
    [201, "READY", "development", A, ["form3a"], "1.0.0", "admin-a"]);
  check("the opening is the first entry on the trail", pilot.transitions.map((t) => [t.from, t.to, t.by]), [[null, "READY", "admin-a"]]);
  check("the record says what it may do next", pilot.allowedTransitions, ["ACTIVE", "CLOSED"]);
  check("a second open pilot at the same school → 409 PILOT_OPEN",
    (await head.post("/insights/pilot", { kind: "real" })).body.code, "PILOT_OPEN");
  check("Beta's head has no pilot and cannot see Alpha's",
    [(await headB.get("/insights/pilot")).body.data.pilot, (await headB.patch(`/insights/pilot/${pilot.pilotRunId}`, { to: "ACTIVE" })).status], [null, 404]);
  check("the operator sees it having selected Alpha, and nothing without a selection",
    [(await operator.get(inA("/insights/pilot"))).body.data.pilot?.pilotRunId === pilot.pilotRunId, (await operator.get("/insights/pilot")).status], [true, 400]);
  r = await teacherA.get("/insights/pilot");
  check("a teacher sees that a pilot is on, its kind and state — and not the evidence or the trail",
    [r.status, r.body.data.pilot.status, r.body.data.pilot.kind, "evidence" in r.body.data.pilot, "transitions" in r.body.data.pilot],
    [200, "READY", "development", false, false]);
  check("the bursar sees nothing", (await bursar.get("/insights/pilot")).status, 403);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. advancing it: legal moves, illegal moves, the gate ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const move = (who, to, extra = {}) => who.patch(`/insights/pilot/${pilot.pilotRunId}`, { to, ...extra });
  r = await move(head, "CALIBRATED", { decision: { outcome: "KEEP", summary: "Everything is fine, let us call it calibrated." } });
  check("READY → CALIBRATED is refused with the moves that were allowed",
    [r.status, r.body.code, r.body.allowed], [409, "INVALID_TRANSITION", ["ACTIVE", "CLOSED"]]);
  check("a teacher cannot advance it", (await move(teacherA, "ACTIVE")).status, 403);
  r = await move(head, "ACTIVE", { version: 1, note: "Teachers briefed on Monday" });
  pilot = r.body.data;
  check("READY → ACTIVE: started, version bumped, note on the trail",
    [r.status, pilot.status, pilot.startedAt !== null, pilot.version, pilot.transitions.at(-1).note], [200, "ACTIVE", true, 2, "Teachers briefed on Monday"]);
  check("a stale version → 409 VERSION_CONFLICT", (await move(head, "REVIEWING", { version: 1 })).body.code, "VERSION_CONFLICT");
  check("ACTIVE → ANALYSIS_READY skips a state → 409", (await move(head, "ANALYSIS_READY")).body.code, "INVALID_TRANSITION");
  r = await move(operator, "REVIEWING", { schoolId: A });
  check("the operator, having selected the school, moves it to REVIEWING", [r.status, r.body.data.status, r.body.data.transitions.at(-1).by], [200, "REVIEWING", "operator"]);
  r = await move(head, "ANALYSIS_READY");
  check("with no reviews recorded, ANALYSIS_READY is refused — nothing to analyse",
    [r.status, r.body.code], [409, "EVIDENCE_REQUIRED"]);

  // The two teachers review, independently, inside the pilot.
  const sheet = (await teacherA.get("/insights/review-cases")).body.data;
  const decline = sheet.cases.find((c) => c.category === "declining" && c.subjectId === "maths");
  const formA = { observedPattern: "YES", classificationAppropriate: "PARTIALLY", evidenceSufficient: "YES", guidanceAppropriate: "YES",
    reason: "Real fall, hard paper", dataQuality: ["assessment_unusually_difficult"], temporal: { interpretationReasonable: "UNCERTAIN", possibleExplanation: "assessment_difficulty" } };
  const formB = { observedPattern: "NO", classificationAppropriate: "NO", evidenceSufficient: "NO", guidanceAppropriate: "UNCERTAIN", reason: "One mark", dataQuality: [] };
  const body = (form) => ({ studentId: "st-a1", subjectId: "maths", category: "declining", engineVersion: sheet.engineVersion, review: form });
  check("teacher A submits → 201", (await teacherA.post("/insights/reviews", body(formA))).status, 201);
  let bView = (await teacherB.get("/insights/review-cases")).body.data.cases.find((c) => c.caseId === decline.caseId);
  check("teacher B, inside the pilot, still sees a count and no answer",
    [bView.reviewCount, bView.reviews, bView.othersHidden, bView.agreement], [1, [], true, null]);
  check("teacher B submits independently → 201", (await teacherB.post("/insights/reviews", body(formB))).status, 201);
  bView = (await teacherB.get("/insights/review-cases")).body.data.cases.find((c) => c.caseId === decline.caseId);
  check("and now both are there, distinct, named, differing",
    [bView.reviews.map((v) => [v.reviewedByName, v.review.classificationAppropriate]).sort(), bView.agreement],
    [[["M. Biya", "NO"], ["Mme Ateba", "PARTIALLY"]], "DIFFER"]);

  r = await head.get("/insights/pilot/evidence");
  check("the live evidence read shows the shortfalls before anyone commits to a decision",
    [r.status, r.body.data.evidence.reviewers, r.body.data.shortfalls.map((s) => s.requirement)],
    [200, 2, ["casesReviewed", "casesWithMultipleReviews"]]);

  r = await move(head, "ANALYSIS_READY");
  pilot = r.body.data;
  check("REVIEWING → ANALYSIS_READY takes the evidence snapshot from the persisted reviews",
    [r.status, pilot.evidence.casesReviewed, pilot.evidence.casesWithMultipleReviews, pilot.evidence.reviewers, pilot.evidence.studentsReviewed,
     pilot.evidence.reviewsRecorded, pilot.evidence.categories, pilot.evidence.subjects, pilot.evidence.temporalPatterns],
    [200, 1, 1, 2, 1, 2, ["declining"], ["Mathematics"], ["academic_decline", "sudden_performance_change"]]);
  check("it counts cases selected and awaiting, and the data problems cited",
    [pilot.evidence.casesSelected > 1, pilot.evidence.casesAwaitingReview, pilot.evidence.dataQualityCitations],
    [true, pilot.evidence.casesSelected - 1, { assessment_unusually_difficult: 1 }]);
  check("and it is counts — no pupil, no mark, no reviewer's words",
    /st-a1|Pupil|16|hard paper|Ateba|Biya/.test(JSON.stringify(pilot.evidence).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "")), false);   // timestamps stripped: a run at 16:xx is not a mark

  r = await move(head, "CALIBRATED");
  check("ANALYSIS_READY → CALIBRATED without a decision → 400 DECISION_REQUIRED", [r.status, r.body.code], [400, "DECISION_REQUIRED"]);
  r = await move(head, "CALIBRATED", { decision: { outcome: "KEEP", summary: "Two reviews of one case; the engine seems fine to us." } });
  check("with a decision but below the gate → 409 EVIDENCE_GATE, CALIBRATION REQUIRES MORE DATA",
    [r.status, r.body.code, /REQUIRES MORE DATA/.test(r.body.message), r.body.shortfalls.map((s) => `${s.requirement}:${s.actual}/${s.minimum}`)],
    [409, "EVIDENCE_GATE", true, ["casesReviewed:1/30", "casesWithMultipleReviews:1/3"]]);
  check("still ANALYSIS_READY — a refused move changes nothing",
    (await head.get("/insights/pilot")).body.data.pilot.status, "ANALYSIS_READY");
  r = await move(head, "INSUFFICIENT_EVIDENCE", { decision: { summary: "too few" } });
  check("INSUFFICIENT_EVIDENCE also needs a written decision, not two words", [r.status, r.body.code], [400, "DECISION_REQUIRED"]);
  r = await move(head, "INSUFFICIENT_EVIDENCE", { decision: { summary: "One case, two reviewers. Not enough to answer any calibration question. Continue next term." } });
  pilot = r.body.data;
  check("→ INSUFFICIENT_EVIDENCE with the decision recorded and signed",
    [r.status, pilot.status, pilot.decision.outcome, pilot.decision.recordedBy, pilot.decision.summary.length > 20], [200, "INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", "admin-a", true]);
  check("its engine version is still the one the reviews were of", pilot.engineVersion, "1.0.0");
  r = await move(head, "CLOSED");
  pilot = r.body.data;
  check("→ CLOSED: ended, terminal", [r.status, pilot.status, pilot.endedAt !== null, pilot.allowedTransitions], [200, "CLOSED", true, []]);
  check("nothing moves a closed pilot", (await move(head, "ACTIVE")).body.code, "INVALID_TRANSITION");
  check("the whole trail is on the record",
    pilot.transitions.map((t) => t.to), ["READY", "ACTIVE", "REVIEWING", "ANALYSIS_READY", "INSUFFICIENT_EVIDENCE", "CLOSED"]);

  // ── Stage 8: a REAL pilot opens only past the preflight ──────────────────
  r = await head.get("/insights/pilot/preflight");
  const pre = r.body.data;
  check("the preflight answers every automatic precondition for this school",
    [r.status, pre.ready, pre.checks.filter((c) => c.kind === "automatic").length, pre.checks.filter((c) => c.kind === "manual").map((c) => c.key)],
    [200, false, 9, ["schoolParticipates", "reviewersUnderstandTask", "noticeRequirementsMet", "retentionAgreed"]]);
  check("technical readiness and operational readiness are answered apart: the application is sound here, the school is not yet ready, and what is missing is said in words",
    [pre.technicalReady, pre.operationalReady, pre.status, pre.missing, pre.attestationsPending, pre.checks.every((c) => ["technical", "operational", "evidence", "reviewer", "privacy"].includes(c.group))],
    [true, false, "REAL_PILOT_BLOCKED", [`reviewable cases (${pre.counts.cases}/30)`, `multi-review cases (${pre.counts.multiReviewCapable}/3)`].filter((m, i) => (i === 0 ? pre.counts.cases < 30 : pre.counts.multiReviewCapable < 3)), ["attestation: the school participates", "attestation: the reviewers understand the task", "confirmation: notice/consent requirements met", "confirmation: retention and closure agreed"], true]);
  check("an active school is an operational prerequisite: a closed school is not authorised, and the preflight says so in words",
    await (async () => { await M("School").updateOne({ _id: B }, { $set: { isActive: false } }); const p = await pilots.preflight({ schoolId: B }); await M("School").updateOne({ _id: B }, { $set: { isActive: true } }); return [p.checks.find((c) => c.key === "schoolAuthorized").ok, p.operationalReady, p.missing[0]]; })(),
    [false, false, "authorized school"]);
  const byKey = Object.fromEntries(pre.checks.map((c) => [c.key, c.ok]));
  check("two teachers, an administrator, published results, a name-free engine input and live = offline all pass",
    [byKey.reviewersAvailable, byKey.schoolAdminPresent, byKey.publishedEvidence, byKey.engineInputNameFree, byKey.consistencyOperational, byKey.saltNotExposed],
    [true, true, true, true, true, true]);
  check("but a fixture school has nowhere near thirty cases — and says so as the blocker",
    [byKey.reviewableCases, pre.blockers.some((x) => /reviewableCases/.test(x))], [false, true]);
  check("the consistency sample is reported per pupil, identical",
    pre.consistency.every((c) => c.identical) && pre.consistency.length > 0, true);
  r = await head.post("/insights/pilot", { kind: "real", label: "Next term", attestations: { schoolParticipates: true, reviewersUnderstandTask: true } });
  check("so a REAL pilot is refused → 409 REAL_PILOT_BLOCKED with the reason, even with both attestations signed; the refusal carries the split and the missing list",
    [r.status, r.body.code, /REAL PILOT BLOCKED/.test(r.body.message), r.body.blockers.length > 0, r.body.technicalReady, r.body.operationalReady, Array.isArray(r.body.missing) && r.body.missing.length > 0], [409, "REAL_PILOT_BLOCKED", true, true, true, false, true]);
  check("a teacher cannot read the preflight", (await teacherA.get("/insights/pilot/preflight")).status, 403);
  check("a development pilot is not gated", (await head.post("/insights/pilot", { kind: "development", label: "Next term" })).status, 201);
  check("history tells the two apart",
    (await head.get("/insights/pilot/history")).body.data.map((p) => [p.kind, p.status, p.label]),
    [["development", "READY", "Next term"], ["development", "CLOSED", "Form 3A, first try"]]);
  check("the school's current pilot is the open one", (await head.get("/insights/pilot")).body.data.pilot.label, "Next term");
  r = await head.get("/insights/pilot/evidence");
  check("a pilot's evidence is the reviews made inside it: the reviews recorded under the earlier pilot are not this one's, and the number left out is said",
    [r.status, r.body.data.evidence.reviewsRecorded, r.body.data.evidence.reviewers, r.body.data.evidence.reviewsExcluded > 0, typeof r.body.data.evidence.since, r.body.data.evidence.engineVersion],
    [200, 0, 0, true, "string", (await head.get("/insights/pilot")).body.data.pilot.engineVersion]);

  // ── Stage 8: findings on the record ─────────────────────────────────────
  const current = (await head.get("/insights/pilot")).body.data.pilot;
  const fUrl = `/insights/pilot/${current.pilotRunId}/findings`;
  check("a finding needs a category the list knows", (await head.post(fUrl, { category: "VIBES", severity: "low", summary: "Something felt off today" })).body.code, "INVALID_FINDING");
  check("and a summary that is at least a short sentence", (await head.post(fUrl, { category: "MAPPING", severity: "low", summary: "bad" })).body.code, "INVALID_FINDING");
  check("a teacher cannot raise one", (await teacherA.post(fUrl, { category: "MAPPING", severity: "low", summary: "Offline path dropped a field" })).status, 403);
  r = await head.post(fUrl, { category: "OFFLINE_CONSISTENCY", severity: "medium", summary: "Offline path dropped isPassing from each mark",
    evidence: "GET /insights/student/<id>/consistency showed $.profile.subjects[0].marks[0].isPassing live=true offline=null", affectedCases: 6,
    recommendedNextAction: "Carry the field in cohortSchema; engine untouched", engineVersion: "9.9.9" });
  const finding = r.body.data;
  check("→ 201 with an id, status open, the PILOT's engine version, the raiser named",
    [r.status, typeof finding.findingId, finding.status, finding.engineVersion, finding.raisedBy, finding.affectedCases], [201, "string", "open", "1.0.0", "admin-a", 6]);
  check("an amendment without a reason is refused → 400 AMENDMENT_REASON_REQUIRED", (await head.patch(`${fUrl}/${finding.findingId}`, { status: "resolved" })).body.code, "AMENDMENT_REASON_REQUIRED");
  r = await head.patch(`${fUrl}/${finding.findingId}`, { status: "resolved", reason: "Field carried in cohortSchema; consistency re-run identical" });
  check("its status moves with the reason on the trail — who, when, what changed, why; it is never deleted",
    [r.status, r.body.data.status, r.body.pilot.findings.length, r.body.data.amendments.map((a) => [a.by, typeof a.at, a.changes.map((c) => `${c.field}:${c.from}→${c.to}`), a.reason.length > 5, a.pilotClosed])],
    [200, "resolved", 1, [["admin-a", "string", ["status:open→resolved"], true, false]]]);
  check("an unknown status → 400", (await head.patch(`${fUrl}/${finding.findingId}`, { status: "gone", reason: "trying an unknown status" })).body.code, "INVALID_FINDING");
  check("an unknown finding → 404", (await head.patch(`${fUrl}/nope`, { status: "open", reason: "no such finding" })).body.code, "FINDING_NOT_FOUND");
  check("Beta's head cannot reach Alpha's pilot findings", (await headB.post(fUrl, { category: "UX", severity: "low", summary: "Buttons too small for me" })).status, 404);
  check("a teacher's lean view carries no findings", "findings" in (await teacherA.get("/insights/pilot")).body.data.pilot, false);

  // ── Stage 8: the four concerns stay four ────────────────────────────────
  const concerns = (await head.get("/insights/review-cases")).body.data.feedback.concerns;
  check("interpretation disagreement, data quality, missing evidence and contextual limitation are counted apart",
    [concerns.interpretationDisagreement.reviews, concerns.dataQuality.reviews, concerns.missingEvidence.reviews, concerns.contextualLimitation.reviews],
    [2, 1, 0, 0]);
  check("the two new reviewer codes are accepted by the form contract",
    (await head.get("/insights/review-cases")).body.data.reviewForm.dataQuality.filter((c) => ["stale_record", "context_unavailable"].includes(c)).length, 2);
  check("a teacher cannot read the history", (await teacherA.get("/insights/pilot/history")).status, 403);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. what the record never carries ---");
  // ═══════════════════════════════════════════════════════════════════════════

  process.env.CALIBRATION_SALT = "a-salt-that-must-never-appear";
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-only-key-that-must-never-appear";
  const stored = JSON.stringify(await M("IntelligencePilot").find({}).lean());
  const onTheWire = JSON.stringify([(await head.get("/insights/pilot")).body, (await head.get("/insights/pilot/history")).body, (await head.get("/insights/pilot/evidence")).body, (await head.get("/insights/pilot/preflight")).body]);
  check("no salt, no credential, no connection string",
    /salt|CALIBRATION_SALT|a-salt-that|mongodb|MONGODB_URI|password|Check-only/i.test(stored), false);
  check("no signing secret and no provider key, in the record or on any pilot route",
    [stored.includes(process.env.JWT_SECRET), /sk-ant-/.test(stored), onTheWire.includes(process.env.JWT_SECRET), /sk-ant-|a-salt-that|mongodb:/.test(onTheWire)], [false, false, false, false]);
  delete process.env.ANTHROPIC_API_KEY;
  check("no pupil id, name, mark or reviewer's words",
    /st-a1|st-a2|Pupil A|"16"|hard paper|One mark|Ateba|Biya/.test(stored), false);
  check("no result, exam or review document ids",
    /"s1"|"ax1"|reviewId/.test(stored), false);
  check("the scope is the tenancy key and class ids the application already puts in every URL",
    (await M("IntelligencePilot").findOne({ kind: "development" }).lean()).classIds, ["form3a"]);
  delete process.env.CALIBRATION_SALT;

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. live == offline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacherA.get("/insights/student/st-a1/consistency");
  check("a pupil with a decline, an intervention and a steady subject: identical through both paths",
    [r.status, r.body.data.identical, r.body.data.differences, r.body.data.engineVersion], [200, true, [], { live: "1.0.0", offline: "1.0.0" }]);
  check("classification, metrics, evidence, guidance, coverage, the 1.2.0 classes and the development classes — none differ",
    r.body.data.summary, { engineVersion: false, classification: false, metrics: false, evidence: false, guidance: false, coverage: false,
      // Strength Reading 1.2.0 names its own difference classes; none differ either.
      state: false, relationship: false, reasonCodes: false, eventCounts: false, sources: false, contradictions: false, versions: false,
      // Development Engine 1.0.0 classes; none differ either.
      trajectory: false, transitions: false, changeTypes: false, changeReasons: false, quality: false, persistence: false,
      // Guidance 1.0.0 and Intervention 1.0.0 classes; none differ either.
      guidanceState: false, guidanceReason: false, guidanceEvidence: false, interventionTrigger: false, interventionRule: false,
      // Development Planning 1.0.0 and Adaptive Support 1.0.0 classes; none differ either.
      planState: false, planObjective: false, planMilestone: false, planEvidenceBoundary: false, planReview: false, planAdaptation: false, planVersion: false });
  check("a persistently weak pupil, read by the head: identical",
    (await head.get("/insights/student/st-a2/consistency")).body.data.identical, true);
  check("the teacher cannot run it on a pupil they do not teach", (await teacherA.get("/insights/student/st-a2/consistency")).status, 403);
  check("Beta's head cannot run it on Alpha's pupil", (await headB.get("/insights/student/st-a1/consistency")).status, 404);

  // The comparison itself, against a real pair with one thing changed.
  const reviewCases = require(path.join(SRC, "services/intelligence/reviewCases.service"));
  const subjectInsights = require(path.join(SRC, "services/intelligence/subjectInsights.service"));
  const live = await subjectInsights.profileFor({ schoolId: A, studentId: "st-a1" });
  const tampered = JSON.parse(JSON.stringify(live));
  tampered.insights[0].confidence = tampered.insights[0].confidence === "strong" ? "emerging" : "strong";
  const cmp = compareProfiles({ engineVersion: "1.0.0", profile: live, guidance: [] }, { engineVersion: "1.0.0", profile: tampered, guidance: [] });
  check("a planted confidence change is reported, with its path, and flagged as a classification difference",
    [cmp.identical, cmp.summary.classification, cmp.differences.length, /confidence$/.test(cmp.differences[0].path)], [false, true, 1, true]);
  const shifted = JSON.parse(JSON.stringify(live));
  const sub = shifted.subjects.find((s) => s.recentAverage !== null && s.recentAverage !== undefined);
  sub.recentAverage = (sub.recentAverage ?? 0) + 0.01;
  check("a one-hundredth difference in a metric is a difference",
    compareProfiles({ engineVersion: "1.0.0", profile: live, guidance: [] }, { engineVersion: "1.0.0", profile: shifted, guidance: [] }).summary.metrics, true);
  check("the service's own comparison is the same function", typeof reviewCases.liveOfflineConsistency, "function");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. the operator's picture, and the registries ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await operator.get("/super-admin/intelligence/calibration");
  check("each school's row carries its open pilot's kind and state, and how many it has closed",
    r.body.schools.map((s) => [s.schoolName, s.pilot?.kind ?? null, s.pilot?.status ?? null, s.pilotsClosed]),
    [["Alpha Academy", "development", "READY", 1], ["Beta College", null, null, 0]]);
  check("and still no pupil", /st-a1|Pupil/.test(JSON.stringify(r.body)), false);
  check("the head cannot reach it", (await head.get("/super-admin/intelligence/calibration")).status, 403);

  const feed = require(path.join(SRC, "config/syncFeed"));
  check("the pilot record is classified as never mirrored, with a reason",
    [typeof feed.EXCLUDED.IntelligencePilot, feed.EXCLUDED.IntelligencePilot.length > 40], ["string", true]);
  const { definitionOf } = require(path.join(SRC, "config/permissions"));
  const def = definitionOf("insights.pilot");
  check("insights.pilot is registered for the office and not delegable",
    [Boolean(def), def?.delegable ?? null, (def?.defaults ?? []).includes("teacher")], [true, false, false]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
