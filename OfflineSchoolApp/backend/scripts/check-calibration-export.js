// backend/scripts/check-calibration-export.js
"use strict";

/**
 * The exporter, executed for the first time — against a database nobody owns.
 *
 * ── Why this script exists ────────────────────────────────────────────────
 *
 * export-cohort.js is the one piece of Stage 7 that had never run. It could
 * not: it is built to read a real school, and a development checkout has no
 * business doing that. So every property a real run depends on — that it reads
 * ONE school, that it writes nothing back, that no name or raw id survives,
 * that the six semantic states arrive intact — was asserted by reading the
 * code, not by watching it. This script watches it.
 *
 * Two schools are seeded into an in-memory Mongo, both with pupils who have
 * names, enrolment numbers, phones and a fee balance. The exporter is run as
 * the operator would run it — a child process with the three environment
 * variables — and the file it writes is examined for what it must and must not
 * contain. The database is snapshotted before and after and compared byte for
 * byte, because "read-only" is a claim, and this is the proof.
 *
 * ── And the feedback tool, on a filled-in sheet ───────────────────────────
 *
 * Section 6 fills the synthetic review sheet the way a teacher would and
 * checks the cross-tabulation counts what it should — including that it
 * withholds a share below the minimum and never calls anything "accuracy".
 *
 *   node scripts/check-calibration-export.js
 */

