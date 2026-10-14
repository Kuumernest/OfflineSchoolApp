// backend/scripts/check-shared-intelligence.js
"use strict";

/**
 * One engine, three consumers, and nothing lost in the move.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 *
 * Stage 6 moved the deterministic intelligence rules out of the backend and
 * into shared/. That is the kind of change that is either invisible or a
 * disaster, and the only way to tell the difference is to assert the three
 * things that could have gone wrong:
 *
 * THE RULES CHANGED IN THE MOVE. A threshold mistyped, a comparison flipped, a
 * branch dropped. Section 3 feeds fixed inputs through the engine and pins the
 * exact outputs; section 4 feeds the same inputs through the BACKEND service
 * and asserts the two answers are identical objects, so a future edit to either
 * side that forgets the other fails here.
 *
 * SOMETHING IMPURE CAME WITH THEM. A stray `require` of a Mongoose model would
 * make the engine unloadable on a device and nobody would notice until the
 * desktop crashed offline. Section 1 loads the engine in a process with no
 * database connection at all and walks its entire require graph looking for
 * anything it must not touch.
 *
 * THE BACKEND KEPT A COPY. An extraction that leaves the old implementation in
 * place is worse than no extraction: two implementations that agree today.
 * Section 2 asserts the backend services are loaders — that the rule bodies are
 * gone from them and their exports are the shared functions themselves, by
 * identity.
 *
 * ── The offline proof ─────────────────────────────────────────────────────
 *
 * Section 5 is the point of the whole stage. It computes a full profile, its
 * guidance and a before/after comparison from plain JavaScript objects, in a
 * process that has never opened a socket or connected to Mongo. Nothing is
 * mocked — the calculation is genuinely the one the server runs.
 *
 *   node scripts/check-shared-intelligence.js
 */

const path = require("path");
const Module = require("module");

const ROOT   = path.join(__dirname, "..");
const SRC    = path.join(ROOT, "src");
const SHARED = path.join(ROOT, "..", "shared");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 1. the engine loads with no database, and touches nothing it must not ---");
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Deliberately the FIRST thing this script does, before anything requires a
 * model or opens a connection. If the engine needed mongoose to be connected,
 * or reached a model at require time, it would fail right here.
 */
const engine = require(path.join(SHARED, "intelligence"));

check("shared/intelligence loads in a bare process",
  typeof engine.subjectInsights.buildProfile, "function");
check("and exposes the four modules the consumers need",
  Object.keys(engine).sort(),
  ["ENGINE_VERSION", "academicOrder", "guidance", "interventionOutcome", "subjectInsights"]);
check("with the engine version it has always reported", engine.ENGINE_VERSION, "1.0.0");

check("no mongoose connection was opened to get here",
  require("mongoose").connection.readyState, 0);

/** Every file the engine pulls in, transitively. */
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

const engineGraph = graphOf(path.join(SHARED, "intelligence"));

const FORBIDDEN = [
  [/[\\/]node_modules[\\/]mongoose[\\/]/i, "mongoose"],
  [/[\\/]node_modules[\\/]express[\\/]/i,  "express"],
  [/[\\/]node_modules[\\/]axios[\\/]/i,    "axios"],
  [/[\\/]db[\\/]models[\\/]/i,             "a database model"],
  [/[\\/]middleware[\\/]/i,                "middleware"],
  [/[\\/]routes[\\/]/i,                    "a router"],
  [/(fees|finance|financeReports|payroll|feeReminders)\.service\.js$/i, "the fee ledger"],
];
for (const [pattern, what] of FORBIDDEN) {
  check(`the engine cannot reach ${what}`,
    engineGraph.filter((f) => pattern.test(f)).map((f) => path.basename(f)), []);
}

check("and everything it does reach is inside shared/",
  engineGraph.filter((f) => !f.startsWith(SHARED)).map((f) => path.relative(ROOT, f)), []);

