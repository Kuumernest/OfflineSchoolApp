// backend/scripts/check-term-annual-cards.js
"use strict";
const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "cards" });

  const Exam        = require("../src/db/models/Exam");
  const ExamSubject = require("../src/db/models/ExamSubject");
  const Score       = require("../src/db/models/StudentScore");
  const TermResult  = require("../src/db/models/TermResult");
  const Annual      = require("../src/db/models/AnnualResult");
  const Structure   = require("../src/db/models/AcademicStructure");
  const Student     = require("../src/db/models/Student");
  const { buildTermCard, buildAnnualCard } =
    require("../src/services/reportCardData.service");
  const { renderReportCardHtml } = require("../src/services/reportHtml.service");

  const S = "school-1", YEAR = "2026/2027", CLS = "cls-1";

  await Structure.collection.insertOne({
    _id: "st-1", schoolId: S, academicYear: YEAR,
    terms: [
      { number: 1, name: "1st Term", weight: 33.34, sequences: [
        { number: 1, name: "Sequence 1", weight: 50 },
        { number: 2, name: "Sequence 2", weight: 50 }] },
      { number: 2, name: "2nd Term", weight: 33.33, sequences: [
        { number: 3, name: "Sequence 3", weight: 50 },
        { number: 4, name: "Sequence 4", weight: 50 }] },
      { number: 3, name: "3rd Term", weight: 33.33, sequences: [
        { number: 5, name: "Sequence 5", weight: 50 },
        { number: 6, name: "Sequence 6", weight: 50 }] },
    ],
  });

  // Three pupils, two subjects, the two sequences of term 1.
  const pupils = ["p1", "p2", "p3"];
  await Student.collection.insertMany(pupils.map((id, i) => ({
    _id: id, schoolId: S, classId: CLS, studentName: ["Ada Ngu", "Bih Tem", "Che Ako"][i],
    enrollmentNo: "ENR-00" + (i + 1), gender: ["Female", "Female", "Male"][i],
    dateOfBirth: new Date("2011-04-0" + (i + 1)), status: "approved", deletedAt: null,
  })));

  const exams = [
    { _id: "ex-1", term: 1, sequenceNumber: 1 },
    { _id: "ex-2", term: 1, sequenceNumber: 2 },
  ];
  await Exam.collection.insertMany(exams.map((e) => ({
    ...e, schoolId: S, academicYear: YEAR, name: "Seq " + e.sequenceNumber,
    type: "test", classId: CLS, deletedAt: null,
  })));

  const es = [];
  for (const e of exams) for (const [sid, name] of [["sub-m", "Mathematics"], ["sub-e", "English"]]) {
    es.push({ _id: `es-${e._id}-${sid}`, examId: e._id, schoolId: S,
      subjectId: sid, subjectName: name, coefficient: 1, maxScore: 20, deletedAt: null });
  }
  await ExamSubject.collection.insertMany(es);

  // Maths: Ada 18/16, Bih 18/18, Che 9/11  → term 17, 18, 10
  // English: Ada 14/12, Bih 8/10, Che absent in both
  const marks = {
    "ex-1": { p1: { "sub-m": 18, "sub-e": 14 }, p2: { "sub-m": 18, "sub-e": 8 }, p3: { "sub-m": 9 } },
    "ex-2": { p1: { "sub-m": 16, "sub-e": 12 }, p2: { "sub-m": 18, "sub-e": 10 }, p3: { "sub-m": 11 } },
  };
  const rows = [];
  for (const [examId, byPupil] of Object.entries(marks))
    for (const [pupil, bySubject] of Object.entries(byPupil))
      for (const [sid, score] of Object.entries(bySubject))
        rows.push({ _id: `${examId}-${pupil}-${sid}`, examId, schoolId: S, studentId: pupil,
          examSubjectId: `es-${examId}-${sid}`, subjectId: sid, score, maxScore: 20,
          isAbsent: false, isExempt: false, deletedAt: null });
  await Score.collection.insertMany(rows);

  await TermResult.collection.insertOne({
    _id: "tr-1", schoolId: S, academicYear: YEAR, term: 1, classId: CLS, studentId: "p1",
    studentName: "Ada Ngu", admissionNo: "ENR-001", className: "Form 3",
    sequenceAverages: [{ sequence: 1, average: 16 }, { sequence: 2, average: 14 }],
    termAverage: 15, overallGrade: "B+", overallRemark: "Good",
    classPosition: 2, totalInClass: 3, isPassing: true, isPublished: true, deletedAt: null,
  });
  await Annual.collection.insertOne({
    _id: "ar-1", schoolId: S, academicYear: YEAR, classId: CLS, studentId: "p1",
    studentName: "Ada Ngu", admissionNo: "ENR-001", className: "Form 3",
    termAverages: [{ term: 1, average: 15 }, { term: 2, average: 14 }, { term: 3, average: 16 }],
    annualAverage: 15, overallGrade: "B+", overallRemark: "Good",
    promotionStatus: "promoted", nextClassName: "Form 4",
    classPosition: 2, totalInClass: 3, isPassing: true, isPublished: true, deletedAt: null,
  });

  const opts = { school: { name: "GBHS Molyko", logo: "l.png", motto: "Knowledge and Service" } };

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) pass++;
    else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
  };

  const term   = await buildTermCard({ schoolId: S, academicYear: YEAR, term: 1, classId: CLS, studentId: "p1" });
  const annual = await buildAnnualCard({ schoolId: S, academicYear: YEAR, classId: CLS, studentId: "p1" });
  const bySubject = (card) => Object.fromEntries(card.subjects.map((s) => [s.subjectName, s]));

  console.log("--- the term card ---");
  check("is a term card", term.reportType, "term");
  check("named the way the school names it", term.term, "1st Term");
  check("with the term average in the box", term.summary.average, 15);
  check("and the term position", [term.summary.classPosition, term.summary.totalInClass], [2, 3]);
  check("and the per-sequence breakdown behind it",
    term.sequenceAverages, [{ sequence: 1, average: 16 }, { sequence: 2, average: 14 }]);

  // 18 and 16 across two sequences weighted 50/50.
  check("a subject mark is the sequences combined by their weights",
    bySubject(term).Mathematics.score, 17);
  check("graded off the school's bands",
    [bySubject(term).Mathematics.grade, bySubject(term).Mathematics.remark], ["A", "Very Good"]);
  // Bih averages 18, Ada 17, Che 10.
  check("and placed against classmates' combined marks",
    [bySubject(term).Mathematics.subjectPosition, bySubject(term).Mathematics.subjectTotal], [2, 3]);
  // Che sat no English in either sequence, so English has two candidates.
  check("a pupil who never sat a subject is out of ITS denominator",
    [bySubject(term).English.subjectPosition, bySubject(term).English.subjectTotal], [1, 2]);

  console.log("--- the annual card ---");
  check("is an annual card", annual.reportType, "annual");
  check("with the annual average", annual.summary.average, 15);
  check("and the per-term breakdown",
    annual.termAverages.map((t) => t.term), [1, 2, 3]);
  check("and the promotion decision, spelled for a parent",
    annual.summary.promotionStatus, "PROMOTED TO FORM 4");

  console.log("--- §8 on the page, not just in the payload ---");
  const th = renderReportCardHtml(term, opts);
  const ah = renderReportCardHtml(annual, opts);
  check("the term card carries no promotion decision", term.summary.promotionStatus, null);
  check("nor prints one", /PROMOTED/.test(th), false);
  check("the annual card prints its own", /PROMOTED TO FORM 4/.test(ah), true);

  console.log("--- §1 and §2 on both ---");
  for (const [name, html] of [["term", th], ["annual", ah]]) {
    for (const [what, needle] of [
      ["the school logo",   "l.png"],
      ["the school motto",  "Knowledge and Service"],
      ["the school name",   "GBHS Molyko"],
      ["the enrollment no", "ENR-001"],
      ["the gender",        "Female"],
      ["the date of birth", "2011-04-01"],
      ["the class",         "Form 3"],
      ["the academic year", "2026/2027"],
    ]) check(`the ${name} card shows ${what}`, html.includes(needle), true);
  }

  console.log(`
  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail === 0 ? 0 : 1);
};
main().catch((e) => { console.error(e); process.exit(1); });
