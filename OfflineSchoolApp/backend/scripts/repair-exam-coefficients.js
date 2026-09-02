// backend/scripts/repair-exam-coefficients.js
"use strict";

/**
 * Align the coefficient on already-attached exam subjects with their subject.
 *
 * ── Why these drifted ─────────────────────────────────────────────────────
 *
 * PUT /admin/subjects/:id wrote Subject.coefficient and nothing else, so every
 * ExamSubject kept the weight it was seeded with when the subject was attached.
 * The grading service and the mark-entry screen both read the weight. A head
 * would set Mathematics to 4, open the marks sheet, and find it counting as 1.
 *
 * The route cascades now. That does nothing for the exams already attached: the
 * cascade compares against the coefficient the exams were following, and these
 * rows are following a value from before the edit that never reached them. So
 * they need aligning once, deliberately, with somebody looking at the list.
 *
 * ── What it will not touch ────────────────────────────────────────────────
 *
 * An exam whose results are published, locked or archived. A coefficient
 * rescales every average in the class, and those cards have gone home.
 *
 * ── And what it cannot know ───────────────────────────────────────────────
 *
 * Whether a mismatched weight was somebody's deliberate choice for one paper.
 * PUT /exams/:examId/subjects/:id lets a head weight a single exam differently,
 * and a row set that way looks exactly like a row that never got the update.
 *
 * That is why this prints every change and writes nothing without --apply: the
 * list is for a person who knows which of their exams were deliberate. Per
 * subject with --subject, per school with --school, so a school with one
 * deliberate override can align everything else and leave that one.
 *
 *   node scripts/repair-exam-coefficients.js                 # report only
 *   node scripts/repair-exam-coefficients.js --apply         # write
 *   node scripts/repair-exam-coefficients.js --school <id>
 *   node scripts/repair-exam-coefficients.js --subject <id>
 *   node scripts/repair-exam-coefficients.js --exclude <id>,<id>
 */

require("dotenv").config();
const mongoose = require("mongoose");
const path     = require("path");
const fs       = require("fs");

const Subject      = require("../src/db/models/Subject");
const ExamSubject  = require("../src/db/models/ExamSubject");
const Exam         = require("../src/db/models/Exam");
const StudentScore = require("../src/db/models/StudentScore");
const { coefficientOf, weightFor, isFinalised } =
  require("../src/services/subjectCoefficient.service");

const APPLY = process.argv.includes("--apply");
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const SCHOOL  = argOf("--school");
const SUBJECT = argOf("--subject");
// Exam subjects to leave exactly as they are, by id. For the row a head looks
// at in the list and recognises as their own decision.
const EXCLUDE = new Set(
  String(argOf("--exclude") || "").split(",").map((x) => x.trim()).filter(Boolean)
);

