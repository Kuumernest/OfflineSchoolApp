// backend/src/services/intelligence/interventionOutcome.service.js
"use strict";

/**
 * Loading the history behind a before/after comparison. The comparison is shared/.
 *
 * The date rule, the split, the four "cannot compare" states and the flat
 * observation codes all live in shared/intelligence/interventionOutcome.js. A
 * second copy of the date rule alone would be enough to put an occasion on the
 * wrong side of an action — a sequence sat before it but published after it is
 * PRIOR evidence, and getting that backwards credits the action with a mark
 * that predates it.
 *
 * What stays here: fetching the pupil's published history, which needs a
 * database and a school the caller is entitled to ask about.
 *
 * The comparison remains an OBSERVATION and never a verdict; see the shared
 * module's header for why that distinction is load-bearing.
 */

const academicHistory = require("./academicHistory.service");
const engine          = require("../../../../shared/intelligence/interventionOutcome");

/**
 * Before and after, for one intervention.
 *
 * @param   {object} intervention  a lean Intervention document
 * @returns {Promise<object>} never null; says why when it cannot compare
 */
const compare = async (intervention) => {
  const schoolId  = String(intervention.schoolId);
  const studentId = String(intervention.studentId);

  // Loaded even when the intervention names no subject: the engine answers
  // not_subject_specific without touching the history, and branching here to
  // avoid one query would put a rule in two places to save nothing.
  const history = await academicHistory.publishedHistory({
    schoolId, studentIds: [studentId], withSubjects: true,
  });

  return engine.compareOutcome({
    intervention,
    history: history.get(studentId) ?? [],
  });
};

module.exports = {
  compare,
  // Re-exported from shared for the check scripts and any caller that already
  // holds the history.
  compareOutcome: engine.compareOutcome,
  occasionTime:   engine.occasionTime,
  pivotOf:        engine.pivotOf,
  readingOf:      engine.readingOf,
};
