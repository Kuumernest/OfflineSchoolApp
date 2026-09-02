// OfflineSchoolApp/shared/gradeScale.js
"use strict";

/**
 * The grading scale a school gets before it configures its own.
 *
 * Used by:
 *   - backend/src/db/models/GradingConfig.js       (findGradeBand's fallback)
 *   - backend/src/routes/admin.routes.js           (GET/PUT /settings/grading)
 *   - desktop/src/main/api/handlers/settings.js    (the same read, offline)
 *
 * This lived as three copies and they disagreed in ways that reached paper. Two
 * of them drifted apart on the scale itself — the backend moved to Cameroon's
 * /20 while the desktop mirror stayed on a /100 one, so the same mark printed
 * as a different letter depending on which machine printed it. The third, the
 * report card's own fallback, was right all along and nothing pointed at it.
 *
 * The bands below are the school's specified table. A school that never opens
 * the grading screen and a school that opens it and saves now get the same
 * eight bands, because there is only one table left to get.
 *
 * minMark is inclusive and maxMark exclusive, so the bands tile [0, 20) with no
 * gap and no overlap; 20 itself is caught by the top band explicitly, because
 * a perfect mark must not fall through to the F fallback.
 */

const DEFAULT_GRADES = [
  { grade: "A+", minMark: 18, maxMark: 20, gpaPoints: 4.0, remark: "Excellent"     },
  { grade: "A",  minMark: 16, maxMark: 18, gpaPoints: 3.7, remark: "Very Good"     },
  { grade: "B+", minMark: 14, maxMark: 16, gpaPoints: 3.3, remark: "Good"          },
  { grade: "B",  minMark: 12, maxMark: 14, gpaPoints: 3.0, remark: "Fair"          },
  { grade: "C+", minMark: 11, maxMark: 12, gpaPoints: 2.5, remark: "Above Average" },
  { grade: "C",  minMark: 10, maxMark: 11, gpaPoints: 2.0, remark: "Average"       },
  { grade: "D",  minMark:  8, maxMark: 10, gpaPoints: 1.0, remark: "Below Average" },
  { grade: "F",  minMark:  0, maxMark:  8, gpaPoints: 0.0, remark: "Fail"          },
];

/** 10/20 — the pass mark that goes with the scale above. */
const DEFAULT_PASS_MARK = 10;

/**
 * The whole grading config a school has before it saves one of its own.
 *
 * showGrades is part of it: the settings screen reads this shape and writes it
 * back, so a key missing here is a toggle the screen silently drops on save.
 */
const defaultGradingConfig = (schoolId) => ({
  schoolId,
  grades:      DEFAULT_GRADES,
  passMark:    DEFAULT_PASS_MARK,
  showGrades:  true,
  useGpa:      false,
  gpaScale:    4.0,
  gradingType: "percentage",
});

module.exports = {
  DEFAULT_GRADES,
  DEFAULT_PASS_MARK,
  defaultGradingConfig,
};
