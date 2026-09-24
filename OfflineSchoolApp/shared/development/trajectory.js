// shared/development/trajectory.js
"use strict";

/**
 * A trajectory: the observations of one dimension in order, and what the
 * sequence amounts to — categorically. Nothing is fitted, nothing is a rate.
 *
 * Two independent observations are the least that can be called a history.
 * With one, the current state stands (it is still ESTABLISHED, or whatever
 * the strengths engine read) and the trajectory is INSUFFICIENT_HISTORY.
 * Observations made from the same evidence boundary are one observation for
 * this purpose: recording the same day twice is not persistence.
 */

const { STATE_RANK, WINDOWS, RULES } = require("./version");
const { periodsOf } = require("./contradictions");

const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

/** Independent observations: consecutive observations on the same evidence boundary collapse to the latest. */
const independentOf = (obs) => {
  const out = [];
  for (const o of obs) {
    const prev = out[out.length - 1];
    if (prev && prev.boundaryHash && prev.boundaryHash === o.boundaryHash) out[out.length - 1] = o; else out.push(o);
  }
  return out;
};

const directionOf = (states) => {
  if (states.length < RULES.independentObservationsForHistory) return "insufficient";
  let up = 0, down = 0;
  for (let i = 1; i < states.length; i++) {
    const d = STATE_RANK[states[i]] - STATE_RANK[states[i - 1]];
    if (d > 0) up += 1; else if (d < 0) down += 1;
    // ESTABLISHED/EMERGING → DECLINING shares rank 0 with INSUFFICIENT; it is a fall.
    if (states[i] === "DECLINING" && states[i - 1] !== "DECLINING" && states[i - 1] !== "INSUFFICIENT") down += 1;
    if (states[i - 1] === "DECLINING" && (states[i] === "EMERGING" || states[i] === "ESTABLISHED")) up += 1;
  }
  if (!up && !down) return "sustaining";
  if (up && !down) return "rising";
  if (down && !up) return "declining";
  return "variable";
};

const trajectoryLabel = ({ states, direction, independentCount }) => {
  if (independentCount < RULES.independentObservationsForHistory) return "INSUFFICIENT_HISTORY";
  const current = states[states.length - 1];
  if (direction === "sustaining") return `STABLE_${current}`;
  if (direction === "rising") return states.includes("DECLINING") && current !== "DECLINING" ? "RECOVERING" : current === "ESTABLISHED" ? "STRENGTHENING" : "EMERGING";
  if (direction === "declining") return current === "EMERGING" ? "WEAKENING" : "DECLINING";
  return "VARIABLE";
};

const recencyOf = (date, asOf) => {
  if (!date || !asOf) return null;
  const age = daysBetween(date, asOf);
  return age <= WINDOWS.recentDays ? "RECENT" : age <= WINDOWS.historicalDays ? "HISTORICAL" : "STALE";
};

/**
 * The trajectory of one dimension.
 *
 * @param {string}   dimension
 * @param {object[]} observations   chronological, from observations.js
 * @param {object}   ctx            { asOf, contradictions: history rows, changes: change events for this dimension }
 */
