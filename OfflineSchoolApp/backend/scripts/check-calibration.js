// backend/scripts/check-calibration.js
"use strict";

/**
 * The calibration tooling, pinned — and the question of whether it can lie.
 *
 * ── The three ways a calibration harness misleads ─────────────────────────
 *
 * IT MEASURES ITSELF. If the analysis script held its own copy of what a
 * decline is, the report would agree with the script and say nothing about the
 * engine. Section 2 asserts that the tooling reaches shared/intelligence and
 * nothing else, that its source contains no threshold definition, and that its
 * profiles are byte-identical to a direct engine call.
 *
 * IT CHANGES WHAT IT MEASURES. Sensitivity analysis has to run the engine with
 * different numbers. Section 4 asserts that after a full analysis the
 * production THRESHOLDS object is the same object with the same values, and
 * that the isolated copy the sweep used is a different object.
 *
 * IT ACCEPTS A FILE THAT FLATTENS THE DATA. A cohort that turned an absence into
 * a zero, or carried a pupil's name, would make the whole exercise worthless or
 * worse. Section 1 feeds the validator every malformation the brief names and
 * asserts each is refused by name.
 *
 * ── What this file does NOT claim ─────────────────────────────────────────
 *
 * That any threshold is right. The only cohort here is synthetic, says so in
 * its provenance, and is used to prove the tooling works — section 6 asserts
 * the provenance is carried into every output so it cannot be mistaken for
 * evidence.
 *
 *   node scripts/check-calibration.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT   = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "..", "shared");
const CAL    = path.join(__dirname, "calibration");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const schema   = require(path.join(CAL, "cohortSchema"));
const analysis = require(path.join(CAL, "analyseCohort"));
const isolated = require(path.join(CAL, "isolatedEngine"));
const engine   = require(path.join(SHARED, "intelligence"));

const synthetic = JSON.parse(fs.readFileSync(path.join(CAL, "fixtures", "synthetic-cohort.json"), "utf8"));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 1. the validator refuses what it must ---");
// ═══════════════════════════════════════════════════════════════════════════

const v = schema.validateCohort(synthetic);
check("the synthetic fixture validates", [v.ok, v.errors], [true, []]);
check("and its provenance says what it is", synthetic.provenance.kind, "synthetic");

const refuses = (label, mutate, needle) => {
  const c = clone(synthetic);
  mutate(c);
  const r = schema.validateCohort(c);
  check(`refuses ${label}`, [r.ok, r.errors.some((e) => e.includes(needle))], [false, true]);
};

refuses("a missing required field (no studentId)",
  (c) => { delete c.results[0].studentId; }, "studentId is required");
refuses("a malformed score (a string)",
  (c) => { c.results[0].subjects[0].score = "abs"; }, "score must be a number or null");
refuses("a score above its maximum",
  (c) => { c.results[0].subjects[0].score = 25; }, "outside 0");
refuses("an invalid assessment type",
  (c) => { c.exams[0].type = "mock"; }, "is not one of");
refuses("a subject with no identity",
  (c) => { c.results[0].subjects[0].subjectId = ""; }, "subjectId is required");
refuses("a subject with no name",
  (c) => { delete c.results[0].subjects[0].subjectName; }, "subjectName is required");
refuses("invalid temporal ordering (sequence 2 dated before sequence 1)",
  (c) => { c.exams.find((e) => e.examId === "X2").startDate = "2026-09-01"; }, "invalid temporal ordering");
refuses("duplicate evidence (same pupil, exam and subject twice)",
  (c) => { c.results.push({ ...clone(c.results[0]), resultId: "dup" }); }, "duplicate evidence");
refuses("a result naming an exam that does not exist",
  (c) => { c.results[0].examId = "nope"; }, "names no exam");
refuses("a pupil's name, anywhere",
  (c) => { c.students[0].studentName = "Ngong Precious"; }, "identifying or financial field");
refuses("a guardian phone, nested deep",
  (c) => { c.results[0].subjects[0].guardianPhone = "6xx"; }, "identifying or financial field");
refuses("a fee balance",
  (c) => { c.students[0].balance = 15000; }, "identifying or financial field");
refuses("an unknown provenance",
  (c) => { c.provenance.kind = "real"; }, "provenance.kind");
refuses("the wrong format",
  (c) => { c.format = "something-else"; }, "format must be");

const okWith = (label, mutate) => {
  const c = clone(synthetic);
  mutate(c);
  check(`accepts ${label}`, schema.validateCohort(c).ok, true);
};
okWith("a genuine zero (score 0, flags false)",
  (c) => { Object.assign(c.results[0].subjects[0], { score: 0, normalizedMark: 0 }); });
okWith("an unentered mark (score null, flags false)",
  (c) => { Object.assign(c.results[0].subjects[0], { score: null, normalizedMark: 0 }); });
okWith("an absence (score null, isAbsent true)",
  (c) => { Object.assign(c.results[0].subjects[0], { score: null, normalizedMark: 0, isAbsent: true }); });
okWith("a subject name that happens to contain the word name (className is not a person)",
  (c) => { c.students[0].className = "Form 3A"; });

check("the assessment types are exactly the backend model's",
  [...schema.ASSESSMENT_TYPES],
  require(path.join(ROOT, "src", "db", "models", "Exam")).EXAM_TYPES);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 2. the tooling measures the engine, not itself ---");
// ═══════════════════════════════════════════════════════════════════════════

const graphOf = (entry) => {
  const id = require.resolve(entry);
  require(entry);
  const seen = new Set();
  const walk = (m) => { if (seen.has(m)) return; seen.add(m); for (const ch of require.cache[m]?.children ?? []) walk(ch.id); };
  walk(id);
  return [...seen];
};
const toolingGraph = [
  ...graphOf(path.join(CAL, "analyseCohort")),
  ...graphOf(path.join(CAL, "cohortSchema")),
  ...graphOf(path.join(CAL, "isolatedEngine")),
];
check("the tooling reaches the shared engine",
  toolingGraph.some((f) => f.startsWith(path.join(SHARED, "intelligence"))), true);
check("and nothing in backend/src — no model, no route, no service",
  toolingGraph.filter((f) => f.startsWith(path.join(ROOT, "src"))).map((f) => path.relative(ROOT, f)), []);
check("and no mongoose, express or axios",
  toolingGraph.filter((f) => /node_modules[\\/](mongoose|express|axios)[\\/]/.test(f)), []);
check("and nothing financial",
  toolingGraph.filter((f) => /(fees|finance|payroll)\.service\.js$/i.test(f)), []);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const toolingSource = ["analyseCohort.js", "cohortSchema.js", "isolatedEngine.js", "run.js"]
  .map((f) => stripComments(fs.readFileSync(path.join(CAL, f), "utf8"))).join("\n");
for (const [needle, what] of [
  [/\b(declineDrop|suddenDrop|improvementGain|consistencySpread|establishedObservations)\s*:\s*\d/, "a threshold definition"],
  // A mark compared against a NUMBER or STRING written in this file. Comparing
  // against grading.strongMark or grading.passMark is permitted: those are
  // values the engine emitted, read back, not thresholds decided here.
  [/(recentAverage|priorAverage|overallAverage|latest|delta|spread)\s*[<>]=?\s*(-?\d|["'])/, "a comparison of a mark against a literal"],
  [/["']academic_decline["']\s*:/, "an insight rule keyed by code"],
  [/confidence\s*=\s*["'](strong|emerging)["']/, "an assignment of confidence"],
]) {
  check(`the tooling source contains no ${what}`, needle.test(toolingSource), false);
}

// Byte identity with a direct engine call.
const input = schema.toEngineInput(synthetic);
const direct = engine.subjectInsights.analyseHistories({
  historyByStudent: input.historyByStudent, studentIds: input.studentIds, grading: input.grading,
});
const viaTooling = analysis.runEngine(synthetic).profiles;
check("the tooling's profiles are the engine's profiles, byte for byte",
  JSON.stringify([...viaTooling.entries()]), JSON.stringify([...direct.entries()]));
check("under the engine version the report names",
  analysis.analyse(synthetic).engineVersion, engine.ENGINE_VERSION);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 3. the loader applies the one production filter and nothing else ---");
// ═══════════════════════════════════════════════════════════════════════════

check("unpublished results are not handed to the engine",
  input.summaries.some((s) => s.studentId === "S12"), false);
check("but absent, exempt, unentered and CA rows ARE — those exclusions are the engine's to make",
  [input.summaries.filter((s) => s.studentId === "S09").length,
   input.summaries.filter((s) => s.studentId === "S11").length],
  [4, 5]);
check("and the engine then excludes them exactly as in production",
  [input.historyByStudent.get("S11").map((r) => r.examId),
   engine.subjectInsights.seriesFrom(input.historyByStudent.get("S11")).get("MAT").points.map((p) => p.mark)],
  [["X1", "X2", "X3", "X4"], [12, 13]]);
check("a genuine zero survives as a mark",
  engine.subjectInsights.seriesFrom(input.historyByStudent.get("S10")).get("MAT").points.map((p) => p.mark),
  [0, 0, 5]);
check("an absence-heavy history keeps only the sat papers",
  engine.subjectInsights.seriesFrom(input.historyByStudent.get("S09")).get("MAT").points.map((p) => p.mark),
  [12, 11]);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 4. sensitivity moves a private copy, never production ---");
// ═══════════════════════════════════════════════════════════════════════════

const prod = engine.subjectInsights.THRESHOLDS;
const before = clone(prod);
const report = analysis.analyse(synthetic);
check("after a full analysis the production thresholds are unchanged", prod, before);
check("and are still the same object every module holds",
  prod === require(path.join(SHARED, "intelligence", "subjectInsights")).THRESHOLDS, true);

const iso = isolated.loadIsolatedEngine();
check("the isolated engine is a different object graph",
  iso.subjectInsights.THRESHOLDS !== prod && iso.subjectInsights.seriesFrom !== engine.subjectInsights.seriesFrom, true);
check("with the same numbers in it", iso.subjectInsights.THRESHOLDS, prod);
iso.subjectInsights.THRESHOLDS.declineDrop = 99;
check("editing it leaves production alone", prod.declineDrop, before.declineDrop);
check("and a fresh require still returns production",
  require(path.join(SHARED, "intelligence")).subjectInsights.THRESHOLDS === prod, true);

check("every numeric threshold was swept",
  Object.keys(report.sensitivity.thresholds).sort(),
  Object.entries(prod).filter(([, x]) => typeof x === "number").map(([k]) => k).sort());
check("by the documented deltas", report.sensitivity.deltas, [-2, -1, 1, 2]);

// A boundary the fixture places exactly on the threshold: S02 Mathematics
// 16,15 → 10,9 has delta −6, well past declineDrop; S13 English 14,15 → 14,15
// has delta 0. The case that sits ON the line is S08: 14,12 → 12,10, delta −2.
// At declineDrop 3 it must stop being a decline; at 1 it must remain one.
const s08 = report.profiles.S08.subjects.find((s) => s.subjectId === "MAT");
check("the fixture holds a subject exactly on the decline threshold", s08.delta, -prod.declineDrop);
const d = report.sensitivity.thresholds.declineDrop.deltas;
check("raising declineDrop by one loses exactly that classification",
  [d["1"].classificationsLost, d["1"].lostByCode.academic_decline], [1, 1]);
check("and lowering it gains more, never loses",
  [d["-1"].classificationsLost, d["-1"].classificationsGained > 0], [0, true]);
check("the on-the-line case is listed as borderline",
  report.sensitivity.borderline.some((b) => b.studentId === "S08" && b.code === "academic_decline"), true);

const twice = analysis.analyse(synthetic);
check("the whole analysis is deterministic — same file, same bytes",
  JSON.stringify(twice), JSON.stringify(report));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 5. distributions count what came out ---");
// ═══════════════════════════════════════════════════════════════════════════

const e = report.evidence, dist = report.distribution;
check("every pupil in the file is counted, including those with nothing published",
  e.students, synthetic.students.length);
check("the two with nothing usable are insufficient (S07 one mark; S12 unpublished only)",
  e.studentsInsufficient, 2);
check("row states are tallied from the file, each in its own bucket",
  [e.rowStates.genuineZero, e.rowStates.absent, e.rowStates.exempt, e.rowStates.unentered, e.rowStates.inCa, e.rowStates.unpublished],
  [2, 2, 1, 1, 1, 2]);
check("insight counts sum to the total",
  Object.values(dist.insights.byCode).reduce((a, b) => a + b, 0), dist.insights.total);
check("every guidance rationale is one the engine can emit",
  Object.keys(dist.guidance.byRationale).every((r) =>
    r === "INSUFFICIENT_ACADEMIC_EVIDENCE" ||
    Object.values(engine.guidance.RISK_GUIDANCE).some((g) => g.rationaleCode === r) ||
    Object.values(engine.guidance.STRENGTH_RATIONALE).includes(r)), true);
check("outcomes are reported by the engine's own statuses",
  dist.outcomes.byStatus, { awaiting_after: 1, compared: 1, not_subject_specific: 1 });

const empty = { ...clone(synthetic), students: [], results: [], interventions: [] };
const emptyReport = analysis.analyse(empty);
check("an empty cohort analyses to zeros and one flag, not a crash",
  [emptyReport.evidence.students, emptyReport.distribution.insights.total, emptyReport.flags.map((f) => f.code)],
  [0, 0, ["NO_ANALYSABLE_STUDENTS"]]);

const sparse = { ...clone(synthetic), students: [{ studentId: "only" }], interventions: [],
  results: [{ ...clone(synthetic.results[0]), studentId: "only", resultId: "only-1" }] };
const sparseReport = analysis.analyse(sparse);
// With nobody analysable the report says exactly that and stops: a DATA_SPARSE
// share on top of it would be the same fact said twice.
check("a one-mark cohort is insufficient and says so",
  [sparseReport.evidence.studentsInsufficient, sparseReport.distribution.insights.total,
   sparseReport.flags.map((f) => f.code)],
  [1, 0, ["NO_ANALYSABLE_STUDENTS"]]);

const noSubjects = { ...clone(synthetic), results: synthetic.results.map((r) => ({ ...clone(r), subjects: [] })) };
check("results with no subject rows are handled",
  analysis.analyse(noSubjects).distribution.insights.total, 0);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 6. review cases carry evidence and no identity ---");
// ═══════════════════════════════════════════════════════════════════════════

const cases = report.reviewCases.cases;
check("every review category the brief names is populated by the fixture",
  Object.entries(report.reviewCases.coverage).filter(([, n]) => n === 0).map(([k]) => k), []);
check("each case carries marks, metrics, classification, thresholds and the engine's evidence",
  cases.every((c) => Array.isArray(c.marks) && "classifications" in c && "thresholdsInvolved" in c && "explanation" in c), true);
check("and an empty structured review form for the teacher",
  cases.every((c) => c.review.classificationAppropriate === null && c.review.reason === null
    && Array.isArray(report.reviewCases.reviewForm.classificationAppropriate)), true);
const caseBlob = JSON.stringify(cases).toLowerCase();
check("no case carries a name, phone, email or balance",
  /"(studentname|firstname|lastname|phone|email|guardian|balance)"/.test(caseBlob), false);
check("the thresholds a case names are real thresholds with their current values",
  cases.flatMap((c) => c.thresholdsInvolved).every((t) =>
    t.value === (t.threshold === "passMark" || t.threshold === "strongMark" ? report.evidence.grading[t.threshold] : prod[t.threshold])), true);
check("provenance is carried into the report so synthetic can never read as evidence",
  report.provenance.kind, "synthetic");
check("and the markdown says so in its first lines",
  analysis.renderMarkdown(report).includes("SYNTHETIC DATA"), true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 7. regression fixture: today's answers, held ---");
// ═══════════════════════════════════════════════════════════════════════════

const regFile = path.join(CAL, "fixtures", "synthetic-regression.json");
if (!fs.existsSync(regFile)) {
  fail++;
  console.log(`  FAIL ${path.relative(ROOT, regFile)} is missing — generate it with run.js --emit-fixtures`);
} else {
  const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
  check("the fixture records its provenance", reg.provenance.kind, "synthetic");
  check("and the engine version it was recorded under", reg.engineVersion, engine.ENGINE_VERSION);
  const byId = new Map(cases.map((c) => [c.caseId, c]));
  const drift = reg.cases.filter((r) => {
    const now = byId.get(r.caseId);
    return !now || JSON.stringify({ classifications: now.classifications, guidance: now.guidance, metrics: now.metrics })
      !== JSON.stringify(r.expected);
  }).map((r) => r.caseId);
  check(`all ${reg.cases.length} recorded cases still get the same answer`, drift, []);
}

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
