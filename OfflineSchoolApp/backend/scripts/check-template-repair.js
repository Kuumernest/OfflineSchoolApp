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

const { repairHtml, verify } = require("./repair-report-templates");
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

const OLD_SEEDED = `<div class="school-header">{{school_logo}}{{school_name}}</div>
<div>{{student_name}} — {{class}}</div>
{{subjects_table}}
${OLD_BANNER}
<div class="footer">{{report_date}}</div>`;

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- what it repairs ---");

const repaired = repairHtml(OLD_SEEDED);
check("the shipped banner is recognised", repaired.status, "repaired");
check("PROMOTED is gone from the pass/fail banner",
  /PROMOTED/.test(repaired.html.split("{{if is_annual}}")[0]), false);
check("it says PASSED instead",
  repaired.html.includes("✓ PASSED &mdash; {{remark}}"), true);
check("and NOT PASSED for the other branch",
  repaired.html.includes("✗ NOT PASSED &mdash; {{remark}}"), true);
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
  verify(repairHtml(OLD_SEEDED).html, DEFAULT_TEMPLATE_CSS), []);

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
