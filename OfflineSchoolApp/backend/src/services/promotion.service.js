// backend/src/services/promotion.service.js
"use strict";

const Student           = require("../db/models/Student");
const Class             = require("../db/models/Class");
const ResultSummary     = require("../db/models/ResultSummary");
const Enrollment        = require("../db/models/Enrollment");
const PromotionRun      = require("../db/models/PromotionRun");
const PromotionDecision = require("../db/models/PromotionDecision");
const { displayName } = require("../utils/studentName");

/**
 * End-of-year rollover: who moves up, who repeats, who leaves.
 *
 * This is the single most destructive operation in the system — it rewrites the
 * class of every student in the school at once — so it is built the same way
 * payroll is, and for the same reason:
 *
 *   generate a draft → review and override → commit → (reverse if wrong)
 *
 * Nothing about a student changes until commit. Three rules follow from that,
 * and each one is load-bearing:
 *
 *   1. A destination is never guessed. Where a class has no `nextClassId` the
 *      student's decision is "unassigned", and an unassigned decision BLOCKS the
 *      commit. Sorting class names would put "Form 10" before "Form 2" and has
 *      nothing to say about "Form 5" → "Lower Sixth"; a wrong guess here puts a
 *      child in the wrong classroom for a year.
 *
 *   2. The outgoing year is written to Enrollment before `student.classId`
 *      moves. That pointer is the only record of where a student sits, so
 *      overwriting it without capturing the year first destroys the history that
 *      report cards and transcripts are built from.
 *
 *   3. Reversal restores from the decision rows, not from a guess. Each decision
 *      keeps `fromClassId`, so undoing is exact even for students whose class
 *      was later renamed or deleted.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SEEDING A DRAFT FROM RESULTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The year's academic picture per student, from published result summaries.
 *
 * Only published summaries count. A draft result is a teacher's working copy,
 * and promoting a school off unpublished marks would act on figures nobody has
 * signed off.
 */
const resultsByStudent = async (schoolId, academicYear) => {
  const rows = await ResultSummary.aggregate([
    { $match: { schoolId, academicYear, isPublished: true, deletedAt: null } },
    { $group: {
        _id:      "$studentId",
        average:  { $avg: "$average" },
        passes:   { $sum: { $cond: ["$isPassing", 1, 0] } },
        total:    { $sum: 1 },
    } },
  ]);

  return new Map(rows.map((r) => [r._id, {
    average: r.average === null || r.average === undefined ? null : Math.round(r.average * 10) / 10,
    // Passed more terms than not. A single bad term does not hold a child back,
    // and the head can still override either way.
    passing: r.passes * 2 >= r.total,
    terms:   r.total,
  }]));
};

/**
 * Decide one student's proposed outcome. Pure — no database, no clock.
 *
 * When the student's class carries a `promotionAverage` (set per class by the
 * school admin on the promotion page), the student's published yearly average
 * must meet it to move up — the majority-of-terms rule no longer decides on
 * its own. A class without a threshold keeps the old behaviour, so nothing
 * changes for schools that have not set one.
 *
 * @returns {{outcome: string, basis: string, toClassId: string|null}}
 */
const proposeFor = ({ currentClass, result }) => {
  if (!currentClass) {
    return { outcome: "unassigned", basis: "no_results", toClassId: null };
  }

  if (currentClass.isFinalYear) {
    return { outcome: "graduated", basis: "final_year", toClassId: null };
  }

  // The class's own bar, when the admin has set one. Checked before the
  // pass-count rule: a student can have scraped through two of three terms
  // and still sit under the average the class demands.
  if (
    currentClass.promotionAverage !== null &&
    currentClass.promotionAverage !== undefined &&
    result &&
    result.average !== null &&
    result.average !== undefined
  ) {
    if (result.average < currentClass.promotionAverage) {
      // The student stays exactly where they are — a real destination.
      return {
        outcome:   "repeated",
        basis:     "average_fail",
        toClassId: currentClass._id,
      };
    }
  } else if (result && !result.passing) {
    // Failing the year repeats it — the student stays exactly where they are,
    // which is a real destination, not an absent one.
    return { outcome: "repeated", basis: "results_fail", toClassId: currentClass._id };
  }

  if (!currentClass.nextClassId) {
    // Rule 1. No destination is stated, so none is invented.
    return { outcome: "unassigned", basis: result ? "results_pass" : "no_results", toClassId: null };
  }

  return {
    outcome:   "promoted",
    basis:     result ? "results_pass" : "no_results",
    toClassId: currentClass.nextClassId,
  };
};

