// backend/src/db/models/IntelligenceAnalysisRun.js
"use strict";

/**
 * One cold run of the school-wide calibration analysis (docs/38).
 *
 * The analysis behind the review queue, the calibration summary and the
 * pilot's evidence runs the academic engine some forty times over every
 * published result in scope (docs/37 §7). At a few thousand pupils that is
 * most of a minute of CPU and hundreds of megabytes, so it does not run on a
 * request: a run is recorded here, executed in a worker thread, and its
 * report kept here for every later request over the same evidence.
 *
 * ── What a run is keyed by ────────────────────────────────────────────────
 *
 * A school, a scope (the whole school, or a sorted set of classes) and a
 * FINGERPRINT of the evidence in that scope: every row the analysis would
 * read, by id and last write, plus the engine and analysis code. A report is
 * served only under the fingerprint the evidence has now; a mark changed,
 * published, deleted, or a pupil moved changes the fingerprint and the old
 * report is simply never matched again.
 *
 * ── What it holds, and what it does not ───────────────────────────────────
 *
 * The report is the analysis output with the per-pupil profiles dropped,
 * gzip-compressed. The analysis never sees a name: its input is ids, marks
 * and subject names (scripts/calibration/cohortSchema.cohortFromDocuments),
 * and names are joined per viewer, after authorisation, in
 * reviewCases.service. No question, no review text, no reviewer, no name is
 * stored here. A failure keeps a code and a fixed message, never a stack or
 * a row.
 *
 * ── One active run per key, across processes ──────────────────────────────
 *
 * `activeKey` is set while a run is queued or running and cleared when it
 * ends. The unique partial index below is what stops two processes (or two
 * requests racing in one) from starting the same analysis twice; a run whose
 * owner died is recognised by its expired lease and failed as INTERRUPTED,
 * which clears the key. src/server.js ensures the index at boot, because
 * autoIndex is off in production.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const STATUSES = Object.freeze(["queued", "running", "succeeded", "failed", "superseded"]);
const ACTIVE_STATUSES = Object.freeze(["queued", "running"]);
const STAGES = Object.freeze(["queued", "loading", "analysing", "storing", "done"]);
const ERROR_CODES = Object.freeze([
  "WORKER_OUT_OF_MEMORY", // the worker hit its heap cap; the server did not
  "TIMEOUT",              // the worker ran past ANALYSIS_TIMEOUT_MS and was terminated
  "ENGINE_ERROR",         // the analysis threw
  "WORKER_EXITED",        // the worker stopped without a result
  "LOAD_ERROR",           // the evidence could not be read
  "STORE_ERROR",          // the report could not be saved
  "REPORT_TOO_LARGE",     // the compressed report exceeded ANALYSIS_REPORT_MAX_BYTES
  "INTERRUPTED",          // the process holding the run stopped (lease expired)
]);
const TRIGGERS = Object.freeze(["request", "explicit", "retry"]);

const errorSchema = new mongoose.Schema(
  {
    code:      { type: String, enum: ERROR_CODES, required: true },
    // A fixed sentence per code. Never err.message from the engine or the
    // database: either can quote a value from a row.
    message:   { type: String, maxlength: 300, default: null },
    retryable: { type: Boolean, default: true },
  },
  { _id: false }
);

const intelligenceAnalysisRunSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Scope ───────────────────────────────────────────────────────────────
    schoolId: { type: String, required: true },
    // "school", or "classes:<sha1 of the sorted class ids>".
    scopeKey: { type: String, required: true, maxlength: 80 },
    classIds: { type: [String], default: null },

    // ── What it is of ───────────────────────────────────────────────────────
    fingerprint:   { type: String, required: true, maxlength: 80 },
    engineVersion: { type: String, required: true, maxlength: 20 },
    // The analysis code the fingerprint covered (engine + calibration
    // scripts), so a deploy that changes either is never served an old report.
    codeDigest:    { type: String, required: true, maxlength: 80 },

    // ── Lifecycle ───────────────────────────────────────────────────────────
    status: { type: String, enum: STATUSES, default: "queued" },
    stage:  { type: String, enum: STAGES, default: "queued" },
    // `${schoolId}|${scopeKey}|${fingerprint}` while queued or running; null
    // otherwise. Unique while set: see the index below.
    activeKey: { type: String, default: null },
    // 1 for the first run of a (scope, fingerprint), +1 for each later one.
    attempt: { type: Number, default: 1 },
    trigger: { type: String, enum: TRIGGERS, default: "request" },

    requestedBy:     { type: String, default: null },
    requestedByRole: { type: String, default: null },

    // The process that holds the run, and until when. Renewed while it works;
    // a lease in the past means nobody is working on it.
    owner:      { type: String, default: null },
    leaseUntil: { type: Date, default: null },

    queuedAt:   { type: Date, default: Date.now },
    startedAt:  { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    // Counts only.
    counts: {
      type: new mongoose.Schema({
        students: { type: Number, default: 0 },
        results:  { type: Number, default: 0 },
        exams:    { type: Number, default: 0 },
        cases:    { type: Number, default: 0 },
      }, { _id: false }),
      default: null,
    },

    error: { type: errorSchema, default: null },

    // ── The report ──────────────────────────────────────────────────────────
    // gzip(JSON(report without profiles)). select:false: listing runs must
    // never drag megabytes of report along.
    report:         { type: Buffer, default: null, select: false },
    reportBytes:    { type: Number, default: null },  // compressed
    reportRawBytes: { type: Number, default: null },  // JSON before compression
    // sha256 of the compressed bytes, checked on every read.
    reportDigest:   { type: String, default: null },
    // Set when a newer report for the same scope replaced this one and the
    // bytes were released; the run itself stays as a record.
    reportPrunedAt: { type: Date, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

// One active run per (school, scope, fingerprint), across every process.
intelligenceAnalysisRunSchema.index(
  { activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: { $type: "string" } }, name: "one_active_analysis_per_key" }
);
// The lookup every request makes: the newest run of a scope over this evidence.
intelligenceAnalysisRunSchema.index({ schoolId: 1, scopeKey: 1, fingerprint: 1, createdAt: -1 });
// Status pages and pruning: a scope's runs, newest first.
intelligenceAnalysisRunSchema.index({ schoolId: 1, scopeKey: 1, createdAt: -1 });
// Recovery: active runs whose lease has run out.
intelligenceAnalysisRunSchema.index({ status: 1, leaseUntil: 1 });

const IntelligenceAnalysisRun =
  mongoose.models.IntelligenceAnalysisRun ||
  mongoose.model("IntelligenceAnalysisRun", intelligenceAnalysisRunSchema);

IntelligenceAnalysisRun.STATUSES = STATUSES;
IntelligenceAnalysisRun.ACTIVE_STATUSES = ACTIVE_STATUSES;
IntelligenceAnalysisRun.STAGES = STAGES;
IntelligenceAnalysisRun.ERROR_CODES = ERROR_CODES;
IntelligenceAnalysisRun.TRIGGERS = TRIGGERS;

module.exports = IntelligenceAnalysisRun;
