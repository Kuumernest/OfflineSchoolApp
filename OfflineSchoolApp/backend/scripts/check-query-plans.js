// backend/scripts/check-query-plans.js
"use strict";

/**
 * Whether the hot queries actually use an index, asked of the database.
 *
 * An index existing is not the same as an index being used. A filter on
 * schoolId with a sort on something the compound index does not cover, a
 * regex that cannot be anchored, a $or that defeats the plan — each produces a
 * collection scan that is invisible at a hundred rows and ruinous at fifty
 * thousand, and none of them look wrong in the source.
 *
 * So this asks Mongo. Every query below is run through explain("executionStats")
 * against a school of realistic size, and the assertion is on the stage the
 * planner actually chose and on how many documents it had to touch to answer.
 *
 * The failure being looked for is COLLSCAN on a collection that grows with the
 * school, and the ratio that matters is documents examined to documents
 * returned: a query that reads five thousand rows to return fifty is a query
 * that will be slow on a school's own hardware even when it is fast here.
 *
 *   node scripts/check-query-plans.js
 */

const mongoose = require("mongoose");
const path     = require("path");

const SRC = path.join(__dirname, "..", "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

// A school big enough for a bad plan to show. Cameroonian secondary schools of
// this size are ordinary; the point is that the numbers below are not a
// hundred rows in a test fixture.
const STUDENTS = 2000;
const TERMS    = 3;
const SUBJECTS = 8;

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const Student      = mongoose.model("Student");
  const Class        = mongoose.model("Class");
  const StudentScore = mongoose.model("StudentScore");
  const Attendance   = mongoose.model("StudentAttendance");
  const FeePayment   = mongoose.model("FeePayment");
  const TermResult   = mongoose.model("TermResult");

  const A = "school-a";
  const B = "school-b";
  const YEAR = "2026/2027";

  console.log(`\nseeding ~${STUDENTS} pupils in two schools …`);
  const t0 = Date.now();

  const classes = [];
  for (let c = 0; c < 20; c++) {
    classes.push({ _id: `cls-${c}`, schoolId: c < 15 ? A : B, name: `Form ${c}` });
  }
  await Class.insertMany(classes);

  const students = [];
  for (let i = 0; i < STUDENTS; i++) {
    const school = i < STUDENTS * 0.75 ? A : B;
    students.push({
      _id: `st-${i}`, userId: `u-${i}`, schoolId: school,
      classId: `cls-${i % 20}`, studentName: `Pupil Number ${i}`,
      enrollmentNo: `ENR-${String(i).padStart(5, "0")}`,
      isActive: true, status: i % 11 === 0 ? "pending" : "approved",
    });
  }
  await Student.insertMany(students, { ordered: false });

  const scores = [];
  for (let i = 0; i < STUDENTS; i++) {
    for (let s = 0; s < SUBJECTS; s++) {
      scores.push({
        _id: `sc-${i}-${s}`, examId: "ex-1", schoolId: students[i].schoolId,
        studentId: `st-${i}`, subjectId: `sub-${s}`, classId: students[i].classId,
        score: (i + s) % 21,
      });
    }
  }
  await StudentScore.insertMany(scores, { ordered: false });

  const registers = [];
  for (let i = 0; i < STUDENTS; i++) {
    for (let d = 0; d < 5; d++) {
      registers.push({
        _id: `at-${i}-${d}`, schoolId: students[i].schoolId, classId: students[i].classId,
        studentId: `st-${i}`, date: `2026-09-0${d + 1}`, status: "present",
        markedBy: "adm-1",
      });
    }
  }
  await Attendance.insertMany(registers, { ordered: false });

  const payments = [];
  for (let i = 0; i < STUDENTS; i++) {
    payments.push({
      _id: `pay-${i}`, schoolId: students[i].schoolId, studentId: `st-${i}`,
      academicYear: YEAR, amount: 25000, method: "cash",
      receiptNo: `R-${String(i).padStart(6, "0")}`, receivedAt: new Date(),
    });
  }
  await FeePayment.insertMany(payments, { ordered: false });

  const terms = [];
  for (let i = 0; i < STUDENTS; i++) {
    for (let t = 1; t <= TERMS; t++) {
      terms.push({
        _id: `tr-${i}-${t}`, schoolId: students[i].schoolId, studentId: `st-${i}`,
        classId: students[i].classId, academicYear: YEAR, term: t,
        average: 12 + (i % 8), classPosition: (i % 40) + 1, totalInClass: 40,
      });
    }
  }
  await TermResult.insertMany(terms, { ordered: false });

  // Indexes are declared on the schemas; build them before measuring, or the
  // first query measures an empty index rather than the plan in production.
  for (const m of [Student, StudentScore, Attendance, FeePayment, TermResult, Class]) {
    await m.init();
  }

  const counts = {
    students: await Student.estimatedDocumentCount(),
    scores:   await StudentScore.estimatedDocumentCount(),
    register: await Attendance.estimatedDocumentCount(),
    payments: await FeePayment.estimatedDocumentCount(),
    terms:    await TermResult.estimatedDocumentCount(),
  };
  console.log(`seeded in ${Date.now() - t0} ms — ` +
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));

  /**
   * Run a query under explain and report the plan.
   *
   * `ratio` is examined-to-returned. 1 is a perfect index; a few is fine;
   * hundreds means the index is not doing the work the query needs.
   */
  const plan = async (label, query, { maxRatio = 12, allowScan = false } = {}) => {
    const started = Date.now();
    const stats   = await query.explain("executionStats");
    const ms      = Date.now() - started;

    const ex        = stats.executionStats ?? {};
    const returned  = ex.nReturned ?? 0;
    const examined  = ex.totalDocsExamined ?? 0;
    const keys      = ex.totalKeysExamined ?? 0;
    const stage     = JSON.stringify(stats.queryPlanner?.winningPlan ?? {});
    const collscan  = stage.includes("COLLSCAN");
    const ratio     = returned === 0 ? examined : examined / returned;

    const detail =
      `${collscan ? "COLLSCAN" : "IXSCAN"}  returned ${returned}  ` +
      `docs examined ${examined}  keys ${keys}  ${ms} ms`;

    if (collscan && !allowScan) {
      bad(`${label}: uses an index`,
        `${detail}\nThe planner read the whole collection. At ${counts.students} ` +
        "pupils this is already the wrong shape; it does not improve with more.");
      return;
    }
    if (ratio > maxRatio) {
      bad(`${label}: the index narrows the search`,
        `${detail}\nexamined ${ratio.toFixed(1)}x what it returned.`);
      return;
    }
    ok(`${label} — ${detail}`);
  };

  console.log("\n--- the roster ---");

  // What the endpoint ACTUALLY runs.
  //
  // GET /admin/students does not sort or paginate in the database. It fetches
  // every matching pupil, sorts them in JavaScript with localeCompare, and
  // slices the page afterwards — deliberately, because binary order and
  // localeCompare disagree on accented names and in a French-speaking school
  // that is most of the roll. check-desktop-parity asserts the two agree, so
  // the ordering is load-bearing.
  //
  // The cost is that every request reads the whole roster whatever page was
  // asked for. The index does its job; the shape of the endpoint is what
  // decides the work. Measured rather than assumed, and asserted below as a
  // budget rather than a ratio, because a ratio would be meaningless for a
  // query that is meant to return everything.
  await plan("the roster query the endpoint really makes (no sort, no limit)",
    Student.find({ schoolId: A, status: "approved" }),
    { maxRatio: 1.2 });

  await plan("one class's roster",
    Student.find({ schoolId: A, classId: "cls-3", isActive: true }));

  await plan("a pupil by enrolment number",
    Student.findOne({ enrollmentNo: "ENR-01234", schoolId: A }));

  console.log("\n--- marks and results ---");

  await plan("one exam's scores for a class",
    StudentScore.find({ examId: "ex-1", classId: "cls-3", schoolId: A }));

  await plan("one pupil's scores across an exam",
    StudentScore.find({ examId: "ex-1", studentId: "st-500" }));

  await plan("a term's results for a class, in rank order",
    TermResult.find({ schoolId: A, academicYear: YEAR, term: 1, classId: "cls-3" })
      .sort({ classPosition: 1 }));

  console.log("\n--- the register ---");

  await plan("one class on one day",
    Attendance.find({ schoolId: A, classId: "cls-3", date: "2026-09-01" }));

  await plan("one pupil's term of attendance",
    Attendance.find({ studentId: "st-500", date: { $gte: "2026-09-01", $lte: "2026-12-31" } }));

  console.log("\n--- money ---");

  await plan("a family's payment history",
    FeePayment.find({ schoolId: A, studentId: "st-500", academicYear: YEAR })
      .sort({ receivedAt: -1 }));

  await plan("the day's takings",
    FeePayment.find({ schoolId: A, receivedAt: { $gte: new Date(Date.now() - 86400000) } })
      .sort({ receivedAt: -1 }).limit(100));

  console.log("\n--- the sync feed, which reads every collection ---");

  // The keyset cursor: this is the query the desktop runs thirty-six times per
  // sync, so its plan matters more than any single screen's.
  await plan("a page of the change feed",
    Student.find({
      schoolId: A,
      $or: [
        { updatedAt: { $gt: new Date(0) } },
        { updatedAt: new Date(0), _id: { $gt: "st-0" } },
      ],
    }).sort({ updatedAt: 1, _id: 1 }).limit(500),
    { maxRatio: 3 });

  // ── What it costs end to end ───────────────────────────────────────────
  //
  // A plan is not a latency. These are the queries above, timed as the
  // endpoint runs them, so there is a number to hold a release to rather
  // than a feeling.
  console.log("\n--- measured, at this size ---");

  const timed = async (label, fn, budgetMs) => {
    await fn();                       // warm the cache; the first is not typical
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await fn();
      runs.push(Date.now() - t);
    }
    runs.sort((a, b) => a - b);
    const median = runs[2];
    const worst  = runs[4];

    if (median <= budgetMs) {
      ok(`${label} — median ${median} ms, worst ${worst} ms (budget ${budgetMs})`);
    } else {
      bad(`${label} within ${budgetMs} ms`,
        `median ${median} ms, worst ${worst} ms across ${counts.students} pupils.`);
    }
  };

  await timed("the whole roster, fetched and sorted the way the endpoint does",
    async () => {
      const rows = await Student.find({ schoolId: A, status: "approved" }).lean();
      rows.sort((a, b) =>
        String(a.studentName ?? "").toLowerCase()
          .localeCompare(String(b.studentName ?? "").toLowerCase()));
      return rows.slice(0, 50);
    }, 400);

  await timed("one class's mark sheet",
    () => StudentScore.find({ examId: "ex-1", classId: "cls-3", schoolId: A }).lean(), 120);

  await timed("a term's results for a class",
    () => TermResult.find({ schoolId: A, academicYear: YEAR, term: 1, classId: "cls-3" })
      .sort({ classPosition: 1 }).lean(), 120);

  await timed("a page of the change feed",
    () => Student.find({
      schoolId: A,
      $or: [
        { updatedAt: { $gt: new Date(0) } },
        { updatedAt: new Date(0), _id: { $gt: "st-0" } },
      ],
    }).sort({ updatedAt: 1, _id: 1 }).limit(500).lean(), 250);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
