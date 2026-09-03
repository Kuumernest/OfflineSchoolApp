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

const { repairHtml, verify, layoutPass, repairCss,
        headerPass, repairHeaderCss,
        verifyStripPass, repairVerifyCss,
        printClassPass, repairPrintCss } = require("./repair-report-templates");
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
console.log("--- what it repairs ---");

const repaired = repairHtml(OLD_SEEDED, OLD_CSS);
check("the shipped banner is recognised", repaired.status, "repaired");
check("PROMOTED is gone from the pass/fail banner",
  /PROMOTED/.test(repaired.html.split("{{if is_annual}}")[0]), false);
check("it says PASSED instead",
  repaired.html.includes('<div class="verdict-pill pass">✓ PASSED</div>'), true);
check("and NOT PASSED for the other branch",
  repaired.html.includes('<div class="verdict-pill fail">✗ NOT PASSED</div>'), true);
check("both passes ran over the one template",
  repaired.changes, ["promotion", "layout"]);
check("the annual-only promotion block is added",
  repaired.html.includes("{{if is_annual}}"), true);
check("gated on there being a decision at all",
  repaired.html.includes("{{if promotion_status}}"), true);

// The whole point of patching rather than reseeding.
check("the school's own header survives",
  repaired.html.includes('<div class="school-header">{{school_logo}}{{school_name}}</div>'), true);
check("and its footer",
  repaired.html.includes('<div class="footer">{{report_date}}</div>'), true);
check("and everything before the banner is byte-identical",
  repaired.html.slice(0, OLD_SEEDED.indexOf("  <!-- Pass / fail -->")),
  OLD_SEEDED.slice(0, OLD_SEEDED.indexOf("  <!-- Pass / fail -->")));

// A banner with another conditional inside it: a lazy regex would stop at the
// inner {{endif}} and leave half the block rewritten.
const nested = "HEAD{{if isPassing}}{{if grade}}A{{endif}} PROMOTED{{else}}NOT PROMOTED{{endif}}TAIL";
const nestedFixed = repairHtml(nested);
check("a nested {{if}} does not truncate the block", nestedFixed.status, "repaired");
check("the text after the block is kept",
  nestedFixed.html.endsWith("TAIL"), true);
check("the inner conditional is intact",
  nestedFixed.html.includes("{{if grade}}A{{endif}}"), true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the verdict comes off its own row ---");

// The fault: a full-width band carrying the remark inside it, which wrapped to
// several lines and pushed the verification code off the page.
check("the band is gone",
  /class="pass-banner (pass|fail)">\s*[✓✗]/.test(repaired.html), false);
check("the remark moved out of it and beside the pill",
  repaired.html.includes(
    '{{if remark}}<div class="verdict-remark">{{remark}}</div>{{endif}}'), true);
check("and is gated, so an empty remark leaves no empty box",
  repaired.html.split("verdict-remark").length - 1, 2);
check("the promotion block keeps its own full-width band",
  repaired.html.split("{{if is_annual}}")[1].includes('class="pass-banner pass"'),
  true);

// The styles the new markup needs, added only when they are missing.
check("the rules are appended to the school's own CSS",
  /\.verdict-pill\.fail/.test(repaired.css), true);
check("and its own rules are kept",
  repaired.css.startsWith(OLD_CSS), true);
// The current seed already carries them, which is the case that must not be
// appended to twice — a second copy would win on order and could differ.
check("a stylesheet already carrying them is not given them twice",
  repairCss(DEFAULT_TEMPLATE_CSS), null);
check("and a template with no stylesheet of its own is not invented one",
  repairCss(undefined), null);

// A band a school built itself, with markup inside, is its design to keep.
const ownMarkup =
  '{{if isPassing}}<div class="pass-banner pass"><b>✓ PASSED</b> &mdash; {{remark}}</div>{{endif}}';
check("a band with markup of its own is left alone",
  layoutPass(ownMarkup).status, "already-fixed");

// And a band that never carried the remark has nothing to unstack.
check("a band without the remark is left alone",
  layoutPass('{{if isPassing}}<div class="pass-banner pass">✓ PASSED</div>{{endif}}').status,
  "already-fixed");
check("a template repaired for the promotion months ago still gets the layout",
  layoutPass(
    '{{if isPassing}}<div class="pass-banner pass">✓ PASSED &mdash; {{remark}}</div>{{endif}}' +
    '{{if is_annual}}{{if promotion_status}}x{{endif}}{{endif}}').status,
  "repaired");

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
  allThree.changes, ["promotion", "layout", "header"]);
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
  allFour.changes, ["promotion", "layout", "header", "verify"]);
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
console.log("--- what it refuses to touch ---");

check("a template already using the new block",
  repairHtml("x {{if is_annual}}{{if promotion_status}}y{{endif}}{{endif}}").status,
  "already-fixed");
check("the current seed, which is already correct",
  repairHtml(DEFAULT_TEMPLATE_HTML).status, "already-fixed");
check("a template with no pass/fail banner",
  repairHtml("<div>{{student_name}}</div>").status, "no-banner");
check("an empty template",
  repairHtml("").status, "no-banner");
check("a banner that never mentioned promotion",
  repairHtml("{{if isPassing}}Well done{{else}}Try again{{endif}}").status,
  "no-promotion");
check("an {{if}} that never closes is reported, not guessed at",
  repairHtml("{{if isPassing}} PROMOTED").status, "unbalanced");
check("and nothing is returned to write in that case",
  repairHtml("{{if isPassing}} PROMOTED").html, undefined);

// Case matters: only the banner's own wording is rewritten, and only inside it.
const promoElsewhere =
  "<div>Council decision: PROMOTED</div>{{if isPassing}}Passed{{else}}Failed{{endif}}";
check("PROMOTED outside the banner is left alone",
  repairHtml(promoElsewhere).status, "no-promotion");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- and it proves the result before writing it ---");

check("the current seed passes verification",
  verify(DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS), []);
check("a repaired old template passes too",
  verify(repaired.html, repaired.css, { expectRemark: true }), []);

// The risk of rearranging markup at all: tidying the row by losing the words.
check("a rearrangement that dropped the remark is refused",
  verify('{{if isPassing}}<div class="verdict-pill pass">✓ PASSED</div>{{endif}}' +
         '{{if is_annual}}{{if promotion_status}}{{promotion_status}}{{endif}}{{endif}}',
    DEFAULT_TEMPLATE_CSS, { expectRemark: true })
    .some((p) => /dropped the remark/.test(p)), true);

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
  leaky.some((p) => /sequence card still shows a promotion/.test(p)), true);
check("while the token on its own is gated upstream and renders empty",
  verify("{{promotion_status}}{{if isPassing}}PASSED{{endif}}", DEFAULT_TEMPLATE_CSS)
    .some((p) => /sequence card still shows a promotion/.test(p)),
  false);

// And one that has lost the decision from the annual card.
const noDecision = verify("{{if isPassing}}PASSED{{else}}NOT PASSED{{endif}}",
  DEFAULT_TEMPLATE_CSS);
check("a template with no promotion at all is refused for the annual card",
  noDecision.some((p) => /annual card lost its promotion/.test(p)), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
