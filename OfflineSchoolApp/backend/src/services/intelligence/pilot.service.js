// backend/src/services/intelligence/pilot.service.js
"use strict";

/**
 * The pilot state machine, and the only writer of a pilot's status.
 *
 * ── What a pilot is for ───────────────────────────────────────────────────
 *
 * To make a real school's validation of the engine a bounded, recorded
 * exercise: one school, a scope, an engine version, dates, a count of what was
 * reviewed, and a written decision at the end. The reviews themselves live on
 * IntelligenceReview; the pilot is the frame that says which of them are
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
 *    regression-covered change. The engine version on the record is the one
 *    the pilot's reviews were of, whatever the engine says later.
 *
 * ── The minimum evidence gate ─────────────────────────────────────────────
 *
 * Derived from minimums that already exist rather than invented here: the
 * feedback tool withholds shares below MIN_CASES_FOR_SHARE reviewed cases and
 * names no pattern below MIN_SUPPORT_FOR_PATTERN; the brief requires at least
 * two independent reviewers. So: ≥ 2 reviewers, ≥ 30 cases reviewed, ≥ 3 cases
 * reviewed by two or more teachers. It is a floor for calling the exercise
 * analysable, not a proof of anything — the decision text has to carry that.
 */

const IntelligencePilot = require("../../db/models/IntelligencePilot");
const User              = require("../../db/models/User");
const Student           = require("../../db/models/Student");
const ResultSummary     = require("../../db/models/ResultSummary");
const TeacherAssignment = require("../../db/models/TeacherAssignment");
const reviewCases       = require("./reviewCases.service");
const { ENGINE_VERSION } = require("../../../../shared/intelligence");
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

const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/** Which parts of the gate an evidence snapshot fails. Empty means it passes. */
const evidenceShortfalls = (evidence) => Object.entries(MINIMUM_EVIDENCE)
  .filter(([k, min]) => (evidence?.[k] ?? 0) < min)
  .map(([k, min]) => ({ requirement: k, minimum: min, actual: evidence?.[k] ?? 0 }));

