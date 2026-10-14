// backend/scripts/calibration/isolatedEngine.js
"use strict";

/**
 * A second, private copy of the shared engine, for asking "what if".
 *
 * ── The problem this solves ───────────────────────────────────────────────
 *
 * Threshold sensitivity means running the SAME rules with a different number
 * — declineDrop at 3 instead of 2 — and counting whose classification moves.
 * The obvious way is to poke shared/intelligence's THRESHOLDS object and run
 * again. That is also the way a calibration script quietly changes production
 * behaviour for every other module loaded in the same process, and the way a
 * thrown exception halfway through leaves the thresholds altered for good.
 *
 * The other obvious way is to copy the rules into the calibration script with
 * the threshold as a parameter. That is a second implementation, and Stage 6
 * existed to remove the last one.
 *
 * ── What this does instead ────────────────────────────────────────────────
 *
 * Node's module cache is what makes `require("./subjectInsights")` return the
 * one shared object everybody holds. Evicting the engine's files from that
 * cache and requiring them again yields fresh module objects with their own
 * THRESHOLDS — the identical code, a separate instance. The production entries
 * are put straight back, so anything that already holds a reference, or
 * requires the engine afterwards, gets the original. The isolated copy can then
 * be adjusted freely and thrown away.
 *
 * Same rules, different constants, no duplication, no mutation of anything
 * anybody else can see. scripts/check-calibration.js asserts all three.
 */

const path = require("path");

const SHARED = path.join(__dirname, "..", "..", "..", "shared");

/** Every file the engine is made of, plus the two shared tables it reads. */
const ENGINE_FILES = [
  path.join(SHARED, "intelligence", "index.js"),
  path.join(SHARED, "intelligence", "academicOrder.js"),
  path.join(SHARED, "intelligence", "subjectInsights.js"),
  path.join(SHARED, "intelligence", "guidance.js"),
  path.join(SHARED, "intelligence", "interventionOutcome.js"),
  path.join(SHARED, "gradeScale.js"),
  path.join(SHARED, "caAssessment.js"),
];

/**
 * Load a private instance of shared/intelligence.
 *
 * @returns {object} the same shape as require("shared/intelligence"), but a
 *          distinct object graph whose THRESHOLDS may be edited safely.
 */
const loadIsolatedEngine = () => {
  const saved = new Map();
  for (const file of ENGINE_FILES) {
    if (require.cache[file]) {
      saved.set(file, require.cache[file]);
      delete require.cache[file];
    }
  }

  let isolated;
  try {
    isolated = require(path.join(SHARED, "intelligence"));
  } finally {
    // Whatever happened, the process goes back to holding the production
    // modules. The fresh ones live on only through `isolated`.
    for (const file of ENGINE_FILES) {
      if (saved.has(file)) require.cache[file] = saved.get(file);
      else delete require.cache[file];
    }
  }
  return isolated;
};

/**
 * Run a function against an isolated engine whose THRESHOLDS carry the given
 * overrides. The production engine is never touched.
 *
 * @param {object}   overrides  e.g. { declineDrop: 3 }
 * @param {Function} fn         (engine) => result
 */
const withThresholds = (overrides, fn) => {
  const engine = loadIsolatedEngine();
  Object.assign(engine.subjectInsights.THRESHOLDS, overrides);
  return fn(engine);
};

module.exports = { loadIsolatedEngine, withThresholds, ENGINE_FILES };
