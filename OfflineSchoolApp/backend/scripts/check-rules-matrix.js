// backend/scripts/check-rules-matrix.js
"use strict";

/**
 * The calculation rules (shared/academicRules.js, docs/39 Phase 4), rule by
 * rule, through the live routes the apps call — on one synthetic school whose
 * every expected figure is worked out by hand below, not read back from the
 * code under test.
 *
 * check:academicrules proves each rule's headline effect. This suite covers
 * what it leaves open (docs/39 §20.0, "Validation"):
 *
 *   1. Every rule's default, and every invalid value or incoherent set
 *      refused by the server with nothing stored and nothing audited.
 *   2. Every rule's preview: what it says moves, and what it reaches; a
 *      preview stores nothing.
 *   3. Every rule change audited with before/after and the reason (null when
 *      none is given).
 *   4. The pipeline — POST /exams/:examId/process → term → annual →
 *      promotion — under raw_mean and weighted_20, split and school_bands,
 *      and the four promotion rules: figures, grades at band boundaries,
 *      ranks with ties, an absent subject against a genuine zero, a pupil
 *      with no marks, an incomplete year and a complete one.
 *   5. Provenance: every row's calcVersion is its writer's for the rules in
 *      force, and its policyHash names a snapshot recording exactly those
 *      rules. A rule change alone rewrites no row. Legacy rows
 *      (policyHash null) are read as they are and keep their null.
 *   6. D3: under "overwrite" a recompute rewrites published term and annual
 *      figures and keeps them published (its defined behaviour); under
 *      "refuse" every layer refuses, nothing is written, and unpublishing
 *      first lets the recompute through.
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
  // CA off, so every figure below is the paper's. School bands with edges at
  // 10 and 14, so the boundaries show; pass mark 10.
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
   *          Maths   English  raw_mean: round(Σ/2)  %      weighted_20: (2M + E)/3, absent left out
   *   ama    15      9        12                    60     (30 + 9)/3  = 13
   *   bih    12      18       15                    75     (24 + 18)/3 = 14     ← the TOP edge
   *   cho    absent  10        5 (absent counts 0)  25     10/1        = 10     ← the pass/MID edge
   *   dan    0       10        5 (a real zero)      25     (0 + 10)/3  = 3.33
   *   fay    15      9        12                    60     13                   ← ties ama
   *   eve    no marks at all: no summary, no term, no annual row
   *
   * raw_mean ranks by percentage, competition style: bih 1, ama 2, fay 2, cho 4, dan 4.
   * weighted_20 ranks by the average: bih 1, ama 2, fay 2, cho 4, dan 5.
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
  const putRules = (rules, reason) => call("PUT", "adm", rulesUrl, reason === undefined ? { rules } : { rules, reason });
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
  // A snapshot stores its policy in canonical (sorted-key) form.
  const sorted = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);
  const snapshotRules = async (hash) => {
    const s = await M("AcademicPolicySnapshot").findById(hash).lean();
    return s ? sorted(s.policy?.rules ?? null) : "missing";
  };
  const audits = () => M("AuditLog").find({ action: "academic.rulesChanged", schoolId: A }).sort({ createdAt: 1, _id: 1 }).lean();
  const storedRules = async () => (await M("AcademicStructure").findOne({ schoolId: A, academicYear: YEAR }).lean()).rules ?? null;
  const dropRuns = async () => { await M("PromotionDecision").deleteMany({ schoolId: A }); await M("PromotionRun").deleteMany({ schoolId: A }); };
  const run = async () => {
    const { decisions } = await promotion.generateRun({ schoolId: A, fromYear: YEAR, toYear: NEXT, generatedBy: null });
    await dropRuns();
    return Object.fromEntries(PUPILS.map((p) => {
      const d = decisions.find((x) => x.studentId === p);
      return [p, d ? [d.outcome, d.basis] : null];
    }));
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. defaults, and what the server refuses ---");
  let r = await call("GET", "adm", rulesUrl);
  check("every rule at its default; isDefault", [r.status, r.body?.rules, r.body?.isDefault], [200, {
    sequenceAverage: "raw_mean", gradingAuthority: "split", promotionRule: "legacy", publishedResults: "overwrite",
    promotionThreshold: null, classThresholds: {},
  }, true]);

  const refused = [
    ["sequenceAverage 'gpa'",            { sequenceAverage: "gpa" },              "INVALID_VALUE"],
    ["gradingAuthority 'teacher'",        { gradingAuthority: "teacher" },          "INVALID_VALUE"],
    ["promotionRule 'everyone'",          { promotionRule: "everyone" },            "INVALID_VALUE"],
    ["publishedResults 'ignore'",         { publishedResults: "ignore" },           "INVALID_VALUE"],
    ["promotionThreshold -1",             { promotionThreshold: -1 },               "INVALID_THRESHOLD"],
    ["promotionThreshold 21",             { promotionThreshold: 21 },               "INVALID_THRESHOLD"],
    ["promotionThreshold '12' (a string)", { promotionThreshold: "12" },            "INVALID_THRESHOLD"],
    ["classThresholds as an array",       { classThresholds: [12] },                "INVALID_THRESHOLD"],
    ["a class bar of 25",                 { classThresholds: { f1: 25 } },          "INVALID_THRESHOLD"],
    ["an unknown rule",                   { rounding: "up" },                       "UNKNOWN_RULE"],
  ];
  for (const [label, body, code] of refused) {
    r = await putRules(body, "should not be stored");
    check(`PUT ${label} → 400 INVALID_RULES ${code}`,
      [r.status, r.body?.code, (r.body?.errors ?? []).some((e) => e.code === code)], [400, "INVALID_RULES", true]);
    r = await call("POST", "adm", `${rulesUrl}/preview`, { rules: body });
    check(`  and its preview → 400`, r.status, 400);
  }
  r = await putRules({ promotionRule: "annual_average_at_least", classThresholds: { f1: 12 } });
  check("annual_average_at_least with only a class bar → 400 THRESHOLD_REQUIRED (the school bar is the fallback)",
    [r.status, (r.body?.errors ?? []).map((e) => e.code)], [400, ["THRESHOLD_REQUIRED"]]);
  check("nothing refused was stored or audited", [await storedRules(), (await audits()).length], [null, 0]);
  r = await call("PUT", "tea", rulesUrl, { rules: { sequenceAverage: "weighted_20" } });
  check("a teacher may not change the rules → 403", r.status, 403);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 2. the preview, rule by rule ---");
  const previews = [
    [{ sequenceAverage: "weighted_20" },  [{ rule: "sequenceAverage",  from: "raw_mean", to: "weighted_20", affects: ["sequence", "term", "annual"] }]],
    [{ gradingAuthority: "school_bands" }, [{ rule: "gradingAuthority", from: "split", to: "school_bands", affects: ["term", "annual"] }]],
    [{ promotionRule: "majority_of_terms_passed" }, [{ rule: "promotionRule", from: "legacy", to: "majority_of_terms_passed", affects: ["annual", "promotion"] }]],
    [{ promotionRule: "manual_only" },     [{ rule: "promotionRule", from: "legacy", to: "manual_only", affects: ["annual", "promotion"] }]],
    [{ publishedResults: "refuse" },       [{ rule: "publishedResults", from: "overwrite", to: "refuse", affects: [] }]],
    [{ promotionRule: "annual_average_at_least", promotionThreshold: 12 }, [
      { rule: "promotionRule", from: "legacy", to: "annual_average_at_least", affects: ["annual", "promotion"] },
      { rule: "promotionThreshold", from: null, to: 12, affects: ["annual", "promotion"] }]],
    [{ sequenceAverage: "raw_mean" },      []],
  ];
  for (const [body, changes] of previews) {
    r = await call("POST", "adm", `${rulesUrl}/preview`, { rules: body });
    check(`preview ${JSON.stringify(body)}: what moves and what it reaches`, [r.status, r.body?.changes], [200, changes]);
  }
  r = await call("POST", "adm", `${rulesUrl}/preview`, { rules: { sequenceAverage: "weighted_20" } });
  check("a preview carries the year's counts per layer (nothing computed yet)",
    r.body?.impact, { sequence: { published: 0, unpublished: 0 }, term: { published: 0, unpublished: 0 },
      annual: { published: 0, unpublished: 0 }, draftPromotionRuns: 0 });
  check("a preview stores and audits nothing", [await storedRules(), (await audits()).length], [null, 0]);
  r = await call("POST", "tea", `${rulesUrl}/preview`, { rules: { sequenceAverage: "weighted_20" } });
  check("a teacher may not preview → 403", r.status, 403);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4a. raw_mean (the default), through the live route ---");
  for (const n of [1, 2, 3, 4]) await process_(n);
  const DEFAULT_HASH = (await rows("ResultSummary"))[0]?.policyHash;
  check("sequence 1, raw_mean: [average, percentage, place, passing]", await seq(1, ["average", "percentage", "classPosition", "isPassing"]), {
    ama: [12, 60, 2, true], bih: [15, 75, 1, true], cho: [5, 25, 4, false], dan: [5, 25, 4, false], eve: null, fay: [12, 60, 2, true],
  });
  check("  an absent subject and a genuine zero both count as nothing here (cho = dan = 5)",
    (await seq(1, ["average"])).cho[0] === (await seq(1, ["average"])).dan[0], true);
  check("  stamped exam-process/1, every summary on one snapshot that records no rules",
    [[...new Set((await rows("ResultSummary")).map((s) => `${s.calcVersion}|${s.policyHash}`))].length,
     (await rows("ResultSummary"))[0]?.calcVersion, await snapshotRules(DEFAULT_HASH)], [1, "exam-process/1", null]);
  check("  and no year or term on the summary (docs/39 §4.7e)", (await seq(1, ["academicYear", "term"])).ama, [null, null]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3/5. a rule change is audited, and rewrites nothing ---");
  const before = await everything();
  r = await putRules({ sequenceAverage: "weighted_20" }, "D1 decided by the academic board");
  r = await putRules({ gradingAuthority: "school_bands" });
  check("both changes stored", await storedRules(), { sequenceAverage: "weighted_20", gradingAuthority: "school_bands" });
  let log = await audits();
  check("each change audited: before/after of the rule, the reason, or null when none was given",
    // Order-free: two writes in one millisecond carry the same createdAt.
    log.map((a) => [a.before?.sequenceAverage, a.after?.sequenceAverage, a.before?.gradingAuthority, a.after?.gradingAuthority, a.reason, a.actorId])
      .map((x) => JSON.stringify(x)).sort(),
    [["raw_mean", "weighted_20", "split", "split", "D1 decided by the academic board", "adm"],
     ["weighted_20", "weighted_20", "split", "school_bands", null, "adm"]].map((x) => JSON.stringify(x)).sort());
  check("no summary, term or annual row moved because the rules did", await everything(), before);
  r = await putRules({ gradingAuthority: "school_bands" });
  check("the same value again: no change, no audit", [r.body?.changed, (await audits()).length], [false, 2]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4b. weighted_20 and school_bands, when recomputed ---");
  for (const n of [1, 2, 3, 4]) await process_(n);
  check("sequence 1, weighted_20: [average, grade, place, passing]", await seq(1, ["average", "overallGrade", "classPosition", "isPassing"]), {
    ama: [13, "MID", 2, true], bih: [14, "TOP", 1, true], cho: [10, "MID", 4, true], dan: [3.33, "LOW", 5, false], eve: null, fay: [13, "MID", 2, true],
  });
  check("  the absent subject is left out, the zero is not (cho 10, dan 3.33)",
    [(await seq(1, ["average"])).cho[0], (await seq(1, ["average"])).dan[0]], [10, 3.33]);
  check("  the summary carries its year and term", (await seq(3, ["academicYear", "term"])).ama, [YEAR, "2"]);
  const WEIGHTED_HASH = (await rows("ResultSummary"))[0]?.policyHash;
  check("  stamped exam-process/2, on a snapshot recording both rules",
    [[...new Set((await rows("ResultSummary")).map((s) => `${s.calcVersion}|${s.policyHash}`))].length,
     (await rows("ResultSummary"))[0]?.calcVersion, await snapshotRules(WEIGHTED_HASH), WEIGHTED_HASH !== DEFAULT_HASH],
    [1, "exam-process/2", sorted({ sequenceAverage: "weighted_20", gradingAuthority: "school_bands" }), true]);
  check("  the default snapshot still answers for what it produced", await snapshotRules(DEFAULT_HASH), null);

  for (const t of [1, 2]) await computeTerm(t);
  check("term 1, school_bands: [average, grade, passing, place]", await term(1, ["termAverage", "overallGrade", "isPassing", "classPosition"]), {
    ama: [13, "MID", true, 2], bih: [14, "TOP", true, 1], cho: [10, "MID", true, 4], dan: [3.33, "LOW", false, 5], eve: null, fay: [13, "MID", true, 2],
  });
  check("  term rows: term/2, on the same snapshot as the summaries",
    [...new Set((await rows("TermResult")).map((t) => `${t.calcVersion}|${t.policyHash === WEIGHTED_HASH}`))], ["term/2|true"]);
  await putRules({ gradingAuthority: "split" });
  await computeTerm(1);
  const SPLIT_HASH = (await rows("TermResult", { term: 1 }))[0]?.policyHash;
  check("term 1 again under split: the same averages on the built-in scale (B, B+, C, F), term/1",
    [await term(1, ["termAverage", "overallGrade"]), (await rows("TermResult", { term: 1 }))[0]?.calcVersion, await snapshotRules(SPLIT_HASH)],
    [{ ama: [13, "B"], bih: [14, "B+"], cho: [10, "C"], dan: [3.33, "F"], eve: null, fay: [13, "B"] }, "term/1", { sequenceAverage: "weighted_20" }]);
  check("  term 2, not recomputed, keeps its school bands and its term/2 stamp",
    [(await term(2, ["overallGrade"])).bih, (await rows("TermResult", { term: 2 }))[0]?.calcVersion], [["TOP"], "term/2"]);
  await putRules({ gradingAuthority: "school_bands" });
  await computeTerm(1);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4c. an incomplete year ---");
  r = await computeYear();
  check("two terms of three: the year is the two terms' figure, every status pending; eve has no row",
    [r.body?.computed, r.body?.noTerms, await year(["annualAverage", "overallGrade", "promotionStatus", "classPosition"])],
    [5, 1, { ama: [13, "MID", "pending", 2], bih: [14, "TOP", "pending", 1], cho: [10, "MID", "pending", 4],
      dan: [3.33, "LOW", "pending", 5], eve: null, fay: [13, "MID", "pending", 2] }]);
  check("  stamped annual/2 (school_bands), on the summaries' snapshot",
    [...new Set((await rows("AnnualResult")).map((a) => `${a.calcVersion}|${a.policyHash === WEIGHTED_HASH}`))], ["annual/2|true"]);
  await call("POST", "adm", "/term-results/publish", { academicYear: YEAR, term: 1 });
  await call("POST", "adm", "/term-results/publish", { academicYear: YEAR, term: 2 });
  await M("ResultSummary").updateMany({ schoolId: A }, { $set: { isPublished: true } });
  await call("POST", "adm", "/annual-results/publish", { academicYear: YEAR });
  check("legacy run on an incomplete year, weighted summaries: decided on the sequences it has (eve: no evidence)",
    await run(), { ama: ["promoted", "results_pass"], bih: ["promoted", "results_pass"], cho: ["promoted", "results_pass"],
      dan: ["repeated", "results_fail"], eve: ["unassigned", "no_results"], fay: ["promoted", "results_pass"] });
  await putRules({ promotionRule: "majority_of_terms_passed" });
  check("majority_of_terms_passed on an incomplete year: nobody decided from results",
    Object.values(await run()).every((d) => d?.[0] === "unassigned"), true);
  await putRules({ promotionRule: "legacy" });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 6a. overwrite: published rows are recomputed in place ---");
  await M("Exam").updateMany({ _id: { $in: ["s1", "s2"] } }, { $set: { status: "completed" } });
  await M("StudentScore").updateOne({ examId: "s1", studentId: "dan", subjectId: "math" }, { $set: { score: 6 } });
  r = await process_(1);
  // dan, sequence 1: (6·2 + 10)/3 = 7.33; term 1 = (7.33 + 3.33)/2 = 5.33
  check("process over published summaries → 200; dan's 7.33 stored and still published",
    [r.status, (await seq(1, ["average", "isPublished"])).dan], [200, [7.33, true]]);
  r = await computeTerm(1);
  check("term 1 recomputed over published rows: dan 5.33, still published",
    [r.status, (await term(1, ["termAverage", "isPublished"])).dan], [200, [5.33, true]]);
  r = await computeYear();
  // dan's year: (5.33 + 3.33)/2 = 4.33
  check("the year recomputed over published rows: dan 4.33, still published",
    [r.status, (await year(["annualAverage", "isPublished"])).dan], [200, [4.33, true]]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 6b. refuse ---");
  await putRules({ publishedResults: "refuse" }, "published means published");
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
  await M("TermResult").updateMany({ schoolId: A, term: 1 }, { $set: { isPublished: false } });
  r = await computeTerm(1);
  check("term 1 unpublished first → the recompute goes through", r.status, 200);
  await call("POST", "adm", "/term-results/publish", { academicYear: YEAR, term: 1 });
  await putRules({ publishedResults: "overwrite" });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4d. the complete year, under each promotion rule ---");
  await M("StudentScore").updateOne({ examId: "s1", studentId: "dan", subjectId: "math" }, { $set: { score: 0 } });
  await process_(1);
  for (const n of [5, 6]) { await addSequence(n); await process_(n); }
  await M("ResultSummary").updateMany({ schoolId: A }, { $set: { isPublished: true } });
  for (const t of [1, 2, 3]) { await computeTerm(t); await call("POST", "adm", "/term-results/publish", { academicYear: YEAR, term: t }); }
  check("three terms, every one the sequence figure", await term(3, ["termAverage", "isPassing"]), {
    ama: [13, true], bih: [14, true], cho: [10, true], dan: [3.33, false], eve: null, fay: [13, true],
  });

  const expectations = [
    // [rules, annual statuses, run, calcVersion]
    [{ promotionRule: "legacy", gradingAuthority: "split" },
      { ama: "promoted", bih: "promoted", cho: "promoted", dan: "repeated", eve: null, fay: "promoted" },
      { ama: ["promoted", "results_pass"], bih: ["promoted", "results_pass"], cho: ["promoted", "results_pass"],
        dan: ["repeated", "results_fail"], eve: ["unassigned", "no_results"], fay: ["promoted", "results_pass"] }, "annual/1"],
    [{ promotionRule: "annual_average_at_least", promotionThreshold: 12 },
      { ama: "promoted", bih: "promoted", cho: "repeated", dan: "repeated", eve: null, fay: "promoted" },
      { ama: ["promoted", "results_pass"], bih: ["promoted", "results_pass"], cho: ["repeated", "average_fail"],
        dan: ["repeated", "average_fail"], eve: ["unassigned", "no_results"], fay: ["promoted", "results_pass"] }, "annual/2"],
    [{ promotionRule: "majority_of_terms_passed", promotionThreshold: null },
      { ama: "promoted", bih: "promoted", cho: "promoted", dan: "repeated", eve: null, fay: "promoted" },
      { ama: ["promoted", "results_pass"], bih: ["promoted", "results_pass"], cho: ["promoted", "results_pass"],
        dan: ["repeated", "results_fail"], eve: ["unassigned", "no_results"], fay: ["promoted", "results_pass"] }, "annual/2"],
    [{ promotionRule: "manual_only" },
      { ama: "pending", bih: "pending", cho: "pending", dan: "pending", eve: null, fay: "pending" },
      { ama: ["unassigned", "manual"], bih: ["unassigned", "manual"], cho: ["unassigned", "manual"],
        dan: ["unassigned", "manual"], eve: ["unassigned", "manual"], fay: ["unassigned", "manual"] }, "annual/2"],
  ];
  for (const [rules, statuses, proposals, version] of expectations) {
    r = await putRules(rules);
    await computeYear();
    await call("POST", "adm", "/annual-results/publish", { academicYear: YEAR });
    const label = JSON.stringify(rules);
    check(`${label}: the annual status`, Object.fromEntries(Object.entries(await year(["promotionStatus"])).map(([k, v]) => [k, v?.[0] ?? null])), statuses);
    check(`${label}: the run proposes what the year says`, await run(), proposals);
    const stamps = [...new Set((await rows("AnnualResult")).map((a) => a.calcVersion))];
    const hash = (await rows("AnnualResult"))[0]?.policyHash;
    const expectedRules = Object.fromEntries(Object.entries({ sequenceAverage: "weighted_20", ...await storedRules() })
      .filter(([k, v]) => !(k === "promotionThreshold" && (v == null || rules.promotionRule !== "annual_average_at_least"))
        && !(k === "classThresholds") && !(k === "promotionRule" && v === "legacy") && !(k === "gradingAuthority" && v === "split")
        && !(k === "publishedResults" && v === "overwrite")));
    check(`${label}: stamped ${version}, on a snapshot recording the rules in force`, [stamps, await snapshotRules(hash)], [[version], sorted(expectedRules)]);
  }
  // annual_average_at_least on a class's own bar: Form 1 at 10 → cho passes.
  r = await putRules({ promotionRule: "annual_average_at_least", promotionThreshold: 12, classThresholds: { f1: 10 } });
  await computeYear();
  check("a class bar of 10 overrides the school's 12: cho (10.00) promoted, dan not",
    [(await year(["promotionStatus"])).cho[0], (await year(["promotionStatus"])).dan[0]], ["promoted", "repeated"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 5. legacy rows (policyHash null) ---");
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
    [r.status, gil?.annualAverage, gil?.calcVersion, typeof gil?.policyHash === "string"], [200, 12, "annual/2", true]);
  check("  the legacy term rows keep their null hash and are not rewritten",
    JSON.stringify(await rows("TermResult", { classId: "f2" })), legacyBefore);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
