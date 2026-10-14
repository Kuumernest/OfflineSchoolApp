// shared/exploration/index.js
"use strict";

/**
 * The Guided Exploration layer — one entry point for the server, the mobile
 * app, the desktop and the checks.
 *
 * Consumes the strengths profile; produces suggestions with reasons, and
 * turns what happened in an exploration into evidence rows, kind by kind.
 * Versioned on its own (EXPLORATION_ENGINE_VERSION); the academic and
 * strengths engines do not move for a change here.
 *
 * Exploration is evidence generation. It is not career prediction.
 */

const catalog   = require("./catalog");
const recommend = require("./recommend");
const evidence  = require("./evidence");

const STATES = Object.freeze([
  "DISCOVERED", "SAVED", "STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED", "ABANDONED", "SKIPPED", "NOT_INTERESTED",
]);

/** The moves a pupil (and, for review, a teacher) may make. Closed states are closed. */
const TRANSITIONS = Object.freeze({
  DISCOVERED:      ["SAVED", "STARTED", "SKIPPED", "NOT_INTERESTED"],
  SAVED:           ["STARTED", "SKIPPED", "NOT_INTERESTED"],
  STARTED:         ["SUBMITTED", "ABANDONED"],
  SUBMITTED:       ["REVIEW_REQUIRED", "COMPLETED"],
  REVIEW_REQUIRED: ["COMPLETED"],
  COMPLETED:       [],
  ABANDONED:       [],
  SKIPPED:         ["STARTED", "SAVED"],
  NOT_INTERESTED:  [],
});

module.exports = {
  ...catalog,
  ...recommend,
  ...evidence,
  STATES,
  TRANSITIONS,
  canTransition: (from, to) => (TRANSITIONS[from] ?? []).includes(to),
};
