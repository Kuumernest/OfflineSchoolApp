// shared/guidance/version.js
"use strict";

/**
 * The Development Guidance Engine's version and vocabulary.
 *
 * This engine turns a development history (Stage 14) and the current strength
 * reading (Stage 13) into bounded, categorical guidance: what was observed,
 * what changed, what supports it, what a pupil could try, and what evidence
 * would show whether it helped. Every word is a code the interface renders;
 * nothing here is a sentence, a score, a probability or a career.
 *
 * It is distinct from the academic guidance projection in
 * shared/intelligence/guidance.js (academic 1.0.0), which projects the
 * academic engine's risk and strength insights for staff and is unchanged.
 */

const GUIDANCE_ENGINE_VERSION = "1.0.0";

/** The controlled categories. Order is the order of preference when a dimension earns several. */
const CATEGORIES = Object.freeze([
  "SEEK_SUPPORT", "CHANGE_APPROACH", "REFLECT", "BUILD_EVIDENCE", "MONITOR", "MAINTAIN", "DEEPEN", "EXPLORE", "PRACTICE", "REVISIT",
]);

/** How much and how good the evidence behind a guidance item is. Not a probability that it will help. */
const EVIDENCE_QUALITY = Object.freeze(["INSUFFICIENT", "LIMITED", "SUPPORTED", "WELL_SUPPORTED"]);

/** At most this many items per dimension, in CATEGORIES order. Bounded on purpose. */
// (Four: a strength with an open question can carry REFLECT, BUILD_EVIDENCE, MONITOR and still MAINTAIN.)
const MAX_PER_DIMENSION = 5;

/** Words the engine and its templates must never emit. Asserted by the check. */
const FORBIDDEN_KEYS = Object.freeze(["score", "probability", "ranking", "riskScore", "successProbability", "careerFit", "personality", "aptitudeScore", "abilityScore"]);
const FORBIDDEN_LANGUAGE = /\b(you must|should become|the system recommends that you|your future is|career|profession|engineer|doctor|lawyer|university|IQ|gifted|talented)\b/i;

const NOT_INFERRED = Object.freeze([
  "career", "profession", "university", "personality", "psychological_state", "intelligence", "socioeconomic_status", "dropout_risk",
  "discipline", "risk_score", "success_probability", "best_intervention", "student_ranking",
]);

module.exports = { GUIDANCE_ENGINE_VERSION, CATEGORIES, EVIDENCE_QUALITY, MAX_PER_DIMENSION, FORBIDDEN_KEYS, FORBIDDEN_LANGUAGE, NOT_INFERRED };
