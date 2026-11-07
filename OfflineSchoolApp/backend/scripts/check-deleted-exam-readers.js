// backend/scripts/check-deleted-exam-readers.js
"use strict";

/**
 * Every reader of academicHistory.publishedHistory ignores a deleted exam.
 *
 * Deleting an exam only stamps deletedAt on the Exam; its ResultSummary rows
 * stay live. The loader now drops them by default (skipDeletedExams = true).
 * One check per reader that used to count them:
 *
 *   ama, Mathematics /20, all published, 2026/2027 term 1:
 *     s1  Sequence 1, sat 2026-09-15   12
 *     s2  Sequence 2, sat 2026-10-10   13
 *     sd  Sequence 3, sat 2026-10-20    3   ← exam DELETED
 *
 *   student overview      lists s2 then s1; sd is not a result
 *   subject intelligence  two sequences, two Mathematics observations
 *   intervention outcome  Mathematics support started 2026-10-01:
 *                         before 12 (s1), after 13 (s2) → +1, INCREASED_AFTER
 *                         (counting sd would read 8 after → DECREASED_AFTER)
 *
 *   node scripts/check-deleted-exam-readers.js
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

  const { overviewFor }   = require(path.join(SRC, "services/studentOverview.service"));
  const subjectInsights   = require(path.join(SRC, "services/intelligence/subjectInsights.service"));
  const interventionOutcome = require(path.join(SRC, "services/intelligence/interventionOutcome.service"));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv-del@example.test", settings: { academicYear: YEAR } });
  await M("GradingConfig").create({ schoolId: S, passMark: 10 });
  const student = (await M("Student").create({
    _id: "ama", userId: "u-ama", schoolId: S, classId: "f1", className: "Form 1",
    studentName: "Pupil ama", enrollmentNo: "EN-ama", status: "approved", isActive: true,
  })).toObject();

  const exam = (_id, seq, startDate, deletedAt = null) => ({
    _id, schoolId: S, classId: "f1", classIds: ["f1"], name: `Sequence ${seq}`, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, startDate,
    status: deletedAt ? "archived" : "published", deletedAt,
  });
  await M("Exam").collection.insertMany([
    exam("s1", 1, "2026-09-15"), exam("s2", 2, "2026-10-10"), exam("sd", 3, "2026-10-20", new Date()),
  ]);
  const result = (examId, mark) => M("ResultSummary").create({
    examId, studentId: "ama", classId: "f1", schoolId: S, academicYear: YEAR, term: "1", average: mark,
    isPublished: true, publishedAt: new Date(), calcVersion: "exam-process/3",
    subjectBreakdown: [{ subjectId: "maths", subjectName: "Mathematics", score: mark, maxScore: 20,
      normalizedMark: mark, coefficient: 1, isPassing: mark >= 10 }],
  });
  await result("s1", 12); await result("s2", 13); await result("sd", 3);

  console.log("\n--- student overview ---");
  const overview = await overviewFor({ schoolId: S, student, withFees: false });
  check("lists the live sequences only, newest first", overview.results.map((r) => r.examId), ["s2", "s1"]);

  console.log("\n--- subject intelligence ---");
  const profile = await subjectInsights.profileFor({ schoolId: S, studentId: "ama" });
  check("two sequences, two Mathematics observations",
    [profile?.coverage.sequences, profile?.subjects.find((s) => s.subjectId === "maths")?.observations], [2, 2]);

  console.log("\n--- intervention outcome ---");
  const outcome = await interventionOutcome.compare({
    _id: "iv-1", schoolId: S, studentId: "ama", subjectId: "maths",
    startedAt: new Date("2026-10-01T00:00:00Z"), createdAt: new Date("2026-09-30T00:00:00Z"),
  });
  check("before 12, after 13: the deleted 3 is not 'after' evidence",
    [outcome.before?.average, outcome.after?.average, outcome.after?.observations, outcome.reading],
    [12, 13, 1, "INCREASED_AFTER"]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
