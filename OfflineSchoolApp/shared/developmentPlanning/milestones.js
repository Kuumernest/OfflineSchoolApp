// shared/developmentPlanning/milestones.js
"use strict";

/**
 * Milestones: observable events in order. The first is AVAILABLE, the rest
 * PENDING; completing or skipping one makes the next available. A skipped
 * milestone carries a categorical reason and is not a failure. Nothing here
 * measures the child.
 */

const { MILESTONE_TRANSITIONS, MILESTONE_STATES, SKIP_REASONS, MILESTONE_KINDS } = require("./version");
const { OBJECTIVES } = require("./taxonomy");

const err = (code, message) => { const e = new Error(message); e.code = code; return e; };

const FAMILY_OF = Object.freeze({
  activity_started: "EXPLORATION", activity_completed: "EXPLORATION", assignment_submitted: "ASSIGNMENT", quiz_completed: "QUIZ", teacher_observation_recorded: "TEACHER_OBSERVATION",
  practical_completed: "PRACTICAL", reflection_submitted: "REFLECTION", support_session_completed: "TEACHER_OBSERVATION", second_independent_observation_recorded: "ACADEMIC",
  coursework_submitted: "COURSEWORK", different_approach_tried: "ASSIGNMENT",
});

/** The milestones an objective opens, in order. `prefix` keeps ids unique across adaptations. */
const milestonesFor = (objectiveCategory, { prefix = "m" } = {}) => {
  const def = OBJECTIVES[objectiveCategory];
  if (!def) throw err("INVALID_OBJECTIVE", `Unknown objective "${objectiveCategory}"`);
  return def.milestones.map(([kind, owner], i) => ({
    milestoneId: `${prefix}${i + 1}`, kind, owner, order: i + 1, evidenceFamily: FAMILY_OF[kind],
    state: i === 0 ? "AVAILABLE" : "PENDING", reason: null, history: [],
  }));
};

/** Which roles may move a milestone: its owner, and staff for any. */
const mayMove = (milestone, actorRole) => actorRole === "TEACHER" || actorRole === "SCHOOL_ADMIN" || milestone.owner === actorRole;

/**
 * One milestone move. Returns the new list (the input is not mutated) or throws.
 * Completing or skipping opens the next PENDING milestone.
 */
const milestoneTransition = (milestones, { milestoneId, action, actorRole, reason = null, at = null, by = null }) => {
  const rule = MILESTONE_TRANSITIONS[action];
  if (!rule) throw err("INVALID_MILESTONE_TRANSITION", `Unknown action "${action}"`);
  const idx = milestones.findIndex((m) => m.milestoneId === milestoneId);
  if (idx < 0) throw err("MILESTONE_NOT_FOUND", `No milestone "${milestoneId}"`);
  const m = milestones[idx];
  if (!mayMove(m, actorRole)) throw err("ROLE_NOT_ALLOWED", `${actorRole} may not ${action} a ${m.owner} milestone`);
  if (m.state === rule.to) return { milestones, changed: false };
  if (!rule.from.includes(m.state)) throw err("INVALID_MILESTONE_TRANSITION", `Cannot ${action} from ${m.state}`);
  if (action === "skip" && !SKIP_REASONS.includes(reason)) throw err("INVALID_SKIP_REASON", "A skip needs one of the documented reasons");
  const next = milestones.map((x) => ({ ...x, history: [...(x.history ?? [])] }));
  next[idx] = { ...next[idx], state: rule.to, reason: action === "skip" || action === "block" ? reason : next[idx].reason, history: [...next[idx].history, { from: m.state, to: rule.to, action, reason: action === "skip" || action === "block" ? reason : null, by, role: actorRole, at }] };
  if (rule.to === "COMPLETED" || rule.to === "SKIPPED") {
    const following = next.find((x, i) => i > idx && x.state === "PENDING");
    if (following) { following.state = "AVAILABLE"; following.history = [...following.history, { from: "PENDING", to: "AVAILABLE", action: "advance", reason: null, by: null, role: "SYSTEM", at }]; }
  }
  return { milestones: next, changed: true };
};

/** Counts, never a percentage. */
const progressOf = (milestones) => ({
  total: milestones.length,
  completed: milestones.filter((m) => m.state === "COMPLETED").length,
  skipped: milestones.filter((m) => m.state === "SKIPPED").length,
  blocked: milestones.filter((m) => m.state === "BLOCKED").length,
  started: milestones.filter((m) => m.state === "STARTED").length,
  available: milestones.filter((m) => m.state === "AVAILABLE").length,
  pending: milestones.filter((m) => m.state === "PENDING").length,
  next: milestones.find((m) => m.state === "AVAILABLE" || m.state === "STARTED") ?? null,
});

module.exports = { FAMILY_OF, milestonesFor, milestoneTransition, progressOf, mayMove, MILESTONE_STATES, MILESTONE_KINDS };
