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
 *   E  marks → the previous code alone, then reads (its own cards, beside A);
 *   F  this branch → record (revert-cleanup-agreed-calc.js) → revert → cleanup
 *      (dry run first) → the previous promotion run;
 *   G  this branch → record → the previous code reprocesses → cleanup → run;
 *   P  this branch, then PUBLISHED → record → the previous code reprocesses
 *      → cleanup → run (what publishing under the new code leaves);
 *   Q  as P, but after the revert the school unpublishes first, then cleanup,
 *      reprocess, publish, run.
 *
 * Every database also holds one older summary with a year and a term, as the
 * previous code's "Calculate & save" creates them (cyr, exam x1, 15/20,
 * published): the cleanup must leave it, and the previous run counts it.
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
    // A summary as the previous "Calculate & save" creates one (year and
    // term from the exam, no calcVersion), published long ago.
    await mongoose.connection.db.collection("resultsummaries").insertOne({ _id: "rs-x1-cyr", examId: "x1", studentId: "cyr",
      schoolId: S, classId: "f2", average: 15, percentage: 75, isPassing: true, isPublished: true, academicYear: YEAR, term: "1",
      calcVersion: null, subjectBreakdown: [], deletedAt: null });
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

  if (mode === "publishnew") {
    // Published under this branch, as its publish routes set the flag.
    await M("ResultSummary").updateMany({ schoolId: S, examId: { $in: ["s1", "s2"] } }, { $set: { isPublished: true, publishedAt: new Date() } });
    await M("TermResult").updateMany({ schoolId: S }, { $set: { isPublished: true } });
    await M("AnnualResult").updateMany({ schoolId: S }, { $set: { isPublished: true } });
  }

  if (mode === "unpublish") {
    // The previous code's own unpublish.
    const results = r("src/services/results.service");
    for (const examId of ["s1", "s2"]) await results.unpublishResults(examId);
    await M("TermResult").updateMany({ schoolId: S }, { $set: { isPublished: false } });
    await M("AnnualResult").updateMany({ schoolId: S }, { $set: { isPublished: false } });
  }

  if (mode === "record" || mode === "cleanup" || mode === "cleanupdry") {
    const tool = require("./revert-cleanup-agreed-calc");
    const manifestFile = arg("manifest");
    if (mode === "record") { const m = await tool.record({ uri }); fs.writeFileSync(manifestFile, JSON.stringify(m)); res.recorded = m.rows.length; }
    else res.cleanup = await tool.cleanup({ uri, manifest: JSON.parse(fs.readFileSync(manifestFile, "utf8")), dryRun: mode === "cleanupdry" });
  }

  if (mode === "dumpall") {
    res.all = {};
    for (const c of (await mongoose.connection.db.listCollections().toArray()).map((x) => x.name).sort()) {
      res.all[c] = Object.fromEntries((await mongoose.connection.db.collection(c).find({}).sort({ _id: 1 }).toArray()).map((d) => [String(d._id), JSON.stringify(d)]));
    }
  }

  if (["newcalc", "reprocess", "rows"].includes(mode)) {
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
  let n = 0;
  const step = (code, mode, db) => new Promise((resolve, reject) => {
    const out = path.join(tmp, `${db}-${mode}-${n++}.json`);
    execFile(process.execPath, [__filename, "--phase", mode, "--code", code, "--uri", mem.getUri(db), "--out", out,
      "--manifest", path.join(tmp, `${db}-manifest.json`)],
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
      { "s1|ama": 14, "s1|bih": 13, "s1|cyr": 10.33, "s2|ama": 12, "s2|bih": 12.67, "s2|cyr": 12, "x1|cyr": 15 });
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
      [{ "s1|ama": 12, "s1|bih": 14, "s1|cyr": 11, "s2|ama": 12, "s2|bih": 13, "s2|cyr": 11, "x1|cyr": 15 }, { "1|ama": 12, "1|bih": 13.5, "1|cyr": 11 }, { ama: 12, bih: 13.5, cyr: 11 }]);
    const rowDiffs = (X, Y) => {
      const out = [];
      for (const coll of Object.keys(Y.rows)) {
        const keys = new Set([...Object.keys(X.rows[coll]), ...Object.keys(Y.rows[coll])]);
        for (const k of keys) {
          const x = X.rows[coll][k] || {}, y = Y.rows[coll][k] || {};
          for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
            if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) out.push(`${coll} ${k} ${f}: ${JSON.stringify(x[f])} (never run: ${JSON.stringify(y[f])})`);
          }
        }
      }
      return out;
    };
    const diffs = rowDiffs(B, C);
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

    // ── 4. The cleanup ──────────────────────────────────────────────────
    const changedDocs = (x, y) => {
      const out = [];
      for (const c of new Set([...Object.keys(x.all), ...Object.keys(y.all)])) {
        for (const id of new Set([...Object.keys(x.all[c] || {}), ...Object.keys(y.all[c] || {})])) {
          if ((x.all[c] || {})[id] !== (y.all[c] || {})[id]) out.push(`${c}/${id}`);
        }
      }
      return out.sort();
    };
    const fieldsChanged = (x, y, coll, id) => {
      const a = JSON.parse(x.all[coll][id]), b = JSON.parse(y.all[coll][id]);
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f])).sort();
    };
    const SEQ_IDS = ["s1|ama", "s1|bih", "s1|cyr", "s2|ama", "s2|bih", "s2|cyr"];

    console.log("--- 4. cleanup after the revert, nothing reprocessed (F) ---");
    await step(HEAD, "seed", "F"); await step(HEAD, "newcalc", "F");
    check("recorded: the six summaries this branch wrote, not the older x1", (await step(HEAD, "record", "F")).recorded, 6);
    const f0 = await step(PREV, "dumpall", "F");
    const dry = await step(PREV, "cleanupdry", "F");
    check("dry run: counts, nothing to leave", dry.cleanup,
      { dryRun: true, counts: { inManifest: 6, missing: 0, alreadyClear: 0, changedSince: 0, published: 0, toClear: 6, cleared: 0 } });
    check("dry run writes nothing", changedDocs(f0, await step(PREV, "dumpall", "F")), []);
    const run = await step(PREV, "cleanup", "F");
    check("cleanup: six cleared", run.cleanup.counts.cleared, 6);
    const f1 = await step(PREV, "dumpall", "F");
    const touched = changedDocs(f0, f1);
    check("only the six summaries changed", touched.length, 6);
    check("and in each only academicYear and term", [...new Set(touched.map((t) => fieldsChanged(f0, f1, ...t.split("/")).join(",")))], ["academicYear,term"]);
    check("the older x1 summary keeps its year", JSON.parse(f1.all.resultsummaries["rs-x1-cyr"]).academicYear, YEAR);
    check("a second cleanup finds them already clear", (await step(PREV, "cleanupdry", "F")).cleanup.counts.alreadyClear, 6);
    const promF = await step(PREV, "promote", "F");
    check("the previous run proposes exactly what it did before this branch", promF.decisions, promC.decisions);

    console.log("--- 5. cleanup after the previous code reprocessed (G) ---");
    await step(HEAD, "seed", "G"); await step(HEAD, "newcalc", "G"); await step(HEAD, "record", "G");
    await step(PREV, "reprocess", "G");
    check("cleanup: six cleared (calcVersion is exam-process/1 again by now)", (await step(PREV, "cleanup", "G")).cleanup.counts.cleared, 6);
    const G = await step(PREV, "rows", "G");
    check("every sequence, term and annual row identical to the previous code never having met this branch",
      rowDiffs(G, C).map((d) => d.slice(0, 160)), []);
    const promG = await step(PREV, "promote", "G");
    check("the previous run proposes exactly what it did before this branch", promG.decisions, promC.decisions);

    console.log("--- 6. published under the new code before the revert (P) ---");
    await step(HEAD, "seed", "P"); await step(HEAD, "newcalc", "P"); await step(HEAD, "publishnew", "P");
    check("recorded six, all published", (await step(HEAD, "record", "P")).recorded, 6);
    const repP = await step(PREV, "reprocess", "P");
    const cleanP = await step(PREV, "cleanup", "P");
    check("cleanup leaves the six published summaries as they are", [cleanP.cleanup.counts.published, cleanP.cleanup.counts.cleared], [6, 0]);
    const P = await step(PREV, "rows", "P");
    const promP = await step(PREV, "promote", "P");
    console.log(`       previous process route on published rows: ${JSON.stringify(repP.statuses)}`);
    console.log(`       sequence rows now: ${JSON.stringify(SEQ_IDS.map((k) => [k, P.rows.ResultSummary[k].average, P.rows.ResultSummary[k].calcVersion, P.rows.ResultSummary[k].isPublished, P.rows.ResultSummary[k].academicYear]))}`);
    console.log(`       promotion run: ${JSON.stringify(promP.decisions)}`);
    check("what it leaves: the previous run still finds the published results, and differs", JSON.stringify(promP.decisions) === JSON.stringify(promC.decisions), false);

    console.log("--- 7. published, then unpublished after the revert (Q) ---");
    await step(HEAD, "seed", "Q"); await step(HEAD, "newcalc", "Q"); await step(HEAD, "publishnew", "Q"); await step(HEAD, "record", "Q");
    await step(PREV, "unpublish", "Q");
    check("after unpublishing, cleanup clears the six", (await step(PREV, "cleanup", "Q")).cleanup.counts.cleared, 6);
    await step(PREV, "reprocess", "Q");
    const Q = await step(PREV, "rows", "Q");
    // Unpublishing leaves the date it was published: the one trace of it.
    const qd = rowDiffs(Q, C);
    check("then every row is the previous code's own, except publishedAt on the six once published",
      [qd.filter((d) => !/^ResultSummary s[12]\|\w+ publishedAt: "/.test(d)).map((d) => d.slice(0, 160)), qd.length], [[], 6]);
    const promQ = await step(PREV, "promote", "Q");
    check("and the previous run proposes what it did before this branch", promQ.decisions, promC.decisions);
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
