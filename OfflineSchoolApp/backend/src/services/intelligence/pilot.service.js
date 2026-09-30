// backend/src/services/intelligence/pilot.service.js
"use strict";

/**
 * The pilot state machine, and the only writer of a pilot's status.
 *
 * ── What a pilot is for ───────────────────────────────────────────────────
 *
 * To make a real school's validation of the engine a bounded, recorded
 * exercise: one school, a scope, the engine versions, dates, a count of what
 * was reviewed, and a written decision at the end. The reviews themselves live
 * on IntelligenceReview; the pilot is the frame that says which of them are
 * evidence and which are a developer trying the buttons.
 *
 * ── The two rules that matter ─────────────────────────────────────────────
 *
 * 1. CALIBRATED is earned, not clicked. Reaching it requires the evidence
 *    snapshot — taken by the server, from the persisted reviews, at the moment
 *    of the transition — to meet MINIMUM_EVIDENCE, and a written decision with
 *    an outcome. Reviews having been submitted is not enough. If the sample is
 *    too small to answer the calibration questions, INSUFFICIENT_EVIDENCE is
 *    the honest terminal state and the pilot closes from there.
 *
 * 2. Nothing here changes what the engine says. A pilot has no effect on a
 *    classification, a threshold or a piece of guidance; a CALIBRATE decision
 *    is a recorded intention that docs/25 §6 then takes up as a separate,
 *    regression-covered change. The engine versions on the record are the
 *    ones the pilot's reviews were of, whatever the engines say later.
 *
 * ── The minimum evidence gate ─────────────────────────────────────────────
 *
 * Derived from minimums that already exist rather than invented here: the
 * feedback tool withholds shares below MIN_CASES_FOR_SHARE reviewed cases and
 * names no pattern below MIN_SUPPORT_FOR_PATTERN; the brief requires at least
 * two independent reviewers. So: ≥ 2 reviewers, ≥ 30 cases reviewed, ≥ 3 cases
 * reviewed by two or more teachers. It is a floor for calling the exercise
 * analysable, not a proof of anything — the decision text has to carry that.
 *
 * ── Stage 18: what a REAL pilot is tied to ────────────────────────────────
 *
 * Its own reviews (stamped with its id at submission; nothing made outside it
 * counts), the eleven engine versions as they stood when it opened (a version
 * that moves during the review period is recorded as drift and blocks a
 * CALIBRATED decision), four attestations signed by a person, and a report
 * built from counts. The explanation layer is watched, not judged: a tally of
 * modes, fallback reasons and validator rejections says whether it narrated
 * the deterministic reading without changing it. Pupils answer six bounded
 * questions about their own summary; the report counts the answers and never
 * lists a pupil.
 */

const IntelligencePilot = require("../../db/models/IntelligencePilot");
const IntelligenceStudentFeedback = require("../../db/models/IntelligenceStudentFeedback");
const School            = require("../../db/models/School");
const User              = require("../../db/models/User");
const Student           = require("../../db/models/Student");
const ResultSummary     = require("../../db/models/ResultSummary");
const TeacherAssignment = require("../../db/models/TeacherAssignment");
const reviewCases       = require("./reviewCases.service");
const { ENGINE_VERSION } = require("../../../../shared/intelligence");
const strengths   = require("../../../../shared/strengths");
const exploration = require("../../../../shared/exploration");
const learning    = require("../../../../shared/learningEvidence");
const development = require("../../../../shared/development");
const guidance    = require("../../../../shared/guidance");
const interventions = require("../../../../shared/interventions");
const planning    = require("../../../../shared/developmentPlanning");
const adaptive    = require("../../../../shared/adaptiveSupport");
const advanced    = require("../../../../shared/advancedIntelligence");
const path = require("path");
const { MIN_CASES_FOR_SHARE, MIN_SUPPORT_FOR_PATTERN } =
  require(path.join(__dirname, "..", "..", "..", "scripts", "calibration", "reviewFeedback"));
const { REVIEW_FORM } =
  require(path.join(__dirname, "..", "..", "..", "scripts", "calibration", "analyseCohort"));
const { validateCohort } =
  require(path.join(__dirname, "..", "..", "..", "scripts", "calibration", "cohortSchema"));

const STATES = IntelligencePilot.STATES;
const KINDS  = IntelligencePilot.KINDS;

/** From each state, the states it may move to. CLOSED is terminal. */
const TRANSITIONS = Object.freeze({
  READY:                 ["ACTIVE", "CLOSED"],
  ACTIVE:                ["REVIEWING", "CLOSED"],
  REVIEWING:             ["ANALYSIS_READY", "CLOSED"],
  ANALYSIS_READY:        ["CALIBRATED", "INSUFFICIENT_EVIDENCE", "CLOSED"],
  CALIBRATED:            ["CLOSED"],
  INSUFFICIENT_EVIDENCE: ["CLOSED"],
  CLOSED:                [],
});

const MINIMUM_EVIDENCE = Object.freeze({
  reviewers:                2,
  casesReviewed:            MIN_CASES_FOR_SHARE,
  casesWithMultipleReviews: MIN_SUPPORT_FOR_PATTERN,
});

/** The four things only a person can sign, at the opening of a REAL pilot. */
const ATTESTATIONS = Object.freeze(["schoolParticipates", "reviewersUnderstandTask", "noticeRequirementsMet", "retentionAgreed"]);

/** The states in which reviews and pupils' answers are being collected. */
const COLLECTING = Object.freeze(["ACTIVE", "REVIEWING"]);

/**
 * The eleven engines as they stand on this server, in the brief's vocabulary.
 * Read at the moment a pilot opens and again at every snapshot; never posted.
 */
const currentEngineVersions = () => ({
  academic:             ENGINE_VERSION,
  strengths:            strengths.STRENGTH_ENGINE_VERSION,
  exploration:          exploration.EXPLORATION_ENGINE_VERSION,
  learningEvidence:     learning.LEARNING_EVIDENCE_VERSION,
  learningIntegration:  strengths.LEARNING_INTEGRATION_VERSION,
  development:          development.DEVELOPMENT_ENGINE_VERSION,
  guidance:             guidance.GUIDANCE_ENGINE_VERSION,
  intervention:         interventions.INTERVENTION_ENGINE_VERSION,
  developmentPlanning:  planning.DEVELOPMENT_PLANNING_ENGINE_VERSION,
  adaptiveSupport:      adaptive.ADAPTIVE_SUPPORT_ENGINE_VERSION,
  advancedIntelligence: advanced.ADVANCED_INTELLIGENCE_VERSION,
});

