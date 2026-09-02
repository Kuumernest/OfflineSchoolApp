// backend/scripts/check-term-compute.js
"use strict";

/**
 * Computing a term has to find the marks, and has to finish.
 *
 * ── The two faults ────────────────────────────────────────────────────────
 *
 * IDENTITY. ResultSummary.studentId holds Student._id, and so does
 * TermResult.studentId — buildTermCard looks the pupil up with
 * Student.findOne({ _id: studentId }). The service passed
 * `student.userId ?? student._id`, so for every pupil with a linked login the
 * summary lookup matched nothing. On the live school that was 0 of 50 pupils.
 *
 * And it did not fail: with no summaries the weighted average came out 0, and
 * a TermResult was written saying the pupil had scored nothing. 68 of them.
 * That is worse than an error, because every screen downstream reads it as a
 * fact about a child.
 *
 * TIME. Four round trips per pupil, awaited in a loop over every pupil in every
 * class — the structure, the grading config, the exams and the summaries, all
 * refetched per pupil though none of them varies by pupil. At ~130ms a hop a
 * school of 68 waits three quarters of a minute, and the request times out
 * half-written.
 *
 * ── What this pins ────────────────────────────────────────────────────────
 *
 * That a pupil with a login is found; that a pupil with no marks gets NO row
 * rather than a zero; and the query count, because "it is fast now" decays the
 * moment somebody moves a query back inside the loop and nothing says so.
 *
 *   node scripts/check-term-compute.js
 */

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  // monitorCommands, so the query-count assertion below counts something. The
  // driver does not emit commandStarted without it, and a listener that never
  // fires makes a ceiling of twelve look like a pass at any number.
  await mongoose.connect(mongo.getUri(), { monitorCommands: true });

  const Exam       = require("../src/db/models/Exam");
  const Summary    = require("../src/db/models/ResultSummary");
  const TermResult = require("../src/db/models/TermResult");
  const Structure  = require("../src/db/models/AcademicStructure");
  const Student    = require("../src/db/models/Student");
  const Class      = require("../src/db/models/Class");
  const termGrading = require("../src/services/termGrading.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
  };

  const SCHOOL = "sch-1", YEAR = "2026/2027", CLASS = "cls-1";

  await Structure.create({
    schoolId: SCHOOL, academicYear: YEAR,
    terms: [{
      number: 1, name: "First Term", weight: 33,
      sequences: [
        { number: 1, name: "First Sequence",  weight: 50, assessment: { type: "test" } },
        { number: 2, name: "Second Sequence", weight: 50, assessment: { type: "test" } },
      ],
    }],
    annualAverageMethod: "terms", promotionExams: [], promotionThreshold: 10,
    passMark: 10, maxAbsences: null,
  });

  await Class.create({ _id: CLASS, schoolId: SCHOOL, name: "Form 3A" });

  const mkExam = (id, seq) => Exam.create({
    _id: id, schoolId: SCHOOL, name: `Sequence ${seq ?? "?"}`, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, status: "completed",
    classId: CLASS, totalMarks: 20, passMark: 10,
  });
  await mkExam("ex-1", 1);
  await mkExam("ex-2", 2);

  /*
   * The pupil at the heart of it: one WITH a linked login. The old code keyed
   * the summary lookup on userId, so this is the pupil who came out as a zero.
   */
  await Student.create({
    _id: "stu-linked", userId: "usr-999", schoolId: SCHOOL, classId: CLASS,
    studentName: "Linked Pupil", enrollmentNo: "ENR-1", isActive: true,
  });
  // And one with no login at all — the case the old fallback happened to get
  // right, which is why the bug looked intermittent rather than total.
  await Student.create({
    _id: "stu-plain", schoolId: SCHOOL, classId: CLASS, status: "pending",
    studentName: "Plain Pupil", enrollmentNo: "ENR-2", isActive: true,
  });
  // And one nobody has marked, who must not be given a zero.
  await Student.create({
    _id: "stu-unmarked", userId: "usr-888", schoolId: SCHOOL, classId: CLASS,
    studentName: "Unmarked Pupil", enrollmentNo: "ENR-3", isActive: true,
  });

  // Summaries are keyed on Student._id — the fact the service disagreed with.
  const mkSummary = (examId, studentId, average) => Summary.create({
    examId, studentId, classId: CLASS, schoolId: SCHOOL,
    totalScore: average, maxTotalScore: 20, percentage: average * 5, average,
    subjectsPassed: 1, subjectsFailed: 0, subjectsTotal: 1, isPassing: average >= 10,
  });
  await mkSummary("ex-1", "stu-linked", 14);
  await mkSummary("ex-2", "stu-linked", 16);
  await mkSummary("ex-1", "stu-plain",   9);
  await mkSummary("ex-2", "stu-plain",  11);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the pupil is found by the id the summaries are keyed on ---");

  const run = await termGrading.computeClassTermAverages({
    schoolId: SCHOOL, academicYear: YEAR, term: 1, classId: CLASS,
  });

  check("both marked pupils are computed", run.computed, 2);
  check("and the unmarked one is skipped, not invented", run.skipped, 1);

  const linked = await TermResult.findOne({ studentId: "stu-linked" }).lean();
  check("a pupil with a login has a term result at all", Boolean(linked), true);
  // 14 and 16 at 50/50.
  check("with the average its sequences actually give", linked?.termAverage, 15);
  check("both sequences counted", linked?.sequenceAverages?.map((s) => s.isComplete),
    [true, true]);
  check("the row is keyed on Student._id, which the card looks up by",
    linked?.studentId, "stu-linked");

  const plain = await TermResult.findOne({ studentId: "stu-plain" }).lean();
  check("a pupil with no login is computed the same way", plain?.termAverage, 10);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- an unmarked pupil gets no row, rather than a zero ---");

  const unmarked = await TermResult.findOne({ studentId: "stu-unmarked" }).lean();
  check("nothing is written for them", unmarked, null);
  check("so the class holds only the pupils with marks",
    await TermResult.countDocuments({ classId: CLASS }), 2);

  // Positions rank only what exists.
  check("the better average is first", linked?.classPosition, 1);
  check("and the other second", plain?.classPosition, 2);
  check("out of the two that were computed", linked?.totalInClass, 2);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- two pupils on the same average share a place ---");

  /*
   * Ranking by sorted index gave the same average different positions: on the
   * live school two pupils on 13.0 came 14th and 20th. §6 says a tie shares
   * the rank, and the subject positions on the same card already do.
   */
  for (const [id, name] of [["stu-tie-a", "Tie A"], ["stu-tie-b", "Tie B"]]) {
    await Student.create({
      _id: id, userId: `usr-${id}`, schoolId: SCHOOL, classId: CLASS,
      studentName: name, enrollmentNo: id, isActive: true,
    });
    await mkSummary("ex-1", id, 13);
    await mkSummary("ex-2", id, 13);
  }
  await termGrading.computeClassTermAverages({
    schoolId: SCHOOL, academicYear: YEAR, term: 1, classId: CLASS,
  });

  const tieA = await TermResult.findOne({ studentId: "stu-tie-a" }).lean();
  const tieB = await TermResult.findOne({ studentId: "stu-tie-b" }).lean();
  check("both are on the same average", [tieA?.termAverage, tieB?.termAverage],
    [13, 13]);
  check("and share the same place", tieA?.classPosition, tieB?.classPosition);
  // 15 is ahead of 13; 10 is behind. So the tie is second, and nobody is third.
  check("which is one more than the pupils ahead of them",
    tieA?.classPosition, 2);
  const third = await TermResult.findOne({ studentId: "stu-plain" }).lean();
  check("the place after a two-way tie is skipped",
    third?.classPosition, 4);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- and it does not go back to the database per pupil ---");

  /*
   * The count, not the clock. A timing assertion on a laptop says nothing about
   * a school on a hosted database, and the fault was never slow code — it was
   * the NUMBER of round trips, four per pupil. Counted through the driver so a
   * query moved back inside the loop fails here rather than in an office.
   */
  /*
   * Reads and writes only. Mongoose builds indexes lazily the first time it
   * touches a model, so createIndexes appears at unpredictable moments and
   * would be counted as work this service did — it is the driver's own
   * housekeeping, and counting it would make the comparison below fail for a
   * reason that has nothing to do with the loop.
   */
  const DATA_COMMANDS = new Set(["find", "update", "insert", "aggregate", "delete"]);
  let queries = 0;
  const onCommand = (e) => { if (DATA_COMMANDS.has(e.commandName)) queries += 1; };
  const conn = mongoose.connection.getClient();

  // The same class again, at its current size of three, as the baseline.
  conn.on("commandStarted", onCommand);
  await termGrading.computeClassTermAverages({
    schoolId: SCHOOL, academicYear: YEAR, term: 1, classId: CLASS,
  });
  conn.off("commandStarted", onCommand);
  const forThree = queries;

  for (let i = 0; i < 30; i++) {
    await Student.create({
      _id: `stu-bulk-${i}`, userId: `usr-bulk-${i}`, schoolId: SCHOOL,
      classId: CLASS, studentName: `Bulk ${i}`, enrollmentNo: `B-${i}`,
      isActive: true,
    });
    await mkSummary("ex-1", `stu-bulk-${i}`, 12);
    await mkSummary("ex-2", `stu-bulk-${i}`, 14);
  }

  queries = 0;
  conn.on("commandStarted", onCommand);
  const big = await termGrading.computeClassTermAverages({
    schoolId: SCHOOL, academicYear: YEAR, term: 1, classId: CLASS,
  });
  conn.off("commandStarted", onCommand);
  const forThirtyTwo = queries;

  console.log(`      ${forThree} queries for 3 pupils, ` +
              `${forThirtyTwo} for ${big.computed}`);
  check("every marked pupil is computed", big.computed, 34);
  // A listener that never fired would make the comparison meaningless.
  check("the counter is actually counting", forThree > 0, true);

  /*
   * THE ASSERTION THIS SECTION EXISTS FOR.
   *
   * Not a ceiling — a ceiling is a number somebody picked, and it passes right
   * up until the day a school is one pupil bigger than the guess. The property
   * that matters is that the cost does not depend on the size of the class at
   * all: structure, grading config, exams, students, summaries, one bulk write
   * and the positions pass, whether the class holds three pupils or thirty-two.
   */
  check("ten times the pupils costs the same number of queries",
    forThirtyTwo, forThree);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- an exam with no sequence is reported, not ignored ---");

  await Exam.create({
    _id: "ex-loose", schoolId: SCHOOL, name: "Unassigned Test", type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: null, status: "completed",
    classId: CLASS, totalMarks: 20, passMark: 10,
  });

  const withLoose = await termGrading.computeClassTermAverages({
    schoolId: SCHOOL, academicYear: YEAR, term: 1, classId: CLASS,
  });
  check("the exam missing a sequence is named",
    withLoose.unsequencedExams.map((e) => e.name), ["Unassigned Test"]);
  check("and it does not disturb the pupils who do have marks",
    withLoose.computed, 34);

  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
