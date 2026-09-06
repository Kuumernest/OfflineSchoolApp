# 07 — Mobile Application

*Documented commit `be2d2ac`. Source: `OfflineSchoolApp/mobile/`.*

The mobile app is the fullest offline-first client: a complete SQLite mirror, a
durable mutation outbox, an ID map for records created offline, and a background
sync manager. Everything below is traced to source.

---

## Technology — IMPLEMENTATION VERIFIED

| Dependency | Version |
|---|---|
| `expo` | ~57.0.11 |
| `expo-router` | ~57.0.11 |
| `expo-sqlite` | ~57.0.1 |
| `react-native` | 0.86.2 |
| `react` | 19.2.3 |
| `axios` | ^1.19.0 |
| `zustand` | ^5.0.14 |
| `@react-native-async-storage/async-storage` | 2.2.0 |

`mobile/.npmrc` sets `legacy-peer-deps=true`. Expo SDK 57 has peer-dependency
conflicts with some React 19 packages and a plain `npm install` fails without it.

`mobile/AGENTS.md` carries a standing instruction: **read the versioned Expo docs
at `https://docs.expo.dev/versions/v57.0.0/` before writing code**, because Expo
changed substantially at this SDK.

---

## Navigation

`expo-router` — file-system routing over `app/`. **116 screen files.**

```text
app/
├── _layout.js          # root layout, providers, auth gate
├── index.js            # entry redirect
├── auth/               # login, password reset
├── admin/              # 60+ screens: students, classes, subjects, exams,
│                       #   marks, fees, finance, payroll, promotion, reports,
│                       #   settings, gate, sync-overwrites, announcements
├── teacher/            # a teacher's own classes, registers, marks, homework
├── student/            # a student's own record and learning
├── messages/           # staff and guardian threads
├── portal/             # guardian screens
└── sync/               # sync status and diagnostics
```

State is Zustand (`src/store/`), i18n is `src/i18n/` with complete `en` and `fr`
locale files, and `scripts/check.js` asserts they cover the same keys and that
every `t()` reference in the source resolves.

---

## The local database

`expo-sqlite`. Roughly **40 tables** created across `src/db/` and the service
layer.

`src/db/schema.js` declares 8 tables in a `SCHEMAS` map with an explicit
`{table, pk, columns, indexes}` shape and `createTableFromSchema()` as the only
sanctioned way to create them. The remaining tables are still created with inline
`CREATE TABLE IF NOT EXISTS` in their owning service — the migration to `SCHEMAS`
is **PARTIALLY IMPLEMENTED**.

### Naming rule — IMPLEMENTATION VERIFIED

> All column names are `snake_case` in the database. JavaScript uses `camelCase`
> and converts on read with `snakeToCamel()`.

This exists because mixed casing was breaking queries silently.

### The dirty flag

Syncable tables carry `_synced` (0 = local-only, 1 = confirmed by the server) and
some carry `_synced_at`. `mutationQueue.service.js` probes for `_synced_at` once
per table with `PRAGMA table_info` and caches the answer, because older installs
lack the column.

`SYNCABLE_LOCAL_TABLES` is the **allowlist** of tables whose dirty flag the queue
may clear:

```text
attendance, teacher_attendance, homework, homework_submissions,
exams, exam_subjects, exam_scores, classes, subjects, users,
teacher_assignments, timetable, students, announcements,
questions, quizzes, quiz_attempts, fee_structures
```

It is an allowlist because the table name is interpolated into SQL. It lives in
the queue rather than in the orchestrator so that **any** caller of `drain()`
gets correct flag-clearing — a direct drain from a screen must not leave rows
marked dirty forever.

`periods` is deliberately absent: it has no `_synced` column and tracks pending
work with `dirty`, cleared by its own reconciler.

---

## The mutation outbox

Table `mutation_outbox`, created by `src/services/mutationQueue.service.js`.

