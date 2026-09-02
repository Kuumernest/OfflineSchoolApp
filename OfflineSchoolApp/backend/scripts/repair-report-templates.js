// backend/scripts/repair-report-templates.js
"use strict";

/**
 * Repair the promotion banner in report-card templates a school already saved.
 *
 * ── What is wrong with them ───────────────────────────────────────────────
 *
 * The layout this project shipped gated its banner on {{if isPassing}} and
 * printed "✓ PROMOTED". Passing one exam is not a promotion, so every pupil who
 * passed was told they had been promoted — on a First Sequence card, in a
 * document a family keeps, before any council had decided anything.
 *
 * The seed is fixed. A school that saved a copy still holds the old text in its
 * own ReportTemplate row, and fixing the seed does nothing for them.
 *
 * ── Why this patches rather than reseeds ──────────────────────────────────
 *
 * A template is the school's document. Some have been edited — their own
 * header, their own colours, fields added and removed — and replacing the row
 * with the current seed would throw all of that away to fix one banner. So this
 * finds the {{if isPassing}} block, changes the wording INSIDE it, and adds the
 * annual-only promotion block after it. Everything else is left exactly as the
 * school left it.
 *
 * A template without that block is not touched at all, and is reported as such
 * rather than silently skipped: "we did not need to" and "we could not tell"
 * are different answers.
 *
 * ── Nothing is written without being rendered first ───────────────────────
 *
 * Each repaired template is run through the real engine before it is saved, on
 * a sequence payload and an annual one, and is only written if the promotion
 * appears on the annual card and nowhere else. A repair that produces a broken
 * template would be worse than the bug it fixes.
 *
 *   node scripts/repair-report-templates.js              # report only
 *   node scripts/repair-report-templates.js --apply      # write
 *   node scripts/repair-report-templates.js --school <id> # one school
 */

require("dotenv").config();
const mongoose = require("mongoose");

const ReportTemplate = require("../src/db/models/ReportTemplate");
const { renderReportCard } = require("../src/services/reportHtml.service");

const APPLY  = process.argv.includes("--apply");
const SCHOOL = (() => {
  const i = process.argv.indexOf("--school");
  return i > -1 ? process.argv[i + 1] : null;
})();

// ─────────────────────────────────────────────────────────────────────────────
// FINDING THE BLOCK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The {{if isPassing}} … {{endif}} block, matched with nesting respected.
 *
 * Not a regex: a school may well have put another {{if}} inside the banner, and
 * a lazy match would stop at ITS {{endif}} and leave a half-rewritten template
 * behind. Counting depth is the only honest way to find the end.
 *
 * @returns {{start: number, end: number, body: string}|null}
 */
const findIsPassingBlock = (html) => {
  const open = html.indexOf("{{if isPassing}}");
  if (open === -1) return null;

  const OPEN_RE = /\{\{if\s+[^}]+\}\}/g;
  let depth = 1;
  let cursor = open + "{{if isPassing}}".length;

  while (cursor < html.length) {
    OPEN_RE.lastIndex = cursor;
    const nextOpen  = OPEN_RE.exec(html);
    const nextClose = html.indexOf("{{endif}}", cursor);
    if (nextClose === -1) return null;              // unbalanced; leave it alone

    if (nextOpen && nextOpen.index < nextClose) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }

    depth -= 1;
    cursor = nextClose + "{{endif}}".length;
    if (depth === 0) {
      return { start: open, end: cursor, body: html.slice(open, cursor) };
    }
  }
  return null;
};

/** The annual-only promotion block, matching the current seed. */
const PROMOTION_BLOCK = `

  <!-- The promotion decision: the final annual report card only. -->
  {{if is_annual}}
    {{if promotion_status}}
      <div class="pass-banner pass">
        {{promotion_status}}
      </div>
    {{endif}}
  {{endif}}`;

/**
 * @returns {{ status: string, html?: string, note?: string }}
 *   repaired      | the banner was rewritten and the promotion block added
 *   already-fixed | it gates on is_annual already; nothing to do
 *   no-banner     | no {{if isPassing}} block; not ours to touch
 *   no-promotion  | it has the block, but says nothing about promotion
 *   unbalanced    | the block does not close; reported, never guessed at
 */
