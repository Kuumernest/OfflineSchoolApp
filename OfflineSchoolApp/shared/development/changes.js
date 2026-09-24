// shared/development/changes.js
"use strict";

/**
 * What changed between two observations of one pupil, dimension by
 * dimension, as change types and reason codes about EVIDENCE.
 *
 * Two observations are compared on their reduced shape (observations.js), so
 * object order, timestamps of serialisation, ids and database metadata cannot
 * produce a difference. A real difference in state, relationship, direction,
 * persistence, counts, families or standing conflicts always does.
 *
 * A single new event never becomes a trend here: a new assignment beside an
 * unchanged state is EVIDENCE_ADDED with NEW_EVIDENCE_WITHOUT_STATE_CHANGE,
 * and the relationship may have changed. Nothing here says why.
 */

const { DIMENSIONS } = require("../strengths/taxonomy");

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Change of one dimension between two observations. `history` (optional) is
 * the contradiction history, consulted so that CONTRADICTION_RESOLVED is
 * emitted only when the documented resolution rule holds.
 */
const dimensionChange = (dimension, prev, cur, { history = [], prevObs, curObs } = {}) => {
  const a = prev.dimensions[dimension], b = cur.dimensions[dimension];
  const types = [], reasons = [];

  if (a.state !== b.state) { types.push("STATE_CHANGED"); reasons.push("ACADEMIC_STATE_CHANGED"); }
  else if (b.state !== "INSUFFICIENT" || a.state !== "INSUFFICIENT") types.push("STATE_STABLE");

  if ((a.relationship ?? null) !== (b.relationship ?? null)) {
    types.push("RELATIONSHIP_CHANGED");
    if (b.relationship === "CORROBORATED" || (b.relationship === "PARTIALLY_CORROBORATED" && b.supportingEvents > a.supportingEvents)) reasons.push("LEARNING_CORROBORATION_ADDED");
    if (["CORROBORATED", "PARTIALLY_CORROBORATED"].includes(a.relationship) && ["UNSUPPORTED", "INSUFFICIENT_EVIDENCE", "CONTEXT_LIMITED"].includes(b.relationship)) reasons.push("LEARNING_CORROBORATION_LOST");
    if (b.relationship === "CONTRADICTED") reasons.push("LEARNING_CONTRADICTION_ADDED");
  } else if (b.relationship) types.push("RELATIONSHIP_STABLE");

  if (a.direction && b.direction && a.direction !== b.direction) { types.push("DIRECTION_CHANGED"); reasons.push("ACADEMIC_DIRECTION_CHANGED"); }
  if (a.persistence && b.persistence && a.persistence !== b.persistence) { types.push("PERSISTENCE_CHANGED"); reasons.push("ACADEMIC_PERSISTENCE_CHANGED"); }

  const totalA = a.independentEventCount + a.staleEventCount, totalB = b.independentEventCount + b.staleEventCount;
  if (b.independentEventCount > a.independentEventCount || b.explorationEvents > a.explorationEvents || b.teacherObservers > a.teacherObservers) {
    types.push("EVIDENCE_ADDED");
    if (b.explorationEvents > a.explorationEvents) reasons.push("EXPLORATION_EVIDENCE_ADDED");
    if (b.teacherObservers > a.teacherObservers) reasons.push("TEACHER_OBSERVATION_ADDED");
    if (a.state === b.state) reasons.push("NEW_EVIDENCE_WITHOUT_STATE_CHANGE");
  }
  if (totalB < totalA) { types.push("EVIDENCE_RETRACTED"); reasons.push("EVIDENCE_RETRACTED"); }
  if (b.staleEventCount > a.staleEventCount) { types.push("EVIDENCE_BECAME_STALE"); reasons.push("EVIDENCE_BECAME_STALE"); }
  // Modalities are compared only when both readings carried a context block; a dimension that was
  // INSUFFICIENT had no context to compare, and its first context is not a reduction.
  const bothContext = a.hasContext && b.hasContext;
  const famA = [...a.sourceFamilies, ...(a.explorationEvents ? ["EXPLORATION"] : []), ...(a.teacherObservers ? ["TEACHER_OBSERVATION"] : [])];
  const famB = [...b.sourceFamilies, ...(b.explorationEvents ? ["EXPLORATION"] : []), ...(b.teacherObservers ? ["TEACHER_OBSERVATION"] : [])];
  if (!sameList(famA, famB) || (bothContext && !sameList(a.missingModalities, b.missingModalities))) {
    types.push("EVIDENCE_COVERAGE_CHANGED");
    if (famB.some((f) => !famA.includes(f)) || (bothContext && a.missingModalities.some((m) => !b.missingModalities.includes(m)))) reasons.push("EVIDENCE_COVERAGE_EXPANDED");
    if (famA.some((f) => !famB.includes(f)) || (bothContext && b.missingModalities.some((m) => !a.missingModalities.includes(m)))) reasons.push("EVIDENCE_COVERAGE_REDUCED");
  }

  for (const kind of b.contradictions) {
    if (a.contradictions.includes(kind)) { types.push("CONTRADICTION_PERSISTED"); reasons.push("LEARNING_CONTRADICTION_PERSISTED"); }
    else { types.push("CONTRADICTION_STARTED"); if (!reasons.includes("LEARNING_CONTRADICTION_ADDED")) reasons.push("LEARNING_CONTRADICTION_ADDED"); }
  }
  for (const kind of a.contradictions) {
    if (b.contradictions.includes(kind)) continue;
    const h = history.find((x) => x.dimension === dimension && x.kind === kind);
    if (h?.status === "RESOLVED" && curObs && h.resolutionDate && h.resolutionDate <= curObs.observedAt && curObs.observedAt >= h.resolutionDate) { types.push("CONTRADICTION_RESOLVED"); reasons.push("LEARNING_CONTRADICTION_RESOLVED"); }
    else reasons.push("CONTRADICTION_NOT_CURRENTLY_OBSERVED");
  }

  // Versions compared where both sides recorded one; a snapshot from before a version existed is not a change.
  const versionChanged = Object.keys(cur.versions).some((k) => prev.versions[k] && cur.versions[k] && prev.versions[k] !== cur.versions[k]);
  if (prevObs && curObs && versionChanged) reasons.push("PROFILE_VERSION_CHANGED");

  if (types.length === 0 || (types.length === 1 && (types[0] === "STATE_STABLE" || types[0] === "RELATIONSHIP_STABLE")) || (types.length === 2 && types.includes("STATE_STABLE") && types.includes("RELATIONSHIP_STABLE"))) {
    if (!types.length && a.state === "INSUFFICIENT" && b.state === "INSUFFICIENT" && !totalA && !totalB) return null; // nothing was ever observed here
    types.push("NO_MEANINGFUL_CHANGE");
  }
  return {
    changeId: `${dimension}:${prev.observedAt ?? "none"}>${cur.observedAt ?? "now"}`,
    dimensionId: dimension, subjectId: null,
    observedAt: cur.observedAt, previousObservedAt: prev.observedAt,
    previousState: a.state, currentState: b.state,
    previousRelationship: a.relationship, currentRelationship: b.relationship,
    previousDirection: a.direction, currentDirection: b.direction,
    previousPersistence: a.persistence, currentPersistence: b.persistence,
    changeTypes: [...new Set(types)], reasonCodes: [...new Set(reasons)],
    supportingEvidence: { learningEvents: b.supportingEvents, families: b.sourceFamilies, familyCounts: b.familyCounts, explorationEvents: b.explorationSupporting, teacherObservers: b.teacherObservers },
    contradictingEvidence: { learningEvents: b.contradictingEvents, explorationEvents: b.explorationContradicting, kinds: b.contradictions },
    evidenceBoundaryHash: cur.boundaryHash ?? null,
    previousEvidenceBoundaryHash: prev.boundaryHash ?? null,
    engineVersions: cur.versions,
  };
};

