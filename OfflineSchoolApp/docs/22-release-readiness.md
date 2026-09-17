# 22 — Release Readiness

*Branch `ca-assessment`. Each statement below is marked **VERIFIED** (run in
this pass, result recorded), **IMPLEMENTED** (code changed and its own suite
passes), **NOT TESTED** (could not be exercised on this machine, reason
given), **KNOWN LIMITATION**, **PRODUCT DECISION REQUIRED** or **BLOCKER**.*

## 1. Repository state

| | |
|---|---|
| Branch | `ca-assessment` |
| Security checkpoint | `58512df` (authorization hardening) — untouched |
| Also inherited | `e468a0f` (attendance reminder fix, committed before this pass) — untouched |
| New commits, in order | `f46a939` security: finalize temporary password lifecycle · `26dd0a2` docs: document teacher academic read scope · `2cd6199` security: complete production security gate · `ab1479f` test: validate offline sync behavior · `d622813` perf: validate critical API workloads · `6979a5a` build: validate production mobile configuration · this document's commit |
| Working tree | clean after the final commit; nothing pushed |

No commit was reset, rebased or rewritten from `e468a0f` back. (My own
interim commits from this pass were redone once, before anything was pushed,
after a staging helper wrote the wrong package file; the final series above
was verified file by file.)

## 2. Security

Full detail: docs/21-production-security-gate.md.

| Area | Status | Evidence |
|---|---|---|
| Authentication | VERIFIED | bcrypt 12; 15-minute restricted temporary sessions (§3); refresh refuses inactive users, closed schools, stale and flagged accounts; `check-login-response` 42, `check-temp-password-lifecycle` 39 |
| Authorization | VERIFIED | door + capability + relationship helpers; `check-authz-matrix` 24, `check-marks-scope` 65, `check-register-scope` 26, `check-homework-scope` 29, `check-quiz-scope`, `check-teacher-read-scope` 15 |
| Tenant isolation | VERIFIED | `check-school-scope` 58, `check-cross-school`, `check-student-tenancy` 20, `check-announcement-tenancy`, `check-tenant-ids` 53, `check-sync-feed` 61 |
| Application documents | VERIFIED | `/uploads/applications` closed; signed one-hour links; `check-application-documents` 45 |
| Input validation | VERIFIED | one regex path escaped this pass (G5); no injectable filter found; no sort parameters read |
| File handling | VERIFIED with one deployment step | applicant documents closed; message attachments signed, gate in observe mode until `REQUIRE_MEDIA_SIGNATURE=1` (G2, MEDIUM) |
| CORS | VERIFIED | production allow-list required at boot |
| Rate limiting | VERIFIED | login 10/15 min, portal 15/15 min, public application 10/15 min; no global limiter (G10, LOW) |
| Secrets | VERIFIED | pattern scan over tracked files: only placeholders and one synthetic fixture |
| Error handling | IMPLEMENTED | public router fixed sentences; global 500 generic in production (G3) |
| Logging | IMPLEMENTED | no credentials or tokens; `?sig=` redacted from the request log (G4); Sentry scrubs body, cookies, auth header |

Open security items: G2 (deployment step), G6–G10 (LOW), G11–G12 (INFO). No
BLOCKER, no HIGH.

## 3. X21 — temporary-password authentication

**Original issue.** A `mustResetPassword` account received a 15-minute token
and no refresh token, but nothing checked the flag afterwards: the token
opened every protected route for 15 minutes, and `POST /auth/refresh` in its
access-token mode minted another 15-minute token on request, indefinitely.

**Chosen behaviour** (one deterministic lifecycle, IMPLEMENTED):

```
temporary password → sign in
  → 15-minute token, no refresh token, user.mustResetPassword = true
  → RESTRICTED: POST /auth/change-password, GET /auth/me, GET /users/me,
    POST /auth/logout answer; every other route, refresh in either mode
    included, answers 403 PASSWORD_CHANGE_REQUIRED
  → change refused (mismatch, policy, reuse of the temporary password):
    state unchanged
  → change accepted (no current password needed): passwordChangedAt stamped,
    ordinary 30-day token + refresh token returned, flag cleared
  → the temporary token is dead (401 TOKEN_STALE); ordinary refresh lifecycle
```

