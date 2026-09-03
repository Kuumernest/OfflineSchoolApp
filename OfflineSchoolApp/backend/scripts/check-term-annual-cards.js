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

  /*
   * WEIGHT, which is the field ExamSubject actually has.
   *
   * This fixture used to write `coefficient: 1` — through insertMany, so the
   * schema never objected to a field it does not define. The card builder read
   * the same imaginary field, so the two agreed with each other and disagreed
   * with every real exam in the database: on a live card every subject printed
   * ×1 however the school had weighted it, while the sequence card, which
   * computes from weight, printed ×4.
   *
   * Different weights per subject, so a card that ignored them would show it.
   */
  const WEIGHTS = { "sub-m": 400, "sub-e": 300 };   // coefficients 4 and 3
  const es = [];
  for (const e of exams) for (const [sid, name] of [["sub-m", "Mathematics"], ["sub-e", "English"]]) {
    es.push({ _id: `es-${e._id}-${sid}`, examId: e._id, schoolId: S,
      subjectId: sid, subjectName: name, weight: WEIGHTS[sid], maxScore: 20,
      deletedAt: null });
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

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the coefficient and the class, which came out blank ---");

  /*
   * Three fields that were empty or wrong on every term and annual card while
   * the suite passed, because each was read from somewhere that does not hold
   * it: the coefficient from a field ExamSubject does not define, the class
   * from a Student field most pupils do not carry, and the exam name from
   * nothing at all.
   */
  const tCard = term;
  const aCard = annual;

  const coeffOf = (card, subject) =>
    card.subjects.find((x) => x.subjectName === subject)?.coefficient;

  check("the term card weights Mathematics as the exam says",
    coeffOf(tCard, "Mathematics"), 4);
  check("and English",              coeffOf(tCard, "English"), 3);
  check("the annual card agrees",   coeffOf(aCard, "Mathematics"), 4);
  check("on both subjects",         coeffOf(aCard, "English"), 3);

  check("the term card names its period where the exam name goes",
    tCard.examName, "1st Term");
  check("and the annual card says so",
    aCard.examName, "Annual");

  // The class comes off the class, not off a Student field that is usually
  // absent — a term card printed an empty Class row on every pupil.
  /*
   * The class on a result that never stored one, which is most of them:
   * TermResult.className is written from Student.className, a field a pupil
   * does not generally carry — the class is held as classId.
   */
  const Class = require("../src/db/models/Class");
  await Class.collection.insertOne({ _id: CLS, schoolId: S, name: "Form 3" });
  await TermResult.collection.insertOne({
    _id: "tr-2", schoolId: S, academicYear: YEAR, term: 1, classId: CLS,
    studentId: "p2", studentName: "Bih Ndum", admissionNo: "ENR-002",
    className: null,
    // Deliberately below Ada: the listing assertions further down expect her
    // first, and a fixture added for one purpose must not move another's ground.
    sequenceAverages: [{ sequence: 1, average: 9 }, { sequence: 2, average: 9 }],
    termAverage: 9, overallGrade: "D", overallRemark: "Below Average",
    classPosition: 3, totalInClass: 3, isPassing: false, isPublished: true,
    deletedAt: null,
  });
  check("a term card knows the class even when the result did not store one",
    (await buildTermCard({
      schoolId: S, academicYear: YEAR, term: 1, classId: CLS, studentId: "p2",
    }))?.className, "Form 3");
  check("and a stored name still wins, so a pupil who moved class keeps theirs",
    tCard.className, "Form 3");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the QR and the code, which these cards did not have ---");

  /*
   * The verification strip lived in the sequence card's controller, so only
   * that card had one. A term or annual card rendered {{qr_code}} with nothing
   * behind it, and the engine turns that into the inert placeholder box: a grey
   * square where the QR belongs and no code beneath it. The document hardest to
   * check by eye — its marks combined from several exams and stored nowhere a
   * registrar can see — was the one that could not be checked at all.
   */
  const { cardVerification, periodDocumentKey } =
    require("../src/services/reportCardData.service");
  const fakeReq = { protocol: "https", headers: {}, get: () => "school.example.com" };

  const tVerify = await cardVerification({
    data: term, schoolId: S, studentId: "p1",
    documentKey: periodDocumentKey(term), req: fakeReq,
  });
  check("a term card gets a verification block", Boolean(tVerify), true);
  check("with a QR to scan", /<svg/.test(tVerify?.qrSvg || ""), true);
  check("and a code to type", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(tVerify?.code || ""),
    true);
  check("pointing at the page that answers for it",
    (tVerify?.url || "").includes("/api/verify/"), true);

  const aVerify = await cardVerification({
    data: annual, schoolId: S, studentId: "p1",
    documentKey: periodDocumentKey(annual), req: fakeReq,
  });
  check("so does an annual card", Boolean(aVerify?.code), true);

  /*
   * Each period is its own document.
   *
   * The verification row is unique per (school, kind, pupil, examId), and a
   * term card has no exam. Passing nothing would give every term of every year
   * for one pupil the same code — one piece of paper's code would verify
   * another's marks.
   */
  check("the term card's key names its term",
    periodDocumentKey(term), "term:2026/2027:1");
  check("and the annual card's names the year",
    periodDocumentKey(annual), "annual:2026/2027");
  check("so the two cards do not share a code",
    tVerify.code === aVerify.code, false);

  // Reprinting keeps the code: the paper already in circulation must go on
  // working, which is the whole point of printing it.
  const tAgain = await cardVerification({
    data: term, schoolId: S, studentId: "p1",
    documentKey: periodDocumentKey(term), req: fakeReq,
  });
  check("reprinting a card reuses its code", tAgain.code, tVerify.code);

  /*
   * And the record behind the code says what the paper says.
   *
   * Read from the collection rather than through documentVerify.verify(), which
   * also loads the School to put its letterhead on the public page — this
   * fixture's schoolId is a plain string and that lookup casts to an ObjectId.
   * The snapshot is what this section is about.
   */
  const DocumentVerification = require("../src/db/models/DocumentVerification");
  const record = await DocumentVerification.findOne({
    schoolId: S, studentId: "p1", examId: periodDocumentKey(term),
  }).lean();
  check("the code has a record behind it", Boolean(record), true);
  const factOf = (label) =>
    record.snapshot.facts.find((f) => f.label.en === label)?.value;
  check("naming the pupil", factOf("Student"), "Ada Ngu");
  // The average must match the card beside it: a term average is already /20,
  // where a sequence card's is GPA points shown as x5.
  check("and the same average the card prints", factOf("Average /20"), "15.00");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- what the Report Cards page depends on ---");

  /**
   * The page prints all three cards and picks the endpoint from the card type.
   * Two things it relies on that nothing else asserts:
   *
   *   the listing it reads its pupils from returns studentId and studentName,
   *     because a term or annual card exists only for a pupil the computation
   *     has run for — the class roster would offer pupils with no card, and
   *     each of those is a 404 an admin has to interpret
   *
   *   the card endpoints answer with the DOCUMENT, not JSON with the html
   *     inside it, which is the opposite of the sequence endpoint. The page
   *     handles both; if either changed shape it would print blank pages.
   */
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => {
    req.user = { _id: "admin-1", schoolId: S, role: "school_admin",
                 permissions: ["results.view", "exams.view"] };
    n();
  });
  app.use("/api/term-results",   require("../src/routes/termResults.routes"));
  app.use("/api/annual-results", require("../src/routes/annualResults.routes"));
  const srv  = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const yr   = encodeURIComponent(YEAR);

  const termList = await (await fetch(
    `${base}/term-results?schoolId=${S}&academicYear=${yr}&classId=${CLS}&term=1&limit=200`)).json();
  check("the term listing carries the pupil's id and name",
    [termList.results?.[0]?.studentId, termList.results?.[0]?.studentName], ["p1", "Ada Ngu"]);

  const annualList = await (await fetch(
    `${base}/annual-results?schoolId=${S}&academicYear=${yr}&classId=${CLS}&limit=200`)).json();
  check("and so does the annual listing", annualList.results?.[0]?.studentId, "p1");

  for (const [label, url, promoted] of [
    ["term",   `${base}/term-results/p1/report-card?schoolId=${S}&academicYear=${yr}&classId=${CLS}&term=1&lang=en`, false],
    ["annual", `${base}/annual-results/p1/report-card?schoolId=${S}&academicYear=${yr}&classId=${CLS}&lang=en`,      true ],
  ]) {
    const res  = await fetch(url);
    const body = await res.text();
    check(`the ${label} card answers 200`, res.status, 200);
    check(`the ${label} card is a document, not JSON`,
      String(res.headers.get("content-type")).startsWith("text/html"), true);
    check(`the ${label} card names the pupil`, body.includes("Ada Ngu"), true);
    check(`the ${label} card shows a promotion: ${promoted}`, /PROMOTED/.test(body), promoted);
  }

  // A pupil the computation has not run for. The page counts this as a failure
  // and tells the admin to Compute, which only reads correctly if it is a 404.
  const missing = await fetch(
    `${base}/annual-results/p1/report-card?schoolId=${S}&academicYear=${yr}&classId=cls-none&lang=en`);
  check("a class with no computed result is a 404, not an empty card", missing.status, 404);

  srv.close();

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- a computed result overtaken by its marks ---");

  /**
   * The warning that replaces recomputing behind the school's back.
   *
   * A term average is computed once, deliberately. Nothing recomputes it, so a
   * mark corrected afterwards leaves the report card disagreeing with itself:
   * the subject rows are rebuilt on every print and show the new mark, the
   * average is read from storage and shows the old one. Nobody was told.
   *
   * Timestamps are set explicitly here rather than by saving in sequence —
   * "save, wait, save again" is a test that passes because a machine was slow.
   */
  const stale = require("../src/services/resultStaleness.service");
  const At = (iso) => new Date(iso);

  await TermResult.collection.updateOne(
    { _id: "tr-1" }, { $set: { updatedAt: At("2026-03-02T12:00:00Z") } });
  // Ada's mark predates the computation; nothing is stale yet.
  await Score.collection.updateMany(
    { studentId: "p1" }, { $set: { updatedAt: At("2026-03-01T10:00:00Z") } });

  const freshRows = await TermResult.find({ schoolId: S, academicYear: YEAR, term: 1 }).lean();
  let sres = await stale.termStaleness({ schoolId: S, academicYear: YEAR, term: 1, results: freshRows });
  check("a term computed after its marks is not stale", sres.staleIds.size, 0);

  // A mark corrected after the computation.
  await Score.collection.updateMany(
    { studentId: "p1" }, { $set: { updatedAt: At("2026-03-05T09:00:00Z") } });
  sres = await stale.termStaleness({ schoolId: S, academicYear: YEAR, term: 1, results: freshRows });
  check("a mark changed afterwards makes it stale", sres.staleIds.has("p1"), true);
  check("and the pupil is named, not just counted",
    stale.withStaleness(freshRows, sres.staleIds).results.find((r) => r.studentId === "p1").isStale,
    true);
  check("the count matches", stale.withStaleness(freshRows, sres.staleIds).staleCount, 1);

  // The same instant is not evidence of anything, and calling it stale would
  // leave a warning no amount of recomputing could clear.
  await Score.collection.updateMany(
    { studentId: "p1" }, { $set: { updatedAt: At("2026-03-02T12:00:00Z") } });
  sres = await stale.termStaleness({ schoolId: S, academicYear: YEAR, term: 1, results: freshRows });
  check("a mark saved in the same instant is not stale", sres.staleIds.size, 0);

  // Annual is compared against the TERMS, not the marks.
  await Annual.collection.updateOne(
    { _id: "ar-1" }, { $set: { updatedAt: At("2026-06-01T10:00:00Z") } });
  const annualRows = await Annual.find({ schoolId: S, academicYear: YEAR }).lean();
  let ares = await stale.annualStaleness({ schoolId: S, academicYear: YEAR, results: annualRows });
  check("a year computed after its terms is not stale", ares.staleIds.size, 0);

  await TermResult.collection.updateOne(
    { _id: "tr-1" }, { $set: { updatedAt: At("2026-07-01T10:00:00Z") } });
  ares = await stale.annualStaleness({ schoolId: S, academicYear: YEAR, results: annualRows });
  check("a term recomputed afterwards makes the year stale", ares.staleIds.has("p1"), true);

  check("nothing to check is not stale",
    (await stale.termStaleness({ schoolId: S, academicYear: YEAR, term: 1, results: [] })).staleIds.size,
    0);

  console.log(`
  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail === 0 ? 0 : 1);
};
main().catch((e) => { console.error(e); process.exit(1); });
