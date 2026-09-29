// shared/advancedIntelligence/version.js
"use strict";

/**
 * Advanced Intelligence 1.0.0 — the vocabulary.
 *
 * ── What this layer is ────────────────────────────────────────────────────
 *
 * A consumer of the deterministic engines beneath it, never a producer of
 * an authoritative state. It explains, synthesises and helps a pupil explore;
 * it does not calculate a mark, a strength, a trajectory, a guidance
 * category, a trigger, a plan state or an adaptive decision, and it cannot
 * change one. Where a generated sentence and an engine disagree, the engine
 * wins and the sentence is discarded.
 *
 * Everything in this directory is pure: no database, no Express, no
 * identity, no filesystem, no network, no clock (asOf is an input), and —
 * this is the point of the directory — no model call. A language model is
 * reached only at the application boundary (backend/src/services/
 * intelligence/advancedIntelligence.service.js), through a provider that
 * receives a structured context and returns a structured answer, and that
 * answer passes through the validator here before anybody reads it.
 */

const ADVANCED_INTELLIGENCE_VERSION = "1.0.0";
/** The shape of the evidence context handed to a provider. Bumped when a field is added or removed. */
const CONTEXT_VERSION = "1.0.0";

/** What a generated sentence may be. An unsupported inference is never presented as a fact. */
const CLAIM_TYPES = Object.freeze(["OBSERVED", "INFERRED_BY_DETERMINISTIC_ENGINE", "SUGGESTED_EXPLORATION", "UNCERTAIN", "NOT_AVAILABLE"]);
/** The claim types that must carry at least one citation. */
const CITED_CLAIM_TYPES = Object.freeze(["OBSERVED", "INFERRED_BY_DETERMINISTIC_ENGINE"]);

/** Where a citation may point. Every id in the context is `<SOURCE_TYPE>:<key>`. */
const SOURCE_TYPES = Object.freeze(["ACADEMIC_PROFILE", "STRENGTH_PROFILE", "LEARNING_EVIDENCE", "DEVELOPMENT_HISTORY", "EXPLORATION", "GUIDANCE", "INTERVENTION", "DEVELOPMENT_PLAN", "PLAN_REVIEW"]);

/** Who is asking. The context builder projects for the viewer; the routes decide who the viewer is. */
const VIEWERS = Object.freeze(["student", "teacher", "parent", "school_admin", "super_admin"]);

/** What a question is about, decided deterministically before any model sees it. */
const QUESTION_CATEGORIES = Object.freeze(["PROFILE_EXPLANATION", "DEVELOPMENT_EXPLANATION", "GUIDANCE_EXPLANATION", "INTERVENTION_EXPLANATION", "PLAN_EXPLANATION", "EVIDENCE_QUESTION", "EXPLORATION_QUESTION", "GENERAL_EDUCATIONAL", "UNSUPPORTED", "SENSITIVE", "UNAUTHORIZED"]);
/** Categories a model may narrate. The rest are answered deterministically or refused. */
const NARRATABLE_CATEGORIES = Object.freeze(["PROFILE_EXPLANATION", "DEVELOPMENT_EXPLANATION", "GUIDANCE_EXPLANATION", "INTERVENTION_EXPLANATION", "PLAN_EXPLANATION", "EVIDENCE_QUESTION", "EXPLORATION_QUESTION", "GENERAL_EDUCATIONAL"]);

/** What the grounding validator can find. Any of these discards the generated answer. */
const VALIDATION_CODES = Object.freeze(["MALFORMED_OUTPUT", "UNSUPPORTED_CLAIM", "CONTRADICTS_EVIDENCE", "MISSING_CITATION", "FUTURE_EVIDENCE", "UNAUTHORIZED_DATA", "CAREER_PREDICTION", "PSYCHOLOGICAL_INFERENCE", "MEDICAL_INFERENCE", "RISK_INFERENCE", "INTERVENTION_COMMAND"]);

/** What the input screen can find in a question or in any untrusted text. */
const INPUT_THREATS = Object.freeze(["INSTRUCTION_OVERRIDE", "SYSTEM_PROMPT_EXTRACTION", "CREDENTIAL_REQUEST", "PRIVATE_DATA_REQUEST", "CROSS_STUDENT_REQUEST", "TOOL_INVOCATION", "POLICY_MANIPULATION"]);

/** How the answer reached the reader. */
const ANSWER_MODES = Object.freeze(["DETERMINISTIC", "MODEL_VALIDATED", "DETERMINISTIC_FALLBACK", "REFUSED"]);
/** Why the deterministic answer was used instead of a model's. */
const FALLBACK_REASONS = Object.freeze(["PROVIDER_NOT_CONFIGURED", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_QUOTA", "PROVIDER_REFUSED", "INVALID_RESPONSE", "VALIDATION_FAILED", "CATEGORY_NOT_NARRATABLE", "OFFLINE"]);

/** The cross-domain reading of one dimension. */
const CROSS_DOMAIN = Object.freeze(["CORROBORATED_ACROSS_SOURCES", "SINGLE_SOURCE", "CONFLICTING_SOURCES", "INSUFFICIENT"]);
/** What changed for a dimension lately, in the synthesis. */
const RECENT_CHANGE = Object.freeze(["NONE", "STATE_CHANGED", "RELATIONSHIP_CHANGED", "EVIDENCE_ADDED", "CONTRADICTION", "INSUFFICIENT_HISTORY"]);

/** The authority line, stated once and asserted by the check. */
const AUTHORITY = Object.freeze({
  deterministicEngines: "AUTHORITATIVE_INTERPRETATION",
  advancedIntelligence: "EXPLANATION_SYNTHESIS_EXPLORATION_ASSISTANCE",
  onDisagreement: "DETERMINISTIC_ENGINE_WINS",
  mayModify: [],
  mayNotModify: ["marks", "grades", "attendance", "strengthStates", "developmentStates", "evidenceQuality", "contradictions", "guidanceCategories", "interventionTriggers", "interventionOutcomes", "planStates", "milestoneStates", "adaptiveSupportDecisions"],
  autonomousActions: [],
});

/** Keys that must never appear in anything this layer emits. Asserted by the check. */
const FORBIDDEN_KEYS = Object.freeze(["careerProbability", "careerFit", "careerScore", "bestCareer", "idealCareer", "predictedProfession", "studentCareerFit", "predictedCareer", "careerMatchScore", "recommendedCareer", "personality", "riskScore", "successProbability", "aptitudeScore", "abilityScore", "iq", "ranking", "rank", "score", "probability"]);

const NOT_INFERRED = Object.freeze([
  "career", "profession", "career_fit", "career_probability", "personality", "motivation", "mental_health", "medical_condition", "family_situation", "financial_situation",
  "socioeconomic_status", "intelligence", "giftedness", "risk_score", "dropout_risk", "success_probability", "student_ranking", "best_exploration_domain", "predicted_outcome",
]);

module.exports = {
  ADVANCED_INTELLIGENCE_VERSION, CONTEXT_VERSION,
  CLAIM_TYPES, CITED_CLAIM_TYPES, SOURCE_TYPES, VIEWERS, QUESTION_CATEGORIES, NARRATABLE_CATEGORIES, VALIDATION_CODES, INPUT_THREATS,
  ANSWER_MODES, FALLBACK_REASONS, CROSS_DOMAIN, RECENT_CHANGE, AUTHORITY, FORBIDDEN_KEYS, NOT_INFERRED,
};