const tallyCounts = (decisions) => ({
  total:      decisions.length,
  promoted:   decisions.filter((d) => d.outcome === "promoted").length,
  repeated:   decisions.filter((d) => d.outcome === "repeated").length,
  graduated:  decisions.filter((d) => d.outcome === "graduated").length,
  unassigned: decisions.filter((d) => d.outcome === "unassigned").length,
});

const refreshCounts = async (runId) => {
  const decisions = await PromotionDecision.find({ runId, deletedAt: null })
    .select("outcome").lean();
  const counts = tallyCounts(decisions);
  await PromotionRun.updateOne({ _id: runId }, { counts });
  return counts;
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERATE
// ─────────────────────────────────────────────────────────────────────────────

const generateRun = async ({ schoolId, fromYear, toYear, generatedBy }) => {
  if (fromYear === toYear) {
    const err = new Error("fromYear and toYear must differ");
    err.status = 400;
    throw err;
  }

  const students = await Student.find({
    schoolId, status: "approved", deletedAt: null,
  }).select("studentName name firstName lastName classId enrollmentNo").lean();

  if (!students.length) {
    const err = new Error("There are no approved students to promote");
    err.code   = "NO_STUDENTS";
    err.status = 400;
    throw err;
  }

  const classes = await Class.find({ schoolId, deletedAt: null })
    .select("name nextClassId isFinalYear promotionAverage").lean();
  const classById = new Map(classes.map((c) => [String(c._id), c]));

  const results = await resultsByStudent(schoolId, fromYear);

  const run = await PromotionRun.create({
    schoolId, fromYear, toYear,
    status: "draft",
    generatedBy: generatedBy ?? null,
  });

  const rows = students.map((s) => {
    const currentClass = s.classId ? classById.get(String(s.classId)) : null;
    const result       = results.get(String(s._id)) ?? null;
    const proposal     = proposeFor({ currentClass, result });
    const target       = proposal.toClassId ? classById.get(String(proposal.toClassId)) : null;

    return {
      runId:    String(run._id),
      schoolId,
      studentId:    String(s._id),
      studentName:  displayName(s) || null,
      enrollmentNo: s.enrollmentNo ?? null,
      fromClassId:   s.classId ? String(s.classId) : null,
      fromClassName: currentClass?.name ?? null,
      toClassId:     proposal.toClassId,
      toClassName:   target?.name ?? null,
      outcome:       proposal.outcome,
      basis:         proposal.basis,
      average:       result?.average ?? null,
    };
  });

  await PromotionDecision.insertMany(rows, { ordered: false });
  const counts = await refreshCounts(String(run._id));

  return { run: { ...run.toObject(), counts }, decisions: rows };
};

// ─────────────────────────────────────────────────────────────────────────────
// OVERRIDE
// ─────────────────────────────────────────────────────────────────────────────

const setDecision = async ({ schoolId, runId, studentId, outcome, toClassId }) => {
  const run = await PromotionRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Promotion run not found");
    err.status = 404;
    throw err;
  }
  if (run.status !== "draft") {
    const err = new Error(`This run is already ${run.status}`);
    err.code   = "NOT_DRAFT";
    err.status = 409;
    throw err;
  }

  const decision = await PromotionDecision.findOne({
    runId, studentId, deletedAt: null,
  });
  if (!decision) {
    const err = new Error("No decision for that student in this run");
    err.status = 404;
    throw err;
  }

  // A promotion or a repeat must land somewhere real; graduating deliberately
  // lands nowhere. Checking here keeps an impossible decision out of the run
  // rather than discovering it half way through the commit.
  if (outcome === "promoted" || outcome === "repeated") {
    if (!toClassId) {
      const err = new Error("A destination class is required for that outcome");
      err.status = 400;
      throw err;
    }
    const target = await Class.findOne({ _id: toClassId, schoolId, deletedAt: null })
      .select("name").lean();
    if (!target) {
      const err = new Error("No class with that id in this school");
      err.status = 404;
      throw err;
    }
    decision.toClassId   = String(toClassId);
    decision.toClassName = target.name;
  } else {
    decision.toClassId   = null;
    decision.toClassName = null;
  }

  decision.outcome    = outcome;
  decision.basis      = "manual";
  decision.overridden = true;
  await decision.save();

  const counts = await refreshCounts(runId);
  return { decision, counts };
};

// ─────────────────────────────────────────────────────────────────────────────
// COMMIT
// ─────────────────────────────────────────────────────────────────────────────

