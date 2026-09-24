// backend/scripts/check-learning-integration.js
"use strict";

/**
 * Strength Reading 1.2.0 — the learning-evidence integration.
 *
 * The academic baseline preserved; corroboration per family; independence
 * (one event counted once, retries collapsed, nothing the baseline already
 * read counted again); contradiction kept standing; missing modalities read
 * as unavailable, never weak; attendance as context only; interest as
 * context only; one step at most; longitudinal change codes about evidence;
 * versions; determinism; no score, no career; then the real routes as each
 * role, snapshots with every version, retraction, live = offline.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-learning-integration.js
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
const exploration = require(path.join(ROOT, "..", "shared", "exploration"));
const li = require(path.join(ROOT, "..", "shared", "strengths", "learningIntegration"));

const ASOF = "2027-06-01";
const Q = "quantitative_reasoning";

// ── Academic fixture: the strengths test's cohort factory ─────────────────
const EXAMS = [
  { examId: "X1", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { examId: "X2", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
  { examId: "X3", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 1, startDate: "2027-02-10" },
  { examId: "X4", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 2, startDate: "2027-03-20" },
  { examId: "X5", type: "test", academicYear: "2026-2027", term: 3, sequenceNumber: 1, startDate: "2027-05-10" },
];
const profileOf = (marksBySubject, { exams = EXAMS.length } = {}) => {
  const subjects = Object.keys(marksBySubject);
  const results = [];
  for (let i = 0; i < exams; i++) {
    const rows = subjects.map((name) => {
      const m = marksBySubject[name][i];
      if (m === undefined) return null;
      return { subjectId: name.toLowerCase().replace(/\W+/g, "_"), subjectName: name, normalizedMark: m, score: m, maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false };
    }).filter(Boolean);
    if (rows.length) results.push({ resultId: `S-${EXAMS[i].examId}`, studentId: "S", classId: "C", examId: EXAMS[i].examId, isPublished: true, subjects: rows });
  }
  const cohort = { format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" },
    grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 }, exams: EXAMS.slice(0, exams),
    students: [{ studentId: "S", classId: "C" }], results, interventions: [] };
  return runEngine(cohort).profiles.get("S");
};

// ── Learning fixture: the learning-evidence test's source builders ────────
const hw = (id, due, opts) => { const { score = null, submittedOffsetDays = 0, maxScore = 20, subjectId = "mathematics" } = opts ?? {}; return ({
  _id: id, subjectId, classId: "c", dueDate: due, maxScore, isPublished: true, createdAt: due, version: 1,
  submission: submittedOffsetDays === null ? null : { submittedAt: new Date(new Date(due).getTime() + submittedOffsetDays * 86400000).toISOString(), score, gradedAt: score !== null ? due : null },
}); };
const quiz = (quizId, date, raw, { attemptNumber = 1, max = 10, subjectId = "mathematics" } = {}) =>
  ({ _id: `${quizId}-${attemptNumber}`, quizId, subjectId, classId: "c", isPublished: true, status: "submitted", rawScore: raw, maxScore: max, submittedAt: date, startedAt: date, attemptNumber });
const score = (examId, type, date, value, { subjectId = "mathematics" } = {}) =>
  ({ _id: `s-${examId}-${subjectId}`, examId, subjectId, classId: "c", examType: type, academicYear: "2026-2027", term: 2, sequenceNumber: 1, startDate: date, resultsPublished: true, score: value, maxScore: 20, isAbsent: false, isExempt: false, version: 1 });
const att = (i, date, status) => ({ _id: `a${i}`, date, status, subjectId: null, classId: "c" });
const days = (n, from) => Array.from({ length: n }, (_, i) => new Date(new Date(from).getTime() + i * 86400000).toISOString().slice(0, 10));
const learning = (sources) => le.buildLearningEvidence({ pupilId: "S", schoolId: "A", sources, asOf: ASOF });

const build = (marks, { exams, learningEvidence = null, explorationEvidence = [] } = {}) =>
  strengths.buildStrengthProfile({ academicProfile: profileOf(marks, { exams }), explorationEvidence, learningEvidence, asOf: ASOF });
const dim = (p, d) => [...p.strengths, ...p.emergingAreas, ...p.decliningAreas].find((x) => x.dimension === d) ?? null;
const STRONG = { Mathematics: [16, 17, 16, 17, 16] };
const ONE = { Mathematics: [16] };
const twoHw = [hw("h1", "2027-04-01", { score: 16 }), hw("h2", "2027-04-15", { score: 17 })];

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the academic baseline is preserved ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let p = build(STRONG);
  let d = dim(p, Q);
  check("versions: strengths 1.2.0 over integration 1.0.0; academic 1.0.0, exploration 1.0.0, learning evidence 1.0.0 unchanged",
    [p.strengthEngineVersion, p.learningIntegrationVersion, p.academicEngineVersion, exploration.EXPLORATION_ENGINE_VERSION, le.LEARNING_EVIDENCE_VERSION, p.learningEvidenceVersion],
    ["1.2.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0", null]);
  check("with no learning reading the 1.1.0 answer stands, and the Stage 11 base fields are all present",
    [d.state, d.baseState, d.baseConfidence, d.basePersistence, d.baseConsistency, typeof d.baseDirection, d.fusedState, d.fused.stateSource],
    ["ESTABLISHED", "ESTABLISHED", "strong", "persistent", "consistent", "string", "ESTABLISHED", "academic"]);
  check("the academic block anchors the reading; the relationship is UNSUPPORTED, not weak; every modality is reported unavailable",
    [d.academic, d.learningEvidence.relationship, d.learningEvidence.independentEventCount, d.context.missingModalities.length, p.limitations.includes("no_learning_evidence")],
    [{ state: "ESTABLISHED", confidence: "strong", persistence: "persistent", direction: d.baseDirection, consistency: "consistent" }, "UNSUPPORTED", 0, 9, true]);
  check("the authority contract names thirteen families and the academic baseline is the only 'baseline'",
    [Object.keys(li.LEARNING_EVIDENCE_AUTHORITY).length, Object.entries(li.LEARNING_EVIDENCE_AUTHORITY).filter(([, v]) => v === "baseline").map(([k]) => k),
     ["practical", "coursework", "quiz", "assignment", "exploration"].map((k) => li.LEARNING_EVIDENCE_AUTHORITY[k]), li.LEARNING_EVIDENCE_AUTHORITY.teacherObservation,
     ["interest", "reflection", "exposure", "participation", "attendance", "submission"].every((k) => li.LEARNING_EVIDENCE_AUTHORITY[k] === "context_only")],
    [13, ["academic"], Array(5).fill("supporting_capability"), "supporting_observation", true]);

  p = build(STRONG, { learningEvidence: learning({ homework: twoHw }) });
  d = dim(p, Q);
  check("two strong assignments beside an established reading: CORROBORATED, state and source unchanged (nothing to lift), reasons name the support",
    [d.state, d.confidence, d.interpretation.stateSource, d.learningEvidence.relationship, d.interpretation.reasonCodes.filter((r) => r.startsWith("LEARNING_"))],
    ["ESTABLISHED", "strong", "academic", "CORROBORATED", ["LEARNING_SUPPORT:2", "LEARNING_FAMILIES:ASSIGNMENT"]]);
  check("the integrated shape: academic / learningEvidence / corroboration / context / interpretation, each with the named fields",
    [Object.keys(d.learningEvidence), Object.keys(d.corroboration).slice(0, 4), Object.keys(d.context), Object.keys(d.interpretation)],
    [["relationship", "independentEventCount", "sourceFamilies", "currentEventCount", "historicalEventCount", "staleEventCount", "subjects"],
     ["supportingSources", "supportingEvents", "contradictingSources", "contradictingEvents"],
     ["attendanceLimited", "attendancePattern", "submissionContextAvailable", "missingModalities"],
     ["state", "confidence", "stateSource", "relationship", "reasonCodes", "quality", "contradictions"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. corroboration, family by family; one step at most ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const baseOne = build(ONE, { exams: 1 });
  check("one strong mark alone: INSUFFICIENT — the fixture for every lift below", [dim(baseOne, Q), baseOne.confidence], [null, "insufficient"]);
  const lifted = (sources) => { const pr = build(ONE, { exams: 1, learningEvidence: learning(sources) }); const x = dim(pr, Q); return x ? [x.state, x.confidence, x.interpretation.stateSource, x.learningEvidence.relationship, x.learningEvidence.sourceFamilies] : null; };
  check("ASSIGNMENT: two independent strong assignments → EMERGING from learning evidence, one step",
    lifted({ homework: twoHw }), ["EMERGING", "emerging", "learning_evidence", "CORROBORATED", ["ASSIGNMENT"]]);
  check("QUIZ: two distinct quizzes at the strong mark → EMERGING",
    lifted({ quizAttempts: [quiz("q1", "2027-04-02", 8), quiz("q2", "2027-04-20", 9)] }), ["EMERGING", "emerging", "learning_evidence", "CORROBORATED", ["QUIZ"]]);
  check("COURSEWORK: two CA marks (which the academic engine does not read) → EMERGING",
    lifted({ scores: [score("c1", "ca", "2027-03-01", 15), score("c2", "ca", "2027-04-01", 16)] }), ["EMERGING", "emerging", "learning_evidence", "CORROBORATED", ["COURSEWORK"]]);
  check("PRACTICAL entered as an exam score is already the baseline's input: reported as baseline, never recounted, no lift",
    [lifted({ scores: [score("p1", "practical", "2027-03-01", 19), score("p2", "practical", "2027-04-01", 18)] }),
     build(ONE, { exams: 1, learningEvidence: learning({ scores: [score("p1", "practical", "2027-03-01", 19)] }) }).learningIntegration.baselineEventsNotRecounted],
    [null, 1]);
  check("FORMAL test marks in the learning reading are the baseline's own input: excluded, counted as baseline",
    build(ONE, { exams: 1, learningEvidence: learning({ scores: [score("t9", "test", "2027-03-01", 19), score("t8", "test", "2027-04-01", 18)] }) }).learningIntegration.baselineEventsNotRecounted, 2);
  check("one strong assignment is PARTIALLY_CORROBORATED, below the threshold, and lifts nothing",
    [lifted({ homework: [twoHw[0]] }), build(ONE, { exams: 1, learningEvidence: learning({ homework: [twoHw[0]] }) }).learningIntegration.quality.includes("LEARNING_EVIDENCE_PARTIAL")], [null, true]);
  check("a mixed bag — one assignment and one quiz, both strong — corroborates across families",
    lifted({ homework: [twoHw[0]], quizAttempts: [quiz("q1", "2027-04-02", 9)] }), ["EMERGING", "emerging", "learning_evidence", "CORROBORATED", ["ASSIGNMENT", "QUIZ"]]);
  const many = { homework: [...twoHw, hw("h3", "2027-05-01", { score: 18 }), hw("h4", "2027-05-10", { score: 19 })], quizAttempts: [quiz("q1", "2027-04-02", 9), quiz("q2", "2027-04-20", 10)] };
  check("six clean events do not go further than one step: INSUFFICIENT → EMERGING, never ESTABLISHED in one reading",
    lifted(many), ["EMERGING", "emerging", "learning_evidence", "CORROBORATED", ["ASSIGNMENT", "QUIZ"]]);
  const perf = (id, date) => ({ _id: `e-${id}`, kind: "performance", source: "teacher", dimension: Q, area: "mathematical", activity: `act ${id}`, date, recordedBy: "t1", explorationId: id, outcome: "strong: solved it" });
  p = build(ONE, { exams: 1, learningEvidence: learning(many), explorationEvidence: [perf("x1", "2027-04-03"), perf("x2", "2027-04-21")] });
  d = dim(p, Q);
  check("when exploration already lifted INSUFFICIENT → EMERGING, learning evidence agrees but takes no second step",
    [d.baseState, d.fusedState, d.state, d.fused.stateSource, d.interpretation.stateSource, d.interpretation.reasonCodes.includes("LEARNING_SUPPORT_AFTER_EXPLORATION_LIFT")],
    ["INSUFFICIENT", "EMERGING", "EMERGING", "exploration", "exploration", true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. independence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let L = learning({ quizAttempts: [quiz("q1", "2027-04-02", 5, { attemptNumber: 1 }), quiz("q1", "2027-04-03", 7, { attemptNumber: 2 }), quiz("q1", "2027-04-04", 9, { attemptNumber: 3 })] });
  let it = li.learningItems({ learningEvidence: L, subjectNames: { mathematics: "Mathematics" }, grading: { passMark: 10, strongMark: 14 } });
  check("three attempts at one quiz are ONE independent event (the latest speaks); two collapsed; the profile says so",
    [it.items.length, it.items[0].independenceKey, it.items[0].normalizedValue, it.collapsed, build(ONE, { exams: 1, learningEvidence: L }).learningIntegration.quality.includes("DUPLICATE_EVENT_COLLAPSED")],
    [1, "quiz:q1", 0.9, 2, true]);
  check("and one quiz, however many attempts, lifts nothing", lifted({ quizAttempts: [quiz("q1", "2027-04-02", 9, { attemptNumber: 1 }), quiz("q1", "2027-04-03", 10, { attemptNumber: 2 })] }), null);
  L = learning({ homework: [hw("h1", "2027-04-01", { score: 18, submittedOffsetDays: 3 })] });
  check("a late, graded, completed homework is one event with three observations — and one item, not three",
    [L.events[0].observations.length, li.learningItems({ learningEvidence: L, subjectNames: { mathematics: "Mathematics" }, grading: { passMark: 10, strongMark: 14 } }).items.length], [3, 1]);
  it = li.learningItems({ learningEvidence: learning({ homework: [hw("h1", "2027-04-01", { score: 18 })] }), subjectNames: {}, grading: { passMark: 10, strongMark: 14 } });
  check("a subject with no known name maps to no dimension: the item exists, speaks to nothing, and lifts nothing", [it.items.length, it.items[0].dimensions], [1, {}]);
  check("an ungraded submission has no performance observation and is not an item", li.learningItems({ learningEvidence: learning({ homework: [hw("h1", "2027-04-01", { score: null })] }), subjectNames: { mathematics: "Mathematics" }, grading: {} }).items.length, 0);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. contradiction stands; nothing is retired, nothing rescued ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const weak = [hw("w1", "2027-04-01", { score: 6 }), hw("w2", "2027-04-15", { score: 7 })];
  p = build(STRONG, { learningEvidence: learning({ homework: weak }) });
  d = dim(p, Q);
  check("two failing assignments beside an established reading: CONTRADICTED; the strength is NOT retired; confidence steps down once; the conflict is on record",
    [d.state, d.baseState, d.confidence, d.learningEvidence.relationship, d.interpretation.quality.includes("ACADEMIC_LEARNING_CONFLICT"), p.learningIntegration.contradictions.map((c) => [c.dimension, c.kind, c.academic, c.contradicting]),
     p.limitations.includes("academic_learning_conflict")],
    ["ESTABLISHED", "ESTABLISHED", "emerging", "CONTRADICTED", true, [[Q, "ACADEMIC_VS_LEARNING_EVIDENCE", "ESTABLISHED", 2]], true]);
  check("the conflict offers possible explanations, none of them a verdict",
    [d.interpretation.contradictions[0].possibleExplanations, /lazy|unmotivated|weak student|cheat/i.test(JSON.stringify(d))],
    [["different_task_type", "different_period", "limited_evidence", "assessment_context", "missing_context"], false]);
  p = build(STRONG, { learningEvidence: learning({ homework: [...twoHw, weak[0]] }) });
  check("two strong and one failing: PARTIALLY_CORROBORATED, confidence untouched, conflict still named",
    [dim(p, Q).learningEvidence.relationship, dim(p, Q).confidence, dim(p, Q).interpretation.quality.includes("ACADEMIC_LEARNING_CONFLICT")], ["PARTIALLY_CORROBORATED", "strong", true]);
  p = build({ Mathematics: [17, 17, 16, 10, 9] }, { learningEvidence: learning({ homework: [...twoHw, hw("h3", "2027-05-01", { score: 19 }), hw("h4", "2027-05-10", { score: 20 })] }) });
  d = dim(p, Q);
  check("a DECLINING academic reading with four strong assignments stays DECLINING — learning evidence never rescues a decline; the support is reported",
    [d.state, d.baseState, d.learningEvidence.relationship, d.corroboration.supportingEvents.length], ["DECLINING", "DECLINING", "CORROBORATED", 4]);
  p = build(ONE, { exams: 1, learningEvidence: learning({ homework: weak }) });
  check("an INSUFFICIENT reading contradicted by learning evidence stays INSUFFICIENT — no dimension is minted to be contradicted", dim(p, Q), null);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. missing data and staleness ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = build(STRONG, { learningEvidence: learning({ homework: [hw("old1", "2025-04-01", { score: 18 }), hw("old2", "2025-05-01", { score: 19 })] }) });
  d = dim(p, Q);
  check("two strong assignments from two years ago: STALE, not counted, INSUFFICIENT_EVIDENCE, the quality code says stale, the state unmoved",
    [d.learningEvidence.relationship, d.learningEvidence.independentEventCount, d.learningEvidence.staleEventCount, d.interpretation.quality.includes("LEARNING_EVIDENCE_STALE"), d.state],
    ["INSUFFICIENT_EVIDENCE", 0, 2, true, "ESTABLISHED"]);
  p = build(STRONG, { learningEvidence: learning({ homework: [hw("m1", "2027-04-01", { score: 12 }), hw("m2", "2027-04-15", { score: 11 })] }) });
  check("two passing-but-not-strong assignments are neutral: INSUFFICIENT_EVIDENCE, two neutral events, no lift and no contradiction",
    [dim(p, Q).learningEvidence.relationship, dim(p, Q).corroboration.neutralEvents, dim(p, Q).interpretation.quality.includes("ACADEMIC_LEARNING_CONFLICT")], ["INSUFFICIENT_EVIDENCE", 2, false]);
  p = build(STRONG, { learningEvidence: learning({ homework: twoHw }) });
  check("with assignments only, the other modalities are unavailable — named, never 'weak'",
    [dim(p, Q).context.missingModalities, dim(p, Q).interpretation.quality.includes("SOURCE_MODALITY_UNAVAILABLE"), /weak/i.test(JSON.stringify(dim(p, Q).interpretation))],
    [["QUIZ", "COURSEWORK", "PRACTICAL", "EXPLORATION", "TEACHER_OBSERVATION", "INTEREST", "REFLECTION", "ATTENDANCE"], true, false]);
  check("the learning reading itself may be absent (null) and the profile still builds, with no independent events and the integration marked unavailable",
    [build(STRONG).learningIntegration.available, build(STRONG).learningIntegration.independentLearningItems, build(STRONG).learningIntegration.quality.includes("NO_INDEPENDENT_LEARNING_EVENTS")], [false, 0, true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. context: attendance and submission never speak to ability ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const irregular = days(12, "2027-05-01").map((dt, i) => att(i, dt, i % 3 === 1 ? "absent" : "present"));
  p = build(STRONG, { learningEvidence: learning({ homework: [twoHw[0]], attendance: irregular }) });
  d = dim(p, Q);
  check("one assignment beside irregular attendance: CONTEXT_LIMITED, CONTEXT_INCOMPLETE, attendance named — the state unmoved",
    [d.learningEvidence.relationship, d.context.attendanceLimited, d.context.attendancePattern, d.interpretation.quality.includes("CONTEXT_INCOMPLETE"), d.state], ["CONTEXT_LIMITED", true, "ATTENDANCE_IRREGULAR", true, "ESTABLISHED"]);
  p = build(STRONG, { learningEvidence: learning({ homework: twoHw, attendance: irregular }) });
  check("two assignments beside the same attendance: CORROBORATED — context limits thin evidence, it does not veto evidence",
    [dim(p, Q).learningEvidence.relationship, dim(p, Q).context.attendanceLimited], ["CORROBORATED", true]);
  p = build(ONE, { exams: 1, learningEvidence: learning({ attendance: days(12, "2027-05-01").map((dt, i) => att(i, dt, "present")) }) });
  check("perfect attendance alone lifts nothing and corroborates nothing", [dim(p, Q), p.learningIntegration.independentLearningItems, p.learningIntegration.modalities.ATTENDANCE], [null, 0, true]);
  const withSub = build(STRONG, { learningEvidence: learning({ homework: [hw("s1", "2027-04-01", { score: null, submittedOffsetDays: 5 }), hw("s2", "2027-04-10", { score: null, submittedOffsetDays: null })] }) });
  check("late and missing submissions are context: submission context available, no item, no contradiction",
    [dim(withSub, Q).context.submissionContextAvailable, dim(withSub, Q).learningEvidence.independentEventCount, dim(withSub, Q).learningEvidence.relationship], [true, 0, "UNSUPPORTED"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. interest and reflection are context ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const interest = (id, date) => ({ _id: `i-${id}`, kind: "interest", source: "student", dimension: Q, area: "mathematical", activity: `act ${id}`, date, recordedBy: "S", explorationId: id });
  p = build(ONE, { exams: 1, explorationEvidence: [interest("i1", "2027-04-01"), interest("i2", "2027-04-10"), interest("i3", "2027-04-20")] });
  check("three interest rows: INTEREST present as a modality, nothing lifted, nothing corroborated",
    [p.learningIntegration.modalities.INTEREST, dim(p, Q), p.learningIntegration.independentLearningItems], [true, null, 0]);
  check("interest and reflection are context_only in the contract", [li.LEARNING_EVIDENCE_AUTHORITY.interest, li.LEARNING_EVIDENCE_AUTHORITY.reflection], ["context_only", "context_only"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. longitudinal: change codes are about evidence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const before = build(STRONG, { learningEvidence: learning({ homework: [twoHw[0]] }) });
  const after  = build(STRONG, { learningEvidence: learning({ homework: [...twoHw, quiz && hw("h3", "2027-05-01", { score: 18 })], quizAttempts: [quiz("q1", "2027-05-02", 9)] }) });
  let cmp = strengths.compareProfiles(before, after);
  check("more corroboration and a new family: CORROBORATION_ADDED and COVERAGE_CHANGED; the relationship moved PARTIALLY → CORROBORATED",
    cmp.learningEvidence.map((x) => [x.dimension, x.previous, x.current, x.reasons]), [[Q, "PARTIALLY_CORROBORATED", "CORROBORATED", ["LEARNING_EVIDENCE_CORROBORATION_ADDED", "LEARNING_EVIDENCE_COVERAGE_CHANGED"]]]);
  cmp = strengths.compareProfiles(after, before);
  check("evidence gone: RETRACTED and COVERAGE_CHANGED", cmp.learningEvidence[0].reasons, ["LEARNING_EVIDENCE_COVERAGE_CHANGED", "LEARNING_EVIDENCE_RETRACTED"]);
  cmp = strengths.compareProfiles(before, build(STRONG, { learningEvidence: learning({ homework: [twoHw[0], weak[0], weak[1]] }) }));
  check("new failing work: CONTRADICTION_ADDED", cmp.learningEvidence[0].reasons.includes("LEARNING_EVIDENCE_CONTRADICTION_ADDED"), true);
  cmp = strengths.compareProfiles(before, build(STRONG, { learningEvidence: learning({ homework: [twoHw[0]], attendance: irregular }) }));
  check("attendance turned irregular: CONTEXT_CHANGED, and the relationship became CONTEXT_LIMITED", [cmp.learningEvidence[0].reasons, cmp.learningEvidence[0].current], [["LEARNING_EVIDENCE_CONTEXT_CHANGED"], "CONTEXT_LIMITED"]);
  const aged = strengths.buildStrengthProfile({ academicProfile: profileOf(STRONG), learningEvidence: le.buildLearningEvidence({ pupilId: "S", schoolId: "A", sources: { homework: [twoHw[0]] }, asOf: "2029-01-01" }), asOf: "2029-01-01" });
  check("the same assignment two years on: BECAME_STALE", strengths.compareProfiles(before, aged).learningEvidence[0].reasons.includes("LEARNING_EVIDENCE_BECAME_STALE"), true);
  check("no change code names ability — the vocabulary is evidence arriving, leaving, ageing, or context",
    [li.CHANGE_REASONS.every((c) => c.startsWith("LEARNING_EVIDENCE_")), /ABILITY|TALENT|SMARTER|IMPROVED_STUDENT/.test(li.CHANGE_REASONS.join(" "))], [true, false]);
  check("a 1.1.0 snapshot (no learning block) compared with a 1.2.0 reading yields no learning codes — nothing is invented for the past",
    strengths.compareProfiles({ strengths: [{ dimension: Q, state: "ESTABLISHED", confidence: "strong" }], emergingAreas: [], decliningAreas: [] }, after).learningEvidence, []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. determinism, no score, no career ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const twice = [1, 2].map(() => JSON.stringify(build(STRONG, { learningEvidence: learning(many) })));
  check("the same inputs give byte-identical output", twice[0] === twice[1], true);
  const src = fs.readFileSync(path.join(ROOT, "..", "shared", "strengths", "learningIntegration.js"), "utf8");
  check("the module is pure: no I/O, no clock, no randomness, no network",
    [/require\(["'](fs|http|https|mongoose|axios|crypto)["']\)/.test(src), /Date\.now\(\)|new Date\(\)/.test(src), /Math\.random/.test(src)], [false, false, false]);
  const FORBIDDEN = /studentScore|intelligenceScore|talentScore|learningScore|careerScore|overallScore|abilityScore/;
  const stripped = (o) => JSON.stringify(o).replace(/"notInferred":\[[^\]]*\]/g, "");
  check("no forbidden score key in the module or in a full profile; no career, no ranking, no personality anywhere but the not-inferred list",
    [FORBIDDEN.test(src), FORBIDDEN.test(stripped(build(STRONG, { learningEvidence: learning(many) }))), /career|ranking|personality|iq\b/i.test(stripped(build(STRONG, { learningEvidence: learning(many) })))], [false, false, false]);
  check("no weighting anywhere: the thresholds are counts", li.INTEGRATION, { eventsToCorroborate: 2, eventsToContradict: 2, minWeight: 0.5 });
  check("every relationship the layer can emit is one of the six", li.RELATIONSHIPS.length, 6);

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
  const mkExam = (id, type, term, seq, startDate) => ({ _id: id, schoolId: A, name: id, type, academicYear: YEAR, term, sequenceNumber: seq, startDate, classId: "form3a", totalMarks: 20, passMark: 10, status: "published", resultsPublished: true });
  await M("Exam").create([mkExam("t1", "test", 1, 1, "2027-01-10"), mkExam("t2", "test", 1, 2, "2027-02-10"), mkExam("t3", "test", 2, 1, "2027-03-10"), mkExam("t4", "test", 2, 2, "2027-04-10"), mkExam("p1", "practical", 2, 1, "2027-03-15")]);
  const sc = (examId, v) => ({ examId, studentId: "st-a1", subjectId: "maths", classId: "form3a", schoolId: A, score: v, maxScore: 20, passMark: 10 });
  await M("StudentScore").create([sc("t1", 16), sc("t2", 17), sc("t3", 16), sc("t4", 17), sc("p1", 19)]);
  // The academic engine reads the published result summaries, not the raw scores.
  const row = (m) => ({ subjectId: "maths", subjectName: "Mathematics", normalizedMark: m, score: m, maxScore: 20, coefficient: 1, grade: null, points: 0, remark: null, isPassing: m >= 10, isAbsent: false, isExempt: false });
  const summary = (id, examId, term, m) => ({ _id: id, examId, studentId: "st-a1", classId: "form3a", schoolId: A, academicYear: YEAR, term: String(term), isPublished: true, percentage: 80, isPassing: true, subjectsFailed: 0, subjectBreakdown: [row(m)] });
  await M("ResultSummary").create([summary("rs1", "t1", 1, 16), summary("rs2", "t2", 1, 17), summary("rs3", "t3", 2, 16), summary("rs4", "t4", 2, 17), summary("rs5", "p1", 2, 19)]);
  const gradedSub = (score, submittedAt) => ({ studentId: "st-a1", text: "done", submittedAt, score, gradedAt: submittedAt, gradedBy: "teach-a" });
  await M("Homework").create([
    { _id: "hw1", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Fractions", dueDate: "2027-04-01", maxScore: 20, isPublished: true, submissions: [gradedSub(16, "2027-04-01")] },
    { _id: "hw2", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Ratios", dueDate: "2027-04-08", maxScore: 20, isPublished: true, submissions: [gradedSub(18, "2027-04-10")] },
    { _id: "hw3", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Algebra", dueDate: "2027-04-15", maxScore: 20, isPublished: true, submissions: [] },
  ]);
  const quizDocs = await M("Quiz").create([1, 2].map((n) => ({ schoolId: A, title: `Q${n}`, subject_id: "maths", class_id: "form3a", is_published: true, created_by: "teach-a" })));
  await M("QuizAttempt").create([
    ...quizDocs.map((qd, i) => ({ quiz_id: qd._id, user_id: "stu-a1", schoolId: A, attempt_number: 1, status: "submitted", raw_score: 8 + i, max_score: 10, percentage: (8 + i) * 10, submitted_at: new Date(`2027-05-0${i + 1}`), started_at: new Date(`2027-05-0${i + 1}`) })),
    { quiz_id: quizDocs[0]._id, user_id: "stu-a1", schoolId: A, attempt_number: 2, status: "submitted", raw_score: 9, max_score: 10, percentage: 90, submitted_at: new Date("2027-05-03"), started_at: new Date("2027-05-03") },
  ]);
  await M("StudentAttendance").create(days(12, "2027-05-01").map((dt, i) => ({ schoolId: A, classId: "form3a", studentId: "st-a1", markedBy: "teach-a", date: dt, status: i % 3 === 1 ? "absent" : "present" })));

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const asOf = (url) => `${url}${url.includes("?") ? "&" : "?"}asOf=${ASOF}`;
  const call = (token) => { const c = async (method, url, body) => { const res = await fetch(`${API}${method === "GET" ? asOf(url) : url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); let out = {}; try { out = await res.json(); } catch { /* empty */ } return { status: res.status, body: out }; }; return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b) }; };
  const as = (id, role, schoolId) => call(jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" }));
  const teacherA = as("teach-a", "teacher", A), teacherC = as("teach-c", "teacher", A), head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;
  const reads = ["strengths", "profile", "profile/timeline", "profile/changes", "profile/evidence"].map((k) => `/insights/student/st-a1/${k}`);
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. the routes carry the integrated reading ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.get("/insights/student/st-a1/strengths");
  let prof = rr.body.data.profile;
  let q = prof.strengths.find((x) => x.dimension === Q);
  check("the teacher's read → 200, strengths 1.2.0 over integration 1.0.0 and learning evidence 1.0.0; the learning integration block is present",
    [rr.status, prof.strengthEngineVersion, prof.learningIntegrationVersion, prof.learningEvidenceVersion, prof.learningIntegration.version, prof.learningIntegration.available], [200, "1.2.0", "1.0.0", "1.0.0", "1.0.0", true]);
  check("quantitative reasoning: ESTABLISHED from the marks, CORROBORATED by two assignments and two quizzes (three attempts → two events); the practical stayed in the baseline",
    [q.state, q.baseState, q.learningEvidence.relationship, q.learningEvidence.independentEventCount, q.learningEvidence.sourceFamilies, prof.learningIntegration.duplicateEventsCollapsed, prof.learningIntegration.baselineEventsNotRecounted],
    ["ESTABLISHED", "ESTABLISHED", "CORROBORATED", 4, ["ASSIGNMENT", "QUIZ"], 1, 5]);
  check("attendance irregular is context beside a corroborated reading; coursework, exploration, observation, interest, reflection are unavailable, not weak",
    [q.context.attendanceLimited, q.context.attendancePattern, q.context.missingModalities], [true, "ATTENDANCE_IRREGULAR", ["COURSEWORK", "EXPLORATION", "TEACHER_OBSERVATION", "INTEREST", "REFLECTION"]]);
  check("the supporting events are traceable — id, family, subject, date, recency — and carry no note text",
    [q.corroboration.supportingEvents.map((e) => [e.eventId, e.sourceKind, e.subjectId, e.recency]), /done/.test(JSON.stringify(q))],
    [[["homework:hw1", "ASSIGNMENT", "maths", "RECENT"], ["homework:hw2", "ASSIGNMENT", "maths", "RECENT"], [`quiz:${quizDocs[0]._id}:2`, "QUIZ", "maths", "RECENT"], [`quiz:${quizDocs[1]._id}:1`, "QUIZ", "maths", "RECENT"]], false]);
  rr = await teacherA.get("/insights/student/st-a1/profile/evidence");
  check("/profile/evidence: the learning authority, the independent items, the modalities, every version, and the integrated blocks per dimension",
    [rr.status, rr.body.data.learningAuthority.academic, rr.body.data.learningIntegration.items.length, rr.body.data.learningIntegration.modalities.QUIZ, rr.body.data.versions,
     Object.keys(rr.body.data.dimensions[0]).filter((k) => ["academic", "learningEvidence", "corroboration", "context", "interpretation"].includes(k)).length],
    [200, "baseline", 4, true, { academic: "1.0.0", strengths: "1.2.0", learningIntegration: "1.0.0", learningEvidence: "1.0.0", exploration: "1.0.0" }, 5]);
  rr = await teacherA.get("/insights/student/st-a1/profile/timeline");
  check("/profile/timeline names the relationship per dimension and every version", [rr.body.data.learningRelationships[Q], rr.body.data.versions.learningIntegration], ["CORROBORATED", "1.0.0"]);
  rr = await teacherA.get("/insights/student/st-a1/profile");
  check("/profile: the current reading carries the integration summary (no events) and both new versions",
    [rr.body.data.current.learningIntegrationVersion, rr.body.data.current.learningIntegration.relationships[Q], "items" in rr.body.data.current.learningIntegration], ["1.0.0", "CORROBORATED", false]);
  check("authorisation unchanged: the pupil reads their own; another pupil, the bursar, a teacher of another class → 403; Beta's head → 404; the operator only with a school",
    [await statuses(pupilA1, reads.map((u) => u.replace("st-a1", "me"))), (await pupilA2.get(reads[0])).status, await statuses(bursar, reads), await statuses(teacherC, reads), await statuses(headB, reads), await statuses(operator, reads.map(inA)), (await statuses(operator, reads)).every((s) => s !== 200)],
    [[200, 200, 200, 200, 200], 403, [403, 403, 403, 403, 403], [403, 403, 403, 403, 403], [404, 404, 404, 404, 404], [200, 200, 200, 200, 200], true]);
  rr = await pupilA1.get("/insights/student/me/strengths");
  const mineQ = rr.body.data.profile.strengths.find((x) => x.dimension === Q);
  check("the pupil's own reading has the same four answers and no percentage, no score, no other pupil",
    [mineQ.learningEvidence.relationship, mineQ.context.missingModalities.length, /%|score":|st-a2|Pupil A2/.test(JSON.stringify(rr.body.data.profile.strengths))], ["CORROBORATED", 5, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 11. snapshots carry every version; retraction; live = offline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a pupil cannot rebuild; the bursar cannot", [(await pupilA1.post("/insights/student/st-a1/profile/rebuild", {})).status, (await bursar.post("/insights/student/st-a1/profile/rebuild", {})).status], [403, 403]);
  rr = await teacherA.post("/insights/student/st-a1/profile/rebuild", { learningIntegrationVersion: "9.9.9" });
  const v1 = rr.body.data;
  check("first rebuild → 201, v1, the SERVER's five versions, the boundary counts learning events too",
    [rr.status, v1.profileVersion, v1.academicEngineVersion, v1.strengthEngineVersion, v1.explorationEngineVersion, v1.learningIntegrationVersion, v1.learningEvidenceVersion, v1.evidenceBoundary.learningEvents, typeof v1.evidenceBoundary.hash],
    [201, 1, "1.0.0", "1.2.0", "1.0.0", "1.0.0", "1.0.0", 4, "string"]);
  rr = await teacherA.post("/insights/student/st-a1/profile/rebuild", {});
  check("a rebuild on unchanged evidence returns v1 and writes nothing", [rr.status, rr.body.created, await M("StrengthProfileSnapshot").countDocuments({ studentId: "st-a1" })], [200, false, 1]);
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { "submissions.0.score": 5 } });
  rr = await teacherA.get("/insights/student/st-a1/profile/changes");
  check("a corrected assignment mark changes the next reading: pending, CONTRADICTION_ADDED for quantitative reasoning, PARTIALLY_CORROBORATED now; v1 is untouched",
    [rr.body.data.pendingSnapshot, rr.body.data.comparison.learningEvidence.map((x) => [x.dimension, x.previous, x.current, x.reasons]),
     (await M("StrengthProfileSnapshot").findOne({ studentId: "st-a1", profileVersion: 1 }).lean()).evidenceBoundary.hash === v1.evidenceBoundary.hash],
    [true, [[Q, "CORROBORATED", "PARTIALLY_CORROBORATED", ["LEARNING_EVIDENCE_CONTRADICTION_ADDED"]]], true]);
  check("the changes payload names the versions on both sides", [rr.body.data.previous.learningIntegrationVersion, rr.body.data.current.learningIntegrationVersion], ["1.0.0", "1.0.0"]);
  rr = await head.post("/insights/student/st-a1/profile/rebuild", {});
  check("the head's rebuild → v2", [rr.status, rr.body.data.profileVersion], [201, 2]);
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { deletedAt: new Date() } });
  rr = await teacherA.get("/insights/student/st-a1/profile/changes");
  check("a retracted homework: RETRACTED, the reading returns to CORROBORATED-by-three, both snapshots kept",
    [rr.body.data.comparison.learningEvidence[0].reasons, rr.body.data.comparison.learningEvidence[0].current, await M("StrengthProfileSnapshot").countDocuments({ studentId: "st-a1" })],
    [["LEARNING_EVIDENCE_RETRACTED"], "CORROBORATED", 2]);
  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("live = offline: the strengths reading through both roads is identical, every version matching; the difference classes are named",
    [rr.status, rr.body.data.strengths.identical, rr.body.data.strengths.differences, rr.body.data.strengths.versions.live.learningIntegration === rr.body.data.strengths.versions.offline.learningIntegration,
     ["relationship", "reasonCodes", "eventCounts", "sources", "contradictions", "versions"].every((k) => rr.body.data.strengths.summary[k] === false)],
    [200, true, [], true, true]);
  const strengthsSvc = require(path.join(SRC, "services/intelligence/strengths.service"));
  const [liveP, offP] = await Promise.all([strengthsSvc.profileFor({ schoolId: A, studentId: "st-a1", asOf: new Date(ASOF) }), strengthsSvc.offlineProfileFor({ schoolId: A, studentId: "st-a1", asOf: new Date(ASOF) })]);
  check("and directly: JSON-identical profiles from the live loader and the mirrored documents", JSON.stringify(liveP) === JSON.stringify(offP), true);
  const feed = require(path.join(SRC, "config/syncFeed"));
  check("the snapshot stays where it was registered; the exploration engine is untouched", [typeof feed.EXCLUDED.StrengthProfileSnapshot, exploration.EXPLORATION_ENGINE_VERSION], ["string", "1.0.0"]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
