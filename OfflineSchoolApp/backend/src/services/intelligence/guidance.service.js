// backend/src/services/intelligence/guidance.service.js
"use strict";

/**
 * Guidance for one pupil. The projection itself is shared/.
 *
 * The mapping from an insight to a suggested action — every code, every action
 * list, every priority rule, the monitoring fallback — lives in
 * shared/intelligence/guidance.js so the desktop can show a teacher the
 * suggested actions offline rather than the evidence alone.
 *
 * What is left here is loading the profile, which needs a database and a school
 * the caller is entitled to ask about.
 */

const subjectInsights = require("./subjectInsights.service");
const engine          = require("../../../../shared/intelligence/guidance");

/** Guidance for one pupil, computed from their published results. */
const guidanceFor = async ({ schoolId, studentId }) =>
  engine.guidanceForProfile(await subjectInsights.profileFor({ schoolId, studentId }));

module.exports = {
  guidanceFor,
  // Re-exported from shared. guidanceForProfile is pure and takes an
  // already-computed profile, so a class fan-out projects the profiles it
  // already holds rather than recomputing one per pupil.
  guidanceForProfile: engine.guidanceForProfile,
  RISK_GUIDANCE:      engine.RISK_GUIDANCE,
  STRENGTH_RATIONALE: engine.STRENGTH_RATIONALE,
  STRENGTH_ACTIONS:   engine.STRENGTH_ACTIONS,
};
