// backend/scripts/check-cross-school.js
"use strict";

/**
 * One school must never read another's data — proved with data in both.
 *
 * check-student-tenancy already covers the routers that use resolveSchoolId,
 * the local helper that says "only a super_admin may name a school; everybody
 * else gets their own". Seventeen routers use it. This suite exists for the
 * ones that do not, and instead take schoolId straight off the query string.
 *
 * The trap in testing this is that an empty answer looks exactly like a
 * correctly scoped one. So both schools are populated with distinguishable
 * records, and the assertion is not "school B got nothing" but "school B got
 * nothing OF SCHOOL A'S" — with school A's own request proving the fixture is
 * really there to be leaked.
 *
 *   node scripts/check-cross-school.js
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User         = mongoose.model("User");
  const Student      = mongoose.model("Student");
  const Class        = mongoose.model("Class");
  const TermResult   = mongoose.model("TermResult");
  const AnnualResult = mongoose.model("AnnualResult");
  const Attendance   = mongoose.model("StudentAttendance");
  const Announcement = mongoose.model("Announcement");
  const AcademicStructure = mongoose.model("AcademicStructure");

  const A = "school-a";
  const B = "school-b";
  const YEAR = "2026/2027";

  const seed = async (S, tag) => {
    await User.create({
      _id: `adm-${tag}`, name: `Admin ${tag}`, email: `adm-${tag}@example.test`,
      password: "check-only-password", role: "school_admin", schoolId: S, isActive: true,
    });
    await User.create({
      _id: `stu-${tag}`, name: `Pupil ${tag}`, email: `stu-${tag}@example.test`,
      password: "check-only-password", role: "student", schoolId: S, isActive: true,
    });
    await Class.create({ _id: `cls-${tag}`, schoolId: S, name: `Form 1 ${tag}` });
    await Student.create({
      _id: `st-${tag}`, userId: `stu-${tag}`, schoolId: S, classId: `cls-${tag}`,
      studentName: `Pupil ${tag}`, enrollmentNo: `${tag}-1`, isActive: true,
    });
    await TermResult.create({
      _id: `tr-${tag}`, schoolId: S, studentId: `st-${tag}`, classId: `cls-${tag}`,
      academicYear: YEAR, term: 1, average: 15, classPosition: 1, totalInClass: 1,
    });
    await AnnualResult.create({
      _id: `ar-${tag}`, schoolId: S, studentId: `st-${tag}`, classId: `cls-${tag}`,
      academicYear: YEAR, annualAverage: 15, classPosition: 1, totalInClass: 1,
    }).catch(() => {});
    // date is a String path and markedBy is required; a silent .catch here
    // once let the fixture fail and made a leaky endpoint look scoped.
    await Attendance.create({
      _id: `at-${tag}`, schoolId: S, studentId: `st-${tag}`, classId: `cls-${tag}`,
      date: "2026-09-01", status: "present", markedBy: `adm-${tag}`,
    });
    await Announcement.create({
      _id: `an-${tag}`, schoolId: S, title: `Notice ${tag}`, body: `Body ${tag}`,
      audience: "all", createdBy: `adm-${tag}`,
    }).catch(() => {});
    await AcademicStructure.create({
      _id: `as-${tag}`, schoolId: S, academicYear: YEAR, passMark: 10,
    }).catch(() => {});
  };

  await seed(A, "a");
  await seed(B, "b");

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  const mount = (p, f) => {
    try { app.use(p, auth.authenticate, require(path.join(SRC, "routes", f))); }
    catch (e) { console.log(`  (cannot mount ${f}: ${e.message})`); }
  };
  mount("/api/term-results",       "termResults.routes");
  mount("/api/annual-results",     "annualResults.routes");
  mount("/api/academic-structure", "academicStructure.routes");
  mount("/api/attendance",         "attendance.routes");
  mount("/api/announcements",      "announcement.routes");
  mount("/api/admin/timetable",    "timetable.routes");

  const server = app.listen(0);
  const port   = server.address().port;

  const tok = (id, role, schoolId) =>
    jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });

  const TOK = {
    adminA:   tok("adm-a", "school_admin", A),
    adminB:   tok("adm-b", "school_admin", B),
    studentB: tok("stu-b", "student",      B),
  };

  const get = async (who, p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { Authorization: `Bearer ${TOK[who]}` },
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body, text: JSON.stringify(body) };
  };

  /**
   * The fixture has to be reachable by its owner, or "no leak" proves nothing.
   * Then the same request, from the other school, must not contain it.
   */
  const noLeak = async (label, pathFor, marker) => {
    const own = await get("adminA", pathFor(A));
    const reachable = own.status === 200 && own.text.includes(marker);
    if (!reachable) {
      bad(`${label}: the fixture is reachable by its own school first`,
          `${own.status} ${own.text.slice(0, 160)}`);
      return;
    }
    ok(`${label}: school A can see its own record`);

    for (const who of ["adminB", "studentB"]) {
      const r = await get(who, pathFor(A));
      if (r.text.includes(marker)) {
        bad(`${label}: ${who} received school A's data`,
            `${r.status} ${r.text.slice(0, 200)}`);
      } else {
        ok(`${label}: ${who} does not receive it (${r.status})`);
      }
    }
  };

  console.log("\n--- term results ---");
  await noLeak("term results",
    (s) => `/api/term-results?schoolId=${s}&academicYear=${encodeURIComponent(YEAR)}&term=1`,
    "tr-a");

  console.log("\n--- annual results ---");
  await noLeak("annual results",
    (s) => `/api/annual-results?schoolId=${s}&academicYear=${encodeURIComponent(YEAR)}`,
    "ar-a");

  console.log("\n--- academic structure (schoolId is a path parameter) ---");
  await noLeak("academic structure",
    (s) => `/api/academic-structure/${s}/${encodeURIComponent(YEAR)}`,
    "as-a");

  // /students is scopeToSelfForStudents — an administrator legitimately gets
  // nothing back from it. The staff-facing roster is the one that could leak.
  console.log("\n--- attendance ---");
  await noLeak("attendance report",
    (s) => `/api/attendance/report/student/st-a?schoolId=${s}` +
           "&startDate=2026-08-01&endDate=2026-12-31",
    "at-a");

  console.log("\n--- announcements ---");
  await noLeak("announcements",
    (s) => `/api/announcements?schoolId=${s}`,
    "Notice a");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
