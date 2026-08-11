// backend/src/services/grading.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GRADING SERVICE — Cameroon Anglophone Education System
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles:
 *   - Per-subject grading (normalized to /20 scale)
 *   - Overall student grading (GPA + aggregate)
 *   - Grade scale configuration
 *   - Remark generation
 *
 * Scale Reference (Cameroon Anglophone):
 * ┌──────────────┬───────┬────────┬──────────────────┐
 * │ Mark (out 20)│ Grade │ Points │ Remark           │
 * ├──────────────┼───────┼────────┼──────────────────┤
 * │ 18.00 – 20   │  A+   │  4.0   │ Excellent        │
 * │ 16.00 – 17.99│  A    │  3.7   │ Very Good        │
 * │ 14.00 – 15.99│  B+   │  3.3   │ Good             │
 * │ 12.00 – 13.99│  B    │  3.0   │ Fairly Good      │
 * │ 10.00 – 11.99│  C    │  2.0   │ Average          │
 * │ 08.00 – 09.99│  D    │  1.0   │ Poor             │
 * │ 00.00 – 07.99│  F    │  0.0   │ Very Poor        │
 * └──────────────┴───────┴────────┴──────────────────┘
 *
 * Passing threshold = 10/20
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Grade Scale Definition ────────────────────────────────────────────────

const GRADE_SCALE = [
  { min: 18.0, max: 20.0,  grade: "A+", points: 4.0, remark: "Excellent"   },
  { min: 16.0, max: 17.99, grade: "A",  points: 3.7, remark: "Very Good"   },
  { min: 14.0, max: 15.99, grade: "B+", points: 3.3, remark: "Good"        },
  { min: 12.0, max: 13.99, grade: "B",  points: 3.0, remark: "Fairly Good" },
  { min: 10.0, max: 11.99, grade: "C",  points: 2.0, remark: "Average"     },
  { min: 8.0,  max: 9.99,  grade: "D",  points: 1.0, remark: "Poor"        },
  { min: 0.0,  max: 7.99,  grade: "F",  points: 0.0, remark: "Very Poor"   },
];

const PASSING_MARK_OUT_OF_20 = 10;

// ── Core Grading Functions ────────────────────────────────────────────────

/**
 * Normalize a raw score to the /20 Cameroon scale.
 *
 * @param {number} score    The raw score obtained
 * @param {number} maxScore The maximum possible score for the subject
 * @returns {number} Score normalized to 0–20 scale, rounded to 2 decimals
 */
function normalizeTo20(score, maxScore) {
  if (!maxScore || maxScore <= 0)    return 0;
  if (score == null || isNaN(score)) return 0;
  const normalized = (score / maxScore) * 20;
  return Math.round(normalized * 100) / 100;
}

/**
 * Look up a grade entry from the scale for a given /20 mark.
 *
 * @param {number} markOutOf20 Mark on the 0–20 scale
 * @returns {{ grade: string, points: number, remark: string }}
 */
function lookupGrade(markOutOf20) {
  const clamped = Math.max(0, Math.min(20, markOutOf20 ?? 0));
  for (const entry of GRADE_SCALE) {
    if (clamped >= entry.min && clamped <= entry.max) {
      return {
        grade:  entry.grade,
        points: entry.points,
        remark: entry.remark,
      };
    }
  }
  // Fallback — should never reach here
  return { grade: "F", points: 0, remark: "Very Poor" };
}

/**
 * Grade a single subject score.
 *
 * @param {number} score    Raw score
 * @param {number} maxScore Max score for this subject (from ExamSubject)
 * @returns {{
 *   score: number,
 *   maxScore: number,
 *   normalizedMark: number,
 *   grade: string,
 *   points: number,
 *   remark: string,
 *   isPassing: boolean,
 *   percentage: number,
 * }}
 */
function gradeSubject(score, maxScore) {
  const normalizedMark = normalizeTo20(score, maxScore);
  const { grade, points, remark } = lookupGrade(normalizedMark);
  const isPassing  = normalizedMark >= PASSING_MARK_OUT_OF_20;
  const percentage = maxScore > 0
    ? Math.round((score / maxScore) * 10000) / 100
    : 0;

  return {
    score,
    maxScore,
    normalizedMark,
    grade,
    points,
    remark,
    isPassing,
    percentage,
  };
}

