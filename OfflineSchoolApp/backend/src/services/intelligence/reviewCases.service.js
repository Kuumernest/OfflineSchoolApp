// backend/src/services/intelligence/reviewCases.service.js
"use strict";

/**
 * The calibration review surface, inside the application.
 *
 * ── Why this exists when the export already does ──────────────────────────
 *
 * The anonymised export is built so that nobody without the operator's salt
 * can get from a case back to a child. That is the right property for a file
 * that gets emailed. It is the wrong property for a teacher who is being asked
 * "is this your pupil?" — they need the name, and a head teacher reading the
 * school's reviews needs to know which colleague said what.
 *
 * So the same analysis runs here over LIVE documents, for a caller the server
 * has already authorised to see exactly those pupils. Nothing is anonymised
 * because nothing needs to be: the authorisation happened first, and the rows
 * this loads are rows the caller could already read through /insights.
 *
 * ── One analysis, one mapping, one engine ─────────────────────────────────
 *
 * Documents go through cohortSchema.cohortFromDocuments — the same mapping the
 * exporter uses, with the identity function where the exporter puts its HMAC.
 * The cohort goes through scripts/calibration/analyseCohort.analyse — the same
 * distributions, flags, sensitivity and case selection an operator gets from a
 * file. And analyse() reaches shared/intelligence for every judgement, the
 * same functions /insights calls. There is no review-surface copy of anything.
 *
 * ── Independent reviews stay independent ──────────────────────────────────
 *
 * Two teachers asked about the same case must answer without seeing each
 * other. So the package is built for a VIEWER: a teacher who has not yet
 * reviewed a case gets the case, its evidence, and how many colleagues have
 * reviewed it — and not one word of what they said, nor who they were. Once
 * the teacher has submitted their own, the others appear. The head and the
 * operator are not reviewers; they are the people the comparison is for, and
 * they see everything, named, from the start.
 *
 * ── What this module does NOT decide ──────────────────────────────────────
 *
 * Who is asking. It takes a school, a class list and a viewer already resolved
 * by the router from the caller's role and assignments. The engine determines
 * what the evidence means; the router determines who may see it; this turns
 * the one into the other for the people allowed to.
 *
 * ── The isolated engine, in a server ──────────────────────────────────────
 *
 * analyse() runs the sensitivity sweep on a private copy of the engine loaded
 * through scripts/calibration/isolatedEngine.js, which evicts and restores the
 * module cache synchronously. There is no await inside that window, so no
 * other request can observe the swap; the production modules everybody else
 * holds are untouched. scripts/check-calibration.js asserts that.
 */

const path = require("path");

const Student            = require("../../db/models/Student");
const Exam               = require("../../db/models/Exam");
const ResultSummary      = require("../../db/models/ResultSummary");
const GradingConfig      = require("../../db/models/GradingConfig");
const AcademicStructure  = require("../../db/models/AcademicStructure");
const Intervention       = require("../../db/models/Intervention");
const IntelligenceReview = require("../../db/models/IntelligenceReview");
const User               = require("../../db/models/User");
const Class              = require("../../db/models/Class");
const { displayName }    = require("../../utils/studentName");
const { ROLES }          = require("../../config/roles");

const CAL = path.join(__dirname, "..", "..", "..", "scripts", "calibration");
const { cohortFromDocuments } = require(path.join(CAL, "cohortSchema"));
const { analyse }             = require(path.join(CAL, "analyseCohort"));
const { analyseReviews, validateReview } = require(path.join(CAL, "reviewFeedback"));

/** A case is identified by what it is about, not by its position on a sheet. */
const caseKey = ({ category, studentId, subjectId }) =>
  `${category}|${studentId}|${subjectId ?? "-"}`;

/** What a case's review state is called on a screen. Three words, no collapse. */
const STATUS = Object.freeze({ NONE: "UNREVIEWED", ONE: "ONE_REVIEW", MANY: "MULTIPLE_REVIEWS" });

// ─────────────────────────────────────────────────────────────────────────────
// LOADING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The live cohort for a scope.
 *
 * @param {object}        scope
 * @param {string}        scope.schoolId
 * @param {string[]|null} scope.classIds    null means the whole school
 * @param {string[]|null} [scope.studentIds] narrows further, for one pupil
 */
