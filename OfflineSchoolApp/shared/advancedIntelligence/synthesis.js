// shared/advancedIntelligence/synthesis.js
"use strict";

/**
 * Deterministic synthesis — the structured reading a model is handed to
 * explain, and the reading the offline client shows when there is no model.
 *
 * Per dimension it lines up what each engine already said: the strength
 * state (strengths 1.2.0), the trajectory and direction (development 1.0.0),
 * the learning relationship (learning integration 1.0.0), the evidence
 * quality (guidance 1.0.0 — read, never recomputed), the latest change, the
 * open contradictions, the guidance categories, the intervention triggers,
 * the plans. Then the cross-domain reading: which independent sources
 * support the same dimension, and whether they agree. "Your mathematics
 * strength is supported by both formal assessment and practical learning
 * evidence" is a sentence about a relationship the engines beneath already
 * established; this file names the relationship, a model may put it into
 * words, and neither may turn it into "so you should become an engineer".
 *
 * Nothing here is a new state. Every field is a copy of, or a count over,
 * a field an engine produced, and every dimension carries the citation ids
 * of the items it was read from.
 */

const V = require("./version");
const { WINDOWS } = require("../development/version");

const daysBetween = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;
const READ = new Set(["ESTABLISHED", "EMERGING", "DECLINING"]);
const SUPPORTING_RELATIONSHIPS = new Set(["CORROBORATED", "PARTIALLY_CORROBORATED"]);

const recentChangeOf = ({ changes, transitions, asOf }) => {
  const recent = (d) => daysBetween(d, asOf) <= WINDOWS.recentDays;
  const latest = changes.filter((c) => recent(c.observedAt)).sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))[0];
  if (latest) {
    const t = latest.changeTypes ?? [];
    if (t.includes("STATE_CHANGED")) return "STATE_CHANGED";
    if (t.includes("CONTRADICTION_STARTED") || t.includes("CONTRADICTION_PERSISTED")) return "CONTRADICTION";
    if (t.includes("RELATIONSHIP_CHANGED")) return "RELATIONSHIP_CHANGED";
    if (t.includes("EVIDENCE_ADDED")) return "EVIDENCE_ADDED";
    return "NONE";
  }
  if (transitions.some((x) => recent(x.at))) return "STATE_CHANGED";
  return "NONE";
};

const crossDomainOf = (s) => {
  const supporting = [], conflicting = [];
  if (s && READ.has(s.state)) supporting.push("ACADEMIC");
  if (s && SUPPORTING_RELATIONSHIPS.has(s.learningRelationship)) supporting.push("LEARNING_EVIDENCE");
  if (s && s.learningRelationship === "CONTRADICTED") conflicting.push("LEARNING_EVIDENCE");
  if (s && (s.explorationSupporting ?? 0) > 0) supporting.push("EXPLORATION");
  if (s && (s.explorationContradicting ?? 0) > 0) conflicting.push("EXPLORATION");
  if (s && (s.teacherObservers ?? 0) > 0) supporting.push("TEACHER_OBSERVATION");
  const kinds = s?.contradictions ?? [];
  const relationship = conflicting.length || kinds.length ? "CONFLICTING_SOURCES" : supporting.length >= 2 ? "CORROBORATED_ACROSS_SOURCES" : supporting.length === 1 ? "SINGLE_SOURCE" : "INSUFFICIENT";
  return { relationship, supportingSources: supporting, conflictingSources: conflicting, contradictionKinds: kinds, statementCode: supporting.length ? `SUPPORTED_BY:${supporting.join("+")}` : "NO_SUPPORTING_SOURCE" };
};

