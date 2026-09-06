# 02 — Architecture

*Documented commit `be2d2ac`.*

## The system in one paragraph

One MongoDB database and one Express API serve four clients. The **web console**
is a React SPA that talks to the API directly and stores nothing locally. The
**desktop app** is Electron: it serves that same SPA build from disk, and
intercepts its own API calls in the main process, answering them from a local
SQLite document store which synchronizes with the server in the background. The
**mobile app** is Expo/React Native with its own SQLite mirror, a mutation
outbox and an independent, older sync protocol. A **parent portal** is served by
the same API under `/api/portal` and authenticates guardians by code rather than
by account.

The two offline clients do not share sync machinery. They use different
endpoints, different cursor designs, and different local storage engines. This
is the single most important fact about the architecture and is documented in
full in [10-synchronization.md](10-synchronization.md).

---

## System architecture — IMPLEMENTATION VERIFIED

```mermaid
graph TB
    subgraph clients["Clients"]
        MOB["Mobile — Expo SDK 57 / RN 0.86<br/>SQLite mirror + mutation outbox<br/>OFFLINE-FIRST"]
        DESK["Desktop — Electron<br/>node:sqlite document store + outbox<br/>OFFLINE-FIRST"]
        WEB["Web console — React 19 + Vite<br/>no local store<br/>ONLINE ONLY"]
        POR["Parent portal<br/>browser, code login"]
    end

    subgraph edge["Edge"]
        NGX["nginx<br/>serves SPA, proxies /api/ and /uploads/"]
    end

    subgraph server["Backend — Node.js + Express 5"]
        API["372 route handlers across 32 routers"]
        MW["helmet · cors · compression · morgan<br/>authenticate · idempotency · requirePermission"]
        SVC["24 services — grading, fees, payroll,<br/>promotion, report cards, notifications"]
    end

    DB[("MongoDB 7 / Atlas<br/>56 Mongoose models")]
    FS[["uploads volume<br/>served via /uploads with<br/>optional HMAC signature"]]

    MOB -- "REST + /api/sync/pull, /api/sync/push" --> NGX
    DESK -- "REST + /api/sync/changes" --> NGX
    WEB --> NGX
    POR --> NGX
    NGX --> API
    API --> MW --> SVC --> DB
    API --> FS
```

### Why the desktop and mobile paths differ

They were built at different times against different needs, and both are live.

- **Mobile** predates the feed. `/api/sync/pull` returns six collections in one
  response, filtered by a single high-water-mark timestamp. Writes go through a
  per-request **mutation outbox** that replays ordinary REST endpoints.
- **Desktop** uses `/api/sync/changes`, a paginated, capability-gated feed over
  **36 collections**, with a keyset cursor of `(updatedAt, _id)` per collection
  and its own outbox with a dedupe key and an idempotency key.

Neither is deprecated. Replacing the mobile path with the feed is not scheduled.

---

## Request pipeline — IMPLEMENTATION VERIFIED

Order matters here; it is the order in `backend/src/server.js`.

```mermaid
flowchart TD
    R([HTTP request]) --> H["helmet — nosniff, CSP, CORP: cross-origin"]
    H --> C["compression"]
    C --> TP{"NODE_ENV = production?"}
    TP -->|yes| PX["app.set trust proxy, 1<br/>so rate limiting sees the real client"]
    TP -->|no| LOG
    PX --> LOG["morgan — combined in prod, dev otherwise"]
    LOG --> CORS["cors — ALLOWED_ORIGINS in prod, reflect-all otherwise"]
    CORS --> BODY["express.json / urlencoded — 20 mb limit"]
    BODY --> STATIC["/uploads — express.static, 7 d cache"]
    STATIC --> OPEN["/api/auth · /api public · /api verify · /api/portal<br/>mounted BEFORE the authenticated block"]
    OPEN --> IDEM["/api — optionalAuthenticate then idempotency"]
    IDEM --> AUTH["per-router: authenticate + requirePermission(key)"]
    AUTH --> TEN["resolveSchoolId(req) — tenancy"]
    TEN --> HANDLER["route handler"]
    HANDLER --> ERR["multer error mapper → 404 catch-all → errorHandler"]
```