const liveCohort = async ({ schoolId, classIds, studentIds: only = null }) => {
  const studentFilter = { schoolId, status: "approved", deletedAt: null };
  if (classIds) studentFilter.classId = { $in: classIds };
  if (only)     studentFilter._id     = { $in: only };

  // Name fields too: the exporter drops them, this surface shows them, because
  // the caller has already been authorised to see exactly these pupils.
  const students = await Student.find(studentFilter)
    .select("_id classId studentName name firstName lastName enrollmentNo").lean();
  const studentIds = students.map((s) => String(s._id));

  const [exams, summaries, gradingConfig, academicStructure, interventions] = await Promise.all([
    Exam.find({ schoolId, deletedAt: null })
      .select("_id type academicYear term sequenceNumber startDate parentExamId").lean(),
    studentIds.length
      ? ResultSummary.find({ schoolId, deletedAt: null, studentId: { $in: studentIds } })
          .select("_id examId studentId classId isPublished createdAt subjectBreakdown").lean()
      : [],
    GradingConfig.findOne({ schoolId }).select("passMark grades").lean(),
    AcademicStructure.findOne({ schoolId, deletedAt: null })
      .sort({ academicYear: -1 }).select("passMark").lean(),
    studentIds.length
      ? Intervention.find({ schoolId, deletedAt: null, studentId: { $in: studentIds } })
          .select("_id studentId subjectId status createdAt startedAt").lean()
      : [],
  ]);

  return {
    studentIds,
    students,
    cohort: cohortFromDocuments({
      provenance: { kind: "live", note: "Computed in-app over live documents for an authorised caller." },
      exams, summaries, students, gradingConfig, academicStructure, interventions,
    }),
  };
};

/** Reviews already recorded for these pupils, with the reviewer's name joined. */
const reviewsFor = async ({ schoolId, studentIds }) => {
  if (!studentIds.length) return [];
  const reviews = await IntelligenceReview.find({
    schoolId, deletedAt: null, studentId: { $in: studentIds },
  }).sort({ reviewedAt: -1 }).lean();

  const reviewerIds = [...new Set(reviews.map((r) => String(r.reviewedBy)))];
  const reviewers = reviewerIds.length
    ? await User.find({ _id: { $in: reviewerIds } }).select("name").lean()
    : [];
  const nameOf = new Map(reviewers.map((u) => [String(u._id), u.name ?? null]));

  return reviews.map((r) => ({
    ...r,
    // Attributed, always. Whether a given viewer is SHOWN it is decided below.
    reviewedByName: nameOf.get(String(r.reviewedBy)) ?? null,
  }));
};

// ─────────────────────────────────────────────────────────────────────────────
// SHAPING FOR A VIEWER
// ─────────────────────────────────────────────────────────────────────────────

const publicReview = (r) => ({
  reviewId: String(r._id), reviewedBy: String(r.reviewedBy), reviewedByName: r.reviewedByName,
  reviewedAt: r.reviewedAt, revisedAt: r.revisedAt ?? null, engineVersion: r.engineVersion,
  version: r.version, review: r.review,
});

/**
 * Do the reviewers on a case agree about the one question that matters most?
 *
 * "Agreement" on classificationAppropriate, and only when there are at least
 * two reviewers. It is a description of the sheet, never a score: two teachers
 * agreeing that the engine was wrong is agreement.
 */
const agreementOf = (reviews) => {
  if (reviews.length < 2) return null;
  const answers = new Set(reviews.map((r) => r.review?.classificationAppropriate ?? null));
  return answers.size === 1 ? "AGREE" : "DIFFER";
};

const statusOf = (count) => (count === 0 ? STATUS.NONE : count === 1 ? STATUS.ONE : STATUS.MANY);

/**
 * Whether this viewer is shielded from colleagues' answers on this case.
 *
 * Teachers are reviewers, and a reviewer who has not answered yet must not read
 * the answers. Heads and operators are the audience for the comparison and see
 * everything. A teacher who HAS answered is no longer contaminable and sees the
 * others — that is how two independent judgements get compared in a staffroom.
 */
const shielded = (viewer, ownReview) =>
  viewer?.role === ROLES.TEACHER && !ownReview;

/**
 * One case as this viewer may see it.
 */