const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/** Which parts of the gate an evidence snapshot fails. Empty means it passes. */
const evidenceShortfalls = (evidence) => Object.entries(MINIMUM_EVIDENCE)
  .filter(([k, min]) => (evidence?.[k] ?? 0) < min)
  .map(([k, min]) => ({ requirement: k, minimum: min, actual: evidence?.[k] ?? 0 }));

const fail = (status, code, message, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

const plain = (x) => (x && typeof x.toObject === "function" ? x.toObject({ flattenMaps: true }) : x);

/**
 * The engines that moved since the pilot opened. A record from before the
 * baseline existed carries only the academic version; it is compared on that.
 */
const engineDriftOf = (pilot) => {
  const now = currentEngineVersions();
  const base = plain(pilot.engineVersions) ?? { academic: pilot.engineVersion };
  return IntelligencePilot.ENGINE_KEYS
    .filter((k) => base[k] !== undefined && base[k] !== now[k])
    .map((k) => ({ engine: k, pilot: base[k], current: now[k] }));
};

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The counts a decision is made on, from the persisted reviews in the pilot's
 * scope. Read as an administrator — the snapshot is the school's, not a
 * reviewer's — and reduced to numbers and code lists before it is stored.
 */
const evidenceFor = async ({ schoolId, classIds, since = null, engineVersion = null, pilotRunId = null }) => {
  const pkg = await reviewCases.reviewPackage(
    { schoolId, classIds: classIds && classIds.length ? classIds : null },
    { userId: null, role: "school_admin" },
    { reviewedSince: since, engineVersion, pilotRunId }
  );
  const reviewed = pkg.cases.filter((c) => c.reviewCount > 0);
  const codes = new Set(reviewed.flatMap((c) => c.classifications.map((k) => k.code)));
  return {
    takenAt:                  new Date(),
    // The window the counts were taken in: reviews made inside this pilot,
    // since it opened, on the pilot's engine version. Every other review is
    // excluded and the number excluded is kept, so a decision can say what it
    // rested on.
    pilotRunId:               pilotRunId ?? null,
    since:                    since ? new Date(since) : null,
    engineVersion:            engineVersion ?? null,
    reviewsExcluded:          pkg.window.excluded,
    casesSelected:            pkg.cases.length,
    casesReviewed:            reviewed.length,
    casesAwaitingReview:      pkg.cases.length - reviewed.length,
    casesWithMultipleReviews: pkg.cases.filter((c) => c.reviewCount > 1).length,
    studentsReviewed:         new Set(reviewed.map((c) => c.studentId)).size,
    reviewsRecorded:          pkg.reviewStatus.reviewsRecorded,
    reviewers:                pkg.reviewStatus.reviewers,
    categories:               [...new Set(reviewed.map((c) => c.category))].sort(),
    subjects:                 [...new Set(reviewed.map((c) => c.subjectName ?? c.subjectId).filter(Boolean))].sort(),
    temporalPatterns:         REVIEW_FORM.temporal.appliesTo.filter((code) => codes.has(code)),
    repeatedDisagreements:    pkg.reviewStatus.repeatedDisagreements ?? [],
    dataQualityCitations:     pkg.feedback.dataQualityCitations ?? {},
    byOutcome:                pkg.feedback.totals.byOutcome ?? {},
  };
};

/** The evidence window of a pilot: the reviews stamped with its id, since it opened, on its engine version. */
const windowOf = (pilot) => ({ pilotRunId: String(pilot._id), since: pilot.createdAt ?? pilot.startedAt ?? null, engineVersion: pilot.engineVersion ?? null });

// ─────────────────────────────────────────────────────────────────────────────
// THE EXPLANATION LAYER, WATCHED — counts only
// ─────────────────────────────────────────────────────────────────────────────

/** Fallback reasons that mean the provider, not the validator, failed. */
const PROVIDER_FAILURE_REASONS = new Set(["PROVIDER_AUTH", "PROVIDER_UNAVAILABLE", "MODEL_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_QUOTA", "PROVIDER_REFUSED", "INVALID_RESPONSE"]);

/**
 * One explain/ask answer, counted against the school's open pilot. The audit
 * block is the input: its request type, mode, fallback reason, validation
 * codes and question category — and nothing else on it is read. No question,
 * no answer, no pupil, no viewer is stored. A school with no open pilot
 * counts nothing.
 */
const recordAdvancedUse = async ({ schoolId, audit }) => {
  if (!schoolId || !audit || !audit.mode) return false;
  const key = (s) => String(s ?? "UNKNOWN").replace(/[^A-Za-z0-9_]/g, "_");
  const inc = { "advancedTally.requests": 1, [`advancedTally.byRequestType.${key(audit.requestType)}`]: 1, [`advancedTally.byMode.${key(audit.mode)}`]: 1 };
  if (audit.fallbackReason) inc[`advancedTally.byFallbackReason.${key(audit.fallbackReason)}`] = 1;
  if (PROVIDER_FAILURE_REASONS.has(audit.fallbackReason)) inc["advancedTally.providerFailures"] = 1;
  if (audit.fallbackReason === "VALIDATION_FAILED") inc["advancedTally.validatorRejections"] = 1;
  if (audit.mode === "MODEL_VALIDATED") inc["advancedTally.modelValidated"] = 1;
  if (audit.mode === "REFUSED") inc["advancedTally.refused"] = 1;
  if (audit.questionCategory) inc[`advancedTally.byQuestionCategory.${key(audit.questionCategory)}`] = 1;
  for (const code of audit.validationResult?.issues ?? []) inc[`advancedTally.byValidationIssue.${key(code)}`] = 1;
  const r = await IntelligencePilot.updateOne({ schoolId, isOpen: true, deletedAt: null }, { $inc: inc, $set: { "advancedTally.lastAt": new Date() } });
  return (r.modifiedCount ?? 0) > 0;
};

const VALIDATION_CODES = advanced.VALIDATION_CODES ?? ["MALFORMED_OUTPUT", "UNSUPPORTED_CLAIM", "CONTRADICTS_EVIDENCE", "MISSING_CITATION", "FUTURE_EVIDENCE", "UNAUTHORIZED_DATA", "CAREER_PREDICTION", "PSYCHOLOGICAL_INFERENCE", "MEDICAL_INFERENCE", "RISK_INFERENCE", "INTERVENTION_COMMAND"];

/** The tally as a report reads it: every count present, zero where nothing happened. */
const advancedSummaryOf = (pilot) => {
  const t = plain(pilot?.advancedTally) ?? {};
  const issues = Object.fromEntries(VALIDATION_CODES.map((c) => [c, t.byValidationIssue?.[c] ?? 0]));
  return {
    advancedIntelligenceVersion: advanced.ADVANCED_INTELLIGENCE_VERSION,
    validatorMandatory: true,
    requests: t.requests ?? 0,
    modelValidated: t.modelValidated ?? 0,
    refused: t.refused ?? 0,
    providerFailures: t.providerFailures ?? 0,
    validatorRejections: t.validatorRejections ?? 0,
    byRequestType: t.byRequestType ?? {},
    byMode: t.byMode ?? {},
    byFallbackReason: t.byFallbackReason ?? {},
    byQuestionCategory: t.byQuestionCategory ?? {},
    byValidationIssue: issues,
    // The brief's headings, read off the same counts.
    explanationValidation: { modelAnswersKept: t.modelValidated ?? 0, modelAnswersRejected: t.validatorRejections ?? 0 },
    citationValidation:    { MISSING_CITATION: issues.MISSING_CITATION, UNSUPPORTED_CLAIM: issues.UNSUPPORTED_CLAIM, CONTRADICTS_EVIDENCE: issues.CONTRADICTS_EVIDENCE, FUTURE_EVIDENCE: issues.FUTURE_EVIDENCE },
    safety:                { CAREER_PREDICTION: issues.CAREER_PREDICTION, PSYCHOLOGICAL_INFERENCE: issues.PSYCHOLOGICAL_INFERENCE, MEDICAL_INFERENCE: issues.MEDICAL_INFERENCE, RISK_INFERENCE: issues.RISK_INFERENCE, INTERVENTION_COMMAND: issues.INTERVENTION_COMMAND, UNAUTHORIZED_DATA: issues.UNAUTHORIZED_DATA },
    fallbackUsage:         { DETERMINISTIC: t.byMode?.DETERMINISTIC ?? 0, DETERMINISTIC_FALLBACK: t.byMode?.DETERMINISTIC_FALLBACK ?? 0, MODEL_VALIDATED: t.byMode?.MODEL_VALIDATED ?? 0, REFUSED: t.byMode?.REFUSED ?? 0 },
    lastAt: t.lastAt ?? null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PUPILS' ANSWERS — six questions, four words, counted
// ─────────────────────────────────────────────────────────────────────────────

const FEEDBACK = Object.freeze({ QUESTIONS: IntelligenceStudentFeedback.QUESTIONS, ANSWERS: IntelligenceStudentFeedback.ANSWERS });

/** Is a pilot collecting at this school, and has this pupil answered? */
const studentFeedbackStatusFor = async ({ schoolId, studentId }) => {
  const pilot = await openPilot(schoolId);
  const collecting = Boolean(pilot) && COLLECTING.includes(pilot.status);
  const mine = collecting ? await IntelligenceStudentFeedback.findOne({ pilotRunId: String(pilot._id), studentId: String(studentId), deletedAt: null }).lean() : null;
  return {
    open: collecting, pilotRunId: collecting ? String(pilot._id) : null, kind: collecting ? pilot.kind : null,
    questions: FEEDBACK.QUESTIONS, answers: FEEDBACK.ANSWERS,
    submitted: Boolean(mine), mine: mine ? { answers: mine.answers, submittedAt: mine.submittedAt, revisedAt: mine.revisedAt ?? null } : null,
  };
};

/**
 * Record a pupil's answers inside the school's collecting pilot. Every
 * question answered from the four words; no other field is accepted, so
 * there is nowhere for free text to go. A second submission replaces the
 * first and says when.
 */
const recordStudentFeedback = async ({ schoolId, studentId, answers }) => {
  const pilot = await openPilot(schoolId);
  if (!pilot || !COLLECTING.includes(pilot.status)) throw fail(409, "NO_PILOT_COLLECTING", "No validation pilot is collecting answers at this school.");
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw fail(400, "INVALID_FEEDBACK", "answers is required");
  const extra = Object.keys(answers).filter((k) => !FEEDBACK.QUESTIONS.includes(k));
  if (extra.length) throw fail(400, "INVALID_FEEDBACK", `unknown field(s): ${extra.join(", ")}`, { unknown: extra });
  const bad = FEEDBACK.QUESTIONS.filter((q) => !FEEDBACK.ANSWERS.includes(answers[q]));
  if (bad.length) throw fail(400, "INVALID_FEEDBACK", `each question is answered from ${FEEDBACK.ANSWERS.join(", ")}`, { invalid: bad });
  const clean = Object.fromEntries(FEEDBACK.QUESTIONS.map((q) => [q, answers[q]]));
  const pilotRunId = String(pilot._id);
  const existing = await IntelligenceStudentFeedback.findOne({ pilotRunId, studentId: String(studentId), deletedAt: null });
  let row;
  if (existing) {
    existing.answers = clean; existing.revisedAt = new Date();
    row = await existing.save();
  } else {
    row = await IntelligenceStudentFeedback.create({
      schoolId, studentId: String(studentId), pilotRunId, answers: clean,
      advancedIntelligenceVersion: advanced.ADVANCED_INTELLIGENCE_VERSION, strengthEngineVersion: strengths.STRENGTH_ENGINE_VERSION,
    });
  }
  return { pilotRunId, answers: plain(row.answers), submittedAt: row.submittedAt, revisedAt: row.revisedAt ?? null };
};

/**
 * How pupils answered, per question, per word — and only that. Below the
 * pattern minimum the breakdown is withheld: three answers from three pupils
 * in a small class would say who said what.
 */
const studentFeedbackSummaryFor = async (pilot) => {
  const rows = await IntelligenceStudentFeedback.find({ pilotRunId: String(pilot._id), deletedAt: null }).select("answers").lean();
  const responses = rows.length;
  const withheld = responses < MIN_SUPPORT_FOR_PATTERN;
  const byQuestion = withheld ? null : Object.fromEntries(FEEDBACK.QUESTIONS.map((q) => [q,
    Object.fromEntries(FEEDBACK.ANSWERS.map((a) => [a, rows.filter((r) => r.answers?.[q] === a).length]))]));
  return { responses, minimumForBreakdown: MIN_SUPPORT_FOR_PATTERN, withheld, byQuestion, questions: FEEDBACK.QUESTIONS, answers: FEEDBACK.ANSWERS };
};

// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT — may a REAL pilot start here?
// ─────────────────────────────────────────────────────────────────────────────

const GROUPS = Object.freeze(["technical", "operational", "evidence", "reviewer", "privacy"]);

/**
 * Every precondition in docs/25 §13 and §22 that a query can answer, answered;
 * the ones only a person can answer, named for signature. A real pilot cannot
 * be opened while any check fails — createPilot enforces it — so "we started
 * anyway" is not a state the record can be in.
 *
 * Three kinds of check:
 *   automatic  computed here, now, for this school and scope
 *   suite      a property held by a check script, named, not re-run per request
 *   manual     attested by the person opening the pilot
 *
 * Five groups, each answered on its own: TECHNICAL (is this application sound
 * here), OPERATIONAL (an authorised school and administrator), EVIDENCE
 * (published results, enough cases), REVIEWER (two reviewers who understand
 * the task), PRIVACY (data boundaries held by the suites; notice, consent and
 * retention, which the repository cannot determine and a person confirms).
 * A group is READY, BLOCKED, or REQUIRES_CONFIRMATION; the whole is never
 * called ready while any group is not.
 */
const preflight = async ({ schoolId, classIds = null }) => {
  const scope = { schoolId, classIds: classIds && classIds.length ? classIds : null };
  const pkg = await reviewCases.reviewPackage(scope, { userId: null, role: "school_admin" });

  const studentFilter = { schoolId, status: "approved", deletedAt: null, ...(scope.classIds ? { classId: { $in: scope.classIds } } : {}) };
  const students = await Student.find(studentFilter).select("_id classId").lean();
  const studentIds = students.map((s) => String(s._id));
  const classesInScope = [...new Set(students.map((s) => String(s.classId)).filter(Boolean))];

  const [school, admins, assignments, published] = await Promise.all([
    School.findOne({ _id: schoolId, deletedAt: null }).select("_id isActive").lean(),
    User.countDocuments({ schoolId, role: "school_admin", isActive: true }),
    TeacherAssignment.find({ schoolId, isActive: true, class: { $in: classesInScope } }).select("teacher class").lean(),
    studentIds.length ? ResultSummary.countDocuments({ schoolId, deletedAt: null, isPublished: true, studentId: { $in: studentIds } }) : 0,
  ]);
  const teachersByClass = new Map();
  for (const a of assignments) {
    const set = teachersByClass.get(String(a.class)) ?? new Set();
    set.add(String(a.teacher));
    teachersByClass.set(String(a.class), set);
  }
  const reviewers = new Set(assignments.map((a) => String(a.teacher))).size;
  const multiReviewClasses = [...teachersByClass.entries()].filter(([, s]) => s.size >= 2).map(([c]) => c);
  const multiReviewCapable = pkg.cases.filter((c) => multiReviewClasses.includes(String(c.classId))).length;

  // The engine's input, as the exporter would write it, scanned for identity.
  const { cohort } = await reviewCases.liveCohort(scope);
  const cohortProblems = validateCohort(cohort).errors ?? [];

  // Live = offline on a sample: the first three pupils with a case.
  const sample = [...new Set(pkg.cases.map((c) => c.studentId))].slice(0, 3);
  const consistency = await Promise.all(sample.map((id) => reviewCases.liveOfflineConsistency({ schoolId, studentId: id })));
  const mismatches = consistency.filter((c) => !c.identical);

  const salt = process.env.CALIBRATION_SALT;
  const schoolAuthorized = Boolean(school) && school.isActive !== false;
  const checks = [
    // ── operational: an authorised school, an authorised administrator ──
    { key: "schoolAuthorized",        kind: "automatic", group: "operational", ok: schoolAuthorized, detail: school ? (schoolAuthorized ? "the school is active on this deployment" : "the school is closed") : "no such school", missing: "authorized school" },
    { key: "schoolAdminPresent",      kind: "automatic", group: "operational", ok: admins >= 1,           detail: `${admins} active school administrator(s)`, missing: "authorized administrator" },
    { key: "schoolParticipates",      kind: "manual",    group: "operational", ok: null, detail: "the school knows it is taking part and has agreed", missing: "attestation: the school participates" },
    // ── evidence: real published results, enough cases ──────────────────
    { key: "publishedEvidence",       kind: "automatic", group: "evidence", ok: published > 0 && pkg.scope.students > 0, detail: `${published} published result(s) for ${pkg.scope.students} student(s)`, missing: "sufficient published evidence" },
    { key: "reviewableCases",         kind: "automatic", group: "evidence", ok: pkg.cases.length >= MINIMUM_EVIDENCE.casesReviewed, detail: `${pkg.cases.length} case(s) on the sheet (need ${MINIMUM_EVIDENCE.casesReviewed})`, missing: `reviewable cases (${pkg.cases.length}/${MINIMUM_EVIDENCE.casesReviewed})` },
    { key: "multiReviewCapableCases", kind: "automatic", group: "evidence", ok: multiReviewCapable >= MINIMUM_EVIDENCE.casesWithMultipleReviews, detail: `${multiReviewCapable} case(s) in classes with two or more assigned teachers (need ${MINIMUM_EVIDENCE.casesWithMultipleReviews})`, missing: `multi-review cases (${multiReviewCapable}/${MINIMUM_EVIDENCE.casesWithMultipleReviews})` },
    // ── reviewer: two real reviewers who understand the task ────────────
    { key: "reviewersAvailable",      kind: "automatic", group: "reviewer", ok: reviewers >= MINIMUM_EVIDENCE.reviewers, detail: `${reviewers} teacher(s) hold an active assignment in scope (need ${MINIMUM_EVIDENCE.reviewers})`, missing: Array.from({ length: Math.max(0, MINIMUM_EVIDENCE.reviewers - reviewers) }, (_, i) => `reviewer ${reviewers + i + 1}`) },
    { key: "reviewersUnderstandTask", kind: "manual",    group: "reviewer", ok: null, detail: "each reviewer has read the briefing and knows the task", missing: "attestation: the reviewers understand the task" },
    // ── technical: is this application sound at this school ─────────────
    { key: "engineInputNameFree",     kind: "automatic", group: "technical", ok: cohortProblems.length === 0, detail: cohortProblems.length ? cohortProblems.slice(0, 3).join("; ") : "the engine input carries no identity field", missing: "name-free engine input" },
    { key: "consistencyOperational",  kind: "automatic", group: "technical", ok: sample.length > 0 && mismatches.length === 0, detail: `${consistency.length} student(s) checked, ${mismatches.length} mismatch(es)`, missing: "live = offline consistency" },
    { key: "saltNotExposed",          kind: "automatic", group: "technical", ok: !salt || !JSON.stringify(pkg).includes(salt), detail: "the review package carries no salt", missing: "salt kept off the wire" },
    { key: "teacherScopeEnforced",    kind: "suite", group: "technical", ok: true, detail: "check-intelligence-access.js §1, check-review-workflow.js §5" },
    { key: "schoolAdminScopeEnforced", kind: "suite", group: "technical", ok: true, detail: "check-intelligence-access.js §2" },
    { key: "operatorSelectionRequired", kind: "suite", group: "technical", ok: true, detail: "check-intelligence-access.js §3, check-pilot-readiness.js §2" },
    { key: "rawExportNotExposed",     kind: "suite", group: "technical", ok: true, detail: "check-intelligence-access.js §6 — no export, download or raw cohort on any route" },
    // ── privacy: the boundaries the suites hold; the requirements a person confirms ──
    { key: "studentDataBoundaries",   kind: "suite", group: "privacy", ok: true, detail: "check-intelligence-access.js, check-advanced-intelligence.js §9 — a teacher sees taught students, a student themself, a guardian their child, the operator a selected school" },
    { key: "reviewerPrivacy",         kind: "suite", group: "privacy", ok: true, detail: "check-review-workflow.js §5, check-real-pilot.js §3 — a reviewer does not see a colleague's answer before their own" },
    { key: "dataMinimization",        kind: "suite", group: "privacy", ok: true, detail: "check-pilot-readiness.js §4, check-real-pilot.js §12 — the record and the report carry counts and codes, no student, no mark, no credential" },
    { key: "closureBehaviour",        kind: "suite", group: "privacy", ok: true, detail: "check-real-pilot.js §6 — CLOSED is terminal; findings are never deleted and are amended only with who, when, what and why" },
    { key: "noticeRequirementsMet",   kind: "manual", group: "privacy", ok: null, detail: "REQUIRES SCHOOL / OPERATOR CONFIRMATION — the notice or consent requirements that apply to this school have been met; the repository does not determine what they are", missing: "confirmation: notice/consent requirements met" },
    { key: "retentionAgreed",         kind: "manual", group: "privacy", ok: null, detail: "REQUIRES SCHOOL / OPERATOR CONFIRMATION — how long the pilot's reviews, findings and answers are kept, and what closure means, has been agreed with the school", missing: "confirmation: retention and closure agreed" },
  ];
  const blockers = checks.filter((c) => c.ok === false).map((c) => `${c.key}: ${c.detail}`);
  const groupStatus = (g) => {
    const own = checks.filter((c) => c.group === g);
    if (own.some((c) => c.ok === false)) return "BLOCKED";
    if (own.some((c) => c.kind === "manual")) return "REQUIRES_CONFIRMATION";
    return "READY";
  };
  const readiness = Object.fromEntries(GROUPS.map((g) => [g, {
    status: groupStatus(g),
    checks: checks.filter((c) => c.group === g).map((c) => c.key),
    missing: checks.filter((c) => c.group === g && c.ok === false).flatMap((c) => (Array.isArray(c.missing) ? c.missing : [c.missing])).filter(Boolean),
    pending: checks.filter((c) => c.group === g && c.kind === "manual").map((c) => c.key),
  }]));
  const technicalReady   = readiness.technical.status === "READY";
  // Operational readiness, as the earlier stage named it: everything a query
  // can answer about the school, its evidence and its reviewers.
  const operationalReady = checks.filter((c) => c.group !== "technical" && c.kind === "automatic").every((c) => c.ok === true);
  const missing = checks.filter((c) => c.ok === false).flatMap((c) => (Array.isArray(c.missing) ? c.missing : [c.missing])).filter(Boolean);
  return {
    schoolId, classIds: scope.classIds,
    ready: blockers.length === 0,
    technicalReady, operationalReady,
    readiness,
    // What a real pilot still lacks, in the words a person reads; the
    // attestations are listed separately because they are given at opening.
    status: !technicalReady ? "TECHNICAL_NOT_READY" : !operationalReady ? "REAL_PILOT_BLOCKED" : "AWAITING_ATTESTATION",
    realPilotStatus: blockers.length === 0 ? "AWAITING_ATTESTATION" : "BLOCKED",
    missing,
    attestationsPending: checks.filter((c) => c.kind === "manual").map((c) => c.missing),
    attestations: ATTESTATIONS,
    engineVersions: currentEngineVersions(),
    blockers,
    checks,
    counts: { students: pkg.scope.students, published, cases: pkg.cases.length, reviewers, multiReviewCapable, consistencyChecked: consistency.length },
    consistency: consistency.map((c) => ({ studentId: c.studentId, identical: c.identical, differences: c.differences.length })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

const openPilot = (schoolId) =>
  IntelligencePilot.findOne({ schoolId, deletedAt: null, isOpen: true });

/**
 * Open a pilot at a school. One at a time per school; the engine versions are
 * the server's, never the request's.
 */
const createPilot = async ({ schoolId, classIds = null, kind, label = null, actor, attestations = null }) => {
  if (!KINDS.includes(kind)) throw fail(400, "INVALID_PILOT_KIND", `kind must be one of ${KINDS.join(", ")}`);
  if (await openPilot(schoolId)) throw fail(409, "PILOT_OPEN", "This school already has an open pilot. Close it first.");

  // A REAL pilot starts only when every automatic precondition holds and the
  // four manual ones are signed. Development and synthetic pilots are for
  // trying the workflow and are not gated.
  let signed = null;
  if (kind === "real") {
    const pre = await preflight({ schoolId, classIds });
    if (!pre.ready) {
      throw fail(409, "REAL_PILOT_BLOCKED", `REAL PILOT BLOCKED — ${pre.blockers[0]}`,
        { blockers: pre.blockers, checks: pre.checks, readiness: pre.readiness, technicalReady: pre.technicalReady, operationalReady: pre.operationalReady, missing: pre.missing });
    }
    const a = attestations ?? {};
    const unsigned = ATTESTATIONS.filter((k) => a[k] !== true);
    if (unsigned.length) {
      throw fail(409, "ATTESTATION_REQUIRED",
        `REAL PILOT BLOCKED — ${unsigned.join(", ")} must be attested by the person opening the pilot.`,
        { blockers: [`${unsigned.join(", ")} must be attested`], unsigned });
    }
    signed = { ...Object.fromEntries(ATTESTATIONS.map((k) => [k, true])), by: actor, at: new Date() };
  }
  return IntelligencePilot.create({
    attestations: signed,
    schoolId,
    classIds: Array.isArray(classIds) && classIds.length ? classIds.map(String) : null,
    kind,
    label,
    engineVersion: ENGINE_VERSION,
    engineVersions: currentEngineVersions(),
    createdBy: actor,
    transitions: [{ from: null, to: "READY", by: actor, note: null }],
  });
};

/**
 * Move a pilot to its next state, enforcing the rules in the header.
 *
 * @param {object} pilot     the document
 * @param {string} to        the target state
 * @param {object} options   { actor, note, decision: { outcome, summary } }
 */
const transition = async (pilot, to, { actor, note = null, decision = null } = {}) => {
  if (!STATES.includes(to)) throw fail(400, "INVALID_PILOT_STATE", `unknown state ${to}`);
  if (!canTransition(pilot.status, to)) {
    throw fail(409, "INVALID_TRANSITION", `A pilot cannot move from ${pilot.status} to ${to}.`,
      { from: pilot.status, allowed: TRANSITIONS[pilot.status] });
  }

  // Entering analysis, or deciding, takes a fresh snapshot of the evidence:
  // the reviews inside the pilot, the engines now against the baseline, the
  // explanation layer's tally, the pupils' answers — counts throughout.
  if (["ANALYSIS_READY", "CALIBRATED", "INSUFFICIENT_EVIDENCE"].includes(to)) {
    const evidence = await evidenceFor({ schoolId: pilot.schoolId, classIds: pilot.classIds, ...windowOf(pilot) });
    if (to === "ANALYSIS_READY" && evidence.reviewsRecorded === 0) {
      throw fail(409, "EVIDENCE_REQUIRED", "No reviews have been recorded in this pilot's scope; there is nothing to analyse.");
    }
    const drift = engineDriftOf(pilot);
    evidence.engineVersionsMatch = drift.length === 0;
    evidence.engineDrift = drift;
    evidence.advanced = advancedSummaryOf(pilot);
    evidence.studentFeedback = await studentFeedbackSummaryFor(pilot);
    pilot.evidence = evidence;
  }

  if (to === "CALIBRATED" || to === "INSUFFICIENT_EVIDENCE") {
    if (!decision || typeof decision.summary !== "string" || decision.summary.trim().length < 20) {
      throw fail(400, "DECISION_REQUIRED",
        "A written decision (at least a sentence) is required to conclude a pilot.");
    }
    const outcome = to === "CALIBRATED" ? decision.outcome : "INSUFFICIENT_EVIDENCE";
    if (to === "CALIBRATED" && !["KEEP", "CALIBRATE"].includes(outcome)) {
      throw fail(400, "DECISION_REQUIRED", "A CALIBRATED pilot records KEEP or CALIBRATE as its outcome.");
    }
    if (to === "CALIBRATED") {
      const short = evidenceShortfalls(pilot.evidence);
      if (short.length) {
        throw fail(409, "EVIDENCE_GATE",
          "The evidence does not meet the minimum for a calibration decision. CALIBRATION REQUIRES MORE DATA.",
          { shortfalls: short, minimum: MINIMUM_EVIDENCE });
      }
      // The reviews were of the engines the pilot opened on. If one has moved
      // since, the sample is of two things and a calibration decision cannot
      // be made on it; INSUFFICIENT_EVIDENCE and CLOSED remain open.
      if (pilot.evidence.engineDrift?.length) {
        throw fail(409, "ENGINE_VERSION_CHANGED",
          "An engine version changed during the pilot; the reviews are not all of the same engines. A calibration decision cannot rest on a mixed sample.",
          { drift: pilot.evidence.engineDrift.map((d) => (d.toObject ? d.toObject() : d)) });
      }
    }
    pilot.decision = { outcome, summary: decision.summary.trim(), recordedAt: new Date(), recordedBy: actor };
  }

  if (to === "ACTIVE" && !pilot.startedAt) pilot.startedAt = new Date();
  if (to === "CLOSED") { pilot.endedAt = new Date(); pilot.isOpen = false; }

  pilot.transitions.push({ from: pilot.status, to, by: actor, note });
  pilot.status   = to;
  pilot.version += 1;
  await pilot.save();
  return pilot;
};

// ─────────────────────────────────────────────────────────────────────────────
// FINDINGS
// ─────────────────────────────────────────────────────────────────────────────

const FINDING = {
  CATEGORIES: IntelligencePilot.FINDING_CATEGORIES,
  SEVERITIES: IntelligencePilot.FINDING_SEVERITIES,
  STATUSES:   IntelligencePilot.FINDING_STATUSES,
  DISAGREEMENT_SOURCES: IntelligencePilot.DISAGREEMENT_SOURCES,
};

/** Record a finding on a pilot. The engine version is the pilot's, never the caller's. */
const addFinding = async (pilot, { category, severity, summary, evidence = null, affectedCases = 0, recommendedNextAction = null, disagreementSource = "undetermined", actor }) => {
  if (!FINDING.CATEGORIES.includes(category)) throw fail(400, "INVALID_FINDING", `category must be one of ${FINDING.CATEGORIES.join(", ")}`);
  if (!FINDING.SEVERITIES.includes(severity)) throw fail(400, "INVALID_FINDING", `severity must be one of ${FINDING.SEVERITIES.join(", ")}`);
  if (typeof summary !== "string" || summary.trim().length < 10) throw fail(400, "INVALID_FINDING", "summary is required (at least a short sentence)");
  if (!FINDING.DISAGREEMENT_SOURCES.includes(disagreementSource ?? "undetermined")) throw fail(400, "INVALID_FINDING", `disagreementSource must be one of ${FINDING.DISAGREEMENT_SOURCES.join(", ")}`);
  if (pilot.status === "CLOSED") throw fail(409, "PILOT_CLOSED", "A closed pilot takes no new findings.");
  pilot.findings.push({
    category, severity, summary: summary.trim(), evidence, affectedCases: Math.max(0, Number(affectedCases) || 0),
    engineVersion: pilot.engineVersion, recommendedNextAction, disagreementSource: disagreementSource ?? "undetermined", raisedBy: actor,
  });
  pilot.version += 1;
  await pilot.save();
  return pilot.findings[pilot.findings.length - 1];
};

/**
 * Amend a finding: its status, its next action, or where its disagreement
 * was found to come from. Findings are never deleted. Every amendment is
 * appended to the finding with who, when, what changed and why — the reason
 * is required — and on a closed pilot it is marked as made after closure.
 * This is the one road by which a closed pilot's record changes.
 */
const updateFinding = async (pilot, findingId, { status, recommendedNextAction, disagreementSource, reason, actor }) => {
  const f = pilot.findings.find((x) => x.findingId === findingId);
  if (!f) throw fail(404, "FINDING_NOT_FOUND", "No such finding on this pilot.");
  if (typeof reason !== "string" || reason.trim().length < 5) {
    throw fail(400, "AMENDMENT_REASON_REQUIRED", "An amendment records why. Give a reason (a few words at least).");
  }
  const changes = [];
  if (status !== undefined) {
    if (!FINDING.STATUSES.includes(status)) throw fail(400, "INVALID_FINDING", `status must be one of ${FINDING.STATUSES.join(", ")}`);
    if (f.status !== status) changes.push({ field: "status", from: f.status, to: status });
    f.status = status;
  }
  if (recommendedNextAction !== undefined) {
    const next = recommendedNextAction === null ? null : String(recommendedNextAction).slice(0, 1000);
    if ((f.recommendedNextAction ?? null) !== next) changes.push({ field: "recommendedNextAction", from: f.recommendedNextAction ?? null, to: next });
    f.recommendedNextAction = next;
  }
  if (disagreementSource !== undefined) {
    if (!FINDING.DISAGREEMENT_SOURCES.includes(disagreementSource)) throw fail(400, "INVALID_FINDING", `disagreementSource must be one of ${FINDING.DISAGREEMENT_SOURCES.join(", ")}`);
    if (f.disagreementSource !== disagreementSource) changes.push({ field: "disagreementSource", from: f.disagreementSource, to: disagreementSource });
    f.disagreementSource = disagreementSource;
  }
  if (!changes.length) throw fail(400, "NOTHING_TO_AMEND", "The amendment changes nothing.");
  f.amendments.push({ by: actor, changes, reason: reason.trim(), pilotClosed: pilot.status === "CLOSED" });
  f.updatedAt = new Date();
  f.updatedBy = actor;
  pilot.version += 1;
  await pilot.save();
  return f;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORD, AND THE REPORT
// ─────────────────────────────────────────────────────────────────────────────

/** The record as the application shows it. Nothing on it is secret; this names the shape. */
const publicPilot = (p) => (p ? {
  pilotRunId: String(p._id), schoolId: p.schoolId, classIds: p.classIds ?? null, label: p.label ?? null,
  kind: p.kind, status: p.status, engineVersion: p.engineVersion, engineVersions: plain(p.engineVersions) ?? null,
  engineDrift: engineDriftOf(p),
  startedAt: p.startedAt ?? null, endedAt: p.endedAt ?? null, createdBy: p.createdBy,
  createdAt: p.createdAt, updatedAt: p.updatedAt, version: p.version,
  transitions: (p.transitions ?? []).map((t) => ({ from: t.from ?? null, to: t.to, at: t.at, by: t.by, note: t.note ?? null })),
  // flattenMaps: the two tallies are Mongoose Maps on the document, which
  // JSON.stringify renders as {} — the counts would vanish on the wire.
  evidence: p.evidence ? { ...plain(p.evidence) } : null,
  decision: p.decision ? { ...plain(p.decision) } : null,
  attestations: p.attestations ? { ...plain(p.attestations) } : null,
  advanced: advancedSummaryOf(p),
  findings: (p.findings ?? []).map((f) => plain(f)),
  allowedTransitions: TRANSITIONS[p.status],
  evidenceShortfalls: evidenceShortfalls(p.evidence),
} : null);

/** The brief's outcome words, read off the reviewers' answers. Counts; never a share, never a winner. */
const OUTCOME_OF = Object.freeze({ confirmed: "SUPPORTED", partially_appropriate: "PARTLY_SUPPORTED", rejected: "NOT_SUPPORTED", insufficient_evidence: "INSUFFICIENT_EVIDENCE", uncertain: "UNCERTAIN" });
const CONCERN_OF = Object.freeze({ interpretationDisagreement: "INTERPRETATION_DISAGREEMENT", dataQuality: "DATA_QUALITY", missingEvidence: "MISSING_EVIDENCE", contextualLimitation: "CONTEXTUAL_LIMITATION" });

/** What no pilot of this kind can show, whatever its result (brief §17). */
const NOT_CLAIMED = Object.freeze(["GRADE_IMPROVEMENT", "STUDENT_OUTCOMES", "CAREER_PREDICTION", "RETENTION", "GRADUATION", "WELLBEING", "INTERVENTION_CAUSALITY", "PSYCHOLOGICAL_ASSESSMENT", "UNIVERSAL_VALIDITY"]);

/**
 * The real-world validation report for one pilot: scope, coverage, outcomes,
 * concerns, the explanation layer, the pupils' answers, the findings, the
 * decision, and what the exercise did and did not test. Built from counts
 * over the reviews stamped with the pilot's id; the stored snapshot, where
 * one was taken, is carried beside the live counts so the two can be read
 * together. No case, no pupil, no reviewer, no reviewer's words.
 */
const reportFor = async (pilot) => {
  const window = windowOf(pilot);
  const pkg = await reviewCases.reviewPackage(
    { schoolId: pilot.schoolId, classIds: pilot.classIds && pilot.classIds.length ? pilot.classIds : null },
    { userId: null, role: "school_admin" }, window
  );
  const reviewed = pkg.cases.filter((c) => c.reviewCount > 0);
  const byOutcome = pkg.feedback.totals.byOutcome ?? {};
  const concerns = pkg.feedback.concerns ?? {};
  const advancedNow = advancedSummaryOf(pilot);
  const feedback = await studentFeedbackSummaryFor(pilot);
  const drift = engineDriftOf(pilot);
  const findings = (pilot.findings ?? []).map(plain);
  const countBy = (rows, f) => rows.reduce((acc, r) => { const k = f(r); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const evidenceQualityLimitations = ["missingEvidence", "dataQuality", "contextualLimitation"]
    .flatMap((g) => (concerns[g]?.repeated ?? []).map((r) => ({ group: CONCERN_OF[g], code: r.code, reviews: r.support })));

  const tested = ["INTERPRETATION_SUPPORT", "CONCERN_CATEGORIES", "DATA_QUALITY_CITATIONS", "REVIEWER_INDEPENDENCE", "EVIDENCE_WINDOW", "ENGINE_VERSION_BOUNDARY", "LIVE_OFFLINE_CONSISTENCY"];
  const notTested = ["EDUCATIONAL_EFFECTIVENESS", "CAREER_PREDICTION", "PSYCHOLOGICAL_ASSESSMENT", "INTERVENTION_CAUSALITY", "CROSS_SCHOOL_VALIDITY", "LONG_TERM_OUTCOMES"];
  (advancedNow.requests > 0 ? tested : notTested).push("EXPLANATION_LAYER_BEHAVIOUR");
  (feedback.responses > 0 ? tested : notTested).push("STUDENT_UNDERSTANDING");
  const supports = pilot.status === "CALIBRATED"
    ? [pilot.decision?.outcome === "CALIBRATE" ? "RULE_CHANGE_CANDIDATE_FOR_SEPARATE_PROCESS" : "CURRENT_RULES_FOR_THIS_SCOPE"]
    : pilot.status === "INSUFFICIENT_EVIDENCE" ? ["NO_CALIBRATION_CONCLUSION"] : ["NO_DECISION_YET"];

  return {
    generatedAt: new Date(),
    pilotRunId: String(pilot._id),
    aggregation: "ONE_SCHOOL",
    noRanking: true,
    scope: {
      schoolId: pilot.schoolId, classIds: pilot.classIds ?? null, kind: pilot.kind, label: pilot.label ?? null, status: pilot.status,
      startedAt: pilot.startedAt ?? null, endedAt: pilot.endedAt ?? null, createdAt: pilot.createdAt,
      engineVersion: pilot.engineVersion, engineVersions: plain(pilot.engineVersions) ?? null, engineVersionsMatch: drift.length === 0, engineDrift: drift,
      students: pkg.scope.students, cases: pkg.cases.length, reviewers: pkg.reviewStatus.reviewers,
      attestations: pilot.attestations ? plain(pilot.attestations) : null,
    },
    evidenceCoverage: {
      reviewable: pkg.cases.length,
      reviewed: reviewed.length,
      multiReviewed: pkg.cases.filter((c) => c.reviewCount > 1).length,
      incomplete: pkg.cases.length - reviewed.length,
      studentsReviewed: new Set(reviewed.map((c) => c.studentId)).size,
      reviewsRecorded: pkg.reviewStatus.reviewsRecorded,
      reviewsExcluded: pkg.window.excluded,
      window: { pilotRunId: window.pilotRunId, since: window.since, engineVersion: window.engineVersion },
      byCategory: pkg.reviewStatus.byCategory,
      dataQualityCitations: pkg.feedback.dataQualityCitations ?? {},
      evidenceQualityLimitations,
      minimum: MINIMUM_EVIDENCE,
      shortfalls: evidenceShortfalls({ reviewers: pkg.reviewStatus.reviewers, casesReviewed: reviewed.length, casesWithMultipleReviews: pkg.cases.filter((c) => c.reviewCount > 1).length }),
    },
    reviewOutcomes: Object.fromEntries(Object.entries(OUTCOME_OF).map(([k, v]) => [v, byOutcome[k] ?? 0])),
    concerns: Object.fromEntries(Object.entries(CONCERN_OF).map(([k, v]) => [v, {
      reviews: concerns[k]?.reviews ?? 0,
      examples: (concerns[k]?.repeated ?? []).map((r) => ({ code: r.code, reviews: r.support })),
    }])),
    agreement: pkg.reviewStatus.agreement,
    repeatedDisagreements: pkg.reviewStatus.repeatedDisagreements ?? [],
    patterns: (pkg.feedback.patterns ?? []).map((p) => ({ kind: p.kind, code: p.code ?? null, support: p.support, of: p.of })),
    advancedIntelligence: { ...advancedNow, findings: findings.filter((f) => f.category === "ADVANCED_INTELLIGENCE").length },
    studentFeedback: feedback,
    findings: {
      total: findings.length,
      byCategory: countBy(findings, (f) => f.category), bySeverity: countBy(findings, (f) => f.severity),
      byStatus: countBy(findings, (f) => f.status), byDisagreementSource: countBy(findings, (f) => f.disagreementSource ?? "undetermined"),
      items: findings,
    },
    decision: pilot.decision ? plain(pilot.decision) : null,
    evidenceOnRecord: pilot.evidence ? plain(pilot.evidence) : null,
    limitations: { tested, notTested, evidenceSupports: supports, unknown: ["GENERALISATION_BEYOND_SCOPE", "TEACHER_JUDGEMENT_AS_GROUND_TRUTH", "EFFECT_ON_ANY_OUTCOME"] },
    notClaimed: NOT_CLAIMED,
  };
};

module.exports = {
  STATES,
  KINDS,
  TRANSITIONS,
  MINIMUM_EVIDENCE,
  ATTESTATIONS,
  COLLECTING,
  GROUPS,
  NOT_CLAIMED,
  FEEDBACK,
  currentEngineVersions,
  engineDriftOf,
  canTransition,
  evidenceShortfalls,
  evidenceFor,
  windowOf,
  preflight,
  FINDING,
  addFinding,
  updateFinding,
  openPilot,
  createPilot,
  transition,
  publicPilot,
  reportFor,
  recordAdvancedUse,
  advancedSummaryOf,
  studentFeedbackStatusFor,
  recordStudentFeedback,
  studentFeedbackSummaryFor,
};
