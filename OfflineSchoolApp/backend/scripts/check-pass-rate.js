// backend/scripts/check-pass-rate.js
"use strict";

/**
 * One pass rate (decided 2026-10-27): pupils whose average /20 is at or above
 * the SCHOOL's pass mark, over the pupils with results, in one stated scope.
 *
 * The exams page said 96%, Test 3's analytics 75%, the platform 100%.
 *
 * The school here passes at 12, not 10. Worked by hand:
 *
 *   Test 3 (sequence 3, 2026/2027), Form 1:
 *     ama 15 ✓   bih 12 ✓ (at the mark)   cho 11 ✗ (passes a fixed 10)   dan absent from all
 *     → 2 of 3 with results = 66.7%  (dan in neither count)
 *   Test 3, Upper Sixth: uma 9 ✗ → 0 of 1
 *   Test 3, both classes: 2 of 4 = 50%
 *   An old exam-process/1 summary (raw /100 mean 70, percentage 70 → 14/20)
 *   in Test 1 of the same year: passes → year: 3 of 5 = 60%
 *   A CA exam's own summary in the year is not counted (it is inside its paper).
 *   Last year's Test 9: eve 18 — not in this year's figure.
 *
 *   Term 1 results (platform): ama 13 ✓, bih 11.99 ✗, cho 12 ✓ → 2 of 3 = 66.7%;
 *   a term row with no average is not a result.
 *
 *   node scripts/check-pass-rate.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const { passRateOf, summaryPassRate } = require("../../shared/passRate");
  const classStats = require("../src/services/classStats.service");
  const platform   = require("../src/services/platformStats.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  console.log("--- the rule ---");
  check("at the mark passes; nulls are not results", passRateOf([12, 11.99, null, 15], 12),
    { withResults: 3, passed: 2, failed: 1, rate: 66.7 });
  check("nobody with a result: no rate", passRateOf([null], 10).rate, null);
  check("a fully absent summary is not a result",
    summaryPassRate([{ average: 0, calcVersion: "exam-process/3", subjectBreakdown: [{ isAbsent: true }] }], 10).withResults, 0);

  const YEAR = "2026/2027";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv-pr@example.test", settings: { academicYear: YEAR } });
  await M("GradingConfig").create({ schoolId: S, passMark: 12 });

  const exam = (id, extra = {}) => M("Exam").create({ _id: id, schoolId: S, name: id, type: "test",
    academicYear: YEAR, term: 2, sequenceNumber: 3, status: "published", classId: "f1", classIds: ["f1", "u6"], ...extra });
  await exam("t3");
  await exam("t1", { term: 1, sequenceNumber: 1 });
  await exam("t3-ca", { type: "ca", parentExamId: "t3" });
  await exam("t9", { academicYear: "2025/2026" });
  const summary = (examId, studentId, classId, average, extra = {}) => M("ResultSummary").create({
    examId, studentId, classId, schoolId: S, average, isPublished: true, calcVersion: "exam-process/3",
    // isPassing as a writer with a fixed 10 would have stored it — never read.
    isPassing: average >= 10, ...extra,
  });
  await summary("t3", "ama", "f1", 15);
  await summary("t3", "bih", "f1", 12);
  await summary("t3", "cho", "f1", 11);
  await summary("t3", "dan", "f1", 0, { subjectBreakdown: [{ subjectId: "m", isAbsent: true }, { subjectId: "e", isAbsent: true }] });
  await summary("t3", "uma", "u6", 9);
  await summary("t1", "old", "f1", 70, { calcVersion: "exam-process/1", percentage: 70 });
  await summary("t3-ca", "ama", "f1", 2);
  await summary("t9", "eve", "f1", 18);

  console.log("--- an exam's analytics ---");
  const f1 = await classStats.examStatistics({ schoolId: S, examId: "t3", classId: "f1" });
  check("Test 3, Form 1: 2 of 3 = 66.7% at the school's 12; dan counted in neither",
    [f1.totalStudents, f1.passed, f1.failed, f1.passRate, f1.passMark], [3, 2, 1, 66.7, 12]);
  const both = await classStats.examStatistics({ schoolId: S, examId: "t3" });
  check("Test 3, both classes: 2 of 4 = 50%", [both.totalStudents, both.passed, both.passRate], [4, 2, 50]);

  console.log("--- the exams page: the year ---");
  const yr = await classStats.scopedPassRate({ schoolId: S, academicYear: YEAR });
  check("this year: 3 of 5 = 60% — the old /100 summary read as 14/20, the CA and last year left out",
    [yr.withResults, yr.passed, yr.rate], [5, 3, 60]);
  check("  the same year's other spelling", (await classStats.scopedPassRate({ schoolId: S, academicYear: "2026-2027" })).rate, 60);
  check("  term 2 only: Test 3's 2 of 4", (await classStats.scopedPassRate({ schoolId: S, academicYear: YEAR, term: 2 })).rate, 50);
  check("  Form 1 only: 3 of 4 (Test 3's three and the old one)",
    (await classStats.scopedPassRate({ schoolId: S, academicYear: YEAR, classId: "f1" })).rate, 75);

  console.log("--- the platform: term results ---");
  for (const [studentId, termAverage] of [["ama", 13], ["bih", 11.99], ["cho", 12], ["dan", null]]) {
    await M("TermResult").create({ schoolId: S, academicYear: YEAR, term: 1, classId: "f1", studentId,
      termAverage, isPassing: termAverage != null && termAverage >= 10 });
  }
  await M("TermResult").create({ schoolId: S, academicYear: "2025/2026", term: 1, classId: "f1", studentId: "eve",
    termAverage: 18, isPassing: true });
  const stats = await platform.computePlatformStats(platform.parseFilters({}));
  const row = stats.schools.find((s) => s.schoolId === S);
  check("current year by default: 2 of 3 at the school's 12 = 67%; last year's row and the empty one left out",
    [row.academics.results, row.academics.passRate, row.academics.academicYear], [3, 67, YEAR]);
  const last = await platform.computePlatformStats(platform.parseFilters({ academicYear: "2025/2026" }));
  check("a chosen year: that year", last.schools.find((s) => s.schoolId === S).academics.passRate, 100);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
