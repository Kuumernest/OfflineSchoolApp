// backend/scripts/backfill-ca-exams.js
"use strict";

/**
 * Give the sequences that already exist their continuous assessment.
 *
 * ── Why this is a script and not a migration ──────────────────────────────
 *
 * Nothing needs it. Continuous assessment is additive: the three settings have
 * defaults, the new ResultSummary fields default to null, and a sequence with
 * no CA exam beside it is graded on its paper exactly as it always was. A
 * school can upgrade, change nothing, and notice nothing.
 *
 * What this does is convenience for a school that IS adopting CA and does not
 * want to open every sequence of the year by hand. Creating a sequence now
 * creates its CA automatically; the sequences created before that did not.
 *
 * ── What it will not do ───────────────────────────────────────────────────
 *
 * Touch a mark, delete anything, or recompute a result. A CA exam created here
 * is EMPTY — no scores — and an empty CA changes no average, because a missing
 * CA renormalises onto the paper rather than being read as a zero. So running
 * this cannot move a single pupil's mark. Marks only change once a teacher
 * actually enters CA and an administrator reprocesses the sequence, which is a
 * deliberate act with its own screen.
 *
 * Exams whose results are already published or locked are skipped. Adding a
 * half-sequence to a result a parent has already read is not a backfill.
 *
 * Usage:
 *   node scripts/backfill-ca-exams.js --dry-run
 *   node scripts/backfill-ca-exams.js
 *   node scripts/backfill-ca-exams.js --school=<schoolId>
 *   node scripts/backfill-ca-exams.js --year=2026/2027
 */

require("dotenv").config();

const mongoose        = require("mongoose");
const connectDatabase = require("../src/config/database");
const Exam            = require("../src/db/models/Exam");
const sequenceAssessment = require("../src/services/sequenceAssessment.service");
const { CA_TYPE }     = require("../../shared/caAssessment");

const DRY_RUN = process.argv.includes("--dry-run");
const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** An exam whose results are out is not one to add half a sequence to. */
const isFinalised = (exam) =>
  exam.status === "published" || exam.status === "archived" ||
  exam.resultsPublished === true || exam.resultsLockedAt != null;

const main = async () => {
  await connectDatabase();

  console.log(DRY_RUN ? "\nDRY RUN — nothing will be written\n" : "\nApplying changes\n");

  const filter = {
    deletedAt:      null,
    type:           { $ne: CA_TYPE },
    sequenceNumber: { $ne: null },
  };
  const school = argOf("school");
  const year   = argOf("year");
  if (school) filter.schoolId     = school;
  if (year)   filter.academicYear = year;

  const papers = await Exam.find(filter).lean();
  if (!papers.length) {
    console.log("No sequence exams found. Nothing to do.");
    return;
  }

  // The CA setting is per school, and most runs cover one. Resolved once each
  // rather than once per exam.
  const settingsBySchool = new Map();
  const settingsFor = async (schoolId) => {
    const key = String(schoolId);
    if (!settingsBySchool.has(key)) {
      settingsBySchool.set(key, await sequenceAssessment.loadCaSettings(key));
    }
    return settingsBySchool.get(key);
  };

  let created = 0, existed = 0, finalised = 0, caOff = 0;

  for (const paper of papers) {
    const settings = await settingsFor(paper.schoolId);
    if (!settings.caEnabled) { caOff += 1; continue; }

    if (isFinalised(paper)) {
      finalised += 1;
      console.log(`  skip (results out)  ${paper.name} [${paper._id}]`);
      continue;
    }

    const already = await sequenceAssessment.findCaExam(paper);
    if (already) { existed += 1; continue; }

    if (DRY_RUN) {
      created += 1;
      console.log(`  would create CA for ${paper.name} [${paper._id}]`);
      continue;
    }

    const made = await sequenceAssessment.ensureCaExam({ paper, settings });
    if (made.created) {
      created += 1;
      console.log(
        `  created CA ${made.exam._id} for ${paper.name} ` +
        `(${made.subjects.length} subject(s))`
      );
    } else {
      existed += 1;
    }
  }

  console.log(
    `\n${created} CA exam(s) ${DRY_RUN ? "would be " : ""}created, ` +
    `${existed} already had one, ${finalised} skipped (results out), ` +
    `${caOff} skipped (school does not use CA).`
  );

  if (DRY_RUN) {
    console.log("\nDry run — re-run without --dry-run to apply.");
    return;
  }

  if (created > 0) {
    console.log(
      "\nThe new CA exams are empty, so no average has changed. Once teachers " +
      "have entered CA marks, reprocess each sequence deliberately:\n" +
      "  POST /api/exams/:examId/process\n"
    );
  }
};

main()
  .catch((err) => {
    console.error("\nBackfill failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
