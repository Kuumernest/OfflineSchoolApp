// backend/scripts/check-report-card.js
"use strict";

/**
 * Assert what a report card says, and what it must never say.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * "Promoted" was printing on a First Sequence report card. A promotion depends
 * on a whole year's work, so a sequence card cannot honestly carry one — it
 * tells a family something nobody has decided yet, on paper, in a document they
 * keep. The fix was small. The reason it needs a suite is that nothing about
 * the fix is visible from outside: a card with a promotion banner and a card
 * without one are both perfectly plausible documents, and the difference only
 * matters if you know which kind of card you are holding.
 *
 * So this pins the rule from both ends: the rule itself in shared/reportCard.js,
 * and the rendered HTML that the rule is supposed to govern. A change that
 * satisfies one and not the other fails here.
 *
 * No database. The rules are pure functions and the renderer takes a payload,
 * so the whole thing runs in milliseconds and can be read as a specification.
 *
 *   node scripts/check-report-card.js
 */

const { reportTypeFor, carriesPromotion, subjectRanking } =
  require("../../shared/reportCard");
const { DEFAULT_GRADES } = require("../../shared/gradeScale");
const GradingConfig = require("../src/db/models/GradingConfig");
const { renderReportCardHtml } = require("../src/services/reportHtml.service");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- §7: which card is this ---");

check("a promotion exam is the annual report",
  reportTypeFor({ type: "promotion_exam" }), "annual");
check("and stays annual even when it is bound to a sequence",
  reportTypeFor({ type: "promotion_exam", sequenceNumber: 6 }), "annual");
for (const n of [1, 2, 3, 4, 5, 6]) {
  check(`sequence ${n} is a sequence report`,
    reportTypeFor({ type: "test", sequenceNumber: n }), "sequence");
}
check("an exam bound to no sequence is a term report",
  reportTypeFor({ type: "test", sequenceNumber: null }), "term");
check("and so is one that says nothing at all",
  reportTypeFor({}), "term");
// The safe direction: an unknown shape must not become the annual report,
// because that is the only one that may carry a promotion.
check("an unrecognised type is a term report, not an annual one",
  reportTypeFor({ type: "something_new" }), "term");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- §8: only the annual report may carry a promotion ---");

check("annual may",            carriesPromotion("annual"), true);
check("sequence may not",      carriesPromotion("sequence"), false);
check("term may not",          carriesPromotion("term"), false);
check("nor may anything else", carriesPromotion("whatever"), false);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- §5: a pupil's place in each subject ---");

/**
 * Nine pupils, one subject. Two share the top mark, one was absent and one was
 * exempt — so seven sat it, and the two on 18 are both first.
 */
const scores = [
  { studentId: "s1", examSubjectId: "es1", score: 18 },
  { studentId: "s2", examSubjectId: "es1", score: 18 },
  { studentId: "s3", examSubjectId: "es1", score: 15 },
  { studentId: "s4", examSubjectId: "es1", score: 12 },
  { studentId: "s5", examSubjectId: "es1", score: 12 },
  { studentId: "s6", examSubjectId: "es1", score: 9  },
  { studentId: "s7", examSubjectId: "es1", score: 0  },
  { studentId: "s8", examSubjectId: "es1", score: null, isAbsent: true },
  { studentId: "s9", examSubjectId: "es1", score: null, isExempt: true },
];
const r = subjectRanking(scores);
const at = (id) => r.positionOf(scores.find((s) => s.studentId === id));

check("the denominator counts only the pupils who sat it", at("s1").total, 7);
check("joint first",        at("s1").position, 1);
check("and the other one",  at("s2").position, 1);
check("the next place skips the tie",  at("s3").position, 3);
check("joint fourth",       at("s4").position, 4);
check("and the other one",  at("s5").position, 4);
check("then sixth, not fifth", at("s6").position, 6);
check("a mark of zero is still a place", at("s7").position, 7);
check("an absent pupil has no place",    at("s8"), { position: null, total: null });
check("nor an exempt one",               at("s9"), { position: null, total: null });

// A pupil absent in one subject and present in another is ranked in the second
// and not the first, which is the whole point of ranking per subject.
const mixed = [
  { studentId: "a", examSubjectId: "maths", score: 14 },
  { studentId: "b", examSubjectId: "maths", score: 11 },
  { studentId: "a", examSubjectId: "eng",   score: null, isAbsent: true },
  { studentId: "b", examSubjectId: "eng",   score: 16 },
];
const rm = subjectRanking(mixed);
check("ranked in the subject they sat",
  rm.positionOf(mixed[0]), { position: 1, total: 2 });
check("and absent from the one they did not",
  rm.positionOf(mixed[2]), { position: null, total: null });
check("which leaves the other pupil alone in it",
  rm.positionOf(mixed[3]), { position: 1, total: 1 });

check("a subject nobody sat has no ranking",
  subjectRanking([]).positionOf({ examSubjectId: "x", score: 5 }),
  { position: null, total: null });

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- §3: the grading scale a school gets before it sets one ---");

check("eight bands, as specified", DEFAULT_GRADES.length, 8);
check("named in order",
  DEFAULT_GRADES.map((g) => g.grade),
  ["A+", "A", "B+", "B", "C+", "C", "D", "F"]);
