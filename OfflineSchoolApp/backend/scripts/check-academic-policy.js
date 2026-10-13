// backend/scripts/check-academic-policy.js
"use strict";

/**
 * The academic policy snapshot (docs/39 §6.3, Phase 2b).
 *
 * ── What this pins ────────────────────────────────────────────────────────
 *
 * 1. FAITHFUL. The policy records the configuration the calculations read:
 *    the CA split sequenceAssessment.loadCaSettings returns, the weights and
 *    pass mark termGrading.loadTermContext uses. It records configuration
 *    only — what each writer's code does with it is its calcVersion, stamped
 *    beside the hash (docs/39 §8) — and documents passed in are used as
 *    given, at no query on a warm process.
 * 2. SENSITIVE to every rule a result or card depends on, and INSENSITIVE to
 *    the fields nothing reads — or every inert edit would make a school's
 *    results look stale.
 * 3. STABLE: the same rules give the same hash whatever order the documents
 *    hold them in, and one document however many times they are resolved —
 *    concurrently included.
 * 4. SCOPED: no school, no snapshot; another school's hash reads as nothing.
 * 5. IMMUTABLE: every mutating entry point refuses.
 *
 * Synthetic data only.
 *
 *   node scripts/check-academic-policy.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  const Snapshot      = require("../src/db/models/AcademicPolicySnapshot");
  const Structure     = require("../src/db/models/AcademicStructure");
  const GradingConfig = require("../src/db/models/GradingConfig");
  const Class         = require("../src/db/models/Class");

  const policySvc   = require("../src/services/academicPolicy.service");
  const termGrading = require("../src/services/termGrading.service");
  const sequenceAssessment = require("../src/services/sequenceAssessment.service");
  const shared      = require("../../shared/academicPolicy");
  const { DEFAULT_GRADES } = require("../../shared/gradeScale");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };
  const rejects = async (label, fn, pattern) => {
    try { await fn(); fail++; console.log(`  FAIL ${label}: did not throw`); }
    catch (err) {
      if (pattern.test(String(err.message || err.code))) pass++;
      else { fail++; console.log(`  FAIL ${label}: threw ${err.message}`); }
    }
  };

  const SCHOOL = "sch-pol", OTHER = "sch-pol-other", YEAR = "2026/2027";
  const resolve = (schoolId = SCHOOL, academicYear = YEAR) => {
    policySvc._resetCache();             // every resolve below reads the database
    return policySvc.resolve({ schoolId, academicYear });
  };

  await Structure.create({ schoolId: SCHOOL, academicYear: YEAR });
  await GradingConfig.create({ schoolId: SCHOOL, caEnabled: true, caWeight: 40, testWeight: 60 });
  await Class.create({ _id: "cls-a", schoolId: SCHOOL, name: "Form 1", promotionAverage: 50 });
  await Class.create({ _id: "cls-b", schoolId: SCHOOL, name: "Form 2" });

  // ── 1. The tree a default structure becomes ─────────────────────────────

  console.log("--- periodsFromLegacy ---");
  {
    const structure = (await Structure.findOne({ schoolId: SCHOOL }).lean());
    const periods = shared.periodsFromLegacy(structure, { caEnabled: true, caWeight: 40, testWeight: 60 });
    check("nine periods, parents before children", periods.map((p) => p.key),
      ["t1", "s1", "s2", "t2", "s3", "s4", "t3", "s5", "s6"]);
    check("a term", periods[0], {
      key: "t1", name: "1st Term", kind: "term", parentKey: null, order: 1, weight: 33.33,
      contributesToAnnual: true, scored: false, components: [], legacy: { term: 1, sequence: null },
    });
    check("a sequence, with CA and paper", periods[4], {
      key: "s3", name: "Sequence 3", kind: "sequence", parentKey: "t2", order: 1, weight: 50,
      contributesToAnnual: true, scored: true,
      components: [
        { key: "ca",   assessmentType: "ca",   weight: 40, required: false },
        { key: "test", assessmentType: "test", weight: 60, required: false },
      ],
      legacy: { term: 2, sequence: 3 },
    });
    check("CA off: the paper alone at 100",
      shared.periodsFromLegacy(structure, { caEnabled: false, caWeight: 0, testWeight: 100 })[1].components,
      [{ key: "test", assessmentType: "test", weight: 100, required: false }]);
    check("no structure, no periods", shared.periodsFromLegacy(null, { caEnabled: true }), []);
  }

  // ── 2. Faithful: what the calculations read ─────────────────────────────

  console.log("--- the policy says what the code reads ---");
  const snap = await resolve();
  const policy = snap.policy;
  {
    check("CA = sequenceAssessment.loadCaSettings", policy.grading.ca, await sequenceAssessment.loadCaSettings(SCHOOL));

    for (const term of [1, 2, 3]) {
      const ctx = await termGrading.loadTermContext({ schoolId: SCHOOL, academicYear: YEAR, term });
      const fromPolicy = policy.structure.periods
        .filter((p) => p.kind === "sequence" && p.legacy.term === term)
        .map((p) => [p.legacy.sequence, p.weight]);
      check(`term ${term} sequences and weights = loadTermContext`,
        fromPolicy, ctx.termConfig.sequences.map((s) => [s.number, s.weight ?? 50]));
      check(`term ${term} pass mark = loadTermContext`, policy.grading.passMark, ctx.passMark);
    }

    const structure = await Structure.findOne({ schoolId: SCHOOL }).lean();
    check("term weights = the structure's (what annualGrading reads)",
      policy.structure.periods.filter((p) => p.kind === "term").map((p) => [p.legacy.term, p.weight]),
      structure.terms.map((t) => [t.number, t.weight]));

    check("no school bands configured → null (every writer falls back to the built-in table)", policy.grading.schoolBands, null);
    check("annual promotion-exam inputs", policy.promotion, { promotionExams: [], promotionThreshold: 10 });
    check("configuration only: no code description in the policy",
      ["calcVersion", "ranking", "calcBands", "subjectPassMark", "classOverrides"].filter((k) => JSON.stringify(policy).includes(`"${k}"`)), []);
    check("format", [snap.format, policy.format], [2, 2]);
    check("one calcVersion per writer, all distinct", [Object.keys(shared.CALC_VERSIONS).sort(), new Set(Object.values(shared.CALC_VERSIONS)).size],
      [["annual", "examProcess", "resultsService", "term"], 4]);
    check("the stored policy re-hashes to its id", policySvc.verify(snap), true);
    check("id is a sha256", /^[0-9a-f]{64}$/.test(snap._id), true);
    check("provenance recorded", [!!snap.sources.structureId, !!snap.sources.structureUpdatedAt, !!snap.sources.gradingConfigUpdatedAt],
      [true, true, true]);
  }

  // ── 3. Sensitive and insensitive ────────────────────────────────────────

  console.log("--- what moves the hash, and what must not ---");
  const base = snap._id;
  const sameAfter = async (label, change, undo, expectSame) => {
    await change();
    const after = (await resolve())._id;
    check(`${label} ${expectSame ? "keeps" : "changes"} the hash`, after === base, expectSame);
    await undo();
    check(`${label}: undone, the original hash returns`, (await resolve())._id, base);
  };
  const gc = (set) => GradingConfig.updateOne({ schoolId: SCHOOL }, { $set: set });
  const st = (set) => Structure.updateOne({ schoolId: SCHOOL, academicYear: YEAR }, { $set: set });

  // Rules a result or a printed card depends on.
  await sameAfter("the CA split", () => gc({ caWeight: 30, testWeight: 70 }), () => gc({ caWeight: 40, testWeight: 60 }), false);
  await sameAfter("CA off", () => gc({ caEnabled: false }), () => gc({ caEnabled: true }), false);
  await sameAfter("the pass mark", () => gc({ passMark: 12 }), () => gc({ passMark: 10 }), false);
  await sameAfter("showGrades", () => gc({ showGrades: false }), () => gc({ showGrades: true }), false);
  await sameAfter("school bands",
    () => gc({ grades: DEFAULT_GRADES.map((b, i) => (i === 0 ? { ...b, remark: "Outstanding" } : b)) }),
    () => gc({ grades: [] }), false);
  await sameAfter("a sequence weight", () => st({ "terms.0.sequences.0.weight": 60 }), () => st({ "terms.0.sequences.0.weight": 50 }), false);
  await sameAfter("a term weight", () => st({ "terms.1.weight": 40 }), () => st({ "terms.1.weight": 33.33 }), false);
  await sameAfter("a term name (it is printed)", () => st({ "terms.2.name": "Third Term" }), () => st({ "terms.2.name": "3rd Term" }), false);
  await sameAfter("the structure pass mark", () => st({ passMark: 11 }), () => st({ passMark: 10 }), false);
  await sameAfter("the promotion threshold", () => st({ promotionThreshold: 11 }), () => st({ promotionThreshold: 10 }), false);
  await sameAfter("the promotion exams", () => st({ promotionExams: [6] }), () => st({ promotionExams: [] }), false);

  // Fields nothing reads (shared/academicPolicy.INERT_FIELDS).
  await sameAfter("useGpa/gpaScale/gradingType", () => gc({ useGpa: true, gpaScale: 5, gradingType: "gpa" }),
    () => gc({ useGpa: false, gpaScale: 4, gradingType: "points" }), true);
  await sameAfter("the dead weight fields",
    () => gc({ sequenceWeightingMethod: "custom", sequenceWeights: [{ sequence: 1, weight: 70 }], termWeightingMethod: "custom", termWeights: [{ term: 1, weight: 50 }] }),
    () => gc({ sequenceWeightingMethod: "equal", sequenceWeights: [], termWeightingMethod: "equal", termWeights: [] }), true);
  await sameAfter("annualAverageMethod", () => st({ annualAverageMethod: "sequences" }), () => st({ annualAverageMethod: "terms" }), true);
  await sameAfter("maxAbsences", () => st({ maxAbsences: 30 }), () => st({ maxAbsences: null }), true);
  await sameAfter("a sequence's assessment label", () => st({ "terms.0.sequences.0.assessment.label": "Mid-term" }),
    () => st({ "terms.0.sequences.0.assessment.label": "Test 1" }), true);
  // No result row depends on a class's promotion bar — only the promotion
  // run does, which will carry its own record (shared/academicPolicy).
  await sameAfter("a class promotion bar",
    () => Class.updateOne({ _id: "cls-b" }, { $set: { promotionAverage: 60 } }),
    () => Class.updateOne({ _id: "cls-b" }, { $set: { promotionAverage: null } }), true);
  await sameAfter("re-saving the same values (updatedAt only)",
    () => gc({ caWeight: 40 }), async () => {}, true);
  {
    // The terms array in another order: termGrading finds terms by number.
    const s = await Structure.findOne({ schoolId: SCHOOL }).lean();
    await sameAfter("the terms array reordered", () => st({ terms: [...s.terms].reverse() }), () => st({ terms: s.terms }), true);
  }

  check("canonicalJson ignores key order",
    shared.canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }),
    shared.canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
  check("canonicalJson keeps array order", shared.canonicalJson([1, 2]) === shared.canonicalJson([2, 1]), false);

  // ── 3b. Documents passed in are used as given, and cost nothing warm ────

  console.log("--- preloaded documents ---");
  {
    const structure = await Structure.findOne({ schoolId: SCHOOL, academicYear: YEAR, deletedAt: null }).lean();
    const gradingConfig = await GradingConfig.findOne({ schoolId: SCHOOL }).lean();
    check("preloaded documents give the same snapshot as reading them",
      (await policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR, structure, gradingConfig }))._id, base);

    // Warm (the line above cached it): no query at all.
    let queries = 0;
    const onCmd = (e) => { if (["find", "insert", "update", "aggregate"].includes(e.commandName)) queries += 1; };
    const client = mongoose.connection.getClient();
    client.on("commandStarted", onCmd);
    await policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR, structure, gradingConfig });
    client.off("commandStarted", onCmd);
    check("warm, with both documents passed in: zero queries", queries, 0);

    // Passed in means used, even when the database says otherwise — the
    // snapshot must describe what the CALLER computed with.
    const passed = await policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR, structure,
      gradingConfig: { ...gradingConfig, caWeight: 25, testWeight: 75 } });
    check("a passed-in document is what the snapshot describes", passed.policy.grading.ca, { caEnabled: true, caWeight: 25, testWeight: 75 });
    check("and null passed in means none, not 'go and read it'",
      (await policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR, structure: null, gradingConfig })).policy.structure, null);
  }

  // ── 4. Stable: one document per policy, concurrently too ────────────────

  console.log("--- one document per policy ---");
  {
    const before = await Snapshot.countDocuments({ schoolId: SCHOOL });
    policySvc._resetCache();
    const racers = await Promise.all(Array.from({ length: 8 }, () =>
      policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR })));
    check("eight concurrent resolves agree", new Set(racers.map((r) => r._id)).size, 1);
    check("and add no document", await Snapshot.countDocuments({ schoolId: SCHOOL }), before);

    // A new policy raced the same way: exactly one new document.
    await gc({ caWeight: 35, testWeight: 65 });
    policySvc._resetCache();
    const fresh = await Promise.all(Array.from({ length: 8 }, () =>
      policySvc.resolve({ schoolId: SCHOOL, academicYear: YEAR })));
    check("a new policy, raced eight ways, is one document",
      [new Set(fresh.map((r) => r._id)).size, await Snapshot.countDocuments({ schoolId: SCHOOL })], [1, before + 1]);
    await gc({ caWeight: 40, testWeight: 60 });
  }

  // ── 5. Scoped ───────────────────────────────────────────────────────────

  console.log("--- a school, always ---");
  {
    await rejects("no school → refused", () => policySvc.resolve({ academicYear: YEAR }), /SCHOOL_REQUIRED|school/i);
    await rejects("no year → refused", () => policySvc.resolve({ schoolId: SCHOOL }), /ACADEMIC_YEAR_REQUIRED|year/i);
    await rejects("get with no school → refused", () => policySvc.get(base, {}), /SCHOOL_REQUIRED|school/i);

    // The same rules in another school: a different snapshot.
    await Structure.create({ schoolId: OTHER, academicYear: YEAR });
    await GradingConfig.create({ schoolId: OTHER, caEnabled: true, caWeight: 40, testWeight: 60 });
    await Class.create({ _id: "cls-o", schoolId: OTHER, name: "Form 1", promotionAverage: 50 });
    const other = await resolve(OTHER);
    check("identical rules in two schools are two snapshots", other._id === base, false);
    check("the other school's snapshot is its own", other.schoolId, OTHER);
    check("a hash from another school reads as nothing", await policySvc.get(other._id, { schoolId: SCHOOL }), null);
    check("and its own reads", (await policySvc.get(base, { schoolId: SCHOOL }))?._id, base);

    // A year with no structure: sequence results still compute without one.
    const bare = await resolve(SCHOOL, "2030/2031");
    check("no structure for the year → structure null, grading still recorded",
      [bare.policy.structure, bare.policy.grading.passMark, bare.academicYear], [null, 10, "2030/2031"]);

    // A school with no grading config at all: the shipped defaults.
    const blank = await resolve("sch-pol-blank", YEAR);
    check("no grading config → defaults", [blank.policy.grading.ca, blank.policy.grading.passMarkSource, blank.policy.grading.schoolBands],
      [{ caEnabled: true, caWeight: 40, testWeight: 60 }, "default", null]);
  }

  // ── 6. Immutable ────────────────────────────────────────────────────────

  console.log("--- append-only ---");
  {
    await rejects("updateOne", () => Snapshot.updateOne({ _id: base }, { $set: { format: 99 } }), /append-only/);
    await rejects("updateMany", () => Snapshot.updateMany({}, { $set: { format: 99 } }), /append-only/);
    await rejects("findOneAndUpdate", () => Snapshot.findOneAndUpdate({ _id: base }, { $set: { format: 99 } }), /append-only/);
    await rejects("replaceOne", () => Snapshot.replaceOne({ _id: base }, { format: 99 }), /append-only/);
    await rejects("deleteOne", () => Snapshot.deleteOne({ _id: base }), /append-only/);
    await rejects("deleteMany", () => Snapshot.deleteMany({}), /append-only/);
    await rejects("findOneAndDelete", () => Snapshot.findOneAndDelete({ _id: base }), /append-only/);
    await rejects("save of a loaded document", async () => {
      const doc = await Snapshot.findById(base);
      doc.format = 99;
      await doc.save();
    }, /append-only/);
    const still = await Snapshot.findById(base).lean();
    check("and the snapshot is untouched", [still.format, policySvc.verify(still)], [2, true]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