const trajectoryFor = (dimension, observations, { asOf, contradictions = [], changes = [] }) => {
  const rows = observations.map((o) => ({
    observedAt: o.observedAt, source: o.source, profileVersion: o.profileVersion, periodLabel: o.periodLabel, boundaryHash: o.boundaryHash,
    state: o.dimensions[dimension].state, confidence: o.dimensions[dimension].confidence, persistence: o.dimensions[dimension].persistence,
    relationship: o.dimensions[dimension].relationship, sourceFamilies: o.dimensions[dimension].sourceFamilies,
    independentEventCount: o.dimensions[dimension].independentEventCount, explorationEvents: o.dimensions[dimension].explorationEvents,
    teacherObservers: o.dimensions[dimension].teacherObservers, missingModalities: o.dimensions[dimension].missingModalities,
    contradictions: o.dimensions[dimension].contradictions, versions: o.versions,
  }));
  const seen = rows.some((r) => r.state !== "INSUFFICIENT" || r.independentEventCount > 0 || r.explorationEvents > 0);
  const independent = independentOf(rows);
  const states = independent.map((r) => r.state);
  const direction = directionOf(states);
  const current = rows[rows.length - 1] ?? null;
  const cur = observations[observations.length - 1]?.dimensions[dimension] ?? null;

  const stateTransitions = [], relationshipTransitions = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].state !== rows[i - 1].state) stateTransitions.push({ from: rows[i - 1].state, to: rows[i].state, fromAt: rows[i - 1].observedAt, at: rows[i].observedAt });
    if ((rows[i].relationship ?? null) !== (rows[i - 1].relationship ?? null)) relationshipTransitions.push({ from: rows[i - 1].relationship, to: rows[i].relationship, fromAt: rows[i - 1].observedAt, at: rows[i].observedAt });
  }
  let consecutive = 0;
  for (let i = independent.length - 1; i >= 0 && independent[i].state === current?.state; i--) consecutive += 1;
  let k = independent.length - 1;
  while (k > 0 && independent[k - 1].state === current?.state) k -= 1;
  const firstAtCurrent = current ? independent[k] : null;

  // Coverage over time: which families each observation carried, and where a family first appeared.
  const familyHistory = rows.map((r) => ({ observedAt: r.observedAt, families: [...(r.independentEventCount || r.sourceFamilies.length ? r.sourceFamilies : []), ...(r.explorationEvents ? ["EXPLORATION"] : []), ...(r.teacherObservers ? ["TEACHER_OBSERVATION"] : [])].sort() }));
  const firstSeenFamily = {};
  for (const h of familyHistory) for (const f of h.families) if (!firstSeenFamily[f]) firstSeenFamily[f] = h.observedAt;
  const corroborationBegan = rows.find((r) => r.relationship === "CORROBORATED")?.observedAt ?? null;

  const mine = contradictions.filter((c) => c.dimension === dimension);
  const conflicts = mine.some((c) => c.current) ? "CURRENT" : mine.length ? "HISTORICAL" : "NONE";
  const families = current ? familyHistory[familyHistory.length - 1].families : [];
  const academicFamilies = current && current.state !== "INSUFFICIENT" ? 1 : 0;
  const familyCount = families.length + academicFamilies;

  const reasons = [];
  const label = trajectoryLabel({ states, direction, independentCount: independent.length });
  if (label === "INSUFFICIENT_HISTORY") reasons.push(`INSUFFICIENT_HISTORY:${independent.length}`);
  if (label.startsWith("STABLE_")) reasons.push(`STABLE_ACROSS_OBSERVATIONS:${independent.length}`);
  for (const t of stateTransitions) reasons.push(`STATE_CHANGED:${t.from}>${t.to}`);
  if (corroborationBegan) reasons.push(`LEARNING_CORROBORATION_BEGAN:${corroborationBegan}`);
  for (const [f, at] of Object.entries(firstSeenFamily)) if (at !== rows[0]?.observedAt) reasons.push(`EVIDENCE_COVERAGE_EXPANDED:${f}@${at}`);
  for (const c of mine) reasons.push(`CONTRADICTION_${c.status}:${c.kind}`);
  for (const m of cur?.missingModalities ?? []) reasons.push(`MODALITY_UNAVAILABLE:${m}`);

  return {
    dimensionId: dimension, subjectId: null,
    observed: seen,
    observations: rows,
    currentState: current?.state ?? "INSUFFICIENT", currentConfidence: current?.confidence ?? null, currentRelationship: current?.relationship ?? null,
    firstObservedAt: rows[0]?.observedAt ?? null, lastObservedAt: current?.observedAt ?? null,
    direction, trajectory: label,
    persistence: {
      observationCount: rows.length, independentObservationCount: independent.length, consecutiveObservations: consecutive,
      independentPeriods: periodsOf(independent), firstObservedAtCurrentState: firstAtCurrent?.observedAt ?? null, academic: current?.persistence ?? null,
    },
    stateTransitions, relationshipTransitions,
    evidenceCoverage: {
      current: cur ? { academicSequences: observations[observations.length - 1].coverage.sequences, learning: cur.familyCounts, learningIndependentEvents: cur.independentEventCount, learningStale: cur.staleEventCount,
                       exploration: cur.explorationEvents, teacherObservers: cur.teacherObservers, unavailable: cur.missingModalities } : null,
      familyHistory, firstSeenFamily, corroborationBegan,
    },
    contradictions: mine,
    changes: changes.filter((c) => c.dimensionId === dimension),
    quality: {
      coverage: familyCount >= RULES.familiesForBroadCoverage ? "BROAD" : familyCount >= 2 ? "MODERATE" : "LIMITED",
      recency: recencyOf(current?.observedAt, asOf),
      independence: independent.length >= RULES.independentObservationsForHistory ? "SUFFICIENT" : "INSUFFICIENT",
      conflicts,
      missingModalities: cur?.missingModalities ?? [],
      attendanceLimited: Boolean(cur?.attendanceLimited),
    },
    reasons,
  };
};

/** Single-subject strengths outside the taxonomy: a state history under the subject's own name. */
const subjectTrajectoryFor = (subjectId, observations, { asOf }) => {
  const rows = observations.map((o) => ({ observedAt: o.observedAt, source: o.source, profileVersion: o.profileVersion, boundaryHash: o.boundaryHash,
    state: o.subjects[subjectId]?.state ?? "INSUFFICIENT", persistence: o.subjects[subjectId]?.persistence ?? null, subjectName: o.subjects[subjectId]?.subjectName ?? null }));
  const independent = independentOf(rows);
  const states = independent.map((r) => r.state);
  const direction = directionOf(states);
  const current = rows[rows.length - 1] ?? null;
  const stateTransitions = [];
  for (let i = 1; i < rows.length; i++) if (rows[i].state !== rows[i - 1].state) stateTransitions.push({ from: rows[i - 1].state, to: rows[i].state, fromAt: rows[i - 1].observedAt, at: rows[i].observedAt });
  return {
    dimensionId: null, subjectId, subjectName: rows.map((r) => r.subjectName).filter(Boolean).pop() ?? null, observed: true,
    observations: rows, currentState: current?.state ?? "INSUFFICIENT", currentRelationship: null,
    firstObservedAt: rows[0]?.observedAt ?? null, lastObservedAt: current?.observedAt ?? null,
    direction, trajectory: trajectoryLabel({ states, direction, independentCount: independent.length }),
    persistence: { observationCount: rows.length, independentObservationCount: independent.length, academic: current?.persistence ?? null },
    stateTransitions, relationshipTransitions: [], evidenceCoverage: null, contradictions: [], changes: [],
    quality: { coverage: "LIMITED", recency: recencyOf(current?.observedAt, asOf), independence: independent.length >= RULES.independentObservationsForHistory ? "SUFFICIENT" : "INSUFFICIENT", conflicts: "NONE", missingModalities: [] },
    reasons: [],
  };
};

module.exports = { independentOf, directionOf, trajectoryLabel, recencyOf, trajectoryFor, subjectTrajectoryFor };
