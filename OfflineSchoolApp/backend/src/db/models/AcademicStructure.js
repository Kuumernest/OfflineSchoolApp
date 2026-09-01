// backend/src/db/models/AcademicStructure.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * AcademicStructure — one per school per academic year.
 *
 * Defines the 3-term / 6-sequence layout, weights, and promotion rules.
 * This is the single source of truth for the academic calendar.
 */

const assessmentSchema = new mongoose.Schema(
  {
    type: {
      type:    String,
      enum:    ["test", "practical", "promotion_exam"],
      default: "test",
    },
    label: { type: String, default: null }, // e.g. "Test 1", "Mid-Term"
  },
  { _id: false }
);

const sequenceSchema = new mongoose.Schema(
  {
    number:     { type: Number, required: true, min: 1, max: 6 },
    name:       { type: String, required: true },
    weight:     { type: Number, default: 50 }, // % within the term (equal = 50/50)
    assessment: { type: assessmentSchema, default: () => ({}) },
  },
  { _id: false }
);

const termSchema = new mongoose.Schema(
  {
    number:     { type: Number, required: true, min: 1, max: 3 },
    name:       { type: String, required: true },
    weight:     { type: Number, default: 33.33 }, // % in annual average
    sequences:  { type: [sequenceSchema], default: [] },
  },
  { _id: false }
);

const academicStructureSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:     { type: String, required: true, index: true },
    academicYear: { type: String, required: true }, // "2026/2027"

    terms: {
      type:    [termSchema],
      default: () => [
        {
          number: 1, name: "1st Term", weight: 33.33,
          sequences: [
            { number: 1, name: "Sequence 1", weight: 50, assessment: { type: "test", label: "Test 1" } },
            { number: 2, name: "Sequence 2", weight: 50, assessment: { type: "test", label: "Test 2" } },
          ],
        },
        {
          number: 2, name: "2nd Term", weight: 33.33,
          sequences: [
            { number: 3, name: "Sequence 3", weight: 50, assessment: { type: "test", label: "Test 3" } },
            { number: 4, name: "Sequence 4", weight: 50, assessment: { type: "test", label: "Test 4" } },
          ],
        },
        {
          number: 3, name: "3rd Term", weight: 33.34,
          sequences: [
            { number: 5, name: "Sequence 5", weight: 50, assessment: { type: "test", label: "Test 5" } },
            { number: 6, name: "Sequence 6", weight: 50, assessment: { type: "test", label: "Test 6" } },
          ],
        },
      ],
    },

    // How to compute the annual average
    annualAverageMethod: {
      type:    String,
      enum:    ["terms", "sequences"],
      default: "terms",
    },

    // Which sequence numbers are promotion exams
    promotionExams: { type: [Number], default: [] },

    // Minimum /20 average to pass promotion
    promotionThreshold: { type: Number, default: 10 },

    // Pass/fail rules
    passMark:     { type: Number, default: 10 },   // /20
    maxAbsences:  { type: Number, default: null },   // null = no limit

    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  {
    _id:       false,
    timestamps: true,
    toJSON:    { virtuals: true },
    toObject:  { virtuals: true },
  }
);

academicStructureSchema.index({ schoolId: 1, academicYear: 1 }, { unique: true });
academicStructureSchema.index({ schoolId: 1, deletedAt: 1 });

module.exports = mongoose.model("AcademicStructure", academicStructureSchema);
