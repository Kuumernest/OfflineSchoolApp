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

// ── Core ────────────────────────────────────────────────────

/**
 * Everything a whole term's computation needs, fetched once.
 *
 * ── Why this exists ─────────────────────────────────────────────
 *
 * computeStudentTermAverage used to load the academic structure, the grading
 * config, the term's exams and the pupil's summaries itself: four round trips
 * per pupil, awaited one after another, inside a loop over every pupil in every
 * class. Against a hosted database at ~130ms a hop that is about two thirds of
 * a second per pupil, so a school of 68 waits three quarters of a minute and
 * the request times out before it finishes. The half-written run then leaves
 * some pupils with results and the rest without.
 *
 * Nothing here varies per pupil, so it is fetched once and passed down.
 */
async function loadTermContext({ schoolId, academicYear, term }) {
  const [structure, gradingConfig] = await Promise.all([
    AcademicStructure.findOne({ schoolId, academicYear, deletedAt: null }).lean(),
    GradingConfig.findOne({ schoolId }).lean(),
  ]);

  if (!structure) {
    throw new Error(`No academic structure found for ${schoolId} / ${academicYear}`);
  }
  const termConfig = structure.terms.find((t) => t.number === term);
  if (!termConfig) {
    throw new Error(`Term ${term} not found in academic structure`);
  }

  const sequenceNumbers = termConfig.sequences.map((s) => s.number);

  // Every exam of the term, so the ones missing a sequence can be REPORTED
  // rather than silently ignored. An exam created before the server stored
  // sequenceNumber belongs to no sequence and contributes to no term average,
  // and that used to leave the screen saying nothing at all.
  const Exam = mongoose.model("Exam");
  const all = await Exam.find({
    schoolId, academicYear, term, deletedAt: null,
  }).select("_id name sequenceNumber").lean();

  const exams = all.filter((e) => sequenceNumbers.includes(e.sequenceNumber));

  return {
    termConfig,
    sequenceNumbers,
    exams,
    examIds: exams.map((e) => e._id),
    unsequencedExams: all
      .filter((e) => e.sequenceNumber == null)
      .map((e) => ({ _id: String(e._id), name: e.name || null })),
    passMark: gradingConfig?.passMark ?? 10,
  };
}

/**
 * One pupil's term average, from summaries already in hand. No queries.
 *
 * @returns {{ doc: object, hasAnyMark: boolean }}
 */
function termResultFields({ context, summaries, studentName, admissionNo, className }) {
  const { termConfig, sequenceNumbers, exams, passMark } = context;

  const sequenceAverages = [];
  let totalWeightedAvg = 0;
  let totalWeight = 0;
  let hasAnyMark = false;

  for (const seqNum of sequenceNumbers) {
    const seqConfig = termConfig.sequences.find((s) => s.number === seqNum);
    const exam      = exams.find((e) => e.sequenceNumber === seqNum);
    const summary   = exam
      ? summaries.find((s) => String(s.examId) === String(exam._id))
      : null;

    const avg   = summary?.average ?? null;
    const grade = avg != null ? lookupGrade(avg) : null;

    sequenceAverages.push({
      sequence:     seqNum,
      examId:       exam?._id ?? null,
      average:      avg ?? 0,
      overallGrade: grade?.grade ?? null,
      isComplete:   avg != null,
    });

    if (avg != null) {
      hasAnyMark = true;
      const weight = seqConfig?.weight ?? 50;
      totalWeightedAvg += avg * weight;
      totalWeight += weight;
    }
  }

  const termAverage = totalWeight > 0
    ? Math.round((totalWeightedAvg / totalWeight) * 100) / 100
    : 0;

  const termGrade = lookupGrade(termAverage);

  return {
    hasAnyMark,
    doc: {
      studentName:   studentName ?? null,
      admissionNo:   admissionNo ?? null,
      className:     className ?? null,
      sequenceAverages,
      termAverage,
      overallGrade:  termGrade.grade,
      overallRemark: termGrade.remark,
      isPassing:     termAverage >= passMark,
      syncStatus:    "pending",
    },
  };
}

/**
 * The identity a result is keyed on.
 *
 * ResultSummary.studentId holds Student._id, and so does TermResult.studentId:
 * buildTermCard looks the pupil up with Student.findOne({ _id: studentId }).
 * This service passed `student.userId ?? student._id` instead, so for every
 * pupil with a linked login the summary lookup matched nothing, and the term
 * was computed from no marks and written as a zero. On the live school 0 of 50
 * pupils matched, and 68 term results were saved as 0 with both sequences
 * flagged incomplete.
 */
const studentKey = (student) => String(student._id);

/** Every summary for a class in one query, grouped by pupil. */
async function summariesByStudent({ examIds, classId, schoolId }) {
  if (!examIds.length) return new Map();
  const rows = await ResultSummary.find({
    examId: { $in: examIds }, classId, schoolId, deletedAt: null,
  }).lean();

  const byStudent = new Map();
  for (const row of rows) {
    const key = String(row.studentId);
    if (!byStudent.has(key)) byStudent.set(key, []);
    byStudent.get(key).push(row);
  }
  return byStudent;
}

