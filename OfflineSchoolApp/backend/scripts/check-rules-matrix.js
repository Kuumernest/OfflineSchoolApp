// backend/scripts/check-rules-matrix.js
"use strict";

/**
 * The decided calculation (shared/academicRules.js, docs/39 §21.1, decided by
 * the project owner on 2026-10-16), layer by layer, through the live routes
 * the apps call — on one synthetic school whose every expected figure is
 * worked out by hand below, not read back from the code under test.
 *
 * Phase 4 made these rules per-school choices and this suite crossed every
 * choice; the choices are gone (the rules API refuses them, check:academicrules
 * and check:agreedcalc). What it still covers, end to end over a whole year:
 *
 *   1. POST /exams/:examId/process → term → annual → promotion: figures,
 *      grades at the school's band edges (10 and 14), ranks with ties, an
 *      absent subject against a genuine zero, a pupil with no marks, an
 *      incomplete year and a complete one.
 *   2. Provenance: every row's calcVersion is its writer's (exam-process/3,
 *      term/3, annual/3) and its policyHash names a snapshot recording the
 *      decided rule set and the bars. Legacy rows (policyHash null) are read
 *      as they are and keep their null.
 *   3. D3: a published sequence, term or year is never recomputed — every
 *      layer refuses, a whole-school run names the class, nothing is written —
 *      and a correction goes through unpublishing first.
 *   4. Promotion on a complete year: the school's bar, a class's own bar.
 *
 *   node scripts/check-rules-matrix.js
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
  const promotion = require("../src/services/promotion.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  // ── The school ──────────────────────────────────────────────────────────

  const YEAR = "2026/2027", NEXT = "2027/2028";
  const A = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: A, name: "Matrix School", email: "matrix@example.test" });
  for (const [id, role] of [["adm", "school_admin"], ["tea", "teacher"]]) {
    await M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "check-only-password",
      role, schoolId: A, isActive: true });
  }
  // CA off, so every figure below is the paper's (the CA/paper split is the
  // school's; off, the paper counts in full). School bands with edges at 10
  // and 14, so the boundaries show; pass mark 10.
  const BANDS = [
    { grade: "TOP", minMark: 14, maxMark: 20,    gpaPoints: 4, remark: "Top band" },
    { grade: "MID", minMark: 10, maxMark: 13.99, gpaPoints: 2, remark: "Middle band" },
    { grade: "LOW", minMark: 0,  maxMark: 9.99,  gpaPoints: 0, remark: "Low band" },
  ];
  await M("GradingConfig").create({ schoolId: A, caEnabled: false, passMark: 10, grades: BANDS });
  // The default year: three terms, sequences 1-2, 3-4, 5-6, no promotion exams.
  await M("AcademicStructure").create({ schoolId: A, academicYear: YEAR });
  await M("Class").create({ _id: "f1", schoolId: A, name: "Form 1", nextClassId: "f2" });
  await M("Class").create({ _id: "f2", schoolId: A, name: "Form 2" });

  const PUPILS = ["ama", "bih", "cho", "dan", "eve", "fay"];
  for (const p of PUPILS) {
    await M("Student").create({ _id: p, userId: `u-${p}`, schoolId: A, classId: "f1", className: "Form 1",
      studentName: `Pupil ${p}`, enrollmentNo: `MX-${p}`, status: "approved", isActive: true });
  }

  /*
   * The same marks in every sequence, Maths coefficient 2, English 1, both /20:
   *
   *          Maths   English  (2M + E)/3, absent left out
   *   ama    15      9        (30 + 9)/3  = 13
   *   bih    12      18       (24 + 18)/3 = 14     ← the TOP edge
   *   cho    absent  10       10/1        = 10     ← the pass/MID edge (Maths and its coefficient removed)
   *   dan    0       10       (0 + 10)/3  = 3.33   (a real zero counts)
   *   fay    15      9        13                   ← ties ama
   *   eve    no marks at all: no summary, no term, no annual row
   *
   * Ranked by the average, competition style: bih 1, ama 2, fay 2, cho 4, dan 5.
   * Two equal sequences make each term (50/50) the sequence figure, and
   * equal terms (33.33/33.33/33.34) make the year the same figure again.
   */
  const MARKS = { ama: [15, 9], bih: [12, 18], cho: [null, 10], dan: [0, 10], fay: [15, 9] };
  const addSequence = async (n) => {
    const term = Math.ceil(n / 2);
    await M("Exam").create({ _id: `s${n}`, schoolId: A, name: `Sequence ${n}`, type: "test", academicYear: YEAR,
      term, sequenceNumber: n, status: "completed", classId: "f1", classIds: ["f1"] });
    for (const [sub, w] of [["math", 200], ["eng", 100]]) {
      await M("ExamSubject").create({ _id: `s${n}-${sub}`, examId: `s${n}`, subjectId: sub, subjectName: sub,
        classId: "f1", schoolId: A, maxScore: 20, passMark: 10, weight: w, submissionStatus: "approved" });
    }
    for (const [p, [maths, eng]] of Object.entries(MARKS)) {
      for (const [sub, score] of [["math", maths], ["eng", eng]]) {
        await M("StudentScore").create({ examId: `s${n}`, examSubjectId: `s${n}-${sub}`, studentId: p, subjectId: sub,
          classId: "f1", schoolId: A, maxScore: 20, score, isAbsent: score === null });
      }
    }
  };
  for (const n of [1, 2, 3, 4]) await addSequence(n);   // terms 1 and 2; term 3 comes later

  // ── The routes ──────────────────────────────────────────────────────────

  const app = express(); app.use(express.json());
  app.use("/api/exams",              auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  app.use("/api/term-results",       auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/annual-results",     auth.authenticate, require("../src/routes/annualResults.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = (who) => jwt.sign({ id: who, role: who === "adm" ? "school_admin" : "teacher", schoolId: A },
    process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, who, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token(who)}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const rulesUrl = `/academic-structure/${A}/${encodeURIComponent(YEAR)}/rules`;
  const putBars = (rules, reason = "check-rules-matrix") => call("PUT", "adm", rulesUrl, { rules, reason });
  const process_ = (n) => call("POST", "adm", `/exams/s${n}/process`, { classId: "f1" });
  const computeTerm = (term, classId = "f1") => call("POST", "adm", "/term-results/compute",
    { academicYear: YEAR, term, ...(classId ? { classId } : {}) });
  const computeYear = (classId = "f1") => call("POST", "adm", "/annual-results/compute",
    { academicYear: YEAR, ...(classId ? { classId } : {}) });

  const ROWS = { ResultSummary: {}, TermResult: {}, AnnualResult: {} };
  const rows = async (model, filter = {}) =>
    M(model).find({ schoolId: A, deletedAt: null, ...filter }).sort({ _id: 1 }).lean();
  const everything = async () => JSON.stringify(await Promise.all(Object.keys(ROWS).map((m) => rows(m))));
  const byPupil = (list, fields) => Object.fromEntries(PUPILS.map((p) => {
    const r = list.find((x) => x.studentId === p);
    return [p, r ? fields.map((f) => r[f] ?? null) : null];
  }));
  const seq = async (n, fields) => byPupil(await rows("ResultSummary", { examId: `s${n}` }), fields);
  const term = async (t, fields) => byPupil(await rows("TermResult", { term: t, classId: "f1" }), fields);
  const year = async (fields) => byPupil(await rows("AnnualResult", { classId: "f1" }), fields);
  const sorted = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);
  const snapshotRules = async (hash) => {
    const sn = await M("AcademicPolicySnapshot").findById(hash).lean();
    return sn ? sorted(sn.policy?.rules ?? null) : "missing";
  };
  const dropRuns = async () => { await M("PromotionDecision").deleteMany({ schoolId: A }); await M("PromotionRun").deleteMany({ schoolId: A }); };
  const run = async () => {
    const { decisions } = await promotion.generateRun({ schoolId: A, fromYear: YEAR, toYear: NEXT, generatedBy: null });
    await dropRuns();
    return Object.fromEntries(PUPILS.map((p) => {
      const d = decisions.find((x) => x.studentId === p);
      return [p, d ? [d.outcome, d.basis] : null];
    }));
  };
  const unpublish = (model, filter = {}) => M(model).updateMany({ schoolId: A, ...filter }, { $set: { isPublished: false } });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. sequences, terms, an incomplete year ---");
  for (const n of [1, 2, 3, 4]) {
    const r = await process_(n);
    if (r.status !== 200) check(`process s${n}`, r.status, 200);
  }
  check("sequence 1: [average, grade, place, passing]", await seq(1, ["average", "overallGrade", "classPosition", "isPassing"]), {
    ama: [13, "MID", 2, true], bih: [14, "TOP", 1, true], cho: [10, "MID", 4, true], dan: [3.33, "LOW", 5, false], eve: null, fay: [13, "MID", 2, true],
  });
  check("  the absent subject is left out, the zero is not (cho 10, dan 3.33)",
    [(await seq(1, ["average"])).cho[0], (await seq(1, ["average"])).dan[0]], [10, 3.33]);
  check("  the summary carries its year and term", (await seq(3, ["academicYear", "term"])).ama, [YEAR, "2"]);
  const HASH = (await rows("ResultSummary"))[0]?.policyHash;
  check("  stamped exam-process/3, every summary on one snapshot recording the decided rule set",
    [[...new Set((await rows("ResultSummary")).map((x) => `${x.calcVersion}|${x.policyHash}`))].length,
     (await rows("ResultSummary"))[0]?.calcVersion, await snapshotRules(HASH)],
    [1, "exam-process/3", { platform: "agreed/1" }]);

  for (const t of [1, 2]) await computeTerm(t);
  // Two equal sequences: each term is the sequence figure, graded on the school's bands.
  check("term 1: [average, grade, passing, place]", await term(1, ["termAverage", "overallGrade", "isPassing", "classPosition"]), {
    ama: [13, "MID", true, 2], bih: [14, "TOP", true, 1], cho: [10, "MID", true, 4], dan: [3.33, "LOW", false, 5], eve: null, fay: [13, "MID", true, 2],
  });
  check("  term rows: term/3, on the same snapshot as the summaries",
    [...new Set((await rows("TermResult")).map((t) => `${t.calcVersion}|${t.policyHash === HASH}`))], ["term/3|true"]);

  let r = await computeYear();
  check("two terms of three: the year is the two terms' figure, every status pending; eve has no row",
    [r.body?.computed, r.body?.noTerms, await year(["annualAverage", "overallGrade", "promotionStatus", "classPosition"])],
    [5, 1, { ama: [13, "MID", "pending", 2], bih: [14, "TOP", "pending", 1], cho: [10, "MID", "pending", 4],
      dan: [3.33, "LOW", "pending", 5], eve: null, fay: [13, "MID", "pending", 2] }]);
  check("  stamped annual/3, on the summaries' snapshot",
    [...new Set((await rows("AnnualResult")).map((a) => `${a.calcVersion}|${a.policyHash === HASH}`))], ["annual/3|true"]);
  for (const t of [1, 2]) await call("POST", "adm", "/term-results/publish", { academicYear: YEAR, term: t });
  await M("ResultSummary").updateMany({ schoolId: A }, { $set: { isPublished: true } });
  await call("POST", "adm", "/annual-results/publish", { academicYear: YEAR });
  check("the run on an incomplete year: every pupil needs a decision (eve: no evidence either)",
    Object.values(await run()).every((d) => d?.[0] === "unassigned" && d?.[1] === "no_results"), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3. D3: published results are never recomputed ---");
  const frozen = await everything();
  r = await process_(1);
  check("process → 409 PUBLISHED_RESULTS", [r.status, r.body?.code], [409, "PUBLISHED_RESULTS"]);
  r = await computeTerm(1);
  check("one class's term → 409", [r.status, r.body?.code], [409, "PUBLISHED_RESULTS"]);
  r = await computeTerm(1, null);
  check("the whole school's term: the class skipped and named", [r.status, r.body?.refusedClasses?.map((c) => c.classId)], [200, ["f1"]]);
  r = await computeYear();
  check("one class's year → 409", [r.status, r.body?.code], [409, "PUBLISHED_RESULTS"]);
  r = await computeYear(null);
  check("the whole school's year: the class skipped and named", [r.status, r.body?.refusedClasses?.map((c) => c.classId)], [200, ["f1"]]);
  check("nothing written by any refused run", await everything(), frozen);

  // A correction: dan's Maths in sequence 1 was 6, not 0. Unpublish, then recompute.
  //   dan s1 = (6·2 + 10)/3 = 7.33; term 1 = (7.33 + 3.33)/2 = 5.33; year (5.33 + 3.33)/2 = 4.33
  await M("StudentScore").updateOne({ examId: "s1", studentId: "dan", subjectId: "math" }, { $set: { score: 6 } });
  await unpublish("ResultSummary", { examId: "s1" });
  r = await process_(1);
  check("s1 unpublished → recomputed: dan 7.33, unpublished until re-issued",
    [r.status, (await seq(1, ["average", "isPublished"])).dan], [200, [7.33, false]]);
  await unpublish("TermResult", { term: 1 });
  r = await computeTerm(1);
  check("term 1 unpublished → recomputed: dan 5.33", [r.status, (await term(1, ["termAverage"])).dan], [200, [5.33]]);
  await unpublish("AnnualResult");
  r = await computeYear();
  check("the year unpublished → recomputed: dan 4.33", [r.status, (await year(["annualAverage"])).dan], [200, [4.33]]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4. the complete year: promotion against the bars ---");
  await M("StudentScore").updateOne({ examId: "s1", studentId: "dan", subjectId: "math" }, { $set: { score: 0 } });
  await process_(1);
  for (const n of [5, 6]) { await addSequence(n); await process_(n); }
  await M("ResultSummary").updateMany({ schoolId: A }, { $set: { isPublished: true } });
  await unpublish("TermResult");
  for (const t of [1, 2, 3]) { await computeTerm(t); await call("POST", "adm", "/term-results/publish", { academicYear: YEAR, term: t }); }
  check("three terms, every one the sequence figure", await term(3, ["termAverage", "isPassing"]), {
    ama: [13, true], bih: [14, true], cho: [10, true], dan: [3.33, false], eve: null, fay: [13, true],
  });

  // No bar set: the pass mark, 10. Every year is 13, 14, 10, 3.33, 13.
  r = await computeYear();
  await call("POST", "adm", "/annual-results/publish", { academicYear: YEAR });
  check("no bar: the pass mark 10 — cho at 10 promoted, dan repeats",
    Object.fromEntries(Object.entries(await year(["promotionStatus"])).map(([k, v]) => [k, v?.[0] ?? null])),
    { ama: "promoted", bih: "promoted", cho: "promoted", dan: "repeated", eve: null, fay: "promoted" });
  check("  the run proposes what the year says",
    await run(), { ama: ["promoted", "results_pass"], bih: ["promoted", "results_pass"], cho: ["promoted", "results_pass"],
      dan: ["repeated", "average_fail"], eve: ["unassigned", "no_results"], fay: ["promoted", "results_pass"] });

  r = await putBars({ promotionThreshold: 12 });
  await unpublish("AnnualResult");
  await computeYear();
  await call("POST", "adm", "/annual-results/publish", { academicYear: YEAR });
  check("school bar 12: cho (10) now repeats",
    Object.fromEntries(Object.entries(await year(["promotionStatus"])).map(([k, v]) => [k, v?.[0] ?? null])),
    { ama: "promoted", bih: "promoted", cho: "repeated", dan: "repeated", eve: null, fay: "promoted" });
  check("  the run agrees", await run(), { ama: ["promoted", "results_pass"], bih: ["promoted", "results_pass"],
    cho: ["repeated", "average_fail"], dan: ["repeated", "average_fail"], eve: ["unassigned", "no_results"], fay: ["promoted", "results_pass"] });
  check("  stamped annual/3 on a snapshot recording the decided rules and the bar",
    [[...new Set((await rows("AnnualResult")).map((a) => a.calcVersion))], await snapshotRules((await rows("AnnualResult"))[0]?.policyHash)],
    [["annual/3"], { platform: "agreed/1", promotionThreshold: 12 }]);

  r = await putBars({ classThresholds: { f1: 10 } });
  await unpublish("AnnualResult");
  await computeYear();
  check("a class bar of 10 overrides the school's 12: cho (10.00) promoted, dan not",
    [(await year(["promotionStatus"])).cho[0], (await year(["promotionStatus"])).dan[0]], ["promoted", "repeated"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 2. legacy rows (policyHash null) ---");
  // Form 2 holds rows written before stamping existed: no hash, no version.
  await M("Student").create({ _id: "gil", userId: "u-gil", schoolId: A, classId: "f2", className: "Form 2",
    studentName: "Pupil gil", enrollmentNo: "MX-gil", status: "approved", isActive: true });
  for (const [t, avg] of [[1, 11], [2, 12], [3, 13]]) {
    await M("TermResult").create({ schoolId: A, academicYear: YEAR, term: t, classId: "f2", studentId: "gil",
      termAverage: avg, isPassing: true, isPublished: true, sequenceAverages: [], policyHash: null, calcVersion: null });
  }
  const legacyBefore = JSON.stringify(await rows("TermResult", { classId: "f2" }));
  r = await computeYear("f2");
  const gil = (await rows("AnnualResult", { classId: "f2" }))[0];
  // (11·33.33 + 12·33.33 + 13·33.34)/100 = 12.0001 → 12
  check("the year read from legacy term rows as stored: 12, stamped with today's snapshot",
    [r.status, gil?.annualAverage, gil?.calcVersion, typeof gil?.policyHash === "string"], [200, 12, "annual/3", true]);
  check("  the legacy term rows keep their null hash and are not rewritten",
    JSON.stringify(await rows("TermResult", { classId: "f2" })), legacyBefore);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