// The clock and the network, asserted by reading the source rather than by
// hoping: a Date.now() inside a rule would make the same input produce a
// different answer tomorrow.
const fs = require("fs");
const engineSource = engineGraph.map((f) => fs.readFileSync(f, "utf8")).join("\n");
check("no rule reads the clock",
  /Date\.now\(\)|new Date\(\)/.test(engineSource.replace(/^\s*[/*].*$/gm, "")), false);
check("and nothing fetches",
  /\bfetch\(|https?\.request|XMLHttpRequest/.test(engineSource), false);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 2. the backend kept no second copy ---");
// ═══════════════════════════════════════════════════════════════════════════

const backendInsights  = require(path.join(SRC, "services/intelligence/subjectInsights.service"));
const backendGuidance  = require(path.join(SRC, "services/intelligence/guidance.service"));
const backendOutcome   = require(path.join(SRC, "services/intelligence/interventionOutcome.service"));
const backendHistory   = require(path.join(SRC, "services/intelligence/academicHistory.service"));

// Identity, not equality. A backend function that merely BEHAVED the same would
// be exactly the duplicate this stage exists to remove.
check("the backend's seriesFrom IS the shared one",
  backendInsights.seriesFrom === engine.subjectInsights.seriesFrom, true);
check("so are metricsFor, insightsFor and confidenceFrom",
  [backendInsights.metricsFor  === engine.subjectInsights.metricsFor,
   backendInsights.insightsFor === engine.subjectInsights.insightsFor,
   backendInsights.confidenceFrom === engine.subjectInsights.confidenceFrom],
  [true, true, true]);
check("and the thresholds are the same object, not a copy of the numbers",
  backendInsights.THRESHOLDS === engine.subjectInsights.THRESHOLDS, true);
check("guidanceForProfile is the shared one",
  backendGuidance.guidanceForProfile === engine.guidance.guidanceForProfile, true);
check("the ordering rule is the shared one",
  [backendHistory.byOccurrence === engine.academicOrder.byOccurrence,
   backendHistory.occurrenceOf === engine.academicOrder.occurrenceOf],
  [true, true]);
check("and so is the before/after comparison",
  backendOutcome.compareOutcome === engine.interventionOutcome.compareOutcome, true);

// The rule bodies are gone from the backend files, not merely unused.
const backendSource = [
  "services/intelligence/subjectInsights.service.js",
  "services/intelligence/guidance.service.js",
  "services/intelligence/interventionOutcome.service.js",
  "services/intelligence/academicHistory.service.js",
].map((f) => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n")
  // Comments explain the move and legitimately name these things.
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

for (const [needle, what] of [
  ["academic_decline",             "a risk code"],
  ["subject_strength",             "a strength code"],
  ["RECENT_DECLINE",               "a guidance rationale"],
  ["TARGETED_PRACTICE",            "a guidance action"],
  ["INCREASED_AFTER",              "an outcome reading"],
  ["establishedObservations:",     "a threshold definition"],
]) {
  check(`${what} no longer appears in the backend services`,
    backendSource.includes(needle), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 3. same input, same output ---");
// ═══════════════════════════════════════════════════════════════════════════

const { subjectInsights, guidance, academicOrder, interventionOutcome } = engine;

/** A fixed school year. No clock anywhere in this section. */
const YEAR = "2026-2027";
const exams = [
  { _id: "e1", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 1, startDate: "2026-10-05" },
  { _id: "eca", type: "ca", academicYear: YEAR, term: 1, sequenceNumber: 1, startDate: "2026-10-01" },
  { _id: "e2", type: "test", academicYear: YEAR, term: 1, sequenceNumber: 2, startDate: "2026-11-20" },
  { _id: "e3", type: "test", academicYear: YEAR, term: 2, sequenceNumber: 1, startDate: "2027-02-10" },
  { _id: "e4", type: "test", academicYear: YEAR, term: 2, sequenceNumber: 2, startDate: "2027-03-20" },
];

const mark = (subjectId, subjectName, normalizedMark, extra = {}) => ({
  subjectId, subjectName, normalizedMark,
  score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null,
  isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false,
  ...extra,
});

const summary = (id, examId, term, rows, extra = {}) => ({
  _id: id, examId, studentId: "pupil-1", classId: "c1", schoolId: "s1",
  academicYear: YEAR, term: String(term), isPublished: true,
  percentage: 60, subjectBreakdown: rows,
  createdAt: "2027-01-01T00:00:00.000Z",
  ...extra,
});

/*
 * One pupil carrying every case the brief names, in four subjects:
 *
 *   maths    16 → 15 → 10 → 9      a decline
 *   ict      16 → 17 → 17 → 17     a strength, and a consistent one
 *   physics  0, absent, exempt, unentered, then 8
 *   history  one mark only         insufficient evidence
 *
 * plus a continuous assessment carrying 20 in Mathematics, which must never be
 * counted as an occasion of its own.
 */
const summaries = [
  summary("s1", "e1", 1, [
    mark("maths", "Mathematics", 16), mark("ict", "ICT", 16),
    mark("physics", "Physics", 0), mark("history", "History", 11),
  ]),
  summary("sca", "eca", 1, [mark("maths", "Mathematics", 20)]),
  summary("s2", "e2", 1, [
    mark("maths", "Mathematics", 15), mark("ict", "ICT", 17),
    mark("physics", "Physics", 0, { isAbsent: true, score: null }),
  ]),
  summary("s3", "e3", 2, [
    mark("maths", "Mathematics", 10), mark("ict", "ICT", 17),
    mark("physics", "Physics", 0, { isExempt: true, score: null }),
  ]),
  summary("s4", "e4", 2, [
    mark("maths", "Mathematics", 9), mark("ict", "ICT", 17),
    mark("physics", "Physics", 0, { score: null }),
  ]),
];

const history = academicOrder.orderPublishedHistory(summaries, exams);
const rows = history.get("pupil-1");

check("the continuous assessment is not an occasion",
  rows.map((r) => r.examId), ["e1", "e2", "e3", "e4"]);
check("and the occasions are in the order they were sat",
  rows.map((r) => [r.occurrence.term, r.occurrence.sequence]),
  [[1, 1], [1, 2], [2, 1], [2, 2]]);

const grading = subjectInsights.resolveGradingContext({});
check("a school that configured nothing gets the shipped context",
  [grading.passMark, grading.strongMark, grading.strongBand, grading.strongMarkBasis],
  [10, 14, "B+", "default_grade_band"]);

const series = subjectInsights.seriesFrom(rows);
check("a genuine zero is a mark the pupil earned, and is kept",
  series.get("physics").points.map((p) => p.mark), [0]);
check("an absence, an exemption and an unentered mark are none of them zeros",
  series.get("physics").points.length, 1);
check("the CA mark of 20 never entered Mathematics",
  series.get("maths").points.map((p) => p.mark), [16, 15, 10, 9]);

const profile = subjectInsights.buildProfile({ studentId: "pupil-1", history: rows, grading });

check("Mathematics reads as an established decline",
  profile.insights.filter((i) => i.subjectId === "maths").map((i) => [i.code, i.confidence]),
  [["academic_decline", "strong"]]);
check("ICT reads as an established strength, and a consistent one",
  profile.insights.filter((i) => i.subjectId === "ict").map((i) => [i.code, i.confidence]),
  [["subject_strength", "strong"], ["consistency_strength", "strong"]]);
check("History, with one mark, says nothing at all",
  profile.insights.filter((i) => i.subjectId === "history"), []);
check("and Physics, with one, says nothing either",
  profile.insights.filter((i) => i.subjectId === "physics"), []);
check("four subjects were seen across four sequences",
  [profile.coverage.subjects, profile.coverage.sequences, profile.coverage.sufficient],
  [4, 4, true]);

const items = guidance.guidanceForProfile(profile);
check("guidance projects both sides, and nothing else",
  items.map((g) => [g.subjectName, g.type, g.rationaleCode]),
  [["ICT", "strength_development", "SUBJECT_STRENGTH"],
   ["ICT", "strength_development", "CONSISTENT_STRENGTH"],
   ["Mathematics", "academic_support", "RECENT_DECLINE"]]);
check("the support item carries the evidence that produced it",
  items.find((g) => g.type === "academic_support").evidence
    .filter((e) => ["recent_average", "previous_average", "observations"].includes(e.metric))
    .map((e) => [e.metric, e.value]),
  [["observations", 4], ["recent_average", 9.5], ["previous_average", 15.5]]);

const intervention = {
  _id: "iv-1", schoolId: "s1", studentId: "pupil-1", classId: "c1",
  subjectId: "maths", actionCode: "TARGETED_PRACTICE",
  startedAt: "2027-01-15T00:00:00.000Z", createdAt: "2027-01-10T00:00:00.000Z",
};
const comparison = interventionOutcome.compareOutcome({ intervention, history: rows });
check("before and after split on when the papers were sat",
  [comparison.status, comparison.before.average, comparison.after.average, comparison.change],
  ["compared", 15.5, 9.5, -6]);
check("and the reading is an observation, not a verdict",
  comparison.reading, "DECREASED_AFTER");

// Determinism: the same input, twice, byte for byte.
check("running it twice produces an identical answer",
  JSON.stringify(subjectInsights.buildProfile({ studentId: "pupil-1", history: rows, grading })),
  JSON.stringify(profile));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 4. the backend produces exactly the shared answer ---");
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Not "similar". The backend loader is handed the same rows the shared engine
 * was handed, and the two results are compared as serialised objects. The
 * backend's contribution is the two queries; if it ever adds anything else to
 * the answer, this fails.
 */
const backendProfile = backendInsights.buildProfile({
  studentId: "pupil-1", history: rows, grading,
});
check("the backend's profile is the shared profile, byte for byte",
  JSON.stringify(backendProfile), JSON.stringify(profile));
check("the backend's guidance is the shared guidance, byte for byte",
  JSON.stringify(backendGuidance.guidanceForProfile(backendProfile)),
  JSON.stringify(items));
check("the backend's comparison is the shared comparison, byte for byte",
  JSON.stringify(backendOutcome.compareOutcome({ intervention, history: rows })),
  JSON.stringify(comparison));

// And the desktop handler, which is the third consumer.
const desktopHandlers = require(
  path.join(ROOT, "..", "desktop", "src", "main", "api", "handlers", "intelligence")
);
check("the desktop registers the three intelligence routes",
  desktopHandlers.map((h) => h.route),
  ["GET /api/insights/class/:classId",
   "GET /api/insights/student/:studentId/guidance",
   "GET /api/interventions/:id/evidence"]);

const desktopGraph = graphOf(
  path.join(ROOT, "..", "desktop", "src", "main", "api", "handlers", "intelligence")
);
check("and reaches the engine through shared/, with no copy of its own",
  desktopGraph.some((f) => f.startsWith(path.join(SHARED, "intelligence"))), true);
check("carrying no threshold or rule of its own",
  /establishedObservations|consistencySpread|RECENT_DECLINE|INCREASED_AFTER/.test(
    fs.readFileSync(path.join(ROOT, "..", "desktop", "src", "main", "api", "handlers", "intelligence.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  ), false);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 5. offline: the calculation itself needs no network ---");
// ═══════════════════════════════════════════════════════════════════════════

/*
 * The proof, and it is deliberately not a mock of the calculation.
 *
 * Every outbound door is slammed shut — http, https, dns, net and global fetch
 * all throw — and then the REAL engine computes a real profile, real guidance
 * and a real before/after from plain objects. If anything in the engine
 * reached for a socket, this section would throw rather than pass.
 */
const http  = require("http");
const https = require("https");
const dns   = require("dns");
const net   = require("net");

const boom = () => { throw new Error("NETWORK_USED"); };
const saved = {
  httpRequest:  http.request,  httpsRequest: https.request,
  dnsLookup:    dns.lookup,    netConnect:   net.connect,
  fetch:        global.fetch,
};
http.request = boom; https.request = boom; dns.lookup = boom;
net.connect = boom; global.fetch = boom;

let offlineProfile = null, offlineGuidance = null, offlineComparison = null, threw = null;
try {
  const offlineHistory = academicOrder.orderPublishedHistory(summaries, exams).get("pupil-1");
  // The SAME grading input as the online run above. Handing it a configured
  // school here would change passMarkSource and the comparison would be
  // measuring the fixture rather than the engine.
  const offlineGrading = subjectInsights.resolveGradingContext({});
  offlineProfile = subjectInsights.buildProfile({
    studentId: "pupil-1", history: offlineHistory, grading: offlineGrading,
  });
  offlineGuidance = guidance.guidanceForProfile(offlineProfile);
  offlineComparison = interventionOutcome.compareOutcome({
    intervention, history: offlineHistory,
  });
} catch (err) {
  threw = err.message;
} finally {
  http.request = saved.httpRequest; https.request = saved.httpsRequest;
  dns.lookup = saved.dnsLookup; net.connect = saved.netConnect;
  global.fetch = saved.fetch;
}

check("nothing reached for the network", threw, null);
check("the profile computed offline is the same profile",
  JSON.stringify(offlineProfile), JSON.stringify(profile));
check("the guidance computed offline is the same guidance",
  JSON.stringify(offlineGuidance), JSON.stringify(items));
check("the before/after computed offline is the same comparison",
  JSON.stringify(offlineComparison), JSON.stringify(comparison));
check("and it is a real answer, not an empty one",
  [offlineGuidance.length > 0, offlineComparison.status], [true, "compared"]);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- 6. the engine can be loaded by a consumer with no backend at all ---");
// ═══════════════════════════════════════════════════════════════════════════

/*
 * A device bundle has no backend/ directory beside it. Resolving the engine
 * with backend/node_modules taken out of the picture proves the engine has no
 * dependency that only the server happens to have installed.
 */
let bareLoad = null;
try {
  const bare = new Module(path.join(SHARED, "intelligence", "index.js"));
  bare.paths = [path.join(SHARED, "node_modules")];   // deliberately nonexistent
  bare.load(path.join(SHARED, "intelligence", "index.js"));
  bareLoad = typeof bare.exports.subjectInsights.buildProfile;
} catch (err) {
  bareLoad = `threw: ${err.message}`;
}
check("the engine resolves with no node_modules on its path", bareLoad, "function");

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
