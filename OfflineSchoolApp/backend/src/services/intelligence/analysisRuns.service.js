// backend/src/services/intelligence/analysisRuns.service.js
"use strict";

/**
 * Cold school-wide analysis, off the request thread (docs/38).
 *
 * ── The problem (docs/37 §7, §15 P1/P2) ───────────────────────────────────
 *
 * The review queue, the calibration summary and the pilot's evidence all rest
 * on one analysis of the scope's whole cohort: the academic engine, then a
 * sensitivity sweep that runs it again some forty times. At 5,000 pupils a
 * cold run held the event loop for most of a minute and grew the heap by
 * hundreds of megabytes; two at once could take the process down. And even a
 * cache hit loaded, serialised and hashed the whole cohort to find its key.
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 *   fingerprint   a cheap digest of the scope's evidence: every row the
 *                 analysis reads, by id and last write (plus class for a
 *                 pupil), and the engine and analysis code. No marks are read.
 *   run           a persisted IntelligenceAnalysisRun per (school, scope,
 *                 fingerprint), executed in a worker thread with a capped
 *                 heap and a timeout, its report stored gzip-compressed.
 *   serve         a report only under the fingerprint the evidence has NOW.
 *                 There is no "nearly current": a changed mark is a new
 *                 fingerprint and a new run.
 *
 * A request that finds no current report starts (or joins) the run and waits
 * a bounded time (8 s). If the run has not finished it gets AnalysisNotReady
 * with the run's id; the run carries on without it, and the next request over
 * the same evidence is served from the store.
 *
 * ── Duplicates, crashes, retries ──────────────────────────────────────────
 *
 * In one process, every request for the same key shares one promise. Across
 * processes, the unique partial index on `activeKey` admits one queued-or-
 * running run per key; the loser of the insert race waits on the winner's
 * record. Every active run carries a lease its owner renews; a run whose
 * lease has expired belongs to a process that stopped, and the next request
 * (or the boot sweep) fails it as INTERRUPTED, which frees the key. A failed
 * run is retried automatically once more after a back-off; after that only an
 * explicit retry starts it again, because a failure that repeats on the same
 * evidence is not going to stop repeating on its own.
 *
 * ── What this does NOT decide ─────────────────────────────────────────────
 *
 * Who may ask. Every caller has already resolved the school and the classes
 * from the caller's own role and assignments (insights.routes reviewScope,
 * pilot.service); this module takes that scope as given and never widens it.
 * Nor does it change a judgement: the worker runs the same analyse() the
 * request thread ran, on the same mapping, and the report it stores is that
 * report minus the per-pupil profiles nothing read.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { promisify } = require("util");
const { Worker } = require("worker_threads");

const IntelligenceAnalysisRun = require("../../db/models/IntelligenceAnalysisRun");
const Student           = require("../../db/models/Student");
const Exam              = require("../../db/models/Exam");
const ResultSummary     = require("../../db/models/ResultSummary");
const GradingConfig     = require("../../db/models/GradingConfig");
const AcademicStructure = require("../../db/models/AcademicStructure");
const Intervention      = require("../../db/models/Intervention");

const ROOT   = path.join(__dirname, "..", "..", "..");
const SHARED = path.join(ROOT, "..", "shared");
const CAL    = path.join(ROOT, "scripts", "calibration");
// require.resolve, not a joined path: it fails at load if the file is missing,
// and scripts/check-orphans.js can see the worker is reachable.
const WORKER_FILE = require.resolve("./analysisWorker");

const { ENGINE_VERSION } = require(path.join(SHARED, "intelligence"));

const gunzip = promisify(zlib.gunzip);

/** The same provenance reviewCases.liveCohort stamps, so the report is the same bytes either way. */
const PROVENANCE = Object.freeze({ kind: "live", note: "Computed in-app over live documents for an authorised caller." });

/**
 * A positive whole number from the environment, or the default. Read once,
 * when the module loads. Fractions are floored: a concurrency of "1.5" would
 * otherwise let two analyses run while reading as one. Anything that is not a
 * number of at least 1 after flooring (unset, "abc", "0", "-1", "0.5") is the
 * default.
 */
