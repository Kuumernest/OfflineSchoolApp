// shared/development/contradictions.js
"use strict";

/**
 * Standing conflicts, over time.
 *
 * Stage 11 and 13 record a conflict on the day it is read
 * (ACADEMIC_VS_EXPLORATION, ACADEMIC_VS_LEARNING_EVIDENCE, INTEREST_VS_PERFORMANCE,
 * …). This file turns the sequence of those readings into one record per
 * (dimension, kind): when it was first and last seen, how many observations
 * carried it, over how many independent periods, and what its status is now.
 *
 *   NEW                   seen for the first time in the latest observation
 *   PERSISTENT            present in the latest observation and the one before
 *   RECURRING             present now, seen before, absent in between
 *   RESOLVED              absent in two independent observations after it was last seen
 *   STALE                 not resolved, last seen more than a year before asOf, absent since
 *   INSUFFICIENT_HISTORY  absent now, but only one later observation — too soon to call it resolved
 *
 * A contradiction is never erased. A resolved one keeps its first and last
 * sighting and names the observations that resolved it.
 */

const { WINDOWS, RULES } = require("./version");

const daysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

/** Distinct independent periods among observations: a period label when there is one, else the evidence boundary, else the date. */
const periodsOf = (obs) => new Set(obs.map((o) => o.periodLabel ?? o.boundaryHash ?? o.observedAt)).size;

/**
 * @param {object[]} observations  chronological, from observations.js
 * @param {string}   asOf          ISO date
 */
const analyseContradictionHistory = ({ observations, asOf }) => {
  const keys = new Map();
  observations.forEach((o, i) => {
    for (const c of o.contradictions) {
      const k = `${c.dimension}|${c.kind}`;
      if (!keys.has(k)) keys.set(k, { dimension: c.dimension, kind: c.kind, indices: [] });
      keys.get(k).indices.push(i);
    }
  });
  const last = observations.length - 1;
  const out = [];
  for (const { dimension, kind, indices } of keys.values()) {
    const seen = indices.map((i) => observations[i]);
    const lastIdx = indices[indices.length - 1];
    const presentNow = lastIdx === last;
    const after = observations.slice(lastIdx + 1);
    const independentAfter = new Set(after.map((o) => o.boundaryHash ?? o.observedAt)).size;
    let status, resolution = null;
    if (presentNow) {
      status = indices.length === 1 ? "NEW" : indices.includes(last - 1) ? "PERSISTENT" : "RECURRING";
    } else if (independentAfter >= RULES.observationsToResolveContradiction) {
      // Resolution by later evidence outranks age: what resolved it is on record.
      status = "RESOLVED";
      resolution = { resolutionDate: after[0].observedAt, resolutionEvidence: after.map((o) => ({ observedAt: o.observedAt, source: o.source, profileVersion: o.profileVersion, state: o.dimensions[dimension]?.state ?? null, relationship: o.dimensions[dimension]?.relationship ?? null })) };
    } else if (asOf && daysBetween(observations[lastIdx].observedAt, asOf) > WINDOWS.historicalDays) {
      status = "STALE";
    } else {
      status = "INSUFFICIENT_HISTORY";
    }
    out.push({
      dimension, kind, status,
      firstSeen: seen[0].observedAt, lastSeen: seen[seen.length - 1].observedAt,
      occurrences: indices.length, independentPeriods: periodsOf(seen),
      observedIn: seen.map((o) => ({ observedAt: o.observedAt, source: o.source, profileVersion: o.profileVersion })),
      current: presentNow,
      priority: ["NEW", "RECURRING", "PERSISTENT"].includes(status) ? status : null,
      ...(resolution ?? {}),
    });
  }
  return out.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.kind.localeCompare(b.kind));
};

module.exports = { analyseContradictionHistory, periodsOf };
