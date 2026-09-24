// shared/exploration/evidence.js
"use strict";

/**
 * From what happened in an exploration to the evidence rows it produces —
 * each kind on its own row, none derived from another.
 *
 * ── The matrix ────────────────────────────────────────────────────────────
 *
 *   exposure             the pupil encountered the area        (started)
 *   participation        the pupil engaged in the activity     (submitted)
 *   interest             the pupil wants more of it            (reflection: interest HIGH or continue YES)
 *   reflection           the pupil's own account                (kept as the reflection record, not an evidence row)
 *   performance          an observable outcome, rated           (a teacher rated the criteria)
 *   teacher_observation  an authorised adult saw something      (a teacher recorded an observation)
 *
 * Joining a robotics club is exposure and, once submitted, participation. It
 * is not performance; performance appears only when a teacher rated the
 * output against the activity's criteria. Enjoying it is interest. None of
 * these is converted into another, and the strengths engine (1.0.0) reads
 * only the kinds it already knows: interest, exposure, reflection as signals;
 * teacher_observation under its one rule; performance and participation are
 * carried and not yet consumed — that is a 1.1.0 decision, not a side effect.
 *
 * ── Deterministic identities ──────────────────────────────────────────────
 *
 * Every row's id is derived from the exploration and the kind, so a replayed
 * submission or a re-sent observation lands on the same row. That is what
 * makes the offline queue safe to retry.
 *
 * ── Interest × performance, kept as a pair ────────────────────────────────
 *
 * patternOf() names the four corners — high interest with strong performance,
 * high interest with limited performance, and so on — as a pair of readings.
 * There is no fit score, because the pair IS the finding.
 */

const { PERFORMANCE_RATINGS } = require("./catalog");

const RATING_VALUE = Object.fromEntries(PERFORMANCE_RATINGS.map((r, i) => [r, i]));

/**
 * A single reading of rated criteria: limited / partial / demonstrated / strong.
 * Majority of criteria at "met" or better → demonstrated; all "met" or better
 * with at least one "exceeded" → strong; majority below "met" → limited;
 * otherwise partial. Specific to the activity's criteria; never a global score.
 */
const performanceLevel = (ratings = []) => {
  const vals = ratings.map((r) => RATING_VALUE[r.rating]).filter((v) => v !== undefined);
  if (!vals.length) return null;
  const met = vals.filter((v) => v >= RATING_VALUE.met).length;
  if (met === vals.length && vals.some((v) => v === RATING_VALUE.exceeded)) return "strong";
  if (met * 2 > vals.length) return "demonstrated";
  if (met === 0 || (vals.length - met) * 2 > vals.length) return "limited";
  return "partial";
};

/** The pair. Either side may be null when that evidence does not exist yet. */
const patternOf = ({ interest = null, performance = null }) => ({
  interest: interest ?? null,
  performance: performance ?? null,
  pattern: interest && performance ? `${interest}_INTEREST_${performance.toUpperCase()}_PERFORMANCE` : null,
});

const rowBase = (exploration, activity, kind, source, date) => ({
  _id: `${exploration._id}:${kind}`,
  schoolId: exploration.schoolId, studentId: exploration.studentId, classId: exploration.classId ?? "",
  explorationId: exploration._id, activityId: activity.activityId, activityVersion: activity.version,
  kind, source, dimension: activity.dimensions[0] ?? null, area: activity.area,
  activity: activity.text?.en?.title ?? activity.activityId, date,
});

/** Rows a start produces: exposure. */
const evidenceForStart = ({ exploration, activity }) => [
  { ...rowBase(exploration, activity, "exposure", "system", exploration.startedAt ?? new Date()), participation: "attended" },
];

/**
 * Rows a submission produces: participation, and interest when the reflection
 * says so. Exposure is (re)stated too, so a submission that skipped START
 * still records that the area was encountered.
 */
const evidenceForSubmission = ({ exploration, activity, reflection = null }) => {
  const when = exploration.submittedAt ?? new Date();
  const rows = [
    { ...rowBase(exploration, activity, "exposure", "system", exploration.startedAt ?? when), participation: "attended" },
    { ...rowBase(exploration, activity, "participation", "system", when), participation: "completed" },
  ];
  if (reflection && (reflection.interest === "HIGH" || reflection.continue === "YES")) {
    rows.push({ ...rowBase(exploration, activity, "interest", "student", when),
      reflection: reflection.continue === "YES" ? "want_more" : "enjoyed" });
  }
  return rows;
};

/** The row a teacher observation produces, one per observer. */
const evidenceForObservation = ({ exploration, activity, observation }) => [
  { ...rowBase(exploration, activity, "teacher_observation", "teacher", observation.observedAt ?? new Date()),
    _id: `${exploration._id}:teacher_observation:${observation.observedBy}`, recordedBy: observation.observedBy,
    outcome: `${observation.level}: ${(observation.codes ?? []).join(", ")}` },
];

/** The row a rated performance produces. */
const evidenceForPerformance = ({ exploration, activity, performance }) => {
  const level = performanceLevel(performance.ratings);
  return [
    { ...rowBase(exploration, activity, "performance", "teacher", performance.ratedAt ?? new Date()),
      recordedBy: performance.ratedBy, outcome: level ? `${level}: ${performance.ratings.map((r) => `${r.criterion}=${r.rating}`).join(", ")}` : null },
  ];
};

module.exports = {
  performanceLevel, patternOf,
  evidenceForStart, evidenceForSubmission, evidenceForObservation, evidenceForPerformance,
};