const synthesize = (context) => {
  if (!context?.asOf) { const e = new Error("a context is required"); e.code = "CONTEXT_REQUIRED"; throw e; }
  const S = context.sources;
  const strengthsByDim = new Map(S.strengths.filter((x) => x.dimension && x.state).map((x) => [x.dimension, x]));
  const devByDim = new Map(S.development.filter((x) => x.dimension && x.trajectory).map((x) => [x.dimension, x]));
  const areasByDim = new Map();
  for (const a of S.strengths.filter((x) => x.area && x.evidenceLevel)) for (const d of a.openedBy) areasByDim.set(d, [...(areasByDim.get(d) ?? []), a]);
  const dims = [...new Set([...strengthsByDim.keys(), ...devByDim.keys()])].sort();

  const dimensions = dims.map((dimension) => {
    const s = strengthsByDim.get(dimension) ?? null, d = devByDim.get(dimension) ?? null;
    const g = S.guidance.filter((x) => x.dimension === dimension);
    // A recorded intervention carries a lifecycle; a trigger the history supports today carries none.
    const ivDocs = S.interventions.filter((x) => x.dimension === dimension && x.lifecycle), ivTriggers = S.interventions.filter((x) => x.dimension === dimension && !x.lifecycle && x.trigger);
    const plans = S.plans.filter((x) => x.dimension === dimension);
    const reviews = S.planReviews.filter((r) => plans.some((p) => p.planId === r.planId));
    const changes = S.development.filter((x) => x.dimension === dimension && x.changeTypes);
    const contradictions = S.development.filter((x) => x.dimension === dimension && x.kind);
    const areas = (areasByDim.get(dimension) ?? []).map((a) => a.area).sort();
    const explorations = S.exploration.filter((x) => areas.includes(x.area));
    const subjects = s?.supportingSubjects ?? [];
    const cross = crossDomainOf(s);
    const citations = [
      s?.sourceId, d?.sourceId, ...g.map((x) => x.sourceId), ...ivDocs.map((x) => x.sourceId), ...ivTriggers.map((x) => x.sourceId), ...plans.map((x) => x.sourceId), ...reviews.map((x) => x.sourceId),
      ...contradictions.map((x) => x.sourceId), ...changes.slice(0, 3).map((x) => x.sourceId), ...(areasByDim.get(dimension) ?? []).map((a) => a.sourceId), ...explorations.map((x) => x.sourceId),
      ...subjects.flatMap((sub) => [S.academic.find((a) => a.subjectId === sub.subjectId)?.sourceId, S.learning.find((l) => l.subjectId === sub.subjectId)?.sourceId]),
    ].filter(Boolean);
    return {
      dimension,
      academicState: s?.state ?? d?.currentState ?? "INSUFFICIENT", confidence: s?.confidence ?? d?.currentConfidence ?? "insufficient", persistence: s?.persistence ?? null, stateSource: s?.stateSource ?? null,
      developmentDirection: d?.direction ?? "insufficient", trajectory: d?.trajectory ?? "INSUFFICIENT_HISTORY", independentObservations: d?.independentObservations ?? 0,
      learningRelationship: s?.learningRelationship ?? d?.currentRelationship ?? "INSUFFICIENT_EVIDENCE", independentLearningEvents: s?.independentLearningEvents ?? 0, sourceFamilies: s?.sourceFamilies ?? [],
      evidenceQuality: g.length ? g.map((x) => x.evidenceQuality).sort((a, b) => V_QUALITY.indexOf(b) - V_QUALITY.indexOf(a))[0] : "NOT_AVAILABLE",
      recentChange: d ? recentChangeOf({ changes, transitions: d.stateTransitions ?? [], asOf: context.asOf }) : "INSUFFICIENT_HISTORY",
      contradictions: contradictions.map((c) => ({ kind: c.kind, status: c.status, current: c.current })).sort((a, b) => (a.kind < b.kind ? -1 : 1)),
      activePlan: plans.some((p) => p.open), activePlanIds: plans.filter((p) => p.open).map((p) => p.planId).sort(), planStatuses: plans.map((p) => p.status).sort(),
      guidanceCategories: [...new Set(g.map((x) => x.category))].sort(), interventionTriggers: [...new Set(ivTriggers.map((x) => x.trigger))].sort(),
      activeInterventions: ivDocs.filter((x) => ["ACCEPTED", "ACTIVE", "REVIEW_DUE", "PAUSED"].includes(x.lifecycle)).length, interventionOutcomes: ivDocs.map((x) => x.outcome?.outcome).filter(Boolean).sort(),
      explorationAreas: areas, explorations: { total: explorations.length, completed: explorations.filter((x) => x.status === "COMPLETED").length },
      supportingSubjects: subjects, decliningSubjects: s?.decliningSubjects ?? [],
      quality: d?.quality ?? null, missingModalities: d?.missingModalities ?? [],
      crossDomain: cross, citations: [...new Set(citations)].sort(),
    };
  });

  const subjects = S.strengths.filter((x) => x.subjectId && x.state).map((x) => {
    const l = S.learning.find((y) => y.subjectId === x.subjectId) ?? null, a = S.academic.find((y) => y.subjectId === x.subjectId) ?? null, d = S.development.find((y) => y.subjectId === x.subjectId && y.trajectory) ?? null;
    return { subjectId: x.subjectId, subjectName: x.subjectName ?? a?.subjectName ?? null, academicState: x.state, persistence: x.persistence, consistency: x.consistency ?? a?.consistency ?? null, direction: x.direction ?? null,
      trajectory: d?.trajectory ?? null, learning: l ? { formal: l.formal, continuous: l.continuous, practical: l.practical, quiz: l.quiz, homework: l.homework?.pattern ?? null, coverage: l.coverage } : null,
      citations: [x.sourceId, a?.sourceId, l?.sourceId, d?.sourceId].filter(Boolean).sort() };
  }).sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));

  const crossDomain = dimensions.filter((d) => d.crossDomain.relationship !== "INSUFFICIENT").map((d) => ({ dimension: d.dimension, ...d.crossDomain, citations: d.citations }));
  const overall = {
    profileConfidence: context.evidenceQuality.profileConfidence, coverage: context.evidenceQuality.coverage, academicSufficient: context.evidenceQuality.academicSufficient,
    historySufficient: context.evidenceQuality.historySufficient, independentObservations: context.evidenceQuality.independentObservations, learningCoverage: context.evidenceQuality.learningCoverage,
    dimensionsRead: dimensions.length, established: dimensions.filter((d) => d.academicState === "ESTABLISHED").length, emerging: dimensions.filter((d) => d.academicState === "EMERGING").length, declining: dimensions.filter((d) => d.academicState === "DECLINING").length,
    openContradictions: context.contradictions.filter((c) => c.status === null || c.status === "CURRENT" || c.status === "NEW" || c.status === "RECURRING" || c.status === "PERSISTENT").length,
    guidanceItems: S.guidance.length, activePlans: S.plans.filter((p) => p.open).length, plans: S.plans.length, activeInterventions: dimensions.reduce((n, d) => n + d.activeInterventions, 0),
    explorations: S.exploration.length, explorationsCompleted: S.exploration.filter((x) => x.status === "COMPLETED").length, limitations: context.limitations,
  };
  return { advancedIntelligenceVersion: V.ADVANCED_INTELLIGENCE_VERSION, asOf: context.asOf, viewer: context.viewer, evidenceBoundaryHash: context.evidenceBoundaryHash, engineVersions: context.engineVersions, dimensions, subjects, crossDomain, overall, authority: V.AUTHORITY, notInferred: V.NOT_INFERRED };
};

/** The guidance engine's quality vocabulary, weakest first — used only to pick the label already assigned, never to compute one. */
const V_QUALITY = ["INSUFFICIENT", "LIMITED", "SUPPORTED", "WELL_SUPPORTED"];

module.exports = { synthesize, crossDomainOf, recentChangeOf, V_QUALITY };
