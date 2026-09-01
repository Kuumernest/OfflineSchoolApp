// backend/scripts/seed-academic-structure.js
"use strict";

/**
 * Seeds the AcademicStructure for 2026/2027 with the Cameroon Anglophone
 * 3-term / 6-sequence layout.
 *
 * Safe to run multiple times — updates if a structure already exists.
 *
 * Usage:
 *   node scripts/seed-academic-structure.js [SCHOOL_ID] [YEAR]
 *
 * Defaults:
 *   SCHOOL_ID = 6a4ccbfac10ad6faa189bd85
 *   YEAR      = 2026/2027
 */

require("dotenv").config();
const mongoose = require("mongoose");

const AcademicStructure = require("../src/db/models/AcademicStructure");

const SCHOOL_ID = process.argv[2] || "6a4ccbfac10ad6faa189bd85";
const YEAR      = process.argv[3] || "2026/2027";

const STRUCTURE = {
  schoolId:     SCHOOL_ID,
  academicYear: YEAR,

  terms: [
    {
      number: 1,
      name:   "1st Term",
      weight: 33.33,
      sequences: [
        { number: 1, name: "Sequence 1", weight: 50, assessment: { type: "test", label: "Test 1" } },
        { number: 2, name: "Sequence 2", weight: 50, assessment: { type: "test", label: "Test 2" } },
      ],
    },
    {
      number: 2,
      name:   "2nd Term",
      weight: 33.33,
      sequences: [
        { number: 3, name: "Sequence 3", weight: 50, assessment: { type: "test", label: "Test 3" } },
        { number: 4, name: "Sequence 4", weight: 50, assessment: { type: "test", label: "Test 4" } },
      ],
    },
    {
      number: 3,
      name:   "3rd Term",
      weight: 33.34,
      sequences: [
        { number: 5, name: "Sequence 5", weight: 50, assessment: { type: "promotion_exam", label: "Promotion Exam" } },
        { number: 6, name: "Sequence 6", weight: 50, assessment: { type: "promotion_exam", label: "Promotion Exam" } },
      ],
    },
  ],

  annualAverageMethod: "terms",
  promotionExams:      [5, 6],    // sequences 5 & 6 are promotion exams
  promotionThreshold:  10,        // /20
  passMark:            10,        // /20
  maxAbsences:         null,      // no limit
};

async function seed() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI or MONGO_URI in your .env file.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB.");

  try {
    const existing = await AcademicStructure.findOne({
      schoolId:     SCHOOL_ID,
      academicYear: YEAR,
      deletedAt:    null,
    });

    if (existing) {
      console.log(`\nAcademicStructure for ${YEAR} already exists (${existing._id}). Updating...`);

      existing.terms                 = STRUCTURE.terms;
      existing.annualAverageMethod   = STRUCTURE.annualAverageMethod;
      existing.promotionExams        = STRUCTURE.promotionExams;
      existing.promotionThreshold    = STRUCTURE.promotionThreshold;
      existing.passMark              = STRUCTURE.passMark;
      existing.maxAbsences           = STRUCTURE.maxAbsences;
      existing.updatedAt             = new Date();

      await existing.save();
      console.log("Updated.");
    } else {
      console.log(`\nCreating AcademicStructure for ${YEAR}...`);
      const doc = await AcademicStructure.create(STRUCTURE);
      console.log(`Created: ${doc._id}`);
    }

    console.log("\nStructure:");
    console.log(JSON.stringify(STRUCTURE, null, 2));
  } finally {
    await mongoose.disconnect();
    console.log("\nDone.");
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
