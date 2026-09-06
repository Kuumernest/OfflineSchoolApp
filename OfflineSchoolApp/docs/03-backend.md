# 03 — Backend

*Documented commit `be2d2ac`. Source: `OfflineSchoolApp/backend/`.*

## Technology — IMPLEMENTATION VERIFIED

Read from `backend/package.json` at this commit.

| Dependency | Version | Role |
|---|---|---|
| `express` | ^5.2.1 | HTTP framework (Express **5** — `path-to-regexp` v8 syntax) |
| `mongoose` | ^9.9.1 | ODM |
| `jsonwebtoken` | ^9.0.3 | Access and refresh tokens, HS256 |
| `bcryptjs` | ^2.4.3 | Password hashing |
| `helmet` | ^8.3.0 | Security headers |
| `cors` | ^2.8.6 | Origin control |
| `compression` | ^1.8.1 | gzip |
| `morgan` | ^1.11.0 | Request logging |
| `express-rate-limit` | ^8.7.0 | Login and portal rate limiting |
| `multer` | ^2.2.0 | File uploads (loaded defensively — see below) |
| `zod` | ^4.4.3 | Input validation |
| `nodemailer` | ^9.0.5 | Outbound email |
| `qrcode` | ^1.5.4 | Document verification QR codes |
| `write-excel-file` | ^4.1.1 | Excel exports |
| `@sentry/node` | ^10.73.0 | Error reporting, inert without a DSN |
| `uuid` | ^14.0.1 | Document identifiers |
| `axios` | ^1.19.0 | Outbound HTTP |
| `dotenv` | ^17.4.2 | Local `.env` loading |

`package.json` declares **no `engines` field**. CI runs Node 20. The route loader
comment in `server.js` references Node 24 compatibility for `path-to-regexp` v8.

There is **no `test` script** — `npm test` exits 1 with "no test specified". All
verification runs through `npm run check:all`. See [16-testing.md](16-testing.md).

---

## Application structure — actual

```text
backend/
├── index.js                 # entry (package.json "main")
├── middleware/              # NOT under src/ — four files
│   ├── auth.js              #   authenticate, authorize
│   ├── permissions.js       #   requirePermission, requireAnyPermission
│   ├── idempotency.js       #   replay protection keyed on (key, userId)
│   └── errorHandler.js
├── src/
│   ├── server.js            # ~1000 lines: middleware pipeline + every mount
│   ├── instrument.js        # Sentry init, must be required first
│   ├── config/
│   │   ├── env.js           # boot-time environment validation
│   │   ├── database.js      # Mongoose connection
│   │   ├── roles.js         # the five roles, one copy
│   │   ├── permissions.js   # 65 permission keys + per-role defaults
│   │   └── syncFeed.js      # 36 fed collections + 16 explicit exclusions
│   ├── routes/              # 32 routers, 372 handlers
│   ├── controllers/         # 5 — homework, periods, results, sync, syncFeed
│   ├── services/            # 24 + communication/ and notification/ subtrees
│   ├── db/
│   │   ├── models/          # 50 files, 56 registered models
│   │   └── ensureStudentIndexes.js
│   ├── utils/               # 10 — tenant, uuid, mediaSignature, tempPassword, …
│   ├── export/              # Excel writers
│   ├── print/               # report-card / document HTML
│   └── uploads/             # served at /uploads
├── scripts/                 # 53 files — 40 check-*, plus repairs/seeds/backfills
├── engine/
└── backups/
```

**Note the split:** `middleware/` sits at the package root, not under `src/`.
Routers reach it as `require("../../middleware/auth")`. There is no
`src/middleware` directory.

### Controllers are the exception, not the rule

Only five routers delegate to a controller (`homework`, `periods`, `results`,
`sync`, `syncFeed`). The other 27 define handlers inline and call into
`src/services/` for domain logic. Both shapes are current; neither is deprecated.

---

## Boot sequence — IMPLEMENTATION VERIFIED

1. `src/instrument.js` initialises Sentry **before anything else**. Without
   `SENTRY_DSN` it is inert. It is configured not to send request bodies, query
   strings, cookies, auth headers, console breadcrumbs, or session replay.
2. `src/config/env.js` → `validateEnv()`. Refuses to start when:
   - `MONGODB_URI` or `JWT_SECRET` is unset (always); or
   - `ALLOWED_ORIGINS` is unset **and** `NODE_ENV=production`; or
   - `JWT_SECRET` is one of a refused placeholder set
     (`change-me`, `changeme`, `secret`, `your-secret-key`, `your_jwt_secret`,
     `supersecret`, `jwt-secret`), or is too short.

   On failure it prints each problem and exits non-zero.
   **CONFIGURATION DEPENDENT.**
3. Mongoose connects (`src/config/database.js`).
4. `ensureStudentIndexes.js` reconciles the student indexes.
5. Middleware pipeline and route mounts — see
   [02-architecture.md](02-architecture.md).

---

## Route mounting — IMPLEMENTATION VERIFIED

Mount points, read from `server.js`:

