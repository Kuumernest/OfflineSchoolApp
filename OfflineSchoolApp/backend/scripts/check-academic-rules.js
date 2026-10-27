// backend/scripts/check-academic-rules.js
"use strict";

/**
 * The calculation rules, as decided for every school by the project owner on
 * 2026-10-16 (docs/39 §21.1, shared/academicRules.js). Phase 4 made them
 * per-school choices; this suite pinned each choice and the switching
 * between them, and is now the per-layer check of the one behaviour left.
 * Through the real routers and auth, over HTTP, on synthetic schools:
 *
 *   1. Every snapshot records the decided rule set ("agreed/1") and the
 *      school's bars; a Phase 4 choice still stored is ignored; a bar moves
 *      the hash; a stored manual_only is honoured.
 *   2. D1: the stored average is the figure the card prints — CA blended,
 *      coefficients, absent subjects left out — for every pupil (stored ===
 *      card weightedAverage), ranked on it, the subject passing on its blended
 *      mark, the paper's summary carrying its year and term (the CA's does
 *      not), stamped exam-process/3; the card and class statistics read it as
 *      /20 (no ×5).
 *   3. §12: term and annual rows store the school's own band (term/4).
 *   4. D1b/D2: the annual row's promotionStatus and the run's proposal come
 *      from ONE function and agree for every pupil; a class's own bar
 *      overrides the school's; a stored manual_only proposes nothing; an
 *      incomplete year needs a decision; a bar change is refused while a draft
 *      run exists.
 *   5. D3: a published sequence, term or annual result is never recomputed —
 *      409 for one class, the class skipped and named in a whole-school run —
 *      and nothing is written.
 *   6. The rules API: read (the decided rules, the bars, counts), preview,
 *      write bars only; the Phase 4 choices and malformed bodies refused with
 *      nothing stored; a no-op stores and audits nothing; a real change is
 *      audited before/after with its reason; teachers 403; another school
 *      403; a super_admin naming no school refused.
 *
 *   node scripts/check-academic-rules.js
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

  const academicPolicy = require("../src/services/academicPolicy.service");
  const promotion      = require("../src/services/promotion.service");
  const { lookupGrade } = require("../src/services/grading.service");
  const rulesLib       = require("../../shared/academicRules");
  const { resolvePolicy, canonicalJson } = require("../../shared/academicPolicy");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  // ── Two schools ─────────────────────────────────────────────────────────

  const YEAR = "2026/2027", NEXT = "2027/2028";
  const S = { A: new mongoose.Types.ObjectId().toString(), B: new mongoose.Types.ObjectId().toString() };
  const user = (id, role, schoolId) => M("User").create({
    _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId, isActive: true,
  });
  await M("School").createIndexes();
  await user("sup", "super_admin", null);
  for (const [k, sid] of Object.entries(S)) {
    await M("School").create({ _id: sid, name: `Rules School ${k}`, email: `rules-${k.toLowerCase()}@example.test` });
    await user(`adm-${k}`, "school_admin", sid);
    await user(`tea-${k}`, "teacher", sid);
  }

  const A = S.A;
  // CA on at 40/60, the shipped split. Custom bands, so "school_bands" shows.
  const BANDS = [
    { grade: "TOP", minMark: 14, maxMark: 20, gpaPoints: 4, remark: "Top band" },
    { grade: "MID", minMark: 10, maxMark: 13.99, gpaPoints: 2, remark: "Middle band" },
    { grade: "LOW", minMark: 0,  maxMark: 9.99, gpaPoints: 0, remark: "Low band" },
  ];
  await M("GradingConfig").create({ schoolId: A, caEnabled: true, caWeight: 40, testWeight: 60, passMark: 10, grades: BANDS });
  await M("GradingConfig").create({ schoolId: S.B, caEnabled: false });
  await M("AcademicStructure").create({ schoolId: A, academicYear: YEAR });
  await M("AcademicStructure").create({ schoolId: S.B, academicYear: YEAR });
  await M("Class").create({ _id: "f1", schoolId: A, name: "Form 1", nextClassId: "f2" });
  await M("Class").create({ _id: "f2", schoolId: A, name: "Form 2", nextClassId: "f3" });
  await M("Class").create({ _id: "f3", schoolId: A, name: "Form 3" });

  const PUPILS = ["ama", "bih", "cho"];
  for (const p of PUPILS) {
    await M("Student").create({ _id: p, userId: `u-${p}`, schoolId: A, classId: "f1", className: "Form 1",
      studentName: `Pupil ${p}`, enrollmentNo: `ENR-${p}`, status: "approved", isActive: true });
  }

  // Sequence 1: the paper and its CA. Maths coefficient 2, English 1.
  const exam = (id, type, extra = {}) => M("Exam").create({
    _id: id, schoolId: A, name: id, type, academicYear: YEAR, term: 1, sequenceNumber: 1,
    status: "completed", classId: "f1", classIds: ["f1"], ...extra,
  });
  await exam("p1", "test");
  await exam("c1", "ca", { parentExamId: "p1" });
  for (const [eid, max] of [["p1", 20], ["c1", 10]]) {
    for (const [sub, w] of [["math", 200], ["eng", 100]]) {
      await M("ExamSubject").create({ _id: `${eid}-${sub}`, examId: eid, subjectId: sub, subjectName: sub,
        classId: "f1", schoolId: A, maxScore: max, passMark: 10, weight: w, submissionStatus: "approved" });
    }
  }
  const mark = (eid, p, sub, score, max, absent = false) => M("StudentScore").create({
    examId: eid, examSubjectId: `${eid}-${sub}`, studentId: p, subjectId: sub, classId: "f1",
    schoolId: A, maxScore: max, score: absent ? null : score, isAbsent: absent,
  });
  // Ama: Maths 15/20 + CA 8/10 → 15.4; English 9/20 + CA 6/10 → 10.2  ⇒ (15.4×2 + 10.2)/3 = 13.67
  // Bih: Maths 12/20, no CA → 12;      English 14/20 + CA 5/10 → 12.4  ⇒ (12×2 + 12.4)/3  = 12.13
  // Cho: Maths absent;                 English 11/20 + CA 5.5/10 → 11  ⇒ 11 (absent left out)
  await mark("p1", "ama", "math", 15, 20); await mark("c1", "ama", "math", 8, 10);
  await mark("p1", "ama", "eng", 9, 20);   await mark("c1", "ama", "eng", 6, 10);
  await mark("p1", "bih", "math", 12, 20);
  await mark("p1", "bih", "eng", 14, 20);  await mark("c1", "bih", "eng", 5, 10);
  await mark("p1", "cho", "math", null, 20, true);
  await mark("p1", "cho", "eng", 11, 20);  await mark("c1", "cho", "eng", 5.5, 10);

  const app = express(); app.use(express.json());
  app.use("/api/exams",              auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results",            auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  app.use("/api/term-results",       auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/annual-results",     auth.authenticate, require("../src/routes/annualResults.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const ROLE = { adm: "school_admin", tea: "teacher" };
  const token = (who) => who === "sup"
    ? jwt.sign({ id: "sup", role: "super_admin", schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" })
    : jwt.sign({ id: who, role: ROLE[who.split("-")[0]], schoolId: S[who.split("-")[1]] }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, who, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token(who)}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const Y = encodeURIComponent(YEAR);
  const rulesUrl = (school = A) => `/academic-structure/${school}/${Y}/rules`;
  const summaries = async (examId = "p1") =>
    Object.fromEntries((await M("ResultSummary").find({ examId }).lean()).map((s) => [s.studentId, s]));
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. the decided rules in every snapshot ---");
  const structureA = await M("AcademicStructure").findOne({ schoolId: A }).lean();
  const policyOf = (structure) => resolvePolicy({ schoolId: A, academicYear: YEAR, structure, gradingConfig: null });
  const hashOf = (structure) => academicPolicy.hashOf(policyOf(structure));
  check("a school with no stored rules records the decided rule set",
    JSON.parse(canonicalJson(policyOf(structureA))).rules, { platform: "agreed/1" });
  check("a Phase 4 choice still stored is ignored: the same hash",
    hashOf({ ...structureA, rules: { sequenceAverage: "raw_mean", gradingAuthority: "split", publishedResults: "overwrite" } }),
    hashOf(structureA));
  check("a bar changes the hash", hashOf({ ...structureA, rules: { classThresholds: { f1: 12 } } }) !== hashOf(structureA), true);
  check("a stored manual_only is recorded (and honoured, section 4)",
    JSON.parse(canonicalJson(policyOf({ ...structureA, rules: { promotionRule: "manual_only" } }))).rules,
    { platform: "agreed/1", promotionRule: "manual_only" });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 2. D1: the stored average is the figure the card prints ---");
  let r = await call("POST", "adm-A", "/exams/p1/process", {});
  check("processes", r.status, 200);
  let rows = await summaries();
  check("averages [ama, bih, cho]", PUPILS.map((p) => rows[p]?.average), [13.67, 12.13, 11]);
  for (const p of PUPILS) {
    const card = await call("GET", "adm-A", `/results/p1/student/${p}/reportcard`);
    check(`${p}: stored average === the card's weightedAverage`,
      rows[p]?.average, card.body?.data?.computed?.weightedAverage);
  }
  check("ranked on the average", PUPILS.map((p) => rows[p]?.classPosition), [1, 2, 3]);
  check("English passes on its blended 10.2 (§4.6l)",
    rows.ama.subjectBreakdown.find((b) => b.subjectId === "eng")?.isPassing, true);
  check("Cho's absent Maths carries no mark and is left out",
    pick(rows.cho.subjectBreakdown.find((b) => b.subjectId === "math"), ["normalizedMark", "isAbsent"]),
    { normalizedMark: null, isAbsent: true });
  check("CA parts recorded on the row",
    pick(rows.ama.subjectBreakdown.find((b) => b.subjectId === "math"), ["caMark", "testMark", "caWeight", "testWeight", "normalizedMark", "coefficient"]),
    { caMark: 16, testMark: 15, caWeight: 40, testWeight: 60, normalizedMark: 15.4, coefficient: 2 });
  // 13.67, 12.13 and 11 all fall in MID (10–13.99).
  check("overall grade from the school's bands", PUPILS.map((p) => rows[p]?.overallGrade), ["MID", "MID", "MID"]);
  check("stamped exam-process/3 with the paper's year and term",
    PUPILS.map((p) => [rows[p]?.calcVersion, rows[p]?.academicYear, rows[p]?.term]),
    PUPILS.map(() => ["exam-process/3", YEAR, "1"]));
  check("the policy hash records the decided rule set",
    (await academicPolicy.get(rows.ama.policyHash, { schoolId: A }))?.policy?.rules, { platform: "agreed/1" });

  r = await call("POST", "adm-A", "/exams/c1/process", {});
  const caRow = (await summaries("c1")).ama;
  check("the CA exam's own summary carries no year (its marks are inside the paper's)",
    [r.status, caRow?.academicYear ?? null, caRow?.calcVersion], [200, null, "exam-process/3"]);

  const { averageOutOf20 } = require("../../shared/reportCard");
  check("the card's fallback reads an exam-process/3 average as /20; an exam-process/1 one still ×5",
    [averageOutOf20(13.67, "sequence", "exam-process/3"), averageOutOf20(12, "sequence", "exam-process/1")], [13.67, 60]);
  const classStats = require("../src/services/classStats.service");
  const cs = await classStats.sequenceClassStats({ schoolId: A, examId: "p1", classId: "f1" });
  // (13.67 + 12.13 + 11)/3 = 12.27
  check("class statistics read the exact /20 averages", [cs.average, cs.highest, cs.lowest], [12.27, 13.67, 11]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3. §12: term rows store the school's bands ---");
  // A second sequence, so term 1 has both.
  await M("Exam").create({ _id: "p2", schoolId: A, name: "p2", type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 2, status: "completed", classId: "f1", classIds: ["f1"] });
  for (const [p, avg] of [["ama", 14.33], ["bih", 9.87], ["cho", 13]]) {
    await M("ResultSummary").create({ examId: "p2", studentId: p, classId: "f1", schoolId: A, average: avg,
      isPassing: avg >= 10, calcVersion: "exam-process/3" });
  }
  r = await call("POST", "adm-A", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "f1" });
  const term = await M("TermResult").findOne({ schoolId: A, studentId: "ama", term: 1 }).lean();
  // The term average is read from the term's marks (term/4): p2's summaries
  // above have none behind them, so ama's term subjects are p1's — Maths 15.4
  // (coef 2), English 10.2 (coef 1): (2·15.4 + 10.2)/3 = 13.67 → MID
  // (10–13.99); the built-in table would have given a letter, not the
  // school's band. Under term/3 it was (13.67 + 14.33)/2 = 14.
  check("term 13.67 stored with the school's band, term/4",
    [r.status, term?.termAverage, term?.overallGrade, term?.overallRemark, term?.calcVersion], [200, 13.67, "MID", "Middle band", "term/4"]);
  check("  each sequence's grade on the school's bands too", term?.sequenceAverages?.map((x) => x.overallGrade), ["MID", "TOP"]);
  check("  and not the built-in letter", lookupGrade(13.67).grade !== "MID", true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4. D1b/D2: one promotion rule for the annual row and the run ---");
  // The year's term results, published: Ama strong, Bih weak, Cho in between.
  await M("TermResult").deleteMany({ schoolId: A });
  const TERMS = { ama: [14, 13, 15], bih: [9, 8, 11], cho: [11, 12, 10.5] };
  for (const [p, avgs] of Object.entries(TERMS)) {
    for (const [i, avg] of avgs.entries()) {
      await M("TermResult").create({ schoolId: A, academicYear: YEAR, term: i + 1, classId: "f1", studentId: p,
        termAverage: avg, isPassing: avg >= 10, isPublished: true, sequenceAverages: [] });
    }
  }
  // School bar 10, Form 1's own bar 12.
  r = await call("PUT", "adm-A", rulesUrl(), { rules: { promotionThreshold: 10, classThresholds: { f1: 12 } }, reason: "bars for the year" });
  check("bars set → 200", r.status, 200);
  r = await call("POST", "adm-A", "/annual-results/compute", { academicYear: YEAR, classId: "f1" });
  const annual = Object.fromEntries((await M("AnnualResult").find({ schoolId: A }).lean()).map((a) => [a.studentId, a]));
  // The annual average is read from the year's marks (annual/4), not from
  // the term rows above: the only marks are sequence 1's, so the year's
  // subject marks are its subject marks and the averages are its averages —
  // Ama 13.67, Bih 12.13, Cho 11 (section 2). Under annual/3 it was the
  // weighted mean of the term rows: 14, 9.33, 11.17.
  check("annual averages", PUPILS.map((p) => annual[p]?.annualAverage), [13.67, 12.13, 11]);
  // Bih's 12.13 clears Form 1's bar of 12; Cho's 11 clears the school's bar
  // of 10 but not Form 1's own, and repeats.
  check("annual status by Form 1's own bar of 12 (Cho's 11 repeats)",
    PUPILS.map((p) => annual[p]?.promotionStatus), ["promoted", "promoted", "repeated"]);
  check("annual rows: school bands and annual/4", PUPILS.map((p) => [annual[p]?.overallGrade, annual[p]?.calcVersion]),
    [["MID", "annual/4"], ["MID", "annual/4"], ["MID", "annual/4"]]);

  await M("AnnualResult").updateMany({ schoolId: A }, { $set: { isPublished: true } });
  const run1 = await promotion.generateRun({ schoolId: A, fromYear: YEAR, toYear: NEXT, generatedBy: "adm-A" });
  const byPupil = (run) => Object.fromEntries(run.decisions.map((d) => [d.studentId, d]));
  const d1 = byPupil(run1);
  check("the run proposes exactly what the annual rows say",
    PUPILS.map((p) => d1[p]?.outcome), PUPILS.map((p) => annual[p]?.promotionStatus));
  check("with destinations and bases", PUPILS.map((p) => [d1[p]?.toClassId, d1[p]?.basis, d1[p]?.average]),
    [["f2", "results_pass", 13.67], ["f2", "results_pass", 12.13], ["f1", "average_fail", 11]]);

  r = await call("PUT", "adm-A", rulesUrl(), { rules: { classThresholds: { f1: 11 } }, reason: "lower Form 1's bar" });
  check("a bar change while a draft run exists → 409 PROMOTION_RUN_DRAFT", [r.status, r.body?.code], [409, "PROMOTION_RUN_DRAFT"]);
  await M("PromotionRun").updateOne({ _id: run1.run._id }, { $set: { status: "discarded" } });

  // A manual_only stored before the decision is honoured; nothing can set it.
  r = await call("PUT", "adm-A", rulesUrl(), { rules: { promotionRule: "manual_only" }, reason: "x" });
  check("manual_only cannot be set → 400 RULE_FIXED", [r.status, r.body?.errors?.[0]?.code], [400, "RULE_FIXED"]);
  await M("AcademicStructure").updateOne({ schoolId: A }, { $set: { "rules.promotionRule": "manual_only" } });
  const run3 = await promotion.generateRun({ schoolId: A, fromYear: YEAR, toYear: NEXT, generatedBy: "adm-A" });
  check("a stored manual_only: every pupil awaits a decision (unassigned, basis manual)",
    PUPILS.map((p) => [byPupil(run3)[p]?.outcome, byPupil(run3)[p]?.basis]), PUPILS.map(() => ["unassigned", "manual"]));
  await M("PromotionRun").updateOne({ _id: run3.run._id }, { $set: { status: "discarded" } });
  await M("AcademicStructure").updateOne({ schoolId: A }, { $unset: { "rules.promotionRule": 1 } });

  await M("TermResult").deleteOne({ schoolId: A, studentId: "cho", term: 3 });
  const run4 = await promotion.generateRun({ schoolId: A, fromYear: YEAR, toYear: NEXT, generatedBy: "adm-A" });
  check("an incomplete year is not decided from results (Cho: 2 of 3 terms published)",
    [byPupil(run4).cho?.outcome, byPupil(run4).cho?.basis], ["unassigned", "no_results"]);
  await M("PromotionRun").updateOne({ _id: run4.run._id }, { $set: { status: "discarded" } });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 5. D3: published results are never recomputed ---");
  await M("ResultSummary").updateOne({ examId: "p1", studentId: "ama" }, { $set: { isPublished: true } });
  const before = JSON.stringify(await M("ResultSummary").find({ examId: "p1" }).sort({ studentId: 1 }).lean());
  r = await call("POST", "adm-A", "/exams/p1/process", {});
  check("processing an exam with a published result → 409 PUBLISHED_RESULTS",
    [r.status, r.body?.code, r.body?.published], [409, "PUBLISHED_RESULTS", 1]);
  check("  and nothing was written",
    JSON.stringify(await M("ResultSummary").find({ examId: "p1" }).sort({ studentId: 1 }).lean()), before);
  r = await call("POST", "adm-A", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "f1" });
  check("computing a class's term with published rows → 409", [r.status, r.body?.code], [409, "PUBLISHED_RESULTS"]);
  r = await call("POST", "adm-A", "/term-results/compute", { academicYear: YEAR, term: 1 });
  check("a whole-school term run skips that class and names it",
    [r.status, r.body?.refusedClasses?.map((c) => c.classId)], [200, ["f1"]]);
  r = await call("POST", "adm-A", "/annual-results/compute", { academicYear: YEAR, classId: "f1" });
  check("computing a class's year with published rows → 409", [r.status, r.body?.code], [409, "PUBLISHED_RESULTS"]);
  r = await call("PUT", "adm-A", rulesUrl(), { rules: { publishedResults: "overwrite" }, reason: "x" });
  check("overwrite cannot be chosen → 400 RULE_FIXED", [r.status, r.body?.errors?.[0]?.code], [400, "RULE_FIXED"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 6. the rules API ---");
  r = await call("GET", "tea-A", rulesUrl());
  check("a teacher may not read the rules (settings.view)", r.status, 403);
  r = await call("GET", "adm-A", `/academic-structure/${S.B}/${Y}/rules`);
  check("A reading B's rules → 403", r.status, 403);
  r = await call("GET", "sup", `/academic-structure/${S.B}/${Y}/rules`);
  check("super_admin naming B reads B's: no bars, the pass mark 10 as default",
    [r.status, r.body?.rules?.sequenceAverage, r.body?.bars?.defaultBar, r.body?.bars?.defaultBarSource], [200, "weighted_20", 10, "passMark"]);
  r = await call("GET", "adm-A", rulesUrl());
  check("A reads its rules, bars and impact counts",
    [r.status, r.body?.platform?.publishedResults, r.body?.bars?.classThresholds, r.body?.bars?.defaultBar,
     r.body?.impact?.sequence, r.body?.impact?.term?.published],
    // Sequence rows: p1 and its CA c1 (3 each) and p2 (3); Ama's p1 published.
    // Term rows: 9 seeded, Cho's term 3 removed → 8, all published.
    [200, "refuse", { f1: 12 }, 10, { published: 1, unpublished: 8 }, 8]);

  r = await call("POST", "adm-A", `${rulesUrl()}/preview`, { rules: { classThresholds: { f1: 13 } } });
  check("preview names the change and what it affects, and stores nothing",
    [r.status, r.body?.changes, (await M("AcademicStructure").findOne({ schoolId: A }).lean()).rules.classThresholds],
    [200, [{ rule: "classThresholds.f1", from: 12, to: 13, affects: ["annual", "promotion"] }], { f1: 12 }]);

  const storedBefore = JSON.stringify((await M("AcademicStructure").findOne({ schoolId: A }).lean()).rules);
  for (const [label, body] of [
    ["an unknown rule",          { rules: { averageMethod: "x" }, reason: "x" }],
    ["a Phase 4 choice",         { rules: { sequenceAverage: "raw_mean" }, reason: "x" }],
    ["a threshold off scale",    { rules: { promotionThreshold: 25 }, reason: "x" }],
    ["a class bar not a number", { rules: { classThresholds: { f1: "12" } }, reason: "x" }],
    ["an array body",            { rules: [], reason: "x" }],
  ]) {
    r = await call("PUT", "adm-A", rulesUrl(), body);
    check(`${label} → 400 INVALID_RULES`, [r.status, r.body?.code], [400, "INVALID_RULES"]);
  }
  check("  none of them stored anything", JSON.stringify((await M("AcademicStructure").findOne({ schoolId: A }).lean()).rules), storedBefore);

  const audits = () => M("AuditLog").countDocuments({ action: "academic.rulesChanged", schoolId: A });
  const n0 = await audits();
  r = await call("PUT", "adm-A", rulesUrl(), { rules: { classThresholds: { f1: 12 } } });
  check("a change to the current value → 200 changed:false, no audit row", [r.status, r.body?.changed, await audits()], [200, false, n0]);
  r = await call("PUT", "tea-A", rulesUrl(), { rules: { classThresholds: { f1: 9 } }, reason: "x" });
  check("a teacher may not change them", r.status, 403);
  r = await call("PUT", "adm-A", `/academic-structure/${S.B}/${Y}/rules`, { rules: { promotionThreshold: 9 }, reason: "x" });
  check("A writing B's rules → 403", r.status, 403);
  check("  B untouched", (await M("AcademicStructure").findOne({ schoolId: S.B }).lean()).rules ?? null, null);
  r = await call("PUT", "adm-A", rulesUrl(), { rules: { classThresholds: { f1: 11 } } });
  check("a real change without a reason → 400 REASON_REQUIRED", [r.status, r.body?.code, await audits()], [400, "REASON_REQUIRED", n0]);
  r = await call("PUT", "adm-A", rulesUrl(), { rules: { classThresholds: { f1: 11 } }, reason: "board lowered Form 1's bar" });
  const audit = await M("AuditLog").findOne({ action: "academic.rulesChanged", schoolId: A, reason: "board lowered Form 1's bar" }).lean();
  check("a real change is audited with before, after, actor and reason",
    [await audits(), audit?.before?.classThresholds, audit?.after?.classThresholds, audit?.actorId, audit?.reason],
    [n0 + 1, { f1: 12 }, { f1: 11 }, "adm-A", "board lowered Form 1's bar"]);
  r = await call("PUT", "sup", `/academic-structure/x/${Y}/rules`, { rules: { promotionThreshold: 9 }, reason: "x" });
  check("a super_admin naming no real school is refused", r.status >= 400, true);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
