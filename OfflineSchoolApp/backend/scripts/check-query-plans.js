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
  // A plan is not a latency, and this section used to assert one: four
  // absolute millisecond budgets, "a number to hold a release to rather than
  // a feeling". The intent was right and the mechanism could not work.
  //
  // It failed three times in a row on an unchanged codebase with a DIFFERENT
  // set of assertions each time — the roster at 619 ms, then 133 ms, then
  // 687 ms with a worst case of 2042; the same term-results query between 26
  // and 70 ms. Four budgets all sitting close enough to the machine's noise
  // floor that any of them could trip, which is a gate nobody can use: the
  // one thing a release gate must not do is fail for reasons unrelated to the
  // change under test.
  //
  // ── Why not a ratio to a calibration workload ─────────────────────────
  //
  // The obvious repair is to stop encoding "this machine, unloaded" and
  // measure a reference workload in the same run, asserting each query as a
  // multiple of it. Measured over six rounds, that is WORSE:
  //
  //                      absolute hi/lo    ratio-to-unit hi/lo
  //   roster                   3.42              4.33
  //   mark sheet               1.62              3.48
  //   term results             4.62             10.40
  //   change feed              4.01              6.14
  //
  // The calibration itself swung 2.85x (92–262 ms), so dividing by it
  // compounds the jitter rather than cancelling it. The noise is not a
  // machine-speed factor that divides out; it is independent per-measurement
  // variance — GC, page cache, whatever else the box is doing — and a ratio
  // adds two of those together.
  //
  // With a 3–5x spread on the same query on the same machine, no threshold
  // separates a real regression from noise: loose enough not to flake is
  // loose enough to miss a doubling.
  //
  // ── So the assertion moved to work done ───────────────────────────────
  //
  // Documents returned is deterministic. It is also the thing that actually
  // predicts slowness on a school's own hardware, which is what the timing
  // was a proxy for: the plan assertions above catch a scan, and these catch
  // the volume crossing the wire. The measurement is still taken and still
  // printed — a human reading a release still gets the number — it simply no
  // longer decides whether the suite passes.
  console.log("\n--- what crosses the wire, at this size ---");

  const measured = async (fn) => {
    await fn();                       // warm the cache; the first is not typical
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await fn();
      runs.push(Date.now() - t);
    }
    runs.sort((a, b) => a - b);
    return { median: runs[2], worst: runs[4] };
  };

  /**
   * Assert the volume a query returns, against a bound derived from something
   * else.
   *
   * A bound, not an exact number, and the reason is worth stating. An exact
   * count would just re-encode this fixture — 1363 approved pupils, 75 in a
   * class — and the first change to the seeding would fail the suite for no
   * reason, which is the flakiness this section is being rescued from in a
   * new costume. And deriving the exact number from the same collection the
   * query reads is circular: it would assert that a query agrees with itself.
   *
   * So each bound comes from an INDEPENDENT fact. The mark sheet's ceiling is
   * the class roster times the number of subjects, counted off the students
   * collection — a mark sheet that exceeds it is duplicating rows, which is
   * the fan-out this is really guarding against. Nonzero at the other end,
   * because a query that quietly returns nothing passes any upper bound.
   */
  const bounded = async (label, fn, { atMost, because }) => {
    const rows = await fn();
    const n = Array.isArray(rows) ? rows.length : (rows ? 1 : 0);
    const { median, worst } = await measured(fn);
    const timing = `median ${median} ms, worst ${worst} ms — not asserted`;

    if (n > 0 && n <= atMost) {
      ok(`${label} — ${n} document(s), at most ${atMost} (${because}); ${timing}`);
    } else if (n === 0) {
      bad(`${label} returns something`,
        `it returned nothing. An empty result passes any ceiling, so this is\n` +
        `checked separately: either the fixture stopped seeding or the filter\n` +
        `stopped matching.\n(${timing})`);
    } else {
      bad(`${label} returns at most ${atMost} document(s)`,
        `it returned ${n}. The ceiling is ${because}, so exceeding it means\n` +
        `rows are being duplicated or the filter widened — either way every\n` +
        `call now carries volume nobody asked for.\n(${timing})`);
    }
  };

  // Independent facts, counted once, that the ceilings below are built from.
  const inSchoolA = await Student.countDocuments({ schoolId: A });
  const inClass3  = await Student.countDocuments({ schoolId: A, classId: "cls-3" });

  // The roster fetches every APPROVED pupil and sorts them in JS to show the
  // first fifty, so its ceiling is every pupil in the school — a count taken
  // without the status filter, which is what keeps this from being circular.
  // If it ever exceeds that, the filter has widened past the school.
  await bounded("the whole roster, fetched and sorted the way the endpoint does",
    async () => {
      const rows = await Student.find({ schoolId: A, status: "approved" }).lean();
      rows.sort((a, b) =>
        String(a.studentName ?? "").toLowerCase()
          .localeCompare(String(b.studentName ?? "").toLowerCase()));
      return rows;
    },
    { atMost: inSchoolA, because: `every pupil in the school (${inSchoolA})` });

  // One row per pupil in the class per subject, and no more. More than that is
  // a fan-out — the classic symptom of a lookup that joins twice.
  await bounded("one class's mark sheet",
    () => StudentScore.find({ examId: "ex-1", classId: "cls-3", schoolId: A }).lean(),
    { atMost: inClass3 * SUBJECTS,
      because: `${inClass3} pupils x ${SUBJECTS} subjects` });

  // One row per pupil in the class.
  await bounded("a term's results for a class",
    () => TermResult.find({ schoolId: A, academicYear: YEAR, term: 1, classId: "cls-3" })
      .sort({ classPosition: 1 }).lean(),
    { atMost: inClass3, because: `${inClass3} pupils in the class` });

  // A page is a page. More than the limit means the cursor is not doing its
  // job and every sync on every device gets heavier.
  await bounded("a page of the change feed",
    () => Student.find({
      schoolId: A,
      $or: [
        { updatedAt: { $gt: new Date(0) } },
        { updatedAt: new Date(0), _id: { $gt: "st-0" } },
      ],
    }).sort({ updatedAt: 1, _id: 1 }).limit(500).lean(),
    { atMost: 500, because: "the page limit" });

  // ── One backstop, loose enough that it cannot flake ───────────────────
  //
  // Everything above is deterministic, which leaves a gap: a change that
  // makes a query pathologically slow without changing what it returns — a
  // dropped index the plan assertions somehow miss, a lock, a full sort in
  // memory. So one ceiling, and it is deliberately enormous. The worst run
  // observed while writing this was 2042 ms; ten seconds is five times that,
  // so it will not trip on a busy machine, and nothing that trips it is
  // anything but broken.
  {
    const CEILING_MS = 10_000;
    const { median, worst } = await measured(
      () => Student.find({ schoolId: A, status: "approved" }).lean()
    );
    if (worst <= CEILING_MS) {
      ok(`nothing is pathologically slow (worst ${worst} ms, ceiling ${CEILING_MS})`);
    } else {
      bad(`the roster query completes within ${CEILING_MS} ms`,
        `median ${median} ms, worst ${worst} ms. This ceiling is five times the\n` +
        `slowest run seen on a loaded machine, so this is not noise.`);
    }
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
