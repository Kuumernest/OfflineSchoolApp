// backend/scripts/check-development.js
"use strict";

/**
 * Development Engine 1.0.0 — how the evidence-backed profile changes over time.
 *
 * Basic history; every state transition; one observation is no trend;
 * coverage change is not state change; contradictions new, recurring,
 * persistent, resolved, stale, and never erased; retraction changes the
 * next reading and no snapshot; asOf replay; independence (duplicate
 * observations, retries, one event across modalities); determinism; no
 * score; no prediction; versions kept as recorded; privacy — then the routes
 * as each role, the guardian's view, snapshots feeding the history, and
 * live = offline.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-development.js
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
const strengthsSvc = require(path.join(SRC, "services/intelligence/strengths.service"));

const Q = "quantitative_reasoning";
const ASOF = "2027-06-01";

// ── Fixtures: real 1.2.0 profiles, wrapped as the snapshots the service records ──
const EXAMS = [
  { examId: "X1", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { examId: "X2", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
  { examId: "X3", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 1, startDate: "2027-02-10" },
  { examId: "X4", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 2, startDate: "2027-03-20" },
  { examId: "X5", type: "test", academicYear: "2026-2027", term: 3, sequenceNumber: 1, startDate: "2027-05-10" },
];
const profileOf = (marksBySubject, { exams = EXAMS.length } = {}) => {
  const results = [];
  for (let i = 0; i < exams; i++) {
    const rows = Object.keys(marksBySubject).map((name) => { const m = marksBySubject[name][i]; return m === undefined ? null : { subjectId: name.toLowerCase(), subjectName: name, normalizedMark: m, score: m, maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false }; }).filter(Boolean);
    if (rows.length) results.push({ resultId: `S-${EXAMS[i].examId}`, studentId: "S", classId: "C", examId: EXAMS[i].examId, isPublished: true, subjects: rows });
  }
  return runEngine({ format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" }, grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 },
    exams: EXAMS.slice(0, exams), students: [{ studentId: "S", classId: "C" }], results, interventions: [] }).profiles.get("S");
};
const hw = (id, due, score) => ({ _id: id, subjectId: "mathematics", classId: "c", dueDate: due, maxScore: 20, isPublished: true, createdAt: due, version: 1, submission: { submittedAt: due, score, gradedAt: due } });
const quiz = (quizId, date, raw, attemptNumber = 1) => ({ _id: `${quizId}-${attemptNumber}`, quizId, subjectId: "mathematics", classId: "c", isPublished: true, status: "submitted", rawScore: raw, maxScore: 10, submittedAt: date, startedAt: date, attemptNumber });
const learning = (sources) => le.buildLearningEvidence({ pupilId: "S", schoolId: "A", sources, asOf: ASOF });
const build = (marks, { exams, learningEvidence = null, explorationEvidence = [] } = {}) =>
  strengths.buildStrengthProfile({ academicProfile: profileOf(marks, { exams }), explorationEvidence, learningEvidence, asOf: ASOF });

const STRONG = { Mathematics: [16, 17, 16, 17, 16] };
const twoHw = [hw("h1", "2027-04-01", 16), hw("h2", "2027-04-15", 17)];
const weak  = [hw("w1", "2027-04-01", 6), hw("w2", "2027-04-15", 7)];
const P = {
  INS:   build({ Mathematics: [16] }, { exams: 1 }),
  EMG:   build({ Mathematics: [16] }, { exams: 1, learningEvidence: learning({ homework: twoHw }) }),        // lifted by learning evidence
  EST:   build(STRONG),                                                                                        // UNSUPPORTED
  EST_C: build(STRONG, { learningEvidence: learning({ homework: twoHw }) }),                                   // CORROBORATED
  EST_Q: build(STRONG, { learningEvidence: learning({ homework: twoHw, quizAttempts: [quiz("q1", "2027-05-02", 9)] }) }),   // + QUIZ family
  EST_X: build(STRONG, { learningEvidence: learning({ homework: weak }) }),                                    // CONTRADICTED
  EST_1: build(STRONG, { learningEvidence: learning({ homework: [weak[0]] }) }),                               // one contradicting assignment
  DEC:   build({ Mathematics: [17, 17, 16, 10, 9] }),
};
const dim = (p) => [...p.strengths, ...p.emergingAreas, ...p.decliningAreas].find((x) => x.dimension === Q) ?? null;
check("fixtures read as intended: INSUFFICIENT, EMERGING, ESTABLISHED (unsupported / corroborated / contradicted), DECLINING",
  [dim(P.INS), dim(P.EMG)?.state, dim(P.EST)?.state, dim(P.EST)?.learningEvidence.relationship, dim(P.EST_C)?.learningEvidence.relationship, dim(P.EST_X)?.learningEvidence.relationship, dim(P.DEC)?.state],
  [null, "EMERGING", "ESTABLISHED", "UNSUPPORTED", "CORROBORATED", "CONTRADICTED", "DECLINING"]);

// Snapshots exactly as the service records them: readingOf(profile), versions, boundary. Distinct hashes unless stated.
const DATES = ["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15", "2027-01-15", "2027-04-15"];
const snap = (v, profile, { hash = `h${v}`, label = `T${v}`, at = DATES[v - 1], versions = {} } = {}) => ({
  _id: `snap-${v}`, profileVersion: v, asOf: at, generatedAt: at, periodLabel: label, evidenceBoundary: { hash },
  academicEngineVersion: "1.0.0", strengthEngineVersion: "1.2.0", explorationEngineVersion: "1.0.0", learningIntegrationVersion: "1.0.0", learningEvidenceVersion: "1.0.0", ...versions,
  profile: strengthsSvc.readingOf(profile),
});
const hist = (profiles, { asOf = ASOF, current = null, opts = [] } = {}) =>
  dev.buildDevelopmentHistory({ snapshots: profiles.map((p, i) => snap(i + 1, p, opts[i] ?? {})), current, asOf });
const tq = (h) => h.trajectories.find((t) => t.dimensionId === Q) ?? null;
const cur = (p, hash = "cur") => ({ profile: p, asOf: ASOF, boundaryHash: hash, explorationEngineVersion: "1.0.0" });

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. basic history ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let h = dev.buildDevelopmentHistory({ snapshots: [], current: cur(P.EST), asOf: ASOF });
  let t = tq(h);
  check("one observation: the current state stands (ESTABLISHED) and the trajectory is INSUFFICIENT_HISTORY — not stable, not rising, not declining",
    [h.developmentEngineVersion, t.currentState, t.trajectory, t.direction, t.persistence.observationCount, t.persistence.independentObservationCount, h.history.sufficient, t.quality.independence, t.reasons],
    ["1.0.0", "ESTABLISHED", "INSUFFICIENT_HISTORY", "insufficient", 1, 1, false, "INSUFFICIENT", ["INSUFFICIENT_HISTORY:1", "MODALITY_UNAVAILABLE:ASSIGNMENT", "MODALITY_UNAVAILABLE:ATTENDANCE", "MODALITY_UNAVAILABLE:COURSEWORK", "MODALITY_UNAVAILABLE:EXPLORATION", "MODALITY_UNAVAILABLE:INTEREST", "MODALITY_UNAVAILABLE:PRACTICAL", "MODALITY_UNAVAILABLE:QUIZ", "MODALITY_UNAVAILABLE:REFLECTION", "MODALITY_UNAVAILABLE:TEACHER_OBSERVATION"]]);
  h = hist([P.EST, P.EST]); t = tq(h);
  check("two independent observations, both ESTABLISHED: STABLE_ESTABLISHED, sustaining, no transition, two consecutive",
    [t.trajectory, t.direction, t.stateTransitions, t.persistence.consecutiveObservations, t.persistence.independentPeriods, h.history.sufficient], ["STABLE_ESTABLISHED", "sustaining", [], 2, 2, true]);
  h = hist([P.INS, P.EMG, P.EST_C]); t = tq(h);
  check("INSUFFICIENT → EMERGING → ESTABLISHED across three periods: STRENGTHENING, rising, two transitions dated to their observations",
    [t.trajectory, t.direction, t.stateTransitions.map((s) => [s.from, s.to, s.at.slice(0, 10)])], ["STRENGTHENING", "rising", [["INSUFFICIENT", "EMERGING", "2026-04-15"], ["EMERGING", "ESTABLISHED", "2026-07-15"]]]);
  h = hist([P.INS, P.EMG, P.EMG]); t = tq(h);
  check("INSUFFICIENT → EMERGING → EMERGING: EMERGING (the brief's example), first at the current state on the second observation",
    [t.trajectory, t.persistence.firstObservedAtCurrentState.slice(0, 10), t.explanation.map((l) => l.code)], ["EMERGING", "2026-04-15", ["CURRENT_STATE", "MOVED", "CORROBORATION_BEGAN", "COVERAGE_EXPANDED", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE", "MODALITY_UNAVAILABLE"]]);
  h = hist([P.EST, P.EST, P.DEC]); t = tq(h);
  check("ESTABLISHED → ESTABLISHED → DECLINING: the transition is named, the trajectory DECLINING, the explanation descriptive — no cause",
    [t.trajectory, t.stateTransitions.map((s) => `${s.from}>${s.to}`), /lost interest|less intelligent|less capable|lazy|because|cause/i.test(JSON.stringify(t.explanation))], ["DECLINING", ["ESTABLISHED>DECLINING"], false]);
  check("a dimension never observed has no trajectory; the ten are not padded", h.trajectories.map((x) => x.dimensionId), [Q]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. every supported transition ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const pair = (a, b) => { const x = tq(hist([P[a], P[b]])); return [x.stateTransitions.map((s) => `${s.from}>${s.to}`), x.trajectory, x.direction]; };
  check("INSUFFICIENT → EMERGING", pair("INS", "EMG"), [["INSUFFICIENT>EMERGING"], "EMERGING", "rising"]);
  check("EMERGING → ESTABLISHED", pair("EMG", "EST"), [["EMERGING>ESTABLISHED"], "STRENGTHENING", "rising"]);
  check("ESTABLISHED → EMERGING", pair("EST", "EMG"), [["ESTABLISHED>EMERGING"], "WEAKENING", "declining"]);
  check("EMERGING → DECLINING", pair("EMG", "DEC"), [["EMERGING>DECLINING"], "DECLINING", "declining"]);
  check("ESTABLISHED → DECLINING", pair("EST", "DEC"), [["ESTABLISHED>DECLINING"], "DECLINING", "declining"]);
  check("DECLINING → EMERGING", pair("DEC", "EMG"), [["DECLINING>EMERGING"], "RECOVERING", "rising"]);
  check("DECLINING → ESTABLISHED", pair("DEC", "EST"), [["DECLINING>ESTABLISHED"], "RECOVERING", "rising"]);
  check("same state twice is an observation without a transition, for all four states",
    [pair("EMG", "EMG"), pair("EST", "EST"), pair("DEC", "DEC"), tq(hist([P.INS, P.INS]))], [[[], "STABLE_EMERGING", "sustaining"], [[], "STABLE_ESTABLISHED", "sustaining"], [[], "STABLE_DECLINING", "sustaining"], null]);
  check("rose then fell: VARIABLE, both transitions kept", (() => { const x = tq(hist([P.EMG, P.EST, P.EMG])); return [x.trajectory, x.direction, x.stateTransitions.length]; })(), ["VARIABLE", "variable", 2]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. one event is no trend; coverage is not state ---");
  // ═══════════════════════════════════════════════════════════════════════════

  h = hist([P.EST, P.EST_1]); t = tq(h);
  let c = h.changes.find((x) => x.dimensionId === Q);
  check("ESTABLISHED, then one contradicting assignment, still ESTABLISHED: new evidence, no state transition, the relationship changed — no trend",
    [t.stateTransitions, t.trajectory, c.changeTypes.includes("EVIDENCE_ADDED"), c.changeTypes.includes("STATE_CHANGED"), c.changeTypes.includes("RELATIONSHIP_CHANGED"), c.reasonCodes.includes("NEW_EVIDENCE_WITHOUT_STATE_CHANGE")],
    [[], "STABLE_ESTABLISHED", true, false, true, true]);
  h = hist([P.EST, P.EST_C]); c = h.changes.find((x) => x.dimensionId === Q);
  check("a new evidence source (assignments) beside an unchanged state: EVIDENCE_COVERAGE_CHANGED and LEARNING_CORROBORATION_ADDED — never STATE_CHANGED",
    [c.changeTypes, c.reasonCodes], [["STATE_STABLE", "RELATIONSHIP_CHANGED", "EVIDENCE_ADDED", "EVIDENCE_COVERAGE_CHANGED"], ["LEARNING_CORROBORATION_ADDED", "NEW_EVIDENCE_WITHOUT_STATE_CHANGE", "EVIDENCE_COVERAGE_EXPANDED"]]);
  h = hist([P.EST_C, P.EST_Q]); c = h.changes.find((x) => x.dimensionId === Q); t = tq(h);
  check("quizzes begin: coverage expanded to ASSIGNMENT + QUIZ, first seen on the second observation, state and relationship unchanged",
    [c.changeTypes.includes("EVIDENCE_COVERAGE_CHANGED"), c.changeTypes.includes("STATE_CHANGED"), c.currentRelationship, t.evidenceCoverage.firstSeenFamily.QUIZ.slice(0, 10), t.evidenceCoverage.current.learning],
    [true, false, "CORROBORATED", "2026-04-15", { ASSIGNMENT: 2, QUIZ: 1 }]);
  check("an unavailable modality is coverage, not negative evidence: quality names it, conflicts NONE, the state untouched, and no coverage REDUCED code appears when a dimension first gains a context",
    [t.quality.missingModalities.includes("PRACTICAL"), t.quality.conflicts, t.currentState, hist([P.INS, P.EMG]).changes.find((x) => x.dimensionId === Q).reasonCodes.includes("EVIDENCE_COVERAGE_REDUCED")], [true, "NONE", "ESTABLISHED", false]);
  check("coverage counts describe availability: sittings, independent learning events per family, exploration events, observers, unavailable list — no percentage anywhere",
    [Object.keys(t.evidenceCoverage.current), /%|percent|score/i.test(JSON.stringify(t.evidenceCoverage))], [["academicSequences", "learning", "learningIndependentEvents", "learningStale", "exploration", "teacherObservers", "unavailable"], false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. contradictions over time ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const K = "ACADEMIC_VS_LEARNING_EVIDENCE";
  const con = (h) => h.contradictions.find((x) => x.kind === K) ?? null;
  h = hist([P.EST_C, P.EST_X]);
  check("corroborated then contradicted: a NEW contradiction, current, one occurrence; the change says CONTRADICTION_STARTED; the state is not downgraded",
    [con(h).status, con(h).current, con(h).occurrences, con(h).priority, h.changes.find((x) => x.dimensionId === Q).changeTypes.includes("CONTRADICTION_STARTED"), tq(h).currentState, tq(h).trajectory],
    ["NEW", true, 1, "NEW", true, "ESTABLISHED", "STABLE_ESTABLISHED"]);
  h = hist([P.EST_C, P.EST_X, P.EST_X]);
  check("contradicted in two consecutive observations: PERSISTENT, first T2, last T3, occurrences 2, independent periods 2; the academic state stays ESTABLISHED",
    [con(h).status, con(h).firstSeen.slice(0, 10), con(h).lastSeen.slice(0, 10), con(h).occurrences, con(h).independentPeriods, h.changes.filter((x) => x.dimensionId === Q).pop().changeTypes.includes("CONTRADICTION_PERSISTED"), tq(h).currentState, h.quality.contradictions.persistent],
    ["PERSISTENT", "2026-04-15", "2026-07-15", 2, 2, true, "ESTABLISHED", 1]);
  h = hist([P.EST_X, P.EST_C, P.EST_X]);
  check("seen, gone, seen again: RECURRING", [con(h).status, con(h).occurrences], ["RECURRING", 2]);
  h = hist([P.EST_X, P.EST_C], { asOf: "2026-06-01" });
  check("one later observation without it: INSUFFICIENT_HISTORY — not resolved; the change says not currently observed, never CONTRADICTION_RESOLVED",
    [con(h).status, con(h).current, h.changes.find((x) => x.dimensionId === Q).reasonCodes.includes("CONTRADICTION_NOT_CURRENTLY_OBSERVED"), h.changes.find((x) => x.dimensionId === Q).changeTypes.includes("CONTRADICTION_RESOLVED")],
    ["INSUFFICIENT_HISTORY", false, true, false]);
  h = hist([P.EST_X, P.EST_C, P.EST_C]);
  check("two later independent observations without it: RESOLVED, with the resolution date and evidence; the history keeps first and last sighting",
    [con(h).status, con(h).resolutionDate.slice(0, 10), con(h).resolutionEvidence.map((e) => [e.observedAt.slice(0, 10), e.relationship]), con(h).firstSeen.slice(0, 10), con(h).lastSeen.slice(0, 10), tq(h).quality.conflicts],
    ["RESOLVED", "2026-04-15", [["2026-04-15", "CORROBORATED"], ["2026-07-15", "CORROBORATED"]], "2026-01-15", "2026-01-15", "HISTORICAL"]);
  h = dev.buildDevelopmentHistory({ snapshots: [snap(1, P.EST_X, { at: "2025-01-15" }), snap(2, P.EST_C, { at: "2026-10-15" })], asOf: "2026-11-01" });
  check("last seen more than a year ago and absent since: STALE — still listed, still with its dates", [con(h).status, con(h).firstSeen.slice(0, 10)], ["STALE", "2025-01-15"]);
  check("a historical contradiction stays visible in the trajectory after later agreement", tq(hist([P.EST_X, P.EST_C, P.EST_C])).contradictions.length, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. retraction ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const s1 = snap(1, P.EST_C), before = JSON.stringify(s1);
  h = dev.buildDevelopmentHistory({ snapshots: [s1], current: cur(P.EST), asOf: ASOF });
  c = h.changes.find((x) => x.dimensionId === Q);
  check("corroboration retracted: the next reading is UNSUPPORTED with LEARNING_CORROBORATION_LOST and EVIDENCE_RETRACTED; the state stays ESTABLISHED; the snapshot is byte-identical",
    [c.currentRelationship, c.reasonCodes.includes("LEARNING_CORROBORATION_LOST"), c.changeTypes.includes("EVIDENCE_RETRACTED"), c.changeTypes.includes("STATE_CHANGED"), JSON.stringify(s1) === before, /ability|declin/i.test(c.reasonCodes.join(" "))],
    ["UNSUPPORTED", true, true, false, true, false]);
  h = dev.buildDevelopmentHistory({ snapshots: [snap(1, P.EST_X, { at: "2027-03-15" })], current: cur(P.EST), asOf: ASOF });
  check("a contradiction can change after a retraction: no longer observed, too soon to call resolved", [con(h).status, h.changes.find((x) => x.dimensionId === Q).reasonCodes.includes("CONTRADICTION_NOT_CURRENTLY_OBSERVED")], ["INSUFFICIENT_HISTORY", true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. asOf and replay ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const snaps = [snap(1, P.INS), snap(2, P.EMG), snap(3, P.EST_C)];
  const replay = (asOf) => dev.buildDevelopmentHistory({ snapshots: snaps, current: cur(P.EST_Q), asOf });
  check("asOf 2026-03-01: only the first snapshot exists; the current reading (dated later) does not; INSUFFICIENT_HISTORY",
    [replay("2026-03-01").observations.length, tq(replay("2026-03-01"))?.trajectory ?? null, replay("2026-03-01").history.sufficient], [1, null, false]);
  check("asOf 2026-08-01: three snapshots, no current; STRENGTHENING", [replay("2026-08-01").observations.length, tq(replay("2026-08-01")).trajectory], [3, "STRENGTHENING"]);
  check("the same asOf twice is byte-identical; a different asOf differs only by what existed", [JSON.stringify(replay("2026-08-01")) === JSON.stringify(replay("2026-08-01")), JSON.stringify(replay("2026-08-01")) === JSON.stringify(replay(ASOF))], [true, false]);
  check("the same snapshots and the same current boundary give the same result; a different boundary gives a different one",
    [JSON.stringify(replay(ASOF)) === JSON.stringify(dev.buildDevelopmentHistory({ snapshots: [...snaps].reverse(), current: cur(P.EST_Q), asOf: ASOF })),
     JSON.stringify(replay(ASOF)) === JSON.stringify(dev.buildDevelopmentHistory({ snapshots: snaps, current: cur(P.EST_X, "other"), asOf: ASOF }))], [true, false]);
  let threw = false; try { dev.buildDevelopmentHistory({ snapshots: snaps }); } catch { threw = true; }
  check("asOf is required — the engine never reaches for the clock", threw, true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. independence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  h = hist([P.EST, P.EST, P.EST], { opts: [{ hash: "same" }, { hash: "same" }, { hash: "same" }] }); t = tq(h);
  check("three snapshots on one evidence boundary are ONE observation: no persistence, INSUFFICIENT_HISTORY, no change events",
    [t.persistence.observationCount, t.persistence.independentObservationCount, t.trajectory, h.changes.length], [3, 1, "INSUFFICIENT_HISTORY", 0]);
  const retries = build(STRONG, { learningEvidence: learning({ homework: twoHw, quizAttempts: [quiz("q1", "2027-05-01", 6, 1), quiz("q1", "2027-05-02", 8, 2), quiz("q1", "2027-05-03", 9, 3)] }) });
  h = hist([P.EST_C, retries]); t = tq(h);
  check("three attempts at one quiz are one learning event in the coverage: ASSIGNMENT 2, QUIZ 1", t.evidenceCoverage.current.learning, { ASSIGNMENT: 2, QUIZ: 1 });
  const oneProject = ["performance", "teacher_observation", "student_reflection"].map((kind, i) => ({ _id: `e${i}`, kind, source: kind === "performance" ? "teacher" : kind === "teacher_observation" ? "teacher" : "student", dimension: Q, area: "mathematical", activity: "bridge model", date: "2027-04-20", recordedBy: kind === "student_reflection" ? "S" : "t1", explorationId: "x1", outcome: kind === "performance" ? "strong: built it" : null, reflection: kind === "student_reflection" ? "enjoyed_it" : null }));
  const projectP = build(STRONG, { explorationEvidence: oneProject });
  h = hist([P.EST, projectP]); t = tq(h);
  check("a performance, an observation and a reflection from ONE project are one exploration event, not three", [t.evidenceCoverage.current.exploration, t.evidenceCoverage.current.teacherObservers], [1, 1]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. determinism, no score, no prediction, versions, privacy ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const full = () => hist([P.INS, P.EMG, P.EST_X, P.EST_C, P.EST_Q], { current: cur(P.EST_Q) });
  check("the same inputs give byte-identical output", JSON.stringify(full()) === JSON.stringify(full()), true);
  const srcDir = path.join(ROOT, "..", "shared", "development");
  // The engine names the forbidden keys once, to refuse them; that declaration is not an emission.
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), "utf8")).join("\n").replace(/const FORBIDDEN_KEYS = [^\n]*\n/, "");
  const FORBIDDEN = /developmentScore|growthScore|talentScore|potentialScore|abilityScore|intelligenceScore|careerScore/;
  const strip = (o) => JSON.stringify(o).replace(/"notInferred":\[[^\]]*\]/g, "");
  check("no forbidden score key in the engine or its output; no growth percentage; no career, personality or prediction anywhere but the not-inferred list",
    [FORBIDDEN.test(src), FORBIDDEN.test(strip(full())), /growthRate|percent|%/.test(strip(full())), /career|personality|psycholog|predict|potential/i.test(strip(full()))], [false, false, false, false]);
  check("the engine is pure: no I/O, no clock, no randomness, no network, no database", [/require\(["'](fs|http|https|mongoose|axios|crypto)["']\)/.test(src), /Date\.now\(\)|new Date\(\)/.test(src), /Math\.random/.test(src)], [false, false, false]);
  check("the engine is name-free: no name, email, phone or address field is read or written", /studentName|teacherName|\bemail\b|\bphone\b|\baddress\b/.test(src), false);
  check("the output carries no reflection text and no name", [/"reflection"|enjoyed_it|studentName/.test(JSON.stringify(hist([P.EST, projectP]))), /Pupil|Mme /.test(JSON.stringify(full()))], [false, false]);
  const old = { ...snap(1, P.EST, { versions: { strengthEngineVersion: "1.1.0", learningIntegrationVersion: null, learningEvidenceVersion: null } }) };
  delete old.profile.learningIntegration; old.profile.strengths = old.profile.strengths.map(({ learningEvidence, corroboration, context, interpretation, academic, ...d }) => d);
  h = dev.buildDevelopmentHistory({ snapshots: [old, snap(2, P.EST_C)], asOf: ASOF }); t = tq(h);
  check("a 1.1.0 snapshot keeps its own version in the history; nothing is reinterpreted; the change names PROFILE_VERSION_CHANGED; its relationship stays null",
    [h.observations[0].versions.strengths, h.observations[1].versions.strengths, h.versions.observed.length, t.observations[0].relationship, h.changes.find((x) => x.dimensionId === Q).reasonCodes.includes("PROFILE_VERSION_CHANGED")],
    ["1.1.0", "1.2.0", 2, null, true]);
  check("the engines beneath are untouched: academic 1.0.0, strengths 1.2.0, exploration 1.0.0, learning evidence 1.0.0, integration 1.0.0; development 1.0.0",
    [P.EST.academicEngineVersion, strengths.STRENGTH_ENGINE_VERSION, exploration.EXPLORATION_ENGINE_VERSION, le.LEARNING_EVIDENCE_VERSION, strengths.LEARNING_INTEGRATION_VERSION, dev.DEVELOPMENT_ENGINE_VERSION],
    ["1.0.0", "1.2.0", "1.0.0", "1.0.0", "1.0.0", "1.0.0"]);
  const cmp = dev.compareDevelopmentSnapshots({ previous: snap(1, P.EST_C), current: snap(2, P.EST_X) });
  check("compareDevelopmentSnapshots: relationship change and a new contradiction; nothing from ordering or ids",
    [cmp.stateChanges.length, cmp.relationshipChanges.length, cmp.newContradictions.length, cmp.coverageChanges.length, cmp.versionsChanged,
     JSON.stringify(dev.compareDevelopmentSnapshots({ previous: snap(1, P.EST_C), current: { ...snap(2, P.EST_C, { hash: "h1" }), _id: "another-id", generatedAt: "2030-01-01" } }).changes.map((x) => x.changeTypes))],
    [0, 1, 1, 0, false, JSON.stringify([["STATE_STABLE", "RELATIONSHIP_STABLE", "NO_MEANINGFUL_CHANGE"]])]);
  check("the change vocabulary is the documented enum; no STUDENT_IMPROVED / STUDENT_WORSENED", [dev.CHANGE_TYPES.length, /IMPROVED|WORSENED/.test(dev.CHANGE_TYPES.join(" "))], [14, false]);

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
  await M("Exam").create([mkExam("t1", "test", 1, 1, "2027-01-10"), mkExam("t2", "test", 1, 2, "2027-02-10"), mkExam("t3", "test", 2, 1, "2027-03-10"), mkExam("t4", "test", 2, 2, "2027-04-10")]);
  const sc = (examId, v) => ({ examId, studentId: "st-a1", subjectId: "maths", classId: "form3a", schoolId: A, score: v, maxScore: 20, passMark: 10 });
  await M("StudentScore").create([sc("t1", 16), sc("t2", 17), sc("t3", 16), sc("t4", 17)]);
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
  const teacherA = as("teach-a", "teacher", A), teacherC = as("teach-c", "teacher", A), head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A), guardian = call(portalToken);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;
  const reads = ["development", "development/changes", "development/evidence"].map((k) => `/insights/student/st-a1/${k}`);
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));
  const TQ = (d) => d.trajectories.find((x) => x.dimensionId === Q);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. the routes: history from real snapshots ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.get(reads[0]);
  check("before any snapshot: one observation (today's reading), ESTABLISHED and CORROBORATED, INSUFFICIENT_HISTORY, engine 1.0.0 over the five beneath",
    [rr.status, rr.body.data.engineVersion, rr.body.data.history.observationCount, TQ(rr.body.data).currentState, TQ(rr.body.data).currentRelationship, TQ(rr.body.data).trajectory, rr.body.data.versions.current],
    [200, "1.0.0", 1, "ESTABLISHED", "CORROBORATED", "INSUFFICIENT_HISTORY", { academic: "1.0.0", strengths: "1.2.0", exploration: "1.0.0", learningIntegration: "1.0.0", learningEvidence: "1.0.0" }]);
  rr = await teacherA.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 1" });
  const v1 = rr.body.data;
  rr = await teacherA.get(reads[0]);
  check("a snapshot taken today and today's reading share one evidence boundary: two observations, one independent, still INSUFFICIENT_HISTORY — recording a day twice is not persistence",
    [v1.profileVersion, rr.body.data.history.observationCount, rr.body.data.history.independentObservationCount, TQ(rr.body.data).trajectory, rr.body.data.observations[0].periodLabel], [1, 2, 1, "INSUFFICIENT_HISTORY", "Term 1"]);
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { "submissions.0.score": 5 } });
  rr = await head.post("/insights/student/st-a1/profile/rebuild", { periodLabel: "Term 2" });
  rr = await teacherA.get(reads[0]);
  let d = rr.body.data, x = TQ(d);
  check("a corrected mark, then snapshot 2: two independent observations, STABLE_ESTABLISHED, the relationship moved CORROBORATED → PARTIALLY_CORROBORATED, one change event with a new contradiction",
    [d.history.independentObservationCount, x.trajectory, x.stateTransitions, x.relationshipTransitions.map((r) => [r.from, r.to]), d.changes.filter((c) => c.dimensionId === Q).map((c) => c.changeTypes), d.contradictions.map((c) => [c.kind, c.status, c.occurrences])],
    [2, "STABLE_ESTABLISHED", [], [["CORROBORATED", "PARTIALLY_CORROBORATED"]], [["STATE_STABLE", "RELATIONSHIP_CHANGED", "CONTRADICTION_STARTED"]], [["ACADEMIC_VS_LEARNING_EVIDENCE", "NEW", 1]]]);
  await M("Homework").updateOne({ _id: "hw2" }, { $set: { deletedAt: new Date() } });
  rr = await teacherA.get(`${reads[1]}?dimensionId=${Q}`);
  check("the homework retracted: the latest change says EVIDENCE_RETRACTED, the contradiction is not currently observed (too soon to call resolved), no state change; the filter is echoed",
    [rr.status, rr.body.data.filter.dimensionId, rr.body.data.changes.length, rr.body.data.changes[1].changeTypes.includes("EVIDENCE_RETRACTED"), rr.body.data.changes[1].reasonCodes.includes("CONTRADICTION_NOT_CURRENTLY_OBSERVED"), rr.body.data.changes[1].changeTypes.includes("STATE_CHANGED"), rr.body.data.contradictions[0].status],
    [200, Q, 2, true, true, false, "INSUFFICIENT_HISTORY"]);
  check("snapshot 1 is untouched by everything after it", (await M("StrengthProfileSnapshot").findOne({ profileVersion: 1 }).lean()).evidenceBoundary.hash === v1.evidenceBoundary.hash, true);
  rr = await teacherA.get(`${reads[1]}?from=2000-01-01&to=2000-12-31`);
  check("a date window with nothing in it returns no changes, deterministically", [rr.body.data.changes, rr.body.data.filter.from], [[], "2000-01-01T00:00:00.000Z"]);
  rr = await teacherA.get(reads[2]);
  check("/development/evidence: per trajectory the supporting event references (id, family, subject, date, recency — no note), the coverage and the changes with their boundaries",
    [rr.status, rr.body.data.evidence[0].dimensionId, rr.body.data.evidence[0].supportingEvents.map((e) => e.eventId), Object.keys(rr.body.data.evidence[0].supportingEvents[0]).includes("normalizedValue"), /done/.test(JSON.stringify(rr.body)), rr.body.data.evidence[0].changes.length],
    [200, Q, ["homework:hw1"], true, false, 2]);
  rr = await teacherA.get(`${reads[0]}?asOf=2020-01-01`);
  check("historical replay: as of 2020 no snapshot existed; one observation, INSUFFICIENT_HISTORY", [rr.body.data.observations.map((o) => o.source), rr.body.data.history.sufficient], [["current"], false]);
  check("authorisation unchanged: the pupil reads their own; another pupil, the bursar, a teacher of another class → 403; Beta's head → 404; the operator only with a school",
    [await statuses(pupilA1, reads.map((u) => u.replace("st-a1", "me"))), (await pupilA2.get(reads[0])).status, await statuses(bursar, reads), await statuses(teacherC, reads), await statuses(headB, reads), await statuses(operator, reads.map(inA)), (await statuses(operator, reads)).every((s) => s !== 200)],
    [[200, 200, 200], 403, [403, 403, 403], [403, 403, 403], [404, 404, 404], [200, 200, 200], true]);
  rr = await pupilA1.get("/insights/student/me/development");
  check("the pupil's own view: history, why it changed, what is unclear — no score, no other pupil, no reviewer", [TQ(rr.body.data).explanation.length > 0, /score":|st-a2|Pupil A2|reviewedBy/.test(JSON.stringify(rr.body.data))], [true, false]);
  rr = await guardian.get("/portal/children/st-a1/development");
  check("the guardian: what is developing / consistent / changing / too early, what supports it, what is unclear — no codes beyond states, no reviewer, no note",
    [rr.status, Object.keys(rr.body.data).filter((k) => ["developing", "consistent", "changing", "tooEarly"].includes(k)).length, rr.body.data.consistent[0]?.dimension, rr.body.data.consistent[0]?.history.length, /reviewedBy|notes|done|reasonCodes/.test(JSON.stringify(rr.body))],
    [200, 4, Q, 3, false]);
  check("a child the access does not unlock → 404", (await guardian.get("/portal/children/st-a2/development")).status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. live = offline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  rr = await teacherA.get("/insights/student/st-a1/consistency");
  check("the development history through both roads is identical; every new difference class is named and false",
    [rr.status, rr.body.data.identical, rr.body.data.development.identical, rr.body.data.development.differences, rr.body.data.development.engineVersion,
     ["trajectory", "transitions", "changeTypes", "changeReasons", "quality", "persistence", "state", "relationship", "contradictions", "versions"].every((k) => rr.body.data.development.summary[k] === false)],
    [200, true, true, [], { live: "1.0.0", offline: "1.0.0" }, true]);
  const devSvc = require(path.join(SRC, "services/intelligence/development.service"));
  const at = new Date(ASOF);
  const [liveH, offH] = await Promise.all([devSvc.historyFor({ schoolId: A, studentId: "st-a1", asOf: at }), devSvc.offlineHistoryFor({ schoolId: A, studentId: "st-a1", asOf: at })]);
  check("and directly: JSON-identical histories from the live loader and the mirrored documents", JSON.stringify(liveH) === JSON.stringify(offH), true);
  check("no persistent development-history model: the history is derived from StrengthProfileSnapshot and the current reading (DevelopmentPlan, Stage 16, is a plan record, not a history)", mongoose.modelNames().some((n) => /DevelopmentHistory|Trajectory|DevelopmentSnapshot/i.test(n)), false);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
