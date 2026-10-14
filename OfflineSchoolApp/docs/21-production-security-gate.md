# 21 — Production Security Gate

*Branch `ca-assessment`. Baseline `58512df` (authorization hardening) plus
`e468a0f` (attendance reminders). Evidence cites files under
`OfflineSchoolApp/` as they stand on this branch; every claim below was read
in the code or produced by a check suite in this pass, not inferred.*

The gate asks one question of each area: what would a deployment be exposing
if it shipped today? Findings are graded BLOCKER / HIGH / MEDIUM / LOW /
INFORMATIONAL only where the evidence supports the grade. Where an area is
sound, that is recorded with its evidence too, because "no finding" without
evidence is not a gate.

## 1. Authentication

| Item | Evidence | Verdict |
|---|---|---|
| Password hashing | `User.pre("save")` bcrypt cost 12 (`src/db/models/User.js:220`); the two write paths that once bypassed the hook (`admin.routes.js` re-approval, `sync.controller.js`) go through `save()` or hash explicitly; `check-tenant-ids` asserts the stored hash. | Sound |
| Temporary-password lifecycle (X21) | 15-minute access token, no refresh token (`auth.routes.js buildTokenResponse`); door refuses every route but `POST /auth/change-password`, `GET /auth/me`, `GET /users/me`, `POST /auth/logout` with 403 `PASSWORD_CHANGE_REQUIRED` (`middleware/auth.js PASSWORD_CHANGE_ROUTES`); refresh-token mode refuses a flagged account; `passwordChangedAt` kills the temporary token on change. Suite: `check-temp-password-lifecycle` (39). | **Closed this pass** — see docs/22 §3 |
| Access-token expiry | `JWT_EXPIRES_IN` (30d default) for chosen passwords, 15m while flagged; HS256 only (`middleware/auth.js`). | Sound; 30 days is a product choice for intermittent connectivity (documented in `auth.routes.js`) |
| Refresh tokens | `JWT_REFRESH_SECRET`, 90d; refresh refuses inactive users, closed schools, tokens older than `passwordChangedAt` (5 s leeway), flagged accounts. **No rotation**: a refresh token is reused until expiry. | LOW — rotation is a future item; compensated by the staleness rule |
| Logout | Stateless (`auth.routes.js /logout`): the access token stays valid until expiry. Recorded in the lifecycle suite as a known limitation. | LOW — a token allow-list/revocation store is a future item |
| Password reset | Operator/admin resets set a temporary password and the flag through `save()`; the plaintext leaves only by email or the operator's own typing (commit 47aa74e); `check-platform-admins` asserts it never reaches the console log. | Sound |
| Login rate limiting | `express-rate-limit` 10 attempts / 15 min / IP on `POST /auth/login`; 15 / 15 min on the guardian `POST /portal/login`; public application 10 / 15 min / IP. `trust proxy` set in production so the IP is the client's, not nginx's. | Sound |
| Brute force on identity | Unknown email and wrong password cost the same (`DUMMY_HASH` compare); a pupil's email answers as unknown (X20). | Sound |
| Session invalidation | Deactivated user → 401 at the door on the next request; deactivated/deleted school → 401 `SCHOOL_INACTIVE` (30 s cache); password change → `TOKEN_STALE`. Suites: `check-school-scope`, `check-login-response`. | Sound |
| Role validation | `normalizeRole` at the door; an unknown stored role fails closed (403 `UNKNOWN_ROLE`). | Sound |

## 2. Authorization

Roles present: `super_admin`, `school_admin`, `bursar`, `teacher`, `student`
(`src/config/roles.js`); guardians are not users and enter through the portal
against a `GuardianAccess` row. Capabilities: `src/config/permissions.js`.

