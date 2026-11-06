// backend/scripts/check-rankings-paging.js
"use strict";

/**
 * The analytics page's rankings agree with its overview past 100 pupils.
 *
 * GET /results/:examId/rankings answered the first 100 rows and nothing else:
 * no page, no total. An exam sat by 150 pupils showed "150" on the overview and
 * "100 students" on the Rankings tab, and 50 pupils were unreachable. It now
 * pages like Term Results — ?page=, with `total` and `totalPages` — still cut
 * in the database (check-complexity.js).
 *
 *   one exam, 150 pupils: Form 1 40, Form 2 40, Form 10 35, Upper Sixth 35;
 *   school and grade positions shared in pairs (1, 1, 3, 3, …) so the page
 *   boundary falls inside a tie
 *
 *   every scope:  total 150, two pages of 100 + 50, every pupil exactly once
 *   class scope, every class:  grouped by class, Form 1 < Form 2 < Form 10
 *   Form 1 only:  total 40, one page
 *
 *   node scripts/check-rankings-paging.js
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

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const A = "68e0000000000000000000b7";
  const YEAR = "2026-2027";
  await M("School").create({ _id: A, name: "Big School", code: "BIG", email: "big@example.test" });
  await M("User").create({ _id: "admin-b", name: "admin-b", email: "admin-b@example.test", password: "Check-only-passw0rd", role: "school_admin", schoolId: A, isActive: true });
  await M("GradingConfig").create({ schoolId: A, passMark: 10 });
  await M("Exam").create({
    _id: "ex-big", schoolId: A, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 1,
    status: "published", classId: "f1", classIds: ["f1", "f2", "f10", "u6"], totalMarks: 20, passMark: 10,
  });

  // Listed out of name order on purpose: the order must come from the sort.
  const CLASSES = [["u6", "Upper Sixth", 35], ["f10", "Form 10", 35], ["f2", "Form 2", 40], ["f1", "Form 1", 40]];
  const rows = [];
  for (const [classId, className, n] of CLASSES) {
    for (let i = 0; i < n; i++) {
      rows.push({ studentId: `${classId}-${String(i).padStart(2, "0")}`, classId, className, classPosition: i + 1, totalInClass: n });
    }
  }
  // A school-wide order, positions shared in pairs: 1, 1, 3, 3, 5, 5, …
  rows.forEach((r, i) => {
    r.average = 19 - i * 0.1;
    r.schoolPosition = r.gradePosition = i - (i % 2) + 1;
  });
  await M("ResultSummary").insertMany(rows.map((r) => ({
    ...r, examId: "ex-big", schoolId: A, academicYear: YEAR, term: "1",
    studentName: `Pupil ${r.studentId}`, admissionNo: `EN-${r.studentId}`,
    totalInSchool: 150, totalInGrade: 150,
    isPassing: r.average >= 10, isPublished: true, publishedAt: new Date(), subjectBreakdown: [],
  })));

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/results", auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;
  const token  = jwt.sign({ id: "admin-b", role: "school_admin", schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const get = async (url) => {
    const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.json().catch(() => ({}));
  };

  const stats = await get("/results/ex-big/stats");
  console.log("\n--- the overview ---");
  check("150 pupils", stats?.data?.totalStudents, 150);

  for (const scope of ["class", "grade", "school"]) {
    console.log(`\n--- rank by ${scope}, every class ---`);
    const p1 = await get(`/results/ex-big/rankings?rankBy=${scope}&limit=100&page=1`);
    const p2 = await get(`/results/ex-big/rankings?rankBy=${scope}&limit=100&page=2`);
    check("the table's size is the overview's", [p1.total, p1.totalPages], [150, 2]);
    check("page 1: 100 rows, page 2: the other 50", [p1.count, p2.count, p2.page], [100, 50, 2]);
    const seen = [...(p1.data ?? []), ...(p2.data ?? [])].map((r) => r.studentId);
    check("every pupil exactly once across the pages", [new Set(seen).size, seen.length], [150, 150]);
    if (scope === "class") {
      const runs = [];
      const both = [...(p1.data ?? []), ...(p2.data ?? [])];
      for (const r of both) if (!runs.length || runs[runs.length - 1] !== r.className) runs.push(r.className);
      check("grouped by class, in name order with numbers read as numbers", runs,
        ["Form 1", "Form 2", "Form 10", "Upper Sixth"]);
      const f2 = both.filter((r) => r.classId === "f2").map((r) => r.classPosition);
      check("a class split across pages keeps its positions in order", f2, Array.from({ length: 40 }, (_, i) => i + 1));
    }
  }

  console.log("\n--- Form 1 only ---");
  const f1 = await get("/results/ex-big/rankings?rankBy=school&classId=f1&limit=100&page=1");
  check("40 pupils on one page", [f1.total, f1.totalPages, f1.count], [40, 1, 40]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
