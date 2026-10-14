// backend/scripts/perf-analysis-runs.js
"use strict";

/**
 * The cold school-wide analysis at size, off the request thread (docs/38).
 *
 * Seeds the same synthetic school as perf-scalability.js — S pupils, 40 to a
 * class, M subjects, A published sequences — limited to the collections the
 * analysis reads, into a fresh in-memory MongoDB, and measures:
 *
 *   fingerprint      the per-request freshness check (docs/37 §15 P2)
 *   cold request     what the head's first review-queue request answers, and when
 *   cold run         the run's own duration, in its worker
 *   event loop       the worst timer lag on the server thread during the run
 *   heap             the server thread's heap growth during the run (the
 *                    worker's own heap is separate and capped)
 *   report           JSON and gzip bytes of the stored report
 *   warm             the queue and the summary once the report is stored:
 *                    first from the store (gunzip + parse), then from memory
 *
 * One machine's numbers. Nothing touches a real database.
 *
 *   node --expose-gc scripts/perf-analysis-runs.js
 *   SCALE_SIZES=1200,5000 node --expose-gc scripts/perf-analysis-runs.js
 *   SCALE_JSON=path.json  writes the measurements as JSON
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

const SIZES     = (process.env.SCALE_SIZES || "1200,5000").split(",").map((x) => Number(x.trim())).filter(Boolean);
const SUBJECTS  = Number(process.env.SCALE_SUBJECTS || 12);
const SEQ       = Number(process.env.SCALE_SEQ || 4);
const PER_CLASS = 40;
const REPEATS   = Number(process.env.SCALE_REPEATS || 5);
const YEAR      = "2026-2027";
const A         = "68c0000000000000000000a1";

const mb = (b) => Number((b / 1048576).toFixed(1));
const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gc = () => { if (global.gc) global.gc(); };

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "perf-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const runs = require(path.join(SRC, "services/intelligence/analysisRuns.service"));
  const insights = require(path.join(SRC, "routes/insights.routes"));
  const out = [];

  for (const S of SIZES) {
    const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
    await mongoose.connect(mongo.getUri());
    await Promise.all(mongoose.modelNames().map((n) => M(n).init()));
    await runs.ensureIndexes();
    const raw = (n) => mongoose.connection.collection(M(n).collection.name);
    const now = new Date();
    const stamp = (d) => ({ ...d, deletedAt: null, createdAt: now, updatedAt: now });
    const bulk = async (n, docs) => { for (let i = 0; i < docs.length; i += 5000) await raw(n).insertMany(docs.slice(i, i + 5000).map(stamp), { ordered: false }); };

    // ── The school (perf-scalability.js's, minus what the analysis never reads) ──
    const C = Math.ceil(S / PER_CLASS);
    await M("School").create({ _id: A, name: "Scale Academy", code: "SCALE", email: "scale@example.test" });
    await M("GradingConfig").create({ schoolId: A, passMark: 10 });
    await M("AcademicStructure").create({
      schoolId: A, academicYear: YEAR,
      terms: [1, 2, 3].map((t) => ({ number: t, name: `Term ${t}`, weight: 33, sequences: [1, 2].map((q) => ({ number: q, name: `Sequence ${(t - 1) * 2 + q}`, weight: 50, assessment: { type: "test" } })) })),
      annualAverageMethod: "terms", promotionExams: [], promotionThreshold: 10, passMark: 10, maxAbsences: null,
    });
    const users = [{ _id: "admin-a", name: "Admin", email: "admin-a@example.test", password: "x", role: "school_admin", schoolId: A, isActive: true }];
    const classes = [], assignments = [], students = [];
    for (let c = 0; c < C; c++) {
      const cid = `cls-${c}`, tid = `tea-${c}`;
      classes.push({ _id: cid, schoolId: A, name: `Form ${c}` });
      users.push({ _id: tid, name: `Teacher ${c}`, email: `${tid}@example.test`, password: "x", role: "teacher", schoolId: A, isActive: true });
      for (let m = 0; m < SUBJECTS; m++) assignments.push({ schoolId: A, teacher: tid, class: cid, subject: `sub-${c}-${m}`, isActive: true });
      for (let s = 0; s < PER_CLASS && c * PER_CLASS + s < S; s++) {
        const n = c * PER_CLASS + s;
        students.push({ _id: `st-${n}`, userId: `u-st-${n}`, schoolId: A, classId: cid, studentName: `Pupil ${n}`, firstName: "Pupil", lastName: String(n),
          enrollmentNo: `SC-${String(n).padStart(5, "0")}`, isActive: true, status: "approved" });
      }
    }
    await bulk("User", users); await bulk("Class", classes); await bulk("TeacherAssignment", assignments); await bulk("Student", students);
    const exams = [];
    for (let q = 0; q < SEQ; q++) exams.push({ _id: `ex-${q}`, schoolId: A, name: `Sequence ${q + 1}`, type: "test", academicYear: YEAR, term: 1 + Math.floor(q / 2), sequenceNumber: 1 + (q % 2),
      startDate: new Date(Date.UTC(2026, 9 + q, 5)).toISOString().slice(0, 10), status: "published", resultsPublished: true, classIds: classes.map((c) => c._id), totalMarks: 20, passMark: 10 });
    await bulk("Exam", exams);
    const mark = (n, m, q) => 4 + ((n * 7 + m * 3 + q * 5) % 16);
    const summaries = [];
    for (const ex of exams) {
      const q = Number(ex._id.slice(3));
      for (const st of students) {
        const n = Number(st._id.slice(3)), c = Math.floor(n / PER_CLASS);
        const rows = [];
        for (let m = 0; m < SUBJECTS; m++) {
          const v = mark(n, m, q);
          rows.push({ subjectId: `sub-${c}-${m}`, subjectName: `Subject ${m}`, normalizedMark: v, score: v, maxScore: 20, coefficient: 1, grade: v >= 10 ? "C" : "F", points: 0, remark: null, isPassing: v >= 10, isAbsent: false, isExempt: false });
        }
        const avg = rows.reduce((s, r) => s + r.normalizedMark, 0) / rows.length;
        summaries.push({ _id: `sum-${ex._id}-${n}`, examId: ex._id, studentId: st._id, classId: `cls-${c}`, schoolId: A, academicYear: YEAR, term: String(ex.term),
          average: avg, percentage: avg * 5, isPassing: avg >= 10, subjectsFailed: rows.filter((r) => !r.isPassing).length, isPublished: true, subjectBreakdown: rows });
      }
    }
    await bulk("ResultSummary", summaries);

    const app = express();
    app.use(express.json());
    app.use("/api/insights", auth.authenticate, insights);
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    const API = `http://127.0.0.1:${server.address().port}/api`;
    const sign = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "2h" });
    const ADMIN = sign("admin-a", "school_admin"), TEACHER = sign("tea-0", "teacher");
    const call = async (url, token) => {
      const t0 = performance.now();
      const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
      const text = await res.text();
      return { ms: performance.now() - t0, status: res.status, bytes: text.length };
    };

    // ── Fingerprint ──────────────────────────────────────────────────────────
    const scope = { schoolId: A, classIds: null };
    await runs.fingerprintOf(scope);
    const fpMs = [];
    for (let i = 0; i < REPEATS; i++) { const t0 = performance.now(); await runs.fingerprintOf(scope); fpMs.push(performance.now() - t0); }

    // ── Cold ─────────────────────────────────────────────────────────────────
    gc();
    const heap0 = process.memoryUsage().heapUsed;
    let heapTop = heap0, maxLag = 0, last = performance.now();
    const sampler = setInterval(() => {
      const t = performance.now(); maxLag = Math.max(maxLag, t - last - 10); last = t;
      const h = process.memoryUsage().heapUsed; if (h > heapTop) heapTop = h;
    }, 10);
    const cold = await call("/insights/review-cases", ADMIN);
    await runs.idle();
    clearInterval(sampler);
    const run = await M("IntelligenceAnalysisRun").findOne({ schoolId: A, scopeKey: "school" }).sort({ createdAt: -1 }).lean();

    // ── Warm ─────────────────────────────────────────────────────────────────
    const fromStore = await call("/insights/review-cases", ADMIN);
    const warm = [], warmHeap = [];
    for (let i = 0; i < REPEATS; i++) {
      gc(); const h0 = process.memoryUsage().heapUsed; let top = h0;
      const s = setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > top) top = h; }, 5);
      warm.push((await call("/insights/review-cases", ADMIN)).ms);
      clearInterval(s); warmHeap.push(top - h0);
    }
    const summary = []; for (let i = 0; i < REPEATS; i++) summary.push((await call("/insights/calibration-summary", ADMIN)).ms);
    const teacherCold = await call("/insights/review-cases?classId=cls-0", TEACHER);
    await runs.idle();
    const teacherWarm = []; for (let i = 0; i < REPEATS; i++) teacherWarm.push((await call("/insights/review-cases?classId=cls-0", TEACHER)).ms);

    const r = {
      size: S, results: summaries.length,
      fingerprintMs: Math.round(p50(fpMs)),
      coldRequest: { status: cold.status, ms: Math.round(cold.ms) },
      coldRun: { status: run.status, durationMs: run.durationMs, cases: run.counts?.cases ?? null },
      eventLoopMaxLagMs: Math.round(maxLag),
      serverHeapGrowthDuringRunMB: mb(heapTop - heap0),
      report: { jsonBytes: run.reportRawBytes, gzipBytes: run.reportBytes, ratio: run.reportRawBytes ? Number((run.reportRawBytes / run.reportBytes).toFixed(1)) : null },
      warmFromStoreMs: Math.round(fromStore.ms),
      warmMemoryP50Ms: Math.round(p50(warm)),
      warmHeapP50MB: mb(p50(warmHeap)),
      summaryP50Ms: Math.round(p50(summary)),
      teacherClass: { coldStatus: teacherCold.status, coldMs: Math.round(teacherCold.ms), warmP50Ms: Math.round(p50(teacherWarm)) },
    };
    out.push(r);
    console.log(JSON.stringify(r));

    server.close(); server.closeAllConnections?.();
    await mongoose.disconnect();
    await stopQuietly(mongo);
  }

  if (process.env.SCALE_JSON) fs.writeFileSync(process.env.SCALE_JSON, JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((err) => { console.error("perf failed:", err); process.exit(1); });
