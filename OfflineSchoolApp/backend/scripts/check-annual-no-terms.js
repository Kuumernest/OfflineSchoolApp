// backend/scripts/check-annual-no-terms.js
"use strict";

/**
 * docs/39 §4.6k, fixed: a pupil with no term result gets no annual result.
 *
 * The annual layer wrote a row for every active pupil of the class. A pupil
 * with no term result at all got an annual average of 0, grade F, not
 * passing, and was ranked last — a failure recorded for a child who had
 * simply not been assessed. The term layer has always refused exactly this
 * ("not a zero", termGrading.service.js). check:academic pinned the old
 * behaviour on Eve; this suite pins the corrected one on its own data.
 *
 *   A. The class compute: no row for a pupil with no term result, counted as
 *      noTerms (inside skipped, as the term layer counts noMarks); a pupil
 *      with one term still gets a row; places and totalInClass count only
 *      the ranked rows.
 *   B. Rows an earlier run left: an unpublished one is removed; a published
 *      one is left exactly as issued and kept out of the positions.
 *   C. The per-pupil compute does the same; a pupil who later gets a term
 *      result gets a row again; the whole-school compute adds up noTerms.
 *   D. Under D3 "refuse", a class holding a published row is still refused
 *      before anything is written.
 *
 *   node scripts/check-annual-no-terms.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");

  const M = (n) => mongoose.model(n);
  const annualGrading = require("../src/services/annualGrading.service");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const S = "school-nt", YEAR = "2025-2026", C = "c";
  await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR });
  await M("GradingConfig").create({ schoolId: S, caEnabled: false });
  await M("Class").create({ _id: C, schoolId: S, name: "Form 2" });
  const pupil = (id, n) => ({ _id: id, userId: `u-${id}`, schoolId: S, classId: C, className: "Form 2",
    studentName: `Pupil ${n}`, enrollmentNo: `ENR-NT-${n}`, status: "approved", isActive: true });
  // ama: three terms. bih: one term. eve: none. yan: none, with an unpublished
  // row from an earlier run. zed: none, with a published row.
  await M("Student").create([pupil("ama", 1), pupil("bih", 2), pupil("eve", 3), pupil("yan", 4), pupil("zed", 5)]);
  const term = (studentId, t, avg) => ({ schoolId: S, academicYear: YEAR, term: t, classId: C, studentId,
    termAverage: avg, sequenceAverages: [] });
  await M("TermResult").create([term("ama", 1, 14), term("ama", 2, 12), term("ama", 3, 13), term("bih", 1, 9)]);
  const zeroRow = (studentId, isPublished) => ({ schoolId: S, academicYear: YEAR, classId: C, studentId,
    annualAverage: 0, overallGrade: "F", isPassing: false, promotionStatus: "pending",
    classPosition: 5, totalInClass: 5, termAverages: [], isPublished });
  await M("AnnualResult").create([zeroRow("yan", false), zeroRow("zed", true)]);
  const zedBefore = await M("AnnualResult").findOne({ schoolId: S, studentId: "zed" }).lean();

  const rowOf = (id) => M("AnnualResult").findOne({ schoolId: S, academicYear: YEAR, studentId: id, deletedAt: null }).lean();
  const ranks = async () => Object.fromEntries(await Promise.all(["ama", "bih", "eve", "yan", "zed"].map(async (id) => {
    const r = await rowOf(id);
    return [id, r ? [r.annualAverage, r.overallGrade, r.promotionStatus, r.classPosition, r.totalInClass] : null];
  })));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- A/B. the class compute ---");
  const run = await annualGrading.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: C });
  check("two rows computed; three pupils with no term result counted, inside skipped",
    run, { computed: 2, skipped: 3, noTerms: 3 });
  // ama (14·33.33 + 12·33.33 + 13·33.34)/100 = 13; bih one term of three: 9, pending.
  check("rows: ama and bih ranked 1 and 2 of 2; eve none; yan's stale row gone; zed's published row as issued", await ranks(), {
    ama: [13, "B", "promoted", 1, 2], bih: [9, "D", "pending", 2, 2], eve: null, yan: null, zed: [0, "F", "pending", 5, 5],
  });
  check("  zed's published row is untouched, field for field",
    JSON.stringify(await M("AnnualResult").findOne({ schoolId: S, studentId: "zed" }).lean()) === JSON.stringify(zedBefore), true);
  check("  yan's unpublished row is removed outright, not soft-deleted",
    await M("AnnualResult").countDocuments({ schoolId: S, studentId: "yan" }), 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- C. the per-pupil compute ---");
  await M("AnnualResult").create(zeroRow("yan", false));
  const one = (id) => annualGrading.computeStudentAnnualAverage({ schoolId: S, academicYear: YEAR, classId: C,
    studentId: id, studentName: `Pupil ${id}`, admissionNo: null, className: "Form 2" });
  check("eve: no row, null returned", [await one("eve"), await rowOf("eve")], [null, null]);
  check("yan: the stale unpublished row is removed", [await one("yan"), await rowOf("yan")], [null, null]);
  await one("zed");
  check("zed: the published row is untouched",
    JSON.stringify(await M("AnnualResult").findOne({ schoolId: S, studentId: "zed" }).lean()) === JSON.stringify(zedBefore), true);

  await M("TermResult").create(term("eve", 1, 11));
  await annualGrading.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: C });
  check("eve, once she has a term result, gets a row and a place",
    (await ranks()).eve, [11, "C+", "pending", 2, 3]);
  check("  and the others' places count her: ama 1, bih 3",
    [(await rowOf("ama")).classPosition, (await rowOf("bih")).classPosition], [1, 3]);

  const all = await annualGrading.computeAllClassAnnualAverages({ schoolId: S, academicYear: YEAR });
  check("the whole-school compute adds up noTerms", [all.computed, all.noTerms, all.skipped], [3, 2, 2]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- D. D3 refuse ---");
  await M("AcademicStructure").updateOne({ schoolId: S, academicYear: YEAR }, { $set: { rules: { publishedResults: "refuse" } } });
  const beforeRefuse = await M("AnnualResult").find({ schoolId: S }).sort({ studentId: 1 }).lean();
  let code = null;
  try { await annualGrading.computeClassAnnualAverages({ schoolId: S, academicYear: YEAR, classId: C }); }
  catch (err) { code = err.code; }
  check("a class holding a published row is refused, nothing written", [code,
    JSON.stringify(await M("AnnualResult").find({ schoolId: S }).sort({ studentId: 1 }).lean()) === JSON.stringify(beforeRefuse)],
    ["PUBLISHED_RESULTS", true]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
