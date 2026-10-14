// shared/adaptiveSupport/rules.js
"use strict";

/**
 * What the evidence since the plan's boundary amounts to, and which review
 * outcome the documented rules give it.
 *
 * Priority, when several apply: a documented constraint or a resource
 * problem → PAUSE; completion criteria met → COMPLETE; contradiction,
 * decline, a pupil's or teacher's request for a change → ADAPT; nothing new
 * and nothing in progress → INSUFFICIENT_EVIDENCE; otherwise → CONTINUE.
 * Every outcome carries its reasons. None is "failed".
 */

const { ADAPTATIONS, RULES } = require("./version");

const STATE_RANK = { INSUFFICIENT: 0, DECLINING: 0, EMERGING: 1, ESTABLISHED: 2 };
const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * The independent observations that arrived after the plan's start and on a
 * different evidence boundary than the plan stood on. Repeated snapshots of
 * one boundary are one observation (Stage 14's rule, kept).
 */
const evidenceSince = ({ plan, trajectory, asOf = null }) => {
  const start = iso(plan.reviewSchedule?.startDate);
  const at = iso(asOf);
  const all = (trajectory?.observations ?? []).filter((o) => !at || o.observedAt <= at);   // nothing after asOf exists
  const rows = all.filter((o) => o.observedAt >= start);
  const seen = new Set([plan.evidenceBoundaryHash].filter(Boolean));
  const independent = [];
  for (const o of rows) { const key = o.boundaryHash ?? o.observedAt; if (seen.has(key)) continue; seen.add(key); independent.push(o); }
  const baseline = all.filter((o) => o.observedAt < start).pop() ?? null;
  const latest = independent[independent.length - 1] ?? null;
  const families = new Set(independent.flatMap((o) => [...(o.sourceFamilies ?? []), ...(o.explorationEvents ? ["EXPLORATION"] : []), ...(o.teacherObservers ? ["TEACHER_OBSERVATION"] : [])]));
  const relevant = (plan.objective?.evidenceFamilies ?? []).filter((f) => families.has(f));
  let reading = null;
  if (baseline && latest) {
    const d = STATE_RANK[latest.state] - STATE_RANK[baseline.state];
    reading = latest.state === "DECLINING" && baseline.state !== "DECLINING" ? "DECLINING" : baseline.state === "DECLINING" && latest.state !== "DECLINING" && latest.state !== "INSUFFICIENT" ? "IMPROVING" : d > 0 ? "IMPROVING" : d < 0 ? "DECLINING" : "STABLE";
    if (reading === "STABLE" && latest.relationship === "CORROBORATED" && baseline.relationship !== "CORROBORATED") reading = "IMPROVING";
  }
  const contradiction = latest ? ((latest.contradictions ?? []).length > 0 && !(baseline?.contradictions ?? []).length) || (latest.relationship === "CONTRADICTED" && baseline?.relationship !== "CONTRADICTED") : false;
  return {
    baseline: baseline ? { observedAt: baseline.observedAt, state: baseline.state, relationship: baseline.relationship, boundaryHash: baseline.boundaryHash } : null,
    latest: latest ? { observedAt: latest.observedAt, state: latest.state, relationship: latest.relationship, boundaryHash: latest.boundaryHash } : null,
    independentObservations: independent.length,
    families: [...families].sort(), relevantFamilies: relevant,
    reading, contradiction,
    developmentObservationBoundary: latest?.boundaryHash ?? baseline?.boundaryHash ?? null,
  };
};

/** The reasons a review carries, from every input. */
const reasonsFor = ({ plan, evidence, milestones, reflections, teacherReview, constraints, interventionOutcomes, previousReviews }) => {
  const r = new Set();
  const done = milestones.filter((m) => m.state === "COMPLETED").length;
  const required = plan.objective?.completion?.requiredMilestones ?? milestones.length;
  const needObs = plan.objective?.completion?.independentObservations ?? 1;
  const openConstraints = (constraints ?? []).filter((c) => !c.resolvedAt);
  if (openConstraints.length) r.add("CONSTRAINT_DOCUMENTED");
  if (milestones.some((m) => m.state === "BLOCKED")) r.add("MILESTONES_BLOCKED");
  if (evidence.independentObservations > 0) r.add("NEW_INDEPENDENT_EVIDENCE"); else r.add("NO_NEW_INDEPENDENT_EVIDENCE");
  if (evidence.reading === "IMPROVING") r.add("EVIDENCE_IMPROVING");
  if (evidence.reading === "STABLE") r.add("EVIDENCE_STABLE");
  if (evidence.reading === "DECLINING") r.add("EVIDENCE_DECLINING");
  if (evidence.contradiction) r.add("CONTRADICTORY_EVIDENCE");
  if (done >= required && evidence.independentObservations >= needObs) r.add("COMPLETION_CRITERIA_MET"); else if (done < required) r.add("MILESTONES_REQUIRED_NOT_MET");
  if (milestones.some((m) => m.state === "STARTED" || m.state === "AVAILABLE") && done < required) r.add(done > 0 ? "MILESTONES_IN_PROGRESS" : "PLAN_STILL_GATHERING_EVIDENCE");
  const codes = new Set((reflections ?? []).flatMap((x) => x.codes ?? []));
  if (codes.has("NOT_USEFUL")) r.add("STUDENT_REPORTED_NOT_USEFUL");
  if (codes.has("TOO_DIFFICULT")) r.add("STUDENT_REPORTED_TOO_DIFFICULT");
  if (codes.has("TOO_EASY")) r.add("STUDENT_REPORTED_TOO_EASY");
  if (codes.has("NEED_MORE_SUPPORT")) r.add("STUDENT_REPORTED_NEED_SUPPORT");
  if (codes.has("RESOURCE_PROBLEM")) r.add("STUDENT_REPORTED_RESOURCE_PROBLEM");
  if (codes.has("PREFER_DIFFERENT_APPROACH")) r.add("STUDENT_PREFERS_DIFFERENT_APPROACH");
  if (codes.has("USEFUL")) r.add("STUDENT_REPORTED_USEFUL");
  const tr = teacherReview?.code ?? null;
  if (tr === "OBSERVED_PROGRESS") r.add("TEACHER_OBSERVED_PROGRESS");
  if (tr === "OBSERVED_STABILITY") r.add("TEACHER_OBSERVED_STABILITY");
  if (tr === "OBSERVED_DIFFICULTY") r.add("TEACHER_OBSERVED_DIFFICULTY");
  if (tr === "NO_NEW_EVIDENCE") r.add("TEACHER_REPORTED_NO_NEW_EVIDENCE");
  if (tr === "CONTEXT_CHANGED") r.add("TEACHER_REPORTED_CONTEXT_CHANGED");
  if (tr === "SUPPORT_REQUIRED") r.add("TEACHER_REQUESTED_SUPPORT");
  for (const o of interventionOutcomes ?? []) {
    if (o?.outcome === "IMPROVED") r.add("INTERVENTION_OUTCOME_IMPROVED");
    if (o?.outcome === "DECLINED") r.add("INTERVENTION_OUTCOME_DECLINED");
    if (o?.outcome === "MIXED") r.add("INTERVENTION_OUTCOME_MIXED");
    if (o?.outcome === "INSUFFICIENT_EVIDENCE") r.add("INTERVENTION_OUTCOME_INSUFFICIENT");
  }
  // "The expected change is not shown": two reviews with new evidence and no improvement, milestones done.
  const priorWithEvidence = (previousReviews ?? []).filter((x) => x.system?.reasons?.includes("NEW_INDEPENDENT_EVIDENCE") && !x.system?.reasons?.includes("EVIDENCE_IMPROVING")).length;
  if (evidence.independentObservations > 0 && evidence.reading !== "IMPROVING" && done > 0 && priorWithEvidence + 1 >= RULES.reviewsBeforeExpectedChangeIsJudged) r.add("EXPECTED_CHANGE_NOT_SHOWN");
  return [...r];
};

const PAUSE = ["CONSTRAINT_DOCUMENTED", "STUDENT_REPORTED_RESOURCE_PROBLEM"];
const ADAPT = ["CONTRADICTORY_EVIDENCE", "EVIDENCE_DECLINING", "STUDENT_REPORTED_NOT_USEFUL", "STUDENT_PREFERS_DIFFERENT_APPROACH", "STUDENT_REPORTED_TOO_DIFFICULT", "STUDENT_REPORTED_TOO_EASY",
  "STUDENT_REPORTED_NEED_SUPPORT", "TEACHER_OBSERVED_DIFFICULTY", "TEACHER_REQUESTED_SUPPORT", "TEACHER_REPORTED_CONTEXT_CHANGED", "EXPECTED_CHANGE_NOT_SHOWN", "MILESTONES_BLOCKED", "INTERVENTION_OUTCOME_DECLINED"];

/** Outcome and the bounded adaptation, from the reasons. */
const outcomeFor = (reasons) => {
  const has = (c) => reasons.includes(c);
  let outcome;
  if (PAUSE.some(has)) outcome = "PAUSE";
  else if (has("COMPLETION_CRITERIA_MET")) outcome = "COMPLETE";
  else if (ADAPT.some(has)) outcome = "ADAPT";
  else if (has("NO_NEW_INDEPENDENT_EVIDENCE") && !has("MILESTONES_IN_PROGRESS") && !has("PLAN_STILL_GATHERING_EVIDENCE")) outcome = "INSUFFICIENT_EVIDENCE";
  else if (has("TEACHER_REPORTED_NO_NEW_EVIDENCE") && !has("NEW_INDEPENDENT_EVIDENCE")) outcome = "INSUFFICIENT_EVIDENCE";
  else outcome = "CONTINUE";
  const triggers = reasons.filter((c) => ADAPTATIONS[c]);
  const suggested = [...new Set(triggers.flatMap((c) => ADAPTATIONS[c]))];
  return { outcome, suggestedActions: outcome === "ADAPT" || outcome === "PAUSE" || outcome === "INSUFFICIENT_EVIDENCE" ? suggested : [], adaptationTriggers: triggers };
};

module.exports = { evidenceSince, reasonsFor, outcomeFor, STATE_RANK };
