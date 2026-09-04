# Architecture

## 1. The system in one paragraph

One MongoDB, one Express API, and three front ends. The **web console** is a
React SPA that talks to the API directly. The **desktop app** is the same SPA
loaded inside Electron — but its HTTP calls are answered first by a **local
document store** in the main process, so a school office keeps working when the
internet is gone; an **outbox + sync engine** reconcile the local database with
the server. The **mobile app** (Expo) follows the same pattern for teachers,
students and guardians with SQLite, a Redux store and its own sync manager.
Everything that both the server and the desktop must agree on — grading scales,
receipt numbering, report-card tokens, the request path the desktop calls —
lives in `shared/` so it is written down exactly once.

## 2. Component map

```
                    ┌──────────────┐
   browsers ───────►│  web (React) │────────────┐
                    └──────────────┘            │
                    ┌──────────────┐   HTTPS    ▼
   desktops ───────►│ Electron UI  │      ┌───────────┐     ┌─────────┐
                    │ + local DB   │─────►│  backend  │────►│ MongoDB │
                    │ + outbox     │ sync │ (Express) │     └─────────┘
                    └──────────────┘      └─────┬─────┘
                    ┌──────────────┐            │
   phones   ───────►│ mobile (Expo)│──► Nodemailer → SMTP provider
                    │ + SQLite     │      └─ uploads/ (photos, content, messages)
                    └──────────────┘
```

Production deployment (`docker-compose.yml`): `mongo:7` (no host port, health-
checked) → `backend` (multi-stage `Dockerfile` that also builds the web app and
serves it from `public/web`) → `nginx:alpine` on port 80 serving static files,
proxying `/api/` to the backend and caching `/uploads/`.

## 3. Backend request pipeline

`backend/src/server.js` assembles the app in this order — the order is
load-bearing, and the file's comments explain why for each step:

1. **Env validation** — `config/env.js` runs before anything else; a missing or
   placeholder `JWT_SECRET` (< 32 chars) refuses boot instead of failing on the
   first login.
2. **Upload bootstrap** — `uploads/content/*`, `uploads/logos`, `uploads/photos`,
   `uploads/messages` are created if missing.
3. **Core middleware** — `helmet`, `compression`, `morgan` (combined in prod),
   CORS allow-list from `ALLOWED_ORIGINS` in production, 20 MB JSON bodies.
4. **`trust proxy`** — production only, so the login rate limiter counts real
   client IPs behind the reverse proxy rather than the proxy itself.
5. **Media streaming** — `GET /uploads/{*path}` with path-traversal guarding
   (separator-aware prefix check) and a **signature gate**: message attachments
   are signed URLs; `REQUIRE_MEDIA_SIGNATURE=1` turns observe-mode into
   enforcement. Photos are deliberately unsigned (content-addressed, rendered
   from offline caches).
