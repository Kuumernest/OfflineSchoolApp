// backend/scripts/list-unconfirmed-bars.js
"use strict";

/**
 * Classes with no confirmed promotion bar for the year, in every school
 * (docs/40, step 7.1). Read-only: find() on its own connection, nothing else.
 *
 * A class's bar is confirmed for a year when AcademicStructure.rules.
 * classThresholds holds an entry for it (shared/academicRules). A class
 * without one is judged against the school's bar, or the pass mark, and
 * shows its old 0-100 promotionAverage on Promotion -> Progression until a
 * bar is confirmed. A final-year class graduates whatever the bar, so it is
 * not listed. Within one school the same answer is
 * GET /api/promotion/progression?year=… (`year.classes[id].confirmed`).
 *
 *   node scripts/list-unconfirmed-bars.js --uri <URI> [--year 2026/2027] [--json]
 *
 * --year defaults to each school's settings.academicYear.
 */

const mongoose = require("mongoose");

const listUnconfirmedBars = async ({ uri, year = null }) => {
  if (!uri) throw new Error("--uri is required");
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000 }).asPromise();
  try {
    const db = conn.db;
    const schools = await db.collection("schools").find({}, { projection: { _id: 1, code: 1, settings: 1 } }).toArray();
    const out = [];
    for (const school of schools) {
      const schoolId = String(school._id);
      const academicYear = year || school.settings?.academicYear || null;
      if (!academicYear) { out.push({ schoolId, code: school.code ?? null, academicYear: null, note: "no academic year" }); continue; }
      const structure = await db.collection("academicstructures").findOne(
        { schoolId, academicYear, deletedAt: null }, { projection: { rules: 1 } });
      const confirmed = structure?.rules?.classThresholds ?? {};
      const classes = await db.collection("classes").find(
        { schoolId, deletedAt: null }, { projection: { _id: 1, name: 1, isFinalYear: 1 } }).sort({ name: 1 }).toArray();
      const unconfirmed = classes
        .filter((c) => !c.isFinalYear && !Object.prototype.hasOwnProperty.call(confirmed, String(c._id)))
        .map((c) => ({ classId: String(c._id), name: c.name ?? null }));
      out.push({
        schoolId, code: school.code ?? null, academicYear, hasStructure: Boolean(structure),
        schoolBar: typeof structure?.rules?.promotionThreshold === "number" ? structure.rules.promotionThreshold : null,
        unconfirmed,
      });
    }
    return out;
  } finally {
    await conn.close().catch(() => {});
  }
};

module.exports = { listUnconfirmedBars };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  listUnconfirmedBars({ uri: arg("uri"), year: arg("year") })
    .then((rows) => {
      if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) {
        console.log(`${r.code ?? r.schoolId} ${r.academicYear ?? "(no year)"}: ` +
          (r.unconfirmed ? `${r.unconfirmed.length} class(es) without a confirmed bar` +
            (r.unconfirmed.length ? ` — ${r.unconfirmed.map((c) => c.name ?? c.classId).join(", ")}` : "") : r.note));
      }
      process.exit(0);
    })
    .catch((err) => { console.error(`failed: ${err.message}`); process.exit(1); });
}