/**
 * Compute the term average for a single student.
 *
 * Kept for callers outside a class run; the class path below shares one context
 * across every pupil rather than calling this in a loop.
 *
 * @param {Object} opts
 * @param {string}  opts.schoolId
 * @param {string}  opts.academicYear
 * @param {number}  opts.term         1 | 2 | 3
 * @param {string}  opts.classId
 * @param {string}  opts.studentId    Student._id
 * @param {string} [opts.studentName]
 * @param {string} [opts.admissionNo]
 * @param {string} [opts.className]
 * @returns {Object|null} the TermResult, or null when the term has no marks
 */
async function computeStudentTermAverage({
  schoolId, academicYear, term, classId, studentId,
  studentName, admissionNo, className,
}) {
  const context = await loadTermContext({ schoolId, academicYear, term });

  const summaries = context.examIds.length
    ? await ResultSummary.find({
        examId: { $in: context.examIds }, studentId, classId, schoolId,
        deletedAt: null,
      }).lean()
    : [];

  const { doc, hasAnyMark } = termResultFields({
    context, summaries, studentName, admissionNo, className,
  });

  /*
   * Not a zero.
   *
   * A pupil with no sequence marked has no term average, and writing one as 0
   * does not say "not computed" anywhere a screen can read: it says the pupil
   * scored nothing. The report card, the position and the pass/fail all then
   * treat that as fact. So nothing is written and the caller counts it as
   * skipped.
   */
  if (!hasAnyMark) return null;

  return TermResult.findOneAndUpdate(
    { schoolId, academicYear, term, classId, studentId },
    { $set: doc },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

/**
 * Compute term averages for ALL students in a class.
 *
 * One context, one summaries query and one bulk write for the whole class,
 * rather than four round trips per pupil.
 *
 * @returns {{computed, skipped, noMarks, unsequencedExams}}
 */
async function computeClassTermAverages({
  schoolId, academicYear, term, classId, context = null,
}) {
  const ctx = context || await loadTermContext({ schoolId, academicYear, term });

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
  const [students, byStudent] = await Promise.all([
    Student.find({ schoolId, classId, isActive: true, deletedAt: null }).lean(),
    summariesByStudent({ examIds: ctx.examIds, classId, schoolId }),
  ]);

  const ops = [];
  let noMarks = 0;

  for (const student of students) {
    const studentId = studentKey(student);
    const { doc, hasAnyMark } = termResultFields({
      context:     ctx,
      summaries:   byStudent.get(studentId) || [],
      studentName: student.studentName,
      admissionNo: student.enrollmentNo,
      className:   student.className || resolvedClassName,
    });

    if (!hasAnyMark) { noMarks += 1; continue; }

    ops.push({
      updateOne: {
        filter: { schoolId, academicYear, term, classId, studentId },
        update: { $set: doc },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await TermResult.bulkWrite(ops);
    // Positions only mean something once there is something to rank.
    await computeTermPositions({ schoolId, academicYear, term, classId });
  }

  return {
    computed: ops.length,
    skipped:  noMarks,
    noMarks,
    unsequencedExams: ctx.unsequencedExams,
  };
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

  /*
   * Ties share a place.
   *
   * This ranked by position in the sorted list, so two pupils on the same term
   * average were given different places — 13.0 came 14th and another 13.0 came
   * 20th, which is not a thing that can be true. §6 of the report card rules
   * says a tie shares the rank, and shared/reportCard.js already ranks subject
   * positions that way; a card whose subject positions share ties and whose
   * class position does not is telling a parent two different stories.
   *
   * One more than the number of pupils strictly ahead, which is the same rule
   * expressed against the averages rather than the sorted index.
   */
  const bulkOps = results.map((r) => {
    const mine  = Number(r.termAverage) || 0;
    const ahead = results.filter((o) => (Number(o.termAverage) || 0) > mine).length;
    return {
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { classPosition: ahead + 1, totalInClass } },
      },
    };
  });

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

  // The structure, the grading config and the term's exams are the same for
  // every class. Loading them per class was most of a whole-school run.
  const context = await loadTermContext({ schoolId, academicYear, term });

  let totalComputed = 0;
  let totalSkipped  = 0;

  for (const cls of classes) {
    const { computed, skipped } = await computeClassTermAverages({
      schoolId,
      academicYear,
      term,
      classId: cls._id,
      context,
    });
    totalComputed += computed;
    totalSkipped  += skipped;
  }

  return {
    computed: totalComputed,
    skipped:  totalSkipped,
    noMarks:  totalSkipped,
    unsequencedExams: context.unsequencedExams,
  };
}

module.exports = {
  loadTermContext,
  termResultFields,
  computeStudentTermAverage,
  computeClassTermAverages,
  computeAllClassTermAverages,
  computeTermPositions,
};
