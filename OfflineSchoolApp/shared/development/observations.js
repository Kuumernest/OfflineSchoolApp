// shared/development/observations.js
"use strict";

/**
 * An observation is one reading of a pupil's strengths profile on one day: a
 * snapshot (immutable, as it was recorded, under the engine versions of its
 * day) or the current reading. This file reduces either to the same small,
 * order-free shape the rest of the engine reads, so that a 1.1.0 snapshot, a
 * 1.2.0 snapshot and today's profile are compared on what they say, never on
 * how they were serialised.
 *
 * Nothing is reinterpreted: a snapshot's states and relationships are taken
 * as recorded. A dimension absent from a reading's lists is INSUFFICIENT,
 * which is exactly what its absence meant on that day.
 */

const { DIMENSIONS } = require("../strengths/taxonomy");

const iso = (d) => { if (!d) return null; const t = new Date(d); return Number.isNaN(t.getTime()) ? null : t.toISOString(); };
const sortStrings = (xs) => [...new Set(xs.filter(Boolean).map(String))].sort();

/** The dimension readings of a profile-like object (a profile or a snapshot's `profile`). */
const readingsOf = (p) => [...(p?.strengths ?? []), ...(p?.emergingAreas ?? []), ...(p?.decliningAreas ?? [])];

/** The learning-family counts a reading carries, from its corroboration events. */
const familyCounts = (d) => {
  const out = {};
  for (const e of [...(d.corroboration?.supportingEvents ?? []), ...(d.corroboration?.contradictingEvents ?? [])]) out[e.sourceKind] = (out[e.sourceKind] ?? 0) + 1;
  return out;
};

/** One dimension of one reading, reduced. */
const dimensionOf = (d) => ({
  state: d.state,
  confidence: d.confidence ?? null,
  baseState: d.baseState ?? d.state,
  persistence: d.persistence ?? null,
  direction: d.baseDirection ?? d.academic?.direction ?? null,
  relationship: d.learningEvidence?.relationship ?? null,
  independentEventCount: d.learningEvidence?.independentEventCount ?? 0,
  staleEventCount: d.learningEvidence?.staleEventCount ?? 0,
  sourceFamilies: sortStrings(d.learningEvidence?.sourceFamilies ?? []),
  familyCounts: familyCounts(d),
  supportingEvents: d.corroboration?.supportingEvents?.length ?? 0,
  contradictingEvents: d.corroboration?.contradictingEvents?.length ?? 0,
  explorationEvents: d.fused?.events ?? 0,
  explorationSupporting: d.fused?.supportingEvents ?? 0,
  explorationContradicting: d.fused?.contradictingEvents ?? 0,
  teacherObservers: d.fused?.teacherObservers ?? 0,
  missingModalities: sortStrings(d.context?.missingModalities ?? []),
  attendanceLimited: Boolean(d.context?.attendanceLimited),
  hasContext: Boolean(d.context),
  supportingSubjects: sortStrings((d.supportingSubjects ?? []).map((s) => s.subjectId)),
  contradictions: sortStrings([...(d.fused?.conflicts ?? []).map((c) => c.kind), ...(d.interpretation?.contradictions ?? []).map((c) => c.kind)]),
  evidenceIds: sortStrings([
    ...(d.corroboration?.supportingEvents ?? []).map((e) => e.independenceKey ?? e.eventId),
    ...(d.corroboration?.contradictingEvents ?? []).map((e) => e.independenceKey ?? e.eventId),
    ...(d.fused?.evidenceIds ?? []),
  ]),
});

const INSUFFICIENT = Object.freeze(dimensionOf({ state: "INSUFFICIENT" }));

/**
 * Reduce a profile-like object plus its metadata to an observation.
 *
 * @param {object} p       a strength profile, or a snapshot's `profile`
 * @param {object} meta    { observedAt, source: "snapshot"|"current", profileVersion, periodLabel, boundaryHash, versions }
 */
