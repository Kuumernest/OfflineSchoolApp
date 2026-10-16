// backend/scripts/check-unpublish.js
"use strict";

/**
 * Unpublishing, end to end over HTTP (decided 2026-10-16, docs/41 §7).
 *
 * For each layer, sequence, term and year: publish; recalculating is refused
 * (409 PUBLISHED_RESULTS); unpublishing needs a reason and the right to
 * publish; with a reason it unpublishes the class's rows and nothing else
 * (figures, positions, calcVersion unchanged), says issued cards stay as
 * issued, and leaves an AuditLog row (and, for a sequence, a ResultChangeLog
 * row); recalculating is then allowed; republishing works. A year is not
 * unpublished while a promotion run for it is draft or committed.
 *
 * Synthetic school, in-memory MongoDB.
 *
 *   node scripts/check-unpublish.js
 */

const { stopQuietly } = require("./stopQuietly");
const path     = require("path");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough-xx";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);

  const S = "68e10000000000000000f001", OTHER = "68e10000000000000000f002", YEAR = "2026/2027";
  for (const id of [S, OTHER]) await M("School").create({ _id: id, name: `School ${id.slice(-1)}`, code: `U${id.slice(-1)}`, email: `u${id.slice(-1)}@example.test`, settings: { academicYear: YEAR } });
  await M("GradingConfig").create({ schoolId: S, passMark: 10, caEnabled: false });
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR, rules: { classThresholds: { f1: 10 } },
    terms: [{ number: 1, name: "T1", weight: 100, sequences: [{ number: 1, name: "S1", weight: 50 }, { number: 2, name: "S2", weight: 50 }] }] });
  await M("Class").create({ _id: "f2", schoolId: S, name: "Form 2", isFinalYear: true });
  await M("Class").create({ _id: "f1", schoolId: S, name: "Form 1", nextClassId: "f2" });
  await M("Class").create({ _id: "x1", schoolId: OTHER, name: "Elsewhere" });
  await M("User").create({ _id: "adm", name: "Admin", email: "adm@example.test", password: "Check-only-passw0rd", role: "school_admin", schoolId: S, isActive: true });
  await M("User").create({ _id: "tea", name: "Teacher", email: "tea@example.test", password: "Check-only-passw0rd", role: "teacher", schoolId: S, isActive: true });
  const pupils = ["ama", "bih", "cho"];
  for (const p of pupils) await M("Student").create({ _id: p, userId: `u-${p}`, schoolId: S, classId: "f1", className: "Form 1", studentName: `Synthetic ${p}`, enrollmentNo: p, isActive: true, status: "approved" });
  const MARKS = { 1: { ama: [16, 12], bih: [9, 11], cho: [12, 14] }, 2: { ama: [14, 10], bih: [8, 10], cho: [13, 15] } };
  for (const q of [1, 2]) {
    await M("Exam").create({ _id: `s${q}`, schoolId: S, name: `Sequence ${q}`, type: "test", academicYear: YEAR, term: 1, sequenceNumber: q, status: "completed", classId: "f1", classIds: ["f1"], totalMarks: 20, passMark: 10, startDate: `2026-0${8 + q}-10` });
    for (const [m, w] of [[0, 200], [1, 100]]) {
      await M("ExamSubject").create({ _id: `s${q}-es${m}`, examId: `s${q}`, subjectId: `sub${m}`, subjectName: `Subject ${m}`, classId: "f1", schoolId: S, maxScore: 20, passMark: 10, weight: w });
      for (const p of pupils) await M("StudentScore").create({ examId: `s${q}`, examSubjectId: `s${q}-es${m}`, studentId: p, subjectId: `sub${m}`, classId: "f1", schoolId: S, maxScore: 20, score: MARKS[q][p][m], isAbsent: false });
    }
  }

  const express = require("express"), jwt = require("jsonwebtoken");
  const auth = require("../middleware/auth");
  const app = express(); app.use(express.json());
  app.use("/api/exams",          auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results",        auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/term-results",   auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/annual-results", auth.authenticate, require("../src/routes/annualResults.routes"));
  app.use((err, _q, res, _n) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tok = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = (method, url, body, who = ["adm", "school_admin"]) => fetch(`${base}${url}`, {
    method, headers: { Authorization: `Bearer ${tok(...who)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const figures = async (Model, filter, keys) => (await M(Model).find(filter).sort({ studentId: 1 }).lean())
    .map((r) => keys.map((k) => r[k] ?? null));

  // ── Sequence ────────────────────────────────────────────────────────────
  console.log("--- a class's sequence results ---");
  for (const q of [1, 2]) await call("POST", `/exams/s${q}/process`, { classId: "f1" });
  check("published from the exam screen", (await call("PATCH", "/exams/s1/status", { status: "published" })).status, 200);
  const refused = await call("POST", "/exams/s1/process", { classId: "f1" });
  check("recalculating is refused: 409 PUBLISHED_RESULTS", [refused.status, refused.body.code], [409, "PUBLISHED_RESULTS"]);

  const SEQ_KEYS = ["average", "classPosition", "calcVersion", "overallGrade"];
  const seqBefore = await figures("ResultSummary", { examId: "s1" }, SEQ_KEYS);
  const noReason = await call("POST", "/results/s1/unpublish", { classId: "f1", reason: "  " });
  check("no reason: 400 REASON_REQUIRED", [noReason.status, noReason.body.code], [400, "REASON_REQUIRED"]);
  check("a teacher may not unpublish", (await call("POST", "/results/s1/unpublish", { classId: "f1", reason: "x" }, ["tea", "teacher"])).status, 403);
  check("another school's class: 404", (await call("POST", "/results/s1/unpublish", { classId: "x1", reason: "x" })).status, 404);
  check("still published after the refusals", await M("ResultSummary").countDocuments({ examId: "s1", isPublished: true }), 3);

  const un = await call("POST", "/results/s1/unpublish", { classId: "f1", reason: "Mark entered wrongly for one pupil" });
  check("with a reason: the class's three results unpublished, and issued cards said to stay as issued",
    [un.status, un.body.unpublished, un.body.issuedCardsUnchanged, /stay as issued/.test(un.body.note)], [200, 3, true, true]);
  check("only isPublished and publishedAt changed: figures, positions, calcVersion as before",
    [await figures("ResultSummary", { examId: "s1" }, SEQ_KEYS), await M("ResultSummary").countDocuments({ examId: "s1", isPublished: true, publishedAt: { $ne: null } })], [seqBefore, 0]);
  check("the exam is completed again, so it can be published again", (await M("Exam").findById("s1").lean()).status, "completed");
  const log = await M("ResultChangeLog").findOne({ examId: "s1", action: "unpublished" }).lean();
  check("the exam's change log has it, with the reason and the counts",
    [log?.entity, log?.reason, log?.oldValue, log?.newValue], ["exam", "Mark entered wrongly for one pupil", { classId: "f1", published: 3 }, { classId: "f1", published: 0 }]);
  const auditSeq = await M("AuditLog").findOne({ action: "results.unpublished", resourceType: "sequence" }).lean();
  check("an AuditLog row: who, counts before and after, the reason",
    [auditSeq?.actorId, auditSeq?.schoolId, auditSeq?.before, auditSeq?.after, auditSeq?.reason], ["adm", S, { published: 3 }, { published: 0 }, "Mark entered wrongly for one pupil"]);
  check("recalculating is allowed again", (await call("POST", "/exams/s1/process", { classId: "f1" })).status, 200);
  await call("PATCH", "/exams/s1/status", { status: "published" });
  check("and it is republished", await M("ResultSummary").countDocuments({ examId: "s1", isPublished: true }), 3);

  // ── Term ────────────────────────────────────────────────────────────────
  console.log("--- a class's term results ---");
  const T = { academicYear: YEAR, term: 1, classId: "f1" };
  check("term computed and published", [(await call("POST", "/term-results/compute", T)).status, (await call("POST", "/term-results/publish", T)).body.published], [200, 3]);
  const tRefused = await call("POST", "/term-results/compute", T);
  check("recomputing is refused: 409 PUBLISHED_RESULTS", [tRefused.status, tRefused.body.code], [409, "PUBLISHED_RESULTS"]);
  const TERM_KEYS = ["termAverage", "classPosition", "calcVersion"];
  const termBefore = await figures("TermResult", { schoolId: S, term: 1 }, TERM_KEYS);
  check("no reason: 400", (await call("POST", "/term-results/unpublish", T)).body.code, "REASON_REQUIRED");
  const tu = await call("POST", "/term-results/unpublish", { ...T, reason: "Sequence 1 corrected" });
  check("with a reason: three unpublished, figures as before", [tu.status, tu.body.unpublished, tu.body.issuedCardsUnchanged, await figures("TermResult", { schoolId: S, term: 1 }, TERM_KEYS)], [200, 3, true, termBefore]);
  const auditTerm = await M("AuditLog").findOne({ action: "results.unpublished", resourceType: "term" }).lean();
  check("an AuditLog row for the term", [auditTerm?.before, auditTerm?.after, auditTerm?.reason], [{ published: 3 }, { published: 0 }, "Sequence 1 corrected"]);
  check("recomputing allowed, then republished", [(await call("POST", "/term-results/compute", T)).status, (await call("POST", "/term-results/publish", T)).body.published], [200, 3]);

  // ── Year ────────────────────────────────────────────────────────────────
  console.log("--- a class's annual results ---");
  const A = { academicYear: YEAR, classId: "f1" };
  check("year computed and published", [(await call("POST", "/annual-results/compute", A)).status, (await call("POST", "/annual-results/publish", A)).body.published], [200, 3]);
  const aRefused = await call("POST", "/annual-results/compute", A);
  check("recomputing is refused: 409 PUBLISHED_RESULTS", [aRefused.status, aRefused.body.code], [409, "PUBLISHED_RESULTS"]);
  const promotion = require("../src/services/promotion.service");
  const { run } = await promotion.generateRun({ schoolId: S, fromYear: YEAR, toYear: "2027/2028", generatedBy: "adm" });
  const blocked = await call("POST", "/annual-results/unpublish", { ...A, reason: "Term corrected" });
  check("a draft promotion run for the year: 409 PROMOTION_RUN_EXISTS, with the run's state",
    [blocked.status, blocked.body.code, blocked.body.runStatus, blocked.body.runId === String(run._id)], [409, "PROMOTION_RUN_EXISTS", "draft", true]);
  await M("PromotionRun").updateOne({ _id: run._id }, { $set: { status: "committed" } });
  const blocked2 = await call("POST", "/annual-results/unpublish", { ...A, reason: "Term corrected" });
  check("a committed one too", [blocked2.status, blocked2.body.runStatus], [409, "committed"]);
  check("and nothing was unpublished", await M("AnnualResult").countDocuments({ schoolId: S, isPublished: true }), 3);
  await M("PromotionRun").updateOne({ _id: run._id }, { $set: { status: "reversed" } });
  const ANNUAL_KEYS = ["annualAverage", "classPosition", "promotionStatus", "calcVersion"];
  const annualBefore = await figures("AnnualResult", { schoolId: S }, ANNUAL_KEYS);
  const au = await call("POST", "/annual-results/unpublish", { ...A, reason: "Term corrected" });
  check("once the run is reversed: unpublished, figures and statuses as before",
    [au.status, au.body.unpublished, au.body.issuedCardsUnchanged, await figures("AnnualResult", { schoolId: S }, ANNUAL_KEYS)], [200, 3, true, annualBefore]);
  const auditYear = await M("AuditLog").findOne({ action: "results.unpublished", resourceType: "annual" }).lean();
  check("an AuditLog row for the year", [auditYear?.before, auditYear?.after, auditYear?.reason], [{ published: 3 }, { published: 0 }, "Term corrected"]);
  check("recomputing allowed, then republished", [(await call("POST", "/annual-results/compute", A)).status, (await call("POST", "/annual-results/publish", A)).body.published], [200, 3]);

  // ── Report cards print in the school's language (docs/41 §7) ──────────
  console.log("--- report cards in the school's language, whoever views them ---");
  const langOf = async (url, method = "GET", body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${tok("adm", "school_admin")}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let html = text; try { html = JSON.parse(text).html ?? JSON.parse(text).data?.html ?? text; } catch { /* html */ }
    return [r.status, (String(html).match(/<html[^>]*lang="(\w+)"/) || [])[1] ?? null];
  };
  const urls = (l) => [
    `/results/s1/student/ama/reportcard/html?lang=${l}`,
    `/term-results/ama/report-card?academicYear=${encodeURIComponent(YEAR)}&term=1&classId=f1&lang=${l}`,
    `/annual-results/ama/report-card?academicYear=${encodeURIComponent(YEAR)}&classId=f1&lang=${l}`,
  ];
  await M("School").updateOne({ _id: S }, { $set: { defaultLanguage: "fr" } });
  const frCards = [];
  for (const u of urls("en")) frCards.push(await langOf(u));
  frCards.push(await langOf("/results/s1/student/ama/reportcard/reissue", "POST", { lang: "en", reason: "Reprint" }));
  await M("School").updateOne({ _id: S }, { $set: { defaultLanguage: "en" } });
  const enCards = [];
  for (const u of urls("fr")) enCards.push(await langOf(u));
  check("a French school: sequence, term and annual cards and a reissue in French, though asked for in English",
    frCards.map((c) => c[1]), ["fr", "fr", "fr", "fr"]);
  check("an English school: English, though asked for in French", enCards.map((c) => c[1]), ["en", "en", "en"]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e); process.exit(1); });
