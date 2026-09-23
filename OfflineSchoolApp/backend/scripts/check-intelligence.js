// backend/scripts/check-intelligence.js
"use strict";

/**
 * The deterministic student intelligence layer, pinned.
 *
 * ── The four faults this exists to prevent ────────────────────────────────
 *
 * CONTINUOUS ASSESSMENT COUNTED TWICE. A sequence is two exams — the paper and
 * its CA — and processing either one writes a ResultSummary. Nothing stops a
 * school publishing both. A reader that does not filter the CA out compares one
 * half of a sequence against the other and reports the difference as a change
 * in the child. The watch list did exactly that; section 3 below fails if it
 * ever does again.
 *
 * CHRONOLOGY READ OFF createdAt. Recompute Sequence 1 after a mark correction
 * and its row becomes the newest in the collection while remaining the oldest
 * event in the year. "The last two results" then compares Sequence 1 against
 * Sequence 3 and reports a decline as an improvement. Section 4 builds exactly
 * that data and asserts the direction.
 *
 * A CLAIM FROM ONE BAD AFTERNOON. The whole product rests on a school being
 * able to trust that "persistent" means persistent. Section 5 gives a pupil one
 * poor result after a good one and asserts that nothing persistent is claimed
 * and nothing is called strong evidence.
 *
 * MONEY IN THE STAFFROOM. insights.view names children by fee arrears and is
 * office-only for that reason. The teacher routes must carry none of it — not
 * filtered at the edge, but absent because the module cannot reach it. Section
 * 7 asserts that by reading the require graph, and section 8 by reading every
 * key of an actual teacher response.
 *
 *   node scripts/check-intelligence.js
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

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures shared by the database sections
// ─────────────────────────────────────────────────────────────────────────────

const A = "68d0000000000000000000a1";   // Alpha Academy
const B = "68d0000000000000000000b2";   // Beta College
const YEAR = "2026-2027";

/** A day string N days ago, in the form the register and homework both use. */
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

