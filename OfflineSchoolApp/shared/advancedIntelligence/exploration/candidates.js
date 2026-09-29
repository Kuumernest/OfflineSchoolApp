// shared/advancedIntelligence/exploration/candidates.js
"use strict";

/**
 * Evidence-grounded exploration candidates.
 *
 * Not career prediction. A candidate is a broad domain the pupil's current
 * evidence supports, with why it appeared, what supports it, what does not,
 * how good the evidence is, activities from the existing catalog to
 * investigate it, questions to ask while doing so, skills to try, and what
 * the evidence cannot say. Several candidates appear at once and stay
 * together, alphabetically: there is no ranking, no winner, no "best", no
 * fit, no match, no probability (version.js FORBIDDEN_KEYS).
 *
 * The bridge this makes: strength → exploration → new experience → new
 * evidence → development. The deterministic exploration engine (Stage 10)
 * remains the authority for what is available, started, completed and what
 * evidence an activity generates; this file selects from its catalog and
 * explains relevance, it does not replace the recommender.
 */

const { DOMAINS } = require("./domains");
const ex = require("../../exploration");
const V = require("../version");
const { V_QUALITY } = require("../synthesis");

const LEVEL_ORDER = { INTRODUCTORY: 0, INTERMEDIATE: 1, EXTENDED: 2 };
const SUPPORTIVE_PERFORMANCE = new Set(["strong", "demonstrated"]);
const READ = new Set(["ESTABLISHED", "EMERGING"]);

const candidateFor = ({ domain, context, synthesis, catalog, lang }) => {
  const S = context.sources;
  const dims = synthesis.dimensions.filter((d) => domain.primaryDimensions.includes(d.dimension) || domain.secondaryDimensions.includes(d.dimension));
  const areas = domain.areas;
  const supporting = [], contradictory = [];
  for (const d of dims) {
    const primary = domain.primaryDimensions.includes(d.dimension), sid = `STRENGTH_PROFILE:${d.dimension}`;
    if (READ.has(d.academicState)) supporting.push({ code: d.academicState === "ESTABLISHED" ? "ESTABLISHED_STRENGTH" : "EMERGING_STRENGTH", dimension: d.dimension, primary, state: d.academicState, persistence: d.persistence, trajectory: d.trajectory, sourceId: S.strengths.some((x) => x.sourceId === sid) ? sid : `DEVELOPMENT_HISTORY:${d.dimension}` });
    if (d.academicState === "DECLINING") contradictory.push({ code: "DECLINING_EVIDENCE", dimension: d.dimension, primary, trajectory: d.trajectory, sourceId: S.strengths.some((x) => x.sourceId === sid) ? sid : `DEVELOPMENT_HISTORY:${d.dimension}` });
    if (d.learningRelationship === "CORROBORATED" || d.learningRelationship === "PARTIALLY_CORROBORATED") supporting.push({ code: "LEARNING_EVIDENCE_CORROBORATES", dimension: d.dimension, primary, relationship: d.learningRelationship, sourceId: sid });
    if (d.learningRelationship === "CONTRADICTED") contradictory.push({ code: "LEARNING_EVIDENCE_CONTRADICTS", dimension: d.dimension, primary, sourceId: sid });
    for (const c of d.contradictions) contradictory.push({ code: "CONTRADICTION_ON_RECORD", dimension: d.dimension, primary, kind: c.kind, status: c.status, sourceId: `DEVELOPMENT_HISTORY:contradiction:${d.dimension}:${c.kind}` });
  }
  for (const a of S.strengths.filter((x) => x.area && x.evidenceLevel && areas.includes(x.area))) supporting.push({ code: "EXPLORATION_AREA_OPEN", area: a.area, evidenceLevel: a.evidenceLevel, openedBy: a.openedBy, sourceId: a.sourceId });
  for (const i of S.strengths.filter((x) => x.signals && x.area && areas.includes(x.area))) supporting.push({ code: "STUDENT_INTEREST", area: i.area, signals: i.signals, sourceId: i.sourceId });
  const explored = S.exploration.filter((x) => areas.includes(x.area));
  for (const e of explored) {
    if (e.status === "COMPLETED" && (SUPPORTIVE_PERFORMANCE.has(e.performanceLevel) || e.reflection?.continue === "YES" || e.reflection?.interest === "HIGH")) supporting.push({ code: "EXPLORATION_COMPLETED", area: e.area, activityId: e.activityId, performanceLevel: e.performanceLevel ?? null, sourceId: e.sourceId });
    else if (e.status === "COMPLETED" && e.performanceLevel === "limited") contradictory.push({ code: "EXPLORATION_NOT_SUPPORTIVE", area: e.area, activityId: e.activityId, performanceLevel: e.performanceLevel, sourceId: e.sourceId });
    else if (e.status === "NOT_INTERESTED" || e.reflection?.continue === "NO" || e.reflection?.interest === "LOW") contradictory.push({ code: "EXPLORATION_NOT_SUPPORTIVE", area: e.area, activityId: e.activityId, reason: e.status === "NOT_INTERESTED" ? "NOT_INTERESTED" : "REFLECTION", sourceId: e.sourceId });
  }
  const opens = supporting.some((s) => ((s.code === "ESTABLISHED_STRENGTH" || s.code === "EMERGING_STRENGTH") && s.primary) || s.code === "EXPLORATION_AREA_OPEN" || s.code === "EXPLORATION_COMPLETED" || s.code === "STUDENT_INTEREST");
  const text = domain.text[lang === "fr" ? "fr" : "en"];
  if (!opens) {
    const reason = contradictory.some((c) => c.code === "DECLINING_EVIDENCE" && c.primary) ? "DECLINING_ONLY" : supporting.some((s) => !s.primary && (s.code === "ESTABLISHED_STRENGTH" || s.code === "EMERGING_STRENGTH")) ? "SECONDARY_DIMENSION_ONLY" : "INSUFFICIENT_EVIDENCE";
    return { supported: false, domain: domain.domain, label: text.label, reason, contradictoryEvidence: contradictory, citations: [...new Set([...supporting, ...contradictory].map((x) => x.sourceId))].sort() };
  }
  const qualities = dims.filter((d) => domain.primaryDimensions.includes(d.dimension) && READ.has(d.academicState) && V_QUALITY.includes(d.evidenceQuality)).map((d) => d.evidenceQuality);
  const evidenceQuality = qualities.length ? qualities.sort((a, b) => V_QUALITY.indexOf(b) - V_QUALITY.indexOf(a))[0] : "NOT_AVAILABLE";
  const exploredBy = new Map(explored.map((e) => [e.activityId, e.status]));
  const activities = (catalog ?? ex.ACTIVITIES).filter((a) => a.status === "active" && areas.includes(a.area))
    .sort((a, b) => areas.indexOf(a.area) - areas.indexOf(b.area) || LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.activityId.localeCompare(b.activityId))
    .map((a) => ({ activityId: a.activityId, area: a.area, level: a.level, estimatedMinutes: a.estimatedMinutes, resources: a.resources, title: ex.localize(a, lang).title, explored: exploredBy.get(a.activityId) ?? null }));
  const limitations = ["EVIDENCE_IS_CURRENT_NOT_PREDICTIVE"];
  if (!explored.length) limitations.push("NO_EXPLORATION_EVIDENCE_IN_DOMAIN");
  if (new Set(supporting.filter((s) => s.dimension).map((s) => s.dimension)).size <= 1) limitations.push("SINGLE_DIMENSION");
  if (contradictory.length) limitations.push("CONTRADICTORY_EVIDENCE_PRESENT");
  if (!synthesis.overall.historySufficient) limitations.push("HISTORY_INSUFFICIENT");
  if (context.limitations.includes("EXPLORATION_STATE_IS_CURRENT")) limitations.push("EXPLORATION_STATE_IS_CURRENT");
  return {
    supported: true, domain: domain.domain, label: text.label, description: text.description,
    whyItAppeared: supporting.map((s) => ({ code: s.code, dimension: s.dimension ?? null, area: s.area ?? null, sourceId: s.sourceId })),
    supportingEvidence: supporting, contradictoryEvidence: contradictory, evidenceQuality, activities,
    questionsToInvestigate: domain.questionsToInvestigate[lang === "fr" ? "fr" : "en"], skillsToExplore: domain.skillsToExplore[lang === "fr" ? "fr" : "en"],
    whatYouWouldLearn: { code: "NEW_EVIDENCE_IN_AREAS", areas, evidenceTypes: ex.EVIDENCE_TYPES },
    limitations: limitations.sort(), citations: [...new Set([...supporting, ...contradictory].map((x) => x.sourceId))].sort(),
  };
};