const envInteger = (name, fallback) => {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

const DEFAULTS = Object.freeze({
  /** How long a request waits for a run before answering ANALYSIS_PENDING. */
  waitMs:         8_000,
  /** How long a worker may run before it is terminated. */
  timeoutMs:      envInteger("ANALYSIS_TIMEOUT_MS", 10 * 60_000),
  /** The worker's old-generation heap cap. Exceeding it ends the worker, not the server. */
  heapMb:         envInteger("ANALYSIS_WORKER_HEAP_MB", 2048),
  /** Analyses one process runs at once. Each is CPU-bound and memory-heavy. */
  concurrency:    envInteger("ANALYSIS_CONCURRENCY", 1),
  /** The largest compressed report kept (MongoDB's own document limit is 16 MiB). */
  maxReportBytes: envInteger("ANALYSIS_REPORT_MAX_BYTES", 12 * 1024 * 1024),
  leaseMs:        60_000,
  heartbeatMs:    15_000,
  /** How often a request polls a run another process holds. */
  pollMs:         250,
  /** Failed runs of one (scope, fingerprint) retried without anyone asking. */
  maxAutoAttempts: 2,
  /** Wait before an automatic retry, doubled per attempt, capped at 30 min. */
  retryBackoffMs: 60_000,
  /** Parsed reports kept in memory, and for how long. */
  cacheMax:       4,
  cacheTtlMs:     120_000,
  /** Test-only: a failure mode handed to the worker. Never set in production. */
  fault:          null,
});

/** Fixed sentences per failure code. Never an error's own text. */
const ERROR_MESSAGES = Object.freeze({
  WORKER_OUT_OF_MEMORY: "The analysis needed more memory than its worker is allowed (ANALYSIS_WORKER_HEAP_MB).",
  TIMEOUT:              "The analysis ran longer than its time limit (ANALYSIS_TIMEOUT_MS) and was stopped.",
  ENGINE_ERROR:         "The analysis stopped with an error.",
  WORKER_EXITED:        "The analysis worker stopped without a result.",
  LOAD_ERROR:           "The evidence for the analysis could not be read.",
  STORE_ERROR:          "The analysis report could not be saved.",
  REPORT_TOO_LARGE:     "The analysis report is larger than the configured limit (ANALYSIS_REPORT_MAX_BYTES).",
  INTERRUPTED:          "The server holding the analysis stopped before it finished.",
});
/** A failure that the same evidence will reproduce gains nothing from an automatic retry. */
const NOT_RETRYABLE = new Set(["REPORT_TOO_LARGE"]);

// ─────────────────────────────────────────────────────────────────────────────
// THE ERROR A CALLER SEES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No current report could be produced within the wait.
 *
 * code    ANALYSIS_PENDING  the run is queued or running; ask again later
 *         ANALYSIS_FAILED   the run failed; see run.error
 * status  the HTTP status a WRITE answers with (409: nothing was changed).
 *         A read answers 202 for PENDING; see insights.routes.
 *
 * Only these enumerable fields exist on it, because pilot routes spread an
 * error's own fields into the response body.
 */
class AnalysisNotReady extends Error {
  constructor(code, run) {
    super(code === "ANALYSIS_PENDING"
      ? "The school analysis is still being prepared. Try again in a moment."
      : "The school analysis could not be completed.");
    this.code = code;
    this.status = code === "ANALYSIS_PENDING" ? 409 : 503;
    this.run = run;
    this.retryAfterSeconds = code === "ANALYSIS_PENDING" ? 5 : null;
  }
}
// On the prototype, so it is not an own enumerable field of the error.
AnalysisNotReady.prototype.name = "AnalysisNotReady";

// ─────────────────────────────────────────────────────────────────────────────
// KEYS
// ─────────────────────────────────────────────────────────────────────────────

const sha = (algo, s) => crypto.createHash(algo).update(s).digest("hex");

/** "school", or the sorted class set. Two callers with the same classes share a key. */
const scopeKeyOf = ({ classIds }) => {
  if (!classIds) return "school";
  const sorted = [...new Set(classIds.map(String))].sort();
  return `classes:${sha("sha1", sorted.join(","))}`;
};

const activeKeyOf = (schoolId, scopeKey, fingerprint) => `${schoolId}|${scopeKey}|${fingerprint}`;

/**
 * The analysis code a report depends on: the engine and the calibration
 * scripts, by content. A deploy that changes either changes every fingerprint,
 * so a report from older code is never served — whether or not anybody
 * remembered to move a version number.
 */
let codeDigestMemo = null;
const codeDigest = () => {
  if (codeDigestMemo) return codeDigestMemo;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(path.join(SHARED, "intelligence"));
  for (const f of ["analyseCohort.js", "cohortSchema.js", "isolatedEngine.js"]) files.push(path.join(CAL, f));
  files.push(WORKER_FILE);
  const h = crypto.createHash("sha256");
  for (const f of files.sort()) h.update(path.relative(ROOT, f)).update("\0").update(fs.readFileSync(f)).update("\0");
  codeDigestMemo = h.digest("hex");
  return codeDigestMemo;
};

/** The pupils in scope: the filter reviewCases.liveCohort uses, kept identical. */
const studentFilterOf = ({ schoolId, classIds }) => {
  const f = { schoolId, status: "approved", deletedAt: null };
  if (classIds) f.classId = { $in: classIds };
  return f;
};

const stamp = (d) => (d ? new Date(d).getTime() : "-");

/**
 * The evidence fingerprint for a scope.
 *
 * Every collection the analysis reads, by the same filters the load uses, as
 * (id, updatedAt) — plus the class for a pupil, so a move between classes
 * changes it even where updatedAt could not be trusted. A row added, edited,
 * published, soft-deleted or hard-deleted changes the set or a stamp, so it
 * changes the digest. Projections only: no marks, no names.
 *
 * Every write path to these collections goes through Mongoose with
 * timestamps on (create, save, updateOne/Many, findOneAndUpdate, bulkWrite);
 * none passes timestamps:false and none writes through the raw driver
 * (verified in docs/38 §4, and asserted for bulkWrite in
 * check-analysis-runs.js). Two writes to one row inside the same millisecond
 * are the residual blind spot, recorded there.
 */
const fingerprintOf = async (scope) => {
  const { schoolId } = scope;
  const students = await Student.find(studentFilterOf(scope)).select("_id classId updatedAt").lean();
  const ids = students.map((s) => String(s._id));
  const [exams, summaries, grading, structure, interventions] = await Promise.all([
    Exam.find({ schoolId, deletedAt: null }).select("_id updatedAt").lean(),
    ids.length ? ResultSummary.find({ schoolId, deletedAt: null, studentId: { $in: ids } }).select("_id updatedAt").lean() : [],
    GradingConfig.findOne({ schoolId }).select("_id updatedAt").lean(),
    AcademicStructure.findOne({ schoolId, deletedAt: null }).sort({ academicYear: -1 }).select("_id updatedAt").lean(),
    ids.length ? Intervention.find({ schoolId, deletedAt: null, studentId: { $in: ids } }).select("_id updatedAt").lean() : [],
  ]);
  const h = crypto.createHash("sha256");
  h.update(`v1|${ENGINE_VERSION}|${codeDigest()}|${schoolId}|${scopeKeyOf(scope)}\n`);
  const section = (tag, rows, line) => {
    h.update(`#${tag}:${rows.length}\n`);
    for (const l of rows.map(line).sort()) h.update(l).update("\n");
  };
  section("students", students, (s) => `${s._id}|${s.classId ?? "-"}|${stamp(s.updatedAt)}`);
  section("exams", exams, (e) => `${e._id}|${stamp(e.updatedAt)}`);
  section("results", summaries, (r) => `${r._id}|${stamp(r.updatedAt)}`);
  section("grading", grading ? [grading] : [], (g) => `${g._id}|${stamp(g.updatedAt)}`);
  section("structure", structure ? [structure] : [], (a) => `${a._id}|${stamp(a.updatedAt)}`);
  section("interventions", interventions, (i) => `${i._id}|${stamp(i.updatedAt)}`);
  return h.digest("hex");
};

/**
 * The documents the analysis reads, for the worker. The same queries and
 * projections as reviewCases.liveCohort, minus every name field: the analysis
 * never needed them and the worker never gets them.
 */
const loadEvidence = async (scope) => {
  const { schoolId } = scope;
  const students = await Student.find(studentFilterOf(scope)).select("_id classId").lean();
  const ids = students.map((s) => String(s._id));
  const [exams, summaries, gradingConfig, academicStructure, interventions] = await Promise.all([
    Exam.find({ schoolId, deletedAt: null })
      .select("_id type academicYear term sequenceNumber startDate parentExamId").lean(),
    ids.length
      ? ResultSummary.find({ schoolId, deletedAt: null, studentId: { $in: ids } })
          .select("_id examId studentId classId isPublished createdAt subjectBreakdown").lean()
      : [],
    GradingConfig.findOne({ schoolId }).select("passMark grades").lean(),
    AcademicStructure.findOne({ schoolId, deletedAt: null }).sort({ academicYear: -1 }).select("passMark").lean(),
    ids.length
      ? Intervention.find({ schoolId, deletedAt: null, studentId: { $in: ids } })
          .select("_id studentId subjectId status createdAt startedAt").lean()
      : [],
  ]);
  return { students, exams, summaries, gradingConfig, academicStructure, interventions };
};

// ─────────────────────────────────────────────────────────────────────────────
// THE WORKER
// ─────────────────────────────────────────────────────────────────────────────

const runWorker = (workerData, { timeoutMs, heapMb }) => new Promise((resolve) => {
  let settled = false;
  let worker;
  const finish = (r) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(r);
  };
  const timer = setTimeout(() => {
    finish({ ok: false, code: "TIMEOUT" });
    worker?.terminate().catch(() => {});
  }, timeoutMs);
  try {
    worker = new Worker(WORKER_FILE, { workerData, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
  } catch {
    finish({ ok: false, code: "WORKER_EXITED" });
    return;
  }
  worker.once("message", (m) => finish(m && m.ok
    ? { ok: true, gz: Buffer.from(m.gz.buffer, m.gz.byteOffset, m.gz.byteLength), rawBytes: m.rawBytes, digest: m.digest, engineVersion: m.engineVersion, cases: m.cases }
    : { ok: false, code: m?.code ?? "ENGINE_ERROR" }));
  worker.once("error", (err) => finish({ ok: false, code: err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "WORKER_OUT_OF_MEMORY" : "ENGINE_ERROR" }));
  worker.once("exit", () => finish({ ok: false, code: "WORKER_EXITED" }));
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE INSTANCE PER PROCESS
// ─────────────────────────────────────────────────────────────────────────────

/** What a status endpoint may show of a run: codes, counts and times. Never the report. */
const publicRun = (r) => (r ? {
  runId: String(r._id),
  status: r.status,
  stage: r.stage,
  scope: { schoolId: r.schoolId, classIds: r.classIds ?? null },
  fingerprint: r.fingerprint,
  engineVersion: r.engineVersion,
  attempt: r.attempt,
  trigger: r.trigger,
  requestedAt: r.queuedAt ?? r.createdAt ?? null,
  startedAt: r.startedAt ?? null,
  finishedAt: r.finishedAt ?? null,
  durationMs: r.durationMs ?? null,
  counts: r.counts ?? null,
  reportBytes: r.reportBytes ?? null,
  reportAvailable: r.status === "succeeded" && !r.reportPrunedAt,
  error: r.error ? { code: r.error.code, message: r.error.message, retryable: r.error.retryable } : null,
} : null);

const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

/**
 * @param {object} [options]  overrides of DEFAULTS; `instanceId` names the
 *                            process (tests make two to stand for two servers)
 */
const createAnalysisRuns = (options = {}) => {
  const cfg = { ...DEFAULTS, ...options };
  const instanceId = options.instanceId ?? `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

  /** runId → promise of the finished run, for runs this instance executes. */
  const local = new Map();
  /** FIFO of runIds owned here and not yet started. */
  const queue = [];
  let running = 0;
  let heartbeat = null;
  /** runId → { at, report } */
  const cache = new Map();

  const configure = (o) => Object.assign(cfg, o);

  // ── lease ──────────────────────────────────────────────────────────────────
  const leaseFrom = () => new Date(Date.now() + cfg.leaseMs);

  const renewLeases = () => IntelligenceAnalysisRun.updateMany(
    { owner: instanceId, status: { $in: IntelligenceAnalysisRun.ACTIVE_STATUSES } },
    { $set: { leaseUntil: leaseFrom() } }
  ).catch((err) => console.warn("[analysis] lease renewal failed:", err.message));

  const syncHeartbeat = () => {
    if (local.size && !heartbeat) {
      heartbeat = setInterval(renewLeases, cfg.heartbeatMs);
      heartbeat.unref();
    } else if (!local.size && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  /** Fail one active run whose lease has run out. Returns it, or null when it was alive or already over. */
  const interruptIfStale = (runId) => IntelligenceAnalysisRun.findOneAndUpdate(
    { _id: runId, status: { $in: IntelligenceAnalysisRun.ACTIVE_STATUSES }, leaseUntil: { $lt: new Date() } },
    { $set: {
      status: "failed", stage: "done", activeKey: null, finishedAt: new Date(),
      error: { code: "INTERRUPTED", message: ERROR_MESSAGES.INTERRUPTED, retryable: true },
    } },
    { returnDocument: "after" }
  ).lean();

  /** Fail every active run whose lease has run out. Run at boot. */
  const recoverStale = async () => {
    const r = await IntelligenceAnalysisRun.updateMany(
      { status: { $in: IntelligenceAnalysisRun.ACTIVE_STATUSES }, leaseUntil: { $lt: new Date() } },
      { $set: {
        status: "failed", stage: "done", activeKey: null, finishedAt: new Date(),
        error: { code: "INTERRUPTED", message: ERROR_MESSAGES.INTERRUPTED, retryable: true },
      } }
    );
    return r.modifiedCount ?? 0;
  };

  // ── execution ──────────────────────────────────────────────────────────────

  /** End a run this instance holds. Conditional on still holding it. */
  const finishRun = async (runId, startedAt, set) => {
    const finishedAt = new Date();
    return IntelligenceAnalysisRun.findOneAndUpdate(
      { _id: runId, owner: instanceId, status: "running" },
      { $set: { ...set, stage: "done", activeKey: null, finishedAt, durationMs: startedAt ? finishedAt - startedAt : null } },
      { returnDocument: "after" }
    ).lean();
  };

  const fail = (runId, startedAt, code) => finishRun(runId, startedAt, {
    status: "failed",
    error: { code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.ENGINE_ERROR, retryable: !NOT_RETRYABLE.has(code) },
  });

  const execute = async (runId) => {
    const startedAt = new Date();
    const claimed = await IntelligenceAnalysisRun.findOneAndUpdate(
      { _id: runId, owner: instanceId, status: "queued" },
      { $set: { status: "running", stage: "loading", startedAt, leaseUntil: leaseFrom() } },
      { returnDocument: "after" }
    ).lean();
    // Superseded or interrupted while it waited: nothing to do.
    if (!claimed) return IntelligenceAnalysisRun.findById(runId).lean();

    const scope = { schoolId: claimed.schoolId, classIds: claimed.classIds ?? null };
    let docs;
    try {
      docs = await loadEvidence(scope);
    } catch {
      return fail(runId, startedAt, "LOAD_ERROR");
    }
    const counts = { students: docs.students.length, results: docs.summaries.length, exams: docs.exams.length, cases: 0 };
    await IntelligenceAnalysisRun.updateOne({ _id: runId, owner: instanceId, status: "running" }, { $set: { stage: "analysing", counts } });

    const out = await runWorker(
      { docs, provenance: { ...PROVENANCE }, fault: cfg.fault },
      { timeoutMs: cfg.timeoutMs, heapMb: cfg.heapMb }
    );
    docs = null;
    if (!out.ok) return fail(runId, startedAt, out.code);
    if (out.gz.length > cfg.maxReportBytes) return fail(runId, startedAt, "REPORT_TOO_LARGE");

    await IntelligenceAnalysisRun.updateOne({ _id: runId, owner: instanceId, status: "running" }, { $set: { stage: "storing" } });
    let done;
    try {
      done = await finishRun(runId, startedAt, {
        status: "succeeded", error: null,
        counts: { ...counts, cases: out.cases },
        report: out.gz, reportBytes: out.gz.length, reportRawBytes: out.rawBytes, reportDigest: out.digest,
      });
    } catch {
      return fail(runId, startedAt, "STORE_ERROR");
    }
    // Lost the run while working (its lease was taken over): the result is
    // discarded rather than written over somebody else's record.
    if (!done) return IntelligenceAnalysisRun.findById(runId).lean();

    // Older reports of this scope are of evidence that no longer exists. The
    // runs stay as a record; their bytes go.
    await IntelligenceAnalysisRun.updateMany(
      { schoolId: done.schoolId, scopeKey: done.scopeKey, _id: { $ne: runId }, status: "succeeded", reportPrunedAt: null, createdAt: { $lte: done.createdAt } },
      { $set: { report: null, reportPrunedAt: new Date() } }
    ).catch(() => {});
    return done;
  };

  const pump = () => {
    while (running < cfg.concurrency && queue.length) {
      const runId = queue.shift();
      const entry = local.get(runId);
      running += 1;
      execute(runId)
        .catch(async (err) => {
          console.warn(`[analysis] run ${runId} failed unexpectedly:`, err?.message);
          return fail(runId, null, "ENGINE_ERROR").catch(() => null);
        })
        .then((finished) => entry?.resolve(finished))
        .finally(() => {
          running -= 1;
          local.delete(runId);
          syncHeartbeat();
          pump();
        });
    }
  };

  const enqueue = (runId) => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    local.set(runId, { promise, resolve });
    queue.push(runId);
    syncHeartbeat();
    pump();
    return promise;
  };

  /**
   * Runs still queued here for the same scope over OLDER evidence will only
   * ever produce a report nobody can be served. Dropped before they start.
   */
  const supersedeQueued = async ({ schoolId, scopeKey }, fingerprint) => {
    const stale = await IntelligenceAnalysisRun.find({
      schoolId, scopeKey, status: "queued", owner: instanceId, fingerprint: { $ne: fingerprint },
    }).select("_id").lean();
    for (const { _id } of stale) {
      const id = String(_id);
      const r = await IntelligenceAnalysisRun.findOneAndUpdate(
        { _id: id, status: "queued", owner: instanceId },
        { $set: { status: "superseded", stage: "done", activeKey: null, finishedAt: new Date() } },
        { returnDocument: "after" }
      ).lean();
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
      const entry = local.get(id);
      if (entry) { local.delete(id); entry.resolve(r); }
    }
    syncHeartbeat();
  };

  // ── reports ────────────────────────────────────────────────────────────────

  const readReport = async (run) => {
    const id = String(run._id);
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < cfg.cacheTtlMs) return hit.report;
    const doc = await IntelligenceAnalysisRun.findById(id).select("+report reportDigest status reportPrunedAt").lean();
    if (!doc || doc.status !== "succeeded" || !doc.report || doc.reportPrunedAt) return null;
    const bytes = Buffer.isBuffer(doc.report) ? doc.report : Buffer.from(doc.report.buffer ?? doc.report);
    if (sha("sha256", bytes) !== doc.reportDigest) {
      console.error(`[analysis] run ${id}: stored report does not match its digest; it will be recomputed.`);
      return null;
    }
    const report = JSON.parse((await gunzip(bytes)).toString("utf8"));
    cache.set(id, { at: Date.now(), report });
    while (cache.size > cfg.cacheMax) cache.delete(cache.keys().next().value);
    return report;
  };

  // ── the entry point ────────────────────────────────────────────────────────

  const backoffFor = (attempt) => Math.min(30 * 60_000, cfg.retryBackoffMs * 2 ** Math.max(0, attempt - 1));

  /**
   * Create a run for the key, or find the one somebody else just created.
   * Returns { run, created }.
   */
  const createOrJoin = async ({ scope, scopeKey, fingerprint, attempt, requester, trigger }) => {
    const activeKey = activeKeyOf(scope.schoolId, scopeKey, fingerprint);
    try {
      const doc = await IntelligenceAnalysisRun.create({
        schoolId: scope.schoolId, scopeKey, classIds: scope.classIds ? [...new Set(scope.classIds.map(String))].sort() : null,
        fingerprint, engineVersion: ENGINE_VERSION, codeDigest: codeDigest(),
        status: "queued", stage: "queued", activeKey, attempt, trigger,
        requestedBy: requester?.userId ?? null, requestedByRole: requester?.role ?? null,
        owner: instanceId, leaseUntil: leaseFrom(), queuedAt: new Date(),
      });
      return { run: doc.toObject(), created: true };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await IntelligenceAnalysisRun.findOne({ activeKey }).lean();
      return { run: existing, created: false };
    }
  };

  /** Wait for a run up to `ms`. Returns the run as it then stands. */
  const waitFor = async (run, ms) => {
    const id = String(run._id);
    const deadline = Date.now() + ms;
    const mine = local.get(id);
    if (mine) {
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(r, ms); });
      await Promise.race([mine.promise, timeout]);
      clearTimeout(timer);
      return IntelligenceAnalysisRun.findById(id).lean();
    }
    // Held by another process: watch its record.
    for (;;) {
      const now = await IntelligenceAnalysisRun.findById(id).lean();
      if (!now || !IntelligenceAnalysisRun.ACTIVE_STATUSES.includes(now.status)) return now;
      if (now.leaseUntil && new Date(now.leaseUntil) < new Date()) {
        const stopped = await interruptIfStale(id);
        return stopped ?? IntelligenceAnalysisRun.findById(id).lean();
      }
      if (Date.now() >= deadline) return now;
      await new Promise((r) => setTimeout(r, Math.min(cfg.pollMs, Math.max(1, deadline - Date.now()))));
    }
  };

  /**
   * Start (or join) the run for this scope's current evidence, without
   * waiting for it. Returns { run, fingerprint, current } where `current` is
   * a succeeded run over this exact evidence when one exists.
   *
   * @param {object} scope      { schoolId, classIds|null } — already authorised
   * @param {object} requester  { userId, role } — recorded, never trusted for scope
   * @param {object} [opts]     { trigger: "request"|"explicit"|"retry" }
   */
  const ensure = async (scope, requester = null, { trigger = "request" } = {}) => {
    if (!scope?.schoolId) throw new Error("analysisRuns: a school is required");
    const scopeKey = scopeKeyOf(scope);
    const fingerprint = await fingerprintOf(scope);

    for (let pass = 0; pass < 3; pass += 1) {
      const latest = await IntelligenceAnalysisRun.findOne({
        schoolId: scope.schoolId, scopeKey, fingerprint, deletedAt: null,
      }).sort({ createdAt: -1 }).lean();

      if (latest?.status === "succeeded" && !latest.reportPrunedAt) return { run: latest, fingerprint, current: latest };

      if (latest && IntelligenceAnalysisRun.ACTIVE_STATUSES.includes(latest.status)) {
        if (latest.leaseUntil && new Date(latest.leaseUntil) < new Date()) {
          await interruptIfStale(String(latest._id));
          continue;
        }
        return { run: latest, fingerprint, current: null };
      }

      if (latest?.status === "failed" && trigger !== "retry") {
        const tooMany = latest.attempt >= cfg.maxAutoAttempts;
        // An interruption is the process's failure, not the analysis's: the
        // evidence is not going to fail again for having waited, so there is
        // no back-off. It still counts towards the limit, so a run that keeps
        // coinciding with a dying server stops being restarted on its own.
        const interrupted = latest.error?.code === "INTERRUPTED";
        const tooSoon = !interrupted && latest.finishedAt && Date.now() - new Date(latest.finishedAt).getTime() < backoffFor(latest.attempt);
        if (tooMany || tooSoon || latest.error?.retryable === false) return { run: latest, fingerprint, current: null };
      }

      await supersedeQueued({ schoolId: scope.schoolId, scopeKey }, fingerprint);
      const { run, created } = await createOrJoin({
        scope, scopeKey, fingerprint, attempt: (latest?.attempt ?? 0) + 1, requester, trigger,
      });
      if (created) enqueue(String(run._id));
      if (run) return { run, fingerprint, current: null };
      // The other process's run ended between the insert and the read: look again.
    }
    throw new Error("analysisRuns: could not settle a run for this scope");
  };

  /**
   * The current report for a scope, or AnalysisNotReady.
   *
   * @param {object} scope       { schoolId, classIds|null } — already authorised
   * @param {object} requester   { userId, role }
   * @param {object} [opts]      { waitMs }
   * @returns {Promise<{ report: object, run: object }>}
   */
  const reportFor = async (scope, requester = null, { waitMs = cfg.waitMs, secondPass = false } = {}) => {
    const { run, current } = await ensure(scope, requester);
    let settled = current ?? run;
    if (!current && IntelligenceAnalysisRun.ACTIVE_STATUSES.includes(run.status)) settled = await waitFor(run, waitMs);
    if (settled?.status === "succeeded") {
      const report = await readReport(settled);
      if (report) return { report, run: settled };
      // A stored report that cannot be read (its digest does not match) is
      // released, so that it stops counting as current and the evidence is
      // analysed again — once per request, never in a loop.
      await IntelligenceAnalysisRun.updateOne(
        { _id: String(settled._id), reportPrunedAt: null },
        { $set: { report: null, reportPrunedAt: new Date() } }
      );
      cache.delete(String(settled._id));
      if (!secondPass) return reportFor(scope, requester, { waitMs, secondPass: true });
    }
    // The run's server stopped while this request waited on it (its lease ran
    // out): start over once, which starts a fresh run, rather than reporting
    // another server's death as the analysis failing.
    if (settled?.status === "failed" && settled.error?.code === "INTERRUPTED" && !secondPass) {
      return reportFor(scope, requester, { waitMs, secondPass: true });
    }
    if (settled && IntelligenceAnalysisRun.ACTIVE_STATUSES.includes(settled.status)) {
      throw new AnalysisNotReady("ANALYSIS_PENDING", publicRun(settled));
    }
    // Failed, superseded, or a report that could not be read: a failure is
    // reported as one; anything else has not produced a report yet.
    throw new AnalysisNotReady(settled?.status === "failed" ? "ANALYSIS_FAILED" : "ANALYSIS_PENDING", publicRun(settled));
  };

  /** One run of a school, by id. Scope is checked by the caller. */
  const findRun = (schoolId, runId) => IntelligenceAnalysisRun.findOne({ _id: String(runId), schoolId, deletedAt: null }).lean();

  /** The newest run for a scope, whatever its evidence. */
  const latestRun = (scope) => IntelligenceAnalysisRun.findOne({
    schoolId: scope.schoolId, scopeKey: scopeKeyOf(scope), deletedAt: null,
  }).sort({ createdAt: -1 }).lean();

  /** Settle in-flight work, for tests and shutdown. */
  const idle = async () => { while (local.size) await Promise.all([...local.values()].map((e) => e.promise)); };

  return {
    instanceId, configure, config: cfg,
    ensure, reportFor, findRun, latestRun, recoverStale, idle,
    fingerprintOf, scopeKeyOf, publicRun,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the declared indexes and CHECK the unique one, because autoIndex is
 * off in production and without it two processes could run the same analysis
 * at once. Reported, not thrown, in the manner of ensureIdempotencyIndex: a
 * missing index costs duplicate work, not a school's day.
 */
const ensureIndexes = async () => {
  try { await IntelligenceAnalysisRun.createIndexes(); } catch (err) {
    console.error("[indexes] intelligenceanalysisruns: could not create the declared indexes — " + err.message);
  }
  // Reading the indexes back can fail too — the collection does not exist
  // when creating it was refused — and that must not stop the server either.
  let indexes = [];
  try { indexes = await IntelligenceAnalysisRun.collection.indexes(); } catch (err) {
    console.error("[indexes] intelligenceanalysisruns: could not read the indexes back — " + err.message);
  }
  const ok = indexes.some((ix) => ix.unique && ix.key && ix.key.activeKey === 1 && Object.keys(ix.key).length === 1);
  if (ok) console.log("[indexes] intelligenceanalysisruns activeKey is unique ✅");
  else console.error("[indexes] intelligenceanalysisruns: the unique activeKey index is MISSING — two servers can run the same analysis at once. See docs/38 §9.");
  return ok;
};

const defaultInstance = createAnalysisRuns();

module.exports = {
  ...defaultInstance,
  createAnalysisRuns,
  ensureIndexes,
  AnalysisNotReady,
  ERROR_MESSAGES,
  DEFAULTS,
  // For the check script.
  _internals: { loadEvidence, fingerprintOf, scopeKeyOf, codeDigest, runWorker, PROVENANCE },
};
