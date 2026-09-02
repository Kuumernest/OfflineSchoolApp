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
 *   periodName         the period spelled the way a parent reads it
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

/**
 * The period a card covers, named rather than numbered.
 *
 * "Sequence 1" is how the database holds it; "First Sequence" is what belongs
 * on the document, because that is what the official header says and what a
 * parent reads. The school's own name for a sequence always wins over both —
 * these are the words for a school that has not named them.
 *
 * Six sequences and three terms is the Cameroonian structure and the only one
 * this array needs to cover; a number outside it falls back to the numbered
 * form rather than inventing a word for it.
 */
const ORDINALS = {
  en: ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"],
  fr: ["Première", "Deuxième", "Troisième", "Quatrième", "Cinquième", "Sixième"],
};

// French puts the ordinal after the noun for a term (Premier Trimestre) but
// agrees with séquence, which is feminine. Hence two lists rather than one.
const TERM_ORDINALS = {
  en: ["First", "Second", "Third"],
  fr: ["Premier", "Deuxième", "Troisième"],
};

const PERIOD_WORDS = {
  en: { sequence: "Sequence", term: "Term",       annual: "Annual" },
  fr: { sequence: "Séquence", term: "Trimestre",  annual: "Annuel" },
};

/**
 * @param {object}  p
 * @param {"sequence"|"term"|"annual"} p.reportType
 * @param {number|null} [p.sequenceNumber]
 * @param {number|null} [p.term]
 * @param {string|null} [p.name]  the school's own name for it, which wins
 * @param {"en"|"fr"}   [lang]
 * @returns {string|null} null only when there is nothing to name
 */
const periodName = ({ reportType, sequenceNumber, term, name } = {}, lang = "en") => {
  const l     = lang === "fr" ? "fr" : "en";
  const words = PERIOD_WORDS[l];

  if (name && String(name).trim()) return String(name).trim();

  if (reportType === "annual") return words.annual;

  if (reportType === "sequence" && sequenceNumber != null) {
    const ord = ORDINALS[l][Number(sequenceNumber) - 1];
    return ord ? `${ord} ${words.sequence}` : `${words.sequence} ${sequenceNumber}`;
  }

  if (reportType === "term" && term != null) {
    const ord = TERM_ORDINALS[l][Number(term) - 1];
    return ord ? `${ord} ${words.term}` : `${words.term} ${term}`;
  }

  return null;
};

module.exports = {
  reportTypeFor, carriesPromotion, subjectRanking, periodName,
  ORDINALS, TERM_ORDINALS, PERIOD_WORDS,
};