| Mount | Router | Auth applied at the mount |
|---|---|---|
| `/api/auth` | `auth.routes` | none (per-route inside) |
| `/api` | `public.routes` | none — unauthenticated application intake |
| `/api` | `verify.routes` | none — public document verification |
| `/api/portal` | `portal.routes` | `portal.portalAuth` via `router.use` |
| `/api` | `optionalAuthenticate` then `middleware/idempotency` | — |
| `/api/students` | `students.routes` | `optionalAuthenticate` |
| `/api/student` | `students.routes` | `auth.authenticate` |
| `/api/users` | `user.routes` | `authenticate` |
| `/api/sync` | `sync.routes` | per-route |
| `/api/admin/permissions` | `permissions.routes` | per-route |
| `/api/admin/periods` | `periods.routes` | `router.use(authenticate)` |
| `/api/admin/timetable` | `timetable.routes` | per-route |
| `/api/admin` | `admin.routes` | per-route `requirePermission` |
| 18 further `/api/<area>` mounts | | per-route |

Two subtleties worth knowing before editing `server.js`:

- **`students.routes` is mounted twice** — at `/api/students` with
  `optionalAuthenticate`, and at `/api/student` with hard `authenticate`. The
  same 29 handlers serve both. Callers on `/api/student/...` are always
  authenticated; callers on `/api/students/...` may not be, and the handlers
  guard themselves.
- **`/api/admin/permissions`, `/api/admin/periods` and `/api/admin/timetable` are
  mounted *before* `/api/admin`.** Express matches in registration order, so the
  three specific routers win. Moving the `/api/admin` mount above them would
  shadow all three.

---

## Services — IMPLEMENTATION VERIFIED

24 modules in `src/services/`, plus the `communication/` and `notification/`
subtrees.

| Service | Responsibility |
|---|---|
| `grading.service.js` | Grades a mark against `shared/gradeScale.js` |
| `termGrading.service.js` | Term aggregates from sequence marks |
| `annualGrading.service.js` | Annual aggregates from terms or sequences |
| `subjectCoefficient.service.js` | Per-subject weighting |
| `results.service.js` | Result computation and summaries |
| `resultAudit.service.js` | Writes `ResultChangeLog` |
| `resultStaleness.service.js` | Detects published results whose inputs moved |
| `reportCardData.service.js` | Assembles report-card data |
| `reportHtml.service.js` | Renders it |
| `fees.service.js` | Charges, payments, balances |
| `feeReminders.service.js` | Overdue reminders |
| `financeReports.service.js` | Financial reporting |
| `payroll.service.js` | Salary runs, hourly and salaried |
| `approvals.service.js` | Threshold-gated approval workflow |
| `promotion.service.js` | End-of-year promotion runs |
| `permissions.service.js` | Effective permissions with per-school overrides and a cache |
| `portal.service.js` | Guardian code auth and portal data |
| `gate.service.js` | Arrival and departure scanning |
| `documentVerify.service.js` | Public document verification |
| `earlyWarning.service.js` | At-risk pupil signals |
| `email.service.js`, `email.transport.js` | Outbound mail |
| `communication/policy.service.js` | Who may message whom — speaks in *principals* rather than roles, because guardians have no role |
| `notification/` | Notification creation and portal filtering |

### The permission cache

`permissions.service.js` caches effective permissions per school and invalidates
on `setRolePermissions`. Defaults come from `config/permissions.js`; a school may
override them for `bursar` and `teacher` only (`ADJUSTABLE_ROLES`). 48 of the 65
keys are `delegable`; 17 are locked and cannot be granted away.

---

## Error handling

Three layers, in order:

1. A **multer error mapper** turns `MulterError` (file too large, unexpected
   field) into a 4xx JSON body. `multer` is `require`d inside a try/catch — if it
   is absent, uploads are disabled with a console warning rather than the module
   failing to load.
2. A **404 catch-all** for unmatched `/api` paths.
3. `middleware/errorHandler.js` as the final Express error handler.

---

## Backend findings from this audit

| Item | Classification |
|---|---|
| `middleware/upload.js` | **REMOVED** at an earlier commit; it was imported by nothing. `src/routes/teacher.routes.js` still carries a comment describing it as present. Stale comment, no runtime effect. |
| Duplicate `POST /api/auth/refresh` (`auth.routes.js:259` and `:316`) | **INTENTIONAL** — the first calls `next()` when `JWT_REFRESH_SECRET` is unset, falling through to the second. Working but fragile; see [06](06-authentication-authorization.md). |
| `scripts/check-student-integrity.js` | **UNUSED** — a real suite wired into no npm script, so nothing ever runs it. |
| `GET /api/admin/debug/counts` | **IMPLEMENTED, diagnostic.** Gated on `dashboard.view`. Worth removing before a public deployment. |
| `POST /api/attendance/teachers/bulk` | **PARTIALLY IMPLEMENTED** relative to the student path: it is a near-copy that does **not** write `AttendanceChangeLog`. Staff register overwrites leave no history. See [11](11-conflict-resolution.md). |
