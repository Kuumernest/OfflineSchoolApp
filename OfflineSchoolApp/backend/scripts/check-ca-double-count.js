// backend/scripts/check-ca-double-count.js
"use strict";

/**
 * docs/39 §4.6(d): continuous assessment counted twice by the strengths
 * engine — reproduced, and pinned as the known defect it is, on the real
 * shared engines (no database).
 *
 * The strengths engine treats every CA mark as an independent COURSEWORK
 * event that corroborates the academic reading
 * (shared/strengths/learningIntegration.js: SUPPORTING_LEARNING_FAMILIES,
 * inBaseline). Its premise, in its own header, is that "CA is skipped by the
 * academic engine and is therefore independent".
 *
 *   - Default rule (raw_mean, the live route): the sequence mark the academic
 *     engine reads (subjectBreakdown.normalizedMark) is the PAPER alone. CA is
 *     outside it, so counting CA once as coursework is correct.
 *   - weighted_20 (and the unrouted results.service): the sequence mark is
 *     the CA-BLENDED mark. The same CA marks are then counted again as
 *     coursework — the premise fails, and the reading is lifted a step on
 *     evidence it has already used.
 *
 * No school runs weighted_20 today, so the double count is not reachable on
 * any school's data yet; it becomes reachable the day one chooses it (D1).
 * It is NOT fixed here: a fix needs the academic profile to say which marks
 * already contain CA, which the offline calibration cohort (FORMAT_VERSION 1,
 * a decision gate of its own) cannot carry, so a live-only fix would make
 * the live and offline readings disagree; and it changes the learning
 * integration's output, so LEARNING_INTEGRATION_VERSION must move, which an
 * open pilot reports as drift. See docs/39 §20.0, the defect-closure pass.
 *
 * When it is fixed, the "weighted_20" check below flips to the expected
 * reading named in its label (no lift, the CA counted as baseline).
 *
 *   node scripts/check-ca-double-count.js
 */

const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { runEngine } = require(path.join(ROOT, "scripts/calibration/analyseCohort"));
const strengths = require(path.join(ROOT, "..", "shared", "strengths"));
const le = require(path.join(ROOT, "..", "shared", "learningEvidence"));

const ASOF = "2027-06-01";
const Q = "quantitative_reasoning";
const EXAMS = [
  { examId: "P1", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { examId: "P2", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
];

/** The academic reading from two Mathematics sequence marks, through the real engine. */
const profileOf = (marks) => runEngine({
  format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "§4.6d" },
  grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 }, exams: EXAMS,
  students: [{ studentId: "S", classId: "C" }], interventions: [],
  results: marks.map((m, i) => ({ resultId: `R${i}`, studentId: "S", classId: "C", examId: EXAMS[i].examId, isPublished: true,
    subjects: [{ subjectId: "mathematics", subjectName: "Mathematics", normalizedMark: m, score: m, maxScore: 20, coefficient: 1, isAbsent: false, isExempt: false }] })),
}).profiles.get("S");

/** The CA marks of those same two sequences, as learning evidence reads them (StudentScore of a "ca" exam). */
const caOfTheSameSequences = le.buildLearningEvidence({ pupilId: "S", schoolId: "A", asOf: ASOF, sources: {
  scores: EXAMS.map((e, i) => ({ _id: `ca-${i}`, examId: `C${i + 1}`, subjectId: "mathematics", classId: "c", examType: "ca",
    academicYear: e.academicYear, term: e.term, sequenceNumber: e.sequenceNumber, startDate: e.startDate, resultsPublished: true,
    score: 18, maxScore: 20, isAbsent: false, isExempt: false, version: 1 })),
} });

const reading = (marks, learningEvidence) => {
  const p = strengths.buildStrengthProfile({ academicProfile: profileOf(marks), learningEvidence, explorationEvidence: [], asOf: ASOF });
  const d = [...p.strengths, ...p.emergingAreas, ...p.decliningAreas].find((x) => x.dimension === Q) ?? null;
  return d ? [d.baseState, d.state, d.interpretation.stateSource, d.learningEvidence.sourceFamilies, p.learningIntegration.baselineEventsNotRecounted] : null;
};

/*
 * Two sequences. Paper 14.67 and CA 18 each time, CA 40 / paper 60:
 *   raw_mean     the academic mark is the paper alone   → 14.7
 *   weighted_20  the academic mark is 0.4·18 + 0.6·14.67 → 16
 */
console.log("--- the same two CA marks, beside a paper-only and a CA-blended reading ---");
check("raw_mean: the academic reading is the paper (14.7); the CA, outside it, corroborates once as COURSEWORK and lifts a step — correct",
  reading([14.7, 14.7], caOfTheSameSequences), ["EMERGING", "ESTABLISHED", "learning_evidence", ["COURSEWORK"], 0]);
check("weighted_20 without any learning evidence: the blended 16 alone reads EMERGING",
  reading([16, 16], null), ["EMERGING", "EMERGING", "academic", [], 0]);
check("[§4.6d, KNOWN DEFECT] weighted_20: the CA already inside the 16 is counted again as COURSEWORK and lifts the reading " +
  "(correct: EMERGING, source academic, the 2 CA events counted as baseline, not recounted)",
  reading([16, 16], caOfTheSameSequences), ["EMERGING", "ESTABLISHED", "learning_evidence", ["COURSEWORK"], 0]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
