// backend/src/services/promotion.service.js
"use strict";

const Student           = require("../db/models/Student");
const Class             = require("../db/models/Class");
const Enrollment        = require("../db/models/Enrollment");
const PromotionRun      = require("../db/models/PromotionRun");
const PromotionDecision = require("../db/models/PromotionDecision");
const { displayName } = require("../utils/studentName");
const AcademicStructure = require("../db/models/AcademicStructure");
const AnnualResult      = require("../db/models/AnnualResult");
const TermResult        = require("../db/models/TermResult");
const { promotionUnderRules } = require("../../../shared/academicRules");
const GradingConfig     = require("../db/models/GradingConfig");
const { legacyTermsOf } = require("../../../shared/academicPolicy");
const { moveCurrentYear } = require("./rankingScope.service");

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

// The pre-decision ("legacy") reader averaged the year's published sequence
// summaries against Class.promotionAverage (0-100). It is gone: every run now
// reads the published annual average against the class's bar for the year
// (docs/39 §14, decided 2026-10-16). Class.promotionAverage stays on the class
// for reference and is shown beside the new /20 bar until an admin confirms
// one; no run reads it.

/**
 * The year's picture per student: published AnnualResult and TermResult rows,
 * the year's own figures (docs/39 §14, decision D1b). Published only: a draft
 * result is a working copy nobody has signed off.
 */
const yearByStudent = async (schoolId, academicYear) => {
  const [annual, terms] = await Promise.all([
    AnnualResult.find({ schoolId, academicYear, isPublished: true, deletedAt: null })
      .select("studentId annualAverage").lean(),
    TermResult.find({ schoolId, academicYear, isPublished: true, deletedAt: null })
      .select("studentId term isPassing").lean(),
  ]);
  const out = new Map();
  const entry = (id) => {
    const k = String(id);
    if (!out.has(k)) out.set(k, { annualAverage: null, terms: new Map() });
    return out.get(k);
  };
  for (const a of annual) entry(a.studentId).annualAverage = a.annualAverage ?? null;
  for (const t of terms)  entry(t.studentId).terms.set(Number(t.term), !!t.isPassing);
  return out;
};

/**
 * One student's proposal. Pure.
 *
 * The outcome comes from promotionUnderRules — the very function the annual
 * row's promotionStatus is computed by — so the run and the annual card can
 * no longer disagree (docs/39 §4.4). The rules about destinations are the
 * legacy ones: a final year graduates, a missing next class is never guessed.
 */
const proposeUnderRules = ({ rules, currentClass, year, termNumbers, passMark = null }) => {
  if (!currentClass) return { outcome: "unassigned", basis: "no_results", toClassId: null };
  if (currentClass.isFinalYear) return { outcome: "graduated", basis: "final_year", toClassId: null };

  const { status, reason } = promotionUnderRules(rules, {
    annualAverage: year?.annualAverage ?? null,
    terms: termNumbers.map((n) => ({ isComplete: year?.terms.has(n) ?? false, passed: year?.terms.get(n) ?? false })),
    termsInYear: termNumbers.length,
    classId: currentClass._id,
    passMark,
  });

  if (status === "pending") {
    // Not decidable from results: an incomplete year, no bar, or manual_only.
    // Unassigned blocks the commit until someone decides (rule 1).
    return { outcome: "unassigned", basis: reason === "manual" ? "manual" : "no_results", toClassId: null };
  }
  if (status === "repeated") {
    return { outcome: "repeated", basis: reason === "average_fail" ? "average_fail" : "results_fail", toClassId: currentClass._id };
  }
  if (!currentClass.nextClassId) return { outcome: "unassigned", basis: "results_pass", toClassId: null };
  return { outcome: "promoted", basis: "results_pass", toClassId: currentClass.nextClassId };
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
    .select("name nextClassId isFinalYear").lean();
  const classById = new Map(classes.map((c) => [String(c._id), c]));

  // The year being closed: its terms, its bars, and the school's pass mark,
  // which is the bar of a class with none (shared/academicRules).
  const [structure, gradingConfig] = await Promise.all([
    AcademicStructure.findOne({ schoolId, academicYear: fromYear, deletedAt: null }).select("rules terms").lean(),
    GradingConfig.findOne({ schoolId }).select("passMark").lean(),
  ]);
  const passMark    = gradingConfig?.passMark ?? 10;
  const years       = await yearByStudent(schoolId, fromYear);
  const termNumbers = [...new Set(legacyTermsOf(structure).map((t) => t.number))];

  const run = await PromotionRun.create({
    schoolId, fromYear, toYear,
    status: "draft",
    generatedBy: generatedBy ?? null,
  });

  const rows = students.map((s) => {
    const currentClass = s.classId ? classById.get(String(s.classId)) : null;
    const year         = years.get(String(s._id)) ?? null;
    const proposal     = proposeUnderRules({ rules: structure?.rules, currentClass, year, termNumbers, passMark });
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
      average:       year?.annualAverage ?? null,
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

  // The school is in its new year now (rankingScope.service).
  await moveCurrentYear({ schoolId, from: run.fromYear, to: run.toYear, orUnset: true });

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

  // And back in the year the run closed, unless it has moved on since.
  await moveCurrentYear({ schoolId, from: run.toYear, to: run.fromYear });

  return { run, restored: decisions.length, enrollmentsRemoved: removed.deletedCount ?? 0 };
};

module.exports = {
  proposeUnderRules,
  tallyCounts,
  yearByStudent,
  generateRun,
  setDecision,
  commitRun,
  reverseRun,
};
