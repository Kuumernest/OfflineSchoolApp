// OfflineSchoolApp/shared/gradeScale.js
"use strict";

/**
 * The grading scale a school gets before it configures its own.
 *
 * Used by:
 *   - backend/src/routes/admin.routes.js            (GET/PUT /settings/grading)
 *   - desktop/src/main/api/handlers/settings.js     (the same read, offline)
 *
 * This lived as two copies, one per package, with a comment in each asking for
 * exactly this file. They drifted: the backend moved to Cameroon's /20 scale
 * while the desktop mirror stayed on a /100 one, so the same pupil's mark
 * printed as a different letter depending on which machine printed it. One
 * table cannot drift from itself.
 *
 * Cameroon Anglophone /20. minMark is inclusive and maxMark is the top of the
 * band — the .99 upper bounds are deliberate, so 17.995 lands in A rather than
 * falling through every band and reaching the F fallback.
 */

const DEFAULT_GRADES = [
  { grade: "A+", minMark: 18.0, maxMark: 20.0,  gpaPoints: 4.0, remark: "Excellent"   },
  { grade: "A",  minMark: 16.0, maxMark: 17.99, gpaPoints: 3.7, remark: "Very Good"   },
  { grade: "B+", minMark: 14.0, maxMark: 15.99, gpaPoints: 3.3, remark: "Good"        },
  { grade: "B",  minMark: 12.0, maxMark: 13.99, gpaPoints: 3.0, remark: "Fairly Good" },
  { grade: "C",  minMark: 10.0, maxMark: 11.99, gpaPoints: 2.0, remark: "Average"     },
  { grade: "D",  minMark:  8.0, maxMark:  9.99, gpaPoints: 1.0, remark: "Poor"        },
  { grade: "F",  minMark:  0.0, maxMark:  7.99, gpaPoints: 0.0, remark: "Very Poor"   },
];

/** 10/20 — the pass mark that goes with the scale above. */
const DEFAULT_PASS_MARK = 10;

/** The whole grading config a school has before it saves one of its own. */
const defaultGradingConfig = (schoolId) => ({
  schoolId,
  grades:      DEFAULT_GRADES,
  passMark:    DEFAULT_PASS_MARK,
  useGpa:      false,
  gpaScale:    4.0,
  gradingType: "percentage",
});

module.exports = {
  DEFAULT_GRADES,
  DEFAULT_PASS_MARK,
  defaultGradingConfig,
};
