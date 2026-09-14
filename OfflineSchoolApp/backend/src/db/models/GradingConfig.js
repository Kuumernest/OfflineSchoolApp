// backend/src/db/models/GradingConfig.js
"use strict";

const mongoose = require("mongoose");

/** gradingType's enum. Exported so routes can recognise legacy values without a copy. */
const GRADING_TYPES = ["percentage", "gpa", "points"];

// The CA rules — defaults, validation and the blending itself — live in
// shared/ because the desktop mirror, both settings screens and the grading
// engine all have to agree about them, and four copies of a percentage split
// is how the report card and the settings page come to disagree.
const CA = require("../../../../shared/caAssessment");

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

    // ── Continuous assessment ─────────────────────────────
    // Whether a sequence is marked twice — CA through the weeks, then the
    // sequence paper — or by the paper alone. ON by default: a school that
    // does not use CA turns it off, because the opposite default leaves the
    // schools that DO use it printing half a report card until somebody
    // notices.
    //
    // Turning it off hides CA and stops requiring it. It deletes nothing: the
    // CA exams, their subjects and every mark a teacher entered stay exactly
    // where they are, and turning it back on restores the card they had.
    caEnabled: { type: Boolean, default: CA.DEFAULT_CA_ENABLED },

    // The split, as percentages of the sequence. Validated as a PAIR below —
    // individually these are just two non-negative numbers, and the rule that
    // matters (they add to 100) cannot be expressed on either one alone.
    caWeight:   { type: Number, default: CA.DEFAULT_CA_WEIGHT,   min: 0 },
    testWeight: { type: Number, default: CA.DEFAULT_TEST_WEIGHT, min: 0 },

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

/*
 * CA weight + Test weight = 100, enforced at the schema so that every write
 * path is covered — the settings route, the sync replay of a queued offline
 * save, and a script. A validator on caWeight alone cannot see testWeight, so
 * this is a document-level pre-validate rather than two field validators.
 *
 * Only when CA is enabled. With CA off the stored split is dormant, and a
 * school that turns it off must find its own percentages intact when it turns
 * it back on rather than having them reset by a validator it never saw.
 */
gradingConfigSchema.pre("validate", function caWeightsAddUp() {
  const verdict = CA.validateCaWeights({
    caEnabled:  this.caEnabled,
    caWeight:   this.caWeight,
    testWeight: this.testWeight,
  });
  if (!verdict.ok) {
    this.invalidate("caWeight", verdict.error, this.caWeight);
    this.invalidate("testWeight", verdict.error, this.testWeight);
  }
});

const GradingConfig = mongoose.model("GradingConfig", gradingConfigSchema);
GradingConfig.CA = CA;
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
