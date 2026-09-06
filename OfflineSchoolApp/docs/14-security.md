# 14 — Security

*Documented commit `be2d2ac`. This document records what is implemented and what
is not. Unverified items are listed as unverified.*

---

## Controls

### Authentication

| Control | Status |
|---|---|
| Passwords hashed with `bcryptjs` | IMPLEMENTATION VERIFIED |
| JWT algorithm pinned to **HS256** on both sign and verify | IMPLEMENTATION VERIFIED — an `alg: none` or asymmetric token is rejected |
| Login rate limited: 10 attempts / 15 min / IP | IMPLEMENTATION VERIFIED |
| `trust proxy` set in production so the limiter sees the real client | IMPLEMENTATION VERIFIED |
| Deleted or deactivated accounts rejected **immediately**, not at token expiry | IMPLEMENTATION VERIFIED — costs a DB read per request |
| Short-lived token for users who must reset their password | IMPLEMENTATION VERIFIED |
| Token revocation list | **NOT IMPLEMENTED** — deactivation is the revocation mechanism |

### Portal (guardians)

| Control | Value |
|---|---|
| Code source | `crypto.randomBytes` — a CSPRNG, not `Math.random` |
| Alphabet | 30 characters, ambiguous pairs (`O/0`, `I/1`, `S/5`) removed |
| Length | 8, formatted `XXXX-XXXX` |
| Max attempts | 6, then a **15-minute lockout** |
| Session | 12 hours |
| Write surface | messaging only; everything else is read-only |

An 8-character code from a 30-character alphabet is ~39 bits. That is **not**
password-grade, and the design says so: *"rate-limited, because an eight-character
code is guessable given unlimited attempts."* The lockout is what makes it safe,
not the entropy.

### Authorization

| Control | Status |
|---|---|
| 65 permission keys, one definition file | IMPLEMENTATION VERIFIED |
| `requirePermission` / `requireAnyPermission` on routes | IMPLEMENTATION VERIFIED |
| 17 keys **locked** — never delegable | IMPLEMENTATION VERIFIED |
| Only `bursar` and `teacher` are school-adjustable | IMPLEMENTATION VERIFIED |
| Roles defined once (`config/roles.js`); `"admin"` normalised away | IMPLEMENTATION VERIFIED |
| Bursar separated from admin (no `payroll.setSalary`, no `approvals.decide`) | IMPLEMENTATION VERIFIED |
| The full matrix | TEST VERIFIED — `check-role-matrix.js`, `check-authz-matrix.js`, `check-admin-guards.js` |

### Tenant isolation

| Control | Status |
|---|---|
| One rule, one file (`src/utils/tenant.js`) | IMPLEMENTATION VERIFIED |
| Non-super-admins silently corrected to their own school | IMPLEMENTATION VERIFIED |
| `namedAnotherSchool()` for writes that should refuse | IMPLEMENTATION VERIFIED |
| Cross-school read attempts blocked | TEST VERIFIED — `check-cross-school.js`, `check-student-tenancy.js`, `check-announcement-tenancy.js` |
| **Database-level enforcement** | **NONE.** One database, one connection. A query that omits `schoolId` returns every school's rows. |

That last row is the real boundary of this guarantee. Tenancy is an application
invariant maintained by discipline and check suites, not by the storage layer.

### Replay and duplicate protection

| Layer | Mechanism |
|---|---|
| Header | `Idempotency-Key`, scoped `(key, userId)`, 14-day TTL |
| In-flight | `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 2` |
| Server error | key **deleted** on 5xx so a genuine retry is possible |
| Derived ids | attendance and scores compute `_id` from the natural key |
| Client ids | endpoints answer `200 replay: true`, never a spurious `409` |

### Environment validation

The process **refuses to start** when `MONGODB_URI` or `JWT_SECRET` is missing,
when `JWT_SECRET` is a known placeholder or too short, or when
`ALLOWED_ORIGINS` is unset in production. Docker Compose enforces the same with
`${VAR:?message}` for `MONGO_USER`, `MONGO_PASSWORD`, `JWT_SECRET`,
`JWT_REFRESH_SECRET` and `ALLOWED_ORIGINS`.

### HTTP headers

`helmet()` with `crossOriginResourcePolicy: { policy: "cross-origin" }` — so
`nosniff`, helmet's default CSP and the rest are on. CORS in production is
restricted to `ALLOWED_ORIGINS`; **in development it reflects any origin**.

Allowed request headers include `Idempotency-Key`, without which a browser
preflight would strip it and the client would silently lose the protection it
asked for.

### Uploads

Two different policies, and the difference matters.

| Path | Policy | Limit |
|---|---|---|
| Teacher content (`teacher.routes.js`) | **allowlist** of MIME types per content type | 500 MB multer ceiling; per-type caps: video 500 MB, audio 100 MB, image 10 MB, documents/notes/syllabus 50 MB |
| Message attachments (`messages.routes.js`) | **blocklist** of 16 executable extensions | 25 MB, 1 file |

`image/svg+xml` is **deliberately absent** from the teacher image allowlist: an
SVG is a document that can carry `<script>`, and these files are served from the
API origin.

**The message attachment filter is a blocklist**, and `.svg` and `.html` are not
on it. A staff member or guardian can attach either. Two things reduce the impact:
helmet's default CSP applies to responses from the API origin, and `/uploads/`
paths under `messages` are subject to the signature gate below. It remains an
asymmetry between two filters that guard the same directory. See the findings.

### Signed media

`src/utils/mediaSignature.js` — HMAC-SHA256 over the relative path plus an
expiry, keyed on `JWT_SECRET`.

