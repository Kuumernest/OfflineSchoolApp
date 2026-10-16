// backend/scripts/check-revert-previous.js
"use strict";

/**
 * What a code revert leaves behind (docs/40, step 1.4): results reprocessed
 * by this branch, none published, then the previous code deployed again.
 *
 *   node scripts/check-revert-previous.js [--ref origin/master]
 *
 * --ref is the previous code: any git ref (default origin/master). It is
 * checked out into a temporary git worktree, given this checkout's
 * node_modules, and removed afterwards. Not in check:all: it needs the git
 * history and a second checkout.
 *
 * Every step runs in its own process, on its own in-memory database, with the
 * database URI and provider keys blanked:
 *
 *   A  marks → this branch processes, terms, years → the PREVIOUS code reads
 *      (cards, the term layer), then publishes and generates a promotion run;
 *   B  the same → the previous code reprocesses (its own route, over HTTP),
 *      then publishes and generates a run;
 *   C  marks → the previous code alone, as if this branch never ran;
 *   E  marks → the previous code alone, then reads (its own cards, beside A).
 *
 * The school (synthetic). One term (weight 100) of two sequences (50/50), so
 * the year is the term. Pass mark 10, CA off. Maths coefficient 2 (weight
 * 200), English 1, papers /20. Form 1 (ama, bih) has its old 0–100
 * promotionAverage 50 and this branch's per-year bar 13; Form 5 (cyr) is a
 * final year.
 *
 *              S1 (M, E)   S2 (M, E)
 *   ama        18, 6       12, 12
 *   bih        11, 17      13, 12
 *   cyr         9, 13      14, 8
 *
 * This branch, (2M + E)/3:     S1 14, 13, 10.33   S2 12, 12.67, 12
 *   term = year (S1 + S2)/2:   ama 13, bih 12.835 → 12.84, cyr 11.165 → 11.17
 *   against Form 1's bar 13:   ama promoted, bih repeated; cyr graduated.
 * The previous route, round((M + E)/2):
 *                              S1 12, 14, 11      S2 12, round(12.5) = 13, 11
 *   term = year:               ama 12, bih 13.5, cyr 11.
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const S = "6a00000000000000000000e1", YEAR = "2026/2027", NEXT = "2027/2028";
const BLANK = { MONGODB_URI: "", MONGO_URI: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", BREVO_API_KEY: "" };
const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

// ── One step, in a child process, with one tree's code ────────────────────
const phase = async ({ code, mode, uri, out }) => {
  const r = (p) => require(path.join(code, p));
  process.env.JWT_SECRET = "check-only-secret-check-only-secret-xx";
  Object.assign(process.env, BLANK);
  const mongoose = r("node_modules/mongoose");
  await mongoose.connect(uri);
  r("src/db/models");
  const M = (n) => mongoose.model(n);
  const res = {};
  const classesOf = ["f1", "f2"];

  if (mode === "seed") {
    await M("School").create({ _id: S, name: "Revert School", email: "rv@example.test", code: "RV1", settings: { academicYear: YEAR } });
    await M("GradingConfig").create({ schoolId: S, caEnabled: false, passMark: 10 });
    await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR, rules: { classThresholds: { f1: 13 } },
      terms: [{ number: 1, name: "The year", weight: 100, sequences: [{ number: 1, name: "S1", weight: 50 }, { number: 2, name: "S2", weight: 50 }] }] });
    await M("Class").create({ _id: "f2", schoolId: S, name: "Form 5", isFinalYear: true });
    await M("Class").create({ _id: "f1", schoolId: S, name: "Form 1", nextClassId: "f2", promotionAverage: 50 });
    const pupils = [["ama", "f1"], ["bih", "f1"], ["cyr", "f2"]];
    for (const [id, cls] of pupils) {
      await M("Student").create({ _id: id, userId: `usr-${id}`, schoolId: S, classId: cls, className: cls === "f1" ? "Form 1" : "Form 5",
        studentName: `Synthetic ${id}`, enrollmentNo: `E-${id}`, status: "approved", isActive: true });
    }
    await M("User").create({ _id: "adm", name: "Admin", email: "adm@example.test", password: "check-only-password", role: "school_admin", schoolId: S, isActive: true });
    const MARKS = { 1: { ama: [18, 6], bih: [11, 17], cyr: [9, 13] }, 2: { ama: [12, 12], bih: [13, 12], cyr: [14, 8] } };
    // One exam per sequence for the school, as the term layer reads them.
    for (const seq of [1, 2]) {
      await M("Exam").create({ _id: `s${seq}`, schoolId: S, name: `Sequence ${seq}`, type: "test", academicYear: YEAR, term: 1, sequenceNumber: seq,
        status: "completed", classId: "f1", classIds: classesOf, totalMarks: 20, passMark: 10, startDate: `2026-0${8 + seq}-15` });
      for (const cls of classesOf) {
        const es = {};
        for (const [sub, w] of [["math", 200], ["eng", 100]]) {
          es[sub] = (await M("ExamSubject").create({ examId: `s${seq}`, subjectId: sub, subjectName: sub, classId: cls, schoolId: S,
            maxScore: 20, passMark: 10, weight: w, submissionStatus: "approved" }))._id;
        }
        for (const [id, pcls] of pupils) {
          if (pcls !== cls) continue;
          const [m, e] = MARKS[seq][id];
          for (const [sub, score] of [["math", m], ["eng", e]]) {
            await M("StudentScore").create({ examId: `s${seq}`, examSubjectId: es[sub], studentId: id, subjectId: sub, classId: cls, schoolId: S, maxScore: 20, score, isAbsent: false });
          }
        }
      }
    }
  }

  const termsAndYears = async () => {
    for (const classId of classesOf) {
      await r("src/services/termGrading.service").computeClassTermAverages({ schoolId: S, academicYear: YEAR, term: 1, classId });
      await r("src/services/annualGrading.service").computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId });
    }
  };

  if (mode === "newcalc") {
    const { processExam } = r("src/services/examProcess.service");
    for (const exam of await M("Exam").find({ schoolId: S }).lean()) {
      for (const classId of classesOf) {
        const x = await processExam({ exam, schoolId: S, classId });
        if (x.status !== 200) throw new Error(`process ${exam._id}/${classId}: ${x.status}`);
      }
    }
    await termsAndYears();
  }

  if (mode === "reprocess") {
    // The previous code's own route, over HTTP, one class at a time.
    const express = r("node_modules/express"), jwt = r("node_modules/jsonwebtoken");
    const app = express(); app.use(express.json());
    app.use("/api/exams", r("middleware/auth").authenticate, r("src/routes/exam.routes"));
    app.use((err, _q, s, _n) => s.status(err.statusCode || 500).json({ message: err.message }));
    const server = app.listen(0);
    const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.statuses = [];
    for (const exam of await M("Exam").find({ schoolId: S }).sort({ _id: 1 }).lean()) {
      for (const classId of classesOf) {
        const x = await fetch(`http://127.0.0.1:${server.address().port}/api/exams/${exam._id}/process`, { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ classId }) });
        res.statuses.push(x.status);
      }
    }
    server.close();
    await termsAndYears();
  }

  if (mode === "read") {
    const { buildStudentReportCardData } = r("src/controllers/results.controller");
    const cards = r("src/services/reportCardData.service");
    res.seqCards = {}; res.termCards = {}; res.annualCards = {};
    for (const [cls, sid] of [["f1", "ama"], ["f1", "bih"], ["f2", "cyr"]]) {
      const c = (await buildStudentReportCardData("s1", sid)).data;
      res.seqCards[sid] = [c?.summary?.average ?? null, c?.computed?.weightedAverage ?? null];
      const t = await cards.buildTermCard({ schoolId: S, academicYear: YEAR, term: 1, classId: cls, studentId: sid });
      res.termCards[sid] = t?.summary?.average ?? null;
      const a = await cards.buildAnnualCard({ schoolId: S, academicYear: YEAR, classId: cls, studentId: sid });
      res.annualCards[sid] = [a?.summary?.average ?? null, a?.summary?.promotionStatus ?? null];
    }
    // The previous term layer reading the sequence rows as they stand.
    for (const classId of classesOf) await r("src/services/termGrading.service").computeClassTermAverages({ schoolId: S, academicYear: YEAR, term: 1, classId });
    res.termLayer = Object.fromEntries((await M("TermResult").find({ schoolId: S, term: 1 }).lean()).map((x) => [x.studentId, x.termAverage]).sort());
  }

  if (mode === "promote") {
    // As a school would after the revert: publish, then generate the run.
    const results = r("src/services/results.service");
    for (const exam of await M("Exam").find({ schoolId: S }).lean()) await results.publishResults(exam._id);
    await M("TermResult").updateMany({ schoolId: S }, { $set: { isPublished: true } });
    await M("AnnualResult").updateMany({ schoolId: S }, { $set: { isPublished: true } });
    const { decisions } = await r("src/services/promotion.service").generateRun({ schoolId: S, fromYear: YEAR, toYear: NEXT, generatedBy: null });
    res.decisions = Object.fromEntries(decisions.map((d) => [d.studentId, [d.outcome, d.basis, d.average ?? null]]).sort());
  }

  if (["newcalc", "reprocess"].includes(mode)) {
    const strip = ({ _id, createdAt, updatedAt, lastSyncedAt, __v, policyHash, subjectBreakdown, ...rest }) => ({
      ...rest,
      // The same subjects; the order they are stored in follows the marks' read order.
      subjectBreakdown: [...(subjectBreakdown || [])].sort((x, y) => (String(x.subjectId) < String(y.subjectId) ? -1 : 1)),
    });
    res.rows = {};
    for (const [name, key] of [["ResultSummary", (x) => `${x.examId}|${x.studentId}`], ["TermResult", (x) => `${x.term}|${x.studentId}`], ["AnnualResult", (x) => x.studentId]]) {
      res.rows[name] = Object.fromEntries((await M(name).find({ schoolId: S }).lean()).map((x) => [key(x), strip(x)]).sort());
    }
  }

  fs.writeFileSync(out, JSON.stringify(res));
  await mongoose.disconnect();
};

// ── The check ─────────────────────────────────────────────────────────────
const main = async () => {
  const { execFile, execFileSync } = require("child_process");
  const ref = arg("ref", "origin/master");
  const HEAD = path.join(__dirname, "..");
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HEAD }).toString().trim();
  const sub  = path.relative(repo, HEAD);   // OfflineSchoolApp/backend
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), "revert-"));
  const tree = path.join(tmp, "tree");
  execFileSync("git", ["worktree", "add", "--detach", tree, ref], { cwd: repo, stdio: "ignore" });
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: tree }).toString().trim();
  const PREV = path.join(tree, sub);
  fs.symlinkSync(path.join(HEAD, "node_modules"), path.join(PREV, "node_modules"));

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mem = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  // Asynchronous: a blocked event loop here stops draining mongod's output, and mongod stalls.
  const step = (code, mode, db) => new Promise((resolve, reject) => {
    const out = path.join(tmp, `${db}-${mode}.json`);
    execFile(process.execPath, [__filename, "--phase", mode, "--code", code, "--uri", mem.getUri(db), "--out", out],
      { env: { ...process.env, ...BLANK }, maxBuffer: 1 << 26 },
      (err, _o, e) => (err ? reject(new Error(`${mode} on ${db}: ${e.split("\n").filter((l) => /fail|Error/.test(l)).slice(0, 4).join(" | ")}`))
        : resolve(JSON.parse(fs.readFileSync(out, "utf8")))));
  });

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  try {
    console.log(`previous code: ${ref} (${sha})`);
    await step(HEAD, "seed", "A"); const NEW = await step(HEAD, "newcalc", "A");
    const read = await step(PREV, "read", "A"); const promA = await step(PREV, "promote", "A");
    await step(HEAD, "seed", "B"); await step(HEAD, "newcalc", "B");
    const B = await step(PREV, "reprocess", "B"); const promB = await step(PREV, "promote", "B");
    await step(HEAD, "seed", "C"); const C = await step(PREV, "reprocess", "C"); const promC = await step(PREV, "promote", "C");
    await step(HEAD, "seed", "E"); await step(PREV, "reprocess", "E"); const readOwn = await step(PREV, "read", "E");

    const fig = (rows, f) => Object.fromEntries(Object.entries(rows).map(([k, x]) => [k, x[f]]));
    console.log("--- this branch's rows (hand-worked above) ---");
    check("sequence averages", fig(NEW.rows.ResultSummary, "average"),
      { "s1|ama": 14, "s1|bih": 13, "s1|cyr": 10.33, "s2|ama": 12, "s2|bih": 12.67, "s2|cyr": 12 });
    check("term and year", [fig(NEW.rows.TermResult, "termAverage"), fig(NEW.rows.AnnualResult, "annualAverage")],
      [{ "1|ama": 13, "1|bih": 12.84, "1|cyr": 11.17 }, { ama: 13, bih: 12.84, cyr: 11.17 }]);
    check("statuses", fig(NEW.rows.AnnualResult, "promotionStatus"), { ama: "promoted", bih: "repeated", cyr: "graduated" });

    console.log("--- 1. the previous code reads them (nothing reprocessed) ---");
    check("sequence card: stored average = the card's rebuilt figure", read.seqCards,
      { ama: [14, 14], bih: [13, 13], cyr: [10.33, 10.33] });
    check("term card: the stored term average", read.termCards, { ama: 13, bih: 12.84, cyr: 11.17 });
    check("annual card: the stored average and status", read.annualCards,
      { ama: [13, "PROMOTED TO THE NEXT CLASS"], bih: [12.84, "REPEATED"], cyr: [11.17, "GRADUATED"] });
    check("the previous term layer reads the new sequence rows on /20", read.termLayer, { ama: 13, bih: 12.84, cyr: 11.17 });
    check("on its own rows the previous card rebuilds from the marks (14, 13, 10.33) beside its stored mean",
      readOwn.seqCards, { ama: [12, 14], bih: [14, 13], cyr: [11, 10.33] });

    console.log("--- 2. the previous code reprocesses them ---");
    check("every process call 200", B.statuses, [200, 200, 200, 200]);
    check("its own figures: S1 12, 14, 11; S2 12, 13, 11; term = year 12, 13.5, 11",
      [fig(B.rows.ResultSummary, "average"), fig(B.rows.TermResult, "termAverage"), fig(B.rows.AnnualResult, "annualAverage")],
      [{ "s1|ama": 12, "s1|bih": 14, "s1|cyr": 11, "s2|ama": 12, "s2|bih": 13, "s2|cyr": 11 }, { "1|ama": 12, "1|bih": 13.5, "1|cyr": 11 }, { ama: 12, bih: 13.5, cyr: 11 }]);
    const diffs = [];
    for (const coll of Object.keys(C.rows)) {
      const keys = new Set([...Object.keys(B.rows[coll]), ...Object.keys(C.rows[coll])]);
      for (const k of keys) {
        const x = B.rows[coll][k] || {}, y = C.rows[coll][k] || {};
        for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
          if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) diffs.push(`${coll} ${k} ${f}: ${JSON.stringify(x[f])} (never run: ${JSON.stringify(y[f])})`);
        }
      }
    }
    const leftover = diffs.filter((d) => /^ResultSummary \S+ (academicYear: "2026\/2027" \(never run: null\)|term: "1" \(never run: null\))$/.test(d));
    check("term and annual rows identical to the previous code never having met this branch",
      diffs.filter((d) => !d.startsWith("ResultSummary")), []);
    check("sequence rows identical except two fields left on every one: academicYear and term",
      [diffs.length - leftover.length, leftover.length], [0, 12]);
    for (const d of leftover.slice(0, 2)) console.log(`       e.g. ${d}`);

    console.log("--- 3. the previous code's promotion run, after publishing ---");
    console.log(`       never met this branch:      ${JSON.stringify(promC.decisions)}`);
    console.log(`       read as left:               ${JSON.stringify(promA.decisions)}`);
    console.log(`       reprocessed after revert:   ${JSON.stringify(promB.decisions)}`);
    check("never met this branch: no pupil has a result (its summaries carry no year)",
      Object.values(promC.decisions).map((d) => d[1]), ["no_results", "no_results", "final_year"]);
    check("after the revert, reprocessed or not: Form 1 judged on its summaries against the old 0-100 bar 50",
      [Object.values(promA.decisions).map((d) => d.slice(0, 2)), Object.values(promB.decisions).map((d) => d.slice(0, 2))],
      [[["repeated", "average_fail"], ["repeated", "average_fail"], ["graduated", "final_year"]],
       [["repeated", "average_fail"], ["repeated", "average_fail"], ["graduated", "final_year"]]]);
  } finally {
    await mem.stop().catch(() => {});
    try { execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: repo, stdio: "ignore" }); } catch { /* left for git worktree prune */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

if (arg("phase")) {
  phase({ code: arg("code"), mode: arg("phase"), uri: arg("uri"), out: arg("out") })
    .then(() => process.exit(0))
    .catch((err) => { console.error(`phase failed: ${err.stack || err.message}`); process.exit(1); });
} else {
  main().catch((err) => { console.error("check failed:", err.message); process.exit(1); });
}