const repairHtml = (html) => {
  if (typeof html !== "string" || !html.trim()) {
    return { status: "no-banner", note: "empty template" };
  }
  if (html.includes("{{if is_annual}}")) {
    return { status: "already-fixed" };
  }

  const block = findIsPassingBlock(html);
  if (!block) {
    return html.includes("{{if isPassing}}")
      ? { status: "unbalanced", note: "{{if isPassing}} has no matching {{endif}}" }
      : { status: "no-banner" };
  }
  if (!/PROMOTED/i.test(block.body)) {
    return { status: "no-promotion", note: "the banner does not mention promotion" };
  }

  // Only inside the block. "NOT PROMOTED" becomes "NOT PASSED" by the same
  // replacement, which is why it is not handled separately.
  const fixedBody = block.body.replace(/PROMOTED/g, "PASSED");

  return {
    status: "repaired",
    html: html.slice(0, block.start) + fixedBody + PROMOTION_BLOCK + html.slice(block.end),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PROVING IT BEFORE WRITING IT
// ─────────────────────────────────────────────────────────────────────────────

const PROBE = (reportType) => ({
  studentName: "Probe Pupil", admissionNo: "PROBE-1", className: "Form 3",
  academicYear: "2026/2027", gender: "Female", dateOfBirth: "2011-04-02",
  examName: "Probe", term: "Probe", reportType, showGrades: true,
  subjects: [{
    subjectName: "Mathematics", score: 18, maxScore: 20, normalizedMark: 18,
    grade: "A+", remark: "Excellent", subjectPosition: 1, subjectTotal: 2,
    coefficient: 1, isPassing: true,
  }],
  summary: {
    average: 18, classPosition: 1, totalInClass: 2, isPassing: true,
    overallGrade: "A+", overallRemark: "Excellent",
    promotionStatus: "PROMOTED TO THE NEXT CLASS",
  },
  computed: { totalCoefficients: 1, weightedAverage: 18, outOf: 20 },
});

const PROBE_OPTS = (html, css) => ({
  template:   { html, css },
  schoolName: "Probe School",
  school:     { name: "Probe School", logo: null, motto: "Probe" },
});

/**
 * Render the candidate and insist on three things: the engine parsed it, the
 * promotion appears on the annual card, and it appears nowhere else.
 *
 * @returns {string[]} reasons it is not safe to write; empty means it is
 */
const verify = (html, css) => {
  const problems = [];
  let annual, sequence;

  try {
    annual   = renderReportCard(PROBE("annual"),   PROBE_OPTS(html, css));
    sequence = renderReportCard(PROBE("sequence"), PROBE_OPTS(html, css));
  } catch (err) {
    return [`the engine threw: ${err.message}`];
  }

  // renderReportCard falls back to the built-in layout when a template fails to
  // parse, so a "template" source is the proof that the repair is still valid.
  if (annual.source !== "template")   problems.push("the repaired template no longer parses");
  if (!/PROMOTED TO THE NEXT CLASS/.test(annual.html)) {
    problems.push("the annual card lost its promotion decision");
  }
  if (/PROMOTED TO THE NEXT CLASS/.test(sequence.html)) {
    problems.push("the sequence card still shows a promotion");
  }
  if (!/PASSED/.test(sequence.html)) {
    problems.push("the sequence card lost its pass/fail banner");
  }
  return problems;
};

// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const filter = { deletedAt: null, ...(SCHOOL ? { schoolId: String(SCHOOL) } : {}) };
  const rows = await ReportTemplate.find(filter)
    .select("_id schoolId name html css isDefault")
    .lean();

  console.log(
    `\n  ${rows.length} template(s)${SCHOOL ? ` for school ${SCHOOL}` : ""}` +
    `  —  ${APPLY ? "APPLYING" : "dry run, nothing will be written"}\n`
  );

  const tally = {};
  const writes = [];

  for (const row of rows) {
    const label  = `${row.name || "(unnamed)"} [${row._id}]`;
    const result = repairHtml(row.html);
    tally[result.status] = (tally[result.status] || 0) + 1;

    if (result.status !== "repaired") {
      console.log(`  ${result.status.padEnd(14)} ${label}` +
                  (result.note ? `  — ${result.note}` : ""));
      continue;
    }

    const problems = verify(result.html, row.css);
    if (problems.length) {
      tally.repaired -= 1;
      tally["unsafe"] = (tally.unsafe || 0) + 1;
      console.log(`  unsafe         ${label}`);
      for (const p of problems) console.log(`                   ${p}`);
      continue;
    }

    console.log(`  repaired       ${label}${row.isDefault ? "  (default)" : ""}`);
    writes.push({ _id: row._id, html: result.html });
  }

  if (APPLY && writes.length) {
    for (const w of writes) {
      await ReportTemplate.updateOne(
        { _id: w._id },
        { $set: { html: w.html } }
      );
    }
    console.log(`\n  wrote ${writes.length} template(s)`);
  } else if (writes.length) {
    console.log(`\n  ${writes.length} template(s) would be written — re-run with --apply`);
  }

  const order = ["repaired", "already-fixed", "no-banner", "no-promotion", "unbalanced", "unsafe"];
  console.log("\n  " + order
    .filter((k) => tally[k])
    .map((k) => `${k}: ${tally[k]}`)
    .join("   ") + "\n");

  await mongoose.disconnect();
};

// Exported so scripts/check-template-repair.js can exercise the decision and
// the verification without a database. Only connects when run directly, so
// requiring this file costs nothing.
module.exports = { repairHtml, findIsPassingBlock, verify, PROMOTION_BLOCK };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
