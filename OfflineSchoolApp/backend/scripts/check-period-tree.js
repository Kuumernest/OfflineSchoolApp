// backend/scripts/check-period-tree.js
"use strict";

/**
 * Phase 3 (docs/39 §20): the term and annual readers take their terms and
 * sequences from the snapshot's period tree, and nothing they compute moves.
 *
 *   A. Equivalence. For every shape a structure can be saved in — the
 *      default, custom weights, custom names, fewer terms, a term with no
 *      sequences, a repeated term number — every reader's view built from
 *      the tree equals the view it used to read off AcademicStructure.
 *      The one shape where they differ, a structure stored out of number
 *      order, is pinned: the same figures, listed in number order.
 *   B. The snapshot carries it. The tree a stored snapshot holds, read back
 *      from the database, gives the same terms as the structure it froze.
 *   C. End to end, with weights that are not 50/50 — which no other suite
 *      uses, so a tree that lost the weights would pass all of them: the
 *      real term and annual computations and the real term and annual
 *      cards, against figures worked out by hand.
 *
 * check:academic pins today's pipeline on the default structure; this pins
 * what it does not exercise.
 *
 *   node scripts/check-period-tree.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const { legacyTermsOf, legacyTermsFromPeriods } = require("../../shared/academicPolicy");
  const academicPolicy = require("../src/services/academicPolicy.service");
  const termGrading    = require("../src/services/termGrading.service");
  const annualGrading  = require("../src/services/annualGrading.service");
  const { buildTermCard, buildAnnualCard } = require("../src/services/reportCardData.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  // ── A. Every reader's view, before and after ────────────────────────────
  //
  // `before` is each reader exactly as it read the structure until Phase 3
  // (termGrading.loadTermContext/termResultFields, annualGrading
  // getTermWeights, reportCardData buildTermCard/buildAnnualCard,
  // results.controller's sequence name). `after` is the same reader on
  // legacyTermsOf.
  const views = (terms) => {
    const termNumbers = [...new Set(terms.map((t) => t.number))];
    const seqNumbers  = [...new Set(terms.flatMap((t) => (t.sequences || []).map((s) => s.number)))];
    const termOf = (n) => terms.find((t) => t.number === n) || null;
    return {
      termCompute: termNumbers.map((n) => {
        const tc = termOf(n);
        return { term: n, seqs: tc.sequences.map((s) => s.number),
                 weights: tc.sequences.map((s) => tc.sequences.find((x) => x.number === s.number)?.weight ?? 50) };
      }),
      annualCompute: terms.map((t) => ({ term: t.number, weight: t.weight })),
      termCard: termNumbers.map((n) => {
        const tc = termOf(n);
        return {
          name:    tc?.name || null,
          weights: (tc?.sequences || []).map((s) => [s.number, s.weight ?? 50]),
          columns: (tc?.sequences || []).map((sq) => ({ number: sq.number, name: sq.name || `Sequence ${sq.number}` })),
        };
      }),
      annualShare: termNumbers.flatMap((n) => seqNumbers.map((q) => {
        const tc = termOf(n);
        const sc = tc?.sequences?.find((s) => s.number === q);
        return [n, q, ((tc?.weight ?? 100 / 3) / 100) * ((sc?.weight ?? 50) / 100) * 100];
      })),
      sequenceName: seqNumbers.map((q) => terms.flatMap((t) => t.sequences || []).find((sq) => sq.number === q)?.name || null),
    };
  };
  const seq = (number, name, weight) => ({ number, name, weight, assessment: { type: "test" } });
  // Saved through the model, as the settings route saves, so defaults apply.
  const saved = async (key, terms) => {
    const doc = terms === undefined
      ? await M("AcademicStructure").create({ schoolId: `shape-${key}`, academicYear: "2026/2027" })
      : await M("AcademicStructure").create({ schoolId: `shape-${key}`, academicYear: "2026/2027", terms });
    return M("AcademicStructure").findById(doc._id).lean();
  };

  console.log("--- A. every reader sees the same terms through the tree ---");
  const SHAPES = {
    default:          undefined,
    customWeights:    [{ number: 1, name: "T1", weight: 25, sequences: [seq(1, "S1", 70), seq(2, "S2", 30)] },
                       { number: 2, name: "T2", weight: 35, sequences: [seq(3, "S3", 40), seq(4, "S4", 60)] },
                       { number: 3, name: "T3", weight: 40, sequences: [seq(5, "S5", 50), seq(6, "S6", 50)] }],
    customNames:      [{ number: 1, name: "Trimestre 1", sequences: [seq(1, "Évaluation 1"), seq(2, "Évaluation 2")] }],
    twoTerms:         [{ number: 1, name: "A", weight: 50, sequences: [seq(1, "S1", 100)] },
                       { number: 2, name: "B", weight: 50, sequences: [seq(2, "S2", 60), seq(3, "S3", 40)] }],
    emptyTerm:        [{ number: 1, name: "T1", weight: 60, sequences: [seq(1, "S1"), seq(2, "S2")] },
                       { number: 2, name: "T2", weight: 40, sequences: [] }],
    repeatedTerm:     [{ number: 1, name: "First", weight: 50, sequences: [seq(1, "S1", 80), seq(2, "S2", 20)] },
                       { number: 1, name: "Again", weight: 50, sequences: [seq(3, "S3")] }],
  };
  for (const [key, terms] of Object.entries(SHAPES)) {
    const structure = await saved(key, terms);
    check(`${key}: every reader's view unchanged`, views(legacyTermsOf(structure)), views(structure.terms));
  }

  {
    // Out of number order: only a raw API write can store this (the settings
    // screen edits the default in place). The tree lists in number order —
    // array order is deliberately not part of the policy hash (Phase 2b) —
    // so the same terms, sequences, names and weights come back reordered.
    const structure = await saved("outOfOrder", [
      { number: 2, name: "T2", weight: 50, sequences: [seq(4, "S4", 30), seq(3, "S3", 70)] },
      { number: 1, name: "T1", weight: 50, sequences: [seq(2, "S2", 60), seq(1, "S1", 40)] },
    ]);
    const tree = legacyTermsOf(structure);
    check("out of order: listed in number order",
      tree.map((t) => [t.number, t.sequences.map((s) => s.number)]), [[1, [1, 2]], [2, [3, 4]]]);
    const asSet = (terms) => terms.map((t) => ({ ...t, sequences: [...t.sequences].sort((a, b) => a.number - b.number) }))
      .sort((a, b) => a.number - b.number).map((t) => JSON.stringify([t.number, t.name, t.weight, t.sequences.map((s) => [s.number, s.name, s.weight ?? 50])]));
    check("out of order: the same terms, names and weights", asSet(tree), asSet(structure.terms));
  }

  // ── B. The snapshot holds the same tree ─────────────────────────────────
  console.log("--- B. a stored snapshot gives back the terms it froze ---");
  for (const key of ["default", "customWeights", "twoTerms"]) {
    const structure = await M("AcademicStructure").findOne({ schoolId: `shape-${key}` }).lean();
    const snap = await academicPolicy.resolve({ schoolId: `shape-${key}`, academicYear: "2026/2027", structure, gradingConfig: null });
    academicPolicy._resetCache();
    const reread = await academicPolicy.get(snap._id, { schoolId: `shape-${key}` });
    check(`${key}: the snapshot's tree, read back from the database, = the structure's`,
      legacyTermsFromPeriods(reread.policy.structure.periods), legacyTermsOf(structure));
  }

  // ── C. End to end, weights that are not 50/50 ───────────────────────────
  console.log("--- C. term and annual results and cards, custom weights ---");
  const S = "sch-tree", YEAR = "2026/2027", CLS = "cls-tree";
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR, terms: SHAPES.customWeights.map((t) => ({
    ...t, sequences: t.sequences.map((s) => ({ ...s, name: { 1: "First", 2: "Second" }[s.number] ?? s.name })),
  })) });
  await M("GradingConfig").create({ schoolId: S, caEnabled: false });
  await M("Class").create({ _id: CLS, schoolId: S, name: "Form 2" });
  await M("Student").create({ _id: "p1", userId: "usr-p1", schoolId: S, classId: CLS, className: "Form 2",
    studentName: "Pupil One", enrollmentNo: "ENR-T1", status: "approved", isActive: true });

  // One subject, one mark per sequence; the sequence summary carries the
  // same figure (summaries are seeded on /20, as check:term seeds them).
  const MARKS = { 1: 12, 2: 16, 3: 10, 4: 15, 5: 14, 6: 8 };
  for (const [q, mark] of Object.entries(MARKS)) {
    const n = Number(q), term = Math.ceil(n / 2), exam = `ex-${n}`;
    await M("Exam").create({ _id: exam, schoolId: S, name: `Sequence ${n}`, type: "test", academicYear: YEAR,
      term, sequenceNumber: n, status: "completed", classId: CLS, classIds: [CLS] });
    await M("ExamSubject").create({ _id: `es-${n}`, examId: exam, subjectId: "sub-m", subjectName: "Mathematics",
      classId: CLS, schoolId: S, maxScore: 20, passMark: 10, weight: 100 });
    await M("StudentScore").create({ examId: exam, examSubjectId: `es-${n}`, studentId: "p1", subjectId: "sub-m",
      classId: CLS, schoolId: S, maxScore: 20, score: mark });
    await M("ResultSummary").create({ examId: exam, studentId: "p1", classId: CLS, schoolId: S,
      totalScore: mark, maxTotalScore: 20, percentage: mark * 5, average: mark, isPassing: mark >= 10 });
  }

  for (const term of [1, 2, 3]) {
    await termGrading.computeClassTermAverages({ schoolId: S, academicYear: YEAR, term, classId: CLS });
  }
  const terms = await M("TermResult").find({ schoolId: S }).sort({ term: 1 }).lean();
  // T1 (12×70 + 16×30)/100 = 13.2 · T2 (10×40 + 15×60)/100 = 13 · T3 (14 + 8)/2 = 11
  check("term averages by the term's own sequence weights", terms.map((t) => t.termAverage), [13.2, 13, 11]);
  check("each term lists its sequences in order",
    terms.map((t) => t.sequenceAverages.map((s) => [s.sequence, s.average])),
    [[[1, 12], [2, 16]], [[3, 10], [4, 15]], [[5, 14], [6, 8]]]);

  await annualGrading.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: CLS });
  const annual = await M("AnnualResult").findOne({ schoolId: S }).lean();
  // (13.2×25 + 13×35 + 11×40)/100 = 12.25
  check("annual average by the terms' weights", annual?.annualAverage, 12.25);
  check("annual lists the terms in order", annual?.termAverages.map((t) => [t.term, t.average]), [[1, 13.2], [2, 13], [3, 11]]);
  check("all three terms complete and passed, so promoted", annual?.promotionStatus, "promoted");

  const termCard = await buildTermCard({ schoolId: S, academicYear: YEAR, term: 1, classId: CLS, studentId: "p1" });
  check("term card: the subject mark weighs the sequences 70/30", termCard?.subjects?.[0]?.score, 13.2);
  check("term card: one column per sequence, as the school names them",
    termCard?.sequenceColumns, [{ number: 1, name: "First" }, { number: 2, name: "Second" }]);
  check("term card: the term named as the school names it", termCard?.term, "T1");

  const annualCard = await buildAnnualCard({ schoolId: S, academicYear: YEAR, classId: CLS, studentId: "p1" });
  // Shares of the year: s1 .25×.70, s2 .25×.30, s3 .35×.40, s4 .35×.60, s5 .40×.50, s6 .40×.50
  // (12×17.5 + 16×7.5 + 10×14 + 15×21 + 14×20 + 8×20)/100 = 12.25
  check("annual card: the subject mark weighs every sequence by its share of the year",
    annualCard?.subjects?.[0]?.score, 12.25);

  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
