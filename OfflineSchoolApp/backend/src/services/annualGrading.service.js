// backend/src/services/annualGrading.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANNUAL GRADING SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Computes annual averages from per-term results.
 *
 * Annual average = the term averages weighted by the year's term weights
 * (AcademicStructure).
 *
 * Promotion status (shared/academicRules promotionUnderRules, docs/39 §21.1):
 *   - pending until every term of the year has a complete result;
 *   - then the annual average against the class's bar out of 20 (or the
 *     school's, or the pass mark): promoted at or above it, repeated below;
 *   - a final-year class graduates.
 */

const mongoose          = require("mongoose");
const TermResult        = require("../db/models/TermResult");
const AnnualResult      = require("../db/models/AnnualResult");
const AcademicStructure = require("../db/models/AcademicStructure");
const GradingConfig     = require("../db/models/GradingConfig");
const grading           = require("./grading.service");
const { competitionPlaces } = require("./termGrading.service");
const academicPolicy    = require("./academicPolicy.service");
const { rosterDecides } = require("./rankingScope.service");
const { rankAcrossClasses } = require("./schoolRanking.service");
const { CALC_VERSIONS, legacyTermsFromPeriods } = require("../../../shared/academicPolicy");
const { effectiveRules, calcVersionFor, promotionUnderRules } = require("../../../shared/academicRules");

// ── Helpers ─────────────────────────────────────────────────────────────────

function lookupGrade(markOutOf20) {
  return grading.lookupGrade(markOutOf20);
}

