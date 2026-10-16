// backend/scripts/check-dry-run-agreed-calc.js
"use strict";

/**
 * scripts/dry-run-agreed-calc.js against an in-memory "source" database
 * holding one school as it would be before the release (docs/40 step 1.5).
 *
 *   1. The report, every figure worked by hand below.
 *   2. No pupil name in it.
 *   3. scripts/list-unconfirmed-bars.js lists the class with no confirmed bar.
 *   4. The source is byte-identical afterwards (after the module run, the
 *      command-line run and the listing): dbHash, every document of every
 *      collection, and every index.
 *
 *   node scripts/check-dry-run-agreed-calc.js
 */

const { stopQuietly } = require("./stopQuietly");
const crypto   = require("crypto");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/*
 * The school, as stored before the release. One term (weight 100) of two
 * sequences (50/50), so the year is the term. Form 1's bar for the year: 13.
 * Pass mark 10, CA off. Maths coefficient 2 (weight 200), English 1, papers /20.
 *
 * Sequence 1 — unpublished, stored by the old route (exam-process/1):
 *          marks (M, E)   old stored          new: (2M + E)/3
 *   ama    18, 6          12 (60 %), 2nd      (36 + 6)/3  = 14, 1st
 *   bih    11, 17         14 (70 %), 1st      (22 + 17)/3 = 13, 2nd
 *   On /20 the old rows read 60/5 = 12 and 70/5 = 14: ama +2, bih −1.
 *   Two changed, largest +2 (ama); both positions move.
 *
 * Sequence 2 — PUBLISHED (ama 60 %, bih 64 %): refused, read as 12 and 12.8,
 * unchanged.
 *
 * Term 1 (old, unpublished): ama 12, 2nd; bih 13.5, 1st.
 *   new: ama (14 + 12)/2 = 13; bih (13 + 12.8)/2 = 12.9 → ama 1st, bih 2nd.
 *   Two changed (+1, −0.6), largest +1 (ama); both positions move.
 * Year (old, unpublished): ama 12 promoted, 2nd; bih 13.5 promoted, 1st.
 *   new: the one term: ama 13, bih 12.9. Against Form 1's bar 13: ama
 *   promoted (no change), bih repeated (promoted → repeated).
 */
