// shared/strengths/engineConstants.js
"use strict";

/** The state and confidence vocabularies, in one place so fusion.js and engine.js share them without a cycle. */
const STATES = Object.freeze({
  ESTABLISHED: "ESTABLISHED", EMERGING: "EMERGING", DECLINING: "DECLINING", INSUFFICIENT: "INSUFFICIENT",
});
const PERSISTENCE = Object.freeze({ PERSISTENT: "persistent", RECURRING: "recurring", EMERGING: "emerging", NONE: "none" });
const CONFIDENCE  = Object.freeze({ STRONG: "strong", EMERGING: "emerging", INSUFFICIENT: "insufficient" });

module.exports = { STATES, PERSISTENCE, CONFIDENCE };
