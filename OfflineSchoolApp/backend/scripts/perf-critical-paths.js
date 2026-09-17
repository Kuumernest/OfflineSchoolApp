// backend/scripts/perf-critical-paths.js
"use strict";

/**
 * How the API behaves under a school's own load, measured rather than assumed.
 *
 * Boots the real routers over an in-memory MongoDB seeded with a school of
 * realistic size — thirty classes, twelve hundred pupils, a term of registers
 * and two marked exams — and fires the requests a school day is made of, a
 * handful at a time, the way a staffroom does. For each path it reports
 * throughput, p50/p95/p99 latency, the error rate and the response size.
 *
 * No thresholds are asserted: the project defines none, and a number chosen
 * here would be a number chosen here. The figures are recorded in
 * docs/22-release-readiness.md and the shape of each — a p99 far from its p50,
 * a body that grows with the school — is what to read. Index usage for the
 * hot queries is asserted separately by check-query-plans.js.
 *
 * Not part of check:all: it takes minutes and measures the machine it runs on.
 *
 *   node scripts/perf-critical-paths.js            # default: 8 concurrent, 120 per path
 *   PERF_CONCURRENCY=16 PERF_N=300 node scripts/perf-critical-paths.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

const CONCURRENCY = Math.max(1, parseInt(process.env.PERF_CONCURRENCY || "8", 10));
const N           = Math.max(10, parseInt(process.env.PERF_N || "120", 10));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

(async () => {
  process.env.JWT_SECRET         = process.env.JWT_SECRET || "perf-only-secret-that-is-long-enough";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "perf-only-refresh-secret-long-enough";
  process.env.NODE_ENV           = "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  // ── The school ───────────────────────────────────────────────────────────
  const A = "68c0000000000000000000a1";
  const YEAR = "2026-2027", PASSWORD = "Perf-only-passw0rd";
  const CLASSES = 30, PER_CLASS = 40, DAYS = 20;
  await M("School").create({ _id: A, name: "Perf Academy", code: "PERF", email: "perf@example.test" });

  const users = [{ _id: "admin-a", name: "Admin", email: "admin-a@example.test", password: PASSWORD, role: "school_admin", schoolId: A, isActive: true }];
  const classes = [], subjects = [], assignments = [], students = [], periods = [];
  for (let c = 0; c < CLASSES; c++) {
    const cid = `cls-${c}`, tid = `tea-${c}`, sid = `sub-${c}`;
    classes.push({ _id: cid, schoolId: A, name: `Form ${1 + (c % 6)}${String.fromCharCode(65 + Math.floor(c / 6))}` });
    subjects.push({ _id: sid, schoolId: A, name: `Subject ${c}`, classId: cid });
    users.push({ _id: tid, name: `Teacher ${c}`, email: `${tid}@example.test`, password: PASSWORD, role: "teacher", schoolId: A, isActive: true });
    assignments.push({ schoolId: A, teacher: tid, class: cid, subject: sid });
    for (let s = 0; s < PER_CLASS; s++) {
      const n = c * PER_CLASS + s;
      students.push({ _id: `st-${n}`, userId: `u-st-${n}`, schoolId: A, classId: cid, studentName: `Pupil ${n}`, firstName: "Pupil", lastName: String(n),
        enrollmentNo: `PERF-${String(n).padStart(4, "0")}`, isActive: true, status: "approved", guardianName: "Parent", guardianPhone: "+237600000000" });
    }
  }
  for (let p = 0; p < 8; p++) periods.push({ _id: `p${p}`, schoolId: A, name: `Period ${p + 1}`, startTime: `${String(7 + p).padStart(2, "0")}:00`, endTime: `${String(8 + p).padStart(2, "0")}:00`, sortOrder: p });

  // bcrypt at cost 12 per user is the slow part of seeding; insert hashed once.
  const bcrypt = require("bcryptjs");
  const hash   = await bcrypt.hash(PASSWORD, 12);
  await M("User").collection.insertMany(users.map((u) => ({ ...u, password: hash, passwordChangedAt: new Date(0), createdAt: new Date(), updatedAt: new Date() })));
  await M("Class").insertMany(classes);
  await M("Subject").insertMany(subjects);
  await M("TeacherAssignment").insertMany(assignments);
  await M("Student").insertMany(students);
  await M("Period").insertMany(periods);

  const exams = [
    { _id: "ex-1", schoolId: A, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 1, status: "published", classIds: classes.map((c) => c._id), totalMarks: 20, passMark: 10, resultsPublished: true },
    { _id: "ex-2", schoolId: A, name: "Sequence 2", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 2, status: "ongoing",   classIds: classes.map((c) => c._id), totalMarks: 20, passMark: 10 },
  ];
  await M("Exam").insertMany(exams);
  const examSubjects = [], scores = [], summaries = [];
  for (const ex of exams) for (let c = 0; c < CLASSES; c++) {
    const esId = `es-${ex._id}-${c}`;
    examSubjects.push({ _id: esId, examId: ex._id, subjectId: `sub-${c}`, classId: `cls-${c}`, schoolId: A, subjectName: `Subject ${c}`, maxScore: 20 });
    for (let s = 0; s < PER_CLASS; s++) {
      const n = c * PER_CLASS + s, mark = 5 + ((n * 7) % 16);
      scores.push({ _id: `sc-${ex._id}-${n}`, examId: ex._id, examSubjectId: esId, studentId: `st-${n}`, subjectId: `sub-${c}`, classId: `cls-${c}`, schoolId: A, score: mark, maxScore: 20, percentage: mark * 5 });
      if (ex._id === "ex-1") summaries.push({ _id: `sum-${n}`, examId: "ex-1", studentId: `st-${n}`, classId: `cls-${c}`, schoolId: A, average: mark, percentage: mark * 5, classPosition: 1 + s, isPublished: true, subjects: [] });
    }
  }
  await M("ExamSubject").insertMany(examSubjects);
  await M("StudentScore").insertMany(scores);
  await M("ResultSummary").insertMany(summaries);

  const registers = [];
  const day = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  for (let d = 0; d < DAYS; d++) for (let c = 0; c < 5; c++) for (let s = 0; s < PER_CLASS; s++) {
    const n = c * PER_CLASS + s;
    registers.push({ schoolId: A, classId: `cls-${c}`, studentId: `st-${n}`, markedBy: `tea-${c}`, date: day(d), status: (n + d) % 9 === 0 ? "absent" : "present", subjectId: null, periodId: null });
  }
  await M("StudentAttendance").insertMany(registers);
  const apps = [];
  for (let i = 0; i < 50; i++) apps.push({ _id: `app-${i}`, schoolId: A, studentName: `Applicant ${i}`, email: `parent${i}@example.test`, guardianName: "P", phone: "+237611111111", classId: "cls-0", status: "pending", documents: [] });
  await M("StudentApplication").insertMany(apps);

  // ── The routers, as server.js mounts them ────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json({ limit: "20mb" }));
  app.use("/api/auth",       require(path.join(SRC, "routes/auth.routes")));
  app.use("/api",            require(path.join(SRC, "routes/public.routes")));
  app.use("/api/students",   auth.authenticate, require(path.join(SRC, "routes/students.routes")));
  app.use("/api/admin",      auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use("/api/teacher",    auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
  app.use("/api/attendance", auth.authenticate, require(path.join(SRC, "routes/attendance.routes")));
  app.use("/api/exams",      auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/results",    auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use("/api/sync",       auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const sign = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const ADMIN = sign("admin-a", "school_admin"), TEACHER = sign("tea-0", "teacher");
  const login = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin-a@example.test", password: PASSWORD }) }).then((r) => r.json());
  const REFRESH = login.refreshToken;

  const today = day(0);
  const paths = [
    { name: "POST /auth/login (bcrypt 12)",                 n: 40, method: "POST", url: "/auth/login", body: { email: "admin-a@example.test", password: PASSWORD } },
    { name: "POST /auth/refresh (refresh token)",           method: "POST", url: "/auth/refresh", body: { refreshToken: REFRESH } },
    { name: "GET  /admin/students?limit=50",                token: ADMIN, url: `/admin/students?schoolId=${A}&limit=50` },
    { name: "GET  /students?search=Pupil 7",                token: ADMIN, url: `/students?search=${encodeURIComponent("Pupil 7")}&limit=50` },
    { name: "GET  /students/:id",                           token: ADMIN, url: "/students/st-77" },
    { name: "GET  /students/teacher/students?classId",      token: TEACHER, url: "/students/teacher/students?classId=cls-0" },
    { name: "GET  /attendance/students/today?classId",      token: TEACHER, url: "/attendance/students/today?classId=cls-0" },
    { name: "POST /attendance/students/bulk (40 pupils)",   token: TEACHER, method: "POST", url: "/attendance/students/bulk",
      body: { classId: "cls-0", date: today, records: Array.from({ length: PER_CLASS }, (_, s) => ({ studentId: `st-${s}`, status: "present" })) } },
    { name: "GET  /attendance/report/class/:classId",       token: TEACHER, url: "/attendance/report/class/cls-0" },
    { name: "GET  /exams/:id/scores?classId",               token: TEACHER, url: "/exams/ex-2/scores?classId=cls-0" },
    { name: "POST /exams/:id/scores/bulk (40 marks)",       token: TEACHER, method: "POST", url: "/exams/ex-2/scores/bulk",
      body: { classId: "cls-0", subjectId: "sub-0", examSubjectId: "es-ex-2-0", scores: Array.from({ length: PER_CLASS }, (_, s) => ({ studentId: `st-${s}`, score: 12 })) } },
    { name: "GET  /results/:examId (published)",            token: TEACHER, url: "/results/ex-1" },
    { name: "GET  /results/:examId/rankings",               token: TEACHER, url: "/results/ex-1/rankings?classId=cls-0" },
    { name: "GET  /results/:examId/student/:id/reportcard", token: ADMIN,   url: "/results/ex-1/student/st-5/reportcard" },
    { name: "GET  /exams/dashboard",                        token: ADMIN,   url: "/exams/dashboard" },
    { name: "GET  /students/pending (50 applications)",     token: ADMIN,   url: "/students/pending" },
    { name: "GET  /teacher/stats/summary",                  token: TEACHER, url: "/teacher/stats/summary" },
    { name: "GET  /sync/changes (student, first page)",     token: TEACHER, url: "/sync/changes?collections=student&limit=200" },
    { name: "GET  /sync/changes (studentScore, 500)",       token: TEACHER, url: "/sync/changes?collections=studentScore&limit=500" },
    { name: "GET  /admin/stats",                            token: ADMIN,   url: `/admin/stats?schoolId=${A}` },
  ];

  const fire = async (p) => {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${API}${p.url}`, {
      method: p.method || "GET",
      headers: { "Content-Type": "application/json", ...(p.token ? { Authorization: `Bearer ${p.token}` } : {}) },
      ...(p.body ? { body: JSON.stringify(p.body) } : {}),
    });
    const bytes = Buffer.byteLength(await res.text());
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status, bytes };
  };

  const run = async (p) => {
    const total = p.n ?? N;
    const results = [];
    let next = 0;
    const wall0 = Date.now();
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (next < total) { next++; results.push(await fire(p)); }
    }));
    const wall = (Date.now() - wall0) / 1000;
    const lat  = results.map((r) => r.ms).sort((a, b) => a - b);
    const errs = results.filter((r) => r.status >= 400).length;
    const bytes = Math.round(results.reduce((s, r) => s + r.bytes, 0) / results.length);
    return { name: p.name, n: total, rps: (total / wall).toFixed(1), p50: pct(lat, 50).toFixed(1), p95: pct(lat, 95).toFixed(1), p99: pct(lat, 99).toFixed(1), errors: `${errs}/${total}`, status: results[0].status, bytes };
  };

  console.log(`\nschool: ${CLASSES} classes × ${PER_CLASS} pupils = ${students.length} pupils, ${scores.length} marks, ${registers.length} register rows; ${CONCURRENCY} concurrent`);
  console.log("");
  const rows = [];
  for (const p of paths) rows.push(await run(p));
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log(`${"path".padEnd(w)}  ${"n".padStart(4)} ${"req/s".padStart(7)} ${"p50ms".padStart(8)} ${"p95ms".padStart(8)} ${"p99ms".padStart(8)} ${"errors".padStart(7)} ${"status".padStart(6)} ${"bytes".padStart(8)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(w)}  ${String(r.n).padStart(4)} ${r.rps.padStart(7)} ${r.p50.padStart(8)} ${r.p95.padStart(8)} ${r.p99.padStart(8)} ${r.errors.padStart(7)} ${String(r.status).padStart(6)} ${String(r.bytes).padStart(8)}`);
  }
  const failing = rows.filter((r) => r.status >= 400);
  console.log("");
  console.log(failing.length ? `  ${failing.length} path(s) answered an error status — see above` : "  every path answered 2xx");

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(failing.length ? 1 : 0);
})().catch((err) => { console.error("perf run failed:", err); process.exit(1); });
