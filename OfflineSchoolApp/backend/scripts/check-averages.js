// backend/scripts/check-averages.js
"use strict";

/**
 * The one average (shared/averages.js), worked by hand. Pure: no database.
 *
 *   average = sum(subject mark /20 x coefficient)
 *             / sum(coefficients of the subjects with a mark)
 *
 * Coefficients always applied; a subject with no mark is removed with its
 * coefficient; a subject's term mark combines its sequence marks, each
 * sequence its paper and CA, level by level.
 *
 *   node scripts/check-averages.js
 */

const {
  markOutOf20, combineMarks, combineByLevel, subjectMarksByStudent, coefficientAverage, averageOfSubjects,
} = require("../../shared/averages");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

console.log("--- the card's TOTAL row is the average ---");
// Yong Angel's card: TOTAL 548 over 38 coefficients. 548 / 38 = 14.421 → 14.42,
// not the 14.5 the mean of her two sequence averages gave.
check("548 / 38 = 14.42", coefficientAverage([
  { mark: 15, coefficient: 10 },   // 150
  { mark: 14, coefficient: 12 },   // 168
  { mark: 16, coefficient: 8 },    // 128
  { mark: 12.75, coefficient: 8 }, // 102
]), { totalCoefficients: 38, totalWeighted: 548, average: 14.42 });

console.log("--- an absent subject goes with its coefficient ---");
// Maths 15 (coef 4), English absent (coef 3), French 10 (coef 2):
// (60 + 20) / 6 = 13.33 — not (60 + 0 + 20) / 9 = 8.89.
check("absent removed", coefficientAverage([
  { mark: 15, coefficient: 4 },
  { mark: null, coefficient: 3, isAbsent: true },
  { mark: 10, coefficient: 2 },
]).average, 13.33);
check("exempt removed", coefficientAverage([
  { mark: 15, coefficient: 4 }, { mark: 9, coefficient: 3, isExempt: true },
]).average, 15);
check("an entered 0 is a 0", coefficientAverage([
  { mark: 15, coefficient: 4 }, { mark: 0, coefficient: 4 },
]).average, 7.5);
check("no mark at all: no average", coefficientAverage([{ mark: null, coefficient: 2 }]).average, null);
check("card rows read as `score`", coefficientAverage([{ score: 12, coefficient: 2 }, { score: 18, coefficient: 1 }]).average, 14);

console.log("--- marks on /20 ---");
check("35/50 → 14", markOutOf20({ score: 35, maxScore: 50 }), 14);
check("absent → none", markOutOf20({ score: 12, maxScore: 20, isAbsent: true }), null);
check("not entered → none", markOutOf20({ score: null, maxScore: 20 }), null);

console.log("--- combining a subject's marks, level by level ---");
check("weights renormalise over what is there", combineMarks([{ mark: 12, weight: 50 }, { mark: null, weight: 50 }]), 12);
// One term, two sequences 50/50, CA 40 / paper 60.
//   S1 Maths: CA 16, paper 15 → 0.4·16 + 0.6·15 = 15.4
//   S2 Maths: no CA, paper 14 → 14 (the paper alone, still half the term)
//   term = (15.4 + 14) / 2 = 14.7
// A flat pass gives S2 only 0.6 of S1's share: (16·20 + 15·30 + 14·30)/80 = 14.88.
const s1 = { sequence: "1:1", sequenceWeight: 50, term: 1, termWeight: 1 };
const s2 = { sequence: "1:2", sequenceWeight: 50, term: 1, termWeight: 1 };
check("a missing CA does not shrink its sequence's share of the term", combineByLevel([
  { ...s1, mark: 16, inSequence: 0.4 }, { ...s1, mark: 15, inSequence: 0.6 },
  { ...s2, mark: 14, inSequence: 0.6 },
]), 14.7);
// A year: term 1 at 14.7 (above), term 2 at 12, term 3 at 10; weights 1/1/2.
//   (14.7 + 12 + 2·10) / 4 = 11.675
check("terms combine by the term weights", combineByLevel([
  { ...s1, mark: 16, inSequence: 0.4 }, { ...s1, mark: 15, inSequence: 0.6 }, { ...s2, mark: 14, inSequence: 0.6 },
  { sequence: "2:3", sequenceWeight: 50, term: 2, termWeight: 1, mark: 12, inSequence: 1 },
  { sequence: "3:5", sequenceWeight: 50, term: 3, termWeight: 2, mark: 10, inSequence: 1 },
]), 11.675);
check("CA off: a CA counts nothing", combineByLevel([
  { ...s1, mark: 20, inSequence: 0 }, { ...s1, mark: 10, inSequence: 1 },
]), 10);

console.log("--- one pupil's term, from the marks ---");
// Sequence 1: Maths (coef 2) 15, English (coef 1) 9. Sequence 2: Maths 17,
// English absent. Term Maths (15 + 17)/2 = 16, English 9 (sequence 1 only).
//   term average (2·16 + 9) / 3 = 13.67.
// The mean of the sequence averages would be ((2·15 + 9)/3 + 17)/2 = 15 — the
// English absence in sequence 2 counted twice over.
const place = { e1: { sequence: "1:1", sequenceWeight: 50, term: 1, termWeight: 1, inSequence: 1 },
                e2: { sequence: "1:2", sequenceWeight: 50, term: 1, termWeight: 1, inSequence: 1 } };
const { byStudent } = subjectMarksByStudent({
  scores: [
    { studentId: "p", examId: "e1", examSubjectId: "e1-m", score: 15, maxScore: 20 },
    { studentId: "p", examId: "e1", examSubjectId: "e1-e", score: 9,  maxScore: 20 },
    { studentId: "p", examId: "e2", examSubjectId: "e2-m", score: 17, maxScore: 20 },
    { studentId: "p", examId: "e2", examSubjectId: "e2-e", score: null, maxScore: 20, isAbsent: true },
    { studentId: "gone", examId: "e1", examSubjectId: "e1-m", score: 20, maxScore: 20 },
  ],
  examSubjects: [
    { _id: "e1-m", subjectId: "m", subjectName: "Maths", weight: 200, maxScore: 20 },
    { _id: "e1-e", subjectId: "e", subjectName: "English", weight: 100, maxScore: 20 },
    { _id: "e2-m", subjectId: "m", subjectName: "Maths", weight: 200, maxScore: 20 },
    { _id: "e2-e", subjectId: "e", subjectName: "English", weight: 100, maxScore: 20 },
  ],
  placeOf: (examId) => place[examId],
  coefficientOf: (es) => es.weight / 100,
  skipStudent: (sid) => sid === "gone",
});
const mine = byStudent.get("p");
check("subject term marks", [...mine.values()].map((r) => [r.subjectName, r.mark, r.coefficient]),
  [["Maths", 16, 2], ["English", 9, 1]]);
check("term average 13.67", averageOfSubjects(mine), 13.67);
check("a skipped (deleted) pupil has no marks", byStudent.has("gone"), false);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
