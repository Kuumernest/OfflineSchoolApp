# 23 — Offline/Sync Reliability Audit

*Branch `ca-assessment`, on top of `a8bef54`. Does a mutation made offline
survive disconnection, retries, authentication changes, server rejection,
conflicts and reconnection without being lost, duplicated or misrouted? Each
statement is marked **VERIFIED** (a suite asserts it), **IMPLEMENTED** (fixed
in this pass, with its regression test), **KNOWN LIMITATION**, **UNTESTED**
or **DESIGN CHOICE**.*

Companion to [10-synchronization.md](10-synchronization.md), which describes the
two pull protocols; this document is about the write path.

## 1. Architecture map

Both clients replay ordinary REST requests from a durable local queue. There is
no bespoke push protocol and no batch endpoint (`POST /api/sync/push` exists
server-side and is called by nothing).

```
local storage ─────────── mutation ─────── queue ──────────── retry ──────── API ──── server ──── database ── reconciliation
mobile  SQLite (expo-sqlite)  service writes   mutation_outbox   MutationQueue   axios      Express     Mongo      _settle → reconciler,
        rows carry _synced /  the row and      one row per       .processPending api.js     routers     Mongoose   sync_id_map, _synced=1
        dirty                 enqueues         entity_key        backoff 5s→30m  refresh                          (mutationQueue.service.js)
desktop SQLite (better-sqlite) handlers put    outbox            engine.push     sync/       Express     Mongo      docs.settle(); response
        docs table, _pending   doc + queue     one row per       backoff 5s→10m  client.js   routers                document copied
        flag                   in one tx       HTTP request      strict FIFO     fetch                             (sync/engine.js)
```

| Step | Mobile (Expo) | Desktop (Electron) | Server |
|---|---|---|---|
| Local write | service function writes its table inside a transaction and calls `MutationQueue.enqueue` — `src/services/*.service.js` (37 call sites) | write handler returns `{collection, doc, request}`; `api/index.js handle()` puts the doc as `_pending` and `queue.add()`s the request in one transaction | — |
| Queue | `mutation_outbox` (`src/services/mutationQueue.service.js`): `id` (= Idempotency-Key), `entity_key`, `method`, `endpoint`, `payload` (JSON, with `__local`, `__reconcile`, `__resolve`, `__endpoints` metadata stripped before the wire), `base_version`, `status` pending/retrying/conflict/failed/synced, `retry_count`, `next_attempt_at`, `error`, `conflict`, `silent`, **`owner_id` (new)** | `outbox` (`src/main/db/outbox.js`, schema in `db/schema.js`): `seq` FIFO, `idem_key` UNIQUE, `dedupe_key`, `method`, `path`, `body`, `collection`, `doc_id`, `extra_docs`, `attempts`, `next_try_at`, `last_error`, `last_status`, `status` pending/blocked, **`user_id` (new, migration 4)** | — |
| Scheduler | `syncManager.syncAll()` on connectivity change, foreground, timer → `backfillOutbox()` (dirty rows without a queue row are enqueued) → `drainOutbox()` → `MutationQueue.drain()` | `engine.cycle()` on session set, reconnect, interval → `push()` then `pull()` | — |
| Send | `api.request` with `Idempotency-Key: row.id`, `If-Match: base_version`; ids rewritten through `sync_id_map` (`applyIdMap`); alternate endpoints tried on 404 (`sendWithFallback`) | `client.replay()` with `Idempotency-Key: idem_key`, token held in memory only | `middleware/auth.js` authenticates, refuses a body/query naming another school (`SCHOOL_ACCESS_DENIED`); `middleware/idempotency.js` scoped `(key, userId)`, stored response replayed, in-flight → `409 IDEMPOTENCY_IN_PROGRESS`, 5xx deletes the key; route authorization and relationship checks; attendance and scores derive `_id` from the natural key |
| Reconcile | `_settle`: row → synced, registered reconciler adopts the server id into `sync_id_map`, `_clearLocalFlag` sets `_synced=1` on the rows named by `payload.__local` | `queue.markSent` deletes the row; `docs.settle` clears `_pending` on the doc and `extra_docs`; response document copied into the mirror; next pull overwrites | — |