const main = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const esFilter = {
    deletedAt: null,
    ...(SCHOOL  ? { schoolId:  String(SCHOOL)  } : {}),
    ...(SUBJECT ? { subjectId: String(SUBJECT) } : {}),
  };

  const rows = await ExamSubject.find(esFilter)
    .select("_id examId subjectId subjectName weight schoolId").lean();

  const subjects = new Map(
    (await Subject.find({
      ...(SCHOOL ? { schoolId: String(SCHOOL) } : {}),
    }).select("_id name coefficient").lean())
      .map((s) => [String(s._id), s])
  );

  const exams = new Map(
    (await Exam.find({
      _id: { $in: [...new Set(rows.map((r) => String(r.examId)))] },
    }).select("_id name status resultsPublished resultsLockedAt").lean())
      .map((e) => [String(e._id), e])
  );

  console.log(
    `\n  ${rows.length} exam subject(s)` +
    `${SCHOOL ? ` for school ${SCHOOL}` : ""}` +
    `${SUBJECT ? ` for subject ${SUBJECT}` : ""}` +
    `  —  ${APPLY ? "APPLYING" : "dry run, nothing will be written"}\n`
  );

  const changes = [];
  const tally = { agrees: 0, finalised: 0, orphaned: 0, change: 0,
                  unset: 0, excluded: 0 };

  for (const row of rows) {
    const subject = subjects.get(String(row.subjectId));
    const exam    = exams.get(String(row.examId));
    const label   = `${(exam?.name || row.examId).slice(0, 18).padEnd(20)}` +
                    `${(row.subjectName || subject?.name || "?").slice(0, 24).padEnd(26)}`;

    // A row whose subject is gone: nothing to align it to, and guessing would
    // be inventing a coefficient.
    if (!subject) {
      tally.orphaned += 1;
      console.log(`  orphaned    ${label}weight=${row.weight}  (no subject row)`);
      continue;
    }

    /*
     * A subject with no coefficient stored is not an instruction.
     *
     * The whole app READS an absent coefficient as 1, which is right for
     * grading — but aligning an exam DOWN to it would enforce a default nobody
     * chose over a weighting somebody did. These rows are exactly the ones
     * where the exam is likelier to be right than the subject, so they are
     * reported and left; setting the subject's coefficient, which now cascades,
     * is the way to change them.
     */
    if (!(Number(subject.coefficient) > 0)) {
      tally.unset += 1;
      console.log(`  unset       ${label}coefficient ${Number(row.weight) / 100}` +
                  `  kept (the subject has none set)`);
      continue;
    }

    const want = weightFor(coefficientOf(subject));
    if (Number(row.weight) === want) { tally.agrees += 1; continue; }

    if (EXCLUDE.has(String(row._id))) {
      tally.excluded += 1;
      console.log(`  excluded    ${label}coefficient ${Number(row.weight) / 100}` +
                  ` → ${coefficientOf(subject)}  kept by --exclude`);
      continue;
    }

    if (isFinalised(exam)) {
      tally.finalised += 1;
      console.log(`  finalised   ${label}weight=${row.weight} → ${want}  NOT CHANGED` +
                  ` (${exam?.status}${exam?.resultsPublished ? ", published" : ""})`);
      continue;
    }

    tally.change += 1;
    console.log(`  align       ${label}coefficient ` +
                `${Number(row.weight) / 100} → ${coefficientOf(subject)}` +
                `   [${row._id}]`);
    changes.push({ _id: row._id, from: row.weight, to: want,
                   examId: String(row.examId), subjectId: String(row.subjectId),
                   schoolId: row.schoolId });
  }

  // Which of them have marks already, and so need reprocessing afterwards.
  let needReprocess = [];
  if (changes.length) {
    const pairs = await StudentScore.aggregate([
      { $match: {
          examId:    { $in: [...new Set(changes.map((c) => c.examId))] },
          subjectId: { $in: [...new Set(changes.map((c) => c.subjectId))] },
          deletedAt: null,
      } },
      { $group: { _id: "$examId" } },
    ]);
    needReprocess = pairs.map((p) => String(p._id));
  }

  if (APPLY && changes.length) {
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file  = path.join(dir, `exam-coefficients-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(changes, null, 2));
    console.log(`\n  backed up to ${path.relative(process.cwd(), file)}`);

    for (const c of changes) {
      await ExamSubject.updateOne({ _id: c._id }, { $set: { weight: c.to } });
    }
    console.log(`  wrote ${changes.length} exam subject(s)`);
  } else if (changes.length) {
    console.log(`\n  ${changes.length} would be written — re-run with --apply`);
  }

  console.log(
    `\n  agrees already: ${tally.agrees}` +
    `   to align: ${tally.change}` +
    `   left finalised: ${tally.finalised}` +
    `   subject unset: ${tally.unset}` +
    (tally.excluded ? `   excluded: ${tally.excluded}` : "") +
    `   orphaned: ${tally.orphaned}`
  );

  if (needReprocess.length) {
    console.log(
      `\n  ${needReprocess.length} exam(s) already have marks, so their averages ` +
      `are now stale.\n  Reprocess each from the exam's page ` +
      `(POST /api/exams/<id>/process) when you are ready:`
    );
    for (const id of needReprocess) {
      console.log(`    ${exams.get(id)?.name || id}  [${id}]`);
    }
  }
  console.log();

  await mongoose.disconnect();
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
