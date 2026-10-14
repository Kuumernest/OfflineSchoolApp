# 32 — Stage 18A: System Bug & Performance Audit

An audit of the repository as it stood after Stage 18, before any real-school
pilot is opened. Bug-finding, fixing, security, data integrity and
performance. No intelligence stage, rule, threshold, gate or engine version
changed. Real-world validation remains pending: everything below is technical
verification on synthetic data, plus a read-only preflight against the one
authorised school.

## Baseline

| | |
|---|---|
| Branch | `ca-assessment` |
| Commit | `6c93b37` (Stage 18 + the two terminology commits), level with `origin` |
| Working tree | clean |
| Suites on disk | backend 85 check scripts (`check:all` reaches 84; `check-anthropic-live.js` is opt-in), web 8, mobile 18, desktop 11 |

## What was run

- Backend `check:all` expanded script by script (so one failure hides
  nothing): 57 scripts before the fixes, 5,427 assertions, 0 failures;
  `check:brevo` skipped for want of credentials, `check:mail` ran and passed.
- `verify-advanced-runtime.js`: the real `src/server.js` as a child process,
  live Anthropic on synthetic fixtures, a stand-in Anthropic answering
  401/403/404/429/hang/junk/junk-shape/dropped socket, the provider off, and
  a scan of every tracked file for configured secrets.
- `check-anthropic-live.js` three times for latency samples.
- `check-query-plans.js` (index use, explain plans): 16/16.
- `perf-critical-paths.js` (30 classes, 1,200 pupils, 8 concurrent).
- A new probe, now committed as `check-input-hardening.js`: 515 routes across
  36 mounts, six callers, malformed ids, bodies, JSON and query strings,
  10,680 requests; the only assertion is that nothing answers 5xx, drops
  the socket, takes over five seconds or leaves an uncaught exception.
- An intelligence perf pass (30 classes × 40 pupils, four published
  sequences × six subjects): per-request database query counts and latency
  percentiles for every intelligence, review, pilot and operator endpoint.
- Web: `tsc -b`, `eslint`, `vite build`, `i18n:check`, `check:l10n`, roles,
  normalisers, intelligence UI, pilot UI, layout. Mobile: the full `check`
  chain (20). Desktop: the full `check` chain (11, 270 assertions).
- The real-school preflight, read-only, against the configured database
  (counts only; no pupil named).

## Findings and fixes

### P1 — the server process exits on the pupil announcements route

`GET /api/announcements/student` registered a `finish` listener that called
`res.removeHeader` after the body was on the wire. Node throws
`ERR_HTTP_HEADERS_SENT` from there; an exception in a `finish` listener is
uncaught, and `server.js` answers `uncaughtException` with `process.exit(1)`.
Any authenticated caller could stop the server with one request. No shipped
client calls the route today (the mobile app reads announcements elsewhere),
which is why no suite had tripped it. **Fixed** by removing the listener —
a 304 was already impossible, the conditional request headers are deleted
before the query and `no-store` is set. Regression:
`check-announcement-tenancy.js` (a pupil reads, the response finishes with
no uncaught exception) and `check-input-hardening.js`.

### P1 — live ≠ offline on the real school: the offline contract dropped the grade letter

The real-pilot preflight's `consistencyOperational` check failed for every
sampled pupil at the authorised school: 28 differences each, all at
`profile.subjects[i].marks[j].grade` — the live loader carries the letter
the school graded, `cohortFromDocuments` and `toEngineInput` dropped it.
Same class as the `isPassing` finding in docs/25 §12, invisible on fixtures
because fixture marks carried no letter. **Fixed at the mapping**, in both
directions, with the field validated as a short string or null; the engine
was not touched (it copies `row.grade` as evidence; it is an input to no
rule). Regression: `check-pilot-readiness.js` now stores a letter on every
fixture mark and asserts it survives documents → file → engine input. The
preflight against the real school now reads `TECHNICAL: READY`,
`status: AWAITING_ATTESTATION`.

