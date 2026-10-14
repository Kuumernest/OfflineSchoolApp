// shared/guidance/index.js
"use strict";

/**
 * The Development Guidance Engine — one entry point for the server, the
 * desktop, the calibration tooling and the checks.
 *
 * Reads the development history (shared/development) and produces bounded,
 * categorical, evidence-linked guidance. It informs; the pupil decides.
 * No score, no probability, no ranking, no career, no personality, no LLM.
 */

const V = require("./version");
const taxonomy = require("./taxonomy");
const rules = require("./rules");
const { buildGuidance, itemsFor } = require("./buildGuidance");

module.exports = { ...V, ...taxonomy, ...rules, buildGuidance, itemsFor };
