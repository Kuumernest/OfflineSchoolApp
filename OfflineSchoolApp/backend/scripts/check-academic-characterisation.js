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
 * There are TWO code paths that compute a sequence result, and they disagree:
 *
 *   - results.service.processResults (CA blended, coefficients, GPA-point
 *     average). No router has ever mounted it (git log -S); it is reached
 *     only from tests (its unrouted caller, results.controller.computeResults,
 *     which passed it an object, was removed: docs/39 §4.6e).
 *   - POST /api/exams/:examId/process (exam.routes.js). What web, mobile and
 *     desktop call — so what every real result in a database came from.
 *     Raw-mark integer mean, no CA, no coefficients, absent as zero, and no
 *     academicYear on the summary.
 *
 * Both are pinned: the first half of this file runs processResults, the last
 * section ("the live route") builds the same school again and processes it
 * over HTTP through the real router and auth.
 *
 * Nothing is seeded below the marks. A synthetic school is marked, and every
 * layer above is produced by the real services:
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
 *   [docs/39 §4.6k] FIXED: a pupil with no term result used to get an
 *                   annual row of 0, F, ranked last; now gets none
 *   [docs/39 §4.6l] the sequence card's subject pass flag is the paper's,
 *                   not the blended mark it prints
 *   [docs/39 §4.7]  the live route: CA and coefficients ignored, absent as
 *                   zero, whole-number averages, no academicYear (so the
 *                   promotion run sees no results), card average ≠ stored
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

  const PUPILS = [
    ["stu-ama", "Ama Synthetic"],
    ["stu-bih", "Bih Synthetic"],
    ["stu-cho", "Cho Synthetic"],
    ["stu-dan", "Dan Synthetic"],   // Ama's marks exactly: the tie
    ["stu-eve", "Eve Synthetic"],   // never marked: must get no term row, no zero
  ];

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

  const termOf  = (seq) => Math.ceil(seq / 2);

  /*
   * One school with the data above. Every document id carries the prefix `p`,
   * so the same school can be built twice side by side — once for each of the
   * two routes that compute sequence results (see "The live route" below).
   */
  const seedSchool = async ({ schoolId, p }) => {
    const form3 = `${p}${FORM3}`, form4 = `${p}${FORM4}`;
    await Structure.create({ schoolId, academicYear: YEAR });
    await GradingConfig.create({ schoolId, caEnabled: true, caWeight: 40, testWeight: 60 });
    await Class.create({ _id: form4, schoolId, name: "Form 4" });
    await Class.create({ _id: form3, schoolId, name: "Form 3", nextClassId: form4 });

    for (const [id, name] of PUPILS) {
      await Student.create({
        _id: `${p}${id}`, userId: `usr-${p}${id}`, schoolId, classId: form3, className: "Form 3",
        studentName: name, enrollmentNo: `ENR-${p}${id}`, status: "approved", isActive: true,
      });
    }

    const addSubjects = async (examId, maxScore) => {
      const ids = {};
      for (const [subjectId, subjectName, weight] of SUBJECTS) {
        const es = await ExamSubject.create({
          examId, subjectId, subjectName, classId: form3, schoolId,
          maxScore, passMark: maxScore / 2, weight, submissionStatus: "approved",
        });
        ids[subjectId] = es._id;
      }
      return ids;
    };

    for (let seq = 1; seq <= 6; seq++) {
      const paper = `${p}ex-seq${seq}`;
      await Exam.create({
        _id: paper, schoolId, name: `Sequence ${seq}`, type: "test",
        academicYear: YEAR, term: termOf(seq), sequenceNumber: seq, status: "completed",
        classId: form3, classIds: [form3], totalMarks: 20, passMark: 10,
        startDate: `2026-${String(8 + seq).padStart(2, "0")}-15`,
      });
      const paperSubjects = await addSubjects(paper, 20);
      for (const [studentId, marks] of Object.entries(PAPER)) {
        for (const [subjectId, base] of Object.entries(marks)) {
          await StudentScore.create({
            examId: paper, examSubjectId: paperSubjects[subjectId], studentId: `${p}${studentId}`, subjectId,
            classId: form3, schoolId, maxScore: 20,
            score: base == null ? null : Math.max(0, Math.min(20, base + DELTA[seq])),
            isAbsent: base == null,
          });
        }
      }

      if (termOf(seq) !== 1) continue;
      const ca = `${p}ex-ca${seq}`;
      await Exam.create({
        _id: ca, schoolId, name: `CA ${seq}`, type: "ca", parentExamId: paper,
        academicYear: YEAR, term: 1, sequenceNumber: seq, status: "completed",
        classId: form3, classIds: [form3], totalMarks: 10, passMark: 5,
      });
      const caSubjects = await addSubjects(ca, 10);
      for (const [studentId, marks] of Object.entries(CA_MARKS)) {
        for (const [subjectId, score] of Object.entries(marks)) {
          await StudentScore.create({
            examId: ca, examSubjectId: caSubjects[subjectId], studentId: `${p}${studentId}`, subjectId,
            classId: form3, schoolId, maxScore: 10, score,
          });
        }
      }
    }
  };

  await seedSchool({ schoolId: SCHOOL, p: "" });
  const paperId = (seq) => `ex-seq${seq}`;

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
  // [docs/39 §4.6k, fixed] four, not five: Eve has no term result and gets no
  // annual row, as the term layer gives her no term row. Was { computed: 5,
  // skipped: 0 }.
  check("annual run", annualRun, { computed: 4, skipped: 1, noTerms: 1 });
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
     * [docs/39 §4.6k, fixed] Eve has no term result at all and gets no
     * annual row, as the term layer gives her none ("not a zero",
     * termGrading.service.js). Until the fix she was written average 0, F,
     * "pending", ranked 5 of 5. Nobody else's place moves (she was last);
     * totalInClass is 4, not 5.
     */
    check("annual rows", all, {
      "stu-ama": { annualAverage: 2.73, overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 2, totalInClass: 4 },
      "stu-bih": { annualAverage: 2.9,  overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 1, totalInClass: 4 },
      "stu-cho": { annualAverage: 2.33, overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 4, totalInClass: 4 },
      "stu-dan": { annualAverage: 2.73, overallGrade: "F", isPassing: false, promotionStatus: "repeated", promotionThreshold: 10, classPosition: 2, totalInClass: 4 },
      "stu-eve": null,
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
    /*
     * The decided rule (docs/39 §21.1, 2026-10-16): the run reads published
     * ANNUAL results against the class's bar. Only the sequence summaries
     * are published here, so no pupil has a published annual result and
     * every one needs a decision. (Before the decision the run averaged
     * the GPA-point summaries, proposed all four "promoted" while their
     * annual rows said "repeated", and compared a 0–100 class bar with them,
     * docs/39 §4.4, §21 D2.)
     */
    const { decisions } = await promotion.generateRun({ schoolId: SCHOOL, fromYear: YEAR, toYear: NEXT_YEAR, generatedBy: null });
    check("promotion decisions", Object.fromEntries(decisions
      .map((x) => [x.studentId, pick(x, ["outcome", "basis", "average", "toClassId"])]).sort()), {
      "stu-ama": { outcome: "unassigned", basis: "no_results", average: null, toClassId: null },
      "stu-bih": { outcome: "unassigned", basis: "no_results", average: null, toClassId: null },
      "stu-cho": { outcome: "unassigned", basis: "no_results", average: null, toClassId: null },
      "stu-dan": { outcome: "unassigned", basis: "no_results", average: null, toClassId: null },
      "stu-eve": { outcome: "unassigned", basis: "no_results", average: null, toClassId: null },
    });
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

  // ── The live route: POST /api/exams/:examId/process ─────────────────────
  //
  // Everything above runs results.service.processResults. No router mounts
  // it (its one caller, the unrouted results.controller.computeResults, is gone).
  // What web, mobile and desktop actually call to compute a sequence is
  // POST /api/exams/:examId/process (exam.routes.js), which writes
  // ResultSummary by arithmetic of its own. The same school, built again,
  // goes through that route over HTTP exactly as the clients send it.

  console.log("--- the live route: POST /exams/:examId/process ---");
  {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
    require("../src/db/models");
    const express = require("express");
    const jwt     = require("jsonwebtoken");
    const auth    = require("../middleware/auth");
    const User    = mongoose.model("User");

    const LIVE = "sch-live", L = "L-";
    await seedSchool({ schoolId: LIVE, p: L });
    await User.create({
      _id: "adm-live", name: "Live Admin", email: "adm-live@example.test", password: "check-only-password",
      role: "school_admin", schoolId: LIVE, isActive: true,
    });

    const app = express(); app.use(express.json());
    app.use("/api/exams", auth.authenticate, require("../src/routes/exam.routes"));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    const API = `http://127.0.0.1:${server.address().port}/api`;
    const token = jwt.sign({ id: "adm-live", role: "school_admin", schoolId: LIVE }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const post = (url, body = {}) => fetch(`${API}${url}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    const statuses = [];
    for (let seq = 1; seq <= 6; seq++) statuses.push((await post(`/exams/${L}ex-seq${seq}/process`, {})).status);
    check("live: every paper processes", statuses, [200, 200, 200, 200, 200, 200]);

    const live = (seq, id) => ResultSummary.findOne({ examId: `${L}ex-seq${seq}`, studentId: `${L}${id}` }).lean();
    const ama = await live(1, "stu-ama");
    /*
     * The decided calculation (docs/39 §21.1, exam-process/3): CA blended at
     * 40/60, coefficients carried. Before the decision this route stored the
     * paper alone (15, coefficient 1) and a raw mean of 12 (docs/39 §4.7).
     *   Maths   0.4·(8/10·20) + 0.6·15 = 6.4 + 9   = 15.4  B+, ×2 = 30.8
     *   English 0.4·(6/10·20) + 0.6·9  = 4.8 + 5.4 = 10.2  C (passes on it)
     */
    check("live: Ama S1 Maths breakdown", pick(subjectRow(ama, "sub-math"),
      ["score", "maxScore", "normalizedMark", "coefficient", "weightedMark", "caMark", "testMark", "grade", "points", "isPassing"]),
      { score: 15.4, maxScore: 20, normalizedMark: 15.4, coefficient: 2, weightedMark: 30.8, caMark: 16, testMark: 15,
        grade: "B+", points: 3.3, isPassing: true });
    check("live: Ama S1 English breakdown", pick(subjectRow(ama, "sub-eng"),
      ["score", "normalizedMark", "coefficient", "caMark", "grade", "points", "isPassing"]),
      { score: 10.2, normalizedMark: 10.2, coefficient: 1, caMark: 12, grade: "C", points: 2, isPassing: true });
    check("live: Ama S1 summary", pick(ama,
      ["average", "overallGrade", "isPassing", "gpa", "totalScore", "maxTotalScore", "percentage", "subjectsPassed", "subjectsFailed", "subjectsTotal"]),
      /*
       * (30.8 + 10.2)/3 = 13.67, B; percentage round(13.67/20·100) = 68;
       * totalScore 15.4 + 10.2 = 25.6 of 40; both subjects pass.
       */
      { average: 13.67, overallGrade: "B", isPassing: true, gpa: 3, totalScore: 25.6, maxTotalScore: 40, percentage: 68,
        subjectsPassed: 2, subjectsFailed: 0, subjectsTotal: 2 });
    const rows = {};
    for (const [id] of PUPILS) {
      const s = await live(1, id);
      rows[id] = s ? [s.average, s.percentage, s.overallGrade, s.isPassing, s.classPosition, s.totalInClass] : null;
    }
    /*
     * Bih: Maths 12 (no CA: the paper alone), English 0.4·10 + 0.6·14 = 12.4
     *      → (24 + 12.4)/3 = 12.13, 61 %.
     * Cho: Maths absent, removed with its coefficient; English
     *      0.4·11 + 0.6·11 = 11 → 11, C+, 55 %. (Was round(11/2) = 6, F.)
     * Ranked on the average: Ama = Dan 13.67 (1st, shared), Bih 3rd, Cho 4th.
     */
    check("live: S1 every pupil [average, percentage, grade, passing, position, ofClass]", rows, {
      "stu-ama": [13.67, 68, "B", true, 1, 4], "stu-bih": [12.13, 61, "B", true, 3, 4], "stu-cho": [11, 55, "C+", true, 4, 4],
      "stu-dan": [13.67, 68, "B", true, 1, 4], "stu-eve": null,
    });
    const seqAvg = {};
    for (let seq = 1; seq <= 6; seq++) seqAvg[seq] = (await live(seq, "stu-ama"))?.average ?? null;
    // S2 Maths 0.4·16 + 0.6·17 = 16.6, English 0.4·12 + 0.6·11 = 11.4 → (33.2 + 11.4)/3 = 14.87.
    // S3–S6 have no CA: S3 (2·14 + 8)/3 = 12; S4 (2·16 + 10)/3 = 14; S5 (2·15 + 9)/3 = 13; S6 (2·13 + 7)/3 = 11.
    check("live: Ama sequence averages S1..S6", seqAvg, { 1: 13.67, 2: 14.87, 3: 12, 4: 14, 5: 13, 6: 11 });

    for (const term of [1, 2, 3]) {
      await termGrading.computeClassTermAverages({ schoolId: LIVE, academicYear: YEAR, term, classId: `${L}${FORM3}` });
    }
    const terms = {};
    for (const term of [1, 2, 3]) {
      for (const [id] of PUPILS) {
        const r = await TermResult.findOne({ schoolId: LIVE, academicYear: YEAR, term, studentId: `${L}${id}` }).lean();
        terms[`T${term} ${id}`] = r ? [r.termAverage, r.overallGrade, r.isPassing, r.classPosition] : null;
      }
    }
    /*
     * Terms are the 50/50 mean of their two sequences, graded on the school's
     * bands (none here: the built-in table).
     *   Ama T1 (13.67 + 14.87)/2 = 14.27 B+; T2 (12 + 14)/2 = 13 B; T3 (13 + 11)/2 = 12 B.
     *   Bih S2 Maths 14, English 0.4·10 + 0.6·16 = 13.6 → 13.87; T1 (12.13 + 13.87)/2 = 13 B.
     *       S3 (2·11 + 13)/3 = 11.67, S4 (2·13 + 15)/3 = 13.67 → T2 12.67 B;
     *       S5 (2·12 + 14)/3 = 12.67, S6 (2·10 + 12)/3 = 10.67 → T3 11.67 C+.
     *   Cho (English only) S2 0.4·11 + 0.6·13 = 12.2 → T1 (11 + 12.2)/2 = 11.6 C+;
     *       T2 (10 + 12)/2 = 11 C+; T3 (11 + 9)/2 = 10 C.
     */
    check("live: every term row [average, grade, passing, position]", terms, {
      "T1 stu-ama": [14.27, "B+", true, 1], "T1 stu-bih": [13, "B", true, 3], "T1 stu-cho": [11.6, "C+", true, 4],
      "T1 stu-dan": [14.27, "B+", true, 1], "T1 stu-eve": null,
      "T2 stu-ama": [13, "B", true, 1], "T2 stu-bih": [12.67, "B", true, 3], "T2 stu-cho": [11, "C+", true, 4],
      "T2 stu-dan": [13, "B", true, 1], "T2 stu-eve": null,
      "T3 stu-ama": [12, "B", true, 1], "T3 stu-bih": [11.67, "C+", true, 3], "T3 stu-cho": [10, "C", true, 4],
      "T3 stu-dan": [12, "B", true, 1], "T3 stu-eve": null,
    });

    await annualGrading.computeClassAnnualAverages({ schoolId: LIVE, academicYear: YEAR, classId: `${L}${FORM3}` });
    const annual = {};
    for (const [id] of PUPILS) {
      const r = await AnnualResult.findOne({ schoolId: LIVE, academicYear: YEAR, studentId: `${L}${id}` }).lean();
      annual[id] = r ? [r.annualAverage, r.overallGrade, r.isPassing, r.promotionStatus, r.classPosition] : null;
    }
    /*
     * Ama (14.27·33.33 + 13·33.33 + 12·33.34)/100 = 13.0899 → 13.09 B
     * Bih (13·33.33 + 12.67·33.33 + 11.67·33.34)/100 = 12.4466 → 12.45 B
     * Cho (11.6·33.33 + 11·33.33 + 10·33.34)/100 = 10.8666 → 10.87 C
     * Promotion against the bar: no bar set, so the pass mark 10; all three
     * terms complete; each at or above 10 → promoted. Eve: no row (§4.6k).
     */
    check("live: annual rows [average, grade, passing, promotion, position]", annual, {
      "stu-ama": [13.09, "B", true, "promoted", 1], "stu-bih": [12.45, "B", true, "promoted", 3],
      "stu-cho": [10.87, "C", true, "promoted", 4], "stu-dan": [13.09, "B", true, "promoted", 1],
      "stu-eve": null,
    });

    const card = await buildStudentReportCardData(`${L}ex-seq1`, `${L}stu-ama`);
    check("live: sequence card headline", {
      average: card.data?.summary?.average ?? null, overallGrade: card.data?.summary?.overallGrade ?? null,
      isPassing: card.data?.summary?.isPassing ?? null, classPosition: card.data?.summary?.classPosition ?? null,
      weightedAverage: card.data?.computed?.weightedAverage ?? null,
    },
    // The card prints the stored figure: 13.67, B, 1st (docs/39 §4.7f closed by D1).
    { average: 13.67, overallGrade: "B", isPassing: true, classPosition: 1, weightedAverage: 13.67 });

    for (let seq = 1; seq <= 6; seq++) await results.publishResults(`${L}ex-seq${seq}`);
    const { decisions } = await promotion.generateRun({ schoolId: LIVE, fromYear: YEAR, toYear: NEXT_YEAR, generatedBy: null });
    // The run reads published ANNUAL results (D1b, decided). Only the
    // sequence summaries are published here, so every pupil needs a decision.
    check("live: promotion decisions [outcome, basis]", Object.fromEntries(decisions
      .map((x) => [x.studentId, [x.outcome, x.basis]]).sort()), {
      "L-stu-ama": ["unassigned", "no_results"], "L-stu-bih": ["unassigned", "no_results"], "L-stu-cho": ["unassigned", "no_results"],
      "L-stu-dan": ["unassigned", "no_results"], "L-stu-eve": ["unassigned", "no_results"],
    });
    check("live: paper summaries carry their year and term (§4.7e closed)", pick(await live(1, "stu-ama"), ["academicYear", "term"]),
      { academicYear: YEAR, term: "1" });

    // A re-process after publication.
    const before = await live(1, "stu-ama");
    const reprocess = await post(`/exams/${L}ex-seq1/process`, {});
    const after = await live(1, "stu-ama");
    // A published result is never recomputed (D3, decided): 409, nothing written.
    check("live: re-process after publication → 409, the row untouched",
      [reprocess.status, reprocess.body?.code, JSON.stringify(after) === JSON.stringify(before)], [409, "PUBLISHED_RESULTS", true]);

    // ── Provenance (docs/39 §8, Phase 2c) ───────────────────────────────
    //
    // Every row above now says what produced it: the snapshot of the
    // configuration it was computed under, and the code that computed it.
    // Stamping is additive — every figure pinned above is unchanged.

    console.log("--- provenance: policyHash and calcVersion on every row ---");
    const policySvc = require("../src/services/academicPolicy.service");
    const stamps = async (Model, filter) =>
      [...new Set((await Model.find(filter).select("policyHash calcVersion").lean())
        .map((r) => `${r.policyHash}|${r.calcVersion}`))].sort();

    const snapUnrouted = await policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR });
    const snapLive     = await policySvc.resolve({ schoolId: LIVE,   academicYear: YEAR });
    check("each school's snapshot is its own, intact",
      [snapUnrouted.schoolId, snapLive.schoolId, snapUnrouted._id === snapLive._id, policySvc.verify(snapUnrouted), policySvc.verify(snapLive)],
      [SCHOOL, LIVE, false, true, true]);

    const paperIds = (prefix) => ({ $in: [1, 2, 3, 4, 5, 6].map((q) => `${prefix}ex-seq${q}`) });
    check("unrouted path: every summary stamped results-service/1",
      await stamps(ResultSummary, { examId: paperIds("") }), [`${snapUnrouted._id}|results-service/1`]);
    check("live route: every summary stamped exam-process/3",
      await stamps(ResultSummary, { examId: paperIds(L) }), [`${snapLive._id}|exam-process/3`]);
    check("term rows stamped term/3, per school",
      [await stamps(TermResult, { schoolId: SCHOOL }), await stamps(TermResult, { schoolId: LIVE })],
      [[`${snapUnrouted._id}|term/3`], [`${snapLive._id}|term/3`]]);
    check("annual rows stamped annual/3, per school",
      [await stamps(AnnualResult, { schoolId: SCHOOL }), await stamps(AnnualResult, { schoolId: LIVE })],
      [[`${snapUnrouted._id}|annual/3`], [`${snapLive._id}|annual/3`]]);

    /*
     * A configuration edit touches no result. A recompute after it (once the
     * sequence is unpublished: a published one is refused) is stamped with
     * the new configuration, and follows the new CA split:
     *   S2 at 30/70: Maths 0.3·16 + 0.7·17 = 16.7, English 0.3·12 + 0.7·11 = 11.3
     *   → (33.4 + 11.3)/3 = 14.9 (was 14.87 at 40/60).
     */
    await GradingConfig.updateOne({ schoolId: LIVE }, { $set: { caWeight: 30, testWeight: 70 } });
    check("after a config edit, existing rows keep their stamp",
      await stamps(ResultSummary, { examId: paperIds(L) }), [`${snapLive._id}|exam-process/3`]);
    await ResultSummary.updateMany({ examId: `${L}ex-seq2` }, { $set: { isPublished: false } });
    await post(`/exams/${L}ex-seq2/process`, {});
    const s2After = await live(2, "stu-ama");
    const snapEdited = await policySvc.resolve({ schoolId: LIVE, academicYear: YEAR });
    check("a re-process is stamped with the new configuration; the others keep theirs", [
      s2After.policyHash === snapEdited._id, snapEdited._id !== snapLive._id,
      (await live(1, "stu-ama")).policyHash === snapLive._id,
    ], [true, true, true]);
    check("and its figure follows the new split: 14.9", s2After.average, 14.9);
    check("the earlier snapshot is still there to answer for the rows that used it",
      (await policySvc.get(snapLive._id, { schoolId: LIVE }))?._id, snapLive._id);

    server.close();
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
