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
        INFO_PANEL_HTML,    INFO_PANEL_CSS,
        REMARKS_BLOCK_HTML, REMARKS_BLOCK_CSS,
        PRINT_CSS } = require("../src/print/defaultReportTemplate");
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

/**
 * One element, from its opening tag to the `</div>` that closes it.
 *
 * Counted rather than matched: a regex for "the next </div>" stops at the
 * first child's, and a block with four columns in it has plenty of those.
 *
 * @returns {{ start: number, end: number } | null}
 */
const elementAt = (html, openingTag) => {
  const start = html.indexOf(openingTag);
  if (start < 0) return null;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return { start, end: m.index + m[0].length };
  }
  return null;
};

/**
 * The band of figures over the marks, taken off.
 *
 * Passed, the average, the rank and the remark were stated twice: once in a
 * band across the top of the card and again in the table and panel beneath
 * it. The table is the summary now, so the band goes — in whichever shape a
 * school's copy carries it: the folded card, the verdict row that preceded
 * it, or the original pass/fail banner. The promotion banner goes with them;
 * the decision has its own row in the table.
 *
 * Nothing is inserted in its place, and nothing outside the band is touched.
 */
const removeBannerPass = (html) => {
  let out = html, removed = 0;

  for (const tag of [`<div class="summary-section"`, `<div class="verdict"`]) {
    let found;
    while ((found = elementAt(out, tag))) {
      out = (out.slice(0, found.start) + out.slice(found.end)).replace(/\n\s*\n\s*\n/g, "\n\n");
      removed += 1;
    }
  }

  // The original banner, and the annual promotion block that followed it.
  for (const opening of ["{{if isPassing}}", "{{if is_annual}}"]) {
    const at = out.indexOf(opening);
    if (at === -1) continue;
    const block = opening === "{{if isPassing}}"
      ? findIsPassingBlock(out)
      : findBlockFrom(out, at);
    if (!block) continue;
    // Only a banner. The information panel states the same decision in a
    // row of its own, gated on the same {{if is_annual}} — so the test is
    // the banner's own markup, not the token it prints.
    if (!/pass-banner|verdict-pill|class="verdict"/.test(block.body)) continue;
    if (block.body.length > 900 || /\{\{subjects_table\}\}|<table/.test(block.body)) continue;
    out = (out.slice(0, block.start) + out.slice(block.end)).replace(/\n\s*\n\s*\n/g, "\n\n");
    removed += 1;
  }

  return removed
    ? { status: "repaired", html: out }
    : { status: "already-fixed" };
};

/** A {{if ...}} … {{endif}} block starting at `at`, depth-counted. */
const findBlockFrom = (html, at) => {
  const OPEN_RE = /\{\{if\s+[^}]+\}\}/g;
  const opening = html.slice(at).match(/^\{\{if\s+[^}]+\}\}/);
  if (!opening) return null;
  let depth = 1, cursor = at + opening[0].length;
  while (cursor < html.length) {
    OPEN_RE.lastIndex = cursor;
    const nextOpen  = OPEN_RE.exec(html);
    const nextClose = html.indexOf("{{endif}}", cursor);
    if (nextClose === -1) return null;
    if (nextOpen && nextOpen.index < nextClose) {
      depth += 1; cursor = nextOpen.index + nextOpen[0].length; continue;
    }
    depth -= 1; cursor = nextClose + "{{endif}}".length;
    if (depth === 0) return { start: at, end: cursor, body: html.slice(at, cursor) };
  }
  return null;
};

/**
 * The attendance and the remark panels that sat in the middle, taken off.
 *
 * Attendance is not part of a report card in this application any more, and
 * the two remark panels move to the foot of the document where they are
 * signed (see remarksBlockPass).
 *
 * Every shape this project ever wrote is removed by naming the block rather
 * than by matching a run of markup between two landmarks: the folded closing
 * card, the remarks row and the attendance figures it was folded from, and
 * the attendance heading with its table token. A sequence-matching regex
 * over that region worked until a template had one fewer closing tag than it
 * expected, and then it took a neighbouring block with it.
 */
const removeClosingPass = (html) => {
  let out = html, removed = 0;

  for (const tag of [`<div class="closing-section"`, `<div class="remarks-row"`,
                     `<div class="stat-row"`]) {
    let found;
    while ((found = elementAt(out, tag))) {
      out = out.slice(0, found.start) + out.slice(found.end);
      removed += 1;
    }
  }

  // The heading over the attendance table, in either language, and the token
  // the table itself was printed from.
  const heading = out.match(/[ \t]*<h3[^>]*>\s*(?:Attendance|Assiduit[ée])\s*<\/h3>\s*/i);
  if (heading) { out = out.replace(heading[0], ""); removed += 1; }
  if (out.includes("{{attendance_table}}")) {
    out = out.replace(/[ \t]*\{\{attendance_table\}\}[ \t]*\n?/g, "");
    removed += 1;
  }

  return removed
    ? { status: "repaired", html: out.replace(/\n\s*\n\s*\n/g, "\n\n") }
    : { status: "already-fixed" };
};

