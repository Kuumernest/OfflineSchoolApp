// backend/scripts/check-class-ranking.js
"use strict";

/**
 * A class position and the class size beside it count the same pupils: the
 * pupils of that class, and — in the school's current year — only those still
 * on its roster.
 *
 * A card printed "5th of 8" for a class of two. Two causes, both fixed:
 *
 *   A. Rows for pupils who had left (made inactive, moved, marks withdrawn)
 *      stayed in the ranked group at sequence, term and annual level.
 *   B. An exam sat by several classes, processed without a classId, was
 *      ranked as one group and every summary stamped with one class.
 *
 * The roster decides only while the period is the school's current year and
 * no promotion has closed that year for the class (rankingScope.service):
 * promotion overwrites Student.classId, so judged by the roster a past
 * period's pupils would all look departed. Published rows are never
 * recomputed, removed or re-ranked (docs/39 §21.1 D3). The current year is
 * kept current: committing a promotion moves it on, reversing one moves it
 * back, and a platform administrator can set it on a school that has none.
 *
 * Every figure is worked by hand. One subject, marked /20, coefficient 1, CA
 * off: a sequence average is the mark. Term 1 holds sequences 1 and 2; with
 * only sequence 1 sat, the term average is that mark (check:weightednomarks),
 * and with one term weighted 100 the annual average is the term's. Places are
 * competition places (1, 1, 3), shared/ranking.js.
 *
 *   node scripts/check-class-ranking.js
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
  const annual  = require("../src/services/annualGrading.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";

  // A school whose current year is `currentYear`. A term reads one exam per
  // sequence for the whole school, so a scenario that computes terms or years
  // has a school of its own.
  const school = async (currentYear) => {
    const S = new mongoose.Types.ObjectId().toString();
    await M("School").create({ _id: S, name: `School ${S.slice(-4)}`, email: `s${S.slice(-6)}@example.test`,
      settings: { academicYear: currentYear } });
    await M("User").create({ _id: `adm-${S}`, name: "adm", email: `adm${S.slice(-6)}@example.test`,
      password: "check-only-password", role: "school_admin", schoolId: S, isActive: true });
    await M("GradingConfig").create({ schoolId: S, caEnabled: false, passMark: 10 });
    await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR,
      terms: [{ number: 1, name: "T1", weight: 100,
        sequences: [{ number: 1, name: "S1", weight: 50 }, { number: 2, name: "S2", weight: 50 }] }] });
    return S;
  };
  const CUR  = await school(YEAR);           // sequence-only scenarios
  const TIE  = await school(YEAR);
  const LEFT = await school(YEAR);
  const MOVE = await school(YEAR);
  const PUB  = await school(YEAR);
  const PAST = await school("2027/2028");    // its current year has moved on

  // A class and its pupils; ids are unique across the suite.
  const cls = async (S, classId, pupils) => {
    await M("Class").create({ _id: classId, schoolId: S, name: classId });
    for (const id of pupils) {
      await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: S, classId, className: classId,
        studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true });
    }
  };
  const exam = (S, id, classIds, seq = 1) => M("Exam").create({ _id: id, schoolId: S, name: id, type: "test",
    academicYear: YEAR, term: 1, sequenceNumber: seq, status: "completed", classId: classIds[0], classIds });
  // Marks for one class of an exam: a number, or "abs".
  const marks = async (S, examId, classId, byPupil) => {
    const esId = `${examId}-${classId}-math`;
    if (!(await M("ExamSubject").exists({ _id: esId }))) {
      await M("ExamSubject").create({ _id: esId, examId, subjectId: "math", subjectName: "Maths", classId,
        schoolId: S, maxScore: 20, passMark: 10, weight: 100, submissionStatus: "approved" });
    }
    for (const [studentId, m] of Object.entries(byPupil)) {
      await M("StudentScore").create({ examId, examSubjectId: esId, studentId, subjectId: "math", classId,
        schoolId: S, maxScore: 20, score: typeof m === "number" ? m : null, isAbsent: m === "abs" });
    }
  };

  const app = express(); app.use(express.json());
  app.use("/api/exams",              auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/academic-structure", auth.authenticate, require("../src/routes/academicStructure.routes"));
  app.use("/api/term-results",       auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/results",            auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/super-admin",        auth.authenticate, require("../src/routes/superAdmin.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, code: err.code, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (S, method, url, body) => {
    const token = jwt.sign({ id: `adm-${S}`, role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const processExam = (S, examId, classId) => call(S, "POST", `/exams/${examId}/process`, classId ? { classId } : {});
  const computeTerm = (S, classId) => call(S, "POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId });
  const computeAnnual = async (S, classId) => {
    try { return await annual.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId }); }
    catch (err) { return { code: err.code }; }
  };

  // [place, of, class] per pupil, or null for no row.
  const seq = async (S, examId, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const r = await M("ResultSummary").findOne({ schoolId: S, examId, studentId: id, deletedAt: null }).lean();
    return [id, r ? [r.classPosition, r.totalInClass, r.classId] : null];
  })));
  const termOf = async (S, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const r = await M("TermResult").findOne({ schoolId: S, academicYear: YEAR, term: 1, studentId: id, deletedAt: null }).lean();
    return [id, r ? [r.classPosition, r.totalInClass] : null];
  })));
  const annualOf = async (S, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const r = await M("AnnualResult").findOne({ schoolId: S, academicYear: YEAR, studentId: id, deletedAt: null }).lean();
    return [id, r ? [r.classPosition, r.totalInClass] : null];
  })));
  // Every field, or every field but those in `omit`.
  const snapshot = async (model, filter, omit = []) =>
    JSON.stringify(await M(model).find(filter, Object.fromEntries(omit.map((f) => [f, 0])))
      .sort({ studentId: 1, examId: 1 }).lean());
  const ACROSS = ["gradePosition", "totalInGrade", "schoolPosition", "totalInSchool"];
  const deactivate = (ids) => M("Student").updateMany({ _id: { $in: ids } }, { $set: { isActive: false } });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1, 2, 12. a class of two; ties share a place ---");
  // F1A: ama 15, bob 12. F1T: h1 13, h2 13, h3 9. F1U: k1 13, k2 13.
  await cls(CUR, "F1A", ["ama", "bob", "cal"]);
  await cls(TIE, "F1T", ["h1", "h2", "h3"]);
  await cls(CUR, "F1U", ["k1", "k2"]);
  await exam(CUR, "s1", ["F1A"]);       await marks(CUR, "s1", "F1A", { ama: 15, bob: 12 });
  await exam(TIE, "t1", ["F1T"]);       await marks(TIE, "t1", "F1T", { h1: 13, h2: 13, h3: 9 });
  await exam(CUR, "u1", ["F1U"]);       await marks(CUR, "u1", "F1U", { k1: 13, k2: 13 });
  await processExam(CUR, "s1", "F1A");
  await processExam(TIE, "t1", "F1T");
  await processExam(CUR, "u1", "F1U");
  check("two pupils: 15 → 1/2, 12 → 2/2", await seq(CUR, "s1", ["ama", "bob"]),
    { ama: [1, 2, "F1A"], bob: [2, 2, "F1A"] });
  check("a tie of two: 13, 13 → 1/2, 1/2", await seq(CUR, "u1", ["k1", "k2"]),
    { k1: [1, 2, "F1U"], k2: [1, 2, "F1U"] });
  check("a tie then one below: 13, 13, 9 → 1, 1, 3 of 3", await seq(TIE, "t1", ["h1", "h2", "h3"]),
    { h1: [1, 3, "F1T"], h2: [1, 3, "F1T"], h3: [3, 3, "F1T"] });
  await computeTerm(TIE, "F1T");
  check("  the term keeps the tie and the size: 1, 1, 3 of 3", await termOf(TIE, ["h1", "h2", "h3"]),
    { h1: [1, 3], h2: [1, 3], h3: [3, 3] });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 5. sequences are ranked apart ---");
  // s2 (sequence 2): cal 16, bob 14, ama 10. cal sat no paper in s1.
  await exam(CUR, "s2", ["F1A"], 2);    await marks(CUR, "s2", "F1A", { cal: 16, bob: 14, ama: 10 });
  await processExam(CUR, "s2", "F1A");
  check("s2: 16, 14, 10 → 1, 2, 3 of 3", await seq(CUR, "s2", ["cal", "bob", "ama"]),
    { cal: [1, 3, "F1A"], bob: [2, 3, "F1A"], ama: [3, 3, "F1A"] });
  await processExam(CUR, "s1", "F1A");
  check("  s1 re-processed after s2: still of 2, cal has no s1 row", await seq(CUR, "s1", ["ama", "bob", "cal"]),
    { ama: [1, 2, "F1A"], bob: [2, 2, "F1A"], cal: null });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 6, 7. no counted subject; marks withdrawn ---");
  // F1C: e1 14, e2 absent. F1D: g1 18, g2 15, g3 11, then g1's mark withdrawn.
  await cls(CUR, "F1C", ["e1", "e2"]);
  await cls(CUR, "F1D", ["g1", "g2", "g3"]);
  await exam(CUR, "c1", ["F1C"]);       await marks(CUR, "c1", "F1C", { e1: 14, e2: "abs" });
  await exam(CUR, "d1", ["F1D"]);       await marks(CUR, "d1", "F1D", { g1: 18, g2: 15, g3: 11 });
  await processExam(CUR, "c1", "F1C");
  check("absent in every subject: no row, and not counted: e1 1/1", await seq(CUR, "c1", ["e1", "e2"]),
    { e1: [1, 1, "F1C"], e2: null });
  await processExam(CUR, "d1", "F1D");
  check("d1: 18, 15, 11 → 1, 2, 3 of 3", await seq(CUR, "d1", ["g1", "g2", "g3"]),
    { g1: [1, 3, "F1D"], g2: [2, 3, "F1D"], g3: [3, 3, "F1D"] });
  await M("StudentScore").updateMany({ examId: "d1", studentId: "g1" }, { $set: { deletedAt: new Date() } });
  await processExam(CUR, "d1", "F1D");
  check("  g1's mark withdrawn: his unpublished row goes; 15, 11 → 1/2, 2/2", await seq(CUR, "d1", ["g1", "g2", "g3"]),
    { g1: null, g2: [1, 2, "F1D"], g3: [2, 2, "F1D"] });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3, 4. one exam, two classes ---");
  // x1 sat by F2A (a1 16, a2 11) and F2B (b1..b6: 19, 18, 17, 14, 10, 9).
  // a1 carries a row an earlier one-group run left: filed under F2B, 7th of 8.
  await cls(CUR, "F2A", ["a1", "a2"]);
  await cls(CUR, "F2B", ["b1", "b2", "b3", "b4", "b5", "b6"]);
  await exam(CUR, "x1", ["F2A", "F2B"]);
  await marks(CUR, "x1", "F2A", { a1: 16, a2: 11 });
  await marks(CUR, "x1", "F2B", { b1: 19, b2: 18, b3: 17, b4: 14, b5: 10, b6: 9 });
  await M("ResultSummary").create({ examId: "x1", studentId: "a1", schoolId: CUR, classId: "F2B",
    average: 16, classPosition: 7, totalInClass: 8, isPublished: false });
  let r = await processExam(CUR, "x1");
  check("processed without a classId → 200, all 8 written", [r.status, r.body?.processed], [200, 8]);
  check("  F2A ranked alone: 16 → 1/2, 11 → 2/2, and a1's row now filed under F2A",
    await seq(CUR, "x1", ["a1", "a2"]), { a1: [1, 2, "F2A"], a2: [2, 2, "F2A"] });
  check("  F2B ranked alone: 19 … 9 → 1 … 6 of 6",
    await seq(CUR, "x1", ["b1", "b2", "b3", "b4", "b5", "b6"]),
    { b1: [1, 6, "F2B"], b2: [2, 6, "F2B"], b3: [3, 6, "F2B"], b4: [4, 6, "F2B"], b5: [5, 6, "F2B"], b6: [6, 6, "F2B"] });
  const f2bBefore = await snapshot("ResultSummary", { schoolId: CUR, examId: "x1", classId: "F2B" }, [...ACROSS, "updatedAt"]);
  await M("StudentScore").updateMany({ examId: "x1", studentId: "a2" }, { $set: { score: 17 } });
  await M("StudentScore").updateMany({ examId: "x1", studentId: "b1" }, { $set: { score: 8 } });
  await processExam(CUR, "x1", "F2A");
  check("processed for F2A only: a2's 17 → 1/2, a1 2/2", await seq(CUR, "x1", ["a1", "a2"]),
    { a1: [2, 2, "F2A"], a2: [1, 2, "F2A"] });
  // Only its grade and school places may move (and the time they did):
  // a2 now sits among them.
  check("  F2B's results and class places untouched, field for field (b1's changed mark not read)",
    await snapshot("ResultSummary", { schoolId: CUR, examId: "x1", classId: "F2B" }, [...ACROSS, "updatedAt"])
      === f2bBefore, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 8. six of eight leave: sequence, term, annual ---");
  // F3: p1 19, p2 18, p3 17, p4 16, t1 15, p6 14, p7 13, t2 12.
  const F3 = { p1: 19, p2: 18, p3: 17, p4: 16, t1: 15, p6: 14, p7: 13, t2: 12 };
  const SIX = ["p1", "p2", "p3", "p4", "p6", "p7"];
  await cls(LEFT, "F3", Object.keys(F3));
  await exam(LEFT, "e3", ["F3"]);        await marks(LEFT, "e3", "F3", F3);
  await processExam(LEFT, "e3", "F3");
  await computeTerm(LEFT, "F3");
  await computeAnnual(LEFT, "F3");
  check("all eight: t1 5/8, t2 8/8 at every level",
    [await seq(LEFT, "e3", ["t1", "t2"]), await termOf(LEFT, ["t1", "t2"]), await annualOf(LEFT, ["t1", "t2"])],
    [{ t1: [5, 8, "F3"], t2: [8, 8, "F3"] }, { t1: [5, 8], t2: [8, 8] }, { t1: [5, 8], t2: [8, 8] }]);
  await deactivate(SIX);
  r = await processExam(LEFT, "e3", "F3");
  check("six made inactive, sequence re-processed → 200, 2 ranked, 6 departed",
    [r.status, r.body?.processed, r.body?.departed], [200, 2, 6]);
  check("  sequence: t1 1/2, t2 2/2; the six have no row", await seq(LEFT, "e3", ["t1", "t2", ...SIX]),
    { t1: [1, 2, "F3"], t2: [2, 2, "F3"], p1: null, p2: null, p3: null, p4: null, p6: null, p7: null });
  await computeTerm(LEFT, "F3");
  check("  term: t1 1/2, t2 2/2, and only two term rows left",
    [await termOf(LEFT, ["t1", "t2"]), await M("TermResult").countDocuments({ schoolId: LEFT, classId: "F3" })],
    [{ t1: [1, 2], t2: [2, 2] }, 2]);
  await computeAnnual(LEFT, "F3");
  check("  annual: t1 1/2, t2 2/2, and only two annual rows left",
    [await annualOf(LEFT, ["t1", "t2"]), await M("AnnualResult").countDocuments({ schoolId: LEFT, classId: "F3" })],
    [{ t1: [1, 2], t2: [2, 2] }, 2]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 9. a pupil moves class ---");
  // F4A: mo 18, m1 16, m2 12. F4B: n1 15. mo then moves to F4B.
  await cls(MOVE, "F4A", ["mo", "m1", "m2"]);
  await cls(MOVE, "F4B", ["n1"]);
  await exam(MOVE, "e4", ["F4A", "F4B"]);
  await marks(MOVE, "e4", "F4A", { mo: 18, m1: 16, m2: 12 });
  await marks(MOVE, "e4", "F4B", { n1: 15 });
  await processExam(MOVE, "e4");
  await computeTerm(MOVE, "F4A");
  check("before the move: mo 1/3 in F4A", (await seq(MOVE, "e4", ["mo"])).mo, [1, 3, "F4A"]);
  await M("Student").updateOne({ _id: "mo" }, { $set: { classId: "F4B", className: "F4B" } });
  await processExam(MOVE, "e4");
  check("after: F4A's unpublished row for mo goes; m1 1/2, m2 2/2; F4B n1 1/1",
    await seq(MOVE, "e4", ["mo", "m1", "m2", "n1"]),
    { mo: null, m1: [1, 2, "F4A"], m2: [2, 2, "F4A"], n1: [1, 1, "F4B"] });
  await computeTerm(MOVE, "F4A");
  check("  F4A's term: m1 1/2, m2 2/2, mo's term row gone",
    [await termOf(MOVE, ["m1", "m2", "mo"]), await M("TermResult").countDocuments({ schoolId: MOVE, classId: "F4A" })],
    [{ m1: [1, 2], m2: [2, 2], mo: null }, 2]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 10. a published row for a pupil who left ---");
  // F5: q1 17, q2 13, q3 11, all three levels computed; q1's rows then
  // published, and q1 made inactive.
  await cls(PUB, "F5", ["q1", "q2", "q3"]);
  await exam(PUB, "e5", ["F5"]);        await marks(PUB, "e5", "F5", { q1: 17, q2: 13, q3: 11 });
  await processExam(PUB, "e5", "F5");
  await computeTerm(PUB, "F5");
  await computeAnnual(PUB, "F5");
  for (const model of ["ResultSummary", "TermResult", "AnnualResult"]) {
    await M(model).updateOne({ schoolId: PUB, studentId: "q1" }, { $set: { isPublished: true } });
  }
  const f5 = {};
  for (const model of ["ResultSummary", "TermResult", "AnnualResult"]) f5[model] = await snapshot(model, { schoolId: PUB, classId: "F5" });
  await deactivate(["q1"]);
  r = await processExam(PUB, "e5", "F5");
  const t5 = await computeTerm(PUB, "F5");
  const a5 = await computeAnnual(PUB, "F5");
  check("every level refuses (D3): sequence 409, term 409, annual PUBLISHED_RESULTS",
    [r.status, r.body?.code, t5.status, a5.code], [409, "PUBLISHED_RESULTS", 409, "PUBLISHED_RESULTS"]);
  const same = {};
  for (const model of ["ResultSummary", "TermResult", "AnnualResult"]) {
    same[model] = (await snapshot(model, { schoolId: PUB, classId: "F5" })) === f5[model];
  }
  check("  nothing written: every F5 row at every level exactly as before, q1's 1/3 included", same,
    { ResultSummary: true, TermResult: true, AnnualResult: true });

  // F6: r1 14, r2 10, plus a published summary filed under F6 for a pupil
  // with no mark in it (gh): kept as issued, outside the places, and named.
  await cls(CUR, "F6", ["r1", "r2", "gh"]);
  await exam(CUR, "e6", ["F6"]);        await marks(CUR, "e6", "F6", { r1: 14, r2: 10 });
  await M("ResultSummary").create({ examId: "e6", studentId: "gh", schoolId: CUR, classId: "F6",
    average: 18, classPosition: 1, totalInClass: 3, isPublished: true });
  const ghBefore = await snapshot("ResultSummary", { examId: "e6", studentId: "gh" });
  r = await processExam(CUR, "e6", "F6");
  check("a published row with no mark behind it: 200, reported, not ranked",
    [r.status, r.body?.publishedNotRanked, await seq(CUR, "e6", ["r1", "r2"])],
    [200, 1, { r1: [1, 2, "F6"], r2: [2, 2, "F6"] }]);
  check("  and kept exactly as issued", (await snapshot("ResultSummary", { examId: "e6", studentId: "gh" })) === ghBefore, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 11. recomputing one pupil ---");
  // e7 sat by F7A (w1 15, w2 11) and F7B (v1 18). w1's row is then filed
  // under F7B, as a one-group run left it, and recomputed alone.
  await cls(CUR, "F7A", ["w1", "w2"]);
  await cls(CUR, "F7B", ["v1"]);
  await exam(CUR, "e7", ["F7A", "F7B"]);
  await marks(CUR, "e7", "F7A", { w1: 15, w2: 11 });
  await marks(CUR, "e7", "F7B", { v1: 18 });
  await processExam(CUR, "e7");
  await M("ResultSummary").updateOne({ examId: "e7", studentId: "w1" }, { $set: { classId: "F7B", classPosition: 2, totalInClass: 2 } });
  r = await call(CUR, "POST", "/results/e7/student/w1/reportcard/calculate", {});
  check("calculate & save → 200, w1 back in F7A: 1/2", [r.status, r.body?.data?.classPosition, r.body?.data?.totalInClass],
    [200, 1, 2]);
  check("  stored: w1 1/2 F7A, w2 2/2 F7A, v1 1/1 F7B", await seq(CUR, "e7", ["w1", "w2", "v1"]),
    { w1: [1, 2, "F7A"], w2: [2, 2, "F7A"], v1: [1, 1, "F7B"] });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- outside the current year, nothing is removed ---");
  // The same eight as F3, in a school whose current year has moved on, and
  // in a class whose year a promotion has closed. The six leave; the rows
  // that exist are ranked as they are, none removed: 5/8 stays.
  await cls(PAST, "F8", ["y1", "y2", "y3", "y4", "yt", "y6", "y7", "yu"]);
  await exam(PAST, "e8", ["F8"]);
  await marks(PAST, "e8", "F8", { y1: 19, y2: 18, y3: 17, y4: 16, yt: 15, y6: 14, y7: 13, yu: 12 });
  await processExam(PAST, "e8", "F8");
  await computeTerm(PAST, "F8");
  await deactivate(["y1", "y2", "y3", "y4", "y6", "y7"]);
  r = await processExam(PAST, "e8", "F8");
  await computeTerm(PAST, "F8");
  check("past year: re-processed → 200, all 8 ranked; yt 5/8 in sequence and term",
    [r.status, r.body?.processed, (await seq(PAST, "e8", ["yt"])).yt, (await termOf(PAST, ["yt"])).yt],
    [200, 8, [5, 8, "F8"], [5, 8]]);
  check("  no row removed: 8 summaries, 8 term rows",
    [await M("ResultSummary").countDocuments({ schoolId: PAST, examId: "e8" }), await M("TermResult").countDocuments({ schoolId: PAST, classId: "F8" })],
    [8, 8]);

  await cls(CUR, "F9", ["z1", "z2", "z3", "z4", "zt", "z6", "z7", "zu"]);
  await exam(CUR, "e9", ["F9"]);
  await marks(CUR, "e9", "F9", { z1: 19, z2: 18, z3: 17, z4: 16, zt: 15, z6: 14, z7: 13, zu: 12 });
  await processExam(CUR, "e9", "F9");
  await M("Enrollment").create({ schoolId: CUR, studentId: "z1", academicYear: YEAR, classId: "F9", outcome: "promoted" });
  await deactivate(["z1", "z2", "z3", "z4", "z6", "z7"]);
  r = await processExam(CUR, "e9", "F9");
  check("year closed by a promotion: all 8 ranked, zt 5/8, no row removed",
    [r.status, r.body?.processed, (await seq(CUR, "e9", ["zt"])).zt, await M("ResultSummary").countDocuments({ schoolId: CUR, examId: "e9" })],
    [200, 8, [5, 8, "F9"], 8]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a row filed under a class with no mark left in the exam ---");
  // e10 sat by F10 only: f1 15, f2 11. Rows an earlier run left for pupils
  // with no mark in e10: fx under no class, fz under a class that sat
  // nothing (both unpublished), fy under no class, published.
  await cls(CUR, "F10", ["f1", "f2", "fx", "fy", "fz"]);
  await exam(CUR, "e10", ["F10"]);      await marks(CUR, "e10", "F10", { f1: 15, f2: 11 });
  // Written past the schema, as the old one-group run's bulkWrite upsert did
  // when the exam named no class (classId is required on a create).
  const leftover = (studentId, classId, isPublished) => ({ _id: `lo-${studentId}`, examId: "e10", studentId,
    schoolId: CUR, classId, average: 12, classPosition: 2, totalInClass: 3, isPublished, deletedAt: null });
  await M("ResultSummary").collection.insertMany([
    leftover("fx", null, false), leftover("fz", "F-gone", false), leftover("fy", null, true),
  ]);
  const fyBefore = await snapshot("ResultSummary", { examId: "e10", studentId: "fy" });
  r = await processExam(CUR, "e10");
  check("processed with no class named → 200; the published leftover reported",
    [r.status, r.body?.processed, r.body?.publishedNotRanked], [200, 2, 1]);
  check("  f1 1/2, f2 2/2; fx's and fz's unpublished leftovers gone", await seq(CUR, "e10", ["f1", "f2", "fx", "fz"]),
    { f1: [1, 2, "F10"], f2: [2, 2, "F10"], fx: null, fz: null });
  check("  fy's published leftover exactly as issued",
    (await snapshot("ResultSummary", { examId: "e10", studentId: "fy" })) === fyBefore, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the current year moves with a promotion ---");
  const promotion = require("../src/services/promotion.service");
  const yearOf = async (S) => (await M("School").findById(S).select("settings").lean())?.settings?.academicYear ?? null;
  // A draft run moving one pupil from one class to the next: commitRun's own
  // path, without the decisions generateRun would work out.
  const draft = async (S, runId, pupil, fromYear, toYear) => {
    await M("PromotionRun").create({ _id: runId, schoolId: S, fromYear, toYear, status: "draft" });
    await M("PromotionDecision").create({ runId, schoolId: S, studentId: pupil, outcome: "promoted",
      fromClassId: `${pupil}-from`, toClassId: `${pupil}-to`, reason: "manual" });
  };
  const PROMO = await school(YEAR);
  await cls(PROMO, "pr1-from", ["pr1"]);
  await M("Class").create({ _id: "pr1-to", schoolId: PROMO, name: "pr1-to" });
  await draft(PROMO, "run-a", "pr1", YEAR, "2027/2028");
  await promotion.commitRun({ schoolId: PROMO, runId: "run-a" });
  check("committing YEAR → 2027/2028 moves the school's current year on", await yearOf(PROMO), "2027/2028");
  await promotion.reverseRun({ schoolId: PROMO, runId: "run-a", reason: "check" });
  check("  reversing it moves the year back", await yearOf(PROMO), YEAR);
  await draft(PROMO, "run-b", "pr1", "2024/2025", "2025/2026");
  await promotion.commitRun({ schoolId: PROMO, runId: "run-b" });
  check("  a run for an older year leaves the current year alone", await yearOf(PROMO), YEAR);

  const UNSET = await school(null);
  await cls(UNSET, "pr2-from", ["pr2"]);
  await M("Class").create({ _id: "pr2-to", schoolId: UNSET, name: "pr2-to" });
  await draft(UNSET, "run-c", "pr2", YEAR, "2027/2028");
  await promotion.commitRun({ schoolId: UNSET, runId: "run-c" });
  check("a school with no current year is given the one it was promoted into", await yearOf(UNSET), "2027/2028");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a platform administrator sets the current year ---");
  // SET has no current year, so the six who left stay ranked (5/8) until a
  // super admin names the year — written 2026-2027, the same year as YEAR.
  await M("User").create({ _id: "root-rk", name: "root", email: "root-rk@example.test", password: "check-only-password",
    role: "super_admin", schoolId: null, isActive: true });
  const asRoot = async (method, url, body) => {
    const token = jwt.sign({ id: "root-rk", role: "super_admin", schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await fetch(`${API}${url}`, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  const SET = await school(null);
  const H = { sa1: 19, sa2: 18, sa3: 17, sa4: 16, sat: 15, sa6: 14, sa7: 13, sau: 12 };
  await cls(SET, "H1", Object.keys(H));
  await exam(SET, "e11", ["H1"]);       await marks(SET, "e11", "H1", H);
  await processExam(SET, "e11", "H1");
  await deactivate(["sa1", "sa2", "sa3", "sa4", "sa6", "sa7"]);
  await processExam(SET, "e11", "H1");
  check("no current year: the six stay ranked, sat 5/8", (await seq(SET, "e11", ["sat"])).sat, [5, 8, "H1"]);
  r = await asRoot("PATCH", `/super-admin/schools/${SET}`, { settings: { academicYear: "2026" } });
  check("  a malformed year is refused → 400, nothing stored", [r.status, await yearOf(SET)], [400, null]);
  r = await asRoot("PATCH", `/super-admin/schools/${SET}`, { settings: { academicYear: "2026-2027" } });
  const audit = await M("AuditLog").findOne({ action: "school.updated", schoolId: SET }).lean();
  check("  set to 2026-2027 → 200, stored, audited before/after",
    [r.status, await yearOf(SET), audit?.before?.academicYear ?? null, audit?.after?.academicYear ?? null],
    [200, "2026-2027", null, "2026-2027"]);
  r = await processExam(SET, "e11", "H1");
  check("  re-processed: 2026-2027 is YEAR, the six depart, sat 1/2, sau 2/2",
    [r.body?.departed, await seq(SET, "e11", ["sat", "sau"])], [6, { sat: [1, 2, "H1"], sau: [2, 2, "H1"] }]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a mark corrected after publishing: what the screens' buttons do ---");
  // e12 for J1: j1 14, j2 12. Processed with no class named (the web and
  // phone buttons send none), published, then j2's mark corrected to 16.
  await cls(CUR, "J1", ["j1", "j2"]);
  await exam(CUR, "e12", ["J1"]);       await marks(CUR, "e12", "J1", { j1: 14, j2: 12 });
  await processExam(CUR, "e12");
  r = await call(CUR, "PATCH", "/exams/e12/status", { status: "published" });
  const avg = async (id) => (await M("ResultSummary").findOne({ examId: "e12", studentId: id }).lean())?.average ?? null;
  check("published: j1 1/2 (14), j2 2/2 (12)",
    [r.status, await seq(CUR, "e12", ["j1", "j2"]), await avg("j2")],
    [200, { j1: [1, 2, "J1"], j2: [2, 2, "J1"] }, 12]);
  await M("StudentScore").updateMany({ examId: "e12", studentId: "j2" }, { $set: { score: 16 } });
  r = await processExam(CUR, "e12");
  check("  recalculating while published is refused, and j2 still shows 12",
    [r.status, r.body?.code, await avg("j2")], [409, "PUBLISHED_RESULTS", 12]);
  r = await call(CUR, "POST", "/results/e12/unpublish", { classId: "J1", reason: "j2's mark entered wrongly" });
  check("  unpublishing the class → 200, 2 results", [r.status, r.body?.unpublished], [200, 2]);
  r = await processExam(CUR, "e12");
  check("  recalculated: j2's 16 is read, j2 1/2, j1 2/2",
    [r.status, await avg("j2"), await seq(CUR, "e12", ["j1", "j2"])],
    [200, 16, { j1: [2, 2, "J1"], j2: [1, 2, "J1"] }]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- grade and school places ---");
  // g1 sat by G1A and G1B (both level Form 1, written two ways), G2 (level
  // Form 2) and GX (no level). G1A: ga1 16, ga2 12. G1B: gb1 18, gb2 12.
  // G2: gc1 14. GX: gx1 20.
  const GS = await school(YEAR);
  await cls(GS, "G1A", ["ga1", "ga2"]);
  await cls(GS, "G1B", ["gb1", "gb2"]);
  await cls(GS, "G2",  ["gc1"]);
  await cls(GS, "GX",  ["gx1"]);
  await M("Class").updateOne({ _id: "G1A" }, { $set: { level: "Form 1" } });
  await M("Class").updateOne({ _id: "G1B" }, { $set: { level: " form 1" } });
  await M("Class").updateOne({ _id: "G2" },  { $set: { level: "Form 2" } });
  await exam(GS, "g1", ["G1A", "G1B", "G2", "GX"]);
  await marks(GS, "g1", "G1A", { ga1: 16, ga2: 12 });
  await marks(GS, "g1", "G1B", { gb1: 18, gb2: 12 });
  await marks(GS, "g1", "G2",  { gc1: 14 });
  await marks(GS, "g1", "GX",  { gx1: 20 });
  // [grade place, of, school place, of] per pupil.
  const across = async (ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const s = await M("ResultSummary").findOne({ schoolId: GS, examId: "g1", studentId: id }).lean();
    return [id, [s.gradePosition, s.totalInGrade, s.schoolPosition, s.totalInSchool]];
  })));
  const G = ["ga1", "ga2", "gb1", "gb2", "gc1", "gx1"];
  await processExam(GS, "g1");
  check("school: 20, 18, 16, 14, 12, 12 → 1, 2, 3, 4, 5, 5 of 6; grade Form 1 over G1A and G1B: 18, 16, 12, 12 → 1, 2, 3, 3 of 4; Form 2 1/1; no level, no grade",
    await across(G), {
      ga1: [2, 4, 3, 6], ga2: [3, 4, 5, 6], gb1: [1, 4, 2, 6], gb2: [3, 4, 5, 6],
      gc1: [1, 1, 4, 6], gx1: [null, null, 1, 6],
    });
  check("  class places unchanged by it: G1A 16, 12 → 1/2, 2/2", await seq(GS, "g1", ["ga1", "ga2"]),
    { ga1: [1, 2, "G1A"], ga2: [2, 2, "G1A"] });

  await M("StudentScore").updateMany({ examId: "g1", studentId: "ga2" }, { $set: { score: 19 } });
  await processExam(GS, "g1", "G1A");
  check("G1A alone re-processed with ga2's 19: every class's grade and school places move with it",
    await across(G), {
      ga1: [3, 4, 4, 6], ga2: [1, 4, 2, 6], gb1: [2, 4, 3, 6], gb2: [4, 4, 6, 6],
      gc1: [1, 1, 5, 6], gx1: [null, null, 1, 6],
    });
  check("  G1B's class places stay its own: gb1 1/2", (await seq(GS, "g1", ["gb1"])).gb1, [1, 2, "G1B"]);

  await M("ResultSummary").updateMany({ schoolId: GS, examId: "g1", classId: "G1B" }, { $set: { isPublished: true } });
  const g1bBefore = await snapshot("ResultSummary", { schoolId: GS, examId: "g1", classId: "G1B" });
  await M("StudentScore").updateMany({ examId: "g1", studentId: "ga1" }, { $set: { score: 20 } });
  r = await processExam(GS, "g1", "G1A");
  check("G1B published, G1A re-processed with ga1's 20 → 200; G1B's pupils still counted, ga1 ties gx1",
    [r.status, await across(["ga1", "ga2", "gc1", "gx1"])],
    [200, { ga1: [1, 4, 1, 6], ga2: [2, 4, 3, 6], gc1: [1, 1, 5, 6], gx1: [null, null, 1, 6] }]);
  check("  G1B's published rows exactly as issued (D3)",
    (await snapshot("ResultSummary", { schoolId: GS, examId: "g1", classId: "G1B" })) === g1bBefore, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- school places for a term and a year ---");
  // es1 (sequence 1) sat by K1 (k1a 16, k1b 10) and K2 (k2a 18, k2b 12,
  // k2c 10). With only sequence 1 sat, the term average is the mark, and with
  // one term weighted 100 the annual average is the term's.
  const SR = await school(YEAR);
  await cls(SR, "K1", ["k1a", "k1b"]);
  await cls(SR, "K2", ["k2a", "k2b", "k2c"]);
  await exam(SR, "es1", ["K1", "K2"]);
  await marks(SR, "es1", "K1", { k1a: 16, k1b: 10 });
  await marks(SR, "es1", "K2", { k2a: 18, k2b: 12, k2c: 10 });
  // [school place, of] per pupil, at the term (T) or the year (A).
  const schoolOf = async (model, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const filter = { schoolId: SR, academicYear: YEAR, studentId: id, deletedAt: null, ...(model === "TermResult" ? { term: 1 } : {}) };
    const r = await M(model).findOne(filter).lean();
    return [id, r ? [r.schoolPosition, r.totalInSchool] : null];
  })));
  const K = ["k1a", "k1b", "k2a", "k2b", "k2c"];
  await processExam(SR, "es1");
  r = await call(SR, "POST", "/term-results/compute", { academicYear: YEAR, term: 1 });
  await annual.computeAllClassAnnualAverages({ schoolId: SR, academicYear: YEAR });
  const firstPlaces = { k1a: [2, 5], k1b: [4, 5], k2a: [1, 5], k2b: [3, 5], k2c: [4, 5] };
  check("whole school computed: 18, 16, 12, 10, 10 → 1, 2, 3, 4, 4 of 5, at the term and the year",
    [r.status, await schoolOf("TermResult", K), await schoolOf("AnnualResult", K)], [200, firstPlaces, firstPlaces]);
  check("  class places still per class: K1 1/2, 2/2; K2 1/3, 2/3, 3/3", await termOf(SR, K),
    { k1a: [1, 2], k1b: [2, 2], k2a: [1, 3], k2b: [2, 3], k2c: [3, 3] });

  await M("StudentScore").updateMany({ examId: "es1", studentId: "k1b" }, { $set: { score: 17 } });
  await processExam(SR, "es1", "K1");
  await computeTerm(SR, "K1");
  await annual.computeClassAnnualAverages({ schoolId: SR, academicYear: YEAR, classId: "K1" });
  const movedPlaces = { k1a: [3, 5], k1b: [2, 5], k2a: [1, 5], k2b: [4, 5], k2c: [5, 5] };
  check("K1 alone recomputed with k1b's 17: K2's school places move with it, at the term and the year",
    [await schoolOf("TermResult", K), await schoolOf("AnnualResult", K)], [movedPlaces, movedPlaces]);
  check("  K2's class places untouched: 1/3, 2/3, 3/3", await termOf(SR, ["k2a", "k2b", "k2c"]),
    { k2a: [1, 3], k2b: [2, 3], k2c: [3, 3] });

  for (const model of ["TermResult", "AnnualResult"]) {
    await M(model).updateMany({ schoolId: SR, classId: "K2" }, { $set: { isPublished: true } });
  }
  const k2Before = {};
  for (const model of ["TermResult", "AnnualResult"]) k2Before[model] = await snapshot(model, { schoolId: SR, classId: "K2" });
  await M("StudentScore").updateMany({ examId: "es1", studentId: "k1a" }, { $set: { score: 19 } });
  await processExam(SR, "es1", "K1");
  await computeTerm(SR, "K1");
  await annual.computeClassAnnualAverages({ schoolId: SR, academicYear: YEAR, classId: "K1" });
  check("K2 published, K1 recomputed with k1a's 19: K2's pupils still counted; k1a 1/5, k1b 3/5",
    [await schoolOf("TermResult", ["k1a", "k1b"]), await schoolOf("AnnualResult", ["k1a", "k1b"])],
    [{ k1a: [1, 5], k1b: [3, 5] }, { k1a: [1, 5], k1b: [3, 5] }]);
  const k2Same = {};
  for (const model of ["TermResult", "AnnualResult"]) {
    k2Same[model] = (await snapshot(model, { schoolId: SR, classId: "K2" })) === k2Before[model];
  }
  check("  K2's published rows exactly as issued (D3)", k2Same, { TermResult: true, AnnualResult: true });
  const cards = require("../src/services/reportCardData.service");
  const termCard   = await cards.buildTermCard({ schoolId: SR, academicYear: YEAR, term: 1, classId: "K1", studentId: "k1a" });
  const annualCard = await cards.buildAnnualCard({ schoolId: SR, academicYear: YEAR, classId: "K1", studentId: "k1a" });
  const placed = (c) => [c?.summary?.classPosition, c?.summary?.totalInClass, c?.summary?.schoolPosition, c?.summary?.totalInSchool];
  check("  k1a's term and annual cards carry both places: 1/2 in the class, 1/5 in the school",
    [placed(termCard), placed(annualCard)], [[1, 2, 1, 5], [1, 2, 1, 5]]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- grade places for a term and a year ---");
  // el1 sat by L1A (la1 15, la2 11) and L1B (lb1 13), both level Form 1,
  // and L2 (lc1 17), no level. A whole-school compute, then L1B alone.
  const LV = await school(YEAR);
  await cls(LV, "L1A", ["la1", "la2"]);
  await cls(LV, "L1B", ["lb1"]);
  await cls(LV, "L2",  ["lc1"]);
  await M("Class").updateMany({ _id: { $in: ["L1A", "L1B"] } }, { $set: { level: "Form 1" } });
  await exam(LV, "el1", ["L1A", "L1B", "L2"]);
  await marks(LV, "el1", "L1A", { la1: 15, la2: 11 });
  await marks(LV, "el1", "L1B", { lb1: 13 });
  await marks(LV, "el1", "L2",  { lc1: 17 });
  // [grade place, of, school place, of] per pupil.
  const gradeOf = async (model, ids) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
    const filter = { schoolId: LV, academicYear: YEAR, studentId: id, deletedAt: null, ...(model === "TermResult" ? { term: 1 } : {}) };
    const r = await M(model).findOne(filter).lean();
    return [id, r ? [r.gradePosition, r.totalInGrade, r.schoolPosition, r.totalInSchool] : null];
  })));
  const L = ["la1", "la2", "lb1", "lc1"];
  await processExam(LV, "el1");
  await call(LV, "POST", "/term-results/compute", { academicYear: YEAR, term: 1 });
  await annual.computeAllClassAnnualAverages({ schoolId: LV, academicYear: YEAR });
  const lvPlaces = { la1: [1, 3, 2, 4], la2: [3, 3, 4, 4], lb1: [2, 3, 3, 4], lc1: [null, null, 1, 4] };
  check("Form 1 over L1A and L1B: 15, 13, 11 → 1, 2, 3 of 3; L2 has no level, no grade; school 17, 15, 13, 11",
    [await gradeOf("TermResult", L), await gradeOf("AnnualResult", L)], [lvPlaces, lvPlaces]);
  await M("StudentScore").updateMany({ examId: "el1", studentId: "lb1" }, { $set: { score: 16 } });
  await processExam(LV, "el1", "L1B");
  await computeTerm(LV, "L1B");
  await annual.computeClassAnnualAverages({ schoolId: LV, academicYear: YEAR, classId: "L1B" });
  const lvMoved = { la1: [2, 3, 3, 4], la2: [3, 3, 4, 4], lb1: [1, 3, 2, 4], lc1: [null, null, 1, 4] };
  check("  L1B alone recomputed with lb1's 16: L1A's grade places move with it, at the term and the year",
    [await gradeOf("TermResult", L), await gradeOf("AnnualResult", L)], [lvMoved, lvMoved]);
  const lbCard = await cards.buildTermCard({ schoolId: LV, academicYear: YEAR, term: 1, classId: "L1B", studentId: "lb1" });
  check("  lb1's term card carries the grade place: 1/3",
    [lbCard?.summary?.gradePosition, lbCard?.summary?.totalInGrade], [1, 3]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
