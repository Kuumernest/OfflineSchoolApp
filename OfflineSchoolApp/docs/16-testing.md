# 16 — Testing and Quality Assurance

*Documented commit `be2d2ac`. Every total below was produced by **running** the
suites during this audit, not read from an earlier report.*

---

## The testing philosophy

There is **no Jest, no Mocha, no Vitest** anywhere in this repository. The check
suites are plain Node scripts that boot a real environment and assert against it.

Backend suites start `mongodb-memory-server` and mount the **real routers** —
they exercise the actual middleware chain, the actual permission guards and the
actual Mongoose models. Desktop suites open a real `node:sqlite` store. Mobile
suites parse and evaluate the real modules.

Assertions are written as prose, `ok(...)` / `bad(...)`, so a failure reads as a
sentence:

```text
ok   a replay with the same key records one payment, not two
FAIL the overwritten value is recoverable
```

### The governing principle

> Every fixed production defect should have a regression test capable of
> demonstrating the previous failure.

Applied literally: a new suite is checked by **reverting the fix and confirming
the suite fails**. Two worked examples from this commit:

| Suite | Against the previous commit |
|---|---|
| `check-attendance-history.js` (21) | **7 fail**, including *"the overwritten value is recoverable"* |
| `check-sync-state.js` (28) | **6 fail**, including *"the marks sheet asks for it"* |

### The trap this codebase names explicitly

**Vacuous assertions.** A check that passes because its fixture collection is
empty proves nothing. Several suites were found doing exactly that and were
tightened to require a fixture be reachable by its rightful owner *before*
asserting that someone else cannot reach it.

---

## Backend — 39 suites, 2 655 assertions

```bash
cd OfflineSchoolApp/backend
npm run check:all      # exit 0 at this commit
```

Listed in execution order, with counts measured by pairing the expanded
`check:all` chain against the suite output:

| # | Suite | Assertions | Covers |
|---|---|---|---|
| 1 | `check-role-matrix.js` | 90 | every role's effective permissions |
| 2 | `check-communication-policy.js` | 67 | who may message whom |
| 3 | `check-email-transport.js` | 33 | mail transport |
| 4 | `check-report-card.js` | 115 | report-card assembly and rendering |
| 5 | `check-template-repair.js` | 92 | report-template repair |
| 6 | `check-approvals.js` | 42 | approval thresholds and decisions |
| 7 | `check-admin-guards.js` | 6 | admin route guards |
| 8 | `check-fee-reminders.js` | 71 | overdue reminders |
| 9 | `check-staff-lifecycle.js` | 41 | staff creation, deactivation, reset |
| 10 | `check-login-response.js` | 42 | what login returns, and does not |
| 11 | `check-sync-feed.js` | 59 | feed gating, model classification |
| 12 | `check-announcement-tenancy.js` | 17 | announcement tenancy |
| 13 | `check-student-tenancy.js` | 20 | student tenancy |
| 14 | `check-idempotency.js` | 41 | replay protection |
| 15 | `check-desktop-parity.js` | **1 346** | the desktop/server contract |
| 16 | `check-term-annual-cards.js` | 81 | term and annual report cards |
| 17 | `check-coefficients.js` | 37 | subject coefficients |
| 18 | `check-term-compute.js` | 21 | term computation |
| 19 | `check-homework-submission.js` | 18 | homework |
| 20 | `check-attendance-dashboard.js` | 21 | attendance reporting |
| 21 | `check-messaging-integration.js` | 73 | staff messaging |
| 22 | `check-portal-messaging.js` | 15 | guardian messaging |
| 23 | `check-portal-gate.js` | 10 | portal access boundaries |
| 24 | `check-message-search.js` | 12 | search, incl. parent-via-child |
| 25 | `check-enrollment-index.js` | 8 | enrolment uniqueness |
| 26 | `check-orphans.js` | 6 | orphaned records |
| 27 | `check-hourly-payroll.js` | 30 | hourly pay |
| 28 | `check-salary-edit.js` | 18 | salary edits |
| 29 | `check-student-results.js` | 13 | a student's own results |
| 30 | `check-student-classnames.js` | 13 | class names on student pages |
| 31 | `check-result-classnames.js` | 8 | class names on results |
| 32 | `check-authz-matrix.js` | 24 | route-level authorization |
| 33 | `check-cross-school.js` | 15 | cross-tenant reads and writes |
| 34 | `check-duplicate-money.js` | 10 | payment duplication |
| 35 | `check-conflicts.js` | 23 | conflict resolution |
| 36 | `check-attendance-history.js` | 21 | register change history |
| 37 | `check-sync-cursor.js` | 21 | cursor correctness |
| 38 | `check-query-plans.js` | 15 | index usage + latency budgets |
| 39 | `smoke-bursar-path.js` | 60 | an end-to-end bursar journey |
| | **Total** | **2 655** | **39 suites, 0 failures** |

`check-desktop-parity.js` alone contributes **1 346** — more than half the total.
It walks the desktop/server contract field by field, which is exactly the kind of
comparison that produces many small assertions. **Suite count is the better
measure of breadth; the assertion total is dominated by one suite.** Excluding it,
the other 38 suites contribute 1 309.

