# 19 — Known Limitations and Production Risks

*Documented commit `be2d2ac`.*

This document contains **only** items that are unresolved or genuinely
unverified at this commit. Nothing here is speculative, and nothing verified has
been left in to pad the list. If an item is not here, it is either working or
documented elsewhere as working.

---

## A. Blocking — fix before deployment

### A1. The web console is not served by the bundled Docker stack — CONFIRMED DEFECT

**New finding from this audit.** Three verified facts:

1. The Dockerfile copies the web build to `/app/public/web` **inside the backend
   image**.
2. `backend/src/server.js` has exactly one `express.static` call, serving
   `src/uploads`. **Nothing serves `public/web`.**
3. `nginx.conf`'s `location /` uses `root /app/public/web`, but the `nginx`
   service in `docker-compose.yml` mounts **only** `./nginx.conf`.

`GET /` on the Compose stack returns nginx's 404. The API and `/uploads/` work.

**Fix:** mount the build into nginx, or serve it from Express and point
`location /` at the backend. Keep `try_files … /index.html` either way.

### A2. Production credentials have not been rotated

The credentials in the working `.env` are development credentials. `MONGODB_URI`
(including the Atlas password), `JWT_SECRET`, `JWT_REFRESH_SECRET` and any mail
credentials must all be rotated.

Rotating `JWT_SECRET` invalidates every issued token — intended.

*Explicitly out of scope for this audit at the user's instruction; `.env` was not
read, edited or included anywhere.*

### A3. `ALLOWED_ORIGINS` must be set

Required in production; the backend refuses to start without it. Must list the
real console origins including scheme and port.

### A4. `EXPO_PUBLIC_API_URL` must be set for the mobile build

Inlined at build time. A release built without it has no server to talk to.
There is no `eas.json` in the repository — production mobile build configuration
lives outside this repo and is **NOT CONFIGURED HERE**.

### A5. No TLS in the bundled configuration

`nginx.conf` listens on port 80 only. A TLS terminator must sit in front.
`X-Forwarded-Proto` is already forwarded and `trust proxy` is set in production,
so the app is ready for one — but nothing here provides it.

---

## B. Data remediation outstanding

### B1. Results published before the lock check existed

One edit path did not check `isLocked`/`isPublished`, so a published report card
could change under a family with no record. The check is present now. **Results
published before it was added were never re-processed.**

Use `resultStaleness.service.js` to identify published results whose inputs have
since moved, then follow runbook 13 in
[18-operations-troubleshooting.md](18-operations-troubleshooting.md).

Reprocessing changes **class, school and grade positions for every pupil in the
class**, not only the corrected one. Tell the school before doing it — families
have paper.

---

## C. Unverified — no measurement exists

These are not "probably fine". They are unmeasured.

| # | Item | What is unknown |
|---|---|---|
| C1 | **Two real devices synchronizing against each other** | Every multi-device claim in this documentation rests on simulated clients against an in-memory MongoDB. No two physical devices have been converged. |
| C2 | **Mid-range Android cold start** | The target device is not a flagship. App start, SQLite open and first sync on a low-end handset have never been timed. |
| C3 | **Electron memory over a working day** | The desktop app is expected to stay open for hours. No memory profile over that period exists. |
| C4 | **Throttled-browser behaviour** | Never tested under network throttling. The 20 `set-state-in-effect` errors are most likely to surface there. |
| C5 | **Concurrent load** | Every performance figure is single-client. Nothing is known about 30 teachers marking a register simultaneously. |
| C6 | **Real Atlas latency** | All measurements are in-memory MongoDB with no network. |
| C7 | **Sync after a long offline period** | A device offline for a fortnight pulls a large backlog. Never measured. |
| C8 | **Initial sync on a new device** | The first full pull has no timing. |
| C9 | **Upload throughput** | 500 MB video uploads on a school connection are untested. |
| C10 | **Report-card generation at scale** | Rendering a whole school's report cards has no timing. |
| C11 | **Penetration test** | None performed. |
| C12 | **Dependency vulnerability audit** | `npm audit` runs nowhere in CI. |
| C13 | **Atlas network configuration** | IP allowlist, TLS settings and database user privileges are outside this repository and were not reviewed. |

