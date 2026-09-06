// backend/scripts/check-authz-matrix.js
"use strict";

/**
 * Who can actually call what.
 *
 * A route inventory of this backend turns up 325 routes, and a good number of
 * them carry no role or permission middleware at all. Most of those are
 * self-scoped on purpose — /portal/*, /results/my-results, /students/me — and
 * are correct. But "no middleware" and "self-scoped" look identical from the
 * outside, and the difference is the whole of authorization.
 *
 * So this asks the routers directly, over HTTP, with a real token for each
 * role, and records what comes back. Frontend hiding is not security and
 * neither is a reviewer's reading of a route table; the only evidence that a
 * student cannot publish results is a student trying it and being refused.
 *
 * A case marked `deny` must answer 401, 403 or 404. Anything else — including
 * a 500, which means the request got past authorization and into the handler —
 * is a finding.
 *
 *   node scripts/check-authz-matrix.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {
  process.env.JWT_SECRET  = process.env.JWT_SECRET  || "test-only-secret";
  process.env.NODE_ENV    = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User    = mongoose.model("User");
  const Student = mongoose.model("Student");
  const Class   = mongoose.model("Class");

  const A = "school-a";
  const B = "school-b";

  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId, isActive: true,
  });

  await mkUser("adm-a",  "school_admin", A, "Admin A");
  await mkUser("bur-a",  "bursar",       A, "Bursar A");
  await mkUser("tea-a",  "teacher",      A, "Teacher A");
  await mkUser("stu-a",  "student",      A, "Student A");
  await mkUser("stu-a2", "student",      A, "Other Student A");
  await mkUser("adm-b",  "school_admin", B, "Admin B");

  await Class.create({ _id: "cls-a", schoolId: A, name: "Form 1" });
  await Student.create({
    _id: "st-a", userId: "stu-a", schoolId: A, classId: "cls-a",
    studentName: "Student A", enrollmentNo: "A-1", isActive: true,
  });
  await Student.create({
    _id: "st-a2", userId: "stu-a2", schoolId: A, classId: "cls-a",
    studentName: "Other Student A", enrollmentNo: "A-2", isActive: true,
  });

  // The real routers, behind the real authenticate middleware, mounted exactly
  // as server.js mounts them.
  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());

  const mount = (p, file) => {
    try { app.use(p, auth.authenticate, require(path.join(SRC, "routes", file))); }
    catch (err) { console.log(`  (could not mount ${file}: ${err.message})`); }
  };

  mount("/api/annual-results",    "annualResults.routes");
  mount("/api/academic-structure","academicStructure.routes");
  mount("/api/exports",           "export.routes");
  mount("/api/messages",          "messages.routes");
  mount("/api/exams",             "exam.routes");
  mount("/api/homework",          "homework.routes");
  mount("/api/attendance",        "attendance.routes");
  mount("/api/term-results",      "termResults.routes");
  mount("/api/finance",           "finance.routes");
  mount("/api/fees",              "fees.routes");
  mount("/api/admin",             "admin.routes");

  const server = app.listen(0);
  const port   = server.address().port;

  const tokens = {};
  for (const [k, u] of Object.entries({
    admin: ["adm-a", "school_admin", A], bursar: ["bur-a", "bursar", A],
    teacher: ["tea-a", "teacher", A],    student: ["stu-a", "student", A],
    adminB: ["adm-b", "school_admin", B],
  })) {
    tokens[k] = jwt.sign({ id: u[0], role: u[1], schoolId: u[2] },
      process.env.JWT_SECRET, { expiresIn: "1h" });
  }

  const call = async (who, method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokens[who]}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = {}; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };

  const DENIED = new Set([401, 403, 404]);

  /**
   * A read that names another school is not refused — resolveSchoolId quietly
   * gives the caller their own, which is the right behaviour for a client that
   * sends a stale schoolId on every request. So the assertion is not "was it
   * refused" but "did anything of the other school come back". Those look the
   * same when the other school is empty, which is why the callers below seed
   * a marker over there first.
   */
  const scoped = async (who, method, p, marker, note) => {
    const r = await call(who, method, p);
    const text = JSON.stringify(r.body ?? {});
    const label = `${who.padEnd(7)} ${method.padEnd(6)} ${p}${note ? "  — " + note : ""}`;
    if (!text.includes(marker)) ok(`scoped away: ${label}  (${r.status})`);
    else bad(`LEAKED: ${label}`, `${r.status} ${text.slice(0, 200)}`);
  };

  /**
   * @param {"deny"|"allow"} expect
   */
  const probe = async (expect, who, method, p, body, note) => {
    const r = await call(who, method, p, body);
    const denied = DENIED.has(r.status);
    const label = `${who.padEnd(7)} ${method.padEnd(6)} ${p}${note ? "  — " + note : ""}`;

    if (expect === "deny") {
      if (denied) ok(`refused: ${label}  (${r.status})`);
      else bad(`NOT refused: ${label}`,
        `answered ${r.status}. ${JSON.stringify(r.body).slice(0, 160)}`);
    } else {
      if (!denied) ok(`allowed: ${label}  (${r.status})`);
      else bad(`wrongly refused: ${label}`, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    return r;
  };

  // ── Results a pupil must not be able to compute or publish ────────────────
  console.log("\n--- annual results: computing and publishing are not pupil actions ---");

  await probe("deny", "student", "POST", "/api/annual-results/compute",
    { schoolId: A, academicYear: "2026/2027", classId: "cls-a" });
  await probe("deny", "student", "POST", "/api/annual-results/publish",
    { schoolId: A, academicYear: "2026/2027", classId: "cls-a" });
  await probe("deny", "student", "GET",
    `/api/annual-results/student/st-a2?schoolId=${A}&academicYear=2026/2027`,
    null, "another pupil's annual result");

  console.log("\n--- term results ---");
  await probe("deny", "student", "POST", "/api/term-results/compute",
    { schoolId: A, academicYear: "2026/2027", term: 1, classId: "cls-a" });
  await probe("deny", "student", "POST", "/api/term-results/publish",
    { schoolId: A, academicYear: "2026/2027", term: 1, classId: "cls-a" });

  // ── The academic structure takes its school from the URL ──────────────────
  console.log("\n--- academic structure: the schoolId is a path parameter ---");

  await probe("deny", "student", "PUT", `/api/academic-structure/${A}/2026-2027`,
    { terms: [] }, "a pupil rewriting the year");
  await probe("deny", "teacher", "PUT", `/api/academic-structure/${A}/2026-2027`,
    { terms: [] }, "a teacher rewriting the year");
  await probe("deny", "admin",   "PUT", `/api/academic-structure/${B}/2026-2027`,
    { terms: [] }, "school A's admin rewriting school B");
  // Seeded so "nothing came back" cannot pass by accident.
  await mongoose.model("AcademicStructure").create({
    _id: "as-b", schoolId: B, academicYear: "2026-2027", passMark: 7,
  }).catch(() => {});
  await scoped("admin", "GET", `/api/academic-structure/${B}/2026-2027`,
    "as-b", "school A's admin reading school B");

  // ── Bulk export is a mass data read ───────────────────────────────────────
  console.log("\n--- exports ---");

  await probe("deny", "student", "GET", `/api/exports/students?schoolId=${A}`);
  await probe("deny", "teacher", "GET", `/api/exports/payments?schoolId=${A}`);
  await mongoose.model("Student").create({
    _id: "st-b", userId: "usr-b", schoolId: B, classId: "cls-b",
    studentName: "Pupil Of B", enrollmentNo: "B-1", isActive: true,
  }).catch(() => {});
  await scoped("admin", "GET", `/api/exports/students?schoolId=${B}`,
    "Pupil Of B", "school A's admin exporting school B");

  // ── The message audit log is an administrator's view ──────────────────────
  console.log("\n--- message audit ---");

  await probe("deny", "student", "GET", `/api/messages/audit/conversations?schoolId=${A}`);
  await probe("deny", "teacher", "GET", `/api/messages/audit/conversations?schoolId=${A}`);

  // ── Exam structure ────────────────────────────────────────────────────────
  console.log("\n--- exams ---");

  await probe("deny", "student", "DELETE", `/api/exams/ex-1/subjects/sub-1?schoolId=${A}`);
  // The earlier run answered 200 with an empty list only because no exam
  // existed. An absent fixture makes a permissive endpoint look safe.
  await mongoose.model("Exam").create({
    _id: "ex-1", schoolId: A, name: "First Sequence", type: "test",
    academicYear: "2026/2027", term: 1, sequenceNumber: 1,
    status: "completed", classId: "cls-a", totalMarks: 20, passMark: 10,
  }).catch((e) => console.log("    (exam fixture: " + e.message + ")"));
  await mongoose.model("StudentScore").create({
    _id: "sc-1", examId: "ex-1", schoolId: A, studentId: "st-a2", subjectId: "sub-1",
    classId: "cls-a", score: 17,
  }).catch((e) => console.log("    (score fixture: " + e.message + ")"));

  await probe("deny", "student", "GET",    `/api/exams/ex-1/scores?schoolId=${A}`,
    null, "the whole cohort's scores");

  // ── Homework ──────────────────────────────────────────────────────────────
  console.log("\n--- homework ---");

  await probe("deny", "student", "POST", "/api/homework",
    { schoolId: A, classId: "cls-a", title: "Set by a pupil" });

  // ── Attendance ────────────────────────────────────────────────────────────
  console.log("\n--- attendance ---");

  // scopeToSelfForStudents narrows this to the caller's own record rather than
  // refusing, so the property is "only mine came back", not "refused".
  {
    const rr = await call("student", "GET", `/api/attendance/students?schoolId=${A}`);
    const recs = rr.body?.records ?? [];
    const others = recs.filter((x) => String(x.studentId) !== "st-a");
    if (others.length === 0) ok(`a pupil's register request returns only their own (${recs.length} row(s))`);
    else bad("a pupil sees only their own register", JSON.stringify(others).slice(0, 160));
  }

  // ── Money ─────────────────────────────────────────────────────────────────
  console.log("\n--- money ---");

  await probe("deny", "student", "GET",  `/api/finance/expenses?schoolId=${A}`);
  await probe("deny", "teacher", "GET",  `/api/finance/payroll?schoolId=${A}`);
  await probe("deny", "teacher", "POST", "/api/fees/payments",
    { schoolId: A, studentId: "st-a", amount: 1000 });
  await probe("deny", "student", "GET",  `/api/fees/payments?schoolId=${A}`);

  // ── Cross-school, the one that matters most ───────────────────────────────
  console.log("\n--- one school's administrator against another's data ---");

  await scoped("adminB", "GET", `/api/admin/students?schoolId=${A}`,
    "Student A", "school B's admin listing school A's pupils");

  const r = await call("adminB", "GET", `/api/admin/students?schoolId=${A}`);
  const rows = r.body?.data?.students ?? r.body?.students ?? r.body?.data ?? [];
  const foreign = (Array.isArray(rows) ? rows : []).filter((s) => String(s.schoolId) === A);
  if (foreign.length === 0) ok("and not one row of school A is in the reply");
  else bad("school B received school A's pupils", `${foreign.length} row(s)`);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
