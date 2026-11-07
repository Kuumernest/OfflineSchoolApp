// desktop/scripts/check-mirror-tombstones.js
"use strict";

/**
 * No ghost rows: what the server hard-deletes, or unpublishes, leaves the mirror.
 *
 * The server hard-deletes rows of collections this mirror holds — a recompute
 * drops the result of a pupil it no longer ranks, reversing a promotion
 * removes the enrolments it made, a draft run is discarded with its
 * decisions — and only subjects, assignments and pupils used to leave a
 * tombstone. So the mirror kept every other deleted row for good, and after
 * a recompute held the dropped rows beside the kept ones. A result
 * unpublished stayed on a non-admin's machine as published.
 *
 * End to end, nothing faked: the REAL backend (its models, plugin, feed and
 * routes, on an in-memory MongoDB) and the REAL desktop store, client and
 * sync engine, into a temporary file. After every server change the mirror
 * must hold exactly the rows the server would send that caller now.
 *
 *   node scripts/check-mirror-tombstones.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { createRequire } = require("module");

const BACKEND = path.join(__dirname, "..", "..", "backend");
const breq    = createRequire(path.join(BACKEND, "package.json"));
const store      = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");
const { client } = require("../src/main/sync/client");
const { engine } = require("../src/main/sync/engine");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const COLLECTIONS = ["resultSummary", "termResult", "annualResult", "enrollment", "promotionRun", "promotionDecision", "syncTombstone"];

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-long-enough-for-validation";
  const mongoose = breq("mongoose");
  const { MongoMemoryServer } = breq("mongodb-memory-server");
  const express = breq("express");
  const jwt     = breq("jsonwebtoken");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  breq("./src/db/models");
  const M = (n) => mongoose.model(n);
  await M("SyncTombstone").createIndexes();
  const auth   = breq("./middleware/auth");
  const annual = breq("./src/services/annualGrading.service");

  // ── the school ───────────────────────────────────────────────────────────
  const YEAR = "2026/2027", NEXT = "2027/2028";
  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Mirror School", email: "mirror@example.test", settings: { academicYear: YEAR } });
  for (const [id, role] of [["adm", "school_admin"], ["bur", "bursar"]]) {
    await M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId: S, isActive: true });
  }
  await M("GradingConfig").create({ schoolId: S, caEnabled: false, passMark: 10 });
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR,
    terms: [{ number: 1, name: "T1", weight: 100, sequences: [{ number: 1, name: "S1", weight: 50 }, { number: 2, name: "S2", weight: 50 }] }] });
  await M("Class").create({ _id: "F1", schoolId: S, name: "F1" });
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

  // ── the server ───────────────────────────────────────────────────────────
  const app = express(); app.use(express.json());
  app.use("/api/exams",        auth.authenticate, breq("./src/routes/exam.routes"));
  app.use("/api/term-results", auth.authenticate, breq("./src/routes/termResults.routes"));
  app.use("/api/results",      auth.authenticate, breq("./src/routes/results.routes"));
  app.use("/api/promotion",    auth.authenticate, breq("./src/routes/promotion.routes"));
  app.use("/api/sync",         auth.authenticate, breq("./src/routes/sync.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const token = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const admin = async (method, url, body) => {
    const r = await fetch(`${BASE}/api${url}`, { method,
      headers: { Authorization: `Bearer ${token("adm", "school_admin")}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── two desktops: the office (admin) and the bursar ─────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-tombstones-"));
  const desktop = (name, id, role) => {
    const db   = store.open(path.join(dir, `${name}.db`));
    const docs = store.documents(db);
    const api  = client({ meta: store.meta(db) });
    api.setServerUrl(BASE);
    api.setToken(token(id, role));
    const eng = engine({ docs, queue: outbox(db), state: store.state(db), client: api, feedCollections: COLLECTIONS });
    return { db, docs, sync: () => eng.cycle(), status: () => eng.status() };
  };
  const office = desktop("office", "adm", "school_admin");
  const bursar = desktop("bursar", "bur", "bursar");

  const mirror = (d, c) => d.docs.find(c, {}).map((r) => r._id).sort();
  const server_ = async (model, filter = {}) => (await M(model).find({ schoolId: S, ...filter }).select("_id").lean()).map((r) => String(r._id)).sort();
  const idOf = async (model, filter) => String((await M(model).findOne(filter).select("_id").lean())?._id ?? "");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a recompute drops a pupil's results ---");
  await admin("POST", "/exams/e1/process", { classId: "F1" });
  await admin("POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "F1" });
  await annual.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: "F1" });
  await office.sync();
  check("first sync: the office mirror holds the 3 summaries, 3 term and 3 annual rows",
    [mirror(office, "resultSummary").length, mirror(office, "termResult").length, mirror(office, "annualResult").length], [3, 3, 3]);
  const p3 = { s: await idOf("ResultSummary", { studentId: "p3" }), t: await idOf("TermResult", { studentId: "p3" }), a: await idOf("AnnualResult", { studentId: "p3" }) };

  await M("StudentScore").updateMany({ examId: "e1", studentId: "p3" }, { $set: { deletedAt: new Date() } });
  await admin("POST", "/exams/e1/process", { classId: "F1" });
  await admin("POST", "/term-results/compute", { academicYear: YEAR, term: 1, classId: "F1" });
  await annual.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: "F1" });
  await office.sync();
  check("after the recompute the office mirror holds exactly the server's summaries (no ghost for p3)",
    mirror(office, "resultSummary"), await server_("ResultSummary"));
  check("  term results likewise", mirror(office, "termResult"), await server_("TermResult"));
  check("  annual results likewise", mirror(office, "annualResult"), await server_("AnnualResult"));
  check("  p3's three rows specifically are gone from the mirror",
    [office.docs.get("resultSummary", p3.s), office.docs.get("termResult", p3.t), office.docs.get("annualResult", p3.a)], [null, null, null]);
  check("  and the mirror keeps no tombstone rows of its own", office.docs.find("syncTombstone", {}).length, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a result unpublished leaves the bursar's mirror ---");
  await M("ResultSummary").updateMany({ examId: "e1" }, { $set: { isPublished: true, publishedAt: new Date() } });
  await bursar.sync();
  check("published: the bursar's mirror holds the two published summaries",
    mirror(bursar, "resultSummary"), await server_("ResultSummary", { isPublished: true }));
  let r = await admin("POST", "/results/e1/unpublish", { classId: "F1", reason: "a mark was wrong" });
  check("POST /results/e1/unpublish → 200", r.status, 200);
  await bursar.sync();
  check("unpublished: the bursar's mirror no longer holds them (it reads published results only)",
    mirror(bursar, "resultSummary"), []);
  await office.sync();
  check("  the office mirror still holds them, now unpublished",
    office.docs.find("resultSummary", {}).map((d) => d.isPublished), [false, false]);
  await M("ResultSummary").updateMany({ examId: "e1" }, { $set: { isPublished: true, publishedAt: new Date() } });
  await bursar.sync();
  check("published again: they are back on the bursar's mirror",
    mirror(bursar, "resultSummary"), await server_("ResultSummary", { isPublished: true }));
  await bursar.sync();
  check("  and a further sync does not remove them again", mirror(bursar, "resultSummary").length, 2);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- promotion: a discarded draft, a reversed run ---");
  await M("PromotionRun").create({ _id: "run-draft", schoolId: S, fromYear: YEAR, toYear: NEXT, status: "draft" });
  await M("PromotionDecision").create({ _id: "dec-1", runId: "run-draft", schoolId: S, studentId: "p1", fromClassId: "F1", toClassId: "F2", outcome: "promoted" });
  await M("PromotionRun").create({ _id: "run-c", schoolId: S, fromYear: "2025/2026", toYear: YEAR, status: "committed" });
  await M("PromotionDecision").create({ _id: "dec-c1", runId: "run-c", schoolId: S, studentId: "p2", fromClassId: "F0", toClassId: "F1", outcome: "promoted" });
  await M("Enrollment").create({ _id: "en-new", schoolId: S, studentId: "p2", academicYear: YEAR, classId: "F1", promotionRunId: "run-c" });
  await office.sync(); await bursar.sync();
  check("before: the office mirrors both runs, both decisions and the enrolment",
    [mirror(office, "promotionRun"), mirror(office, "promotionDecision"), mirror(office, "enrollment")],
    [["run-c", "run-draft"], ["dec-1", "dec-c1"], ["en-new"]]);
  check("  the bursar mirrors the enrolment", mirror(bursar, "enrollment"), ["en-new"]);

  r = await admin("DELETE", `/promotion/runs/run-draft?schoolId=${S}`);
  check("DELETE the draft run → 200", r.status, 200);
  r = await admin("POST", "/promotion/runs/run-c/reverse", { schoolId: S, reason: "wrong class" });
  check("reverse the committed run → 200, its enrolment removed", [r.status, r.body?.enrollmentsRemoved], [200, 1]);
  await office.sync(); await bursar.sync();
  check("after: the office mirror holds what the server holds — run-c (reversed), its decision, no enrolment",
    [mirror(office, "promotionRun"), mirror(office, "promotionDecision"), mirror(office, "enrollment")],
    [await server_("PromotionRun"), await server_("PromotionDecision"), await server_("Enrollment")]);
  check("  which is no draft run, no draft decision, no enrolment",
    [office.docs.get("promotionRun", "run-draft"), office.docs.get("promotionDecision", "dec-1"), office.docs.get("enrollment", "en-new")],
    [null, null, null]);
  check("  the bursar's enrolment is gone too", mirror(bursar, "enrollment"), []);
  check("  nothing held back on either", [office.status().heldBack ?? [], bursar.status().heldBack ?? []], [[], []]);

  for (const d of [office, bursar]) d.db.close();
  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
