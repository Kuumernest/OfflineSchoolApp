// OfflineSchoolApp/shared/averages.js
"use strict";

/**
 * The one average (decided for launch, 2026-10-27).
 *
 * A term or annual average is
 *
 *     sum(subject mark /20 x coefficient) / sum(coefficients of the subjects
 *                                              the pupil has a mark in)
 *
 * — the figure the report card's TOTAL row and coefficient total already
 * printed. The stored term average was the mean of the sequence averages
 * instead, so a card could read TOTAL 548 / coef 38 = 14.42 above a "Term
 * average" of 14.5. Every screen, card and export now reads the figure this
 * file computes.
 *
 * Rules:
 *   - coefficients are always applied;
 *   - a subject with no mark (absent, exempt, not entered) is removed with its
 *     coefficient — an absence is not a zero;
 *   - a subject's term mark is its sequence marks combined by the sequence
 *     weights, each sequence mark its paper and CA combined by the school's
 *     CA/Test split (CA off: the paper); an annual subject mark is its term
 *     marks combined by the term weights (combineByLevel).
 *
 * Pure: the callers fetch, this only counts.
 */

const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

/** A score row as a mark out of 20, or null when there is no mark to count. */
function markOutOf20(score, maxScore) {
  if (!score || score.isAbsent || score.isExempt || score.score == null) return null;
  const max = Number(maxScore ?? score.maxScore ?? 20);
  const raw = Number(score.score);
  if (!Number.isFinite(raw) || !Number.isFinite(max) || max <= 0) return null;
  return (raw / max) * 20;
}

/**
 * Combine one subject's marks into one /20, by weight.
 *
 * Parts with no mark are dropped and the weights renormalised over the rest:
 * a pupil who missed a sequence is graded on the one they sat. A plain mean
 * when no part carries a weight.
 *
 * @param {Array<{mark: number|null, weight: number}>} parts
 * @returns {number|null}
 */
function combineMarks(parts) {
  const present = (parts || []).filter((p) => p.mark != null);
  if (present.length === 0) return null;
  const totalWeight = present.reduce((s, p) => s + (Number(p.weight) || 0), 0);
  if (totalWeight <= 0) {
    return present.reduce((s, p) => s + p.mark, 0) / present.length;
  }
  return present.reduce((s, p) => s + p.mark * (Number(p.weight) || 0), 0) / totalWeight;
}

/**
 * One subject's mark for a term or a year, combined level by level.
 *
 * A paper and its CA make a sequence mark; sequences make a term mark; terms
 * make a year mark. Each level drops what is missing and renormalises its own
 * weights — so a pupil with no CA in one sequence is graded on that
 * sequence's paper, and that sequence still carries its full share of the
 * term. Combining every part in one flat pass instead shrank that sequence's
 * share, and moved the year's mark with it.
 *
 * @param {Array<{mark, inSequence, sequence, sequenceWeight, term, termWeight}>} parts
 * @returns {number|null}
 */
function combineByLevel(parts) {
  const groupBy = (list, key) => {
    const out = new Map();
    for (const item of list) {
      const k = String(item[key]);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(item);
    }
    return [...out.values()];
  };
  const terms = groupBy(parts || [], "term").map((termParts) => {
    const sequences = groupBy(termParts, "sequence").map((seqParts) => ({
      mark:   combineMarks(seqParts.map((x) => ({ mark: x.mark, weight: x.inSequence }))),
      weight: seqParts[0].sequenceWeight,
    }));
    return { mark: combineMarks(sequences), weight: termParts[0].termWeight };
  });
  return combineMarks(terms);
}

