// shared/strengths/index.js
"use strict";

/**
 * The Strengths & Exploration layer — one entry point for the server, the
 * desktop, the calibration tooling and the checks.
 *
 * Consumes shared/intelligence's academic profile; produces a strengths
 * profile whose every claim carries its evidence. Versioned on its own:
 * STRENGTH_ENGINE_VERSION moves when a rule, threshold, keyword or area here
 * changes, and the academic engine's version does not move for that.
 *
 * Capability, stated plainly: evidence-based student strengths and
 * exploration intelligence. Not talent detection, not career guidance.
 */

const taxonomy = require("./taxonomy");
const engine   = require("./engine");

module.exports = {
  ...engine,
  DIMENSIONS:        taxonomy.DIMENSIONS,
  EXPLORATION_AREAS: taxonomy.EXPLORATION_AREAS,
  SUBJECT_KEYWORDS:  taxonomy.SUBJECT_KEYWORDS,
  dimensionsForSubject: taxonomy.dimensionsForSubject,
};
