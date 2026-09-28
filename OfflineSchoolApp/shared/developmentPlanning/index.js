// shared/developmentPlanning/index.js
"use strict";

/**
 * The Development Planning Engine — one entry point for the server, the
 * desktop, the calibration tooling and the checks.
 *
 * From guidance to a plan a pupil and a teacher can work on together:
 * a bounded objective, controlled actions, observable milestones, a review
 * schedule, the pupil's participation, a closed lifecycle, and historical
 * reconstruction. Pure: no database, no Express, no identity, no clock,
 * no network, no LLM. Nothing is a score, a probability or a prediction.
 */

const V = require("./version");
const taxonomy = require("./taxonomy");
const rules = require("./rules");
const milestones = require("./milestones");
const { buildPlan, addDays } = require("./buildPlan");
const { reconstruct, upTo } = require("./review");

module.exports = { ...V, ...taxonomy, ...rules, ...milestones, buildPlan, addDays, reconstruct, upTo };
