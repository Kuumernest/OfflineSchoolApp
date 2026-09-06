# 15 — Performance

*Documented commit `be2d2ac`. All figures in the "measured" sections were
produced by running `backend/scripts/check-query-plans.js` during this audit.*

---

## Methodology

`backend/scripts/check-query-plans.js` seeds a realistic dataset into
`mongodb-memory-server`, then does two things for each hot query:

1. **`explain("executionStats")`** — asserts the plan is an `IXSCAN`, not a
   `COLLSCAN`, and records documents returned versus documents and index keys
   examined.
2. **Repeated timing** — records median and worst latency against a declared
   budget.

### Dataset

| Collection | Rows | Note |
|---|---|---|
| Students | 2 000 | across **two** schools, so tenancy filters are exercised |
| Student scores | 16 000 | |
| Attendance | 10 000 | |
| Fee payments | 2 000 | |
| Term results | 6 000 | |

Seed time: **16 395 ms**.

### What this is and is not

It is a **plan and index audit with indicative latencies** on an in-memory
MongoDB, on one machine, with a warm cache and no network. It proves that the
queries are index-served and that no hot path degrades to a collection scan.

It is **not** a production benchmark. A real Atlas deployment adds network
latency, a shared working set, and concurrent load. Treat the millisecond figures
as relative, not absolute.

---

## MEASURED PERFORMANCE

### Query plans — all `IXSCAN`, 0 collection scans

| Query | Returned | Docs examined | Keys examined | Latency |
|---|---|---|---|---|
| The roster query the endpoint really makes (no sort, no limit) | 1 363 | 1 363 | 1 363 | 43 ms |
| One class's roster | 75 | 75 | 75 | 7 ms |
| A pupil by enrolment number | 1 | 1 | 1 | 7 ms |
| One exam's scores for a class | 600 | 800 | 800 | 28 ms |
| One pupil's scores across an exam | 8 | 8 | 8 | 8 ms |
| A term's results for a class, in rank order | 75 | 75 | 75 | 16 ms |
| One class on one day (register) | 75 | 75 | 75 | 7 ms |
| One pupil's term of attendance | 5 | 5 | 5 | 5 ms |
| A family's payment history | 1 | 1 | 1 | 8 ms |
| The day's takings | 100 | 100 | 100 | 8 ms |
| A page of the change feed | 500 | 1 500 | 1 500 | 78 ms |

**Nine of eleven examine exactly what they return** — a 1:1 ratio, which is what
a correctly covered index looks like.

Two do not:

- **One exam's scores for a class** — 800 examined for 600 returned (1.33×). The
  index leads on `examId` and the class filter is applied after.
- **A page of the change feed** — 1 500 examined for 500 returned (**3×**). This
  is the one to watch as data grows; see below.

### End-to-end latency against budget

| Operation | Median | Worst | Budget | Headroom |
|---|---|---|---|---|
| The whole roster, fetched and sorted the way the endpoint does | **77 ms** | 114 ms | 400 ms | 3.5× |
| One class's mark sheet | **25 ms** | 33 ms | 120 ms | 3.6× |
| A term's results for a class | **5 ms** | 9 ms | 120 ms | 13× |
| A page of the change feed | **38 ms** | 50 ms | 250 ms | 5× |

**15 assertions, 15 passed, 0 failed.**

### The change feed's 3× examination ratio

At 500 returned the feed examines 1 500 documents. The keyset filter
`updatedAt > t OR (updatedAt = t AND _id > id)` is expressed as an `$or`, and
MongoDB evaluates both branches. At this data size the cost is invisible — 38 ms
median against a 250 ms budget. At ten times the data it would be the first thing
to profile.

Nothing is broken here and nothing needs changing now. It is recorded so that
whoever profiles a slow sync later starts in the right place.

---

## Why student names are sorted in JavaScript

A deliberate trade, and the reason the roster query above has **no sort and no
limit**.

Names in this system are Cameroonian and bilingual. Sorting them correctly means
locale-aware collation — accented characters ordered as a reader expects, not by
code point. MongoDB can do this with a collation, but a collated sort requires a
matching collated index, and the roster is filtered several different ways.

The implementation therefore:

1. fetches the filtered set index-served (**1 363 docs, 43 ms, `IXSCAN`**), then
2. sorts in JavaScript with locale-aware comparison.

### The cost

**Database-side pagination is given up.** The endpoint cannot `skip`/`limit` in
Mongo, because the correct order is not known until every matching row is in
memory. The whole filtered set is fetched on every roster request.

