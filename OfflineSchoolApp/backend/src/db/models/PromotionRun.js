// backend/src/db/models/PromotionRun.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One end-of-year rollover, from draft to committed.
 *
 * The same shape as a payroll run, for the same reason: this touches every
 * student in the school at once, so it is generated as a proposal, reviewed,
 * and only then applied. Nothing about a student changes until it is committed.
 */
const promotionRunSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId: { type: String, required: true, index: true },

    /** "2025/2026" — the year ending. */
    fromYear: { type: String, required: true },
    /** "2026/2027" — the year beginning. */
    toYear:   { type: String, required: true },

    status: {
      type:    String,
      enum:    ["draft", "committed", "reversed"],
      default: "draft",
      index:   true,
    },

    // Counts are a summary of the decisions, refreshed whenever they change.
    // Every figure remains derivable from PromotionDecision — these exist so a
    // list of runs does not need an aggregate per row.
    counts: {
      total:      { type: Number, default: 0 },
      promoted:   { type: Number, default: 0 },
      repeated:   { type: Number, default: 0 },
      graduated:  { type: Number, default: 0 },
      unassigned: { type: Number, default: 0 },
    },

    generatedBy: { type: String, default: null },
    generatedAt: { type: Date,   default: () => new Date() },
    committedBy: { type: String, default: null },
    committedAt: { type: Date,   default: null },
    reversedBy:  { type: String, default: null },
    reversedAt:  { type: Date,   default: null },
    reversalReason: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true }
);

// One live rollover per year pair. A reversed run leaves the pair free to be
// generated again; a draft or committed one blocks it, so nobody can quietly
// run the same promotion twice.
promotionRunSchema.index(
  { schoolId: 1, fromYear: 1, toYear: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["draft", "committed"] }, deletedAt: null },
  }
);

module.exports =
  mongoose.models.PromotionRun ||
  mongoose.model("PromotionRun", promotionRunSchema);