/**
 * Every pupil's per-subject mark over a set of exams.
 *
 * @param {object} p
 * @param {Array}  p.scores        StudentScore-shaped rows
 * @param {Array}  p.examSubjects  ExamSubject-shaped rows for the same exams
 * @param {(examId: string) => {inSequence: number, sequence: *, sequenceWeight: number,
 *                              term: *, termWeight: number}} p.placeOf
 *   where an exam sits: its share of its sequence (the paper's or the CA's,
 *   0 for a CA the school has turned off), and its sequence and term with
 *   their weights
 * @param {(examSubject: object) => number} p.coefficientOf
 * @param {(studentId: string) => boolean} [p.skipStudent]
 * @returns {{ byStudent: Map<string, Map<string, {subjectName, coefficient, mark, parts}>>,
 *             subjects: Map<string, {subjectName, coefficient}> }}
 *   each part carries `weight` (its share of its sequence) and `examId`
 */
function subjectMarksByStudent({ scores, examSubjects, placeOf, coefficientOf, skipStudent = () => false }) {
  const esById = new Map((examSubjects || []).map((es) => [String(es._id), es]));

  const subjects = new Map();
  for (const es of examSubjects || []) {
    const key = String(es.subjectId);
    if (!subjects.has(key)) {
      subjects.set(key, { subjectName: es.subjectName || key, coefficient: coefficientOf(es) });
    }
  }

  const parts = new Map();
  for (const sc of scores || []) {
    const es      = sc.examSubjectId ? esById.get(String(sc.examSubjectId)) : null;
    const subject = String(es?.subjectId ?? sc.subjectId ?? "");
    if (!subject || skipStudent(String(sc.studentId))) continue;
    const mark = markOutOf20(sc, es?.maxScore);
    if (mark == null) continue;

    const sid = String(sc.studentId);
    if (!parts.has(sid)) parts.set(sid, new Map());
    const bySubject = parts.get(sid);
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    const place = placeOf(String(sc.examId));
    bySubject.get(subject).push({
      ...place, mark, weight: place.inSequence, examId: String(sc.examId),
    });
  }

  const byStudent = new Map();
  for (const [sid, bySubject] of parts) {
    const combined = new Map();
    for (const [subject, list] of bySubject) {
      const mark = combineByLevel(list);
      if (mark == null) continue;
      combined.set(subject, {
        subjectName: subjects.get(subject)?.subjectName || subject,
        coefficient: subjects.get(subject)?.coefficient ?? 1,
        mark:        round2(mark),
        parts:       list.map(({ mark: m, weight, examId }) => ({ mark: m, weight, examId })),
      });
    }
    byStudent.set(sid, combined);
  }

  return { byStudent, subjects };
}

/**
 * The coefficient-weighted average of subject marks.
 *
 * @param {Array<{mark?: number|null, score?: number|null, coefficient: number,
 *                isAbsent?: boolean, isExempt?: boolean}>} rows
 *   `mark`, or `score` as the card rows call it — /20 either way
 * @returns {{ totalCoefficients: number, totalWeighted: number, average: number|null }}
 *   average is null when no subject has a mark
 */
function coefficientAverage(rows) {
  const counted = (rows || []).map((r) => ({ ...r, value: r.mark ?? r.score }))
    .filter((r) => !r.isAbsent && !r.isExempt && r.value != null && Number.isFinite(Number(r.value)));
  const totalCoefficients = counted.reduce((s, r) => s + Number(r.coefficient ?? 1), 0);
  const totalWeighted = counted.reduce((s, r) => s + Number(r.value) * Number(r.coefficient ?? 1), 0);
  return {
    totalCoefficients,
    totalWeighted: round2(totalWeighted),
    average:       totalCoefficients > 0 ? round2(totalWeighted / totalCoefficients) : null,
  };
}

/** One pupil's average from their per-subject map (subjectMarksByStudent). */
const averageOfSubjects = (bySubject) =>
  coefficientAverage(bySubject ? [...bySubject.values()] : []).average;

module.exports = {
  round2,
  markOutOf20,
  combineMarks,
  combineByLevel,
  subjectMarksByStudent,
  coefficientAverage,
  averageOfSubjects,
};
