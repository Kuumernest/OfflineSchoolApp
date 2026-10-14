// shared/advancedIntelligence/exploration/index.js
"use strict";

/**
 * Evidence-grounded exploration: broad domains a pupil may investigate,
 * read from the deterministic evidence, never ranked, never a career.
 */

const domains = require("./domains");
const candidates = require("./candidates");

module.exports = { ...domains, ...candidates };
