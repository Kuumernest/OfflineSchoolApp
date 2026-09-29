// backend/src/services/intelligence/advancedIntelligence.service.js
"use strict";

/**
 * The advanced intelligence layer, loaded and served — the application
 * boundary where a model may be called, and the only place it is.
 *
 * ── The pipeline ──────────────────────────────────────────────────────────
 *
 *   authorise (the router) → load the engines' readings for one pupil on
 *   one day (the same loaders every intelligence route uses) → evidence
 *   context, projected for the viewer → deterministic synthesis → classify
 *   the question → deterministic answer facts → [provider, bounded by a
 *   timeout] → validator → reader
 *
 * The deterministic answer is computed before any provider is asked, and
 * it is what the reader gets when there is no provider (the offline road),
 * when the provider fails, times out, is refused or over quota, when the
 * reply is malformed, and when the validator rejects a claim. A model that
 * answers well changes the words; it never changes a fact.
 *
 * ── What is never done here ───────────────────────────────────────────────
 *
 * Nothing is written. No plan, intervention, milestone, strength, guidance,
 * mark or notification is created or changed on this path, and the provider
 * is handed no tool with which to do so. The audit block returned with each
 * answer holds what reproduces it — versions, asOf, the boundary hash,
 * provider and model names, the request type, the citation ids, the
 * validation result — and never the question text or the answer text; the
 * response carries those to the reader once and nothing stores them.
 */

const ai = require("../../../../shared/advancedIntelligence");
const ex = require("../../../../shared/exploration");
const iv = require("../../../../shared/interventions");
const dp = require("../../../../shared/developmentPlanning");
const asup = require("../../../../shared/adaptiveSupport");
const strengthsSvc = require("./strengths.service");
const subjectInsights = require("./subjectInsights.service");
const learningSvc = require("./learningEvidence.service");
const developmentSvc = require("./development.service");
const guidanceSvc = require("./developmentGuidance.service");
const interventionsSvc = require("./developmentInterventions.service");
const plansSvc = require("./developmentPlans.service");
const explorationSvc = require("./exploration.service");
const providers = require("./providers");

const QUESTION_MAX = ai.safety.MAX_UNTRUSTED;

// ─────────────────────────────────────────────────────────────────────────────
// THE PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

let override;
/** Tests inject a provider; `configure()` with no argument returns to the environment's. */
const configure = ({ provider } = {}) => { override = provider === undefined ? undefined : provider; };
let fromEnv = null;
const providerInUse = () => { if (override !== undefined) return override; if (!fromEnv) fromEnv = providers.providerFromEnv(); return fromEnv; };
const timeoutMs = () => (Number(process.env.ADVANCED_INTELLIGENCE_TIMEOUT_MS) > 0 ? Number(process.env.ADVANCED_INTELLIGENCE_TIMEOUT_MS) : providers.DEFAULT_TIMEOUT_MS);

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { const e = new Error(`the provider did not answer within ${ms}ms`); e.code = "PROVIDER_TIMEOUT"; reject(e); }, ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STATE
// ─────────────────────────────────────────────────────────────────────────────

const explorationViewerOf = (viewer) => (viewer === "student" ? "student" : viewer === "parent" ? "guardian" : "staff");
const planViewerOf = (viewer) => (viewer === "student" ? "student" : viewer === "parent" ? "parent" : "staff");
const isStaff = (viewer) => !["student", "parent"].includes(viewer);