const caseForViewer = (c, reviews, viewer) => {
  const mine = viewer?.userId ? reviews.find((r) => String(r.reviewedBy) === String(viewer.userId)) : null;
  const hide = shielded(viewer, mine);
  return {
    ...c,
    reviewStatus: statusOf(reviews.length),
    reviewCount: reviews.length,
    reviewerCount: new Set(reviews.map((r) => String(r.reviewedBy))).size,
    agreement: hide ? null : agreementOf(reviews),
    myReview: mine ? publicReview(mine) : null,
    othersHidden: hide && reviews.length > 0,
    reviews: hide ? [] : reviews.map(publicReview),
  };
};

/**
 * The school-wide (or class-wide) picture of how the validation is going.
 * Counts only; the per-case detail is on the cases themselves.
 */
const reviewStatusOf = (cases, allReviews) => {
  const byCategory = {};
  for (const c of cases) {
    const b = byCategory[c.category] ?? { cases: 0, reviewed: 0, multipleReviews: 0, differ: 0 };
    b.cases += 1;
    if (c.reviewCount > 0) b.reviewed += 1;
    if (c.reviewCount > 1) b.multipleReviews += 1;
    if (c.agreement === "DIFFER") b.differ += 1;
    byCategory[c.category] = b;
  }
  // A category where reviewers have differed on more than one case is worth a
  // second look before anything else — a pattern, not a verdict, and never a
  // score for anyone.
  const repeatedDisagreements = Object.keys(byCategory).filter((k) => byCategory[k].differ >= 2).sort();
  const withMany = cases.filter((c) => c.reviewCount > 1);
  return {
    cases: cases.length,
    unreviewed:      cases.filter((c) => c.reviewCount === 0).length,
    oneReview:       cases.filter((c) => c.reviewCount === 1).length,
    multipleReviews: withMany.length,
    // Off the viewer-shaped case: null where the shield hid it, so a teacher
    // learns nothing about how colleagues answered a case they have not.
    agreement: {
      agree:  withMany.filter((c) => c.agreement === "AGREE").length,
      differ: withMany.filter((c) => c.agreement === "DIFFER").length,
    },
    reviewsRecorded: [...allReviews.values()].reduce((n, l) => n + l.length, 0),
    reviewers: new Set([...allReviews.values()].flat().map((r) => String(r.reviewedBy))).size,
    repeatedDisagreements,
    byCategory: Object.fromEntries(Object.keys(byCategory).sort().map((k) => [k, byCategory[k]])),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PACKAGE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The review package for a scope, as one viewer may see it.
 *
 * @param {object} scope   { schoolId, classIds }
 * @param {object} viewer  { userId, role }
 */
const reviewPackage = async (scope, viewer = null) => {
  const { studentIds, students, cohort } = await liveCohort(scope);
  const report = analyse(cohort);
  const reviews = await reviewsFor({ schoolId: scope.schoolId, studentIds });

  // Who each case is about, for the person reading it. analyse() itself never
  // sees a name — the identity is joined here, after authorisation, and only
  // here.
  const classIds = [...new Set(students.map((s) => String(s.classId)).filter(Boolean))];
  const classes = classIds.length
    ? await Class.find({ _id: { $in: classIds }, schoolId: scope.schoolId }).select("_id name").lean()
    : [];
  const className = new Map(classes.map((c) => [String(c._id), c.name ?? null]));
  const identity = new Map(students.map((s) => [String(s._id), {
    studentName: displayName(s) || null,
    enrollmentNo: s.enrollmentNo ?? null,
    classId: s.classId ? String(s.classId) : null,
    className: s.classId ? (className.get(String(s.classId)) ?? null) : null,
  }]));

  const byCase = new Map();
  for (const r of reviews) {
    const k = caseKey(r);
    const list = byCase.get(k) ?? [];
    list.push(r);
    byCase.set(k, list);
  }

  const cases = report.reviewCases.cases.map((c) =>
    caseForViewer({ ...c, ...(identity.get(c.studentId) ?? {}) }, byCase.get(caseKey(c)) ?? [], viewer));

  // The feedback tool reads the sheet shape: cases whose `review` is the form.
  // Each recorded review is one row; two reviewers on one case count twice,
  // which is what two independent judgements should do. Built from the reviews
  // THIS viewer may see: the tally quotes reasons and names disagreements, so
  // for a teacher it covers only cases they have answered, and for the head and
  // the operator, everything. A tally over one hidden review would be that
  // review, with the shield taken off.
  const feedbackSheet = {
    cases: cases.flatMap((c) => c.reviews.map((r) => ({
      caseId: `${c.caseId}#${r.reviewId}`, category: c.category,
      classifications: c.classifications, thresholdsInvolved: c.thresholdsInvolved, review: r.review,
    }))),
  };

  return {
    engineVersion: report.engineVersion,
    scope: { schoolId: scope.schoolId, classIds: scope.classIds, students: studentIds.length },
    reviewForm: report.reviewCases.reviewForm,
    categories: report.reviewCases.categories,
    priority:   report.reviewCases.priority,
    coverage:   report.reviewCases.coverage,
    reviewStatus: reviewStatusOf(cases, byCase),
    cases,
    feedback: analyseReviews(feedbackSheet),
    report,
  };
};

/**
 * One case, verified against the engine, for a submission.
 *
 * A review must be OF something the engine actually said about this pupil
 * today. The pupil is analysed alone — the case selection is per pupil, so the
 * answer is the same as it would be on the whole sheet — and the case's
 * classifications are taken from the server, not from the request.
 *
 * @returns {object|null} the case, or null when the engine produces no such case
 */
const caseFor = async ({ schoolId, studentId, category, subjectId }) => {
  const student = await Student.findOne({ _id: String(studentId), schoolId, deletedAt: null })
    .select("_id classId").lean();
  if (!student) return null;
  const { cohort } = await liveCohort({ schoolId, classIds: null, studentIds: [String(student._id)] });
  const report = analyse(cohort);
  const wanted = caseKey({ category, studentId: String(student._id), subjectId: subjectId ?? null });
  return report.reviewCases.cases.find((c) => caseKey(c) === wanted) ?? null;
};

/**
 * One pupil, through both paths, compared.
 *
 * The live path is what /insights answers; the offline path is what the
 * exporter's file and the review sheet are built from. Both end in
 * shared/intelligence; this proves the road to it is the same too. The
 * comparison is a structural diff that normalises nothing — see
 * scripts/calibration/consistency.js.
 */
const liveOfflineConsistency = async ({ schoolId, studentId }) => {
  const subjectInsights = require("./subjectInsights.service");
  const guidance        = require("./guidance.service");
  const { runEngine }        = require(path.join(CAL, "analyseCohort"));
  const { compareProfiles }  = require(path.join(CAL, "consistency"));

  const id = String(studentId);
  const [liveProfile, liveGuidance, { cohort }] = await Promise.all([
    subjectInsights.profileFor({ schoolId, studentId: id }),
    guidance.guidanceFor({ schoolId, studentId: id }),
    liveCohort({ schoolId, classIds: null, studentIds: [id] }),
  ]);
  const run = runEngine(cohort);
  return {
    studentId: id,
    ...compareProfiles(
      { engineVersion: subjectInsights.ENGINE_VERSION, profile: liveProfile, guidance: liveGuidance },
      { engineVersion: run.engineVersion, profile: run.profiles.get(id) ?? null, guidance: run.guidanceByStudent.get(id) ?? null }
    ),
  };
};

/**
 * The calibration summary for a scope: what the data is, what the engine said,
 * the flags, the sensitivity table, how the review is going — and none of the
 * per-pupil detail, which lives on the review package where it can be read
 * case by case.
 *
 * Nothing here is an extraction artefact. There is no salt (nothing was
 * anonymised), no raw cohort and no download; a reader gets the results of the
 * analysis over pupils they were already entitled to see.
 */
const calibrationSummary = async (scope, viewer = null) => {
  const pkg = await reviewPackage(scope, viewer);
  const { report } = pkg;
  return {
    engineVersion: report.engineVersion,
    scope: pkg.scope,
    evidence: report.evidence,
    distribution: report.distribution,
    flags: report.flags,
    flagLimits: report.flagLimits,
    sensitivity: {
      deltas: report.sensitivity.deltas,
      thresholds: report.sensitivity.thresholds,
      borderlineCount: report.sensitivity.borderline.length,
      borderlineShare: report.sensitivity.borderlineShare,
    },
    reviewCoverage: pkg.coverage,
    reviewStatus: pkg.reviewStatus,
    feedback: pkg.feedback,
  };
};

module.exports = {
  liveCohort,
  reviewsFor,
  reviewPackage,
  calibrationSummary,
  liveOfflineConsistency,
  caseFor,
  caseKey,
  publicReview,
  agreementOf,
  shielded,
  validateReview,
  STATUS,
};