**Implementation.** `middleware/auth.js` (`PASSWORD_CHANGE_ROUTES`, matched on
method and path); `auth.routes.js` refresh-token mode refuses a flagged
account; web `lib/axios.ts` marks the stored user on the code so `StaffOnly`
routes to `/change-password`; mobile `api.js` raises the password wall the
layout already draws (`/auth/set-password`). Token claims are unchanged (id,
role, schoolId); the flag is read from the database on every request.

**Tests.** `check-temp-password-lifecycle` (39): sign-in shape, the doors,
protected read and write refused, query string and method do not change the
answer, both refresh modes refused, a refresh token from before an
administrator's reset is `REFRESH_STALE`, three refusals leave the state
unchanged, success returns the ordinary tokens and kills the temporary one,
expired temporary token, sign-in again restarts the 15 minutes, a teacher's
temporary token cannot reach the register, logout, a pupil by enrolment
number, an unflagged administrator untouched. Ten existing suites that use
temporary passwords rerun clean.

**Residual risks (KNOWN LIMITATION).** Logout is stateless: a temporary token
stays valid until its 15 minutes end (asserted, recorded). Refresh tokens do
not rotate. Both are future items (docs/21 G6).

## 4. Teacher read scope

Teachers' READS of marks, results, registers and the academic sync
collections are school-wide by capability (`results.view`, `exams.view`,
`attendance.view`); their WRITES are confined to active `TeacherAssignment`
rows (class + subject for marks, class for registers). Intentional, recorded
in docs/20 §7b and §11.7, and pinned by `check-teacher-read-scope`: a
teacher opens another class's sheet, results and register in their school,
never another school's by any route or through the sync feed, and cannot
write to the class they can read. Confining reads to assigned classes is a
**PRODUCT DECISION REQUIRED**, not taken here.

## 5. Attendance notification

Fixed and committed before this pass (`e468a0f`); VERIFIED here by
`check-attendance-reminders` on both sides (backend 19, mobile 33) inside the
full chains.

- Root cause: the dashboard's "attendance not marked" card was a bare count
  routed to the register screen with no class, so the screen opened empty.
- Fix: the server's today-classes carry `classId`, `subjectId`, `periodId`,
  the date and `attendanceMarked`; one reminder per unmarked class opens the
  register for that class, date and period; the screen resolves the route
  against the teacher's canonical scope before loading anything.
- Authorization: unchanged server rule (active class assignment); a stale or
  hand-built route for a class not in scope shows a safe state.
- Edge cases covered: already marked (no reminder), two periods of one class
  (one reminder), unassigned/inactive/cross-school (refused), malformed date
  (today), no class in the route (safe state), offline roster from the phone
  with "not downloaded" distinguished from "no pupils".

## 6. Offline / sync

**Architecture (VERIFIED by reading and by the suites):** SQLite tables →
`mutation_outbox` (a row written before any network attempt; one row per
`entity_key`, later edits coalesce) → `drain()` sends due rows in creation
order with `Idempotency-Key = row id` and `If-Match = base_version` →
server: `middleware/idempotency.js` (scoped per user, in-flight answered
`IDEMPOTENCY_IN_PROGRESS`), route authorization re-applied to every replayed
mutation against current state → response → `_settle` marks the row synced,
runs the entity's reconciler (server ids adopted, cascaded through the id
map), clears the local dirty flag. Retries: exponential backoff 5 s → 30 min,
8 attempts, then failed; 412/409 parked as conflicts for a person;
404/410 on DELETE counts as done.