const breakdown = (rows) => rows.map(([subjectId, subjectName, normalizedMark, extra = {}]) => ({
  subjectId, subjectName, normalizedMark,
  score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null,
  isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false,
  ...extra,
}));

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Subject           = mongoose.model("Subject");
  const Student           = mongoose.model("Student");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Exam              = mongoose.model("Exam");
  const ResultSummary     = mongoose.model("ResultSummary");
  const Register          = mongoose.model("StudentAttendance");
  const Homework          = mongoose.model("Homework");
  const AcademicStructure = mongoose.model("AcademicStructure");

  const academicHistory = require(path.join(SRC, "services/intelligence/academicHistory.service"));
  const engine          = require(path.join(SRC, "services/intelligence/subjectInsights.service"));
  const earlyWarning    = require(path.join(SRC, "services/earlyWarning.service"));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. measurement: the arithmetic, without a database ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const occ = (term, sequence) => ({
    academicYear: YEAR, term, sequence, startDate: "", createdAt: 0, examId: "",
  });
  /** A subject series from a list of marks, one per sequence, oldest first. */
  const series = (marks, name = "Mathematics") => ({
    subjectId: "subj", subjectName: name,
    points: marks.map((mark, i) => ({
      occurrence: occ(1 + Math.floor(i / 2), (i % 2) + 1),
      mark, grade: null, isPassing: mark >= 10, coefficient: 1,
      caMark: null, testMark: null,
    })),
  });
  // The grading context a school on the shipped defaults resolves to. Passed
  // explicitly here so the arithmetic can be exercised without a database; the
  // database sections below prove that a real school resolves to exactly this.
  const GRADING = { scale: 20, passMark: 10, strongMark: 14 };
  const metrics  = (marks) => engine.metricsFor(series(marks), GRADING);
  const codesFor = (marks) => engine.insightsFor(metrics(marks), GRADING)
    .map((i) => [i.code, i.confidence]);

  const m = metrics([12, 14, 16, 18]);
  check("the recent half is the later ceil(n/2) marks", m.recentAverage, 17);
  check("and the earlier half the rest",                m.priorAverage,  13);
  check("change is recent minus earlier",               m.delta,          4);
  check("spread is highest minus lowest",               m.spread,         6);
  check("steps are sequence to sequence",               m.steps,     [2, 2, 2]);

  // A pupil who did not sit a paper did not score nothing in it. Averaging the
  // absence as a zero would invent a collapse in a subject that never happened,
  // which is the same distinction shared/caAssessment.js makes about a missing
  // CA — and the authoritative breakdown already flags it.
  const withAbsence = engine.seriesFrom([
    { occurrence: occ(1, 1), subjectBreakdown: [
      { subjectId: "maths",   subjectName: "Mathematics", normalizedMark: 16, isAbsent: false },
      { subjectId: "physics", subjectName: "Physics",     normalizedMark: 0,  isAbsent: true  },
    ] },
    { occurrence: occ(1, 2), subjectBreakdown: [
      { subjectId: "maths",   subjectName: "Mathematics", normalizedMark: 14, isAbsent: false },
      { subjectId: "physics", subjectName: "Physics",     normalizedMark: 12, isAbsent: false },
    ] },
  ]);
  check("a sequence the pupil was absent for is left out, not counted as zero",
    withAbsence.get("physics").points.map((p) => p.mark), [12]);
  check("and the marks they did sit are kept in the order they were sat",
    withAbsence.get("maths").points.map((p) => p.mark), [16, 14]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. insights: strength, improvement, decline, and silence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("consistently high marks → strength, and consistency, both established",
    codesFor([16, 17, 17]),
    [["subject_strength", "strong"], ["consistency_strength", "strong"]]);

  check("a climb from failing to strong → sustained improvement, established",
    codesFor([9, 11, 14, 16]),
    [["subject_strength", "emerging"], ["sustained_improvement", "strong"]]);

  check("a steady slide → decline, and NOT also a sudden change",
    codesFor([16, 15, 11, 8]), [["academic_decline", "strong"]]);

  check("a sharp fall in the latest sequence → a sudden change as well",
    codesFor([16, 16, 16, 9]),
    [["academic_decline", "strong"], ["sudden_performance_change", "strong"]]);

  // 18, 9, 18: the pupil finished exactly where they started. Neither risk may
  // fire — the fall is over — and the strength that does fire is offered as
  // emerging, because two marks out of three is not a record you would bet on.
  check("a sharp fall that was recovered is neither a decline nor a sudden change",
    codesFor([18, 9, 18]).map(([code]) => code)
      .filter((c) => c === "academic_decline" || c === "sudden_performance_change"), []);
  check("and the strength it does show is emerging, not established",
    codesFor([18, 9, 18]), [["subject_strength", "emerging"]]);

  check("three marks, most below the pass mark → persistent underperformance",
    codesFor([7, 8, 6]),
    [["persistent_underperformance", "strong"]]);

  check("a high average that swings wildly is NOT called consistently strong",
    codesFor([17, 9, 17, 9]).map(([code]) => code).includes("consistency_strength"), false);

  check("one mark, however high, says nothing at all",
    codesFor([18]), []);

  const insufficient = metrics([18]);
  check("and the measurement still reports what little there is",
    [insufficient.observations, insufficient.overallAverage, insufficient.consistency],
    [1, 18, null]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. weak evidence: one poor result is not a pattern ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const isolated = codesFor([15, 6]);
  check("a good mark then a poor one raises no PERSISTENT claim",
    isolated.map(([code]) => code).includes("persistent_underperformance"), false);
  check("what it does raise is offered as emerging, never established",
    isolated.every(([, confidence]) => confidence === "emerging"), true);
  check("and it is the decline and the single drop, nothing invented",
    isolated.map(([code]) => code), ["academic_decline", "sudden_performance_change"]);

  check("below the minimum observations nothing is claimed in either direction",
    engine.confidenceFrom({ observations: 1, unanimous: true }), "insufficient");
  check("a pattern present throughout three occasions may be called established",
    engine.confidenceFrom({ observations: 3, unanimous: true }), "strong");
  check("the same three occasions with the pattern only partly present may not",
    engine.confidenceFrom({ observations: 3, unanimous: false }), "emerging");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. cross-subject strength names subjects and nothing else ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const strongIn = (id, name) => engine.insightsFor(
    engine.metricsFor({
      subjectId: id, subjectName: name,
      points: [16, 17, 17].map((mark, i) => ({
        occurrence: occ(1, i + 1), mark, grade: null, isPassing: true,
        coefficient: 1, caMark: null, testMark: null,
      })),
    }, GRADING), GRADING);

  const threeStrong = [
    ...strongIn("s1", "Mathematics"),
    ...strongIn("s2", "Physics"),
    ...strongIn("s3", "ICT"),
  ];
  const cross = engine.crossSubjectStrength(threeStrong);
  check("three strong subjects group into one statement",
    [cross.code, cross.confidence, cross.subjects.map((s) => s.subjectName)],
    ["cross_subject_strength", "strong", ["Mathematics", "Physics", "ICT"]]);
  check("and it carries no domain, cluster or career field",
    Object.keys(cross).filter((k) => /domain|cluster|career|pathway/i.test(k)), []);
  check("two strong subjects are not yet a group",
    engine.crossSubjectStrength(threeStrong.filter((i) => i.subjectId !== "s3")), null);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. the school, the classes, the pupils ---");
  // ═══════════════════════════════════════════════════════════════════════════

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  await AcademicStructure.create({
    schoolId: A, academicYear: YEAR, passMark: 10,
    terms: [{ number: 1, name: "First Term", weight: 50, sequences: [
      { number: 1, name: "First Sequence",  weight: 50 },
      { number: 2, name: "Second Sequence", weight: 50 },
    ] }],
  });

  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`,
    password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a", "teacher", A),
    mkUser("admin-a", "school_admin", A),
  ]);

  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths",   schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "physics", schoolId: A, name: "Physics",     classId: "form3a" },
  ]);
  // teach-a takes Mathematics in 3A, and nothing in 4B.
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
  ]);

  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `${n}`,
    isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st-ca",      A, "form3a", "Ca"),
    pupil("st-chrono",  A, "form3a", "Chrono"),
    pupil("st-watch",   A, "form3a", "Watch"),
    pupil("st-strong",  A, "form3a", "Strong"),
    pupil("st-other",   A, "form4b", "Other"),
    pupil("st-b1",      B, "form1b", "Beta"),
  ]);

  const mkExam = (id, { type = "test", term = 1, sequenceNumber = 1, parentExamId = null }) => ({
    _id: id, schoolId: A, name: id, type, academicYear: YEAR, term,
    sequenceNumber, parentExamId, classId: "form3a",
    totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
  });
  await Exam.create([
    mkExam("ex-s1",   { sequenceNumber: 1, term: 1 }),
    mkExam("ex-s1ca", { sequenceNumber: 1, term: 1, type: "ca", parentExamId: "ex-s1" }),
    mkExam("ex-s2",   { sequenceNumber: 2, term: 1 }),
    mkExam("ex-s3",   { sequenceNumber: 1, term: 2 }),
  ]);

  const summary = (id, examId, studentId, fields) => ({
    _id: id, examId, studentId, classId: "form3a", schoolId: A,
    academicYear: YEAR, term: "1", isPublished: true,
    subjectsFailed: 0, isPassing: true, subjectBreakdown: [],
    ...fields,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. continuous assessment is not a second sequence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * st-ca sat Sequence 1 (80%) and Sequence 2 (78%) and did NOT decline. The
   * school also processed and published the CA exam attached to Sequence 1, on
   * which the pupil scored 40% and did not pass.
   *
   * createdAt is arranged so that a reader ordering by it sees the CA last:
   * that reader reports a 38-point drop and a failed exam, both of which are
   * statements about a bookkeeping artefact rather than about the child.
   */
  await ResultSummary.create([
    summary("sum-ca-s1", "ex-s1", "st-ca",
      { percentage: 80, isPassing: true,  createdAt: new Date("2026-10-01") }),
    summary("sum-ca-s2", "ex-s2", "st-ca",
      { percentage: 78, isPassing: true,  createdAt: new Date("2026-11-01") }),
    summary("sum-ca-ca", "ex-s1ca", "st-ca",
      { percentage: 40, isPassing: false, createdAt: new Date("2026-12-01") }),
  ]);

  const caHistory = await academicHistory.publishedHistory({ schoolId: A, studentIds: ["st-ca"] });
  check("the CA summary is left out of the pupil's history",
    (caHistory.get("st-ca") ?? []).map((s) => s.examId), ["ex-s1", "ex-s2"]);

  const caWatch = await earlyWarning.watchlist({ schoolId: A, days: 30 });
  const caRow = caWatch.students.find((s) => s.studentId === "st-ca");
  check("so the watch list reports no drop between the halves of one sequence",
    (caRow?.signals ?? []).map((s) => s.code).filter((c) => c === "grade_drop"), []);
  check("and does not report the CA as a failed exam",
    (caRow?.signals ?? []).map((s) => s.code).filter((c) => c === "failed_exam"), []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. chronology is academic order, not row age ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * st-chrono scored 70 in Sequence 1 and 55 in Sequence 2 — a fifteen-point
   * fall. Sequence 1 was recomputed after a mark correction, so its ROW is the
   * newer of the two. Ordered by createdAt the pupil appears to have improved
   * from 55 to 70 and no signal fires at all.
   */
  await ResultSummary.create([
    summary("sum-ch-s2", "ex-s2", "st-chrono",
      { percentage: 55, isPassing: true, createdAt: new Date("2026-11-01") }),
    summary("sum-ch-s1", "ex-s1", "st-chrono",
      { percentage: 70, isPassing: true, createdAt: new Date("2026-12-20") }),
  ]);

  const chHistory = await academicHistory.publishedHistory({ schoolId: A, studentIds: ["st-chrono"] });
  check("the history is ordered by year, term and sequence",
    (chHistory.get("st-chrono") ?? []).map((s) => s.examId), ["ex-s1", "ex-s2"]);

  const chWatch = await earlyWarning.watchlist({ schoolId: A, days: 30 });
  const chDrop = (chWatch.students.find((s) => s.studentId === "st-chrono")?.signals ?? [])
    .find((s) => s.code === "grade_drop");
  check("so the fall is seen, and in the right direction",
    [chDrop?.data?.from, chDrop?.data?.to], [70, 55]);

  check("an exam with no sequence number sorts after the numbered ones in its term",
    academicHistory.byOccurrence(
      { occurrence: { academicYear: YEAR, term: 1, sequence: 2, startDate: "", createdAt: 0, examId: "a" } },
      { occurrence: { academicYear: YEAR, term: 1, sequence: academicHistory.UNSEQUENCED, startDate: "", createdAt: 0, examId: "b" } },
    ) < 0, true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. the watch list still says what it always said ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * st-watch: five absences in twenty marked days (25%, the middle band, two
   * points), both pieces of homework missed (two points) and a failed latest
   * result (two points). Six points is the high tier.
   */
  const register = [];
  for (let i = 1; i <= 20; i += 1) {
    register.push({
      schoolId: A, classId: "form3a", studentId: "st-watch", markedBy: "admin-a",
      date: daysAgo(i), status: i <= 5 ? "absent" : "present",
    });
  }
  await Register.create(register);
  await Homework.create([
    { schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a",
      title: "Algebra", dueDate: daysAgo(5),  isPublished: true, submissions: [] },
    { schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a",
      title: "Geometry", dueDate: daysAgo(2), isPublished: true, submissions: [] },
  ]);
  await ResultSummary.create([
    summary("sum-w-s1", "ex-s1", "st-watch", { percentage: 44, isPassing: false }),
  ]);

  const watch = await earlyWarning.watchlist({ schoolId: A, days: 30 });
  const watchRow = watch.students.find((s) => s.studentId === "st-watch");
  check("the signals, their codes and their points are unchanged",
    (watchRow?.signals ?? []).map((s) => [s.code, s.points]),
    [["absence", 2], ["failed_exam", 2], ["missing_homework", 2]]);
  check("the absence signal still carries the numbers behind it",
    watchRow?.signals?.[0]?.data, { absent: 5, marked: 20, days: 30 });
  check("the score and tier are unchanged",
    [watchRow?.score, watchRow?.tier], [6, "high"]);
  check("the response still carries its counts and window",
    [typeof watch.counts.high, watch.windowDays, watch.counts.students],
    ["number", 30, 5]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. subject intelligence over real published results ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * st-strong: Mathematics 16, 17, 17 across three sequences; Physics 15, 11, 8.
   * One subject should read as an established strength, the other as a decline,
   * from the same three rows.
   */
  await ResultSummary.create([
    summary("sum-s-s1", "ex-s1", "st-strong", {
      percentage: 78, subjectBreakdown: breakdown([
        ["maths", "Mathematics", 16], ["physics", "Physics", 15]]),
    }),
    summary("sum-s-s2", "ex-s2", "st-strong", {
      percentage: 72, subjectBreakdown: breakdown([
        ["maths", "Mathematics", 17], ["physics", "Physics", 11]]),
    }),
    summary("sum-s-s3", "ex-s3", "st-strong", {
      term: "2", percentage: 65, subjectBreakdown: breakdown([
        ["maths", "Mathematics", 17],
        ["physics", "Physics", 8, { isPassing: false }]]),
    }),
  ]);

  const profile = await engine.profileFor({ schoolId: A, studentId: "st-strong" });
  check("three sequences and two subjects were seen",
    [profile.coverage.sequences, profile.coverage.subjects, profile.coverage.sufficient],
    [3, 2, true]);
  check("the engine reports the thresholds it used",
    [profile.engine.passMark, profile.engine.strongMark, profile.engine.scale],
    [10, 14, 20]);
  check("Mathematics reads as an established strength",
    profile.insights
      .filter((i) => i.subjectId === "maths")
      .map((i) => [i.code, i.confidence]),
    [["subject_strength", "strong"], ["consistency_strength", "strong"]]);
  check("Physics, from the same rows, reads as a decline",
    profile.insights
      .filter((i) => i.subjectId === "physics")
      .map((i) => [i.code, i.confidence]),
    [["academic_decline", "strong"]]);

  const strength = profile.insights.find((i) => i.code === "subject_strength");
  check("and the strength carries the evidence behind it, not an adjective",
    strength.evidence.map((e) => e.metric),
    ["observations", "recent_average", "previous_average", "overall_average",
     "latest_mark", "consistency", "strong_mark_threshold", "marks_at_or_above_threshold"]);
  check("with the marks on the twenty-point scale the report card uses",
    [strength.evidence.find((e) => e.metric === "recent_average").value,
     strength.evidence.find((e) => e.metric === "recent_average").scale],
    [17, 20]);
  check("the underlying marks are inspectable, sequence by sequence",
    profile.subjects.find((s) => s.subjectId === "maths").marks.map((mk) => [mk.term, mk.sequence, mk.mark]),
    [[1, 1, 16], [1, 2, 17], [2, 1, 17]]);

  const nothingKnown = await engine.profileFor({ schoolId: A, studentId: "st-other" });
  check("a pupil with no published results yields no claims and says so",
    [nothingKnown.insights, nothingKnown.coverage.sufficient], [[], false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. money cannot reach the teacher surface ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * Asserted on the require graph rather than on a payload, because a payload
   * check passes for as long as nobody adds the field. A module that cannot
   * reach fees.service cannot leak a balance by accident later.
   */
  const graphOf = (entry) => {
    const id = require.resolve(entry);
    require(entry);
    const seen = new Set();
    const walk = (moduleId) => {
      if (seen.has(moduleId)) return;
      seen.add(moduleId);
      for (const child of require.cache[moduleId]?.children ?? []) walk(child.id);
    };
    walk(id);
    return [...seen];
  };
  const MONEY_MODULE = /(fees|finance|financeReports|payroll|feeReminders)\.service\.js$/i;

  check("the subject intelligence module cannot reach the fee ledger",
    graphOf(path.join(SRC, "services/intelligence/subjectInsights.service")).filter((f) => MONEY_MODULE.test(f)),
    []);
  check("nor can the history loader it reads through",
    graphOf(path.join(SRC, "services/intelligence/academicHistory.service")).filter((f) => MONEY_MODULE.test(f)),
    []);
  check("while the office watch list still does — the separation is structural",
    graphOf(path.join(SRC, "services/earlyWarning.service")).some((f) => MONEY_MODULE.test(f)),
    true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 11. teacher authorisation over the routes ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return async (url) => {
      const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
      let body = {}; try { body = await res.json(); } catch { /* empty body */ }
      return { status: res.status, body };
    };
  };
  const teacher = as("teach-a", "teacher", A);
  const admin   = as("admin-a", "school_admin", A);

  let r = await teacher("/insights/student/st-strong");
  check("a teacher reads a pupil in the class they teach → 200",
    [r.status, r.body?.data?.studentId], [200, "st-strong"]);

  r = await teacher("/insights/student/st-other");
  check("a pupil in a class they do not teach → 403 CLASS_NOT_ASSIGNED",
    [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);

  r = await teacher("/insights/student/st-b1");
  check("a pupil in another school → 404, never a hint that the id exists",
    r.status, 404);

  r = await teacher("/insights/class/form3a");
  check("their own class list → 200, with every approved pupil in it",
    [r.status, r.body?.data?.students?.length], [200, 4]);

  r = await teacher("/insights/class/form4b");
  check("somebody else's class list → 403", r.status, 403);

  r = await teacher("/insights/early-warning");
  check("and the office watch list stays shut to them → 403",
    [r.status, r.body?.permission], [403, "insights.view"]);

  r = await admin("/insights/early-warning");
  check("while the office still reads it → 200", r.status, 200);

  r = await admin("/insights/student/st-strong");
  check("and the office reads subject intelligence too → 200", r.status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 12. nothing financial in what a teacher receives ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const MONEY_WORD = /balance|fee|arrear|owed|owing|debt|invoice|receipt|payment|paid|charge|waive|amount|currency|xaf|cfa/i;
  const offending = (node, trail = "$") => {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) return node.flatMap((v, i) => offending(v, `${trail}[${i}]`));
    if (typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) =>
        (MONEY_WORD.test(k) ? [`${trail}.${k}`] : []).concat(offending(v, `${trail}.${k}`)));
    }
    return typeof node === "string" && MONEY_WORD.test(node) ? [`${trail} = ${node}`] : [];
  };

  const pupilPayload = (await teacher("/insights/student/st-strong")).body;
  const classPayload = (await teacher("/insights/class/form3a")).body;
  check("the pupil profile carries no financial key or value",
    offending(pupilPayload), []);
  check("nor does the class list", offending(classPayload), []);

  // And the office list, by contrast, is allowed to — that is what makes it
  // office-only. Asserted so that "no money anywhere" is not mistaken for the
  // rule, which would make the watch list wrong instead.
  check("the office watch list is still built from the fee ledger among others",
    Object.keys(earlyWarning.THRESHOLDS).includes("feeRatio"), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 13. zero, blank, absent and exempt are four different facts ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * Run the REAL grading pipeline rather than hand-writing a breakdown, because
   * the question is what results.service actually stores — and the intelligence
   * layer's whole contract is that it reads that and does not second-guess it.
   *
   * st-cases sits one sequence in three subjects: a genuine zero in Mathematics,
   * an absence in Physics, an exemption in ICT.
   */
  const ExamSubject  = mongoose.model("ExamSubject");
  const StudentScore = mongoose.model("StudentScore");
  const resultsService = require(path.join(SRC, "services/results.service"));

  await Student.create([pupil("st-cases", A, "form3a", "Cases")]);
  await Subject.create([{ _id: "ict", schoolId: A, name: "ICT", classId: "form3a" }]);
  await Exam.create([mkExam("ex-cases", { sequenceNumber: 2, term: 2 })]);
  await ExamSubject.create([
    { _id: "es-c-m", examId: "ex-cases", subjectId: "maths",   classId: "form3a", schoolId: A, subjectName: "Mathematics", maxScore: 20, submissionStatus: "approved" },
    { _id: "es-c-p", examId: "ex-cases", subjectId: "physics", classId: "form3a", schoolId: A, subjectName: "Physics",     maxScore: 20, submissionStatus: "approved" },
    { _id: "es-c-i", examId: "ex-cases", subjectId: "ict",     classId: "form3a", schoolId: A, subjectName: "ICT",         maxScore: 20, submissionStatus: "approved" },
  ]);
  await StudentScore.create([
    { examId: "ex-cases", examSubjectId: "es-c-m", studentId: "st-cases", subjectId: "maths",
      classId: "form3a", schoolId: A, score: 0, maxScore: 20 },
    { examId: "ex-cases", examSubjectId: "es-c-p", studentId: "st-cases", subjectId: "physics",
      classId: "form3a", schoolId: A, score: null, maxScore: 20, isAbsent: true },
    { examId: "ex-cases", examSubjectId: "es-c-i", studentId: "st-cases", subjectId: "ict",
      classId: "form3a", schoolId: A, score: null, maxScore: 20, isExempt: true },
  ]);
  await resultsService.processResults("ex-cases", "form3a");
  await resultsService.publishResults("ex-cases", "form3a");

  const casesRow = await ResultSummary.findOne({ examId: "ex-cases", studentId: "st-cases" }).lean();
  const bySubject = new Map((casesRow?.subjectBreakdown ?? []).map((b) => [b.subjectId, b]));
  check("a genuine zero is stored as a graded mark of zero",
    [bySubject.get("maths")?.normalizedMark, bySubject.get("maths")?.isAbsent,
     bySubject.get("maths")?.isExempt,       bySubject.get("maths")?.grade],
    [0, false, false, "F"]);
  check("an absence is stored flagged, with no score behind it",
    [bySubject.get("physics")?.score, bySubject.get("physics")?.isAbsent,
     bySubject.get("physics")?.grade],
    [null, true, "AB"]);
  check("an exemption is stored flagged and distinct from an absence",
    [bySubject.get("ict")?.score, bySubject.get("ict")?.isExempt,
     bySubject.get("ict")?.grade],
    [null, true, "EX"]);

  const casesProfile = await engine.profileFor({ schoolId: A, studentId: "st-cases" });
  check("intelligence keeps the genuine zero — it is a mark the pupil earned",
    casesProfile.subjects.map((s) => [s.subjectId, s.marks.map((mk) => mk.mark)]),
    [["maths", [0]]]);
  check("and drops the absence and the exemption, rather than averaging them as zeros",
    casesProfile.subjects.map((s) => s.subjectId).filter((id) => id !== "maths"), []);
  check("one mark is still not enough to claim anything about the pupil",
    [casesProfile.insights, casesProfile.coverage.sufficient], [[], false]);

  // ── The blank mark, at the door ─────────────────────────────────────────
  /*
   * Both write paths must refuse a present pupil with no mark. The bulk sheet
   * always did. POST /results/score did not, and a body with no score stored
   * score: null with isAbsent false — which processResults turns into a real
   * zero that nothing downstream can tell from an earned one.
   */
  app.use("/api/results", auth.authenticate, require(path.join(SRC, "routes/results.routes")));

  const post = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return async (url, payload) => {
      const res = await fetch(`${API}${url}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify(payload),
      });
      let body = {}; try { body = await res.json(); } catch { /* empty body */ }
      return { status: res.status, body };
    };
  };
  const adminPost = post("admin-a", "school_admin", A);
  await Exam.create([mkExam("ex-entry", { sequenceNumber: 3, term: 2 })]);
  await ExamSubject.create([
    { _id: "es-e-m", examId: "ex-entry", subjectId: "maths", classId: "form3a",
      schoolId: A, subjectName: "Mathematics", maxScore: 20 },
  ]);
  const markBody = (extra) => ({
    examId: "ex-entry", studentId: "st-cases", subjectId: "maths",
    classId: "form3a", schoolId: A, ...extra,
  });

  r = await adminPost("/results/score", markBody({}));
  check("a mark sheet row with no score at all → 400 SCORE_REQUIRED",
    [r.status, r.body?.code], [400, "SCORE_REQUIRED"]);
  check("and nothing was written",
    await StudentScore.countDocuments({ examId: "ex-entry" }), 0);

  r = await adminPost("/results/score", markBody({ score: null }));
  check("an explicit null score is refused too", r.status, 400);
  r = await adminPost("/results/score", markBody({ score: 25, maxScore: 20 }));
  check("and a mark above the subject ceiling", r.status, 400);

  r = await adminPost("/results/score", markBody({ isAbsent: true }));
  check("recording the pupil ABSENT with no score is how a blank is expressed → 200/201",
    r.status === 200 || r.status === 201, true);
  const absentRow = await StudentScore.findOne({ examId: "ex-entry", studentId: "st-cases" }).lean();
  check("and that row carries the flag and no score",
    [absentRow?.score, absentRow?.isAbsent], [null, true]);

  // A different pupil, because this endpoint's update branch keeps whatever
  // isAbsent the row already had unless the body overrides it — posting a
  // score over an absence would leave both set.
  r = await adminPost("/results/score",
    { ...markBody({ score: 0 }), studentId: "st-watch" });
  check("a genuine zero is still accepted", r.status === 200 || r.status === 201, true);
  const zeroRow = await StudentScore.findOne({ examId: "ex-entry", studentId: "st-watch" }).lean();
  check("and is stored as a zero, not as a null",
    [zeroRow?.score, zeroRow?.isAbsent], [0, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 14. the strength threshold lands on the school's own bands ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const GradingConfigModel = mongoose.model("GradingConfig");

  const alpha = await engine.gradingContextFor(A);
  check("a school that has configured nothing gets the shipped bands' Good floor",
    [alpha.passMark, alpha.passMarkSource, alpha.strongMark, alpha.strongBand, alpha.strongMarkBasis],
    [10, "academicStructure", 14, "B+", "default_grade_band"]);
  check("and the engine's own heuristic is reported beside it",
    alpha.heuristicStrongMark, 14);

  // A school whose own table steps at 15. On its report card a 14 is a pass,
  // not a distinction — so the engine must not call it a strength.
  await GradingConfigModel.create({
    schoolId: "sch-custom", passMark: 12,
    grades: [
      { grade: "Distinction", minMark: 18, maxMark: 20 },
      { grade: "Merit",       minMark: 15, maxMark: 18 },
      { grade: "Pass",        minMark: 12, maxMark: 15 },
      { grade: "Fail",        minMark:  0, maxMark: 12 },
    ],
  });
  const custom = await engine.gradingContextFor("sch-custom");
  check("a school with its own bands gets its own floor, and its own pass mark",
    [custom.passMark, custom.passMarkSource, custom.strongMark, custom.strongBand, custom.strongMarkBasis],
    [12, "gradingConfig", 15, "Merit", "school_grade_band"]);

  const midMarks = [14, 15, 14];
  check("14, 15, 14 is a strength on the shipped scale",
    engine.insightsFor(engine.metricsFor(series(midMarks), alpha), alpha)
      .map((i) => i.code), ["subject_strength", "consistency_strength"]);
  check("and is no kind of strength at the school whose own bands step at 15",
    engine.insightsFor(engine.metricsFor(series(midMarks), custom), custom)
      .map((i) => i.code), []);
  check("the same marks, the same engine — only the school's bands differ",
    [engine.metricsFor(series(midMarks), alpha).overallAverage,
     engine.metricsFor(series(midMarks), custom).overallAverage],
    [14.3, 14.3]);

  // A pass mark above the heuristic. A threshold at or below the pass mark
  // would call a barely-passing mark a strength.
  await GradingConfigModel.create({ schoolId: "sch-strict", passMark: 16 });
  const strict = await engine.gradingContextFor("sch-strict");
  check("a pass mark above the heuristic pushes the threshold to the next band up",
    [strict.passMark, strict.strongMark, strict.strongBand], [16, 18, "A+"]);

  // Bands stored on a /100 scale, which findBand deliberately permits. Snapping
  // onto them would produce a threshold no /20 subject mark could ever reach.
  await GradingConfigModel.create({
    schoolId: "sch-hundred", passMark: 10,
    grades: [
      { grade: "A", minMark: 80, maxMark: 100 },
      { grade: "B", minMark: 60, maxMark:  80 },
      { grade: "F", minMark:  0, maxMark:  60 },
    ],
  });
  const hundred = await engine.gradingContextFor("sch-hundred");
  check("bands outside the /20 scale are declined, and the engine keeps its own number",
    [hundred.strongMark, hundred.strongBand, hundred.strongMarkBasis],
    [14, null, "engine_heuristic"]);

  check("no configuration anywhere made the engine change a grade",
    (await ResultSummary.findOne({ examId: "ex-cases", studentId: "st-cases" }).lean())
      ?.subjectBreakdown?.find((b) => b.subjectId === "maths")?.grade,
    "F");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
