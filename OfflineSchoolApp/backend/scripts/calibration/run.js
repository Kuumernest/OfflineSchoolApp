// backend/scripts/calibration/run.js
"use strict";

/**
 * Analyse a calibration cohort, offline, with the production engine.
 *
 *   node scripts/calibration/run.js <cohort.json> [--out <dir>] [--emit-fixtures]
 *
 * Writes into --out (default: beside the cohort, in calibration-out/):
 *
 *   report.json          the whole machine-readable analysis
 *   report.md            the same, for a person
 *   review-cases.json    the teacher review sheet, verdict slots empty
 *   regression.json      (with --emit-fixtures) the review cases with the
 *                        engine's current answers recorded, for
 *                        scripts/check-calibration.js to hold future engines to
 *
 * ── What this needs ───────────────────────────────────────────────────────
 *
 * The cohort file and Node. No database, no network, no environment variable.
 * It reads shared/intelligence directly; the backend is not involved and does
 * not have to be installed. Running it twice on the same file writes the same
 * bytes twice — there is no timestamp in any output, on purpose, so that two
 * people can diff two runs and see only what changed in the engine or the data.
 *
 * ── What it refuses ───────────────────────────────────────────────────────
 *
 * A cohort that does not validate. The errors are printed and nothing is
 * written, because an analysis of a malformed file is an analysis of the
 * malformation.
 */

const fs   = require("fs");
const path = require("path");

const { validateCohort } = require("./cohortSchema");
const { analyse, renderMarkdown } = require("./analyseCohort");

const args = process.argv.slice(2);
const cohortFile = args.find((a) => !a.startsWith("--"));
if (!cohortFile) {
  console.error("usage: node scripts/calibration/run.js <cohort.json> [--out <dir>] [--emit-fixtures]");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.join(path.dirname(path.resolve(cohortFile)), "calibration-out");
const emitFixtures = args.includes("--emit-fixtures");

const cohort  = JSON.parse(fs.readFileSync(cohortFile, "utf8"));
const verdict = validateCohort(cohort);
if (!verdict.ok) {
  console.error(`cohort does not validate (${verdict.errors.length} error${verdict.errors.length === 1 ? "" : "s"}):`);
  for (const e of verdict.errors.slice(0, 40)) console.error("  -", e);
  process.exit(1);
}
for (const w of verdict.warnings.slice(0, 20)) console.log("warning:", w);

const report = analyse(cohort);

fs.mkdirSync(outDir, { recursive: true });
const write = (name, data) => {
  fs.writeFileSync(path.join(outDir, name), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path.join(outDir, name)}`);
};

write("report.json", report);
write("report.md", renderMarkdown(report));
write("review-cases.json", {
  provenance: report.provenance,
  engineVersion: report.engineVersion,
  verdictOptions: report.reviewCases.verdictOptions,
  cases: report.reviewCases.cases,
});

if (emitFixtures) {
  /*
   * The regression fixture: each review case with what the engine said about
   * it TODAY. A future engine is held to these answers unless somebody changes
   * them deliberately and says why. Synthetic provenance is carried through so
   * a fixture made from constructed data can never be mistaken for one made
   * from real pupils.
   */
  write("regression.json", {
    provenance: report.provenance,
    engineVersion: report.engineVersion,
    cases: report.reviewCases.cases.map((c) => ({
      caseId: c.caseId, category: c.category, studentId: c.studentId, subjectId: c.subjectId,
      expected: {
        classifications: c.classifications,
        guidance: c.guidance,
        metrics: c.metrics,
      },
    })),
  });
}

console.log("");
console.log(`engine ${report.engineVersion} · provenance ${report.provenance.kind}`);
console.log(`pupils ${report.evidence.students} · sufficient ${report.evidence.studentsSufficient} · insights ${report.distribution.insights.total} · flags ${report.flags.length}`);
