// OfflineSchoolApp/shared/intelligence/interventionOutcome.js
"use strict";

/**
 * What the evidence looked like before a support action, and what it looks like
 * after it.
 *
 * ── The sentence this module is built to never say ────────────────────────
 *
 *   "The intervention improved the pupil's Mathematics."
 *
 * It cannot know that. A school is not a controlled trial: the pupil also grew
 * up three months, the syllabus moved on, a different teacher took the class,
 * the family situation changed, and the next paper was a different paper. What
 * this module can say — and the most it may say — is:
 *
 *   "Mathematics was 11.2 before and 14.1 after. That is +2.9."
 *
 * The arithmetic is the finding. The interpretation belongs to the teacher who
 * was in the room, and the outcome field they fill in themselves is where their
 * judgement is recorded. So the codes here are deliberately flat —
 * INCREASED_AFTER, not IMPROVED_BY — and the word "because" appears nowhere.
 *
 * ── Why nothing is stored ─────────────────────────────────────────────────
 *
 * No impact score, no effectiveness rating, no cached comparison. A stored
 * number would freeze on the day it was computed, survive the correction of the
 * marks underneath it, and acquire authority it has not earned. The comparison
 * is recomputed from published results on every request.
 *
 * ── Why this is in shared/, and pure ──────────────────────────────────────
 *
 * Same reason as the engine it reads through: the desktop must be able to show
 * a teacher the before and after without a connection, and a second copy of the
 * date rule would eventually split an occasion onto the wrong side of an action.
 * It takes the intervention and the pupil's already-ordered history as plain
 * data and does no I/O.
 *
 * ── Where the rules come from ─────────────────────────────────────────────
 *
 * All of them are inherited, none reimplemented. The series is built by
 * subjectInsights.seriesFrom over an academicOrder history, so this module gets,
 * for free and by construction:
 *
 *   continuous assessment excluded as an independent occasion
 *   occasions ordered by (year, term, sequence) rather than by row age
 *   absences and exemptions skipped rather than averaged as zeros
 *   rows with no mark behind them (score null) skipped
 *   a genuine zero kept, because the pupil earned it
 */

const { seriesFrom } = require("./subjectInsights");

const round1 = (n) => Math.round(n * 10) / 10;
const mean   = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

/**
 * When an occasion happened.
 *
 * The exam's own start date when it has one, because that is when the pupil sat
 * the paper. Falling back to when the summary row was computed, which is the
 * best available answer for an exam nobody dated — and which
 * academicHistory.occurrenceOf already carries for its own tie-breaking.
 *
 * This matters more than it looks. A sequence SAT before the intervention but
 * PUBLISHED after it is prior evidence, and sorting it into the "after" side
 * would credit the action with a mark that predates it.
 */
const occasionTime = (occurrence) => {
  const sat = String(occurrence?.startDate ?? "").trim();
  if (sat) {
    const parsed = Date.parse(sat);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number(occurrence?.createdAt) || 0;
};

/**
 * The moment the support started.
 *
 * `startedAt` when the teacher moved it to active, because that is when
 * anything could have begun to change. `createdAt` otherwise — a planned
 * intervention has not started, and its creation is the only honest pivot
 * available.
 */
const pivotOf = (intervention) =>
  new Date(intervention.startedAt ?? intervention.createdAt).getTime();

/** One side of the comparison, or null when there is nothing on that side. */
const side = (points) => {
  if (!points.length) return null;
  const marks = points.map((p) => p.mark);
  return {
    average:      round1(mean(marks)),
    observations: marks.length,
    from: points[0].occurrence,
    to:   points[points.length - 1].occurrence,
  };
};

/**
 * The neutral reading of a change.
 *
 * Derived from the sign alone. There is deliberately no "meaningful change"
 * threshold: any number chosen for it would be invented, and a system that
 * quietly decides 1.9 marks is nothing while 2.0 is something has made an
 * editorial judgement it cannot defend. The figure is reported; the reader
 * decides whether it matters.
 */
const readingOf = (change) => {
  if (change > 0) return "INCREASED_AFTER";
  if (change < 0) return "DECREASED_AFTER";
  return "NO_CHANGE_OBSERVED";
};

/**
 * Before and after, for one intervention.
 *
 * @param   {object}   input
 * @param   {object}   input.intervention  an Intervention-shaped row
 * @param   {object[]} input.history       that pupil's ordered published history
 * @returns {object} never null; says why when it cannot compare
 */
const compareOutcome = ({ intervention, history = [] }) => {
  const studentId = String(intervention.studentId);
  const subjectId = intervention.subjectId ? String(intervention.subjectId) : null;
  const pivot     = pivotOf(intervention);

  const base = {
    interventionId: String(intervention._id),
    studentId,
    subjectId,
    subjectName: null,
    scale: 20,
    pivot: new Date(pivot),
    // Said out loud so a reader knows whether "after" means "since the teacher
    // started" or "since the teacher wrote it down".
    pivotSource: intervention.startedAt ? "startedAt" : "createdAt",
    before: null,
    after:  null,
    change: null,
  };

  /*
   * An intervention that names no subject is not compared.
   *
   * Falling back to the pupil's overall average would answer a question nobody
   * asked: a Mathematics action followed by a good term in three other subjects
   * would read as a Mathematics recovery.
   */
  if (!subjectId) {
    return { ...base, status: "not_subject_specific", reading: "NOT_SUBJECT_SPECIFIC" };
  }

  const series = seriesFrom(history).get(subjectId);
  if (!series || !series.points.length) {
    return { ...base, status: "no_evidence", reading: "NO_COMPARABLE_EVIDENCE" };
  }

  const named  = { ...base, subjectName: series.subjectName ?? null };
  const before = side(series.points.filter((p) => occasionTime(p.occurrence) <  pivot));
  const after  = side(series.points.filter((p) => occasionTime(p.occurrence) >= pivot));

  if (!before && !after) {
    return { ...named, status: "no_evidence", reading: "NO_COMPARABLE_EVIDENCE" };
  }
  if (!after) {
    // The ordinary case for a recent intervention, and it must not read as a
    // failure: the next sequence simply has not been sat or published yet.
    return { ...named, before, status: "awaiting_after", reading: "AWAITING_POST_EVIDENCE" };
  }
  if (!before) {
    return { ...named, after, status: "no_before", reading: "NO_PRIOR_EVIDENCE" };
  }

  const change = round1(after.average - before.average);
  return { ...named, before, after, change, status: "compared", reading: readingOf(change) };
};

module.exports = {
  compareOutcome,
  occasionTime,
  pivotOf,
  readingOf,
};
