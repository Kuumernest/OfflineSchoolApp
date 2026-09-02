// backend/scripts/repair-result-identity.js
"use strict";

/**
 * Remove the term and annual results written under the wrong pupil identity.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * ResultSummary.studentId holds Student._id, and so does TermResult.studentId:
 * buildTermCard looks the pupil up with Student.findOne({ _id: studentId }).
 * The grading services keyed on `student.userId ?? student._id` instead, so for
 * every pupil with a linked login the summary lookup matched nothing.
 *
 * It did not fail. With no summaries the weighted average came out 0, and a
 * result was written saying the pupil had scored nothing, both sequences marked
 * incomplete. On the live school that was 68 of them.
 *
 * The services are fixed and write under Student._id now. These rows stay
 * behind: keyed on a login id, matching no pupil the card can look up, and
 * still listed on the term results screen as a pupil who scored zero.
 *
 * ── What it deletes, and what it will not ─────────────────────────────────
 *
 * ONLY a row whose studentId matches some Student.userId in the same school.
 * That is the fingerprint of this bug and nothing else writes it.
 *
 * And a row keyed correctly but computed from nothing: every sequence flagged
 * incomplete and an average of 0. That is the same fabrication reached by the
 * other path — a pupil who simply had not been marked — and it cannot be a real
 * result, because a pupil who genuinely scored 0 has a COMPLETE sequence saying
 * so. The service refuses to write these now; the ones already saved are still
 * on the screen.
 *
 * A row whose studentId matches neither a userId nor an _id is reported and
 * kept. It could be a pupil since removed, and a result for somebody who has
 * left is not obviously rubbish — that is a judgement for the school, not for
 * a repair script.
 *
 * Recompute the term after running this: these rows held no marks, so nothing
 * of value is being thrown away, but the correct rows only appear once the
 * compute is run again.
 *
 *   node scripts/repair-result-identity.js            # report only
 *   node scripts/repair-result-identity.js --apply    # delete
 *   node scripts/repair-result-identity.js --school <id>
 */

require("dotenv").config();
const mongoose = require("mongoose");
const path     = require("path");
const fs       = require("fs");

const Student      = require("../src/db/models/Student");
const TermResult   = require("../src/db/models/TermResult");
const AnnualResult = require("../src/db/models/AnnualResult");

const APPLY  = process.argv.includes("--apply");
const SCHOOL = (() => {
  const i = process.argv.indexOf("--school");
  return i > -1 ? process.argv[i + 1] : null;
})();

const main = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const filter = SCHOOL ? { schoolId: String(SCHOOL) } : {};

  const students = await Student.find(filter).select("_id userId studentName").lean();
  const byUserId = new Map(
    students.filter((s) => s.userId).map((s) => [String(s.userId), s])
  );
  const ids = new Set(students.map((s) => String(s._id)));

  console.log(
    `\n  ${students.length} pupil(s)${SCHOOL ? ` in school ${SCHOOL}` : ""}` +
    `  —  ${APPLY ? "APPLYING" : "dry run, nothing will be deleted"}\n`
  );

  const doomed = { term: [], annual: [] };
  const orphans = [];
  let intact = 0, fabricated = 0;

  /*
   * Computed from no marks at all.
   *
   * Not "the average is 0" — a pupil can score 0. The signature is that NO
   * sequence (or term, on an annual row) was complete, which is only reachable
   * when the lookup found nothing to average.
   */
  const cameFromNothing = (row) => {
    const parts = row.sequenceAverages || row.termAverages || [];
    if (!parts.length) return false;
    return parts.every((p) => p.isComplete === false);
  };

  for (const [label, Model, bucket] of [
    ["term",   TermResult,   doomed.term],
    ["annual", AnnualResult, doomed.annual],
  ]) {
    const rows = await Model.find(filter).lean();
    for (const row of rows) {
      const key = String(row.studentId);
      if (ids.has(key)) {
        if (cameFromNothing(row)) {
          fabricated += 1;
          bucket.push(row);
          console.log(`  no marks    ${label.padEnd(7)}` +
            `${String(row.studentName || "?").slice(0, 22).padEnd(24)}` +
            `every sequence incomplete   [${row._id}]`);
        } else {
          intact += 1;
        }
        continue;
      }

      const pupil = byUserId.get(key);
      if (pupil) {
        bucket.push(row);
        const avg = row.termAverage ?? row.annualAverage;
        console.log(`  wrong id    ${label.padEnd(7)}` +
          `${String(pupil.studentName || "?").slice(0, 22).padEnd(24)}` +
          `average=${avg}   [${row._id}]`);
      } else {
        orphans.push({ label, row });
        console.log(`  unknown     ${label.padEnd(7)}` +
          `studentId=${key}  KEPT (matches no pupil at all)`);
      }
    }
  }

  const total = doomed.term.length + doomed.annual.length;

  if (APPLY && total) {
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file  = path.join(dir, `result-identity-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(doomed, null, 2));
    console.log(`\n  backed up to ${path.relative(process.cwd(), file)}`);

    if (doomed.term.length) {
      await TermResult.deleteMany({ _id: { $in: doomed.term.map((r) => r._id) } });
    }
    if (doomed.annual.length) {
      await AnnualResult.deleteMany({ _id: { $in: doomed.annual.map((r) => r._id) } });
    }
    console.log(`  deleted ${total} row(s)`);
  } else if (total) {
    console.log(`\n  ${total} would be deleted — re-run with --apply`);
  }

  console.log(
    `\n  real results kept: ${intact}` +
    `   deleted: ${total}` +
    `   (of those, computed from no marks: ${fabricated})` +
    `   matching no pupil: ${orphans.length}\n`
  );

  if (total) {
    console.log("  Recompute the term afterwards — these rows held no marks,\n" +
                "  and the correct ones appear only when the compute is run again.\n");
  }

  await mongoose.disconnect();
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
