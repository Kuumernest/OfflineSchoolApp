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
async function computeStudentAnnualAverage({
  schoolId,
  academicYear,
  classId,
  studentId,
  studentName,
  admissionNo,
  className,
}) {
  // 1. Load academic structure
  const structure = await AcademicStructure.findOne({
    schoolId,
    academicYear,
    deletedAt: null,
  }).lean();

  if (!structure) {
    throw new Error(`No academic structure found for ${schoolId} / ${academicYear}`);
  }

  // 2. Load grading config
  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();
  const passMark = gradingConfig?.passMark ?? 10;

  // 3. Get term weights
  const termWeights = getTermWeights(structure);

  // 4. Load all 3 TermResults for this student
  const termResults = await TermResult.find({
    schoolId,
    academicYear,
    classId,
    studentId,
    deletedAt: null,
  }).lean();

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
    // Check if student passed all terms
    const allTermsPassed = termAverages.every(
      (ta) => ta.isComplete && ta.average >= passMark
    );

    // Check promotion exams (if configured)
    const promotionExams = structure.promotionExams ?? [];
    let promotionExamsPassed = true;

    if (promotionExams.length > 0) {
      // Find exams that are promotion exams
      const Exam = mongoose.model("Exam");
      const promotionExamDocs = await Exam.find({
        schoolId,
        academicYear,
        sequenceNumber: { $in: promotionExams },
        type: "promotion_exam",
        deletedAt: null,
      }).lean();

      const promotionExamIds = promotionExamDocs.map((e) => e._id);

      if (promotionExamIds.length > 0) {
        const ResultSummary = require("../db/models/ResultSummary");
        const promotionResults = await ResultSummary.find({
          examId: { $in: promotionExamIds },
          studentId,
          classId,
          schoolId,
          deletedAt: null,
        }).lean();

        for (const pr of promotionResults) {
          if (pr.average < structure.promotionThreshold) {
            promotionExamsPassed = false;
            break;
          }
        }
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

  // 8. Upsert AnnualResult
  const filter = {
    schoolId,
    academicYear,
    classId,
    studentId,
  };

  const update = {
    $set: {
      studentName:         studentName ?? null,
      admissionNo:         admissionNo ?? null,
      className:           className ?? null,
      termAverages,
      annualAverage,
      overallGrade:        annualGrade.grade,
      overallRemark:       annualGrade.remark,
      promotionStatus,
      promotionThreshold:  structure.promotionThreshold ?? null,
      isPassing,
      syncStatus:          "pending",
    },
  };

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

  for (const student of students) {
    try {
      await computeStudentAnnualAverage({
        schoolId,
        academicYear,
        classId,
        // Student._id, which is what TermResult.studentId holds and what
        // buildAnnualCard looks the pupil up by. Reading the login id here
        // matched no term results at all for any pupil who had an account.
        studentId:   student._id,
        studentName: student.studentName,
        admissionNo: student.enrollmentNo,
        className:   student.className || resolvedClassName,
      });
      computed++;
    } catch (err) {
      console.error(`[annualGrading] Skipped ${student.studentName}:`, err.message);
      skipped++;
    }
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
  const bulkOps = results.map((r) => {
    const mine  = Number(r.annualAverage) || 0;
    const ahead = results.filter((o) => (Number(o.annualAverage) || 0) > mine).length;
    return {
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { classPosition: ahead + 1, totalInClass } },
      },
    };
  });

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
