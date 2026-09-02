// backend/src/db/models/GradingConfig.js
"use strict";

const mongoose = require("mongoose");

/** gradingType's enum. Exported so routes can recognise legacy values without a copy. */
const GRADING_TYPES = ["percentage", "gpa", "points"];

const gradeBandSchema = new mongoose.Schema(
  {
    grade:     { type: String, required: true },
    minMark:   { type: Number, required: true },
    maxMark:   { type: Number, required: true },
    gpaPoints: { type: Number, default: 0     },
    remark:    { type: String, default: ""    },
    // The same remark in French. A report card renders in the reader's
    // language and the remark is the part a parent actually reads, so it
    // cannot be the one field that stays English. Empty falls back to
    // `remark`, which is what a school writing in one language will have.
    remarkFr:  { type: String, default: ""    },
  },
  { _id: false }
);

const gradingConfigSchema = new mongoose.Schema(
  {
    schoolId:    { type: String, required: true, unique: true, index: true },
    grades:      { type: [gradeBandSchema], default: []         },
    passMark:    { type: Number,  default: 10   }, // /20 Cameroon scale

    // ── Optional grade display ────────────────────────────
    // Master toggle for whether GRADES appear anywhere marks do — report
    // cards, results tables, remarks derived from bands. When false the
    // grade column is omitted from printed report cards entirely; marks,
    // averages and pass/fail still show. The grading SCALE itself stays
    // configurable in `grades` (empty → DEFAULT_GRADE_SCALE below).
    showGrades:  { type: Boolean, default: true },
    useGpa:      { type: Boolean, default: false },
    gpaScale:    { type: Number,  default: 4.0   },
    gradingType: {
      type:    String,
      enum:    GRADING_TYPES,
      default: "points",
    },

    // ── Sequence / Term weighting ─────────────────────────
    // Equal weighting: each sequence in a term = 50 %
    sequenceWeightingMethod: {
      type:    String,
      enum:    ["equal", "custom"],
      default: "equal",
    },
    sequenceWeights: {
      // Only used when sequenceWeightingMethod = "custom"
      // [{ sequence: 1, weight: 50 }, { sequence: 2, weight: 50 }]
      type:    [{ sequence: Number, weight: Number }],
      default: [],
    },

    // Equal weighting: each term = 33.33 %
    termWeightingMethod: {
      type:    String,
      enum:    ["equal", "custom"],
      default: "equal",
    },
    termWeights: {
      // Only used when termWeightingMethod = "custom"
      // [{ term: 1, weight: 33.33 }, { term: 2, weight: 33.33 }, { term: 3, weight: 33.34 }]
      type:    [{ term: Number, weight: Number }],
      default: [],
    },

    updatedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

const GradingConfig = mongoose.model("GradingConfig", gradingConfigSchema);
GradingConfig.GRADING_TYPES = GRADING_TYPES;

/**
 * The built-in /20 Cameroon grading scale, used verbatim when a school has not
 * configured its own `grades` bands. Deliberately NOT hard-coded at the usage
 * sites: a school's own bands always win over this.
 *
 * From shared/, which is also what the settings screen offers. It was a second
 * copy here and the two had diverged — this one carried the eight bands the
 * school specified while the settings screen served seven, so whether a pupil
 * scoring 11.5 got "C+ / Above Average" depended on whether an administrator
 * had ever opened that screen.
 */
const { DEFAULT_GRADES: DEFAULT_GRADE_SCALE, findBand, bandRemark } =
  require("../../../../shared/gradeScale");

/**
 * Look up the band a /20 mark falls in.
 *
 * @param {number|null} markOn20  the normalized mark out of 20
 * @param {Array} [bands]         the school's configured bands; falls back
 *                                to DEFAULT_GRADE_SCALE when empty/missing
 * @returns {{grade, remark, minMark, maxMark}|null}
 */
const findGradeBand = (markOn20, bands) => findBand(markOn20, bands);

GradingConfig.DEFAULT_GRADE_SCALE = DEFAULT_GRADE_SCALE;
GradingConfig.findGradeBand = findGradeBand;
GradingConfig.bandRemark    = bandRemark;

module.exports = GradingConfig;
