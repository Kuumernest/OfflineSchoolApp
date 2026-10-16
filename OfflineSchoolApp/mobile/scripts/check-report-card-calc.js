// mobile/scripts/check-report-card-calc.js
"use strict";

/**
 * "Calculate & Generate Report Card" on the admin pupil-result screen
 * (app/admin/exams/results/[examId]/student/[studentId].js), docs/39 §20.0.
 *
 *   1. The service it calls (src/services/reportCardCalc.service.js), against
 *      the REAL backend route over HTTP: nothing typed on the phone is sent;
 *      the server recalculates the WHOLE CLASS from the stored marks; it is
 *      refused (409 PUBLISHED_RESULTS) when any result in the class is
 *      published, and nothing is written.
 *   2. The screen, by its source only — no test renders it, and no device or
 *      emulator ran it: no editable mark, coefficient, scale or pass mark; the
 *      request goes through the service after a confirmation.
 *   3. The confirmation says, in EN and FR, that the whole class is
 *      recalculated from the stored marks and that a published result in the
 *      class refuses it.
 *
 *   node scripts/check-report-card-calc.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { stopQuietly } =
  require(path.join(__dirname, "..", "..", "backend", "scripts", "stopQuietly"));

const MOBILE  = path.join(__dirname, "..");
const BACKEND = path.join(MOBILE, "..", "backend");
const bmod    = (name) => require(path.join(BACKEND, "node_modules", name));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const loadModule = (rel, stubs = {}) => {
  const abs = path.join(MOBILE, rel);
  const { code } = babel.transformFileSync(abs, {
    presets: [require.resolve("babel-preset-expo")],
    caller:  { name: "check", supportsStaticESM: false },
    babelrc: false, configFile: false,
  });
  const dir = path.dirname(abs);
  const mod = { exports: {} };
  const req = (id) => (id in stubs ? stubs[id] : require(id.startsWith(".") ? path.resolve(dir, id) : id));
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const express  = bmod("express");
  const mongoose = bmod("mongoose");
  const jwt      = bmod("jsonwebtoken");
  const { MongoMemoryServer } = bmod("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(BACKEND, "src", "db", "models"));
  const M = (n) => mongoose.model(n);

  /*
   * One class, one sequence paper, CA off, papers /20. Maths coefficient 2
   * (ExamSubject.weight 200), English 1:
   *   ama  Maths 15, English 9   → (2·15 + 9)/3  = 13
   *   bih  Maths 12, English 18  → (2·12 + 18)/3 = 14
   */
  const SCHOOL = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027";
  await M("School").create({ _id: SCHOOL, name: "Calc School", email: "calc@example.test" });
  await M("User").create({ _id: "adm", name: "adm", email: "adm@example.test", password: "check-only-password",
    role: "school_admin", schoolId: SCHOOL, isActive: true });
  await M("GradingConfig").create({ schoolId: SCHOOL, caEnabled: false, passMark: 10 });
  await M("AcademicStructure").create({ schoolId: SCHOOL, academicYear: YEAR });
  await M("Class").create({ _id: "c1", schoolId: SCHOOL, name: "Form 1" });
  for (const id of ["ama", "bih"]) {
    await M("Student").create({ _id: id, userId: `u-${id}`, schoolId: SCHOOL, classId: "c1", className: "Form 1",
      studentName: `Pupil ${id}`, enrollmentNo: id, status: "approved", isActive: true });
  }
  await M("Exam").create({ _id: "s1", schoolId: SCHOOL, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1,
    sequenceNumber: 1, status: "completed", classId: "c1", classIds: ["c1"] });
  for (const [sub, w] of [["math", 200], ["eng", 100]]) {
    await M("ExamSubject").create({ _id: `s1-${sub}`, examId: "s1", subjectId: sub, subjectName: sub, classId: "c1",
      schoolId: SCHOOL, maxScore: 20, passMark: 10, weight: w, submissionStatus: "approved" });
  }
  for (const [id, math, eng] of [["ama", 15, 9], ["bih", 12, 18]]) {
    for (const [sub, score] of [["math", math], ["eng", eng]]) {
      await M("StudentScore").create({ examId: "s1", examSubjectId: `s1-${sub}`, studentId: id, subjectId: sub,
        classId: "c1", schoolId: SCHOOL, maxScore: 20, score, isAbsent: false });
    }
  }

  const auth = require(path.join(BACKEND, "middleware", "auth"));
  const app = express(); app.use(express.json());
  app.use("/api/results", auth.authenticate, require(path.join(BACKEND, "src", "routes", "results.routes")));
  app.use(require(path.join(BACKEND, "middleware", "errorHandler")));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // The axios instance as this service uses it: post(url, body) → { data },
  // throwing { response: { status, data } } on a non-2xx, as axios does.
  const sent = [];
  const apiStub = {
    post: async (url, body) => {
      sent.push({ url, body });
      const res = await fetch(`${API}${url}`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.response = { status: res.status, data }; throw err; }
      return { data };
    },
  };
  const svc = loadModule("src/services/reportCardCalc.service.js");

  console.log("--- 1. the service, against the real route ---");
  let r = await svc.recalculateClass(apiStub, "s1", "ama");
  const summary = (id) => M("ResultSummary").findOne({ examId: "s1", studentId: id }).lean();
  check("ama: 13 out of 20 from the stored marks, exam-process/3",
    [r.ok, r.data?.average, r.data?.outOf, (await summary("ama"))?.calcVersion], [true, 13, 20, "exam-process/3"]);
  check("  the whole class was recalculated: bih 14", (await summary("bih"))?.average, 14);
  check("  nothing typed on the phone is sent (an empty body)", sent[0]?.body, {});

  await M("ResultSummary").updateOne({ examId: "s1", studentId: "bih" }, { $set: { isPublished: true } });
  const before = JSON.stringify(await M("ResultSummary").find({ examId: "s1" }).sort({ _id: 1 }).lean());
  r = await svc.recalculateClass(apiStub, "s1", "ama");
  check("a classmate's published result refuses it: 409 PUBLISHED_RESULTS", [r.ok, r.status, r.code], [false, 409, "PUBLISHED_RESULTS"]);
  check("  nothing written", JSON.stringify(await M("ResultSummary").find({ examId: "s1" }).sort({ _id: 1 }).lean()), before);

  console.log("--- 2. the screen (source only) ---");
  const screen = fs.readFileSync(path.join(MOBILE, "app/admin/exams/results/[examId]/student/[studentId].js"), "utf8");
  check("no editable field: no TextInput, no scale or pass-mark state, no coefficient editing",
    [/TextInput/.test(screen), /setOutOf|setPassMark/.test(screen), /onChangeText/.test(screen), /handleSubjectChange/.test(screen)],
    [false, false, false, false]);
  check("the request goes through recalculateClass, after an Alert with the confirmation keys",
    [/recalculateClass\(api, examId, studentId\)/.test(screen),
     /Alert\.alert\(\s*t\(CONFIRM\.title\),\s*t\(CONFIRM\.body\)/.test(screen),
     /onPress: \(\) => \{ runCalculate\(\); \}/.test(screen)], [true, true, true]);
  check("no figure is recalculated on the phone (no scale × mark arithmetic)", /\* out \* 100/.test(screen), false);

  console.log("--- 3. the confirmation, EN and FR ---");
  const loc = (lang) => JSON.parse(fs.readFileSync(path.join(MOBILE, `src/i18n/locales/${lang}.json`), "utf8")).studentResult;
  const en = loc("en"), fr = loc("fr");
  check("the keys the screen uses", [svc.CONFIRM.title, svc.CONFIRM.body, svc.CONFIRM.confirm],
    ["studentResult.calcConfirmTitle", "studentResult.calcConfirmBody", "studentResult.calcConfirm"]);
  check("EN: the whole class, from the stored marks; refused if a result is published",
    [/every pupil of this class/.test(en.calcConfirmBody), /stored marks/.test(en.calcConfirmBody), /refused if any result in the class is published/.test(en.calcConfirmBody)],
    [true, true, true]);
  check("FR: la classe entière, à partir des notes enregistrées ; refusé si un résultat est publié",
    [/tous les élèves de cette classe/.test(fr.calcConfirmBody), /notes enregistrées/.test(fr.calcConfirmBody), /refusé si un résultat de la classe est publié/.test(fr.calcConfirmBody)],
    [true, true, true]);
  check("both languages carry every new key", ["calcConfirmTitle", "calcConfirmBody", "calcConfirm", "calcRefusedPublished", "calcFixedHint"]
    .every((k) => typeof en[k] === "string" && typeof fr[k] === "string" && en[k] !== fr[k]), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
