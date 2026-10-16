// backend/scripts/check-analysis-runs.js
"use strict";

/**
 * The cold school-wide analysis, run off the request thread (docs/38).
 *
 * ── What is being proved ──────────────────────────────────────────────────
 *
 * 1. Same answer. The worker's report is byte-for-byte the report the request
 *    thread produced before this change (analyse() over liveCohort, minus the
 *    profiles), and it survives compression, storage and the digest check.
 * 2. The record. A run moves queued → running → succeeded (or failed), keeps
 *    its counts, times and codes, and holds no name.
 * 3. Freshness. The fingerprint moves for every write the analysis can see —
 *    a mark, a bulkWrite, publication, soft and hard deletion, a new result,
 *    a class move, the grading config, an exam, an intervention — and for
 *    nothing in another school. A changed fingerprint is a new run; a report
 *    is never served under one that differs.
 * 4. Duplicates. Five concurrent requests make one run; two instances standing
 *    for two servers make one run, held by the unique index.
 * 5. Recovery. A run whose owner died is failed INTERRUPTED and does not block
 *    the next request; a live run held elsewhere is waited on, not doubled.
 * 6. Failure. An engine error, a worker exit, a timeout, an out-of-memory
 *    worker (the server survives it) and an oversized report each end the run
 *    with their code; automatic retry stops at its limit; an explicit retry is
 *    the head's.
 * 7. The loop. A worker that never yields does not stall the server's timers.
 * 8. Who. The bursar and the pupil are refused; an operator without a school
 *    gets 400, never every school; another school's run is 404; a teacher
 *    reads only runs over classes they teach now.
 * 9. HTTP. A cold miss past the wait is 202 ANALYSIS_PENDING with the run and
 *    a status URL, success:false; a pilot transition that needs the analysis
 *    is 409 ANALYSIS_PENDING and records nothing.
 *
 * ── What is NOT being proved ──────────────────────────────────────────────
 *
 * Anything about the engine, which these runs execute unchanged; and the
 * timings at scale, which scripts/perf-analysis-runs.js measures.
 *
 *   node scripts/check-analysis-runs.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const zlib     = require("zlib");
const crypto   = require("crypto");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};
const section = (t) => console.log(`\n[${t}]`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = "6a00000000000000000000a1";   // Alpha Academy
const B = "6a00000000000000000000b2";   // Beta College
const YEAR = "2026-2027";

const row = (subjectId, subjectName, normalizedMark) => ({
  subjectId, subjectName, normalizedMark, score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null, isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false,
});

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  const Run = M("IntelligenceAnalysisRun");
  await M("IntelligenceReview").syncIndexes();
  await M("IntelligencePilot").syncIndexes();

  const runs = require(path.join(SRC, "services/intelligence/analysisRuns.service"));
  const reviewCases = require(path.join(SRC, "services/intelligence/reviewCases.service"));
  const { analyse } = require(path.join(ROOT, "scripts/calibration/analyseCohort"));
  const { loadEvidence, runWorker, PROVENANCE } = runs._internals;

  // Fast settings for a small fixture; each test sets what it needs.
  const base = { waitMs: 30_000, retryBackoffMs: 0, timeoutMs: 60_000, heapMb: 512, fault: null, pollMs: 50, maxReportBytes: 12 * 1024 * 1024 };
  runs.configure(base);

  // ── The schools ──────────────────────────────────────────────────────────
  await M("School").create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId, name) => M("User").create({
    _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a",  "teacher",      A, "Teacher A"),
    mkUser("teach-c",  "teacher",      A, "Teacher C"),
    mkUser("admin-a",  "school_admin", A, "Head Alpha"),
    mkUser("admin-b",  "school_admin", B, "Head Beta"),
    mkUser("bursar-a", "bursar",       A, "Bursar Alpha"),
    mkUser("operator", "super_admin",  null, "Platform Operator"),
  ]);
  await M("Class").create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await M("TeacherAssignment").create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
    { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `ENR-${n}`, isActive: true, status: "approved",
  });
  await M("Student").create([pupil("st-a1", A, "form3a", "A1"), pupil("st-a2", A, "form4b", "A2"), pupil("st-a3", A, "form3a", "A3"), pupil("st-b1", B, "form1b", "B1")]);
  await mkUser("u-st-a1", "student", A, "Pupil A1");
  await M("GradingConfig").create({ schoolId: A, passMark: 10 });
  const mkExam = (id, schoolId, term, seq, startDate) => ({
    _id: id, schoolId, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate,
    classId: "form3a", totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
  });
  await M("Exam").create([mkExam("ax1", A, 1, 1, "2026-10-05"), mkExam("ax2", A, 1, 2, "2026-11-20"), mkExam("ax3", A, 2, 1, "2027-02-10"), mkExam("bx1", B, 1, 1, "2026-10-05")]);
  const summary = (id, examId, studentId, classId, schoolId, term, rows) => ({
    _id: id, examId, studentId, classId, schoolId, academicYear: YEAR, term: String(term),
    isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows,
  });
  await M("ResultSummary").create([
    summary("s1", "ax1", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 16), row("ict", "ICT", 16)]),
    summary("s2", "ax2", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 15), row("ict", "ICT", 17)]),
    summary("s3", "ax3", "st-a1", "form3a", A, 2, [row("maths", "Mathematics", 9),  row("ict", "ICT", 17)]),
    summary("s4", "ax1", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 8)]),
    summary("s5", "ax2", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 7)]),
    summary("s6", "ax3", "st-a2", "form4b", A, 2, [row("maths", "Mathematics", 6)]),
    summary("s7", "ax1", "st-a3", "form3a", A, 1, [row("maths", "Mathematics", 12)]),
    summary("b1", "bx1", "st-b1", "form1b", B, 1, [row("maths", "Mathematics", 11)]),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, {
        method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let out = {}; try { out = await res.json(); } catch { /* empty */ }
      return { status: res.status, body: out, retryAfter: res.headers.get("retry-after") };
    };
    return { get: (u) => call("GET", u), post: (u, b) => call("POST", u, b), patch: (u, b) => call("PATCH", u, b) };
  };
  const teacherA = as("teach-a",  "teacher",      A);
  const teacherC = as("teach-c",  "teacher",      A);
  const head     = as("admin-a",  "school_admin", A);
  const headB    = as("admin-b",  "school_admin", B);
  const bursar   = as("bursar-a", "bursar",       A);
  const pupilA1  = as("u-st-a1",  "student",      A);
  const operator = as("operator", "super_admin",  null);

  const SCHOOL = { schoolId: A, classIds: null };
  const runsOf = (scope = SCHOOL) => Run.countDocuments({ schoolId: scope.schoolId, scopeKey: runs.scopeKeyOf(scope) });

  // ───────────────────────────────────────────────────────────────────────────
  section("1. the index");
  check("ensureIndexes reports the unique activeKey index present", await runs.ensureIndexes(), true);
  const mk = (activeKey) => Run.create({ schoolId: A, scopeKey: "probe", fingerprint: "f", engineVersion: "x", codeDigest: "c", activeKey });
  await mk("probe-key");
  let dup = null; try { await mk("probe-key"); } catch (err) { dup = err.code; }
  check("a second active run under the same key is refused by the index", dup, 11000);
  await mk(null); await mk(null);
  check("ended runs (activeKey null) are not constrained", await Run.countDocuments({ scopeKey: "probe" }), 3);
  await Run.deleteMany({ scopeKey: "probe" });
  {
    // A database that refuses index creation (and so never creates the
    // collection) must cost a log line, not the server's start.
    const realCreate = Run.createIndexes, realIndexes = Run.collection.indexes;
    Run.createIndexes = async () => { throw new Error("not authorized to createIndex"); };
    Run.collection.indexes = async () => { throw new Error("ns does not exist"); };
    let threw = false, okAnswer = null;
    try { okAnswer = await runs.ensureIndexes(); } catch { threw = true; }
    Run.createIndexes = realCreate; Run.collection.indexes = realIndexes;
    check("index creation and read-back both refused → reported as missing, never thrown", [threw, okAnswer], [false, false]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("2. the same answer, through the worker and the store");
  {
    const { cohort } = await reviewCases.liveCohort(SCHOOL);
    const before = JSON.stringify({ ...analyse(cohort), profiles: undefined });
    const docs = await loadEvidence(SCHOOL);
    check("the worker's evidence carries no name field",
      docs.students.some((s) => "studentName" in s || "name" in s || "enrollmentNo" in s), false);
    const out = await runWorker({ docs, provenance: { ...PROVENANCE }, fault: null }, { timeoutMs: 60_000, heapMb: 512 });
    check("the worker answers ok", out.ok, true);
    const json = zlib.gunzipSync(out.gz).toString("utf8");
    check("worker report === request-thread report (bytes)", json === before, true);
    check("digest is sha256 of the compressed bytes", out.digest, crypto.createHash("sha256").update(out.gz).digest("hex"));
    check("raw size recorded", out.rawBytes, Buffer.byteLength(json));
    check("the report holds no pupil name or enrollment number", /Pupil A1|ENR-A1|studentName|enrollmentNo/.test(json), false);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("3. lifecycle over HTTP");
  const r1 = await head.get("/insights/review-cases");
  check("cold review queue → 200 once the run finishes inside the wait", r1.status, 200);
  check("the existing contract: cases, reviewStatus, scope", [Array.isArray(r1.body.data?.cases), typeof r1.body.data?.reviewStatus, r1.body.data?.scope?.students], [true, "object", 3]);
  check("names are joined for the reader, after the stored report", r1.body.data.cases.some((c) => typeof c.studentName === "string" && c.studentName.startsWith("Pupil")), true);
  const first = await Run.findOne({ schoolId: A, scopeKey: "school" }).select("+report").lean();
  check("one run, succeeded, stage done, key released",
    [await runsOf(), first.status, first.stage, first.activeKey, first.attempt], [1, "succeeded", "done", null, 1]);
  check("times and counts recorded",
    [Boolean(first.startedAt && first.finishedAt), first.durationMs >= 0, first.counts.students, first.counts.results, first.counts.cases > 0], [true, true, 3, 7, true]);
  check("stored report is gzip, sized and digested",
    [first.report.buffer[0] === 0x1f && first.report.buffer[1] === 0x8b, first.reportBytes === first.report.buffer.length, first.reportDigest.length], [true, true, 64]);
  check("requester recorded, never a name", [first.requestedBy, first.requestedByRole], ["admin-a", "school_admin"]);
  const r2 = await head.get("/insights/review-cases");
  check("warm: served from the store, no second run", [r2.status, await runsOf()], [200, 1]);
  check("warm answer equals cold answer (cases)", JSON.stringify(r2.body.data.cases), JSON.stringify(r1.body.data.cases));
  const cs = await head.get("/insights/calibration-summary");
  check("calibration summary served from the same run", [cs.status, await runsOf(), typeof cs.body.data?.sensitivity?.borderlineShare], [200, 1, "number"]);

  // ───────────────────────────────────────────────────────────────────────────
  section("4. freshness: what moves the fingerprint");
  {
    const fp = () => runs.fingerprintOf(SCHOOL);
    const f0 = await fp();
    check("stable when nothing changed", await fp(), f0);
    let last = f0;
    const moves = async (label, write) => {
      await sleep(3);  // a write in a later millisecond than the last (see docs/38 §4)
      await write();
      const now = await fp();
      check(`${label} changes the fingerprint`, now !== last, true);
      last = now;
    };
    const RS = M("ResultSummary");
    await moves("a mark edit (updateOne)", () => RS.updateOne({ _id: "s3" }, { $set: { "subjectBreakdown.0.normalizedMark": 8 } }));
    await moves("a bulkWrite update (exam.routes, results.controller)", () => RS.bulkWrite([{ updateOne: { filter: { _id: "s2" }, update: { $set: { percentage: 61 } } } }]));
    await moves("unpublishing a result", () => RS.updateOne({ _id: "s7" }, { $set: { isPublished: false } }));
    await moves("publishing it again", () => RS.updateOne({ _id: "s7" }, { $set: { isPublished: true } }));
    await moves("a soft delete", () => RS.updateOne({ _id: "s7" }, { $set: { deletedAt: new Date() } }));
    await moves("a new result", () => RS.create(summary("s8", "ax3", "st-a3", "form3a", A, 2, [row("maths", "Mathematics", 13)])));
    await moves("a hard delete", () => RS.deleteOne({ _id: "s8" }));
    await moves("a pupil moved between classes", () => M("Student").updateOne({ _id: "st-a3" }, { $set: { classId: "form4b" } }));
    await moves("the grading config", () => M("GradingConfig").updateOne({ schoolId: A }, { $set: { passMark: 11 } }));
    await moves("an exam edit", () => M("Exam").updateOne({ _id: "ax3" }, { $set: { startDate: new Date("2027-02-11") } }));
    await moves("an intervention", () => M("Intervention").create({ schoolId: A, studentId: "st-a1", classId: "form3a", createdBy: "admin-a", updatedBy: "admin-a", actionCode: "check-in", subjectId: "maths" }));
    await moves("a pupil withdrawn (status)", () => M("Student").updateOne({ _id: "st-a3" }, { $set: { status: "rejected" } }));
    const beforeB = await fp();
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "b1" }, { $set: { percentage: 70 } });
    await M("Student").updateOne({ _id: "st-b1" }, { $set: { classId: "form1b" } });
    check("another school's writes do not move this school's fingerprint", await fp(), beforeB);
    const form3a = { schoolId: A, classIds: ["form3a"] };
    const c0 = await runs.fingerprintOf(form3a);
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s4" }, { $set: { percentage: 41 } });  // st-a2, in form4b
    check("a class scope ignores another class's result", await runs.fingerprintOf(form3a), c0);
    check("class scopes with the same classes share a key, in any order",
      runs.scopeKeyOf({ classIds: ["form4b", "form3a"] }), runs.scopeKeyOf({ classIds: ["form3a", "form4b", "form3a"] }));

    const r3 = await head.get("/insights/review-cases");
    const latest = await Run.findOne({ schoolId: A, scopeKey: "school" }).sort({ createdAt: -1 }).lean();
    check("changed evidence → a new run, not the old report", [r3.status, await runsOf(), latest.fingerprint === f0], [200, 2, false]);
    check("the new report reflects the change (one fewer pupil in scope)", r3.body.data.scope.students, 2);
    const older = await Run.findOne({ schoolId: A, scopeKey: "school", fingerprint: f0 }).select("+report").lean();
    check("the older report's bytes are released, the run kept", [Boolean(older.reportPrunedAt), older.report === null, older.status], [true, true, "succeeded"]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("5. duplicates");
  {
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 62 } });
    const n0 = await runsOf();
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => head.get("/insights/review-cases")));
    check("five concurrent cold requests all answer 200", five.map((r) => r.status), [200, 200, 200, 200, 200]);
    check("…from exactly one run", await runsOf() - n0, 1);

    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 63 } });
    const other = runs.createAnalysisRuns({ instanceId: "second-server", ...base });
    const [x, y] = await Promise.all([runs.ensure(SCHOOL, null), other.ensure(SCHOOL, null)]);
    check("two servers asking at once get the same run", String(x.run._id), String(y.run._id));
    check("…and only one was created", await runsOf() - n0, 2);
    const viaOther = await other.reportFor(SCHOOL, null, { waitMs: 30_000 });
    check("the server that lost the race waits on the winner's record and is served", typeof viaOther.report.reviewCases, "object");
    await runs.idle(); await other.idle();
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("6. recovery");
  {
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 64 } });
    const fp = await runs.fingerprintOf(SCHOOL);
    const key = `${A}|school|${fp}`;
    // The production back-off (60 s) is in force here: an interruption must
    // not wait it out.
    runs.configure({ retryBackoffMs: 60_000 });
    const ghost = await Run.create({ schoolId: A, scopeKey: "school", fingerprint: fp, engineVersion: "1.0.0", codeDigest: "x",
      status: "running", stage: "analysing", activeKey: key, owner: "dead-server", leaseUntil: new Date(Date.now() - 1000) });
    const r = await head.get("/insights/review-cases");
    const g = await Run.findById(ghost._id).lean();
    check("a run whose owner died is failed INTERRUPTED", [g.status, g.error?.code, g.activeKey], ["failed", "INTERRUPTED", null]);
    check("…and does not block the request, which gets a fresh run (with the 60 s back-off configured)", r.status, 200);
    runs.configure({ retryBackoffMs: 0 });

    // The same, seen by a request that is already waiting on the dead run.
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 64.5 } });
    runs.configure({ retryBackoffMs: 60_000 });
    const fpw = await runs.fingerprintOf(SCHOOL);
    const dying = await Run.create({ schoolId: A, scopeKey: "school", fingerprint: fpw, engineVersion: "1.0.0", codeDigest: "x",
      status: "running", stage: "analysing", activeKey: `${A}|school|${fpw}`, owner: "dying-server", leaseUntil: new Date(Date.now() + 400) });
    const w = await head.get("/insights/review-cases");
    check("a request waiting on a run whose server dies mid-wait is served by a fresh run, not 503",
      [w.status, (await Run.findById(dying._id).lean()).error?.code], [200, "INTERRUPTED"]);
    runs.configure({ retryBackoffMs: 0 });

    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 65 } });
    const fp2 = await runs.fingerprintOf(SCHOOL);
    const alive = await Run.create({ schoolId: A, scopeKey: "school", fingerprint: fp2, engineVersion: "1.0.0", codeDigest: "x",
      status: "running", stage: "analysing", activeKey: `${A}|school|${fp2}`, owner: "busy-server", leaseUntil: new Date(Date.now() + 60_000) });
    runs.configure({ waitMs: 300 });
    const p = await head.get("/insights/review-cases");
    check("a live run held elsewhere is waited on, then 202 — not run twice",
      [p.status, p.body.code, p.body.data?.runId === String(alive._id), await Run.countDocuments({ activeKey: `${A}|school|${fp2}` })], [202, "ANALYSIS_PENDING", true, 1]);
    await Run.updateOne({ _id: alive._id }, { $set: { leaseUntil: new Date(Date.now() - 1) } });
    check("recoverStale fails expired leases at boot", await runs.recoverStale(), 1);
    runs.configure({ waitMs: 30_000 });
    check("…after which the scope is served again", (await head.get("/insights/review-cases")).status, 200);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("7. failure and retry");
  {
    const bump = async (n) => { await sleep(3); await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 66 + n } }); };
    await bump(0);
    runs.configure({ fault: "throw" });
    const e1 = await head.get("/insights/review-cases");
    const f1 = await Run.findOne({ schoolId: A, scopeKey: "school" }).sort({ createdAt: -1 }).lean();
    check("an engine error → 503 ANALYSIS_FAILED, run failed ENGINE_ERROR",
      [e1.status, e1.body.success, e1.body.code, f1.status, f1.error.code, f1.attempt], [503, false, "ANALYSIS_FAILED", "failed", "ENGINE_ERROR", 1]);
    check("the failure message is the fixed sentence, not the error's text", /injected/.test(JSON.stringify(e1.body)), false);
    const e2 = await head.get("/insights/review-cases");
    check("one automatic retry (attempt 2) after the back-off", (await Run.findOne({ schoolId: A, scopeKey: "school" }).sort({ createdAt: -1 }).lean()).attempt, 2);
    check("…which fails the same way", e2.status, 503);
    const before = await runsOf();
    const e3 = await head.get("/insights/review-cases");
    check("past the automatic limit no new run starts", [e3.status, await runsOf() - before], [503, 0]);
    const lastId = e3.body.data.runId;
    const postAfter = await head.post("/insights/analysis-runs");
    check("POST start past the limit → 503 ANALYSIS_FAILED, no new run", [postAfter.status, postAfter.body.code, await runsOf() - before], [503, "ANALYSIS_FAILED", 0]);
    check("a teacher may not force a retry", (await teacherA.post(`/insights/analysis-runs/${lastId}/retry`)).status, 403);
    runs.configure({ fault: null });
    const rt = await head.post(`/insights/analysis-runs/${lastId}/retry`);
    check("the head's explicit retry starts attempt 3", [[200, 202].includes(rt.status), rt.body.data.run.attempt, rt.body.data.run.trigger], [true, 3, "retry"]);
    await runs.idle();
    check("…and the scope is served", (await head.get("/insights/review-cases")).status, 200);
    check("retrying a run that did not fail → 409", (await head.post(`/insights/analysis-runs/${rt.body.data.run.runId}/retry`)).status, 409);

    await bump(20);
    runs.configure({ fault: "throw", retryBackoffMs: 60_000 });
    await head.get("/insights/review-cases");
    const nb = await runsOf();
    const soon = await head.get("/insights/review-cases");
    check("an engine failure is not retried inside its back-off", [soon.status, await runsOf() - nb], [503, 0]);
    runs.configure({ fault: null, retryBackoffMs: 0 });

    const failsWith = async (label, fault, code, cfg = {}) => {
      await bump(Math.random() * 10);
      runs.configure({ fault, ...cfg });
      const r = await head.get("/insights/review-cases");
      const f = await Run.findOne({ schoolId: A, scopeKey: "school" }).sort({ createdAt: -1 }).lean();
      check(`${label} → run failed ${code}`, [r.status, f.status, f.error?.code, f.activeKey], [503, "failed", code, null]);
      runs.configure({ fault: null, ...base });
    };
    await failsWith("a worker that exits", "exit", "WORKER_EXITED");
    await failsWith("a worker past its time limit", "hang", "TIMEOUT", { timeoutMs: 1500 });
    await failsWith("a worker past its heap cap", "oom", "WORKER_OUT_OF_MEMORY", { heapMb: 48 });
    check("the server survived the out-of-memory worker and still answers", (await head.get("/insights/review-cases")).status, 200);
    await failsWith("a report over the size limit", null, "REPORT_TOO_LARGE", { maxReportBytes: 100 });
    const big = await Run.findOne({ schoolId: A, scopeKey: "school" }).sort({ createdAt: -1 }).lean();
    check("…which is not retryable automatically", big.error.retryable, false);
    const n = await runsOf();
    runs.configure({ maxReportBytes: 100 });
    await head.get("/insights/review-cases");
    check("…so a second request does not start another run", await runsOf() - n, 0);
    runs.configure(base);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("8. the event loop and the pending answer");
  {
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 90 } });
    runs.configure({ fault: "hang", timeoutMs: 12_000, waitMs: 1500 });
    let maxLag = 0, last = Date.now();
    const t = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - 20); last = now; }, 20);
    const p = await head.get("/insights/review-cases");
    clearInterval(t);
    check("a worker spinning at 100% CPU does not stall the server's timers (max lag < 150 ms)", maxLag < 150, true);
    console.log(`       (max timer lag during the run: ${maxLag} ms)`);
    check("past the wait: 202 ANALYSIS_PENDING, success:false, Retry-After",
      [p.status, p.body.success, p.body.code, p.retryAfter], [202, false, "ANALYSIS_PENDING", "5"]);
    check("…with the run id, its status and where to poll it",
      [typeof p.body.data.runId, ["queued", "running"].includes(p.body.data.status), p.body.data.statusUrl], ["string", true, `/api/insights/analysis-runs/${p.body.data.runId}`]);
    check("…and no report in the body", "cases" in (p.body.data ?? {}), false);
    const st = await head.get(p.body.data.statusUrl.replace("/api", ""));
    check("the status URL answers for the head", [st.status, st.body.data.runId, st.body.data.status], [200, p.body.data.runId, "running"]);
    check("a status never carries the report", ["report", "reportDigest"].some((k) => k in st.body.data), false);

    // The pilot: a transition that needs the analysis records nothing.
    const opened = await head.post("/insights/pilot", { kind: "development" });
    const pilotId = opened.body.data.pilotRunId;
    const act = await head.patch(`/insights/pilot/${pilotId}`, { to: "ACTIVE", version: opened.body.data.version });
    const rev = await head.patch(`/insights/pilot/${pilotId}`, { to: "REVIEWING", version: act.body.data.version });
    const ver = rev.body.data.version;
    const tr = await head.patch(`/insights/pilot/${pilotId}`, { to: "ANALYSIS_READY", version: ver });
    const after = await M("IntelligencePilot").findById(pilotId).lean();
    check("a transition needing the pending analysis → 409 ANALYSIS_PENDING", [tr.status, tr.body.code, tr.body.success], [409, "ANALYSIS_PENDING", false]);
    check("…and nothing was recorded: status, version, evidence unchanged", [after.status, after.version, after.evidence], ["REVIEWING", ver, null]);
    const ev = await head.get("/insights/pilot/evidence");
    check("the pilot's evidence read → 202 while pending", [ev.status, ev.body.code], [202, "ANALYSIS_PENDING"]);
    // A failed analysis: the transition is refused with 503 and records nothing either.
    await runs.idle();
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 90.5 } });
    runs.configure({ fault: "throw", timeoutMs: 60_000, waitMs: 30_000 });
    const trf = await head.patch(`/insights/pilot/${pilotId}`, { to: "ANALYSIS_READY", version: ver });
    const afterF = await M("IntelligencePilot").findById(pilotId).lean();
    check("a transition whose analysis failed → 503 ANALYSIS_FAILED", [trf.status, trf.body.code, trf.body.success], [503, "ANALYSIS_FAILED", false]);
    check("…and nothing was recorded", [afterF.status, afterF.version, afterF.evidence, afterF.transitions.length], ["REVIEWING", ver, null, after.transitions.length]);
    runs.configure({ fault: "hang", timeoutMs: 12_000, waitMs: 1500 });
    const real = await head.post("/insights/pilot", { kind: "real" });
    check("opening a pilot while one is open is still refused first", real.status, 409);

    await runs.idle();
    runs.configure(base);
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 91 } });
    const again = await head.patch(`/insights/pilot/${pilotId}`, { to: "ANALYSIS_READY", version: ver });
    check("the same request repeated once the analysis is current is processed normally (no reviews → EVIDENCE_REQUIRED)",
      [again.status, again.body.code], [409, "EVIDENCE_REQUIRED"]);
    await head.patch(`/insights/pilot/${pilotId}`, { to: "CLOSED", version: ver });
    await M("IntelligencePilot").updateOne({ _id: pilotId }, { $set: { isOpen: false, status: "CLOSED" } });

    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 92 } });
    runs.configure({ fault: "hang", timeoutMs: 3000, waitMs: 200 });
    const before = await M("IntelligencePilot").countDocuments({ schoolId: A });
    const realPending = await head.post("/insights/pilot", { kind: "real" });
    check("opening a real pilot while its preflight's analysis is pending → 409 ANALYSIS_PENDING, no pilot created",
      [realPending.status, realPending.body.code, await M("IntelligencePilot").countDocuments({ schoolId: A }) - before], [409, "ANALYSIS_PENDING", 0]);
    await runs.idle();
    runs.configure(base);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("8b. a stored report that does not match its digest");
  {
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 94 } });
    check("served", (await head.get("/insights/review-cases")).status, 200);
    const good = await Run.findOne({ schoolId: A, scopeKey: "school", status: "succeeded", reportPrunedAt: null }).sort({ createdAt: -1 }).lean();
    await Run.updateOne({ _id: good._id }, { $set: { reportDigest: "0".repeat(64) } });
    const fresh = runs.createAnalysisRuns({ instanceId: "fresh-cache", ...base });  // no parsed copy in memory
    const n = await runsOf();
    const got = await fresh.reportFor(SCHOOL, null, { waitMs: 30_000 });
    check("an unreadable report is not served and the evidence is analysed again", [typeof got.report.reviewCases, await runsOf() - n], ["object", 1]);
    const after = await Run.findById(good._id).lean();
    check("…the unreadable run's bytes are released, the run kept", [Boolean(after.reportPrunedAt), after.status], [true, "succeeded"]);
    await fresh.idle();
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("9. who may start and read a run");
  {
    await sleep(3);
    await M("ResultSummary").updateOne({ _id: "s1" }, { $set: { percentage: 93 } });
    check("the bursar may not read the queue", (await bursar.get("/insights/review-cases")).status, 403);
    check("the bursar may not start a run", (await bursar.post("/insights/analysis-runs")).status, 403);
    check("a pupil may not start a run", (await pupilA1.post("/insights/analysis-runs")).status, 403);
    check("a pupil may not read runs", (await pupilA1.get("/insights/analysis-runs/latest")).status, 403);
    check("an operator with no school selected → 400 (start)", (await operator.post("/insights/analysis-runs")).status, 400);
    check("an operator with no school selected → 400 (latest)", (await operator.get("/insights/analysis-runs/latest")).status, 400);

    const started = await head.post("/insights/analysis-runs");
    check("the head starts the school's run (202, or 200 if current)", [200, 202].includes(started.status), true);
    await runs.idle();
    const id = started.body.data.run.runId;
    const ok = await head.get(`/insights/analysis-runs/${id}`);
    check("the head reads it", [ok.status, ok.body.data.status, ok.body.data.scope.classIds], [200, "succeeded", null]);
    check("…as codes, counts and times: no name anywhere", /Pupil|ENR-/.test(JSON.stringify(ok.body)), false);
    const lt = await head.get("/insights/analysis-runs/latest");
    check("latest: the same run, current", [lt.body.data.run.runId, lt.body.data.current], [id, true]);
    const again = await head.post("/insights/analysis-runs");
    check("starting again over the same evidence → 200, the same run, nothing new", [again.status, again.body.data.run.runId, again.body.data.current], [200, id, true]);

    check("another school's head → 404 (existence not disclosed)", (await headB.get(`/insights/analysis-runs/${id}`)).status, 404);
    check("another school's head naming this school → 403", (await headB.get(`/insights/analysis-runs/${id}?schoolId=${A}`)).status, 403);
    check("the operator, for this school → 200", (await operator.get(`/insights/analysis-runs/${id}?schoolId=${A}`)).status, 200);
    check("the operator, for another school → 404", (await operator.get(`/insights/analysis-runs/${id}?schoolId=${B}`)).status, 404);
    check("the operator without a school → 400, never every school", (await operator.get(`/insights/analysis-runs/${id}`)).status, 400);
    const opStart = await operator.post("/insights/analysis-runs", { schoolId: A });
    check("an operator naming the school in the body gets a status URL that names it",
      opStart.body.data?.statusUrl, `/api/insights/analysis-runs/${opStart.body.data?.run?.runId}?schoolId=${A}`);
    check("…and that URL answers", (await operator.get(opStart.body.data.statusUrl.replace("/api", ""))).status, 200);

    check("a teacher may not read the whole-school run", (await teacherA.get(`/insights/analysis-runs/${id}`)).status, 404);
    const tStart = await teacherA.post("/insights/analysis-runs");
    await runs.idle();
    const tId = tStart.body.data.run.runId;
    check("a teacher's run is scoped to the classes they teach", tStart.body.data.run.scope.classIds, ["form3a"]);
    check("the teacher reads their own run", (await teacherA.get(`/insights/analysis-runs/${tId}`)).status, 200);
    check("another teacher of other classes → 404", (await teacherC.get(`/insights/analysis-runs/${tId}`)).status, 404);
    check("the head reads a teacher's class run", (await head.get(`/insights/analysis-runs/${tId}`)).status, 200);
    check("a teacher naming a class they do not teach → 403", (await teacherA.post("/insights/analysis-runs?classId=form4b")).status, 403);
    check("the teacher's queue is scoped and served", ((await teacherA.get("/insights/review-cases")).body.data?.scope?.classIds ?? null), ["form3a"]);
    await M("TeacherAssignment").updateMany({ teacher: "teach-a" }, { $set: { isActive: false } });
    check("authorisation is re-checked: a teacher who lost the class loses the run", (await teacherA.get(`/insights/analysis-runs/${tId}`)).status, 404);
    await M("TeacherAssignment").updateMany({ teacher: "teach-a" }, { $set: { isActive: true } });
    check("an unknown run → 404", (await head.get("/insights/analysis-runs/no-such-run")).status, 404);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("10. what is stored");
  {
    const all = await Run.find({ schoolId: A }).select("+report").lean();
    const live = all.filter((r) => r.report);
    const text = live.map((r) => zlib.gunzipSync(r.report.buffer).toString("utf8")).join("\n");
    check("no stored report holds a pupil name, an enrollment number or a reviewer", /Pupil A|ENR-|Teacher A|Head Alpha/.test(text), false);
    check("at most one live report per scope (older bytes released)",
      Object.values(live.reduce((m, r) => { m[r.scopeKey] = (m[r.scopeKey] ?? 0) + 1; return m; }, {})).every((n) => n === 1), true);
    check("no run left active", await Run.countDocuments({ status: { $in: ["queued", "running"] } }), 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("11. the code digest covers every file the analysis loads");
  {
    const fs = require("fs");
    const os = require("os");
    const { Worker } = require("worker_threads");
    const { execFile } = require("child_process");
    const PROJECT = path.join(ROOT, "..");
    const rel = (f, root = PROJECT) => path.relative(root, f).split(path.sep).join("/");
    const inProject = (k) => k.startsWith(PROJECT + path.sep) && !k.split(path.sep).includes("node_modules");
    const { codeFiles, codeDigestOf, codeDigest } = runs._internals;
    const WORKER = require.resolve(path.join(SRC, "services/intelligence/analysisWorker"));

    // The worker, run unchanged, its one message wrapped to carry its require.cache.
    const docs = await loadEvidence(SCHOOL);
    const wrapper = `
      const wt = require("worker_threads");
      const post = wt.parentPort.postMessage.bind(wt.parentPort);
      wt.parentPort.postMessage = (m) => post({ ok: m.ok, loaded: Object.keys(require.cache) });
      require(${JSON.stringify(WORKER)});`;
    const msg = await new Promise((resolve, reject) => {
      const w = new Worker(wrapper, { eval: true, workerData: { docs, provenance: { ...PROVENANCE }, fault: null } });
      w.once("message", resolve); w.once("error", reject);
    });
    const loaded = msg.loaded.filter(inProject).map((f) => rel(f)).sort();
    const covered = typeof codeFiles === "function" ? codeFiles().map((f) => rel(f)) : [];
    check("the worker ran and reported what it loaded", [msg.ok, loaded.includes("backend/scripts/calibration/analyseCohort.js")], [true, true]);
    check("every project file the worker loads is in the digest's file set", loaded.filter((f) => !covered.includes(f)), []);
    check("…including shared/caAssessment.js and shared/gradeScale.js, which the hand-kept list missed",
      ["shared/caAssessment.js", "shared/gradeScale.js"].map((f) => covered.includes(f)), [true, true]);

    // A temporary copy of the project, never the working tree.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osa-digest-"));
    const copy = (sub) => fs.cpSync(path.join(PROJECT, sub), path.join(tmp, sub),
      { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") });
    copy("shared"); copy("backend");
    fs.symlinkSync(path.join(PROJECT, "backend", "node_modules"), path.join(tmp, "backend", "node_modules"), "dir");
    const d0 = codeDigestOf(tmp);
    check("the copy's digest is the working tree's (same content, any location)", d0, codeDigest());
    const touch = (f) => { const p = path.join(tmp, f); const orig = fs.readFileSync(p); fs.appendFileSync(p, "\n// changed\n"); return () => fs.writeFileSync(p, orig); };
    for (const f of ["shared/caAssessment.js", "shared/gradeScale.js", "shared/intelligence/subjectInsights.js",
                     "backend/scripts/calibration/cohortSchema.js", "backend/src/services/intelligence/analysisWorker.js"]) {
      const undo = touch(f);
      check(`changing ${f} changes the digest`, codeDigestOf(tmp) !== d0, true);
      undo();
    }
    // Not loaded by the analysis (A1: the worker never requires them), so not
    // covered: a change there is not a change of the analysis code.
    for (const f of ["shared/strengths/learningIntegration.js", "shared/academicRules.js"]) {
      const undo = touch(f);
      check(`${f} is not loaded by the worker and does not move the digest`, [loaded.includes(f), codeDigestOf(tmp) === d0], [false, true]);
      undo();
    }
    check("restored copy, same digest again", codeDigestOf(tmp), d0);

    // The Docker image's layout (Dockerfile): backend/src at /app/src, the
    // calibration scripts at /app/scripts/calibration, shared at /shared, so
    // the project root is /. The module is loaded from the copy, as the image
    // loads it, and must cover the same files under their image paths.
    const img = fs.mkdtempSync(path.join(os.tmpdir(), "osa-image-"));
    const cp = (from, to) => fs.cpSync(path.join(PROJECT, from), path.join(img, to),
      { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") });
    cp("backend/src", "app/src"); cp("backend/scripts/calibration", "app/scripts/calibration"); cp("shared", "shared");
    fs.symlinkSync(path.join(PROJECT, "backend", "node_modules"), path.join(img, "app", "node_modules"), "dir");
    const imageFiles = await new Promise((resolve) => execFile(process.execPath, ["-e",
      `const m = require(${JSON.stringify(path.join(img, "app/src/services/intelligence/analysisCode.js"))});` +
      `process.stdout.write(JSON.stringify(m.codeFiles().map((f) => require("path").relative(m.PROJECT, f).split(require("path").sep).join("/"))))`],
      { env: { ...process.env, MONGODB_URI: "" } }, (err, out, errOut) => resolve(err ? `failed: ${String(errOut || err.message).split("\n").find((l) => /Error/.test(l))}` : JSON.parse(out))));
    const asImage = (f) => f.replace(/^backend\/src\//, "app/src/").replace(/^backend\/scripts\//, "app/scripts/");
    check("in the image's layout the digest covers the same files, under their image paths",
      imageFiles, covered.map(asImage).sort((a, b) => (a < b ? -1 : 1)));
    fs.rmSync(img, { recursive: true, force: true });
    const { isUnder } = require(path.join(SRC, "services/intelligence/analysisCode"));
    check("a file under the filesystem root counts as inside it (the image's root is /)",
      [isUnder("/", "/shared/gradeScale.js"), isUnder("/app", "/app/src/x.js"), isUnder("/app", "/application/x.js")], [true, true, false]);

    // Two processes on the same code agree.
    const childDigest = (backendDir) => new Promise((resolve, reject) => execFile(process.execPath, ["-e",
      `process.stdout.write(require(${JSON.stringify(path.join(backendDir, "src/services/intelligence/analysisRuns.service"))})._internals.codeDigest())`],
      { env: { ...process.env, MONGODB_URI: "" } }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out.trim()))));
    const [p1, p2] = await Promise.all([childDigest(path.join(PROJECT, "backend")), childDigest(path.join(PROJECT, "backend"))]);
    check("the digest is the same in two processes on the same code", [p1 === p2, p1 === codeDigest()], [true, true]);

    // A deploy that changes covered code: the stored report is not served; a new run starts.
    await runs.reportFor(SCHOOL);
    const servedBefore = (await runs.ensure(SCHOOL)).current;
    const undo = touch("shared/caAssessment.js");
    const child = await new Promise((resolve, reject) => execFile(process.execPath, ["-e", `
      const path = require("path");
      const mongoose = require(require.resolve("mongoose", { paths: [${JSON.stringify(path.join(tmp, "backend"))}] }));
      (async () => {
        await mongoose.connect(${JSON.stringify(mongo.getUri())});
        require(${JSON.stringify(path.join(tmp, "backend/src/db/models"))});
        const runs = require(${JSON.stringify(path.join(tmp, "backend/src/services/intelligence/analysisRuns.service"))});
        runs.configure({ waitMs: 30000, retryBackoffMs: 0, timeoutMs: 60000, heapMb: 512, fault: null, pollMs: 50, maxReportBytes: 12 * 1024 * 1024 });
        const { run } = await runs.reportFor({ schoolId: ${JSON.stringify(A)}, classIds: null });
        process.stdout.write(JSON.stringify({ runId: String(run._id), codeDigest: run.codeDigest, digestHere: runs._internals.codeDigest() }));
        await runs.idle?.();
        await mongoose.disconnect();
      })().catch((e) => { console.error(e); process.exit(1); });`],
      { env: { ...process.env, MONGODB_URI: "", NODE_ENV: "test" }, cwd: path.join(tmp, "backend") },
      (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(JSON.parse(out)))));
    undo();
    check("after the change, the report stored under the old digest is not served: a new run, under the new digest",
      [child.runId !== String(servedBefore._id), child.codeDigest === child.digestHere, child.codeDigest !== servedBefore.codeDigest],
      [true, true, true]);
    check("…and that new run is a fresh analysis, held under its own fingerprint",
      (await Run.findById(child.runId).lean())?.fingerprint !== servedBefore.fingerprint, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
