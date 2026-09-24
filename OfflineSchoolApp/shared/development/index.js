// shared/development/index.js
"use strict";

/**
 * The Development Engine — DEVELOPMENT_ENGINE_VERSION 1.0.0.
 *
 * ── What it answers ───────────────────────────────────────────────────────
 *
 * Stage 13 answers "what evidence supports, contradicts or limits this
 * strength today?". This layer answers "how has that changed over time,
 * when, and what evidence explains the change?" — from the immutable
 * strength snapshots and the current reading, without recomputing a mark,
 * reinterpreting an old snapshot with today's engine, or measuring anything
 * about the child.
 *
 * ── What it never does ────────────────────────────────────────────────────
 *
 * No score, rate, percentage or rank of development. No prediction. No
 * cause. One new event is never a trend. A missing source is never a
 * decline. A snapshot is never rewritten. Nothing here calls the clock:
 * asOf is an input, and evidence dated after it does not exist for it.
 *
 * Pure: no I/O, no identity, no randomness.
 */

const V = require("./version");
const { observationOf, observationOfSnapshot, observationsOf, dimensionOf } = require("./observations");
const { analyseContradictionHistory } = require("./contradictions");
const { changesBetween, compareDevelopmentSnapshots, dimensionChange } = require("./changes");
const { trajectoryFor, subjectTrajectoryFor, independentOf, directionOf, trajectoryLabel } = require("./trajectory");
const { DIMENSIONS } = require("../strengths/taxonomy");

/**
 * Plain, categorical explanation lines for one trajectory — codes with
 * parameters, translated by the interface. Each line states an observed
 * fact about evidence; none states a cause or a measure.
 */
const explain = (t) => {
  const lines = [{ code: "CURRENT_STATE", state: t.currentState, relationship: t.currentRelationship }];
  const n = t.persistence.independentObservationCount;
  if (t.trajectory === "INSUFFICIENT_HISTORY") lines.push({ code: "INSUFFICIENT_HISTORY", n });
  else if (t.trajectory.startsWith("STABLE_")) lines.push({ code: "STABLE_ACROSS", state: t.currentState, n });
  else for (const s of t.stateTransitions) lines.push({ code: "MOVED", from: s.from, to: s.to, at: s.at });
  if (t.evidenceCoverage?.corroborationBegan) lines.push({ code: "CORROBORATION_BEGAN", at: t.evidenceCoverage.corroborationBegan, families: t.observations[t.observations.length - 1]?.sourceFamilies ?? [] });
  for (const [f, at] of Object.entries(t.evidenceCoverage?.firstSeenFamily ?? {})) if (at !== t.firstObservedAt) lines.push({ code: "COVERAGE_EXPANDED", family: f, at });
  for (const c of t.contradictions) lines.push({ code: "CONTRADICTION", kind: c.kind, status: c.status, occurrences: c.occurrences, firstSeen: c.firstSeen, lastSeen: c.lastSeen });
  for (const m of t.quality.missingModalities ?? []) lines.push({ code: "MODALITY_UNAVAILABLE", family: m });
  if (t.quality.attendanceLimited) lines.push({ code: "ATTENDANCE_LIMITED" });
  return lines;
};

/**
 * The development history of one pupil on one day.
 *
 * @param {object}   input
 * @param {object[]} input.snapshots   StrengthProfileSnapshot documents (or their JSON), any order; read as recorded
 * @param {object}   [input.current]   { profile, asOf, boundaryHash, explorationEngineVersion } — the current reading, built for the same asOf
 * @param {string|Date} input.asOf     required; nothing after it exists
 */
const buildDevelopmentHistory = ({ snapshots = [], current = null, asOf }) => {
  if (!asOf) throw new Error("buildDevelopmentHistory: asOf is required");
  const at = new Date(asOf).toISOString();
  const observations = observationsOf({ snapshots, current, asOf: at });
  // Contradiction history and change events are read over INDEPENDENT observations: a snapshot taken
  // today and today's reading share an evidence boundary and are one observation, not two.
  const independent = independentOf(observations);
  const contradictions = analyseContradictionHistory({ observations: independent, asOf: at });
  const changes = [];
  for (let i = 1; i < independent.length; i++) changes.push(...changesBetween(independent[i - 1], independent[i], { history: contradictions }));
  const trajectories = DIMENSIONS.map((d) => trajectoryFor(d, observations, { asOf: at, contradictions, changes })).filter((t) => t.observed);
  const subjectIds = [...new Set(observations.flatMap((o) => Object.keys(o.subjects)))].sort();
  const subjectTrajectories = subjectIds.map((s) => subjectTrajectoryFor(s, observations, { asOf: at }));
  const all = [...trajectories, ...subjectTrajectories];
  const last = observations[observations.length - 1] ?? null;
  return {
    developmentEngineVersion: V.DEVELOPMENT_ENGINE_VERSION,
    asOf: at,
    windows: V.WINDOWS,
    rules: V.RULES,
    versions: {
      development: V.DEVELOPMENT_ENGINE_VERSION,
      current: last?.versions ?? null,
      observed: [...new Set(observations.map((o) => JSON.stringify(o.versions)))].map((s) => JSON.parse(s)),
    },
    observations: observations.map((o) => ({ observedAt: o.observedAt, source: o.source, profileVersion: o.profileVersion, periodLabel: o.periodLabel, boundaryHash: o.boundaryHash, versions: o.versions, coverage: o.coverage })),
    history: {
      observationCount: observations.length,
      independentObservationCount: independent.length,
      sufficient: independent.length >= V.RULES.independentObservationsForHistory,
      firstObservedAt: observations[0]?.observedAt ?? null,
      lastObservedAt: last?.observedAt ?? null,
    },
    trajectories: all.map((t) => ({ ...t, explanation: explain(t) })),
    changes,
    contradictions,
    coverage: {
      current: last?.coverage ?? null,
      history: observations.map((o) => ({ observedAt: o.observedAt, families: o.coverage.families, sequences: o.coverage.sequences })),
      familiesEverSeen: [...new Set(observations.flatMap((o) => o.coverage.families))].sort(),
    },
    quality: {
      history: independent.length >= V.RULES.independentObservationsForHistory ? "SUFFICIENT" : "INSUFFICIENT",
      trajectories: Object.fromEntries(all.map((t) => [t.dimensionId ?? `subject:${t.subjectId}`, t.quality])),
      contradictions: { current: contradictions.filter((c) => c.current).length, historical: contradictions.filter((c) => !c.current).length, persistent: contradictions.filter((c) => c.status === "PERSISTENT").length },
      missingModalities: last ? [...new Set(Object.values(last.dimensions).flatMap((d) => d.missingModalities))].sort() : [],
    },
    notInferred: V.NOT_INFERRED,
  };
};

module.exports = {
  ...V,
  buildDevelopmentHistory, compareDevelopmentSnapshots, analyseContradictionHistory,
  observationOf, observationOfSnapshot, observationsOf, dimensionOf, changesBetween, dimensionChange,
  trajectoryFor, subjectTrajectoryFor, independentOf, directionOf, trajectoryLabel, explain,
};