const fail = (status, code, message, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The counts a decision is made on, from the persisted reviews in the pilot's
 * scope. Read as an administrator — the snapshot is the school's, not a
 * reviewer's — and reduced to numbers and code lists before it is stored.
 */
const evidenceFor = async ({ schoolId, classIds }) => {
  const pkg = await reviewCases.reviewPackage(
    { schoolId, classIds: classIds && classIds.length ? classIds : null },
    { userId: null, role: "school_admin" }
  );
  const reviewed = pkg.cases.filter((c) => c.reviewCount > 0);
  const codes = new Set(reviewed.flatMap((c) => c.classifications.map((k) => k.code)));
  return {
    takenAt:                  new Date(),
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

// ─────────────────────────────────────────────────────────────────────────────
// PREFLIGHT — may a REAL pilot start here?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every precondition in docs/25 §13 that a query can answer, answered; the two
 * that only a person can answer, named for signature. A real pilot cannot be
 * opened while any check fails — createPilot enforces it — so "we started
 * anyway" is not a state the record can be in.
 *
 * Three kinds of check:
 *   automatic  computed here, now, for this school and scope
 *   suite      a property held by a check script, named, not re-run per request
 *   manual     attested by the person opening the pilot
 */
const preflight = async ({ schoolId, classIds = null }) => {
  const scope = { schoolId, classIds: classIds && classIds.length ? classIds : null };
  const pkg = await reviewCases.reviewPackage(scope, { userId: null, role: "school_admin" });

  const studentFilter = { schoolId, status: "approved", deletedAt: null, ...(scope.classIds ? { classId: { $in: scope.classIds } } : {}) };
  const students = await Student.find(studentFilter).select("_id classId").lean();
  const studentIds = students.map((s) => String(s._id));
  const classesInScope = [...new Set(students.map((s) => String(s.classId)).filter(Boolean))];

  const [admins, assignments, published] = await Promise.all([
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
  const checks = [
    { key: "schoolAdminPresent",      kind: "automatic", ok: admins >= 1,           detail: `${admins} active school administrator(s)` },
    { key: "reviewersAvailable",      kind: "automatic", ok: reviewers >= MINIMUM_EVIDENCE.reviewers, detail: `${reviewers} teacher(s) hold an active assignment in scope (need ${MINIMUM_EVIDENCE.reviewers})` },
    { key: "publishedEvidence",       kind: "automatic", ok: published > 0 && pkg.scope.students > 0, detail: `${published} published result(s) for ${pkg.scope.students} pupil(s)` },
    { key: "reviewableCases",         kind: "automatic", ok: pkg.cases.length >= MINIMUM_EVIDENCE.casesReviewed, detail: `${pkg.cases.length} case(s) on the sheet (need ${MINIMUM_EVIDENCE.casesReviewed})` },
    { key: "multiReviewCapableCases", kind: "automatic", ok: multiReviewCapable >= MINIMUM_EVIDENCE.casesWithMultipleReviews, detail: `${multiReviewCapable} case(s) in classes with two or more assigned teachers (need ${MINIMUM_EVIDENCE.casesWithMultipleReviews})` },
    { key: "engineInputNameFree",     kind: "automatic", ok: cohortProblems.length === 0, detail: cohortProblems.length ? cohortProblems.slice(0, 3).join("; ") : "the engine input carries no identity field" },
    { key: "consistencyOperational",  kind: "automatic", ok: sample.length > 0 && mismatches.length === 0, detail: `${consistency.length} pupil(s) checked, ${mismatches.length} mismatch(es)` },
    { key: "saltNotExposed",          kind: "automatic", ok: !salt || !JSON.stringify(pkg).includes(salt), detail: "the review package carries no salt" },
    { key: "teacherScopeEnforced",    kind: "suite", ok: true, detail: "check-intelligence-access.js §1, check-review-workflow.js §5" },
    { key: "schoolAdminScopeEnforced", kind: "suite", ok: true, detail: "check-intelligence-access.js §2" },
    { key: "operatorSelectionRequired", kind: "suite", ok: true, detail: "check-intelligence-access.js §3, check-pilot-readiness.js §2" },
    { key: "rawExportNotExposed",     kind: "suite", ok: true, detail: "check-intelligence-access.js §6 — no export, download or raw cohort on any route" },
    { key: "schoolParticipates",      kind: "manual", ok: null, detail: "the school knows it is taking part and has agreed" },
    { key: "reviewersUnderstandTask", kind: "manual", ok: null, detail: "each reviewer has read the briefing and knows the task" },
  ];
  const blockers = checks.filter((c) => c.ok === false).map((c) => `${c.key}: ${c.detail}`);
  return {
    schoolId, classIds: scope.classIds,
    ready: blockers.length === 0,
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
 * Open a pilot at a school. One at a time per school; the engine version is
 * the server's, never the request's.
 */
const createPilot = async ({ schoolId, classIds = null, kind, label = null, actor, attestations = null }) => {
  if (!KINDS.includes(kind)) throw fail(400, "INVALID_PILOT_KIND", `kind must be one of ${KINDS.join(", ")}`);
  if (await openPilot(schoolId)) throw fail(409, "PILOT_OPEN", "This school already has an open pilot. Close it first.");

  // A REAL pilot starts only when every automatic precondition holds and the
  // two manual ones are signed. Development and synthetic pilots are for
  // trying the workflow and are not gated.
  let signed = null;
  if (kind === "real") {
    const pre = await preflight({ schoolId, classIds });
    if (!pre.ready) {
      throw fail(409, "REAL_PILOT_BLOCKED", `REAL PILOT BLOCKED — ${pre.blockers[0]}`, { blockers: pre.blockers, checks: pre.checks });
    }
    const a = attestations ?? {};
    if (a.schoolParticipates !== true || a.reviewersUnderstandTask !== true) {
      throw fail(409, "ATTESTATION_REQUIRED",
        "REAL PILOT BLOCKED — the school's participation and the reviewers' understanding of the task must be attested.",
        { blockers: ["schoolParticipates and reviewersUnderstandTask must both be attested"] });
    }
    signed = { schoolParticipates: true, reviewersUnderstandTask: true, by: actor, at: new Date() };
  }
  return IntelligencePilot.create({
    attestations: signed,
    schoolId,
    classIds: Array.isArray(classIds) && classIds.length ? classIds.map(String) : null,
    kind,
    label,
    engineVersion: ENGINE_VERSION,
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

  // Entering analysis, or deciding, takes a fresh snapshot of the evidence.
  if (["ANALYSIS_READY", "CALIBRATED", "INSUFFICIENT_EVIDENCE"].includes(to)) {
    const evidence = await evidenceFor({ schoolId: pilot.schoolId, classIds: pilot.classIds });
    if (to === "ANALYSIS_READY" && evidence.reviewsRecorded === 0) {
      throw fail(409, "EVIDENCE_REQUIRED", "No reviews have been recorded in this pilot's scope; there is nothing to analyse.");
    }
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
};

/** Record a finding on a pilot. The engine version is the pilot's, never the caller's. */
const addFinding = async (pilot, { category, severity, summary, evidence = null, affectedCases = 0, recommendedNextAction = null, actor }) => {
  if (!FINDING.CATEGORIES.includes(category)) throw fail(400, "INVALID_FINDING", `category must be one of ${FINDING.CATEGORIES.join(", ")}`);
  if (!FINDING.SEVERITIES.includes(severity)) throw fail(400, "INVALID_FINDING", `severity must be one of ${FINDING.SEVERITIES.join(", ")}`);
  if (typeof summary !== "string" || summary.trim().length < 10) throw fail(400, "INVALID_FINDING", "summary is required (at least a short sentence)");
  if (pilot.status === "CLOSED") throw fail(409, "PILOT_CLOSED", "A closed pilot takes no new findings.");
  pilot.findings.push({
    category, severity, summary: summary.trim(), evidence, affectedCases: Math.max(0, Number(affectedCases) || 0),
    engineVersion: pilot.engineVersion, recommendedNextAction, raisedBy: actor,
  });
  pilot.version += 1;
  await pilot.save();
  return pilot.findings[pilot.findings.length - 1];
};

/** Move a finding's status, or amend its next action. Findings are never deleted. */
const updateFinding = async (pilot, findingId, { status, recommendedNextAction, actor }) => {
  const f = pilot.findings.find((x) => x.findingId === findingId);
  if (!f) throw fail(404, "FINDING_NOT_FOUND", "No such finding on this pilot.");
  if (status !== undefined) {
    if (!FINDING.STATUSES.includes(status)) throw fail(400, "INVALID_FINDING", `status must be one of ${FINDING.STATUSES.join(", ")}`);
    f.status = status;
  }
  if (recommendedNextAction !== undefined) f.recommendedNextAction = recommendedNextAction;
  f.updatedAt = new Date();
  void actor;
  pilot.version += 1;
  await pilot.save();
  return f;
};

/** The record as the application shows it. Nothing on it is secret; this names the shape. */
const publicPilot = (p) => (p ? {
  pilotRunId: String(p._id), schoolId: p.schoolId, classIds: p.classIds ?? null, label: p.label ?? null,
  kind: p.kind, status: p.status, engineVersion: p.engineVersion,
  startedAt: p.startedAt ?? null, endedAt: p.endedAt ?? null, createdBy: p.createdBy,
  createdAt: p.createdAt, updatedAt: p.updatedAt, version: p.version,
  transitions: (p.transitions ?? []).map((t) => ({ from: t.from ?? null, to: t.to, at: t.at, by: t.by, note: t.note ?? null })),
  // flattenMaps: the two tallies are Mongoose Maps on the document, which
  // JSON.stringify renders as {} — the counts would vanish on the wire.
  evidence: p.evidence ? { ...(p.evidence.toObject ? p.evidence.toObject({ flattenMaps: true }) : p.evidence) } : null,
  decision: p.decision ? { ...(p.decision.toObject ? p.decision.toObject() : p.decision) } : null,
  attestations: p.attestations ? { ...(p.attestations.toObject ? p.attestations.toObject() : p.attestations) } : null,
  findings: (p.findings ?? []).map((f) => (f.toObject ? f.toObject() : f)),
  allowedTransitions: TRANSITIONS[p.status],
  evidenceShortfalls: evidenceShortfalls(p.evidence),
} : null);

module.exports = {
  STATES,
  KINDS,
  TRANSITIONS,
  MINIMUM_EVIDENCE,
  canTransition,
  evidenceShortfalls,
  evidenceFor,
  preflight,
  FINDING,
  addFinding,
  updateFinding,
  openPilot,
  createPilot,
  transition,
  publicPilot,
};