| Boundary | Enforced by | Suite |
|---|---|---|
| Tenant (school) | Door rule in `middleware/auth.js` (query/body `schoolId` ≠ own → 403), `guardSchoolParam` for path params, `resolveSchoolId` for super_admin | `check-school-scope` (58), `check-cross-school`, `check-student-tenancy`, `check-announcement-tenancy` |
| Object level (by id) | Scoped `findOne({ _id, schoolId })` with uniform 404 across students, admin, results, exams, templates, generated reports, applications | `check-tenant-ids` (53), `check-marks-scope` (65) |
| Class / subject (teacher writes) | `utils/teacherScope.teacherAssigned`: active `TeacherAssignment` pair for marks, class for registers | `check-marks-scope`, `check-register-scope` (26), `check-homework-scope`, `check-quiz-scope` |
| Teacher reads | School-wide by capability (product policy, docs/20 §7b, §11.7); never cross-school | `check-teacher-read-scope` (15, this pass) |
| Student own record | Identity from the token (`/results/my-results`, `/students/me`) | `check-student-results`, `check-authz-matrix` |
| Guardian | `req.portal.studentIds` only; every per-child query carries school + student | `check-portal-*` (six suites) |
| Application documents | Signed link or `students.admit`/`students.viewFull` in the owning school; `/uploads/applications` closed | `check-application-documents` (45) |
| Announcements | `utils/announcementScope` (school + role) | `check-tenant-ids`, `check-announcement-tenancy` |
| Attendance | Class-level assignment on both routes and the legacy teacher route | `check-register-scope`, `check-attendance-reminders` |
| Marks / report cards | Pair check; exam anchored in the caller's school for every per-student read and write | `check-marks-scope` |
| Sync | Per-collection capability + scope (`config/syncFeed.js`), tenant filter on every collection; teacher `student` collection narrowed to taught classes | `check-sync-feed` (61), `check-teacher-read-scope` |
| Platform (super_admin) | `platform.*` non-delegable capabilities; a named school must exist (404 otherwise); no school is ever assigned to the role | `check-super-admin` (121), `check-platform-admins` (89), `check-school-context` |

No authorization finding is open. N6 (super_admin cross-school reads) is
intentional platform behaviour, verified in docs/20 §11.6.

## 3. Input validation

| Item | Evidence | Verdict |
|---|---|---|
| Mongo operator injection | Filters are built from named fields with `String()` coercion where a query value could be an object (portal `academicYear`, X23 fixes). No `express-mongo-sanitize`; Mongoose 9 `strictQuery` is off so unknown filter keys are not silently dropped. | LOW — no injectable path was found; a global sanitiser is a future hardening item, not a fix for a found defect |
| Regex from input | Escaped in `admin.routes.js`, `superAdmin.routes.js`, `students.routes.js`, `public.routes.js` (X18), `conversation.service.js`. **`teacher.routes.js /my-content` search passed the raw term** — escaped and capped at 100 chars in this pass. | Closed |
| Sort / filter parameters | No route reads `req.query.sort`; enums are checked against fixed lists (`STUDENT_STATUSES`, exam types, roles). | Sound |
| Ids | String UUIDs for most models; ObjectId-typed lookups guard the shape (`isValidObjectId`, `looksLikeSchoolId`) before querying. | Sound |
| Mass assignment | `Question.create({ ...req.body, schoolId, subject_id, created_by })` and the Quiz equivalent spread the body but set tenant and author afterwards; schemas are strict, so unknown keys drop. `Object.assign(existing, {...})` in results uses named fields. | INFORMATIONAL |
| Prototype pollution | No deep-merge of request bodies into reused objects was found; `express.json` produces plain objects and Mongoose casts. | No finding |
| Request size | `express.json`/`urlencoded` 20 MB; multer 5 MB (applications), 25 MB (messages), 500 MB (teacher content); nginx `client_max_body_size 500m` on `/api/`. | Sound; the 500 MB content limit is a product choice for lesson video |

## 4. File handling

