// backend/scripts/check-complexity-calc.js
"use strict";

/**
 * Queries per call on the paths the agreed calculation changed, held flat:
 * the same number for a class of 5 as for a class of 40, and no more than the
 * ceiling measured when this was written (docs/39 §20.0, detail-check pass).
 * check:complexity covers the annual compute and the card's cohort read; this
 * covers the rest:
 *
 *   /process (processExam), term compute, sequence / term / annual card
 *   payloads, the promotion run, GET /promotion/progression?year, and
 *   "calculate & save" (POST .../reportcard/calculate).
 *
 * A count that grows with the class is an N+1 put back; a count over the
 * ceiling is a new query per call: look before raising it.
 *
 *   node scripts/check-complexity-calc.js
 */

const { stopQuietly } = require("./stopQuietly");
const B = require("path").join(__dirname, "..");
const mongoose = require(B + "/node_modules/mongoose");
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough-xx";
process.env.NODE_ENV   = "test";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// Measured when written (a class of 5 and of 40 alike).
//
// Raised once, looked at first: process, term compute and calculate & save
// each read the school's current year and whether a promotion has closed it
// (+2, rankingScope.service), the one test that decides whether a departed
// pupil's row is dropped from a class ranking. Calculate & save also reads
// the class the pupil's marks were sat in before the stored summary's (+1).
const CEILING = {
  "process one exam, one class": 13,
  "term compute, one class": 12,
  "sequence card payload": 12,
  "term card": 11,
  "annual card": 11,
  "promotion generateRun": 10,
  "progression?year (HTTP)": 8,
  "calculate & save (HTTP)": 23,
};
(async () => {
  const { MongoMemoryServer } = require(B + "/node_modules/mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { monitorCommands: true });
  require(B + "/src/db/models");
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => M(n).init()));
  const YEAR = "2026/2027";
  const schools = { small: ["68e1000000000000000000b1", 5], large: ["68e1000000000000000000b2", 40] };
  for (const [tag, [S, n]] of Object.entries(schools)) {
    await M("School").create({ _id: S, name: `S ${tag}`, code: tag.toUpperCase(), email: `${tag}@example.test`, settings: { academicYear: YEAR } });
    await M("GradingConfig").create({ schoolId: S, passMark: 10, caEnabled: false });
    await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR, rules: { classThresholds: { [`c-${tag}`]: 10 } },
      terms: [{ number: 1, name: "T1", weight: 100, sequences: [{ number: 1, name: "S1", weight: 50 }, { number: 2, name: "S2", weight: 50 }] }] });
    await M("Class").create({ _id: `n-${tag}`, schoolId: S, name: "Next", isFinalYear: true });
    await M("Class").create({ _id: `c-${tag}`, schoolId: S, name: "Form", nextClassId: `n-${tag}` });
    await M("User").create({ _id: `adm-${tag}`, name: "A", email: `adm-${tag}@example.test`, password: "Check-only-passw0rd", role: "school_admin", schoolId: S, isActive: true });
    const st = []; for (let i = 0; i < n; i++) st.push({ _id: `${tag}-p${i}`, userId: `u-${tag}-${i}`, schoolId: S, classId: `c-${tag}`, className: "Form", studentName: `P ${i}`, enrollmentNo: `${tag}${i}`, isActive: true, status: "approved" });
    await M("Student").create(st);
    for (const q of [1, 2]) {
      const ex = `${tag}-s${q}`;
      await M("Exam").create({ _id: ex, schoolId: S, name: `Seq ${q}`, type: "test", academicYear: YEAR, term: 1, sequenceNumber: q, status: "completed", classId: `c-${tag}`, classIds: [`c-${tag}`], totalMarks: 20, passMark: 10, startDate: `2026-0${8 + q}-10` });
      const es = []; for (let m = 0; m < 6; m++) es.push({ _id: `${ex}-es${m}`, examId: ex, subjectId: `sub${m}`, subjectName: `Sub ${m}`, classId: `c-${tag}`, schoolId: S, maxScore: 20, passMark: 10, weight: 100 + 100 * (m % 2) });
      await M("ExamSubject").create(es);
      const sc = []; for (const p of st) for (let m = 0; m < 6; m++) sc.push({ examId: ex, examSubjectId: `${ex}-es${m}`, studentId: p._id, subjectId: `sub${m}`, classId: `c-${tag}`, schoolId: S, maxScore: 20, score: 5 + ((p._id.length * 3 + m * 7 + q) % 14), isAbsent: false });
      await M("StudentScore").insertMany(sc);
    }
  }
  let cmds = []; const onStart = (e) => { if (!["ping", "endSessions", "killCursors", "getMore", "hello", "isMaster"].includes(e.commandName)) cmds.push(`${e.commandName}:${e.command[e.commandName]}`); };
  mongoose.connection.client.on("commandStarted", onStart);
  const counted = async (fn) => { cmds = []; await fn(); return cmds.slice(); };
  const out = {};
  const both = async (label, fn) => {
    const r = {}; for (const [tag, [S]] of Object.entries(schools)) r[tag] = await counted(() => fn(tag, S));
    out[label] = [r.small.length, r.large.length];
    if (r.small.length !== r.large.length) {
      const tally = (a) => a.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
      const ts = tally(r.small), tl = tally(r.large);
      out[label + " (grows)"] = Object.fromEntries(Object.keys(tl).filter((k) => tl[k] !== ts[k]).map((k) => [k, [ts[k] || 0, tl[k]]]));
    }
  };
  const { processExam } = require(B + "/src/services/examProcess.service");
  const term = require(B + "/src/services/termGrading.service");
  const annual = require(B + "/src/services/annualGrading.service");
  const promotion = require(B + "/src/services/promotion.service");
  const cards = require(B + "/src/services/reportCardData.service");
  const { buildStudentReportCardData } = require(B + "/src/controllers/results.controller");
  // warm the policy cache etc. once, uncounted
  // Both sequences once, uncounted: the cold first call warms caches.
  for (const [tag, [S]] of Object.entries(schools)) for (const q of [1, 2]) await processExam({ exam: await M("Exam").findById(`${tag}-s${q}`).lean(), schoolId: S, classId: `c-${tag}` });
  await both("process one exam, one class", async (tag, S) => processExam({ exam: await M("Exam").findById(`${tag}-s1`).lean(), schoolId: S, classId: `c-${tag}` }));
  await both("term compute, one class", (tag, S) => term.computeClassTermAverages({ schoolId: S, academicYear: YEAR, term: 1, classId: `c-${tag}` }));
  // (check:complexity holds the annual compute's count; here it only builds the rows the cards and the run read.)
  for (const [tag, [S]] of Object.entries(schools)) await annual.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: `c-${tag}` });
  await both("sequence card payload", (tag) => buildStudentReportCardData(`${tag}-s1`, `${tag}-p0`));
  await both("term card", (tag, S) => cards.buildTermCard({ schoolId: S, academicYear: YEAR, term: 1, classId: `c-${tag}`, studentId: `${tag}-p0` }));
  await both("annual card", (tag, S) => cards.buildAnnualCard({ schoolId: S, academicYear: YEAR, classId: `c-${tag}`, studentId: `${tag}-p0` }));
  for (const [, [S]] of Object.entries(schools)) {
    await M("AnnualResult").updateMany({ schoolId: S }, { $set: { isPublished: true } });
    await M("TermResult").updateMany({ schoolId: S }, { $set: { isPublished: true } });
  }
  const decided = {};
  await both("promotion generateRun", async (tag, S) => { decided[tag] = (await promotion.generateRun({ schoolId: S, fromYear: YEAR, toYear: "2027/2028", generatedBy: null })).decisions.length; });
  // HTTP: calculate & save, progression
  const express = require(B + "/node_modules/express"), jwt = require(B + "/node_modules/jsonwebtoken");
  const app = express(); app.use(express.json());
  const auth = require(B + "/middleware/auth");
  app.use("/api/results", auth.authenticate, require(B + "/src/routes/results.routes"));
  app.use("/api/promotion", auth.authenticate, require(B + "/src/routes/promotion.routes"));
  const server = app.listen(0); const port = server.address().port;
  const statuses = [];
  const call = (tag, S, method, url) => fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ id: `adm-${tag}`, role: "school_admin", schoolId: S }, process.env.JWT_SECRET)}`, "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined }).then((r) => statuses.push(r.status));
  await both("progression?year (HTTP)", (tag, S) => call(tag, S, "GET", `/api/promotion/progression?year=${encodeURIComponent(YEAR)}`));
  for (const [, [S]] of Object.entries(schools)) await M("ResultSummary").updateMany({ schoolId: S }, { $set: { isPublished: false } });
  await both("calculate & save (HTTP)", (tag, S) => call(tag, S, "POST", `/api/results/${tag}-s1/student/${tag}-p0/reportcard/calculate`));
  server.close();
  mongoose.connection.client.off("commandStarted", onStart);

  console.log("--- the work was done ---");
  check("every pupil summarised, term and year computed (5 and 40)", await Promise.all(Object.values(schools).map(async ([S]) =>
    [await M("ResultSummary").countDocuments({ schoolId: S }), await M("TermResult").countDocuments({ schoolId: S }), await M("AnnualResult").countDocuments({ schoolId: S })])),
    [[10, 5, 5], [80, 40, 40]]);
  check("the run decided every pupil", decided, { small: 5, large: 40 });
  check("every HTTP call answered 200", statuses, [200, 200, 200, 200]);

  console.log("--- queries per call: flat, and under the ceiling ---");
  for (const [label, ceiling] of Object.entries(CEILING)) {
    const [small, large] = out[label];
    check(`${label}: ${small} for 5 pupils, ${large} for 40, ceiling ${ceiling}`, [small === large, large <= ceiling], [true, true]);
    if (out[`${label} (grows)`]) console.log(`       grows: ${JSON.stringify(out[`${label} (grows)`])}`);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e); process.exit(1); });