/**
 * Calculate the overall result for a student across all subjects.
 *
 * @param {Array<{
 *   score: number,
 *   maxScore: number,
 *   isAbsent: boolean,
 *   isExempt?: boolean,
 *   subjectName?: string,
 *   subjectId: string,
 * }>} subjectScores
 *
 * @returns {{
 *   totalScore: number,
 *   maxTotalScore: number,
 *   percentage: number,
 *   normalizedAverage: number,
 *   overallGrade: string,
 *   overallRemark: string,
 *   gpa: number,
 *   isPassing: boolean,
 *   subjectsPassed: number,
 *   subjectsFailed: number,
 *   subjectsTotal: number,
 *   subjectsAbsent: number,
 *   subjectBreakdown: Array
 * }}
 */
function calculateOverallResult(subjectScores) {
  const gradedSubjects = subjectScores.filter((s) => !s.isAbsent && !s.isExempt);
  const absentSubjects = subjectScores.filter((s) =>  s.isAbsent || s.isExempt);

  let totalRawScore  = 0;
  let totalMaxScore  = 0;
  let totalPoints    = 0;
  let subjectsPassed = 0;
  let subjectsFailed = 0;

  const subjectBreakdown = [];

  // Graded subjects
  for (const entry of gradedSubjects) {
    const result = gradeSubject(entry.score ?? 0, entry.maxScore ?? 100);

    totalRawScore += entry.score ?? 0;
    totalMaxScore += entry.maxScore ?? 100;
    totalPoints   += result.points;

    if (result.isPassing) subjectsPassed++;
    else                  subjectsFailed++;

    subjectBreakdown.push({
      subjectId:      entry.subjectId,
      subjectName:    entry.subjectName || null,
      score:          entry.score,
      maxScore:       entry.maxScore,
      normalizedMark: result.normalizedMark,
      grade:          result.grade,
      points:         result.points,
      remark:         result.remark,
      isPassing:      result.isPassing,
      percentage:     result.percentage,
      isAbsent:       false,
      isExempt:       false,
    });
  }

  // Absent / exempt subjects
  for (const entry of absentSubjects) {
    subjectsFailed++; // absent counts as failed

    subjectBreakdown.push({
      subjectId:      entry.subjectId,
      subjectName:    entry.subjectName || null,
      score:          null,
      maxScore:       entry.maxScore,
      normalizedMark: 0,
      grade:          entry.isExempt ? "EX" : "AB",
      points:         0,
      remark:         entry.isExempt ? "Exempt" : "Absent",
      isPassing:      false,
      percentage:     null,
      isAbsent:       entry.isAbsent  || false,
      isExempt:       entry.isExempt  || false,
    });
  }

  const subjectsGraded = gradedSubjects.length;
  const subjectsTotal  = subjectScores.length;
  const subjectsAbsent = absentSubjects.length;

  // Average on the /20 scale (GPA basis)
  const normalizedAverage = subjectsGraded > 0
    ? Math.round((totalPoints / subjectsGraded) * 100) / 100
    : 0;

  // Percentage on raw scores
  const percentage = totalMaxScore > 0
    ? Math.round((totalRawScore / totalMaxScore) * 10000) / 100
    : 0;

  // GPA
  const gpa = normalizedAverage; // same in Cameroon system

  // Overall grade from normalized average (convert back to /20 for lookup)
  const overall = lookupGrade(normalizedAverage * 5);

  // Passing if average GPA >= 2.0 (= C grade = 10/20)
  const isPassing = normalizedAverage >= 2.0;

  return {
    totalScore:        Math.round(totalRawScore * 100) / 100,
    maxTotalScore:     Math.round(totalMaxScore * 100) / 100,
    percentage:        Math.round(percentage * 100) / 100,
    normalizedAverage: Math.round(normalizedAverage * 100) / 100,
    overallGrade:      overall.grade,
    overallRemark:     overall.remark,
    gpa:               Math.round(gpa * 100) / 100,
    isPassing,
    subjectsPassed,
    subjectsFailed,
    subjectsTotal,
    subjectsAbsent,
    subjectBreakdown,
  };
}

/**
 * Generate a teacher/principal remark based on overall performance.
 *
 * @param {{ overallGrade: string, isPassing: boolean }} result
 * @returns {string}
 */
function generateRemark(result) {
  const g = result?.overallGrade;
  if (g === "A+") return "Outstanding performance. Keep it up!";
  if (g === "A")  return "Excellent work. Continue with this momentum.";
  if (g === "B+") return "Good performance. Aim higher next term.";
  if (g === "B")  return "Fairly good. More effort needed for excellence.";
  if (g === "C")  return "Average performance. Needs significant improvement.";
  if (g === "D")  return "Below average. Serious effort required.";
  return "Very poor performance. Must improve drastically.";
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  GRADE_SCALE,
  PASSING_MARK_OUT_OF_20,
  normalizeTo20,
  lookupGrade,
  gradeSubject,
  calculateOverallResult,
  generateRemark,
};