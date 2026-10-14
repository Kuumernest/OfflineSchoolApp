// backend/scripts/check-period-shapes.js
"use strict";

/**
 * Phase 6 (docs/39 §20): a school shapes its own year, within the bounds
 * every stored record lives in (shared/periodStructure.js).
 *
 *   A. The shape rules: 1–3 terms numbered in order, every term with at
 *      least one sequence, sequences numbered 1..m across the year (m ≤ 6),
 *      names, weights 0–100, term weights summing to 100.
 *   B. The save route: a valid new shape is stored; an invalid one is refused
 *      and nothing stored; a shape that would remove or move a period that
 *      already has exams is refused (409 PERIODS_IN_USE) and nothing stored;
 *      promotion exams that no longer exist are dropped.
 *   C. A school of two semesters with three evaluations each, end to end:
 *      term results made of three sequences by their weights, the annual
 *      result of two semesters, the default promotion status decided once
 *      both are complete (it waited for a third term that never comes), the
 *      term card's three columns named as the school names them, and the
 *      annual card weighting every sequence by its share of the year — all
 *      against figures worked out by hand.
 *
 *   node scripts/check-period-shapes.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");
  const M       = (n) => mongoose.model(n);

  const { validateTerms, periodsStillHolding } = require("../../shared/periodStructure");
  const termGrading   = require("../src/services/termGrading.service");
  const annualGrading = require("../src/services/annualGrading.service");
  const { buildTermCard, buildAnnualCard } = require("../src/services/reportCardData.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const seq = (number, name, weight = 50) => ({ number, name, weight, assessment: { type: "test" } });
  const SEMESTERS = [
    { number: 1, name: "First Semester",  weight: 50, sequences: [seq(1, "Eval 1", 40), seq(2, "Eval 2", 30), seq(3, "Eval 3", 30)] },
    { number: 2, name: "Second Semester", weight: 50, sequences: [seq(4, "Eval 4", 40), seq(5, "Eval 5", 30), seq(6, "Eval 6", 30)] },
  ];

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- A. the shape rules ---");
  const codes = (terms) => { const r = validateTerms(terms); return r.ok ? [] : r.errors.map((e) => e.code); };
  const DEFAULT = (await new (M("AcademicStructure"))({ schoolId: "x", academicYear: "y" }).toObject()).terms;
  check("the standard year (3 terms × 2 sequences) is valid", codes(DEFAULT), []);
  check("two semesters of three evaluations are valid", codes(SEMESTERS), []);
  check("one term of one sequence is valid",
    codes([{ number: 1, name: "Year", weight: 100, sequences: [seq(1, "Final")] }]), []);
  check("four terms → TERM_COUNT", codes([1, 2, 3, 4].map((n) => ({ number: n, name: `T${n}`, weight: 25, sequences: [seq(n, `S${n}`)] }))), ["TERM_COUNT"]);
  check("no terms → TERM_COUNT", codes([]), ["TERM_COUNT"]);
  check("seven sequences → SEQUENCE_COUNT",
    codes([{ number: 1, name: "A", weight: 50, sequences: [1, 2, 3, 4].map((n) => seq(n, `S${n}`)) },
           { number: 2, name: "B", weight: 50, sequences: [5, 6, 7].map((n) => seq(n, `S${n}`)) }]), ["SEQUENCE_COUNT"]);
  check("sequences numbered two-per-term after a three → SEQUENCE_NUMBER",
    codes([{ number: 1, name: "A", weight: 50, sequences: [seq(1, "a"), seq(2, "b"), seq(3, "c")] },
           { number: 2, name: "B", weight: 50, sequences: [seq(3, "d")] }]), ["SEQUENCE_NUMBER"]);
  check("terms out of order → TERM_NUMBER",
    codes([{ ...SEMESTERS[1], number: 2 }, { ...SEMESTERS[0], number: 1 }]).includes("TERM_NUMBER"), true);
  check("a term with no sequence → NO_SEQUENCES",
    codes([{ number: 1, name: "A", weight: 100, sequences: [] }]), ["NO_SEQUENCES"]);
  check("term weights not adding to 100 → WEIGHTS_SUM",
    codes([{ ...SEMESTERS[0], weight: 60 }, { ...SEMESTERS[1], weight: 60 }]), ["WEIGHTS_SUM"]);
  check("a nameless sequence → NAME_REQUIRED",
    codes([{ number: 1, name: "A", weight: 100, sequences: [seq(1, " ")] }]), ["NAME_REQUIRED"]);
  check("an exam in a sequence that moves to another term is held",
    periodsStillHolding(SEMESTERS, [{ _id: "e", name: "Seq 3", term: 2, sequenceNumber: 3 }]).map((e) => e.examId), ["e"]);
  check("an exam whose sequence stays in its term is not",
    periodsStillHolding(SEMESTERS, [{ _id: "e", term: 1, sequenceNumber: 2 }, { _id: "p", term: 2, sequenceNumber: null }]), []);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- B. the save route ---");
  const YEAR = "2026/2027";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Semester School", email: "semester@example.test" });
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: S, isActive: true });
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR, promotionExams: [5, 6] });

  const app = express(); app.use(express.json());
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const tok = jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const put = async (body) => {
    const r = await fetch(`${API}/academic-structure/${S}/${encodeURIComponent(YEAR)}`, {
      method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const stored = async () => (await M("AcademicStructure").findOne({ schoolId: S, academicYear: YEAR }).lean());

  // An exam already set in the standard year's term 2, sequence 3.
  await M("Exam").create({ _id: "held", schoolId: S, name: "Sequence 3", type: "test", academicYear: YEAR,
    term: 2, sequenceNumber: 3, status: "draft", classId: "c" });
  const before = JSON.stringify((await stored()).terms);
  let r = await put({ terms: SEMESTERS });
  check("moving sequence 3 (which has an exam) to another term → 409 PERIODS_IN_USE",
    [r.status, r.body?.code, r.body?.exams?.map((e) => e.examId)], [409, "PERIODS_IN_USE", ["held"]]);
  check("  nothing stored", JSON.stringify((await stored()).terms), before);
  r = await put({ terms: [{ number: 1, name: "A", weight: 100, sequences: [] }] });
  check("an invalid shape → 400 INVALID_STRUCTURE, nothing stored",
    [r.status, r.body?.code, JSON.stringify((await stored()).terms) === before], [400, "INVALID_STRUCTURE", true]);
  await M("Exam").deleteOne({ _id: "held" });
  r = await put({ terms: SEMESTERS, promotionExams: [3, 6, 7] });
  const s = await stored();
  check("with no exam in the way, two semesters are stored",
    [r.status, s.terms.map((t) => [t.name, t.weight, t.sequences.map((q) => q.number)])],
    [200, [["First Semester", 50, [1, 2, 3]], ["Second Semester", 50, [4, 5, 6]]]]);
  check("promotion exams the year no longer has are dropped", s.promotionExams, [3, 6]);
  r = await put({ passMark: 11 });
  check("a write without terms is unaffected by the shape rules", [r.status, (await stored()).passMark], [200, 11]);
  server.close();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- C. two semesters of three evaluations, end to end ---");
  await M("GradingConfig").create({ schoolId: S, caEnabled: false });
  await M("Class").create({ _id: "c", schoolId: S, name: "Form 1" });
  await M("Student").create({ _id: "p", userId: "u-p", schoolId: S, classId: "c", className: "Form 1",
    studentName: "Pupil", enrollmentNo: "ENR-P", status: "approved", isActive: true });
  const MARKS = { 1: 10, 2: 14, 3: 16, 4: 12, 5: 9, 6: 15 };
  for (const [q, mark] of Object.entries(MARKS)) {
    const n = Number(q), term = n <= 3 ? 1 : 2;
    await M("Exam").create({ _id: `e${n}`, schoolId: S, name: `Eval ${n}`, type: "test", academicYear: YEAR,
      term, sequenceNumber: n, status: "completed", classId: "c", classIds: ["c"] });
    await M("ExamSubject").create({ _id: `es${n}`, examId: `e${n}`, subjectId: "m", subjectName: "Maths",
      classId: "c", schoolId: S, maxScore: 20, passMark: 10, weight: 100 });
    await M("StudentScore").create({ examId: `e${n}`, examSubjectId: `es${n}`, studentId: "p", subjectId: "m",
      classId: "c", schoolId: S, maxScore: 20, score: mark });
    await M("ResultSummary").create({ examId: `e${n}`, studentId: "p", classId: "c", schoolId: S,
      totalScore: mark, maxTotalScore: 20, percentage: mark * 5, average: mark, isPassing: mark >= 10 });
  }
  for (const term of [1, 2]) await termGrading.computeClassTermAverages({ schoolId: S, academicYear: YEAR, term, classId: "c" });
  const terms = await M("TermResult").find({ schoolId: S }).sort({ term: 1 }).lean();
  // S1 (10×40 + 14×30 + 16×30)/100 = 13 · S2 (12×40 + 9×30 + 15×30)/100 = 12
  check("each semester's average from its three evaluations by their weights", terms.map((t) => t.termAverage), [13, 12]);
  check("each semester lists its three evaluations",
    terms.map((t) => t.sequenceAverages.map((q) => q.sequence)), [[1, 2, 3], [4, 5, 6]]);

  await annualGrading.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: "c" });
  const annual = await M("AnnualResult").findOne({ schoolId: S }).lean();
  check("the year from two semesters at 50/50", [annual?.annualAverage, annual?.termAverages.map((t) => t.term)], [12.5, [1, 2]]);
  check("the default promotion status is decided once both semesters are complete",
    annual?.promotionStatus, "promoted");

  const termCard = await buildTermCard({ schoolId: S, academicYear: YEAR, term: 1, classId: "c", studentId: "p" });
  check("the semester card: three columns, as the school names them",
    termCard?.sequenceColumns?.map((c) => c.name), ["Eval 1", "Eval 2", "Eval 3"]);
  check("  its subject mark weighs the three 40/30/30", termCard?.subjects?.[0]?.score, 13);
  check("  named as the school names the semester", termCard?.term, "First Semester");
  const annualCard = await buildAnnualCard({ schoolId: S, academicYear: YEAR, classId: "c", studentId: "p" });
  // shares: .5×.4, .5×.3, .5×.3 per semester → (10×20+14×15+16×15 + 12×20+9×15+15×15)/100 = 12.5
  check("the annual card weighs every evaluation by its share of the year", annualCard?.subjects?.[0]?.score, 12.5);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