/** Single-subject strengths (outside the taxonomy) change too: state only. */
const subjectChange = (subjectId, prev, cur) => {
  const a = prev.subjects[subjectId] ?? { state: "INSUFFICIENT" }, b = cur.subjects[subjectId] ?? { state: "INSUFFICIENT" };
  if (a.state === b.state) return null;
  return {
    changeId: `subject:${subjectId}:${prev.observedAt ?? "none"}>${cur.observedAt ?? "now"}`, dimensionId: null, subjectId,
    observedAt: cur.observedAt, previousObservedAt: prev.observedAt, previousState: a.state, currentState: b.state, previousRelationship: null, currentRelationship: null,
    changeTypes: ["STATE_CHANGED"], reasonCodes: ["ACADEMIC_STATE_CHANGED"], supportingEvidence: null, contradictingEvidence: null,
    evidenceBoundaryHash: cur.boundaryHash ?? null, previousEvidenceBoundaryHash: prev.boundaryHash ?? null, engineVersions: cur.versions,
  };
};

/** Every change between two consecutive observations. */
const changesBetween = (prev, cur, { history = [] } = {}) => {
  const out = [];
  for (const d of DIMENSIONS) { const c = dimensionChange(d, prev, cur, { history, prevObs: prev, curObs: cur }); if (c) out.push(c); }
  for (const s of [...new Set([...Object.keys(prev.subjects), ...Object.keys(cur.subjects)])].sort()) { const c = subjectChange(s, prev, cur); if (c) out.push(c); }
  return out;
};

