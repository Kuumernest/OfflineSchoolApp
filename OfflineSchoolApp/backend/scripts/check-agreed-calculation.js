// backend/scripts/check-agreed-calculation.js
"use strict";

/**
 * The calculation every school uses, decided by the project owner on
 * 2026-10-16 (docs/39 §21.1, shared/academicRules.js), through the live
 * routes the apps call, on synthetic schools. Every expected figure is worked
 * out by hand in the comments; none is read back from the code under test.
 *
 *   A. Sequence average (POST /exams/:examId/process): CA on and off, a
 *      coefficient-2 subject, an absent subject against an entered 0, a CA
 *      with no paper row, a pupil absent in everything; stored === card.
 *   B. A published result is never recomputed (409, nothing written).
 *   C. A term mixing an old exam-process/1 summary with a new one reads the
 *      old one as its percentage ÷ 5.
 *   D. The rules API: the four Phase 4 choices refused (RULE_FIXED).
 *   E. Promotion: at, just above and just below a class bar; a class with no
 *      bar (the school's bar; the pass mark when the school sets none); a
 *      final-year class; a pupil with no published annual result; an
 *      incomplete year; the old 0–100 promotionAverage never read.
 *   F. Bars: a change refused while a draft run exists; a change without a
 *      reason refused; a change audited with its reason; the next year
 *      starting with the bars copied.
 *
 *   node scripts/check-agreed-calculation.js
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

  const YEAR = "2026/2027", NEXT = "2027/2028";
  const S = {
    A: new mongoose.Types.ObjectId().toString(),   // CA on, 40/60
    B: new mongoose.Types.ObjectId().toString(),   // CA off
    P: new mongoose.Types.ObjectId().toString(),   // promotion, pass mark 10
    Q: new mongoose.Types.ObjectId().toString(),   // promotion, pass mark 10.5, no bars at all
  };
  for (const [k, sid] of Object.entries(S)) {
    await M("School").create({ _id: sid, name: `Agreed ${k}`, email: `agreed-${k.toLowerCase()}@example.test` });
    await M("User").create({ _id: `adm-${k}`, name: `adm-${k}`, email: `adm-${k}@example.test`,
      password: "check-only-password", role: "school_admin", schoolId: sid, isActive: true });
  }
  await M("GradingConfig").create({ schoolId: S.A, caEnabled: true,  caWeight: 40, testWeight: 60, passMark: 10 });
  await M("GradingConfig").create({ schoolId: S.B, caEnabled: false, caWeight: 40, testWeight: 60, passMark: 10 });
  await M("GradingConfig").create({ schoolId: S.P, passMark: 10 });
  await M("GradingConfig").create({ schoolId: S.Q, passMark: 10.5 });
  for (const sid of Object.values(S)) await M("AcademicStructure").create({ schoolId: sid, academicYear: YEAR });

  // ── The routes ──────────────────────────────────────────────────────────
  const app = express(); app.use(express.json());
  app.use("/api/exams",              auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  app.use("/api/term-results",       auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/annual-results",     auth.authenticate, require("../src/routes/annualResults.routes"));
  app.use("/api/promotion",          auth.authenticate, require("../src/routes/promotion.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (k, method, url, body) => {
    const token = jwt.sign({ id: `adm-${k}`, role: "school_admin", schoolId: S[k] }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const rulesUrl = (k, y = YEAR) => `/academic-structure/${S[k]}/${encodeURIComponent(y)}/rules`;

  // ═══════════════════════════════════════════════════════════════════════
  // A. The sequence average
  //
  // Schools A (CA on, 40 CA / 60 paper) and B (CA off) hold the same marks.
  // Sequence 1 of term 1, class f1. Maths coefficient 2 (weight 200),
  // English 1 (weight 100). Papers /20, CA /10. A subject's mark is
  //   CA on:  0.4·(CA/10·20) + 0.6·paper   (the paper alone when it has no CA)
  //   CA off: the paper
  // and the average is Σ(coeff · mark) / Σ coeff over the subjects with a
  // paper mark.
  //
  //          Maths paper  Maths CA  English paper  English CA
  //   ama    15           8         9              6
  //   bih    absent       9         12             7
  //   dan    0            —         12             —
  //   eve    absent       —         12             —
  //   fay    (no row)     10        14             —
  //   gus    absent       —         absent         8
  //
  // School A (CA on):
  //   ama  Maths 0.4·16 + 0.6·15 = 15.4; English 0.4·12 + 0.6·9 = 10.2
  //        (2·15.4 + 10.2)/3 = 41/3 = 13.67
  //   bih  Maths absent: removed with its coefficient, whatever its CA.
  //        English 0.4·14 + 0.6·12 = 12.8              → 12.8
  //   dan  Maths 0 is a real 0 (no CA: the paper alone); English 12
  //        (2·0 + 12)/3                                → 4
  //   eve  Maths absent: removed; English 12            → 12
  //        (dan and eve differ only by 0 against absent: 4 against 12)
  //   fay  Maths: CA but no paper row → removed (decided; it counted the
  //        CA alone, 20/20, under the Phase 4 rule: (2·20 + 14)/3 = 18)
  //        English 14                                  → 14
  //   gus  no paper mark in any subject                → no summary at all
  // School B (CA off): the CA marks are ignored, every paper counts in full.
  //   ama  (2·15 + 9)/3 = 39/3 = 13
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- A. the sequence average ---");
  const PUPILS = ["ama", "bih", "dan", "eve", "fay", "gus"];
  const MARKS = {
    ama: { math: [15, 8],    eng: [9, 6] },
    bih: { math: ["abs", 9], eng: [12, 7] },
    dan: { math: [0, null],  eng: [12, null] },
    eve: { math: ["abs", null], eng: [12, null] },
    fay: { math: ["none", 10], eng: [14, null] },
    gus: { math: ["abs", null], eng: ["abs", 8] },
  };
  for (const k of ["A", "B"]) {
    const sid = S[k], c = `${k}-f1`;
    await M("Class").create({ _id: c, schoolId: sid, name: "Form 1", nextClassId: `${k}-f2` });
    for (const p of PUPILS) {
      await M("Student").create({ _id: `${k}-${p}`, userId: `u-${k}-${p}`, schoolId: sid, classId: c, className: "Form 1",
        studentName: `Pupil ${p}`, enrollmentNo: `${k}-${p}`, status: "approved", isActive: true });
    }
    const exam = (id, type, extra = {}) => M("Exam").create({ _id: id, schoolId: sid, name: id, type, academicYear: YEAR,
      term: 1, sequenceNumber: 1, status: "completed", classId: c, classIds: [c], ...extra });
    await exam(`${k}-p1`, "test");
    await exam(`${k}-c1`, "ca", { parentExamId: `${k}-p1` });
    for (const [eid, max] of [[`${k}-p1`, 20], [`${k}-c1`, 10]]) {
      for (const [sub, w] of [["math", 200], ["eng", 100]]) {
        await M("ExamSubject").create({ _id: `${eid}-${sub}`, examId: eid, subjectId: sub, subjectName: sub,
          classId: c, schoolId: sid, maxScore: max, passMark: 10, weight: w, submissionStatus: "approved" });
      }
    }
    for (const [p, subs] of Object.entries(MARKS)) {
      for (const [sub, [paper, ca]] of Object.entries(subs)) {
        if (paper !== "none") {
          await M("StudentScore").create({ examId: `${k}-p1`, examSubjectId: `${k}-p1-${sub}`, studentId: `${k}-${p}`,
            subjectId: sub, classId: c, schoolId: sid, maxScore: 20,
            score: paper === "abs" ? null : paper, isAbsent: paper === "abs" });
        }
        if (ca !== null) {
          await M("StudentScore").create({ examId: `${k}-c1`, examSubjectId: `${k}-c1-${sub}`, studentId: `${k}-${p}`,
            subjectId: sub, classId: c, schoolId: sid, maxScore: 10, score: ca, isAbsent: false });
        }
      }
    }
  }
  const seq = async (k, examId, fields) => {
    const rows = await M("ResultSummary").find({ schoolId: S[k], examId, deletedAt: null }).lean();
    return Object.fromEntries(PUPILS.map((p) => {
      const r = rows.find((x) => x.studentId === `${k}-${p}`);
      return [p, r ? fields.map((f) => r[f] ?? null) : null];
    }));
  };

  let r = await call("A", "POST", "/exams/A-p1/process", { classId: "A-f1" });
  check("A: process → 200, five summaries (gus has none)", [r.status, r.body?.processed], [200, 5]);
  check("A (CA on): [average, place]", await seq("A", "A-p1", ["average", "classPosition"]), {
    ama: [13.67, 2], bih: [12.8, 3], dan: [4, 5], eve: [12, 4], fay: [14, 1], gus: null,
  });
  check("A: stamped exam-process/3, with the year and term on the paper's summary",
    (await seq("A", "A-p1", ["calcVersion", "academicYear", "term"])).ama, ["exam-process/3", YEAR, "1"]);
  const fayRow = await M("ResultSummary").findOne({ schoolId: S.A, examId: "A-p1", studentId: "A-fay" }).lean();
  check("A: fay's Maths is listed with its CA (20/20) but not counted",
    (({ normalizedMark, caMark, weightedMark }) => [normalizedMark, caMark, weightedMark])(
      fayRow?.subjectBreakdown?.find((x) => x.subjectId === "math") ?? {}), [null, 20, null]);
  const cards = {};
  for (const p of ["ama", "bih", "dan", "eve", "fay"]) {
    cards[p] = (await buildStudentReportCardData("A-p1", `A-${p}`))?.data?.computed?.weightedAverage ?? null;
  }
  check("A: the card prints the stored figure for every pupil", cards,
    { ama: 13.67, bih: 12.8, dan: 4, eve: 12, fay: 14 });
  check("A: gus (no paper mark anywhere) has no card figure",
    (await buildStudentReportCardData("A-p1", "A-gus"))?.data?.computed?.weightedAverage ?? null, null);

  r = await call("B", "POST", "/exams/B-p1/process", { classId: "B-f1" });
  check("B (CA off): the paper counts 100 %: ama (2·15 + 9)/3 = 13, fay 14 (no Maths paper)",
    [r.status, (await seq("B", "B-p1", ["average"])).ama, (await seq("B", "B-p1", ["average"])).fay], [200, [13], [14]]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- B. a published result is never recomputed ---");
  await M("ResultSummary").updateMany({ schoolId: S.A, examId: "A-p1" }, { $set: { isPublished: true } });
  const frozen = JSON.stringify(await M("ResultSummary").find({ schoolId: S.A }).sort({ _id: 1 }).lean());
  r = await call("A", "POST", "/exams/A-p1/process", { classId: "A-f1" });
  check("process over published summaries → 409 PUBLISHED_RESULTS", [r.status, r.body?.code], [409, "PUBLISHED_RESULTS"]);
  check("  nothing written", JSON.stringify(await M("ResultSummary").find({ schoolId: S.A }).sort({ _id: 1 }).lean()), frozen);

  // ═══════════════════════════════════════════════════════════════════════
  // C. A term with an old and a new sequence.
  //
  // Sequence 2 of school A was processed before the decision and published:
  // an exam-process/1 summary for ama on papers /100, average 65 (the raw
  // mean of 60 and 70), percentage 65. Read as its percentage ÷ 5: 13.
  // Term 1 (sequences 50/50) = (13.67 + 13)/2 = 13.335 → 13.34.
  // (Read as stored it would have been (13.67 + 65)/2 = 39.34.)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- C. a term mixing an old and a new sequence ---");
  await M("Exam").create({ _id: "A-p2", schoolId: S.A, name: "A-p2", type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 2, status: "completed", classId: "A-f1", classIds: ["A-f1"] });
  await M("ResultSummary").create({ _id: "old-ama-2", examId: "A-p2", studentId: "A-ama", schoolId: S.A, classId: "A-f1",
    average: 65, percentage: 65, totalScore: 130, maxTotalScore: 200, subjectsTotal: 2, isPublished: true,
    calcVersion: "exam-process/1", policyHash: "old", subjectBreakdown: [] });
  const oldRow = JSON.stringify(await M("ResultSummary").findById("old-ama-2").lean());
  r = await call("A", "POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "A-f1" });
  const t1 = await M("TermResult").findOne({ schoolId: S.A, term: 1, studentId: "A-ama" }).lean();
  check("term 1 for ama: (13.67 + 13)/2 = 13.34, stamped term/3",
    [r.status, t1?.termAverage, t1?.sequenceAverages?.map((x) => x.average), t1?.calcVersion], [200, 13.34, [13.67, 13], "term/3"]);
  check("  the old summary is untouched", JSON.stringify(await M("ResultSummary").findById("old-ama-2").lean()), oldRow);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- D. the Phase 4 choices are gone ---");
  for (const [key, value] of [["sequenceAverage", "raw_mean"], ["gradingAuthority", "split"],
                              ["promotionRule", "majority_of_terms_passed"], ["publishedResults", "overwrite"]]) {
    r = await call("A", "PUT", rulesUrl("A"), { rules: { [key]: value }, reason: "try" });
    check(`PUT ${key} → 400 RULE_FIXED`, [r.status, r.body?.errors?.[0]?.code], [400, "RULE_FIXED"]);
  }
  r = await call("A", "GET", rulesUrl("A"));
  check("GET rules: the decided behaviour, the pass mark as the default bar",
    [r.body?.platform, r.body?.bars?.defaultBar, r.body?.bars?.defaultBarSource],
    [{ sequenceAverage: "weighted_20", gradingAuthority: "school_bands", promotionRule: "annual_average_at_least", publishedResults: "refuse" }, 10, "passMark"]);

  // ═══════════════════════════════════════════════════════════════════════
  // E. Promotion, school P (pass mark 10).
  //
  // Bars for 2026/2027: school bar 11; Form 1 (p1) its own bar 12. Form 2
  // (p2) has none, so 11. Form 5 (p5) is a final year. p1 carries an old
  // promotionAverage of 90 and p2 one of 95 (0–100): if either were read,
  // every pupil there would repeat.
  //
  // Each pupil's three published terms are equal, so the annual average
  // (terms 33.33 / 33.33 / 33.34) is that figure:
  //   p1  at 12 → promoted;  above 12.01 → promoted;  below 11.99 → repeated
  //       none (no term result) → no annual row → needs a decision
  //       part (terms 1 and 2 only) → annual 12.5 but the year is incomplete → needs a decision
  //   p2  ok 11 → promoted (school bar);  low 10.99 → repeated
  //   p5  grad 8 → graduated by the run (final year, whatever the average);
  //       its annual row still compares 8 with the school bar 11 → "repeated"
  // School Q (pass mark 10.5, no bars at all), class q1:
  //   q1  pass 10.5 → promoted;  fail 10.49 → repeated
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- E. promotion against the class's bar ---");
  const P = S.P, Q = S.Q;
  await M("Class").create({ _id: "p1", schoolId: P, name: "P Form 1", nextClassId: "p2", promotionAverage: 90 });
  await M("Class").create({ _id: "p2", schoolId: P, name: "P Form 2", nextClassId: "p3", promotionAverage: 95 });
  await M("Class").create({ _id: "p3", schoolId: P, name: "P Form 3" });
  await M("Class").create({ _id: "p5", schoolId: P, name: "P Form 5", isFinalYear: true });
  await M("Class").create({ _id: "q1", schoolId: Q, name: "Q Form 1", nextClassId: "q2" });
  await M("Class").create({ _id: "q2", schoolId: Q, name: "Q Form 2" });
  const PROMO = [
    [P, "p1", "at", [12, 12, 12]], [P, "p1", "above", [12.01, 12.01, 12.01]], [P, "p1", "below", [11.99, 11.99, 11.99]],
    [P, "p1", "none", []], [P, "p1", "part", [12, 13]],
    [P, "p2", "ok", [11, 11, 11]], [P, "p2", "low", [10.99, 10.99, 10.99]],
    [P, "p5", "grad", [8, 8, 8]],
    [Q, "q1", "pass", [10.5, 10.5, 10.5]], [Q, "q1", "fail", [10.49, 10.49, 10.49]],
  ];
  for (const [sid, cls, id, terms] of PROMO) {
    await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: sid, classId: cls, className: cls,
      studentName: `Pupil ${id}`, enrollmentNo: id, status: "approved", isActive: true });
    for (const [i, avg] of terms.entries()) {
      await M("TermResult").create({ schoolId: sid, academicYear: YEAR, term: i + 1, classId: cls, studentId: id,
        termAverage: avg, isPassing: avg >= 10, isPublished: true, sequenceAverages: [] });
    }
  }
  r = await call("P", "PUT", rulesUrl("P"), { rules: { promotionThreshold: 11, classThresholds: { p1: 12 } }, reason: "bars agreed by the board" });
  check("P: bars set (school 11, Form 1 12)", [r.status, r.body?.rules?.promotionThreshold, r.body?.rules?.classThresholds], [200, 11, { p1: 12 }]);
  const audit = await M("AuditLog").findOne({ action: "academic.rulesChanged", schoolId: P }).lean();
  check("  audited with the reason, before and after", [audit?.reason, audit?.before?.promotionThreshold, audit?.after?.promotionThreshold,
    audit?.after?.classThresholds], ["bars agreed by the board", null, 11, { p1: 12 }]);

  let prog = await call("P", "GET", `/promotion/progression?year=${encodeURIComponent(YEAR)}`);
  check("Progression before any annual result: p1 confirmed (12), p2 not (old 95 shown, bar 11), no published annual results",
    [prog.body?.year?.classes?.p1, prog.body?.year?.classes?.p2, prog.body?.data?.find((c) => c._id === "p2")?.promotionAverage],
    [{ bar: 12, confirmed: true, effectiveBar: 12, pupils: 5, publishedAnnual: 0 },
     { bar: null, confirmed: false, effectiveBar: 11, pupils: 2, publishedAnnual: 0 }, 95]);

  for (const k of ["P", "Q"]) {
    for (const cls of k === "P" ? ["p1", "p2", "p5"] : ["q1"]) {
      r = await call(k, "POST", "/annual-results/compute", { academicYear: YEAR, classId: cls });
      if (r.status !== 200) check(`annual compute ${cls}`, r.status, 200);
    }
    await call(k, "POST", "/annual-results/publish", { academicYear: YEAR });
  }
  const annual = async (id) => {
    const a = await M("AnnualResult").findOne({ studentId: id, academicYear: YEAR }).lean();
    return a ? [a.annualAverage, a.promotionStatus, a.calcVersion] : null;
  };
  const annuals = {};
  for (const [, , id] of PROMO) annuals[id] = await annual(id);
  check("annual rows [average, status, version]", annuals, {
    at: [12, "promoted", "annual/3"], above: [12.01, "promoted", "annual/3"], below: [11.99, "repeated", "annual/3"],
    none: null, part: [12.5, "pending", "annual/3"],
    // grad: the annual row knows nothing of final years: 8 < the school bar 11
    // → "repeated" on the row, while the run graduates the pupil (below).
    // Reported as a gap (docs/39 §20.0); not changed here.
    ok: [11, "promoted", "annual/3"], low: [10.99, "repeated", "annual/3"], grad: [8, "repeated", "annual/3"],
    pass: [10.5, "promoted", "annual/3"], fail: [10.49, "repeated", "annual/3"],
  });

  const run = async (k) => {
    const res = await call(k, "POST", "/promotion/runs", { fromYear: YEAR, toYear: NEXT });
    const runId = res.body?.run?._id;
    const ds = await M("PromotionDecision").find({ runId: String(runId) }).lean();
    return { status: res.status, runId, by: Object.fromEntries(ds.map((d) => [d.studentId, [d.outcome, d.basis]])) };
  };
  const pRun = await run("P");
  check("P run: the proposals", pRun.by, {
    at: ["promoted", "results_pass"], above: ["promoted", "results_pass"], below: ["repeated", "average_fail"],
    none: ["unassigned", "no_results"], part: ["unassigned", "no_results"],
    ok: ["promoted", "results_pass"], low: ["repeated", "average_fail"], grad: ["graduated", "final_year"],
  });
  const qRun = await run("Q");
  check("Q run (no bars: the pass mark 10.5)", qRun.by, { pass: ["promoted", "results_pass"], fail: ["repeated", "average_fail"] });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- F. bars: draft runs, reasons, the next year ---");
  const before = JSON.stringify((await M("AcademicStructure").findOne({ schoolId: P, academicYear: YEAR }).lean()).rules);
  r = await call("P", "PUT", rulesUrl("P"), { rules: { classThresholds: { p2: 10 } }, reason: "moving p2" });
  check("a bar change while P's draft run exists → 409 PROMOTION_RUN_DRAFT, nothing stored",
    [r.status, r.body?.code, JSON.stringify((await M("AcademicStructure").findOne({ schoolId: P, academicYear: YEAR }).lean()).rules)],
    [409, "PROMOTION_RUN_DRAFT", before]);
  r = await call("P", "DELETE", `/promotion/runs/${pRun.runId}`);
  check("the draft run discarded", r.status, 200);
  r = await call("P", "PUT", rulesUrl("P"), { rules: { classThresholds: { p2: 10 } } });
  check("a bar change without a reason → 400 REASON_REQUIRED", [r.status, r.body?.code], [400, "REASON_REQUIRED"]);
  r = await call("P", "PUT", rulesUrl("P"), { rules: { classThresholds: { p2: 10 } }, reason: "Form 2 bar confirmed at 10" });
  const audits = await M("AuditLog").find({ action: "academic.rulesChanged", schoolId: P }).sort({ createdAt: 1, _id: 1 }).lean();
  check("the change stored and audited with its reason",
    [r.status, r.body?.rules?.classThresholds, audits.length, audits.map((a) => a.reason).includes("Form 2 bar confirmed at 10")],
    [200, { p1: 12, p2: 10 }, 2, true]);
  prog = await call("P", "GET", `/promotion/progression?year=${encodeURIComponent(YEAR)}`);
  check("p2 now confirmed at 10; its old 95 is still stored, unread",
    [prog.body?.year?.classes?.p2?.confirmed, prog.body?.year?.classes?.p2?.effectiveBar,
     (await M("Class").findById("p2").lean()).promotionAverage], [true, 10, 95]);

  // The next year: its structure, created by a first read, starts from these bars.
  r = await call("P", "GET", `/academic-structure/${P}/${encodeURIComponent(NEXT)}`);
  const nextRules = (await M("AcademicStructure").findOne({ schoolId: P, academicYear: NEXT }).lean())?.rules;
  check("2027/2028 created with 2026/2027's bars", [r.status, nextRules?.promotionThreshold, nextRules?.classThresholds],
    [200, 11, { p1: 12, p2: 10 }]);
  // Created by a write instead (PUT of the year's shape): the same.
  r = await call("Q", "PUT", rulesUrl("Q"), { rules: { classThresholds: { q1: 9 } }, reason: "Q bars" });
  check("Q: a bar change while Q's draft run exists is refused too", r.status, 409);
  await call("Q", "DELETE", `/promotion/runs/${qRun.runId}`);
  r = await call("Q", "PUT", rulesUrl("Q"), { rules: { classThresholds: { q1: 9 } }, reason: "Q bars" });
  r = await call("Q", "PUT", `/academic-structure/${Q}/${encodeURIComponent(NEXT)}`, { maxAbsences: 30 });
  const qNext = (await M("AcademicStructure").findOne({ schoolId: Q, academicYear: NEXT }).lean())?.rules;
  check("Q's 2027/2028, created by a PUT, starts with q1's 9", [r.status, qNext?.classThresholds], [200, { q1: 9 }]);
  r = await call("P", "PUT", rulesUrl("P", NEXT), { rules: { classThresholds: { p1: 13 } }, reason: "next year Form 1" });
  check("a change to next year's bars leaves this year's alone",
    [r.status, (await M("AcademicStructure").findOne({ schoolId: P, academicYear: YEAR }).lean()).rules.classThresholds],
    [200, { p1: 12, p2: 10 }]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
