// backend/scripts/check-mirror-tombstones.js
"use strict";

/**
 * Every hard delete of a mirrored collection reaches the desktop.
 *
 * GET /sync/changes mirrors results, enrolments, promotion runs and their
 * decisions, and staff/pupil accounts. The server hard-deletes rows of all of
 * them — a recompute drops the result of a pupil it no longer ranks, reversing
 * a promotion removes the enrolments it made, a draft run is discarded, a
 * pupil's deletion takes their login — and only subjects, assignments and
 * pupils left a tombstone. Every other deletion left its row on every desktop
 * for good, and a recompute left the dropped rows beside the new ones.
 *
 * And one removal that is not a deletion: a result unpublished. A non-admin
 * mirrors published results only, so the unpublished row stops matching its
 * feed and the published copy stayed on that machine, still saying published.
 *
 * Driven through the real paths: POST /exams/:id/process, POST
 * /term-results/compute, the annual service, POST /results/:examId/unpublish,
 * DELETE /promotion/runs/:id, POST /promotion/runs/:id/reverse. Then read as
 * an admin, a bursar, a teacher and a pupil through GET /sync/changes.
 *
 *   node scripts/check-mirror-tombstones.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-long-enough-for-validation";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);
  await M("SyncTombstone").createIndexes();

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");
  const annual  = require("../src/services/annualGrading.service");
  const unpublish = require("../src/services/unpublish.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027", NEXT = "2027/2028";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Tomb School", email: "tomb@example.test", settings: { academicYear: YEAR } });
  const user = (id, role) => M("User").create({ _id: id, name: id, email: `${id}@example.test`,
    password: "check-only-password", role, schoolId: S, isActive: true });
  await user("adm", "school_admin"); await user("bur", "bursar"); await user("tea", "teacher"); await user("pup", "student");
  await M("GradingConfig").create({ schoolId: S, caEnabled: false, passMark: 10 });
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR,
    terms: [{ number: 1, name: "T1", weight: 100,
      sequences: [{ number: 1, name: "S1", weight: 50 }, { number: 2, name: "S2", weight: 50 }] }] });
  await M("Class").create({ _id: "F1", schoolId: S, name: "F1" });
  await M("Class").create({ _id: "F2", schoolId: S, name: "F2" });
  await M("TeacherAssignment").create({ _id: "ta-1", schoolId: S, teacher: "tea", class: "F1", subject: "math" });
  for (const id of ["p1", "p2", "p3"]) {
    await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: S, classId: "F1", className: "F1",
      studentName: `Pupil ${id}`, enrollmentNo: `EN-${id}`, status: "approved", isActive: true });
  }
  await M("Exam").create({ _id: "e1", schoolId: S, name: "e1", type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 1, status: "completed", classId: "F1", classIds: ["F1"] });
  await M("ExamSubject").create({ _id: "e1-F1-math", examId: "e1", subjectId: "math", subjectName: "Maths",
    classId: "F1", schoolId: S, maxScore: 20, passMark: 10, weight: 100, submissionStatus: "approved" });
  for (const [studentId, score] of Object.entries({ p1: 15, p2: 12, p3: 9 })) {
    await M("StudentScore").create({ examId: "e1", examSubjectId: "e1-F1-math", studentId, subjectId: "math",
      classId: "F1", schoolId: S, maxScore: 20, score, isAbsent: false });
  }

  const app = express(); app.use(express.json());
  app.use("/api/exams",        auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/term-results", auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/results",      auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/promotion",    auth.authenticate, require("../src/routes/promotion.routes"));
  app.use("/api/sync",         auth.authenticate, require("../src/routes/sync.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, code: err.code, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const T = Object.fromEntries([["adm", "school_admin"], ["bur", "bursar"], ["tea", "teacher"], ["pup", "student"]]
    .map(([id, role]) => [id, jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" })]));
  const call = async (who, method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${T[who]}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };

  // Each caller reads the feed from its own cursor, as a desktop does.
  const cursors = { adm: null, bur: null, tea: null, pup: null };
  // What each reader already has. The feed re-sends rows changed within its
  // safety window (commit-safe cursors, 58b1a0a) and a desktop applies them
  // as no-ops; "hears of" means news to that reader. A reader whose cursor is
  // reset starts fresh, as a desktop that had not synced.
  const seen = { adm: new Set(), bur: new Set(), tea: new Set(), pup: new Set() };
  const feed = async (who) => {
    if (!cursors[who]) seen[who] = new Set();
    const out = [];
    for (let page = 0; page < 50; page++) {
      const qs = new URLSearchParams({ collections: "syncTombstone", limit: "200",
        ...(cursors[who] ? { cursors: JSON.stringify({ syncTombstone: cursors[who] }) } : {}) });
      const r = await call(who, "GET", `/sync/changes?${qs}`);
      const slice = r.body?.collections?.syncTombstone;
      if (!slice) return { refused: (r.body?.refused || []).some((x) => x.collection === "syncTombstone"), rows: out };
      for (const t of slice.documents) {
        const k = `${t.entity}:${t.docId}:${t.reason || ""}`;
        if (!seen[who].has(k)) { seen[who].add(k); out.push(t); }
      }
      cursors[who] = slice.cursor;
      if (!slice.hasMore) break;
    }
    return { refused: false, rows: out };
  };
  const names = (rows) => rows.map((t) => `${t.entity}:${t.docId}${t.reason ? `(${t.reason})` : ""}`).sort();
  const idOf = async (model, filter) => (await M(model).findOne(filter).select("_id").lean())?._id ?? null;
  const ids = async (model, filter) => (await M(model).find(filter).select("_id").lean()).map((r) => String(r._id)).sort();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- recompute: the rows a run drops are tombstoned, the kept rows keep their ids ---");
  let r = await call("adm", "POST", "/exams/e1/process", { classId: "F1" });
  check("first process → 3 summaries", [r.status, (await ids("ResultSummary", { examId: "e1" })).length], [200, 3]);
  r = await call("adm", "POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "F1" });
  check("first term compute → 3 term rows", [r.status, (await ids("TermResult", { schoolId: S })).length], [200, 3]);
  await annual.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: "F1" });
  check("first annual compute → 3 annual rows", (await ids("AnnualResult", { schoolId: S })).length, 3);
  // Nothing deleted yet: every caller starts at an empty tombstone feed.
  for (const who of ["adm", "bur", "tea"]) await feed(who);

  const before = {
    summary: { p1: await idOf("ResultSummary", { studentId: "p1" }), p2: await idOf("ResultSummary", { studentId: "p2" }), p3: await idOf("ResultSummary", { studentId: "p3" }) },
    term:    { p1: await idOf("TermResult", { studentId: "p1" }), p3: await idOf("TermResult", { studentId: "p3" }) },
    annual:  { p1: await idOf("AnnualResult", { studentId: "p1" }), p3: await idOf("AnnualResult", { studentId: "p3" }) },
  };
  // p3's mark is withdrawn: the recompute at every level drops p3's row.
  await M("StudentScore").updateMany({ examId: "e1", studentId: "p3" }, { $set: { deletedAt: new Date() } });
  await call("adm", "POST", "/exams/e1/process", { classId: "F1" });
  await call("adm", "POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "F1" });
  await annual.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: "F1" });

  check("after: p3 has no summary, term or annual row",
    [await idOf("ResultSummary", { studentId: "p3" }), await idOf("TermResult", { studentId: "p3" }), await idOf("AnnualResult", { studentId: "p3" })],
    [null, null, null]);
  check("the kept rows are the SAME rows (upserted, not deleted and re-inserted): no ghost beside a new id",
    [await idOf("ResultSummary", { studentId: "p1" }), await idOf("TermResult", { studentId: "p1" }), await idOf("AnnualResult", { studentId: "p1" })],
    [before.summary.p1, before.term.p1, before.annual.p1]);
  let adm = await feed("adm");
  check("an admin hears of exactly the three rows the recompute dropped",
    names(adm.rows), [`annualResult:${before.annual.p3}`, `resultSummary:${before.summary.p3}`, `termResult:${before.term.p3}`].sort());
  let bur = await feed("bur");
  check("a bursar (results.view) hears of them too",
    names(bur.rows), [`annualResult:${before.annual.p3}`, `resultSummary:${before.summary.p3}`, `termResult:${before.term.p3}`].sort());
  let tea = await feed("tea");
  check("a teacher (results.view) hears of them too",
    names(tea.rows), [`annualResult:${before.annual.p3}`, `resultSummary:${before.summary.p3}`, `termResult:${before.term.p3}`].sort());
  const pup = await feed("pup");
  check("a pupil: refused by name", pup.refused, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- unpublish: the published copy leaves the non-admin mirror ---");
  await M("ResultSummary").updateMany({ examId: "e1" }, { $set: { isPublished: true, publishedAt: new Date() } });
  await M("TermResult").updateMany({ schoolId: S }, { $set: { isPublished: true, publishedAt: new Date() } });
  r = await call("adm", "POST", "/results/e1/unpublish", { classId: "F1", reason: "a mark was wrong" });
  check("POST /results/e1/unpublish → 200, 2 unpublished", [r.status, r.body?.unpublished], [200, 2]);
  const fakeReq = { user: { _id: "adm", role: "school_admin", schoolId: S, name: "adm" }, headers: {}, ip: "127.0.0.1" };
  r = await unpublish.unpublishTerm(fakeReq, { schoolId: S, academicYear: YEAR, term: 1, classId: "F1", reason: "re-weighting" });
  check("unpublishTerm → 200, 2 unpublished", [r.status, r.body?.unpublished], [200, 2]);
  const unpub = [`resultSummary:${before.summary.p1}(unpublished)`, `resultSummary:${before.summary.p2}(unpublished)`,
    `termResult:${before.term.p1}(unpublished)`, `termResult:${await idOf("TermResult", { studentId: "p2" })}(unpublished)`].sort();
  bur = await feed("bur");
  check("a bursar (mirrors published results only) is told to drop the four unpublished rows", names(bur.rows), unpub);
  tea = await feed("tea");
  check("a teacher likewise", names(tea.rows), unpub);
  adm = await feed("adm");
  check("an admin is not (its mirror holds unpublished rows, and the row itself reached it)", names(adm.rows), []);

  // Published again: the row reaches the non-admin through its own feed, and
  // a stale "unpublished" must not then remove it. A fresh reader is used, as
  // a desktop that had not synced between the two.
  await M("ResultSummary").updateMany({ examId: "e1" }, { $set: { isPublished: true } });
  cursors.bur = null;
  bur = await feed("bur");
  check("republished: the summaries' 'unpublished' tombstones are no longer sent; the term ones still are",
    names(bur.rows).filter((n) => n.includes("(unpublished)")),
    unpub.filter((n) => n.startsWith("termResult")));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- promotion: a discarded draft run, and a reversed run's enrolments ---");
  await M("PromotionRun").create({ _id: "run-draft", schoolId: S, fromYear: YEAR, toYear: NEXT, status: "draft" });
  await M("PromotionDecision").create({ _id: "dec-1", runId: "run-draft", schoolId: S, studentId: "p1", fromClassId: "F1", toClassId: "F2", outcome: "promoted" });
  await M("PromotionDecision").create({ _id: "dec-2", runId: "run-draft", schoolId: S, studentId: "p2", fromClassId: "F1", toClassId: "F2", outcome: "promoted" });
  cursors.adm = cursors.bur = cursors.tea = null;
  for (const who of ["adm", "bur", "tea"]) await feed(who);   // read up to now
  r = await call("adm", "DELETE", `/promotion/runs/run-draft?schoolId=${S}`);
  check("DELETE /promotion/runs/run-draft → 200, discarded", [r.status, r.body?.discarded], [200, true]);
  check("  the run and its decisions are gone",
    [await M("PromotionRun").countDocuments({ _id: "run-draft" }), await M("PromotionDecision").countDocuments({ runId: "run-draft" })], [0, 0]);

  await M("PromotionRun").create({ _id: "run-c", schoolId: S, fromYear: YEAR, toYear: NEXT, status: "committed" });
  await M("PromotionDecision").create({ _id: "dec-c1", runId: "run-c", schoolId: S, studentId: "p1", fromClassId: "F1", toClassId: "F2", outcome: "promoted" });
  await M("Enrollment").create({ _id: "en-old", schoolId: S, studentId: "p1", academicYear: YEAR, classId: "F1" });
  await M("Enrollment").create({ _id: "en-new", schoolId: S, studentId: "p1", academicYear: NEXT, classId: "F2", promotionRunId: "run-c" });
  r = await call("adm", "POST", "/promotion/runs/run-c/reverse", { schoolId: S, reason: "wrong year" });
  check("POST /promotion/runs/run-c/reverse → 200, 1 enrolment removed", [r.status, r.body?.enrollmentsRemoved], [200, 1]);

  adm = await feed("adm");
  check("an admin (promotion.run, students.view) hears of the run, both decisions and the enrolment",
    names(adm.rows), ["enrollment:en-new", "promotionDecision:dec-1", "promotionDecision:dec-2", "promotionRun:run-draft"]);
  bur = await feed("bur");
  check("a bursar (students.view, no promotion.run): the enrolment only", names(bur.rows), ["enrollment:en-new"]);
  tea = await feed("tea");
  check("a teacher (students.viewTaught, no promotion.run): the enrolment only", names(tea.rows), ["enrollment:en-new"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a pupil's login account, deleted with the pupil ---");
  await user("u-gone", "student");
  await M("User").findByIdAndDelete("u-gone");
  adm = await feed("adm");
  check("an admin (users.manage) hears of the deleted account", names(adm.rows), ["user:u-gone"]);
  bur = await feed("bur");
  check("a bursar (no users.manage) does not", names(bur.rows), []);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the boot check ---");
  const syncFeed = require("../src/config/syncFeed");
  check("every mirrored model the source hard-deletes is tombstoned (boot assertion passes)",
    (() => { try { syncFeed.assertHardDeletesAreTombstoned(); return "ok"; } catch (e) { return e.message; } })(), "ok");
  check("  and it saw the delete paths this check drives",
    ["AnnualResult", "Enrollment", "PromotionDecision", "PromotionRun", "ResultSummary", "TermResult", "User"]
      .every((m) => syncFeed.hardDeletedModels().has(m)), true);
  const schema = M("Enrollment").schema;
  const saved = schema.syncTombstoneEntity;
  delete schema.syncTombstoneEntity;
  check("  a mirrored, hard-deleted model without the plugin stops the boot, naming it",
    (() => { try { syncFeed.assertHardDeletesAreTombstoned(); return "passed"; } catch (e) { return /Enrollment does not carry/.test(e.message); } })(), true);
  schema.syncTombstoneEntity = saved;

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
