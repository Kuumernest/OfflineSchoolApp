// backend/scripts/check-ca-double-count.js
"use strict";

/**
 * docs/39 §4.6(d): continuous assessment counted twice by the strengths
 * engine — FIXED (LEARNING_INTEGRATION_VERSION 1.1.0, cohort FORMAT_VERSION 2),
 * on the real shared engines (no database).
 *
 * The strengths engine treats a CA mark as an independent COURSEWORK event
 * that may corroborate the academic reading (shared/strengths/
 * learningIntegration.js). That premise holds only where the academic mark is
 * the paper alone:
 *
 *   - Before the decided calculation (exam-process/1): the sequence mark is the
 *     PAPER. CA is outside it, so counting CA once as coursework is correct.
 *   - The decided calculation (exam-process/3, every school since 2026-10-16):
 *     the sequence mark is CA-BLENDED when the school has CA on. Counting the
 *     same CA again lifted the reading a step on evidence it had already used.
 *
 * The fix: the academic profile carries, per mark, the CA blended into it
 * (`caMark`, from ResultSummary.subjectBreakdown live and from the cohort's
 * format 2 rows offline, so live = offline). A CA event of the same subject
 * and occasion as a mark with a caMark is baseline evidence: reported in
 * baselineEventsNotRecounted, not counted.
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
const profileOf = (marks, caMark = null) => runEngine({
  format: "osa-intelligence-cohort", formatVersion: 2, provenance: { kind: "synthetic", note: "§4.6d" },
  grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 }, exams: EXAMS,
  students: [{ studentId: "S", classId: "C" }], interventions: [],
  results: marks.map((m, i) => ({ resultId: `R${i}`, studentId: "S", classId: "C", examId: EXAMS[i].examId, isPublished: true,
    subjects: [{ subjectId: "mathematics", subjectName: "Mathematics", normalizedMark: m, score: m, maxScore: 20, coefficient: 1,
      caMark, isAbsent: false, isExempt: false }] })),
}).profiles.get("S");

/** The CA marks of those same two sequences, as learning evidence reads them (StudentScore of a "ca" exam). */
const caOfTheSameSequences = le.buildLearningEvidence({ pupilId: "S", schoolId: "A", asOf: ASOF, sources: {
  scores: EXAMS.map((e, i) => ({ _id: `ca-${i}`, examId: `C${i + 1}`, subjectId: "mathematics", classId: "c", examType: "ca",
    academicYear: e.academicYear, term: e.term, sequenceNumber: e.sequenceNumber, startDate: e.startDate, resultsPublished: true,
    score: 18, maxScore: 20, isAbsent: false, isExempt: false, version: 1 })),
} });

const reading = (marks, learningEvidence, caMark = null) => {
  const p = strengths.buildStrengthProfile({ academicProfile: profileOf(marks, caMark), learningEvidence, explorationEvidence: [], asOf: ASOF });
  const d = [...p.strengths, ...p.emergingAreas, ...p.decliningAreas].find((x) => x.dimension === Q) ?? null;
  return d ? [d.baseState, d.state, d.interpretation.stateSource, d.learningEvidence.sourceFamilies, p.learningIntegration.baselineEventsNotRecounted] : null;
};

/*
 * Two sequences. Paper 14.67 and CA 18 each time, CA 40 / paper 60:
 *   before the decision (exam-process/1)  the academic mark is the paper alone → 14.7, no caMark
 *   decided calculation (exam-process/3)  the academic mark is 0.4·18 + 0.6·14.67 = 7.2 + 8.8 = 16,
 *                                         with caMark 18
 */
console.log("--- the same two CA marks, beside a paper-only and a CA-blended reading ---");
check("version", strengths.LEARNING_INTEGRATION_VERSION ?? require(path.join(ROOT, "..", "shared", "strengths", "learningIntegration")).LEARNING_INTEGRATION_VERSION, "1.1.0");
check("paper-only mark (no caMark): the CA, outside it, corroborates once as COURSEWORK and lifts a step — unchanged",
  reading([14.7, 14.7], caOfTheSameSequences), ["EMERGING", "ESTABLISHED", "learning_evidence", ["COURSEWORK"], 0]);
check("blended 16 without any learning evidence: EMERGING",
  reading([16, 16], null, 18), ["EMERGING", "EMERGING", "academic", [], 0]);
check("[§4.6d, FIXED] blended 16 with caMark 18: the CA already inside it is baseline — no lift, source academic, " +
  "the 2 CA events reported as not recounted",
  reading([16, 16], caOfTheSameSequences, 18), ["EMERGING", "EMERGING", "academic", [], 2]);
check("a CA of another occasion is still independent: the same two CA events against marks of term 2 lift as before",
  (() => {
    const other = le.buildLearningEvidence({ pupilId: "S", schoolId: "A", asOf: ASOF, sources: {
      scores: [0, 1].map((i) => ({ _id: `ca-x${i}`, examId: `X${i}`, subjectId: "mathematics", classId: "c", examType: "ca",
        academicYear: "2026-2027", term: 2, sequenceNumber: 3 + i, startDate: `2027-0${1 + i}-15`, resultsPublished: true,
        score: 18, maxScore: 20, isAbsent: false, isExempt: false, version: 1 })) } });
    return reading([16, 16], other, 18);
  })(), ["EMERGING", "ESTABLISHED", "learning_evidence", ["COURSEWORK"], 0]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
