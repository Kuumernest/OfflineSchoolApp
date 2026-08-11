// backend/src/utils/gradeUtils.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GRADE UTILITIES — Cameroon Anglophone Education System
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Scale (marks out of 20):
 * ┌──────────────┬───────┬────────┬──────────────────┐
 * │ Mark (/20)   │ Grade │ Points │ Remark           │
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
 * Passing threshold: 10/20
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Grade Scale ───────────────────────────────────────────────────────────

const GRADE_SCALE = [
  { min: 18.0, max: 20.0,  grade: "A+", points: 4.0, remark: "Excellent"   },
  { min: 16.0, max: 17.99, grade: "A",  points: 3.7, remark: "Very Good"   },
  { min: 14.0, max: 15.99, grade: "B+", points: 3.3, remark: "Good"        },
  { min: 12.0, max: 13.99, grade: "B",  points: 3.0, remark: "Fairly Good" },
  { min: 10.0, max: 11.99, grade: "C",  points: 2.0, remark: "Average"     },
  { min: 8.0,  max: 9.99,  grade: "D",  points: 1.0, remark: "Poor"        },
  { min: 0.0,  max: 7.99,  grade: "F",  points: 0.0, remark: "Very Poor"   },
];

const PASSING_MARK = 10; // out of 20

// ── Core Functions ────────────────────────────────────────────────────────

/**
 * Normalize a raw score to the /20 Cameroon scale.
 *
 * @param {number} score    Raw score obtained
 * @param {number} maxScore Maximum possible score
 * @returns {number}        Score on 0–20 scale, rounded to 2 decimals
 */
const normalizeTo20 = (score, maxScore) => {
  if (!maxScore || maxScore <= 0)          return 0;
  if (score == null || isNaN(score))       return 0;
  const normalized = (score / maxScore) * 20;
  return Math.round(normalized * 100) / 100;
};

/**
 * Look up grade entry for a mark on the /20 scale.
 *
 * @param {number} markOutOf20
 * @returns {{ grade: string, points: number, remark: string }}
 */
const lookupGrade = (markOutOf20) => {
  if (markOutOf20 == null || isNaN(markOutOf20)) {
    return { grade: "F", points: 0, remark: "Very Poor" };
  }
  const clamped = Math.max(0, Math.min(20, markOutOf20));
  const entry   = GRADE_SCALE.find(
    (s) => clamped >= s.min && clamped <= s.max
  );
  return entry
    ? { grade: entry.grade, points: entry.points, remark: entry.remark }
    : { grade: "F", points: 0, remark: "Very Poor" };
};

/**
 * Grade a single subject score.
 *
 * @param {number} score    Raw score
 * @param {number} maxScore Max score for this subject
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
const gradeSubject = (score, maxScore) => {
  const normalizedMark  = normalizeTo20(score, maxScore);
  const { grade, points, remark } = lookupGrade(normalizedMark);
  const isPassing = normalizedMark >= PASSING_MARK;
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
};

/**
 * Returns { grade, points, remark } for a percentage (0–100).
 * Converts percentage → /20 then looks up.
 *
 * @param {number} pct  0–100
 */
const getGrade = (pct) => {
  if (pct == null || isNaN(pct)) {
    return { grade: "F", points: 0, remark: "Very Poor" };
  }
  const markOutOf20 = (pct / 100) * 20;
  return lookupGrade(markOutOf20);
};

/**
 * Overall remark based on aggregate percentage.
 *
 * @param {number} pct 0–100
 * @returns {string}
 */
const getOverallRemark = (pct) => {
  if (pct >= 90) return "Outstanding";
  if (pct >= 75) return "Excellent";
  if (pct >= 65) return "Very Good";
  if (pct >= 55) return "Good";
  if (pct >= 50) return "Average";
  if (pct >= 40) return "Below Average";
  return "Poor";
};

/**
 * Generate a principal / teacher comment based on overall result.
 *
 * @param {{ overallGrade: string, isPassing: boolean }} result
 * @returns {string}
 */
const generateRemark = (result) => {
  const g = result?.overallGrade;
  if (g === "A+") return "Outstanding performance. Keep it up!";
  if (g === "A")  return "Excellent work. Continue with this momentum.";
  if (g === "B+") return "Good performance. Aim higher next term.";
  if (g === "B")  return "Fairly good. More effort needed for excellence.";
  if (g === "C")  return "Average performance. Needs significant improvement.";
  if (g === "D")  return "Below average. Serious effort required.";
  return "Very poor performance. Must improve drastically.";
};

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  GRADE_SCALE,
  PASSING_MARK,
  normalizeTo20,
  lookupGrade,
  gradeSubject,
  getGrade,
  getOverallRemark,
  generateRemark,
};