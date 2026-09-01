// backend/src/services/termGrading.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TERM GRADING SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Computes term averages from per-sequence exam results.
 *
 * Each term has 2 sequences. Each sequence has one exam (ResultSummary).
 * The term average is a weighted average of the two sequence averages,
 * using equal weights (50/50) by default.
 *
 * Hierarchy:
 *   Exam → ResultSummary (sequence-level)
 *   ResultSummary → TermResult (term-level)
 *   TermResult → AnnualResult (year-level)
 */

const mongoose         = require("mongoose");
const ResultSummary    = require("../db/models/ResultSummary");
const TermResult       = require("../db/models/TermResult");
const AcademicStructure = require("../db/models/AcademicStructure");
const GradingConfig    = require("../db/models/GradingConfig");
const grading          = require("./grading.service");

// ── Helpers ─────────────────────────────────────────────────────────────────

function lookupGrade(markOutOf20) {
  return grading.lookupGrade(markOutOf20);
}

function getSequenceWeights(structure, termNumber) {
  const term = structure.terms.find((t) => t.number === termNumber);
  if (!term) return [50, 50];

  // Equal weights: 50/50 for 2 sequences
  return term.sequences.map((s) => s.weight);
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Compute the term average for a single student.
 *
 * @param {Object} opts
 * @param {string}  opts.schoolId
 * @param {string}  opts.academicYear
 * @param {number}  opts.term         1 | 2 | 3
 * @param {string}  opts.classId
 * @param {string}  opts.studentId
 * @param {string} [opts.studentName]
 * @param {string} [opts.admissionNo]
 * @param {string} [opts.className]
 * @returns {Object} TermResult document (upserted)
 */
async function computeStudentTermAverage({
  schoolId,
  academicYear,
  term,
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

  const termConfig = structure.terms.find((t) => t.number === term);
  if (!termConfig) {
    throw new Error(`Term ${term} not found in academic structure`);
  }

  // 2. Load grading config for grade lookup
  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();
  const passMark = gradingConfig?.passMark ?? 10;

  // 3. Find the two sequence numbers for this term
  const sequenceNumbers = termConfig.sequences.map((s) => s.number);

  // 4. Find exams for this student in these sequences
  const Exam = mongoose.model("Exam");
  const exams = await Exam.find({
    schoolId,
    academicYear,
    term,
    sequenceNumber: { $in: sequenceNumbers },
    deletedAt: null,
  }).lean();

  const examIds = exams.map((e) => e._id);

  // 5. Get ResultSummary for each exam
  const summaries = await ResultSummary.find({
    examId: { $in: examIds },
    studentId,
    classId,
    schoolId,
    deletedAt: null,
  }).lean();

  // 6. Build per-sequence averages
  const sequenceAverages = [];
  let totalWeightedAvg = 0;
  let totalWeight = 0;

  for (const seqNum of sequenceNumbers) {
    const seqConfig = termConfig.sequences.find((s) => s.number === seqNum);
    const exam = exams.find((e) => e.sequenceNumber === seqNum);
    const summary = exam
      ? summaries.find((s) => s.examId === exam._id)
      : null;

    const avg = summary?.average ?? null;
    const grade = avg != null ? lookupGrade(avg) : null;

    sequenceAverages.push({
      sequence:     seqNum,
      examId:       exam?._id ?? null,
      average:      avg ?? 0,
      overallGrade: grade?.grade ?? null,
      isComplete:   avg != null,
    });

    if (avg != null) {
      const weight = seqConfig?.weight ?? 50;
      totalWeightedAvg += avg * weight;
      totalWeight += weight;
    }
  }

  // 7. Compute weighted term average
  const termAverage = totalWeight > 0
    ? Math.round((totalWeightedAvg / totalWeight) * 100) / 100
    : 0;

  const termGrade = lookupGrade(termAverage);
  const isPassing = termAverage >= passMark;

  // 8. Upsert TermResult
  const filter = {
    schoolId,
    academicYear,
    term,
    classId,
    studentId,
  };

  const update = {
    $set: {
      studentName:    studentName ?? null,
      admissionNo:    admissionNo ?? null,
      className:      className ?? null,
      sequenceAverages,
      termAverage,
      overallGrade:   termGrade.grade,
      overallRemark:  termGrade.remark,
      isPassing,
      syncStatus:     "pending",
    },
  };

  const result = await TermResult.findOneAndUpdate(filter, update, {
    upsert: true,
    returnDocument: 'after',
    setDefaultsOnInsert: true,
  });

  return result;
}

/**
 * Compute term averages for ALL students in a class.
 *
 * @param {Object} opts
 * @param {string}  opts.schoolId
 * @param {string}  opts.academicYear
 * @param {number}  opts.term
 * @param {string}  opts.classId
 * @returns {{ computed: number, skipped: number }}
 */
async function computeClassTermAverages({
  schoolId,
  academicYear,
  term,
  classId,
}) {
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
      await computeStudentTermAverage({
        schoolId,
        academicYear,
        term,
        classId,
        studentId:  student.userId ?? student._id,
        studentName: student.studentName,
        admissionNo: student.enrollmentNo,
        className:   student.className,
      });
      computed++;
    } catch (err) {
      console.error(`[termGrading] Skipped ${student.studentName}:`, err.message);
      skipped++;
    }
  }

  // 9. Compute class positions
  await computeTermPositions({ schoolId, academicYear, term, classId });

  return { computed, skipped };
}

/**
 * Compute term positions (dense ranking) for a class.
 */
async function computeTermPositions({ schoolId, academicYear, term, classId }) {
  const results = await TermResult.find({
    schoolId,
    academicYear,
    term,
    classId,
    deletedAt: null,
  })
    .sort({ termAverage: -1 })
    .lean();

  const totalInClass = results.length;

  const bulkOps = results.map((r, i) => ({
    updateOne: {
      filter: { _id: r._id },
      update: {
        $set: {
          classPosition:  i + 1,
          totalInClass,
        },
      },
    },
  }));

  if (bulkOps.length > 0) {
    await TermResult.bulkWrite(bulkOps);
  }
}

/**
 * Compute term averages for ALL students across ALL classes.
 *
 * @param {Object} opts
 * @param {string}  opts.schoolId
 * @param {string}  opts.academicYear
 * @param {number}  opts.term
 * @returns {{ computed: number, skipped: number }}
 */
async function computeAllClassTermAverages({ schoolId, academicYear, term }) {
  const Class = mongoose.model("Class");
  const classes = await Class.find({
    schoolId,
    deletedAt: null,
  }).lean();

  let totalComputed = 0;
  let totalSkipped  = 0;

  for (const cls of classes) {
    const { computed, skipped } = await computeClassTermAverages({
      schoolId,
      academicYear,
      term,
      classId: cls._id,
    });
    totalComputed += computed;
    totalSkipped  += skipped;
  }

  return { computed: totalComputed, skipped: totalSkipped };
}

module.exports = {
  computeStudentTermAverage,
  computeClassTermAverages,
  computeAllClassTermAverages,
  computeTermPositions,
};
