// desktop/src/main/api/timetableConflicts.js
"use strict";

const TT = require("../../../../shared/timetableConflicts");

/**
 * The detector's context from the mirror — the rows the server's
 * services/timetableConflicts.service.js loads from Mongo, so the conflicts
 * screen and the pre-save check answer the same offline as online.
 */
const conflictContext = (docs, schoolId) => {
  const live = (r) => !r.deletedAt;
  return TT.buildContext({
    slots:       docs.find("timetableSlot", { schoolId, deletedAt: null }),
    periods:     docs.find("period", { schoolId }).filter((p) => live(p) && p.isActive !== false),
    classes:     docs.find("class", { schoolId }),
    subjects:    docs.find("subject", { schoolId }),
    teachers:    docs.find("user", { schoolId }),
    assignments: docs.find("teacherAssignment", { schoolId }),
  });
};

module.exports = { conflictContext };
