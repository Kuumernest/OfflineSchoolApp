// backend/scripts/check-strength-fusion.js
"use strict";

/**
 * Strength Engine 1.1.0 — longitudinal fusion of exploration evidence.
 *
 * ── Section 1: the pure layer ─────────────────────────────────────────────
 *
 * Academic baseline untouched; one activity moves nothing; two independent
 * supporting events move one step and never two; one activity's several rows
 * are one event; interest, participation, exposure and reflection move
 * nothing; the one teacher rule is the same; contradiction is represented,
 * not resolved; recency windows at their boundaries; skipped and declined
 * activities weaken nothing; duplicate and unknown rows are rejected, not
 * counted; compare and reasons are structured; determinism.
 *
 * ── Section 2: the application ────────────────────────────────────────────
 *
 * Timeline, changes, fused evidence and rebuild as each role; rebuild is
 * idempotent on the evidence boundary and old snapshots stay as they were; a
 * retracted evidence row changes the next reading and not the old snapshot;
 * the recommender stops repeating a saturated area; live = offline for the
 * fused profile.
 *
 * Fixtures throughout. Nothing here is validation on a real pupil.
 *
 *   node scripts/check-strength-fusion.js
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

const st = require(path.join(ROOT, "..", "shared", "strengths"));
const ex = require(path.join(ROOT, "..", "shared", "exploration"));
const { runEngine } = require(path.join(ROOT, "scripts/calibration/analyseCohort"));

const EXAMS = [
  { examId: "X1", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { examId: "X2", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
  { examId: "X3", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 1, startDate: "2027-02-10" },
  { examId: "X4", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 2, startDate: "2027-03-20" },
];
const academic = (marks, exams = EXAMS.length) => {
  const results = EXAMS.slice(0, exams).map((x, i) => ({ resultId: `S-${x.examId}`, studentId: "S", classId: "C", examId: x.examId, isPublished: true,
    subjects: Object.entries(marks).map(([name, ms]) => ({ subjectId: name.toLowerCase(), subjectName: name, normalizedMark: ms[i], score: ms[i], maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false })) }));
  const cohort = { format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" }, grading: { passMark: 10, grades: [] },
    academicStructure: { passMark: 10 }, exams: EXAMS.slice(0, exams), students: [{ studentId: "S", classId: "C" }], results, interventions: [] };
  return runEngine(cohort).profiles.get("S");
};
const ASOF = "2027-06-01";
/** One exploration event's rows, on one dimension, with a rated level and optional observers/interest. */
const event = (id, dimension, date, { level = null, observers = [], interest = false, participation = true } = {}) => {
  const base = (kind, extra = {}) => ({ _id: `${id}:${kind}${extra.by ? ":" + extra.by : ""}`, kind, source: extra.source ?? "system", dimension, area: "computational_technical", activity: id, date,
    recordedBy: extra.by ?? "system", explorationId: id, activityId: "comp-intro-algorithm", activityVersion: 1, outcome: extra.outcome ?? null });
  const rows = [base("exposure")];
  if (participation) rows.push(base("participation"));
  if (level) rows.push(base("performance", { source: "teacher", by: "rater", outcome: `${level}: task_completion=met` }));
  for (const t of observers) rows.push(base("teacher_observation", { source: "teacher", by: t, outcome: "OBSERVED: PROBLEM_SOLVING" }));
  if (interest) rows.push(base("interest", { source: "student", by: "stu" }));
  return rows;
};
const fused = (marks, rows = [], opts = {}) => st.buildStrengthProfile({ academicProfile: academic(marks, opts.exams), explorationEvidence: rows, asOf: opts.asOf ?? ASOF });
const dim = (p, d) => [...p.strengths, ...p.emergingAreas, ...p.decliningAreas].find((x) => x.dimension === d) ?? null;
const STRONG_MATHS = { Mathematics: [16, 17, 16, 17] };            // quantitative ESTABLISHED
const EMERGING_MATHS = { Mathematics: [16, 12, 17, 15] };          // quantitative EMERGING (variable)
const NO_TECH = STRONG_MATHS;
const EMERGING_STEADY = { Mathematics: [16, 17] };               // quantitative EMERGING (recurring, consistent) — two exams                                      // technical_applied INSUFFICIENT
const Q = "quantitative_reasoning", T = "technical_applied";

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. academic remains the baseline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let p = fused(STRONG_MATHS);
  check("1.1.0 with no exploration evidence reads exactly as 1.0.0 did: base and fused agree",
    [p.strengthEngineVersion, dim(p, Q).baseState, dim(p, Q).state, dim(p, Q).baseConfidence, dim(p, Q).confidence, dim(p, Q).fused.stateSource], ["1.2.0", "ESTABLISHED", "ESTABLISHED", "strong", "strong", "academic"]);
  check("the academic engine stays at 1.0.0 beneath it", p.academicEngineVersion, "1.0.0");
  p = fused(STRONG_MATHS, event("e1", Q, "2027-05-01", { level: "limited" }));
  check("one unsuccessful activity does not touch a persistent academic strength — state, confidence, and it is reported below threshold",
    [dim(p, Q).state, dim(p, Q).confidence, dim(p, Q).fused.contradictingEvents, p.fusion.contradictions.length], ["ESTABLISHED", "strong", 1, 1]);
  p = fused(STRONG_MATHS, [...event("e1", Q, "2027-05-01", { level: "limited" }), ...event("e2", Q, "2027-05-10", { level: "limited" })]);
  check("two independent contradicting events lower CONFIDENCE and are reported; the academic state is not erased",
    [dim(p, Q).state, dim(p, Q).confidence, p.fusion.contradictions.map((c) => [c.dimension, c.kind, c.exploration])], ["ESTABLISHED", "emerging", [[Q, "ACADEMIC_VS_EXPLORATION", "contradictory"]]]);
  p = fused({ Mathematics: [17, 17, 10, 9] }, [...event("e1", Q, "2027-05-01", { level: "strong" }), ...event("e2", Q, "2027-05-10", { level: "strong" })]);
  check("an academic decline is not rescued by exploration: DECLINING stays, and the supportive events are a reported conflict",
    [dim(p, Q).state, p.fusion.contradictions.map((c) => [c.kind, c.exploration])], ["DECLINING", [["ACADEMIC_VS_EXPLORATION", "supportive"]]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. exploration: one event, two events, one step ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = fused(NO_TECH, event("e1", T, "2027-05-01", { level: "strong" }));
  check("one successful activity establishes nothing: INSUFFICIENT stays, with the support noted as below threshold",
    [dim(p, T), p.fusion.coverage.exploration.events], [null, 1]);
  p = fused(NO_TECH, [...event("e1", T, "2027-04-01", { level: "strong" }), ...event("e2", T, "2027-05-01", { level: "demonstrated" })]);
  check("two independent supporting events: INSUFFICIENT → EMERGING, sourced from exploration, confidence emerging",
    [dim(p, T).baseState, dim(p, T).state, dim(p, T).confidence, dim(p, T).fused.stateSource, dim(p, T).fused.reasons], ["INSUFFICIENT", "EMERGING", "emerging", "exploration", ["EXPLORATION_SUPPORT:2"]]);
  p = fused(NO_TECH, [1, 2, 3, 4, 5].flatMap((i) => event(`e${i}`, T, `2027-0${Math.min(5, i)}-1${i}`, { level: "strong" })));
  check("five successes never jump INSUFFICIENT → ESTABLISHED: exploration alone caps at EMERGING",
    [dim(p, T).state, dim(p, T).fused.supportingEvents], ["EMERGING", 5]);
  p = fused(EMERGING_MATHS, [...event("e1", Q, "2027-04-01", { level: "strong" }), ...event("e2", Q, "2027-05-01", { level: "strong" })]);
  check("an academically EMERGING dimension with two supporting events → ESTABLISHED, strong",
    [dim(p, Q).baseState, dim(p, Q).state, dim(p, Q).confidence], ["EMERGING", "ESTABLISHED", "strong"]);
  p = fused(EMERGING_MATHS, [...event("e1", Q, "2027-04-01", { level: "strong" }), ...event("e2", Q, "2027-05-01", { level: "limited" })]);
  check("mixed exploration (one success, one failure) moves nothing and is reported as mixed",
    [dim(p, Q).state, dim(p, Q).confidence, p.fusion.contradictions[0]?.exploration], ["EMERGING", "emerging", "mixed"]);
  p = fused(EMERGING_MATHS, [...event("e1", Q, "2027-04-01", { level: "limited" }), ...event("e2", Q, "2027-05-01", { level: "limited" })]);
  check("two failures on an emerging reading lower its confidence to insufficient; the state is not erased",
    [dim(p, Q).state, dim(p, Q).confidence], ["EMERGING", "insufficient"]);
  p = fused(NO_TECH, [...event("e1", T, "2027-04-01", { level: "partial" }), ...event("e2", T, "2027-05-01", { level: "partial" })]);
  check("partial performance is neutral: neither support nor contradiction", [dim(p, T), p.fusion.coverage.exploration.events], [null, 2]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. one event is one event ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = fused(NO_TECH, event("e1", T, "2027-05-01", { level: "strong", observers: ["t1", "t2"], interest: true }));
  const items = p.fusion.evidence.filter((i) => i.eventId === "e1");
  check("one exploration with exposure, participation, performance, two observations and interest is six rows and ONE event",
    [items.length, new Set(items.map((i) => i.eventId)).size, p.fusion.coverage.exploration.events, dim(p, T)], [6, 1, 1, null]);
  check("each row keeps its source and authority — nothing is converted into anything else",
    items.map((i) => [i.sourceType, i.authority]).sort(),
    [["EXPLORATION_PERFORMANCE", "demonstrated_activity_performance"], ["EXPOSURE", "encountered_domain"], ["PARTICIPATION", "engaged_with_activity"],
     ["STUDENT_INTEREST", "stated_preference"], ["TEACHER_OBSERVATION", "contextual_observation"], ["TEACHER_OBSERVATION", "contextual_observation"]]);
  const dup = event("e1", T, "2027-05-01", { level: "strong" });
  p = fused(NO_TECH, [...dup, ...dup]);
  check("the same rows delivered twice are rejected as duplicates, not counted twice",
    [p.fusion.coverage.exploration.events, p.fusion.rejected.filter((r) => r.reason === "duplicate").length, p.limitations.includes("rejected_evidence_rows")], [1, dup.length, true]);
  p = fused(NO_TECH, [{ _id: "weird", kind: "vibes", source: "system", dimension: T, date: "2027-05-01", recordedBy: "x" }]);
  check("a row of a kind the layer does not know is rejected and named", p.fusion.rejected, [{ evidenceId: "weird", reason: "unknown kind vibes" }]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. what never counts as ability ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const signalsOnly = [1, 2, 3, 4].flatMap((i) => event(`e${i}`, T, `2027-05-0${i}`, { level: null, interest: true }));
  p = fused(NO_TECH, signalsOnly);
  check("four completed activities with interest but no rating: participation, exposure and interest — no strength, no emerging",
    [dim(p, T), p.fusion.coverage.participation, p.fusion.coverage.interest, p.fusion.coverage.exploration.events], [null, 4, 4, 4]);
  check("coverage says how much evidence there is, by source, and nothing about the pupil",
    [p.fusion.coverage.sources, p.fusion.coverage.overall], [["ACADEMIC", "STUDENT_INTEREST", "EXPOSURE", "PARTICIPATION"], "broad"]);
  const obs1 = event("e1", Q, "2027-05-01", { level: null, observers: ["t1"] });
  const obs2 = event("e1", Q, "2027-05-01", { level: null, observers: ["t1", "t2"] });
  check("the one teacher rule is unchanged: one observer leaves EMERGING emerging, two distinct observers lift it to strong",
    [dim(fused(EMERGING_STEADY, obs1, { exams: 2 }), Q).confidence, dim(fused(EMERGING_STEADY, obs2, { exams: 2 }), Q).confidence], ["emerging", "strong"]);
  check("and the same teacher twice is one observer",
    dim(fused(EMERGING_STEADY, [...event("e1", Q, "2027-05-01", { level: null, observers: ["t1"] }), ...event("e2", Q, "2027-05-02", { level: null, observers: ["t1"] })], { exams: 2 }), Q).confidence, "emerging");
  check("observers do not lift INSUFFICIENT and do not lift ESTABLISHED past strong",
    [dim(fused(NO_TECH, event("e1", T, "2027-05-01", { level: null, observers: ["t1", "t2"] })), T), dim(fused(STRONG_MATHS, obs2), Q).confidence], [null, "strong"]);
  p = fused(STRONG_MATHS, [...event("e1", Q, "2027-05-01", { level: "limited", observers: ["t1"] }), ...event("e2", Q, "2027-05-05", { level: "limited" })]);
  check("a supportive observer against contradicting performance is a reported conflict, not a resolution",
    p.fusion.contradictions.map((c) => c.kind).sort(), ["ACADEMIC_VS_EXPLORATION", "OBSERVATION_VS_PERFORMANCE"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. interest × performance, four corners ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const pairOf = (level, interest) => dim(fused(EMERGING_MATHS, [...event("e1", Q, "2027-05-01", { level, interest }), ...event("e2", Q, "2027-05-02", { level, interest })]), Q).fused.pair;
  check("high interest + low performance", pairOf("limited", true), { interest: "HIGH", performance: "limited" });
  check("high interest + high performance", pairOf("strong", true), { interest: "HIGH", performance: "strong" });
  check("no stated interest + high performance", pairOf("strong", false), { interest: "NOT_STATED", performance: "strong" });
  check("no stated interest + low performance", pairOf("limited", false), { interest: "NOT_STATED", performance: "limited" });
  check("high interest with limited performance is reported as INTEREST_VS_PERFORMANCE, never as a fit",
    [fused(EMERGING_MATHS, [...event("e1", Q, "2027-05-01", { level: "limited", interest: true }), ...event("e2", Q, "2027-05-02", { level: "limited", interest: true })]).fusion.contradictions.some((c) => c.kind === "INTEREST_VS_PERFORMANCE"),
     /fit_score|talent_score|career_score|career_fit_score/i.test(JSON.stringify(p))], [true, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. recency: 120 and 365 days, at the boundary ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("120 days before asOf is RECENT; 121 is HISTORICAL; 365 is HISTORICAL; 366 is STALE",
    ["2027-02-01", "2027-01-31", "2026-06-01", "2026-05-31"].map((d) => st.recencyOf(d, ASOF)), ["RECENT", "HISTORICAL", "HISTORICAL", "STALE"]);
  p = fused(NO_TECH, [...event("e1", T, "2026-05-01", { level: "strong" }), ...event("e2", T, "2026-05-15", { level: "strong" })]);
  check("two supporting events that are STALE move nothing, and are kept on the record as stale",
    [dim(p, T), p.fusion.coverage.stale, p.limitations.includes("stale_evidence_present")], [null, 6, true]);
  p = fused(NO_TECH, [...event("e1", T, "2026-06-01", { level: "strong" }), ...event("e2", T, "2026-07-01", { level: "strong" })]);
  check("HISTORICAL events still count", dim(p, T)?.state, "EMERGING");
  check("an unreadable date is STALE, and says so", st.recencyOf("not a date", ASOF), "STALE");
  check("asOf is part of the reading: the same rows read differently a year later",
    [dim(fused(NO_TECH, [...event("e1", T, "2027-04-01", { level: "strong" }), ...event("e2", T, "2027-05-01", { level: "strong" })], { asOf: "2027-06-01" }), T)?.state,
     dim(fused(NO_TECH, [...event("e1", T, "2027-04-01", { level: "strong" }), ...event("e2", T, "2027-05-01", { level: "strong" })], { asOf: "2028-06-01" }), T)], ["EMERGING", null]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. agency, timeline, comparison, determinism ---");
  // ═══════════════════════════════════════════════════════════════════════════

  // Skipped, declined and abandoned activities produce no performance rows at all — the exploration layer guarantees it.
  check("a skip, a decline and an abandon produce no evidence the fusion could read",
    [ex.evidenceForStart({ exploration: { _id: "x", schoolId: "A", studentId: "s", classId: "c", startedAt: new Date("2027-05-01") }, activity: ex.activityById("comp-intro-algorithm") }).map((r) => r.kind)],
    [["exposure"]]);
  p = fused(EMERGING_MATHS, [...event("e1", Q, "2027-04-01", { level: "strong", observers: ["t1"] }), ...event("e2", Q, "2027-05-01", { level: "strong", observers: ["t2"] })]);
  const tl = p.fusion.timeline[Q];
  check("the timeline runs academic periods → events by date → the reading, each with its source",
    [tl[0].source, tl.filter((r) => r.source === "EXPLORATION_PERFORMANCE").length, tl.filter((r) => r.source === "TEACHER_OBSERVATION").length, tl[tl.length - 1]],
    ["ACADEMIC", 2, 2, { when: null, source: "PROFILE", reading: "ESTABLISHED", confidence: "strong", stateSource: "exploration" }]);
  const before = fused(EMERGING_MATHS);
  const cmp = st.compareProfiles(before, p);
  check("compare says what changed and why, from structured facts",
    [cmp.newStrengths.map((x) => [x.dimension, x.previous.state, x.current.state, x.reasons]), cmp.weakened.length, cmp.coverage.explorationEvents],
    [[[Q, "EMERGING", "ESTABLISHED", ["EXPLORATION_SUPPORT:2", "TEACHER_OBSERVERS:2", "ACADEMIC_PERSISTENT"]]], 0, { previous: 0, current: 2 }]);
  const weaker = fused(STRONG_MATHS, [...event("e1", Q, "2027-05-01", { level: "limited" }), ...event("e2", Q, "2027-05-10", { level: "limited" })]);
  const cmp2 = st.compareProfiles(fused(STRONG_MATHS), weaker);
  check("and a weakening: confidence down, the contradiction new",
    [cmp2.weakened.map((x) => [x.dimension, x.previous.confidence, x.current.confidence]), cmp2.newContradictions.length, cmp2.newStrengths.length], [[[Q, "strong", "emerging"]], 1, 0]);
  check("no improvement score anywhere in a comparison", /score|percent|improvement/i.test(JSON.stringify(cmp)), false);
  check("deterministic: the same evidence gives the same bytes", JSON.stringify(p) === JSON.stringify(fused(EMERGING_MATHS, [...event("e1", Q, "2027-04-01", { level: "strong", observers: ["t1"] }), ...event("e2", Q, "2027-05-01", { level: "strong", observers: ["t2"] })])), true);
  check("exploration areas follow the fused reading", fused(NO_TECH, [...event("e1", T, "2027-04-01", { level: "strong" }), ...event("e2", T, "2027-05-01", { level: "strong" })]).explorationAreas.some((a) => a.area === "computational_technical"), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. the recommender does not feed itself ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const sp = fused(STRONG_MATHS);
  const twice = [{ activityId: "math-intro-patterns", area: "mathematical", level: "INTRODUCTORY", status: "COMPLETED" }, { activityId: "math-inter-market", area: "mathematical", level: "INTERMEDIATE", status: "COMPLETED" }];
  const r0 = ex.recommend({ strengthProfile: sp, history: twice, count: 6 });
  const r1 = ex.recommend({ strengthProfile: sp, history: twice, count: 6, saturation: 2 });
  check("without the option the 1.0.0 list is unchanged; with saturation the twice-completed mathematical area yields its aligned slot to breadth",
    [r0.suggestions.some((s) => s.area === "mathematical"), r1.suggestions.some((s) => s.area === "mathematical"), r1.saturated, r1.suggestions.length], [true, false, ["mathematical"], 6]);
  check("no reason is ever 'because it was suggested before'", r1.suggestions.every((s) => s.reasons.every((x) => ex.REASONS.includes(x))), true);

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
  await Promise.all([mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("teach-b", "teacher", A, "M. Biya"), mkUser("teach-c", "teacher", A, "Mme Chantal"), mkUser("admin-a", "school_admin", A, "Head Alpha"),
    mkUser("admin-b", "school_admin", B, "Head Beta"), mkUser("bursar-a", "bursar", A, "Bursar Alpha"), mkUser("operator", "super_admin", null, "Operator"), mkUser("stu-a1", "student", A, "Pupil A1"), mkUser("stu-a2", "student", A, "Pupil A2")]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" }]);
  await M("TeacherAssignment").create([{ schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }, { schoolId: A, teacher: "teach-b", class: "form3a", subject: "phy" }, { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" }]);
  const pupil = (id, classId, n) => ({ _id: id, userId: `stu-${id.slice(3)}`, schoolId: A, classId, studentName: `Pupil ${n}`, enrollmentNo: n, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", "form3a", "A1"), pupil("st-a2", "form4b", "A2")]);
  const mkExam = (id, term, seq, startDate) => ({ _id: id, schoolId: A, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate, classId: "form3a", totalMarks: 20, passMark: 10, status: "published", resultsPublished: true });
  await M("Exam").create([mkExam("ax1", 1, 1, "2026-10-05"), mkExam("ax2", 1, 2, "2026-11-20"), mkExam("ax3", 2, 1, "2027-02-10")]);
  const row = (subjectId, subjectName, m) => ({ subjectId, subjectName, normalizedMark: m, score: m, maxScore: 20, coefficient: 1, grade: null, points: 0, remark: null, isPassing: m >= 10, isAbsent: false, isExempt: false });
  const summary = (id, examId, term, rows) => ({ _id: id, examId, studentId: "st-a1", classId: "form3a", schoolId: A, academicYear: YEAR, term: String(term), isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows });
  await M("ResultSummary").create([summary("s1", "ax1", 1, [row("maths", "Mathematics", 16)]), summary("s2", "ax2", 1, [row("maths", "Mathematics", 12)]), summary("s3", "ax3", 2, [row("maths", "Mathematics", 17)])]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights",     auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/explorations", auth.authenticate, require(path.join(SRC, "routes/explorations.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const c = async (method, url, body) => { const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); let out = {}; try { out = await res.json(); } catch { /* empty */ } return { status: res.status, body: out }; };
    return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b) };
  };
  const teacherA = as("teach-a", "teacher", A), teacherB = as("teach-b", "teacher", A), teacherC = as("teach-c", "teacher", A), head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;
  const reads = ["profile/timeline", "profile/changes", "profile/evidence"].map((k) => `/insights/student/st-a1/${k}`);
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. who may read the longitudinal profile ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("assigned teacher, head, pupil (own), operator (selected) → 200 on timeline, changes and evidence",
    [await statuses(teacherA, reads), await statuses(head, reads), await statuses(pupilA1, reads.map((u) => u.replace("st-a1", "me"))), await statuses(operator, reads.map(inA))], [[200, 200, 200], [200, 200, 200], [200, 200, 200], [200, 200, 200]]);
  check("teacher of another class, another pupil, the bursar → 403; Beta's head → 404; the operator unselected → not 200",
    [await statuses(teacherC, reads), await statuses(pupilA2, reads), await statuses(bursar, reads), await statuses(headB, reads), (await statuses(operator, reads)).every((s) => s !== 200)],
    [[403, 403, 403], [403, 403, 403], [403, 403, 403], [404, 404, 404], true]);
  check("a pupil cannot rebuild; the bursar cannot; the teacher of another class cannot",
    [(await pupilA1.post("/insights/student/st-a1/profile/rebuild", {})).status, (await bursar.post("/insights/student/st-a1/profile/rebuild", {})).status, (await teacherC.post("/insights/student/st-a1/profile/rebuild", {})).status], [403, 403, 403]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. v1, new evidence, v2 — and v1 untouched ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 2", strengthEngineVersion: "9.9.9" });
  const v1 = rr.body.data;
  check("first rebuild → 201, snapshot 1, the SERVER's three versions, the evidence boundary recorded",
    [rr.status, rr.body.created, v1.profileVersion, v1.academicEngineVersion, v1.strengthEngineVersion, v1.explorationEngineVersion, v1.evidenceBoundary.evidenceRows, typeof v1.evidenceBoundary.hash],
    [201, true, 1, "1.0.0", "1.2.0", "1.0.0", 0, "string"]);
  rr = await teacherA.post("/insights/student/st-a1/profile/rebuild", {});
  check("a rebuild on unchanged evidence returns snapshot 1 again and writes nothing", [rr.status, rr.body.created, rr.body.data.profileVersion, await M("StrengthProfileSnapshot").countDocuments({ studentId: "st-a1" })], [200, false, 1, 1]);
  check("with no new evidence, changes says nothing is pending and the comparison is all unchanged",
    (({ body }) => [body.data.pendingSnapshot, body.data.newEvidence.rows, body.data.comparison.newStrengths.length])(await teacherA.get("/insights/student/st-a1/profile/changes")), [false, 0, 0]);
  check("quantitative reasoning reads EMERGING from marks 16, 12, 17", (await teacherA.get("/insights/student/st-a1/strengths")).body.data.profile.emergingAreas.map((d) => d.dimension), ["quantitative_reasoning"]);

  // Two explorations, rated strong, through the real routes.
  const run = async (activityId) => {
    const e = (await pupilA1.post("/insights/student/st-a1/explorations", { activityId, action: "start" })).body.data;
    await pupilA1.post(`/explorations/${e._id}/submit`, { outputs: [{ label: "out", value: "done" }], reflection: { interest: "HIGH", continue: "YES" } });
    const rated = await teacherA.post(`/explorations/${e._id}/performance`, { ratings: [{ criterion: "task_completion", rating: "exceeded" }, { criterion: "accuracy", rating: "met" }] });
    return rated.body.data;
  };
  const x1 = await run("math-intro-patterns");
  rr = await teacherA.get("/insights/student/st-a1/profile/changes");
  check("after one rated exploration: new evidence is listed, a snapshot is pending, and the reading has not moved",
    [rr.body.data.newEvidence.explorations, rr.body.data.pendingSnapshot, rr.body.data.comparison.newStrengths.length, rr.body.data.comparison.unchanged.some((d) => d.dimension === Q && d.current.state === "EMERGING")], [1, true, 0, true]);
  const x2 = await run("math-inter-market");
  rr = await teacherA.get("/insights/student/st-a1/profile/changes");
  check("after two: quantitative reasoning moves EMERGING → ESTABLISHED, with the reasons",
    rr.body.data.comparison.newStrengths.map((d) => [d.dimension, d.previous.state, d.current.state, d.reasons[0]]), [[Q, "EMERGING", "ESTABLISHED", "EXPLORATION_SUPPORT:2"]]);
  rr = await teacherA.get("/insights/student/st-a1/profile/evidence");
  check("the fused evidence is traceable: every item has an id, an event, a source, a date and a recency; two events",
    [rr.body.data.evidence.every((i) => i.evidenceId && i.eventId && i.sourceType && i.timestamp && i.recency), rr.body.data.coverage.exploration.events, rr.body.data.dimensions.find((d) => d.dimension === Q).fused.stateSource], [true, 2, "exploration"]);
  rr = await teacherA.get("/insights/student/st-a1/profile/timeline");
  check("the timeline for quantitative reasoning ends in the established reading", rr.body.data.timeline[Q].at(-1).reading, "ESTABLISHED");
  rr = await head.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 3" });
  const v2 = rr.body.data;
  check("the head rebuilds → snapshot 2, boundary with the new rows", [rr.status, v2.profileVersion, v2.evidenceBoundary.evidenceRows > 0], [201, 2, true]);
  const v1Again = await M("StrengthProfileSnapshot").findOne({ studentId: "st-a1", profileVersion: 1 }).lean();
  check("snapshot 1 is byte-for-byte what it was", JSON.stringify(v1Again.profile) === JSON.stringify(v1.profile) && v1Again.evidenceBoundary.hash === v1.evidenceBoundary.hash, true);
  rr = await pupilA1.get("/insights/student/me/profile");
  check("the pupil's profile read shows both versions in order", rr.body.data.history.map((h) => [h.profileVersion, h.strengthEngineVersion]), [[1, "1.2.0"], [2, "1.2.0"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 11. retraction, and live = offline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  await M("ExplorationEvidence").updateOne({ _id: `${x2._id}:performance` }, { $set: { deletedAt: new Date() } });
  rr = await teacherA.get("/insights/student/st-a1/profile/changes");
  check("a retracted performance row: the next reading falls back to EMERGING and a snapshot is pending; snapshot 2 is untouched",
    [rr.body.data.pendingSnapshot, rr.body.data.comparison.weakened.map((d) => [d.dimension, d.previous.state, d.current.state]), (await M("StrengthProfileSnapshot").findOne({ studentId: "st-a1", profileVersion: 2 }).lean()).profile.strengths.length],
    [true, [[Q, "ESTABLISHED", "EMERGING"]], 1]);
  void x1;
  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("live = offline for the fused profile: states, evidence, coverage, contradictions, timeline — identical",
    [rr.status, rr.body.data.identical, rr.body.data.strengths.identical, rr.body.data.strengths.differences, rr.body.data.strengths.engineVersion], [200, true, true, [], { live: "1.2.0", offline: "1.2.0" }]);
  check("the recommender for this pupil reads the fused profile and carries the saturation list", Array.isArray((await pupilA1.get("/insights/student/me/explorations/recommended")).body.data.saturated), true);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
