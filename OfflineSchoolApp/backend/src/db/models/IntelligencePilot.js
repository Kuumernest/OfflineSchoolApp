// backend/src/db/models/IntelligencePilot.js
"use strict";

/**
 * One controlled validation exercise of the intelligence engine, at one school.
 *
 * ── Why a record at all ───────────────────────────────────────────────────
 *
 * Reviews accumulate; a pilot is the frame around them — which school, which
 * classes, under which engine version, from when to when, how far it has got
 * and what was decided at the end. Without the frame, a report cannot tell a
 * developer's test run from a real school's validation, and the calibration
 * protocol in docs/25 §6 needs exactly that distinction to mean anything.
 *
 * ── The three kinds ───────────────────────────────────────────────────────
 *
 *   synthetic    fixtures; validates the tooling, never a threshold
 *   development  a developer or tester driving the workflow; same
 *   real         an authorised school and its own teachers; the only kind
 *                whose reviews count as calibration evidence
 *
 * The kind is set at creation and never changes. A report that aggregates
 * reviews must say which kind of pilot they came from.
 *
 * ── States ────────────────────────────────────────────────────────────────
 *
 *   READY → ACTIVE → REVIEWING → ANALYSIS_READY → CALIBRATED
 *                                              → INSUFFICIENT_EVIDENCE
 *   any of the above → CLOSED; CLOSED is terminal.
 *
 * CALIBRATED is not "teachers submitted reviews". It requires the evidence
 * snapshot to meet the minimum gate AND a written decision, both enforced in
 * services/intelligence/pilot.service.js, which is the only writer of `status`.
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 *
 * The calibration salt, any credential, any export, any pupil row, any mark,
 * any reviewer's answer. The evidence snapshot is counts and code lists; the
 * scope is the tenancy key and class ids the application already puts in every
 * URL. scripts/check-pilot-readiness.js asserts the record carries none of the
 * rest.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const KINDS  = ["synthetic", "development", "real"];
const STATES = ["READY", "ACTIVE", "REVIEWING", "ANALYSIS_READY", "CALIBRATED", "INSUFFICIENT_EVIDENCE", "CLOSED"];
const DECISION_OUTCOMES = ["KEEP", "CALIBRATE", "INSUFFICIENT_EVIDENCE"];
const FINDING_CATEGORIES = ["ENGINE", "DATA_QUALITY", "MAPPING", "AUTHORIZATION", "UX", "MISSING_EVIDENCE",
                            "GUIDANCE", "REVIEW_WORKFLOW", "OFFLINE_CONSISTENCY"];
const FINDING_SEVERITIES = ["low", "medium", "high"];
const FINDING_STATUSES   = ["open", "investigating", "confirmed", "resolved", "not_reproduced"];

/**
 * A structured finding from a pilot. Severity says how much of the exercise it
 * touches; it never says that anything about a child has been established.
 * The engine is not changed because a finding exists — a finding goes to the
 * post-pilot decision in docs/25 §6 and §14.
 */
const findingSchema = new mongoose.Schema(
  {
    findingId:     { type: String, default: uuidv4 },
    category:      { type: String, enum: FINDING_CATEGORIES, required: true },
    severity:      { type: String, enum: FINDING_SEVERITIES, required: true },
    summary:       { type: String, required: true, maxlength: 500 },
    evidence:      { type: String, default: null, maxlength: 4000 },
    affectedCases: { type: Number, default: 0 },
    engineVersion: { type: String, required: true },
    status:        { type: String, enum: FINDING_STATUSES, default: "open" },
    recommendedNextAction: { type: String, default: null, maxlength: 1000 },
    raisedBy:  { type: String, required: true },
    raisedAt:  { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const transitionSchema = new mongoose.Schema(
  {
    from: { type: String, enum: [...STATES, null], default: null },
    to:   { type: String, enum: STATES, required: true },
    at:   { type: Date, default: Date.now },
    by:   { type: String, required: true },
    note: { type: String, default: null, maxlength: 2000 },
  },
  { _id: false }
);

/** Counts and code lists only. Taken by the server at the moment of a transition. */
const evidenceSchema = new mongoose.Schema(
  {
    takenAt:                  { type: Date, default: Date.now },
    casesSelected:            { type: Number, default: 0 },
    casesReviewed:            { type: Number, default: 0 },
    casesAwaitingReview:      { type: Number, default: 0 },
    casesWithMultipleReviews: { type: Number, default: 0 },
    studentsReviewed:         { type: Number, default: 0 },
    reviewsRecorded:          { type: Number, default: 0 },
    reviewers:                { type: Number, default: 0 },
    categories:               { type: [String], default: [] },
    subjects:                 { type: [String], default: [] },
    temporalPatterns:         { type: [String], default: [] },
    repeatedDisagreements:    { type: [String], default: [] },
    dataQualityCitations:     { type: Map, of: Number, default: {} },
    byOutcome:                { type: Map, of: Number, default: {} },
  },
  { _id: false }
);

const decisionSchema = new mongoose.Schema(
  {
    outcome:    { type: String, enum: DECISION_OUTCOMES, required: true },
    summary:    { type: String, required: true, maxlength: 4000 },
    recordedAt: { type: Date, default: Date.now },
    recordedBy: { type: String, required: true },
  },
  { _id: false }
);

const intelligencePilotSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Scope: one school, optionally some of its classes ──────────────────
    schoolId: { type: String, required: true, index: true },
    classIds: { type: [String], default: null },
    label:    { type: String, default: null, maxlength: 120 },

    kind:   { type: String, enum: KINDS, required: true },
    status: { type: String, enum: STATES, default: "READY", index: true },
    // Mirrors status !== CLOSED, because a partial index may test equality but
    // not inequality. Maintained by pilot.service alongside status.
    isOpen: { type: Boolean, default: true },

    // The engine the pilot's reviews are of. Stamped by the server at creation.
    engineVersion: { type: String, required: true, maxlength: 20 },

    startedAt: { type: Date, default: null },
    endedAt:   { type: Date, default: null },
    createdBy: { type: String, required: true },

    transitions: { type: [transitionSchema], default: [] },
    findings:    { type: [findingSchema], default: [] },

    // The two preconditions no query can verify, signed by whoever opened a
    // REAL pilot: that the school knows it is participating, and that the
    // reviewers understand the task.
    attestations: {
      type: new mongoose.Schema({
        schoolParticipates:      { type: Boolean, default: false },
        reviewersUnderstandTask: { type: Boolean, default: false },
        by: { type: String, default: null },
        at: { type: Date, default: null },
      }, { _id: false }),
      default: null,
    },
    evidence:    { type: evidenceSchema, default: null },
    decision:    { type: decisionSchema, default: null },

    version:   { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

// One open pilot per school. A second exercise waits for the first to close,
// so that "the school's pilot" is never ambiguous in a report.
intelligencePilotSchema.index(
  { schoolId: 1, isOpen: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: "one_open_pilot_per_school" }
);

const IntelligencePilot =
  mongoose.models.IntelligencePilot ||
  mongoose.model("IntelligencePilot", intelligencePilotSchema);

IntelligencePilot.KINDS  = KINDS;
IntelligencePilot.STATES = STATES;
IntelligencePilot.DECISION_OUTCOMES = DECISION_OUTCOMES;
IntelligencePilot.FINDING_CATEGORIES = FINDING_CATEGORIES;
IntelligencePilot.FINDING_SEVERITIES = FINDING_SEVERITIES;
IntelligencePilot.FINDING_STATUSES   = FINDING_STATUSES;

module.exports = IntelligencePilot;
