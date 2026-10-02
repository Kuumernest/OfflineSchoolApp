// backend/scripts/check-complexity.js
"use strict";

/**
 * The shape of the work, held: the paths docs/37 straightened must not grow
 * their query count with the school again, and must answer what they
 * answered before.
 *
 *   - competitionPlaces: the same places as counting, per pupil, every pupil
 *     strictly ahead — ties shared, a missing average placed as zero — on
 *     random lists with ties, against that very count
 *   - annual compute for a class: a constant number of queries whether the
 *     class has 5 pupils or 40; rows identical to the per-pupil function's
 *   - the two submission views: a constant number of queries whatever the
 *     number of subjects
 *   - rankings: the page is cut in the database (the query carries the limit)
 *   - staleness: the aggregation names the page's pupils
 *   - a report card: the cohort read carries the pupil's own keys, not the exam
 *   - the change feed's idle page examines no more rows than it returns, on
 *     the collections that grow with the school
 *   - the taught-class scope is read once per feed request
 *
 *   node scripts/check-complexity.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

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

  // ── 1. the places, against the count they replace ──
  console.log("\n--- competition places ---");
  const { competitionPlaces } = require(path.join(SRC, "services/termGrading.service"));
  const reference = (avgs) => avgs.map((a) => { const mine = Number(a) || 0; return avgs.filter((o) => (Number(o) || 0) > mine).length + 1; });
  let same = true; let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let t = 0; t < 200 && same; t++) {
    const n = 1 + Math.floor(rnd() * 60);
    const avgs = Array.from({ length: n }, () => { const r = rnd(); return r < 0.1 ? null : r < 0.15 ? undefined : Math.round(rnd() * 400) / 20; });
    if (JSON.stringify(competitionPlaces(avgs)) !== JSON.stringify(reference(avgs))) same = false;
  }
  check("200 random lists with ties, nulls and undefineds: the same places as the per-pupil count", same, true);
  check("a worked case: 15, 13, 13, null, 9 → 1, 2, 2, 5, 4", competitionPlaces([15, 13, 13, null, 9]), [1, 2, 2, 5, 4]);

  // ── the school ──
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { monitorCommands: true });
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const A = "68e1000000000000000000a1", YEAR = "2026-2027";
  await M("School").create({ _id: A, name: "Shape Academy", code: "SHAPE", email: "shape@example.test" });
  await M("GradingConfig").create({ schoolId: A, passMark: 10 });
  await M("AcademicStructure").create({
    schoolId: A, academicYear: YEAR,
    terms: [1, 2, 3].map((t) => ({ number: t, name: `Term ${t}`, weight: 33, sequences: [1, 2].map((q) => ({ number: q, name: `Seq ${q}`, weight: 50, assessment: { type: "test" } })) })),
    annualAverageMethod: "terms", promotionExams: [], promotionThreshold: 10, passMark: 10, maxAbsences: null,
  });
  const mk = (id, role) => M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: A, isActive: true });
  await Promise.all([mk("admin-a", "school_admin"), mk("tea-0", "teacher")]);
  // two classes: small (5) and large (40)
  const classes = [{ _id: "cls-s", schoolId: A, name: "Small" }, { _id: "cls-l", schoolId: A, name: "Large" }];
  await M("Class").create(classes);
  const SUBJ = 6;
  const subjects = [], assignments = [], students = [];
  for (const c of classes) for (let m = 0; m < SUBJ; m++) { subjects.push({ _id: `sub-${c._id}-${m}`, schoolId: A, name: `Subject ${m}`, classId: c._id }); assignments.push({ schoolId: A, teacher: "tea-0", class: c._id, subject: `sub-${c._id}-${m}` }); }
  await M("Subject").create(subjects); await M("TeacherAssignment").create(assignments);
  const sizes = { "cls-s": 5, "cls-l": 40 };
  for (const c of classes) for (let s = 0; s < sizes[c._id]; s++) students.push({ _id: `st-${c._id}-${s}`, userId: `u-${c._id}-${s}`, schoolId: A, classId: c._id, studentName: `Pupil ${c._id} ${s}`, enrollmentNo: `${c._id}-${s}`, isActive: true, status: "approved" });
  await M("Student").create(students);
  const exam = { _id: "ex-1", schoolId: A, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 1, startDate: "2026-10-05", status: "published", resultsPublished: true, classIds: ["cls-s", "cls-l"], totalMarks: 20, passMark: 10 };
  await M("Exam").create(exam);
  const es = [], scores = [], sums = [];
  for (const c of classes) for (let m = 0; m < SUBJ; m++) es.push({ _id: `es-${c._id}-${m}`, examId: "ex-1", subjectId: `sub-${c._id}-${m}`, classId: c._id, schoolId: A, subjectName: `Subject ${m}`, maxScore: 20 });
  for (const st of students) {
    const rows = [];
    for (let m = 0; m < SUBJ; m++) { const v = 5 + ((st._id.length * 3 + m * 7) % 14); scores.push({ _id: `sc-${st._id}-${m}`, examId: "ex-1", examSubjectId: `es-${st.classId}-${m}`, studentId: st._id, subjectId: `sub-${st.classId}-${m}`, classId: st.classId, schoolId: A, score: v, maxScore: 20, percentage: v * 5 }); rows.push({ subjectId: `sub-${st.classId}-${m}`, subjectName: `Subject ${m}`, normalizedMark: v, score: v, maxScore: 20, coefficient: 1, isPassing: v >= 10, isAbsent: false, isExempt: false }); }
    const avg = rows.reduce((s, r) => s + r.normalizedMark, 0) / rows.length;
    sums.push({ _id: `sum-${st._id}`, examId: "ex-1", studentId: st._id, classId: st.classId, schoolId: A, academicYear: YEAR, term: "1", average: avg, percentage: avg * 5, isPassing: avg >= 10, classPosition: 1, schoolPosition: 1, isPublished: true, subjectBreakdown: rows, studentName: st.studentName });
  }
  await M("ExamSubject").create(es); await M("StudentScore").create(scores); await M("ResultSummary").create(sums);
  // term results for the annual compute: three terms per pupil, varied
  const trs = [];
  for (const st of students) for (const t of [1, 2, 3]) trs.push({ schoolId: A, academicYear: YEAR, term: t, classId: st.classId, studentId: st._id, termAverage: 8 + ((st._id.length + t * 5) % 11), isPassing: true, isPublished: true });
  await M("TermResult").create(trs);

  // query counting
  // getMore is a cursor continuing, not another question asked of the database.
  let cmds = []; const onStart = (e) => { if (!["ping", "endSessions", "killCursors", "getMore"].includes(e.commandName)) cmds.push(e); };
  mongoose.connection.client.on("commandStarted", onStart);
  const counted = async (fn) => { cmds = []; const r = await fn(); return { r, n: cmds.length, cmds: cmds.slice() }; };

  // ── 2. annual compute: constant queries, identical rows ──
  console.log("\n--- annual compute ---");
  const annual = require(path.join(SRC, "services/annualGrading.service"));
  // One unmeasured run first: the first command on a fresh collection carries
  // mongoose's one-off work, which is not the compute's.
  await annual.computeClassAnnualAverages({ schoolId: A, academicYear: YEAR, classId: "cls-s" });
  const small = await counted(() => annual.computeClassAnnualAverages({ schoolId: A, academicYear: YEAR, classId: "cls-s" }));
  const large = await counted(() => annual.computeClassAnnualAverages({ schoolId: A, academicYear: YEAR, classId: "cls-l" }));
  check("a class of 40 takes the same number of queries as a class of 5", [small.n === large.n, small.n <= 8, small.r.computed, large.r.computed], [true, true, 5, 40]);
  if (small.n !== large.n) console.log("       small: " + small.cmds.map((c) => c.commandName).join(" ") + " | large: " + large.cmds.map((c) => c.commandName).join(" "));
  const fast = await M("AnnualResult").find({ schoolId: A, classId: "cls-l" }).sort({ studentId: 1 }).lean();
  await M("AnnualResult").deleteMany({ schoolId: A, classId: "cls-l" });
  // The pupils as stored (the schema normalises the enrolment number), which is what the class path reads.
  const storedL = await M("Student").find({ schoolId: A, classId: "cls-l" }).lean();
  for (const st of storedL) await annual.computeStudentAnnualAverage({ schoolId: A, academicYear: YEAR, classId: "cls-l", studentId: st._id, studentName: st.studentName, admissionNo: st.enrollmentNo, className: st.className || "Large" });
  await annual.computeAnnualPositions({ schoolId: A, academicYear: YEAR, classId: "cls-l" });
  const slow = await M("AnnualResult").find({ schoolId: A, classId: "cls-l" }).sort({ studentId: 1 }).lean();
  const shape = (r) => ({ s: r.studentId, avg: r.annualAverage, terms: r.termAverages.map((t) => [t.term, t.average, t.overallGrade, t.isComplete]), g: r.overallGrade, rem: r.overallRemark, p: r.promotionStatus, pass: r.isPassing, pos: r.classPosition, tot: r.totalInClass, name: r.studentName, adm: r.admissionNo, cls: r.className });
  check("the class-level compute writes exactly what the per-pupil compute wrote, pupil for pupil, place for place", fast.map(shape), slow.map(shape));

  // ── the routers ──
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express(); app.use(express.json());
  app.use("/api/exams", auth.authenticate, require(path.join(SRC, "routes/exam.routes")));
  app.use("/api/results", auth.authenticate, require(path.join(SRC, "routes/results.routes")));
  app.use("/api/term-results", auth.authenticate, require(path.join(SRC, "routes/termResults.routes")));
  app.use("/api/sync", auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0); const API = `http://127.0.0.1:${server.address().port}/api`;
  const tok = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const get = async (url, token) => { const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } }); let b = {}; try { b = await res.json(); } catch {} return { status: res.status, body: b }; };
  const ADMIN = tok("admin-a", "school_admin"), TEACHER = tok("tea-0", "teacher");

  // ── 3. submissions: one grouped count ──
  console.log("\n--- submissions ---");
  const sub = await counted(() => get("/exams/ex-1/submissions", TEACHER));
  check("twelve subjects, a constant number of queries (no count per subject)", [sub.r.status, sub.r.body.submissions.length, sub.n <= 6], [200, 12, true]);
  check("and every subject counts its marks", sub.r.body.submissions.map((x) => x.totalScoresEntered).sort((a, b) => a - b), [5, 5, 5, 5, 5, 5, 40, 40, 40, 40, 40, 40]);
  const sub2 = await counted(() => get("/exams/submissions/submissions?examId=ex-1", TEACHER));
  check("the school-wide view too", [sub2.r.body.total, sub2.n <= 6], [12, true]);

  // ── 4. rankings: the limit in the query ──
  console.log("\n--- rankings ---");
  const rk = await counted(() => get("/results/ex-1/rankings?rankBy=school&limit=7", TEACHER));
  const findCmd = rk.cmds.find((c) => c.commandName === "find" && c.command.find === M("ResultSummary").collection.name);
  check("seven asked, seven returned, and the find carried the limit", [rk.r.body.count, findCmd?.command?.limit], [7, 7]);

  // ── 5. staleness names the page's pupils ──
  console.log("\n--- staleness ---");
  const tl = await counted(() => get(`/term-results?academicYear=${YEAR}&term=1&classId=cls-s&limit=50`, ADMIN));
  const agg = tl.cmds.find((c) => c.commandName === "aggregate" && c.command.aggregate === M("StudentScore").collection.name);
  const matchIds = agg?.command?.pipeline?.[0]?.$match?.studentId?.$in ?? null;
  check("the term list's mark aggregation is restricted to the pupils on the page", [tl.r.body.results.length, Array.isArray(matchIds) ? matchIds.length : null], [5, 5]);

  // ── 6. the report card reads the pupil's own cohort ──
  console.log("\n--- report card ---");
  const rc = await counted(() => get("/results/ex-1/student/st-cls-s-0/reportcard/html", ADMIN));
  const cohortFind = rc.cmds.find((c) => c.commandName === "find" && c.command.find === M("StudentScore").collection.name && c.command.filter?.$or);
  const keyed = cohortFind?.command?.filter?.$or?.[0]?.examSubjectId?.$in ?? null;
  check("the cohort read names the pupil's exam-subject keys", [rc.r.status, Array.isArray(keyed) ? keyed.length : null, (keyed ?? []).every((k) => String(k).startsWith("es-cls-s-"))], [200, SUBJ, true]);
  const html = typeof rc.r.body === "string" ? rc.r.body : null; void html;
  const rc2 = await fetch(`${API}/results/ex-1/student/st-cls-s-0/reportcard`, { headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());
  const positions = (rc2?.data?.subjects ?? rc2?.data?.scores ?? []).map((s) => s.subjectPosition ?? s.position ?? null);
  check("and the card still carries a place in every subject, out of the class's five", positions.length === SUBJ && positions.every((p) => (p?.position ?? p) >= 1 && (p?.total ?? 5) === 5), true);

  // ── 7. the feed's idle page, and the taught scope once ──
  console.log("\n--- the change feed ---");
  const idle = { $or: [{ updatedAt: { $gt: new Date() } }, { updatedAt: new Date(), _id: { $gt: "~" } }] };
  for (const [model, extra] of [["StudentScore", {}], ["ResultSummary", {}], ["Student", {}], ["TermResult", {}]]) {
    const x = await M(model).find({ schoolId: A, ...extra, ...idle }).sort({ updatedAt: 1, _id: 1 }).limit(501).explain("executionStats");
    const es2 = x.executionStats ?? x;
    check(`${model}: an idle page examines no documents (was: every row of the school)`, [es2.totalDocsExamined, es2.nReturned], [0, 0]);
  }
  const feed = await counted(() => get("/sync/changes?collections=student,intervention,intelligenceReview,explorationEvidence,studentExploration,explorationObservation&limit=50", TEACHER));
  const taFinds = feed.cmds.filter((c) => c.commandName === "find" && c.command.find === M("TeacherAssignment").collection.name).length;
  check("six taught-scoped collections in one request: one read of the teacher's assignments", [feed.r.status, taFinds], [200, 1]);

  // ── 8. the teacher's subject scope is the school's ──
  console.log("\n--- teacher scope ---");
  const src = fs.readFileSync(path.join(SRC, "routes/teacher.routes.js"), "utf8");
  check("the Subject read in getTeacherScope carries the school", /Subject\.find\(\{\s*\.\.\.\(schoolId \? \{ schoolId: String\(schoolId\) \} : \{\}\),\s*\$or:/.test(src), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  mongoose.connection.client.off("commandStarted", onStart);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
