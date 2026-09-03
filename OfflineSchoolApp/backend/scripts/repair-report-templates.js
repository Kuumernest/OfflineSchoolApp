// backend/scripts/repair-report-templates.js
"use strict";

/**
 * Repair the verdict banner in report-card templates a school already saved.
 *
 * Two faults, both in the same block, both fixed in the seed and both still
 * sitting in every copy a school made of it.
 *
 * ── One: it called passing a promotion ────────────────────────────────────
 *
 * The layout this project shipped gated its banner on {{if isPassing}} and
 * printed "✓ PROMOTED". Passing one exam is not a promotion, so every pupil who
 * passed was told they had been promoted — on a First Sequence card, in a
 * document a family keeps, before any council had decided anything.
 *
 * The seed is fixed. A school that saved a copy still holds the old text in its
 * own ReportTemplate row, and fixing the seed does nothing for them.
 *
 * ── Two: the verdict took a whole row, and pushed the code off the page ───
 *
 * That same banner is a full-width band with the remark printed inside it, at
 * 16px bold. Any remark longer than a few words wraps to two or three lines,
 * and the band plus the summary boxes above it is enough height to push the
 * verification block — with the code a registrar types to check that the card
 * is genuine — off the foot of the page. The document loses the one part of it
 * that proves it is real.
 *
 * So the verdict becomes a short pill and the remark sits beside it, on one
 * row. Same words, one line instead of four.
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
const path     = require("path");
const fs       = require("fs");

const ReportTemplate = require("../src/db/models/ReportTemplate");
const { OFFICIAL_HEADER_HTML, OFFICIAL_HEADER_CSS,
        VERIFY_BLOCK_HTML,  VERIFY_BLOCK_CSS,
        OUTCOME_BLOCK_HTML, CLOSING_BLOCK_HTML,
        PRINT_CSS } =
  require("../src/print/defaultReportTemplate");
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
const promotionPass = (html) => {
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
// SECOND PASS: THE VERDICT OFF ITS OWN ROW
// ─────────────────────────────────────────────────────────────────────────────

/** The rules the rearranged markup needs, appended to a template's own CSS. */
const LAYOUT_CSS = `

  /* ── Verdict and remark, on one row ────────────────────
     Added by scripts/repair-report-templates.js. The verdict used to be a
     full-width band with the remark inside it: it wrapped to several lines and
     pushed the verification code off the foot of the page. */
  .verdict {
    display:       flex;
    align-items:   center;
    gap:           10px;
    flex-wrap:     wrap;
    margin-bottom: 12px;
  }

  .verdict-pill {
    flex:          none;
    padding:       6px 12px;
    border-radius: 999px;
    font-size:     12px;
    font-weight:   bold;
    white-space:   nowrap;
  }

  .verdict-pill.pass { background: #d1fae5; color: #059669; }
  .verdict-pill.fail { background: #fee2e2; color: #dc2626; }

  .verdict-remark {
    flex:        1;
    min-width:   220px;
    font-size:   11px;
    font-style:  italic;
    color:       #4b5563;
    line-height: 1.5;
  }`;

/**
 * A pass/fail band, and only one that has no markup of its own inside it.
 *
 * A school that put a table or a nested div in its banner gets left alone: the
 * indentation and the structure are then its own design, and rebuilding the
 * block would be rewriting the document rather than repairing it.
 */
const BANNER_RE =
  /([ \t]*)<div class="pass-banner (pass|fail)"\s*>([\s\S]*?)<\/div>/g;

/** Only a real dash divides the verdict from the remark. Never a hyphen: a
 *  remark may well contain one, and splitting on it would cut a sentence. */