### P2 — 33 routes answered 500 to malformed input

The probe found 500s for: a malformed id where a model expects an ObjectId
(mongoose `CastError`), a NUL byte in a search string (driver `BSONError`),
a negative page (`skip` below zero, `MongoServerError` code 2), `term=abc`
or a missing term cast to `NaN`, an invalid date on the expenses filter, a
non-string `classId` on the public application, and a `GET` reading
`req.body.schoolId` off an undefined body (periods, operator with no school
named). None corrupted anything; in production the message is generic, in
development it named models and fields. **Fixed**: the global error handler
maps `CastError`, `BSONError`, BadValue and NUL-byte errors to 400
("Invalid request value"); paging guards on eight list routes; `term`
validated on six routes; dates validated on the expenses filter; NUL bytes
stripped in the five `escapeRegex` helpers; the public application's
`classId` type-checked; the periods resolver reads `req.body?.schoolId`.
Two legacy teacher routes answer 503 by design ("model not available") and
are allow-listed by name in the check.

### P2 (performance) — the school-wide review queue at a thousand pupils

`GET /insights/review-cases` (head), `calibration-summary` and
`pilot/preflight` each run `analyse()` over the whole school; its
sensitivity sweep runs the entire engine forty times (ten thresholds × four
deltas). At 1,200 pupils: 17.5 s, 7.7 s and 6.7 s per request, and the
head's pilot page asks for all three in a row over the same cohort.
**Fixed** without touching the engine or the sweep: the engine input is
built once per analysis instead of once per run, and the analysis report is
memoised for two minutes under a SHA-1 of the cohort it was computed from
(a changed mark changes the digest; a stale report cannot be served; six
entries at most). Output hash before and after: identical
(`cfa9b85e…`). After: review queue 2.6 s (0.5 s in-process once warm, the
rest is four concurrent CPU-bound requests queueing), calibration summary
0.8 s, preflight 2.3 s; the teacher's class queue 961 ms → 67 ms. The first
cold analysis of a 1,200-pupil school still costs about six seconds; the
pilot school has 70 pupils, where it is well under a second.

### P3 — test and tooling defects

- `verify-advanced-runtime.js` phase D scanned every tracked file for the
  script's own verification constant and therefore always flagged itself.
  Now scans for configured secrets and real key shapes only. 35/35.
- The web toast for advancing a pilot used `intelReview.pilot.advanced`,
  which Stage 18 turned into an object (the explanation-layer counts), so
  `i18n:check` failed and the toast would have shown a key. Restored as
  `advanced_ok` with the pre-Stage-18 wording in both languages.

### Findings not fixed here (documented)

- **Seeded test pupils in the real school's database** (operational, not
  code). 56 of 70 pupils match the enrollment pattern of
  `seed-form1-students.js`; 96 of 100 published results and 29 of 30
  review cases are theirs; 7 of the 53 seeded accounts still carry the
  script's default password. Before any real pilot these accounts must be
  removed or deactivated and the preflight re-read; the automatic evidence
  gate cannot tell them from real pupils.
- **Login under concurrency.** `bcryptjs` at cost 12 is pure JavaScript and
  blocks the event loop; eight simultaneous logins give p50 4.9 s and stall
  every other request meanwhile. Not a defect and not changed (a security
  parameter); the native `bcrypt` package would move the work to the thread
  pool at the same cost. Worth a decision before a school of a thousand.
- **Duplicate reads inside one intelligence request.** `intelligence-summary`
  and `explain` issue ~50 queries: the eight loaders each re-read the same
  academic history, grading config and pupil (`resultsummaries.find` ×4,
  `gradingconfigs.findOne` ×4). ~100 ms warm, p95 0.95 s at four concurrent.
  A request-scoped memo would halve it; left alone as an architectural
  change with no pilot impact.
- **Unbounded `limit` on list routes** (`?limit=999999` is honoured). Not
  reduced, since a cap is a contract change; noted for the API owner.