## 2. Queue behaviour

**Persistence.** Both queues are SQLite tables; nothing is held only in memory.
A row is written before any network attempt and survives process termination
(**VERIFIED**: mobile scenario 1 closes and reopens the database file; desktop
`check-outbox` "the queue survives the machine being switched off").

**Ordering.** Mobile drains by `created_at`; desktop by `seq`. Neither models
dependencies; both rely on "the order the user did things" plus the id map
(mobile) for a child queued behind its parent. Desktop is strict FIFO with
head-of-line blocking: a refused request stops the queue until a person
unblocks or discards it (**DESIGN CHOICE**, stated in `outbox.js`). Mobile
parks the refused row and continues.

**Retries.** Mobile: transient (no response, 5xx, 408/425/429, 409
IDEMPOTENCY_IN_PROGRESS) → exponential backoff 5 s to 30 min, 8 attempts, then
`failed`; conflict (409/412) → `conflict`; 404/410 on DELETE → settled; 401 or
403 PASSWORD_CHANGE_REQUIRED → drain stops, rows stay `pending`; other 4xx →
`failed`. Desktop: no status/408/429/5xx/409 IN_PROGRESS → backoff 5, 15, 60,
300, 600 s without an attempt cap; other 4xx → `blocked`; 401 → cycle stops
`unauthenticated`, rows untouched.

| Failure | Mobile | Desktop | Class |
|---|---|---|---|
| network / timeout | retrying, backoff | pending, backoff | retryable |
| 5xx, 408, 429 | retrying | pending | retryable |
| 409 IDEMPOTENCY_IN_PROGRESS | retrying | pending | retryable |
| 401, 403 PASSWORD_CHANGE_REQUIRED | pending, drain stops | pending, cycle stops | requires authentication |
| 412 / 409 (other) | conflict | blocked | requires user intervention |
| 400, 403, 404 (non-DELETE), 422 | failed | blocked | permanently failed, preserved |
| 404/410 on DELETE | synced (nothing left to do) | blocked | resolved / requires user |
| 8 transient attempts exhausted | failed | n/a (no cap) | requires user intervention |
| no endpoint / unreadable payload | failed (new) | blocked (new) | permanently failed, preserved |

Every terminal state keeps the row. `discard` (both) and `cancelUnsent`
(mobile) are the only deletions of unsent work, and both are user actions.

**Authentication.** Mobile: the axios layer refreshes an expired access token
(refresh token, then access-token mode) before a 401 reaches the queue; sync
routes never auto-logout. Logout stops the sync manager and clears secure
storage but leaves SQLite, including the outbox, intact. Desktop: the token is
held in memory only; logout sets it to null, and a queued request then fails
`NO_TOKEN` (retryable, kept).

**Reconciliation.** A success is not "HTTP 2xx"; both clients then clear the
local dirty/pending flag and adopt the server's ids. A reconciler failure on
mobile is logged and the row still counts as synced (the `_synced` flag is
cleared by `_clearLocalFlag` independently) — **KNOWN LIMITATION**: a reconciler
that throws leaves a local id unmapped until the next pull.

**Duplicates.** Three layers (see docs/10 §Idempotency): derived `_id`s for
attendance and scores; `Idempotency-Key` per operation, `(key, userId)` scoped,
replaying the stored response; client-supplied ids answered `replay: true`.
Coalescing on mobile (one row per `entity_key`) is now limited to rows never
attempted (§4, defect D1).

## 3. Test matrix

New suites: `mobile/scripts/check-sync-reliability.js` (40) and
`desktop/scripts/check-sync-reliability.js` (24), both in the `check` chains,
and `backend/scripts/check-create-replays.js` (18) in `check:all`.
Existing: mobile `check-outbox-drain` (37), `check-sync-state` (28),
`check-id-map` (11); desktop `check-outbox` (57), `check-sync-engine` (48),
`check-crash-seams` (9); backend `check-idempotency`, `check-conflicts`,
`check-sync-cursor`, `check-desktop-parity` (1,364, includes replay against the
real middleware), `check-cross-school`, `check-tenant-ids`.

