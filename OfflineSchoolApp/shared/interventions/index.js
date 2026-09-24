// shared/interventions/index.js
"use strict";

/**
 * The Intervention Engine — one entry point for the server, the desktop, the
 * calibration tooling and the checks.
 *
 * Proposes bounded, human-owned support actions from documented triggers in
 * the development history, runs a closed lifecycle, and interprets the
 * observed outcome after the period through the existing academic
 * before/after engine and the development reading. Guidance is not an
 * intervention; a proposal is not an active intervention; an outcome is not
 * a cause.
 */

const V = require("./version");
const taxonomy = require("./taxonomy");
const rules = require("./rules");
const { buildIntervention, addDays } = require("./buildIntervention");

module.exports = { ...V, ...taxonomy, ...rules, buildIntervention, addDays };
