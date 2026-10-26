// backend/scripts/check-card-lifecycle.js
"use strict";

/**
 * The report-card and QR lifecycle as it is TODAY, event by event (docs/39
 * §10, §20.0 — the card/QR lifecycle is a product decision not yet taken).
 *
 * Nothing here decides anything. Each step pins what happens now, so that
 * whichever option the school chooses (archive at first print, issue at
 * publication, freeze the QR only) lands as a visible, intended change. Only
 * the invariants that hold under all three options are asserted as such:
 *
 *   - one verification code per document, kept across every reprint;
 *   - the public page answers from the stored snapshot, never live data;
 *   - a revoked code stays revoked across reprints;
 *   - the parent's archived sequence card is written once and changed only
 *     by an administrator's reissue.
 *
 * Today's behaviour, pinned (marked TODAY):
 *   draft print       the QR row is minted and its snapshot taken before the
 *                     result is published; no archive
 *   publication       touches neither the archive nor the QR row
 *   preview           (no ?issue=1) shows the code but archives nothing,
 *                     counts no print and leaves the QR snapshot as it was
 *   first print after publication   archives the card (first issue wins)
 *   reprint           re-renders from live data; the archive is untouched;
 *                     the QR snapshot is refreshed from live data
 *   a mark corrected  the next reprint shows it and refreshes the QR page,
 *                     while the archived paper keeps the old figure — page
 *                     and paper disagree (the "mismatch is the check
 *                     working" design, documentVerify.service.js)
 *   reissue           rewrites the archive and refreshes the QR snapshot
 *   term card         never archived; every print refreshes its QR row
 *
 *   node scripts/check-card-lifecycle.js
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
  const docVerify = require("../src/services/documentVerify.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027";
  await M("School").create({ _id: S, name: "Lifecycle School", email: "life@example.test" });
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: S, isActive: true });
  await M("GradingConfig").create({ schoolId: S, caEnabled: false, passMark: 10 });
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR });
  await M("Class").create({ _id: "c1", schoolId: S, name: "Form 1" });
  await M("Student").create({ _id: "p1", userId: "u-p1", schoolId: S, classId: "c1", className: "Form 1",
    studentName: "Pupil One", enrollmentNo: "LC-1", status: "approved", isActive: true });
  await M("Exam").create({ _id: "e1", schoolId: S, name: "Sequence 1", type: "test", academicYear: YEAR,
    term: 1, sequenceNumber: 1, status: "completed", classId: "c1", classIds: ["c1"] });
  for (const [sub, mark] of [["math", 12], ["eng", 14]]) {
    await M("ExamSubject").create({ _id: `e1-${sub}`, examId: "e1", subjectId: sub, subjectName: sub, classId: "c1",
      schoolId: S, maxScore: 20, passMark: 10, weight: 100, submissionStatus: "approved" });
    await M("StudentScore").create({ examId: "e1", examSubjectId: `e1-${sub}`, studentId: "p1", subjectId: sub,
      classId: "c1", schoolId: S, maxScore: 20, score: mark, isPassing: mark >= 10 });
  }

  const app = express(); app.use(express.json());
  app.use("/api/exams",        auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results",      auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/term-results", auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/documents",    auth.authenticate, require("../src/routes/documents.routes"));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const print = async () => {
    const r = await call("GET", "/results/e1/student/p1/reportcard/html?issue=1");
    // The archive is written after the response, fire-and-forget: give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return r.body?.data?.html ?? "";
  };
  const archive = () => M("GeneratedReport").findOne({ examId: "e1", studentId: "p1" }).lean();
  const qr = () => M("DocumentVerification").findOne({ schoolId: S, studentId: "p1", examId: "e1" }).lean();
  const fact = (row, en) => row?.snapshot?.facts?.find((f) => f.label?.en === en)?.value ?? null;
  const page = async (code) => { const v = await docVerify.verify(code); return [v.status, fact(v, "Average /20")]; };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- draft ---");
  await call("POST", "/exams/e1/process", { classId: "c1" });
  await print();
  const draftQr = await qr();
  check("TODAY: a draft print mints the QR row and snapshots the unpublished 13.00", [Boolean(draftQr?.code), fact(draftQr, "Average /20"), draftQr?.printCount], [true, "13.00", 1]);
  check("TODAY: a draft print archives nothing", await archive(), null);

  console.log("--- publication ---");
  const summary = await M("ResultSummary").findOne({ examId: "e1", studentId: "p1" }).lean();
  const pub = await call("PUT", `/results/summary/${summary._id}/publish`, { isPublished: true });
  check("publication itself writes no archive and leaves the QR row as it was",
    [pub.status, await archive(), (await qr()).printCount], [200, null, 1]);

  console.log("--- a preview after publication ---");
  await call("GET", "/results/e1/student/p1/reportcard/html");
  await new Promise((resolve) => setTimeout(resolve, 150));
  check("opening the preview (no ?issue) archives nothing, even once published", await archive(), null);
  check("and counts no print on the QR row, nor refreshes its snapshot",
    [(await qr()).printCount, String((await qr()).refreshedAt)], [1, String(draftQr.refreshedAt)]);

  console.log("--- first print after publication ---");
  await print();
  const issued = await archive();
  check("TODAY: the first print after publication archives the card, with the 13.00 it printed",
    [Boolean(issued), (issued?.renderedHtml ?? "").includes("13.00")], [true, true]);
  check("invariant: the same QR code as the draft, a second print counted", [(await qr()).code, (await qr()).printCount], [draftQr.code, 2]);

  console.log("--- a mark corrected after issue ---");
  await M("StudentScore").updateOne({ examId: "e1", subjectId: "eng" }, { $set: { score: 18 } });
  await call("POST", "/exams/e1/process", { classId: "c1" });
  check("invariant: until something prints, the public page still answers with the stored snapshot (13.00)",
    await page(draftQr.code), ["valid", "13.00"]);
  const reprinted = await print();
  check("TODAY: a reprint re-renders from live data (15.00)", reprinted.includes("15.00"), true);
  check("invariant: the parent's archived card is unchanged (13.00)", (await archive()).renderedHtml === issued.renderedHtml, true);
  check("TODAY: the reprint refreshed the QR page to 15.00 — page and archived paper now disagree",
    await page(draftQr.code), ["valid", "15.00"]);
  check("invariant: still one code", (await qr()).code, draftQr.code);

  console.log("--- reissue ---");
  const re = await call("POST", "/results/e1/student/p1/reportcard/reissue", { reason: "English corrected" });
  check("reissue rewrites the archive to 15.00 and keeps the code",
    [re.status, (await archive()).renderedHtml.includes("15.00"), (await qr()).code], [200, true, draftQr.code]);

  console.log("--- revocation ---");
  const rv = await call("POST", `/documents/verifications/${(await qr())._id}/revoke`, { reason: "withdrawn" });
  check("a revoked code answers revoked", [rv.status, (await page(draftQr.code))[0]], [200, "revoked"]);
  await print();
  check("invariant: a reprint does not un-revoke it", (await page(draftQr.code))[0], "revoked");

  console.log("--- a term card ---");
  await M("TermResult").create({ schoolId: S, academicYear: YEAR, term: 1, classId: "c1", studentId: "p1",
    studentName: "Pupil One", className: "Form 1", termAverage: 14, overallGrade: "B+", isPassing: true,
    isPublished: true, sequenceAverages: [{ sequence: 1, average: 15 }, { sequence: 2, average: 13 }] });
  const termCard = (issue = "&issue=1") => call("GET", `/term-results/p1/report-card?academicYear=${encodeURIComponent(YEAR)}&term=1&classId=c1${issue}`);
  const t1 = await termCard();
  const termQr = () => M("DocumentVerification").findOne({ schoolId: S, studentId: "p1", examId: { $regex: "^term:" } }).lean();
  const firstTermQr = await termQr();
  await termCard();
  check("TODAY: a term card is never archived; every print refreshes its own QR row",
    [t1.status, await M("GeneratedReport").countDocuments({ studentId: "p1", examId: null }), (await termQr())?.printCount, (await termQr())?.code === firstTermQr?.code],
    [200, 0, 2, true]);
  await termCard("");
  check("a term card preview (no ?issue) shows the same code and counts no print",
    [(await termQr())?.printCount, (await termQr())?.code === firstTermQr?.code], [2, true]);

  console.log("--- a preview before any print ---");
  await M("DocumentVerification").deleteMany({ studentId: "p1", examId: { $regex: "^term:" } });
  await termCard("");
  check("a code first minted by a preview starts at printCount 0", (await termQr())?.printCount, 0);
  await termCard();
  check("and its first print counts as one", (await termQr())?.printCount, 1);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