| Scenario | Current behaviour | Result | Risk | Fix |
|---|---|---|---|---|
| Offline create | row written before any send; drained once on reconnect; `_synced` cleared, id mapped | RECONCILED — VERIFIED (drain A, reliability 1) | — | — |
| Offline update | later edit coalesces onto the pending row (mobile); separate request (desktop) | RECONCILED — VERIFIED (drain B) | see "coalesce after attempt" | D1 |
| App restart | rows and attempt counts persist in SQLite | PRESERVED — VERIFIED (mobile 1, desktop check-outbox) | — | — |
| Network interruption mid-batch | one request per row; dropped row backs off in place, later rows proceed (mobile) / wait (desktop) | RETRYABLE, PRESERVED — VERIFIED (drain C, desktop "backs off keeping its place") | — | — |
| Duplicate sync (drain twice) | nothing pending on the second pass | RECONCILED once — VERIFIED (mobile 2) | — | — |
| Lost response, retry with same key | server answers from memory; applied once | RECONCILED once — VERIFIED (mobile 3, desktop 1, parity replay) | — | — |
| **Coalesce after a lost-response attempt** | **the correction reused the sent key and was answered with the old result: correction lost** | **SILENTLY LOST → fixed: RECONCILED** (mobile 4) | was a blocker | **D1** |
| Auth expiry (access token) | axios refreshes; queue never sees it | RECONCILED — VERIFIED (api layer) / drain F for the 401 case | — | — |
| Auth expiry (refresh invalid) | 401 → drain stops, rows pending; sent after sign-in in order | PRESERVED — VERIFIED (drain F, desktop 6) | — | — |
| **Account switch on the same device** | **the new account's token sent the old account's rows** | **WRONG ACCOUNT → fixed: HELD** (mobile 5, desktop 2) | was a blocker | **D2, D3** |
| **Ownerless row (queued before owners were recorded)** | **held under every account; never stamped; discardable** | **HELD, PRESERVED** (mobile 5b, desktop 2b) | recovery is a person's action (§7) | **D6** |
| **Create committed, then 5xx** | **key deleted, retry reaches the handler; four creates made a second record** | **DUPLICATE → fixed: replay by client id** (backend check-create-replays) | six creates end 409 instead (§8) | **D7** |
| Partial batch (one refused) | mobile parks the row and continues; desktop stops at it, nothing removed | PRESERVED — VERIFIED (drain G, mobile 8/10, desktop 5) | head-of-line on desktop is by design | — |
| Conflict (412) | parked as conflict with the server's current version; a person releases or discards | REQUIRES USER — VERIFIED (drain E) | only homework checks If-Match; others last-write-wins | none (documented) |
| Stale / foreign ids | server refuses (403 SCHOOL_ACCESS_DENIED, 404); row parked, releasable | PERMANENTLY FAILED, PRESERVED — VERIFIED (mobile 8, backend cross-school 15 / tenant-ids 53) | — | — |
| Large queue | 500 rows (drain H, 188 ms), 200 rows with a refusal in the middle: order kept, none dropped or doubled | RECONCILED — VERIFIED (mobile 10) | — | — |
| **Malformed queue row** | **mobile: a row with no endpoint made the drain throw, stranding every row behind it for ever; desktop: an unparseable body threw inside batch selection, ending every cycle** | **INFINITE, UNRECOVERABLE → fixed: PERMANENTLY FAILED, PRESERVED** (mobile 9, desktop 3) | was a blocker | **D4, D5** |
| Deleted server record | PUT → 404 → failed/blocked with the reason; DELETE → 404 settles (mobile) | PRESERVED — VERIFIED (mobile 7, desktop 5) | — | — |
| Transient server failure (5xx) | backoff, not resent early, applied once on recovery | RECONCILED — VERIFIED (mobile 6, desktop 4) | — | — |