/**
 * Deterministic comparison of two readings (profiles or snapshot readings).
 * Structured lists a reader can scan; every entry is one of the change
 * events above. Nothing here is a measure of the pupil.
 */
const compareDevelopmentSnapshots = ({ previous, current, history = [] }) => {
  const { observationOf, observationOfSnapshot } = require("./observations");
  const toObs = (x) => (x?.profile && (x.profileVersion !== undefined || x.evidenceBoundary) ? observationOfSnapshot(x) : observationOf(x, { observedAt: x?.fusion?.asOf ?? null, source: "current" }));
  const a = toObs(previous), b = toObs(current);
  const changes = changesBetween(a, b, { history });
  const has = (t) => changes.filter((c) => c.changeTypes.includes(t));
  return {
    previous: { observedAt: a.observedAt, profileVersion: a.profileVersion, versions: a.versions, boundaryHash: a.boundaryHash },
    current: { observedAt: b.observedAt, profileVersion: b.profileVersion, versions: b.versions, boundaryHash: b.boundaryHash },
    identicalBoundary: Boolean(a.boundaryHash && a.boundaryHash === b.boundaryHash),
    stateChanges: has("STATE_CHANGED"), relationshipChanges: has("RELATIONSHIP_CHANGED"), directionChanges: has("DIRECTION_CHANGED"), persistenceChanges: has("PERSISTENCE_CHANGED"),
    newEvidence: has("EVIDENCE_ADDED"), retractedEvidence: has("EVIDENCE_RETRACTED"), staleEvidence: has("EVIDENCE_BECAME_STALE"),
    newContradictions: has("CONTRADICTION_STARTED"), persistedContradictions: has("CONTRADICTION_PERSISTED"), resolvedContradictions: has("CONTRADICTION_RESOLVED"),
    coverageChanges: has("EVIDENCE_COVERAGE_CHANGED"),
    coverage: { previous: a.coverage.families, current: b.coverage.families },
    versionsChanged: Object.keys(b.versions).some((k) => a.versions[k] && b.versions[k] && a.versions[k] !== b.versions[k]),
    changes,
  };
};

module.exports = { dimensionChange, subjectChange, changesBetween, compareDevelopmentSnapshots };
