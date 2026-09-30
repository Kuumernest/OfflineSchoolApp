// backend/scripts/check-input-hardening.js
"use strict";

/**
 * Stage 18A — malformed input never becomes a 5xx, a dropped connection or
 * an uncaught exception.
 *
 * ── What is being proved ──────────────────────────────────────────────────
 *
 * Every route every router exports, mounted behind the real authenticate
 * middleware and the real error handler, is called by an operator (with and
 * without a school named), a head, a teacher, a pupil and another school's
 * head, with the input a client can actually send when it is wrong: an id
 * that is not an id, an id that is well-formed and unknown, a body that is
 * empty, a body of the wrong shapes (numbers for ids, an object for a class,
 * an impossible date, a negative amount, a huge score, a five-thousand-byte
 * name, a string for a list), malformed JSON, and a query string of negative
 * pages, absurd limits, impossible dates, a NUL byte and a prototype key.
 *
 * The only assertion is about the class of the answer: 2xx, 3xx or 4xx are
 * all acceptable — the route decided. 5xx means the server did not decide,
 * a dropped socket means it died mid-answer, and an uncaught exception means
 * process.on("uncaughtException") in server.js would have exited the process.
 * The first run of this probe found exactly that: the pupil's announcements
 * route removed headers in a "finish" listener and killed the server after
 * every 200.
 *
 * ── What is NOT being proved ──────────────────────────────────────────────
 *
 * Authorisation (check-authz-matrix.js and the access suites), validation
 * messages, or that any of these requests is refused for the right reason.
 * Two legacy teacher routes answer 503 by design when a model they were
 * written for is not registered; they are listed below and nothing else may
 * join that list.
 *
 *   node scripts/check-input-hardening.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/** Legacy routes that answer 503 "model not available" by design. */
const KNOWN_503 = new Set(["POST /api/teacher/homework", "POST /api/teacher/quizzes"]);

const A = "68c0000000000000000000a1", B = "68c0000000000000000000b2";
const MOUNTS = [
  ["/api/students", "students.routes", "optional"], ["/api/student", "students.routes"], ["/api/users", "user.routes"], ["/api/sync", "sync.routes"],
  ["/api/announcements", "announcement.routes"], ["/api/attendance", "attendance.routes"], ["/api/homework", "homework.routes"], ["/api/quiz", "quiz.routes"],
  ["/api/results", "results.routes"], ["/api/templates", "template.routes"], ["/api/generated-reports", "generated.report.routes"], ["/api/exams", "exam.routes"],
  ["/api/academic-structure", "academicStructure.routes"], ["/api/term-results", "termResults.routes"], ["/api/annual-results", "annualResults.routes"],
  ["/api/fees", "fees.routes"], ["/api/approvals", "approvals.routes"], ["/api/finance", "finance.routes"], ["/api/promotion", "promotion.routes"],
  ["/api/documents", "documents.routes"], ["/api/exports", "export.routes"], ["/api/messages", "messages.routes"], ["/api/gate", "gate.routes"],
  ["/api/insights", "insights.routes"], ["/api/interventions", "interventions.routes"], ["/api/explorations", "explorations.routes"], ["/api/teacher", "teacher.routes"],
  ["/api/super-admin", "superAdmin.routes"], ["/api/admin/permissions", "permissions.routes"], ["/api/admin/periods", "periods.routes"], ["/api/admin/timetable", "timetable.routes"],
  ["/api/admin", "admin.routes"], ["/api/auth", "auth.routes", "none"], ["/api", "public.routes", "none"], ["/api", "verify.routes", "none"], ["/api/portal", "portal.routes", "none"],
];

