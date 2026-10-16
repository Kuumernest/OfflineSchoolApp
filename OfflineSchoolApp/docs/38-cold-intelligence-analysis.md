# 38 — Cold intelligence analysis

The school-wide calibration analysis, moved off the request thread: a
persisted run, executed in a worker thread, served under a fingerprint of the
evidence it was computed from.

- **Branch:** `cold-intelligence-analysis`, from `ca-assessment` @ `a4e752f`.
- **Specification:** `docs/37-complexity-scalability-audit.md` §7 and §15 —
  P1 (the cold review blocks the event loop; de-duplicate in-flight misses)
  and P2 (the memo's key costs a full cohort load per hit).
- **Not changed:** any engine, any threshold, any grading rule, any version
  constant, the review form, the contamination shield, the pilot's states or
  gates. The worker runs the same `analyse()` over the same mapping.

## 1. What was there

`reviewCases.service.analyse()` (Stage 18A) ran
`scripts/calibration/analyseCohort.analyse` synchronously on the request
thread and memoised the report for 120 s under a SHA-1 of
`JSON.stringify(cohort)`. Its callers:

| Caller | Route |
|---|---|
| `reviewPackage` | `GET /api/insights/review-cases`, `GET /api/insights/calibration-summary` |
| `pilot.service.preflight` | `GET /api/insights/pilot/preflight`, `POST /api/insights/pilot` (kind `real`) |
| `pilot.service.evidenceFor` | `GET /api/insights/pilot/evidence`, `PATCH /api/insights/pilot/:id` (to `ANALYSIS_READY`, `CALIBRATED`, `INSUFFICIENT_EVIDENCE`) |
| `pilot.service.reportFor` | `GET /api/insights/pilot/:id/report` |

Measured on this Codespace at `a4e752f` (`SCALE_SIZES=1200,5000
SCALE_REPEATS=3 npm run perf:scale`, 2 vCPU):

| Pupils | Review queue, cold | Review queue, warm (hit) | Calibration summary | Preflight |
|---|---|---|---|---|
| 1,200 | 8.96 s, heap +699 MB | 0.51 s, heap +96 MB | 0.45 s | 1.07 s |
| 5,000 | 32.5 s, heap +501 MB | 1.83 s, heap +257 MB | 1.91 s | 4.46 s |

The cold figure is time the event loop could do nothing else.

## 2. What is there now

```
request ──► reviewScope / pilot route   (who, which school, which classes — unchanged)
        ──► reviewCases.reviewPackage
        ──► analysisRuns.reportFor(scope)
              │ fingerprintOf(scope)              projections of (id, updatedAt): no marks, no names
              │ succeeded run with that fingerprint?  ── yes ─► stored report (gunzip, digest check)
              │ active run for it?                 ── yes ─► wait ≤ 8 s
              │ else create one (unique activeKey) ─► queue ─► worker thread
              ▼
         report ready ─► viewer shaping, names joined, reviews attached (unchanged)
         not ready    ─► AnalysisNotReady ─► 202 / 409 / 503 (§6)
```

| File | Role |
|---|---|
| `backend/src/db/models/IntelligenceAnalysisRun.js` | The run: scope, fingerprint, lifecycle, lease, error code, compressed report |
| `backend/src/services/intelligence/analysisRuns.service.js` | Fingerprint, de-duplication, queue, lease, worker supervision, retry, report storage and reading |
| `backend/src/services/intelligence/analysisWorker.js` | The worker: documents → cohort → `analyse()` → JSON → gzip |
| `backend/src/services/intelligence/reviewCases.service.js` | `reviewPackage` reads the report through `analysisRuns`; the in-process memo is gone; `caseFor` (one pupil) still analyses in-thread |
| `backend/src/routes/insights.routes.js` | `analysisNotReady`, the four `analysis-runs` routes, 202/409 handling on the review and pilot routes |
| `backend/src/server.js` | At boot: ensure the run indexes, fail runs whose lease expired |
| `backend/src/config/syncFeed.js` | `IntelligenceAnalysisRun` classified `EXCLUDED` (online-only) |
| `web/src/services/insights.service.ts` | `AnalysisPendingError`, `pollWhileAnalysisPending` |
| `web/src/pages/insights/intelligence-review.tsx` | Pending / failed states on the queue, preflight, evidence and report |

## 3. The run

`IntelligenceAnalysisRun` (collection `intelligenceanalysisruns`):

| Field | Meaning |
|---|---|
| `schoolId`, `scopeKey`, `classIds` | `scopeKey` is `school` or `classes:<sha1 of the sorted class ids>` |
| `fingerprint`, `engineVersion`, `codeDigest` | What the report is of (§4) |
| `status` | `queued` → `running` → `succeeded` \| `failed`; `superseded` for a queued run overtaken by newer evidence before it started |
| `stage` | `queued`, `loading`, `analysing`, `storing`, `done` |
| `activeKey` | `school\|scope\|fingerprint` while queued or running, else `null`; unique while set |
| `attempt`, `trigger` | Attempt number for this (scope, fingerprint); `request`, `explicit` or `retry` |
| `requestedBy`, `requestedByRole` | A user id and a role. Never a name |
| `owner`, `leaseUntil` | The process holding the run and until when (§5) |
| `queuedAt`, `startedAt`, `finishedAt`, `durationMs` | |
| `counts` | `students`, `results`, `exams`, `cases` |
| `error` | `{ code, message, retryable }`; the message is a fixed sentence per code, never an exception's text |
| `report` (`select: false`), `reportBytes`, `reportRawBytes`, `reportDigest`, `reportPrunedAt` | gzip of the report JSON; sha256 of those bytes, checked on every read; bytes released when a newer report of the same scope is stored |

Error codes: `WORKER_OUT_OF_MEMORY`, `TIMEOUT`, `ENGINE_ERROR`,
`WORKER_EXITED`, `LOAD_ERROR`, `STORE_ERROR`, `REPORT_TOO_LARGE`,
`INTERRUPTED`.

Indexes: `one_active_analysis_per_key` (unique, partial on `activeKey` being
a string); `{schoolId, scopeKey, fingerprint, createdAt}`;
`{schoolId, scopeKey, createdAt}`; `{status, leaseUntil}`.

**What the report holds.** The analysis output minus the per-pupil
`profiles` (docs/37 §7: nothing reads them). Its input is ids, marks and
subject names: the worker's student documents are loaded with `_id classId`
only, and `cohortFromDocuments` drops names in any case. Names are joined per
viewer, after authorisation, in `reviewPackage`, exactly as before. The check
asserts that no stored report contains a pupil's name, an enrollment number,
a reviewer or a head.

## 4. Freshness

A report is served only under the fingerprint the scope's evidence has at
the moment of the request. There is no "nearly current".

The fingerprint is a sha256 over:

- the engine version and a digest of the analysis code by content, so a
  deploy that changes any of it invalidates every stored report whether or
  not a version moved (see "What the code digest covers" below);
- the school and the scope key;
- for each collection the analysis reads, with **the same filters the load
  uses**: students (`_id`, `classId`, `updatedAt`), exams, result summaries,
  the grading config, the latest academic structure, interventions
  (`_id`, `updatedAt`), each section with its row count.

**What the code digest covers** (`backend/src/services/intelligence/analysisCode.js`).
The file set is read off the module graph, not kept by hand.
- **Where it starts:** the worker (`analysisWorker.js`) and
  `scripts/calibration/analyseCohort.js`.
- **What it follows:** every relative string literal (as
  `scripts/check-orphans.js` does), plus `path.join(__dirname, "…")` and
  `path.join(CONST, "…")` for constants built the same way.
- **What is hashed:** each reached project file (never `node_modules`), as
  its project-relative path and its content, sorted by path. Computed once
  per process.

Today that set is these 11 files:
- `backend/src/services/intelligence/analysisWorker.js`;
- `backend/scripts/calibration/analyseCohort.js`, `cohortSchema.js`,
  `isolatedEngine.js`;
- `shared/intelligence/index.js`, `subjectInsights.js`, `guidance.js`,
  `academicOrder.js`, `interventionOutcome.js`;
- `shared/caAssessment.js`, `shared/gradeScale.js`.

That is exactly the set the worker loads at runtime.

The earlier hand-kept list (`shared/intelligence/**`, the three calibration
scripts and the worker) missed the last two. A deploy that changed
`caAssessment.js` or `gradeScale.js` would have left every fingerprint
unchanged and served a report computed by the old code.

`shared/strengths/**` and `shared/academicRules.js` are not loaded by the
analysis, so they are not covered. A process that also loads models, as
`reviewCases.caseFor` does, pulls them in through
`ExplorationEvidence.js`, outside the analysis.

`check:analysis` (section 11) proves the coverage:
- it runs the real worker and requires every project file in its
  `require.cache` to be in the set;
- on a temporary copy of the project, changing a covered file moves the
  digest, and changing an uncovered one does not;
- the digest is the same in two processes;
- after a covered file changes, the stored report is not served: a new run
  starts, under the new digest.

The change of method itself moves every digest once, so the first request
after this deploy analyses each scope again.

**Write paths inspected, not assumed.** All six models have
`timestamps: true`. No write in `backend/src` passes `timestamps: false` to
them (the only `timestamps: false` is the `AuditLog` sub-schema), none
writes to their collections through the raw driver (the only
`db.collection("students")` is index maintenance in
`db/ensureStudentIndexes.js`), and no route sets `updatedAt` explicitly. The
`ResultSummary.bulkWrite` calls (`exam.routes.js`, `results.controller.js`)
rely on Mongoose stamping bulk updates, which the check asserts directly.

The check proves the fingerprint moves for a mark edit, a `bulkWrite`,
unpublishing and republishing, a soft delete, a new result, a hard delete, a
class move, a pupil's status, the grading config, an exam edit and a new
intervention; that it does not move for another school's writes, or for
another class's result in a class scope; and that changed evidence produces
a new run rather than the old report.

**Residual blind spots, recorded:**

1. Two writes to the same row within one millisecond, with a fingerprint
   taken between them, leave the second invisible until the row is written
   again. Mongo stamps `updatedAt` to the millisecond.
2. A write made outside Mongoose (a shell, a migration script) that changes
   a field without touching `updatedAt`. Every in-repository path is covered;
   an operator editing the database by hand is not.
3. The fingerprint is taken before the evidence is loaded. Evidence that
   changes in between is analysed under the earlier fingerprint; the report
   is then *newer* than its label, never older, and no later request matches
   that label, so it is wasted work, not a stale answer.

## 5. Execution, duplicates, recovery

**Worker.** `node:worker_threads`, no new dependency. The worker receives the
scope's documents as `workerData`, maps them, runs `analyse()`, serialises
and compresses, and posts the bytes back. Its old-generation heap is capped
(`resourceLimits.maxOldGenerationSizeMb`): exceeding it ends the worker with
`ERR_WORKER_OUT_OF_MEMORY` and the run fails `WORKER_OUT_OF_MEMORY`; the
server carries on. A worker past `ANALYSIS_TIMEOUT_MS` is terminated. A
worker has its own module registry, so `isolatedEngine`'s cache swap for the
sensitivity sweep cannot be observed by a request.

**Shutdown.** Nothing is drained. On SIGTERM the server's existing graceful
shutdown closes HTTP and MongoDB and exits; a worker thread ends with the
process. Its run stays `queued` or `running` with a lease nobody renews; the
next boot's sweep, or the first request after the lease runs out (≤ 60 s),
fails it `INTERRUPTED` and starts a fresh run. A scope whose analysis was in
progress therefore answers 202 for up to a minute after a restart.

**Concurrency.** `ANALYSIS_CONCURRENCY` runs per process (default 1), FIFO.
A queued run for the same scope over older evidence is marked `superseded`
before it starts.

**De-duplication.**

- In one process: requests for the same key share one promise.
- Across processes: `activeKey` is unique while set. The loser of the insert
  race reads the winner's run and waits on its record (polling every 250 ms).
  The check simulates two servers with two service instances and proves one
  run. This rests on the index existing: `autoIndex` is off in production,
  so `server.js` builds and then **verifies** it at boot
  (`analysisRuns.ensureIndexes`) and logs loudly if it is missing. Without
  it, de-duplication is per process only.

**Leases.** The owning process renews `leaseUntil` (60 s) every 15 s for
every run it holds, queued or running. A run whose lease has expired belongs
to a process that stopped: the next request for that key, a poller, or the
boot sweep (`recoverStale`) fails it `INTERRUPTED`, which frees the key, and
a fresh run starts at once: an interruption is not subject to the failure
back-off below (it still counts towards the automatic-retry limit). A request
that was already waiting on the run when its server died starts that fresh
run itself rather than answering 503. A stale record therefore blocks a scope
for at most one lease. A live run held by another process is waited on,
never doubled.

**Retries.** A failed run is retried automatically once more (attempt 2)
after a back-off (60 s, doubling, capped at 30 min; none for `INTERRUPTED`). After that, or for a
non-retryable failure (`REPORT_TOO_LARGE`), requests — including
`POST /analysis-runs` — get 503 `ANALYSIS_FAILED` and no new run starts.
`POST /analysis-runs/:id/retry` (head or operator) starts another attempt
over the evidence as it is now.

**Unreadable reports.** A stored report whose bytes do not match
`reportDigest` is never served: its bytes are released (`reportPrunedAt`),
so it stops counting as current, and the same request starts a fresh run —
once, not in a loop.

## 6. HTTP

**Reads that need the analysis** — `GET /review-cases`,
`/calibration-summary`, `/pilot/preflight`, `/pilot/evidence`,
`/pilot/:id/report`. Each waits up to 8 s for a run. Then:

| Outcome | Status | Body |
|---|---|---|
| Report ready | 200 | Unchanged contract |
| Run still queued or running | **202** | `{ success: false, code: "ANALYSIS_PENDING", message, data: { runId, status, stage, statusUrl, retryAfterSeconds, error: null, run } }`, header `Retry-After: 5` |
| Run failed | **503** | `{ success: false, code: "ANALYSIS_FAILED", message, data: { runId, status, error: { code, message, retryable }, run } }` |

`success` is `false` on both so that no client reads a pending answer as a
report.

**Writes that need the analysis** — `PATCH /pilot/:id` (the evidence
snapshot), `POST /pilot` with `kind: real` (the preflight). A pending run is
**409 `ANALYSIS_PENDING`** with the same body shape; a failed one is 503.
`transition()` and `createPilot()` reach the analysis before they change
anything, so nothing is recorded: the pilot's status, version and evidence
are as they were (asserted). Repeating the same request, with the same
`version`, once the run has finished is safe.

**Run endpoints** (all under `/api/insights`, all behind `authenticate`):

| Route | Permission | Does |
|---|---|---|
| `POST /analysis-runs?classId=` | `insights.viewTaught` | Start or join the run for the caller's scope. 200 `{ run, current: true }` when a current report exists, else 202 |
| `GET /analysis-runs/latest?classId=` | `insights.viewTaught` | The newest run for the caller's scope and whether it is current |
| `GET /analysis-runs/:runId` | `insights.viewTaught` | One run's status. Never the report. An operator's `statusUrl` carries the run's `?schoolId=` |
| `POST /analysis-runs/:runId/retry` | `insights.pilot` | Start a failed run again |

**Authorisation** is the existing policy, resolved again on every request:

- The scope comes from `reviewScope`: the token's school (an operator must
  name one with `?schoolId=` — none is a 400, never every school), and for a
  teacher the classes `feedScopes.taughtStudentsOnly` gives them now.