| Scenario | Status | Where |
|---|---|---|
| A. offline create → reconnect → one send, key attached, local flag cleared | VERIFIED | `check-outbox-drain` |
| B. offline update coalesces onto the pending row, later edit wins | VERIFIED | `check-outbox-drain` |
| C. interrupted mid-batch: the dropped row backs off in place, order kept | VERIFIED | `check-outbox-drain` |
| D. duplicate: same key retried, server answers with the first write | VERIFIED | `check-outbox-drain` + backend `check-idempotency` |
| E. conflict: 412 parked with the server's answer; version stamps | VERIFIED | `check-outbox-drain`, backend `check-conflicts` (policy: last write with a version wins only through a person) |
| F. authentication expiry mid-sync | IMPLEMENTED | 401 / 403 PASSWORD_CHANGE_REQUIRED used to park rows as failed; the drain now stops and leaves them pending (`stopped: "unauthenticated"`), sent after sign-in |
| G. school boundary on replay | VERIFIED | every replayed mutation passes the door and route checks; `check-tenant-ids`, `check-marks-scope`, `check-register-scope` exercise the same routes |
| H. large queue: 500 rows | VERIFIED | one pass, 500 synced, 500 distinct keys, 188 ms against a fake network on this machine |
| I. partial failure: one refused row parked, the others land, releasable | VERIFIED | `check-outbox-drain` |

**Known limitations.** The harness uses a fake server; a true device/network
matrix (airplane mode mid-sync, app killed during drain, re-login on device)
is NOT TESTED here — see the manual matrix in §10. The desktop outbox has its
own suite (`check-outbox`, 57) and engine suite (`check-sync-engine`, 9).

## 7. Performance

Tool: `backend/scripts/perf-critical-paths.js` (not in `check:all`). School:
30 classes × 40 pupils = 1,200 pupils, 2,400 marks, 4,000 register rows,
50 applications; 8 concurrent clients; MongoDB in memory on this developer
machine. No thresholds are defined by the project; figures are recorded, not
graded. Two runs were made: run 1 before the student-list change, while other
suites were running on the machine, and run 2 on the final tree with the
machine otherwise idle. Every path was roughly twice as fast in run 2 (login
p50 4.8 s, refresh 42 ms, results 109 ms, studentScore feed 252 ms), so
compare rows within a run; the table below is run 1 except where marked.

| Path | n | req/s | p50 ms | p95 ms | p99 ms | errors | bytes |
|---|---|---|---|---|---|---|---|
| POST /auth/login (bcrypt 12) | 40 | 0.8 | 10258 | 13365 | 14949 | 0 | 1827 |
| POST /auth/refresh | 120 | 64.8 | 111 | 216 | 230 | 0 | 1827 |
| GET /admin/students?limit=50 — run 1, before paging | 120 | 4.3 | 1056 | 6186 | 6685 | 0 | 81694 |
| GET /admin/students?limit=50 — run 2, after paging | 120 | 48.9 | 156 | 216 | 256 | 0 | 81694 |
| GET /students?search= | 120 | 15.2 | 344 | 2582 | 2626 | 0 | 105018 |
| GET /students/:id | 120 | 50.7 | 145 | 253 | 262 | 0 | 2157 |
| GET /students/teacher/students?classId | 120 | 46.8 | 156 | 273 | 289 | 0 | 34029 |
| GET /attendance/students/today?classId | 120 | 84.6 | 83 | 182 | 187 | 0 | 31265 |
| POST /attendance/students/bulk (40) | 120 | 42.7 | 175 | 272 | 306 | 0 | 57 |
| GET /attendance/report/class/:classId | 120 | 102.7 | 63 | 210 | 264 | 0 | 5409 |
| GET /exams/:id/scores?classId | 120 | 70.9 | 110 | 205 | 285 | 0 | 23276 |
| POST /exams/:id/scores/bulk (40) | 120 | 11.5 | 509 | 1924 | 2075 | 0 | 57 |
| GET /results/:examId (published) | 120 | 27.0 | 210 | 917 | 980 | 0 | 41837 |
| GET /results/:examId/rankings | 120 | 52.7 | 126 | 340 | 394 | 0 | 33323 |
| GET /results/:examId/student/:id/reportcard | 120 | 22.7 | 363 | 534 | 537 | 0 | 1481 |
| GET /exams/dashboard | 120 | 24.0 | 303 | 518 | 541 | 0 | 2061 |
| GET /students/pending (50) | 120 | 47.2 | 171 | 210 | 228 | 0 | 44216 |
| GET /teacher/stats/summary | 120 | 28.1 | 245 | 498 | 566 | 0 | 744 |
| GET /sync/changes (student, 200) | 120 | 34.8 | 182 | 538 | 654 | 0 | 38441 |
| GET /sync/changes (studentScore, 500) | 120 | 13.6 | 523 | 1025 | 1109 | 0 | 292168 |
| GET /admin/stats | 120 | 30.4 | 256 | 420 | 458 | 0 | 663 |

