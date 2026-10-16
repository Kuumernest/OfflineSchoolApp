// backend/scripts/check-weighted-no-marks.js
"use strict";

/**
 * weighted_20: a pupil with no counted subject has no sequence result.
 *
 * The weighted_20 rule (shared/academicRules, docs/39 D1) averages the
 * subjects a pupil was marked in, absent and exempt subjects left out. A
 * pupil marked absent (or exempt) in EVERY subject leaves nothing to average,
 * and the route stored 0, grade F, not passing, ranked last; the term layer
 * then averaged that 0 in as a sequence the pupil had sat. That is the
 * sequence-level twin of docs/39 §4.6k (no term result → an artificial 0/F
 * annual row), and it is fixed the same way: no row. A pupil with no score
 * rows at all was already handled so (check:rulesmatrix, eve).
 *
 * The default rule is unchanged and pinned here too: raw_mean counts an
 * absent subject as zero (docs/39 §4.7c), so the same pupil still gets 0.
 *
 * Every figure is worked by hand. CA off, papers /20, Maths coefficient 2,
 * English 1, term 1 = sequences 1 and 2 at 50/50, pass mark 10:
 *
 *            seq 1 (M, E)        seq 2 (M, E)    weighted_20 seq1 / seq2      term 1
 *   ama      15, 9               15, 9           (30+9)/3 = 13 / 13           13
 *   zed      absent, absent      14, 11          none / (28+11)/3 = 13        13  (seq 2 alone)
 *   xan      absent, exempt      absent, absent  none / none                  no term row
 *
 *   raw_mean seq 1: ama round(24/2) = 12, 60%; zed 0, 0%; xan 0, 0%; places 1, 2, 2.
 *
 *   node scripts/check-weighted-no-marks.js
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

  const YEAR = "2026/2027";
  const A = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: A, name: "No-marks School", email: "nomarks@example.test" });
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: A, isActive: true });
  await M("GradingConfig").create({ schoolId: A, caEnabled: false, passMark: 10 });
  await M("AcademicStructure").create({ schoolId: A, academicYear: YEAR });
  await M("Class").create({ _id: "f1", schoolId: A, name: "Form 1" });
  const PUPILS = ["ama", "zed", "xan"];
  for (const p of PUPILS) {
    await M("Student").create({ _id: p, userId: `u-${p}`, schoolId: A, classId: "f1", className: "Form 1",
      studentName: `Pupil ${p}`, enrollmentNo: `NM-${p}`, status: "approved", isActive: true });
  }

  // A mark is a number, "abs" (absent) or "exe" (exempt).
  const MARKS = {
    1: { ama: [15, 9], zed: ["abs", "abs"], xan: ["abs", "exe"] },
    2: { ama: [15, 9], zed: [14, 11],       xan: ["abs", "abs"] },
  };
  for (const n of [1, 2]) {
    await M("Exam").create({ _id: `s${n}`, schoolId: A, name: `Sequence ${n}`, type: "test", academicYear: YEAR,
      term: 1, sequenceNumber: n, status: "completed", classId: "f1", classIds: ["f1"] });
    for (const [sub, w] of [["math", 200], ["eng", 100]]) {
      await M("ExamSubject").create({ _id: `s${n}-${sub}`, examId: `s${n}`, subjectId: sub, subjectName: sub,
        classId: "f1", schoolId: A, maxScore: 20, passMark: 10, weight: w, submissionStatus: "approved" });
    }
    for (const [p, marks] of Object.entries(MARKS[n])) {
      for (const [i, sub] of ["math", "eng"].entries()) {
        const m = marks[i];
        await M("StudentScore").create({ examId: `s${n}`, examSubjectId: `s${n}-${sub}`, studentId: p, subjectId: sub,
          classId: "f1", schoolId: A, maxScore: 20, score: typeof m === "number" ? m : null,
          isAbsent: m === "abs", isExempt: m === "exe" });
      }
    }
  }

  const app = express(); app.use(express.json());
  app.use("/api/exams",              auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  app.use("/api/term-results",       auth.authenticate, require("../src/routes/termResults.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const processSeq = (n) => call("POST", `/exams/s${n}/process`, { classId: "f1" });
  const computeTerm = () => call("POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "f1" });
  const seq = async (n, fields) => {
    const list = await M("ResultSummary").find({ schoolId: A, examId: `s${n}`, deletedAt: null }).lean();
    return Object.fromEntries(PUPILS.map((p) => {
      const r = list.find((x) => x.studentId === p);
      return [p, r ? fields.map((f) => r[f] ?? null) : null];
    }));
  };
  const term = async (fields) => {
    const list = await M("TermResult").find({ schoolId: A, term: 1, deletedAt: null }).lean();
    return Object.fromEntries(PUPILS.map((p) => {
      const r = list.find((x) => x.studentId === p);
      return [p, r ? fields.map((f) => r[f] ?? null) : null];
    }));
  };
  const cardAverage = async (n, p) => (await buildStudentReportCardData(`s${n}`, p))?.data?.computed?.weightedAverage ?? null;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- raw_mean (the default) is unchanged: absent counts as zero ---");
  for (const n of [1, 2]) await processSeq(n);
  check("seq 1 raw_mean [average, percentage, place, passing]", await seq(1, ["average", "percentage", "classPosition", "isPassing"]), {
    ama: [12, 60, 1, true], zed: [0, 0, 2, false], xan: [0, 0, 2, false],
  });
  check("  the default card still prints its rebuilt 0 for an all-absent pupil", await cardAverage(1, "zed"), 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- weighted_20: no counted subject, no sequence result ---");
  let r = await call("PUT", `/academic-structure/${A}/${encodeURIComponent(YEAR)}/rules`,
    { rules: { sequenceAverage: "weighted_20" }, reason: "check-weighted-no-marks" });
  check("rule set", r.status, 200);
  for (const n of [1, 2]) {
    r = await processSeq(n);
    check(`process seq ${n} → 200`, r.status, 200);
  }
  check("seq 1 [average, grade, place, of]: only ama; zed's and xan's unpublished raw_mean rows are gone",
    await seq(1, ["average", "overallGrade", "classPosition", "totalInClass"]), {
      ama: [13, "B", 1, 1], zed: null, xan: null,
    });
  check("seq 2: ama and zed tie at 13, xan has none",
    await seq(2, ["average", "classPosition", "totalInClass"]), {
      ama: [13, 1, 2], zed: [13, 1, 2], xan: null,
    });
  check("the route reports only the pupils it wrote", (await processSeq(1)).body?.processed, 1);
  check("the card agrees: no figure for zed on seq 1, 13 for ama", [await cardAverage(1, "zed"), await cardAverage(1, "ama")], [null, 13]);
  {
    const { renderReportCardHtml } = require("../src/services/reportHtml.service");
    const data = (await buildStudentReportCardData("s1", "zed"))?.data;
    let html = "";
    try { html = renderReportCardHtml(data); } catch (e) { html = `THREW ${e.message}`; }
    check("  zed's card still renders, with no NaN and no 0.00 average",
      [html.startsWith("THREW"), /NaN/.test(html), /0\.00\s*\/\s*20/.test(html)], [false, false, false]);
  }

  await computeTerm();
  check("term 1 [average, passing]: zed is seq 2 alone (13), not (0 + 13)/2; xan has no row",
    await term(["termAverage", "isPassing"]), { ama: [13, true], zed: [13, true], xan: null });
  check("  zed's seq 1 is recorded incomplete, not as a 0",
    (await M("TermResult").findOne({ schoolId: A, studentId: "zed" }).lean())?.sequenceAverages
      ?.map((s) => [s.sequence, s.isComplete]), [[1, false], [2, true]]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a published result is kept as issued ---");
  // zed sat seq 1 after all, it was processed and published, then the marks
  // were withdrawn: the issued row is not erased, and is not rewritten.
  await M("StudentScore").updateMany({ examId: "s1", studentId: "zed" }, { $set: { score: 12, isAbsent: false } });
  await processSeq(1);
  check("zed seq 1 marked: (24 + 12)/3 = 12", (await seq(1, ["average"])).zed, [12]);
  await M("ResultSummary").updateMany({ schoolId: A, examId: "s1" }, { $set: { isPublished: true } });
  await M("StudentScore").updateMany({ examId: "s1", studentId: "zed" }, { $set: { score: null, isAbsent: true } });
  const before = await M("ResultSummary").findOne({ schoolId: A, examId: "s1", studentId: "zed" }).lean();
  await processSeq(1);
  const after = await M("ResultSummary").findOne({ schoolId: A, examId: "s1", studentId: "zed" }).lean();
  check("the published row stays exactly as issued",
    JSON.stringify(after && { ...after, updatedAt: null }), JSON.stringify(before && { ...before, updatedAt: null }));
  check("  and is not counted in the class's places (ama alone, 1 of 1)",
    (await seq(1, ["classPosition", "totalInClass"])).ama, [1, 1]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
