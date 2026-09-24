// backend/scripts/check-teacher-intelligence.js
"use strict";

/**
 * The loop: evidence → guidance → a human decision → an action → what happened.
 *
 * ── What this file is really testing ──────────────────────────────────────
 *
 * Not a screen. The property that the whole product rests on: that a teacher
 * can get from "this pupil is struggling" to "here is what we did and here is
 * what the marks looked like afterwards" without the system ever making the
 * educational decision, and without any step in the chain quietly inventing
 * something it does not know.
 *
 * ── The three ways the last step goes wrong ───────────────────────────────
 *
 * IT CLAIMS CAUSALITY. A before/after difference is a coincidence in time and
 * nothing more: the pupil also grew up a term, the syllabus moved, the paper
 * was a different paper. Section 6 reads every code and string the comparison
 * can emit and fails on any word that asserts the intervention did it.
 *
 * IT INVENTS A COMPARISON IT DOES NOT HAVE. A recent intervention has no "after"
 * yet, and the honest answer is to say so. Turning that into a zero, or into
 * "no improvement", would tell a teacher their action failed when the next
 * sequence has simply not been sat. Section 5 walks the whole matrix — before
 * only, after only, both, neither.
 *
 * IT COUNTS A NON-MARK AS A MARK. The comparison inherits Stage 2.1's
 * distinctions rather than reimplementing them, and section 5's last pupil
 * proves it: one genuine zero, one absence, one exemption, one unentered mark
 * and one continuous assessment, in the same subject, where only the zero and
 * the real marks may be counted. Get that wrong and a pupil who missed two
 * papers reads as a collapse.
 *
 *   node scripts/check-teacher-intelligence.js
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

const A = "6900000000000000000000a1";   // Alpha Academy
const B = "6900000000000000000000b2";   // Beta College
const YEAR = "2026-2027";

/** A breakdown row in the shape results.service actually stores. */
const row = (subjectId, subjectName, normalizedMark, extra = {}) => ({
  subjectId, subjectName, normalizedMark,
  score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null,
  isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false,
  ...extra,
});

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  // monitorCommands so section 7 can count queries; a listener that never fires
  // would make any ceiling look like a pass.
  await mongoose.connect(mongo.getUri(), { monitorCommands: true });

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Subject           = mongoose.model("Subject");
  const Student           = mongoose.model("Student");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Exam              = mongoose.model("Exam");
  const ResultSummary     = mongoose.model("ResultSummary");
  const Intervention      = mongoose.model("Intervention");

  const outcome = require(path.join(SRC, "services/intelligence/interventionOutcome.service"));

  // ── The school ───────────────────────────────────────────────────────────
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`,
    password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a", "teacher", A),
    mkUser("admin-a", "school_admin", A),
    mkUser("teach-b", "teacher", B),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths", schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "ict",   schoolId: A, name: "ICT",         classId: "form3a" },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
  ]);

  const pupil = (id, classId, n, schoolId = A) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st-decline", "form3a", "Decline"),
    pupil("st-strong",  "form3a", "Strong"),
    pupil("st-cases",   "form3a", "Cases"),
    pupil("st-quiet",   "form3a", "Quiet"),
    pupil("st-other",   "form4b", "Other"),
    pupil("st-beta",    "form1b", "Beta", B),
  ]);

  /*
   * Five occasions with real dates, because the comparison splits on WHEN the
   * paper was sat. ex-1ca is the continuous assessment attached to Sequence 1
   * and must never count as an occasion of its own.
   */
  const mkExam = (id, term, seq, startDate, extra = {}) => ({
    _id: id, schoolId: A, name: id, type: "test", academicYear: YEAR,
    term, sequenceNumber: seq, startDate, classId: "form3a",
    totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
    ...extra,
  });
  await Exam.create([
    mkExam("ex-1",   1, 1, "2026-10-05"),
    mkExam("ex-1ca", 1, 1, "2026-10-01", { type: "ca", parentExamId: "ex-1" }),
    mkExam("ex-2",   1, 2, "2026-11-20"),
    mkExam("ex-3",   2, 1, "2027-02-10"),
    mkExam("ex-4",   2, 2, "2027-03-20"),
    mkExam("ex-5",   3, 1, "2027-05-10"),
  ]);

  const summary = (id, examId, studentId, term, rows, extra = {}) => ({
    _id: id, examId, studentId, classId: "form3a", schoolId: A,
    academicYear: YEAR, term: String(term), isPublished: true,
    percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows,
    ...extra,
  });

  await ResultSummary.create([
    // st-decline: Maths 16, 15 before the pivot; 10, 9 after it.
    summary("s-d1", "ex-1", "st-decline", 1, [row("maths", "Mathematics", 16), row("ict", "ICT", 15)]),
    // Sat in November, but COMPUTED in March — after the pivot. It is prior
    // evidence and must sort that way; createdAt must not decide this.
    summary("s-d2", "ex-2", "st-decline", 1, [row("maths", "Mathematics", 15), row("ict", "ICT", 15)],
      { createdAt: new Date("2027-03-01") }),
    summary("s-d3", "ex-3", "st-decline", 2, [row("maths", "Mathematics", 10), row("ict", "ICT", 15)]),
    summary("s-d4", "ex-4", "st-decline", 2, [row("maths", "Mathematics",  9), row("ict", "ICT", 16)]),

    // st-strong: ICT consistently high, so the same loop runs for a strength.
    summary("s-s1", "ex-1", "st-strong", 1, [row("ict", "ICT", 16)]),
    summary("s-s2", "ex-2", "st-strong", 1, [row("ict", "ICT", 17)]),
    summary("s-s3", "ex-3", "st-strong", 2, [row("ict", "ICT", 17)]),

    /*
     * st-cases, all in Mathematics, one of each kind of non-mark:
     *   ex-1    a GENUINE zero the pupil earned        → counted, before
     *   ex-1ca  continuous assessment, 20/20           → never an occasion
     *   ex-2    absent                                 → not a performance zero
     *   ex-3    exempt                                 → not a performance zero
     *   ex-4    unentered (score null, flags false)    → no mark behind the row
     *   ex-5    a real 8                               → counted, after
     */
    summary("s-c1", "ex-1",   "st-cases", 1, [row("maths", "Mathematics", 0)]),
    summary("s-cca", "ex-1ca", "st-cases", 1, [row("maths", "Mathematics", 20)]),
    summary("s-c2", "ex-2",   "st-cases", 1, [row("maths", "Mathematics", 0, { isAbsent: true, score: null })]),
    summary("s-c3", "ex-3",   "st-cases", 2, [row("maths", "Mathematics", 0, { isExempt: true, score: null })]),
    summary("s-c4", "ex-4",   "st-cases", 2, [row("maths", "Mathematics", 0, { score: null })]),
    summary("s-c5", "ex-5",   "st-cases", 3, [row("maths", "Mathematics", 8)]),
  ]);

  // ── The app ──────────────────────────────────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights",      auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/interventions", auth.authenticate, require(path.join(SRC, "routes/interventions.routes")));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let out = {}; try { out = await res.json(); } catch { /* empty */ }
      return { status: res.status, body: out };
    };
    return {
      get:   (u)    => call("GET", u),
      post:  (u, b) => call("POST", u, b),
      patch: (u, b) => call("PATCH", u, b),
    };
  };
  const teacher = as("teach-a", "teacher", A);
  const admin   = as("admin-a", "school_admin", A);
  const beta    = as("teach-b", "teacher", B);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the class surface a teacher opens ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = await teacher.get("/insights/class/form3a");
  check("a teacher opens a class they teach → 200", r.status, 200);
  const roster = r.body?.data?.students ?? [];
  check("and sees every approved pupil in it",
    roster.map((s) => s.studentId).sort(),
    ["st-cases", "st-decline", "st-quiet", "st-strong"]);

  const decline = roster.find((s) => s.studentId === "st-decline");
  // Both sides at once: Mathematics falling, ICT holding. A teacher meets the
  // pupil as a whole rather than as a problem.
  check("each pupil carries a guidance summary, strengths included",
    decline.guidance.map((g) => [g.subjectName, g.type, g.rationaleCode]),
    [["ICT", "strength_development", "SUBJECT_STRENGTH"],
     ["ICT", "strength_development", "CONSISTENT_STRENGTH"],
     ["Mathematics", "academic_support", "RECENT_DECLINE"]]);
  const declineItem = decline.guidance.find((g) => g.type === "academic_support");
  check("the summary says how loudly, so a teacher knows who to open first",
    [declineItem.priority, declineItem.confidence], ["high", "strong"]);
  check("but carries no evidence — that is what the pupil route is for",
    Object.keys(declineItem).sort(),
    ["confidence", "priority", "rationaleCode", "subjectId", "subjectName", "type"]);
  check("and an open-intervention list, empty before anybody acts",
    decline.openInterventions, []);

  const quiet = roster.find((s) => s.studentId === "st-quiet");
  check("a pupil with no published results is listed, with monitoring guidance",
    [quiet.guidance.map((g) => g.rationaleCode), quiet.coverage.sufficient],
    [["INSUFFICIENT_ACADEMIC_EVIDENCE"], false]);

  r = await teacher.get("/insights/class/form4b");
  check("a class they do not teach → 403 CLASS_NOT_ASSIGNED",
    [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);

  r = await beta.get("/insights/class/form3a");
  check("Beta's teacher reaching Alpha's class → 404, not a hint it exists",
    r.status, 404);

  r = await beta.get(`/insights/class/form3a?schoolId=${A}`);
  check("and naming Alpha in the query string is refused at the door",
    [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);

  r = await admin.get("/insights/class/form3a");
  check("the office reads any class in its own school → 200", r.status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. the evidence behind one pupil ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacher.get("/insights/student/st-decline/guidance");
  const items = r.body?.data?.guidance ?? [];
  const support = items.find((g) => g.type === "academic_support");
  check("the pupil route carries the evidence the summary omitted",
    support.evidence.filter((e) => ["recent_average", "previous_average", "observations"]
      .includes(e.metric)).map((e) => [e.metric, e.value]),
    [["observations", 4], ["recent_average", 9.5], ["previous_average", 15.5]]);
  check("and the actions a teacher may choose between",
    support.recommendedActionCodes,
    ["REVIEW_RECENT_ASSESSMENTS", "TARGETED_PRACTICE", "MONITOR_NEXT_SEQUENCE"]);
  check("with the insight it came from, so the measurements are reachable",
    support.sourceInsightCode, "academic_decline");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the human decides; the system never does ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * Nothing above created an intervention. Guidance has existed for four pupils
   * across two requests and the collection is still empty — which is the
   * property, not an accident of ordering.
   */
  check("surfacing guidance creates no intervention on its own",
    await Intervention.countDocuments({}), 0);

  r = await teacher.post("/interventions", {
    studentId:  "st-decline",
    sourceType: "guidance",
    sourceCode: "RECENT_DECLINE",
    subjectId:  "maths",
    actionCode: "TARGETED_PRACTICE",
    notes:      "Two weeks of drills on simultaneous equations",
  });
  check("a teacher explicitly records one → 201, planned",
    [r.status, r.body?.data?.status], [201, "planned"]);
  check("the link back to the guidance is kept as codes, not a copied payload",
    [r.body?.data?.sourceType, r.body?.data?.sourceCode, r.body?.data?.subjectId],
    ["guidance", "RECENT_DECLINE", "maths"]);
  check("and no evidence was frozen into the record",
    Object.keys(r.body?.data ?? {}).some((k) => /evidence|guidance|insight|score/i.test(k)),
    false);
  const mathsAction = r.body.data._id;

  r = await teacher.post("/interventions", {
    studentId: "st-strong", sourceType: "guidance", sourceCode: "SUBJECT_STRENGTH",
    subjectId: "ict", actionCode: "ENRICHMENT_ACTIVITY",
  });
  check("the same loop runs for a strength, not only for a problem", r.status, 201);
  const ictAction = r.body.data._id;

  r = await teacher.post("/interventions", {
    studentId: "st-quiet", sourceType: "guidance", sourceCode: "INSUFFICIENT_ACADEMIC_EVIDENCE",
    actionCode: "MONITOR_NEXT_SEQUENCE",
  });
  check("and for monitoring, which names no subject",
    [r.status, r.body?.data?.subjectId], [201, null]);
  const monitorAction = r.body.data._id;

  r = await teacher.post("/interventions", {
    studentId: "st-other", actionCode: "TARGETED_PRACTICE",
  });
  check("a pupil in a class they do not teach → 403", r.status, 403);

  r = await teacher.get("/insights/class/form3a");
  const openNow = (r.body?.data?.students ?? [])
    .find((s) => s.studentId === "st-decline")?.openInterventions ?? [];
  check("the class list now shows it as open, without a second request per pupil",
    openNow.map((i) => [i.status, i.actionCode]), [["planned", "TARGETED_PRACTICE"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. moving it along, and closing it ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * The pivot for the comparison. Started mid-January, between Sequence 2
   * (sat in November) and Sequence 3 (sat in February).
   */
  r = await teacher.patch(`/interventions/${mathsAction}`, { status: "active", version: 1 });
  check("planned → active → 200", [r.status, r.body?.data?.status], [200, "active"]);
  await Intervention.updateOne({ _id: mathsAction },
    { $set: { startedAt: new Date("2027-01-15") } });

  r = await teacher.patch(`/interventions/${mathsAction}`, { status: "planned", version: 2 });
  check("and a move the lifecycle forbids is still refused → 409", r.status, 409);

  const marksBefore = await ResultSummary.find({ studentId: "st-decline" })
    .select("_id subjectBreakdown percentage").lean();

  r = await teacher.patch(`/interventions/${mathsAction}`, {
    status: "completed", version: 2,
    outcomeCode: "improved", outcomeNotes: "Sat sequence 3 and passed",
  });
  check("active → completed with a human-entered outcome → 200",
    [r.status, r.body?.data?.status, r.body?.data?.outcomeCode],
    [200, "completed", "improved"]);
  check("both moves are on the record, with who made them",
    (r.body?.data?.statusHistory ?? []).map((h) => `${h.from}>${h.to}:${h.by}`),
    ["planned>active:teach-a", "active>completed:teach-a"]);

  r = await teacher.patch(`/interventions/${ictAction}`, { outcomeCode: "not_a_real_outcome" });
  check("an outcome outside the recorded vocabulary is refused", r.status >= 400, true);

  const marksAfter = await ResultSummary.find({ studentId: "st-decline" })
    .select("_id subjectBreakdown percentage").lean();
  check("recording an outcome changed no mark, no breakdown and no percentage",
    JSON.stringify(marksAfter), JSON.stringify(marksBefore));

  r = await teacher.get("/insights/class/form3a");
  check("and a completed intervention drops out of the open list",
    (r.body?.data?.students ?? []).find((s) => s.studentId === "st-decline")
      ?.openInterventions ?? [], []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. what the marks looked like before, and afterwards ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacher.get(`/interventions/${mathsAction}/evidence`);
  const ev = r.body?.data ?? {};
  check("both sides available → a comparison, on the twenty-point scale",
    [r.status, ev.status, ev.subjectName, ev.scale], [200, "compared", "Mathematics", 20]);
  check("before is the two sequences sat before it started",
    [ev.before.average, ev.before.observations], [15.5, 2]);
  check("including the one PUBLISHED afterwards — it was still sat before",
    ev.before.to.sequence, 2);
  check("after is the two sat since",
    [ev.after.average, ev.after.observations], [9.5, 2]);
  check("and the change is reported as a number, not a verdict",
    [ev.change, ev.reading], [-6, "DECREASED_AFTER"]);
  check("the pivot says which moment it split on, and why",
    ev.pivotSource, "startedAt");

  // ── awaiting evidence ────────────────────────────────────────────────────
  const strengthRow = await Intervention.findById(ictAction);
  strengthRow.startedAt = new Date("2027-08-01");   // after every occasion
  await strengthRow.save();
  r = await teacher.get(`/interventions/${ictAction}/evidence`);
  check("nothing sat since it started → awaiting, NOT a failure and NOT a zero",
    [r.body?.data?.status, r.body?.data?.reading, r.body?.data?.change],
    ["awaiting_after", "AWAITING_POST_EVIDENCE", null]);
  check("and the prior evidence is still shown",
    r.body?.data?.before?.observations, 3);

  // ── no prior evidence ────────────────────────────────────────────────────
  strengthRow.startedAt = new Date("2026-09-01");   // before every occasion
  await strengthRow.save();
  r = await teacher.get(`/interventions/${ictAction}/evidence`);
  check("nothing sat before it → no prior evidence, and no invented baseline",
    [r.body?.data?.status, r.body?.data?.reading, r.body?.data?.before],
    ["no_before", "NO_PRIOR_EVIDENCE", null]);

  // ── neither side ─────────────────────────────────────────────────────────
  r = await teacher.post("/interventions", {
    studentId: "st-quiet", subjectId: "maths", actionCode: "ADDITIONAL_SUPPORT",
  });
  const quietAction = r.body.data._id;
  r = await teacher.get(`/interventions/${quietAction}/evidence`);
  check("a pupil with no published Mathematics at all → no evidence, said plainly",
    [r.body?.data?.status, r.body?.data?.reading, r.body?.data?.before, r.body?.data?.after],
    ["no_evidence", "NO_COMPARABLE_EVIDENCE", null, null]);

  // ── not subject specific ─────────────────────────────────────────────────
  r = await teacher.get(`/interventions/${monitorAction}/evidence`);
  check("an action about no subject is not compared against the whole average",
    [r.body?.data?.status, r.body?.data?.reading],
    ["not_subject_specific", "NOT_SUBJECT_SPECIFIC"]);

  // ── the data-integrity matrix, in one pupil ──────────────────────────────
  r = await teacher.post("/interventions", {
    studentId: "st-cases", subjectId: "maths", actionCode: "ADDITIONAL_SUPPORT",
  });
  const casesAction = r.body.data._id;
  await Intervention.updateOne({ _id: casesAction },
    { $set: { startedAt: new Date("2027-01-15") } });
  r = await teacher.get(`/interventions/${casesAction}/evidence`);
  const cases = r.body?.data ?? {};
  check("the genuine zero is counted — the pupil earned it",
    [cases.before.average, cases.before.observations], [0, 1]);
  check("the absence, the exemption and the unentered mark are not",
    cases.after.observations, 1);
  check("the continuous assessment was never an occasion of its own",
    [cases.before.observations + cases.after.observations], [2]);
  check("and the comparison reads from a real zero to a real eight",
    [cases.before.average, cases.after.average, cases.change, cases.reading],
    [0, 8, 8, "INCREASED_AFTER"]);

  // ── authorization on the comparison ──────────────────────────────────────
  r = await beta.get(`/interventions/${mathsAction}/evidence`);
  check("another school cannot read the comparison → 404", r.status, 404);
  r = await admin.get(`/interventions/${mathsAction}/evidence`);
  check("the office can → 200", r.status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. the comparison never claims it caused anything ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const everyReading = [
    outcome.readingOf(3), outcome.readingOf(-3), outcome.readingOf(0),
    "AWAITING_POST_EVIDENCE", "NO_PRIOR_EVIDENCE",
    "NO_COMPARABLE_EVIDENCE", "NOT_SUBJECT_SPECIFIC",
  ];
  const CAUSAL = /caused|because|due_to|thanks_to|worked|failed|succeed|effective|improved_by|impact|result_of/i;
  check("no reading code asserts the intervention did it",
    everyReading.filter((code) => CAUSAL.test(code)), []);
  check("and the codes are the documented set",
    everyReading.sort(),
    ["AWAITING_POST_EVIDENCE", "DECREASED_AFTER", "INCREASED_AFTER",
     "NOT_SUBJECT_SPECIFIC", "NO_CHANGE_OBSERVED", "NO_COMPARABLE_EVIDENCE",
     "NO_PRIOR_EVIDENCE"]);

  const payload = JSON.stringify(ev);
  check("no payload carries a persisted impact or effectiveness score",
    /impactscore|successscore|effectiveness|aioutcome/i.test(payload), false);
  check("and nothing derived was written to the database",
    await mongoose.connection.db.listCollections().toArray()
      // Deliberately narrow: studentscores is an authoritative collection that
      // predates all of this, not a derived-intelligence cache.
      .then((cs) => cs.map((c) => c.name).filter((n) =>
        /studentinsight|insightsnapshot|impactscore|successscore|aianalysis|guidancecache/i.test(n))),
    []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. a class of forty costs what a class of four costs ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * READS only — find, aggregate, count and their cursor continuations.
   *
   * Mongoose builds an index the first time it touches a collection, so
   * createIndexes turns up in whichever measurement happened to be first and
   * has nothing to do with how many pupils were asked for. Counting it would
   * make this assertion fail for a reason it is not about, which is how a check
   * gets weakened until it proves nothing.
   */
  const READS = new Set(["find", "aggregate", "count", "getMore", "distinct"]);
  const countQueries = async (fn) => {
    let n = 0;
    const onStart = (e) => {
      if (!READS.has(e.commandName)) return;
      n += 1;
      if (process.env.QDEBUG) console.log("      Q", e.commandName, e.command?.find ?? e.command?.aggregate ?? "");
    };
    mongoose.connection.client.on("commandStarted", onStart);
    await fn();
    mongoose.connection.client.off("commandStarted", onStart);
    return n;
  };

  const small = await countQueries(() => teacher.get("/insights/class/form3a"));

  // Six more pupils in the same class, each with published results.
  const extra = [];
  for (let i = 0; i < 6; i += 1) {
    extra.push(pupil(`st-bulk-${i}`, "form3a", `Bulk${i}`));
  }
  await Student.create(extra);
  await ResultSummary.create(extra.flatMap((s, i) => [
    summary(`s-b${i}-1`, "ex-1", s._id, 1, [row("maths", "Mathematics", 12 + (i % 3))]),
    summary(`s-b${i}-2`, "ex-2", s._id, 1, [row("maths", "Mathematics", 11 + (i % 3))]),
  ]));

  const large = await countQueries(() => teacher.get("/insights/class/form3a"));
  check("ten pupils take the same number of queries as four", large, small);
  check("and the larger class still answers with every pupil",
    (await teacher.get("/insights/class/form3a")).body?.data?.students?.length, 10);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. nothing financial, structurally ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const graphOf = (entryPoint) => {
    const id = require.resolve(entryPoint);
    require(entryPoint);
    const seen = new Set();
    const walk = (moduleId) => {
      if (seen.has(moduleId)) return;
      seen.add(moduleId);
      for (const child of require.cache[moduleId]?.children ?? []) walk(child.id);
    };
    walk(id);
    return [...seen];
  };
  const MONEY = /(fees|finance|financeReports|payroll|feeReminders)\.service\.js$/i;
  check("the outcome comparison cannot reach the fee ledger",
    graphOf(path.join(SRC, "services/intelligence/interventionOutcome.service"))
      .filter((f) => MONEY.test(f)), []);

  // Currency codes as whole words: a UUID can contain the hex letters "cfa", and
  // an id is not money.
  const MONEY_WORD = /balance|\bfees?\b|arrear|owed|debt|invoice|receipt|payment|paid|charge|waive|amount|currency|\bxaf\b|\bcfa\b|bursar/i;   // word-bounded short tokens: a generated uuid can contain "fee" or "cfa"
  const offending = (node, trail = "$") => {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) return node.flatMap((v, i) => offending(v, `${trail}[${i}]`));
    if (typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) =>
        (MONEY_WORD.test(k) ? [`${trail}.${k}`] : []).concat(offending(v, `${trail}.${k}`)));
    }
    return typeof node === "string" && MONEY_WORD.test(node) ? [`${trail} = ${node}`] : [];
  };
  check("the class surface carries no financial key or value",
    offending((await teacher.get("/insights/class/form3a")).body), []);
  check("nor does the comparison",
    offending((await teacher.get(`/interventions/${mathsAction}/evidence`)).body), []);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