/**
 * Every domain, read against the context and the synthesis. Candidates in
 * alphabetical order; the unsupported ones with their reason. No ranking.
 */
const explorationCandidates = ({ context, synthesis, catalog = null, lang = "en" } = {}) => {
  if (!context || !synthesis) { const e = new Error("context and synthesis are required"); e.code = "CONTEXT_REQUIRED"; throw e; }
  const all = DOMAINS.map((domain) => candidateFor({ domain, context, synthesis, catalog, lang }));
  const byDomain = (a, b) => a.domain.localeCompare(b.domain);
  return {
    advancedIntelligenceVersion: V.ADVANCED_INTELLIGENCE_VERSION, explorationEngineVersion: ex.EXPLORATION_ENGINE_VERSION, asOf: context.asOf, evidenceBoundaryHash: context.evidenceBoundaryHash, viewer: context.viewer,
    ordering: "ALPHABETICAL_NOT_RANKED", winner: null,
    candidates: all.filter((c) => c.supported).map(({ supported, ...c }) => c).sort(byDomain),
    notSupported: all.filter((c) => !c.supported).map(({ supported, ...c }) => c).sort(byDomain),
    statement: { code: "EXPLORATION_NOT_CAREER_PREDICTION", causal: false, decidedBy: "STUDENT" },
    notInferred: V.NOT_INFERRED,
  };
};

/** A career question, turned into what this system can honestly answer. */
const careerToExploration = (candidates) => ({
  code: "CAREER_QUESTION_TRANSFORMED_TO_EXPLORATION", prediction: null, recommendation: null,
  areas: candidates.candidates.map((c) => c.domain), ordering: candidates.ordering, decidedBy: "STUDENT",
});

module.exports = { explorationCandidates, candidateFor, careerToExploration };
