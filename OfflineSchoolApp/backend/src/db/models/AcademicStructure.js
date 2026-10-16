// backend/src/db/models/AcademicStructure.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// The same list Exam.type carries. Built from the shared constant rather
// than required from the Exam model, which would tie two schemas together
// at load time for the sake of one array.
const { CA_TYPE } = require("../../../../shared/caAssessment");
const ASSESSMENT_TYPES = ["test", "practical", "promotion_exam", CA_TYPE];

/**
 * AcademicStructure — one per school per academic year.
 *
 * Defines the 3-term / 6-sequence layout, weights, and promotion rules.
 * This is the single source of truth for the academic calendar.
 */

const assessmentSchema = new mongoose.Schema(
  {
    // The same enum Exam.type carries, from the same place — "ca" included, so
    // a school can describe a sequence that is assessed continuously.
    type: {
      type:    String,
      enum:    ASSESSMENT_TYPES,
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

/**
 * The three terms of two sequences a new year starts with, named in the
 * school's language (decided 2026-10-16, docs/41 §7). Only at creation: a
 * stored structure keeps the names it has.
 */
const DEFAULT_NAMES = {
  en: { term: ["1st Term", "2nd Term", "3rd Term"], sequence: (n) => `Sequence ${n}`, assessment: (n) => `Test ${n}` },
  fr: { term: ["1er trimestre", "2e trimestre", "3e trimestre"], sequence: (n) => `Séquence ${n}`, assessment: (n) => `Évaluation ${n}` },
};
const defaultTermsFor = (lang = "en") => {
  const n = DEFAULT_NAMES[lang] ?? DEFAULT_NAMES.en;
  return [1, 2, 3].map((t) => ({
    number: t, name: n.term[t - 1], weight: t === 3 ? 33.34 : 33.33,
    sequences: [2 * t - 1, 2 * t].map((q) => ({
      number: q, name: n.sequence(q), weight: 50, assessment: { type: "test", label: n.assessment(q) },
    })),
  }));
};

const academicStructureSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:     { type: String, required: true, index: true },
    academicYear: { type: String, required: true }, // "2026/2027"

    terms: {
      type:    [termSchema],
      // English here; a structure created for a French school is seeded
      // with defaultTermsFor("fr") instead (academicStructure.routes).
      default: () => defaultTermsFor("en"),
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

    // The school's promotion bars for this year, out of 20 (shared/
    // academicRules.js): promotionThreshold, the school's bar, and
    // classThresholds, one per class. The calculation itself is the same for
    // every school and is not stored here (docs/39 §21.1). No default: absent
    // means no bar set, so the pass mark applies. Written only through
    // PUT /academic-structure/:schoolId/:year/rules, which validates and
    // audits.
    rules: { type: mongoose.Schema.Types.Mixed, default: undefined },

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

academicStructureSchema.statics.defaultTermsFor = defaultTermsFor;

module.exports = mongoose.model("AcademicStructure", academicStructureSchema);
