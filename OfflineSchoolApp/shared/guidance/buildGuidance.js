// shared/guidance/buildGuidance.js
"use strict";

/**
 * From a development history to guidance items: one per (dimension,
 * category), each carrying what was observed, what changed, what supports
 * it, what the pupil could try, why, and what evidence to watch. Pure and
 * deterministic; asOf is echoed, never read from the clock.
 */

const { GUIDANCE_ENGINE_VERSION, NOT_INFERRED } = require("./version");
const { ACTIONS, EVIDENCE_TO_WATCH, DEFINITIONS } = require("./taxonomy");
const { facetsOf, evidenceQualityOf, categoriesFor } = require("./rules");

const lastOf = (xs) => (xs && xs.length ? xs[xs.length - 1] : null);

/** The guidance for one trajectory. */
const itemsFor = (t, { asOf, developmentEngineVersion }) => {
  const f = facetsOf(t);
  const quality = evidenceQualityOf(f);
  const last = lastOf(t.observations);
  const lastChange = lastOf(t.changes ?? []);
  const key = t.dimensionId ?? `subject:${t.subjectId}`;
  return categoriesFor(f).map(({ category, reasons }) => ({
    id: `${key}:${category}`,
    category,
    definition: DEFINITIONS[category],
    dimension: t.dimensionId ?? null,
    subjectId: t.subjectId ?? null,
    title: { code: `GUIDANCE_${category}`, dimension: t.dimensionId ?? null, subjectId: t.subjectId ?? null },
    explanation: {
      observed: { code: "OBSERVED_STATE", state: t.currentState, trajectory: t.trajectory, observations: t.persistence?.independentObservationCount ?? 0 },
      changed: lastChange ? { code: "LAST_CHANGE", changeTypes: lastChange.changeTypes, reasonCodes: lastChange.reasonCodes, at: lastChange.observedAt } : { code: "NO_CHANGE_ON_RECORD" },
      relationship: t.currentRelationship ? { code: "LEARNING_RELATIONSHIP", relationship: t.currentRelationship, families: last?.sourceFamilies ?? [] } : { code: "NO_LEARNING_RELATIONSHIP" },
      why: { code: `WHY_${category}`, reasons },
      uncertain: { code: "UNCERTAIN", missingModalities: f.missing, conflicts: f.conflicts, historySufficient: f.historySufficient, recency: f.recency, attendanceLimited: f.attendanceLimited },
    },
    evidence: {
      state: t.currentState, relationship: t.currentRelationship, trajectory: t.trajectory, direction: t.direction,
      coverage: t.evidenceCoverage?.current ?? null, quality: t.quality, contradictions: (t.contradictions ?? []).map((c) => ({ kind: c.kind, status: c.status, occurrences: c.occurrences })),
      stateTransitions: t.stateTransitions ?? [], relationshipTransitions: t.relationshipTransitions ?? [],
    },
    reasons,
    suggestedActions: ACTIONS[category],
    evidenceToWatch: EVIDENCE_TO_WATCH[category],
    evidenceQuality: quality,
    developmentContext: { trajectory: t.trajectory, direction: t.direction, currentState: t.currentState, previousState: t.observations.length > 1 ? t.observations[t.observations.length - 2].state : null, independentObservations: t.persistence?.independentObservationCount ?? 0, lastObservedAt: t.lastObservedAt ?? null },
    asOf,
    engineVersion: GUIDANCE_ENGINE_VERSION,
    developmentEngineVersion,
  }));
};

/**
 * @param {object} input
 * @param {object} input.development   the Stage 14 history (buildDevelopmentHistory output)
 * @param {string|Date} input.asOf     required; echoed on every item
 */
const buildGuidance = ({ development, asOf }) => {
  if (!asOf) throw new Error("buildGuidance: asOf is required");
  const at = new Date(asOf).toISOString();
  const trajectories = (development?.trajectories ?? []).filter((t) => t.currentState !== "INSUFFICIENT" || (t.stateTransitions ?? []).length > 0 || (t.observations ?? []).some((o) => o.independentEventCount > 0));
  const items = trajectories.flatMap((t) => itemsFor(t, { asOf: at, developmentEngineVersion: development?.developmentEngineVersion ?? null }));
  // Nothing observed in any dimension: one profile-level item, BUILD_EVIDENCE, and nothing stronger.
  if (!items.length) {
    items.push({
      id: "profile:BUILD_EVIDENCE", category: "BUILD_EVIDENCE", definition: DEFINITIONS.BUILD_EVIDENCE, dimension: null, subjectId: null, title: { code: "GUIDANCE_BUILD_EVIDENCE", dimension: null, subjectId: null },
      explanation: { observed: { code: "NOTHING_OBSERVED", state: "INSUFFICIENT", trajectory: "INSUFFICIENT_HISTORY", observations: development?.history?.independentObservationCount ?? 0 }, changed: { code: "NO_CHANGE_ON_RECORD" }, relationship: { code: "NO_LEARNING_RELATIONSHIP" },
                     why: { code: "WHY_BUILD_EVIDENCE", reasons: ["NO_OBSERVED_DIMENSIONS"] }, uncertain: { code: "UNCERTAIN", missingModalities: [], conflicts: "NONE", historySufficient: Boolean(development?.history?.sufficient), recency: null, attendanceLimited: false } },
      evidence: { state: "INSUFFICIENT", relationship: null, trajectory: "INSUFFICIENT_HISTORY", direction: "insufficient", coverage: null, quality: null, contradictions: [], stateTransitions: [], relationshipTransitions: [] },
      reasons: ["NO_OBSERVED_DIMENSIONS"], suggestedActions: ACTIONS.BUILD_EVIDENCE, evidenceToWatch: EVIDENCE_TO_WATCH.BUILD_EVIDENCE, evidenceQuality: "INSUFFICIENT",
      developmentContext: { trajectory: "INSUFFICIENT_HISTORY", direction: "insufficient", currentState: "INSUFFICIENT", previousState: null, independentObservations: development?.history?.independentObservationCount ?? 0, lastObservedAt: development?.history?.lastObservedAt ?? null },
      asOf: at, engineVersion: GUIDANCE_ENGINE_VERSION, developmentEngineVersion: development?.developmentEngineVersion ?? null,
    });
  }
  const byCategory = {};
  for (const i of items) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  return {
    guidanceEngineVersion: GUIDANCE_ENGINE_VERSION,
    developmentEngineVersion: development?.developmentEngineVersion ?? null,
    asOf: at,
    historySufficient: Boolean(development?.history?.sufficient),
    items,
    byCategory,
    byDimension: Object.fromEntries(trajectories.map((t) => [t.dimensionId ?? `subject:${t.subjectId}`, items.filter((i) => (i.dimension ?? `subject:${i.subjectId}`) === (t.dimensionId ?? `subject:${t.subjectId}`)).map((i) => i.category)])),
    agency: "INFORMS_ONLY",
    notInferred: NOT_INFERRED,
  };
};

module.exports = { buildGuidance, itemsFor };
