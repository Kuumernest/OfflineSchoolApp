// backend/scripts/repair-score-grades.js
"use strict";

/**
 * Recompute stored letter grades from the marks they came from.
 *
 * ── What went wrong ───────────────────────────────────────────────────────────
 *
 * A letter grade is not a value anybody typed. It is the band a mark lands in
 * once normalised to the /20 scale, so it is derived data that happens to be
 * stored — and stored derived data goes stale when the thing it was derived
 * from changes.
 *
 * The grade scale changed. shared/gradeScale.js records it: there were four
 * scales, three of them a seven-band table with no C+ and remarks of its own,
 * and those three were the ones actually grading marks. Consolidating them onto
 * the school's real eight-band table fixed every future grading and touched
 * none of the letters already written to StudentScore.
 *
 * So a pupil on 11/20 carries "D" from the retired scale where the school's own
 * table says "C+", and 14/20 carries "B" where the table says "B+". At the time
 * of writing that is 598 of 1404 marks.
 *
 * It surfaced in the parent portal, because POST /exams/:examId/process used to
 * copy StudentScore.grade straight into ResultSummary.subjectBreakdown — so the
 * portal showed the retired scale's letters beside marks the same summary had
 * recomputed correctly. A 20/20 read "F". That copy is now a recomputation, so
 * reprocessing an exam fixes its summaries. This script fixes the score rows
 * those summaries were built from, which other screens read directly.
 *
 * ── Dry run unless told otherwise ─────────────────────────────────────────────
 *
 *   node scripts/repair-score-grades.js            # report only, writes nothing
 *   node scripts/repair-score-grades.js --apply    # write the corrections
 *   node scripts/repair-score-grades.js --school <id>
 *
 * isPassing is recomputed too, from the school's passMark. It was already right
 * — it was always derived from the mark rather than stored alongside a letter —
 * so it should not move, and the report says if it does.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY  = process.argv.includes("--apply");
const SCHOOL = (() => {
  const i = process.argv.indexOf("--school");
  return i !== -1 ? process.argv[i + 1] : null;
})();

const main = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set — check backend/.env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  require("../src/db/models");

  const StudentScore  = mongoose.model("StudentScore");
  const GradingConfig = mongoose.model("GradingConfig");
  const { GRADE_SCALE } = require("../../shared/gradeScale");

  const configs = await GradingConfig.find({}).lean();
  const configBySchool = new Map(configs.map((c) => [String(c.schoolId), c]));

  /** The band a /20 mark belongs to. Highest-first, first match wins. */
  const bandFor = (markOutOf20, bands) => {
    const m = Math.max(0, Math.min(20, markOutOf20));
    for (const b of bands) {
      const min = Number(b.minMark ?? b.min);
      const max = Number(b.maxMark ?? b.max);
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      if (m >= min && m <= max) return b;
    }
    return null;
  };

  const query = { score: { $ne: null }, isAbsent: { $ne: true }, deletedAt: null };
  if (SCHOOL) query.schoolId = SCHOOL;

  const rows = await StudentScore.find(query)
    .select("_id schoolId score maxScore grade remark gpaPoints isPassing")
    .lean();

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${rows.length} mark(s) examined\n`);

  const ops = [];
  const moved = new Map();     // "D -> C+" => count
  let unchanged = 0;
  let passingMoved = 0;
  const samples = [];

  for (const r of rows) {
    const maxScore = Number(r.maxScore) || 100;
    if (maxScore <= 0) continue;

    const cfg      = configBySchool.get(String(r.schoolId));
    const bands    = cfg?.grades?.length ? cfg.grades : GRADE_SCALE;
    const passMark = Number(cfg?.passMark ?? 10);

    const markOutOf20 = Math.round(((Number(r.score) / maxScore) * 20) * 100) / 100;
    const band        = bandFor(markOutOf20, bands);
    if (!band) continue;

    const grade     = band.grade;
    const points    = Number(band.gpaPoints ?? band.points ?? 0);
    const remark    = band.remark ?? null;
    const isPassing = markOutOf20 >= passMark;

    const gradeStale   = r.grade !== grade;
    const passingStale = Boolean(r.isPassing) !== isPassing;

    if (!gradeStale && !passingStale) { unchanged++; continue; }
    if (passingStale) passingMoved++;

    if (gradeStale) {
      const key = `${r.grade ?? "none"} -> ${grade}`;
      moved.set(key, (moved.get(key) ?? 0) + 1);
      if (samples.length < 8) {
        samples.push(`  ${String(r.score).padStart(3)}/${maxScore}  ${String(r.grade ?? "none").padEnd(5)} -> ${grade}`);
      }
    }

    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { grade, remark, gpaPoints: points, isPassing } },
      },
    });
  }

  console.log(`already correct : ${unchanged}`);
  console.log(`to correct      : ${ops.length}`);
  console.log(`isPassing moves : ${passingMoved}${passingMoved ? "  (unexpected — see the note in this file)" : ""}`);

  if (moved.size) {
    console.log("\nletter changes:");
    for (const [k, n] of [...moved.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`);
    }
    console.log("\nexamples:");
    for (const s of samples) console.log(s);
  }

  if (!ops.length) {
    console.log("\nNothing to do.");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log("\nNothing was written. Re-run with --apply to make these changes.");
    console.log("Afterwards, re-run POST /api/exams/:examId/process for each affected");
    console.log("exam so the published summaries and report cards pick them up.");
    await mongoose.disconnect();
    return;
  }

  // Batched, so a large school does not go out as one enormous write.
  let written = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const batch = ops.slice(i, i + 500);
    const res = await StudentScore.bulkWrite(batch, { ordered: false });
    written += res.modifiedCount ?? 0;
    console.log(`  wrote ${written}/${ops.length}`);
  }

  console.log(`\nDone — ${written} mark(s) corrected.`);
  console.log("Now re-run POST /api/exams/:examId/process for each affected exam:");
  console.log("the summaries the portal reads are rebuilt from these rows.");

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error("repair failed:", err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
