// backend/src/services/intelligence/development.service.js
"use strict";

/**
 * The development layer, loaded and served.
 *
 * ── What this file does ───────────────────────────────────────────────────
 *
 * Fetches the two things the pure Development Engine reads — the pupil's
 * immutable strength snapshots and the current strength profile built for
 * the same asOf — and hands them to shared/development. Nothing is stored:
 * the history is derived on every read from records that already exist, so
 * there is no second source of truth and nothing to drift. Identity is
 * joined by the router after authorisation, as for every intelligence
 * surface.
 *
 * ── Live and offline ──────────────────────────────────────────────────────
 *
 * offlineHistoryFor takes the same snapshots as a mirror would hold them
 * (JSON round-tripped) and the strengths layer's offline road to the current
 * profile, on the same asOf, so the consistency checker can diff the two.
 */

const StrengthProfileSnapshot = require("../../db/models/StrengthProfileSnapshot");
const strengthsSvc = require("./strengths.service");
const dev = require("../../../../shared/development");
const { EXPLORATION_ENGINE_VERSION } = require("../../../../shared/exploration");

const snapshotsOf = ({ schoolId, studentId }) =>
  StrengthProfileSnapshot.find({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ profileVersion: 1 }).lean();

const currentOf = (profile, asOf) => (profile ? { profile, asOf: asOf.toISOString(), boundaryHash: strengthsSvc.boundaryOf(profile).hash, explorationEngineVersion: EXPLORATION_ENGINE_VERSION } : null);

/** The live history for one pupil on one day. Null when the pupil has no academic profile and no snapshot. */
const historyFor = async ({ schoolId, studentId, asOf = null }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const [snapshots, profile] = await Promise.all([snapshotsOf({ schoolId, studentId }), strengthsSvc.profileFor({ schoolId, studentId, asOf: at })]);
  if (!profile && !snapshots.length) return null;
  return dev.buildDevelopmentHistory({ snapshots, current: currentOf(profile, at), asOf: at });
};

/** The same history through the offline road. */
const offlineHistoryFor = async ({ schoolId, studentId, asOf = null }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const [snapshots, profile] = await Promise.all([snapshotsOf({ schoolId, studentId }), strengthsSvc.offlineProfileFor({ schoolId, studentId, asOf: at })]);
  if (!profile && !snapshots.length) return null;
  return dev.buildDevelopmentHistory({ snapshots: JSON.parse(JSON.stringify(snapshots)), current: currentOf(profile, at), asOf: at });
};

/** Changes, filtered the way the route allows: a date window and a dimension or subject. Deterministic: the same filter on the same history gives the same list. */
const changesOf = (h, { from = null, to = null, dimensionId = null, subjectId = null } = {}) =>
  (h?.changes ?? []).filter((c) =>
    (!from || c.observedAt >= new Date(from).toISOString()) && (!to || c.observedAt <= new Date(to).toISOString()) &&
    (!dimensionId || c.dimensionId === dimensionId) && (!subjectId || c.subjectId === subjectId));

/**
 * The evidence behind the history: per trajectory, the current reading's
 * supporting and contradicting event references (id, family, subject, date,
 * recency — never a note), the exploration evidence ids, and per change the
 * boundary hashes. Reflection text never enters the development engine and
 * is not here.
 */
const evidenceOf = (h, profile) => {
  const readings = new Map([...(profile?.strengths ?? []), ...(profile?.emergingAreas ?? []), ...(profile?.decliningAreas ?? [])].map((d) => [d.dimension, d]));
  return (h?.trajectories ?? []).filter((t) => t.dimensionId).map((t) => {
    const d = readings.get(t.dimensionId);
    return {
      dimensionId: t.dimensionId, trajectory: t.trajectory, currentState: t.currentState, currentRelationship: t.currentRelationship,
      supportingEvents: d?.corroboration?.supportingEvents ?? [], contradictingEvents: d?.corroboration?.contradictingEvents ?? [], neutralEvents: d?.corroboration?.neutralEvents ?? 0,
      explorationEvidenceIds: d?.fused?.evidenceIds ?? [], teacherObservers: d?.fused?.teacherObservers ?? 0,
      academicSubjects: (d?.supportingSubjects ?? []).map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName ?? null })),
      coverage: t.evidenceCoverage, contradictions: t.contradictions,
      changes: t.changes.map((c) => ({ changeId: c.changeId, observedAt: c.observedAt, changeTypes: c.changeTypes, reasonCodes: c.reasonCodes, evidenceBoundaryHash: c.evidenceBoundaryHash, previousEvidenceBoundaryHash: c.previousEvidenceBoundaryHash })),
    };
  });
};

/**
 * The parent's view: what is developing, what has stayed consistent, what
 * supports the reading, what is still unclear. No codes a parent was not
 * already shown, no reviewer, no note.
 */
const forGuardian = (h) => {
  if (!h) return null;
  const dims = h.trajectories.filter((t) => t.dimensionId && (t.currentState !== "INSUFFICIENT" || t.stateTransitions.length));
  const item = (t) => ({
    dimension: t.dimensionId, currentState: t.currentState, trajectory: t.trajectory, observations: t.persistence.independentObservationCount,
    history: t.observations.map((o) => ({ when: o.observedAt, state: o.state })),
    supportedBy: { academic: t.currentState !== "INSUFFICIENT", learningFamilies: t.observations[t.observations.length - 1]?.sourceFamilies ?? [], exploration: (t.observations[t.observations.length - 1]?.explorationEvents ?? 0) > 0 },
    unclear: { missing: t.quality.missingModalities, historyInsufficient: t.trajectory === "INSUFFICIENT_HISTORY", conflict: t.quality.conflicts !== "NONE" },
  });
  return {
    asOf: h.asOf,
    developing: dims.filter((t) => ["EMERGING", "STRENGTHENING", "RECOVERING"].includes(t.trajectory)).map(item),
    consistent: dims.filter((t) => t.trajectory.startsWith("STABLE_") && t.currentState !== "INSUFFICIENT").map(item),
    changing: dims.filter((t) => ["WEAKENING", "DECLINING", "VARIABLE"].includes(t.trajectory)).map(item),
    tooEarly: dims.filter((t) => t.trajectory === "INSUFFICIENT_HISTORY").map(item),
    observations: h.history,
    notInferred: h.notInferred,
    versions: { development: h.developmentEngineVersion, ...(h.versions.current ?? {}) },
  };
};

module.exports = { snapshotsOf, historyFor, offlineHistoryFor, changesOf, evidenceOf, forGuardian };
