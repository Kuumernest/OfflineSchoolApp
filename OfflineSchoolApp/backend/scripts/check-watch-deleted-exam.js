// backend/scripts/check-watch-deleted-exam.js
"use strict";

/**
 * Students to watch ignores the marks of a deleted exam.
 *
 * Deleting an exam stamps deletedAt on the Exam only; its ResultSummary rows
 * stay live. The watch list used to count them as the pupil's latest sitting.
 *
 * Pass mark 10/20, all results published, Form 1, 2026/2027 term 1:
 *
 *   ama  Seq 1 = 14, Seq 2 (DELETED) = 6
 *        → nothing: the 6 is not her latest result, so no fail and no drop
 *   bih  Seq 1 = 14, Seq 2 = 9, Seq 3 (DELETED) = 15
 *        → failed_exam at 9 and grade_drop 14 → 9: the deleted 15 does not
 *          hide a real decline
 *   cho  Seq 1 = 12, Seq 2 = 7 (exam row missing altogether)
 *        → failed_exam at 7: a summary with no exam row is kept, as before
 *
 *   node scripts/check-watch-deleted-exam.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const { watchlist } = require("../src/services/earlyWarning.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv@example.test", settings: { academicYear: YEAR } });
  await M("GradingConfig").collection.insertOne({ schoolId: S, passMark: 10 });

  for (const id of ["ama", "bih", "cho"]) {
    await M("Student").create({
      _id: id, userId: `u-${id}`, schoolId: S, classId: "f1", className: "Form 1",
      studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true,
    });
  }

  const exam = (_id, seq, deletedAt = null) => ({
    _id, schoolId: S, classId: "f1", classIds: ["f1"], name: `Sequence ${seq}`, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, startDate: `2026-10-0${seq}`,
    status: deletedAt ? "archived" : "published", deletedAt,
  });
  await M("Exam").collection.insertMany([
    exam("s1", 1), exam("s2", 2), exam("s2-deleted", 2, new Date()), exam("s3-deleted", 3, new Date()),
  ]);

  const result = (studentId, examId, average) => M("ResultSummary").create({
    examId, studentId, classId: "f1", schoolId: S, academicYear: YEAR, term: "1", average,
    isPublished: true, publishedAt: new Date(), calcVersion: "exam-process/3",
  });
  await result("ama", "s1", 14); await result("ama", "s2-deleted", 6);
  await result("bih", "s1", 14); await result("bih", "s2", 9); await result("bih", "s3-deleted", 15);
  await result("cho", "s1", 12); await result("cho", "no-such-exam", 7);

  const list = await watchlist({ schoolId: S });
  const signals = (id) => {
    const row = list.students.find((s) => s.studentId === id);
    return (row?.signals ?? [])
      .filter((g) => ["failed_exam", "grade_drop", "subjects_failed"].includes(g.code))
      .map((g) => g.code === "failed_exam" ? `failed_exam ${g.data.average}`
        : g.code === "grade_drop" ? `grade_drop ${g.data.from}->${g.data.to}` : g.code);
  };

  console.log("\n--- a deleted exam's marks are not a reason to watch a pupil ---");
  check("ama: a fail in a deleted exam is not flagged", signals("ama"), []);
  check("bih: a deleted exam does not hide a real fail and drop", signals("bih"), ["failed_exam 9", "grade_drop 14->9"]);
  check("cho: a summary with no exam row at all is still read", signals("cho"), ["failed_exam 7", "grade_drop 12->7"]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
