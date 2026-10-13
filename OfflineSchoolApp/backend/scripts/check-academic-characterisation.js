// backend/scripts/check-academic-characterisation.js
"use strict";

/**
 * The academic pipeline as it behaves today, pinned end to end.
 *
 * ── Why this exists (docs/39 §20, Phase 2a) ───────────────────────────────
 *
 * docs/39 plans to move the academic rules into configuration without
 * changing any result a school has been given. "Without changing" needs
 * something to compare against, and the suites that existed did not provide
 * it: check-term-compute and check-term-annual-cards seed ResultSummary rows
 * by hand, on /20, which is not what processResults writes. A refactor could
 * keep those green and still move every term average in the school.
 *
 * So nothing here is seeded below the marks. One synthetic school is marked,
 * and every layer above is produced by the real services:
 *
 *   StudentScore → processResults → ResultSummary (+ grades written back)
 *               → termGrading     → TermResult
 *               → annualGrading   → AnnualResult
 *               → publishResults  → promotion.generateRun → PromotionDecision
 *               → sequence / term / annual card payloads
 *
 * ── What a pinned value means ─────────────────────────────────────────────
 *
 * It is what the code produces at the commit this was written against, each
 * figure checked by hand (the arithmetic is beside the pin). It is NOT a claim
 * that the figure is right. Tagged pins encode known defects, reported in
 * docs/39 and deliberately left alone:
 *
 *   [docs/39 §4.1]  ResultSummary.average is GPA points (0–4); the term,
 *                   annual and promotion layers read it as /20 or 0–100
 *   [docs/39 §4.3]  a recompute unpublishes a published result
 *   [docs/39 §4.4]  the promotion run and the annual results disagree
 *   [docs/39 §4.6k] a pupil with no term result gets an annual row of 0
 *   [docs/39 §4.6l] the sequence card's subject pass flag is the paper's,
 *                   not the blended mark it prints
 *
 * When a decision (docs/39 §21) changes one of those on purpose, its pins are
 * updated in the same change and the commit says so. Any OTHER pin moving is
 * a regression.
 *
 * Synthetic data only — no real pupil, school or credential.
 *
 *   node scripts/check-academic-characterisation.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  const Exam          = require("../src/db/models/Exam");
  const ExamSubject   = require("../src/db/models/ExamSubject");
  const StudentScore  = require("../src/db/models/StudentScore");
  const ResultSummary = require("../src/db/models/ResultSummary");
  const TermResult    = require("../src/db/models/TermResult");
  const AnnualResult  = require("../src/db/models/AnnualResult");
  const Structure     = require("../src/db/models/AcademicStructure");
  const GradingConfig = require("../src/db/models/GradingConfig");
  const Student       = require("../src/db/models/Student");
  const Class         = require("../src/db/models/Class");

  const results       = require("../src/services/results.service");
  const termGrading   = require("../src/services/termGrading.service");
  const annualGrading = require("../src/services/annualGrading.service");
  const promotion     = require("../src/services/promotion.service");
  const cards         = require("../src/services/reportCardData.service");
  const { buildStudentReportCardData } = require("../src/controllers/results.controller");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  // ── The school ──────────────────────────────────────────────────────────
  //
  // Today's defaults wherever there is one: the default structure (3 terms of
  // 2 sequences, 50/50 within a term, 33.33/33.33/33.34 across the year), the
  // shipped grade bands, pass mark 10, CA on at 40/60.

  const SCHOOL = "sch-char", YEAR = "2026/2027", NEXT_YEAR = "2027/2028";
  const FORM3 = "cls-f3", FORM4 = "cls-f4";

  await Structure.create({ schoolId: SCHOOL, academicYear: YEAR });
  await GradingConfig.create({ schoolId: SCHOOL, caEnabled: true, caWeight: 40, testWeight: 60 });
  await Class.create({ _id: FORM4, schoolId: SCHOOL, name: "Form 4" });
  await Class.create({ _id: FORM3, schoolId: SCHOOL, name: "Form 3", nextClassId: FORM4 });

  const PUPILS = [
    ["stu-ama", "Ama Synthetic"],
    ["stu-bih", "Bih Synthetic"],
    ["stu-cho", "Cho Synthetic"],
    ["stu-dan", "Dan Synthetic"],   // Ama's marks exactly: the tie
    ["stu-eve", "Eve Synthetic"],   // never marked: must get no term row, no zero
  ];
  for (const [id, name] of PUPILS) {
    await Student.create({
      _id: id, userId: `usr-${id}`, schoolId: SCHOOL, classId: FORM3, className: "Form 3",
      studentName: name, enrollmentNo: `ENR-${id}`, status: "approved", isActive: true,
    });
  }

  // Maths carries coefficient 2 (ExamSubject.weight 200), English 1.
  const SUBJECTS = [["sub-math", "Mathematics", 200], ["sub-eng", "English", 100]];

  // Paper marks /20 for sequence 1. Later sequences shift them by DELTA so the
  // sequence and term weights have something to weigh; null = absent.
  const PAPER = {
    "stu-ama": { "sub-math": 15, "sub-eng": 9 },
    "stu-bih": { "sub-math": 12, "sub-eng": 14 },
    "stu-cho": { "sub-math": null, "sub-eng": 11 },
    "stu-dan": { "sub-math": 15, "sub-eng": 9 },
  };
  const DELTA = { 1: 0, 2: 2, 3: -1, 4: 1, 5: 0, 6: -2 };

  // CA marks /10, term 1 only — terms 2 and 3 have no CA exam, which is the
  // "sequence with no CA" path. Bih has no Maths CA: renormalised onto the
  // paper, never read as a zero.
  const CA_MARKS = {
    "stu-ama": { "sub-math": 8, "sub-eng": 6 },
    "stu-bih": { "sub-eng": 5 },
    "stu-cho": { "sub-eng": 5.5 },
    "stu-dan": { "sub-math": 8, "sub-eng": 6 },
  };

  const paperId = (seq) => `ex-seq${seq}`;
  const caId    = (seq) => `ex-ca${seq}`;
  const termOf  = (seq) => Math.ceil(seq / 2);

  const addSubjects = async (examId, maxScore) => {
    const ids = {};
    for (const [subjectId, subjectName, weight] of SUBJECTS) {
      const es = await ExamSubject.create({
        examId, subjectId, subjectName, classId: FORM3, schoolId: SCHOOL,
        maxScore, passMark: maxScore / 2, weight, submissionStatus: "approved",
      });
      ids[subjectId] = es._id;
    }
    return ids;
  };

  for (let seq = 1; seq <= 6; seq++) {
    await Exam.create({
      _id: paperId(seq), schoolId: SCHOOL, name: `Sequence ${seq}`, type: "test",
      academicYear: YEAR, term: termOf(seq), sequenceNumber: seq, status: "completed",
      classId: FORM3, classIds: [FORM3], totalMarks: 20, passMark: 10,
      startDate: `2026-${String(8 + seq).padStart(2, "0")}-15`,
    });
    const paperSubjects = await addSubjects(paperId(seq), 20);
    for (const [studentId, marks] of Object.entries(PAPER)) {
      for (const [subjectId, base] of Object.entries(marks)) {
        await StudentScore.create({
          examId: paperId(seq), examSubjectId: paperSubjects[subjectId], studentId, subjectId,
          classId: FORM3, schoolId: SCHOOL, maxScore: 20,
          score: base == null ? null : Math.max(0, Math.min(20, base + DELTA[seq])),
          isAbsent: base == null,
        });
      }
    }

    if (termOf(seq) !== 1) continue;
    await Exam.create({
      _id: caId(seq), schoolId: SCHOOL, name: `CA ${seq}`, type: "ca", parentExamId: paperId(seq),
      academicYear: YEAR, term: 1, sequenceNumber: seq, status: "completed",
      classId: FORM3, classIds: [FORM3], totalMarks: 10, passMark: 5,
    });
    const caSubjects = await addSubjects(caId(seq), 10);
    for (const [studentId, marks] of Object.entries(CA_MARKS)) {
      for (const [subjectId, score] of Object.entries(marks)) {
        await StudentScore.create({
          examId: caId(seq), examSubjectId: caSubjects[subjectId], studentId, subjectId,
          classId: FORM3, schoolId: SCHOOL, maxScore: 10, score,
        });
      }
    }
  }

  // ── Layer 1: sequence results ───────────────────────────────────────────

  for (let seq = 1; seq <= 6; seq++) await results.processResults(paperId(seq));

  const summary = (seq, studentId) =>
    ResultSummary.findOne({ examId: paperId(seq), studentId }).lean();
  const subjectRow = (s, subjectId) =>
    (s?.subjectBreakdown || []).find((r) => r.subjectId === subjectId);
  const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));

  console.log("--- sequence results (processResults) ---");
  {
    const ama = await summary(1, "stu-ama");
    /*
     * Maths: CA 8/10 → 16/20, paper 15/20; 0.4·16 + 0.6·15 = 15.4 → band B+ (3.3).
     * English: CA 6/10 → 12/20, paper 9/20; 0.4·12 + 0.6·9 = 10.2 → band C (2.0).
     */
    check("Ama S1 Maths breakdown", pick(subjectRow(ama, "sub-math"),
      ["score", "maxScore", "normalizedMark", "coefficient", "weightedMark", "caScore", "caMaxScore",
       "caMark", "testScore", "testMaxScore", "testMark", "caWeight", "testWeight", "grade", "points", "isPassing"]),
      { score: 15.4, maxScore: 20, normalizedMark: 15.4, coefficient: 2, weightedMark: 30.8, caScore: 8, caMaxScore: 10,
        caMark: 16, testScore: 15, testMaxScore: 20, testMark: 15, caWeight: 40, testWeight: 60, grade: "B+", points: 3.3, isPassing: true });
    check("Ama S1 English breakdown", pick(subjectRow(ama, "sub-eng"),
      ["normalizedMark", "coefficient", "weightedMark", "caMark", "testMark", "grade", "points", "isPassing"]),
      { normalizedMark: 10.2, coefficient: 1, weightedMark: 10.2, caMark: 12, testMark: 9, grade: "C", points: 2, isPassing: true });
    /*
     * [docs/39 §4.1] average is GPA POINTS, coefficient-weighted:
     * (3.3·2 + 2.0·1) / 3 = 2.8667 → 2.87. Overall grade from 2.87×5 = 14.33 → B+.
     * Pass = 2.87 ≥ 2.0. The /20 coefficient-weighted mean would be
     * (15.4·2 + 10.2) / 3 = 13.67 — it is stored nowhere.
     */
    check("Ama S1 summary", pick(ama,
      ["average", "overallGrade", "isPassing", "gpa", "totalScore", "maxTotalScore", "percentage",
       "subjectsPassed", "subjectsFailed", "subjectsTotal", "isPartial", "isPublished", "isLocked"]),
      { average: 2.87, overallGrade: "B+", isPassing: true, gpa: 2.87, totalScore: 25.6, maxTotalScore: 40, percentage: 64,
        subjectsPassed: 2, subjectsFailed: 0, subjectsTotal: 2, isPartial: false, isPublished: false, isLocked: false });

    // Bih: no Maths CA → Maths is the paper alone (12), renormalised to 0/100.
    const bih = await summary(1, "stu-bih");
    check("Bih S1 Maths renormalised onto the paper", pick(subjectRow(bih, "sub-math"),
      ["normalizedMark", "caMark", "testMark", "caWeight", "testWeight", "grade"]),
      { normalizedMark: 12, caMark: null, testMark: 12, caWeight: 0, testWeight: 100, grade: "B" });
    // English: CA 5/10 → 10, paper 14; 0.4·10 + 0.6·14 = 12.4 → B (3.0). (3.0·2 + 3.0) / 3 = 3.0; 3.0×5 = 15 → B+.
    check("Bih S1 summary", pick(bih, ["average", "overallGrade", "isPassing"]), { average: 3, overallGrade: "B+", isPassing: true });

    // Cho: absent in Maths counts as failed, scores nothing, carries no weight.
    const cho = await summary(1, "stu-cho");
    check("Cho S1 absent Maths", pick(subjectRow(cho, "sub-math"),
      ["score", "normalizedMark", "grade", "remark", "isAbsent", "isPassing", "weightedMark"]),
      { score: null, normalizedMark: 0, grade: "AB", remark: "Absent", isAbsent: true, isPassing: false, weightedMark: null });
    check("Cho S1 summary", pick(cho,
      ["average", "overallGrade", "isPassing", "subjectsPassed", "subjectsFailed"]),
      // English alone: CA 5.5/10 → 11, paper 11 → 11 → C+ (2.5). The absent subject is out of the
      // average but counted as failed. 2.5×5 = 12.5 → B.
      { average: 2.5, overallGrade: "B", isPassing: true, subjectsPassed: 1, subjectsFailed: 1 });

    // Positions: competition ranking on the GPA-point average, ties share.
    const positions = {};
    for (const [id] of PUPILS) {
      const s = await summary(1, id);
      positions[id] = s ? [s.classPosition, s.totalInClass, s.gradePosition, s.schoolPosition, s.totalInSchool] : null;
    }
    /*
     * [docs/39 §4.1] Bih ranks first on 3.0 points over Ama's 2.87, though on
     * the /20 marks Ama is ahead: (15.4·2 + 10.2)/3 = 13.67 against Bih's
     * (12·2 + 12.4)/3 = 12.13. Ama and Dan tie and share 2nd; Cho is 4th
     * (the next place after a shared 2nd is 4th); Eve has no summary.
     */
    check("S1 positions [class, ofClass, grade, school, ofSchool]", positions, {
      "stu-ama": [2, 4, 2, 2, 4], "stu-bih": [1, 4, 1, 1, 4], "stu-cho": [4, 4, 4, 4, 4],
      "stu-dan": [2, 4, 2, 2, 4], "stu-eve": null,
    });

    // The grade written back onto the PAPER's StudentScore is graded on the
    // paper mark alone, by the built-in scale — not the blended mark.
    const amaMathScore = await StudentScore.findOne({ examId: paperId(1), studentId: "stu-ama", subjectId: "sub-math" }).lean();
    check("Ama S1 Maths StudentScore write-back", pick(amaMathScore,
      ["score", "percentage", "grade", "remark", "gpaPoints", "isPassing"]),
      { score: 15, percentage: 75, grade: "B+", remark: "Good", gpaPoints: 3.3, isPassing: true });

    const seqAverages = {};
    for (let seq = 1; seq <= 6; seq++) seqAverages[seq] = (await summary(seq, "stu-ama"))?.average ?? null;
    /*
     * S2 Maths 0.4·16+0.6·17 = 16.6 A 3.7, English 0.4·12+0.6·11 = 11.4 C+ 2.5 → (7.4+2.5)/3 = 3.3.
     * S3–S6 have no CA: S3 14 B+ / 8 D → (6.6+1)/3 = 2.53; S4 16 A / 10 C → 3.13;
     * S5 15 B+ / 9 D → 2.53; S6 13 B / 7 F → 2.0.
     */
    check("Ama sequence averages S1..S6 (GPA points)", seqAverages,
      { 1: 2.87, 2: 3.3, 3: 2.53, 4: 3.13, 5: 2.53, 6: 2 });

    check("no summary for the pupil with no marks", await summary(1, "stu-eve"), null);
  }

  // ── Layer 2: term results ───────────────────────────────────────────────

  console.log("--- term results (termGrading) ---");
  const termRuns = [];
  for (const term of [1, 2, 3]) {
    termRuns.push(await termGrading.computeClassTermAverages({
      schoolId: SCHOOL, academicYear: YEAR, term, classId: FORM3,
    }));
  }
  // Four pupils with marks each term; Eve is skipped, never written as a zero.
  check("term runs [computed, skipped]", termRuns.map((r) => [r.computed, r.skipped]), [[4, 1], [4, 1], [4, 1]]);
  {
    const t = (term, studentId) => TermResult.findOne({ schoolId: SCHOOL, academicYear: YEAR, term, studentId }).lean();
    const ama = await t(1, "stu-ama");
    /*
     * [docs/39 §4.1] the term average is the 50/50 mean of the two GPA-point
     * sequence averages, then graded and passed as though it were /20.
     */
    check("Ama T1", pick(ama, ["termAverage", "overallGrade", "overallRemark", "isPassing", "classPosition", "totalInClass"]),
      // (2.87 + 3.3) / 2 = 3.085 → 3.09, graded on /20 → F, below 10 → failing.
      { termAverage: 3.09, overallGrade: "F", overallRemark: "Fail", isPassing: false, classPosition: 2, totalInClass: 4 });
    check("Ama T1 sequenceAverages", (ama?.sequenceAverages || []).map((s) => pick(s, ["sequence", "average", "overallGrade", "isComplete"])),
      [{ sequence: 1, average: 2.87, overallGrade: "F", isComplete: true },
       { sequence: 2, average: 3.3, overallGrade: "F", isComplete: true }]);
    const all = {};
    for (const term of [1, 2, 3]) {
      for (const [id] of PUPILS) {
        const r = await t(term, id);
        all[`T${term} ${id}`] = r ? [r.termAverage, r.overallGrade, r.isPassing, r.classPosition] : null;
      }
    }
    check("every term row [average, grade, passing, position]", all, {
      "T1 stu-ama": [3.09, "F", false, 2], "T1 stu-bih": [3.1, "F", false, 1], "T1 stu-cho": [2.75, "F", false, 4],
      "T1 stu-dan": [3.09, "F", false, 2], "T1 stu-eve": null,
      "T2 stu-ama": [2.83, "F", false, 2], "T2 stu-bih": [2.89, "F", false, 1], "T2 stu-cho": [2.5, "F", false, 4],
      "T2 stu-dan": [2.83, "F", false, 2], "T2 stu-eve": null,
      "T3 stu-ama": [2.27, "F", false, 2], "T3 stu-bih": [2.72, "F", false, 1], "T3 stu-cho": [1.75, "F", false, 4],
      "T3 stu-dan": [2.27, "F", false, 2], "T3 stu-eve": null,
    });
  }

  // ── Layer 3: annual results ─────────────────────────────────────────────

  console.log("--- annual results (annualGrading) ---");
  const annualRun = await annualGrading.computeClassAnnualAverages({ schoolId: SCHOOL, academicYear: YEAR, classId: FORM3 });
  // Five, not four: Eve too — see the annual rows below.
  check("annual run", annualRun, { computed: 5, skipped: 0 });
  {
    const all = {};
    for (const [id] of PUPILS) {
      const r = await AnnualResult.findOne({ schoolId: SCHOOL, academicYear: YEAR, studentId: id }).lean();
      all[id] = r ? pick(r, ["annualAverage", "overallGrade", "isPassing", "promotionStatus", "promotionThreshold", "classPosition", "totalInClass"]) : null;
    }
    /*
     * [docs/39 §4.1] every term average is on the GPA-point scale, below the
     * pass mark of 10, so every complete year is "repeated".
     */
    /*
     * Ama: (3.09·33.33 + 2.83·33.33 + 2.27·33.34) / 100 = 2.7299 → 2.73.
     *
     * [docs/39 §4.6k] Eve has no term result at all and is still written an
     * annual row: average 0, F, ranked last of five. The term layer refuses
     * exactly this ("not a zero", termGrading.service.js); the annual layer
     * writes one for every active pupil. promotionStatus stays "pending"
     * because fewer than three terms are complete.
     */
    check("annual rows", all, {
      "stu-ama": { annualAverage: 2.73, overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 2, totalInClass: 5 },
      "stu-bih": { annualAverage: 2.9,  overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 1, totalInClass: 5 },
      "stu-cho": { annualAverage: 2.33, overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 4, totalInClass: 5 },
      "stu-dan": { annualAverage: 2.73, overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 2, totalInClass: 5 },
      "stu-eve": { annualAverage: 0,    overallGrade: "F", isPassing: false, promotionStatus: "pending",  promotionThreshold: 10, classPosition: 5, totalInClass: 5 },
    });
    const ama = await AnnualResult.findOne({ schoolId: SCHOOL, academicYear: YEAR, studentId: "stu-ama" }).lean();
    check("Ama termAverages", (ama?.termAverages || []).map((x) => pick(x, ["term", "average", "overallGrade", "isComplete"])),
      [{ term: 1, average: 3.09, overallGrade: "F", isComplete: true },
       { term: 2, average: 2.83, overallGrade: "F", isComplete: true },
       { term: 3, average: 2.27, overallGrade: "F", isComplete: true }]);
  }

  // ── Layer 4: cards (built before publication; the payload, not the HTML) ─

  console.log("--- card payloads ---");
  {
    const seqCard = await buildStudentReportCardData(paperId(1), "stu-ama");
    const d = seqCard.data || {};
    /*
     * The sequence card prints computed.weightedAverage — the /20
     * coefficient-weighted mean (13.67) — but its headline grade is looked up
     * on the GPA-point average un-multiplied [docs/39 §4.1].
     */
    check("sequence card headline", {
      ok: seqCard.ok,
      reportType: d.reportType ?? null,
      average: d.summary?.average ?? null,
      overallGrade: d.summary?.overallGrade ?? null,
      isPassing: d.summary?.isPassing ?? null,
      classPosition: d.summary?.classPosition ?? null,
      weightedAverage: d.computed?.weightedAverage ?? null,
    }, { ok: true, reportType: "sequence", average: 2.87, overallGrade: "F", isPassing: true, classPosition: 2, weightedAverage: 13.67 });
    check("sequence card subject rows", (d.subjects || []).map((r) =>
      pick(r, ["subjectId", "score", "maxScore", "normalizedMark", "coefficient", "grade", "isPassing"])),
      /*
       * [docs/39 §4.6l] English prints the blended 10.2, grade C, but its pass
       * flag is the PAPER's StudentScore.isPassing (9/20 → false,
       * results.controller.js:612) — a 10.2 above a pass mark of 10, marked failed.
       */
      [{ subjectId: "sub-eng", score: 10.2, maxScore: 20, normalizedMark: 10.2, coefficient: 1, grade: "C", isPassing: false },
       { subjectId: "sub-math", score: 15.4, maxScore: 20, normalizedMark: 15.4, coefficient: 2, grade: "B+", isPassing: true }]);

    const termCard = await cards.buildTermCard({ schoolId: SCHOOL, academicYear: YEAR, term: 1, classId: FORM3, studentId: "stu-ama" });
    // [docs/39 §4.1] headline from the stored TermResult; rows rebuilt from marks on /20.
    check("term card headline", pick(termCard?.summary, ["average", "overallGrade", "isPassing", "classPosition", "totalInClass", "promotionStatus"]),
      { average: 3.09, overallGrade: "F", isPassing: false, classPosition: 2, totalInClass: 4, promotionStatus: null });
    check("term card subject rows", (termCard?.subjects || []).map((r) =>
      pick(r, ["subjectId", "score", "coefficient", "grade", "isPassing", "subjectPosition", "sequenceMarks"])),
      // English (10.2 + 11.4)/2 = 10.8 → C; Maths (15.4 + 16.6)/2 = 16 → A. On /20, beside a 3.09 headline.
      [{ subjectId: "sub-eng", score: 10.8, coefficient: 1, grade: "C", isPassing: true, subjectPosition: 3,
         sequenceMarks: [{ number: 1, mark: 10.2 }, { number: 2, mark: 11.4 }] },
       { subjectId: "sub-math", score: 16, coefficient: 2, grade: "A", isPassing: true, subjectPosition: 1,
         sequenceMarks: [{ number: 1, mark: 15.4 }, { number: 2, mark: 16.6 }] }]);
    // 16·2 + 10.8 = 42.8 over 3 coefficients (= 14.27 /20, which the card does not headline).
    check("term card computed totals", termCard?.computed ?? null, { outOf: 20, totalCoefficients: 3, totalWeighted: 42.8 });

    const annualCard = await cards.buildAnnualCard({ schoolId: SCHOOL, academicYear: YEAR, classId: FORM3, studentId: "stu-ama" });
    check("annual card headline", pick(annualCard?.summary, ["average", "overallGrade", "isPassing", "classPosition", "promotionStatus"]),
      { average: 2.73, overallGrade: "F", isPassing: false, classPosition: 2, promotionStatus: "REPEATED" });
    check("annual card subject rows", (annualCard?.subjects || []).map((r) =>
      pick(r, ["subjectId", "score", "coefficient", "grade", "isPassing"])),
      // English terms 10.8, 9, 8 → 9.27 D; Maths 16, 15, 14 → 15 B+.
      [{ subjectId: "sub-eng", score: 9.27, coefficient: 1, grade: "D", isPassing: false },
       { subjectId: "sub-math", score: 15, coefficient: 2, grade: "B+", isPassing: true }]);
  }

  // ── Layer 5: publication and promotion ──────────────────────────────────

  console.log("--- publication and promotion ---");
  for (let seq = 1; seq <= 6; seq++) await results.publishResults(paperId(seq));
  {
    const byStudent = await promotion.resultsByStudent(SCHOOL, YEAR);
    // [docs/39 §4.1] the mean of six GPA-point sequence averages.
    // Ama (2.87+3.3+2.53+3.13+2.53+2)/6 = 2.727 → 2.7. "terms" counts summaries, which are sequences.
    check("resultsByStudent", Object.fromEntries([...byStudent.entries()].sort()), {
      "stu-ama": { average: 2.7, passing: true, terms: 6 }, "stu-bih": { average: 2.9, passing: true, terms: 6 },
      "stu-cho": { average: 2.3, passing: true, terms: 6 }, "stu-dan": { average: 2.7, passing: true, terms: 6 },
    });

    const { decisions } = await promotion.generateRun({ schoolId: SCHOOL, fromYear: YEAR, toYear: NEXT_YEAR, generatedBy: null });
    check("promotion decisions", Object.fromEntries(decisions
      .map((x) => [x.studentId, pick(x, ["outcome", "basis", "average", "toClassId"])]).sort()), {
      /*
       * [docs/39 §4.4] every pupil the annual results call "repeated" is
       * proposed "promoted" here — the run reads summaries, not annual results.
       * Eve, with no results at all, is proposed "promoted" on basis "no_results".
       */
      "stu-ama": { outcome: "promoted", basis: "results_pass", average: 2.7, toClassId: FORM4 },
      "stu-bih": { outcome: "promoted", basis: "results_pass", average: 2.9, toClassId: FORM4 },
      "stu-cho": { outcome: "promoted", basis: "results_pass", average: 2.3, toClassId: FORM4 },
      "stu-dan": { outcome: "promoted", basis: "results_pass", average: 2.7, toClassId: FORM4 },
      "stu-eve": { outcome: "promoted", basis: "no_results", average: null, toClassId: FORM4 },
    });

    /*
     * [docs/39 §4.1, §21 D2] a class promotion average is entered 0–100 and
     * compared with that GPA-point mean, so a 50 % bar holds back every pupil.
     */
    const amaResult = byStudent.get("stu-ama");
    check("proposeFor with a 50 % class bar", promotion.proposeFor({
      currentClass: { _id: FORM3, nextClassId: FORM4, isFinalYear: false, promotionAverage: 50 },
      result: amaResult,
    }), { outcome: "repeated", basis: "average_fail", toClassId: FORM3 });
  }

  // ── Layer 6: recompute after publication ────────────────────────────────

  console.log("--- recompute after publication ---");
  {
    const before = await summary(1, "stu-ama");
    await results.processResults(paperId(1));
    const after = await summary(1, "stu-ama");
    check("recompute leaves the figures as they were", pick(after, ["average", "overallGrade", "classPosition"]),
      pick(before, ["average", "overallGrade", "classPosition"]));
    // [docs/39 §4.3, §21 D3] and silently unpublishes.
    check("recompute after publication [isPublished before, after]", [before?.isPublished, after?.isPublished], [true, false]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
