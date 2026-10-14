// backend/src/services/intelligence/analysisWorker.js
"use strict";

/**
 * The school-wide calibration analysis, in a worker thread (docs/38).
 *
 * Started by analysisRuns.service with the scope's documents as workerData;
 * answers with one message and exits. Everything CPU-bound happens here: the
 * mapping to a cohort, the forty-odd engine passes of analyse(), the
 * serialisation and the compression. The server's event loop only copies the
 * documents in and the compressed bytes out.
 *
 * It is the same analysis, not a copy: cohortFromDocuments and analyse() are
 * required from scripts/calibration exactly as reviewCases.service required
 * them on the request thread. A worker has its own module registry, so
 * isolatedEngine's cache swap for the sensitivity sweep happens in this
 * thread's registry and cannot be observed by any request.
 *
 * Its heap is capped by the parent (resourceLimits). Running out of it ends
 * this thread with ERR_WORKER_OUT_OF_MEMORY; the server carries on.
 *
 * The message never carries an error's text: an engine error can quote a value
 * from a row, and the run record keeps codes only.
 */

const { parentPort, workerData } = require("worker_threads");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const CAL = path.join(__dirname, "..", "..", "..", "scripts", "calibration");

const run = () => {
  const { docs, provenance, fault } = workerData;

  // Test-only failure modes, honoured only when the service was configured to
  // pass them (scripts/check-analysis-runs.js). Never set in production.
  if (fault === "throw") throw new Error("injected engine failure");
  if (fault === "exit") process.exit(3);
  if (fault === "hang") { for (;;) { /* until terminated */ } }
  if (fault === "oom") { const hold = []; for (;;) hold.push(new Array(1e6).fill(hold.length)); }

  const { cohortFromDocuments } = require(path.join(CAL, "cohortSchema"));
  const { analyse } = require(path.join(CAL, "analyseCohort"));

  const cohort = cohortFromDocuments({ provenance, ...docs });
  const full = analyse(cohort);
  // The per-pupil profiles are consumed inside analyse() and read by nothing
  // after it (docs/37 §7); they were the bulk of a report.
  const report = { ...full, profiles: undefined };
  const json = Buffer.from(JSON.stringify(report), "utf8");
  const gz = zlib.gzipSync(json, { level: 6 });
  return {
    ok: true,
    gz,
    rawBytes: json.length,
    digest: crypto.createHash("sha256").update(gz).digest("hex"),
    engineVersion: report.engineVersion,
    cases: report.reviewCases?.cases?.length ?? 0,
  };
};

let message;
try {
  message = run();
} catch {
  message = { ok: false, code: "ENGINE_ERROR" };
}
parentPort.postMessage(message);
