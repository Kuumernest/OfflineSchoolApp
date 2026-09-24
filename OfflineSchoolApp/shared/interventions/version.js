// shared/interventions/version.js
"use strict";

/**
 * The Intervention Engine's version and vocabulary.
 *
 * An intervention is not advice. It is a bounded support action a human
 * owns: a trigger the evidence supports, an objective, an action, an owner,
 * a duration, the evidence to collect, a review point, and afterwards an
 * observed outcome. The engine proposes and interprets; a person accepts,
 * runs, reviews and decides. Nothing here is a score, a probability, a
 * ranking of interventions, or a cause.
 */

const INTERVENTION_ENGINE_VERSION = "1.0.0";

/** Documented patterns that may propose an intervention. Never one mark, one activity or one observation. */
const TRIGGERS = Object.freeze([
  "PERSISTENT_DECLINE", "REPEATED_DIFFICULTY", "LEARNING_CONTRADICTION", "ACADEMIC_LEARNING_MISMATCH",
  "INSUFFICIENT_EVIDENCE", "REPEATED_SUPPORT_SIGNAL", "EVIDENCE_COVERAGE_GAP",
]);

/** Who is responsible for reviewing or supporting the intervention. The system performs none of it. */
const OWNER_ROLES = Object.freeze(["STUDENT", "TEACHER", "PARENT", "SCHOOL_ADMIN"]);

const LIFECYCLE = Object.freeze(["PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "COMPLETED", "DECLINED", "PAUSED", "CANCELLED"]);

/** action → { from: [...], to } — the only moves that exist. Anything else fails deterministically. */
const TRANSITIONS = Object.freeze({
  accept:   { from: ["PROPOSED"], to: "ACCEPTED" },
  decline:  { from: ["PROPOSED"], to: "DECLINED" },
  activate: { from: ["ACCEPTED"], to: "ACTIVE" },
  mark_review_due: { from: ["ACTIVE"], to: "REVIEW_DUE" },
  review:   { from: ["ACTIVE", "REVIEW_DUE"], to: "ACTIVE" },        // a review recorded; the intervention continues
  complete: { from: ["ACTIVE", "REVIEW_DUE"], to: "COMPLETED" },
  pause:    { from: ["ACTIVE", "REVIEW_DUE"], to: "PAUSED" },
  resume:   { from: ["PAUSED"], to: "ACTIVE" },
  cancel:   { from: ["ACCEPTED", "ACTIVE", "REVIEW_DUE", "PAUSED"], to: "CANCELLED" },
});

/** Which actor roles may take which action. A pupil accepts or declines what is proposed to them; staff do the rest. */
const ACTION_ROLES = Object.freeze({
  accept: ["STUDENT", "TEACHER", "SCHOOL_ADMIN", "PARENT"], decline: ["STUDENT", "TEACHER", "SCHOOL_ADMIN", "PARENT"],
  activate: ["TEACHER", "SCHOOL_ADMIN"], mark_review_due: ["TEACHER", "SCHOOL_ADMIN"], review: ["TEACHER", "SCHOOL_ADMIN"],
  complete: ["TEACHER", "SCHOOL_ADMIN"], pause: ["TEACHER", "SCHOOL_ADMIN"], resume: ["TEACHER", "SCHOOL_ADMIN"], cancel: ["TEACHER", "SCHOOL_ADMIN"],
});

/** Observed change after the intervention period. Descriptive; no "because". */
const OUTCOMES = Object.freeze(["IMPROVED", "STABLE", "DECLINED", "MIXED", "INSUFFICIENT_EVIDENCE"]);

/** The legacy Intervention record's status, derived from the lifecycle so older readers keep working. */
const LEGACY_STATUS = Object.freeze({
  PROPOSED: "planned", ACCEPTED: "planned", ACTIVE: "active", REVIEW_DUE: "active", PAUSED: "active", COMPLETED: "completed", DECLINED: "cancelled", CANCELLED: "cancelled",
});

const RULES = Object.freeze({
  independentObservationsForTrigger: 2,   // no trigger from one observation, one mark, one activity
  independentObservationsForGap: 3,       // an evidence gap is a pattern only after three observations without independent evidence
  mostModalities: 7,                      // seven of nine unavailable: the record is academic-only or nearly so
  defaultDurationDays: 42,                // six weeks to a review point
  minimumDurationDays: 14,
  maximumDurationDays: 120,
});

const FORBIDDEN_KEYS = Object.freeze(["score", "probability", "ranking", "riskScore", "successProbability", "careerFit", "personality", "aptitudeScore", "abilityScore", "interventionScore", "bestIntervention"]);

module.exports = { INTERVENTION_ENGINE_VERSION, TRIGGERS, OWNER_ROLES, LIFECYCLE, TRANSITIONS, ACTION_ROLES, OUTCOMES, LEGACY_STATUS, RULES, FORBIDDEN_KEYS };
