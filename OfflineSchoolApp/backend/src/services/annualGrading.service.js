// backend/src/services/annualGrading.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANNUAL GRADING SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Computes annual averages from per-term results.
 *
 * Annual Average = (Term 1 Avg + Term 2 Avg + Term 3 Avg) / 3
 * (equal weighting, configurable via AcademicStructure.termWeights)
 *
 * Promotion is determined by:
 *   - Whether the student passed all terms (termAverage >= passMark)
 *   - Whether the student passed promotion exams (if configured)
 */

const mongoose          = require("mongoose");
const TermResult        = require("../db/models/TermResult");
const AnnualResult      = require("../db/models/AnnualResult");
const AcademicStructure = require("../db/models/AcademicStructure");
const GradingConfig     = require("../db/models/GradingConfig");
const grading           = require("./grading.service");
const { competitionPlaces } = require("./termGrading.service");

// ── Helpers ─────────────────────────────────────────────────────────────────

function lookupGrade(markOutOf20) {
  return grading.lookupGrade(markOutOf20);
}

function getTermWeights(structure) {
  return structure.terms.map((t) => ({
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
  const termWeights = getTermWeights(structure);

  const promotionExams = structure.promotionExams ?? [];
  let promotionExamIds = [];
  if (promotionExams.length > 0) {
    const Exam = mongoose.model("Exam");
    const promotionExamDocs = await Exam.find({
      schoolId,
      academicYear,
      sequenceNumber: { $in: promotionExams },
      type: "promotion_exam",
      deletedAt: null,
    }).lean();
    promotionExamIds = promotionExamDocs.map((e) => e._id);
  }

  return { structure, passMark, termWeights, promotionExamIds };
}

/**
 * The annual row for one pupil, from the term results and promotion results
 * already in hand. Pure: no database. The arithmetic and the promotion rule
 * are exactly those of the per-pupil function this replaced.
 */
function annualRowFor(ctx, { termResults, promotionResults }) {
  const { structure, passMark, termWeights } = ctx;

  // 5. Build per-term averages
  const termAverages = [];
  let totalWeightedAvg = 0;
  let totalWeight = 0;
  let completedTerms = 0;

  for (const tw of termWeights) {
    const tr = termResults.find((r) => r.term === tw.term);
    const avg = tr?.termAverage ?? null;
    const grade = avg != null ? lookupGrade(avg) : null;

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

  const annualGrade = lookupGrade(annualAverage);
  const isPassing = annualAverage >= passMark;

  // 7. Determine promotion status
  let promotionStatus = "pending";
  if (completedTerms >= 3) {
    const allTermsPassed = termAverages.every(
      (ta) => ta.isComplete && ta.average >= passMark
    );
    let promotionExamsPassed = true;
    for (const pr of promotionResults) {
      if (pr.average < structure.promotionThreshold) {
        promotionExamsPassed = false;
        break;
      }
    }
    if (allTermsPassed && promotionExamsPassed) {
      promotionStatus = "promoted";
    } else if (!allTermsPassed) {
      promotionStatus = "repeated";
    } else {
      promotionStatus = "conditional";
    }
  }

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
  promotionThreshold:  ctx.structure.promotionThreshold ?? null,
  isPassing:           row.isPassing,
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

  const row = annualRowFor(ctx, { termResults, promotionResults });

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
 * @returns {{ computed: number, skipped: number }}
 */
async function computeClassAnnualAverages({
  schoolId,
  academicYear,
  classId,
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
    .select("_id name")
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
    for (const student of students) {
      try {
        const k = String(student._id);
        const row = annualRowFor(ctx, {
          termResults:      termsByStudent.get(k) ?? [],
          promotionResults: promoByStudent.get(k) ?? [],
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
      } catch (err) {
        console.error(`[annualGrading] Skipped ${student.studentName}:`, err.message);
        skipped++;
      }
    }
    if (ops.length > 0) await AnnualResult.bulkWrite(ops, { ordered: false });
  }

  // Compute class positions
  await computeAnnualPositions({ schoolId, academicYear, classId });

  return { computed, skipped };
}

/**
 * Compute annual positions (dense ranking) for a class.
 */
async function computeAnnualPositions({ schoolId, academicYear, classId }) {
  const results = await AnnualResult.find({
    schoolId,
    academicYear,
    classId,
    deletedAt: null,
  })
    .sort({ annualAverage: -1 })
    .lean();

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

  for (const cls of classes) {
    const { computed, skipped } = await computeClassAnnualAverages({
      schoolId,
      academicYear,
      classId: cls._id,
    });
    totalComputed += computed;
    totalSkipped  += skipped;
  }

  return { computed: totalComputed, skipped: totalSkipped };
}

module.exports = {
  computeStudentAnnualAverage,
  computeClassAnnualAverages,
  computeAllClassAnnualAverages,
  computeAnnualPositions,
};