| Property | Value |
|---|---|
| Protected prefixes | `["messages"]` |
| Default validity | 7 days (`hours: 24 * 7`) |
| Enforcement | **off by default**; `REQUIRE_MEDIA_SIGNATURE=1` turns it on |

Only message attachments are protected. Everything else under `/uploads` —
including school logos, which need to be cacheable — is unsigned by design; a
signature that expires on a logo is *"laminating the cache"*.

nginx proxies `/uploads/` to the backend rather than serving the volume itself,
so the gate is always consulted. Giving nginx the files as well would leave a
second, ungated path one edited `location` block away.

### Error reporting

Sentry, in both backend and web. **Inert without `SENTRY_DSN`.**

| Setting | Value |
|---|---|
| `sendDefaultPii` | `false` — no IPs, no usernames |
| `tracesSampleRate` | `0` by default |
| `beforeSend` | scrubs the request; deletes `body` and `query` from **every breadcrumb** |
| Session replay | not enabled |

Breadcrumbs are scrubbed as well as the event, because breadcrumbs record earlier
requests and carry the same payloads.

### Temporary passwords

`src/utils/tempPassword.js` — a word from a fixed list, digits, and a symbol,
selected with `crypto.randomInt`. These are **first-login credentials**, paired
with `mustResetPassword` and a deliberately short access token.

**The notification body can contain one.** This is why `Notification` is excluded
from the device sync feed, and why:

> **The portal notification kind list must remain an explicit allowlist, never a
> blocklist.**

A blocklist there would leak a temporary password to a guardian's screen the first
time a new notification kind was added.

---

## Secrets

### Rules

1. **`.env` is git-ignored and must never be committed.** It is not read, edited
   or included anywhere in this documentation package.
2. **No secret value appears in these documents.** Only variable *names*.
3. `.env.example` holds names and placeholder values only.
4. `JWT_SECRET` must be **32+ characters** and not a placeholder; the process
   refuses to start otherwise.
5. `docker-compose.yml` requires `MONGO_USER`, `MONGO_PASSWORD`, `JWT_SECRET`,
   `JWT_REFRESH_SECRET` and `ALLOWED_ORIGINS` from the environment with no
   defaults.
6. Mongo publishes **no host port** — only the backend reaches it, over the
   Docker network.

### Rotation — OUTSTANDING

The credentials currently in the working `.env` are **development credentials and
have not been rotated**. They must be rotated before deployment. This is a stated
prerequisite, not a code change. See
[19-known-limitations.md](19-known-limitations.md).

Rotating means, at minimum: `MONGODB_URI` (including the Atlas password),
`JWT_SECRET`, `JWT_REFRESH_SECRET`, and any mail credentials. Rotating
`JWT_SECRET` invalidates every issued token, which is the intended effect.

---

## Verified limitations

Only items traced to code or measured. Nothing speculative.

| # | Limitation | Impact |
|---|---|---|
| 1 | **No token revocation list.** A stolen access token is valid for up to 30 days. | Mitigation is deactivating the account, which takes effect on the next request. |
| 2 | **Tenancy is application-level only.** | A new route that forgets `resolveSchoolId` leaks across schools. Only the check suites catch it, and only on covered paths. |
| 3 | **Message attachments use a blocklist, not an allowlist.** `.svg` and `.html` are permitted. | Files are served from the API origin. Mitigated by helmet's CSP and, when enabled, the signature gate. |
| 4 | **`REQUIRE_MEDIA_SIGNATURE` is off by default.** | Message attachment URLs are guessable-by-path unless it is switched on. Turn it on in production. |
| 5 | **CORS reflects any origin outside production.** | A staging host left at `NODE_ENV != production` accepts requests from anywhere. |
| 6 | **`GET /api/admin/debug/counts` ships enabled.** | Gated on `dashboard.view`, so staff-only, but it is a diagnostic endpoint in a production build. |
| 7 | **`/uploads` sets `Access-Control-Allow-Origin: *`** and no `Content-Disposition: attachment`. | Uploaded files render inline cross-origin. Helmet's `nosniff` applies; the content-type does not. |
| 8 | **Portal codes are ~39 bits.** | Safe only because of the 6-attempt lockout. Removing or widening that lockout would make them brute-forceable. |
| 9 | **20 `set-state-in-effect` errors in the web client.** | Not a security issue; listed because the lint gate that would catch a genuine issue is not blocking. See [09](09-web.md). |
| 10 | **`POST /api/sync/push` is live and unused.** | An implemented, permission-gated write path with no caller and therefore no client-side test coverage. Reachable by any `school_admin`. |

---

## Security verification — TEST VERIFIED

Suites that specifically cover security behaviour, all green at this commit:

| Suite | Covers |
|---|---|
| `check-role-matrix.js` | every role's effective permissions |
| `check-authz-matrix.js` | route-level authorization |
| `check-admin-guards.js` | admin route guards |
| `check-cross-school.js` | cross-tenant reads and writes |
| `check-student-tenancy.js`, `check-announcement-tenancy.js` | per-model tenancy |
| `check-idempotency.js` | replay protection |
| `check-duplicate-money.js` | financial replay and duplicate prevention |
| `check-login-response.js` | what login does and does not return |
| `check-communication-policy.js` | who may message whom |
| `check-portal-gate.js`, `check-portal-messaging.js` | portal access boundaries |
| `check-sync-feed.js` | feed capability gating and model classification |
| `check-orphans.js` | orphaned records |

---

## What has not been security tested

Stated plainly:

- **No penetration test** has been performed against this system.
- **No dependency vulnerability audit** is wired into CI (`npm audit` is not run).
- **No load or denial-of-service testing.**
- **No review of the Atlas deployment's own network rules** — IP allowlist, TLS
  configuration, database user privileges — which are outside this repository.
