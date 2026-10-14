// shared/adaptiveSupport/adaptPlan.js
"use strict";

/**
 * Apply an adaptation a human chose: the current actions are marked replaced
 * (never deleted), the chosen action is added, and fresh milestones for the
 * objective are appended after the existing ones. The record kept says what
 * was there, what is there now, why, on which evidence boundary, by whom,
 * when, and under which engine versions.
 */

const { ADAPTIVE_SUPPORT_ENGINE_VERSION } = require("./version");
const { ACTION_TYPES, DEVELOPMENT_PLANNING_ENGINE_VERSION } = require("../developmentPlanning/version");
const { ACTION_EXPLANATIONS } = require("../developmentPlanning/taxonomy");
const { milestonesFor } = require("../developmentPlanning/milestones");

const err = (code, message) => { const e = new Error(message); e.code = code; return e; };

/**
 * @param {object} input
 * @param {object} input.plan          the stored plan
 * @param {object} input.review        the review the adaptation follows (reviewPlan output, or the stored review)
 * @param {string} input.actionType    one of ACTION_TYPES, normally one the review suggested
 * @param {string} input.actorRole
 * @param {string} [input.by]
 * @param {string|Date} input.at       required
 * @returns {{ actions, milestones, adaptation }}
 */
const adaptPlan = ({ plan, review, actionType, actorRole, by = null, at }) => {
  if (!ACTION_TYPES.includes(actionType)) throw err("INVALID_ACTION", `"${actionType}" is not a controlled action`);
  if (!at) throw err("INVALID_ADAPTATION", "at is required");
  const when = new Date(at).toISOString();
  const previous = (plan.actions ?? []).filter((a) => !a.replacedAt).map((a) => a.actionType);
  const actions = [
    ...(plan.actions ?? []).map((a) => (a.replacedAt ? a : { ...a, replacedAt: when })),
    { actionType, explanation: ACTION_EXPLANATIONS[actionType], addedAt: when, replacedAt: null },
  ];
  const index = (plan.adaptations ?? []).length + 1;
  const fresh = milestonesFor(plan.objective.category, { prefix: `a${index}m` }).map((m) => ({ ...m, createdAt: when, adaptationIndex: index }));
  const milestones = [...(plan.milestones ?? []), ...fresh];
  const adaptation = {
    index, at: when, by, role: actorRole,
    previous: { actions: previous }, next: { actions: [actionType] },
    reason: { outcome: review?.outcome ?? null, reasons: review?.reasons ?? [], triggers: review?.adaptation?.triggers ?? [], suggested: review?.adaptation?.suggestedActions ?? [], chosenWasSuggested: (review?.adaptation?.suggestedActions ?? []).includes(actionType) },
    evidenceBoundaryHash: review?.evidenceBoundaryHash ?? plan.evidenceBoundaryHash ?? null,
    developmentObservationBoundary: review?.developmentObservationBoundary ?? null,
    reviewId: review?.reviewId ?? null,
    engineVersions: { adaptive: ADAPTIVE_SUPPORT_ENGINE_VERSION, planning: DEVELOPMENT_PLANNING_ENGINE_VERSION, ...(plan.engineVersions ?? {}) },
    explanation: { changed: { code: "ACTION_REPLACED", from: previous, to: [actionType] }, because: { code: "REVIEW_OUTCOME", outcome: review?.outcome ?? null, reasons: review?.reasons ?? [] }, uncertain: review?.contract?.uncertain ?? null, changing: { code: ACTION_EXPLANATIONS[actionType] } },
  };
  return { actions, milestones, adaptation };
};

module.exports = { adaptPlan };