- **One intermittent assertion.** `check-pilot-readiness.js` scans the
  evidence snapshot with `/…|16|…/` (a mark must not appear); with four
  suites sharing the CPU it matched once and passed on every solo run
  (five of five). Left as is, noted as fragile.
- **Legacy teacher routes** `POST /teacher/homework` and `/teacher/quizzes`
  answer 503 "model not available"; no client calls them.

## Security

- No tracked file carries a configured secret or a real key shape;
  `backend/.env` is ignored; only `.env.example` files are tracked.
- Anthropic credentials live only in the server's environment; the audit
  block carries provider and model names, never the key; the request
  carries a name-free evidence context, the question wrapped as untrusted
  data, and no tool.
- Logs: token refreshes log the user id only; no JWT, refresh token,
  password or key is logged (`check-login-response.js`,
  `check-brevo-email.js`, phase D).
- Authorization is at the service boundary: the access matrices,
  cross-school, school-context, operator-selection, teacher-scope,
  reviewer-privacy and real-pilot suites all pass; "selecting nothing is not
  selecting everything" is asserted for the operator.

## Performance (synthetic school, 30 classes, 1,200 pupils)

| Endpoint | Before | After | Notes |
|---|---|---|---|
| GET insights/review-cases (head, whole school) | 17,539 ms | 2,573 ms warm; p95 2,882 ms at 4 concurrent | first cold analysis ~6 s |
| GET insights/calibration-summary (head) | 7,705 ms | 830 ms | |
| GET insights/pilot/preflight (head) | 6,712 ms | 2,340 ms | two cohort reads + three consistency runs |
| GET insights/review-cases?classId (teacher) | 961 ms | 67 ms | |
| GET student/:id/intelligence-summary | 100 ms | 106 ms (p95 949 ms at 4 concurrent) | 51 queries; unchanged |
| GET student/:id/strengths, development, guidance | 40–90 ms | unchanged | 15 queries |
| POST auth/login (8 concurrent, bcrypt 12) | p50 4,880 ms | unchanged | see above |
| GET students, attendance, exams, results, report card, sync | p95 60–480 ms | unchanged | `perf-critical-paths.js` |

Anthropic (live, synthetic fixture, `claude-sonnet-5`): round trips 14.7 s,
16.0 s, 19.9 s; every question type `MODEL_VALIDATED`; every failure mode
classified and answered deterministically (`401/403 → PROVIDER_AUTH`,
`404 → MODEL_UNAVAILABLE`, `429 → PROVIDER_QUOTA`, hang → `PROVIDER_TIMEOUT`,
junk → `INVALID_RESPONSE`, wrong shape → `VALIDATION_FAILED`, dropped socket
→ `PROVIDER_UNAVAILABLE`).

## Regression after the fixes

| | |
|---|---|
| backend `check:all` (+ `check:inputs`) | 58 scripts: 57 passed on the parallel run, `check:brevo` skipped (credentials); `check:intel` tripped one assertion under load and was re-run alone: 22 scripts, 1,377 assertions, 0 failures. Whole run ≈ 5,430 assertions, 0 failures on a clean pass |
| `verify-advanced-runtime.js` | 35 passed, 0 failed (live, mocked, offline, secrets) |
| web | `tsc -b` clean; `eslint` 0 errors (1 pre-existing warning); `vite build` ok; i18n 4,621 keys; l10n 70; roles 31; normalisers 4; intelui 16; pilotui 16; layout 60 |
| mobile | 20/20 (lint 0 errors, 49 pre-existing warnings; types; i18n; l10n; intelligence client) |
| desktop | 11/11, 270 assertions |
| engines | all eleven versions unchanged; `shared/` untouched |

## Real pilot impact

Blocking, unchanged by this audit: the school's evidence is seeded test
pupils; the open synthetic pilot must be closed; four attestations and the
notice/retention confirmations are unsigned. Removed by this audit: the
technical gate (live = offline) now passes on the real school.

```
SYSTEM AUDIT: TECHNICALLY VERIFIED
REAL-WORLD VALIDATION: STILL PENDING
```