**Findings and actions.**
- `GET /admin/students` fetched every pupil, sorted in memory and sliced:
  1.1 s median / 6.2 s p95 for 50 rows, growing with the school. IMPLEMENTED:
  a database pipeline for paged callers (same filter, same order under an
  English collation, skip/limit, total counted alongside); unpaged callers
  unchanged. Run 2 (VERIFIED): p50 156 ms, p95 216 ms, 48.9 req/s — a
  seven-fold median and 28-fold p95 change against a two-fold machine
  factor; identical bytes, so the same 50 rows come back.
- Login is bcrypt-bound: cost 12 serialises on one Node process, so eight
  simultaneous sign-ins queue behind each other (10 s median here). Not a
  defect; a morning sign-in rush on one core will feel it. Options — a cost of
  11, or running more than one process behind nginx — are a **PRODUCT
  DECISION REQUIRED** (security margin vs. latency).
- `POST /exams/:id/scores/bulk` p95 1.9 s for 40 marks: bulkWrite plus one
  change-log row per mark; acceptable at class size, worth a look at
  school-wide imports.
- `/students?search=` is a regex over nine fields; 2.6 s p95 at 1,200 pupils.
  Index-backed text search is a future item. `check-query-plans` (16) still
  asserts index use on the non-search hot queries.
- No N+1 pattern was found in the measured handlers; the sync feed pages are
  bounded (`MAX_LIMIT`).

## 8. Mobile build

| Item | Status |
|---|---|
| Configuration | IMPLEMENTED: `mobile/eas.json` (development APK on the LAN API, preview APK, production app bundle with remote versioning and auto-increment); `app.json` has package `com.myschoolonthemove.app`, version 1.0.0, icon/splash/adaptive icon, plugins for router, sqlite, secure store |
| `EXPO_PUBLIC_API_URL` | Named per profile in `eas.json`; production and preview hosts are placeholders to fill at build time. A release bundle refuses to start without it (`src/services/api.js`); the LAN fallback applies only when unset in development |
| `expo config --type public` | VERIFIED: resolves without error |
| `expo-doctor` | 18/21 checks pass. Failed: (1) config schema check — needs the Expo API, unreachable from this machine; (2) missing required peer `expo-constants` for `expo-router` — **fixed, declared and locked**; (3) version drift: TypeScript 5.8.3 vs expected ~6.0, `expo` 57.0.12 vs 57.0.23 and 17 other SDK 57 packages a patch behind — **NOT upgraded here**; run `npx expo install --check` on a build machine and rerun the mobile chain |
| EAS build | **NOT TESTED / BLOCKER for a release artifact**: `eas-cli` is not installed, there is no Expo account session, no Android SDK and no Java on this machine. `eas build --profile production --platform android` must run on a machine with an Expo login (cloud build needs no local SDK) |
| Device smoke test | NOT TESTED (no artifact) — checklist in §10 |
| Notification configuration | Not applicable: the app has no push notifications; reminders are in-app cards (§5) |

## 9. Desktop build