const S = "6a00000000000000000000d1", YEAR = "2026/2027";
const DOCS = {
  schools: [{ _id: S, name: "Dry Run School", email: "dry@example.test", settings: { academicYear: YEAR } }],
  gradingconfigs: [{ schoolId: S, caEnabled: false, passMark: 10 }],
  academicstructures: [{ schoolId: S, academicYear: YEAR, deletedAt: null, promotionExams: [],
    terms: [{ number: 1, name: "The year", weight: 100, sequences: [
      { number: 1, name: "S1", weight: 50, assessment: { type: "test" } },
      { number: 2, name: "S2", weight: 50, assessment: { type: "test" } }] }],
    rules: { classThresholds: { f1: 13 } } }],
  classes: [{ _id: "f1", schoolId: S, name: "Form 1", nextClassId: "f2", deletedAt: null },
            { _id: "f2", schoolId: S, name: "Form 2", deletedAt: null }],
  students: [["ama", "Real Name Ama"], ["bih", "Real Name Bih"]].map(([id, name]) => ({
    _id: id, schoolId: S, classId: "f1", className: "Form 1", studentName: name, status: "approved", isActive: true, deletedAt: null })),
  exams: [1, 2].map((n) => ({ _id: `s${n}`, schoolId: S, name: `Sequence ${n}`, type: "test", academicYear: YEAR,
    term: 1, sequenceNumber: n, status: "completed", classId: "f1", classIds: ["f1"], deletedAt: null })),
  examsubjects: [["math", 200], ["eng", 100]].map(([sub, w]) => ({ _id: `s1-${sub}`, examId: "s1", subjectId: sub,
    subjectName: sub, classId: "f1", schoolId: S, maxScore: 20, passMark: 10, weight: w, deletedAt: null })),
  // Sequence 2's marks too (published: 24/40 = 60 %, 25.6/40 = 64 %), as a
  // real published exam has them.
  studentscores: [["s1", "ama", 18, 6], ["s1", "bih", 11, 17], ["s2", "ama", 12, 12], ["s2", "bih", 13, 12.6]]
    .flatMap(([examId, id, m, e]) => [["math", m], ["eng", e]].map(([sub, score]) => ({
      examId, examSubjectId: `${examId}-${sub}`, studentId: id, subjectId: sub, classId: "f1", schoolId: S,
      maxScore: 20, score, isAbsent: false, deletedAt: null }))),
  resultsummaries: [
    ["s1", "ama", 12, 60, 2, false], ["s1", "bih", 14, 70, 1, false],
    ["s2", "ama", 12, 60, 2, true],  ["s2", "bih", 13, 64, 1, true],
  ].map(([examId, studentId, average, percentage, classPosition, isPublished]) => ({
    _id: `${examId}-${studentId}`, examId, studentId, schoolId: S, classId: "f1", average, percentage, classPosition,
    totalInClass: 2, isPublished, maxTotalScore: 40, subjectsTotal: 2, calcVersion: "exam-process/1",
    policyHash: "before", subjectBreakdown: [], deletedAt: null })),
  // String _ids, as the models write them.
  termresults: [["ama", 12, 2], ["bih", 13.5, 1]].map(([studentId, termAverage, classPosition]) => ({
    _id: `tr-${studentId}`, schoolId: S, academicYear: YEAR, term: 1, classId: "f1", studentId, termAverage, classPosition, totalInClass: 2,
    isPassing: true, isPublished: false, sequenceAverages: [], calcVersion: "term/1", deletedAt: null })),
  annualresults: [["ama", 12, 2], ["bih", 13.5, 1]].map(([studentId, annualAverage, classPosition]) => ({
    _id: `ar-${studentId}`, schoolId: S, academicYear: YEAR, classId: "f1", studentId, annualAverage, classPosition, totalInClass: 2,
    promotionStatus: "promoted", isPassing: true, isPublished: false, termAverages: [], calcVersion: "annual/1", deletedAt: null })),
};

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const sourceServer = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  const sourceUri = sourceServer.getUri("schooldb");
  const seed = await mongoose.createConnection(sourceUri).asPromise();
  for (const [coll, docs] of Object.entries(DOCS)) await seed.db.collection(coll).insertMany(docs);
  // An index the source has, which must survive untouched.
  await seed.db.collection("resultsummaries").createIndex({ examId: 1, studentId: 1 }, { unique: true });

  const state = async () => {
    const out = { hash: (await seed.db.command({ dbHash: 1 })).md5, collections: {} };
    for (const c of (await seed.db.listCollections().toArray()).map((x) => x.name).sort()) {
      out.collections[c] = {
        docs: JSON.stringify(await seed.db.collection(c).find({}).sort({ _id: 1 }).toArray()),
        indexes: JSON.stringify(await seed.db.collection(c).indexes()),
      };
    }
    return out;
  };
  const before = await state();

  const { dryRun, text } = require("./dry-run-agreed-calc");
  const report = await dryRun({ sourceUri, schoolId: S, salt: "check" });
  const pid = (id) => `P-${crypto.createHash("sha256").update(`check${id}`).digest("hex").slice(0, 8)}`;

  console.log("--- 1. the report ---");
  check("published for the year: s2's two summaries; no term or annual row", report.published,
    { sequence: 2, term: 0, annual: 0 });
  check("reprocessed: s1; s2 refused (published); one term and one year per class (2 classes)", report.reprocessed,
    { examsProcessed: 1, examsRefusedPublished: 1, termsComputed: 2, termsRefusedPublished: 0, yearsComputed: 2, yearsRefusedPublished: 0 });
  check("sequence: 4 compared, 2 changed, largest +2 (ama, s1: 12 → 14), 2 positions",
    report.sequence, { compared: 4, changed: 2, created: 0, removed: 0, positionsChanged: 2,
      largestChange: { pupil: pid("ama"), of: "s1", from: 12, to: 14, delta: 2 } });
  check("term: 2 changed, largest +1 (ama: 12 → 13), 2 positions",
    report.term, { compared: 2, changed: 2, created: 0, removed: 0, positionsChanged: 2,
      largestChange: { pupil: pid("ama"), of: "term 1", from: 12, to: 13, delta: 1 } });
  check("annual: 2 changed, largest +1 (ama: 12 → 13), 2 positions",
    report.annual, { compared: 2, changed: 2, created: 0, removed: 0, positionsChanged: 2,
      largestChange: { pupil: pid("ama"), of: "year", from: 12, to: 13, delta: 1 } });
  check("promotion: bih promoted → repeated (12.9 < 13); ama unchanged",
    report.promotionStatusChanges, [{ pupil: pid("bih"), from: "promoted", to: "repeated" }]);

  console.log("--- 2. no names ---");
  const printed = JSON.stringify(report) + text(report);
  check("no pupil name, and no raw pupil id, in the report", [/Real Name|"ama"|"bih"|\bama\b|\bbih\b/.test(printed)], [false]);

  // The command line, as an operator runs it: the same report.
  const { execFile } = require("child_process");
  const cli = await new Promise((resolve, reject) => execFile(process.execPath,
    [require("path").join(__dirname, "dry-run-agreed-calc.js"), "--uri", sourceUri, "--school", S, "--salt", "check", "--json"],
    { env: { ...process.env, MONGODB_URI: "" } }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(JSON.parse(out)))));
  check("the command line gives the same report", JSON.stringify(cli), JSON.stringify(report));

  // docs/40 step 7.1: classes with no confirmed bar. Form 1 has one (13);
  // Form 2 has none, and is not a final year, so it is listed.
  console.log("--- classes with no confirmed bar ---");
  const { listUnconfirmedBars } = require("./list-unconfirmed-bars");
  const bars = await listUnconfirmedBars({ uri: sourceUri });
  check("Form 2 listed, Form 1 (bar 13) not", bars.map((b) => [b.schoolId, b.academicYear, b.unconfirmed]),
    [[S, YEAR, [{ classId: "f2", name: "Form 2" }]]]);

  console.log("--- 3. the source is untouched (after the dry runs and the listing) ---");
  const after = await state();
  check("dbHash identical", after.hash, before.hash);
  check("the same collections", Object.keys(after.collections), Object.keys(before.collections));
  check("every document identical", Object.keys(before.collections).every((c) => after.collections[c]?.docs === before.collections[c].docs), true);
  check("every index identical", Object.keys(before.collections).every((c) => after.collections[c]?.indexes === before.collections[c].indexes), true);

  console.log("\n--- example output ---\n" + text(report));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await seed.close();
  await stopQuietly(sourceServer);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
