// backend/scripts/check-agreed-followup.js
"use strict";

/**
 * Follow-up to the agreed calculation (docs/39 §20.0), decided by the
 * project owner on 2026-10-16. Every expected figure is worked out by hand.
 *
 *   A. A final-year pupil's annual row says "graduated" — never "promoted"
 *      or "repeated" — as the promotion run proposes; average, grade and
 *      place are unchanged. A pupil of another class is unchanged. The
 *      annual card agrees with the run, in English and in French
 *      (DIPLÔMÉ(E)); a published row keeps what it says.
 *   B. "Calculate & save" (POST /api/results/:examId/student/:studentId/
 *      reportcard/calculate) runs the decided calculation on the stored
 *      marks — the numbers in the body are not read — stamps exam-process/3,
 *      and is audited; on a published summary it is refused with 409
 *      PUBLISHED_RESULTS and nothing is written.
 *
 *   node scripts/check-agreed-followup.js
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
  const cards   = require("../src/services/reportCardData.service");
  const { renderReportCardHtml } = require("../src/services/reportHtml.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027", NEXT = "2027/2028";
  const F = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: F, name: "Follow-up School", email: "followup@example.test" });
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: F, isActive: true });
  await M("GradingConfig").create({ schoolId: F, caEnabled: false, passMark: 10 });
  // School bar 11 for every class.
  await M("AcademicStructure").create({ schoolId: F, academicYear: YEAR, rules: { promotionThreshold: 11 } });

  const app = express(); app.use(express.json());
  app.use("/api/annual-results", auth.authenticate, require("../src/routes/annualResults.routes"));
  app.use("/api/promotion",      auth.authenticate, require("../src/routes/promotion.routes"));
  app.use("/api/results",        auth.authenticate, require("../src/routes/results.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: F }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };

  // ═══════════════════════════════════════════════════════════════════════
  // A. Final-year annual rows.
  //
  // Three published terms per pupil, all equal, so the annual average
  // (33.33/33.33/33.34) is that figure. Bar 11 (the school's). Built-in grades:
  // 8 → D (8–10), 9 → D, 12 → B (12–14).
  //   Form 5 (final year):  lo 8   (below the bar)    → graduated, D, 2nd of 2
  //                         hi 12  (above the bar)    → graduated, B, 1st of 2
  //   Form 4 (→ Form 5):    mid 9  (below)            → repeated,  D, 2nd of 2
  //                         up 12  (above)            → promoted,  B, 1st of 2
  //   Form 6 (final year):  old — a row published before this pass saying
  //                         "repeated": kept as issued, its class refused.
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- A. a final-year pupil's annual row ---");
  await M("Class").create({ _id: "f4", schoolId: F, name: "Form 4", nextClassId: "f5" });
  await M("Class").create({ _id: "f5", schoolId: F, name: "Form 5", isFinalYear: true });
  await M("Class").create({ _id: "f6", schoolId: F, name: "Form 6", isFinalYear: true });
  const PUPILS = [["lo", "f5", 8], ["hi", "f5", 12], ["mid", "f4", 9], ["up", "f4", 12], ["old", "f6", 9]];
  for (const [id, cls, avg] of PUPILS) {
    await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: F, classId: cls, className: cls,
      studentName: `Pupil ${id}`, enrollmentNo: id, status: "approved", isActive: true });
    for (const t of [1, 2, 3]) {
      await M("TermResult").create({ schoolId: F, academicYear: YEAR, term: t, classId: cls, studentId: id,
        termAverage: avg, isPassing: avg >= 10, isPublished: true, sequenceAverages: [] });
    }
  }
  await M("AnnualResult").create({ schoolId: F, academicYear: YEAR, classId: "f6", studentId: "old", annualAverage: 9,
    overallGrade: "D", isPassing: false, promotionStatus: "repeated", isPublished: true, classPosition: 1, totalInClass: 1,
    termAverages: [], calcVersion: "annual/3" });
  const oldBefore = JSON.stringify(await M("AnnualResult").findOne({ studentId: "old" }).lean());

  for (const cls of ["f4", "f5"]) {
    const r = await call("POST", "/annual-results/compute", { academicYear: YEAR, classId: cls });
    if (r.status !== 200) check(`compute ${cls}`, r.status, 200);
  }
  const row = async (id) => {
    const a = await M("AnnualResult").findOne({ studentId: id, academicYear: YEAR }).lean();
    return a ? [a.annualAverage, a.overallGrade, a.promotionStatus, a.classPosition] : null;
  };
  check("final year, below the bar: graduated; average, grade and place as computed", await row("lo"), [8, "D", "graduated", 2]);
  check("final year, above the bar: graduated", await row("hi"), [12, "B", "graduated", 1]);
  check("not a final year, below the bar: repeated (unchanged)", await row("mid"), [9, "D", "repeated", 2]);
  check("not a final year, above the bar: promoted (unchanged)", await row("up"), [12, "B", "promoted", 1]);
  let r = await call("POST", "/annual-results/compute", { academicYear: YEAR, classId: "f6" });
  check("a published row keeps what it says: its class is refused, the row untouched",
    [r.status, r.body?.code, JSON.stringify(await M("AnnualResult").findOne({ studentId: "old" }).lean()) === oldBefore],
    [409, "PUBLISHED_RESULTS", true]);

  await call("POST", "/annual-results/publish", { academicYear: YEAR });
  r = await call("POST", "/promotion/runs", { fromYear: YEAR, toYear: NEXT });
  const ds = await M("PromotionDecision").find({ runId: String(r.body?.run?._id) }).lean();
  const outcome = Object.fromEntries(ds.map((d) => [d.studentId, d.outcome]));
  check("the run agrees with the rows", ["lo", "hi", "mid", "up"].map((id) => outcome[id]),
    ["graduated", "graduated", "repeated", "promoted"]);

  // The structure-level threshold (schema default 10) is read by nothing and
  // is no longer copied onto annual rows (decided 2026-10-16, docs/41 §7).
  check("annual rows carry no copy of the structure's threshold",
    [...new Set((await M("AnnualResult").find({ schoolId: F }).lean()).map((a) => a.promotionThreshold ?? null))], [null]);

  const card = async (id, cls) => cards.buildAnnualCard({ schoolId: F, academicYear: YEAR, classId: cls, studentId: id });
  const lo = await card("lo", "f5");
  check("the annual card says GRADUATED for the final-year pupil below the bar", lo?.summary?.promotionStatus, "GRADUATED");
  check("  and REPEATED for Form 4's pupil below it", (await card("mid", "f4"))?.summary?.promotionStatus, "REPEATED");
  const frHtml = renderReportCardHtml(lo, { lang: "fr" });
  const enHtml = renderReportCardHtml(lo, { lang: "en" });
  // Wording decided by the project owner (2026-10-16, docs/41 §7):
  // DIPLÔMÉ(E) with the circumflex, REDOUBLANT kept, ADMIS(E) SOUS CONDITION.
  check("a French card prints DIPLÔMÉ(E), an English one GRADUATED",
    [frHtml.includes("DIPLÔMÉ(E)"), frHtml.includes("DIPLOMÉ(E)"), frHtml.includes("GRADUATED"), enHtml.includes("GRADUATED")], [true, false, false, true]);
  const conditional = { ...lo, summary: { ...lo.summary, promotionCode: "conditional", promotionStatus: "CONDITIONAL PROMOTION" } };
  check("a French card prints ADMIS(E) SOUS CONDITION for a conditional promotion; English unchanged",
    [renderReportCardHtml(conditional, { lang: "fr" }).includes("ADMIS(E) SOUS CONDITION"), renderReportCardHtml(conditional, { lang: "fr" }).includes("CONDITIONAL PROMOTION"),
     renderReportCardHtml(conditional, { lang: "en" }).includes("CONDITIONAL PROMOTION")], [true, false, true]);
  check("the French card says Année scolaire, not Année académique",
    [frHtml.includes("Année scolaire"), frHtml.includes("Année académique")], [true, false]);
  check("a French card prints REDOUBLANT for a pupil who repeats",
    renderReportCardHtml(await card("mid", "f4"), { lang: "fr" }).includes("REDOUBLANT"), true);

  // ═══════════════════════════════════════════════════════════════════════
  // B. Calculate & save.
  //
  // Sequence 1, Form 4, CA off. Maths coefficient 2, English 1, papers /20.
  // Stored marks for "up": Maths 15, English 9 → (2·15 + 9)/3 = 39/3 = 13.
  // The body claims Maths 20, English 20, out of 100, pass mark 50 — what the
  // route used to compute from (it would have stored (20·2 + 20)/3 /100 = 20
  // with its own scale); now ignored.
  // After English is corrected to 12 in mark entry: (30 + 12)/3 = 14.
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- B. calculate & save ---");
  await M("Exam").create({ _id: "s1", schoolId: F, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 1, status: "completed", classId: "f4", classIds: ["f4"] });
  for (const [sub, w, mark] of [["math", 200, 15], ["eng", 100, 9]]) {
    await M("ExamSubject").create({ _id: `s1-${sub}`, examId: "s1", subjectId: sub, subjectName: sub, classId: "f4",
      schoolId: F, maxScore: 20, passMark: 10, weight: w, submissionStatus: "approved" });
    await M("StudentScore").create({ examId: "s1", examSubjectId: `s1-${sub}`, studentId: "up", subjectId: sub,
      classId: "f4", schoolId: F, maxScore: 20, score: mark, isAbsent: false });
  }
  const BODY = { subjects: [
    { subjectId: "math", subjectName: "math", score: 20, maxScore: 20, coefficient: 1 },
    { subjectId: "eng",  subjectName: "eng",  score: 20, maxScore: 20, coefficient: 1 },
  ], outOf: 100, passMark: 50 };
  const URL = "/results/s1/student/up/reportcard/calculate";
  const logs = () => M("ResultChangeLog").find({ examId: "s1", entity: "summary" }).sort({ createdAt: 1, _id: 1 }).lean();

  r = await call("POST", URL, BODY);
  let stored = await M("ResultSummary").findOne({ examId: "s1", studentId: "up" }).lean();
  check("unpublished: 200, the stored marks' 13 out of 20, exam-process/3 (the body's numbers not read)",
    [r.status, r.body?.data?.average, r.body?.data?.outOf, stored?.average, stored?.calcVersion],
    [200, 13, 20, 13, "exam-process/3"]);
  let log = await logs();
  check("  audited: a summary created, average null → 13", log.map((l) => [l.action, l.oldValue, l.newValue]), [["created", null, 13]]);

  await M("StudentScore").updateOne({ examId: "s1", studentId: "up", subjectId: "eng" }, { $set: { score: 12 } });
  r = await call("POST", URL, BODY);
  stored = await M("ResultSummary").findOne({ examId: "s1", studentId: "up" }).lean();
  log = await logs();
  check("after a correction in mark entry: (30 + 12)/3 = 14, audited 13 → 14",
    [r.status, stored?.average, log.map((l) => [l.action, l.oldValue, l.newValue])],
    [200, 14, [["created", null, 13], ["updated", 13, 14]]]);

  await M("ResultSummary").updateOne({ examId: "s1", studentId: "up" }, { $set: { isPublished: true } });
  const before = JSON.stringify(await M("ResultSummary").find({ examId: "s1" }).lean());
  r = await call("POST", URL, BODY);
  check("published: 409 PUBLISHED_RESULTS, nothing written, nothing audited",
    [r.status, r.body?.code, JSON.stringify(await M("ResultSummary").find({ examId: "s1" }).lean()) === before, (await logs()).length],
    [409, "PUBLISHED_RESULTS", true, 2]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
