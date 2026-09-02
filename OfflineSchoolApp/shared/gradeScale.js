// OfflineSchoolApp/shared/gradeScale.js
"use strict";

/**
 * The grading scale, and the only copy of it.
 *
 * Used by:
 *   - backend/src/services/grading.service.js    (grades every mark entered)
 *   - backend/src/utils/gradeUtils.js            (grades a single subject)
 *   - backend/src/db/models/GradingConfig.js     (findGradeBand's fallback)
 *   - backend/src/routes/admin.routes.js         (GET/PUT /settings/grading)
 *   - desktop/src/main/api/gradeUtils.js         (the same grading, offline)
 *   - desktop/src/main/api/handlers/settings.js  (the same read, offline)
 *
 * There were four of these and they disagreed. Three carried a seven-band scale
 * with no C+ and remarks of its own — "Fairly Good", "Poor", "Very Poor" — and
 * those three are the ones that actually graded marks, so a pupil on 11.5 was
 * told "C / Average" by the report card and the school's own table said "C+ /
 * Above Average". Correcting the settings screen alone did not touch that,
 * because the settings screen was not what did the grading.
 *
 * ── Two remarks per band ──────────────────────────────────────────────────
 *
 * A report card renders in the reader's language, and until now only its LABELS
 * did — "Observation" over a column still containing "Above Average". The
 * remark is the part a parent actually reads, so each band carries both and the
 * renderer picks by language. A school that rewrites its remarks writes both.
 *
 * ── The bounds ────────────────────────────────────────────────────────────
 *
 * minMark inclusive, maxMark the top of the band, ordered highest first. A mark
 * that lands exactly on a boundary belongs to the HIGHER band — 18 is A+, 16 is
 * A — which is what the school's table means by "18 to 20" and "16 to 18", and
 * what first-match-wins over this order produces.
 */

const DEFAULT_GRADES = [
  { grade: "A+", minMark: 18, maxMark: 20, gpaPoints: 4.0,
    remark: "Excellent",     remarkFr: "Excellent"        },
  { grade: "A",  minMark: 16, maxMark: 18, gpaPoints: 3.7,
    remark: "Very Good",     remarkFr: "Très bien"   },
  { grade: "B+", minMark: 14, maxMark: 16, gpaPoints: 3.3,
    remark: "Good",          remarkFr: "Bien"             },
  { grade: "B",  minMark: 12, maxMark: 14, gpaPoints: 3.0,
    remark: "Fair",          remarkFr: "Assez bien"       },
  { grade: "C+", minMark: 11, maxMark: 12, gpaPoints: 2.5,
    remark: "Above Average", remarkFr: "Au-dessus de la moyenne" },
  { grade: "C",  minMark: 10, maxMark: 11, gpaPoints: 2.0,
    remark: "Average",       remarkFr: "Moyen"            },
  { grade: "D",  minMark:  8, maxMark: 10, gpaPoints: 1.0,
    remark: "Below Average", remarkFr: "Insuffisant"      },
  { grade: "F",  minMark:  0, maxMark:  8, gpaPoints: 0.0,
    remark: "Fail",          remarkFr: "Échec"       },
];

/** 10/20 — the pass mark that goes with the scale above. */
const DEFAULT_PASS_MARK = 10;

/**
 * The same bands in the { min, max, grade, points } shape the graders use.
 *
 * Two shapes for one table is not ideal, but it is better than two tables: the
 * grading services were written against these names and the stored
 * GradingConfig against the others, and deriving one from the other is what
 * stops them drifting again.
 */
const GRADE_SCALE = DEFAULT_GRADES.map((b) => ({
  min:      b.minMark,
  max:      b.maxMark,
  grade:    b.grade,
  points:   b.gpaPoints,
  remark:   b.remark,
  remarkFr: b.remarkFr,
}));

/**
 * The band a /20 mark falls in.
 *
 * @param {number|null} markOn20
 * @param {Array} [bands]  a school's own bands, in either shape; falls back to
 *                         DEFAULT_GRADES when empty or missing
 */
const findBand = (markOn20, bands) => {
  if (markOn20 == null || !Number.isFinite(Number(markOn20))) return null;
  // Deliberately NOT clamped to 0–20. The shipped table is /20, but a school
  // may configure its own bands on any scale — a /100 one is the obvious case —
  // and clamping would push every mark above 20 out of every band it owns.
  // The /20 callers clamp before they get here, where clamping is correct.
  const m = Number(markOn20);
  const scale = Array.isArray(bands) && bands.length > 0 ? bands : DEFAULT_GRADES;

  for (const b of scale) {
    const min = Number(b.minMark ?? b.min);
    const max = Number(b.maxMark ?? b.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    // Inclusive both ends, highest band first — see the note on the bounds.
    if (m >= min && m <= max) return b;
  }
  return null;
};

/**
 * A band's remark in the reader's language.
 *
 * Falls back to the English one, which is what a school that has written its
 * own remarks in one language only will have.
 */
const bandRemark = (band, lang) => {
  if (!band) return null;
  if (lang === "fr") return band.remarkFr || band.remark || null;
  return band.remark || null;
};

/** The whole grading config a school has before it saves one of its own. */
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
  GRADE_SCALE,
  findBand,
  bandRemark,
  defaultGradingConfig,
};