```sql
CREATE TABLE IF NOT EXISTS mutation_outbox (
  id              TEXT PRIMARY KEY,
  entity_key      TEXT NOT NULL,     -- stable per logical record
  method          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  base_version    TEXT,              -- optimistic-concurrency baseline
  status          TEXT NOT NULL DEFAULT 'pending',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  error           TEXT,
  conflict        TEXT,
  silent          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_mutation_outbox_pending
  ON mutation_outbox(status, next_attempt_at, created_at);
```

| Setting | Value |
|---|---|
| `MAX_RETRIES` | 8 |
| `BASE_BACKOFF_MS` | 5 000 |
| `MAX_BACKOFF_MS` | 1 800 000 (30 minutes) |

### Ordering

The pending index is `(status, next_attempt_at, created_at)`, so the queue drains
**in creation order** among rows that are due. `entity_key` coalesces: re-queuing
the same logical record merges onto the pending row rather than stacking a second
write for it.

`silent` marks non-user-data pings (receipt fetches and similar) so they do not
raise user-visible sync noise.

### Client-only payload keys

Four keys are stripped by `wireBody()` before the request leaves the device and
never reach the server:

| Key | Meaning |
|---|---|
| `__local` | `{table, ids}` — which local rows this request owns, so success can clear their `_synced` flags |
| `__resolve` | which payload fields hold ids that may need remapping |
| `__reconcile` | which reconciler to run on success |
| `__endpoints` | alternate endpoints to try |

### Error classification — IMPLEMENTATION VERIFIED

`classifyError()` returns one of four outcomes:

| Outcome | Triggered by |
|---|---|
| `transient` | no response at all (offline/DNS); `408`, `425`, `429`; any `5xx`; **and `409 IDEMPOTENCY_IN_PROGRESS`** — retrying is exactly right there, and the key guarantees a single write |
| `resolved` | `404`/`410` on a `DELETE` — a delete with nothing left to do has, in effect, succeeded |
| `conflict` | `412` or `409` (other than the idempotency code) |
| `permanent` | anything else 4xx |

Status transitions: `pending` → `retrying` while attempts remain →
`failed` once `MAX_RETRIES` is exhausted; `conflict` on 409/412;
`synced` on success.

---

## ID mapping

Table `sync_id_map`:

```sql
CREATE TABLE IF NOT EXISTS sync_id_map (
  local_id   TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  entity     TEXT,
  created_at TEXT
);
```

A record created offline gets a local id immediately. When the server accepts it
and answers with its own id, the pair is recorded, and every **later** queued
mutation that referenced the local id is rewritten before it is sent.

### Two rewrite paths, and why one is conservative

1. **Payload fields** — driven by `payload.__resolve`, an explicit list. The
   caller knows which of its fields hold an id; guessing by field name would
   rewrite a field that merely looks like one.
2. **URL segments** — every path segment is checked against the map, but only if
   it `looksLikeId()`: at least `MIN_ID_LENGTH` (8) characters.

The length floor exists because a short segment could collide with a **route
word**. Substituting a mapped value into the URL there would send the request
somewhere else entirely. No route word in this codebase reaches 8 characters, so
the floor closes it.

> Erring towards *not* rewriting is the safe direction: a missed rewrite fails
> loudly, a wrong rewrite succeeds quietly against the wrong record.

**TEST VERIFIED** by `scripts/check-id-map.js`.

---

## Score synchronization state

Added at commit `be2d2ac` to close a real gap: `countUnsyncedScores` had existed
since `exam_scores` was written and **was called by nothing**. A teacher entering
marks with no signal saw a save confirmation and no other indication that the
marks were still on the phone.

### Why a count was not enough

*"3 marks not uploaded"* is two opposite situations in one sentence: three queued
behind a bad line that will go on their own, and three the server refused that
never will. A teacher who sees the first every morning stops reading it, and the
morning it means the second looks identical.

### The classifier — `src/services/syncState.js`

Pure, dependency-free, and therefore testable without a device.

```js
classifyDirtyRows({ dirtyIds, outboxRows, table })
  → { pending, failed, orphaned, total }
```