## 4. Defects found and fixed

- **D1 — mobile, correction lost after a lost response.** `MutationQueue.enqueue`
  coalesced any later edit onto the pending row for the same `entity_key`,
  including a row already attempted once. The server had committed the first
  version under that Idempotency-Key, so the retry — carrying the new payload
  with the old key — was answered from memory and the correction vanished.
  Fix: coalesce only onto rows with `retry_count = 0 AND last_attempt_at IS
  NULL`; an edit after an attempt is a new row queued behind it. Test: mobile 4.
- **D2 — mobile, another account's rows sent.** The outbox had no owner; logout
  leaves SQLite intact; the next sign-in drained everything under its token.
  Fix: `owner_id` column set at enqueue from the signed-in account; drain,
  stats and the unresolved list consider only that account's rows (and legacy
  rows with no owner); held rows are reported as `heldForOtherUser`. Test:
  mobile 5.
- **D3 — desktop, the same.** Fix: migration 4 adds `outbox.user_id`, set by the
  request handler from the session; the engine asks `currentUser()` each request
  and batches only that account's rows. Test: desktop 2.
- **D4 — mobile, a row with no endpoint threw out of the drain.** `sendWithFallback`
  had no candidates and threw `undefined`; the catch read `.message` of it, the
  drain threw, and the row and everything after it never moved. Fix: a row with
  no endpoint is a permanent refusal (`NO_ENDPOINT`); the catch reads the
  message defensively. Test: mobile 9.
- **D5 — desktop, an unparseable body threw inside `nextBatch`.** Every cycle
  ended at the same row. Fix: the row is parked `blocked` with the parse error
  and the queue stops behind it as for any refusal. Test: desktop 3.

- **D6 — both clients, an ownerless row adopted by the next account.** The
  first version of the owner filter sent rows with no owner (queued before the
  column existed) under whoever signed in, which is a stamp of ownership nobody
  gave. Fix: an ownerless row matches no account; it is held, counted
  (`heldOwnerless` / `stats.ownerless` on the phone, `summary.ownerless` on the
  desktop) and left alone. The legacy `sync_queue` migration now writes its
  rows ownerless too. Tests: mobile 5b, desktop 2b. See §7.
- **D7 — server, four creates that made a second record on a retried request.**
  `POST /gate/scan`, `POST /quiz/questions`, `POST /quiz/quizzes` and
  `POST /templates` assigned their own id and had no replay guard, so a
  commit-then-5xx retry (the idempotency key is deleted on 5xx) inserted again —
  and a replayed scan would message the guardian twice. Fix: each recognises
  the client's id and answers a repeat with the record it already made (gate and
  templates take the id as `_id`, as payments and classes do; the ObjectId-keyed
  quiz models keep it as `client_id`, unique per school). Test:
  `backend/scripts/check-create-replays.js` (18). See §8.

Server: authorization is untouched; all authorization suites pass.

Test-only: `backend/scripts/check-attendance-reminders.js` seeds two slots for
one teacher in one period on purpose; the timetable's unique index forbids that
write today, and whether the seed beat the index build was a race that lost
under load during this pass. The suite now drops that index before seeding,
as the schedule-roster suite already did; no assertion changed.
`mobile/scripts/check-outbox-drain.js` now stubs a signed-in teacher, as the
other mobile suites do: with the real auth helper and no store, every row it
queued was ownerless and, correctly, held. `desktop/scripts/check-sync-reliability.js`
sets `process.exitCode` instead of forcing `process.exit()`, which on Windows
tripped a libuv assertion while fetch was still closing its kept-alive sockets
and turned a 24/0 run into a failed chain link. No assertion changed in either.

## 5. Data-loss assessment

