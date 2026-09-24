// backend/scripts/check-exploration.js
"use strict";

/**
 * The guided exploration loop: the catalog, the recommender, the evidence
 * matrix, the pupil's agency, the longitudinal record, and who may do what.
 *
 * ── Section 1: the pure layer ─────────────────────────────────────────────
 *
 * Every catalog entry validates; the recommender's quota is exactly what the
 * documentation says; strong, emerging, adjacent and discovery suggestions
 * carry the right reasons; completed, declined and skipped history is
 * honoured; resources filter; the list is never longer than asked; a pupil
 * strong in one area is still shown other areas; the evidence matrix keeps
 * exposure, participation, interest, performance and observation apart with
 * deterministic ids; the interest × performance pair is a pair.
 *
 * ── Section 2: the application ────────────────────────────────────────────
 *
 * A pupil discovers, starts, saves, skips, declines, submits; a teacher
 * observes and rates; the reflection's text reaches staff only when shared;
 * the guardian sees progress and no reflection; the office sees counts and no
 * pupil; every write is a replay; the strengths profile does not move because
 * an activity was completed.
 *
 * Fixture pupils, fixture teachers, fixture answers. Nothing here is evidence
 * about a real child.
 *
 *   node scripts/check-exploration.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const ex = require(path.join(ROOT, "..", "shared", "exploration"));
const strengths = require(path.join(ROOT, "..", "shared", "strengths"));
const { runEngine } = require(path.join(ROOT, "scripts/calibration/analyseCohort"));

// A strengths profile from marks, through the real engines.
const EXAMS = [
  { examId: "X1", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { examId: "X2", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
  { examId: "X3", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 1, startDate: "2027-02-10" },
  { examId: "X4", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 2, startDate: "2027-03-20" },
];
const profileOf = (marks, interest = []) => {
  const results = EXAMS.map((x, i) => ({ resultId: `S-${x.examId}`, studentId: "S", classId: "C", examId: x.examId, isPublished: true,
    subjects: Object.entries(marks).map(([name, ms]) => ({ subjectId: name.toLowerCase(), subjectName: name, normalizedMark: ms[i], score: ms[i], maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false })) }));
  const cohort = { format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" }, grading: { passMark: 10, grades: [] },
    academicStructure: { passMark: 10 }, exams: EXAMS, students: [{ studentId: "S", classId: "C" }], results, interventions: [] };
  return strengths.buildStrengthProfile({ academicProfile: runEngine(cohort).profiles.get("S"), explorationEvidence: interest });
};

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the catalog ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("thirty activities, every one valid", [ex.ACTIVITIES.length, ex.ACTIVITIES.filter((a) => ex.validateActivity(a).length).length], [30, 0]);
  check("three levels in each of the ten areas", ex.AREAS.every((area) => ["INTRODUCTORY", "INTERMEDIATE", "EXTENDED"].every((l) => ex.ACTIVITIES.some((a) => a.area === area && a.level === l))), true);
  check("every activity is versioned and carries the layer's version once localised",
    [ex.ACTIVITIES.every((a) => a.version >= 1), ex.localize(ex.ACTIVITIES[0]).engineVersion, ex.EXPLORATION_ENGINE_VERSION], [true, "1.0.0", "1.0.0"]);
  check("categories correspond to the strengths layer's areas", Object.keys(ex.CATEGORY_OF_AREA).sort(), [...strengths.EXPLORATION_AREAS.map((a) => a.code)].sort());
  const bad = { ...ex.ACTIVITIES[0], activityId: "bad", performanceCriteria: [], resources: ["LASER"], studentId: "x" };
  check("an invalid activity is refused with each problem named",
    ex.validateActivity(bad).map((p) => p.split(" ")[0]).sort(), ["an", "resources", "studentId"]);
  check("an activity localises to French and falls back to English",
    [ex.localize(ex.activityById("qsci-intro-bridge"), "fr").title, ex.localize(ex.activityById("qsci-intro-bridge"), "de").language], ["Construire un pont simple", "en"]);
  check("no activity, level or area names a profession",
    /engineer|doctor|lawyer|nurse|pilot|accountant|journalist|programmer\b/i.test(JSON.stringify(ex.ACTIVITIES.map((a) => [a.activityId, a.area, a.text.en.title]))), false);
  check("every activity names an observable outcome and reflection prompts", ex.ACTIVITIES.every((a) => a.text.en.expectedOutputs.length && a.text.en.observable.length && a.text.en.reflectionPrompts.length), true);
  check("most activities need nothing beyond paper, phone or nothing at all",
    ex.ACTIVITIES.filter((a) => a.resources.every((r) => ["NO_SPECIAL_RESOURCES", "PAPER", "PHONE", "GROUP"].includes(r))).length >= 15, true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the recommender ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("the quota for six is three aligned, one adjacent, two discovery — as documented", ex.quota(6), { aligned: 3, adjacent: 1, discovery: 2 });
  const strongQuant = profileOf({ Mathematics: [16, 17, 16, 17], Physics: [15, 16, 15, 16] });
  let r = ex.recommend({ strengthProfile: strongQuant, history: [], count: 6 });
  check("a pupil strong in Mathematics and Physics: three aligned suggestions, each RECURRING_STRENGTH with the subjects behind it",
    [r.suggestions.filter((s) => s.relevance === "aligned").length,
     r.suggestions.filter((s) => s.relevance === "aligned").every((s) => s.reasons[0] === "RECURRING_STRENGTH" && s.supportingSubjects.some((x) => ["Mathematics", "Physics"].includes(x.subjectName))),
     r.suggestions.filter((s) => s.relevance === "aligned").map((s) => s.area).sort()],
    [3, true, ["life_sciences", "mathematical", "quantitative_scientific"]]);
  check("and is NOT locked in: at least one adjacent and one discovery suggestion, six in all",
    [r.breadth.adjacent >= 1, r.breadth.discovery >= 1, r.suggestions.length], [true, true, 6]);
  check("adjacent suggestions say what they relate to; discovery ones say they are new ground",
    [r.suggestions.find((s) => s.relevance === "adjacent")?.reasons, r.suggestions.find((s) => s.relevance === "discovery")?.reasons], [["RELATED_EXPLORATION"], ["NEW_DOMAIN_EXPLORATION"]]);
  check("every suggestion carries the evidence and exploration versions, and no relevance is called fit or probability",
    [r.suggestions.every((s) => s.evidenceVersion === "1.2.0" && s.explorationEngineVersion === "1.0.0"), /fit|probability|career/i.test(JSON.stringify(r))], [true, false]);
  const emerging = profileOf({ Mathematics: [16, 17, 9, 9] });
  r = ex.recommend({ strengthProfile: profileOf({ Mathematics: [16, 12, 17, 15] }), history: [], count: 6 });
  check("an emerging area (strong but variable) suggests with EMERGING_STRENGTH", r.suggestions.some((s) => s.reasons.includes("EMERGING_STRENGTH")), true);
  void emerging;
  r = ex.recommend({ strengthProfile: null, history: [], count: 6 });
  check("no profile at all: six discovery suggestions, one per area, nothing invented", [r.breadth, r.suggestions.every((s) => s.relevance === "discovery")], [{ aligned: 0, adjacent: 0, discovery: 6 }, true]);
  check("never more than asked, for any count", [1, 3, 6, 9, 12].every((n) => ex.recommend({ strengthProfile: strongQuant, count: n }).suggestions.length <= n), true);

  const done = [{ activityId: "math-intro-patterns", area: "mathematical", level: "INTRODUCTORY", status: "COMPLETED" }];
  r = ex.recommend({ strengthProfile: strongQuant, history: done, count: 6 });
  check("a completed activity is not suggested again; the area's next suggestion steps up a level with PREVIOUS_ACTIVITY_FOLLOWUP",
    [r.suggestions.some((s) => s.activityId === "math-intro-patterns"), r.suggestions.find((s) => s.area === "mathematical")?.level, r.suggestions.find((s) => s.area === "mathematical")?.reasons.includes("PREVIOUS_ACTIVITY_FOLLOWUP")],
    [false, "INTERMEDIATE", true]);
  r = ex.recommend({ strengthProfile: strongQuant, history: [{ activityId: "math-intro-patterns", area: "mathematical", level: "INTRODUCTORY", status: "NOT_INTERESTED" }], count: 6 });
  check("a declined activity is not suggested again, and the profile is untouched by the decline",
    [r.suggestions.some((s) => s.activityId === "math-intro-patterns"), strongQuant.strengths.length], [false, 2]);
  r = ex.recommend({ strengthProfile: strongQuant, history: [{ activityId: "math-intro-patterns", area: "mathematical", level: "INTRODUCTORY", status: "SKIPPED" }], count: 6 });
  check("a skipped activity is offered again only behind the alternatives, flagged",
    r.suggestions.find((s) => s.area === "mathematical")?.activityId !== "math-intro-patterns" || r.suggestions.find((s) => s.area === "mathematical")?.skippedBefore === true, true);
  r = ex.recommend({ strengthProfile: strongQuant, history: [{ activityId: "math-intro-patterns", area: "mathematical", level: "INTRODUCTORY", status: "STARTED" }], count: 6 });
  check("an activity in progress is the pupil's already and is not suggested", r.suggestions.some((s) => s.activityId === "math-intro-patterns"), false);
  r = ex.recommend({ strengthProfile: strongQuant, history: [], resources: ["PAPER"], count: 12 });
  check("with only paper available, nothing needing a phone, a computer or a lab is suggested, and each suggestion says the resource is available",
    [r.suggestions.every((s) => ex.activityById(s.activityId).resources.every((x) => ["PAPER", "NO_SPECIAL_RESOURCES"].includes(x))), r.suggestions.every((s) => s.reasons.includes("RESOURCE_AVAILABLE"))], [true, true]);
  const interested = profileOf({ Mathematics: [16, 17, 16, 17] }, [{ kind: "interest", source: "student", dimension: "creative_expression", activity: "Drama", date: "2027-01-01", recordedBy: "s" }]);
  r = ex.recommend({ strengthProfile: interested, history: [], count: 6 });
  check("a pupil's interest in an area adds STUDENT_INTEREST and moves it up within its bucket — it does not make it a strength",
    [r.suggestions.find((s) => s.area === "creative_arts")?.reasons, r.suggestions.find((s) => s.area === "creative_arts")?.relevance], [["NEW_DOMAIN_EXPLORATION", "STUDENT_INTEREST"], "discovery"]);
  check("deterministic: the same inputs give the same bytes", JSON.stringify(ex.recommend({ strengthProfile: strongQuant, history: done, count: 6 })) === JSON.stringify(ex.recommend({ strengthProfile: strongQuant, history: done, count: 6 })), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the evidence matrix ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const expl = { _id: "e1", schoolId: "A", studentId: "st", classId: "c", startedAt: new Date("2027-01-01"), submittedAt: new Date("2027-01-02") };
  const bridge = ex.activityById("qsci-intro-bridge");
  check("starting produces exposure and nothing else", ex.evidenceForStart({ exploration: expl, activity: bridge }).map((x) => [x.kind, x.source, x._id]), [["exposure", "system", "e1:exposure"]]);
  let rows = ex.evidenceForSubmission({ exploration: expl, activity: bridge, reflection: { interest: "LOW", continue: "NO" } });
  check("submitting produces participation (and restates exposure); low interest produces no interest row", rows.map((x) => x.kind), ["exposure", "participation"]);
  rows = ex.evidenceForSubmission({ exploration: expl, activity: bridge, reflection: { interest: "HIGH", continue: "MAYBE" } });
  check("high interest produces an interest row from the pupil, apart from participation", rows.map((x) => [x.kind, x.source]), [["exposure", "system"], ["participation", "system"], ["interest", "student"]]);
  check("participation is never performance: no performance row without a teacher's rating", rows.some((x) => x.kind === "performance"), false);
  const obs = ex.evidenceForObservation({ exploration: expl, activity: bridge, observation: { observedBy: "t1", level: "OBSERVED", codes: ["ITERATION"] } });
  check("an observation produces one teacher_observation row per observer, id fixed by observer", obs.map((x) => [x.kind, x._id, x.recordedBy]), [["teacher_observation", "e1:teacher_observation:t1", "t1"]]);
  const perf = ex.evidenceForPerformance({ exploration: expl, activity: bridge, performance: { ratedBy: "t1", ratings: [{ criterion: "task_completion", rating: "met" }, { criterion: "iteration", rating: "exceeded" }] } });
  check("a rating produces one performance row with the activity-specific level", perf.map((x) => [x.kind, x.outcome.split(":")[0]]), [["performance", "strong"]]);
  check("performance levels: all met with one exceeded → strong; majority met → demonstrated; majority below → limited; else partial",
    [ex.performanceLevel([{ rating: "met" }, { rating: "met" }, { rating: "partly_met" }]), ex.performanceLevel([{ rating: "not_met" }, { rating: "partly_met" }, { rating: "met" }]), ex.performanceLevel([{ rating: "met" }, { rating: "partly_met" }])],
    ["demonstrated", "limited", "partial"]);
  check("interest × performance stays a pair — four corners, no score",
    [ex.patternOf({ interest: "HIGH", performance: "limited" }).pattern, ex.patternOf({ interest: "LOW", performance: "strong" }).pattern, ex.patternOf({ interest: "HIGH", performance: null }).pattern],
    ["HIGH_INTEREST_LIMITED_PERFORMANCE", "LOW_INTEREST_STRONG_PERFORMANCE", null]);
  check("the state machine: discovered may start, save, skip or decline; started may submit or abandon; completed is closed",
    [ex.TRANSITIONS.DISCOVERED, ex.TRANSITIONS.STARTED, ex.TRANSITIONS.COMPLETED, ex.canTransition("NOT_INTERESTED", "STARTED")],
    [["SAVED", "STARTED", "SKIPPED", "NOT_INTERESTED"], ["SUBMITTED", "ABANDONED"], [], false]);

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
  await Promise.all([
    mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("teach-b", "teacher", A, "M. Biya"), mkUser("teach-c", "teacher", A, "Mme Chantal"),
    mkUser("admin-a", "school_admin", A, "Head Alpha"), mkUser("admin-b", "school_admin", B, "Head Beta"), mkUser("bursar-a", "bursar", A, "Bursar Alpha"),
    mkUser("operator", "super_admin", null, "Platform Operator"), mkUser("stu-a1", "student", A, "Pupil A1"), mkUser("stu-a2", "student", A, "Pupil A2"),
  ]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" }, { _id: "form1b", schoolId: B, name: "Form 1B" }]);
  await M("TeacherAssignment").create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }, { schoolId: A, teacher: "teach-b", class: "form3a", subject: "phy" },
    { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({ _id: id, userId: `stu-${id.slice(3)}`, schoolId, classId, studentName: `Pupil ${n}`, enrollmentNo: n, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", A, "form3a", "A1"), pupil("st-a2", A, "form4b", "A2"), pupil("st-b1", B, "form1b", "B1")]);
  const mkExam = (id, classId, term, seq, startDate) => ({ _id: id, schoolId: A, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate, classId, totalMarks: 20, passMark: 10, status: "published", resultsPublished: true });
  await M("Exam").create([mkExam("ax1", "form3a", 1, 1, "2026-10-05"), mkExam("ax2", "form3a", 1, 2, "2026-11-20"), mkExam("ax3", "form3a", 2, 1, "2027-02-10")]);
  const row = (subjectId, subjectName, m) => ({ subjectId, subjectName, normalizedMark: m, score: m, maxScore: 20, coefficient: 1, grade: null, points: 0, remark: null, isPassing: m >= 10, isAbsent: false, isExempt: false });
  const summary = (id, examId, studentId, classId, term, rows2) => ({ _id: id, examId, studentId, classId, schoolId: A, academicYear: YEAR, term: String(term), isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows2 });
  await M("ResultSummary").create([
    summary("s1", "ax1", "st-a1", "form3a", 1, [row("maths", "Mathematics", 16), row("phy", "Physics", 15)]),
    summary("s2", "ax2", "st-a1", "form3a", 1, [row("maths", "Mathematics", 17), row("phy", "Physics", 16)]),
    summary("s3", "ax3", "st-a1", "form3a", 2, [row("maths", "Mathematics", 16), row("phy", "Physics", 15)]),
    summary("s4", "ax1", "st-a2", "form4b", 1, [row("maths", "Mathematics", 8)]),
  ]);
  // A guardian of st-a1, with a live portal session.
  const refresh = "guardian-refresh-token";
  const sid = "sess-1";
  const access = await M("GuardianAccess").create({
    schoolId: A, studentIds: ["st-a1"], codeHash: "not-a-real-hash", label: "Parent A1",
    sessions: [{ _id: sid, tokenHash: crypto.createHash("sha256").update(refresh).digest("hex"), createdAt: new Date(), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) }],
  });
  const portalToken = jwt.sign({ aud: "portal", accessId: String(access._id), schoolId: A, sid }, process.env.JWT_SECRET, { expiresIn: "20m" });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights",     auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/explorations", auth.authenticate, require(path.join(SRC, "routes/explorations.routes")));
  app.use("/api/portal",       require(path.join(SRC, "routes/portal.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const call = (token) => {
    const c = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let out = {}; try { out = await res.json(); } catch { /* empty */ }
      return { status: res.status, body: out };
    };
    return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b) };
  };
  const as = (id, role, schoolId) => call(jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" }));
  const teacherA = as("teach-a", "teacher", A), teacherB = as("teach-b", "teacher", A), teacherC = as("teach-c", "teacher", A);
  const head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B), bursar = as("bursar-a", "bursar", A);
  const operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A);
  const guardian = call(portalToken);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));
  const reads = (id) => ["explorations", "explorations/recommended", "explorations/history", "exploration-evidence"].map((k) => `/insights/student/${id}/${k}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. discovering: the catalog and the suggestions ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await pupilA1.get("/explorations/activities");
  check("a pupil reads the catalog → 200, thirty activities, each with a task and expected outputs", [rr.status, rr.body.data.count, Boolean(rr.body.data.activities[0].task)], [200, 30, true]);
  check("filtered by what the school has: paper only", (await pupilA1.get("/explorations/activities?resources=PAPER")).body.data.activities.every((a) => a.resources.every((x) => ["PAPER", "NO_SPECIAL_RESOURCES"].includes(x))), true);
  check("in French on request", (await pupilA1.get("/explorations/activities/qsci-intro-bridge?lang=fr")).body.data.title, "Construire un pont simple");
  check("the bursar reads no catalog", (await bursar.get("/explorations/activities")).status, 403);

  rr = await pupilA1.get("/insights/student/st-a1/explorations/recommended");
  const sug = rr.body.data.suggestions;
  check("the pupil's suggestions → 200, six, each with reasons a screen can show and the versions",
    [rr.status, sug.length, sug.every((s) => s.reasons.length && s.activity?.title), rr.body.data.explorationEngineVersion, rr.body.data.evidenceVersion], [200, 6, true, "1.0.0", "1.2.0"]);
  check("aligned with Mathematics and Physics, and still with breadth", [sug.filter((s) => s.relevance === "aligned").length >= 1, rr.body.data.breadth.adjacent + rr.body.data.breadth.discovery >= 1], [true, true]);
  check("another pupil's suggestions → 403; a teacher of another class → 403; the bursar → 403; Beta's head → 404",
    [(await pupilA2.get("/insights/student/st-a1/explorations/recommended")).status, ...(await statuses(teacherC, reads("st-a1"))).slice(0, 1), (await bursar.get("/insights/student/st-a1/explorations")).status, (await headB.get("/insights/student/st-a1/explorations")).status],
    [403, 403, 403, 404]);
  check("the assigned teacher, the head and the operator (selected) read all four; the operator unselected does not",
    [await statuses(teacherA, reads("st-a1")), await statuses(head, reads("st-a1")), await statuses(operator, reads("st-a1").map(inA)), (await statuses(operator, reads("st-a1"))).every((s) => s !== 200)],
    [[200, 200, 200, 200], [200, 200, 200, 200], [200, 200, 200, 200], true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. choosing: start, save, skip, decline — and replays ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const first = sug.find((s) => s.activityId === "qsci-intro-bridge") ?? sug[0];
  const clientId = "11111111-1111-4111-8111-111111111111";
  rr = await pupilA1.post("/insights/student/st-a1/explorations", { _id: clientId, activityId: "qsci-intro-bridge", action: "start", reasons: first.reasons, relevance: first.relevance });
  const e1 = rr.body.data;
  check("the pupil starts the bridge with a client id → 201 STARTED, the reasons kept, exposure recorded",
    [rr.status, e1._id, e1.status, e1.suggestedBecause.length > 0, e1.generatedEvidenceIds], [201, clientId, "STARTED", true, [`${clientId}:exposure`]]);
  rr = await pupilA1.post("/insights/student/st-a1/explorations", { _id: clientId, activityId: "qsci-intro-bridge", action: "start" });
  check("the same create again is a replay, not a second record", [rr.status, rr.body.replayed, rr.body.data._id, await M("StudentExploration").countDocuments({ studentId: "st-a1" })], [201, true, clientId, 1]);
  check("and a create for the same activity while one is open returns the open one", (await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "qsci-intro-bridge", action: "save" })).body.data._id, clientId);
  rr = await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "lang-intro-explain", action: "save" });
  const saved = rr.body.data;
  check("saving → SAVED, nothing recorded as evidence", [saved.status, saved.generatedEvidenceIds], ["SAVED", []]);
  const skipped = (await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "art-intro-series", action: "skip" })).body.data;
  const declined = (await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "org-intro-plan", action: "not_interested" })).body.data;
  check("skipping and declining close the row, no evidence, no penalty", [skipped.status, declined.status, Boolean(declined.closedAt), skipped.generatedEvidenceIds.length + declined.generatedEvidenceIds.length], ["SKIPPED", "NOT_INTERESTED", true, 0]);
  check("an unknown activity → 404; an unknown action → 400", [(await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "nope", action: "start" })).body.code, (await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "math-intro-patterns", action: "fly" })).body.code], ["ACTIVITY_NOT_FOUND", "INVALID_ACTION"]);
  check("another pupil, or a teacher of another class, cannot choose for this pupil",
    [(await pupilA2.post("/insights/student/st-a1/explorations", { activityId: "math-intro-patterns", action: "start" })).status, (await teacherC.post("/insights/student/st-a1/explorations", { activityId: "math-intro-patterns", action: "start" })).status], [403, 403]);
  rr = await pupilA1.get("/insights/student/st-a1/explorations/recommended");
  check("the suggestions now leave out the open, skipped-behind and declined activities",
    [rr.body.data.suggestions.some((s) => ["qsci-intro-bridge", "lang-intro-explain", "org-intro-plan"].includes(s.activityId)), rr.body.data.suggestions.length], [false, 6]);

  rr = await pupilA1.post(`/explorations/${saved._id}/start`, { version: saved.version });
  check("starting a saved exploration → STARTED, exposure recorded", [rr.status, rr.body.data.status, rr.body.data.generatedEvidenceIds.length], [200, "STARTED", 1]);
  const v = rr.body.data.version;
  check("starting again is a no-op with the same version", (await pupilA1.post(`/explorations/${saved._id}/start`, {})).body.data.version, v);
  check("a stale version → 409 VERSION_CONFLICT", (await pupilA1.post(`/explorations/${saved._id}/abandon`, { version: 1 })).body.code, "VERSION_CONFLICT");
  check("skipping a started exploration → 409 INVALID_TRANSITION with the moves allowed", (({ body }) => [body.code, body.allowed])(await pupilA1.post(`/explorations/${saved._id}/skip`, {})), ["INVALID_TRANSITION", ["SUBMITTED", "ABANDONED"]]);
  check("another pupil cannot touch it; a teacher of another class cannot; the bursar cannot",
    [(await pupilA2.post(`/explorations/${saved._id}/abandon`, {})).status, (await teacherC.post(`/explorations/${saved._id}/abandon`, {})).status, (await bursar.post(`/explorations/${saved._id}/abandon`, {})).status], [403, 403, 403]);
  rr = await pupilA1.post(`/explorations/${saved._id}/abandon`, { version: v });
  check("abandoning → ABANDONED, closed, on the trail", [rr.body.data.status, Boolean(rr.body.data.closedAt), rr.body.data.transitions.map((t) => t.to)], ["ABANDONED", true, ["SAVED", "STARTED", "ABANDONED"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. submitting: outputs, reflection, evidence, review ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a submission without outputs → 400 OUTPUT_REQUIRED", (await pupilA1.post(`/explorations/${clientId}/submit`, { outputs: [] })).body.code, "OUTPUT_REQUIRED");
  const submission = { outputs: [{ label: "bridge", value: "A card truss; held one book" }, { label: "explanation", value: "The triangles spread the load" }], completionMode: "pair",
    reflection: { interest: "HIGH", difficulty: "MANAGEABLE", continue: "YES", enjoyed: "Watching it hold", difficult: "Gluing straight", shareText: false } };
  rr = await pupilA1.post(`/explorations/${clientId}/submit`, submission);
  check("done alone, the bridge completes on submission — a pupil's completion never waits on a teacher; participation and interest rows are written",
    [rr.status, rr.body.data.status, Boolean(rr.body.data.completedAt), rr.body.data.generatedEvidenceIds.sort()], [200, "COMPLETED", true, [`${clientId}:exposure`, `${clientId}:interest`, `${clientId}:participation`]]);
  const evidenceCount = await M("ExplorationEvidence").countDocuments({ explorationId: clientId });
  rr = await pupilA1.post(`/explorations/${clientId}/submit`, submission);
  check("delivering the same submission again does nothing twice", [rr.status, rr.body.data.status, await M("ExplorationEvidence").countDocuments({ explorationId: clientId })], [200, "COMPLETED", evidenceCount]);
  rr = await pupilA1.get("/insights/student/st-a1/explorations");
  const mine = rr.body.data.explorations.find((x) => x.explorationId === clientId);
  check("the pupil sees their whole reflection", [mine.reflection.interest, mine.reflection.enjoyed], ["HIGH", "Watching it hold"]);
  rr = await teacherA.get("/insights/student/st-a1/explorations");
  const theirs = rr.body.data.explorations.find((x) => x.explorationId === clientId);
  check("the teacher sees the controlled answers and not the unshared text", [theirs.reflection.interest, theirs.reflection.continue, "enjoyed" in theirs.reflection, theirs.reflection.shareText], ["HIGH", "YES", false, false]);
  check("a teacher cannot write the pupil's reflection", (await teacherA.post(`/explorations/${clientId}/reflection`, { interest: "LOW" })).body.code, "STUDENT_ONLY");
  rr = await pupilA1.post(`/explorations/${clientId}/reflection`, { ...submission.reflection, shareText: true });
  check("the pupil revises to share the text: a revision, the earlier account kept", [rr.status, rr.body.data.version, rr.body.data.revisions.length, rr.body.data.revisions[0].body.shareText], [201, 2, 1, false]);
  check("now the teacher sees the text", (await teacherA.get("/insights/student/st-a1/explorations")).body.data.explorations.find((x) => x.explorationId === clientId).reflection.enjoyed, "Watching it hold");
  check("an unknown reflection value → 400", (await pupilA1.post(`/explorations/${clientId}/reflection`, { interest: "EXTREME" })).body.code, "INVALID_REFLECTION");

  rr = await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "life-intro-observe", action: "start" });
  const plain = rr.body.data;
  rr = await pupilA1.post(`/explorations/${plain._id}/submit`, { outputs: [{ label: "record", value: "Seven days of the mango tree" }] });
  check("an activity with no rated output completes on submission, with participation and exposure only",
    [rr.body.data.status, Boolean(rr.body.data.completedAt), (await M("ExplorationEvidence").find({ explorationId: plain._id }).lean()).map((x) => x.kind).sort()], ["COMPLETED", true, ["exposure", "participation"]]);
  check("rating it → 409 NO_PERFORMANCE_CRITERIA", (await teacherA.post(`/explorations/${plain._id}/performance`, { ratings: [{ criterion: "quality", rating: "met" }] })).body.code, "NO_PERFORMANCE_CRITERIA");
  rr = await pupilA1.post("/insights/student/st-a1/explorations", { activityId: "qsci-ext-investigation", action: "start" });
  const withTeacher = rr.body.data;
  rr = await pupilA1.post(`/explorations/${withTeacher._id}/submit`, { outputs: [{ label: "question", value: "Does the ramp angle change the roll time?" }] });
  check("an activity done WITH a teacher waits in REVIEW_REQUIRED for that teacher's rating", rr.body.data.status, "REVIEW_REQUIRED");
  rr = await teacherB.post(`/explorations/${withTeacher._id}/performance`, { ratings: [{ criterion: "task_completion", rating: "met" }, { criterion: "communication", rating: "exceeded" }] });
  check("and the rating completes it, on the trail", [rr.body.data.status, rr.body.data.transitions.map((x) => x.to)], ["COMPLETED", ["STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. the teacher: observation and performance, apart from each other ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a pupil cannot observe", (await pupilA1.post(`/explorations/${clientId}/observation`, { level: "OBSERVED" })).status, 403);
  check("an unknown code → 400", (await teacherA.post(`/explorations/${clientId}/observation`, { level: "OBSERVED", codes: ["NATURAL_LEADER"] })).body.code, "INVALID_OBSERVATION");
  rr = await teacherA.post(`/explorations/${clientId}/observation`, { level: "OBSERVED", codes: ["ITERATION", "EXPLANATION"], note: "Rebuilt the deck after the first test" });
  check("teacher A observes → 201, one teacher_observation row", [rr.status, rr.body.data.codes, await M("ExplorationEvidence").countDocuments({ explorationId: clientId, kind: "teacher_observation" })], [201, ["ITERATION", "EXPLANATION"], 1]);
  rr = await teacherA.post(`/explorations/${clientId}/observation`, { level: "PARTLY_OBSERVED", codes: ["ITERATION"] });
  check("teacher A again: a revision of the same observation, still one row of each", [rr.body.data.version, rr.body.data.revisions.length, await M("ExplorationObservation").countDocuments({ explorationId: clientId }), await M("ExplorationEvidence").countDocuments({ explorationId: clientId, kind: "teacher_observation" })], [2, 1, 1, 1]);
  rr = await teacherB.post(`/explorations/${clientId}/observation`, { level: "OBSERVED", codes: ["COLLABORATION"] });
  check("teacher B: a second observer, a second row", [rr.status, await M("ExplorationEvidence").countDocuments({ explorationId: clientId, kind: "teacher_observation" })], [201, 2]);
  check("a criterion the activity does not have → 400", (await teacherA.post(`/explorations/${clientId}/performance`, { ratings: [{ criterion: "accuracy", rating: "met" }] })).body.code, "INVALID_PERFORMANCE");
  rr = await teacherA.post(`/explorations/${clientId}/performance`, { ratings: [{ criterion: "task_completion", rating: "met" }, { criterion: "problem_solving_approach", rating: "partly_met" }, { criterion: "iteration", rating: "met" }] });
  check("the rating records an activity-specific level on the completed exploration, and one performance row",
    [rr.status, rr.body.data.status, rr.body.data.performance.level, rr.body.data.performance.ratedBy, await M("ExplorationEvidence").countDocuments({ explorationId: clientId, kind: "performance" })], [200, "COMPLETED", "demonstrated", "teach-a", 1]);
  rr = await teacherA.get("/insights/student/st-a1/explorations");
  const done1 = rr.body.data.explorations.find((x) => x.explorationId === clientId);
  check("the record shows the pair — high interest, demonstrated performance — as a pair, and every evidence kind apart",
    [done1.pattern.pattern, done1.evidence.map((x) => x.kind).sort()], ["HIGH_INTEREST_DEMONSTRATED_PERFORMANCE", ["exposure", "interest", "participation", "performance", "teacher_observation", "teacher_observation"]]);
  check("the trail is complete and untouched", done1.transitions.map((t) => t.to), ["STARTED", "SUBMITTED", "COMPLETED"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. boundaries: the strengths profile, the guardian, the office ---");
  // ═══════════════════════════════════════════════════════════════════════════

  rr = await teacherA.get("/insights/student/st-a1/strengths");
  check("the strengths profile is unchanged by a completed exploration — participation and performance are carried, not consumed by 1.0.0",
    [rr.body.data.profile.strengths.map((d) => d.dimension), rr.body.data.profile.strengthEngineVersion, rr.body.data.profile.interestSignals.length > 0], [["quantitative_reasoning", "scientific_reasoning"], "1.2.0", true]);
  rr = await pupilA1.get("/insights/student/st-a1/exploration-evidence");
  check("the evidence read groups the rows by kind", Object.fromEntries(Object.entries(rr.body.data.byKind).sort()), { exposure: 4, interest: 1, participation: 3, performance: 2, teacher_observation: 2 });
  rr = await pupilA1.get("/insights/student/st-a1/explorations/history");
  check("history answers what, when, how many, completed, reported, observed, produced",
    [Object.fromEntries(Object.entries(rr.body.data.counts).sort()), rr.body.data.areasExplored],
    [{ ABANDONED: 1, COMPLETED: 3, NOT_INTERESTED: 1, SKIPPED: 1 }, ["creative_arts", "language_media", "life_sciences", "organisation_enterprise", "quantitative_scientific"]]);

  rr = await guardian.get("/portal/children/st-a1/explorations");
  const g1 = rr.body.data.explorations.find((x) => x.explorationId === clientId);
  check("the guardian sees progress: status, area, evidence kinds, observation count — and no reflection, no outputs, no trail",
    [rr.status, g1.status, g1.evidence.sort(), g1.observations, g1.reflection, "outputs" in g1, "transitions" in g1], [200, "COMPLETED", ["exposure", "interest", "participation", "performance", "teacher_observation", "teacher_observation"], 2, null, false, false]);
  check("a child the access does not unlock → 404", (await guardian.get("/portal/children/st-a2/explorations")).status, 404);
  check("the guardian's strengths view still works beside it", (await guardian.get("/portal/children/st-a1/strengths")).status, 200);

  rr = await head.get("/insights/explorations/summary");
  check("the office sees counts by area, completions, skips, declines and evidence volume — and no pupil",
    [rr.status, rr.body.data.students, rr.body.data.byArea.quantitative_scientific.completed, rr.body.data.frequentlyDeclined[0]?.activityId, rr.body.data.evidenceRows, /st-a1|Pupil|enjoyed|Watching/.test(JSON.stringify(rr.body))],
    [200, 1, 2, "org-intro-plan", 12, false]);
  check("a teacher's summary is scoped to their classes; the bursar has none", [(await teacherC.get("/insights/explorations/summary")).body.data.explorations, (await bursar.get("/insights/explorations/summary")).status], [0, 403]);

  const feed = require(path.join(SRC, "config/syncFeed"));
  check("explorations and observations mirror on the intelligence capabilities scoped to taught pupils; reflections and school activities stay online with reasons",
    [feed.required(feed.byCollection.get("studentExploration")), typeof feed.byCollection.get("explorationObservation").scope, typeof feed.EXCLUDED.ExplorationReflection, typeof feed.EXCLUDED.ExplorationActivity],
    [["insights.view", "insights.viewTaught"], "function", "string", "string"]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
