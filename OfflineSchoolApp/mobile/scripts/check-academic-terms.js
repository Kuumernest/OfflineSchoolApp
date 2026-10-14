// mobile/scripts/check-academic-terms.js
"use strict";

/**
 * The exam term pickers' source (src/services/academicPeriods.service.js,
 * docs/39 Phase 6 and D4), against the REAL backend route over HTTP, as a
 * teacher:
 *
 *   1. a school of two named semesters is offered those two, by name, in
 *      number order — from GET /api/academic-structure/:schoolId/:year, which
 *      a teacher reads with exams.view;
 *   2. the answer is kept, and offered again with no connection;
 *   3. with neither a connection nor a kept answer, null — the screen then
 *      offers the fixed three terms, as before;
 *   4. termsOfStructure keeps only what Exam.term can hold (1–3).
 *
 *   node scripts/check-academic-terms.js
 */

const path  = require("path");
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

/** One module out of src/, with the device-touching imports stubbed. */
const loadModule = (rel, stubs) => {
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

  const SCHOOL = new mongoose.Types.ObjectId().toString();
  const YEAR = "2026/2027";
  await M("School").create({ _id: SCHOOL, name: "Semester School", email: "sem@example.test" });
  await M("User").create({ _id: "tea", name: "tea", email: "tea@example.test", password: "check-only-password",
    role: "teacher", schoolId: SCHOOL, isActive: true });
  const seq = (number, name) => ({ number, name, weight: 50, assessment: { type: "test" } });
  await M("AcademicStructure").create({ schoolId: SCHOOL, academicYear: YEAR, terms: [
    // Stored out of order on purpose: the picker lists them by number.
    { number: 2, name: "Second Semester", weight: 50, sequences: [seq(3, "Eval 3"), seq(4, "Eval 4")] },
    { number: 1, name: "First Semester",  weight: 50, sequences: [seq(1, "Eval 1"), seq(2, "Eval 2")] },
  ] });

  const auth = require(path.join(BACKEND, "middleware", "auth"));
  const app = express(); app.use(express.json());
  app.use("/api/academic-structure", auth.authenticate, require(path.join(BACKEND, "src", "routes", "academicStructure.routes")));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "tea", role: "teacher", schoolId: SCHOOL }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // The axios instance, as far as this service uses it: get(url) → { data },
  // throwing on a non-2xx or no connection.
  let online = true;
  const urls = [];
  const apiStub = {
    get: async (url) => {
      urls.push(url);
      if (!online) throw new Error("Network Error");
      const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { data: await res.json() };
    },
  };
  const store = new Map();
  const asyncStorage = {
    setItem: async (k, v) => { store.set(k, v); },
    getItem: async (k) => (store.has(k) ? store.get(k) : null),
  };
  const svc = loadModule("src/services/academicPeriods.service.js", {
    "./api": { default: apiStub, __esModule: true },
    "@react-native-async-storage/async-storage": { default: asyncStorage, __esModule: true },
  });

  console.log("--- a teacher, online ---");
  const terms = await svc.fetchAcademicTerms(SCHOOL, YEAR);
  check("the school's two semesters, by name, in number order",
    terms, [{ number: 1, name: "First Semester" }, { number: 2, name: "Second Semester" }]);
  check("the year is encoded in the path", urls[0], `/academic-structure/${SCHOOL}/2026%2F2027`);

  console.log("--- no connection ---");
  online = false;
  check("the kept answer is offered again", await svc.fetchAcademicTerms(SCHOOL, YEAR),
    [{ number: 1, name: "First Semester" }, { number: 2, name: "Second Semester" }]);
  check("a year never read: null, so the screen offers the fixed three", await svc.fetchAcademicTerms(SCHOOL, "2030/2031"), null);
  check("no school or no year: null, and nothing asked", [await svc.fetchAcademicTerms(null, YEAR), urls.length], [null, 3]);

  console.log("--- what a picker can hold ---");
  check("only terms Exam.term can store (1–3), numbers coerced, names trimmed",
    svc.termsOfStructure({ terms: [{ number: "3", name: " Third " }, { number: 4, name: "Fourth" }, { number: 0 }, { number: 1 }] }),
    [{ number: 1, name: "" }, { number: 3, name: "Third" }]);
  check("a structure with no terms: null", svc.termsOfStructure({ terms: [] }), null);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