After the fixes, every scenario in §3 ends in one of RECONCILED, RETRYABLE
AND PRESERVED, PERMANENTLY FAILED BUT PRESERVED, or REQUIRES USER ACTION.
None ends SILENTLY LOST. Of the listed release blockers: the lost coalesced
correction (D1), the wrong-account replay (D2/D3) and the malformed row that
strands the queue (D4/D5) were real and are fixed with regression tests; a
successful server write followed by local deletion, a wrong-school execution,
a batch removed because one member failed, and queued rows disappearing on
authentication failure were each tested and did not occur. A duplicate create
from a retry was possible on four routes (D7) and is fixed; on six others the
retry is refused by a unique index and waits for a person (§8).

## 6. Authentication and school isolation

- A payload naming another school is refused at the door for every route
  (`SCHOOL_ACCESS_DENIED`) regardless of what the device believes —
  **VERIFIED** by the cross-school and tenant-id suites, and by mobile 8.
- A row from account A is no longer sent under account B on either client
  (**IMPLEMENTED**, D2/D3). Server-side idempotency is `(key, userId)`-scoped, so
  even before the fix a replay under B was a fresh request evaluated as B; it
  is now not sent at all.
- Rows queued before this change carry no owner and are **never sent under
  any account** (**IMPLEMENTED**, D6; §7).
- The server, not the device, decides authorization at the moment a replay
  lands: a capability revoked while offline refuses the queued write.

## 7. Legacy ownerless queue rows

**Invariant: OWNERLESS QUEUED MUTATIONS MUST NEVER BE EXECUTED UNDER A
DIFFERENT ACCOUNT.** An ownerless row was queued by an account nobody can
name; whoever signs in next is not thereby its author.

**Schema.** Mobile: `mutation_outbox.owner_id TEXT` added with `ALTER TABLE …
ADD COLUMN` in `ensureSchema` (NULL for every pre-existing row). Desktop:
migration 4 in `db/schema.js` adds `outbox.user_id TEXT` (NULL for every
pre-existing row).

**Runtime path.** Mobile: sign-in → `SyncManager.syncAll` → `MutationQueue.drain`
→ `processPending` reads the signed-in account from `getCurrentAuth()`
(`utils/authHelpers.js`) and selects
`status IN ('pending','retrying') AND … AND owner_id = ?`; a NULL owner
matches nothing. Held ownerless rows are counted in the drain summary
(`heldOwnerless`) and in `getStats().ownerless`; `enqueue` stamps the
signed-in account, and the only path that writes NULL on purpose is
`migrateLegacyQueue` (rows from the abandoned `sync_queue` table). Logout
stops the sync manager and leaves SQLite intact. Desktop: `session:set` →
`engine.cycle` → `push` → `queue.nextBatch(1, { userId: currentUser() })`
selects `user_id = ?`; with no account named (tests, tooling) the whole line is
read as before, but the engine always names one. `summary().ownerless` counts
the held rows; `discard` removes one on a person's decision.

**Behaviour, both clients, VERIFIED** (mobile 5b, desktop 2b): an ownerless
row is not executed as account A, not executed as account B after a logout and
login, keeps `status = pending` and `owner_id / user_id = NULL`, is never
stamped, and can be removed with the queue's `discard`. Account B's own line
still moves past it.

**Can an ownerless row ever execute under a new account?** No. The only way
for it to be sent is a caller that names no account at all
(`nextBatch(limit)` with no `userId`), which the running application never
does. **KNOWN LIMITATION:** the counts are exposed (`stats.ownerless`,
`summary().ownerless`) but neither sync screen lists these rows or offers an
action on them — the mobile unresolved list shows only the signed-in
account's conflict/failed rows, the desktop stuck list only blocked rows. So
today they sit in the table indefinitely, harmless and invisible. Showing
them, with discard or a re-queue-as-mine action, is a product decision.

## 8. Commit-then-5xx create safety

**Middleware.** `backend/middleware/idempotency.js` records
`(Idempotency-Key, userId)` as *processing* before the handler runs, answers a
concurrent repeat with `409 IDEMPOTENCY_IN_PROGRESS`, stores the response when
the handler answers with a status below 500, and **deletes the record on 5xx**
so a genuine retry can run. The unprotected window is therefore: the handler
writes the database, then something throws before the response (or the
connection drops before the response is sent). The retry reaches the handler
again, and only the handler can recognise it.

