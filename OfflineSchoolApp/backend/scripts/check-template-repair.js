// backend/scripts/check-template-repair.js
"use strict";

/**
 * Assert what the template repair will and will not touch.
 *
 * ── Why this is worth a suite of its own ──────────────────────────────────
 *
 * repair-report-templates.js edits documents that belong to schools. A bug in
 * it does not show up as a failing page: it shows up as somebody's own report
 * card layout quietly mangled, discovered weeks later when they next print.
 * The decision it makes per template — repair, leave alone, or refuse — is
 * therefore worth pinning harder than the bug it fixes.
 *
 * The cases that matter are the ones where it must NOT act: a template with no
 * banner, a banner that never mentioned promotion, a template already using the
 * new block, and one whose {{if}} does not close. Each of those is a school's
 * document and none of them is ours to rewrite.
 *
 * No database.
 *
 *   node scripts/check-template-repair.js
 */

const { repairHtml, verify,
        headerPass, repairHeaderCss,
        verifyStripPass, repairVerifyCss,
        printClassPass, repairPrintCss,
        removeBannerPass, removeClosingPass,
        infoPanelPass, repairInfoPanelCss,
        remarksBlockPass, repairRemarksCss } = require("./repair-report-templates");
const { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS } =
  require("../src/print/defaultReportTemplate");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
};

/** The banner exactly as this project used to ship it. */
const OLD_BANNER = [
  "  <!-- Pass / fail -->",
  "  {{if isPassing}}",
  "    <div class=\"pass-banner pass\">",
  "      ✓ PROMOTED &mdash; {{remark}}",
  "    </div>",
  "  {{else}}",
  "    <div class=\"pass-banner fail\">",
  "      ✗ NOT PROMOTED &mdash; {{remark}}",
  "    </div>",
  "  {{endif}}",
].join("\n");

/** The stylesheet as schools stored it: a full-width band, and no pill. */
const OLD_CSS = [
  "  .pass-banner {",
  "    text-align:    center;",
  "    font-size:     16px;",
  "    font-weight:   bold;",
  "    padding:       10px;",
  "    border-radius: 6px;",
  "    margin-bottom: 14px;",
  "  }",
  "  .pass-banner.pass { background: #d1fae5; color: #059669; }",
  "  .pass-banner.fail { background: #fee2e2; color: #dc2626; }",
].join("\n");

const OLD_SEEDED = `<div class="school-header">{{school_logo}}{{school_name}}</div>
<div>{{student_name}} — {{class}}</div>
{{subjects_table}}
${OLD_BANNER}
<div class="footer">{{report_date}}</div>`;

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the official header replaces the centred strip ---");

/** The header exactly as this project used to seed it. */
const OLD_HEADER = [
  "<div class=\"report-wrapper\">",
  "",
  "  <!-- School header -->",
  "  <div class=\"school-header\">",
  "    {{school_logo}}",
  "    <div class=\"school-name\">{{school_name}}</div>",
  "    <div class=\"school-motto\">{{school_motto}}</div>",
  "    <div class=\"school-contact\">{{school_address}} | {{school_phone}}</div>",
  "  </div>",
  "",
  "  <div class=\"report-title\">ACADEMIC REPORT CARD</div>",
  "  <p style=\"text-align:center;font-size:13px\">",
  "    {{term}} &mdash; {{academic_year}}",
  "  </p>",
  "",
  "  <!-- Student information -->",
  "  <div class=\"student-info-grid\">SCHOOL OWN CONTENT</div>",
].join("\n");

const headed = headerPass(OLD_HEADER);
check("the seeded header is recognised", headed.status, "repaired");
check("the English margin is there",
  /class="ministry-column">/.test(headed.html), true);
check("and the French one",
  /class="ministry-column french">/.test(headed.html), true);
check("the period is named rather than titled ACADEMIC REPORT CARD",
  headed.html.includes("{{report_title}}") &&
  !headed.html.includes("ACADEMIC REPORT CARD"), true);
check("a delegation the school has not filled in is gated, not printed blank",
  headed.html.includes("{{if header_regional_en}}"), true);
check("the rest of the school's document is untouched",
  headed.html.includes("SCHOOL OWN CONTENT"), true);