### Why it is acceptable here, and where the ceiling is

| | |
|---|---|
| Measured at ~1 363 pupils in one school | 77 ms median, 114 ms worst, against a 400 ms budget |
| Growth | fetch time and sort time both grow **linearly** |
| Approximate ceiling before the budget is at risk | around 5 000–7 000 pupils per school — **extrapolated, NOT MEASURED** |

A single school with more pupils than that would need either a collated index
per filter shape, or accepting code-point ordering, or a different pagination
strategy. None of those is needed at the sizes this system targets.

**Correct ordering was chosen over database pagination on purpose.** A parent
looking for their child in a list ordered by byte value experiences that as a
broken product; 77 ms does not.

---

## Indexes

Index coverage is asserted, not assumed: every query in the table above fails its
suite if the plan is not an `IXSCAN`. Index definitions are in
[05-database.md](05-database.md).

Two supporting scripts exist for index problems found in production:
`scripts/fix-enrollment-index.js` and `scripts/fix-payroll-index.js`.
`check-enrollment-index.js` guards the first against regression.

---

## Client-side performance

### Web

| Optimisation | Status |
|---|---|
| Per-route lazy chunks | IMPLEMENTATION VERIFIED — `App.tsx` |
| `manualChunks` splitting React out of the app bundle | IMPLEMENTATION VERIFIED — `vite.config.ts` |
| `sourcemap: false` in production | IMPLEMENTATION VERIFIED |
| React Query caching server state | IMPLEMENTATION VERIFIED |
| Dev watcher excludes `node_modules`, `dist`, `.git` | IMPLEMENTATION VERIFIED — on a synced filesystem every watched path sits behind the sync filter and pre-bundling never finished |

### Mobile

| Optimisation | Status |
|---|---|
| Sync interval widened from 30 s | IMPLEMENTATION VERIFIED — at 30 s a full backfill + pull + quiz sweep ran twice a minute, and on a bad link a failing pull can occupy most of a minute |
| Retry backoff to a 30-minute ceiling | IMPLEMENTATION VERIFIED |
| `_synced_at` column probe cached per table | IMPLEMENTATION VERIFIED |
| iOS foreground bounce handling (permission dialogs, notification shade) | IMPLEMENTATION VERIFIED |
| `linkQuality.js` normalises connection quality to one number | IMPLEMENTATION VERIFIED |

### Desktop

| Optimisation | Status |
|---|---|
| One sync cycle at a time; a second trigger is ignored | IMPLEMENTATION VERIFIED |
| Refused collections dropped for the rest of the cycle | TEST VERIFIED |
| Page and cursor committed in one transaction | IMPLEMENTATION VERIFIED |
| Columns lifted out of the document JSON for filtering | IMPLEMENTATION VERIFIED |

---

## NOT YET MEASURED

Everything below has **no numbers**. Not "probably fine" — unmeasured.

| # | Item | Why it matters |
|---|---|---|
| 1 | **Mid-range Android cold start** | The target device is not a flagship. App start, SQLite open, and first sync on a low-end handset are unknown. |
| 2 | **Electron memory over a working day** | The desktop app is expected to stay open for hours. No memory profile over that period exists. |
| 3 | **Browser behaviour under throttling** | Never tested with network throttling. The 20 `set-state-in-effect` warnings are most likely to show under a slow connection. |
| 4 | **Client-side rendering cost** | React render time for a large roster or mark sheet has never been profiled. The 77 ms is the *server*. |
| 5 | **Concurrent load** | Every measurement is single-client. Nothing is known about 30 teachers marking a register at once. |
| 6 | **Real Atlas latency** | All figures are in-memory MongoDB, no network. Add real round-trip time. |
| 7 | **Sync duration after a long offline period** | A device offline for a fortnight pulls a large backlog. Never measured. |
| 8 | **Initial sync on a new device** | The first full pull has no timing. |
| 9 | **Upload throughput** | 500 MB video uploads on a school connection are untested. |
| 10 | **Report-card generation at scale** | Rendering a whole school's report cards has no timing. |

Items 1–3 are also carried in [19-known-limitations.md](19-known-limitations.md)
as standing production risks.

---

## Reproducing these numbers

```bash
cd OfflineSchoolApp/backend
npm run check:plans
```

Runtime is roughly 60–90 seconds including the seed. It downloads a MongoDB
binary on first run.
