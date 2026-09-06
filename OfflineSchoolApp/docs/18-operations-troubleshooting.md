# 18 — Operations and Troubleshooting

*Documented commit `be2d2ac`.*

Each runbook follows the same shape: **symptom → likely causes → how to
investigate → safe recovery → when not to touch the data.**

> **Standing rule for every runbook below.** Diagnostics against a live database
> are **read-only** unless a named person has authorised a specific write. There
> is no undo. Where a runbook says "do not modify data manually", that is not
> caution for its own sake — it is because the audit trails in this system are
> written by the application, and a manual edit produces a record with no history
> and no actor.

---

## 1. Backend fails to start

**Symptom.** The process exits immediately, printing a list of problems.

**Likely causes.** A missing or placeholder environment variable.

**Investigate.** Read the printed list — `config/env.js` names each problem:

```text
Cannot start — the environment is incomplete:
    · MONGODB_URI is not set
    · JWT_SECRET is still a placeholder value
```

**Recovery.** Set the named variables. `JWT_SECRET` must be 32+ characters and
must not be one of: `change-me`, `changeme`, `secret`, `your-secret-key`,
`your_jwt_secret`, `supersecret`, `jwt-secret`.

**Do not** disable `validateEnv` to get past it. It is refusing for a reason,
and a backend running on a guessable secret issues forgeable tokens.

---

## 2. Missing environment variable in production

**Symptom.** Started in development, refuses in production.

**Cause.** `ALLOWED_ORIGINS` is `REQUIRED_IN_PRODUCTION` only.

**Investigate.**

```bash
docker compose logs backend | head -20
```

**Recovery.** Set `ALLOWED_ORIGINS` to a comma-separated list of the real console
origins. An empty allow-list rejects the web console itself.

---

## 3. Database unavailable

**Symptom.** Startup hangs or 500s on every route.

**Likely causes.** Wrong `MONGODB_URI`; Atlas IP allowlist; the `mongo` container
unhealthy; wrong `MONGO_USER`/`MONGO_PASSWORD`.

**Investigate.**

```bash
docker compose ps                 # is mongo healthy?
docker compose logs mongo | tail -30
```

The compose healthcheck runs `db.adminCommand('ping')` every 10 s, and `backend`
has `depends_on: condition: service_healthy`.

**Recovery.** Fix credentials or the allowlist and restart. Mongo publishes **no
host port** by design — connect through the backend container, not from the host.

**Do not** add a host port mapping to debug. Publishing 27017 invites the
internet to try the password.

---

## 4. Mobile cannot connect

**Symptom.** Every request fails; the app behaves as permanently offline.

**Likely causes.**

1. `EXPO_PUBLIC_API_URL` unset in the build — check the startup warning:
   *"EXPO_PUBLIC_API_URL is not set — a release build has no server to talk to."*
2. Pointed at `localhost` — a device is not the host machine; use the LAN address.
3. TLS: a release build against a plain-HTTP endpoint is blocked by ATS (iOS) and
   cleartext policy (Android).

**Investigate.** Open the in-app sync screen (`app/sync/`), which shows link
quality and last-sync state.

**Recovery.** Rebuild with the correct `EXPO_PUBLIC_API_URL`.

**Do not** clear the local database to "fix" connectivity — unsynced work lives
there. Confirm the queue is empty first (runbook 6).

---

## 5. CORS failure

**Symptom.** Browser console: *"blocked by CORS policy"*. The API works from
`curl`.

**Cause.** The origin is not in `ALLOWED_ORIGINS`, and `NODE_ENV=production`.

**Investigate.** Compare the browser's `Origin` header with the configured list.
Scheme and port are part of an origin: `https://x.com` ≠ `http://x.com` ≠
`https://x.com:8443`.

**Recovery.** Add the exact origin and restart.

**Do not** set `NODE_ENV` to something other than `production` to make CORS
permissive. That also disables `trust proxy`, so the login rate limiter starts
counting the whole school as one client.

---

## 6. Pending synchronization

**Symptom.** The marks sheet shows *"N marks waiting"*.

**Meaning.** Normal. Rows are dirty **and** an outbox entry in `pending` or
`retrying` is carrying them. They will go when the connection returns.

**Investigate.**

```sql
SELECT status, COUNT(*) FROM mutation_outbox GROUP BY status;
SELECT id, endpoint, retry_count, next_attempt_at, error
  FROM mutation_outbox WHERE status IN ('pending','retrying')
  ORDER BY created_at LIMIT 20;
```

**Recovery.** Restore connectivity. Backoff runs 5 s → 30 min, so a device that
has been offline a long time may wait up to 30 minutes; foregrounding the app
triggers a drain immediately.

**Do not** delete outbox rows to clear the indicator. Each row is somebody's
unsent work.

---

## 7. Failed synchronization

**Symptom.** The marks sheet shows *"N marks failed"* (red).