/** Every route a router exports, with nested routers walked under their prefix. */
const routesOf = (router, prefix) => {
  const out = [];
  const walk = (stack, pre) => {
    for (const layer of stack ?? []) {
      if (layer.route) { for (const m of Object.keys(layer.route.methods)) if (m !== "_all") out.push({ method: m.toUpperCase(), path: pre + layer.route.path }); }
      else if (layer.name === "router" && layer.handle?.stack) {
        const m = (layer.regexp?.source ?? "").match(/^\^\\\/([^\\?]+)/);
        walk(layer.handle.stack, pre + (m ? "/" + m[1].replace(/\\\//g, "/") : ""));
      }
    }
  };
  walk(router.stack, prefix);
  return out;
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "check-only-refresh-secret";
  process.env.NODE_ENV = "test";
  process.env.ADVANCED_INTELLIGENCE_PROVIDER = "none";
  delete process.env.ANTHROPIC_API_KEY; delete process.env.BREVO_API_KEY; delete process.env.GMAIL_APP_PASSWORD;

  let current = "(none)";
  const uncaught = [];
  process.on("uncaughtException", (e) => { uncaught.push(`${e.code ?? e.name}: ${e.message} — during ${current}`); });

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await M("School").create([{ _id: A, name: "Alpha", code: "ALPHA", email: "alpha@example.test", isActive: true }, { _id: B, name: "Beta", code: "BETA", email: "beta@example.test", isActive: true }]);
  const mk = (id, role, schoolId, name) => M("User").create({ _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true });
  await Promise.all([mk("op", "super_admin", null, "Operator"), mk("adm", "school_admin", A, "Head"), mk("tea", "teacher", A, "Teacher"), mk("stu", "student", A, "Pupil"), mk("admB", "school_admin", B, "Head B")]);
  await M("Class").create([{ _id: "cls-a", schoolId: A, name: "Form 1" }]);
  await M("Student").create([{ _id: "st-a", userId: "stu", schoolId: A, classId: "cls-a", studentName: "Pupil A", enrollmentNo: "A-1", isActive: true, status: "approved" }]);
  await M("TeacherAssignment").create([{ schoolId: A, teacher: "tea", class: "cls-a", subject: "maths" }]);

  const auth = require(path.join(ROOT, "middleware/auth"));
  const errorHandler = require(path.join(ROOT, "middleware/errorHandler"));
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const all = [];
  for (const [p, file, mode] of MOUNTS) {
    const router = require(path.join(SRC, "routes", file));
    // server.js keeps optionalAuthenticate private; the same shape suffices here: a bearer is checked, its absence is not.
    const optional = (req, res, next) => (req.headers.authorization ? auth.authenticate(req, res, next) : next());
    if (mode === "none") app.use(p, router); else if (mode === "optional") app.use(p, optional, router); else app.use(p, auth.authenticate, router);
    all.push(...routesOf(router, p).map((r) => ({ ...r, file })));
  }
  app.use((req, res) => res.status(404).json({ success: false, error: "Route not found" }));
  app.use(errorHandler);
  const server = app.listen(0); const port = server.address().port;
  const tok = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const roles = { operator: tok("op", "super_admin", null), operatorSel: tok("op", "super_admin", null), head: tok("adm", "school_admin", A), teacher: tok("tea", "teacher", A), pupil: tok("stu", "student", A), headB: tok("admB", "school_admin", B) };

  const badId = "zz-not-an-id", hexId = "0123456789abcdef01234567";
  const junk = { studentId: 12345, classId: { a: 1 }, examId: [], date: "2026-13-45", amount: -1, score: 1e308, name: "x".repeat(5000), items: "notarray", status: null, email: "", page: -1, limit: 999999, version: "abc", schoolId: badId, unexpectedField: true };
  const query = "?page=-1&limit=999999&date=2026-13-45&from=x&to=y&term=abc&academicYear=zz&classId=zz&studentId=zz&examId=zz&search=%00&sort=__proto__";
  const findings = []; let n = 0; const seen = new Set();
  const fire = async (route, role, variant, url, body, raw) => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${roles[role]}` };
    if (role === "operatorSel") headers["x-school-id"] = A;
    current = `${route.method} ${url} [${role}, ${variant}]`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000); const started = Date.now();
    try {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, { method: route.method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
      const text = await res.text(); n++;
      const key = `${route.method} ${route.path}`;
      const known503 = res.status === 503 && KNOWN_503.has(key);
      if (res.status >= 500 && !known503 && !seen.has(`${key} ${res.status}`)) { seen.add(`${key} ${res.status}`); findings.push(`${res.status} ${route.method} ${route.path} [${role}, ${variant}] ${text.slice(0, 120).replace(/\s+/g, " ")}`); }
      if (Date.now() - started > 5000) findings.push(`SLOW ${Date.now() - started}ms ${key} [${role}, ${variant}]`);
    } catch (e) { n++; findings.push(`DROPPED ${route.method} ${route.path} [${role}, ${variant}] ${e.message}`); }
    finally { clearTimeout(t); }
  };
  const uniq = new Map(); for (const r of all) uniq.set(`${r.method} ${r.path}`, r);
  const withParams = (p, v) => p.replace(/:[A-Za-z_]+\??/g, v).replace(/\(\?\)/g, "");
  console.log(`\n--- ${uniq.size} routes across ${MOUNTS.length} mounts, six callers, malformed input ---`);
  for (const route of uniq.values()) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(route.method);
    for (const role of Object.keys(roles)) {
      for (const [variant, url] of [["bad-id", withParams(route.path, badId) + (mutating ? "" : query)], ["hex-id", withParams(route.path, hexId) + (mutating ? "" : query)]]) {
        if (!mutating) { await fire(route, role, variant, url); continue; }
        await fire(route, role, `${variant} empty`, url, {});
        await fire(route, role, `${variant} junk`, url, junk);
        if (variant === "bad-id") await fire(route, role, "malformed-json", url, undefined, "{\"bad\": ");
      }
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  console.log(`  (${n} requests)`);
  for (const f of findings) console.log(`       ${f}`);
  check("no route answers 5xx, drops the connection or takes over five seconds on malformed input", findings, []);
  check("no request leaves an uncaught exception behind once its response is on the wire", uncaught, []);

  // The route that once did: a pupil reads their announcements and the response finishes cleanly.
  const before = uncaught.length;
  current = "GET /api/announcements/student [pupil]";
  const mine = await fetch(`http://127.0.0.1:${port}/api/announcements/student`, { headers: { Authorization: `Bearer ${roles.pupil}` } });
  await mine.text(); await new Promise((r) => setTimeout(r, 100));
  check("a pupil's announcements answer 200 and finishing the response raises nothing", [mine.status, uncaught.length - before], [200, 0]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err.stack || err.message); process.exit(1); });
