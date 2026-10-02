// backend/scripts/perf-scalability.js
"use strict";

/**
 * How the heavy paths grow with the school.
 *
 * Seeds a synthetic school of S pupils (40 to a class, M subjects a class, A
 * published sequences across two terms, one more sequence marked but not yet
 * processed) into a fresh in-memory MongoDB, mounts the real routers, and
 * times each heavy path at that size: class and school intelligence, the
 * review queue cold and warm, calibration and preflight, a pupil's summary,
 * result processing, rankings and statistics, term computation for the
 * school, report cards, both sync architectures and the big lists. Each
 * timing comes with the number of database commands the request issued and
 * the peak heap growth during it, so a ratio between two sizes can be read
 * beside the shape of the work rather than guessed from the clock alone.
 *
 * Nothing here touches a real database; the server is in-memory and gone
 * when the process exits. The numbers are one machine's and the shape (the
 * ratio between sizes, the query count) is the finding; the absolute
 * milliseconds are not.
 *
 *   node --expose-gc scripts/perf-scalability.js
 *   SCALE_SIZES=100,300,600,1200,2500,5000 SCALE_SUBJECTS=12 SCALE_SEQ=4 \
 *     node --expose-gc scripts/perf-scalability.js
 *   SCALE_JSON=path.json  writes the measurements as JSON beside the table
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

const SIZES    = (process.env.SCALE_SIZES || "100,300,600,1200,2500,5000").split(",").map((x) => Number(x.trim())).filter(Boolean);
const SUBJECTS = Number(process.env.SCALE_SUBJECTS || 12);
const SEQ      = Number(process.env.SCALE_SEQ || 4);          // published sequences
const PER_CLASS = 40;
const REPEATS  = Number(process.env.SCALE_REPEATS || 5);
const YEAR     = "2026-2027";
const A        = "68c0000000000000000000a1";

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const mb  = (b) => (b / 1048576).toFixed(1);

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "perf-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const out = [];
  // Models and routers are loaded once; each size gets a fresh database behind
  // the same mongoose instance. The review queue's memo is keyed by a digest
  // of the cohort, so a new school is a miss, as it would be in production.
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const routers = [["students", "students.routes"], ["admin", "admin.routes"], ["teacher", "teacher.routes"], ["exams", "exam.routes"], ["results", "results.routes"],
    ["term-results", "termResults.routes"], ["annual-results", "annualResults.routes"], ["insights", "insights.routes"], ["sync", "sync.routes"]]
    .map(([p, r]) => [p, require(path.join(SRC, "routes", r))]);

  for (const S of SIZES) {
    const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
    await mongoose.connect(mongo.getUri(), { monitorCommands: true });
    await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
    const raw = (n) => mongoose.connection.collection(mongoose.model(n).collection.name);
    const now = new Date();
    const stamp = (d) => ({ ...d, deletedAt: null, createdAt: now, updatedAt: now });
    const bulk = async (n, docs) => { for (let i = 0; i < docs.length; i += 5000) await raw(n).insertMany(docs.slice(i, i + 5000).map(stamp), { ordered: false }); };

    // ── The school ─────────────────────────────────────────────────────────
    const C = Math.ceil(S / PER_CLASS);
    await M("School").create({ _id: A, name: "Scale Academy", code: "SCALE", email: "scale@example.test" });
    await M("GradingConfig").create({ schoolId: A, passMark: 10 });
    await M("AcademicStructure").create({
      schoolId: A, academicYear: YEAR,
      terms: [1, 2, 3].map((t) => ({ number: t, name: `Term ${t}`, weight: 33, sequences: [1, 2].map((q) => ({ number: q, name: `Sequence ${(t - 1) * 2 + q}`, weight: 50, assessment: { type: "test" } })) })),
      annualAverageMethod: "terms", promotionExams: [], promotionThreshold: 10, passMark: 10, maxAbsences: null,
    });
    const users = [{ _id: "admin-a", name: "Admin", email: "admin-a@example.test", password: "x", role: "school_admin", schoolId: A, isActive: true }];
    const classes = [], subjects = [], assignments = [], students = [];
    for (let c = 0; c < C; c++) {
      const cid = `cls-${c}`, tid = `tea-${c}`;
      classes.push({ _id: cid, schoolId: A, name: `Form ${1 + (c % 7)}${String.fromCharCode(65 + Math.floor(c / 7) % 26)}${Math.floor(c / 182) || ""}` });
      users.push({ _id: tid, name: `Teacher ${c}`, email: `${tid}@example.test`, password: "x", role: "teacher", schoolId: A, isActive: true });
      for (let m = 0; m < SUBJECTS; m++) {
        subjects.push({ _id: `sub-${c}-${m}`, schoolId: A, name: `Subject ${m}`, code: `S${m}`, classId: cid });
        assignments.push({ schoolId: A, teacher: tid, class: cid, subject: `sub-${c}-${m}`, isActive: true });
      }
      for (let s = 0; s < PER_CLASS && c * PER_CLASS + s < S; s++) {
        const n = c * PER_CLASS + s;
        students.push({ _id: `st-${n}`, userId: `u-st-${n}`, schoolId: A, classId: cid, studentName: `Pupil ${n}`, firstName: "Pupil", lastName: String(n),
          enrollmentNo: `SC-${String(n).padStart(5, "0")}`, isActive: true, status: "approved" });
      }
    }
    await bulk("User", users); await bulk("Class", classes); await bulk("Subject", subjects);
    await bulk("TeacherAssignment", assignments); await bulk("Student", students);

    // A published sequences, then one marked-but-unprocessed sequence.
    const exams = [];
    for (let q = 0; q < SEQ; q++) exams.push({ _id: `ex-${q}`, schoolId: A, name: `Sequence ${q + 1}`, type: "test", academicYear: YEAR, term: 1 + Math.floor(q / 2), sequenceNumber: 1 + (q % 2),
      startDate: new Date(Date.UTC(2026, 9 + q, 5)).toISOString().slice(0, 10), status: "published", resultsPublished: true, classIds: classes.map((c) => c._id), totalMarks: 20, passMark: 10 });
    exams.push({ _id: "ex-next", schoolId: A, name: `Sequence ${SEQ + 1}`, type: "test", academicYear: YEAR, term: 1 + Math.floor(SEQ / 2), sequenceNumber: 1 + (SEQ % 2),
      startDate: "2027-03-05", status: "ongoing", classIds: classes.map((c) => c._id), totalMarks: 20, passMark: 10 });
    await bulk("Exam", exams);
    const mark = (n, m, q) => 4 + ((n * 7 + m * 3 + q * 5) % 16);
    const examSubjects = [], scores = [], summaries = [];
    for (const ex of exams) for (let c = 0; c < C; c++) for (let m = 0; m < SUBJECTS; m++) {
      examSubjects.push({ _id: `es-${ex._id}-${c}-${m}`, examId: ex._id, subjectId: `sub-${c}-${m}`, classId: `cls-${c}`, schoolId: A, subjectName: `Subject ${m}`, maxScore: 20, weight: 100 });
    }
    for (const ex of exams) {
      const q = ex._id === "ex-next" ? SEQ : Number(ex._id.slice(3));
      for (const st of students) {
        const n = Number(st._id.slice(3)), c = Math.floor(n / PER_CLASS);
        const rows = [];
        for (let m = 0; m < SUBJECTS; m++) {
          const v = mark(n, m, q);
          scores.push({ _id: `sc-${ex._id}-${n}-${m}`, examId: ex._id, examSubjectId: `es-${ex._id}-${c}-${m}`, studentId: st._id, subjectId: `sub-${c}-${m}`, classId: `cls-${c}`, schoolId: A, score: v, maxScore: 20, percentage: v * 5, grade: v >= 10 ? "C" : "F", isPassing: v >= 10 });
          rows.push({ subjectId: `sub-${c}-${m}`, subjectName: `Subject ${m}`, normalizedMark: v, score: v, maxScore: 20, coefficient: 1, grade: v >= 10 ? "C" : "F", points: 0, remark: null, isPassing: v >= 10, isAbsent: false, isExempt: false });
        }
        if (ex._id !== "ex-next") {
          const avg = rows.reduce((s, r) => s + r.normalizedMark, 0) / rows.length;
          summaries.push({ _id: `sum-${ex._id}-${n}`, examId: ex._id, studentId: st._id, classId: `cls-${c}`, schoolId: A, academicYear: YEAR, term: String(ex.term),
            average: avg, percentage: avg * 5, isPassing: avg >= 10, subjectsFailed: rows.filter((r) => !r.isPassing).length,
            classPosition: 1 + (n % PER_CLASS), schoolPosition: 1 + n, totalInClass: PER_CLASS, isPublished: true, subjectBreakdown: rows,
            studentName: st.studentName, admissionNo: st.enrollmentNo, className: classes[c].name });
        }
      }
    }
    await bulk("ExamSubject", examSubjects); await bulk("StudentScore", scores); await bulk("ResultSummary", summaries);
    const docs = { students: S, classes: C, subjects: subjects.length, scores: scores.length, summaries: summaries.length };

    // ── The routers ────────────────────────────────────────────────────────
    const app  = express();
    app.use(express.json({ limit: "20mb" }));
    for (const [p, r] of routers) app.use(`/api/${p}`, auth.authenticate, r);
    app.use((err, _req, res, _next) => { if (process.env.SCALE_DEBUG) console.error("   route error:", err.stack); res.status(err.statusCode || 500).json({ success: false, message: err.message }); });
    const server = app.listen(0);
    const API = `http://127.0.0.1:${server.address().port}/api`;
    const sign = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "2h" });
    const ADMIN = sign("admin-a", "school_admin"), TEACHER = sign("tea-0", "teacher");

    // ── Instrumentation ────────────────────────────────────────────────────
    let cmds = 0;
    const onStart = (e) => { if (!["ping", "endSessions", "killCursors"].includes(e.commandName)) cmds++; };
    mongoose.connection.client.on("commandStarted", onStart);
    const agent = new (require("http").Agent)({ keepAlive: false });
    const call = async ({ method = "GET", url, token, body }) => {
      const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}), agent });
      const text = await res.text();
      return { status: res.status, bytes: text.length, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    };
    const measure = async (name, req, { n = REPEATS, count = null, warm = true } = {}) => {
      const lat = [], qs = []; let peak = 0, status = 0, bytes = 0, returned = null;
      // One unmeasured call first, so the JIT and the connection pool are not
      // charged to the smallest school; the review queue's "cold" row opts out.
      if (warm && n > 1) await call(req);
      for (let i = 0; i < n; i++) {
        if (global.gc) global.gc();
        const base = process.memoryUsage().heapUsed; let top = base;
        const tick = setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > top) top = h; }, 5);
        cmds = 0; const t0 = process.hrtime.bigint();
        const r = await call(req);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        clearInterval(tick);
        lat.push(ms); qs.push(cmds); peak = Math.max(peak, top - base); status = r.status; bytes = r.bytes;
        if (r.status >= 400 && i === 0) console.log(`         ! ${JSON.stringify(r.body ?? "").slice(0, 240)}`);
        if (count) { try { returned = count(r.body); } catch { returned = null; } }
      }
      lat.sort((a, b) => a - b);
      const row = { size: S, name, status, p50: pct(lat, 50), p95: pct(lat, 95), first: lat.length > 1 ? null : lat[0], queries: Math.max(...qs), peakHeapMB: Number(mb(peak)), bytes, returned };
      out.push(row);
      console.log(`  ${String(S).padStart(5)}  ${name.padEnd(52)} ${String(status).padStart(3)}  p50 ${row.p50.toFixed(0).padStart(7)} ms  p95 ${row.p95.toFixed(0).padStart(7)} ms  q ${String(row.queries).padStart(5)}  heap+${String(row.peakHeapMB).padStart(6)} MB  ${String(bytes).padStart(9)} B${returned !== null && returned !== undefined ? `  n=${returned}` : ""}`);
      return row;
    };
    const once = (name, req, opts) => measure(name, req, { n: 1, warm: false, ...opts });
    const explain = async (label, model, filter, sort = null) => {
      let q = M(model).find(filter); if (sort) q = q.sort(sort);
      const x = await q.explain("executionStats"); const es = x.executionStats ?? x;
      const stage = JSON.stringify(x.queryPlanner?.winningPlan ?? "").includes("COLLSCAN") ? "COLLSCAN" : "IXSCAN";
      const row = { size: S, name: `explain ${label}`, stage, ms: es.executionTimeMillis, examined: es.totalDocsExamined, keys: es.totalKeysExamined, returned: es.nReturned };
      out.push(row);
      console.log(`  ${String(S).padStart(5)}  explain ${label.padEnd(44)} ${stage.padEnd(8)} ${String(es.executionTimeMillis).padStart(6)} ms  docs ${String(es.totalDocsExamined).padStart(7)}  keys ${String(es.totalKeysExamined).padStart(7)}  n ${es.nReturned}`);
    };

    console.log(`\n=== ${S} pupils: ${C} classes × ${SUBJECTS} subjects × ${SEQ} published sequences → ${docs.scores} marks, ${docs.summaries} summaries ===`);
    const list = (b) => (b?.data ?? b?.results ?? b?.cases ?? b?.data?.cases ?? []).length;

    // intelligence
    await measure("GET insights/class/cls-0 (teacher)", { url: "/insights/class/cls-0", token: TEACHER }, { count: (b) => b?.data?.students?.length });
    await once("GET insights/review-cases (head, cold)", { url: "/insights/review-cases", token: ADMIN }, { count: (b) => b?.data?.totalCases });
    await measure("GET insights/review-cases (head, warm)", { url: "/insights/review-cases", token: ADMIN }, { count: (b) => b?.data?.totalCases });
    await measure("GET insights/review-cases?classId=cls-0 (teacher)", { url: "/insights/review-cases?classId=cls-0", token: TEACHER }, { count: (b) => b?.data?.totalCases });
    await measure("GET insights/calibration-summary (head)", { url: "/insights/calibration-summary", token: ADMIN });
    await measure("GET insights/pilot/preflight (head)", { url: "/insights/pilot/preflight", token: ADMIN });
    await measure("GET insights/student/st-7/intelligence-summary", { url: "/insights/student/st-7/intelligence-summary", token: TEACHER });
    await measure("GET insights/student/st-7/strengths", { url: "/insights/student/st-7/strengths", token: TEACHER });
    await measure("GET insights/student/st-7/guidance", { url: "/insights/student/st-7/guidance", token: TEACHER });
    await measure("GET insights/explorations/summary (head)", { url: "/insights/explorations/summary", token: ADMIN });

    // results
    await once("POST exams/ex-next/process (whole school)", { method: "POST", url: "/exams/ex-next/process", token: ADMIN, body: {} }, { count: (b) => b?.processed ?? b?.data?.processed ?? b?.count });
    await measure("GET results/ex-0?limit=50 (admin)", { url: "/results/ex-0?limit=50", token: ADMIN }, { count: (b) => b?.total });
    await measure("GET results/ex-0/rankings?rankBy=school (teacher)", { url: "/results/ex-0/rankings?rankBy=school&limit=100", token: TEACHER }, { count: (b) => b?.count });
    await measure("GET results/ex-0/stats (teacher)", { url: "/results/ex-0/stats", token: TEACHER }, { count: (b) => b?.data?.totalStudents });
    await measure("GET results/ex-0/student/st-7 (teacher)", { url: "/results/ex-0/student/st-7", token: TEACHER });
    await measure("GET results/ex-0/student/st-7/reportcard/html (admin)", { url: "/results/ex-0/student/st-7/reportcard/html", token: ADMIN });
    await measure("GET exams/ex-0/scores?classId=cls-0 (teacher)", { url: "/exams/ex-0/scores?classId=cls-0", token: TEACHER }, { count: (b) => b?.scores?.length });
    await measure("GET teacher/results (teacher, pair-scoped)", { url: "/teacher/results", token: TEACHER }, { count: (b) => b?.results?.length });
    await once("POST term-results/compute term 1 (whole school)", { method: "POST", url: "/term-results/compute", token: ADMIN, body: { academicYear: YEAR, term: 1 } }, { count: (b) => b?.computed });
    await measure("GET term-results?term=1&limit=50 (admin)", { url: `/term-results?academicYear=${YEAR}&term=1&limit=50`, token: ADMIN }, { count: (b) => b?.total });
    await measure("GET term-results/st-7/report-card (admin)", { url: `/term-results/st-7/report-card?academicYear=${YEAR}&term=1&classId=cls-0`, token: ADMIN });
    await once("POST annual-results/compute (whole school)", { method: "POST", url: "/annual-results/compute", token: ADMIN, body: { academicYear: YEAR } }, { count: (b) => b?.computed });

    // sync
    await once("GET sync/pull (admin, full)", { url: `/sync/pull?schoolId=${A}`, token: ADMIN }, { count: (b) => Object.values(b?.data ?? b ?? {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0) });
    await measure("GET sync/pull (teacher, delta since now)", { url: `/sync/pull?schoolId=${A}&lastSync=${encodeURIComponent(new Date().toISOString())}`, token: TEACHER });
    await once("GET sync/changes studentScore,resultSummary limit=500 (teacher, page 1)", { url: "/sync/changes?collections=studentScore,resultSummary&limit=500", token: TEACHER }, { count: (b) => Object.values(b?.collections ?? {}).reduce((s, c) => s + (c.documents?.length ?? 0), 0) });
    await once("GET sync/changes (teacher, every collection, page 1)", { url: "/sync/changes?limit=500", token: TEACHER }, { count: (b) => Object.values(b?.collections ?? {}).reduce((s, c) => s + (c.documents?.length ?? 0), 0) });

    // lists
    await measure("GET admin/students?limit=50", { url: `/admin/students?schoolId=${A}&limit=50`, token: ADMIN }, { count: list });
    await measure("GET students?search=Pupil 7&limit=50", { url: `/students?search=${encodeURIComponent("Pupil 7")}&limit=50`, token: ADMIN }, { count: list });
    await measure("GET students/teacher/students?classId=cls-0", { url: "/students/teacher/students?classId=cls-0", token: TEACHER }, { count: list });

    // Representative query plans at this size.
    console.log("  -- query plans --");
    await explain("ResultSummary published history (school)", "ResultSummary", { schoolId: A, isPublished: true, deletedAt: null });
    await explain("ResultSummary one pupil", "ResultSummary", { schoolId: A, studentId: "st-7", isPublished: true, deletedAt: null });
    await explain("ResultSummary exam list sorted", "ResultSummary", { examId: "ex-0", schoolId: A, deletedAt: null, isPublished: true }, { classPosition: 1 });
    await explain("StudentScore exam sheet (class)", "StudentScore", { examId: "ex-0", schoolId: A, classId: "cls-0", deletedAt: null });
    await explain("StudentScore one pupil one exam", "StudentScore", { examId: "ex-0", studentId: "st-7", schoolId: A, deletedAt: null });
    await explain("StudentScore feed page (updatedAt keyset)", "StudentScore", { schoolId: A, updatedAt: { $gte: new Date(0) } }, { updatedAt: 1, _id: 1 });
    await explain("ResultSummary feed page published", "ResultSummary", { schoolId: A, isPublished: true, updatedAt: { $gte: new Date(0) } }, { updatedAt: 1, _id: 1 });
    // The idle poll: a cursor at "now", nothing changed. The common case, once a minute per desk.
    const idle = { $or: [{ updatedAt: { $gt: new Date() } }, { updatedAt: new Date(), _id: { $gt: "~" } }] };
    await explain("StudentScore feed page, idle cursor", "StudentScore", { schoolId: A, ...idle }, { updatedAt: 1, _id: 1 });
    await explain("ResultSummary feed page, idle cursor", "ResultSummary", { schoolId: A, isPublished: true, ...idle }, { updatedAt: 1, _id: 1 });
    await explain("Student feed page, idle cursor", "Student", { schoolId: A, ...idle }, { updatedAt: 1, _id: 1 });
    await explain("Student mobile pull, since now", "Student", { schoolId: A, status: "approved", isActive: true, updatedAt: { $gte: new Date() }, deletedAt: null });
    await explain("Student class roster", "Student", { schoolId: A, classId: "cls-0" });
    await explain("Student name search (regex)", "Student", { schoolId: A, studentName: { $regex: "Pupil 7", $options: "i" } });
    await explain("TermResult list sorted", "TermResult", { schoolId: A, academicYear: YEAR, term: 1, deletedAt: null }, { classPosition: 1 });

    mongoose.connection.client.off("commandStarted", onStart);
    server.close(); server.closeAllConnections?.();
    await mongoose.disconnect(); await stopQuietly(mongo);
  }

  if (process.env.SCALE_JSON) fs.writeFileSync(process.env.SCALE_JSON, JSON.stringify(out, null, 2));
  // Ratios between consecutive sizes, per path: the shape of the growth.
  console.log("\n=== growth: p50 ratio between consecutive sizes (size ratio in brackets) ===");
  const names = [...new Set(out.map((r) => r.name))];
  for (const name of names) {
    const rows = SIZES.map((s) => out.find((r) => r.size === s && r.name === name)).filter(Boolean);
    const cells = rows.slice(1).map((r, i) => { const prev = rows[i]; const ratio = prev.p50 > 0 ? (r.p50 / prev.p50).toFixed(2) : "–"; return `${ratio}× [${(r.size / prev.size).toFixed(2)}]`; });
    console.log(`  ${name.padEnd(60)} ${cells.join("   ")}`);
  }
  process.exit(0);
})().catch((err) => { console.error("perf failed:", err); process.exit(1); });
