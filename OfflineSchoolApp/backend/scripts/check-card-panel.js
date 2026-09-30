// backend/scripts/check-card-panel.js
//
// The information panel under the marks: the figures have to be the school's
// own, over the right period, for the right class.
//
// Three things this suite is here to catch, all of which the card did before:
//
//   1. A class average computed a second time inside the card, drifting from
//      the one the statistics page shows for the same exam.
//   2. A figure gathered across a whole school, a whole year, or another
//      school's pupils, because the query forgot a scope.
//   3. A subject printed against the class teacher rather than the teacher
//      actually assigned to teach it, or a total added up from what the page
//      displays instead of from the marks behind it.
//
// Real records throughout: a seeded class with known marks and known teacher
// assignments, read back through the real routes.
//
//   node scripts/check-card-panel.js
"use strict";

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
  const School        = mongoose.model("School");
  const User          = mongoose.model("User");
  const Student       = mongoose.model("Student");
  const Class         = mongoose.model("Class");
  const Subject       = mongoose.model("Subject");
  const Exam          = mongoose.model("Exam");
  const ExamSubject   = mongoose.model("ExamSubject");
  const StudentScore  = mongoose.model("StudentScore");
  const ResultSummary = mongoose.model("ResultSummary");
  const TermResult    = mongoose.model("TermResult");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const AcademicStructure = mongoose.model("AcademicStructure");
  const AnnualResult  = mongoose.model("AnnualResult");
  const { StudentAttendance } = require(path.join(SRC, "db/models/Attendance"));

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const YEAR = "2026/2027";

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const PASSWORD = "Check-only-passw0rd";
  await User.create([
    { _id: "admin-a", name: "Admin A", email: "a@example.test", password: PASSWORD, role: "school_admin", schoolId: A, isActive: true },
    { _id: "admin-b", name: "Admin B", email: "b@example.test", password: PASSWORD, role: "school_admin", schoolId: B, isActive: true },
    { _id: "marker",  name: "Marker",  email: "m@example.test", password: PASSWORD, role: "teacher",      schoolId: A, isActive: true },
  ]);
  await Class.create([
    { _id: "form1",  schoolId: A, name: "Form 1"  },
    { _id: "form2",  schoolId: A, name: "Form 2"  },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create({ _id: "maths", schoolId: A, name: "Mathematics", classId: "form1" });

  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st1", A, "form1", 1), pupil("st2", A, "form1", 2), pupil("st3", A, "form1", 3),
    pupil("st9", A, "form2", 9),   // another class in the same school
    pupil("stb", B, "form1b", 1),  // another school
  ]);

  // ── The exam this card is for, and one in the same term with no dates ────
  await Exam.create([
    { _id: "ex-a", schoolId: A, name: "Sequence 1", type: "test", academicYear: YEAR,
      term: 1, sequenceNumber: 1, classId: "form1", totalMarks: 20, passMark: 10,
      startDate: "2026-09-01", endDate: "2026-09-30", status: "completed" },
    { _id: "ex-undated", schoolId: A, name: "Sequence 2", type: "test", academicYear: YEAR,
      term: 1, sequenceNumber: 2, classId: "form1", totalMarks: 20, passMark: 10, status: "completed" },
    { _id: "ex-other-class", schoolId: A, name: "Sequence 1", type: "test", academicYear: YEAR,
      term: 1, sequenceNumber: 1, classId: "form2", totalMarks: 20, passMark: 10,
      startDate: "2026-09-01", endDate: "2026-09-30", status: "completed" },
    { _id: "ex-b", schoolId: B, name: "Sequence 1", type: "test", academicYear: YEAR,
      term: 1, sequenceNumber: 1, classId: "form1b", totalMarks: 20, passMark: 10,
      startDate: "2026-09-01", endDate: "2026-09-30", status: "completed" },
  ]);
  await ExamSubject.create({ _id: "es-a", examId: "ex-a", subjectId: "maths", classId: "form1",
  // weight is the percentage-style figure the model stores: 100 = coefficient 1.
                             schoolId: A, subjectName: "Mathematics", maxScore: 20, weight: 400 });
  await StudentScore.create({
    _id: "sc-1", examId: "ex-a", examSubjectId: "es-a", subjectId: "maths", studentId: "st1",
    classId: "form1", schoolId: A, score: 14, maxScore: 20, percentage: 70, isPassing: true,
  });

  // ── The class's results: three pupils, known percentages ────────────────
  const summary = (id, studentId, pct, avg, position, extra = {}) => ({
    _id: id, examId: "ex-a", studentId, classId: "form1", schoolId: A,
    percentage: pct, average: avg, classPosition: position, totalInClass: 3,
    isPassing: pct >= 50, overallGrade: "B", isPublished: true,
    subjects: [], subjectBreakdown: [], ...extra,
  });
  await ResultSummary.create([
    // A different figure from the term average below, deliberately: the two
    // are different records at different levels, and a card must read its own.
    summary("sum-1", "st1", 70, 12.0, 1),
    summary("sum-2", "st2", 50, 10.0, 2),
    summary("sum-3", "st3", 30,  6.0, 3),
    // Another class, same school and exam-less: must not reach Form 1's panel.
    { _id: "sum-9", examId: "ex-other-class", studentId: "st9", classId: "form2", schoolId: A,
      percentage: 99, average: 19.8, classPosition: 1, totalInClass: 1, isPassing: true,
      isPublished: true, subjects: [], subjectBreakdown: [] },
    // Another school entirely.
    { _id: "sum-b", examId: "ex-b", studentId: "stb", classId: "form1b", schoolId: B,
      percentage: 5, average: 1, classPosition: 1, totalInClass: 1, isPassing: false,
      isPublished: true, subjects: [], subjectBreakdown: [] },
  ]);

  // ── The term's second sequence, so a term card has two results to show ──
  //
  // Sequence 2 is marked over the same subjects. A term card combines the
  // two sequence results; it does not go back to the CA and the paper.
  await AcademicStructure.create({ schoolId: A, academicYear: YEAR });
  await ExamSubject.create([
    { _id: "es-a2", examId: "ex-undated", subjectId: "maths", classId: "form1",
      schoolId: A, subjectName: "Mathematics", maxScore: 20, weight: 400 },
    { _id: "es-p2", examId: "ex-undated", subjectId: "physics", classId: "form1",
      schoolId: A, subjectName: "Physics", maxScore: 20, weight: 300 },
  ]);
  await StudentScore.create([
    { _id: "sc-3", examId: "ex-undated", examSubjectId: "es-a2", subjectId: "maths",
      studentId: "st1", classId: "form1", schoolId: A, score: 16, maxScore: 20,
      percentage: 80, isPassing: true },
    // Below the pass mark in both sequences: the term result fails too.
    { _id: "sc-4", examId: "ex-undated", examSubjectId: "es-p2", subjectId: "physics",
      studentId: "st1", classId: "form1", schoolId: A, score: 7, maxScore: 20,
      percentage: 35, isPassing: false },
  ]);

  // ── Who teaches what, which is not who runs the class ──────────────────
  //
  // The class teacher is Mr Kum; nobody would guess from a card that printed
  // him against Physics. TeacherAssignment is the authority, and it is what
  // the card reads.
  await Class.updateOne({ _id: "form1" }, { $set: { classTeacherName: "Mr Kum" } });
  await Subject.create({ _id: "physics", schoolId: A, name: "Physics", classId: "form1" });
  await User.create([
    { _id: "t-maths", name: "Mr Buh", email: "buh@example.test", password: PASSWORD,
      role: "teacher", schoolId: A, isActive: true },
    { _id: "t-extra", name: "Mrs Ade", email: "ade@example.test", password: PASSWORD,
      role: "teacher", schoolId: A, isActive: true },
    { _id: "t-beta",  name: "Beta Teacher", email: "bt@example.test", password: PASSWORD,
      role: "teacher", schoolId: B, isActive: true },
  ]);
  await TeacherAssignment.create([
    { _id: "ta-1", schoolId: A, teacher: "t-maths", class: "form1", subject: "maths", isActive: true },
    // A second teacher on the same subject: both names belong on the row.
    { _id: "ta-2", schoolId: A, teacher: "t-extra", class: "form1", subject: "maths", isActive: true },
    // Another school's assignment for a subject with the same id shape.
    { _id: "ta-b", schoolId: B, teacher: "t-beta",  class: "form1b", subject: "maths", isActive: true },
    // An assignment that was withdrawn: not a teacher of this subject today.
    { _id: "ta-old", schoolId: A, teacher: "t-beta", class: "form1", subject: "physics", isActive: false },
  ]);
  // Physics is on the exam and on the pupil's card, with nobody assigned to it.
  await ExamSubject.create({ _id: "es-p", examId: "ex-a", subjectId: "physics", classId: "form1",
                             schoolId: A, subjectName: "Physics", maxScore: 20, weight: 300 });
  await StudentScore.create({
    _id: "sc-2", examId: "ex-a", examSubjectId: "es-p", subjectId: "physics", studentId: "st1",
    classId: "form1", schoolId: A, score: 9, maxScore: 20, percentage: 45, isPassing: false,
  });

  // ── The real routes, behind the real door ───────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/results", auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const adminA = sign("admin-a", "school_admin", A);
  const adminB = sign("admin-b", "school_admin", B);
  const get = async (url, token = adminA) => {
    const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    let body = {}; try { body = await res.json(); } catch { /* none */ }
    if (res.status >= 500) console.log(`       (server ${res.status}: ${body.message || ""})`);
    return { status: res.status, body };
  };
  /** The value printed beside a label in the panel. */
  const cell = (html, label) => {
    const re = new RegExp(`<span class="panel-lbl">${label}</span><span class="panel-val">([^<]*)</span>`);
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- the class figures are the ones the statistics page shows ---");

  const stats = await get("/results/ex-a/stats?classId=form1");
  check("the statistics endpoint still answers as it did",
    [stats.status, stats.body.data.totalStudents, stats.body.data.average,
     stats.body.data.highest, stats.body.data.lowest],
    [200, 3, 50, 70, 30]);

  const card = await get("/results/ex-a/student/st1/reportcard/html");
  check("the card renders", [card.status, Boolean(card.body.data?.html)], [200, true]);
  const html = card.body.data?.html || "";

  // The card prints marks, not percentages: the same authoritative figures
  // the statistics page reads, on the twenty-point scale the card is marked
  // in. 70%, 50% and 30% of twenty are 14, 10 and 6.
  const marks = [70, 50, 30].map((pct) => (pct / 100) * 20);
  check("the class average on the card is a mark, over the same cohort",
    cell(html, "Class Average"),
    `${(marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(2)} /20`);
  check("  best is the highest of them", cell(html, "Best"), `${Math.max(...marks).toFixed(2)} /20`);
  check("  lowest is the lowest", cell(html, "Lowest"), `${Math.min(...marks).toFixed(2)} /20`);
  check("  and none of the three is a percentage",
    /(Class Average|Best|Lowest)<\/span><span class="panel-val">[^<]*%/.test(html), false);
  check("  nor a figure above the scale the card is marked on",
    ["Class Average", "Best", "Lowest"]
      .map((l) => Number(String(cell(html, l)).split(" ")[0]))
      .every((n) => n >= 0 && n <= 20), true);
  check("  while the statistics page keeps its own percentages",
    [stats.body.data.average, stats.body.data.highest, stats.body.data.lowest], [50, 70, 30]);
  check("  and the pupil's own rank is unchanged", cell(html, "Rank"), "1 / 3");

  // The class next door scored 99 and is not in these figures.
  check("another class in the same school is not counted",
    html.includes("99.00%"), false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- every subject names the teacher assigned to teach it ---");

  /** The teacher cell of one subject's row. */
  const teacherOf = (html, subject) => {
    const m = html.match(new RegExp(`<td>${subject}</td>\\s*<td class="teacher-cell">([^<]*)</td>`));
    return m ? m[1].trim() : null;
  };
  check("the subject's own teacher, not the class teacher",
    teacherOf(html, "Mathematics"), "Mr Buh, Mrs Ade");
  check("  a subject with nobody assigned shows the card's dash",
    teacherOf(html, "Physics"), "—");
  check("  and the class teacher is not printed against any subject",
    /teacher-cell">Mr Kum/.test(html), false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- the table ends with the totals it was averaged from ---");

  const foot = html.slice(html.indexOf("<tfoot>"), html.indexOf("</tfoot>"));
  const jsonCard = await get("/results/ex-a/student/st1/reportcard");
  const rowsOf = jsonCard.body.data?.subjects || [];
  const expectedCoeff = rowsOf.reduce((n, r) => n + Number(r.coefficient || 0), 0);
  const expectedMarks = Math.round(
    rowsOf.reduce((n, r) => n + Number(r.normalizedMark ?? r.score ?? 0) * Number(r.coefficient || 0), 0) * 100
  ) / 100;
  check("two subjects, with the coefficients their exam rows carry",
    rowsOf.map((r) => [r.subjectName, r.coefficient]).sort(),
    [["Mathematics", 4], ["Physics", 3]]);
  check("the total coefficient is the sum of the subjects'",
    foot.includes(`>${expectedCoeff}<`), true);
  check("  and the total marks the sum of mark by coefficient",
    foot.includes(`>${expectedMarks.toFixed(2)}<`), true);
  check("  which is the arithmetic, not the display",
    [expectedCoeff, expectedMarks], [7, 14 * 4 + 9 * 3]);
  check("  and the average the card prints is still its own",
    jsonCard.body.data?.computed?.weightedAverage,
    Math.round((expectedMarks / expectedCoeff) * 100) / 100);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- the decision is the stored one, in the table ---");

  check("the pupil passed, and the table says so once",
    [/status-pass[^>]*>\s*PASSED/.test(foot), (html.match(/PASSED/g) || []).length], [true, 1]);
  check("  no band of figures stands over the marks",
    [html.includes('class="summary-section"'), html.includes("verdict-pill")], [false, false]);
  check("  and the remarks are the last thing before the strip",
    html.indexOf('<div class="remark-box">') > html.indexOf("</table>"), true);

  // ════════════════════════════════════════════════════════════════════════
  console.log("\n--- nothing to report is a dash, never a zero ---");

  await ResultSummary.create(summary("sum-u1", "st1", 70, 14.0, 1, { _id: "sum-u1", examId: "ex-undated" }));
  const undated = await get("/results/ex-undated/student/st1/reportcard/html");
  const uHtml = undated.body.data?.html || "";
  check("a card for an exam of its own renders", undated.status, 200);
  // One pupil in that exam, at 70%: 14.00 out of twenty.
  check("  with the class figures it does have", cell(uHtml, "Class Average"), "14.00 /20");
  check("  and no attendance section anywhere on it",
    ["Days absent", ">Absences<", "Late Coming"].some((w) => uHtml.includes(w)), false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- the conduct rows are printed to be filled in by hand ---");

  check("work, behaviour and observation are on the card",
    ["Work", "Behaviour", "Observation"].every((w) => html.includes(`>${w}</span>`)), true);
  check("  each with an empty box, and no invented value",
    (html.match(/<span class="panel-write"><\/span>/g) || []).length, 3);
  check("  and a line saying who completes them",
    html.includes("To be completed by the classmaster"), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- one school's figures ---");

  const crossed = await get("/results/ex-a/student/st1/reportcard/html", adminB);
  check("another school's admin cannot read this card at all", crossed.status, 404);
  // Beta's own pupil scored 5%: if the card's statistics were school-blind it
  // would show as the lowest in Alpha's Form 1.
  check("and their pupil is not in Alpha's class figures", html.includes("5.00%"), false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- a term card and an annual card, on their own scale ---");

  const { buildTermCard, buildAnnualCard } = require(path.join(SRC, "services/reportCardData.service"));
  const { renderReportCardHtml } = require(path.join(SRC, "services/reportHtml.service"));

  await TermResult.create([
    { _id: "tr-1", schoolId: A, academicYear: YEAR, term: 1, classId: "form1", studentId: "st1",
      termAverage: 14, overallGrade: "B", classPosition: 1, totalInClass: 3, isPassing: true, isPublished: true },
    { _id: "tr-2", schoolId: A, academicYear: YEAR, term: 1, classId: "form1", studentId: "st2",
      termAverage: 10, overallGrade: "C", classPosition: 2, totalInClass: 3, isPassing: true, isPublished: true },
    { _id: "tr-3", schoolId: A, academicYear: YEAR, term: 1, classId: "form1", studentId: "st3",
      termAverage: 6,  overallGrade: "E", classPosition: 3, totalInClass: 3, isPassing: false, isPublished: true },
    // Another school, same year and term.
    { _id: "tr-b", schoolId: B, academicYear: YEAR, term: 1, classId: "form1b", studentId: "stb",
      termAverage: 19, overallGrade: "A", classPosition: 1, totalInClass: 1, isPassing: true, isPublished: true },
  ]);
  const termCard = await buildTermCard({ schoolId: A, academicYear: YEAR, term: 1, classId: "form1", studentId: "st1" });
  check("the term card's class figures are out of twenty, not percentages",
    [termCard.classStats.scale, termCard.classStats.average, termCard.classStats.highest, termCard.classStats.lowest],
    ["20", 10, 14, 6]);
  check("  over its own class only", termCard.classStats.count, 3);
  check("  and it carries no attendance", termCard.attendance, undefined);
  check("  its totals come from its own rows",
    [termCard.computed.totalCoefficients, termCard.computed.totalWeighted],
    [termCard.subjects.reduce((n, r) => n + Number(r.coefficient || 0), 0),
     Math.round(termCard.subjects.reduce((n, r) => n + Number(r.score || 0) * Number(r.coefficient || 0), 0) * 100) / 100]);
  check("a term card carries no promotion decision", termCard.summary.promotionStatus, null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- each card states its own level, not the one below ---");

  const mathsRow = termCard.subjects.find((r) => r.subjectName === "Mathematics");
  const physicsRow = termCard.subjects.find((r) => r.subjectName === "Physics");
  check("a term card's subject carries the term's two sequence results",
    mathsRow.sequenceMarks.map((m) => [m.number, m.mark]), [[1, 14], [2, 16]]);
  check("  and the term result they combine to, by the school's own weights",
    mathsRow.score, 15);
  check("  which is the figure the table totals",
    termCard.computed.totalWeighted,
    Math.round(termCard.subjects.reduce(
      (n, r) => n + Number(r.score) * Number(r.coefficient), 0) * 100) / 100);
  check("  never the CA and the paper, which belong to the sequence card",
    [mathsRow.caScore ?? null, mathsRow.testScore ?? null], [null, null]);
  check("the card names its sequence columns as the school's calendar does",
    termCard.sequenceColumns.map((c) => c.name), ["Sequence 1", "Sequence 2"]);

  // A subject under the school's pass mark fails on a term card exactly as
  // it does on a sequence card: the same threshold, one level up. The grade
  // band is a label, not the decision — 9/20 is a D and a fail.
  check("a term subject is judged against the school's pass mark",
    [[mathsRow.score, mathsRow.isPassing], [physicsRow.score, physicsRow.isPassing]],
    [[15, true], [8, false]]);
  const termHtml = renderReportCardHtml(termCard, { school: { name: "Alpha Academy" } });
  const physicsCells = (termHtml.match(/<tr>\s*<td>Physics<\/td>[\s\S]*?<\/tr>/) || [""])[0];
  check("  and the failed subject is printed in the card's red, as on a sequence card",
    [/color:#DC2626/.test(physicsCells), />\s*Fail\s*</.test(physicsCells)], [true, true]);
  const mathsCells = (termHtml.match(/<tr>\s*<td>Mathematics<\/td>[\s\S]*?<\/tr>/) || [""])[0];
  check("  while the one above it stays green", /color:#059669/.test(mathsCells), true);

  // The rank, the average and the grade are the term's own, from the term
  // record — not the sequence's, which is a different number for the same
  // pupil in the same class.
  check("the term card's standing is the term's",
    [termCard.summary.average, termCard.summary.classPosition, termCard.summary.overallGrade],
    [14, 1, "B"]);
  const seqCard = await get("/results/ex-a/student/st1/reportcard");
  check("  and the sequence card's is the sequence's, a different figure",
    [seqCard.body.data.summary.average !== termCard.summary.average,
     seqCard.body.data.reportType], [true, "sequence"]);
  check("a sequence card has no sequence columns of its own",
    seqCard.body.data.sequenceColumns, undefined);

  await AnnualResult.create([
    { _id: "ar-1", schoolId: A, academicYear: YEAR, classId: "form1", studentId: "st1",
      annualAverage: 13, overallGrade: "B", classPosition: 1, totalInClass: 2,
      promotionStatus: "promoted", isPassing: true, isPublished: true,
      termAverages: [{ term: 1, average: 14, overallGrade: "B", isComplete: true }] },
    { _id: "ar-2", schoolId: A, academicYear: YEAR, classId: "form1", studentId: "st2",
      annualAverage: 9, overallGrade: "D", classPosition: 2, totalInClass: 2,
      promotionStatus: "repeated", isPassing: false, isPublished: true, termAverages: [] },
  ]);
  const annualCard = await buildAnnualCard({ schoolId: A, academicYear: YEAR, classId: "form1", studentId: "st1" });
  check("the annual card's class figures come from the annual averages",
    [annualCard.classStats.scale, annualCard.classStats.average,
     annualCard.classStats.highest, annualCard.classStats.lowest, annualCard.classStats.count],
    ["20", 11, 13, 9, 2]);
  check("  and it carries no attendance either", annualCard.attendance, undefined);
  check("the annual card states the year's result, with no sequence columns",
    [annualCard.summary.average, annualCard.sequenceColumns,
     annualCard.subjects.every((r) => r.sequenceMarks === undefined)],
    [13, undefined, true]);
  check("  and its totals are of that year's subject results",
    annualCard.computed.totalWeighted,
    Math.round(annualCard.subjects.reduce(
      (n, r) => n + Number(r.score) * Number(r.coefficient), 0) * 100) / 100);
  check("the annual card keeps its own term averages",
    annualCard.annualResult?.termAverages?.[0]?.average ?? annualCard.termAverages?.[0]?.average, 14);

  console.log(`\n${pass} passed, ${fail} failed`);
  // The listening socket has to be closed, not just its connections: an open
  // server keeps the event loop alive, and a suite that prints its results
  // and then never exits stalls the whole chain behind it.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("check failed:", e); process.exit(1); });
