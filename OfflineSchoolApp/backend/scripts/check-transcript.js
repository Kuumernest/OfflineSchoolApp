// backend/scripts/check-transcript.js
"use strict";

/**
 * The academic transcript's wording (2026-10-30), in English and French:
 *
 *   - a year's rows name their sequence: "1st Term · Sequence 1", not two
 *     rows that both say "Term 1";
 *   - stored values as words: Female / Féminin, Approved / Admis(e);
 *   - dates DD/MM/YYYY;
 *   - averages out of twenty, and the overall average says so ("/20").
 *
 *   node scripts/check-transcript.js
 */

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const { buildTranscriptHtml, dayOf } = require("../src/print/transcript");
const { labelsFor } = require("../src/print/labels");

const data = {
  school: { name: "ZZ Test School" },
  student: { name: "ZZ Test Pupil", enrollmentNo: "ZZ-2026-001", gender: "female",
    dateOfBirth: "2011-04-02", status: "approved" },
  years: [{ academicYear: "2026/2027", className: "ZZ Test Form 1", outcome: "promoted", terms: [
    { term: "Term 1", sequenceNumber: 1, average: 12.4, overallGrade: "B", isPassing: true, subjects: [] },
    { term: "Term 1", sequenceNumber: 2, average: 13.6, overallGrade: "B", isPassing: true, subjects: [] },
  ] }],
  overall: { yearsOnRecord: 1, termsOnRecord: 2, average: 13 },
};
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (lang) => text(buildTranscriptHtml({ data, labels: labelsFor(lang), printedOn: "30/10/2026", verify: null }));

const en = render("en"), fr = render("fr");
check("English: the two Term 1 rows name their sequence",
  [en.includes("1st Term · Sequence 1"), en.includes("1st Term · Sequence 2")], [true, true]);
check("French: the same rows", [fr.includes("1er trimestre · Séquence 1"), fr.includes("1er trimestre · Séquence 2")], [true, true]);
check("English: Female, Approved, Promoted — words, capitalised",
  [/Gender Female/.test(en), /Status Approved/.test(en), en.includes("Promoted"), /\bfemale\b|\bapproved\b/.test(en)],
  [true, true, true, false]);
check("French: Féminin, Admis(e)", [fr.includes("Féminin"), fr.includes("Admis(e)")], [true, true]);
check("date of birth DD/MM/YYYY", [en.includes("02/04/2011"), fr.includes("02/04/2011"), en.includes("2011-04-02")], [true, true, false]);
check("overall average out of twenty", [en.includes("Overall average 13 /20"), fr.includes("Moyenne générale 13 /20")], [true, true]);
check("the averages column says /20", [en.includes("Average /20"), fr.includes("Moyenne /20")], [true, true]);
check("dayOf: a date, a datetime and nothing", [dayOf("2011-04-02"), dayOf(new Date(2026, 9, 30)), dayOf(null)], ["02/04/2011", "30/10/2026", ""]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