/** Every engine's reading for one pupil on one day, through the loaders the routes already use. Nothing is written. */
const loadState = async ({ schoolId, studentId, asOf = null, viewer, lang = "en" }) => {
  const id = String(studentId), at = asOf ?? strengthsSvc.startOfToday();
  const [academicProfile, strengthProfile, learningEvidence, development, guidance, interventionDocs, planDocs, explorations] = await Promise.all([
    subjectInsights.profileFor({ schoolId, studentId: id }),
    strengthsSvc.profileFor({ schoolId, studentId: id, asOf: at }),
    learningSvc.readingFor({ schoolId, studentId: id, asOf: at }),
    developmentSvc.historyFor({ schoolId, studentId: id, asOf: at }),
    guidanceSvc.guidanceFor({ schoolId, studentId: id, asOf: at }),
    interventionsSvc.listFor({ schoolId, studentId: id }),
    plansSvc.listFor({ schoolId, studentId: id }),
    explorationSvc.history({ schoolId, studentId: id, viewer: explorationViewerOf(viewer), lang }),
  ]);
  const interventionTriggers = development ? iv.triggersFor({ development, guidance }) : [];
  const interventions = await Promise.all(interventionDocs.map(async (d) => interventionsSvc.view(d, { outcome: await interventionsSvc.outcomeFor(d, { asOf: at }), staff: isStaff(viewer) })));
  // The plan is reconstructed on the asOf the caller asked for, exactly as the
  // plan routes do: none asked → the plan as it stands (a plan opened this
  // morning exists); a date → the plan as of that date. The engines read at `at`.
  const plans = (await Promise.all(planDocs.map(async (d) => plansSvc.view(d, { asOf, viewer: planViewerOf(viewer), system: ["ACTIVE", "REVIEW_DUE"].includes(d.status) ? await plansSvc.systemReview({ doc: d, schoolId, studentId: id, asOf: at }) : null })))).filter(Boolean);
  return {
    at, academicProfile, strengthProfile, learningEvidence, development, guidance, interventionTriggers, interventions, plans, explorations,
    engineVersions: { exploration: ex.EXPLORATION_ENGINE_VERSION, intervention: iv.INTERVENTION_ENGINE_VERSION, planning: dp.DEVELOPMENT_PLANNING_ENGINE_VERSION, adaptive: asup.ADAPTIVE_SUPPORT_ENGINE_VERSION },
  };
};

const prepareFor = async (args) => {
  const state = await loadState(args);
  const { context, synthesis } = ai.prepare({ asOf: state.at, viewer: args.viewer, engineVersions: state.engineVersions, academicProfile: state.academicProfile, strengthProfile: state.strengthProfile, learningEvidence: state.learningEvidence, development: state.development, guidance: state.guidance, interventions: state.interventions, interventionTriggers: state.interventionTriggers, plans: state.plans, explorations: state.explorations });
  return { state, context, synthesis };
};

