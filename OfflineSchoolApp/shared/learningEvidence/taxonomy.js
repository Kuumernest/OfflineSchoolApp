// shared/learningEvidence/taxonomy.js
"use strict";

/**
 * The vocabulary of the learning-evidence layer.
 *
 * ── The one rule ──────────────────────────────────────────────────────────
 *
 * More data is not more intelligence. A quiz mark, a homework submission
 * time, an attendance register and a practical score are four different
 * kinds of fact; each is kept as what it is, with a meaning, an authority, a
 * state vocabulary and a limitation, and none is converted into another.
 *
 * ── What exists in this application, and what does not ───────────────────
 *
 *   HOMEWORK      assignments set to a class, with a pupil's submission, its
 *                 time, its score — the application's "assignments"
 *   QUIZ          a pupil's attempt at a published quiz, with a score
 *   EXAM_SCORE    a subject mark in an assessment: a test, a promotion exam,
 *                 continuous assessment (coursework) or a PRACTICAL
 *   ATTENDANCE    a dated register entry: present, absent, late, excused
 *
 * Participation records and project records do not exist as sources here and
 * are not invented; the only participation evidence the platform holds is the
 * exploration layer's, which already has its own row.
 */

const SOURCE_TYPES = Object.freeze(["HOMEWORK", "QUIZ", "EXAM_SCORE", "ATTENDANCE"]);

/** The five categories. Engagement and context are never ability. */
const EVIDENCE_TYPES = Object.freeze(["ACHIEVEMENT", "SKILL", "ENGAGEMENT", "PERSISTENCE", "CONTEXT"]);

const AUTHORITY = Object.freeze({
  ACHIEVEMENT: "demonstrated performance on a specific learning task — not, by itself, a subject strength",
  SKILL:       "demonstrated skill on an observable task (a practical) — distinct from formal assessment",
  ENGAGEMENT:  "interaction with a learning opportunity — never ability",
  PERSISTENCE: "sustained engagement over repeated tasks — never a trait",
  CONTEXT:     "what limits or frames the other evidence — never a strength, never a weakness",
});

/** How an assessment's kind maps onto a family the patterns are read in. */
const ASSESSMENT_FAMILY = Object.freeze({
  test:           "formal",
  promotion_exam: "formal",
  ca:             "continuous",
  practical:      "practical",
});
const FAMILIES = Object.freeze(["formal", "continuous", "practical", "quiz", "homework"]);

/** What a single observation is about. Kept apart on the event. */
const OBSERVATION_KINDS = Object.freeze(["performance", "submission", "completion", "attendance", "context"]);

/** Semantic states. None of these is ever converted into a zero. */
const STATES = Object.freeze([
  "VALID", "ZERO", "NULL_SCORE", "ABSENT", "EXEMPT", "UNPUBLISHED",
  "NOT_SUBMITTED", "NOT_GRADED", "PENDING", "IN_PROGRESS", "ABANDONED", "TIMED_OUT",
]);
const VALUE_STATES = Object.freeze(["VALID", "ZERO"]);

const SUBMISSION_TIMING = Object.freeze(["ON_TIME", "LATE", "VERY_LATE", "MISSING", "NO_DEADLINE", "PENDING"]);
const ATTENDANCE_STATUS  = Object.freeze(["present", "absent", "late", "excused"]);

const RECENCY = Object.freeze(["RECENT", "HISTORICAL", "STALE"]);

const PERFORMANCE_PATTERNS = Object.freeze(["IMPROVING", "DECLINING", "VARIABLE", "CONSISTENT", "INSUFFICIENT_EVIDENCE"]);
const COMPLETION_PATTERNS  = Object.freeze(["CONSISTENTLY_COMPLETED", "OFTEN_COMPLETED", "OFTEN_MISSING", "INSUFFICIENT_EVIDENCE"]);
const SUBMISSION_PATTERNS  = Object.freeze(["MOSTLY_ON_TIME", "OFTEN_LATE", "INSUFFICIENT_EVIDENCE"]);
const ATTENDANCE_PATTERNS  = Object.freeze(["ATTENDANCE_STABLE", "ATTENDANCE_IRREGULAR", "ATTENDANCE_DECLINING", "ATTENDANCE_IMPROVING", "INSUFFICIENT_ATTENDANCE_DATA"]);

const QUALITY = Object.freeze(["NO_DATA", "INSUFFICIENT_DATA", "SPARSE_DATA", "GOOD_COVERAGE", "STRONG_COVERAGE"]);
const QUALITY_FLAGS = Object.freeze(["STALE_DATA", "INCOMPLETE_PERIOD", "CONFLICTING_DATA", "LIMITED_BY_ATTENDANCE"]);

const CONTRADICTIONS = Object.freeze([
  "FORMAL_VS_CONTINUOUS_ASSESSMENT", "THEORY_VS_PRACTICAL", "PERFORMANCE_VS_ENGAGEMENT",
  "ATTENDANCE_VS_COMPLETION", "RECENT_VS_HISTORICAL",
]);

/** The integration boundary: which signals may currently influence which engine. All informational in 1.0.0. */
const SIGNALS = Object.freeze(["ACHIEVEMENT_SIGNAL", "SKILL_SIGNAL", "ENGAGEMENT_SIGNAL", "PERSISTENCE_SIGNAL", "CONTEXT_SIGNAL", "COVERAGE_SIGNAL"]);
const INTEGRATION = Object.freeze({
  strengthEngine:    [],
  explorationEngine: [],
  guidance:          [],
});

/**
 * Every number the layer reasons with. Normalised values are 0..1.
 */
const THRESHOLDS = Object.freeze({
  recentDays: 120,
  historicalDays: 365,
  minEventsForPattern: 3,           // independent, valid, non-stale
  minAttendanceDays: 10,
  veryLateDays: 7,
  directionDelta: 0.10,             // recent-half mean vs earlier-half mean
  consistentSpread: 0.10,
  variableSpread: 0.20,
  completionConsistent: 0.90,
  completionOften: 0.60,
  onTimeMostly: 0.80,
  attendanceStable: 0.90,
  attendanceTrendDelta: 0.10,
  contradictionDelta: 0.15,
  minEventsForContradiction: 3,
  minPracticalForContradiction: 2,   // practicals are rare
  sparseBelow: 6,
  goodBelow: 12,
});

/** Input rows may not carry identity. The pure layer refuses them. */
const FORBIDDEN_KEYS = Object.freeze([
  "name", "studentname", "firstname", "lastname", "fullname", "phone", "email", "address",
  "guardian", "guardianname", "guardianphone", "guardianemail", "token", "password", "codehash",
]);

const NOT_INFERRED = Object.freeze([
  "personality", "motivation", "discipline", "laziness", "intelligence", "ability_from_attendance",
  "ability_from_participation", "career", "dropout_risk", "mental_health", "student_ranking", "student_score",
]);

module.exports = {
  SOURCE_TYPES, EVIDENCE_TYPES, AUTHORITY, ASSESSMENT_FAMILY, FAMILIES, OBSERVATION_KINDS,
  STATES, VALUE_STATES, SUBMISSION_TIMING, ATTENDANCE_STATUS, RECENCY,
  PERFORMANCE_PATTERNS, COMPLETION_PATTERNS, SUBMISSION_PATTERNS, ATTENDANCE_PATTERNS,
  QUALITY, QUALITY_FLAGS, CONTRADICTIONS, SIGNALS, INTEGRATION, THRESHOLDS, FORBIDDEN_KEYS, NOT_INFERRED,
};
