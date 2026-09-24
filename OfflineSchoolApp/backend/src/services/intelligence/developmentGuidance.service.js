// backend/src/services/intelligence/developmentGuidance.service.js
"use strict";

/**
 * The development guidance layer, loaded and served.
 *
 * Builds the Stage 14 history for one pupil on one day (live or offline
 * road) and hands it to shared/guidance. Nothing is stored: guidance is
 * reproducible from the history, the current evidence and the engine
 * version, and a change of rules will be a new version, never a rewrite.
 * Identity is joined by the router after authorisation.
 */

const developmentSvc = require("./development.service");
const strengthsSvc = require("./strengths.service");
const guidance = require("../../../../shared/guidance");

const guidanceFor = async ({ schoolId, studentId, asOf = null }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const h = await developmentSvc.historyFor({ schoolId, studentId, asOf: at });
  return h ? guidance.buildGuidance({ development: h, asOf: at }) : null;
};

const offlineGuidanceFor = async ({ schoolId, studentId, asOf = null }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const h = await developmentSvc.offlineHistoryFor({ schoolId, studentId, asOf: at });
  return h ? guidance.buildGuidance({ development: h, asOf: at }) : null;
};

/** The pupil sees their own guidance whole: it carries codes, counts and categories, never a note or another pupil. */
const forStudent = (g) => g;

/**
 * The parent's view: which areas are being built, suggested ways to support
 * learning, what to watch. No reason codes, no change events, no engine
 * internals beyond the state and the category.
 */
const forGuardian = (g) => (g ? {
  asOf: g.asOf,
  items: g.items.map((i) => ({
    dimension: i.dimension, subjectId: i.subjectId, category: i.category, evidenceQuality: i.evidenceQuality,
    observed: { state: i.evidence.state, trajectory: i.evidence.trajectory },
    suggestedActions: i.suggestedActions, evidenceToWatch: i.evidenceToWatch,
    unclear: { missingModalities: i.explanation.uncertain.missingModalities, historySufficient: i.explanation.uncertain.historySufficient },
  })),
  agency: g.agency, notInferred: g.notInferred, versions: { guidance: g.guidanceEngineVersion, development: g.developmentEngineVersion },
} : null);

module.exports = { guidanceFor, offlineGuidanceFor, forStudent, forGuardian };
