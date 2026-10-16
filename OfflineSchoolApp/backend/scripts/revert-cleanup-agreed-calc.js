// backend/scripts/revert-cleanup-agreed-calc.js
"use strict";

/**
 * After a code revert of the agreed calculation: take `academicYear` and
 * `term` back off the sequence results this branch wrote (docs/40, step 1.4).
 *
 * Why: this branch writes `academicYear` and `term` on every sequence result
 * (ResultSummary) it computes. The previous code's process route never sets
 * them, so they survive a revert, even a reprocess, and the previous
 * promotion run, which selects published summaries by `academicYear`, then
 * finds results it never found before (check-revert-previous.js).
 *
 * ── Which rows: the ids recorded BEFORE the revert ─────────────────────────
 *
 * Two steps, because no filter on what a row holds after the revert is safe:
 *
 *   - The previous code can itself write a year and term on a summary:
 *     "Calculate & save" creates one with them when the pupil has none
 *     (results.controller.js:1333 at origin/master). The previous promotion
 *     run counts such a row, so it must keep its year.
 *   - Once the previous code reprocesses one of this branch's rows, its
 *     calcVersion is `exam-process/1` again: it looks exactly like such a
 *     row, and a filter on `exam-process/3` misses it.
 *
 * So, while this branch is still deployed:
 *
 *   node scripts/revert-cleanup-agreed-calc.js --uri <URI> --record <manifest.json>
 *
 * lists, read-only, every summary stamped `exam-process/3` (every summary
 * this branch writes is) with its year and term. After the revert:
 *
 *   node scripts/revert-cleanup-agreed-calc.js --uri <URI> --manifest <manifest.json> [--dry-run]
 *
 * sets `academicYear` and `term` back to null (the schema default the
 * previous code writes) on exactly those ids, and only where the row still
 * holds the recorded values. Rows the manifest does not name are never
 * touched. A published row is left as it is, and counted: published results
 * are not changed by this script (unpublish first, if that is the decision).
 *
 * It prints the counts before writing; --dry-run prints them and writes
 * nothing. --school <id> limits either step to one school. Plain driver,
 * no models: it runs from any checkout with node_modules, after the revert.
 */

const fs = require("fs");
const mongoose = require("mongoose");

const COLL = "resultsummaries";

const connect = (uri) => {
  if (!uri) throw new Error("--uri is required");
  return mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000 }).asPromise();
};

/** Before the revert, read-only: the rows this branch wrote. */
const record = async ({ uri, school = null }) => {
  const conn = await connect(uri);
  try {
    const filter = { calcVersion: "exam-process/3", ...(school ? { schoolId: String(school) } : {}) };
    const rows = await conn.db.collection(COLL).find(filter,
      { projection: { _id: 1, schoolId: 1, examId: 1, studentId: 1, academicYear: 1, term: 1, isPublished: 1 } }).sort({ _id: 1 }).toArray();
    return {
      recordedAt: new Date().toISOString(),
      filter: "calcVersion exam-process/3",
      school: school ? String(school) : null,
      rows: rows.map((r) => ({ _id: r._id, schoolId: r.schoolId ?? null, examId: r.examId ?? null, studentId: r.studentId ?? null,
        academicYear: r.academicYear ?? null, term: r.term ?? null, isPublished: !!r.isPublished })),
    };
  } finally {
    await conn.close().catch(() => {});
  }
};

/** After the revert: counts first, then (unless dryRun) the write. */
const cleanup = async ({ uri, manifest, school = null, dryRun = false }) => {
  if (!manifest || !Array.isArray(manifest.rows)) throw new Error("--manifest: not a manifest written by --record");
  const conn = await connect(uri);
  try {
    const coll = conn.db.collection(COLL);
    const named = manifest.rows.filter((r) => !school || String(r.schoolId) === String(school));
    const counts = { inManifest: named.length, missing: 0, alreadyClear: 0, changedSince: 0, published: 0, toClear: 0, cleared: 0 };
    const ops = [];
    for (const m of named) {
      const row = await coll.findOne({ _id: m._id }, { projection: { academicYear: 1, term: 1, isPublished: 1 } });
      if (!row) { counts.missing += 1; continue; }
      if (row.academicYear == null && row.term == null) { counts.alreadyClear += 1; continue; }
      if ((row.academicYear ?? null) !== m.academicYear || (row.term ?? null) !== m.term) { counts.changedSince += 1; continue; }
      if (row.isPublished) { counts.published += 1; continue; }
      counts.toClear += 1;
      ops.push({ updateOne: {
        // The same conditions again, in the write itself: a row published or
        // changed between the count and the write is left alone.
        filter: { _id: m._id, academicYear: m.academicYear, term: m.term, isPublished: { $ne: true } },
        update: { $set: { academicYear: null, term: null } },
      } });
    }
    if (!dryRun && ops.length) counts.cleared = (await coll.bulkWrite(ops, { ordered: false })).modifiedCount;
    return { dryRun, counts };
  } finally {
    await conn.close().catch(() => {});
  }
};

module.exports = { record, cleanup };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  const uri = arg("uri"), school = arg("school"), dryRun = process.argv.includes("--dry-run");
  (async () => {
    if (arg("record")) {
      const m = await record({ uri, school });
      fs.writeFileSync(arg("record"), JSON.stringify(m, null, 1));
      console.log(`Recorded ${m.rows.length} sequence result(s) stamped exam-process/3 ` +
        `(${m.rows.filter((r) => r.isPublished).length} published) to ${arg("record")}. Nothing was written to the database.`);
    } else if (arg("manifest")) {
      const manifest = JSON.parse(fs.readFileSync(arg("manifest"), "utf8"));
      // The counts, before anything is written.
      const plan = await cleanup({ uri, manifest, school, dryRun: true });
      const c = plan.counts;
      console.log(`In the manifest: ${c.inManifest}. To clear: ${c.toClear}. Left alone: ${c.published} published, ` +
        `${c.changedSince} changed since the record, ${c.alreadyClear} already clear, ${c.missing} no longer there.`);
      if (dryRun) { console.log("--dry-run: nothing written."); return; }
      const done = await cleanup({ uri, manifest, school });
      console.log(`Cleared academicYear and term on ${done.counts.cleared} sequence result(s).`);
    } else {
      throw new Error("pass --record <file> (before the revert) or --manifest <file> (after it)");
    }
  })().then(() => process.exit(0)).catch((err) => { console.error(`failed: ${err.message}`); process.exit(1); });
}