**Meaning.** Dirty rows whose outbox entry is `failed` or `conflict`, **or**
orphans (runbook 8). These will **not** resolve themselves.

**Investigate.**

```sql
SELECT id, endpoint, status, retry_count, last_status, error, conflict
  FROM mutation_outbox WHERE status IN ('failed','conflict');
```

| `status` | Meaning |
|---|---|
| `failed` | 8 retries exhausted, or a permanent 4xx |
| `conflict` | server answered `409`/`412` — someone else changed it |

Then check the server for that request's rejection.

**Recovery.**

- **Permission** (`403`) — grant the permission and re-queue.
- **Validation** (`400`) — the payload is wrong; correct it in the app and re-save.
- **Conflict** (`409`/`412`) — a person must decide. Check
  `GET /api/attendance/history` or `ResultChangeLog` for what the server holds
  now, then re-enter the correct value.

**Do not** mass-clear failed entries. A `failed` entry is a write the server
declined; clearing it loses the work and leaves the local row dirty forever —
which is exactly how orphans are created.

---

## 8. Orphaned dirty scores

**Symptom.** `scoreSyncState()` reports `orphaned > 0`. The count is shown with
the failures.

**Meaning.** A local row is marked `_synced = 0` and **no outbox entry references
it**. Nothing retries it; nothing will.

**Investigate.**

```sql
SELECT id FROM exam_scores WHERE _synced = 0;
SELECT payload FROM mutation_outbox WHERE status != 'synced';
```

An id in the first result whose value appears in no `payload.__local.ids` is an
orphan.

**Root causes seen.** A refused save that left its local write behind (fixed), an
outbox row deleted manually (runbook 7), or a crash between the local write and
the enqueue.

**Recovery.** **Re-enter and re-save the affected marks through the app.** That
writes the row and enqueues a request together, which is the only supported way
to make a dirty row reachable again.

**Do not** flip `_synced = 1` by hand. That marks the row as confirmed by a
server which never received it, and the mark is then lost permanently and
silently — strictly worse than the orphan.

---

## 9. Sync cursor issues

### Mobile

**Symptom.** A device is missing records everyone else can see.

**Investigate.** Check the stored cursor (`sync_last_timestamp` in AsyncStorage).
A value in the **future** is clamped to the epoch by the server, with a warning
in the backend log:

```text
[sync] ⚠️  lastSync (…) is in the future — clamping to epoch
```

**Recovery.** Clear the stored timestamp; the next pull re-fetches everything.
Safe — every pull applies as an upsert.

### Desktop

**Symptom.** A collection stops receiving updates while others keep syncing.

**Cause.** The known, deliberately unguarded case: a document whose `updatedAt`
is **ahead of the clock** — a data import that preserved original timestamps, or
a deliberate future date — moves that collection's cursor past it. Every row
written afterwards sorts *before* the cursor and is never offered again.

**Investigate.**

```sql
SELECT collection, cursor FROM sync_state;
```

Decode the cursor (`{at, id}`) and compare `at` with now. An `at` in the future is
the fault.

Then, server-side and **read-only**:

```js
db.<collection>.find({ schoolId, updatedAt: { $gt: new Date() } }).limit(5)
```

**Recovery.** Clear that collection's cursor row. The next cycle re-pulls the
whole collection; documents apply as upserts.

**Do not** "fix" the future timestamps by rewriting `updatedAt` in bulk. That
changes every other device's view of what has changed and can trigger a
system-wide re-sync at the worst moment. Clear the cursor instead.

---

## 10. Duplicate payment investigation

**Symptom.** A family reports being charged twice, or a bursar sees two identical
receipts.

**First question: did the client send an id?**

| Client behaviour | Expected result |
|---|---|
| `Idempotency-Key` sent | one payment |
| client `_id` sent | one payment |
| **neither** | **two payments — documented, correct behaviour** |

**Investigate — read-only.**

```js
db.feepayments.find({ schoolId, studentId, amount, receivedAt: { $gte: from, $lt: to } })
db.idempotencykeys.find({ userId })   // TTL 14 days — older keys are gone
```

Compare `createdAt`. Two rows seconds apart with different `_id`s and no shared
key is a client that sent neither.

**Recovery.** **Reverse, never delete.**

```http
POST /api/fees/payments/:id/reverse
```

This appends a **negative** paired row with `reversesId`, sets `reversedById` on
the original, and records `reversalReason`. The balance corrects itself because it
is a plain sum.

**Do not** delete a `FeePayment`. The ledger is append-only; a deleted payment
leaves a receipt number issued against nothing and a balance that cannot be
reconciled against the receipts a family holds.

---

## 11. Attendance conflict investigation

**Symptom.** *"My child was marked absent and the form master says present."*

**Investigate.**

```http
GET /api/attendance/history?studentId=<id>&date=2026-09-03
GET /api/attendance/history?studentId=<id>&from=2026-09-01&to=2026-09-30&limit=100
```