**Inventory** — every create the two offline queues can send (mobile
`enqueue` call sites plus the backfill specs; desktop write handlers):

| Endpoint | Client | Create type | Idempotency protection | Deterministic ID / upsert | Commit-then-5xx safe? | Reason |
|---|---|---|---|---|---|---|
| POST /attendance/students, /students/bulk | mobile, desktop | mark (upsert) | key sent | yes: `attendanceId(school,class,student,subject,period,date)`, upsert; change-log skips unchanged | **SAFE** | replay upserts the same document |
| POST /attendance/teachers, /teachers/bulk | mobile, desktop | mark (upsert) | key sent | yes: `teacherAttendanceId`, upsert | **SAFE** | same |
| POST /exams | mobile, desktop | create | key sent | client `examId`, replay 200 | **SAFE** | replay guard; partial subject creation after a mid-way failure is a KNOWN LIMITATION (no duplicate exam) |
| POST /exams/:id/subjects | mobile, desktop | create | key sent | client id, replay 200, 409 on conflict | **SAFE** | replay guard |
| POST /exams/:id/scores/bulk | mobile, desktop | marks (upsert) | key sent | prior lookup by (exam, student, subject), upsert | **SAFE** | idempotent by nature |
| POST /exams/:id/process | desktop | compute | key sent | upsert of summaries | **SAFE** | idempotent |
| POST /fees/payments | mobile (backfill sends `_id`), desktop | create | key sent | client `_id`, replay 200; 11000 → 409 | **SAFE** | replay guard + unique key |
| POST /fees/payments/:id/reverse | desktop | create (reversal) | key sent | prior reversal replay 200 | **SAFE** | replay guard |
| POST /fees/plans | desktop | create | key sent | server id when body has none; unique (school, student, year, term) | **SAFE from duplicate; KNOWN LIMITATION** | a retry after commit answers 409, desktop blocks for a person |
| POST /fees/structures | mobile (sends `_id`), desktop (no id) | create | key sent | `_id: body._id \|\| uuid`; unique (school, year, classIds, term) | **SAFE from duplicate; KNOWN LIMITATION** for desktop | both end 409 on retry |
| POST /fees/structures/:id/apply | mobile, desktop | raise charges | key sent | `applyStructure` skips existing (unique FeeCharge per structure) | **SAFE** | idempotent, reports `skipped` |
| POST /finance/expenses | mobile (`_id`), desktop | create | key sent | client `_id`, replay 200 | **SAFE** | replay guard |
| POST /finance/expense-categories | desktop | create | key sent | server id; unique (school, code) → 409 | **SAFE from duplicate; KNOWN LIMITATION** | retry ends 409 |
| POST /finance/salary-structures | desktop | create | key sent | client id replay 200 | **SAFE** | replay guard |
| POST /gate/scan | mobile (sends `_id`) | create + notification | key sent | **now**: client `_id` honoured, replay 200 `replay:true`; time debounce also | **SAFE (fixed, D7)** | was CONFIRMED VULNERABLE: server id, second event and second guardian message on retry |
| POST /homework | mobile | upsert | key sent | client id, `findOneAndUpdate … upsert` | **SAFE** | idempotent |
| POST /homework/:id/submissions | mobile | submit | key sent | `$pull` then push per student | **SAFE** | one submission per student |
| POST /messages/conversations/:id/messages | mobile | create | key sent | `clientId` dedupe → 200 | **SAFE** | replay guard |
| POST /messages/conversations/:id/read | mobile | marker | key sent | idempotent markers | **SAFE** | — |
| POST /students (direct enrol) | mobile | create | key sent | client `_id`, replay 200; 11000 handled | **SAFE** | replay guard runs first |
| POST /admin/classes, /admin/subjects | mobile (backfill `id`), desktop | create | key sent | client `id` as `_id`, replay 200 | **SAFE** | replay guard |
| POST /admin/teacher-assignments, /admin/assignments | desktop | create | key sent | client `id` replay 200; unique (teacher, class, subject) | **SAFE** | replay guard |
| POST /admin/teachers | mobile (backfill) | create | key sent | e-mail uniqueness in pre-save; conflict 409 / restore path | **SAFE from duplicate** | a retry answers 409 or restores the same account |
| POST /admin/periods | mobile (backfill), desktop | create | key sent | server id; overlap check → 409 | **SAFE from duplicate; KNOWN LIMITATION** | retry ends 409 |
| POST /admin/students/:id/enrollment-number | desktop | assign | key sent | returns existing number | **SAFE** | idempotent |
| POST /admin/timetable | mobile (backfill), desktop | create | key sent | client `_id` replay 200; unique (class/teacher, day, period) → 409 | **SAFE** | replay guard |
| POST /quiz/questions | mobile (backfill `id`) | create | key sent | **now**: `client_id` unique per school, replay 200 | **SAFE (fixed, D7)** | was CONFIRMED VULNERABLE: ObjectId key, client id dropped |
| POST /quiz/quizzes | mobile (backfill `id`) | create | key sent | **now**: `client_id` unique per school, replay 200; the analytics upsert after the insert was the window | **SAFE (fixed, D7)** | was CONFIRMED VULNERABLE |
| POST /quiz/attempts | mobile | create | key sent | existing (quiz, user) replay 200 | **SAFE** | replay guard |
| POST /templates | desktop (sends `_id`) | create | key sent | **now**: client `_id` honoured, replay 200 | **SAFE (fixed, D7)** | was CONFIRMED VULNERABLE: server uuid |
| POST /templates/:id/duplicate | desktop | create | key sent | client `_id` replay 200 | **SAFE** | replay guard |

