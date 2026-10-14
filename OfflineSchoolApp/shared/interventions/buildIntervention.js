// shared/interventions/buildIntervention.js
"use strict";

/**
 * A proposal, built from a trigger: the pure intervention contract, before
 * anybody has accepted it. No id (the application mints one, or the client
 * does offline), no name, no note. A person owns it; the system proposes.
 */

const { INTERVENTION_ENGINE_VERSION, TRIGGERS, OWNER_ROLES, RULES } = require("./version");
const { TRIGGER_DEFINITIONS, ACTIONS } = require("./taxonomy");

const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * 86400000).toISOString();

/**
 * @param {object} input
 * @param {string} input.trigger         one of TRIGGERS
 * @param {string} input.dimension       the dimension the trigger came from
 * @param {object} [input.triggerEvidence]  the trigger's evidence, as triggersFor returned it
 * @param {string} [input.guidanceId]    the guidance item this follows, when it does
 * @param {string} [input.action]        one of the trigger's bounded actions; the first by default
 * @param {string} [input.ownerRole]     defaults to the trigger's owner
 * @param {number} [input.durationDays]  bounded to [minimum, maximum]
 * @param {string|Date} input.startDate  required
 * @param {object} [input.engineVersions]  the versions of the layers beneath, echoed
 */
const buildIntervention = ({ trigger, dimension, triggerEvidence = null, guidanceId = null, action = null, ownerRole = null, durationDays = null, startDate, engineVersions = {} }) => {
  if (!TRIGGERS.includes(trigger)) { const e = new Error(`Unknown trigger "${trigger}"`); e.code = "INVALID_TRIGGER"; throw e; }
  if (!startDate) { const e = new Error("startDate is required"); e.code = "INVALID_INTERVENTION"; throw e; }
  const def = TRIGGER_DEFINITIONS[trigger];
  const owner = ownerRole ?? def.ownerRole;
  if (!OWNER_ROLES.includes(owner)) { const e = new Error(`Unknown owner role "${owner}"`); e.code = "INVALID_OWNER"; throw e; }
  const act = action ?? ACTIONS[trigger][0];
  if (!ACTIONS[trigger].includes(act)) { const e = new Error(`"${act}" is not an action for ${trigger}`); e.code = "INVALID_ACTION"; throw e; }
  const days = Math.min(RULES.maximumDurationDays, Math.max(RULES.minimumDurationDays, durationDays ?? def.durationDays));
  const start = new Date(startDate).toISOString();
  return {
    dimension, trigger, triggerEvidence, guidanceId,
    objective: def.objective, action: act, ownerRole: owner,
    startDate: start, durationDays: days, reviewDate: addDays(start, days),
    evidenceToCollect: def.evidenceToCollect,
    lifecycle: "PROPOSED",
    outcome: null,
    engineVersions: { intervention: INTERVENTION_ENGINE_VERSION, ...engineVersions },
    explanation: { why: { code: `TRIGGER_${trigger}`, evidence: triggerEvidence }, owner: { code: "OWNER_ROLE", role: owner }, objective: { code: def.objective }, evidence: { code: "EVIDENCE_TO_COLLECT", families: def.evidenceToCollect }, review: { code: "REVIEW_ON", at: addDays(start, days) } },
  };
};

module.exports = { buildIntervention, addDays };