const observationOf = (p, meta) => {
  const dims = {};
  for (const d of DIMENSIONS) dims[d] = INSUFFICIENT;
  for (const d of readingsOf(p)) if (d?.dimension) dims[d.dimension] = dimensionOf(d);
  const subjects = {};
  for (const s of p?.singleSubjectStrengths ?? []) subjects[String(s.subjectId)] = { state: s.state, persistence: s.persistence ?? null, direction: s.direction ?? null, subjectName: s.subjectName ?? null };
  const families = sortStrings([
    ...((p?.evidenceCoverage?.sequences ?? 0) > 0 ? ["ACADEMIC"] : []),
    ...Object.values(dims).flatMap((d) => d.sourceFamilies),
    ...(Object.values(dims).some((d) => d.explorationEvents > 0) ? ["EXPLORATION"] : []),
    ...(Object.values(dims).some((d) => d.teacherObservers > 0) ? ["TEACHER_OBSERVATION"] : []),
  ]);
  const contradictions = sortStrings([
    ...(p?.fusion?.contradictions ?? []).map((c) => `${c.dimension}|${c.kind}`),
    ...(p?.learningIntegration?.contradictions ?? []).map((c) => `${c.dimension}|${c.kind}`),
  ]).map((k) => { const [dimension, kind] = k.split("|"); return { dimension, kind }; });
  return {
    observedAt: iso(meta.observedAt),
    source: meta.source,
    profileVersion: meta.profileVersion ?? null,
    periodLabel: meta.periodLabel ?? null,
    boundaryHash: meta.boundaryHash ?? null,
    versions: {
      academic: meta.versions?.academic ?? p?.academicEngineVersion ?? null,
      strengths: meta.versions?.strengths ?? p?.strengthEngineVersion ?? null,
      exploration: meta.versions?.exploration ?? null,
      learningIntegration: meta.versions?.learningIntegration ?? p?.learningIntegrationVersion ?? null,
      learningEvidence: meta.versions?.learningEvidence ?? p?.learningEvidenceVersion ?? null,
    },
    coverage: { sequences: p?.evidenceCoverage?.sequences ?? 0, sufficient: Boolean(p?.evidenceCoverage?.sufficient), families, learningEvents: p?.evidenceCoverage?.learningEvents ?? 0 },
    dimensions: dims,
    subjects,
    contradictions,
  };
};

/** A snapshot document → observation. The reading is taken exactly as recorded, under its own versions. */
const observationOfSnapshot = (s) => observationOf(s.profile, {
  observedAt: s.asOf ?? s.generatedAt, source: "snapshot", profileVersion: s.profileVersion ?? null, periodLabel: s.periodLabel ?? null,
  boundaryHash: s.evidenceBoundary?.hash ?? null,
  versions: { academic: s.academicEngineVersion ?? null, strengths: s.strengthEngineVersion ?? null, exploration: s.explorationEngineVersion ?? null,
              learningIntegration: s.learningIntegrationVersion ?? null, learningEvidence: s.learningEvidenceVersion ?? null },
});

/**
 * The observations the engine reads on one day: every snapshot dated on or
 * before asOf (a later snapshot did not exist that day), then the current
 * reading if it was made for that day. Sorted by date, then profile version.
 */
const observationsOf = ({ snapshots = [], current = null, asOf }) => {
  const at = iso(asOf);
  const rows = (snapshots ?? [])
    .filter((s) => s && !s.deletedAt)
    .map(observationOfSnapshot)
    .filter((o) => o.observedAt && (!at || o.observedAt <= at));
  const currentAt = iso(current?.asOf ?? current?.profile?.fusion?.asOf ?? at);
  if (current?.profile && (!at || !currentAt || currentAt <= at)) {
    rows.push(observationOf(current.profile, {
      observedAt: current.asOf ?? current.profile.fusion?.asOf ?? at, source: "current", profileVersion: null, periodLabel: null,
      boundaryHash: current.boundaryHash ?? null, versions: { exploration: current.explorationEngineVersion ?? null },
    }));
  }
  return rows.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : (a.profileVersion ?? 1e9) - (b.profileVersion ?? 1e9)));
};

module.exports = { iso, sortStrings, readingsOf, dimensionOf, observationOf, observationOfSnapshot, observationsOf, INSUFFICIENT };
