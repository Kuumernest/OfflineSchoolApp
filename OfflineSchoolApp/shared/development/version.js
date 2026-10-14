// shared/development/version.js
"use strict";

/**
 * The Development Engine's version and vocabulary.
 *
 * The engine reads the immutable strength snapshots and the current reading
 * and describes how the evidence-backed profile changed over time. Every
 * word here is categorical: a trajectory label, a change type, a reason
 * code, a contradiction status. None is a score, a rate or a prediction.
 *
 * Versioned on its own. It moves when a rule here changes; the engines
 * beneath (academic, strengths, exploration, learning evidence, learning
 * integration) do not move for that.
 */

const DEVELOPMENT_ENGINE_VERSION = "1.0.0";

/** The strength states, as the strengths engine names them. Not redefined here. */
const STATES = Object.freeze(["INSUFFICIENT", "EMERGING", "ESTABLISHED", "DECLINING"]);

/** Rank for direction only: is the later observation above or below the earlier one. Same ranks the fusion layer uses. */
const STATE_RANK = Object.freeze({ INSUFFICIENT: 0, DECLINING: 0, EMERGING: 1, ESTABLISHED: 2 });

/** Direction, in the strengths engine's own words (subject direction: rising / sustaining / declining), plus what a history can add. */
const DIRECTIONS = Object.freeze(["rising", "sustaining", "declining", "variable", "insufficient"]);

/** What a history of observations of one dimension amounts to. Categorical; not a score. */
const TRAJECTORIES = Object.freeze([
  "INSUFFICIENT_HISTORY",  // fewer than two independent observations
  "STABLE_ESTABLISHED", "STABLE_EMERGING", "STABLE_DECLINING", "STABLE_INSUFFICIENT",
  "EMERGING",              // rose, now EMERGING
  "STRENGTHENING",         // rose, now ESTABLISHED
  "WEAKENING",             // fell, still at strength (ESTABLISHED → EMERGING)
  "DECLINING",             // fell, now DECLINING or INSUFFICIENT
  "RECOVERING",            // was DECLINING, now at strength again
  "VARIABLE",              // rose and fell
]);

const CHANGE_TYPES = Object.freeze([
  "STATE_CHANGED", "STATE_STABLE", "RELATIONSHIP_CHANGED", "RELATIONSHIP_STABLE", "DIRECTION_CHANGED", "PERSISTENCE_CHANGED",
  "EVIDENCE_ADDED", "EVIDENCE_RETRACTED", "EVIDENCE_BECAME_STALE", "EVIDENCE_COVERAGE_CHANGED",
  "CONTRADICTION_STARTED", "CONTRADICTION_PERSISTED", "CONTRADICTION_RESOLVED", "NO_MEANINGFUL_CHANGE",
]);

const REASON_CODES = Object.freeze([
  "ACADEMIC_STATE_CHANGED", "LEARNING_CORROBORATION_ADDED", "LEARNING_CORROBORATION_LOST", "LEARNING_CONTRADICTION_ADDED",
  "LEARNING_CONTRADICTION_PERSISTED", "LEARNING_CONTRADICTION_RESOLVED", "CONTRADICTION_NOT_CURRENTLY_OBSERVED",
  "EVIDENCE_COVERAGE_EXPANDED", "EVIDENCE_COVERAGE_REDUCED", "EVIDENCE_BECAME_STALE", "EVIDENCE_RETRACTED",
  "EXPLORATION_EVIDENCE_ADDED", "TEACHER_OBSERVATION_ADDED", "PROFILE_VERSION_CHANGED", "INSUFFICIENT_HISTORY",
  "ACADEMIC_DIRECTION_CHANGED", "ACADEMIC_PERSISTENCE_CHANGED", "NEW_EVIDENCE_WITHOUT_STATE_CHANGE",
]);

const CONTRADICTION_STATUS = Object.freeze(["NEW", "RECURRING", "PERSISTENT", "RESOLVED", "STALE", "INSUFFICIENT_HISTORY"]);

/** Windows, shared with the strengths and learning layers: recent ≤ 120 days, historical ≤ 365 days, stale beyond. */
const WINDOWS = Object.freeze({ recentDays: 120, historicalDays: 365 });

const RULES = Object.freeze({
  independentObservationsForHistory: 2,   // fewer → INSUFFICIENT_HISTORY; nothing is stable, rising or falling on one observation
  observationsToResolveContradiction: 2,  // a contradiction is RESOLVED only after two later independent observations without it
  familiesForBroadCoverage: 3,            // the fusion layer's own bar
});

/** Keys the engine must never emit. Asserted absent by the check. */
const FORBIDDEN_KEYS = Object.freeze(["developmentScore", "growthScore", "talentScore", "potentialScore", "abilityScore", "intelligenceScore", "careerScore"]);

const NOT_INFERRED = Object.freeze([
  "growth_rate", "future_performance", "career", "personality", "motivation", "intelligence", "potential", "student_ranking", "cause_of_change",
]);

module.exports = {
  DEVELOPMENT_ENGINE_VERSION, STATES, STATE_RANK, DIRECTIONS, TRAJECTORIES, CHANGE_TYPES, REASON_CODES, CONTRADICTION_STATUS, WINDOWS, RULES, FORBIDDEN_KEYS, NOT_INFERRED,
};
