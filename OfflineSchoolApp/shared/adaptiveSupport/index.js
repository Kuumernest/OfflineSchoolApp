// shared/adaptiveSupport/index.js
"use strict";

/**
 * The Adaptive Support Engine — one entry point for the server, the desktop,
 * the calibration tooling and the checks.
 *
 * Reviews a development plan against the evidence that became available and
 * what the pupil and the teacher reported, and answers with one categorical
 * outcome and a bounded adaptation a human may take. Pure; no clock; no
 * score; no prediction; no cause. "Failed" is not in its vocabulary.
 */

const V = require("./version");
const rules = require("./rules");
const { reviewPlan } = require("./reviewPlan");
const { adaptPlan } = require("./adaptPlan");

module.exports = { ...V, ...rules, reviewPlan, adaptPlan };