check("and everything before the header is byte-identical",
  headed.html.slice(0, OLD_HEADER.indexOf("  <div class=\"school-header\">")),
  OLD_HEADER.slice(0, OLD_HEADER.indexOf("  <div class=\"school-header\">")));
check("running it twice changes nothing",
  headerPass(headed.html).status, "already-fixed");

// A header is the most personal part of a school's document. Anything that is
// not the shape this project seeded is left exactly as the school made it.
check("a header a school built itself is not touched",
  headerPass('<div class="crest-row">{{school_logo}}<h1>{{school_name}}</h1></div>').status,
  "no-header");
check("nor one that has kept the shape but changed the fields",
  headerPass(OLD_HEADER.replace("{{school_motto}}", "{{school_slogan}}")).status,
  "no-header");
check("the header rules are appended to the school's own CSS",
  /\.ministry-column\.french/.test(repairHeaderCss(".x { color: red }")), true);
check("and a stylesheet that has them is not given them twice",
  repairHeaderCss(DEFAULT_TEMPLATE_CSS), null);

// All three passes over one template, which is what a school that saved the
// original layout actually needs.
const allThree = repairHtml(OLD_HEADER + OLD_BANNER, OLD_CSS);
check("all three faults are repaired in one pass",
  allThree.changes, ["banner-removed", "header"]);
check("and the stylesheet gains both sets of rules",
  /\.verdict-pill/.test(allThree.css) && /\.ministry-column/.test(allThree.css), true);
check("a template needing all three verifies",
  verify(allThree.html, allThree.css, { expectRemark: true, expectHeader: true }), []);

