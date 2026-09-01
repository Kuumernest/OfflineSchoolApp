// backend/scripts/clean-unpublished-results.js
"use strict";

/**
 * Removes unpublished ResultSummary and StudentScore records for a school.
 * These are orphaned from deleted exams and cause false "pending" alerts.
 *
 * Usage: node scripts/clean-unpublished-results.js [SCHOOL_ID]
 */

require("dotenv").config();
const mongoose = require("mongoose");

const ResultSummary = require("../src/db/models/ResultSummary");
const StudentScore  = require("../src/db/models/StudentScore");

const SCHOOL_ID = process.argv[2] || "6a4ccbfac10ad6faa189bd85";

async function clean() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("Set MONGODB_URI in .env"); process.exit(1); }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB.");

  try {
    const rs = await ResultSummary.deleteMany({ schoolId: SCHOOL_ID, isPublished: false });
    console.log(`Deleted ${rs.deletedCount} unpublished ResultSummary records.`);

    const ss = await StudentScore.deleteMany({ schoolId: SCHOOL_ID, score: null, isAbsent: false, isExempt: false });
    console.log(`Deleted ${ss.deletedCount} empty StudentScore records (score=null, not absent/exempt).`);
  } finally {
    await mongoose.disconnect();
    console.log("Done.");
  }
}

clean().catch((err) => { console.error(err); process.exit(1); });