- A run is visible when it is in that school and, for a teacher, every class
  of the run is one they teach now. Otherwise 404; existence is not
  disclosed. A teacher whose assignment ends loses the run at once.
- `insights.viewTaught` is held by default by the teacher, the head and the
  operator. The bursar and the pupil hold neither permission: 403.

**Web.** `fetchReviewCases`, `fetchPreflight`, `fetchPilotEvidence` and
`fetchPilotReport` throw `AnalysisPendingError` on a 202. Their queries
retry at the server's `Retry-After` for up to ten minutes, saying "The school
analysis is being prepared" meanwhile. A 503 says the analysis failed and who
can retry it. A 409 on a pilot action toasts
`intelReview.pilot.error.ANALYSIS_PENDING`: nothing changed, try again. The
mobile app and the desktop shell call none of these routes.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANALYSIS_WORKER_HEAP_MB` | 2048 | The worker's old-generation heap cap |
| `ANALYSIS_TIMEOUT_MS` | 600000 | A worker running longer is terminated (`TIMEOUT`) |
| `ANALYSIS_CONCURRENCY` | 1 | Analyses one process runs at once |
| `ANALYSIS_REPORT_MAX_BYTES` | 12582912 | The largest compressed report stored (`REPORT_TOO_LARGE`) |

None is required; none is a secret. All four are documented in
`backend/.env.example` and `docs/17-deployment.md`. Each is read once, when
the module loads, as a whole number (fractions floored); anything that is not
at least 1 — unset, empty, `abc`, `0`, `-1`, `0.5` — is the default.

**Migration.** A new collection; no existing data changes. The indexes are
created and verified at boot. Nothing to backfill: the first request per
scope after deploy is a cold run.

**At boot, failures are logged, never fatal.** If index creation is refused
(for example a database user without the `createIndex` privilege) or the
indexes cannot be read back, the log says
`the unique activeKey index is MISSING` and the server starts; the cost is
that two server processes can run the same analysis. If the boot sweep of
interrupted runs fails, it is logged and those runs expire with their lease.
Both are asserted (the first in `check-analysis-runs.js`; the server was
also booted against an in-memory MongoDB to confirm the log line).

## 8. Measured

`SCALE_SIZES=1200,5000 npm run perf:analysis` (the `perf:scale` school,
limited to the collections the analysis reads; 2 vCPU Codespace, in-memory
MongoDB; one machine's numbers):

| Pupils | Fingerprint | Cold request | Cold run (worker) | Worst timer lag during the run | Server heap during the run | Report JSON → gzip | Warm, first read from store | Warm, p50 | Warm heap | Summary, p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,200 | 40 ms | 202 at 8.1 s | 8.6 s | 199 ms | +72 MB | 1.65 MB → 52.8 KB | 101 ms | 78 ms | +23 MB | 62 ms |
| 5,000 | 130 ms | 202 at 8.2 s | 31.4 s | 289 ms | +130 MB | 6.73 MB → 199 KB | 335 ms | 214 ms | +50 MB | 188 ms |

Against §1, at 5,000 pupils:

| | Before | After |
|---|---|---|
| Event loop during a cold analysis | blocked for 32.5 s | worst timer lag 289 ms |
| Server heap during a cold analysis | +501 MB | +130 MB (the worker's own heap is separate and capped) |
| Warm review queue | 1.83 s, +257 MB | 0.21 s, +50 MB |
| Calibration summary | 1.91 s | 0.19 s |
| Report stored | none (memo, 120 s, ≤ 6 entries in-process) | 199 KB per scope, persistent |

**Analysis CPU time is unchanged** (31.4 s against 32.5 s): it is the same
analysis, in another thread. What changed is that nothing else waits for it,
two cannot run at once on one key, and an out-of-memory analysis cannot
take the server down.

The 199 KB report at 5,000 pupils is about 60× under the 12 MiB default. The
report grows with the sensitivity table's borderline list, so this is a
measured headroom, not a guarantee; `REPORT_TOO_LARGE` is the failure if it
is ever exceeded.

The remaining event-loop lag (≈ 0.2–0.3 s) is the main thread's own share:
reading 20,000 result summaries through Mongoose and copying them into the
worker (`workerData` is cloned synchronously), and reading the stored report
back (`JSON.parse`). It is a pause, not a minute.

## 9. Validation

See §12 for the commands and results of this change.

`scripts/check-analysis-runs.js` (`npm run check:analysis`, also the last
step of `check:intel`), on an in-memory MongoDB with the real router:

1. **Index:** a second active run per key is refused (11000); ended runs are
   not constrained.
2. **Same answer:** the worker's report equals the request thread's previous
   report byte for byte; digest and sizes match; no names in it.
3. **Lifecycle over HTTP:** the cold queue is served inside the wait; the
   run is succeeded, `done`, key released, with times, counts and requester;
   the report is gzip; warm is served from the store with no second run and
   equals cold; the summary uses the same run.
4. **Freshness:** §4.
5. **Duplicates:** five concurrent cold requests give one run; two instances
   standing for two servers give one run, and the loser is served from the
   winner's record.
6. **Recovery:** with the production 60 s back-off in force, a dead owner's
   run is `INTERRUPTED` and the request is served by a fresh run; so is a
   request already waiting on a run whose server dies mid-wait; a live run
   held elsewhere is waited on (202), not doubled; the boot sweep fails
   expired leases.
7. **Failure and retry:** `ENGINE_ERROR` (503, fixed message), one automatic
   retry, then none (`POST /analysis-runs` included: 503, no new run); no
   automatic retry inside the 60 s back-off; a
   teacher cannot force a retry, the head can (attempt 3); `WORKER_EXITED`, `TIMEOUT`, `WORKER_OUT_OF_MEMORY` (the server still
   answers afterwards), `REPORT_TOO_LARGE` (not retried).
8. **Event loop and pending answers:** a worker spinning at 100 % CPU leaves
   the server's 20 ms timer lag under 150 ms (observed 2–4 ms); past the wait
   the answer is 202 with run id, status URL and `Retry-After`, and no report;
   the status URL answers without the report; a pilot transition needing the
   analysis is 409 `ANALYSIS_PENDING` with status, version and evidence
   unchanged; the pilot's evidence read is 202; opening a real pilot while
   its preflight's analysis is pending is 409 with no pilot created; the same
   transition repeated afterwards is processed normally; a transition whose
   analysis *failed* is 503 `ANALYSIS_FAILED`, again with status, version,
   evidence and transition history unchanged.
8b. **Unreadable report:** a report whose digest no longer matches is not
   served; the evidence is analysed again and the bad bytes are released.
9. **Who:** bursar and pupil 403; operator without a school 400; another
   school's head 404 (403 when naming this school); the operator 200 for the
   school and 404 for another, and an operator who names the school in the
   body gets a status URL that names it and answers; a teacher cannot see the whole-school run,
   sees only runs over classes they teach, loses one when the assignment
   ends; a teacher naming a class they do not teach 403.
10. **Stored:** no stored report holds a pupil's name, an enrollment number,
    a reviewer or a head; at most one live report per scope; nothing left
    active.

## 10. Limitations and what remains

- **Not validated on a real school, a real deployment or real hardware.**
  Every figure here is a synthetic school on an in-memory MongoDB in a 2-vCPU
  Codespace. The 2 GiB worker heap default is sized from that, not from a
  school's server.
- **Cross-process de-duplication depends on the unique index existing in
  the deployed database.** It is built and verified at boot; a boot log
  saying it is missing means duplicate work is possible.
- **Concurrency is per process.** Two server processes may each run one
  analysis at once (for different keys). There is no global limiter.
- **A cold scope now answers 202 first.** A head opening the review queue on
  a large school sees "being prepared" for about half a minute at 5,000
  pupils before the page fills, where before the request hung for the same
  time. A client of these routes outside this repository would need to
  handle 202 (none exists here: the mobile app and desktop do not call
  them).
- **Busy evidence means repeated runs.** Every write in scope changes the
  fingerprint. A school entering marks all day will start a new analysis on
  each read after a change; a reader may see "being prepared" again. This is
  the cost of never serving a stale report, which was the Stage 18A rule and
  is kept. The fingerprint is never weakened to avoid it.
- **Preflight still loads the cohort a second time** on the request thread
  (`validateCohort`) and runs three single-pupil consistency checks (docs/37
  §15 P2). Not changed here.
- **Old runs are kept.** Report bytes are released when a newer report of
  the same scope is stored, but run records (codes, counts, times; no
  report) are never deleted. A retention rule is a decision for the school
  or the operator.
- **No run listing endpoint, no cancel.** A run can be read by id or as the
  latest for a scope, and retried when failed; it cannot be cancelled except
  by the time limit.
- **The web console was type-checked and built, not exercised in a
  browser.** The pending and failed states have not been seen on a screen.

**Manual acceptance still required:**

1. Build the image from this branch (`docker compose build`), deploy it to a
   staging host that meets §11's prerequisites — with **working Compose
   networking**, unverified here — and a production-like database user, and
   confirm the boot log line
   `intelligenceanalysisruns activeKey is unique ✅`. If it says MISSING,
   create the index by hand (§11) before running more than one process.
2. In a browser, as the head of a school large enough that the analysis
   takes more than 8 s: open Intelligence review and confirm the "being
   prepared" state, that the queue fills by itself, and that a reload is
   served at once.
3. Confirm a teacher sees only their classes' queue, and an operator must
   select a school.
4. Advance a development pilot while the analysis is cold and confirm the
   toast, then the same action succeeding once it is ready.
5. Choose `ANALYSIS_WORKER_HEAP_MB` and `ANALYSIS_CONCURRENCY` for the real
   server's memory: two concurrent analyses at 5,000 pupils need two worker
   heaps.
6. Restart the server while an analysis is running and confirm the scope
   answers 202 and then recovers within about a minute (§5, Shutdown).
7. Decide the rollback path (§11) before the first deploy.

## 11. Deployment prerequisites and rollback

**Prerequisites.**

1. The backend must be deployed with `backend/engine/`,
   `backend/scripts/calibration/` and `shared/` at the paths its source
   resolves to: the analysis (worker and request thread), the fingerprint's
   code digest and the report-template engine read them at runtime. This was
   already true before this change, and the repository's `Dockerfile` copied
   none of them. **It now does** (below). Any other deployment method must do
   the same.
2. Node with `worker_threads` and `resourceLimits` (any supported Node; the
   checks ran on Node 24.21.0; CI also targets 20 and 24).
3. A database user allowed to create indexes on `intelligenceanalysisruns`,
   or the unique index created by hand:
   `db.intelligenceanalysisruns.createIndex({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: "string" } }, name: "one_active_analysis_per_key" })`.
4. Memory for `ANALYSIS_CONCURRENCY × ANALYSIS_WORKER_HEAP_MB` on top of the
   server's own.
5. **Backend and web together.** A web build from before this change reads
   a 202 body as a review package (it has `data.runId`, not `data.cases`);
   from reading that code, the review page is expected to break until the
   run completes (not tested). The two
   ship in one image in this repository; keep it that way for this change.

**The Docker image (fixed on this branch).** `Dockerfile` now:

- copies `shared/requestPath.js` to `/app/shared/` in the web stage — the
  offline adapter's `../../../../shared/requestPath.js` from
  `/app/web/src/lib/offline`;
- copies `backend/engine/` to `/app/engine/`,
  `backend/scripts/calibration/` to `/app/scripts/calibration/`, and
  `shared/` to `/shared/` — every backend require of `shared` climbs one level
  above the backend root (`/app/src/db/models/../../../../shared` is
  `/shared`), as `shared/` sits beside `backend/` in the repository;
- names the upload directories one by one: BusyBox `sh` has no brace
  expansion, so `content/{syllabus,…}` had created one directory of that
  literal name and the server's own `mkdir` of `content/syllabus` failed at
  boot (`EACCES`);
- `chown`s the upload tree to the non-root `appuser`, which writes it.

A new `.dockerignore` keeps host `node_modules` (built for another libc;
`COPY web/ ./` would have overwritten the image's own), `web/dist`, and
local uploads and backups out of the build context (7.4 MB).

**Tested here (2026-10-12, Docker 29.8.0, Compose v5.5.1):**

| Step | Result |
|---|---|
| `docker build` of the **unmodified** Dockerfile (from `a4e752f`) | **failed**: `Could not resolve '../../../../shared/requestPath.js'` in the web stage |
| `docker build` of the fixed Dockerfile | exit 0 in 67 s (web `tsc -b` + Vite build inside) |
| `docker compose up` with test-only secrets, first fixed build (shared/engine/calibration only) | backend crash-looped: `EACCES: permission denied, mkdir '/app/src/uploads/content/syllabus'` — the upload-directory defect above, fixed next |
| `docker compose up` after the upload fix | backend started (`Upload directories verified`) but could not reach MongoDB: **this Codespace drops container-to-container traffic** — a plain `node:20-alpine` container on the same network also timed out reaching `mongo:27017`, while the host reached the MongoDB container directly. Compose networking is therefore **not verified here.** |
| The built image run with host networking, `NODE_ENV=production`, against the Compose stack's MongoDB 7 (authentication on), a fresh named volume at `/app/src/uploads` | `GET /api/health` 200 `{"status":"ok","database":"connected","env":"production"}`; boot log: `MongoDB connected`, `intelligenceanalysisruns activeKey is unique ✅` (with `autoIndex` off), `Indexes verified` |
| A synthetic school seeded through the image's own models; a test-only token | `GET /insights/review-cases` 200 (cold, run executed in the image's worker thread; 8 cases, names joined) then 200 warm in 29 ms; `GET /insights/calibration-summary` 200; `GET /insights/analysis-runs/latest` 200 — `succeeded`, 3,425-byte report, current; `GET /insights/pilot/preflight` 200; `GET /templates` 200 (engine loaded); no token 401; no module-load, `ENOENT` or 503 lines in the log |
| `appuser` writing into `/app/src/uploads/logos` on the fresh volume | succeeded |
| `GET /` through nginx (before the fix below) | HTTP 500; nginx's log: `rewrite or internal redirection cycle while internally redirecting to "/index.html"` — `/app/public/web` did not exist in the nginx container |

Everything was torn down afterwards (containers, volumes, network, the
test-only secrets).

**The web console (fixed after the commit above).** The web build existed only
in the backend image, where nothing serves it, and the `nginx` service had
nothing but its config, so `try_files` cycled to a 500 on every page. The
Dockerfile now has a `web` stage — `nginx:alpine` plus
`COPY --from=web-builder /app/web/dist /app/public/web` — placed before the
backend stage so a plain `docker build` still builds the backend, and the
`nginx` service in `docker-compose.yml` builds that target. `nginx.conf` is
unchanged and still mounted. A named volume shared with the backend was
rejected: Docker fills one only when empty, so it would keep serving the
first build after every deploy.

| Step | Result |
|---|---|
| `docker compose up --build` | nginx rebuilt from target `web` and recreated |
| `GET /` through nginx | 200 `text/html`, the console's `index.html` |
| `GET /assets/index-wJzPah24.js` (named in that page) | 200 `application/javascript`, 109,570 bytes |
| `GET /dashboard` (an SPA route) | 200 `text/html` (the `try_files` fallback) |
| `GET /api/health` through nginx **on the Compose network** | **no answer**: the backend could not reach `mongo` and restarted; a probe container on the network timed out to both `mongo:27017` and `nginx:80`. **Not verified here.** |
| Both built images on host networking, unmodified `nginx.conf`, `backend` resolved to `127.0.0.1` | `GET /api/health` via nginx 200 (`database: connected`); `GET /` 200; unauthenticated `GET /api/insights/review-cases` 401; `GET /uploads/logos/none.png` reached the backend (its JSON 404) |
| `docker build` with no target | the backend image (`appuser`, `node src/server.js`) |

Note, unchanged: a missing asset path (for example `/assets/missing.js`) also
answers 200 with `index.html`, from the same `try_files` fallback.

**Not verified (assumptions):**

- The Compose stack end to end over the Compose network (backend → `mongo`,
  nginx → backend). Blocked by this environment's networking — a plain probe
  container cannot reach any other container — not by the images. The same
  images and config work with host networking (above). It must be confirmed
  on the target host.
- A named `uploads_data` volume **created by an earlier image** keeps that
  image's root ownership — Docker copies the image's ownership only into an
  empty, new volume. Such a deployment needs a one-time
  `chown -R 100:101` (the image's `appuser:appgroup`) of the volume, or the
  server cannot write uploads. Because the earlier image could not start at
  all (above), this should only concern volumes made by hand or by an older
  build.
- TLS and production MongoDB (Atlas or replica set) — neither was exercised.
- The console in a browser: `index.html` and its assets are served; nobody
  has logged in through it on this stack.

**Rollback.**

- Revert the change and redeploy backend and web together. The previous
  code computes the analysis on the request thread again, with its 120 s
  in-process memo, and ignores the `intelligenceanalysisruns` collection.
- The collection can be left in place or dropped
  (`db.intelligenceanalysisruns.drop()`): it holds derived reports and run
  records, recomputable from mirrored documents, and nothing else reads it.
- No other collection was changed: reviews, pilots, results, grading and
  the sync feed's documents are untouched, so rollback loses nothing but the
  stored reports.
- The four `ANALYSIS_*` variables are ignored by the previous code.

## 12. Commands run for this change

On the `cold-intelligence-analysis` branch in a GitHub Codespace (Node
v24.21.0, npm 11.19.0, 2 vCPU, in-memory MongoDB from
`mongodb-memory-server`). Results as observed.

| Command (from `backend/` unless noted) | Result |
|---|---|
| `SCALE_SIZES=1200,5000 SCALE_REPEATS=3 node --expose-gc scripts/perf-scalability.js` at `a4e752f`, before any change | exit 0; the "before" figures in §1 |
| `npm run check:analysis` (final version) | 115 passed, 0 failed; earlier versions 104/0 three times in a row, then 110/0 and 114/0 (≈ 25 s each) |
| `SCALE_SIZES=1200,5000 node --expose-gc scripts/perf-analysis-runs.js` | exit 0; the "after" figures in §8 |
| `npm run check:intel` | exit 0, 157 s; all 22 existing suites 0 failed, then this check |
| `npm run check:complexity` | 17 passed, 0 failed |
| `npm run check:inputs` | 3 passed, 0 failed |
| `npm run check:routers` | 4 passed, 0 failed |
| `npm run check:orphans` | first 5/1: the worker, loaded by `new Worker(path)`, was invisible to the static walk; the service now names it with `require.resolve("./analysisWorker")`; then 6 passed, 0 failed |
| `npm run check:roles` | 94 passed, 0 failed |
| `npm run check:conflicts` | 23 passed, 0 failed |
| `npm run check:authz` | 24 passed, 0 failed |
| `npm run check:all` (first full run) | exit 0 in 437 s |
| `npm run check:all` (after the final code change: integer parsing of the `ANALYSIS_*` variables and the interruption fix) | **exit 0 in 435 s**; 88 suites reporting "N passed, 0 failed", none failing — among them `check:intel` (23 suites, the last `check-analysis-runs` 114/0), `check:roles` 94, `check:complexity` 17, `check:inputs` 3, `check:routers` 4, `check:orphans` 6, `check:conflicts` 23, `check:authz` 24, `check:tenancy` 19 + 20, `check:readscope` 15 |
| Boot `src/server.js` against an in-memory MongoDB, then SIGTERM (after the startup fix) | started; logged `intelligenceanalysisruns activeKey is unique ✅` and `Indexes verified` |
| `npm run check:all` (after the startup fix: index read-back and boot sweep made non-fatal) | **exit 0 in 421 s**; 88 suites, 0 failed; `check-analysis-runs` 115/0 |
| Docker build and smoke test (see §11) | fixed image builds and serves the analysis; Compose networking not verifiable here |
| `npm run check:analysis`, `npm run check:routers` (after the Docker change; no application code changed) | 115/0, 4/0 |
| `web/`: `npm run build` (`tsc -b && vite build`) | exit 0 |
| `web/`: `npx eslint` on the two changed files | exit 0, no findings |
| `web/`: `npm run i18n:check` | OK — 4,635 keys, 2 languages, 2,650 references |
| `web/`: `npm run check:l10n`, `check:intelui`, `check:pilotui`, `api:check` | 70/0, 21/0, 16/0, OK |

The web checks above were run again against the final tree, with the same
results.

The §8 measurements were taken before five later fixes (an operator's
status URL, `POST /analysis-runs` answering 503 past the retry limit, the
unreadable-report path, whole-number parsing of the `ANALYSIS_*` variables,
and immediate recovery from an interrupted run), none of which is on the
measured path.

Not run: the mobile and desktop suites (neither package changed), the web
`npm run lint` over the whole app (CI documents pre-existing errors there),
any browser, any real deployment, any live Anthropic call (not on this path).