| Item | Evidence | Verdict |
|---|---|---|
| Applicant documents | Closed at `/uploads/applications` (uniform 404, mounted ahead of the media handler and static); served only by `GET /api/students/applications/:id/documents/:key` after a signed link or an authorised school-scoped read; path reduced to a basename inside the directory; `path`/`filename` never leave (`utils/applicationDocuments.js`). | Sound — `check-application-documents` |
| Extension / MIME | Stored extension from a MIME table, `.bin` otherwise (X16); multer `fileFilter` on declared type. Magic-byte sniffing is not done. | LOW — declared type only; documents are no longer served as pages from the API origin, which was the exposure |
| Path traversal | Media handler resolves under `uploads` and requires the separator (`server.js`); `resolveDocumentFile` uses `path.basename`. | Sound |
| Messages attachments | HMAC-signed URLs (`utils/mediaSignature.js`), gate in **observe mode** until `REQUIRE_MEDIA_SIGNATURE=1`; nginx proxies `/uploads/` so the gate is consulted. | MEDIUM — until the flag is set, an unsigned message attachment URL is still served. Turn the flag on one signature lifetime (7 days) after deploying signed URLs. Recorded as a deployment step in docs/22 |
| Photos | Content-addressed, deliberately unsigned (offline ID-card rendering). | INFORMATIONAL — documented trade-off in `mediaSignature.js` |

## 5. API behaviour

| Item | Evidence | Verdict |
|---|---|---|
| CORS | Production: `ALLOWED_ORIGINS` allow-list, credentials on, methods and headers enumerated; development: open. Boot refuses production without the variable (`src/config/env.js`). | Sound |
| Security headers | `helmet()` defaults (CSP, HSTS-ready, nosniff, frame denial, referrer policy) with `crossOriginResourcePolicy: cross-origin` for media. The web console is static under nginx; nginx adds no headers of its own. | Sound for the API; **the web console's static responses carry no security headers** — LOW, add `add_header` lines to the nginx `location /` block (X-Content-Type-Options, X-Frame-Options/CSP frame-ancestors, Referrer-Policy) |
| Error handling | Public router: fixed sentences (X23). Global handler: **500 path echoed `err.message` in production** — now generic in production for unexpected exceptions; code-chosen 4xx messages kept. Stack traces never leave. | Closed this pass |
| Debug routes | `/api/debug/*` registered only when `NODE_ENV !== "production"`; `/api/debug/env` prints `NODE_ENV` and `PORT` only. | Sound |
| Health | `/api/health` reports status, database state, timestamp, uptime, heap used, environment. | INFORMATIONAL — uptime/heap are harmless but unnecessary; leave or trim |
| API documentation | None served. | — |
| Rate limits | Login, portal login, public application (above). No global limiter on authenticated routes. | LOW — a global limiter behind nginx is a future item; not a found exposure |

## 6. Database

| Item | Evidence | Verdict |
|---|---|---|
| Credentials | `MONGODB_URI` from the environment only; docker-compose requires `MONGO_USER`/`MONGO_PASSWORD` with no default and publishes no Mongo port. `.env` is git-ignored; only `.env.example` files are tracked. | Sound |
| TLS | Atlas (`mongodb+srv`) is TLS by construction; the Docker network path is plaintext inside the compose network only. | Sound for both documented deployments |
| Privileges | The compose root user is used by the application. | LOW — a least-privilege database user for `school_app` is a deployment improvement |
| Indexes / plans | `check-query-plans` asserts index use on hot queries; `check-enrollment-index`, `check-orphans`. | Sound |
| Tenant filters | See §2. | Sound |

## 7. Secrets

A pattern scan over every tracked file (Brevo keys, Mongo URIs with
credentials, private keys, AWS/Stripe/GitHub tokens, JWTs) matched only
`backend/.env.example` (the `USERNAME:PASSWORD@CLUSTER` placeholder) and a
fixture in `scripts/check-email-transport.js` (`xkeysib-0123…`, an obviously
synthetic key used to test provider selection). No real secret is committed.
The mobile bundle inlines only `EXPO_PUBLIC_API_URL`; the backend never reads
a secret from a client-prefixed variable.

## 8. Environment configuration