6. **Auth** — `middleware/auth.js` exposes `authenticate` and
   `optionalAuthenticate` (students' roster endpoints accept anonymous reads).
7. **Idempotency** — mounted at `/api` *before* every authenticated router that
   accepts writes, so a retried mutation (exactly what the mobile outbox does on
   a flaky link) is deduplicated instead of replayed.
8. **Routers** — see [`API.md`](API.md). Order matters: `/api/admin/permissions`,
   `/api/admin/periods`, `/api/admin/timetable` are mounted **before**
   `/api/admin` because the admin router is a catch-all for its prefix.
9. **Error handler** — the final `errorHandler` middleware; every async handler
   goes through `middleware/asyncHandler.js` so rejections become 500s, not
   hangs.
10. **Notification dispatcher** — a 60-second interval drains the notification
    queue (fee receipts, gate arrivals, messages) via Nodemailer; `unref()`'d so
    it never holds the process open.
11. **Graceful shutdown** — SIGTERM/SIGINT close HTTP then Mongo; 10 s forced
    exit; unhandled rejections are logged, uncaught exceptions exit 1.

## 4. Offline-first design

### 4.1 Desktop (`desktop/`)

| Piece | File | Role |
|---|---|---|
| Document store | `src/main/db/store.js`, `db/schema.js` | Local school database in `app.getPath("userData")` (`%APPDATA%/school-desktop`), outside the install dir so updates/uninstalls never touch records. Migrations are numbered (`migrated to 1/2/3 — …`). |
| Outbox | `src/main/db/outbox.js` | Every write is queued locally and marked pending; the UI reflects it immediately. |
| Sync engine | `src/main/sync/engine.js`, `sync/client.js` | Pulls server changes with a cursor, pushes the outbox when online. |
| API shim | `src/main/api/index.js`, `api/writes.js`, `api/coverage.js` | Answers the web UI's usual HTTP surface from the local store; `requestPath.js` (shared) keeps the paths identical to the server's. |
| Security | `src/main/main.js`, `preload.js` | `contextIsolation: on`, `nodeIntegration: off`; the renderer gets a small named IPC surface. Single-instance lock — two windows would mean two pullers writing the same cursors. |

The **desktop-parity check** (`backend/scripts/check-desktop-parity.js`, 1300+
assertions) proves the local shim answers identically to the real routes — the
500-row cap, the arrears list, the approval queue answering differently per
person, and so on.

### 4.2 Idempotency

`middleware/idempotency.js` records an `IdempotencyKey` per write request. The
client generates the key; a retry with the same key returns the first result
instead of applying the write twice. This is what makes outbox replay safe.

### 4.3 Sync feed

`config/syncFeed.js` + `services/sync.service.js` +
`controllers/syncFeed.controller.js` implement:

- `GET /api/sync/changes` / `GET /api/sync/pull` — cursor-based change feed for
  the collections clients mirror.
- `POST /api/sync/push` — client writes, applied server-side with conflict
  tracking (`SyncLog`, `SyncOverwrite` models record overwrites rather than
  silently losing them).

### 4.4 Mobile (`mobile/`)

Expo Router screens under `app/` (teacher / student / portal areas), services
under `src/services/` (`syncManager`, `syncBackfill`, `syncAssignments`,
`sync-overwrite`, `userCache`, `storage`), SQLite via `expo-sqlite`, tokens in
`expo-secure-store`. `app/sync/pending` shows the user what has not left the
device yet.

## 5. Roles, permissions and approvals

- **`config/roles.js`** — the single place a role name is written:
  `super_admin`, `school_admin`, `bursar`, `teacher`, `student` (descending
  authority). Legacy `"admin"` is normalised, never stored. Role *sets*
  (`ADMIN_ROLES`, `FINANCE_ROLES`, `OFFICE_ROLES`, `TEACHING_ROLES`,
  `STAFF_ROLES`) are the only things guards reference.
- **`config/permissions.js`** — capabilities as a registry of
  `{ key, module, defaults, delegable }`. Defaults are written as the role sets
  above, so migrating a route from `authorize(SET)` to `requirePermission(key)`
  changes nobody's access. `delegable: false` marks the ceiling (results,
  promotion, user/permission management, report templates, school settings, sync
  push, message audit). Overrides are permitted for **bursar** and **teacher**
  only — `super_admin` holds everything, `school_admin` is fixed against
  self-lockout, and the student surface is scoped by caller rather than by
  capability. `scripts/check-role-matrix.js` fails the build if a key governs
  nothing.
- **Approvals** (`services/approvals.service.js`, `models/ApprovalRequest.js`):
  kinds — expense, refund, waiver, payroll. Properties enforced by
  `scripts/check-approvals.js`:
  - a school-configurable threshold decides what needs approval;
  - **nobody approves their own request**;
  - only one pending request per target;
  - a pending expense sits outside the accounts; a refund writes nothing until
    approved; a rejected one writes nothing at all;
  - a waiver does not reduce a bill until approved, and is **revalidated at
    approval time** (the bill may have changed);
  - a decided request is frozen; a requester may withdraw;
  - payroll is prepared → signed (approval) → confirmed (paid);
  - the queue answers differently depending on who is asking.

## 6. Multi-tenancy

Every collection carries `schoolId`. Routers resolve it from the authenticated
user (never from an untrusted query without checking), and tenancy checks live
in `scripts/check-student-tenancy.js` / `check-announcement-tenancy.js`.
`super_admin` is the deployment operator and may cross schools; everyone else is
scoped to one.

## 7. Printed & exported documents

- `src/print/` — server-rendered documents: receipts, transcripts, ID cards,
  class lists, verify pages, with a default report template and token engine.
- `src/services/reportHtml.service.js` + `ReportTemplate` / `GeneratedReport`
  models — schools customise templates; generated report cards are stored,
  versioned and revocable (`DocumentVerification`).
- `src/export/` — Excel exports via `write-excel-file`, one `/:kind` route with
  per-kind role checks.
- `shared/` — `gradeScale.js`, `reportCard.js`, `reportTokens.js`,
  `receipts.js` (receipt numbering parity with the desktop's
  `receiptCounter.js`), `officialHeader.js`, `attendance.js`,
  `feeStructures.js`, `approvalThresholds.js`, `studentName.js`,
  `requestPath.js`.

## 8. Grading pipeline

`Subject` coefficients (per exam subject) → `StudentScore` entries →
`ExamSubject` submission state → per-exam `ResultSummary` →
`services/termGrading.service.js` (term averages) →
`services/annualGrading.service.js` (annual averages across terms, promotion
exams) → publication (`isPublished`) → report cards. Every change to a
published result is written to `ResultChangeLog` by
`services/resultAudit.service.js`, and staleness is tracked so a report card is
never silently out of date (`resultStaleness.service.js`).
