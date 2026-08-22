// backend/src/db/models/PromotionDecision.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What is proposed for one student in one rollover.
 *
 * `basis` records WHY the draft says what it says — passing results, failing
 * results, no results on record, or a final-year class. Without it the review
 * screen is a list of 500 identical rows and the only safe thing to do with it
 * is trust it blindly, which defeats the point of a review step.
 */
const promotionDecisionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    runId:    { type: String, required: true, index: true },
    schoolId: { type: String, required: true, index: true },

    studentId:   { type: String, required: true },
    /** Denormalised so the run still reads correctly years later. */
    studentName: { type: String, default: null },
    enrollmentNo:{ type: String, default: null },

    fromClassId:   { type: String, default: null },
    fromClassName: { type: String, default: null },
    toClassId:     { type: String, default: null },
    toClassName:   { type: String, default: null },

    outcome: {
      type:    String,
      // "unassigned" is not a decision — it is the absence of one, and it
      // blocks the commit. A class with no nextClassId lands here rather than
      // having a destination invented for it.
      enum:    ["promoted", "repeated", "graduated", "unassigned"],
      default: "unassigned",
    },

    basis: {
      type:    String,
      enum:    ["results_pass", "results_fail", "no_results", "final_year", "manual"],
      default: "no_results",
    },

    /** The year average the basis was drawn from, when there was one. */
    average: { type: Number, default: null },

    /** True once a human has changed it, so overrides survive a recount. */
    overridden: { type: Boolean, default: false },

    deletedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true }
);

// One decision per student per run — this is what makes generate idempotent.
promotionDecisionSchema.index(
  { runId: 1, studentId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

module.exports =
  mongoose.models.PromotionDecision ||
  mongoose.model("PromotionDecision", promotionDecisionSchema);
