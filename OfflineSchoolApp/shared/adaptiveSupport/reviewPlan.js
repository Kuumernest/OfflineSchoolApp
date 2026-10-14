// shared/adaptiveSupport/reviewPlan.js
"use strict";

/**
 * One plan review: the nine questions answered as structured fields, the
 * categorical outcome, the reasons, the bounded adaptation, and the
 * boundaries it was made on. Pure; asOf is required and echoed.
 */

const { ADAPTIVE_SUPPORT_ENGINE_VERSION } = require("./version");
const { evidenceSince, reasonsFor, outcomeFor } = require("./rules");
const { ACTION_EXPLANATIONS } = require("../developmentPlanning/taxonomy");
const { progressOf } = require("../developmentPlanning/milestones");

/**
 * @param {object} input
 * @param {object}   input.plan                 the plan as it stood (reconstructed for asOf)
 * @param {object}   [input.development]        the Stage 14 history for the same asOf
 * @param {object[]} [input.interventionOutcomes]  Stage 15 outcome interpretations for the plan's source interventions
 * @param {object[]} [input.reflections]        the pupil's reflections since the last review
 * @param {object}   [input.teacherReview]      { code, note } from the reviewing teacher
 * @param {object[]} [input.constraints]        documented constraints on the plan
 * @param {string|Date} input.asOf              required
 */
const reviewPlan = ({ plan, development = null, interventionOutcomes = [], reflections = [], teacherReview = null, constraints = [], asOf }) => {
  if (!asOf) throw new Error("reviewPlan: asOf is required");
  if (!plan) throw new Error("reviewPlan: plan is required");
  const at = new Date(asOf).toISOString();
  const trajectory = (development?.trajectories ?? []).find((t) => (plan.dimension ? t.dimensionId === plan.dimension : t.subjectId === plan.subjectId)) ?? null;
  const evidence = evidenceSince({ plan, trajectory, asOf: at });
  const milestones = plan.milestones ?? [];
  const sinceLast = plan.reviews?.length ? plan.reviews[plan.reviews.length - 1].at : null;
  const recentReflections = (reflections ?? []).filter((x) => !sinceLast || new Date(x.at).toISOString() > new Date(sinceLast).toISOString());
  const reasons = reasonsFor({ plan, evidence, milestones, reflections: recentReflections, teacherReview, constraints: constraints ?? plan.constraints ?? [], interventionOutcomes, previousReviews: plan.reviews ?? [] });
  const { outcome, suggestedActions, adaptationTriggers } = outcomeFor(reasons);
  const lastChange = trajectory?.changes?.filter((c) => c.observedAt >= new Date(plan.reviewSchedule.startDate).toISOString()).pop() ?? null;
  const progress = progressOf(milestones);
  return {
    adaptiveSupportEngineVersion: ADAPTIVE_SUPPORT_ENGINE_VERSION,
    asOf: at,
    outcome, reasons,
    adaptation: { suggestedActions, explanations: Object.fromEntries(suggestedActions.map((a) => [a, ACTION_EXPLANATIONS[a]])), triggers: adaptationTriggers },
    evidenceBoundaryHash: plan.evidenceBoundaryHash ?? null,
    developmentObservationBoundary: evidence.developmentObservationBoundary,
    contradiction: evidence.contradiction ? { code: "NEW_EVIDENCE_CONFLICTS_WITH_RATIONALE", rationale: plan.rationale?.observed ?? null, latest: evidence.latest, originalEvidenceKept: true } : null,
    contract: {
      objective: { category: plan.objective?.category ?? null, code: plan.objective?.code ?? null, dimension: plan.dimension ?? null, subjectId: plan.subjectId ?? null },
      attempted: { actions: (plan.actions ?? []).map((a) => a.actionType), adaptations: (plan.adaptations ?? []).length },
      milestones: { progress, occurred: milestones.filter((m) => m.state === "COMPLETED" || m.state === "SKIPPED").map((m) => ({ milestoneId: m.milestoneId, kind: m.kind, state: m.state, reason: m.reason ?? null })) },
      evidence: { independentObservations: evidence.independentObservations, families: evidence.families, relevantFamilies: evidence.relevantFamilies, baseline: evidence.baseline, latest: evidence.latest },
      changed: { reading: evidence.reading, lastChange: lastChange ? { at: lastChange.observedAt, changeTypes: lastChange.changeTypes, reasonCodes: lastChange.reasonCodes } : null, interventionOutcomes: (interventionOutcomes ?? []).map((o) => o?.outcome ?? null) },
      studentReported: { codes: [...new Set(recentReflections.flatMap((x) => x.codes ?? []))], count: recentReflections.length },
      teacherObserved: teacherReview ? { code: teacherReview.code ?? null } : null,
      uncertain: { noNewEvidence: evidence.independentObservations === 0, contradiction: evidence.contradiction, constraints: (constraints ?? plan.constraints ?? []).filter((c) => !c.resolvedAt).map((c) => c.code), missingRelevantFamilies: (plan.objective?.evidenceFamilies ?? []).filter((f) => !evidence.families.includes(f)) },
      next: { outcome, suggestedActions, code: `NEXT_${outcome}` },
    },
    statement: { code: outcome === "COMPLETE" ? "OBJECTIVE_ADDRESSED_PER_CRITERIA" : outcome === "ADAPT" ? "AVAILABLE_EVIDENCE_DOES_NOT_SHOW_THE_EXPECTED_CHANGE_OR_A_CHANGE_WAS_REQUESTED" : outcome === "PAUSE" ? "EXECUTION_CANNOT_REASONABLY_CONTINUE" : outcome === "INSUFFICIENT_EVIDENCE" ? "NOT_ENOUGH_EVIDENCE_TO_REVIEW" : "OBJECTIVE_STILL_RELEVANT_PLAN_STILL_APPROPRIATE", causal: false },
  };
};

module.exports = { reviewPlan };