Spot-checked directly (`node scripts/<suite>.js`) for suites 7, 8, 15, 16, 34 and
36 to confirm the positional pairing is not off by one.

---

## Mobile — 3 suites, 84 assertions

```bash
cd OfflineSchoolApp/mobile
npm run check          # exit 0, 0 lint errors
```

Chain: `check-id-map.js` → `check-sync-state.js` → `check.js` →
`eslint app src` → `tsc --noEmit`.

| Suite | Assertions | Covers |
|---|---|---|
| `check-id-map.js` | 11 | local→server id rewriting, route-word safety |
| `check-sync-state.js` | 28 | the pending/failed/orphaned classifier **and that a screen calls it** |
| `check.js` | 45 | every file parses; `en`/`fr` locale parity; every `t()` resolves |
| `eslint app src` | — | **0 errors** |
| `tsc --noEmit` | — | clean |
| **Total** | **84** | 0 failures |

The ESLint step catches what the other two cannot: hooks called from plain
helpers, and identifiers used but never imported. Both crash only at runtime —
the parse check and `tsc` stay green on them, and this is the step that keeps the
admin-dashboard class of failure off a device.

---

## Desktop — 9 suites, 216 assertions

```bash
cd OfflineSchoolApp/desktop
npm run check          # exit 0
```

| Suite | Assertions | Covers |
|---|---|---|
| `check-route-shadowing.js` | 6 | no handler shadows another |
| `check-doc-store.js` | 51 | the document store |
| `check-outbox.js` | 57 | queueing, dedupe, backoff, blocking |
| `check-crash-seams.js` | 9 | crash points in the sync loop |
| `check-sync-engine.js` | 48 | cursors, refusals, in-flight cycles |
| `check-request-path.js` | 45 | route matching, shared-module resolution when packaged |
| `check-student-writes.js` | `REAL STORE: ALL PASS` | student writes against the real store |
| `check-results.js` | `ALL PASS` | results |
| `check-settings.js` | `ALL PASS` | settings |

The last three report a verdict rather than a count, which is why 216 covers six
suites and not nine.

`npm run check:coverage`, `check:seam` and `check:probe` exist and are **not** in
the `check` chain — they require Electron.

---

## Web

```bash
cd OfflineSchoolApp/web
npm run build           # tsc -b && vite build — blocking in CI
npm run i18n:check      # blocking in CI
npm run check:normalisers  # blocking in CI
npm run lint            # NOT blocking — 34 errors, 31 warnings
```

There is no assertion-count test suite for the web app. Its gates are the type
check, the parse-everything build, locale parity, and the normaliser check.

`check:normalisers` exists because `tsc` cannot see this class of bug: an optional
field left unassigned still satisfies the type. `normaliseClass` dropped the class
teacher that way, and the Edit Class dialog then showed every form master as
unassigned and cleared the real one on save.

---

## Cross-package suites

Two scripts in `OfflineSchoolApp/scripts/` span three packages and belong to no
`package.json`:

```bash
node OfflineSchoolApp/scripts/check-class-form-syntax.js
node OfflineSchoolApp/scripts/check-desktop-class-create.js
```

They were running **nowhere** for exactly that reason — no package owns them, so
no `npm run check` picks them up, and a check nothing runs rots into a check that
lies. CI now runs them inside the mobile job, whose `npm ci` provides the only
dependency either has.

---

## Continuous integration

`.github/workflows/ci.yml`, on push to `master` and every pull request. Node 20,
four parallel jobs.

| Job | Steps |
|---|---|
| **backend** | `npm ci` → `npm run check:all` |
| **mobile** | `npm ci` → `npm run check` → the two cross-package scripts |
| **web** | `npm ci` → `npm run build` → `i18n:check` → `check:normalisers` |
| **desktop** | `npm ci` (with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`) → `npm run check` |

`npm run lint` in the web job is deliberately absent, with a comment explaining
why. **Note:** that comment cites *"35 pre-existing errors"*; the measured figure
at this commit is **34 errors and 31 warnings**. The comment is marginally stale.

The desktop job's comment says *"Eight suites"*; the `check` chain actually runs
**nine**. Also marginally stale.

---

## Totals at this commit

```text
Backend    39 suites   2 655 assertions   0 failures
Mobile      3 suites      84 assertions   0 failures   0 lint errors
Desktop     9 suites     216 assertions   0 failures
Web         3 gates      build + i18n + normalisers — all pass
```

**Combined: 51 suites, 2 955 counted assertions**, plus three unweighted web
gates and three desktop pass/fail suites.

---

## Gaps in coverage

| Gap | Detail |
|---|---|
| `check-student-integrity.js` | A real suite wired into **no npm script**. Nothing runs it. |
| Web has no assertion suite | Only type-check, build, i18n and normaliser gates. |
| `POST /api/sync/push` | Implemented, permission-gated, **no client and no suite**. |
| Teacher-attendance change history | Not implemented, so nothing tests it. |
| `annualAverageMethod: "sequences"` | Implemented; no end-to-end suite. |
| `maxAbsences` effect on promotion | Implemented as a field; not covered. |
| Real multi-device convergence | Every multi-device result is simulated clients against in-memory MongoDB. |
| `npm audit` | Not run anywhere in CI. |