const commitRun = async ({ schoolId, runId, committedBy }) => {
  const run = await PromotionRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Promotion run not found");
    err.status = 404;
    throw err;
  }
  if (run.status !== "draft") {
    const err = new Error(`This run is already ${run.status}`);
    err.code   = "NOT_DRAFT";
    err.status = 409;
    throw err;
  }

  const decisions = await PromotionDecision.find({ runId, deletedAt: null }).lean();

  const unassigned = decisions.filter((d) => d.outcome === "unassigned");
  if (unassigned.length) {
    const err = new Error(
      `${unassigned.length} student(s) have no destination. Decide those before committing.`
    );
    err.code   = "UNASSIGNED";
    err.status = 409;
    err.details = unassigned.slice(0, 20).map((d) => ({
      studentId: d.studentId, studentName: d.studentName, fromClassName: d.fromClassName,
    }));
    throw err;
  }

  const now = new Date();

  for (const d of decisions) {
    // Rule 2: capture the year being left BEFORE the pointer moves. Upserted,
    // so committing after a reversal does not collide with the row the first
    // attempt already wrote.
    await Enrollment.updateOne(
      { schoolId, studentId: d.studentId, academicYear: run.fromYear, deletedAt: null },
      {
        $set: {
          classId:   d.fromClassId,
          className: d.fromClassName,
          outcome:   d.outcome,
        },
        $setOnInsert: { schoolId, studentId: d.studentId, academicYear: run.fromYear },
      },
      { upsert: true }
    );

    if (d.outcome === "graduated") {
      // No enrollment for the new year — they have left. `graduated` keeps them
      // out of every roster query without deleting anything.
      await Student.updateOne(
        { _id: d.studentId, schoolId },
        { status: "graduated", graduatedAt: now }
      );
      continue;
    }

    await Enrollment.updateOne(
      { schoolId, studentId: d.studentId, academicYear: run.toYear, deletedAt: null },
      {
        $set: {
          classId:        d.toClassId,
          className:      d.toClassName,
          promotionRunId: String(run._id),
        },
        $setOnInsert: { schoolId, studentId: d.studentId, academicYear: run.toYear },
      },
      { upsert: true }
    );

    await Student.updateOne(
      { _id: d.studentId, schoolId },
      { classId: d.toClassId }
    );
  }

  run.status      = "committed";
  run.committedBy = committedBy ?? null;
  run.committedAt = now;
  await run.save();

  return { run, applied: decisions.length };
};

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Put every student back where they were.
 *
 * Restores from each decision's `fromClassId` (rule 3) rather than re-deriving
 * anything, so it is exact even where a class has since been renamed. The new
 * year's enrollments are removed because that year did not happen; the outgoing
 * year's rows are kept, since where a student sat last year remains true.
 */
const reverseRun = async ({ schoolId, runId, reason, reversedBy }) => {
  const run = await PromotionRun.findOne({ _id: runId, schoolId, deletedAt: null });
  if (!run) {
    const err = new Error("Promotion run not found");
    err.status = 404;
    throw err;
  }
  if (run.status !== "committed") {
    const err = new Error("Only a committed run can be reversed");
    err.code   = "NOT_COMMITTED";
    err.status = 409;
    throw err;
  }

  const decisions = await PromotionDecision.find({ runId, deletedAt: null }).lean();
  const now = new Date();

  for (const d of decisions) {
    await Student.updateOne(
      { _id: d.studentId, schoolId },
      {
        classId: d.fromClassId,
        // A graduate returns to the register; anyone else was already on it.
        ...(d.outcome === "graduated" ? { status: "approved", graduatedAt: null } : {}),
      }
    );
  }

  const removed = await Enrollment.deleteMany({
    schoolId, academicYear: run.toYear, promotionRunId: String(run._id),
  });

  // The outgoing year's outcome is no longer settled, so it is cleared while
  // the rows themselves stay — the student really was in that class.
  await Enrollment.updateMany(
    { schoolId, academicYear: run.fromYear, studentId: { $in: decisions.map((d) => d.studentId) } },
    { outcome: null }
  );

  run.status         = "reversed";
  run.reversedBy     = reversedBy ?? null;
  run.reversedAt     = now;
  run.reversalReason = reason ?? null;
  await run.save();

  return { run, restored: decisions.length, enrollmentsRemoved: removed.deletedCount ?? 0 };
};

module.exports = {
  proposeFor,
  tallyCounts,
  resultsByStudent,
  generateRun,
  setDecision,
  commitRun,
  reverseRun,
};
