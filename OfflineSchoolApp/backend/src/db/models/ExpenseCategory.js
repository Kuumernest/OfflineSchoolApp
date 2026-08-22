// backend/src/db/models/ExpenseCategory.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What an expense is FOR — utilities, maintenance, stationery, transport.
 *
 * Flat by default, with an optional parent so a school that wants
 * "Utilities → Electricity" can have it without every school being forced into
 * a hierarchy it does not use.
 */
const expenseCategorySchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },

    /** Stable machine name used by reports: "utilities", "maintenance". */
    code:  { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    /** French label, per the bilingual convention — see src/i18n. */
    labelFr: { type: String, default: null, trim: true },

    /** Null for a top-level category. */
    parentId: { type: String, default: null, index: true },

    isActive:  { type: Boolean, default: true },
    createdBy: { type: String,  default: null },
    deletedAt: { type: Date,    default: null, index: true },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// A code identifies a category within a school, so reports can group on it
// without depending on the label a user may rename.
expenseCategorySchema.index(
  { schoolId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

module.exports =
  mongoose.models.ExpenseCategory ||
  mongoose.model("ExpenseCategory", expenseCategorySchema);