const { stopQuietly } = require("./stopQuietly");

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..");
const CAL  = path.join(__dirname, "calibration");
const EXPORTER = path.join(CAL, "export-cohort.js");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const A = "68f7000000000000000000a1";
const B = "68f7000000000000000000b2";
const SALT = "check-only-salt-that-is-long-enough";

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  const uri = mongo.getUri();
  await mongoose.connect(uri);

  require(path.join(ROOT, "src", "db", "models"));
  const School        = mongoose.model("School");
  const Student       = mongoose.model("Student");
  const Exam          = mongoose.model("Exam");
  const ResultSummary = mongoose.model("ResultSummary");
  const GradingConfig = mongoose.model("GradingConfig");
  const Structure     = mongoose.model("AcademicStructure");
  const Intervention  = mongoose.model("Intervention");

  // ── Two schools, both full of things that must not leave ─────────────────
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const pupil = (id, schoolId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId: `class-${schoolId.slice(-2)}`,
    studentName: `Ngong Precious ${n}`, firstName: "Ngong", lastName: `Precious ${n}`,
    enrollmentNo: `ENR-${n}`, guardianPhone: "677000000", guardianName: "Mama Precious",
    isActive: true, status: "approved",
  });
  await Student.create([pupil("raw-student-a1", A, 1), pupil("raw-student-a2", A, 2), pupil("raw-student-b1", B, 9)]);
  const exam = (id, schoolId, extra) => ({
    _id: id, schoolId, name: `Exam ${id}`, academicYear: "2026-2027", term: 1,
    totalMarks: 20, passMark: 10, status: "published", resultsPublished: true,
    classId: `class-${schoolId.slice(-2)}`, ...extra,
  });
  await Exam.create([
    exam("raw-exam-a1",   A, { type: "test", sequenceNumber: 1, startDate: "2026-10-05" }),
    exam("raw-exam-a1ca", A, { type: "ca",   sequenceNumber: 1, startDate: "2026-10-01", parentExamId: "raw-exam-a1" }),
    exam("raw-exam-a2",   A, { type: "test", sequenceNumber: 2, startDate: "2026-11-20" }),
    exam("raw-exam-b1",   B, { type: "test", sequenceNumber: 1, startDate: "2026-10-05" }),
  ]);
  const row = (subjectId, subjectName, normalizedMark, extra = {}) => ({
    subjectId, subjectName, normalizedMark, score: normalizedMark, maxScore: 20, coefficient: 1,
    grade: null, points: 0, remark: null, isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false, ...extra,
  });
  await ResultSummary.create([
    // a1: a genuine zero, an absence, an exemption, an unentered mark, across two papers
    { _id: "raw-res-1", examId: "raw-exam-a1", studentId: "raw-student-a1", classId: "class-a1", schoolId: A,
      studentName: "Ngong Precious 1", admissionNo: "ENR-1", isPublished: true, subjectBreakdown: [
        row("maths", "Mathematics", 0), row("eng", "English", 0, { isAbsent: true, score: null }),
        row("phy", "Physics", 0, { isExempt: true, score: null }), row("ict", "ICT", 0, { score: null }) ] },
    { _id: "raw-res-2", examId: "raw-exam-a2", studentId: "raw-student-a1", classId: "class-a1", schoolId: A,
      studentName: "Ngong Precious 1", isPublished: true, subjectBreakdown: [row("maths", "Mathematics", 12), row("eng", "English", 14)] },
    // the CA summary — half of a sequence
    { _id: "raw-res-ca", examId: "raw-exam-a1ca", studentId: "raw-student-a1", classId: "class-a1", schoolId: A,
      isPublished: true, subjectBreakdown: [row("maths", "Mathematics", 20)] },
    // a2: published + one UNPUBLISHED draft
    { _id: "raw-res-3", examId: "raw-exam-a1", studentId: "raw-student-a2", classId: "class-a1", schoolId: A,
      isPublished: true, subjectBreakdown: [row("maths", "Mathematics", 16)] },
    { _id: "raw-res-4", examId: "raw-exam-a2", studentId: "raw-student-a2", classId: "class-a1", schoolId: A,
      isPublished: false, subjectBreakdown: [row("maths", "Mathematics", 19)] },
    // Beta's row — must never appear
    { _id: "raw-res-b", examId: "raw-exam-b1", studentId: "raw-student-b1", classId: "class-b2", schoolId: B,
      studentName: "Ngong Precious 9", isPublished: true, subjectBreakdown: [row("maths", "Mathematics", 18)] },
  ]);
  await GradingConfig.create({ schoolId: A, passMark: 10, grades: [{ grade: "A", minMark: 16, maxMark: 20 }, { grade: "P", minMark: 10, maxMark: 16 }, { grade: "F", minMark: 0, maxMark: 10 }] });
  await Structure.create({ schoolId: A, academicYear: "2026-2027", passMark: 10, terms: [] });
  await Intervention.create({ _id: "raw-iv-1", schoolId: A, studentId: "raw-student-a1", classId: "class-a1",
    createdBy: "t", updatedBy: "t", actionCode: "TARGETED_PRACTICE", subjectId: "maths", status: "active",
    startedAt: new Date("2026-11-01"), notes: "Precious struggles with fractions — call mum on 677000000" });

  /** Every document in every collection, sorted, for the read-only proof. */
  const snapshot = async () => {
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name).sort();
    const out = {};
    for (const n of names) {
      out[n] = (await mongoose.connection.db.collection(n).find({}).toArray())
        .map((d) => JSON.stringify(d)).sort();
    }
    return JSON.stringify(out);
  };
  // Every model's indexes built — and so every collection created — BEFORE
  // the snapshot. autoIndex runs in the background; without this, a collection
  // the parent had not yet created appears when the child loads the models,
  // and a read-only export is blamed for a write it did not make.
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const before = await snapshot();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "osa-calib-"));
  const outA = path.join(tmp, "alpha.json");
  /*
   * Async, and that is not a style choice. mongod's stdout is piped to this
   * process; a parent stuck in spawnSync stops draining that pipe, mongod
   * blocks on its next log write, and the child's server selection times out
   * at exactly the moment it tries to connect. The refusal tests never showed
   * it because those children exit before touching the database.
   */
  const run = (args, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, MONGODB_URI: uri, SCHOOL_ID: A, CALIBRATION_SALT: SALT, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  const runExporter = (out, env) => run([EXPORTER, out], env);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. it refuses to guess ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = await runExporter(path.join(tmp, "no-uri.json"), { MONGODB_URI: "" });
  check("no MONGODB_URI → exit 2, nothing written",
    [r.status, fs.existsSync(path.join(tmp, "no-uri.json"))], [2, false]);
  r = await runExporter(path.join(tmp, "no-school.json"), { SCHOOL_ID: "" });
  check("no SCHOOL_ID → exit 2, nothing written",
    [r.status, fs.existsSync(path.join(tmp, "no-school.json"))], [2, false]);
  r = await runExporter(path.join(tmp, "no-salt.json"), { CALIBRATION_SALT: "" });
  check("no CALIBRATION_SALT → exit 2, nothing written",
    [r.status, fs.existsSync(path.join(tmp, "no-salt.json"))], [2, false]);
  r = await runExporter(path.join(tmp, "short-salt.json"), { CALIBRATION_SALT: "short" });
  check("a short salt → exit 2, nothing written",
    [r.status, fs.existsSync(path.join(tmp, "short-salt.json"))], [2, false]);
  r = await run([EXPORTER], {});
  check("no output path → exit 2", r.status, 2);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. one school, out, validated ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await runExporter(outA, {});
  check("the export runs to completion", [r.status, /wrote /.test(r.stdout)], [0, true]);
  if (r.status !== 0) console.log(r.stdout, r.stderr);
  const cohort = JSON.parse(fs.readFileSync(outA, "utf8"));
  const { validateCohort, toEngineInput } = require(path.join(CAL, "cohortSchema"));
  const verdict = validateCohort(cohort);
  check("and the file validates against the Stage 7 contract", [verdict.ok, verdict.errors], [true, []]);
  check("with provenance marked as anonymised real", cohort.provenance.kind, "anonymised-real");

  check("only Alpha's pupils are present — two, not three",
    cohort.students.length, 2);
  check("only Alpha's exams — three, not four",
    cohort.exams.length, 3);
  check("only Alpha's results — five, not six",
    cohort.results.length, 5);
  check("and Alpha's grading context came with them",
    [cohort.grading.passMark, cohort.grading.grades.map((g) => g.grade), cohort.academicStructure.passMark],
    [10, ["A", "P", "F"], 10]);
  check("and Alpha's intervention, with its subject and dates",
    cohort.interventions.map((i) => [i.subjectId, i.status, Boolean(i.startedAt)]), [["maths", "active", true]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. nothing identifying left the database ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const text = fs.readFileSync(outA, "utf8");
  check("no pupil's name", /Ngong|Precious/.test(text), false);
  check("no enrolment number", /ENR-/.test(text), false);
  check("no phone number", /677000000/.test(text), false);
  check("no guardian", /Mama|guardian/i.test(text), false);
  check("no intervention notes — they are free text a teacher wrote about a child",
    /fractions|call mum/.test(text), false);
  check("no raw student, exam, result or intervention id",
    /raw-(student|exam|res|iv)-/.test(text), false);
  check("no raw class id", /class-a1/.test(text), false);
  check("no school id or name", new RegExp(`${A}|Alpha`).test(text), false);
  check("every pupil id is an opaque HMAC prefix",
    cohort.students.every((s) => /^student_[0-9a-f]{16}$/.test(s.studentId)), true);
  check("and subject NAMES are kept, because a teacher has to read the sheet",
    [...new Set(cohort.results.flatMap((x) => x.subjects.map((s) => s.subjectName)))].sort(),
    ["English", "ICT", "Mathematics", "Physics"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. the six states arrive intact ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const idOf = (raw) => cohort.results.find((x) => x.subjects.some((s) => s.subjectId === "ict"))?.studentId;
  const a1 = idOf();
  const res1 = cohort.results.find((x) => x.studentId === a1 && x.subjects.length === 4);
  const by = Object.fromEntries(res1.subjects.map((s) => [s.subjectId, s]));
  check("a genuine zero is score 0 with both flags false",
    [by.maths.score, by.maths.isAbsent, by.maths.isExempt], [0, false, false]);
  check("an absence is score null with isAbsent true",
    [by.eng.score, by.eng.isAbsent], [null, true]);
  check("an exemption is score null with isExempt true",
    [by.phy.score, by.phy.isExempt], [null, true]);
  check("an unentered mark is score null with both flags false",
    [by.ict.score, by.ict.isAbsent, by.ict.isExempt], [null, false, false]);
  check("the CA exam keeps its type and its parent",
    cohort.exams.filter((e) => e.type === "ca").map((e) => Boolean(e.parentExamId)), [true]);
  check("the unpublished draft is exported AS unpublished, not dropped and not published",
    cohort.results.filter((x) => x.isPublished === false).length, 1);

  // And then the loader does exactly what production does with them.
  const input = toEngineInput(cohort);
  check("the loader passes only published rows to the engine",
    input.summaries.length, 4);
  const { analyse } = require(path.join(CAL, "analyseCohort"));
  const report = analyse(cohort);
  check("and the analysis tallies each state in its own bucket",
    [report.evidence.rowStates.genuineZero, report.evidence.rowStates.absent, report.evidence.rowStates.exempt,
     report.evidence.rowStates.unentered, report.evidence.rowStates.inCa, report.evidence.rowStates.unpublished],
    [1, 1, 1, 1, 1, 1]);
  check("the CA mark of 20 never became a Mathematics occasion",
    input.historyByStudent.get(a1).map((x) => x.examId).length, 2);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. read-only, deterministic, and keyed by the salt ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const after = await snapshot();
  // On failure, name the collection rather than reporting a bare false: a
  // read-only proof that fails should say what was written.
  const drift = (() => {
    if (after === before) return [];
    const a = JSON.parse(before), z = JSON.parse(after);
    return [...new Set([...Object.keys(a), ...Object.keys(z)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(z[k]))
      .map((k) => ({ collection: k, before: (a[k] ?? []).length, after: (z[k] ?? []).length, sample: ((z[k] ?? a[k]) ?? [])[0]?.slice(0, 160) ?? null }));
  })();
  check("every collection is byte-identical before and after the export", drift, []);

  const outA2 = path.join(tmp, "alpha-again.json");
  await runExporter(outA2, {});
  check("the same salt produces the same file", fs.readFileSync(outA2, "utf8") === text, true);

  const outA3 = path.join(tmp, "alpha-other-salt.json");
  await runExporter(outA3, { CALIBRATION_SALT: "a-completely-different-operator-salt" });
  const other = JSON.parse(fs.readFileSync(outA3, "utf8"));
  check("a different salt produces different opaque ids",
    other.students.map((s) => s.studentId).some((id) => cohort.students.some((s) => s.studentId === id)), false);
  check("but the same structure and the same marks",
    JSON.stringify(other.results.map((x) => x.subjects.map((s) => [s.subjectId, s.score]))),
    JSON.stringify(cohort.results.map((x) => x.subjects.map((s) => [s.subjectId, s.score]))));

  const outNone = path.join(tmp, "nobody.json");
  r = await runExporter(outNone, { SCHOOL_ID: "68f70000000000000000dead" });
  check("an unknown school exports an empty, valid cohort rather than another school's",
    [r.status, JSON.parse(fs.readFileSync(outNone, "utf8")).results.length], [0, 0]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. the feedback tool, on a sheet a teacher filled in ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const { analyseReviews, outcomeOf } = require(path.join(CAL, "reviewFeedback"));
  const synthetic = JSON.parse(fs.readFileSync(path.join(CAL, "fixtures", "synthetic-cohort.json"), "utf8"));
  const sheet = analyse(synthetic).reviewCases;

  check("every case carries the structured form, unfilled",
    sheet.cases.every((c) => c.review.observedPattern === null && c.review.classificationAppropriate === null
      && c.review.evidenceSufficient === null && c.review.guidanceAppropriate === null), true);
  check("and only trend cases carry the temporal block",
    sheet.cases.every((c) => Boolean(c.review.temporal) ===
      c.classifications.some((x) => sheet.reviewForm.temporal.appliesTo.includes(x.code))), true);
  check("each case says why it was selected",
    sheet.cases.every((c) => typeof c.selectedBecause === "string" && c.selectedBecause.length > 0), true);

  // Fill it in deterministically: declines rejected as assessment difficulty,
  // strengths confirmed, one case left blank, one marked thin.
  const filled = JSON.parse(JSON.stringify(sheet));
  filled.cases.forEach((c, i) => {
    const codes = c.classifications.map((x) => x.code);
    if (i === 0) return;                                     // left unreviewed
    if (codes.includes("academic_decline")) {
      Object.assign(c.review, { observedPattern: "NO", classificationAppropriate: "NO", evidenceSufficient: "YES",
        guidanceAppropriate: "NO", reason: "harder paper", temporal: { interpretationReasonable: "NO", possibleExplanation: "assessment_difficulty" } });
    } else if (codes.includes("subject_strength")) {
      Object.assign(c.review, { observedPattern: "YES", classificationAppropriate: "YES", evidenceSufficient: "YES", guidanceAppropriate: "YES" });
    } else if (c.category === "insufficient_evidence") {
      Object.assign(c.review, { observedPattern: "UNCERTAIN", classificationAppropriate: "UNCERTAIN", evidenceSufficient: "NO", guidanceAppropriate: "UNCERTAIN" });
    } else {
      Object.assign(c.review, { observedPattern: "YES", classificationAppropriate: "PARTIALLY", evidenceSufficient: "YES", guidanceAppropriate: "PARTIALLY" });
    }
  });
  const fb = analyseReviews(filled);
  check("the forms all validate", fb.problems, []);
  check("one case is unreviewed and the rest are counted",
    [fb.totals.unreviewed, fb.totals.reviewed + fb.totals.unreviewed], [1, sheet.cases.length]);
  check("insufficient evidence outranks the verdict",
    outcomeOf({ classificationAppropriate: "YES", evidenceSufficient: "NO" }), "insufficient_evidence");
  check("every decline case is rejected, every strength case confirmed",
    [fb.byCode.academic_decline?.rejected === Object.values(fb.byCode.academic_decline ?? {}).reduce((a, b) => a + b, 0),
     fb.byCode.subject_strength?.confirmed > 0 && fb.byCode.subject_strength?.rejected === 0], [true, true]);
  check("disagreement is attributed to the thresholds behind the rejected code",
    (fb.byThreshold.declineDrop?.rejected ?? 0) > 0, true);
  check("the assessment-difficulty pattern is named, with its support",
    fb.patterns.some((p) => p.kind === "TREND_EXPLAINED_OTHERWISE" && p.explanation === "assessment_difficulty"), true);
  // The contract in both directions. This sheet has 32 reviewed cases, which
  // meets MIN_CASES_FOR_SHARE, so shares are reported — as shares of reviewed
  // cases that sum to one, never as a score. A dozen cases must get none.
  const shareSum = Object.values(fb.shares ?? {}).reduce((a, b) => a + b, 0);
  check("above the minimum, shares are reported and sum to one",
    [fb.totals.reviewed >= fb.minCasesForShare, fb.sharesWithheld, Math.abs(shareSum - 1) < 0.02],
    [true, null, true]);
  const dozen = analyseReviews({ ...filled, cases: filled.cases.slice(0, 12) });
  check("below the minimum, shares are withheld — no accuracy score from a dozen cases",
    [dozen.totals.reviewed < dozen.minCasesForShare, dozen.shares, typeof dozen.sharesWithheld],
    [true, null, "string"]);
  check("no field in the feedback report is called accuracy",
    /accuracy/i.test(JSON.stringify(fb)), false);
  check("a value outside the contract is reported by case",
    analyseReviews({ cases: [{ caseId: "x", classifications: [], thresholdsInvolved: [], review: { classificationAppropriate: "MAYBE" } }] }).problems.length, 1);
  check("and the whole thing is deterministic",
    JSON.stringify(analyseReviews(filled)), JSON.stringify(fb));

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  fs.rmSync(tmp, { recursive: true, force: true });
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