const DASH_RE = /\s*(?:&mdash;|&#8212;|&ndash;|—|–)\s*/;

/**
 * Move the remark out of the band and put it beside a pill.
 *
 * @returns {{ status: string, html?: string, count?: number, note?: string }}
 *   repaired      | at least one band was rearranged
 *   already-fixed | it is a pill already, or its band holds no remark to move
 *   no-banner     | there is no {{if isPassing}} block here
 *   unbalanced    | the block does not close
 */
const layoutPass = (html) => {
  const block = findIsPassingBlock(html);
  if (!block) {
    return html.includes("{{if isPassing}}")
      ? { status: "unbalanced", note: "{{if isPassing}} has no matching {{endif}}" }
      : { status: "no-banner" };
  }
  if (block.body.includes("verdict-pill")) return { status: "already-fixed" };

  // The template's own line endings, not this file's: these rows came out of a
  // database and may well be LF inside a CRLF repository.
  const eol = block.body.includes("\r\n") ? "\r\n" : "\n";

  let count = 0;
  const body = block.body.replace(BANNER_RE, (match, indent, cls, inner) => {
    if (inner.includes("<")) return match;              // markup of its own
    const parts   = inner.split(DASH_RE);
    const verdict = (parts[0] || "").trim();
    const remark  = parts.slice(1).join(" ").trim();

    // Nothing to unstack unless the band really is carrying the remark.
    if (!verdict || !remark.includes("{{remark}}")) return match;

    count += 1;
    return [
      `${indent}<div class="verdict">`,
      `${indent}  <div class="verdict-pill ${cls}">${verdict}</div>`,
      `${indent}  {{if remark}}<div class="verdict-remark">${remark}</div>{{endif}}`,
      `${indent}</div>`,
    ].join(eol);
  });

  if (!count) return { status: "already-fixed" };
  return {
    status: "repaired",
    count,
    html: html.slice(0, block.start) + body + html.slice(block.end),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// THIRD PASS: THE OFFICIAL HEADER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The header block as this project seeded it, and the only shape replaced.
 *
 * Matched loosely on whitespace but strictly on content: the logo, the name,
 * the motto and the contact line, then a hard-coded title and the term. A
 * school that has changed any of it — its own crest block, a different title,
 * fields added — does not match, and its header is left alone. That is
 * deliberate: a header is the most personal part of a school's document, and
 * "we could not tell" has to mean "we do not touch it" here.
 */
const OLD_HEADER_RE = new RegExp(
  [
    String.raw`<div class="school-header">`,
    String.raw`\s*\{\{school_logo\}\}`,
    String.raw`\s*<div class="school-name">\{\{school_name\}\}</div>`,
    String.raw`\s*<div class="school-motto">\{\{school_motto\}\}</div>`,
    String.raw`\s*<div class="school-contact">\{\{school_address\}\}\s*\|`,
    String.raw`\s*\{\{school_phone\}\}</div>`,
    String.raw`\s*</div>`,
    String.raw`\s*<div class="report-title">[^<]*</div>`,
    String.raw`\s*<p[^>]*>[^<]*\{\{term\}\}[\s\S]*?</p>`,
  ].join(""),
  ""
);

/**
 * Put the official three-column header where the centred strip was.
 *
 * @returns {{ status: string, html?: string, note?: string }}
 *   repaired      | the seeded header was replaced
 *   already-fixed | it is the official header already
 *   no-header     | not the shape this seeded; the school's own design
 */
const headerPass = (html) => {
  if (html.includes("ministry-column")) return { status: "already-fixed" };
  if (!OLD_HEADER_RE.test(html))        return { status: "no-header" };
  return {
    status: "repaired",
    html: html.replace(OLD_HEADER_RE, () => OFFICIAL_HEADER_HTML.trim()),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// FOURTH PASS: THE CODE BESIDE THE SQUARE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bare {{qr_code}} in a wrapper of its own, and nothing else.
 *
 * That is what the seed gave every school: the square, with no code beside it.
 * A parent can scan it; a registrar holding the paper and no scanner has
 * nothing to type. Matched narrowly — a lone div around the token — so a
 * school that has already built its own strip around the square keeps it.
 */
const BARE_QR_RE = /<div>\s*\{\{qr_code\}\}\s*<\/div>/;

/**
 * @returns {{ status: string, html?: string }}
 *   repaired      | the code and the URL now sit beside the square
 *   already-fixed | the code is already on the card
 *   no-qr         | no bare {{qr_code}} wrapper; the school's own strip
 */
const verifyStripPass = (html) => {
  if (html.includes("{{verification_code}}")) return { status: "already-fixed" };
  if (!BARE_QR_RE.test(html))                 return { status: "no-qr" };
  return {
    status: "repaired",
    html: html.replace(BARE_QR_RE, () => VERIFY_BLOCK_HTML),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// SIXTH PASS: TWO CARDS INSTEAD OF FIVE BANDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fold the outcome into one card, and the closing block into another.
 *
 * ── What the card looked like ─────────────────────────────────────────────
 *
 * Five stacked bands where two would do:
 *
 *   the summary figures      average, position, grade, class size
 *   the verdict              passed / not passed, and the remark
 *   an Attendance heading    with days open, present, absent and a rate
 *   the attendance table     usually empty
 *   two remark panels        class teacher and principal
 *
 * The figures and the verdict answer one question — how did this pupil do —
 * and sat apart with a gap between them. Attendance was four numbers of which
 * three are arithmetic on the fourth: a parent reads a card to learn how many
 * days their child missed, not the school's opening count.
 *
 * ── Why this pass is stricter than the others ─────────────────────────────
 *
 * The others add something: a class, a stylesheet, a block after another
 * block. This one MOVES the school's content, which is the most invasive thing
 * a repair can do, so it only acts on the exact shape this project seeded and
 * refuses everything else. A school that rearranged its own card keeps it.
 *
 * The blocks it inserts are imported from defaultReportTemplate rather than
 * written out here, so the repaired template and a freshly seeded one cannot
 * drift apart.
 */

const SUMMARY_OPEN = '<div class="summary-section">';

/**
 * The seeded summary grid through the end of the verdict conditional.
 *
 * Found by counting {{if}} depth rather than by a regex, for the reason the
 * promotion pass learned first: the verdict block contains {{if remark}}, so a
 * non-greedy match for {{endif}} stops at the INNER one and leaves the
 * {{else}} branch — and a second verdict band — behind. The first version of
 * this pass did exactly that.
 *
 * @returns {{start: number, end: number}|null}
 */
const outcomeRegion = (html) => {
  const start = html.indexOf(SUMMARY_OPEN);
  if (start === -1) return null;

  const block = findIsPassingBlock(html);
  if (!block || block.start < start) return null;

  // The verdict has to be what follows the figures, not something further down
  // the document that happens to be a conditional.
  const between = html.slice(start + SUMMARY_OPEN.length, block.start);
  if (between.includes("summary-section")) return null;
  if (between.length > 1200) return null;

  return { start, end: block.end };
};

/** The Attendance heading through the end of the remarks row. */
const CLOSING_REGION_RE = new RegExp(
  [
    String.raw`<h3[^>]*>[\s]*Attendance[\s]*</h3>`,
    String.raw`[\s\S]*?\{\{attendance_table\}\}`,
    String.raw`[\s\S]*?class="remarks-row"`,
    String.raw`[\s\S]*?\{\{principal_name\}\}`,
    String.raw`[\s\S]*?</div>[\s]*</div>[\s]*</div>`,
  ].join(""),
  ""
);

/**
 * @returns {{ status: string, html?: string, note?: string }}
 *   repaired      | one or both regions were folded into a card
 *   already-fixed | it carries the cards
 *   no-region     | not the shape this seeded; the school's own arrangement
 */
const layoutCardsPass = (html) => {
  if (html.includes("summary-verdict") || html.includes("closing-absences")) {
    return { status: "already-fixed" };
  }

  let out = html, changed = 0;

  const region = outcomeRegion(out);
  if (region) {
    out = out.slice(0, region.start) + OUTCOME_BLOCK_HTML.trim() + out.slice(region.end);
    changed += 1;
  }
  if (CLOSING_REGION_RE.test(out)) {
    out = out.replace(CLOSING_REGION_RE, () => CLOSING_BLOCK_HTML.trim());
    changed += 1;
  }

  if (!changed) {
    return { status: "no-region", note: "not the seeded arrangement" };
  }
  // Half a fold is not a fold: if only one region matched, the card would carry
  // one new block and one old band, which is worse than leaving both alone.
  if (changed < 2) {
    return { status: "no-region", note: "only one of the two regions matched" };
  }
  return { status: "repaired", html: out };
};

// ─────────────────────────────────────────────────────────────────────────────
// FIFTH PASS: ONE SHEET OF A4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The print rules, and the two classes they need to reach.
 *
 * The card is a one-page document that printed onto two. Not from carrying too
 * much — from a screen-comfortable gap under every one of a dozen blocks, plus
 * a browser page default that is not A4.
 *
 * Two of the blocks the compaction has to reach are styled inline in the
 * markup, and an inline style beats a stylesheet. So this pass adds the class
 * names the print rules hook onto — `stat-row` on the attendance strip,
 * `remarks-row` and `signature-row` on the remark panels — and leaves the
 * inline styles exactly where they are, so the screen rendering does not
 * change at all.
 *
 * @returns {{ status: string, html?: string }}
 *   repaired      | classes added
 *   already-fixed | it has them
 *   no-rows       | neither block is the shape this seeded
 */
const PRINT_ROWS = [
  /*
   * Matched by what the row CONTAINS, not by the inline style it happens to
   * carry.
   *
   * The first version of this matched the seeded strings literally and found
   * one row of three on the live template, because the school had edited the
   * others — `gap:12px` where the seed said 16, `margin-top:13px` where it
   * said 24. Those are the school's numbers and this pass must not touch them;
   * it only needs somewhere to hang a class. So each row is identified by the
   * thing inside it that cannot have changed: the attendance strip holds
   * {{days_open}}, the remarks row opens with a remarks-section, a signature
   * block wraps a signature-line.
   */
  { cls: "stat-row",
    re: /<div style="display:flex;[^"]*">(?=[\s\S]{0,500}?\{\{days_open\}\})/g },
  { cls: "remarks-row",
    re: /<div style="display:flex;[^"]*">(?=\s*<div class="remarks-section")/g },
  { cls: "signature-row",
    re: /<div style="margin-top:[^"]*">(?=\s*<span class="signature-line")/g },
];

const printClassPass = (html) => {
  /*
   * No global "has it already" guard, deliberately.
   *
   * There was one, testing for any of the three classes, and it was wrong in
   * exactly the way that matters: a template that had picked up one class
   * already — as the live one had, from a first run that matched only the
   * strip — was declared finished, and the other two rows never got theirs.
   *
   * The guard is per row instead, and it comes free: the pattern matches
   * `<div style=`, so a div whose class was already inserted in front of its
   * style attribute cannot match a second time.
   */
  let out = html, changed = 0;
  for (const { cls, re } of PRINT_ROWS) {
    out = out.replace(re, (match) => {
      changed += 1;
      // The class goes in front; every existing attribute is left as it was.
      return match.replace("<div ", `<div class="${cls}" `);
    });
  }

  if (changed) return { status: "repaired", html: out, count: changed };
  return /class="(stat|remarks|signature)-row"/.test(html)
    ? { status: "already-fixed" }
    : { status: "no-rows" };
};

/** The template's CSS with the print rules appended, or null if it has them. */
const repairPrintCss = (css) => {
  if (typeof css !== "string") return null;
  if (/@page/.test(css)) return null;
  return css + nlJoin(PRINT_CSS);
};

/** The template's CSS with the strip's rules appended, or null if it has them. */
const repairVerifyCss = (css) => {
  if (typeof css !== "string") return null;
  if (/\.verify-code\b/.test(css)) return null;
  return css + nlJoin(VERIFY_BLOCK_CSS);
};

/** The template's CSS with the header rules appended, or null if it has them. */
const repairHeaderCss = (css) => {
  if (typeof css !== "string") return null;
  if (/\.ministry-column/.test(css)) return null;
  return css + nlJoin(OFFICIAL_HEADER_CSS);
};

/** Two blank lines, then the block — the spacing the stylesheet already uses. */
const nlJoin = (block) => `

${block.trim()}
`;

/** The template's CSS with the new rules appended, or null if it has them. */
const repairCss = (css) => {
  if (typeof css !== "string") return null;
  if (/\.verdict\b/.test(css)) return null;
  return css + LAYOUT_CSS;
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Both passes, in order, over one template.
 *
 * They are independent: a template repaired for the promotion months ago still
 * needs the layout, so neither pass may return early on the other's behalf.
 * When nothing changes, the promotion pass's answer is the one reported — it is
 * the more specific of the two about why.
 *
 * @returns {{ status, html?, css?, changes?: string[], note? }}
 */
const repairHtml = (html, css) => {
  if (typeof html !== "string" || !html.trim()) {
    return { status: "no-banner", note: "empty template" };
  }

  const changes = [];
  let out = html;

  const promo = promotionPass(out);
  if (promo.html) { out = promo.html; changes.push("promotion"); }

  const layout = layoutPass(out);
  if (layout.html) { out = layout.html; changes.push("layout"); }

  const header = headerPass(out);
  if (header.html) { out = header.html; changes.push("header"); }

  const strip = verifyStripPass(out);
  if (strip.html) { out = strip.html; changes.push("verify"); }

  const printable = printClassPass(out);
  if (printable.html) { out = printable.html; changes.push("print"); }

  // Last, because it consumes the blocks the passes above have already
  // corrected — the verdict pill the layout pass built, and the classes the
  // print pass added to the rows it replaces.
  const cards = layoutCardsPass(out);
  if (cards.html) { out = cards.html; changes.push("cards"); }

  if (!changes.length) {
    const note = promo.note || layout.note || header.note || strip.note;
    const cssOnly = repairPrintCss(typeof css === "string" ? css : null);
    // The print rules are CSS only, so a template whose markup is already
    // classed still needs them if its stylesheet has no @page.
    if (cssOnly) {
      return { status: "repaired", changes: ["print"], html: out, css: cssOnly };
    }
    return { status: promo.status, ...(note ? { note } : {}) };
  }

  // Each pass brings its own rules, and each declines if the stylesheet has
  // them already. Applied in order so the second sees the first's work.
  let nextCss = typeof css === "string" ? css : null;
  if (changes.includes("layout")) nextCss = repairCss(nextCss) ?? nextCss;
  if (changes.includes("header")) nextCss = repairHeaderCss(nextCss) ?? nextCss;
  if (changes.includes("verify")) nextCss = repairVerifyCss(nextCss) ?? nextCss;
  nextCss = repairPrintCss(nextCss) ?? nextCss;

  return {
    status: "repaired",
    changes,
    html: out,
    ...(nextCss == null || nextCss === css ? {} : { css: nextCss }),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PROVING IT BEFORE WRITING IT
// ─────────────────────────────────────────────────────────────────────────────

const PROBE = (reportType) => ({
  studentName: "Probe Pupil", admissionNo: "PROBE-1", className: "Form 3",
  academicYear: "2026/2027", gender: "Female", dateOfBirth: "2011-04-02",
  examName: "Probe", term: "Probe", reportType, showGrades: true,
  // So the official header has a period to name in its title.
  period: reportType === "sequence"
    ? { reportType, sequenceNumber: 1 }
    : reportType === "term" ? { reportType, term: 1 } : { reportType },
  subjects: [{
    subjectName: "Mathematics", score: 18, maxScore: 20, normalizedMark: 18,
    grade: "A+", remark: "Excellent", subjectPosition: 1, subjectTotal: 2,
    coefficient: 1, isPassing: true,
  }],
  summary: {
    average: 18, classPosition: 1, totalInClass: 2, isPassing: true,
    overallGrade: "A+", overallRemark: "Steady and careful work",
    promotionStatus: "PROMOTED TO THE NEXT CLASS",
  },
  computed: { totalCoefficients: 1, weightedAverage: 18, outOf: 20 },
});

const PROBE_OPTS = (html, css) => ({
  template:   { html, css },
  // So a repaired verification strip is rendered against a card that actually
  // has something to verify.
  verify:     { code: "PROBE-C0DE-1234", url: "https://probe.test/r/1234",
                qrSvg: "<svg data-probe-qr></svg>" },
  schoolName: "Probe School",
  school:     {
    name: "Probe School", logo: null, motto: "Probe",
    // The official header reads these; without them a repaired header would
    // verify against a card that never exercised its delegation lines.
    region: "Probe Region", division: "Probe Division", schoolType: "shs",
  },
});

/**
 * Render the candidate and insist on four things: the engine parsed it, the
 * promotion appears on the annual card, it appears nowhere else, and — when the
 * layout pass has just moved the remark out of the band — the remark is still
 * on the card. That last one is the whole risk of rearranging markup: a repair
 * that tidied the row by dropping the teacher's words would be a worse
 * document than the one it replaced.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.expectRemark] the layout pass moved a remark
 * @returns {string[]} reasons it is not safe to write; empty means it is
 */
const verify = (html, css, opts = {}) => {
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
  if (opts.expectRemark && !/Steady and careful work/.test(sequence.html)) {
    problems.push("the rearranged row dropped the remark");
  }

  // A rebuilt verification strip has to carry the code as well as the square:
  // the square alone is the fault being repaired.
  if (opts.expectVerify) {
    if (!/PROBE-C0DE-1234/.test(sequence.html)) {
      problems.push("the verification strip has no code to read");
    }
    if (!/data-probe-qr/.test(sequence.html)) {
      problems.push("the verification strip lost its QR");
    }
  }

  // A replaced header has to carry both margins and name its period, or the
  // card has lost the letterhead that makes it an official document.
  if (opts.expectHeader) {
    if (!/Ministry of Secondary Education/.test(sequence.html)) {
      problems.push("the header lost its English ministry");
    }
    if (!/Enseignements Secondaires/.test(sequence.html)) {
      problems.push("the header lost its French ministry");
    }
    if (!/Regional Delegation of Probe Region/.test(sequence.html)) {
      problems.push("the header lost the regional delegation");
    }
    if (!/First Sequence Progress Record/.test(sequence.html)) {
      problems.push("the header does not name the period");
    }
    if (!/Probe School/.test(sequence.html)) {
      problems.push("the header lost the school's name");
    }
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
    const result = repairHtml(row.html, row.css);
    tally[result.status] = (tally[result.status] || 0) + 1;

    if (result.status !== "repaired") {
      console.log(`  ${result.status.padEnd(14)} ${label}` +
                  (result.note ? `  — ${result.note}` : ""));
      continue;
    }

    const problems = verify(result.html, result.css ?? row.css, {
      expectRemark: result.changes.includes("layout"),
      expectHeader: result.changes.includes("header"),
      expectVerify: result.changes.includes("verify"),
    });
    if (problems.length) {
      tally.repaired -= 1;
      tally["unsafe"] = (tally.unsafe || 0) + 1;
      console.log(`  unsafe         ${label}`);
      for (const p of problems) console.log(`                   ${p}`);
      continue;
    }

    console.log(`  repaired       ${label}${row.isDefault ? "  (default)" : ""}` +
                `  — ${result.changes.join(" + ")}`);
    writes.push({
      _id: row._id, html: result.html,
      ...(result.css == null ? {} : { css: result.css }),
      before: { name: row.name, html: row.html, css: row.css },
    });
  }

  if (APPLY && writes.length) {
    // The old rows on disk before the new ones go in. These are the school's
    // own documents, and nothing in the app can put them back.
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file  = path.join(dir, `report-templates-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(
      writes.map((w) => ({ _id: String(w._id), ...w.before })), null, 2));
    console.log(`\n  backed up to ${path.relative(process.cwd(), file)}`);

    for (const w of writes) {
      await ReportTemplate.updateOne(
        { _id: w._id },
        { $set: { html: w.html, ...(w.css == null ? {} : { css: w.css }) } }
      );
    }
    console.log(`  wrote ${writes.length} template(s)`);
  } else if (writes.length) {
    console.log(`\n  ${writes.length} template(s) would be written — re-run with --apply`);
  }

  const order = ["repaired", "already-fixed", "no-banner", "no-promotion",
                 "no-header", "no-qr", "no-rows", "no-region",
                 "unbalanced", "unsafe"];
  console.log("\n  " + order
    .filter((k) => tally[k])
    .map((k) => `${k}: ${tally[k]}`)
    .join("   ") + "\n");

  await mongoose.disconnect();
};

// Exported so scripts/check-template-repair.js can exercise the decision and
// the verification without a database. Only connects when run directly, so
// requiring this file costs nothing.
module.exports = {
  repairHtml, findIsPassingBlock, verify, PROMOTION_BLOCK,
  promotionPass, layoutPass, repairCss, LAYOUT_CSS,
  headerPass, repairHeaderCss, OLD_HEADER_RE,
  verifyStripPass, repairVerifyCss, BARE_QR_RE,
  printClassPass, repairPrintCss,
  layoutCardsPass, outcomeRegion, CLOSING_REGION_RE,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
