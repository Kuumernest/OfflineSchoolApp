// desktop/src/main/api/gradeUtils.js
"use strict";

/**
 * Grade computation for offline exam processing.
 *
 * Mirrors the server's computeGrade (backend/src/routes/exam.routes.js:87-110)
 * so the desktop produces the same percentage, letter grade, GPA points and
 * pass/fail flag the server would. The function is pure: given identical inputs
 * it returns identical outputs on both sides.
 *
 * ── Why a separate file rather than inline ─────────────────────────────────
 *
 * The scores/bulk write handler needs per-subject grading. The process write
 * handler needs per-student and overall grading. Both must agree with the
 * server, so the logic lives here rather than duplicated in two handlers.
 */

/**
 * Look up the grade band for a percentage from the school's grading config.
 *
 * @param {number} score          Raw score
 * @param {number} maxScore       Maximum possible score
 * @param {object} gradingConfig  The school's GradingConfig document from the mirror
 * @returns {{ percentage: number|null, grade: string|null, remark: string|null, gpaPoints: number|null, isPassing: boolean|null }}
 */
// Cameroon /20 scale — mirrors grading.service.js GRADES / GRADE_SCALE and the
// GradingConfig defaults so the offline engine agrees with the server exactly.
// The one table, from shared/. This file carried its own seven-band copy with
// no C+ and remarks that disagreed with the school's — and since this is what
// actually grades a mark, its copy is the one that reached the report card.
const { GRADE_SCALE } = require("../../../../shared/gradeScale");

/** The bottom band, for the marks no band claimed. Read off the table so it
 *  cannot say something the table does not. */
const failBand = () => {
  const f = GRADE_SCALE[GRADE_SCALE.length - 1];
  return { grade: f.grade, points: f.points, remark: f.remark, remarkFr: f.remarkFr };
};

const normalizeTo20 = (score, maxScore) => {
  if (!maxScore || maxScore <= 0)    return 0;
  if (score == null || isNaN(score)) return 0;
  return Math.round((score / maxScore) * 20 * 100) / 100;
};

const lookupGrade = (markOutOf20) => {
  const clamped = Math.max(0, Math.min(20, markOutOf20 ?? 0));
  const found   = GRADE_SCALE.find(
    (g) => clamped >= g.min && clamped <= g.max
  );
  return found
    ? { grade: found.grade, points: found.points, remark: found.remark }
    : failBand();
};

const computeGrade = (score, maxScore, gradingConfig) => {
  if (score === null || score === undefined) {
    return {
      percentage: null,
      grade:      null,
      remark:     null,
      gpaPoints:  null,
      isPassing:  null,
    };
  }

  const percentage  = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const markOutOf20 = normalizeTo20(score, maxScore);
  const grades      = gradingConfig?.grades || [];
  const passMark    = gradingConfig?.passMark ?? 10;
  // Bands are stored on the /20 scale. Fall back to the built-in Cameroon scale
  // when the school has no config or stored bands on another scale, so a real
  // 12/20 never degrades to a wrong letter for everyone.
  let match = grades.find(
    (g) => markOutOf20 >= g.minMark && markOutOf20 <= g.maxMark
  );
  if (!match) {
    const fb = lookupGrade(markOutOf20);
    match = fb ? { grade: fb.grade, remark: fb.remark, gpaPoints: fb.points } : null;
  }

  return {
    percentage,
    grade:     match?.grade     || null,
    remark:    match?.remark    || null,
    gpaPoints: match?.gpaPoints ?? null,
    isPassing: markOutOf20 >= passMark,
  };
};

// The desk no longer computes result summaries: exam processing is the
// server's (writes/exams.js, POST /api/exams/:examId/process), because the
// decided calculation (shared/academicRules) needs the CA beside the paper
// and the published-result guard, and a second copy here was a second answer.

module.exports = { computeGrade };
