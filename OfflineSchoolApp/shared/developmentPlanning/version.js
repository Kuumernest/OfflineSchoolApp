// shared/developmentPlanning/version.js
"use strict";

/**
 * The Development Planning Engine's version and vocabulary.
 *
 * A development plan turns guidance into something a pupil and a teacher
 * can work on together: a bounded, evidence-oriented objective; a few
 * controlled actions; observable milestones; a review schedule; the
 * pupil's own participation. Every word here is categorical. Nothing is a
 * score, a probability, a prediction, or a future identity.
 */

const DEVELOPMENT_PLANNING_ENGINE_VERSION = "1.0.0";

const OBJECTIVE_CATEGORIES = Object.freeze([
  "BUILD_SKILL", "INCREASE_PRACTICE", "INCREASE_EXPOSURE", "EXPLORE", "STRENGTHEN_CONSISTENCY",
  "ADDRESS_DECLINE", "RESOLVE_EVIDENCE_GAP", "TEST_AN_APPROACH", "REFLECT", "SEEK_SUPPORT",
]);

const PLAN_STATUS = Object.freeze(["DRAFT", "PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "COMPLETED", "PAUSED", "CLOSED", "DECLINED"]);

/** action → { from, to, roles } — the only moves that exist. */
const PLAN_TRANSITIONS = Object.freeze({
  propose:          { from: ["DRAFT"], to: "PROPOSED", roles: ["TEACHER", "SCHOOL_ADMIN", "STUDENT"] },
  accept:           { from: ["PROPOSED"], to: "ACCEPTED", roles: ["STUDENT", "TEACHER", "SCHOOL_ADMIN", "PARENT"] },
  decline:          { from: ["PROPOSED"], to: "DECLINED", roles: ["STUDENT", "TEACHER", "SCHOOL_ADMIN", "PARENT"] },
  activate:         { from: ["ACCEPTED"], to: "ACTIVE", roles: ["TEACHER", "SCHOOL_ADMIN"] },
  mark_review_due:  { from: ["ACTIVE"], to: "REVIEW_DUE", roles: ["TEACHER", "SCHOOL_ADMIN"] },
  continue:         { from: ["REVIEW_DUE"], to: "ACTIVE", roles: ["TEACHER", "SCHOOL_ADMIN"] },
  adapt:            { from: ["REVIEW_DUE"], to: "ADAPTING", roles: ["TEACHER", "SCHOOL_ADMIN"] },
  apply_adaptation: { from: ["ADAPTING"], to: "ACTIVE", roles: ["TEACHER", "SCHOOL_ADMIN"] },
  complete:         { from: ["REVIEW_DUE"], to: "COMPLETED", roles: ["TEACHER", "SCHOOL_ADMIN"] },
  pause:            { from: ["ACTIVE", "REVIEW_DUE"], to: "PAUSED", roles: ["STUDENT", "TEACHER", "SCHOOL_ADMIN"] },
  resume:           { from: ["PAUSED"], to: "ACTIVE", roles: ["STUDENT", "TEACHER", "SCHOOL_ADMIN"] },
  close:            { from: ["ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "PAUSED"], to: "CLOSED", roles: ["TEACHER", "SCHOOL_ADMIN"] },
});

/** Statuses in which a plan is still open (for duplicate prevention). */
const OPEN_STATUS = Object.freeze(["DRAFT", "PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "PAUSED"]);

const MILESTONE_STATES = Object.freeze(["PENDING", "AVAILABLE", "STARTED", "COMPLETED", "SKIPPED", "BLOCKED"]);

/** Observable events only. Never a change in the child. */
const MILESTONE_KINDS = Object.freeze([
  "activity_started", "activity_completed", "assignment_submitted", "quiz_completed", "teacher_observation_recorded", "practical_completed",
  "reflection_submitted", "support_session_completed", "second_independent_observation_recorded", "coursework_submitted", "different_approach_tried",
]);

const MILESTONE_TRANSITIONS = Object.freeze({
  start:    { from: ["AVAILABLE"], to: "STARTED" },
  complete: { from: ["AVAILABLE", "STARTED"], to: "COMPLETED" },
  skip:     { from: ["AVAILABLE", "STARTED", "BLOCKED"], to: "SKIPPED" },
  block:    { from: ["AVAILABLE", "STARTED"], to: "BLOCKED" },
  unblock:  { from: ["BLOCKED"], to: "AVAILABLE" },
});

const SKIP_REASONS = Object.freeze(["STUDENT_CHOICE", "RESOURCE_UNAVAILABLE", "TIME_CONSTRAINT", "SCHOOL_CONSTRAINT", "SUPPORT_UNAVAILABLE", "OTHER"]);

/** Explicit operational constraints, recorded only when authorised. Never inferred; never a profile. */
const CONSTRAINTS = Object.freeze(["NO_DEVICE", "LIMITED_CONNECTIVITY", "NO_REQUIRED_MATERIAL", "NO_TEACHER_AVAILABILITY", "TIME_CONSTRAINT", "ACTIVITY_UNAVAILABLE", "SCHOOL_RESOURCE_LIMIT"]);

/** The controlled action vocabulary, shared with the adaptive support engine. */
const ACTION_TYPES = Object.freeze([
  "MORE_PRACTICE", "DIFFERENT_PRACTICE", "LOWER_COMPLEXITY", "HIGHER_COMPLEXITY", "NEW_CONTEXT", "ADDITIONAL_EXPOSURE",
  "TEACHER_SUPPORT", "PEER_SUPPORT", "REFLECTION", "REPEAT_OBSERVATION", "WAIT_FOR_MORE_EVIDENCE", "RESOURCE_SUBSTITUTION",
]);

/** What a pupil may say about the experience. Evidence about the experience — never about ability. */
const REFLECTION_CODES = Object.freeze(["USEFUL", "NOT_USEFUL", "TOO_EASY", "TOO_DIFFICULT", "INTERESTING", "NOT_INTERESTING", "NEED_MORE_SUPPORT", "PREFER_DIFFERENT_APPROACH", "RESOURCE_PROBLEM", "OTHER"]);

const TEACHER_REVIEW_CODES = Object.freeze(["OBSERVED_PROGRESS", "OBSERVED_STABILITY", "OBSERVED_DIFFICULTY", "NO_NEW_EVIDENCE", "CONTEXT_CHANGED", "SUPPORT_REQUIRED"]);

/** The human decision at a review. The system's outcome is recorded beside it, never instead of it. */
const REVIEW_DECISIONS = Object.freeze(["continue", "adapt", "complete", "pause", "close"]);

const OWNER_ROLES = Object.freeze(["STUDENT", "TEACHER", "PARENT", "SCHOOL_ADMIN"]);

const RULES = Object.freeze({
  defaultReviewDays: 42,
  minimumReviewDays: 14,
  maximumReviewDays: 120,
  maxActions: 3,
});

const FORBIDDEN_KEYS = Object.freeze(["planScore", "goalScore", "riskScore", "successProbability", "completionProbability", "aptitudeScore", "readinessScore", "score", "probability", "ranking"]);

const NOT_INFERRED = Object.freeze([
  "career", "profession", "university", "personality", "psychological_state", "aptitude", "intelligence", "socioeconomic_status", "dropout_risk",
  "behaviour_prediction", "success_probability", "completion_probability", "readiness", "student_ranking", "cause_of_change",
]);

module.exports = {
  DEVELOPMENT_PLANNING_ENGINE_VERSION, OBJECTIVE_CATEGORIES, PLAN_STATUS, PLAN_TRANSITIONS, OPEN_STATUS, MILESTONE_STATES, MILESTONE_KINDS, MILESTONE_TRANSITIONS,
  SKIP_REASONS, CONSTRAINTS, ACTION_TYPES, REFLECTION_CODES, TEACHER_REVIEW_CODES, REVIEW_DECISIONS, OWNER_ROLES, RULES, FORBIDDEN_KEYS, NOT_INFERRED,
};
