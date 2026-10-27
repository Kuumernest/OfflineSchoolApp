// backend/scripts/check-exam-analytics.js
"use strict";

/**
 * Exam analytics on /20 with the school's remark scale — no percentages, no
 * GPA, no letter grades (decided 2026-10-27). Pure: no database.
 *
 * The school's own bands: 14–20 "Bien" / 10–13.99 "Passable" / 0–9.99
 * "Insuffisant"; pass mark 10.
 *
 *   ama  15 /20                → Bien, passes
 *   bih  12.5 (exam-process/3) → Passable, passes
 *   cho  9.5                   → Insuffisant, fails
 *   dan  absent from all       → no result, in no count
 *   eve  an exam-process/1 summary, percentage 70 → 14/20 → Bien, passes
 *
 *   average (15 + 12.5 + 9.5 + 14)/4 = 12.75; highest 15; lowest 9.5
 *   pass rate 3 of 4 = 75%
 *   Maths marks: ama 16/20, bih 30/40 = 15, cho absent → average 15.5, 2 of 2 pass
 *
 *   node scripts/check-exam-analytics.js
 */

const { examAnalytics, rowsOn20, remarkOf } = require("../../shared/examAnalytics");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const BANDS = [
  { grade: "X", minMark: 0,  maxMark: 9.99, remark: "Insufficient", remarkFr: "Insuffisant" },
  { grade: "Y", minMark: 14, maxMark: 20,   remark: "Good",         remarkFr: "Bien" },
  { grade: "Z", minMark: 10, maxMark: 13.99, remark: "Pass",        remarkFr: "Passable" },
];
const v3 = { calcVersion: "exam-process/3" };
const ROWS = [
  { studentId: "ama", average: 15, ...v3, gpa: 3.3, overallGrade: "B+", percentage: 75,
    subjectBreakdown: [{ subjectId: "m", subjectName: "Maths", score: 16, maxScore: 20 }] },
  { studentId: "bih", average: 12.5, ...v3,
    subjectBreakdown: [{ subjectId: "m", subjectName: "Maths", score: 30, maxScore: 40 }] },
  { studentId: "cho", average: 9.5, ...v3,
    subjectBreakdown: [{ subjectId: "m", subjectName: "Maths", isAbsent: true }, { subjectId: "e", subjectName: "English", normalizedMark: 9.5 }] },
  { studentId: "dan", average: 0, ...v3, subjectBreakdown: [{ subjectId: "m", isAbsent: true }] },
  { studentId: "eve", average: 70, percentage: 70, calcVersion: "exam-process/1" },
];

const a = examAnalytics(ROWS, { passMark: 10, bands: BANDS });
check("figures on /20, over the pupils with results",
  [a.scale, a.totalStudents, a.average, a.highest, a.lowest, a.passed, a.passRate], ["20", 4, 12.75, 15, 9.5, 3, 75]);
check("no GPA, no letter-grade distribution", ["averageGpa", "gradeDistribution"].filter((k) => k in a), []);
check("the school's remark bands, highest first, every band listed",
  a.remarkDistribution.map((b) => [b.remarkFr, b.count]), [["Bien", 2], ["Passable", 1], ["Insuffisant", 1]]);
check("Maths on /20: 16 and 30/40 = 15 → 15.5, 2 of 2 pass; an absent mark not counted",
  a.subjectStats.find((s) => s.subjectId === "m"), { subjectId: "m", subjectName: "Maths", average: 15.5, highest: 16, lowest: 15, passRate: 100, total: 2 });

console.log("--- ranking rows ---");
const rows = rowsOn20(ROWS, { passMark: 10, bands: BANDS });
check("each row: average /20, the school's remark, passes — none for a pupil absent from all",
  rows.map((r) => [r.studentId, r.average20, r.remarkFr, r.passes]),
  [["ama", 15, "Bien", true], ["bih", 12.5, "Passable", true], ["cho", 9.5, "Insuffisant", false],
   ["dan", null, null, null], ["eve", 14, "Bien", true]]);
check("the shipped scale when a school has set none", remarkOf(12.5, null), { remark: "Fair", remarkFr: "Assez bien" });

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
