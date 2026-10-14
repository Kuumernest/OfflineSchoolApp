// backend/scripts/check-development-guidance.js
"use strict";

/**
 * Development Guidance Engine 1.0.0 — bounded, categorical, evidence-linked.
 *
 * (Named apart from check-guidance.js, which covers the academic guidance
 * projection of Stage 3 and is unchanged.)
 *
 * Stable established, emerging, declining, insufficient, contradictory,
 * stale, limited; learning corroboration and contradiction; a state
 * transition, a direction change, a persistence change, a coverage change;
 * historical asOf; deterministic replay; versions; no score, no ranking,
 * no career language, no psychological inference; the pupil decides — then
 * the routes as every role, the guardian's view, and live = offline.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-development-guidance.js
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
const exploration = require(path.join(ROOT, "..", "shared", "exploration"));
const dev = require(path.join(ROOT, "..", "shared", "development"));
const guidance = require(path.join(ROOT, "..", "shared", "guidance"));
const strengthsSvc = require(path.join(SRC, "services/intelligence/strengths.service"));

const Q = "quantitative_reasoning";
const ASOF = "2027-06-01";

// ── Fixtures: real 1.2.0 profiles as the snapshots the service records ────
const EXAMS = [["X1", 1, 1, "2026-10-05"], ["X2", 1, 2, "2026-11-20"], ["X3", 2, 1, "2027-02-10"], ["X4", 2, 2, "2027-03-20"], ["X5", 3, 1, "2027-05-10"]].map(([examId, term, sequenceNumber, startDate]) => ({ examId, type: "test", academicYear: "2026-2027", term, sequenceNumber, startDate }));
const profileOf = (marks, { exams = 5 } = {}) => runEngine({ format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" }, grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 }, exams: EXAMS.slice(0, exams), students: [{ studentId: "S", classId: "C" }],
  results: EXAMS.slice(0, exams).map((e, i) => ({ resultId: `S-${e.examId}`, studentId: "S", classId: "C", examId: e.examId, isPublished: true, subjects: Object.keys(marks).filter((n) => marks[n][i] !== undefined).map((n) => ({ subjectId: n.toLowerCase(), subjectName: n, normalizedMark: marks[n][i], score: marks[n][i], maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false })) })), interventions: [] }).profiles.get("S");
const hw = (id, due, score) => ({ _id: id, subjectId: "mathematics", classId: "c", dueDate: due, maxScore: 20, isPublished: true, createdAt: due, version: 1, submission: { submittedAt: due, score, gradedAt: due } });
const quiz = (quizId, date, raw) => ({ _id: `${quizId}-1`, quizId, subjectId: "mathematics", classId: "c", isPublished: true, status: "submitted", rawScore: raw, maxScore: 10, submittedAt: date, startedAt: date, attemptNumber: 1 });
const learning = (s) => le.buildLearningEvidence({ pupilId: "S", schoolId: "A", sources: s, asOf: ASOF });
const build = (marks, o = {}) => strengths.buildStrengthProfile({ academicProfile: profileOf(marks, o), explorationEvidence: o.explorationEvidence ?? [], learningEvidence: o.learningEvidence ?? null, asOf: ASOF });
const STRONG = { Mathematics: [16, 17, 16, 17, 16] };
const twoHw = [hw("h1", "2027-04-01", 16), hw("h2", "2027-04-15", 17)];
const weak = [hw("w1", "2027-04-01", 6), hw("w2", "2027-04-15", 7)];
const perf = (id, date) => ({ _id: `e-${id}`, kind: "performance", source: "teacher", dimension: Q, area: "mathematical", activity: `act ${id}`, date, recordedBy: "t1", explorationId: id, outcome: "strong: solved it" });
const P = {
  INS: build({ Mathematics: [16] }, { exams: 1 }),
  EMG: build({ Mathematics: [16] }, { exams: 1, learningEvidence: learning({ homework: twoHw }) }),
  EST: build(STRONG),
  EST_C: build(STRONG, { learningEvidence: learning({ homework: twoHw }) }),
  EST_Q: build(STRONG, { learningEvidence: learning({ homework: twoHw, quizAttempts: [quiz("q1", "2027-05-02", 9), quiz("q2", "2027-05-09", 8)] }), explorationEvidence: [perf("x1", "2027-04-03"), perf("x2", "2027-04-21")] }),
  EST_X: build(STRONG, { learningEvidence: learning({ homework: weak }) }),
  DEC: build({ Mathematics: [17, 17, 16, 10, 9] }),
  DEC_L: build({ Mathematics: [17, 17, 16, 10, 9] }, { learningEvidence: learning({ homework: weak }) }),
};
// Snapshots dated close to asOf so recency is RECENT unless a test says otherwise.
const DATES = ["2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15", "2027-05-15"];
const snap = (v, profile, { hash = `h${v}`, at = DATES[v - 1] } = {}) => ({ _id: `snap-${v}`, profileVersion: v, asOf: at, generatedAt: at, periodLabel: `T${v}`, evidenceBoundary: { hash },
  academicEngineVersion: "1.0.0", strengthEngineVersion: "1.2.0", explorationEngineVersion: "1.0.0", learningIntegrationVersion: "1.0.0", learningEvidenceVersion: "1.0.0", profile: strengthsSvc.readingOf(profile) });
const hist = (profiles, { asOf = ASOF, opts = [] } = {}) => dev.buildDevelopmentHistory({ snapshots: profiles.map((p, i) => snap(i + 1, p, opts[i] ?? {})), asOf });
const guide = (profiles, o) => guidance.buildGuidance({ development: hist(profiles, o), asOf: o?.asOf ?? ASOF });
const cats = (g) => g.items.filter((i) => i.dimension === Q).map((i) => i.category);
const item = (g, c) => g.items.find((i) => i.dimension === Q && i.category === c) ?? null;

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the rules, case by case ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let g = guide([P.EST, P.EST]);
  check("versions: guidance 1.0.0 over development 1.0.0; the engines beneath unchanged",
    [g.guidanceEngineVersion, g.developmentEngineVersion, strengths.STRENGTH_ENGINE_VERSION, exploration.EXPLORATION_ENGINE_VERSION, le.LEARNING_EVIDENCE_VERSION, strengths.LEARNING_INTEGRATION_VERSION, dev.DEVELOPMENT_ENGINE_VERSION],
    ["1.0.0", "1.0.0", "1.2.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0"]);
  check("stable established with no independent learning evidence: MAINTAIN, and BUILD_EVIDENCE because the record shows only marks; LIMITED evidence (marks alone), not well supported",
    [cats(g), item(g, "MAINTAIN").reasons, item(g, "MAINTAIN").evidenceQuality], [["BUILD_EVIDENCE", "MAINTAIN"], ["STABLE_ESTABLISHED"], "LIMITED"]);
  g = guide([P.EST_Q, P.EST_Q]);
  check("stable established, corroborated by assignments, quizzes and exploration: MAINTAIN and DEEPEN, WELL_SUPPORTED",
    [cats(g), item(g, "DEEPEN").reasons, item(g, "DEEPEN").evidenceQuality], [["MAINTAIN", "DEEPEN"], ["ESTABLISHED_AND_CORROBORATED"], "WELL_SUPPORTED"]);
  g = guide([P.INS, P.EMG]);
  check("emerging and rising: EXPLORE and PRACTICE — and no career conclusion anywhere", [cats(g).filter((c) => c !== "BUILD_EVIDENCE"), /career|profession|engineer/i.test(JSON.stringify(g).replace(/"notInferred":\[[^\]]*\]/g, ""))], [["EXPLORE", "PRACTICE"], false]);
  g = guide([P.EST, P.DEC]);
  check("one decline after an established reading: MONITOR only — not support, not a change of approach, not a lack of ability", [cats(g).filter((c) => c !== "BUILD_EVIDENCE"), /ability|lazy|capab/i.test(JSON.stringify(g.items))], [["MONITOR"], false]);
  g = guide([P.EST, P.DEC, P.DEC]);
  check("declining in two consecutive observations: SEEK_SUPPORT with PERSISTENT_DECLINE, and MONITOR", [cats(g).filter((c) => c !== "BUILD_EVIDENCE"), item(g, "SEEK_SUPPORT").reasons], [["SEEK_SUPPORT", "MONITOR"], ["PERSISTENT_DECLINE"]]);
  g = guide([P.EST, P.DEC_L, P.DEC_L]);
  check("repeated decline with learning evidence on record: CHANGE_APPROACH joins SEEK_SUPPORT", [cats(g).slice(0, 2), item(g, "CHANGE_APPROACH").reasons], [["SEEK_SUPPORT", "CHANGE_APPROACH"], ["REPEATED_DECLINE_WITH_LEARNING_EVIDENCE"]]);
  g = guide([P.EST_C, P.EST_X, P.EST_X]);
  check("a persistent contradiction: REFLECT, BUILD_EVIDENCE and MONITOR — the contradiction is not resolved by the engine; MAINTAIN still stands for the established reading",
    [cats(g), item(g, "REFLECT").reasons, item(g, "MONITOR").reasons], [["REFLECT", "BUILD_EVIDENCE", "MONITOR", "MAINTAIN"], ["CONTRADICTION_CURRENT"], ["CONTRADICTION_PERSISTENT"]]);
  g = guide([P.INS, P.INS]);
  check("nothing observed in any dimension across two observations: one profile-level BUILD_EVIDENCE item and nothing stronger", g.items.map((i) => [i.dimension, i.category, i.evidenceQuality]), [[null, "BUILD_EVIDENCE", "INSUFFICIENT"]]);
  g = guidance.buildGuidance({ development: dev.buildDevelopmentHistory({ snapshots: [], current: { profile: P.EST, asOf: ASOF, boundaryHash: "c" }, asOf: ASOF }), asOf: ASOF });
  check("one observation only: BUILD_EVIDENCE first, MAINTAIN with INSUFFICIENT evidence — the current state stands, no trend is claimed", [cats(g), item(g, "MAINTAIN").evidenceQuality, item(g, "BUILD_EVIDENCE").reasons], [["BUILD_EVIDENCE", "MAINTAIN"], "INSUFFICIENT", ["INSUFFICIENT_HISTORY", "NO_INDEPENDENT_LEARNING_EVIDENCE", "MOST_MODALITIES_UNAVAILABLE"]]);
  g = guide([P.EST, P.EST], { asOf: "2028-09-01" });
  check("stale evidence (the latest observation more than a year before asOf): BUILD_EVIDENCE and MONITOR with EVIDENCE_STALE, quality INSUFFICIENT", [item(g, "MONITOR").reasons, item(g, "MAINTAIN").evidenceQuality], [["EVIDENCE_STALE"], "INSUFFICIENT"]);
  g = guide([P.EST, P.EST_C]);
  check("learning corroboration arrived beside an unchanged state: MONITOR names the coverage change; the relationship explanation carries the families", [item(g, "MONITOR").reasons, item(g, "MAINTAIN").explanation.relationship], [["COVERAGE_CHANGED_STATE_UNCHANGED"], { code: "LEARNING_RELATIONSHIP", relationship: "CORROBORATED", families: ["ASSIGNMENT"] }]);
  g = guide([P.EST_C, P.EST_X]);
  check("learning contradiction arrived: REFLECT with the contradiction current; the last change is explained", [item(g, "REFLECT").reasons, item(g, "REFLECT").explanation.changed.changeTypes.includes("CONTRADICTION_STARTED")], [["CONTRADICTION_CURRENT"], true]);
  g = guide([P.INS, P.EMG, P.EST_C]);
  check("a state transition to established (STRENGTHENING): MAINTAIN and DEEPEN, with the transitions on the evidence", [cats(g).filter((c) => c !== "BUILD_EVIDENCE"), item(g, "MAINTAIN").evidence.stateTransitions.map((s) => `${s.from}>${s.to}`)], [["MAINTAIN", "DEEPEN"], ["INSUFFICIENT>EMERGING", "EMERGING>ESTABLISHED"]]);
  g = guide([P.EMG, P.EST, P.EMG]);
  check("rose and fell (VARIABLE, a direction change): REFLECT and MONITOR", cats(g).filter((c) => c !== "BUILD_EVIDENCE"), ["REFLECT", "MONITOR"]);
  const persist = hist([P.EST, P.EST]); persist.trajectories[0].changes = [{ dimensionId: Q, changeTypes: ["PERSISTENCE_CHANGED"], reasonCodes: ["ACADEMIC_PERSISTENCE_CHANGED"], observedAt: DATES[1] }];
  g = guidance.buildGuidance({ development: persist, asOf: ASOF });
  check("a persistence change is carried into the explanation without becoming a category of its own", [item(g, "MAINTAIN").explanation.changed.changeTypes, cats(g)], [["PERSISTENCE_CHANGED"], ["BUILD_EVIDENCE", "MAINTAIN"]]);
  g = guide([P.EST_Q, P.EST_C]);
  check("exploration evidence seen before and absent now, at strength: REVISIT", cats(g).includes("REVISIT"), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the guidance object, agency, determinism, prohibitions ---");
  // ═══════════════════════════════════════════════════════════════════════════

  g = guide([P.EST_C, P.EST_Q]);
  const it = item(g, "DEEPEN");
  check("every item answers the six questions: observed, changed, evidence, why, actions with expected evidence, what to watch, what is uncertain",
    [Object.keys(it.explanation), it.suggestedActions.length > 0 && it.suggestedActions.every((a) => a.type && a.instruction && a.expectedEvidence), it.evidenceToWatch.length > 0, typeof it.evidenceQuality, Object.keys(it.developmentContext)],
    [["observed", "changed", "relationship", "why", "uncertain"], true, true, "string", ["trajectory", "direction", "currentState", "previousState", "independentObservations", "lastObservedAt"]]);
  check("the item shape is the documented one", Object.keys(it), ["id", "category", "definition", "dimension", "subjectId", "title", "explanation", "evidence", "reasons", "suggestedActions", "evidenceToWatch", "evidenceQuality", "developmentContext", "asOf", "engineVersion", "developmentEngineVersion"]);
  check("items are bounded: at most four per dimension, every category from the taxonomy, every action from the catalogue",
    [g.items.filter((i) => i.dimension === Q).length <= 4, g.items.every((i) => guidance.CATEGORIES.includes(i.category)), g.items.every((i) => i.suggestedActions.every((a) => guidance.ACTIONS[i.category].includes(a)))], [true, true, true]);
  check("evidence quality is categorical — one of four words, never a number", [guidance.EVIDENCE_QUALITY, g.items.every((i) => typeof i.evidenceQuality === "string")], [["INSUFFICIENT", "LIMITED", "SUPPORTED", "WELL_SUPPORTED"], true]);
  check("the pupil decides: the payload says so, and nothing in it is an instruction", [g.agency, /must|should become|recommends that you/i.test(JSON.stringify(g))], ["INFORMS_ONLY", false]);
  check("the same history and asOf give byte-identical guidance", JSON.stringify(guide([P.EST_C, P.EST_Q])) === JSON.stringify(guide([P.EST_C, P.EST_Q])), true);
  check("historical asOf: as of a date before the second snapshot, only the first exists and the guidance is the one-observation guidance", cats(guide([P.EST_C, P.EST_Q], { asOf: "2027-02-01" })), ["BUILD_EVIDENCE", "MAINTAIN"]);
  let threw = false; try { guidance.buildGuidance({ development: hist([P.EST]) }); } catch { threw = true; }
  check("asOf is required — the engine never reaches for the clock", threw, true);
  const srcDir = path.join(ROOT, "..", "shared", "guidance");
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n").replace(/const FORBIDDEN_KEYS = [^\n]*\n/, "").replace(/const FORBIDDEN_LANGUAGE = [^\n]*\n/, "");
  const strip = (o) => JSON.stringify(o).replace(/"notInferred":\[[^\]]*\]/g, "");
  check("no score, probability, ranking, risk, career, personality or aptitude key — in the engine or in its output", [/\b(score|probability|ranking|riskScore|successProbability|careerFit|personality|aptitudeScore|abilityScore)\s*[:=(]/.test(src), /score|probability|ranking|career|personality|aptitude|IQ\b|psycholog/i.test(strip(g))], [false, false]);
  check("the engine is pure: no I/O, no clock, no randomness, no network, no database, no name", [/require\(["'](fs|http|https|mongoose|axios|crypto)["']\)/.test(src), /Date\.now\(\)|new Date\(\)/.test(src), /Math\.random/.test(src), /studentName|teacherName|\bemail\b/.test(src)], [false, false, false, false]);
  const locales = ["web/src/i18n/locales/en.json", "mobile/src/i18n/locales/en.json"].map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "..", f), "utf8")).devGuidance);
  check("the pupil-facing templates are invitations in both catalogues: 'could', 'may want', 'one option' — never 'you must' or 'should become'",
    locales.map((l) => [/you must|should become|the system recommends/i.test(JSON.stringify(l.categoryStudent)), Object.values(l.categoryStudent).every((s) => /could|may want|option|would/i.test(s))]), [[false, true], [false, true]]);

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
  const call = (token) => { const c = async (method, url, body) => { const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); let out = {}; try { out = await res.json(); } catch { /* empty */ } return { status: res.status, body: out }; }; return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b) }; };
  const as = (id, role, schoolId) => call(jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" }));
  const teacherA = as("teach-a", "teacher", A), teacherC = as("teach-c", "teacher", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A), guardian = call(portalToken);
  const U = "/insights/student/st-a1/development/guidance";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the route, every role, the guardian, live = offline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.get(U);
  check("before any snapshot: one-observation guidance — BUILD_EVIDENCE and MAINTAIN, INSUFFICIENT quality, the pupil decides",
    [rr.status, rr.body.data.guidanceEngineVersion, rr.body.data.historySufficient, rr.body.data.items.filter((i) => i.dimension === Q).map((i) => [i.category, i.evidenceQuality]), rr.body.data.agency],
    [200, "1.0.0", false, [["BUILD_EVIDENCE", "INSUFFICIENT"], ["MAINTAIN", "INSUFFICIENT"]], "INFORMS_ONLY"]);
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 1" });
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { "submissions.0.score": 5 } });
  await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 2" });
  rr = await teacherA.get(U);
  check("two snapshots later, a contradiction current: REFLECT and BUILD_EVIDENCE, with MAINTAIN for the established reading; the reasons name the contradiction",
    [rr.body.data.historySufficient, rr.body.data.items.filter((i) => i.dimension === Q).map((i) => i.category), rr.body.data.items.find((i) => i.category === "REFLECT").reasons],
    [true, ["REFLECT", "BUILD_EVIDENCE", "MAINTAIN"], ["CONTRADICTION_CURRENT"]]);
  check("as of a date before the snapshots the guidance is the one-observation guidance again; the same asOf twice is identical",
    [(await teacherA.get(`${U}?asOf=2020-01-01`)).body.data.historySufficient, JSON.stringify((await teacherA.get(`${U}?asOf=2027-06-01`)).body.data.items) === JSON.stringify((await teacherA.get(`${U}?asOf=2027-06-01`)).body.data.items)], [false, true]);
  check("authorisation: the pupil reads their own; another pupil, the bursar, a teacher of another class → 403; Beta's head → 404; the operator only with a school",
    [(await pupilA1.get(U.replace("st-a1", "me"))).status, (await pupilA2.get(U)).status, (await bursar.get(U)).status, (await teacherC.get(U)).status, (await headB.get(U)).status, (await operator.get(`${U}?schoolId=${A}`)).status, (await operator.get(U)).status !== 200],
    [200, 403, 403, 403, 404, 200, true]);
  rr = await pupilA1.get(U.replace("st-a1", "me"));
  check("the pupil's own guidance carries no other pupil, no note, no reviewer", /st-a2|Pupil A2|done|reviewedBy|notes/.test(JSON.stringify(rr.body.data)), false);
  rr = await guardian.get("/portal/children/st-a1/guidance");
  check("the guardian: areas being built with suggested ways to support, no reason codes, no change events; agreed support (none yet)",
    [rr.status, rr.body.data.guidance.items.length > 0, Object.keys(rr.body.data.guidance.items[0]), rr.body.data.agreedSupport, /reasons|changeTypes|notes/.test(JSON.stringify(rr.body.data.guidance))],
    [200, true, ["dimension", "subjectId", "category", "evidenceQuality", "observed", "suggestedActions", "evidenceToWatch", "unclear"], [], false]);
  check("a child the access does not unlock → 404", (await guardian.get("/portal/children/st-a2/guidance")).status, 404);
  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("live = offline: the guidance through both roads is identical; the mismatch list is empty; the new classes are named and false",
    [rr.status, rr.body.data.guidance.identical, rr.body.data.guidance.differences, rr.body.data.mismatches, ["guidanceState", "guidanceReason", "guidanceEvidence"].every((k) => rr.body.data.guidance.summary[k] === false)], [200, true, [], [], true]);
  const gSvc = require(path.join(SRC, "services/intelligence/developmentGuidance.service"));
  const at = new Date(ASOF);
  check("and directly: JSON-identical guidance from the live loader and the mirrored documents", JSON.stringify(await gSvc.guidanceFor({ schoolId: A, studentId: "st-a1", asOf: at })) === JSON.stringify(await gSvc.offlineGuidanceFor({ schoolId: A, studentId: "st-a1", asOf: at })), true);
  check("nothing is stored: no guidance model exists", mongoose.modelNames().some((n) => /Guidance/i.test(n)), false);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
