// OfflineSchoolApp/shared/periodStructure.js
"use strict";

/**
 * Which shapes of academic year are valid (docs/39 Phase 6).
 *
 * Until now every year was three terms of two sequences, and the settings
 * screen could only rename and reweight them. Phase 6 lets a school shape its
 * own year — two semesters of three evaluations, three terms of one, any mix —
 * within the bounds every stored record already lives in: terms numbered 1–3,
 * sequences numbered 1–6 (Exam.term / Exam.sequenceNumber, the cohort schema,
 * the card tokens). Inside those bounds nothing downstream needs migrating:
 * the term and annual layers, the cards and the policy snapshot already read
 * the year from its structure (Phase 3).
 *
 * The rules:
 *   - 1 to 3 terms, numbered 1..n in order;
 *   - every term has at least one sequence (a term result is made of its
 *     sequences' results; a term with none could never be computed);
 *   - sequences numbered 1..m across the whole year, in order, m ≤ 6, so a
 *     sequence number names exactly one sequence of the year;
 *   - names present; weights numbers from 0 to 100; term weights summing to
 *     100 (±0.5, the tolerance the settings screen has always used).
 *
 * And the rule that protects data: a period that already has exams cannot be
 * removed or moved to another term (periodsStillHolding).
 *
 * Pure.
 */

const MAX_TERMS = 3;
const MAX_SEQUENCES = 6;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const err = (field, code, message) => ({ field, code, message });

/**
 * @param {unknown} terms  the `terms` of a structure write
 * @returns {{ ok: true } | { ok: false, errors: Array<{field, code, message}> }}
 */
const validateTerms = (terms) => {
  const errors = [];
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > MAX_TERMS) {
    return { ok: false, errors: [err("terms", "TERM_COUNT", `A year has 1 to ${MAX_TERMS} terms`)] };
  }
  let expectedSeq = 1;
  let weightSum = 0;
  terms.forEach((t, i) => {
    const at = `terms[${i}]`;
    if (!t || typeof t !== "object") { errors.push(err(at, "INVALID_TERM", "A term must be an object")); return; }
    if (t.number !== i + 1) errors.push(err(`${at}.number`, "TERM_NUMBER", `Terms are numbered 1..n in order; expected ${i + 1}`));
    if (typeof t.name !== "string" || t.name.trim() === "") errors.push(err(`${at}.name`, "NAME_REQUIRED", "A term needs a name"));
    if (t.weight !== undefined && (!isNum(t.weight) || t.weight < 0 || t.weight > 100)) {
      errors.push(err(`${at}.weight`, "INVALID_WEIGHT", "A weight is a number from 0 to 100"));
    }
    weightSum += isNum(t.weight) ? t.weight : 33.33;
    const seqs = t.sequences;
    if (!Array.isArray(seqs) || seqs.length < 1) {
      errors.push(err(`${at}.sequences`, "NO_SEQUENCES", "A term needs at least one sequence"));
      return;
    }
    seqs.forEach((s, j) => {
      const sat = `${at}.sequences[${j}]`;
      if (!s || typeof s !== "object") { errors.push(err(sat, "INVALID_SEQUENCE", "A sequence must be an object")); return; }
      if (s.number !== expectedSeq) {
        errors.push(err(`${sat}.number`, "SEQUENCE_NUMBER", `Sequences are numbered 1..m across the year; expected ${expectedSeq}`));
      }
      expectedSeq += 1;
      if (typeof s.name !== "string" || s.name.trim() === "") errors.push(err(`${sat}.name`, "NAME_REQUIRED", "A sequence needs a name"));
      if (s.weight !== undefined && (!isNum(s.weight) || s.weight < 0 || s.weight > 100)) {
        errors.push(err(`${sat}.weight`, "INVALID_WEIGHT", "A weight is a number from 0 to 100"));
      }
    });
  });
  if (expectedSeq - 1 > MAX_SEQUENCES) {
    errors.push(err("terms", "SEQUENCE_COUNT", `A year has at most ${MAX_SEQUENCES} sequences`));
  }
  if (errors.length === 0 && Math.abs(weightSum - 100) >= 0.5) {
    errors.push(err("terms", "WEIGHTS_SUM", "Term weights must add up to 100"));
  }
  return errors.length ? { ok: false, errors } : { ok: true };
};

/**
 * The exams a new shape would orphan: an exam whose term no longer exists, or
 * whose sequence no longer exists in that term. Each is a period somebody has
 * already marked against; removing or moving it would leave those marks in no
 * term result.
 *
 * @param {Array<object>} terms  the proposed terms
 * @param {Array<{_id, name, term, sequenceNumber}>} exams  the year's exams
 * @returns {Array<{examId, name, term, sequenceNumber}>}
 */
const periodsStillHolding = (terms, exams) => {
  const seqTerm = new Map();
  const termNumbers = new Set();
  for (const t of terms || []) {
    termNumbers.add(Number(t.number));
    for (const s of t.sequences || []) seqTerm.set(Number(s.number), Number(t.number));
  }
  return (exams || [])
    .filter((e) => {
      const term = Number(e.term);
      if (!termNumbers.has(term)) return true;
      if (e.sequenceNumber == null) return false;
      return seqTerm.get(Number(e.sequenceNumber)) !== term;
    })
    .map((e) => ({ examId: String(e._id), name: e.name ?? null, term: e.term, sequenceNumber: e.sequenceNumber ?? null }));
};

module.exports = { MAX_TERMS, MAX_SEQUENCES, validateTerms, periodsStillHolding };