| Bucket | Meaning |
|---|---|
| `pending` | a dirty row with an outbox entry in `pending` or `retrying` |
| `failed` | a dirty row with an outbox entry in `failed` or `conflict` |
| `orphaned` | **a dirty row with no outbox entry at all** |

A row that appears in both a failed and a pending entry counts as **failed** —
the safer of the two ways to be wrong. `syncStateLabel()` leads with the failure
whenever there is one.

### The orphaned state

Offline applications grow this state whether or not anybody designs it: a local
write whose queue entry never existed or was lost. Nothing retries those and
nothing counted them. One source was fixed earlier — a refused save used to leave
its local write behind — but *"the one we found"* is not *"cannot happen"*, so
orphans are counted **with the failures**.

### Where it surfaces

`ExamService.scoreSyncState()` → `app/admin/exams/marks.js`, refreshed on load
and in the save `finally` so a refused save updates the indicator too.

| State | Shown as |
|---|---|
| synchronised | nothing |
| pending | `marksEntry.marksPending` — cloud-upload icon, amber |
| failed / orphaned | `marksEntry.marksFailed` — alert icon, red |

**TEST VERIFIED** — `scripts/check-sync-state.js`, 28 assertions. Against the
previous commit 6 of them fail, including the five that assert a screen actually
calls it.

---

## Sync lifecycle

```mermaid
sequenceDiagram
    participant UI as Screen
    participant DB as SQLite
    participant Q as mutation_outbox
    participant M as syncManager
    participant S as Server

    UI->>DB: local write, _synced = 0
    UI->>Q: enqueue(entityKey, method, endpoint, payload)
    Note over Q: status = pending
    M->>M: trigger — reconnect, foreground, or enqueue
    M->>Q: drain() — due rows in created_at order
    Q->>Q: remapPayload() via sync_id_map
    Q->>S: replay the request (Idempotency-Key where applicable)
    alt 2xx
        S-->>Q: ok
        Q->>DB: clear _synced for payload.__local.ids
        Q->>Q: status = synced; record any new id in sync_id_map
    else transient
        S-->>Q: 5xx / 408 / 429 / no response
        Q->>Q: status = retrying, exponential backoff to 30 min
    else conflict
        S-->>Q: 409 / 412
        Q->>Q: status = conflict — a person must look
    else permanent
        S-->>Q: other 4xx
        Q->>Q: status = failed after MAX_RETRIES
    end
    M->>S: GET /sync/pull?lastSync=…
    S-->>M: six collections
    M->>DB: upsert, then store the new high-water mark
```

### Sync triggers

`syncManager.js` runs on a periodic timer plus event triggers: reconnect,
app foreground, and enqueue-then-drain. The interval was deliberately widened
from 30 s — at that cadence a full backfill + pull + quiz sweep ran twice a
minute, and on a bad link a pull that is going to fail can spend most of a minute
failing.

An iOS-specific note in the source: a permission dialog or a pulled-down
notification shade bounces the app through background/foreground, which would
otherwise re-trigger a sync cycle each time.

---

## Verification

```bash
cd OfflineSchoolApp/mobile
npm run check          # id-map, sync-state, parse+i18n, eslint, tsc --noEmit
```

**84 assertions** across `check-id-map.js` and `check-sync-state.js`, plus
`check.js` (parse and i18n parity), ESLint over `app src`, and
`tsc --noEmit`. All green at this commit, 0 lint errors.

The ESLint step is the one that catches what the other two cannot: hooks called
from plain helpers, and identifiers used but never imported. Both crash only at
runtime — the parse check and `tsc` stay green on them.

---

## Findings

| Item | Classification |
|---|---|
| `SCHEMAS` map in `src/db/schema.js` covers 8 of ~40 tables | **PARTIALLY IMPLEMENTED** — the rest still use inline `CREATE TABLE` in their service. |
| `/sync/push` in `src/services/apiEndpoints.js` | **UNUSED** — declared, never invoked. See [06](06-authentication-authorization.md). |
| `eslint-log.txt`, `mobile-check-log.txt` in the package root | Build artefacts checked into the working tree; not code. |