check("the model's fallback is the same table, not a second one",
  GradingConfig.DEFAULT_GRADE_SCALE, DEFAULT_GRADES);
// The band that went missing when the settings screen served seven bands: a
// pupil on 11.5 was told "Average" where the school's table says otherwise.
check("11.5 is C+ / Above Average",
  [GradingConfig.findGradeBand(11.5).grade, GradingConfig.findGradeBand(11.5).remark],
  ["C+", "Above Average"]);
check("the bands tile with no gap: every half mark from 0 to 20 lands somewhere",
  Array.from({ length: 41 }, (_, i) => i / 2)
    .filter((m) => GradingConfig.findGradeBand(m) === null),
  []);
check("a perfect 20 is A+, not a fall-through to F",
  GradingConfig.findGradeBand(20).grade, "A+");
check("a school's own bands win over the shipped table",
  GradingConfig.findGradeBand(85, [{ grade: "A", minMark: 80, maxMark: 100 }]).grade, "A");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the rendered card ---");

const SUBJECTS = [
  { subjectName: "Mathematics", score: 18, maxScore: 20, normalizedMark: 18,
    grade: "A+", remark: "Excellent", subjectPosition: 2, subjectTotal: 35,
    coefficient: 1, isPassing: true },
  { subjectName: "Physics", score: 9, maxScore: 20, normalizedMark: 9,
    grade: "D", remark: "Below Average", subjectPosition: 18, subjectTotal: 35,
    coefficient: 1, isPassing: false },
];

const payload = (over = {}) => ({
  studentName: "Ada Ngu", admissionNo: "ENR-0012", className: "Form 3",
  academicYear: "2026/2027", gender: "Female", dateOfBirth: "2011-04-02",
  examName: "First Sequence", term: 1,
  reportType: "sequence", showGrades: true,
  subjects: SUBJECTS,
  summary: {
    average: 13.5, classPosition: 5, totalInClass: 35, isPassing: true,
    overallGrade: "B", overallRemark: "Fair",
    promotionStatus: "PROMOTED TO FORM 4",
  },
  computed: { totalCoefficients: 2, weightedAverage: 13.5, outOf: 20 },
  ...over,
});

const SCHOOL = {
  school: {
    name:  "Government Bilingual High School",
    logo:  "https://example.test/logo.png",
    motto: "Knowledge and Service",
  },
};

const render = (over) => renderReportCardHtml(payload(over), SCHOOL);

// ── §8, the bug this suite exists for ──────────────────────────────────────
// The same payload three ways: the promotion status is IN it every time, and
// only the annual card is allowed to print it.
for (const [type, shown] of [["sequence", false], ["term", false], ["annual", true]]) {
  check(`${type} card prints the promotion decision: ${shown}`,
    render({ reportType: type }).includes("PROMOTED TO FORM 4"), shown);
}

// ── §1 and §2: everything that identifies the pupil and the school ─────────
const card = render();
for (const [what, needle] of [
  ["school logo",    "example.test/logo.png"],
  ["school name",    "Government Bilingual High School"],
  ["school motto",   "Knowledge and Service"],
  ["student name",   "Ada Ngu"],
  ["enrollment no",  "ENR-0012"],
  ["gender",         "Female"],
  ["date of birth",  "2011-04-02"],
  ["class",          "Form 3"],
  ["academic year",  "2026/2027"],
]) check(`the card shows the ${what}`, card.includes(needle), true);

// ── §4 and §5 on the page ──────────────────────────────────────────────────
check("a subject's remark is on the card", card.includes("Below Average"), true);
check("and its place, as an ordinal over the pupils who sat it",
  /2nd\s*\/\s*35/.test(card), true);
check("the overall class position is there too",
  /5\s*\/\s*35/.test(card), true);

// ── §3: grades off ─────────────────────────────────────────────────────────
const headerCols = (html) =>
  [...((html.match(/<thead>[\s\S]*?<\/thead>/) || [""])[0])
    .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, "").trim());

check("with grades on, the table has a Grade column",
  headerCols(render()).includes("Grade"), true);
check("with grades off, it does not",
  headerCols(render({ showGrades: false })).includes("Grade"), false);
check("and the letter is gone from the body as well as the header",
  render({ showGrades: false }).replace(/<thead>[\s\S]*?<\/thead>/, "").includes("A+"),
  false);
// Turning grades off must not take the rest of the row with it.
const noGrades = render({ showGrades: false });
check("marks survive", /18\s*\/\s*20/.test(noGrades), true);
check("remarks survive", noGrades.includes("Below Average"), true);
check("positions survive", /2nd\s*\/\s*35/.test(noGrades), true);

// ── The promotion decision is not smuggled through a template token ────────
// A school's own template may contain {{promotion_status}}. The token is filled
// from the same rule, so a sequence card renders it empty rather than leaking.
const { toTemplateData } = require("../src/services/reportHtml.service");
for (const [type, expected] of [
  ["sequence", ""], ["term", ""], ["annual", "PROMOTED TO FORM 4"],
]) {
  check(`the {{promotion_status}} token on a ${type} card`,
    toTemplateData(payload({ reportType: type }), SCHOOL).performance.promotionStatus,
    expected);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