// The terms come from the snapshot's period tree (docs/39 Phase 3).
function getTermWeights(periods) {
  return legacyTermsFromPeriods(periods).map((t) => ({
    term:   t.number,
    weight: t.weight,
  }));
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Compute the annual average for a single student.
 *
 * @param {Object} opts
 * @param {string}  opts.schoolId
 * @param {string}  opts.academicYear
 * @param {string}  opts.classId
 * @param {string}  opts.studentId
 * @param {string} [opts.studentName]
 * @param {string} [opts.admissionNo]
 * @param {string} [opts.className]
 * @returns {Object} AnnualResult document (upserted)
 */
/**
 * What every pupil of a class shares: the year's structure, the pass mark and
 * the promotion exams. Loaded once per class rather than once per pupil — the
 * per-pupil version read the structure, the config, the term results and the
 * promotion exams for each pupil in turn, so a school of forty classes made
 * about five sequential round trips per pupil, four of them for documents
 * that are the same for everyone in the class.
 */
async function annualContextFor({ schoolId, academicYear }) {
  const structure = await AcademicStructure.findOne({
    schoolId,
    academicYear,
    deletedAt: null,
  }).lean();

  if (!structure) {
    throw new Error(`No academic structure found for ${schoolId} / ${academicYear}`);
  }

  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();
  const passMark = gradingConfig?.passMark ?? 10;

  // The configuration this year is computed under, frozen and named (docs/39
  // §8), from the documents just read — no further query on a warm process,
  // which keeps a class's cost fixed (check-complexity).
  const policy = await academicPolicy.resolve({ schoolId, academicYear, structure, gradingConfig });
  const termWeights = getTermWeights(policy.policy.structure.periods);

  // Promotion exams do not decide promotion under the decided rule (the
  // annual average against the class's bar, docs/39 §14); they are read by
  // nothing here. AcademicStructure.promotionExams still names them for the
  // exam screens and the cards.
  const promotionExamIds = [];

  const rules = effectiveRules(policy.policy.rules);
  return {
    structure, passMark, termWeights, promotionExamIds, policyHash: policy._id,
    // The rules in force (shared/academicRules, decided 2026-10-16), from the
    // same snapshot: the school's bands on the stored row, promotion by the
    // annual average against the class's bar.
    rules,
    rawRules:    policy.policy.rules,
    calcVersion: calcVersionFor("annual"),
    gradeOf: (mark) => grading.lookupSchoolGrade(mark, gradingConfig),
  };
}

/**
 * The annual row for one pupil, from the term results and promotion results
 * already in hand. Pure: no database. The promotion status follows the rule
 * in the file header.
 */
function annualRowFor(ctx, { termResults, promotionResults, classId = null, isFinalYear = false }) {
  const { passMark, termWeights } = ctx;
  // The school's bands; the built-in scale only for a context built by hand.
  const gradeOf = ctx.gradeOf || lookupGrade;

  // 5. Build per-term averages
  const termAverages = [];
  let totalWeightedAvg = 0;
  let totalWeight = 0;
  let completedTerms = 0;

  for (const tw of termWeights) {
    const tr = termResults.find((r) => r.term === tw.term);
    const avg = tr?.termAverage ?? null;
    const grade = avg != null ? gradeOf(avg) : null;

    termAverages.push({
      term:         tw.term,
      average:      avg ?? 0,
      overallGrade: grade?.grade ?? null,
      isComplete:   avg != null,
    });

    if (avg != null) {
      totalWeightedAvg += avg * tw.weight;
      totalWeight += tw.weight;
      completedTerms++;
    }
  }

  // 6. Compute weighted annual average
  const annualAverage = totalWeight > 0
    ? Math.round((totalWeightedAvg / totalWeight) * 100) / 100
    : 0;

  const annualGrade = gradeOf(annualAverage);
  const isPassing = annualAverage >= passMark;

  // 7. Promotion status: the one function the promotion run also proposes
  // by (shared/academicRules promotionUnderRules, docs/39 §14). The annual
  // average against the class's bar, the school's pass mark when no bar is
  // set; pending until every term of the year is complete.
  const { status: decided } = promotionUnderRules(ctx.rawRules, {
    annualAverage,
    terms: termAverages.map((ta) => ({ isComplete: ta.isComplete })),
    termsInYear: termWeights.length,
    classId,
    passMark,
  });
  // A final-year class graduates, whatever the average — as the promotion
  // run proposes (promotion.service proposeUnderRules). The row said
  // "promoted" or "repeated" against the bar while the run graduated the
  // pupil (decided 2026-10-16). Average, grade and place are unchanged.
  const promotionStatus = isFinalYear ? "graduated" : decided;

  return { termAverages, annualAverage, annualGrade, promotionStatus, isPassing };
}

/** The $set an annual result is written with. */
const annualSetFor = ({ studentName, admissionNo, className }, ctx, row) => ({
  studentName:         studentName ?? null,
  admissionNo:         admissionNo ?? null,
  className:           className ?? null,
  termAverages:        row.termAverages,
  annualAverage:       row.annualAverage,
  overallGrade:        row.annualGrade.grade,
  overallRemark:       row.annualGrade.remark,
  promotionStatus:     row.promotionStatus,
  // The structure-level promotionThreshold is no longer copied here: nothing
  // reads it, and the bar a row was judged by is the year's (rules) — decided
  // 2026-10-16, docs/41 §7. Rows written before keep what they hold.
  isPassing:           row.isPassing,
  policyHash:          ctx.policyHash ?? null,
  calcVersion:         ctx.calcVersion ?? CALC_VERSIONS.annual,
  syncStatus:          "pending",
});

async function computeStudentAnnualAverage({
  schoolId,
  academicYear,
  classId,
  studentId,
  studentName,
  admissionNo,
  className,
}) {
  const ctx = await annualContextFor({ schoolId, academicYear });
  const { structure, passMark, termWeights } = ctx;
  void passMark; void termWeights;

  // 4. Load all 3 TermResults for this student
  const termResults = await TermResult.find({
    schoolId,
    academicYear,
    classId,
    studentId,
    deletedAt: null,
  }).lean();

  // The promotion results, read only when the structure names promotion
  // exams, as before.
  let promotionResults = [];
  if (ctx.promotionExamIds.length > 0) {
    const ResultSummary = require("../db/models/ResultSummary");
    promotionResults = await ResultSummary.find({
      examId: { $in: ctx.promotionExamIds },
      studentId,
      classId,
      schoolId,
      deletedAt: null,
    }).lean();
  }
  void structure;

  // No term result, no annual result — as the term layer writes no row for a
  // pupil with no marks. This wrote a 0, an F and last place for a pupil who
  // had simply not been assessed (docs/39 §4.6k). An unpublished row left by
  // an earlier run goes; a published one stays exactly as it was issued.
  if (termResults.length === 0) {
    await AnnualResult.deleteOne({
      schoolId, academicYear, classId, studentId, isPublished: { $ne: true },
    });
    return null;
  }

  // A published row is never recomputed in place (D3, decided).
  if (await AnnualResult.exists({ schoolId, academicYear, classId, studentId, isPublished: true, deletedAt: null })) {
    const err = new Error("This annual result is published. Unpublish it first.");
    err.status = 409; err.code = "PUBLISHED_RESULTS";
    throw err;
  }

  const cls = await mongoose.model("Class").findOne({ _id: classId, schoolId }).select("isFinalYear").lean();
  const row = annualRowFor(ctx, { termResults, promotionResults, classId, isFinalYear: Boolean(cls?.isFinalYear) });

  // 8. Upsert AnnualResult
  const filter = {
    schoolId,
    academicYear,
    classId,
    studentId,
  };

  const update = { $set: annualSetFor({ studentName, admissionNo, className }, ctx, row) };

  const result = await AnnualResult.findOneAndUpdate(filter, update, {
    upsert: true,
    returnDocument: 'after',
    setDefaultsOnInsert: true,
  });

  return result;
}

/**
 * Compute annual averages for ALL students in a class.
 *
 * @param {Object} opts
 * @param {string}  opts.schoolId
 * @param {string}  opts.academicYear
 * @param {string}  opts.classId
 * @returns {{ computed: number, skipped: number, noTerms: number }}
 *   skipped includes noTerms: pupils with no term result, who get no row.
 */
async function computeClassAnnualAverages({
  schoolId,
  academicYear,
  classId,
  schoolPlaces = true,
}) {
  // The class name, resolved once from the class being computed.
  //
  // This was `student.className`, copied straight off the pupil document. A
  // pupil enrolled without that string — three on this school's roster were,
  // on the day they were admitted — got a term result with no class on it,
  // and the exams and results screens showed the column empty for them while
  // every other screen had them in Form 1.
  //
  // classId is what the whole computation is scoped by, so the name is one
  // lookup for the entire class rather than a join per pupil. The stored
  // string still wins when it is there, because a pupil moved mid-term keeps
  // the class the term was actually sat in.
  const classDoc = await mongoose.model("Class")
    .findOne({ _id: classId, schoolId })
    .select("_id name isFinalYear")
    .lean()
    .catch(() => null);
  const resolvedClassName = classDoc?.name ?? null;

  const Student = mongoose.model("Student");
  const students = await Student.find({
    schoolId,
    classId,
    isActive: true,
    deletedAt: null,
  }).lean();

  let computed = 0;
  let skipped  = 0;
  let noTerms  = 0;
  let excluded = [];
  const computedIds = [];

  // A published annual row is never recomputed in place (D3, decided). Asked
  // before anything else, roster or none: a class whose pupils have all left
  // still reaches the positions below, which would re-rank a published row.
  {
    const published = await AnnualResult.countDocuments({
      schoolId, academicYear, classId, isPublished: true, deletedAt: null,
    });
    if (published > 0) {
      const err = new Error(`${published} published annual result(s) would be recomputed. Unpublish them first.`);
      err.status = 409; err.code = "PUBLISHED_RESULTS"; err.published = published;
      throw err;
    }
  }

  if (students.length > 0) {
    // One context for the class (an absent structure fails the whole class,
    // as it failed every pupil of it before), one read of the class's term
    // results grouped by pupil, one read of the promotion results, one write.
    const ctx = await annualContextFor({ schoolId, academicYear });
    // Student._id, which is what TermResult.studentId holds and what
    // buildAnnualCard looks the pupil up by. Reading the login id here
    // matched no term results at all for any pupil who had an account.
    const ids = students.map((s) => String(s._id));
    const termRows = await TermResult.find({
      schoolId, academicYear, classId, studentId: { $in: ids }, deletedAt: null,
    }).lean();
    const termsByStudent = new Map();
    for (const tr of termRows) {
      const k = String(tr.studentId);
      if (!termsByStudent.has(k)) termsByStudent.set(k, []);
      termsByStudent.get(k).push(tr);
    }
    const promoByStudent = new Map();
    if (ctx.promotionExamIds.length > 0) {
      const ResultSummary = require("../db/models/ResultSummary");
      const promoRows = await ResultSummary.find({
        examId: { $in: ctx.promotionExamIds }, studentId: { $in: ids }, classId, schoolId, deletedAt: null,
      }).lean();
      for (const pr of promoRows) {
        const k = String(pr.studentId);
        if (!promoByStudent.has(k)) promoByStudent.set(k, []);
        promoByStudent.get(k).push(pr);
      }
    }

    const ops = [];
    const noTermIds = [];
    for (const student of students) {
      try {
        const k = String(student._id);
        // No term result, no annual row (docs/39 §4.6k): see
        // computeStudentAnnualAverage.
        if (!termsByStudent.has(k)) { noTermIds.push(student._id); continue; }
        const row = annualRowFor(ctx, {
          termResults:      termsByStudent.get(k) ?? [],
          promotionResults: promoByStudent.get(k) ?? [],
          classId,
          isFinalYear:      Boolean(classDoc?.isFinalYear),
        });
        ops.push({
          updateOne: {
            filter: { schoolId, academicYear, classId, studentId: student._id },
            update: { $set: annualSetFor({
              studentName: student.studentName,
              admissionNo: student.enrollmentNo,
              className:   student.className || resolvedClassName,
            }, ctx, row) },
            upsert: true,
          },
        });
        computed++;
        computedIds.push(k);
      } catch (err) {
        console.error(`[annualGrading] Skipped ${student.studentName}:`, err.message);
        skipped++;
      }
    }
    if (ops.length > 0) await AnnualResult.bulkWrite(ops, { ordered: false });

    // Rows an earlier run wrote for those pupils: an unpublished one is
    // removed, so it is no longer ranked; a published one is left as issued
    // and kept out of the positions below. Only asked when there are such
    // pupils, so a class where everyone has a term costs no extra query.
    if (noTermIds.length > 0) {
      await AnnualResult.deleteMany({
        schoolId, academicYear, classId, studentId: { $in: noTermIds }, isPublished: { $ne: true },
      });
      noTerms = noTermIds.length;
      excluded = noTermIds.map(String);
    }
  }

  // This year only, a row for a pupil no longer on the roster — inactive,
  // deleted or moved — goes too, so it is neither ranked nor counted in the
  // class size (rankingScope.service says why only this year): the positions
  // keep exactly the pupils computed here. Unpublished only; a published row
  // refused the class above.
  //
  // Otherwise the pupils with a term result in this class who have not been
  // deleted — never simply every row that exists, which is how a class of
  // three printed "1st / 50".
  const keep = await rosterDecides({ schoolId, academicYear, classId })
    ? computedIds
    : await pupilsWithTermResults({ schoolId, academicYear, classId });

  // Compute class positions
  await computeAnnualPositions({ schoolId, academicYear, classId, exclude: excluded, keep });

  // Every class's pupils, so after this class's rows are settled. A
  // whole-school run ranks once, after its last class.
  if (schoolPlaces) await rankAcrossClasses(AnnualResult, { schoolId, academicYear }, "annualAverage");

  return { computed, skipped: skipped + noTerms, noTerms };
}

/** The pupils with a term result in a class who have not been deleted. */
async function pupilsWithTermResults({ schoolId, academicYear, classId }) {
  const ids = (await TermResult.distinct("studentId", {
    schoolId, academicYear, classId, deletedAt: null,
  })).map(String);
  if (!ids.length) return [];
  const live = await mongoose.model("Student")
    .find({ _id: { $in: ids }, schoolId, deletedAt: null })
    .select("_id").lean();
  return live.map((s) => String(s._id));
}

/**
 * Compute annual positions (dense ranking) for a class.
 *
 * `exclude`: pupils whose row is not ranked and not touched — a published
 * row kept for a pupil who no longer has a term result (docs/39 §4.6k).
 *
 * `keep`: when given, the pupils the class ranks. Any other unpublished row is
 * removed, and any other published one is left exactly as issued, outside the
 * places and the class size — as termGrading's computeTermPositions does.
 */
async function computeAnnualPositions({ schoolId, academicYear, classId, exclude = [], keep = null }) {
  const skip = new Set(exclude.map(String));
  let results = (await AnnualResult.find({
    schoolId,
    academicYear,
    classId,
    deletedAt: null,
  })
    .sort({ annualAverage: -1 })
    .lean()).filter((r) => !skip.has(String(r.studentId)));

  if (keep) {
    const kept = new Set(keep.map(String));
    const stale = results.filter((r) => !kept.has(String(r.studentId)) && !r.isPublished);
    if (stale.length) {
      await AnnualResult.deleteMany({ _id: { $in: stale.map((r) => r._id) }, isPublished: { $ne: true } });
    }
    results = results.filter((r) => kept.has(String(r.studentId)));
  }

  const totalInClass = results.length;

  // Ties share a place, as they do for a subject and for a term — see the note
  // in termGrading.service.js. Ranking by sorted index gave two pupils on the
  // same annual average different positions.
  const places = competitionPlaces(results.map((r) => r.annualAverage));
  const bulkOps = results.map((r, i) => ({
    updateOne: {
      filter: { _id: r._id },
      update: { $set: { classPosition: places[i], totalInClass } },
    },
  }));

  if (bulkOps.length > 0) {
    await AnnualResult.bulkWrite(bulkOps);
  }
}

/**
 * Compute annual averages for ALL students across ALL classes.
 */
async function computeAllClassAnnualAverages({ schoolId, academicYear }) {
  const Class = mongoose.model("Class");
  const classes = await Class.find({
    schoolId,
    deletedAt: null,
  }).lean();

  let totalComputed = 0;
  let totalSkipped  = 0;
  let totalNoTerms  = 0;
  // Under D3 (decided: refuse) a class with published annual results is left
  // exactly as it is and named here; the other classes still compute.
  const refusedClasses = [];

  for (const cls of classes) {
    let out;
    try {
      out = await computeClassAnnualAverages({
        schoolId,
        academicYear,
        classId: cls._id,
        schoolPlaces: false,
      });
    } catch (err) {
      if (err.code !== "PUBLISHED_RESULTS") throw err;
      refusedClasses.push({ classId: String(cls._id), className: cls.name ?? null, published: err.published });
      continue;
    }
    totalComputed += out.computed;
    totalSkipped  += out.skipped;
    totalNoTerms  += out.noTerms;
  }

  await rankAcrossClasses(AnnualResult, { schoolId, academicYear }, "annualAverage");

  return {
    computed: totalComputed, skipped: totalSkipped, noTerms: totalNoTerms,
    ...(refusedClasses.length ? { refusedClasses } : {}),
  };
}

module.exports = {
  computeStudentAnnualAverage,
  computeClassAnnualAverages,
  computeAllClassAnnualAverages,
  computeAnnualPositions,
};