---

## D. Incomplete implementations

| # | Item | Status |
|---|---|---|
| D1 | **Teacher attendance has no change log.** `POST /api/attendance/teachers/bulk` is a near-copy of the student route and does not write `AttendanceChangeLog`. Staff register overwrites leave no trace. | `PARTIALLY IMPLEMENTED` |
| D2 | **`/sync/pull` never propagates deletions.** `data.deletedItems` is always `[]`. A record soft-deleted on the server stops being sent; the device's copy stays until something overwrites it. | `PARTIALLY IMPLEMENTED` |
| D3 | **Mobile `SCHEMAS` map covers 8 of ~40 tables.** The rest still use inline `CREATE TABLE` in their owning service — the drift the map was written to end. | `PARTIALLY IMPLEMENTED` |
| D4 | **`KNOWN_GAPS`: a bursar cannot mirror `user`.** They hold `payroll.view` but not `users.manage`, so payslips would mirror without staff names. The desktop declines that view rather than showing a payroll with every name blank. Closing it needs the feed to be able to say "names, not the account directory". | `PLANNED` |
| D5 | **`KNOWN_GAPS`: a teacher cannot mirror `class`, `subject`, `teacherAssignment`.** No capability grants them. Their screens read through `/api/teacher` and `/sync/pull` instead. | Acknowledged, by design at this commit |
| D6 | **WhatsApp delivery.** `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are read by the code, are absent from `.env.example`, and there is no evidence of a working delivery path. | `NOT IMPLEMENTED` — treat as such until proven |
| D7 | **`annualAverageMethod: "sequences"`** is implemented but has no end-to-end suite. `"terms"` is the exercised path. | Untested branch |
| D8 | **`maxAbsences`** exists as a field; its effect on promotion decisions is not covered by any suite. | Untested |

---

## E. Dead and unreachable code

| # | Item | Status |
|---|---|---|
| E1 | **`POST /api/sync/push`.** Implemented server-side with `requirePermission("sync.push")`, plus `pushChanges` → `pushPeriodChanges` / `pushStudentDecisions`. Declared in `mobile/src/services/apiEndpoints.js` and `web/src/services/apiEndpoints.ts` and **invoked by nothing**. Verified by searching all four clients for the endpoint and its payload shape. A live, permission-gated write path with no caller and no test coverage. | `UNUSED / DEAD CODE` |
| E2 | **`backend/scripts/check-student-integrity.js`.** A real suite wired into no npm script. Nothing runs it, so nothing knows whether it still passes. | `UNUSED` |
| E3 | **`GET /api/admin/debug/counts`.** A diagnostic endpoint shipping enabled, gated on `dashboard.view`. | Remove or gate before public deployment |
| E4 | **Stale comment in `teacher.routes.js`** referring to `middleware/upload.js` as though it exists. That file was removed at an earlier commit. | Harmless, misleading |
| E5 | **Doubled exam paths** — `/reports/results`, `/submissions/results`, `/submissions/submissions`. They register handlers and resolve, but look like historical aliases. | Audit before treating as API |

---

## F. Security limitations — verified, unresolved

Repeated from [14-security.md](14-security.md) because they are production risks.

| # | Limitation |
|---|---|
| F1 | **No token revocation list.** A stolen access token is valid up to 30 days. Deactivating the account is the only revocation, and it works from the next request. |
| F2 | **Tenancy is application-level only.** One database, one connection. A new route that forgets `resolveSchoolId` leaks across schools; only the check suites catch it, and only on covered paths. |
| F3 | **Message attachments use a blocklist, not an allowlist.** `.svg` and `.html` are permitted and served from the API origin. Mitigated by helmet's CSP and, when enabled, the signature gate — but the teacher-content path guards the same directory with an allowlist, so the two disagree. |
| F4 | **`REQUIRE_MEDIA_SIGNATURE` is off by default.** Message attachment URLs are reachable by path until it is switched on. |
| F5 | **CORS reflects any origin outside production.** A public staging host left at `NODE_ENV != production` accepts requests from anywhere. |
| F6 | **`/uploads` sets `Access-Control-Allow-Origin: *`** with no `Content-Disposition: attachment`. Files render inline cross-origin. |
| F7 | **Portal codes are ~39 bits.** Safe only because of the 6-attempt / 15-minute lockout. Widening or removing that lockout makes them brute-forceable. |

---

## G. Quality backlog

| # | Item |
|---|---|
| G1 | **Web lint: 34 errors, 31 warnings** — measured at this commit. 20 are `react-hooks/set-state-in-effect`. `npm run lint` is deliberately **not** blocking in CI. |
| G2 | **The CI comment says "35 pre-existing errors"** — the measured figure is 34 errors and 31 warnings. Marginally stale. |
| G3 | **The CI comment says the desktop job runs "eight suites"** — the `check` chain runs **nine**. Marginally stale. |
| G4 | **No `engines` field** in `backend/package.json`. CI uses Node 20; nothing enforces it for a deployer. |
| G5 | **`backend` has no `test` script** — `npm test` exits 1. All verification is `npm run check:all`, which is not the conventional entry point a new contributor will try. |
| G6 | **Build artefacts committed to the working tree** — `mobile/eslint-log.txt`, `mobile/mobile-check-log.txt`, `web/build-log.txt`, `desktop/probe-log.txt`, `desktop/smoke-log.txt`, `desktop/seam-result.txt` and ~25 scratch `.txt` files at the repository root. |
| G7 | **The older `docs/ARCHITECTURE.md`, `API.md`, `DATA_MODEL.md`, `SETUP.md`** predate this package (2026-09-04) and are not maintained by it. They may drift. |

---

## Resolved during this audit — no longer risks

Recorded so they are not re-reported.

| Item | Where it is documented |
|---|---|
| Unsynchronized exam scores were invisible to teachers | [07-mobile.md](07-mobile.md) — `syncState.js`, 28 assertions |
| Attendance overwrites left no trace | [11-conflict-resolution.md](11-conflict-resolution.md) — `AttendanceChangeLog`, 21 assertions |
| The one-millisecond hole in the `/sync/pull` cursor | [10-synchronization.md](10-synchronization.md) — `$gte`, not `$gt` |
| Cross-school reads through a `schoolId` parameter | [06](06-authentication-authorization.md) — one `resolveSchoolId` |
| `changeReason` had no UI on either client | [12](12-academic-workflows.md) |
| The desktop cursor could skip a document that failed to store | [08-desktop.md](08-desktop.md) |
| `idem_key` doing two incompatible jobs, discarding edits | [08-desktop.md](08-desktop.md) — migration 2 |

---

## Summary

```text
BLOCKING BEFORE DEPLOYMENT ......... 5   (A1 web console, A2 credentials,
                                          A3 ALLOWED_ORIGINS, A4 EXPO_PUBLIC_API_URL,
                                          A5 TLS)
DATA REMEDIATION OUTSTANDING ....... 1   (B1 previously published results)
UNVERIFIED — NO MEASUREMENT ....... 13   (C1–C13)
PARTIALLY IMPLEMENTED .............. 8   (D1–D8)
DEAD / UNREACHABLE ................. 5   (E1–E5)
SECURITY LIMITATIONS ............... 7   (F1–F7)
QUALITY BACKLOG .................... 7   (G1–G7)
```

**The code at this commit passes every gate it defines** — 39 backend suites,
3 mobile, 9 desktop, 3 web, 0 failures. That is a statement about the suites, not
a statement of production readiness. A1 through A5 are unresolved, and C1 through
C13 have never been measured.