/**
 * What the staff wrote, put where it is signed: immediately before the
 * verification strip, after the panel. Same rules as the panel — inserted
 * where there is none, refreshed where an older copy sits, and left alone
 * when it is already current, so running the repair twice changes nothing.
 */
const remarksBlockPass = (html) => {
  const block  = REMARKS_BLOCK_HTML.trim();
  const markup = REMARKS_BLOCK_HTML
    .slice(REMARKS_BLOCK_HTML.indexOf(`<div class="remarks">`)).trim();
  const same   = (a, b) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

  const existing = elementAt(html, `<div class="remarks"`);
  if (existing) {
    if (same(html.slice(existing.start, existing.end), markup)) return { status: "already-fixed" };
    return {
      status: "repaired",
      html: html.slice(0, existing.start) + markup + html.slice(existing.end),
    };
  }

  const anchors = [`<div class="footer"`, `<div class="verify-strip"`, `{{qr_code}}`];
  const anchor = anchors.find((a) => html.includes(a));
  if (!anchor) return { status: "no-region", note: "no footer or verification strip to sit above" };

  const at = html.indexOf(anchor);
  const lineStart = html.lastIndexOf("\n", at) + 1;
  return {
    status: "repaired",
    html: html.slice(0, lineStart) + block + "\n\n  " + html.slice(lineStart),
  };
};

/** The template's CSS with the remarks' rules appended, or null if it has them. */
const repairRemarksCss = (css) => {
  if (typeof css !== "string") return null;
  if (/\.remark-box\b/.test(css)) return null;
  return css + nlJoin(REMARKS_BLOCK_CSS);
};

/**
 * The information panel, added above the verification strip.
 *
 * Where it goes: immediately before the footer, which is where the seeded
 * card carries the strip. A template whose footer a school has renamed or
 * rebuilt is matched on the strip itself, and one with neither is left alone
 * rather than guessed at.
 *
 * @returns {{ status: string, html?: string, note?: string }}
 *   repaired      | the panel was inserted
 *   already-fixed | the template carries it
 *   no-region     | nowhere identifiable to put it
 */
const infoPanelPass = (html) => {
  // The block as it goes in the first time (with the comment that introduces
  // it) and the element alone, which is what an existing panel is compared
  // against — a school's copy carries the comment already.
  const panel  = INFO_PANEL_HTML.trim();
  const markup = INFO_PANEL_HTML
    .slice(INFO_PANEL_HTML.indexOf(`<div class="info-panel">`)).trim();
  const same   = (a, b) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

  // A panel this project put there before, which may be an older shape of it.
  // Replaced rather than left alone, so a correction to the block reaches the
  // schools that already have one; identical markup is left untouched, which
  // is what makes running the repair twice a no-op.
  const existing = elementAt(html, `<div class="info-panel"`);
  if (existing) {
    if (same(html.slice(existing.start, existing.end), markup)) return { status: "already-fixed" };
    return {
      status: "repaired",
      html: html.slice(0, existing.start) + markup + html.slice(existing.end),
    };
  }

  // In order of preference: the footer that holds the strip, the strip
  // itself, or the bare QR token a template from before the strip carries.
  const anchors = [`<div class="footer"`, `<div class="verify-strip"`, `{{qr_code}}`];
  const anchor = anchors.find((a) => html.includes(a));
  if (!anchor) return { status: "no-region", note: "no footer or verification strip to sit above" };

  const at = html.indexOf(anchor);
  // Back to the start of the anchor's own line, so the panel is inserted
  // between lines rather than into the middle of one.
  const lineStart = html.lastIndexOf("\n", at) + 1;
  return {
    status: "repaired",
    html: html.slice(0, lineStart) + panel + "\n\n  " + html.slice(lineStart),
  };
};

/**
 * The template's CSS with the panel's rules on it, or null if they are
 * already the current ones.
 *
 * Unlike the other CSS repairs this one can REPLACE an earlier copy of its
 * own block rather than only append. The first version of these rules named
 * the panel's cells info-row / info-lbl / info-val, which is what the seeded
 * card's own student header is built from — so they restyled the header as
 * well as the panel. Appending the corrected rules would not undo that; the
 * stale block has to go.
 *
 * Only this project's own block is touched, matched by the comment it is
 * written with, and only up to the next top-level section comment.
 */
