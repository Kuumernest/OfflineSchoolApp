// shared/developmentPlanning/rules.js
"use strict";

/**
 * Eligibility, the plan lifecycle, duplicate prevention.
 *
 * A plan comes from guidance the upstream engines already judged. It is
 * never created from one mark, one activity, one observation or one
 * reflection: the guidance item must rest on a sufficient history — except
 * an evidence-gap objective, which is exactly what an insufficient history
 * calls for. Declining a plan is a decision, recorded as such and read as
 * nothing else.
 */

const { PLAN_TRANSITIONS, PLAN_STATUS, OPEN_STATUS } = require("./version");
const { GUIDANCE_TO_OBJECTIVE } = require("./taxonomy");

const err = (code, message) => { const e = new Error(message); e.code = code; return e; };

/** Whether a guidance item may open a plan, and which objective. */
const eligibility = ({ guidanceItem }) => {
  if (!guidanceItem) return { eligible: false, reason: "NO_GUIDANCE_ITEM", objectiveCategory: null };
  const objectiveCategory = GUIDANCE_TO_OBJECTIVE[guidanceItem.category] ?? null;
  if (!objectiveCategory) return { eligible: false, reason: "GUIDANCE_CATEGORY_OPENS_NO_PLAN", objectiveCategory: null };
  const sufficient = Boolean(guidanceItem.explanation?.uncertain?.historySufficient);
  if (!sufficient && objectiveCategory !== "RESOLVE_EVIDENCE_GAP") return { eligible: false, reason: "INSUFFICIENT_HISTORY", objectiveCategory };
  return { eligible: true, reason: sufficient ? "HISTORY_SUFFICIENT" : "EVIDENCE_GAP_OBJECTIVE", objectiveCategory };
};

/** One lifecycle move. Returns { status, changed } or throws INVALID_TRANSITION / ROLE_NOT_ALLOWED. */
const transition = ({ status, action, actorRole }) => {
  const rule = PLAN_TRANSITIONS[action];
  if (!rule) throw err("INVALID_TRANSITION", `Unknown action "${action}"`);
  if (!PLAN_STATUS.includes(status)) throw err("INVALID_TRANSITION", `Unknown status "${status}"`);
  if (!rule.roles.includes(actorRole)) throw err("ROLE_NOT_ALLOWED", `${actorRole} may not ${action}`);
  if (status === rule.to) return { status, changed: false };                 // a replayed move
  if (!rule.from.includes(status)) throw err("INVALID_TRANSITION", `Cannot ${action} from ${status}`);
  return { status: rule.to, changed: true };
};

const isOpen = (status) => OPEN_STATUS.includes(status);

/** An open plan for the same pupil, dimension/subject and objective. Null when none. */
const duplicateOf = (plans, { dimension, subjectId, objectiveCategory }) =>
  (plans ?? []).find((p) => isOpen(p.status) && (p.dimension ?? null) === (dimension ?? null) && (p.subjectId ?? null) === (subjectId ?? null) && p.objective?.category === objectiveCategory) ?? null;

module.exports = { eligibility, transition, isOpen, duplicateOf };
