// backend/scripts/check-card-vs-stored.js
"use strict";

/**
 * docs/39 §4.7(f): the sequence card's average against the stored average —
 * every cause of a disagreement, one at a time, on synthetic schools through
 * the live POST /api/exams/:examId/process and the real card builder.
 *
 * Closed by D1, decided by the project owner on 2026-10-16 (docs/39 §21.1):
 * the stored average IS the card's figure (exam-process/3), equal for every
 * cause once processed. What stays is the reading of rows stored before the
 * decision (exam-process/1): they keep their figures, and their card reads
 * them exactly as before — the card's rebuilt figure printed, the headline
 * grade taken from the stored one. An unpublished old row follows the decided
 * calculation the next time its exam is processed.
 *
 *   stored (old)  round(Σ paper marks ÷ number of subjects), paper only, no
 *                 coefficients, an absent subject counted as 0, on the
 *                 papers' own scale (the route before the decision)
 *   card / now    Σ(mark/20 × coefficient) ÷ Σ coefficients, CA blended by
 *                 the school's split, a subject with no paper mark left out,
 *                 two decimals, on /20
 *
 * Causes, each isolated on its own school (marks /20 unless stated):
 *
 *                                                                 old row          now
 *   control      Maths 12, English 14, equal weight, no CA       13 (65 %)  card 13      13
 *   rounding     Maths 12, English 13                            13 (63 %)  card 12.5    12.5
 *   coefficient  Maths 15 ×2, English 9 ×1                       12 (60 %)  card 13      (30+9)/3 = 13
 *   CA           Maths 15 + CA 8/10, English 9 + CA 6/10, 40/60  12 (60 %)  card 12.8    (15.4+10.2)/2 = 12.8
 *   absent       Maths absent, English 11                         6 (28 %)  card 11      11
 *   scale        Maths 60/100, English 70/100                    65 (65 %)  card 13      13
 *   stale        processed now, then English corrected 14 → 18:  stored 13, card 15 until reprocessed
 *
 *   node scripts/check-card-vs-stored.js
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
  const { buildStudentReportCardData } = require("../src/controllers/results.controller");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const app = express(); app.use(express.json());
  app.use("/api/exams",              auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (school, method, url, body) => {
    const token = jwt.sign({ id: `adm-${school}`, role: "school_admin", schoolId: school }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await fetch(`${API}${url}`, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };

  const YEAR = "2026/2027";
  /**
   * One school, one pupil, one sequence paper with Maths and English.
   * subjects: [{ id, weight, max, mark (null = absent), ca (out of 10, or undefined) }]
   */
  const scenario = async ({ ca = false, subjects }) => {
    const school = new mongoose.Types.ObjectId().toString();
    await M("School").create({ _id: school, name: `School ${school.slice(-4)}`, email: `s${school}@example.test` });
    await M("User").create({ _id: `adm-${school}`, name: "adm", email: `adm${school}@example.test`,
      password: "check-only-password", role: "school_admin", schoolId: school, isActive: true });
    await M("GradingConfig").create({ schoolId: school, caEnabled: ca, caWeight: 40, testWeight: 60, passMark: 10 });
    await M("AcademicStructure").create({ schoolId: school, academicYear: YEAR });
    await M("Class").create({ _id: `c-${school}`, schoolId: school, name: "Form 1" });
    await M("Student").create({ _id: `p-${school}`, userId: `u-${school}`, schoolId: school, classId: `c-${school}`,
      className: "Form 1", studentName: "Pupil", enrollmentNo: `E-${school}`, status: "approved", isActive: true });
    const exam = (id, type, extra = {}) => M("Exam").create({ _id: id, schoolId: school, name: id, type,
      academicYear: YEAR, term: 1, sequenceNumber: 1, status: "completed", classId: `c-${school}`, classIds: [`c-${school}`], ...extra });
    const paper = `e-${school}`, caExam = `ca-${school}`;
    await exam(paper, "test");
    if (ca) await exam(caExam, "ca", { parentExamId: paper });
    for (const s of subjects) {
      await M("ExamSubject").create({ _id: `${paper}-${s.id}`, examId: paper, subjectId: s.id, subjectName: s.id,
        classId: `c-${school}`, schoolId: school, maxScore: s.max ?? 20, passMark: 10, weight: s.weight ?? 100, submissionStatus: "approved" });
      await M("StudentScore").create({ examId: paper, examSubjectId: `${paper}-${s.id}`, studentId: `p-${school}`, subjectId: s.id,
        classId: `c-${school}`, schoolId: school, maxScore: s.max ?? 20, score: s.mark, isAbsent: s.mark === null,
        // As the score routes write it: the paper alone on /20 against 10.
        isPassing: s.mark === null ? false : (s.mark / (s.max ?? 20)) * 20 >= 10 });
      if (ca && s.ca !== undefined) {
        await M("ExamSubject").create({ _id: `${caExam}-${s.id}`, examId: caExam, subjectId: s.id, subjectName: s.id,
          classId: `c-${school}`, schoolId: school, maxScore: 10, passMark: 5, weight: s.weight ?? 100, submissionStatus: "approved" });
        await M("StudentScore").create({ examId: caExam, examSubjectId: `${caExam}-${s.id}`, studentId: `p-${school}`, subjectId: s.id,
          classId: `c-${school}`, schoolId: school, maxScore: 10, score: s.ca });
      }
    }
    const processed = async () => {
      const r = await call(school, "POST", `/exams/${paper}/process`, { classId: `c-${school}` });
      if (r.status !== 200) throw new Error(`process → ${r.status} ${JSON.stringify(r.body)}`);
    };
    const read = async () => {
      const stored = await M("ResultSummary").findOne({ examId: paper, studentId: `p-${school}` }).lean();
      const card   = await buildStudentReportCardData(paper, `p-${school}`);
      return { stored: stored?.average ?? null, card: card?.data?.computed?.weightedAverage ?? null,
        calcVersion: stored?.calcVersion ?? null, headline: card?.data?.summary?.overallGrade ?? null };
    };
    // A summary as the route stored it before the decision (exam-process/1),
    // unpublished: what an old, not yet issued result looks like.
    const seedOld = ({ average, percentage, maxTotalScore }) => M("ResultSummary").create({
      _id: `old-${school}`, examId: paper, studentId: `p-${school}`, schoolId: school, classId: `c-${school}`,
      average, percentage, maxTotalScore, subjectsTotal: subjects.length, totalScore: (percentage / 100) * maxTotalScore,
      overallGrade: null, isPassing: average >= 10, isPublished: false, classPosition: 1, totalInClass: 1,
      calcVersion: "exam-process/1", policyHash: "before-the-decision", subjectBreakdown: [],
    });
    return { school, paper, processed, read, seedOld,
      remark: (subjectId, score) => M("StudentScore").updateOne({ examId: paper, subjectId }, { $set: { score } }),
    };
  };

  const CASES = {
    control:     { subjects: [{ id: "math", mark: 12 }, { id: "eng", mark: 14 }],                        old: [13, 65, 40],  card: 13 },
    rounding:    { subjects: [{ id: "math", mark: 12 }, { id: "eng", mark: 13 }],                        old: [13, 63, 40],  card: 12.5 },
    coefficient: { subjects: [{ id: "math", mark: 15, weight: 200 }, { id: "eng", mark: 9 }],            old: [12, 60, 40],  card: 13 },
    ca:          { ca: true, subjects: [{ id: "math", mark: 15, ca: 8 }, { id: "eng", mark: 9, ca: 6 }], old: [12, 60, 40],  card: 12.8 },
    absent:      { subjects: [{ id: "math", mark: null }, { id: "eng", mark: 11 }],                      old: [6, 28, 40],   card: 11 },
    scale:       { subjects: [{ id: "math", mark: 60, max: 100 }, { id: "eng", mark: 70, max: 100 }],    old: [65, 65, 200], card: 13 },
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an old (exam-process/1) row is read as before ---");
  const built = {};
  for (const [name, c] of Object.entries(CASES)) {
    const s = await scenario(c);
    built[name] = s;
    const [average, percentage, maxTotalScore] = c.old;
    await s.seedOld({ average, percentage, maxTotalScore });
    const r = await s.read();
    check(`${name}: [stored, card] on the old row`, [r.stored, r.card, r.calcVersion], [average, c.card, "exam-process/1"]);
  }
  // The headline grade is the stored figure's, read as /20 where every paper
  // is /20 (absent: 6 → F, above a printed 11), and through its own
  // percentage otherwise (scale: 65 % = 13 → B, not 65 read as /20, A+).
  check("absent: the old row's headline grade is the stored 6's (F), above a printed average of 11",
    (await built.absent.read()).headline, "F");
  check("scale: the old row's headline grade is 65 % = 13 → B, not 65 read as /20 (A+)",
    (await built.scale.read()).headline, "B");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- processed now: the stored average is the card's ---");
  for (const [name, s] of Object.entries(built)) {
    await s.processed();
    const r = await s.read();
    check(`${name}: the unpublished old row follows the decided calculation; stored === card`,
      [r.stored, r.card, r.calcVersion], [CASES[name].card, CASES[name].card, "exam-process/3"]);
  }
  const stale = await scenario(CASES.control);
  await stale.processed();
  await stale.remark("eng", 18);
  check("stale: English corrected to 18 after processing — the card follows the marks until reprocessed: stored 13, card 15",
    [(await stale.read()).stored, (await stale.read()).card], [13, 15]);
  await stale.processed();
  check("  and equal again once reprocessed: (12 + 18)/2 = 15", [(await stale.read()).stored, (await stale.read()).card], [15, 15]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- §4.6l: a card row's pass flag ---");
  /*
   * CA 40/60, pass mark 10. English rows, each a pupil of its own school:
   *   paper 9 + CA 6/10    → 0.4·12 + 0.6·9 = 10.2   (paper alone: 9, failing)
   *   paper 9 + CA 5.75/10 → 0.4·11.5 + 5.4 = 10.00  (the boundary: passes)
   *   paper 9 + CA 5.7/10  → 0.4·11.4 + 5.4 = 9.96   (just under: fails)
   *   absent               → no mark: not passing
   * On an old (exam-process/1) row the card row keeps the paper's stored
   * flag, as it always did. Under the decided calculation a subject passes on
   * its sequence mark, which the row prints and the stored summary counts.
   */
  const rowOf = async (sc) => {
    const card = await buildStudentReportCardData(sc.paper, `p-${sc.school}`);
    return Object.fromEntries((card?.data?.subjects ?? []).map((r) => [r.subjectId, [r.normalizedMark, r.isPassing]])
      .sort(([a], [b]) => a.localeCompare(b)));
  };
  const flags = await scenario({ ca: true, subjects: [
    { id: "eng", mark: 9, ca: 6 }, { id: "edge", mark: 9, ca: 5.75 }, { id: "under", mark: 9, ca: 5.7 }, { id: "abs", mark: null } ] });
  await flags.seedOld({ average: 7, percentage: 34, maxTotalScore: 80 });
  check("old row: every card row keeps the paper's flag (9/20 fails) whatever it prints — unchanged",
    await rowOf(flags), { abs: [null, false], edge: [10, false], eng: [10.2, false], under: [9.96, false] });
  await flags.processed();
  check("decided: each row passes on the mark it prints — 10.2 and exactly 10 pass, 9.96 and absent do not",
    await rowOf(flags), { abs: [null, false], edge: [10, true], eng: [10.2, true], under: [9.96, false] });
  const stored = await M("ResultSummary").findOne({ examId: flags.paper }).lean();
  check("  and the rows agree with the stored summary's count: 2 passed, 1 failed (absent counted in neither)",
    [stored?.subjectsPassed, stored?.subjectsFailed], [2, 1]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
