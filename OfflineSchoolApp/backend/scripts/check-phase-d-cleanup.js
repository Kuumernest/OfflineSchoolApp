// backend/scripts/check-phase-d-cleanup.js
"use strict";

/**
 * D1 — scripts/phase-d-cleanup.js finds the QA test data, writes nothing on a
 * dry run, and on --apply touches only what it listed.
 *
 *   school s1 "Good School"   bin laden (pupil, with login), ama + bih sharing
 *                             test@x.cm, kofi (own email), grading "Faire"
 *                             a "Testing testing" announcement and a real one
 *                             exams: one undated, one dated
 *                             timetable: a lesson in a break, one by an
 *                             unassigned teacher, one fine
 *                             admission numbers: GVA00/2026/001 (old shape)
 *   school s2 "Kena Academy"  2 approved pupils, 0 teachers
 *
 *   node scripts/check-phase-d-cleanup.js
 */

const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  const { run } = require("./phase-d-cleanup");
  await run(); // registers the models on an empty database
  const C = (n) => mongoose.model(n).collection;

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const pupil = (_id, schoolId, studentName, extra = {}) => ({
    _id, schoolId, studentName, status: "approved", deletedAt: null, isActive: true,
    enrollmentNo: `GVA00-2026-${_id.slice(-3)}`, admissionNo: `GVA00-2026-${_id.slice(-3)}`, ...extra,
  });

  await C("School").insertMany([{ _id: "s1", name: "Good School" }, { _id: "s2", name: "Kena Academy" }]);
  await C("User").insertMany([
    { _id: "u-bl", name: "Bin Laden", role: "student", schoolId: "s1", isActive: true },
    { _id: "t1",   name: "Mr Buh",    role: "teacher", schoolId: "s1", isActive: true },
  ]);
  await C("Student").insertMany([
    pupil("p-001", "s1", "Bin Laden", { userId: "u-bl" }),
    pupil("p-002", "s1", "Ama Ndi",   { email: "test@x.cm" }),
    pupil("p-003", "s1", "Bih Fon",   { email: "Test@x.cm " }),
    pupil("p-004", "s1", "Kofi Tah",  { email: "kofi@x.cm", admissionNo: "GVA00/2026/001" }),
    pupil("p-005", "s2", "Kena One"),
    pupil("p-006", "s2", "Kena Two"),
  ]);
  await C("Announcement").insertMany([
    { _id: "a1", schoolId: "s1", title: "Testing testing", body: "123", isActive: true, deletedAt: null },
    { _id: "a2", schoolId: "s1", title: "Sports day",      body: "Friday", isActive: true, deletedAt: null },
  ]);
  await C("GradingConfig").insertOne({
    schoolId: "s1",
    grades: [{ grade: "A", minMark: 16, maxMark: 20, remark: "Excellent" }, { grade: "C", minMark: 10, maxMark: 12, remark: "Faire" }],
  });
  await C("Exam").insertMany([
    { _id: "e1", schoolId: "s1", name: "Sequence 1", className: "Form 1", academicYear: "2026/2027", term: 1, status: "draft", startDate: null, deletedAt: null },
    { _id: "e2", schoolId: "s1", name: "Sequence 2", className: "Form 1", academicYear: "2026/2027", term: 1, status: "draft", startDate: "2026-11-02", deletedAt: null },
  ]);
  await C("Period").insertMany([
    { _id: "pd1", schoolId: "s1", name: "P1",    isBreak: false, isActive: true, deletedAt: null },
    { _id: "pd2", schoolId: "s1", name: "Break", isBreak: true,  isActive: true, deletedAt: null },
  ]);
  await C("TeacherAssignment").insertOne({ _id: "ta1", schoolId: "s1", teacher: "t1", class: "c1", subject: "math", isActive: true });
  await C("TimetableSlot").insertMany([
    { _id: "ts1", schoolId: "s1", classId: "c1", subjectId: "math", teacherId: "t1", periodId: "pd1", dayOfWeek: "MON", deletedAt: null },
    { _id: "ts2", schoolId: "s1", classId: "c1", subjectId: "math", teacherId: "t1", periodId: "pd2", dayOfWeek: "TUE", deletedAt: null },
    { _id: "ts3", schoolId: "s1", classId: "c1", subjectId: "math", teacherId: "t9", periodId: "pd1", dayOfWeek: "WED", deletedAt: null },
  ]);

  console.log("\n--- dry run ---");
  const r = await run();
  check("finds the test student",          r.testStudents.map((s) => s._id), ["p-001"]);
  check("finds the test announcement",     r.testAnnouncements.map((a) => a._id), ["a1"]);
  check("finds one shared email (case and spaces ignored)",
    r.sharedEmails.map((g) => [g.email, g.students.map((s) => s._id).sort()]), [["test@x.cm", ["p-002", "p-003"]]]);
  check("finds the 'Faire' remark",        r.faireRemarks.map((g) => g.grades), [["C"]]);
  check("reports Kena Academy",            r.kena, [{ school: "Kena Academy", students: 2, teachers: 0 }]);
  check("reports the undated exam only",   r.examsWithoutDates.map((e) => e._id), ["e1"]);
  check("reports the break and unassigned lessons",
    r.badSlots.map((s) => [s._id, s.code]), [["ts2", "break_period"], ["ts3", "teacher_not_assigned"]]);
  check("reports the old-shape admission number",
    r.admissionMismatches.map((m) => [m.student, m.field, m.value]), [["Kofi Tah", "admissionNo", "GVA00/2026/001"]]);

  const st = async (id) => C("Student").findOne({ _id: id });
  check("dry run writes nothing",
    [(await st("p-001")).deletedAt, (await st("p-002")).email, (await C("Announcement").findOne({ _id: "a1" })).isActive,
     (await C("GradingConfig").findOne({ schoolId: "s1" })).grades[1].remark],
    [null, "test@x.cm", true, "Faire"]);

  console.log("\n--- --apply ---");
  await run({ apply: true });
  const bl = await st("p-001");
  check("test student soft-deleted",        [bl.deletedAt instanceof Date, bl.isActive], [true, false]);
  check("their login deactivated",          (await C("User").findOne({ _id: "u-bl" })).isActive, false);
  check("teacher untouched",                (await C("User").findOne({ _id: "t1" })).isActive, true);
  check("test announcement removed, real one kept",
    [(await C("Announcement").findOne({ _id: "a1" })).isActive, (await C("Announcement").findOne({ _id: "a2" })).isActive], [false, true]);
  check("shared email cleared, pupils kept",
    [(await st("p-002")).email, (await st("p-003")).email, (await st("p-002")).deletedAt], [null, null, null]);
  check("own email kept",                   (await st("p-004")).email, "kofi@x.cm");
  check("'Faire' → 'Fair', other remarks kept",
    (await C("GradingConfig").findOne({ schoolId: "s1" })).grades.map((b) => b.remark), ["Excellent", "Fair"]);
  check("admission number not rewritten",   (await st("p-004")).admissionNo, "GVA00/2026/001");
  check("timetable and exams untouched",
    [await C("TimetableSlot").countDocuments({ deletedAt: null }), await C("Exam").countDocuments({ deletedAt: null })], [3, 2]);

  const again = await run();
  check("a second run finds nothing left to change",
    [again.testStudents.length, again.testAnnouncements.length, again.sharedEmails.length, again.faireRemarks.length], [0, 0, 0, 0]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