const PANEL_CSS_MARK = "/* ── The information panel ──";

const repairInfoPanelCss = (css) => {
  if (typeof css !== "string") return null;
  // The marker for the current rules: a class only they define.
  if (/\.panel-write\b/.test(css)) return null;

  let out = css;
  const at = out.indexOf(PANEL_CSS_MARK);
  if (at > -1) {
    const nextSection = out.indexOf("/* ──", at + PANEL_CSS_MARK.length);
    out = (out.slice(0, at) + (nextSection > -1 ? out.slice(nextSection) : "")).trimEnd();
  }
  return out + nlJoin(INFO_PANEL_CSS);
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

  // First the blocks that are leaving: the band over the marks and the
  // attendance-and-remarks card under them. The passes below rebuild those
  // regions when they find them, so they have to be gone before they run.
  const banner = removeBannerPass(out);
  if (banner.html) { out = banner.html; changes.push("banner-removed"); }

  const closing = removeClosingPass(out);
  if (closing.html) { out = closing.html; changes.push("attendance-removed"); }

  const header = headerPass(out);
  if (header.html) { out = header.html; changes.push("header"); }

  const strip = verifyStripPass(out);
  if (strip.html) { out = strip.html; changes.push("verify"); }

  const printable = printClassPass(out);
  if (printable.html) { out = printable.html; changes.push("print"); }

  const panel = infoPanelPass(out);
  if (panel.html) { out = panel.html; changes.push("panel"); }

  // Last, so it lands after the panel and immediately before the strip.
  const remarks = remarksBlockPass(out);
  if (remarks.html) { out = remarks.html; changes.push("remarks"); }

  if (!changes.length) {
    const note = banner.note || closing.note || header.note || strip.note;
    // These rules are CSS only, so a template whose markup is already
    // classed still needs them if its stylesheet lacks them.
    const cssChanges = [];
    let cssOnly = typeof css === "string" ? css : null;
    for (const [name, fix] of [["print", repairPrintCss], ["panel", repairInfoPanelCss], ["remarks", repairRemarksCss]]) {
      const next = fix(cssOnly);
      if (next) { cssOnly = next; cssChanges.push(name); }
    }
    if (cssChanges.length) {
      return { status: "repaired", changes: cssChanges, html: out, css: cssOnly };
    }
    return { status: "already-fixed", ...(note ? { note } : {}) };
  }

  // Each pass brings its own rules, and each declines if the stylesheet has
  // them already. Applied in order so the second sees the first's work.
  let nextCss = typeof css === "string" ? css : null;
  if (changes.includes("header")) nextCss = repairHeaderCss(nextCss) ?? nextCss;
  if (changes.includes("verify")) nextCss = repairVerifyCss(nextCss) ?? nextCss;
  nextCss = repairPrintCss(nextCss) ?? nextCss;
  nextCss = repairInfoPanelCss(nextCss) ?? nextCss;
  nextCss = repairRemarksCss(nextCss) ?? nextCss;

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

  /*
   * The facts the card must still state after a migration.
   *
   * Each is checked only where the template carries the block that states
   * it: a school's card that never printed the marks is its own business,
   * and the repair is answerable for what it changed, not for what was
   * never there. What it is always answerable for is the promotion, which
   * belongs to the annual card alone.
   */
  if (/PROMOTED TO THE NEXT CLASS/.test(sequence.html)) {
    problems.push("the sequence card shows a promotion it has not been given");
  }
  if (html.includes("{{subjects_table}}")) {
    if (!/PROMOTED TO THE NEXT CLASS/.test(annual.html)) {
      problems.push("the annual card lost its promotion decision");
    }
    if (!/PASSED/.test(sequence.html)) {
      problems.push("the card no longer states whether the pupil passed");
    }
    if (!/subjects-table/.test(sequence.html)) {
      problems.push("the card lost its marks");
    }
  }
  if (html.includes("remark-box") && !/Steady and careful work/.test(sequence.html)) {
    problems.push("the card lost the teacher's remark");
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
      expectRemark: result.changes.includes("layout") || result.changes.includes("figures"),
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
  repairHtml, findIsPassingBlock, verify,
  headerPass, repairHeaderCss, OLD_HEADER_RE,
  verifyStripPass, repairVerifyCss, BARE_QR_RE,
  printClassPass, repairPrintCss,
  removeBannerPass, removeClosingPass,
  infoPanelPass, repairInfoPanelCss,
  remarksBlockPass, repairRemarksCss,
  PRINT_CSS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