// The guard that matters for a header: one that lost a margin must be refused.
check("a header missing its French margin is refused",
  verify(headed.html.replace(/\{\{header_ministry_fr\}\}/g, "") + OLD_BANNER,
    DEFAULT_TEMPLATE_CSS, { expectHeader: true })
    .some((p) => /French ministry/.test(p)), true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the code goes beside the square ---");

/** The footer as it was seeded: the QR alone, in a wrapper of its own. */
const OLD_FOOTER = [
  '  <div class="footer">',
  '    <div>{{qr_code}}</div>',
  '    <div style="text-align:right">SCHOOL FOOTER TEXT</div>',
  '  </div>',
].join("\n");

const stripped = verifyStripPass(OLD_FOOTER);
check("the bare QR wrapper is recognised", stripped.status, "repaired");
check("the code a registrar types is now on the card",
  stripped.html.includes("{{verification_code}}"), true);
check("and where they type it",
  stripped.html.includes("{{verification_url}}"), true);
check("the square is still there",
  stripped.html.includes("{{qr_code}}"), true);
check("gated, so a card printed without verification shows no empty label",
  stripped.html.includes("{{if verification_code}}"), true);
check("the school's own footer text is untouched",
  stripped.html.includes("SCHOOL FOOTER TEXT"), true);
check("running it twice changes nothing",
  verifyStripPass(stripped.html).status, "already-fixed");

// A school that built its own strip around the square keeps it.
check("a strip a school built itself is not touched",
  verifyStripPass('<div class="mystrip">{{qr_code}} <b>Verify</b></div>').status,
  "no-qr");
check("nor a template with no QR at all",
  verifyStripPass("<div>{{report_date}}</div>").status, "no-qr");
check("the rules are appended to the school's own CSS",
  /\.verify-code/.test(repairVerifyCss(".x { color: red }")), true);
check("and a stylesheet that has them is not given them twice",
  repairVerifyCss(DEFAULT_TEMPLATE_CSS), null);

// All four faults on one template — a school that saved the original seed.
const allFour = repairHtml(OLD_HEADER + OLD_BANNER + OLD_FOOTER, OLD_CSS);
check("all four are repaired in one pass",
  allFour.changes, ["banner-removed", "header", "verify", "panel", "remarks"]);
check("and it verifies",
  verify(allFour.html, allFour.css,
    { expectRemark: true, expectHeader: true, expectVerify: true }), []);

// The guard: a strip rebuilt without the code is the fault, not the fix.
check("a strip with only the square is refused",
  verify('{{qr_code}}' + OLD_BANNER, DEFAULT_TEMPLATE_CSS, { expectVerify: true })
    .some((p) => /no code to read/.test(p)), true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- one sheet of A4 ---");

/*
 * Two of the blocks the print rules must compact are styled inline, and an
 * inline style beats a stylesheet — so the pass adds the class names the rules
 * hook onto and leaves the inline styles alone, which is what keeps the screen
 * rendering identical.
 */
const INLINE_ROWS = [
  '  <div style="display:flex;gap:12px;margin-bottom:16px">',
  '    <div>Days Open: {{days_open}}</div>',
  '  </div>',
  '  <div style="display:flex;gap:16px;margin-bottom:16px">',
  '    <div class="remarks-section" style="flex:1">',
  '      <div style="margin-top:24px">',
  '        <span class="signature-line">{{class_teacher}}</span>',
  '      </div>',
  '    </div>',
  '  </div>',
].join("\n");

const printed = printClassPass(INLINE_ROWS);
check("the inline rows are recognised", printed.status, "repaired");
check("the attendance strip gets its class",
  printed.html.includes('<div class="stat-row" style="display:flex;gap:12px'), true);
check("the remarks row gets its class",
  printed.html.includes('<div class="remarks-row" style="display:flex;gap:16px'), true);
check("and the signature block",
  printed.html.includes('<div class="signature-row" style="margin-top:24px">'), true);
// The whole point: the screen must look exactly as it did.
check("every inline style is left exactly where it was",
  printed.html.includes('style="display:flex;gap:12px;margin-bottom:16px"') &&
  printed.html.includes('style="display:flex;gap:16px;margin-bottom:16px"') &&
  printed.html.includes('style="margin-top:24px"'), true);
check("running it twice changes nothing",
  printClassPass(printed.html).status, "already-fixed");
check("a template with neither row is left alone",
  printClassPass("<div>{{student_name}}</div>").status, "no-rows");

check("the print rules are appended to a stylesheet without them",
  /@page/.test(repairPrintCss(".x { color: red }")), true);
check("and a stylesheet that has @page is not given a second one",
  repairPrintCss(DEFAULT_TEMPLATE_CSS), null);
check("A4 and a 9mm margin",
  /@page\s*\{[^}]*size:\s*A4[^}]*margin:\s*9mm/.test(repairPrintCss(".x{}")), true);
// A block split down the fold is how a signature ends up alone on page two.
check("blocks are told not to break across the fold",
  /break-inside:\s*avoid/.test(repairPrintCss(".x{}")), true);
check("and the table head repeats on a second page",
  /display:\s*table-header-group/.test(repairPrintCss(".x{}")), true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the information panel reaches a template saved without it ---");

const SAVED_CARD = [
  '<div class="report-wrapper">',
  '  <h3>Academic Performance</h3>',
  '  {{subjects_table}}',
  '  <div class="footer">',
  '    <div class="verify-strip">{{qr_code}}</div>',
  '    <div>Next Term Begins: {{next_term_date}}</div>',
  '  </div>',
  '</div>',
].join("\n");

const panelled = infoPanelPass(SAVED_CARD);
check("a saved card is given the panel", panelled.status, "repaired");
check("  above the verification strip, not below it",
  panelled.html.indexOf("info-panel") < panelled.html.indexOf("verify-strip"), true);
check("  and below the marks it summarises",
  panelled.html.indexOf("{{subjects_table}}") < panelled.html.indexOf("info-panel"), true);
check("  with the school's own markup untouched",
  ["{{subjects_table}}", "{{qr_code}}", "{{next_term_date}}", "Academic Performance"]
    .every((bit) => panelled.html.includes(bit)), true);
check("  carrying every figure it is meant to",
  ["{{class_average}}", "{{class_best}}", "{{class_lowest}}",
   "{{position}}", "{{total_students}}", "{{average}}", "{{grade}}"]
    .every((token) => panelled.html.includes(token)), true);
check("  and no attendance, which the card no longer carries",
  ["{{days_absent}}", "{{absences_excused}}", "{{late_coming}}"]
    .some((token) => panelled.html.includes(token)), false);
check("  and the conduct rows empty, for the class teacher to write in",
  (panelled.html.match(/class="panel-write"/g) || []).length, 3);
check("running it twice adds one panel, not two",
  [infoPanelPass(panelled.html).status,
   (infoPanelPass(panelled.html).html ?? panelled.html).split('class="info-panel"').length - 1],
  ["already-fixed", 1]);
check("the seeded card already carries it", infoPanelPass(DEFAULT_TEMPLATE_HTML).status, "already-fixed");
check("a card with no footer and no strip is left alone",
  infoPanelPass("<div>{{subjects_table}}</div>").status, "no-region");

// A template from before the strip existed, which carries the bare token.
const bareQr = infoPanelPass('<div>{{subjects_table}}</div>\n<div>{{qr_code}}</div>');
check("a card with only the bare QR token still gets the panel above it",
  [bareQr.status, bareQr.html?.indexOf("info-panel") < bareQr.html?.indexOf("{{qr_code}}")], ["repaired", true]);

// The first version of these rules named the panel's cells after the
// seeded card's own student header, and restyled it by accident. A sheet
// carrying that version has it taken out, not added to.
const STALE_PANEL_CSS = [
  ".info-row { display: flex; }",
  "",
  "  /* ── The information panel ──────────────────────────",
  "     the version that collided */",
  "  .info-panel { display: grid; }",
  "  .info-row { justify-content: space-between; }",
  "  .info-val { font-weight: bold; white-space: nowrap; }",
].join("\n");
const freshened = repairInfoPanelCss(STALE_PANEL_CSS);
check("a sheet with the colliding rules has them replaced, not doubled",
  [freshened != null,
   (freshened ?? "").includes("the version that collided"),
   /\.panel-write\b/.test(freshened ?? "")],
  [true, false, true]);
check("  and the school's own rules before them are kept",
  (freshened ?? "").startsWith(".info-row { display: flex; }"), true);
check("  running it again changes nothing", repairInfoPanelCss(freshened), null);

check("the panel's rules are appended to a sheet without them",
  /\.info-panel\b/.test(repairInfoPanelCss(".x { color: red }") ?? ""), true);
check("  and not to the seeded sheet, which writes them itself",
  repairInfoPanelCss(DEFAULT_TEMPLATE_CSS), null);

// End to end, on a whole saved card: the panel and its rules arrive together
// and the result still renders.
const panelRepair = repairHtml(SAVED_CARD, ".x { color: red }");
check("through the whole repair: markup and stylesheet together",
  [panelRepair.status, panelRepair.changes.includes("panel"), /\.info-panel\b/.test(panelRepair.css)],
  ["repaired", true, true]);
check("  and running the repair again changes nothing",
  repairHtml(panelRepair.html, panelRepair.css).status, "already-fixed");

console.log("--- the band over the marks comes off ---");

/** A card at the arrangement this project last wrote. */
const FOLDED_CARD = [
  '<div class="report-wrapper">',
  '  {{subjects_table}}',
  '  <div class="summary-section">',
  '    <div class="summary-outcome">{{if isPassing}}<div class="verdict-pill pass">PASSED</div>{{else}}<div class="verdict-pill fail">NOT PASSED</div>{{endif}}</div>',
  '    <div class="summary-performance"><div class="perf-grade">{{grade}}</div></div>',
  '  </div>',
  '  {{if is_annual}}{{if promotion_status}}<div class="pass-banner pass">{{promotion_status}}</div>{{endif}}{{endif}}',
  '  <div class="closing-section"><div class="closing-absences">{{days_absent}}</div>',
  '    <div class="remarks-section"><p>{{teacher_comment}}</p></div></div>',
  '  <div class="footer"><div class="verify-strip">{{qr_code}}</div></div>',
  '</div>',
].join("\n");

/** And one at the arrangement before that: five separate bands. */
const FIVE_BANDS = [
  '<div class="report-wrapper">',
  '  {{subjects_table}}',
  '  {{if isPassing}}<div class="pass-banner pass">PASSED &mdash; {{remark}}</div>',
  '  {{else}}<div class="pass-banner fail">FAILED &mdash; {{remark}}</div>{{endif}}',
  '  <h3>Attendance</h3>',
  '  {{attendance_table}}',
  '  <div class="stat-row"><div>Days Open: {{days_open}}</div></div>',
  '  <div class="remarks-row"><div class="remarks-section"><p>{{teacher_comment}}</p></div>',
  '    <div class="remarks-section"><p>{{principal_comment}}</p></div></div>',
  '  <div class="footer">{{qr_code}}</div>',
  '</div>',
].join("\n");

const debanded = removeBannerPass(FOLDED_CARD);
check("the folded band is taken off", debanded.status, "repaired");
check("  with nothing put in its place",
  [/summary-section/.test(debanded.html), /verdict-pill/.test(debanded.html),
   /pass-banner/.test(debanded.html)], [false, false, false]);
check("  and the marks and the footer left alone",
  ["{{subjects_table}}", "{{qr_code}}"].every((bit) => debanded.html.includes(bit)), true);
check("the original banner is taken off too",
  [removeBannerPass(FIVE_BANDS).status,
   /pass-banner/.test(removeBannerPass(FIVE_BANDS).html)], ["repaired", false]);
check("running it twice changes nothing",
  removeBannerPass(debanded.html).status, "already-fixed");
check("the current seed has no band to remove",
  removeBannerPass(DEFAULT_TEMPLATE_HTML).status, "already-fixed");
check("a school's own block that merely mentions the decision is left alone",
  removeBannerPass('<div>{{if is_annual}}<p>{{promotion_status}}</p>{{endif}}</div>').status,
  "already-fixed");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- attendance and the middle remark panels come off ---");

const declosed = removeClosingPass(FOLDED_CARD);
check("the folded closing card is taken off", declosed.status, "repaired");
check("  absences and the remark panel with it",
  [/closing-section/.test(declosed.html), /closing-absences/.test(declosed.html)], [false, false]);
const debanded5 = removeClosingPass(FIVE_BANDS);
check("the bands it was folded from, too", debanded5.status, "repaired");
check("  the attendance heading, its table and the figures",
  [/Attendance<\/h3>/.test(debanded5.html), debanded5.html.includes("{{attendance_table}}"),
   /stat-row/.test(debanded5.html)], [false, false, false]);
check("  and the two remark panels that sat in the middle",
  /remarks-row/.test(debanded5.html), false);
check("  while the marks stay where they are",
  debanded5.html.includes("{{subjects_table}}"), true);
check("running it twice changes nothing",
  removeClosingPass(declosed.html).status, "already-fixed");
check("the current seed has no attendance to remove",
  removeClosingPass(DEFAULT_TEMPLATE_HTML).status, "already-fixed");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the remarks are put back at the foot of the card ---");

const bandsOff = removeClosingPass(removeBannerPass(FIVE_BANDS).html).html;
const remarked = remarksBlockPass(bandsOff);
check("a card without them is given the pair", remarked.status, "repaired");
check("  above the verification strip",
  remarked.html.indexOf("remark-box") < remarked.html.indexOf("{{qr_code}}"), true);
check("  and below the marks",
  remarked.html.indexOf("{{subjects_table}}") < remarked.html.indexOf("remark-box"), true);
check("  each labelled and signed, in the reader's language",
  ["{{label_teacher_remark}}", "{{teacher_comment}}", "{{class_teacher}}",
   "{{label_principal_remark}}", "{{principal_comment}}", "{{principal_name}}"]
    .every((token) => remarked.html.includes(token)), true);
check("running it twice adds one pair, not two",
  [remarksBlockPass(remarked.html).status,
   remarked.html.split('<div class="remarks">').length - 1], ["already-fixed", 1]);
check("the current seed already carries them",
  remarksBlockPass(DEFAULT_TEMPLATE_HTML).status, "already-fixed");
check("their rules are appended to a sheet without them",
  /\.remark-box\b/.test(repairRemarksCss(".x { color: red }") ?? ""), true);
check("  and not to the seeded sheet, which writes them itself",
  repairRemarksCss(DEFAULT_TEMPLATE_CSS), null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- a saved card, through the whole repair ---");

const migrated = repairHtml(FIVE_BANDS, ".x { color: red }");
check("every change the card needed, in one pass",
  [migrated.status, migrated.changes.includes("banner-removed"),
   migrated.changes.includes("attendance-removed"), migrated.changes.includes("panel"),
   migrated.changes.includes("remarks")], ["repaired", true, true, true, true]);
check("  the order it leaves behind: marks, panel, remarks, footer",
  [migrated.html.indexOf("{{subjects_table}}") < migrated.html.indexOf("info-panel"),
   migrated.html.indexOf("info-panel") < migrated.html.indexOf("remark-box"),
   migrated.html.indexOf("remark-box") < migrated.html.indexOf("{{qr_code}}")],
  [true, true, true]);
check("  the school's own rules kept, with the new ones after them",
  [migrated.css.startsWith(".x { color: red }"), /\.info-panel\b/.test(migrated.css),
   /\.remark-box\b/.test(migrated.css)], [true, true, true]);
check("  and running it again changes nothing",
  repairHtml(migrated.html, migrated.css).status, "already-fixed");
check("the seeded card needs no migration at all",
  repairHtml(DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS).status, "already-fixed");

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
console.log("--- what it refuses to touch ---");

// A card a school arranged itself: the passes act on the blocks this project
// wrote, and on nothing else.
const OWN_DESIGN = [
  '<div class="my-own-card">',
  '  <table class="my-marks">{{subjects_table}}</table>',
  '  <aside class="my-notes">{{teacher_comment}}</aside>',
  '</div>',
].join("\n");
check("no band, no attendance, nothing of ours to remove",
  [removeBannerPass(OWN_DESIGN).status, removeClosingPass(OWN_DESIGN).status],
  ["already-fixed", "already-fixed"]);
check("and nowhere it can identify to put the panel or the remarks",
  [infoPanelPass(OWN_DESIGN).status, remarksBlockPass(OWN_DESIGN).status],
  ["no-region", "no-region"]);
check("  so the whole repair reports it rather than guessing",
  repairHtml(OWN_DESIGN, ".x{}").status, "repaired");
check("  and leaves the school's own markup exactly as it was",
  repairHtml(OWN_DESIGN, ".x{}").html, OWN_DESIGN);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- and it proves the result before writing it ---");

check("the current seed passes verification",
  verify(DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS), []);
check("a migrated old template passes too",
  verify(migrated.html, migrated.css), []);

// The risk of moving markup at all: tidying the card by losing the words.
// A template carrying the remarks block whose text no longer renders is
// refused rather than written.
check("a remarks block that prints nothing is refused",
  verify('{{subjects_table}}<div class="remarks"><div class="remark-box">' +
         '<div class="remark-body"></div></div></div>', DEFAULT_TEMPLATE_CSS)
    .some((p) => /lost the teacher's remark/.test(p)), true);

// The guard that matters: a template that no longer parses must be refused.
const broken = verify("{{each subjects}} unterminated", DEFAULT_TEMPLATE_CSS);
check("a template the engine cannot parse is refused", broken.length > 0, true);

// A template that states a promotion in its own words, outside any gate, must
// be refused — that is the fault being repaired, and a repair that left it in
// place would be no repair. Note that {{promotion_status}} alone CANNOT leak:
// toTemplateData already empties it on anything but an annual card, so the
// token is safe and only literal text is dangerous.
const leaky = verify(
  "PROMOTED TO THE NEXT CLASS{{if isPassing}}PASSED{{endif}}", DEFAULT_TEMPLATE_CSS);
check("a template stating a promotion in its own words is refused",
  leaky.some((p) => /shows a promotion it has not been given/.test(p)), true);
check("while the token on its own is gated upstream and renders empty",
  verify("{{promotion_status}}{{if isPassing}}PASSED{{endif}}", DEFAULT_TEMPLATE_CSS)
    .some((p) => /shows a promotion it has not been given/.test(p)),
  false);

// And a card that prints its marks but has lost the council's decision from
// the annual version of itself. Checked only where the marks are, because a
// fragment that never carried them is not a card the repair can judge.
const noDecision = verify("{{subjects_table}}{{if isPassing}}PASSED{{endif}}",
  DEFAULT_TEMPLATE_CSS);
check("a card whose annual version states no decision is refused",
  noDecision.some((p) => /annual card lost its promotion/.test(p)), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
