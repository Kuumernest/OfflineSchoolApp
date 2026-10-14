// shared/developmentPlanning/review.js
"use strict";

/**
 * Historical reconstruction of a plan.
 *
 * A stored plan is append-only: status moves, milestone moves, reviews,
 * adaptations, reflections and constraints each carry the time they
 * happened. `reconstruct(plan, asOf)` replays only what happened at or
 * before asOf, so a plan as of a date reads the same whatever came later.
 * A plan created after asOf did not exist: null.
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);
const upTo = (xs, at) => (xs ?? []).filter((x) => !at || (iso(x.at) ?? "") <= at);

const reconstruct = (plan, asOf) => {
  if (!plan) return null;
  const at = iso(asOf);
  const created = iso(plan.createdAt ?? plan.reviewSchedule?.startDate);
  if (at && created && created > at) return null;
  const statusMoves = upTo(plan.statusHistory, at);
  const status = statusMoves.length ? statusMoves[statusMoves.length - 1].to : (plan.statusHistory?.length ? "DRAFT" : plan.status);
  const adaptations = upTo(plan.adaptations, at);
  // Actions added by asOf; a replacement that happened after asOf has not happened yet. Replaced actions stay, marked, so the record is whole.
  const actions = (plan.actions ?? []).filter((a) => !at || (iso(a.addedAt) ?? "") <= at).map((a) => (at && a.replacedAt && iso(a.replacedAt) > at ? { ...a, replacedAt: null } : a));
  const milestones = (plan.milestones ?? []).map((m) => {
    const moves = upTo(m.history, at);
    const born = iso(m.createdAt);
    if (at && born && born > at) return null;
    const state = moves.length ? moves[moves.length - 1].to : (m.history?.length ? (m.order === 1 && !m.adaptationIndex ? "AVAILABLE" : "PENDING") : m.state);
    const last = moves.length ? moves[moves.length - 1] : null;
    return { milestoneId: m.milestoneId, kind: m.kind, owner: m.owner, order: m.order, evidenceFamily: m.evidenceFamily, state, reason: last?.reason ?? (moves.length ? null : m.reason ?? null), history: moves };
  }).filter(Boolean);
  return {
    ...plan,
    status, actions, milestones, adaptations,
    statusHistory: statusMoves,
    reviews: upTo(plan.reviews, at),
    reflections: upTo(plan.reflections, at),
    constraints: upTo(plan.constraints, at),
    reconstructedAsOf: at,
  };
};

module.exports = { reconstruct, upTo };
