// backend/scripts/check-guidance.js
"use strict";

/**
 * Guidance: the projection from evidence to a suggested action.
 *
 * ── The three ways this layer could go wrong ──────────────────────────────
 *
 * IT COULD SAY MORE THAN THE EVIDENCE DOES. Guidance is the first thing in this
 * stack that tells a teacher to DO something, and the temptation in every
 * product like it is to soften "we do not know yet" into a recommendation.
 * Section 2 gives it a pupil it knows almost nothing about and asserts that
 * what comes back is monitoring, not advice.
 *
 * IT COULD DRIFT INTO A PREDICTION. A subject strength is one short step from
 * "suited to engineering", and that step is the one this product must never
 * take: there is no competency or career taxonomy in this platform, so any such
 * claim would be invented rather than observed. Section 3 reads every field and
 * every string of a real payload looking for one.
 *
 * IT COULD SPEAK ENGLISH TO A FRENCH SCHOOL. The server sends codes and the
 * client renders them in the reader's language, exactly as the watch list
 * already does. A code shipped without its two translations renders as a raw
 * SCREAMING_SNAKE token on a head teacher's screen, and nothing in testing
 * catches that — the fallback is silent. Section 4 asserts that every code the
 * service is capable of emitting exists in both catalogues, and that no item
 * carries a human sentence at all.
 *
 *   node scripts/check-guidance.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const A = "68f0000000000000000000a1";
const B = "68f0000000000000000000b2";
const YEAR = "2026-2027";

const guidance = require(path.join(SRC, "services/intelligence/guidance.service"));

/** A subject breakdown row in the shape results.service actually stores. */
const breakdown = (rows) => rows.map(([subjectId, subjectName, normalizedMark]) => ({
  subjectId, subjectName, normalizedMark,
  score: normalizedMark, maxScore: 20, coefficient: 1,
  grade: null, points: 0, remark: null,
  isPassing: normalizedMark >= 10, isAbsent: false, isExempt: false,
}));

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. one statement in, one action out ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const evidence = [
    { metric: "observations",     value: 4 },
    { metric: "recent_average",   value: 11.2, scale: 20 },
    { metric: "previous_average", value: 15,   scale: 20 },
  ];
  const project = (insight, coverage = { sufficient: true }) =>
    guidance.guidanceForProfile({ coverage, insights: [insight] });

  const [decline] = project({
    code: "academic_decline", confidence: "strong",
    subjectId: "maths", subjectName: "Mathematics", evidence,
  });
  check("a decline becomes academic support, at the priority its evidence earns",
    [decline.type, decline.priority, decline.confidence],
    ["academic_support", "high", "strong"]);
  check("carrying the evidence that produced it, unchanged",
    decline.evidence, evidence);
  check("and naming the insight it came from, so the evidence page is reachable",
    decline.sourceInsightCode, "academic_decline");
  check("with a stable rationale and a stable action list",
    [decline.rationaleCode, ...decline.recommendedActionCodes],
    ["RECENT_DECLINE", "REVIEW_RECENT_ASSESSMENTS", "TARGETED_PRACTICE",
     "MONITOR_NEXT_SEQUENCE"]);

  const [emerging] = project({
    code: "academic_decline", confidence: "emerging",
    subjectId: "maths", subjectName: "Mathematics", evidence,
  });
  check("the same statement on thinner evidence is offered more quietly",
    emerging.priority, "moderate");

  const [strength] = project({
    code: "subject_strength", confidence: "strong",
    subjectId: "maths", subjectName: "Mathematics", evidence,
  });
  check("a strength becomes development work",
    [strength.type, strength.rationaleCode], ["strength_development", "SUBJECT_STRENGTH"]);
  check("and never outranks a child who is struggling",
    strength.priority === "moderate" && decline.priority === "high", true);

  check("a cross-subject strength is shown but earns no action of its own",
    project({ code: "cross_subject_strength", confidence: "strong", evidence }),
    []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. thin evidence produces monitoring, not advice ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const sparse = guidance.guidanceForProfile({
    coverage: { sufficient: false, sequences: 1, subjects: 1 },
    insights: [],
  });
  check("a pupil the system barely knows gets monitoring and nothing else",
    sparse.map((item) => [item.type, item.priority, item.confidence]),
    [["monitoring", "low", "insufficient"]]);
  check("and it says how little it has seen, rather than implying nothing is wrong",
    sparse[0].evidence,
    [{ metric: "observed_sequences", value: 1 }, { metric: "observed_subjects", value: 1 }]);

  check("an insight the engine itself distrusts is never turned into an action",
    guidance.guidanceForProfile({
      coverage: { sufficient: true },
      insights: [{ code: "academic_decline", confidence: "insufficient", evidence }],
    }), []);

  check("no profile at all produces nothing, rather than throwing",
    guidance.guidanceForProfile(null), []);

  check("every guidance item carries evidence",
    [...project({ code: "academic_decline", confidence: "strong", evidence }), ...sparse]
      .every((item) => Array.isArray(item.evidence) && item.evidence.length > 0), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. what guidance must never say ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const everything = [
    ...project({ code: "academic_decline",            confidence: "strong", subjectId: "m", subjectName: "Mathematics", evidence }),
    ...project({ code: "sudden_performance_change",   confidence: "strong", subjectId: "m", subjectName: "Mathematics", evidence }),
    ...project({ code: "persistent_underperformance", confidence: "strong", subjectId: "m", subjectName: "Mathematics", evidence }),
    ...project({ code: "subject_strength",            confidence: "strong", subjectId: "m", subjectName: "Mathematics", evidence }),
    ...project({ code: "sustained_improvement",       confidence: "strong", subjectId: "m", subjectName: "Mathematics", evidence }),
    ...project({ code: "consistency_strength",        confidence: "strong", subjectId: "m", subjectName: "Mathematics", evidence }),
    ...sparse,
  ];
  const blob = JSON.stringify(everything).toLowerCase();

  const CAREER = /career|profession|engineer|doctor|medicine|lawyer|pathway|vocation|suited|destined|will become|should become/;
  check("no career, profession or pathway anywhere in the output",
    CAREER.test(blob), false);

  // Deliberately NOT a bare /repeat/ or /position/: IDENTIFY_REPEATED_ERRORS is
  // about a pupil making the same mistake twice, which is the most useful thing
  // a teacher can be told, and a check that cries wolf gets switched off.
  const ACADEMIC_DECISION =
    /promotion|promoted|repeat_year|repeated_year|pass_fail|class_position|classposition|ranking|\brank\b|expel|discipl|eligib/;
  check("and no academic decision — this layer promotes, ranks and fails nobody",
    ACADEMIC_DECISION.test(blob), false);

  const MONEY = /balance|fee|arrear|owed|debt|invoice|receipt|payment|paid|charge|waive|bursar|amount|xaf|cfa/;
  check("and nothing financial", MONEY.test(blob), false);

  check("the only fields an item carries are the ones a client can render",
    [...new Set(everything.flatMap((item) => Object.keys(item)))].sort(),
    ["confidence", "evidence", "priority", "rationaleCode", "recommendedActionCodes",
     "sourceInsightCode", "subjectId", "subjectName", "type"]);

  check("the categories are the three the evidence can support",
    [...new Set(everything.map((item) => item.type))].sort(),
    ["academic_support", "monitoring", "strength_development"]);

  const graphOf = (entryPoint) => {
    const id = require.resolve(entryPoint);
    require(entryPoint);
    const seen = new Set();
    const walk = (moduleId) => {
      if (seen.has(moduleId)) return;
      seen.add(moduleId);
      for (const child of require.cache[moduleId]?.children ?? []) walk(child.id);
    };
    walk(id);
    return [...seen];
  };
  check("and the module cannot reach the fee ledger to begin with",
    graphOf(path.join(SRC, "services/intelligence/guidance.service"))
      .filter((f) => /(fees|finance|financeReports|payroll|feeReminders)\.service\.js$/i.test(f)),
    []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. both languages, or the code is not shippable ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * Every code the service is CAPABLE of emitting, taken from the service's own
   * tables rather than from a list written here — a list written here would go
   * out of date the moment somebody adds a rationale, which is exactly when the
   * check needs to fire.
   */
  const emittable = [
    ...Object.values(guidance.RISK_GUIDANCE).map((g) => g.rationaleCode),
    ...Object.values(guidance.RISK_GUIDANCE).flatMap((g) => g.actions),
    ...Object.values(guidance.STRENGTH_RATIONALE),
    ...guidance.STRENGTH_ACTIONS,
    "INSUFFICIENT_ACADEMIC_EVIDENCE",
    "MONITOR_NEXT_SEQUENCE",
  ];
  const codes = [...new Set(emittable)].sort();

  const localeDir = path.join(ROOT, "..", "web", "src", "i18n", "locales");
  if (!fs.existsSync(localeDir)) {
    console.log("  SKIPPED — web/src/i18n/locales not found next to this package");
  } else {
    for (const lang of ["en", "fr"]) {
      const catalogue = JSON.parse(
        fs.readFileSync(path.join(localeDir, `${lang}.json`), "utf8")
      )?.guidance ?? {};
      check(`${lang}: every code the service can emit has a translation`,
        codes.filter((code) => !(code in catalogue)), []);
      check(`${lang}: and no translation is left for a code that is gone`,
        Object.keys(catalogue).filter((code) => !codes.includes(code)), []);
      check(`${lang}: no translation is blank`,
        Object.entries(catalogue).filter(([, text]) => !String(text).trim()).map(([k]) => k), []);
    }

    const en = JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8")).guidance;
    const fr = JSON.parse(fs.readFileSync(path.join(localeDir, "fr.json"), "utf8")).guidance;
    check("the two catalogues describe the same set of codes",
      Object.keys(en).sort(), Object.keys(fr).sort());
    check("and French is actually translated, not English copied across",
      codes.filter((code) => en[code] === fr[code]), []);
  }

  check("and the service itself ships no prose for a client to render",
    everything.flatMap((item) =>
      Object.entries(item)
        .filter(([key, value]) =>
          typeof value === "string" && /\s/.test(value) && key !== "subjectName")
        .map(([key]) => key)),
    []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. over the route, with real results behind it ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Student           = mongoose.model("Student");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Exam              = mongoose.model("Exam");
  const ResultSummary     = mongoose.model("ResultSummary");

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`,
    password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a", "teacher", A),
    mkUser("admin-a", "school_admin", A),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st-a1", A, "form3a", "One"),
    pupil("st-a2", A, "form4b", "Two"),
    pupil("st-b1", B, "form1b", "Beta"),
  ]);

  const mkExam = (id, term, sequenceNumber) => ({
    _id: id, schoolId: A, name: id, type: "test", academicYear: YEAR, term,
    sequenceNumber, classId: "form3a", totalMarks: 20, passMark: 10,
    status: "published", resultsPublished: true,
  });
  await Exam.create([mkExam("gx-s1", 1, 1), mkExam("gx-s2", 1, 2), mkExam("gx-s3", 2, 1)]);

  // Mathematics falls 16 → 12 → 8; ICT holds 16 → 17 → 17.
  const summary = (id, examId, term, rows) => ({
    _id: id, examId, studentId: "st-a1", classId: "form3a", schoolId: A,
    academicYear: YEAR, term: String(term), isPublished: true,
    percentage: 60, isPassing: true, subjectsFailed: 0, subjectBreakdown: breakdown(rows),
  });
  await ResultSummary.create([
    summary("gs-1", "gx-s1", 1, [["maths", "Mathematics", 16], ["ict", "ICT", 16]]),
    summary("gs-2", "gx-s2", 1, [["maths", "Mathematics", 12], ["ict", "ICT", 17]]),
    summary("gs-3", "gx-s3", 2, [["maths", "Mathematics",  8], ["ict", "ICT", 17]]),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return async (url) => {
      const res = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
      let body = {}; try { body = await res.json(); } catch { /* empty body */ }
      return { status: res.status, body };
    };
  };
  const teacher = as("teach-a", "teacher", A);
  const admin   = as("admin-a", "school_admin", A);

  let r = await teacher("/insights/student/st-a1/guidance");
  const items = r.body?.data?.guidance ?? [];
  check("a teacher reads guidance for a pupil they teach → 200", r.status, 200);
  // Maths falls 16 → 12 → 8: a slide AND a four-mark step in the latest
  // sequence, so the engine says both and guidance projects both. Two rationales
  // for one subject is the intended behaviour — they are different things for a
  // teacher to look at, and collapsing them would lose the more urgent one.
  check("Mathematics falling produces support, ICT holding produces development",
    items.map((g) => [g.subjectName, g.type, g.rationaleCode]),
    [["ICT", "strength_development", "SUBJECT_STRENGTH"],
     ["ICT", "strength_development", "CONSISTENT_STRENGTH"],
     ["Mathematics", "academic_support", "RECENT_DECLINE"],
     ["Mathematics", "academic_support", "SUDDEN_PERFORMANCE_CHANGE"]]);
  check("and the support item carries the two averages a teacher would ask for",
    (items.find((g) => g.type === "academic_support")?.evidence ?? [])
      .filter((e) => ["recent_average", "previous_average"].includes(e.metric))
      .map((e) => [e.metric, e.value]),
    [["recent_average", 8], ["previous_average", 16]]);

  r = await teacher("/insights/student/st-a2/guidance");
  check("a pupil in a class they do not teach → 403 CLASS_NOT_ASSIGNED",
    [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);

  r = await teacher("/insights/student/st-b1/guidance");
  check("a pupil in another school → 404", r.status, 404);

  r = await admin("/insights/student/st-a1/guidance");
  check("the office reads it too → 200", r.status, 200);

  const MONEY_KEY = /balance|fee|arrear|owed|debt|invoice|receipt|payment|paid|charge|waive|amount|currency|xaf|cfa/i;
  const offending = (node, trail = "$") => {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) return node.flatMap((v, i) => offending(v, `${trail}[${i}]`));
    if (typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) =>
        (MONEY_KEY.test(k) ? [`${trail}.${k}`] : []).concat(offending(v, `${trail}.${k}`)));
    }
    return typeof node === "string" && MONEY_KEY.test(node) ? [`${trail} = ${node}`] : [];
  };
  check("and the real payload carries no financial key or value",
    offending((await teacher("/insights/student/st-a1/guidance")).body), []);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
