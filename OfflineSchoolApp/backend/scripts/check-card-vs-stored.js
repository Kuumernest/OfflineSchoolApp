// backend/scripts/check-card-vs-stored.js
"use strict";

/**
 * docs/39 §4.7(f): the sequence card's average against the stored average —
 * every cause of a disagreement, one at a time, on synthetic schools through
 * the live POST /api/exams/:examId/process and the real card builder.
 *
 * Under the default rule (sequenceAverage "raw_mean") the stored summary and
 * the card are two calculations from the same marks:
 *
 *   stored  ResultSummary.average   round(Σ paper marks ÷ number of subjects)
 *           (exam.routes.js /process) — paper only, no coefficients, an absent
 *           subject counted as 0, a whole number, on the papers' own scale.
 *   card    computed.weightedAverage  Σ(mark/20 × coefficient) ÷ Σ coefficients
 *           (results.controller buildStudentReportCardData), rebuilt from the
 *           CURRENT marks on every print — CA blended by the school's split,
 *           absent subjects left out, two decimals, always on /20.
 *
 * The card prints the second as its average (reportHtml resolveAverage20)
 * while its headline grade is looked up on the first (resolveAvg20), and its
 * pass/fail and position are the stored row's. Which figure a school's card
 * should print is decision D1 / "the raw_mean card", not this suite's to
 * take: what is pinned here is TODAY's behaviour, labelled, and the invariant
 * that holds under the other rule.
 *
 * Causes, each isolated on its own school (marks /20 unless stated):
 *
 *   control      Maths 12, English 14, equal weight, no CA       stored 13  card 13
 *   rounding     Maths 12, English 13                            stored 13  card 12.5   (12.5 rounds up)
 *   coefficient  Maths 15 ×2, English 9 ×1                       stored 12  card 13     (39/3)
 *   CA           Maths 15 + CA 8/10, English 9 + CA 6/10, 40/60  stored 12  card 12.8   (15.4 and 10.2)
 *   absent       Maths absent, English 11                        stored 6   card 11     (5.5 rounds up; absent left out)
 *   stale        Maths 12, English 14; English corrected to 18
 *                after processing, not reprocessed               stored 13  card 15
 *   scale        Maths 60/100, English 70/100                    stored 65  card 13     (stored on the papers' scale)
 *
 * Under "weighted_20" the stored average IS the card's figure: equal for every
 * cause once processed (the stale one once reprocessed, which is the point of
 * staleness: nothing recomputes behind the school's back).
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
    return { school, paper, processed, read,
      remark: (subjectId, score) => M("StudentScore").updateOne({ examId: paper, subjectId }, { $set: { score } }),
      weighted: () => call(school, "PUT", `/academic-structure/${school}/${encodeURIComponent(YEAR)}/rules`,
        { rules: { sequenceAverage: "weighted_20" }, reason: "check-card-vs-stored" }),
    };
  };

  const CASES = {
    control:     { subjects: [{ id: "math", mark: 12 }, { id: "eng", mark: 14 }],                                   raw: [13, 13] },
    rounding:    { subjects: [{ id: "math", mark: 12 }, { id: "eng", mark: 13 }],                                   raw: [13, 12.5] },
    coefficient: { subjects: [{ id: "math", mark: 15, weight: 200 }, { id: "eng", mark: 9 }],                       raw: [12, 13] },
    ca:          { ca: true, subjects: [{ id: "math", mark: 15, ca: 8 }, { id: "eng", mark: 9, ca: 6 }],            raw: [12, 12.8] },
    absent:      { subjects: [{ id: "math", mark: null }, { id: "eng", mark: 11 }],                                 raw: [6, 11] },
    scale:       { subjects: [{ id: "math", mark: 60, max: 100 }, { id: "eng", mark: 70, max: 100 }],               raw: [65, 13] },
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- raw_mean (the default): each cause on its own ---");
  const built = {};
  for (const [name, c] of Object.entries(CASES)) {
    const s = await scenario(c);
    built[name] = s;
    await s.processed();
    const r = await s.read();
    check(`${name}: [stored, card] under raw_mean`, [r.stored, r.card], c.raw);
    check(`  ${name}: stamped exam-process/1`, r.calcVersion, "exam-process/1");
  }
  const stale = await scenario(CASES.control);
  await stale.processed();
  await stale.remark("eng", 18);
  check("stale: English corrected to 18 after processing — the card follows the marks, the stored row does not",
    [(await stale.read()).stored, (await stale.read()).card], [13, 15]);

  // Today's headline grade is the stored figure's, read as /20 (resolveAvg20).
  // On /100 papers that figure is 65, so the headline is the band of 65 "/20"
  // — the scale defect of §4.7(d), pinned so that its fix is a visible change.
  check("absent: the headline grade is the stored 6's (F), above a printed average of 11 (C+)",
    (await built.absent.read()).headline, "F");
  // On /100 papers the stored 65 is 65% — 13/20, B. Read as /20 it was "A+"
  // (docs/39 §4.7d/f); the headline now reads the stored figure through its
  // own percentage. On /20 papers nothing changes (the absent case above).
  check("scale: the headline grade is the stored 65's on /20 (65% = 13 → B), not 65 read as /20 (A+)",
    (await built.scale.read()).headline, "B");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- weighted_20: the stored average is the card's ---");
  for (const [name, s] of Object.entries(built)) {
    const put = await s.weighted();
    if (put.status !== 200) throw new Error(`rules → ${put.status}`);
    await s.processed();
    const r = await s.read();
    check(`${name}: stored === card under weighted_20`, [r.stored === r.card, r.card, r.calcVersion], [true, CASES[name].raw[1], "exam-process/2"]);
  }
  await stale.weighted();
  await stale.processed();
  await stale.remark("eng", 10);
  check("stale under weighted_20 too, until reprocessed: stored 15, card 11", [(await stale.read()).stored, (await stale.read()).card], [15, 11]);
  await stale.processed();
  check("  and equal again once reprocessed", [(await stale.read()).stored, (await stale.read()).card], [11, 11]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- §4.6l: a card row's pass flag ---");
  /*
   * CA 40/60, pass mark 10. English rows, each a pupil of its own school:
   *   paper 9 + CA 6/10    → 0.4·12 + 0.6·9 = 10.2   (paper alone: 9, failing)
   *   paper 9 + CA 5.75/10 → 0.4·11.5 + 5.4 = 10.00  (the boundary: passes)
   *   paper 9 + CA 5.7/10  → 0.4·11.4 + 5.4 = 9.96   (just under: fails)
   *   absent               → no mark: not passing
   * Under raw_mean the row keeps the paper's stored flag — which figure that
   * card prints is the school's decision (§4.7f). Under weighted_20 the rule
   * itself says a subject passes on its sequence mark, which the row prints
   * and the stored summary counts.
   */
  const rowOf = async (sc) => {
    const card = await buildStudentReportCardData(sc.paper, `p-${sc.school}`);
    return Object.fromEntries((card?.data?.subjects ?? []).map((r) => [r.subjectId, [r.normalizedMark, r.isPassing]])
      .sort(([a], [b]) => a.localeCompare(b)));
  };
  const flags = await scenario({ ca: true, subjects: [
    { id: "eng", mark: 9, ca: 6 }, { id: "edge", mark: 9, ca: 5.75 }, { id: "under", mark: 9, ca: 5.7 }, { id: "abs", mark: null } ] });
  await flags.processed();
  check("raw_mean: every row keeps the paper's flag (9/20 fails) whatever it prints — unchanged, pinned",
    await rowOf(flags), { abs: [null, false], edge: [10, false], eng: [10.2, false], under: [9.96, false] });
  await flags.weighted();
  await flags.processed();
  check("weighted_20: each row passes on the mark it prints — 10.2 and exactly 10 pass, 9.96 and absent do not",
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