Requires `staffRead` and is scoped to the caller's school. Each row gives
`previousStatus` → `newStatus`, `previousMarkedBy` / `previousMarkedAt`,
`changedBy` / `changedByName` / `changedByRole` / `changedAt`, and `source`.

**Reading the result.**

| Observation | Interpretation |
|---|---|
| No history row at all | The mark was **created**, never changed. A first mark writes no row. |
| One row, `source: "sync"` | A device's outbox drained late and overwrote a later correction. |
| Several rows alternating | Genuine disagreement between two people. |
| Nothing for a **staff** register | Expected — `POST /api/attendance/teachers/bulk` does not write history. |

**Recovery.** Re-mark through the app. The correction is itself recorded.

**Do not** edit `StudentAttendance` directly. The history is written by the route,
so a direct edit produces a change with no record of who made it — precisely the
situation `AttendanceChangeLog` exists to end.

---

## 12. Result audit investigation

**Symptom.** *"This mark is not what was published."*

**Investigate.** `ResultChangeLog`, read-only:

```js
db.resultchangelogs.find({ schoolId, examId, studentId }).sort({ changedAt: -1 })
```

| Field | Read it as |
|---|---|
| `field`, `oldValue`, `newValue` | what actually changed |
| `reason` | the `changeReason` the editor supplied |
| `isOverride: true` | edited against a lock |
| `action: "locked" / "unlocked"` | lock transitions |
| `batchId` | groups a bulk edit — look for siblings |
| `changedByName`, `changedByRole` | denormalised, because users get renamed |

**If a change has no log entry**, it predates the audit trail on that path. Say so
plainly rather than inventing a history.

**Recovery.** Correct through the app, supplying a `changeReason`. Lock the
results afterwards.

**Do not** edit `StudentScore` or `ResultSummary` directly. Positions and
averages are computed; a hand-edited mark leaves rankings inconsistent with the
marks they were computed from.

---

## 13. Reprocessing published exams

**When.** After correcting marks in a published exam, or to remediate results
published before the lock check existed (see
[19-known-limitations.md](19-known-limitations.md)).

**Procedure.**

```http
PATCH /api/exams/:examId/unlock      # body: { "reason": "…" } — required
POST  /api/exams/:examId/process     # recompute summaries and positions
```

then re-publish and re-lock.

`resultStaleness.service.js` can identify published results whose inputs have
since moved — that is the list to work from.

**Order matters.** Recomputing changes `classPosition`, `schoolPosition` and
`gradePosition` for **every pupil in the class**, not only the one whose mark
changed. Report cards already issued to other families become out of date.

**Do not** reprocess a published exam without telling the school first. Families
have paper.

---

## 14. Web console does not load

**Symptom.** `GET /` returns nginx's 404; `/api/health` works.

**Cause.** The confirmed defect in the bundled Compose stack: `nginx.conf` roots
`location /` at `/app/public/web`, and the `nginx` service mounts only
`nginx.conf`. Nothing serves the SPA. See
[17-deployment.md](17-deployment.md).

**Investigate.**

```bash
docker compose exec nginx ls -la /app/public/web    # expect: no such directory
docker compose exec backend ls -la /app/public/web  # the build is here
```

**Recovery.** Mount the build into nginx, or serve it from Express and point
`location /` at the backend. Either way keep `try_files … /index.html`.

---

## 15. Uploaded files return 403

**Symptom.** Message attachments 403 while photos and logos load.

**Cause.** `REQUIRE_MEDIA_SIGNATURE=1` with clients still holding unsigned URLs.
Only the `messages` prefix is gated.

**Recovery.** Signatures last 7 days. Turn enforcement **off**, let clients pick
up signed URLs for one full signature lifetime, then turn it on — which is the
sequence `nginx.conf` describes.

**Do not** serve `/uploads/` from nginx's disk to work around it. That
reintroduces an ungated path to guardian correspondence and pupils' photographs.

---

## Health and routine checks

```bash
# Is the API up?
curl -s http://<host>/api/health

# Does this commit still pass its own gates?
cd OfflineSchoolApp/backend && npm run check:all
cd ../mobile   && npm run check
cd ../desktop  && npm run check
cd ../web      && npm run build && npm run i18n:check && npm run check:normalisers

# Are the hot queries still index-served?
cd OfflineSchoolApp/backend && npm run check:plans
```

### Repair scripts — read before running

`backend/scripts/` contains scripts that **write**. Each is a remediation for a
specific historical problem; read the file before running it, and take a backup:

`repair-exam-coefficients.js` · `repair-report-templates.js` ·
`repair-result-identity.js` · `repair-score-grades.js` ·
`fix-enrollment-index.js` · `fix-payroll-index.js` ·
`backfill-admission-numbers.js` · `backfill-subject-coefficients.js` ·
`clean-unpublished-results.js` · `migrate-school-logos.js`

`seed-academic-structure.js` and `seed-form1-students.js` are **development
seeds**. Never run them against production data.