Creates not available offline (no queue call site): parents/guardians, school
settings, platform administration, approvals, payroll runs, announcements
(the queued announcement actions are read/pin/acknowledge markers).

**Testing the risk.** The existing harnesses cannot make a handler commit and
then fail without fault injection, so the four fixes are proven the way the
codebase proves its other replay guards: the same create sent twice with no
Idempotency-Key must yield one record and a `replay: true` second answer
(`check-create-replays.js`, 18 assertions, covering another school reusing the
id and a create without an id). The attendance and scores paths were already
covered by the parity replay and register suites. **UNTESTED**: an actual
mid-handler exception in production; the classification above is from the
handlers' order of operations.

**Remaining risk.** Six creates (fee plans, fee structures from the desktop,
expense categories, teachers, periods, and any unique-index refusal) cannot
duplicate but cannot self-heal either: the retry is refused 409 and the row
waits for a person. A product decision could make those replay by client id
the way payments do.

## 9. Remaining risks

**Confirmed defect:** none open.

**Known limitations**
- A handler that commits and then answers 5xx deletes its idempotency key and
  the retry re-executes. Every create the queues can send now either upserts,
  replays by client id, or is refused by a unique index (§8); for the last
  group the retry ends 409 — held for a person rather than duplicated or
  self-healed.
- Only the homework routes check `If-Match`; other updates are last-write-wins
  with no conflict signal. No conflict strategy was invented.
- Desktop head-of-line blocking: a refused request holds every later request
  until a person acts (by design; surfaced on the sync screen).
- The desktop outbox summary counts another account's held rows as pending.
- A mobile reconciler that throws leaves the local id unmapped until the next
  pull.
- Rows queued before ownership was recorded are held and never sent, and no
  screen yet shows them or offers to discard them (§7).

**Untested behaviour**
- Two real devices editing one record (docs/10 already lists this).
- Airplane mode toggled mid-request on a physical device; the harness models
  the network at the client boundary.
- Refresh-token rotation (the server does not rotate).

**Acceptable design choices**
- Replaying the exact HTTP request rather than a mutation format.
- One request per row rather than batches.
- Mobile continues past a refused row; desktop stops.