Two ordering decisions carry security weight:

1. **`/api/portal` is mounted above the authenticated `/api` block.** Guardians
   hold no JWT and no `req.user`; mounting below would have subjected them to
   `optionalAuthenticate` and then to guards written for staff.
2. **`idempotency` runs after `optionalAuthenticate`.** The middleware keys on
   `(Idempotency-Key, userId)`, so it is inert for anonymous requests by design —
   a key without an authenticated user is ignored rather than shared.

---

## Data flow — a mark entered offline

```mermaid
sequenceDiagram
    autonumber
    participant T as Teacher (mobile)
    participant SQL as SQLite
    participant OB as mutation_outbox
    participant API as Backend
    participant DB as MongoDB

    T->>SQL: write exam_scores row, _synced = 0
    SQL-->>T: saved (screen confirms immediately)
    T->>OB: enqueue POST /exams/:id/scores<br/>payload.__local = {table, ids}
    Note over T,OB: The device is offline. Nothing else happens.
    Note over T: scoreSyncState() shows "N waiting"
    OB->>API: connection returns — drain() replays the request
    API->>DB: upsert StudentScore (derived _id)
    DB-->>API: ok
    API-->>OB: 200
    OB->>SQL: clear _synced on payload.__local.ids
    Note over T: indicator returns to synchronised
```

If the server *refuses* the write (a 4xx that is not retryable), the outbox row
becomes `failed` and the local rows stay dirty. The marks screen then shows
"N failed" rather than "N waiting" — the distinction exists because a teacher
who sees the same warning every morning stops reading it. See
[07-mobile.md](07-mobile.md).

---

## Deployment architecture — IMPLEMENTATION VERIFIED

```mermaid
graph LR
    subgraph host["Docker host — docker-compose.yml"]
        NG["nginx:alpine<br/>:80 published"]
        BE["backend<br/>:5000 published"]
        MG[("mongo:7<br/>NO host port")]
        V1[["mongo_data"]]
        V2[["uploads_data → /app/src/uploads"]]
    end
    BR["Browsers"] --> NG
    DV["Mobile devices"] --> BE
    NG -- "/api/ and /uploads/" --> BE
    BE --> MG
    MG --- V1
    BE --- V2
```

Notes that matter operationally:

- **Mongo publishes no host port.** Only the backend reaches it, over the Docker
  network. `MONGO_USER` and `MONGO_PASSWORD` are required with no default —
  compose uses `${VAR:?message}` so the stack refuses to start without them.
- **`uploads_data` mounts at `/app/src/uploads`**, not `/app/uploads`. Mounted at
  the latter the volume stayed empty and uploads did not survive a restart.
- **nginx no longer mounts the uploads volume.** It proxies `/uploads/` to the
  backend so the signature gate is consulted; serving the files directly would
  leave a second, ungated path to them.
- `client_max_body_size 500m` on `/api/` matches the largest multer limit
  (video content, 500 MB).

---

## Package dependency graph

```mermaid
graph TD
    SH["shared/ — 11 modules, no manifest"]
    BE["backend"] -->|relative require| SH
    DE["desktop"] -->|relative require| SH
    WE["web"] -->|relative import| SH
    MO["mobile"] -->|relative import| SH
    DE -->|npm --prefix ../web run build| WE
```

There are **no npm workspaces**. Each of `backend/`, `mobile/`, `desktop/` and
`web/` is an independent package with its own `package.json` and lockfile, and
each must be installed separately. `shared/` is reached by relative path only —
which is why `desktop/scripts/check-request-path.js` asserts that every shared
module the desktop imports still resolves once the app is packaged.

`mobile/.npmrc` sets `legacy-peer-deps=true`; Expo SDK 57 has peer conflicts with
some React 19 packages and installs fail without it.
