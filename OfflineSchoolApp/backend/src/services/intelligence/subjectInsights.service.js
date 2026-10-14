// backend/src/services/intelligence/subjectInsights.service.js
"use strict";

/**
 * Loading what the engine needs. The engine itself is shared/.
 *
 * ── What moved, and why ───────────────────────────────────────────────────
 *
 * Every rule — the thresholds, the recent/earlier split, the confidence bands,
 * what counts as a mark, what counts as a strength, where a school's own grade
 * bands put the strength threshold — is now in
 * shared/intelligence/subjectInsights.js.
 *
 * It moved because three consumers need the same answer about the same child.
 * The server answers over HTTP; the desktop answers from its local mirror when
 * there is no connection. The first time two implementations disagreed about
 * whether an absence is a zero, a teacher would be told one thing by a screen
 * and another by the report card, with nothing to say which was right. That is
 * precisely what happened to the grading table before shared/gradeScale.js
 * existed, and it took four copies to notice.
 *
 * ── What is left here ─────────────────────────────────────────────────────
 *
 * Three queries and the school context to run them in. This file knows Mongo
 * exists; the engine does not, and must not.
 *
 *     database  →  build the input  →  shared engine  →  profile
 *
 * NOTE ON WHAT IS NOT HERE: no financial field, no fee balance, no attendance
 * and no homework. Neither this module nor the shared engine requires
 * services/fees.service, and the check scripts assert that by reading the
 * require graph of both.
 */

const AcademicStructure = require("../../db/models/AcademicStructure");
const GradingConfig     = require("../../db/models/GradingConfig");
const academicHistory   = require("./academicHistory.service");
const engine            = require("../../../../shared/intelligence/subjectInsights");

/**
 * The school's own grading rules, loaded and then resolved by the engine.
 *
 * The two documents are fetched here because only the application knows where
 * they live; what they MEAN — which pass mark wins, where the strength
 * threshold lands on this school's bands — is the engine's, so that the desktop
 * resolving the same two mirrored documents gets the same context.
 */
const gradingContextFor = async (schoolId) => {
  const [gradingConfig, academicStructure] = await Promise.all([
    GradingConfig.findOne({ schoolId }).select("passMark grades").lean(),
    AcademicStructure.findOne({ schoolId, deletedAt: null })
      .sort({ academicYear: -1 })
      .select("passMark")
      .lean(),
  ]);

  return engine.resolveGradingContext({ gradingConfig, academicStructure });
};

/**
 * Intelligence for one or more pupils, computed from their published results.
 *
 * Bulk by construction: one history query and one grading-context read however
 * many pupils are asked for, so a class of forty costs what one costs. The
 * engine then does the arithmetic with no I/O at all.
 *
 * @returns {Promise<Map<string, object>>} studentId → profile
 */
const analyse = async ({ schoolId, studentIds }) => {
  const ids = [...new Set((studentIds ?? []).map(String).filter(Boolean))];
  if (!ids.length) return new Map();

  const [historyByStudent, grading] = await Promise.all([
    academicHistory.publishedHistory({ schoolId, studentIds: ids, withSubjects: true }),
    gradingContextFor(schoolId),
  ]);

  return engine.analyseHistories({ historyByStudent, studentIds: ids, grading });
};

/** One pupil. */
const profileFor = async ({ schoolId, studentId }) =>
  (await analyse({ schoolId, studentIds: [studentId] })).get(String(studentId)) ?? null;

module.exports = {
  analyse,
  profileFor,
  gradingContextFor,
  // Re-exported from the shared engine rather than reimplemented. Existing
  // callers and check scripts keep one import, and there is no local copy for
  // anything to drift away from.
  seriesFrom:           engine.seriesFrom,
  metricsFor:           engine.metricsFor,
  insightsFor:          engine.insightsFor,
  crossSubjectStrength: engine.crossSubjectStrength,
  confidenceFrom:       engine.confidenceFrom,
  buildProfile:         engine.buildProfile,
  THRESHOLDS:           engine.THRESHOLDS,
  ENGINE_VERSION:       engine.ENGINE_VERSION,
};
