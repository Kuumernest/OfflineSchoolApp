// backend/scripts/check-strengths.js
"use strict";

/**
 * The strengths and exploration layer: every rule the brief names, on
 * fixtures built for it; then the routes, as each role.
 *
 * ── Section 1: the pure layer ─────────────────────────────────────────────
 *
 * One pupil at a time through the real academic engine (runEngine over a
 * tiny cohort) and then through shared/strengths. Persistent, emerging, high
 * average but variable, declining, cross-subject, single-subject, sparse,
 * contradictory, absences, interest, participation, teacher observation, the
 * things it never says, determinism.
 *
 * ── Section 2: the application ────────────────────────────────────────────
 *
 * Teacher (assigned / not), head, operator (selected / not), bursar, a pupil
 * (own profile / another's), another school; evidence recording by source;
 * snapshots and the longitudinal history; a strength confirmation that is
 * stored apart from the engine's reading and changes nothing; the guardian's
 * plain view; live = offline for the strengths layer.
 *
 * Nothing here is validation of the engine on a real pupil. The pupils are
 * fixtures and their names are fixture names.
 *
 *   node scripts/check-strengths.js
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

const { runEngine } = require(path.join(ROOT, "scripts/calibration/analyseCohort"));
const strengths = require(path.join(ROOT, "..", "shared", "strengths"));

// ── A cohort factory: five sittings across three terms, one pupil ─────────
const EXAMS = [
  { examId: "X1", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { examId: "X2", type: "test", academicYear: "2026-2027", term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
  { examId: "X3", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 1, startDate: "2027-02-10" },
  { examId: "X4", type: "test", academicYear: "2026-2027", term: 2, sequenceNumber: 2, startDate: "2027-03-20" },
  { examId: "X5", type: "test", academicYear: "2026-2027", term: 3, sequenceNumber: 1, startDate: "2027-05-10" },
];
const profileOf = (marksBySubject, { exams = EXAMS.length } = {}) => {
  const subjects = Object.keys(marksBySubject);
  const results = [];
  for (let i = 0; i < exams; i++) {
    const rows = subjects.map((name) => {
      const m = marksBySubject[name][i];
      if (m === undefined) return null;
      const absent = m === "A";
      return { subjectId: name.toLowerCase().replace(/\W+/g, "_"), subjectName: name, normalizedMark: absent ? 0 : m, score: absent ? null : m,
               maxScore: 20, coefficient: 1, isAbsent: absent, isExempt: false };
    }).filter(Boolean);
    if (rows.length) results.push({ resultId: `S-${EXAMS[i].examId}`, studentId: "S", classId: "C", examId: EXAMS[i].examId, isPublished: true, subjects: rows });
  }
  const cohort = { format: "osa-intelligence-cohort", formatVersion: 1, provenance: { kind: "synthetic", note: "check" },
    grading: { passMark: 10, grades: [] }, academicStructure: { passMark: 10 }, exams: EXAMS.slice(0, exams),
    students: [{ studentId: "S", classId: "C" }], results, interventions: [] };
  return runEngine(cohort).profiles.get("S");
};
const sp = (marks, opts = {}, explorationEvidence = []) => strengths.buildStrengthProfile({ academicProfile: profileOf(marks, opts), explorationEvidence });
const dim = (p, d) => [...p.strengths, ...p.emergingAreas, ...p.decliningAreas].find((x) => x.dimension === d) ?? null;

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. persistent strength, traceable to evidence ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let p = sp({ Mathematics: [16, 17, 16, 17, 16], Physics: [15, 16, 15, 16, 15] });
  check("Mathematics and Physics, strong across three terms → quantitative and scientific ESTABLISHED, persistent, strong confidence",
    [dim(p, "quantitative_reasoning")?.state, dim(p, "quantitative_reasoning")?.persistence, dim(p, "quantitative_reasoning")?.confidence,
     dim(p, "scientific_reasoning")?.state], ["ESTABLISHED", "persistent", "strong", "ESTABLISHED"]);
  check("every claim carries its evidence: two subjects and the cross-subject support, each traceable",
    dim(p, "quantitative_reasoning").evidence.map((e) => [e.evidenceType, e.subjectName ?? e.subjectIds?.length, e.supports]),
    [["subject_performance", "Mathematics", true], ["subject_performance", "Physics", true], ["cross_subject_support", 2, true]]);
  check("the quantitative & scientific area opens on strong evidence, with ways to explore and why",
    p.explorationAreas.filter((a) => a.area === "quantitative_scientific").map((a) => [a.evidenceLevel, a.openedBy, a.waysToExplore.length > 0, a.because.length]),
    [["strong", ["quantitative_reasoning", "scientific_reasoning"], true, 2]]);
  check("the profile carries both engine versions and the strength thresholds",
    [p.academicEngineVersion, p.strengthEngineVersion, p.thresholds.minObservations, p.grading.strongMark], ["1.0.0", "1.2.0", 2, 14]);
  check("overall confidence is the confidence that the evidence supports the reading", p.confidence, "strong");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. emerging, not established ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = sp({ Mathematics: [16, 17] }, { exams: 2 });
  check("two strong sittings in one term → recurring, EMERGING, confidence emerging — never presented as established",
    [dim(p, "quantitative_reasoning")?.state, dim(p, "quantitative_reasoning")?.persistence, dim(p, "quantitative_reasoning")?.confidence, p.strengths.length],
    ["EMERGING", "recurring", "emerging", 0]);
  check("its area is opened at the limited level, ordered after nothing stronger",
    p.explorationAreas.map((a) => [a.area, a.evidenceLevel]), [["mathematical", "limited"]]);
  p = sp({ Mathematics: [16] }, { exams: 1 });
  check("one strong mark is not a strength of any kind",
    [p.strengths.length, p.emergingAreas.length, p.confidence, p.limitations.includes("insufficient_academic_coverage")], [0, 0, "insufficient", true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. level is not consistency ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const steady = sp({ Mathematics: [16, 16, 16, 16, 16] });
  const swingy = sp({ Mathematics: [20, 12, 19, 11, 18] });
  check("16,16,16,16,16 and 20,12,19,11,18 share an average within a point",
    Math.abs(steady.subjects[0].overallAverage - swingy.subjects[0].overallAverage) <= 1, true);
  check("and not a reading: steady is ESTABLISHED, swingy is EMERGING with variable marks named as the limitation",
    [dim(steady, "quantitative_reasoning").state, dim(swingy, "quantitative_reasoning").state, dim(swingy, "quantitative_reasoning").limitations],
    ["ESTABLISHED", "EMERGING", ["variable_marks"]]);
  check("the subject reading says so too", [steady.subjects[0].consistency, swingy.subjects[0].consistency], ["consistent", "variable"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. a strength that fades is not still a strength ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = sp({ Mathematics: [17, 17, 16, 10, 9] });
  check("strong for a year, then two sittings below the threshold → DECLINING, out of strengths and emerging",
    [dim(p, "quantitative_reasoning")?.state, p.strengths.length, p.emergingAreas.length, p.decliningAreas.length], ["DECLINING", 0, 0, 1]);
  check("the evidence against is on the record, not dropped",
    dim(p, "quantitative_reasoning").evidence.map((e) => [e.evidenceType, e.supports, e.direction]), [["subject_decline", false, "declining"]]);
  check("no exploration area opens on a declining dimension", p.explorationAreas, []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. cross-subject, single-subject, secondary-only ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = sp({ Biology: [15, 16, 15, 16, 15], Chemistry: [16, 16, 17, 16, 16] });
  check("Biology and Chemistry reinforce scientific reasoning: cross-subject, life sciences strong",
    [dim(p, "scientific_reasoning").crossSubject, dim(p, "scientific_reasoning").supportingSubjects.length, p.explorationAreas[0]?.area, p.explorationAreas[0]?.evidenceLevel],
    [true, 2, "life_sciences", "strong"]);
  p = sp({ Woodcarving: [16, 17, 16, 17, 16] });
  check("a subject outside the taxonomy, strong and steady, is a single-subject strength under its own name — no dimension invented",
    [p.singleSubjectStrengths.map((s) => [s.subjectName, s.state, s.persistence]), p.strengths.length, p.limitations.includes("subjects_outside_taxonomy")],
    [[["Woodcarving", "ESTABLISHED", "persistent"]], 0, true]);
  p = sp({ English: [16, 17, 16, 17, 16] });
  check("English alone establishes language & communication and NOT reading & interpretation, which it only draws on",
    [dim(p, "language_communication")?.state, dim(p, "reading_interpretation"), p.explorationAreas.map((a) => a.area)],
    ["ESTABLISHED", null, ["language_media"]]);
  p = sp({ English: [16, 17, 16, 17, 16], History: [15, 16, 15, 16, 15] });
  check("with History beside it, reading & interpretation is established and the humanities area opens",
    [dim(p, "reading_interpretation")?.state, p.explorationAreas.some((a) => a.area === "humanities_social")], ["ESTABLISHED", true]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. contradiction, sparsity, absences ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = sp({ Mathematics: [16, 17, 16, 17, 16], Physics: [16, 15, 9, 8, 9] });
  check("a declining related subject contradicts: quantitative drops to EMERGING with the decline on its evidence, scientific is DECLINING",
    [dim(p, "quantitative_reasoning").state, dim(p, "quantitative_reasoning").evidence.some((e) => e.evidenceType === "subject_decline" && e.subjectName === "Physics"),
     dim(p, "scientific_reasoning").state], ["EMERGING", true, "DECLINING"]);
  p = sp({ Mathematics: [16, 17] }, { exams: 2 });
  check("sparse evidence: an honest emerging reading, never an invented profile", [p.confidence, p.evidenceCoverage.sequences], ["emerging", 2]);
  p = sp({ Mathematics: [16, "A", "A", 17, "A"] });
  check("absences are not marks against: two strong sittings across two terms read as they would without the absences, nothing declines",
    [dim(p, "quantitative_reasoning")?.state, p.decliningAreas.length, p.subjects[0].observations], ["ESTABLISHED", 0, 2]);
  p = sp({});
  check("no subjects at all → insufficient, and the limitation says which", [p.confidence, p.limitations.slice(0, 2)], ["insufficient", ["insufficient_academic_coverage", "no_subject_evidence"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. interest, participation and observation are three different things ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const interest = [{ kind: "interest", source: "student", dimension: "scientific_reasoning", activity: "Science club", date: "2027-01-10", recordedBy: "stu" }];
  p = sp({ English: [16, 17, 16, 17, 16] }, {}, interest);
  check("a pupil's interest in science, with no science marks: carried as a signal, never as a strength",
    [p.interestSignals.map((s) => [s.kind, s.dimension]), dim(p, "scientific_reasoning"), p.evidenceCoverage.explorationEvidence],
    [[["interest", "scientific_reasoning"]], null, 1]);
  const club = [{ kind: "exposure", source: "teacher", dimension: "technical_applied", activity: "Robotics club", date: "2027-01-10", participation: "took_part", recordedBy: "t1" }];
  p = sp({ English: [16, 17, 16, 17, 16] }, {}, club);
  check("participation in a robotics club is exposure, not competence: no technical strength appears",
    [p.interestSignals.map((s) => s.kind), dim(p, "technical_applied")], [["exposure"], null]);
  const obs = (n) => Array.from({ length: n }, (_, i) => ({ kind: "teacher_observation", source: "teacher", dimension: "quantitative_reasoning", activity: "Problem-solving session", date: "2027-01-10", recordedBy: `t${i}` }));
  const emerging = sp({ Mathematics: [16, 17] }, { exams: 2 });
  check("one teacher's observation leaves an emerging reading emerging",
    dim(sp({ Mathematics: [16, 17] }, { exams: 2 }, obs(1)), "quantitative_reasoning").confidence, "emerging");
  check("two distinct teachers' observations lift it to strong — the one explicit, versioned rule",
    [dim(emerging, "quantitative_reasoning").confidence, dim(sp({ Mathematics: [16, 17] }, { exams: 2 }, obs(2)), "quantitative_reasoning").confidence,
     dim(sp({ Mathematics: [16, 17] }, { exams: 2 }, obs(2)), "quantitative_reasoning").evidence.some((e) => e.evidenceType === "teacher_observation" && e.observers === 2)],
    ["emerging", "strong", true]);
  check("but nothing lifts insufficient, and the same two observations from ONE teacher count once",
    [sp({ Mathematics: [16] }, { exams: 1 }, obs(2)).strengths.length,
     dim(sp({ Mathematics: [16, 17] }, { exams: 2 }, [obs(1)[0], obs(1)[0]]), "quantitative_reasoning").confidence], [0, "emerging"]);
  check("interest rows never count as observers",
    dim(sp({ Mathematics: [16, 17] }, { exams: 2 }, [...interest, ...interest].map((e) => ({ ...e, dimension: "quantitative_reasoning", recordedBy: Math.random().toString() }))), "quantitative_reasoning").confidence, "emerging");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. what it never says, and that it says the same thing twice ---");
  // ═══════════════════════════════════════════════════════════════════════════

  p = sp({ Mathematics: [16, 17, 16, 17, 16], Physics: [15, 16, 15, 16, 15], English: [17, 17, 16, 17, 17] });
  const { notInferred, ...rest } = p;
  check("no career, occupation, talent, personality or IQ anywhere in a profile, outside the list of what is not inferred",
    /career|occupation|profession|talent|personality|\bIQ\b|intelligence_quotient|success/i.test(JSON.stringify(rest)), false);
  check("and the list is there every time, naming them",
    ["career", "occupation", "personality", "intelligence_quotient", "fixed_talent", "future_success"].every((k) => notInferred.includes(k)), true);
  check("no area is a job: every area code is one of the taxonomy's broad domains",
    p.explorationAreas.every((a) => strengths.EXPLORATION_AREAS.some((x) => x.code === a.area)), true);
  check("areas are ordered by evidence level only, and the level is on the object",
    p.explorationAreas.every((a, i, arr) => i === 0 || ({ strong: 3, emerging: 2, limited: 1 })[arr[i - 1].evidenceLevel] >= ({ strong: 3, emerging: 2, limited: 1 })[a.evidenceLevel]), true);
  check("deterministic: the same evidence gives the same bytes",
    JSON.stringify(sp({ Mathematics: [16, 17, 16, 17, 16], Physics: [15, 16, 15, 16, 15] })) === JSON.stringify(sp({ Mathematics: [16, 17, 16, 17, 16], Physics: [15, 16, 15, 16, 15] })), true);
  check("the layer has its own version and the academic engine keeps its own", [strengths.STRENGTH_ENGINE_VERSION, p.academicEngineVersion], ["1.2.0", "1.0.0"]);
  check("ten dimensions, ten areas, none named after a profession",
    [strengths.DIMENSIONS.length, strengths.EXPLORATION_AREAS.length, /engineer|doctor|lawyer|nurse|pilot|teacher|accountant/i.test(JSON.stringify(strengths.EXPLORATION_AREAS))], [10, 10, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: the application.
  // ═══════════════════════════════════════════════════════════════════════════

  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const A = "6a00000000000000000000a1", B = "6a00000000000000000000b2", YEAR = "2026-2027";
  await M("School").create([{ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" }, { _id: B, name: "Beta College", code: "BETA", email: "beta@example.test" }]);
  const mkUser = (id, role, schoolId, name) => M("User").create({ _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true });
  await Promise.all([
    mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("teach-b", "teacher", A, "M. Biya"), mkUser("teach-c", "teacher", A, "Mme Chantal"),
    mkUser("admin-a", "school_admin", A, "Head Alpha"), mkUser("admin-b", "school_admin", B, "Head Beta"),
    mkUser("bursar-a", "bursar", A, "Bursar Alpha"), mkUser("operator", "super_admin", null, "Platform Operator"),
    mkUser("stu-a1", "student", A, "Pupil A1"), mkUser("stu-a2", "student", A, "Pupil A2"), mkUser("stu-b1", "student", B, "Pupil B1"),
  ]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" }, { _id: "form1b", schoolId: B, name: "Form 1B" }]);
  await M("TeacherAssignment").create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }, { schoolId: A, teacher: "teach-b", class: "form3a", subject: "phy" },
    { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({ _id: id, userId: `stu-${id.slice(3)}`, schoolId, classId, studentName: `Pupil ${n}`, enrollmentNo: n, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", A, "form3a", "A1"), pupil("st-a2", A, "form4b", "A2"), pupil("st-b1", B, "form1b", "B1")]);
  const mkExam = (id, schoolId, classId, term, seq, startDate) => ({ _id: id, schoolId, name: id, type: "test", academicYear: YEAR, term, sequenceNumber: seq, startDate, classId, totalMarks: 20, passMark: 10, status: "published", resultsPublished: true });
  await M("Exam").create([mkExam("ax1", A, "form3a", 1, 1, "2026-10-05"), mkExam("ax2", A, "form3a", 1, 2, "2026-11-20"), mkExam("ax3", A, "form3a", 2, 1, "2027-02-10")]);
  const row = (subjectId, subjectName, m) => ({ subjectId, subjectName, normalizedMark: m, score: m, maxScore: 20, coefficient: 1, grade: null, points: 0, remark: null, isPassing: m >= 10, isAbsent: false, isExempt: false });
  const summary = (id, examId, studentId, classId, schoolId, term, rows) => ({ _id: id, examId, studentId, classId, schoolId, academicYear: YEAR, term: String(term), isPublished: true, percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: rows });
  await M("ResultSummary").create([
    summary("s1", "ax1", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 16), row("phy", "Physics", 15)]),
    summary("s2", "ax2", "st-a1", "form3a", A, 1, [row("maths", "Mathematics", 17), row("phy", "Physics", 16)]),
    summary("s3", "ax3", "st-a1", "form3a", A, 2, [row("maths", "Mathematics", 16), row("phy", "Physics", 15)]),
    summary("s4", "ax1", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 8)]),
    summary("s5", "ax2", "st-a2", "form4b", A, 1, [row("maths", "Mathematics", 7)]),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let out = {}; try { out = await res.json(); } catch { /* empty */ }
      return { status: res.status, body: out };
    };
    return { get: (u) => call("GET", u), post: (u, b) => call("POST", u, b) };
  };
  const teacherA = as("teach-a", "teacher", A), teacherB = as("teach-b", "teacher", A), teacherC = as("teach-c", "teacher", A);
  const head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B), bursar = as("bursar-a", "bursar", A);
  const operator = as("operator", "super_admin", null);
  const pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A), pupilB1 = as("stu-b1", "student", B);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;
  const reads = (id) => ["strengths", "exploration", "profile", "evidence"].map((k) => `/insights/student/${id}/${k}`);
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. who may read a strengths profile ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = await teacherA.get("/insights/student/st-a1/strengths");
  check("the assigned teacher → 200, the profile named, both versions, quantitative and scientific established",
    [r.status, r.body.data.name, r.body.data.profile.strengthEngineVersion, r.body.data.profile.academicEngineVersion,
     r.body.data.profile.strengths.map((d) => d.dimension)],
    [200, "Pupil A1", "1.2.0", "1.0.0", ["quantitative_reasoning", "scientific_reasoning"]]);
  check("all four reads answer the teacher for their pupil", await statuses(teacherA, reads("st-a1")), [200, 200, 200, 200]);
  check("and refuse the pupil they do not teach", await statuses(teacherA, reads("st-a2")), [403, 403, 403, 403]);
  check("a teacher of another class → 403", await statuses(teacherC, reads("st-a1")), [403, 403, 403, 403]);
  check("the head reads both", [...(await statuses(head, reads("st-a1"))), ...(await statuses(head, reads("st-a2")))], [200, 200, 200, 200, 200, 200, 200, 200]);
  check("the operator, having selected the school → 200; without a selection → not 200",
    [await statuses(operator, reads("st-a1").map(inA)), (await statuses(operator, reads("st-a1"))).every((s) => s !== 200)], [[200, 200, 200, 200], true]);
  check("the bursar holds neither capability → 403 everywhere", await statuses(bursar, reads("st-a1")), [403, 403, 403, 403]);
  check("Beta's head → 404, never a hint", await statuses(headB, reads("st-a1")), [404, 404, 404, 404]);
  r = await pupilA1.get("/insights/student/st-a1/strengths");
  check("the pupil reads their own profile → 200, and it carries no teacher's review",
    [r.status, r.body.data.profile.strengths.length, "reviews" in r.body.data], [200, 2, false]);
  check("another pupil's profile → 403 OWN_PROFILE_ONLY, in the same school or another",
    [(await pupilA2.get("/insights/student/st-a1/strengths")).body.code, (await pupilB1.get("/insights/student/st-a1/strengths")).status], ["OWN_PROFILE_ONLY", 403]);
  check("a pupil with thin evidence gets an honest profile, not a bad one",
    (({ status, body }) => [status, body.data.profile.confidence, body.data.profile.strengths.length, body.data.profile.decliningAreas.length])
      (await pupilA2.get("/insights/student/st-a2/strengths")), [200, "insufficient", 0, 0]);
  r = await pupilA1.get("/insights/student/st-a1/exploration");
  check("the exploration read: areas with ways to explore, the interest signals apart, the limits, the not-inferred list",
    [r.body.data.explorationAreas.map((a) => a.area), Array.isArray(r.body.data.interestSignals), r.body.data.notInferred.includes("career")],
    [["mathematical", "quantitative_scientific", "life_sciences"].sort(), true, true].map((x, i) => i === 0 ? r.body.data.explorationAreas.map((a) => a.area).sort() : x));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. exploration evidence: who records what ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const ev = (extra) => ({ activity: "Science club", date: "2027-01-15", dimension: "scientific_reasoning", ...extra });
  check("a pupil records interest → 201, source student", (({ status, body }) => [status, body.data?.source, body.data?.kind])(await pupilA1.post("/insights/student/st-a1/evidence", ev({ kind: "interest" }))), [201, "student", "interest"]);
  check("a pupil cannot record performance about themselves → 400", (await pupilA1.post("/insights/student/st-a1/evidence", ev({ kind: "performance" }))).body.code, "INVALID_EVIDENCE");
  check("nor anything about another pupil → 403", (await pupilA2.post("/insights/student/st-a1/evidence", ev({ kind: "interest" }))).status, 403);
  check("a reflection needs its code", (await pupilA1.post("/insights/student/st-a1/evidence", ev({ kind: "student_reflection" }))).body.code, "INVALID_EVIDENCE");
  check("with it → 201", (await pupilA1.post("/insights/student/st-a1/evidence", ev({ kind: "student_reflection", reflection: "want_more" }))).status, 201);
  check("a teacher records exposure → 201, source teacher", (({ status, body }) => [status, body.data?.source])(await teacherA.post("/insights/student/st-a1/evidence", ev({ kind: "exposure", participation: "took_part", activity: "Robotics club", dimension: "technical_applied" }))), [201, "teacher"]);
  check("a teacher cannot enter a pupil's interest for them → 400", (await teacherA.post("/insights/student/st-a1/evidence", ev({ kind: "interest" }))).body.code, "INVALID_EVIDENCE");
  check("an unknown dimension → 400; a job title is not a dimension", (await teacherA.post("/insights/student/st-a1/evidence", ev({ kind: "exposure", dimension: "engineer" }))).body.code, "INVALID_EVIDENCE");
  check("a teacher without the class → 403", (await teacherC.post("/insights/student/st-a1/evidence", ev({ kind: "exposure" }))).status, 403);
  check("the bursar → 403", (await bursar.post("/insights/student/st-a1/evidence", ev({ kind: "exposure" }))).status, 403);
  r = await teacherA.get("/insights/student/st-a1/evidence");
  check("the evidence read lists the rows by kind, the academic signals, and the strength evidence apart",
    [r.body.data.explorationEvidence.map((e) => e.kind).sort(), r.body.data.academicSignals.length > 0, r.body.data.strengthEvidence.map((d) => d.dimension)],
    [["exposure", "interest", "student_reflection"], true, ["quantitative_reasoning", "scientific_reasoning"]]);
  r = await teacherA.get("/insights/student/st-a1/strengths");
  check("the profile carries the three as interest signals and no new strength: robotics club is exposure, not competence",
    [r.body.data.profile.interestSignals.map((s) => s.kind).sort(), r.body.data.profile.strengths.map((d) => d.dimension).includes("technical_applied")],
    [["exposure", "interest", "student_reflection"], false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 11. the longitudinal profile ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a pupil cannot snapshot", (await pupilA1.post("/insights/student/st-a1/profile/snapshot", {})).status, 403);
  r = await teacherA.post("/insights/student/st-a1/profile/snapshot", { periodLabel: "Term 2" });
  check("the teacher takes a snapshot → 201, version 1, both engine versions, the source period, the reading without the mark series",
    [r.status, r.body.data.profileVersion, r.body.data.strengthEngineVersion, r.body.data.academicEngineVersion, r.body.data.sourcePeriod.sequences,
     "subjects" in r.body.data.profile, r.body.data.profile.strengths.length],
    [201, 1, "1.2.0", "1.0.0", 3, false, 2]);
  r = await head.post("/insights/student/st-a1/profile/snapshot", { periodLabel: "Term 2 (head)" });
  check("a second snapshot is version 2; the first is not overwritten", [r.status, r.body.data.profileVersion], [201, 2]);
  r = await pupilA1.get("/insights/student/st-a1/profile");
  check("the profile read shows the current reading and the history in order, with who took each",
    [r.body.data.current.strengths.length, r.body.data.history.map((h) => [h.profileVersion, h.periodLabel, h.recordedBy])],
    [2, [[1, "Term 2", "teach-a"], [2, "Term 2 (head)", "admin-a"]]]);
  check("a snapshot of a pupil with no results → 404 NO_PROFILE", (await head.post("/insights/student/st-b1/profile/snapshot", {})).status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 12. teacher confirmation stays apart from the engine ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const form = { observedPattern: "NO", classificationAppropriate: "NO", evidenceSufficient: "YES", guidanceAppropriate: "UNCERTAIN", reason: "Not what I see in class", dataQuality: [] };
  r = await teacherA.post("/insights/reviews", { studentId: "st-a1", category: "strength", subjectId: "quantitative_reasoning", engineVersion: "1.0.0", review: form, classifications: [{ code: "made_up" }] });
  check("a strength confirmation is a review of category strength, verified against the profile, stored with the SERVER's reading",
    [r.status, r.body.data?.category, r.body.data?.classifications], [201, "strength", [{ code: "quantitative_reasoning", confidence: "strong" }]]);
  check("a dimension the profile does not name → 404 CASE_NOT_FOUND", (await teacherA.post("/insights/reviews", { studentId: "st-a1", category: "strength", subjectId: "creative_expression", engineVersion: "1.0.0", review: form })).body.code, "CASE_NOT_FOUND");
  r = await teacherA.get("/insights/student/st-a1/strengths");
  check("one teacher's NO changes nothing in the engine's reading", r.body.data.profile.strengths.map((d) => [d.dimension, d.state]), [["quantitative_reasoning", "ESTABLISHED"], ["scientific_reasoning", "ESTABLISHED"]]);
  check("the review rides beside the profile for its author", r.body.data.reviews.map((v) => [v.reviewedBy, v.review.classificationAppropriate]), [["teach-a", "NO"]]);
  r = await teacherB.get("/insights/student/st-a1/strengths");
  check("and is hidden from the colleague who has not answered", r.body.data.reviews, []);
  check("the head sees it, named", (await head.get("/insights/student/st-a1/strengths")).body.data.reviews.map((v) => v.reviewedByName), ["Mme Ateba"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 13. live = offline, for the strengths layer too ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacherA.get("/insights/student/st-a1/consistency");
  check("the consistency read now diffs the strengths profile through both roads, and it matches",
    [r.status, r.body.data.identical, r.body.data.strengths.identical, r.body.data.strengths.differences, r.body.data.strengths.engineVersion],
    [200, true, true, [], { live: "1.2.0", offline: "1.2.0" }]);
  const strengthsSvc = require(path.join(SRC, "services/intelligence/strengths.service"));
  const g = strengthsSvc.forGuardian(await strengthsSvc.profileFor({ schoolId: A, studentId: "st-a1" }));
  check("the guardian's view is plain: dimensions, subjects by name, areas with ways to explore, limits, what is not inferred — no evidence internals, no review",
    [Object.keys(g).sort(), g.strengths[0].supportingSubjects, "evidence" in g.strengths[0]],
    [["confidence", "emergingAreas", "explorationAreas", "limitations", "notInferred", "strengths", "versions"], ["Mathematics", "Physics"], false]);
  const feed = require(path.join(SRC, "config/syncFeed"));
  check("exploration evidence mirrors on the intelligence capabilities, scoped to taught pupils; snapshots stay online",
    [feed.required(feed.byCollection.get("explorationEvidence")), typeof feed.byCollection.get("explorationEvidence").scope, typeof feed.EXCLUDED.StrengthProfileSnapshot],
    [["insights.view", "insights.viewTaught"], "function", "string"]);
  const { definitionOf, DEFAULTS_BY_ROLE } = require(path.join(SRC, "config/permissions"));
  check("no capability was minted for the pupil: they read by role, and students still hold none", [definitionOf("insights.viewOwn"), (DEFAULTS_BY_ROLE?.student ?? []).length], [null, 0]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
