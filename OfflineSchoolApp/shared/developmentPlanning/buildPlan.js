// shared/developmentPlanning/buildPlan.js
"use strict";

/**
 * A plan, built from a guidance item: the pure contract before anybody has
 * proposed or accepted it. No id (the application mints one, or the client
 * does offline), no name, no note, no copy of the evidence — the evidence
 * boundary and the source ids are referenced.
 */

const { DEVELOPMENT_PLANNING_ENGINE_VERSION, OWNER_ROLES, ACTION_TYPES, RULES, OBJECTIVE_CATEGORIES } = require("./version");
const { OBJECTIVES, ACTION_EXPLANATIONS } = require("./taxonomy");
const { eligibility } = require("./rules");
const { milestonesFor } = require("./milestones");

const err = (code, message) => { const e = new Error(message); e.code = code; return e; };
const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * 86400000).toISOString();

/**
 * @param {object} input
 * @param {object} input.guidanceItem         a Stage 15 guidance item
 * @param {string} [input.objectiveCategory]  defaults to the one the guidance category opens
 * @param {string[]} [input.actions]          action types, at most RULES.maxActions; default per objective
 * @param {string} [input.ownerRole]          who is responsible; defaults to TEACHER, or STUDENT for an evidence-gap or exploration objective
 * @param {string|Date} input.startDate       required
 * @param {number} [input.reviewDays]         clamped to [minimum, maximum]
 * @param {string} [input.evidenceBoundaryHash]  the strengths boundary the guidance stood on
 * @param {string[]} [input.sourceInterventionIds]
 * @param {object} [input.engineVersions]
 */
const buildPlan = ({ guidanceItem, objectiveCategory = null, actions = null, ownerRole = null, startDate, reviewDays = null, evidenceBoundaryHash = null, sourceInterventionIds = [], engineVersions = {} }) => {
  const el = eligibility({ guidanceItem });
  if (!el.eligible) throw err("PLAN_NOT_ELIGIBLE", `Guidance does not open a plan: ${el.reason}`);
  const category = objectiveCategory ?? el.objectiveCategory;
  if (!OBJECTIVE_CATEGORIES.includes(category)) throw err("INVALID_OBJECTIVE", `Unknown objective "${category}"`);
  if (!startDate) throw err("INVALID_PLAN", "startDate is required");
  const def = OBJECTIVES[category];
  const chosen = (actions && actions.length ? actions : def.defaultActions).slice(0, RULES.maxActions);
  for (const a of chosen) if (!ACTION_TYPES.includes(a)) throw err("INVALID_ACTION", `"${a}" is not a controlled action`);
  const owner = ownerRole ?? (category === "RESOLVE_EVIDENCE_GAP" || category === "EXPLORE" || category === "REFLECT" ? "STUDENT" : "TEACHER");
  if (!OWNER_ROLES.includes(owner)) throw err("INVALID_OWNER", `Unknown owner role "${owner}"`);
  const days = Math.min(RULES.maximumReviewDays, Math.max(RULES.minimumReviewDays, reviewDays ?? RULES.defaultReviewDays));
  const start = new Date(startDate).toISOString();
  return {
    dimension: guidanceItem.dimension ?? null,
    subjectId: guidanceItem.subjectId ?? null,
    objective: { category, code: def.code, evidenceFamilies: def.evidenceFamilies, completion: def.completion },
    rationale: {
      guidanceId: guidanceItem.id, guidanceCategory: guidanceItem.category, reasons: guidanceItem.reasons ?? [],
      observed: { state: guidanceItem.evidence?.state ?? null, trajectory: guidanceItem.evidence?.trajectory ?? null, relationship: guidanceItem.evidence?.relationship ?? null, direction: guidanceItem.evidence?.direction ?? null },
      evidenceQuality: guidanceItem.evidenceQuality ?? null, eligibility: el.reason,
    },
    sourceGuidanceIds: [guidanceItem.id],
    sourceInterventionIds: [...sourceInterventionIds],
    actions: chosen.map((actionType) => ({ actionType, explanation: ACTION_EXPLANATIONS[actionType], addedAt: start, replacedAt: null })),
    milestones: milestonesFor(category),
    reviewSchedule: { startDate: start, reviewDate: addDays(start, days), intervalDays: days },
    ownerRole: owner,
    studentParticipation: { required: true, acceptedAt: null, declinedAt: null, reflections: 0 },
    status: "DRAFT",
    evidenceBoundaryHash,
    engineVersions: { planning: DEVELOPMENT_PLANNING_ENGINE_VERSION, ...engineVersions },
    explanation: {
      why: { code: "FROM_GUIDANCE", guidanceId: guidanceItem.id, category: guidanceItem.category, reasons: guidanceItem.reasons ?? [] },
      evidence: { code: "EVIDENCE_BASIS", boundary: evidenceBoundaryHash, observed: guidanceItem.evidence?.state ?? null, trajectory: guidanceItem.evidence?.trajectory ?? null, quality: guidanceItem.evidenceQuality ?? null },
      objective: { code: def.code, category },
      experience: { code: "WHAT_THE_PUPIL_WILL_DO", actions: chosen },
      milestones: { code: "MILESTONES_THAT_MATTER", kinds: def.milestones.map(([k]) => k) },
      evidenceToCollect: { code: "EVIDENCE_TO_COLLECT", families: def.evidenceFamilies },
      review: { code: "REVIEW_ON", at: addDays(start, days) },
    },
  };
};

module.exports = { buildPlan, addDays };
