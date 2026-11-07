// backend/scripts/check-watch-source-exam.js
"use strict";

/**
 * Every Students to watch flag that rests on a mark names the exam and its date.
 *
 * "Failed the last exam (8/20)" did not say which exam, so a teacher could
 * not check it — and with deleted or re-run exams around, "the last exam" was
 * a guess. failed_exam, grade_drop and subjects_failed now carry
 * `exam: { examId, name, date }`; grade_drop also `fromExam`.
 *
 *   ama, Form 1, /20, published:
 *     s1  1st Sequence  sat 2026-09-15   14
 *     s2  2nd Sequence  sat 2026-10-10    7, three subjects failed
 *     → failed_exam, grade_drop (14 → 7), subjects_failed — all on s2,
 *       the drop from s1
 *   bo:   one result whose exam row is missing → flagged, exam named by id only
 *
 *   node scripts/check-watch-source-exam.js
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
  const { watchlist } = require(path.join(SRC, "services/earlyWarning.service"));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv-src@example.test", settings: { academicYear: YEAR } });
  await M("GradingConfig").create({ schoolId: S, passMark: 10 });
  for (const id of ["ama", "bo"]) {
    await M("Student").create({
      _id: id, userId: `u-${id}`, schoolId: S, classId: "f1", className: "Form 1",
      studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
    });
  }
  const exam = (_id, seq, name, startDate) => ({
    _id, schoolId: S, classId: "f1", classIds: ["f1"], name, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, startDate, status: "published", deletedAt: null,
  });
  await M("Exam").collection.insertMany([exam("s1", 1, "1st Sequence", "2026-09-15"), exam("s2", 2, "2nd Sequence", "2026-10-10")]);
  const result = (studentId, examId, mark, subjectsFailed = 0) => M("ResultSummary").create({
    examId, studentId, classId: "f1", schoolId: S, academicYear: YEAR, term: "1", average: mark, subjectsFailed,
    isPublished: true, publishedAt: new Date(), calcVersion: "exam-process/3",
    subjectBreakdown: [{ subjectId: "maths", subjectName: "Mathematics", score: mark, maxScore: 20,
      normalizedMark: mark, coefficient: 1, isPassing: mark >= 10 }],
  });
  await result("ama", "s1", 14); await result("ama", "s2", 7, 3);
  await result("bo", "gone", 6);

  const list = await watchlist({ schoolId: S, asOf: new Date("2026-10-27T10:00:00Z") });
  const sig = (id, code) => list.students.find((s) => s.studentId === id)?.signals.find((s) => s.code === code) ?? null;
  const S2 = { examId: "s2", name: "2nd Sequence", date: "2026-10-10" };
  const S1 = { examId: "s1", name: "1st Sequence", date: "2026-09-15" };

  console.log("\n--- each mark-based flag names its exam and date ---");
  check("failed the last exam: the 2nd Sequence, 10 Oct", sig("ama", "failed_exam")?.exam, S2);
  check("the drop: to the 2nd Sequence, from the 1st", [sig("ama", "grade_drop")?.exam, sig("ama", "grade_drop")?.fromExam], [S2, S1]);
  check("subjects failed: in the 2nd Sequence", sig("ama", "subjects_failed")?.exam, S2);

  console.log("\n--- an exam row that is gone ---");
  check("still flagged, the exam by id only", sig("bo", "failed_exam")?.exam, { examId: "gone", name: null, date: null });

  console.log("\n--- flags that do not rest on a mark carry none ---");
  const others = list.students.flatMap((s) => s.signals)
    .filter((g) => !["failed_exam", "grade_drop", "subjects_failed"].includes(g.code));
  check("no exam on attendance, homework or fee flags", others.every((g) => g.exam === undefined), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
