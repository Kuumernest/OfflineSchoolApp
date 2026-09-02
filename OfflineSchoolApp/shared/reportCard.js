// OfflineSchoolApp/shared/reportCard.js
"use strict";

/**
 * The rules that decide what a report card says, separated from where the data
 * comes from.
 *
 * Three of them, and each was previously inline in results.controller.js where
 * nothing could reach it:
 *
 *   reportTypeFor      which of the three cards this is
 *   carriesPromotion   whether a promotion decision may appear on it
 *   subjectRanking     a pupil's place in each subject
 *
 * They live here because the term and annual cards need the same answers as the
 * sequence card, and because a rule with a test is worth more than a rule with
 * a comment. The promotion rule in particular exists to fix a specific bug —
 * "Promoted" printing on a First Sequence card — and a rule that fixed a bug
 * once should not be able to un-fix it quietly.
 */

/**
 * Which of the three report cards an exam produces.
 *
 * A promotion exam is the final annual report. Anything bound to a sequence
 * (1–6) is a sequence report. Everything else is a term report.
 *
 * @param {{type?: string, sequenceNumber?: number|null}} exam
 * @returns {"annual"|"sequence"|"term"}
 */
const reportTypeFor = (exam) => {
  if (exam?.type === "promotion_exam") return "annual";
  if (exam?.sequenceNumber != null)    return "sequence";
  return "term";
};

/**
 * May this report card show a promotion decision?
 *
 * Only the final annual one. A promotion depends on a whole year's work, so a
 * sequence or intermediate term card cannot honestly carry it — and printing
 * "Promoted" on a First Sequence card tells a family something nobody has
 * decided yet.
 *
 * @param {string} reportType
 * @returns {boolean}
 */
const carriesPromotion = (reportType) => reportType === "annual";

/**
 * Rank a pupil in each subject, against the pupils who actually sat it.
 *
 * Absent, exempt and unmarked scores are excluded from the ranking AND from
 * the denominator, so "18th / 35" means eighteenth of the thirty-five who sat
 * the paper — not of everyone on the register.
 *
 * Equal marks share a place, and the next place skips accordingly: two pupils
 * on the top mark are both 1st and the next is 3rd. That is the ranking a
 * school reads as a tie rather than an arbitrary order.
 *
 * @param {Array<{studentId, examSubjectId?, subjectId?, score?, isAbsent?, isExempt?}>} scores
 *        every score for the exam, across all pupils
 * @returns {{ positionOf: (score) => ({position: number|null, total: number|null}) }}
 */
const subjectRanking = (scores) => {
  const counted = new Map();

  const keyOf = (s) =>
    s?.examSubjectId != null ? `es:${String(s.examSubjectId)}`
      : s?.subjectId != null ? `su:${String(s.subjectId)}`
      : null;

  const sat = (s) =>
    !!s && !s.isAbsent && !s.isExempt && s.score != null &&
    Number.isFinite(Number(s.score));

  for (const s of scores || []) {
    if (!sat(s)) continue;
    const key = keyOf(s);
    if (key === null) continue;
    if (!counted.has(key)) counted.set(key, []);
    counted.get(key).push(Number(s.score));
  }

  const positionOf = (score) => {
    if (!sat(score)) return { position: null, total: null };
    const marks = counted.get(keyOf(score));
    if (!marks || marks.length === 0) return { position: null, total: null };

    const mine = Number(score.score);
    // One more than the number of pupils strictly ahead: ties share a place.
    let ahead = 0;
    for (const m of marks) if (m > mine) ahead += 1;
    return { position: ahead + 1, total: marks.length };
  };

  return { positionOf };
};

module.exports = { reportTypeFor, carriesPromotion, subjectRanking };
