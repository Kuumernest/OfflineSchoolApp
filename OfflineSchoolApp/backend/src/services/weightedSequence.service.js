// backend/src/services/weightedSequence.service.js
"use strict";

/**
 * A pupil's sequence result: the calculation every school uses (shared/
 * academicRules, decided by the project owner, docs/39 §21.1) — calcVersion
 * "exam-process/3". exam-process/2 was the same arithmetic as an opt-in rule,
 * except that a CA with no paper mark counted alone.
 *
 * ── It is the figure the sequence card already prints ─────────────────────
 *
 * The card (results.controller buildStudentReportCardData) rebuilds each
 * subject from the marks: the paper and its CA blended by the school's split
 * (sequenceAssessment.blendSubject), normalised to /20, weighted by the
 * subject's coefficient (ExamSubject.weight ÷ 100), absent and exempt
 * subjects left out, and averaged to two decimals. It printed that as the
 * average while the stored result said something else (docs/39 §4.7f). Under
 * this rule the stored result IS that figure: the same building blocks, the
 * same rounding at the same steps, the same row set. check:sequencerules pins
 * stored average === card weightedAverage for every pupil.
 *
 * Pure: the caller loads the scores, exam subjects and CA context.
 */

const sequenceAssessment = require("./sequenceAssessment.service");
const { coefficientFromWeight } = require("./subjectCoefficient.service");

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} p
 * @param {string} p.studentId
 * @param {Array<object>} p.scores        this pupil's StudentScore rows for the paper
 * @param {Map<string, object>} p.subjectMap  ExamSubject by _id and by subjectId
 * @param {object} p.ca                   sequenceAssessment.loadSequenceContext(exam)
 * @param {object} p.exam
 * @param {(mark20: number) => {grade, remark, gpaPoints, isPassing}} p.grade
 *        grades a /20 mark with the school's bands and pass mark
 * @returns {{ subjectBreakdown: Array<object>, average: number, active: number,
 *             passed: number, failed: number, totalScore: number, maxTotalScore: number }}
 */
function weightedSequenceResult({ studentId, scores, subjectMap, ca, exam, grade }) {
  // A subject with CA and no paper row is listed, so its CA reaches the
  // stored breakdown and the card, but it does not count: no paper mark, no
  // subject (decided 2026-10-16; it counted the CA alone under
  // exam-process/2).
  const caOnly = [];
  if (ca.active) {
    const marked = new Set(scores.map((row) => String(row.subjectId)));
    for (const [key, caRow] of ca.caByKey) {
      const [sid, subjectId] = key.split("|");
      if (String(sid) !== String(studentId) || marked.has(subjectId)) continue;
      caOnly.push({
        subjectId, examSubjectId: null, score: null,
        maxScore: caRow.maxScore, isAbsent: false, isExempt: false,
      });
    }
  }

  const subjectBreakdown = [];
  let totalCoeff = 0, totalWeighted = 0, passed = 0, failed = 0, active = 0;
  let totalScore = 0, maxTotalScore = 0;

  for (const s of [...scores, ...caOnly]) {
    const es = subjectMap.get(String(s.examSubjectId)) || subjectMap.get(String(s.subjectId)) || {};
    // The card's precedence, so the two can never disagree about the scale.
    const maxScore = s.maxScore || es.maxScore || exam?.totalMarks || 100;
    const coeff    = coefficientFromWeight(es.weight);

    const blended = ca.active
      ? sequenceAssessment.blendSubject({
          ca:   ca.lookup(studentId, s.subjectId),
          test: { score: s.score, maxScore, isAbsent: s.isAbsent || false, isExempt: s.isExempt || false },
          settings: ca.settings,
        })
      : null;
    // Counted only with a paper mark: absent, exempt and not-entered papers
    // are left out, mark and coefficient, whatever CA the pupil has. A 0
    // entered by a teacher is a mark.
    const hasPaper  = s.score != null && !s.isAbsent && !s.isExempt;
    const effective = hasPaper ? (blended ? blended.score : s.score) : null;
    const counted   = hasPaper && effective != null;

    const normalizedMark = counted ? round2((effective / maxScore) * 20) : null;
    const weightedMark   = counted ? round2(normalizedMark * coeff) : null;

    maxTotalScore += maxScore;
    let graded = null;
    if (counted) {
      active += 1;
      totalScore    += effective;
      totalCoeff    += coeff;
      totalWeighted += weightedMark;
      graded = grade(normalizedMark);
      // The subject passes on the mark it prints — the blended one — not on
      // the paper alone (docs/39 §4.6l is the raw_mean rule's behaviour).
      if (graded.isPassing) passed += 1; else failed += 1;
    }

    subjectBreakdown.push({
      subjectId:    String(s.subjectId),
      subjectName:  es.subjectName || String(s.subjectId),
      score:        counted ? effective : null,
      maxScore,
      normalizedMark,
      coefficient:  coeff,
      weightedMark,
      caScore:      blended?.caScore      ?? null,
      caMaxScore:   blended?.caMaxScore   ?? null,
      caMark:       blended?.caMark       ?? null,
      testScore:    blended?.testScore    ?? null,
      testMaxScore: blended?.testMaxScore ?? null,
      testMark:     blended?.testMark     ?? null,
      caWeight:     blended?.caWeight     ?? null,
      testWeight:   blended?.testWeight   ?? null,
      grade:        graded?.grade     ?? null,
      points:       graded?.gpaPoints ?? null,
      remark:       graded ? graded.remark : (s.isAbsent ? "Absent" : s.isExempt ? "Exempt" : "No paper mark"),
      isPassing:    graded?.isPassing ?? false,
      isAbsent:     !!s.isAbsent,
      isExempt:     !!s.isExempt,
    });
  }

  const average = totalCoeff > 0 ? round2(totalWeighted / totalCoeff) : 0;
  return { subjectBreakdown, average, active, passed, failed, totalScore, maxTotalScore };
}

module.exports = { weightedSequenceResult };