Variables the code reads (`process.env.*` across `backend/src`):

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | always | boot refuses without it (`config/env.js`) |
| `JWT_SECRET` | always | 32+ chars in production; placeholder values refused |
| `JWT_REFRESH_SECRET` | recommended | without it there is no refresh token and the access-token refresh mode is the only renewal |
| `ALLOWED_ORIGINS` | production | CORS allow-list; boot refuses production without it |
| `NODE_ENV`, `PORT` | always | `production` enables trust-proxy, combined logs, generic errors |
| `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES` | optional | defaults 30d / 90d |
| `REQUIRE_MEDIA_SIGNATURE` | production, after rollout | `1` enforces signed attachment URLs |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `BREVO_REPLY_TO`, `BREVO_TEMPLATE_*` | optional | mail; warnings, never fatal |
| `SMTP_HOST/PORT/SECURE/USER/PASS`, `GMAIL_USER`, `GMAIL_APP_PASSWORD` | optional | fallbacks |
| `APP_LOGIN_URL`, `SCHOOL_NAME`, `BASE_URL` | optional | links and letterheads |
| `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE` | optional | off when unset; bodies, cookies, auth header and query strings are scrubbed (`src/instrument.js`) |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | optional | notification channel |
| `DISABLE_LOGIN_RATE_LIMIT` | development/test only | must never be set in production |
| `BACKFILL_SCHOOL_ID` | scripts only | — |

Clients: web `VITE_API_URL` (default `/api` behind nginx), `VITE_SENTRY_*`;
mobile `EXPO_PUBLIC_API_URL` (release builds refuse to start without it,
`src/services/api.js`); the development LAN fallback `192.168.1.232` is used
only when the variable is unset and never in a release bundle.

## 9. Logging

| Item | Evidence | Verdict |
|---|---|---|
| Credentials | Login logs the user id and role only; no identifier tried, no password, no hash (`auth.routes.js`). Password resets log names, never the password (`check-platform-admins` asserts). | Sound |
| Tokens | Never logged. Sentry strips the Authorization header. | Sound |
| Signed URLs in the request log | `morgan combined` logged the full URL, including `?sig=` — a one-hour capability. **Redacted this pass** (`morgan.token("url")` in `server.js`). | Closed |
| Student / guardian data | Route handlers log ids and counts; a handful of legacy `console.log` lines print names (e.g. `[approve] Updated existing Student record`). | INFORMATIONAL — names in an operational log; trim over time |
| Filesystem paths | Application document paths no longer leave the server in responses; logs print relative filenames on upload. | Sound |

## 10. Findings register

| # | Grade | Finding | Status |
|---|---|---|---|
| G1 | HIGH→closed | Temporary-password token opened every protected route and could be renewed indefinitely (X21) | Fixed this pass; `check-temp-password-lifecycle` |
| G2 | MEDIUM | Message-attachment signature gate in observe mode until `REQUIRE_MEDIA_SIGNATURE=1` | Open — deployment step, one signature lifetime after rollout |
| G3 | LOW→closed | Global 500 handler echoed exception text in production | Fixed this pass |
| G4 | LOW→closed | Signed document/media URLs written to the request log | Fixed this pass |
| G5 | LOW→closed | Teacher content search term used as a regex | Fixed this pass |
| G6 | LOW | No refresh-token rotation; logout is stateless | Open — future item, compensated by `passwordChangedAt` staleness |
| G7 | LOW | Web console static responses carry no security headers (nginx `location /`) | Open — one-line nginx change, not tested here |
| G8 | LOW | Application uploads validated by declared MIME, not content | Open — no longer served as pages; future item |
| G9 | LOW | Database user is the compose root user | Open — deployment improvement |
| G10 | LOW | No global rate limit on authenticated routes | Open — future item |
| G11 | INFO | `/api/health` reports heap and uptime | Leave or trim |
| G12 | INFO | Body spreads in quiz/question creation (tenant fields set after) | No action |

No BLOCKER. The one MEDIUM (G2) is a documented deployment step rather than a
code defect: the code enforces when the flag is set, and the flag must wait
for clients to hold signed URLs.
