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
const { CA_TYPE }      = require("../../../shared/caAssessment");
const academicPolicy   = require("./academicPolicy.service");
const { CALC_VERSIONS, legacyTermsFromPeriods } = require("../../../shared/academicPolicy");
const { effectiveRules, calcVersionFor, sequenceFigureOn20 } = require("../../../shared/academicRules");

// ── Helpers ─────────────────────────────────────────────────────────────────

function lookupGrade(markOutOf20) {
  return grading.lookupGrade(markOutOf20);
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

  // The configuration this term is computed under, frozen and named (docs/39
  // §8), from the two documents just read — no further query on a warm
  // process, which keeps the per-class cost fixed (check-term-compute).
  const policy = await academicPolicy.resolve({ schoolId, academicYear, structure, gradingConfig });

  // Which sequences the term holds and what each weighs come from that
  // snapshot's period tree (docs/39 Phase 3), not from the structure directly.
  const termConfig = legacyTermsFromPeriods(policy.policy.structure.periods)
    .find((t) => t.number === term);
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
  }).select("_id name sequenceNumber type").lean();

  /*
   * The papers, not the continuous assessments.
   *
   * A sequence now has two exams: the paper and its CA. The paper's
   * ResultSummary IS the sequence result — results.service blends the CA into
   * it — so reading the CA exam's own summary here would count continuous
   * assessment a second time, as though it were a whole extra sequence.
   *
   * Without this filter `exams.find(e => e.sequenceNumber === seqNum)` would
   * also return whichever of the two Mongo happened to hand over first, which
   * is a term average that changes between runs.
   */
  const exams = all.filter(
    (e) => sequenceNumbers.includes(e.sequenceNumber) && e.type !== CA_TYPE
  );

  return {
    termConfig,
    sequenceNumbers,
    exams,
    examIds: exams.map((e) => e._id),
    // A CA exam with no sequence is not a paper a school forgot to bind — it
    // cannot be marked as one — so it is left out of the report rather than
    // shown to an administrator as work to do.
    unsequencedExams: all
      .filter((e) => e.sequenceNumber == null && e.type !== CA_TYPE)
      .map((e) => ({ _id: String(e._id), name: e.name || null })),
    passMark: gradingConfig?.passMark ?? 10,
    policyHash: policy._id,
    // The rules in force (shared/academicRules, decided 2026-10-16): the
    // stored term row takes the school's own bands, which is what its card
    // prints (docs/39 §12), falling back to the built-in table when the school
    // has none.
    rules: effectiveRules(policy.policy.rules),
    calcVersion: calcVersionFor("term"),
    gradeOf: (mark) => grading.lookupSchoolGrade(mark, gradingConfig),
  };
}

/**
 * One pupil's term average, from summaries already in hand. No queries.
 *
 * @returns {{ doc: object, hasAnyMark: boolean }}
 */
function termResultFields({ context, summaries, studentName, admissionNo, className }) {
  const { termConfig, sequenceNumbers, exams, passMark } = context;
  // The school's bands; the built-in scale only for a context built by hand.
  const gradeOf = context.gradeOf || lookupGrade;

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

    // On /20 whichever writer produced it: an exam-process/1 summary (a
    // raw-mark mean on the papers' own scale) is read as its percentage ÷ 5,
    // so a term holding old and new sequences averages one scale (decided
    // 2026-10-16). The stored summary is not touched.
    const avg   = sequenceFigureOn20(summary);
    const grade = avg != null ? gradeOf(avg) : null;

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

  const termGrade = gradeOf(termAverage);

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
      // A context built by hand (a caller outside loadTermContext) has no
      // policy, and its rows say so rather than claiming one.
      policyHash:    context.policyHash ?? null,
      calcVersion:   context.calcVersion ?? CALC_VERSIONS.term,
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

  // A published row is never recomputed in place (D3, decided).
  if (await TermResult.exists({ schoolId, academicYear, term, classId, studentId, isPublished: true, deletedAt: null })) {
    const err = new Error("This term result is published. Unpublish it first.");
    err.status = 409; err.code = "PUBLISHED_RESULTS";
    throw err;
  }

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

  // A published term row is never recomputed in place (D3, decided for every
  // school). Checked before anything is written, for the whole class.
  {
    const published = await TermResult.countDocuments({
      schoolId, academicYear, term, classId, isPublished: true, deletedAt: null,
    });
    if (published > 0) {
      const err = new Error(`${published} published term result(s) would be recomputed. Unpublish them first.`);
      err.status = 409; err.code = "PUBLISHED_RESULTS"; err.published = published;
      throw err;
    }
  }

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
 * Competition places for a list of averages: one more than the number
 * strictly ahead, ties sharing a place — the same answer as counting, for
 * each pupil, every pupil with a higher average, without doing that count
 * once per pupil (which made a class of n cost n² and a school of forty
 * classes a visible pause). Values are read the way the count read them,
 * Number(x) || 0, so a missing average places as zero exactly as before.
 *
 * @param {number[]} averages  in any order
 * @returns {number[]}         the place of each, in the same order
 */
// The one ranker, shared with the weighted sequence route (shared/ranking.js).
const { competitionPlaces } = require("../../../shared/ranking");

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
  const places = competitionPlaces(results.map((r) => r.termAverage));
  const bulkOps = results.map((r, i) => ({
    updateOne: {
      filter: { _id: r._id },
      update: { $set: { classPosition: places[i], totalInClass } },
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

  // The structure, the grading config and the term's exams are the same for
  // every class. Loading them per class was most of a whole-school run.
  const context = await loadTermContext({ schoolId, academicYear, term });

  let totalComputed = 0;
  let totalSkipped  = 0;
  // Under the D3 "refuse" rule a class with published term results is left
  // exactly as it is and named here; the other classes still compute.
  const refusedClasses = [];

  for (const cls of classes) {
    let out;
    try {
      out = await computeClassTermAverages({
        schoolId,
        academicYear,
        term,
        classId: cls._id,
        context,
      });
    } catch (err) {
      if (err.code !== "PUBLISHED_RESULTS") throw err;
      refusedClasses.push({ classId: String(cls._id), className: cls.name ?? null, published: err.published });
      continue;
    }
    totalComputed += out.computed;
    totalSkipped  += out.skipped;
  }

  return {
    computed: totalComputed,
    skipped:  totalSkipped,
    noMarks:  totalSkipped,
    unsequencedExams: context.unsequencedExams,
    ...(refusedClasses.length ? { refusedClasses } : {}),
  };
}

module.exports = {
  competitionPlaces,
  loadTermContext,
  termResultFields,
  computeStudentTermAverage,
  computeClassTermAverages,
  computeAllClassTermAverages,
  computeTermPositions,
};
