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

/**
 * Compute a full ResultSummary for one student across all their subjects in an
 * exam. Mirrors the server's POST /:examId/process logic (exam.routes.js:1094-1263).
 *
 * @param {string}   studentId
 * @param {object[]} scores        Array of StudentScore documents for this student
 * @param {Map}      subjectMap    Map<subjectId, ExamSubject> for the exam
 * @param {object}   gradingConfig The school's GradingConfig from the mirror
 * @param {string}   examId
 * @param {string}   schoolId
 * @param {string}   [classId]
 * @returns {object} The ResultSummary document (not yet persisted)
 */
const computeResultSummary = (studentId, scores, subjectMap, gradingConfig, examId, schoolId, classId) => {
  let totalScore    = 0;
  let maxTotalScore = 0;
  let passed        = 0;
  let failedCount   = 0;

  const subjectBreakdown = [];

  for (const s of scores) {
    const es       = subjectMap.get(s.subjectId);
    const maxScore = es?.maxScore ?? s.maxScore ?? 100;
    maxTotalScore += maxScore;

    if (!s.isAbsent && !s.isExempt && s.score !== null) {
      totalScore += s.score;
      const pct  = Math.round((s.score / maxScore) * 100);
      if (s.isPassing) passed++;
      else             failedCount++;

      subjectBreakdown.push({
        subjectId:      s.subjectId,
        subjectName:    es?.subjectName || s.subjectId,
        score:          s.score,
        maxScore,
        normalizedMark: Math.round((pct / 100) * 20 * 10) / 10,
        grade:          s.grade,
        points:         s.gpaPoints,
        remark:         s.remark,
        isPassing:      s.isPassing,
        isAbsent:       false,
      });
    } else {
      subjectBreakdown.push({
        subjectId:      s.subjectId,
        subjectName:    es?.subjectName || s.subjectId,
        score:          null,
        maxScore,
        normalizedMark: null,
        grade:          null,
        points:         null,
        remark:         s.isAbsent ? "Absent" : "Exempt",
        isPassing:      false,
        isAbsent:       s.isAbsent,
      });
    }
  }

  const percentage = maxTotalScore > 0
    ? Math.round((totalScore / maxTotalScore) * 100) : 0;
  const average    = scores.length > 0
    ? Math.round(totalScore / scores.length) : 0;
  const computed   = computeGrade(totalScore, maxTotalScore, gradingConfig);

  return {
    _id:             null,   // caller assigns
    examId,
    studentId,
    schoolId,
    classId:         classId || null,
    totalScore,
    maxTotalScore,
    percentage,
    average,
    overallGrade:    computed.grade,
    overallRemark:   computed.remark,
    gpa:             computed.gpaPoints,
    subjectsPassed:  passed,
    subjectsFailed:  failedCount,
    subjectsTotal:   scores.length,
    isPassing:       computed.isPassing,
    subjectBreakdown,
    classPosition:   null,   // computed after all students
    totalInClass:    null,
    isPublished:     false,
    syncStatus:      "synced",
    lastSyncedAt:    null,
  };
};

/**
 * Assign dense class positions to a set of result summaries, grouped by class.
 * Ties share the same position. Mirrors the server's loop (exam.routes.js:1232-1254).
 *
 * Mutates the summaries in place (sets classPosition and totalInClass).
 *
 * @param {object[]} summaries  Array of ResultSummary documents
 */
const assignClassPositions = (summaries) => {
  const grouped = {};
  for (const s of summaries) {
    const cId = s.classId || "unknown";
    if (!grouped[cId]) grouped[cId] = [];
    grouped[cId].push(s);
  }

  for (const classSummaries of Object.values(grouped)) {
    classSummaries.sort((a, b) => b.percentage - a.percentage);
    let pos = 1;
    for (let i = 0; i < classSummaries.length; i++) {
      if (
        i > 0 &&
        classSummaries[i].percentage < classSummaries[i - 1].percentage
      ) {
        pos = i + 1;
      }
      classSummaries[i].classPosition = pos;
      classSummaries[i].totalInClass  = classSummaries.length;
    }
  }
};

module.exports = { computeGrade, computeResultSummary, assignClassPositions };
