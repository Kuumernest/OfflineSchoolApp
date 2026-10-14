// backend/scripts/check-ca-assessment.js
"use strict";

/**
 * Continuous assessment, from the setting to the printed card.
 *
 * ── Why the whole path and not just the arithmetic ────────────────────────
 *
 * The arithmetic is four lines and obvious when it breaks. What is not obvious
 * is the thing this feature can get wrong silently: a pupil with no CA
 * recorded being graded as though they had scored zero in it. A 16/20 becomes
 * a 9.6/20, an A becomes a D, and nothing anywhere says why — the card looks
 * exactly like a card, and the only way to know is to have known the pupil's
 * paper mark. Every school that has ever entered a mark in this system is in
 * that state for every sequence it has ever run, so the day CA is switched on
 * is the day every historical result would change.
 *
 * So the null is pinned at each layer it passes through: the combiner, the
 * sequence result, the stored breakdown, and the HTML a parent holds.
 *
 *   node scripts/check-ca-assessment.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  const Exam          = require("../src/db/models/Exam");
  const ExamSubject   = require("../src/db/models/ExamSubject");
  const Score         = require("../src/db/models/StudentScore");
  const ResultSummary = require("../src/db/models/ResultSummary");
  const GradingConfig = require("../src/db/models/GradingConfig");

  const CA = require("../../shared/caAssessment");
  const seq = require("../src/services/sequenceAssessment.service");
  const { processResults } = require("../src/services/results.service");
  const { renderReportCardHtml } = require("../src/services/reportHtml.service");
  const { buildStudentReportCardData } = require("../src/controllers/results.controller");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
  };

  const SCHOOL = "sch-ca";
  const YEAR   = "2026/2027";
  const CLASS  = "cls-1";
  const MATHS  = "subj-maths";
  const ENG    = "subj-english";

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- configuration: the toggle and the split ---");

  const fresh = await GradingConfig.create({ schoolId: SCHOOL });
  check("CA is ON for a school that has never configured it", fresh.caEnabled, true);
  check("with a split that adds to 100",
    fresh.caWeight + fresh.testWeight, 100);
  check("and the defaults are 40 / 60",
    [fresh.caWeight, fresh.testWeight], [40, 60]);

  // A config written before this feature existed: none of the three fields.
  check("a config that predates CA still reads as CA on",
    CA.caSettings({ passMark: 10 }).caEnabled, true);

  check("CA can be disabled", CA.caSettings({ caEnabled: false }).caEnabled, false);
  check("and with it off the paper is the whole sequence",
    CA.caSettings({ caEnabled: false }).testWeight, 100);

  for (const [ca, test] of [[30, 70], [40, 60], [50, 50], [60, 40]]) {
    check(`CA ${ca}% + Test ${test}% is accepted`,
      CA.validateCaWeights({ caEnabled: true, caWeight: ca, testWeight: test }).ok, true);
  }

  check("30 + 60 is refused",
    CA.validateCaWeights({ caEnabled: true, caWeight: 30, testWeight: 60 }).code,
    "CA_WEIGHT_SUM");
  check("so is 50 + 60",
    CA.validateCaWeights({ caEnabled: true, caWeight: 50, testWeight: 60 }).ok, false);
  check("a negative CA weight is refused",
    CA.validateCaWeights({ caEnabled: true, caWeight: -10, testWeight: 110 }).code,
    "CA_WEIGHT_NEGATIVE");
  check("a negative Test weight is refused",
    CA.validateCaWeights({ caEnabled: true, caWeight: 110, testWeight: -10 }).code,
    "CA_WEIGHT_NEGATIVE");
  check("a non-numeric weight is refused",
    CA.validateCaWeights({ caEnabled: true, caWeight: "forty", testWeight: 60 }).code,
    "CA_WEIGHT_INVALID");
  // With CA off the stored split is dormant. A school that turns CA off must
  // find its own percentages intact when it turns it back on, so nothing is
  // validated and nothing is reset.
  check("with CA off the weights are not policed",
    CA.validateCaWeights({ caEnabled: false, caWeight: 30, testWeight: 60 }).ok, true);

  // The schema enforces it too, so a script or a replayed offline save cannot
  // write a split the settings screen would have refused.
  const rejected = await GradingConfig
    .create({ schoolId: "sch-bad", caWeight: 30, testWeight: 60 })
    .then(() => null)
    .catch((err) => err);
  check("the model refuses a split that does not add up",
    rejected?.name, "ValidationError");

  // The percentages are stored as given.
  await GradingConfig.updateOne({ schoolId: SCHOOL },
    { $set: { caWeight: 30, testWeight: 70 } });
  const stored = await GradingConfig.findOne({ schoolId: SCHOOL }).lean();
  check("a school's own split is stored", [stored.caWeight, stored.testWeight], [30, 70]);
  await GradingConfig.updateOne({ schoolId: SCHOOL },
    { $set: { caWeight: 40, testWeight: 60 } });

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- combining CA and the paper ---");

  const combine = (ca, test, caW = 40, testW = 60) =>
    CA.combineSequenceMark({ ca, test, caWeight: caW, testWeight: testW });

  const m = (score, maxScore = 20) => ({ score, maxScore });

  // The specified example, to the decimal.
  check("CA 14/20 and Test 16/20 at 40/60 make 15.2",
    combine(m(14), m(16)).mark20, 15.2);
  check("and the halves are still readable",
    [combine(m(14), m(16)).caMark20, combine(m(14), m(16)).testMark20], [14, 16]);
  check("English: CA 16, Test 15 → 15.4",
    combine(m(16), m(15)).mark20, 15.4);
  check("at 50/50 the same pair makes 15",
    combine(m(14), m(16), 50, 50).mark20, 15);
  check("at 60/40 it makes 14.8",
    combine(m(14), m(16), 60, 40).mark20, 14.8);

  // ── The rule the whole feature turns on ────────────────────────────────
  const noCa = combine(null, m(16));
  check("no CA recorded: the pupil is graded on the paper alone",
    noCa.mark20, 16);
  check("NOT on 60% of it", noCa.mark20 === 9.6, false);
  check("and the CA half reads as null, not 0", noCa.caMark20, null);
  check("the applied weights say the paper carried all of it",
    [noCa.appliedCaWeight, noCa.appliedTestWeight], [0, 100]);

  // A CA that really is a zero is a different fact and must survive as one.
  const zeroCa = combine(m(0), m(16));
  check("a CA of 0 is a mark, and it counts", zeroCa.mark20, 9.6);
  check("and it is not mistaken for missing", zeroCa.hasCa, true);

  check("CA alone, before the paper is sat, is the pupil's mark",
    combine(m(14), null).mark20, 14);
  check("neither half recorded is null, not zero",
    combine(null, null).mark20, null);
  check("an absent paper does not become a zero",
    combine(m(14), { score: 16, maxScore: 20, isAbsent: true }).mark20, 14);

  // Different maxima, which a school is entitled to use.
  check("CA out of 20 and a paper out of 100 combine correctly",
    combine(m(14, 20), m(80, 100)).mark20, 15.2);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- CA is an assessment type under the sequence ---");

  check("\"ca\" is an exam type", Exam.EXAM_TYPES.includes("ca"), true);
  check("and the paper still is", Exam.EXAM_TYPES.includes("test"), true);
  check("as are practicals and the promotion exam",
    Exam.EXAM_TYPES.includes("practical") && Exam.EXAM_TYPES.includes("promotion_exam"),
    true);

  const mkPaper = async (id, over = {}) => Exam.create({
    _id: id, schoolId: SCHOOL, name: id, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: 1, classId: CLASS,
    status: "ongoing", totalMarks: 20, passMark: 10, ...over,
  });

  const mkEs = async (id, examId, subjectId, over = {}) => ExamSubject.create({
    _id: id, examId, subjectId, classId: CLASS, schoolId: SCHOOL,
    subjectName: subjectId === MATHS ? "Mathematics" : "English",
    maxScore: 20, passMark: 10, weight: 100,
    submissionStatus: "approved", ...over,
  });

  const paper = await mkPaper("ex-seq1");
  await mkEs("es-p-maths", "ex-seq1", MATHS);
  await mkEs("es-p-eng",   "ex-seq1", ENG);

  const made = await seq.ensureCaExam({ paper: paper.toObject() });
  check("a sequence paper gets a CA exam", made.created, true);
  check("of type ca", made.exam.type, "ca");
  check("bound to the same sequence", made.exam.sequenceNumber, 1);
  check("and pointed at its paper", String(made.exam.parentExamId), "ex-seq1");
  check("carrying the paper's subjects", made.subjects.length, 2);
  check("marked out of what the paper is marked out of",
    made.subjects[0].maxScore, 20);

  const again = await seq.ensureCaExam({ paper: paper.toObject() });
  check("asking twice does not make a second one", again.created, false);
  check("it finds the one that exists", String(again.exam._id), String(made.exam._id));

  const CA_EXAM = String(made.exam._id);
  const caEsOf = async (subjectId) =>
    (await ExamSubject.findOne({ examId: CA_EXAM, subjectId }).lean())._id;

  check("the CA exam is found from the paper",
    String((await seq.findCaExam(paper.toObject()))._id), CA_EXAM);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the sequence result ---");

  const mkScore = async (examId, esId, subjectId, studentId, score, over = {}) =>
    Score.findOneAndUpdate(
      { examId, studentId, subjectId },
      {
        $set: {
          examId, examSubjectId: esId, subjectId, studentId,
          classId: CLASS, schoolId: SCHOOL, score, maxScore: 20, ...over,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

  // Ama: CA and paper in both subjects — the worked example.
  await mkScore("ex-seq1", "es-p-maths", MATHS, "stu-ama", 16);
  await mkScore("ex-seq1", "es-p-eng",   ENG,   "stu-ama", 15);
  await mkScore(CA_EXAM, await caEsOf(MATHS), MATHS, "stu-ama", 14);
  await mkScore(CA_EXAM, await caEsOf(ENG),   ENG,   "stu-ama", 16);

  // Bih: paper only. The historical shape, and the one that must not become 0.
  await mkScore("ex-seq1", "es-p-maths", MATHS, "stu-bih", 16);
  await mkScore("ex-seq1", "es-p-eng",   ENG,   "stu-bih", 12);

  await processResults("ex-seq1", CLASS, null);

  const summaryOf = async (studentId) =>
    ResultSummary.findOne({ examId: "ex-seq1", studentId }).lean();
  const rowOf = (summary, subjectId) =>
    summary.subjectBreakdown.find((r) => String(r.subjectId) === subjectId);

  const ama = await summaryOf("stu-ama");
  check("Mathematics: 14 CA and 16 paper make 15.2",
    rowOf(ama, MATHS).normalizedMark, 15.2);
  check("English: 16 CA and 15 paper make 15.4",
    rowOf(ama, ENG).normalizedMark, 15.4);
  check("the CA half is stored beside it", rowOf(ama, MATHS).caScore, 14);
  check("so is the paper half", rowOf(ama, MATHS).testScore, 16);
  check("and the split it was graded by",
    [rowOf(ama, MATHS).caWeight, rowOf(ama, MATHS).testWeight], [40, 60]);

  const bih = await summaryOf("stu-bih");
  check("a pupil with no CA keeps their paper mark",
    rowOf(bih, MATHS).normalizedMark, 16);
  check("it is NOT reduced to 9.6",
    rowOf(bih, MATHS).normalizedMark === 9.6, false);
  check("and the CA field is null rather than 0",
    rowOf(bih, MATHS).caScore, null);
  check("the paper half is still recorded", rowOf(bih, MATHS).testScore, 16);

  // ── Updating a CA mark ─────────────────────────────────────────────────
  await mkScore(CA_EXAM, await caEsOf(MATHS), MATHS, "stu-ama", 18);
  await processResults("ex-seq1", CLASS, null);
  check("correcting a CA mark moves the sequence result",
    rowOf(await summaryOf("stu-ama"), MATHS).normalizedMark, 16.8);
  await mkScore(CA_EXAM, await caEsOf(MATHS), MATHS, "stu-ama", 14);

  // ── The school's own split ─────────────────────────────────────────────
  await GradingConfig.updateOne({ schoolId: SCHOOL },
    { $set: { caWeight: 50, testWeight: 50 } });
  await processResults("ex-seq1", CLASS, null);
  check("changing the split changes the result — nothing is hard-coded",
    rowOf(await summaryOf("stu-ama"), MATHS).normalizedMark, 15);
  await GradingConfig.updateOne({ schoolId: SCHOOL },
    { $set: { caWeight: 40, testWeight: 60 } });

  // ── CA turned off ──────────────────────────────────────────────────────
  await GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: { caEnabled: false } });
  await processResults("ex-seq1", CLASS, null);
  const amaOff = await summaryOf("stu-ama");
  check("with CA off the sequence is the paper: 16/20",
    rowOf(amaOff, MATHS).normalizedMark, 16);
  check("and the CA columns carry nothing", rowOf(amaOff, MATHS).caScore, null);

  const keptCa = await Score.findOne({ examId: CA_EXAM, studentId: "stu-ama",
    subjectId: MATHS }).lean();
  check("the CA mark itself is NOT deleted", keptCa.score, 14);
  check("nor is the CA exam",
    !!(await Exam.findOne({ _id: CA_EXAM, deletedAt: null }).lean()), true);

  await GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: { caEnabled: true } });
  await processResults("ex-seq1", CLASS, null);
  check("turning it back on restores the combined mark",
    rowOf(await summaryOf("stu-ama"), MATHS).normalizedMark, 15.2);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- GradingConfig is the weight authority, not Exam.weight ---");

  /*
   * Two places in this system can hold a number that looks like a weighting:
   * GradingConfig.caWeight / testWeight, and Exam.weight. Only the first is
   * authoritative. The second is exam metadata kept for display and backward
   * compatibility, and nothing in the calculation path reads it.
   *
   * The hazard is not theoretical. An Exam.weight of 80 sitting on a CA exam
   * reads exactly like "this CA counts for 80% of its sequence", and a change
   * that started honouring it would be invisible: every mark would still be a
   * plausible mark. So the two are deliberately set to CONTRADICT each other
   * here — config 40/60 against Exam.weight 80/20 — and the arithmetic is
   * pinned to the config. Wire Exam.weight into the calculation and this
   * section fails.
   */
  await Exam.updateOne({ _id: "ex-seq1" },  { $set: { weight: 20 } });
  await Exam.updateOne({ _id: CA_EXAM },    { $set: { weight: 80 } });

  await processResults("ex-seq1", CLASS, null);
  const contradicted = await summaryOf("stu-ama");
  check("an Exam.weight that disagrees with the config is ignored",
    rowOf(contradicted, MATHS).normalizedMark, 15.2);
  check("80/20 would have given 14.4, and does not",
    rowOf(contradicted, MATHS).normalizedMark === 14.4, false);
  check("the breakdown records the config's split, not the exam's",
    [rowOf(contradicted, MATHS).caWeight, rowOf(contradicted, MATHS).testWeight],
    [40, 60]);

  // And the card a parent reads states the config's split too, so the printed
  // explanation cannot contradict the printed mark.
  const authorityCard = await buildStudentReportCardData("ex-seq1", "stu-ama");
  check("the report card payload carries the config's split",
    [authorityCard.data.caWeight, authorityCard.data.testWeight], [40, 60]);
  const authorityHtml = renderReportCardHtml(authorityCard.data,
    { school: { name: "Test School" } });
  check("and the printed note names it",
    authorityHtml.includes("CA x 40% + Test x 60%"), true);
  check("never the exam's own metadata",
    authorityHtml.includes("CA x 80%"), false);

  // ── Moving Exam.weight alone moves nothing ─────────────────────────────
  await Exam.updateOne({ _id: CA_EXAM }, { $set: { weight: 10 } });
  await processResults("ex-seq1", CLASS, null);
  check("changing Exam.weight alone does not change the sequence result",
    rowOf(await summaryOf("stu-ama"), MATHS).normalizedMark, 15.2);

  // ── Moving the config moves everything ─────────────────────────────────
  await GradingConfig.updateOne({ schoolId: SCHOOL },
    { $set: { caWeight: 60, testWeight: 40 } });
  await processResults("ex-seq1", CLASS, null);
  check("changing GradingConfig does change it",
    rowOf(await summaryOf("stu-ama"), MATHS).normalizedMark, 14.8);
  await GradingConfig.updateOne({ schoolId: SCHOOL },
    { $set: { caWeight: 40, testWeight: 60 } });

  // The term and annual cards share the same authority: their per-sequence
  // split comes from the config too, so a subject mark cannot mean one thing
  // on a sequence card and another on the term card built from it.
  const authorityWeights = seq.weightsWithCa(
    [
      { _id: "p1", type: "test", term: 1, sequenceNumber: 1, weight: 20 },
      { _id: "c1", type: "ca",   term: 1, sequenceNumber: 1, parentExamId: "p1",
        weight: 80 },
    ],
    () => 50,
    await seq.loadCaSettings(SCHOOL),
  );
  check("term weighting splits by the config, not by Exam.weight",
    [authorityWeights.get("p1"), authorityWeights.get("c1")], [30, 20]);

  // Nothing above should have disturbed the exam metadata itself: the field is
  // kept, not removed.
  check("Exam.weight is still stored and readable",
    (await Exam.findById(CA_EXAM).lean()).weight, 10);

  // A CA exam created from here on carries the schema default rather than a
  // copy of the school's percentage, which is what made the two look like
  // rivals in the first place.
  const freshPaper = await mkPaper("ex-seq4", { sequenceNumber: 4, term: 2 });
  const freshCa = await seq.ensureCaExam({ paper: freshPaper.toObject() });
  check("a new CA exam does not copy the school's CA percentage",
    freshCa.exam.weight, 100);

  await Exam.updateOne({ _id: "ex-seq1" }, { $set: { weight: 100 } });
  await Exam.updateOne({ _id: CA_EXAM },   { $set: { weight: 100 } });
  await processResults("ex-seq1", CLASS, null);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- a sequence with no CA at all: the historical case ---");

  const legacy = await mkPaper("ex-legacy", { sequenceNumber: 2, term: 1 });
  await mkEs("es-l-maths", "ex-legacy", MATHS);
  await mkScore("ex-legacy", "es-l-maths", MATHS, "stu-ama", 16);
  await processResults("ex-legacy", CLASS, null);

  const legacySummary = await ResultSummary.findOne({
    examId: "ex-legacy", studentId: "stu-ama",
  }).lean();
  check("a sequence that never had a CA exam is unchanged",
    rowOf(legacySummary, MATHS).normalizedMark, 16);
  check("with CA on for the school, and still no CA on the card",
    rowOf(legacySummary, MATHS).caScore, null);
  void legacy;

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the report card ---");

  const card = (over = {}) => renderReportCardHtml({
    reportType: "sequence",
    caEnabled: true, caWeight: 40, testWeight: 60,
    studentName: "Ama", showGrades: true,
    subjects: [{
      subjectName: "Mathematics", score: 15.2, maxScore: 20, normalizedMark: 15.2,
      coefficient: 1, grade: "B+", isPassing: true,
      caScore: 14, caMaxScore: 20, testScore: 16, testMaxScore: 20,
    }],
    summary: { average: 3.0 }, computed: { outOf: 20 },
    ...over,
  }, { school: { name: "Test School" }, ...(over.__opts || {}) });

  const withCa = card();
  check("CA is a column when it is enabled", withCa.includes(">CA<"), true);
  check("so is Test", withCa.includes(">Test<"), true);
  check("the CA mark is printed", withCa.includes("14 / 20"), true);
  check("the paper mark is printed", withCa.includes("16 / 20"), true);
  check("and the sequence mark they make", withCa.includes("15.2 / 20"), true);
  check("with the split stated, so a parent can check it",
    withCa.includes("CA x 40% + Test x 60%"), true);

  const withoutCa = card({ caEnabled: false });
  check("CA is not a column when it is disabled",
    withoutCa.includes(">CA<"), false);
  check("nor is Test", withoutCa.includes(">Test<"), false);
  check("the score column stays", withoutCa.includes(">Score<"), true);
  check("and so does the mark", withoutCa.includes("15.2 / 20"), true);

  // ── A pupil with no CA, on a card that has the columns ─────────────────
  const missing = card({
    subjects: [{
      subjectName: "Mathematics", score: 16, maxScore: 20, normalizedMark: 16,
      coefficient: 1, grade: "A", isPassing: true,
      caScore: null, caMaxScore: null, testScore: 16, testMaxScore: 20,
    }],
  });
  check("a missing CA prints a dash", missing.includes("—"), true);
  check("and never a zero", />\s*0 \/ 20\s*</.test(missing), false);
  check("the paper mark is still there", missing.includes("16 / 20"), true);

  // ── A card built before CA existed ─────────────────────────────────────
  const historical = renderReportCardHtml({
    reportType: "sequence", studentName: "Bih", showGrades: true,
    subjects: [{ subjectName: "Mathematics", score: 16, maxScore: 20,
      normalizedMark: 16, coefficient: 1, grade: "A", isPassing: true }],
    summary: { average: 3.7 }, computed: { outOf: 20 },
  }, { school: { name: "Test School" } });
  check("a payload with no CA fields renders as it always did",
    historical.includes("16 / 20") && !historical.includes(">CA<"), true);

  // ── French ─────────────────────────────────────────────────────────────
  const fr = renderReportCardHtml({
    reportType: "sequence", caEnabled: true, caWeight: 40, testWeight: 60,
    studentName: "Ama", showGrades: true,
    subjects: [{ subjectName: "Mathématiques", score: 15.2, maxScore: 20,
      normalizedMark: 15.2, coefficient: 1, grade: "B+", isPassing: true,
      caScore: 14, caMaxScore: 20, testScore: 16, testMaxScore: 20 }],
    summary: { average: 3.0 }, computed: { outOf: 20 },
  }, { school: { name: "Test School" }, lang: "fr" });
  check("the French card heads the column CC", fr.includes(">CC<"), true);
  check("and names the paper Épreuve", fr.includes(">Épreuve<"), true);
  check("with no English left in the note",
    fr.includes("Contrôle Continu") && !fr.includes("Continuous Assessment"), true);

  // A term card never carries CA columns: its marks are already combined
  // across sequences and there is no single CA to name.
  const term = card({ reportType: "term" });
  check("a term card has no CA columns", term.includes(">CA<"), false);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- the payload a real card is built from ---");

  /*
   * The hand-built payloads above assert the renderer. This asserts the thing
   * that feeds it: the controller reading two exams out of the database and
   * assembling one subject row per subject. It is where a CA can go missing
   * without any arithmetic being wrong.
   */
  const built = await buildStudentReportCardData("ex-seq1", "stu-ama");
  check("a sequence card is built", built.ok, true);
  check("and knows its sequence was marked both ways", built.data.caEnabled, true);
  check("carrying the split it was graded by",
    [built.data.caWeight, built.data.testWeight], [40, 60]);

  const mathsRow = built.data.subjects.find((r) => r.subjectId === MATHS);
  check("the row holds the CA half",   mathsRow.caScore, 14);
  check("and the paper half",          mathsRow.testScore, 16);
  check("and the sequence mark they make", mathsRow.normalizedMark, 15.2);

  const bihCard = await buildStudentReportCardData("ex-seq1", "stu-bih");
  const bihEng  = bihCard.data.subjects.find((r) => r.subjectId === ENG);
  check("a subject with no CA carries null, not 0", bihEng.caScore, null);
  check("and keeps its paper mark", bihEng.normalizedMark, 12);

  /*
   * Ranked on the SEQUENCE mark, not on the paper.
   *
   * Both pupils scored 16 on the Mathematics paper and would have tied. Ama's
   * CA of 14 pulls her sequence mark to 15.2; Bih has no CA at all and is
   * graded on the paper alone, so Bih is first and Ama second.
   *
   * That is the honest consequence of not reading a missing CA as a zero, and
   * it is worth writing down: a pupil with no continuous assessment CAN
   * outrank one who has it. The alternative — scoring the absence as nought —
   * would put Bih on 9.6 and last, which is a claim about a child that nobody
   * has any evidence for.
   */
  const bihMaths = bihCard.data.subjects.find((r) => r.subjectId === MATHS);
  check("both sat the same paper and are ranked over the two of them",
    [mathsRow.subjectTotal, bihMaths.subjectTotal], [2, 2]);
  check("the pupil graded on the paper alone leads on 16",
    bihMaths.subjectPosition, 1);
  check("and the pupil whose CA pulled her to 15.2 follows",
    mathsRow.subjectPosition, 2);

  const legacyCard = await buildStudentReportCardData("ex-legacy", "stu-ama");
  check("a sequence with no CA exam prints no CA columns",
    legacyCard.data.caEnabled, false);
  check("and its marks are untouched",
    legacyCard.data.subjects[0].normalizedMark, 16);

  // The card rendered from the real payload, end to end.
  const realHtml = renderReportCardHtml(built.data, { school: { name: "Test School" } });
  check("the rendered card shows the CA column", realHtml.includes(">CA<"), true);
  check("with the pupil's CA mark on it", realHtml.includes("14 / 20"), true);

  await GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: { caEnabled: false } });
  const offCard = await buildStudentReportCardData("ex-seq1", "stu-ama");
  check("with CA off the payload says so", offCard.data.caEnabled, false);
  check("and the subject carries no CA", 
    offCard.data.subjects.find((r) => r.subjectId === MATHS).caScore, null);
  check("while the paper mark stands alone",
    offCard.data.subjects.find((r) => r.subjectId === MATHS).normalizedMark, 16);
  await GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: { caEnabled: true } });

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- term weighting is not double-counted ---");

  const weights = seq.weightsWithCa(
    [
      { _id: "p1", type: "test", term: 1, sequenceNumber: 1 },
      { _id: "c1", type: "ca",   term: 1, sequenceNumber: 1, parentExamId: "p1" },
      { _id: "p2", type: "test", term: 1, sequenceNumber: 2 },
    ],
    () => 50,
    { caEnabled: true, caWeight: 40, testWeight: 60 },
  );
  check("a sequence's 50% is split, not duplicated",
    [weights.get("p1"), weights.get("c1")], [30, 20]);
  check("which still totals the sequence's own share",
    weights.get("p1") + weights.get("c1"), 50);
  check("a sequence with no CA keeps its whole share", weights.get("p2"), 50);

  const weightsOff = seq.weightsWithCa(
    [
      { _id: "p1", type: "test", term: 1, sequenceNumber: 1 },
      { _id: "c1", type: "ca",   term: 1, sequenceNumber: 1, parentExamId: "p1" },
    ],
    () => 50,
    { caEnabled: false, caWeight: 0, testWeight: 100 },
  );
  check("with CA off the paper carries the sequence", weightsOff.get("p1"), 50);
  check("and the CA counts for nothing without being deleted",
    weightsOff.get("c1"), 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- offline creation and sync ---");

  /*
   * CA rides the existing offline path because it is an ordinary exam: the
   * queue, the client-chosen id and the upsert are the ones marks already use.
   * What is worth pinning is that a replay does not produce a second row —
   * a phone that syncs twice must not give a pupil two CA marks.
   */
  const offlineId = "ca-offline-1";
  await Score.findOneAndUpdate(
    { examId: CA_EXAM, studentId: "stu-bih", subjectId: MATHS },
    { $set: {
        _id: offlineId, examId: CA_EXAM, examSubjectId: await caEsOf(MATHS),
        subjectId: MATHS, studentId: "stu-bih", classId: CLASS, schoolId: SCHOOL,
        score: 12, maxScore: 20, syncStatus: "pending",
      } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
  check("a CA mark created offline is queued as pending",
    (await Score.findOne({ _id: offlineId }).lean()).syncStatus, "pending");

  // The same mutation replayed — a sync that ran twice.
  await Score.findOneAndUpdate(
    { examId: CA_EXAM, studentId: "stu-bih", subjectId: MATHS },
    { $set: { score: 12, syncStatus: "synced" } },
    { upsert: true, returnDocument: "after" }
  );
  check("replaying it does not create a second CA record",
    await Score.countDocuments({ examId: CA_EXAM, studentId: "stu-bih", subjectId: MATHS }),
    1);
  check("and it settles as synced",
    (await Score.findOne({ _id: offlineId }).lean()).syncStatus, "synced");

  await processResults("ex-seq1", CLASS, null);
  check("the synced CA reaches the sequence result",
    rowOf(await summaryOf("stu-bih"), MATHS).normalizedMark, 14.4);

  // And it reorders the class, because the ranking is over sequence marks:
  // Bih was first on 16 with no CA and is now second on 14.4.
  const afterSync = await buildStudentReportCardData("ex-seq1", "stu-ama");
  check("a CA arriving from the queue moves the subject positions",
    afterSync.data.subjects.find((r) => r.subjectId === MATHS).subjectPosition, 1);

  // An exam created offline with a client-chosen id, replayed.
  const paper2 = await mkPaper("ex-seq3", { sequenceNumber: 3, term: 2 });
  await seq.ensureCaExam({ paper: paper2.toObject(), caExamId: "ca-chosen-id" });
  await seq.ensureCaExam({ paper: paper2.toObject(), caExamId: "ca-chosen-id" });
  check("a replayed CA exam create makes exactly one exam",
    await Exam.countDocuments({ parentExamId: "ex-seq3", type: "ca" }), 1);
  check("under the id the client chose",
    String((await seq.findCaExam(paper2.toObject()))._id), "ca-chosen-id");

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- a school with CA off gets no CA exam ---");

  await GradingConfig.create({ schoolId: "sch-no-ca", caEnabled: false });
  const plainPaper = await Exam.create({
    _id: "ex-plain", schoolId: "sch-no-ca", name: "Seq 1", type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: 1, classId: CLASS,
    totalMarks: 20, passMark: 10,
  });
  const none = await seq.ensureCaExam({ paper: plainPaper.toObject() });
  check("no CA exam is created for a school that does not use CA",
    none.exam, null);

  // Nor for something that is not a sequence.
  const promo = await Exam.create({
    _id: "ex-promo", schoolId: SCHOOL, name: "Promotion", type: "promotion_exam",
    academicYear: YEAR, term: 3, totalMarks: 20, passMark: 10,
  });
  check("nor for an exam bound to no sequence",
    (await seq.ensureCaExam({ paper: promo.toObject() })).exam, null);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("--- nothing is deleted that should not be ---");

  /*
   * Turning CA off is the setting a school will reach for when it decides not
   * to use continuous assessment, and the one thing it must never do is throw
   * away work teachers have already done. Asserted against the collections
   * rather than the API, because "the toggle deletes nothing" is a promise
   * about the database.
   */
  await GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: { caEnabled: false } });
  check("disabling CA keeps every CA mark",
    await Score.countDocuments({ examId: CA_EXAM, deletedAt: null }) > 0, true);
  check("and every CA exam",
    await Exam.countDocuments({ type: "ca", schoolId: SCHOOL, deletedAt: null }) > 0,
    true);
  check("and every CA subject",
    await ExamSubject.countDocuments({ examId: CA_EXAM, deletedAt: null }), 2);
  await GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: { caEnabled: true } });

  console.log(`\n  ${pass} passed, ${fail} failed`);

  // The verdict is the assertions, not the teardown — see stopQuietly.js.
  const exitCode = fail === 0 ? 0 : 1;

  await mongoose.disconnect().catch(() => {});
  await stopQuietly(mongo);

  process.exit(exitCode);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
