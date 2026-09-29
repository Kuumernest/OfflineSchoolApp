// shared/advancedIntelligence/index.js
"use strict";

/**
 * The Advanced Intelligence layer — one entry point for the server, the
 * desktop, the calibration tooling and the checks.
 *
 * Sits ABOVE the deterministic engines and consumes them:
 *
 *   evidence context  ← academic, strengths, learning, development, guidance,
 *                       interventions, plans, exploration (whitelisted,
 *                       viewer-projected, dated at asOf, hashed)
 *   synthesis         ← per-dimension and cross-domain reading of what the
 *                       engines said (copies and counts; no new state)
 *   questions         ← deterministic classification, injection screen
 *   explanation       ← answer facts, deterministic answer, grounding validator
 *   exploration       ← evidence-grounded domains, unranked, never a career
 *   provider          ← the request every model receives; the null provider
 *
 * Pure throughout: no database, no Express, no identity, no filesystem, no
 * network, no clock, no model call. The application boundary composes the
 * pipeline with `prepare`, `answerDeterministically` and `acceptModelOutput`.
 * Deterministic engine wins; a model explains.
 */

const version = require("./version");
const hash = require("./hash");
const safety = require("./safety");
const questions = require("./questions");
const evidenceContext = require("./evidenceContext");
const citations = require("./citations");
const synthesis = require("./synthesis");
const contracts = require("./contracts");
const provider = require("./provider");
const explanation = require("./explanation");
const exploration = require("./exploration");

/** Context and synthesis from the loaded engine outputs. */
const prepare = (inputs) => {
  const context = evidenceContext.buildEvidenceContext(inputs);
  return { context, synthesis: synthesis.synthesize(context) };
};

/** Classify, choose facts, answer deterministically. What the offline road returns, and every fallback. */
const answerDeterministically = ({ context, synthesis: syn, question, lang = "en", subjects = [], planIds = [], areas = [] } = {}) => {
  const classification = questions.classifyQuestion({ text: question, subjects, planIds, areas });
  const facts = version.NARRATABLE_CATEGORIES.includes(classification.category) ? explanation.answerFacts({ context, synthesis: syn, classification, lang }) : [];
  const output = explanation.deterministicAnswer({ context, synthesis: syn, classification, facts, lang });
  const mode = version.NARRATABLE_CATEGORIES.includes(classification.category) ? "DETERMINISTIC" : "REFUSED";
  return { classification, facts, output, mode, validation: { valid: true, issues: [] } };
};

/**
 * Take a provider's structured output through the validator. Valid → the
 * model's words, MODEL_VALIDATED. Anything else → the deterministic answer,
 * DETERMINISTIC_FALLBACK with the issues attached. The deterministic answer
 * is computed here from the same facts, so the fallback is byte-identical to
 * what the offline road would have said.
 */
const acceptModelOutput = ({ context, synthesis: syn, classification, facts, modelOutput, unauthorizedTerms = [], lang = "en" } = {}) => {
  const validation = explanation.validateExplanation({ output: modelOutput, context, unauthorizedTerms });
  if (validation.valid) return { output: modelOutput, mode: "MODEL_VALIDATED", validation, fallbackReason: null };
  return { output: explanation.deterministicAnswer({ context, synthesis: syn, classification, facts, lang }), mode: "DETERMINISTIC_FALLBACK", validation, fallbackReason: "VALIDATION_FAILED" };
};

module.exports = {
  ...version,
  hash, safety, questions, evidenceContext, citations, synthesis, contracts, provider, explanation, exploration,
  buildEvidenceContext: evidenceContext.buildEvidenceContext, synthesize: synthesis.synthesize, classifyQuestion: questions.classifyQuestion,
  answerFacts: explanation.answerFacts, deterministicAnswer: explanation.deterministicAnswer, validateExplanation: explanation.validateExplanation,
  explorationCandidates: exploration.explorationCandidates, buildProviderRequest: provider.buildProviderRequest, NullProvider: provider.NullProvider,
  prepare, answerDeterministically, acceptModelOutput,
};
