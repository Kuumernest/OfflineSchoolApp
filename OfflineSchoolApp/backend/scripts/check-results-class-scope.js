// backend/scripts/check-results-class-scope.js
"use strict";

/**
 * The exam analytics page's figures and rankings cover the same pupils.
 *
 * The page (web /exams/results) asks /stats and /rankings with the same class
 * — none for All classes. The school ranking ignored the class, so with Form 1
 * chosen the page said "Showing Form 1 only" and listed the whole school.
 *
 *   one exam, two classes:
 *     Form 1   f1-a 15, f1-b 11, f1-c 8        school positions 1, 3, 5
 *     Form 2   f2-a 13, f2-b 9                 school positions 2, 4
 *
 *   All classes   stats 5 pupils; class, grade and school rankings 5 rows
 *   Form 1        stats 3 pupils; every scope 3 rows, all Form 1;
 *                 the school table keeps school positions 1, 3, 5
 *
 *   node scripts/check-results-class-scope.js
 */

const path     = require("path");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  const { getRankings } = require(path.join(SRC, "services/results.service"));
  const classStats      = require(path.join(SRC, "services/classStats.service"));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  await M("GradingConfig").create({ schoolId: S, passMark: 10 });

  const PUPILS = [
    // id,     class, name,     average, class pos, grade pos, school pos
    ["f1-a", "f1", "Form 1", 15, 1, 1, 1],
    ["f1-b", "f1", "Form 1", 11, 2, 2, 3],
    ["f1-c", "f1", "Form 1",  8, 3, 3, 5],
    ["f2-a", "f2", "Form 2", 13, 1, 1, 2],
    ["f2-b", "f2", "Form 2",  9, 2, 2, 4],
  ];
  await M("ResultSummary").insertMany(PUPILS.map(([id, classId, className, average, cp, gp, sp]) => ({
    examId: "ex-1", studentId: id, studentName: `Pupil ${id}`, admissionNo: `EN-${id}`,
    classId, className, schoolId: S, academicYear: "2026/2027", term: "1", average,
    classPosition: cp, gradePosition: gp, schoolPosition: sp,
    isPublished: true, publishedAt: new Date(), calcVersion: "exam-process/3",
  })));

  const ids = (rows) => rows.map((r) => r.studentId);

  for (const [label, classId, expectIds] of [
    ["All classes", null, ["f1-a", "f1-b", "f1-c", "f2-a", "f2-b"]],
    ["Form 1",      "f1", ["f1-a", "f1-b", "f1-c"]],
  ]) {
    console.log(`\n--- ${label} ---`);
    const stats = await classStats.examStatistics({ schoolId: S, examId: "ex-1", classId: classId ?? undefined });
    check("stats count the pupils in scope", stats.totalStudents, expectIds.length);
    for (const scope of ["class", "grade", "school"]) {
      const rows = await getRankings("ex-1", scope, classId, S);
      check(`${scope} rankings rank the same pupils`, ids(rows).sort(), [...expectIds].sort());
    }
  }

  console.log("\n--- the school table, one class ---");
  const school = await getRankings("ex-1", "school", "f1", S);
  check("Form 1 only, with their positions in the whole school",
    school.map((r) => [r.studentId, r.schoolPosition]), [["f1-a", 1], ["f1-b", 3], ["f1-c", 5]]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
