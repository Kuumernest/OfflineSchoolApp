// backend/scripts/backfill-subject-coefficients.js
"use strict";

/**
 * Apply each subject's school-wide coefficient to exams that were set up
 * before the field existed.
 *
 * Subject.coefficient is a plain multiplier (1 = normal, 2 = counts double).
 * ExamSubject.weight is the percentage-style value the grading pipeline
 * actually divides by 100, so the mapping is weight = coefficient * 100.
 * Attaching a subject to an exam now seeds that automatically; rows created
 * before it keep whatever weight they were given.
 *
 * Only rows still sitting on the schema default (weight === 100) are touched.
 * A weight an admin deliberately set for one exam is a per-exam override and
 * must survive this, so anything else is left alone and reported as skipped.
 *
 * An exam whose results are published, locked or archived is never touched,
 * whatever its weights: those cards have gone home, and a coefficient
 * rescales every average on them (isFinalised, subjectCoefficient.service).
 *
 * Changing a weight makes any already-computed average for that exam stale —
 * positions are ranked on it. This script does NOT reprocess: that would
 * silently republish results while nobody is watching. It prints the affected
 * exam ids so they can be reprocessed deliberately via
 * POST /api/exams/:examId/process.
 *
 * A dry run unless told otherwise — writing is the flag, not the default:
 *   node scripts/backfill-subject-coefficients.js            # report only
 *   node scripts/backfill-subject-coefficients.js --apply    # write
 * (--dry-run is still accepted, and still wins over --apply.)
 */

require("dotenv").config();

const mongoose        = require("mongoose");
const connectDatabase = require("../src/config/database");
const Exam            = require("../src/db/models/Exam");
const ExamSubject     = require("../src/db/models/ExamSubject");
const Subject         = require("../src/db/models/Subject");
const { isFinalised } = require("../src/services/subjectCoefficient.service");

const DRY_RUN = process.argv.includes("--dry-run") || !process.argv.includes("--apply");
const DEFAULT_WEIGHT = 100;

const main = async () => {
  await connectDatabase();

  console.log(DRY_RUN ? "\nDRY RUN — nothing will be written\n" : "\nApplying changes\n");

  const examSubjects = await ExamSubject.find({ deletedAt: null })
    .select("_id examId subjectId subjectName weight")
    .lean();

  if (!examSubjects.length) {
    console.log("No exam subjects found. Nothing to do.");
    return;
  }

  // One read of every referenced subject rather than a findById per row.
  const subjectIds = [...new Set(examSubjects.map((es) => String(es.subjectId)))];
  const subjects   = await Subject.find({ _id: { $in: subjectIds } })
    .select("_id name coefficient")
    .lean();

  const coeffById = new Map(
    subjects.map((s) => [
      String(s._id),
      Number(s.coefficient) > 0 ? Number(s.coefficient) : 1,
    ])
  );

  const exams = await Exam.find({
    _id: { $in: [...new Set(examSubjects.map((es) => String(es.examId)))] },
  }).select("_id status resultsPublished resultsLockedAt").lean();
  const finalised = new Set(exams.filter(isFinalised).map((e) => String(e._id)));

  const updates      = [];
  let   skippedFinal = 0;
  const staleExams   = new Set();
  let   skippedSet   = 0;
  let   alreadyRight = 0;
  let   noSubject    = 0;

  for (const es of examSubjects) {
    const coeff = coeffById.get(String(es.subjectId));

    if (coeff === undefined) { noSubject++; continue; }
    if (finalised.has(String(es.examId))) { skippedFinal++; continue; }

    const target = Math.round(coeff * 100);

    if (es.weight !== DEFAULT_WEIGHT) {
      // A deliberate per-exam override, or already backfilled.
      if (es.weight === target) alreadyRight++;
      else                      skippedSet++;
      continue;
    }

    if (target === DEFAULT_WEIGHT) { alreadyRight++; continue; }

    updates.push({
      updateOne: {
        filter: { _id: es._id },
        update: { $set: { weight: target } },
      },
    });
    staleExams.add(String(es.examId));

    console.log(
      `  ${(es.subjectName || es.subjectId).padEnd(24)} ` +
      `weight ${String(es.weight).padStart(4)} -> ${String(target).padStart(4)} ` +
      `(coefficient ${coeff})`
    );
  }

  console.log("\n─────────────────────────────────────────────");
  console.log(`  exam subjects scanned : ${examSubjects.length}`);
  console.log(`  to update             : ${updates.length}`);
  console.log(`  already correct       : ${alreadyRight}`);
  console.log(`  left alone (override) : ${skippedSet}`);
  console.log(`  left alone (published): ${skippedFinal}`);
  console.log(`  subject missing       : ${noSubject}`);
  console.log("─────────────────────────────────────────────");

  if (!updates.length) {
    console.log("\nNothing to change.");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDry run — re-run with --apply to write.");
    return;
  }

  const result = await ExamSubject.bulkWrite(updates);
  console.log(`\nUpdated ${result.modifiedCount} exam subject(s).`);

  console.log(
    `\nAverages for ${staleExams.size} exam(s) are now stale and must be ` +
    `reprocessed deliberately:\n`
  );
  for (const id of staleExams) console.log(`  POST /api/exams/${id}/process`);
};

main()
  .catch((err) => {
    console.error("\nBackfill failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