| Item | Status |
|---|---|
| Packaging system | electron-builder (`desktop/electron-builder.yml`), NSIS installer + portable exe, Windows x64; web build shipped as `resources/web/dist`, shared modules as `resources/shared` |
| Version | `school-desktop` 0.1.0; appId `com.myschoolonthemove.desktop` |
| `npm run package:dir` | VERIFIED: web built (Vite, 44 s), Electron 44.0.0 fetched, asar packed, `dist/win-unpacked/My School On The Move.exe` (244 MB) produced with `resources/app.asar`, `resources/web/dist/index.html`, `resources/shared/*.js` in the layout `check-request-path` asserts |
| Installer (`npm run package`) | NOT TESTED in this pass (the unpacked directory build is the same pipeline minus NSIS; previous installer artifacts from 28 Aug exist in `desktop/dist`, git-ignored) |
| Clean-machine install and smoke test | NOT TESTED (no clean Windows environment available here) — checklist in §10 |
| Code signing | KNOWN LIMITATION: no certificate; SmartScreen will warn (documented in `electron-builder.yml`) |
| Auto-update | Not implemented, by design; documented as a future item |
| Desktop suites | VERIFIED: all 9 suites pass — route shadowing 6, doc store 51, outbox 57, crash seams 9, sync engine 48, request path 45, and student writes / results / settings (68 assertions between them) |

## 10. Manual test matrix (what automation could not reach)

Mobile, after an EAS build is available:
1. Install the production APK/AAB on a device; sign in online.
2. Temporary-password account: sign in → land on set-password → any other
   screen refused → change → dashboard.
3. Attendance reminder card → register for that class, pupils listed, date
   shown → mark → card disappears.
4. Airplane mode: open attendance, mark a class, open marks; reconnect; sync
   badge clears; verify on the server.
5. Kill the app during a sync; reopen; queue resumes with no duplicates.
6. Let the session expire (or reset the password from the console) while
   rows are queued; sign in again; rows send in order.
7. Open an applicant document from the admissions screen (signed link).
8. Sign out; confirm no cached screen shows another user's data.

Desktop, on a clean Windows machine: install per-user; first run online
(login); offline reads; queue a write offline; reconnect and sync; sign out;
uninstall keeps `%APPDATA%` data.

## 11. Remaining items

**BLOCKERS**
- Mobile release artifact not produced (no EAS credentials/tooling here).
  Configuration is ready; the build must be run and smoke-tested elsewhere.

**HIGH**
- None.

**MEDIUM**
- G2: set `REQUIRE_MEDIA_SIGNATURE=1` one signature lifetime (7 days) after
  deploying signed attachment URLs.
- Mobile dependency drift (18 SDK 57 patches, TypeScript major): upgrade on
  a build machine, rerun `npm run check`.

**LOW**
- G6 refresh-token rotation and token revocation on logout.
- G7 security headers on nginx `location /` for the web console.
- G8 content-based (magic-byte) validation of application uploads.
- G9 least-privilege database user for the compose deployment.
- G10 global rate limit on authenticated routes.
- Perf: index-backed search for `/students?search=`.
- Load-induced flake: `smoke-bursar-path` failed once while running
  alongside seven other suites and passed alone and in both full chains.

**PRODUCT DECISIONS REQUIRED**
- Teacher READ scope (§4).
- bcrypt cost / process count for login latency (§7).
- Public re-application after rejection still updates the rejected record
  (docs/20 §11.4 residual).

**FUTURE PRODUCT WORK**
- Desktop auto-update and code signing.
- Push notifications (none exist; reminders are in-app).

## 12. Validation, final tree

All four chains were run on the final tree (the commit before this
document), in this order and with these results:

| Chain | Command | Result |
|---|---|---|
| Backend | `npm run check:all` (58 scripts, 59 suites) | exit 0 · 3,883 assertions passed · 0 failed |
| Web | `tsc --noEmit`, `eslint`, `vite build`, `check:normalisers`, `check:roles` | 0 type errors · 0 lint errors (1 pre-existing React Compiler warning) · built in 16.9 s · 4 + 31 assertions passed |
| Desktop | `npm run check` (9 suites) | exit 0 · 284 assertions passed · 0 failed |
| Mobile | `npm run check` (13 suites + i18n, l10n, lint, types) | exit 0 · 504 assertions passed · 0 failed · 5,371 keys × 2 languages · 0 lint errors (49 pre-existing warnings) |

New suites in this pass and their counts: `check-temp-password-lifecycle` 39,
`check-teacher-read-scope` 15, `check-outbox-drain` 37 (mobile). The
performance script is run separately (§7); its second run, after the student
list change, is recorded in §7.

`git diff --check` is clean; `git status --short` is empty after the final
commit. Nothing has been pushed.