const auditOf = ({ context, provider, requestType, classification = null, output = null, validation = null, mode, fallbackReason = null }) => ({
  advancedIntelligenceVersion: ai.ADVANCED_INTELLIGENCE_VERSION, contextVersion: context.contextVersion, asOf: context.asOf, evidenceBoundaryHash: context.evidenceBoundaryHash, engineVersions: context.engineVersions,
  provider: provider?.name ?? "none", model: provider?.model ?? null, requestType, questionCategory: classification?.category ?? null,
  citationIds: [...new Set((output?.claims ?? []).flatMap((c) => c.citations ?? []))].sort(), validationResult: validation ? { valid: validation.valid, issues: validation.issues.map((i) => i.code) } : null, mode, fallbackReason,
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/** The deterministic summary: context, synthesis, exploration candidates. Never a model. What the offline road shows. */
const summaryFor = async ({ schoolId, studentId, asOf = null, viewer, lang = "en" }) => {
  const { context, synthesis } = await prepareFor({ schoolId, studentId, asOf, viewer, lang });
  const exploration = ai.explorationCandidates({ context, synthesis, lang });
  return {
    advancedIntelligenceVersion: ai.ADVANCED_INTELLIGENCE_VERSION, contextVersion: context.contextVersion, asOf: context.asOf, viewer, evidenceBoundaryHash: context.evidenceBoundaryHash, engineVersions: context.engineVersions, sourceTypes: context.sourceTypes,
    synthesis: { dimensions: synthesis.dimensions, subjects: synthesis.subjects, crossDomain: synthesis.crossDomain, overall: synthesis.overall },
    exploration, evidence: context.sources, contradictions: context.contradictions, evidenceQuality: context.evidenceQuality, limitations: context.limitations, citationIndex: ai.citations.citationIndex(context),
    notInferred: context.notInferred, authority: context.authority, mode: "DETERMINISTIC",
    audit: auditOf({ context, provider: null, requestType: "summarize", mode: "DETERMINISTIC" }),
  };
};

/**
 * Explain or answer. `operation` is "explain" or "answer"; both run the same
 * pipeline and differ only in the request type the provider and the audit
 * see. `identity` carries the names the answer may not contain.
 */
const explain = async ({ schoolId, studentId, asOf = null, viewer, lang = "en", question, operation = "explain", identity = null }) => {
  const { state, context, synthesis } = await prepareFor({ schoolId, studentId, asOf, viewer, lang });
  const subjects = (state.academicProfile?.subjects ?? []).map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName ?? null }));
  const det = ai.answerDeterministically({ context, synthesis, question, lang, subjects, planIds: state.plans.map((p) => p.planId), areas: ex.AREAS });
  const provider = providerInUse();
  const finish = ({ output, mode, validation, fallbackReason }) => ({
    classification: { category: det.classification.category, transformed: det.classification.transformed, threats: det.classification.threats, topic: det.classification.topic },
    mode, fallbackReason, output, citations: ai.citations.resolve(context, [...new Set(output.claims.flatMap((c) => c.citations ?? []))]).map((r) => ({ sourceId: r.sourceId, item: r.item })),
    validation: { valid: validation.valid, issues: validation.issues.map((i) => ({ code: i.code, claim: i.claim ?? null, detail: i.detail ?? null })) },
    asOf: context.asOf, evidenceBoundaryHash: context.evidenceBoundaryHash, engineVersions: context.engineVersions, contextVersion: context.contextVersion, advancedIntelligenceVersion: ai.ADVANCED_INTELLIGENCE_VERSION,
    audit: auditOf({ context, provider: mode === "MODEL_VALIDATED" || mode === "DETERMINISTIC_FALLBACK" ? provider : null, requestType: operation, classification: det.classification, output, validation, mode, fallbackReason }),
  });
  // A refused category never reaches a provider; a null provider is the offline road.
  if (det.mode === "REFUSED") return finish({ output: det.output, mode: "REFUSED", validation: det.validation, fallbackReason: null });
  if (!provider || provider.name === "none") return finish({ output: det.output, mode: "DETERMINISTIC", validation: det.validation, fallbackReason: "PROVIDER_NOT_CONFIGURED" });
  const request = ai.buildProviderRequest({ operation, context, synthesis, facts: det.facts, question, classification: det.classification, lang });
  let modelOutput;
  try {
    modelOutput = await withTimeout(Promise.resolve(provider[operation === "answer" ? "answer" : "explain"](request)), timeoutMs());
  } catch (err) {
    const reason = ai.provider.classifyProviderError(err);
    console.warn(`[advanced-intelligence] provider ${provider.name} unavailable (${reason}); deterministic answer used`);
    return finish({ output: det.output, mode: "DETERMINISTIC_FALLBACK", validation: det.validation, fallbackReason: reason });
  }
  const accepted = ai.acceptModelOutput({ context, synthesis, classification: det.classification, facts: det.facts, modelOutput, unauthorizedTerms: [identity?.name, identity?.enrollmentNo].filter(Boolean), lang });
  return finish({ output: accepted.output, mode: accepted.mode, validation: accepted.validation, fallbackReason: accepted.fallbackReason });
};

module.exports = { configure, providerInUse, loadState, prepareFor, summaryFor, explain, QUESTION_MAX };
