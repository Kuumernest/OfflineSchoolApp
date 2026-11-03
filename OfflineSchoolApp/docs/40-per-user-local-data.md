# 40 — Per-user local data on shared devices

Status: **implemented on mobile behind a per-school switch (§8), off by
default.** Owner decisions D1, D2, D3, D6, D7 are final and built as §8
describes. With the switch off a phone behaves exactly as before. §1–§7 are
the original design, kept for the reasoning; where §8 differs, §8 is what
shipped.

Owner decision being implemented: *"Per-user local data on shared devices:
scope local SQLite data per user and fix the ownerless rows, with a safe
migration of existing local data."* Hard constraint: **no existing local data
may be lost or orphaned without the owner's explicit approval first.**

---

## 1. What is on a shared device today (verified at f53ae86)

### Mobile (expo-sqlite, one file `schoolapp.db` per phone)

| Thing | Scope today | Where |
|---|---|---|
| Mirror tables (students, classes, fees, attendance, exams, …) | **per phone**: whatever the last accounts pulled | `src/db/database.js`, services |
| Dirty local rows (`_synced = 0`) | **no owner**. The next backfill queues them under whoever is signed in | `syncBackfill.service.js` SPECS → `MutationQueue.enqueue` → `currentOwner()` |
| Outbox `mutation_outbox` | `owner_id` per row; drain sends only the signed-in account's rows. `owner_id IS NULL` (legacy) is never sent | `mutationQueue.service.js` |
| Sync cursor `sync_last_timestamp`, `quiz_last_sync` | **per phone** (SecureStore) | `syncManager.js:36, 493-515` |
| Offline login credentials (salt + hash) | per account, but in the **shared `users` mirror table** | `auth.store.js:~465-500` |
| Session (token, user) | per phone, cleared on logout | `auth.store.js _clearStorage` |
| Logout | stops sync; keeps SQLite, outbox, cursor | `auth.store.js:736` |
| Messages | already purged per account on sign-in/out | `forgetOtherPeoplesMessages` |

Consequences: (1) account B on a phone can read account A's mirrored rows on
any screen that reads SQLite; (2) A's unqueued dirty rows are sent **as B**;
(3) B starts from A's cursor, so B never receives rows A was not allowed to
see but which are older than A's cursor (a role-dependent pull, e.g. a bursar
after a teacher, is **incomplete**), and conversely keeps A's wider rows.

### Desktop (better-sqlite3, `docs(collection,id)` + `outbox`)

| Thing | Scope today |
|---|---|
| `docs` mirror, `sync_state` cursors | per *server+school* (`scope`), not per user |
| `outbox.user_id` (schema v4) | engine sends only the signed-in account's rows; `NULL` = legacy, never sent |
| Local read handlers | fees/students/results/attendance checked the school only — **F6**: a teacher after a bursar read the bursar's mirrored ledgers. Fixed for those four families in §6 |
| `summary().pending/blocked` | counts every account's rows; `stuck` lists every account's blocked rows with Discard buttons |

### Web browser
No local data. Out of scope.

### Author evidence available on existing rows (for §4 (b))

| Table (mobile) | Usable author column | Notes |
|---|---|---|
| `announcements` | `author_id` | reliable |
| `quizzes`, `questions` | `created_by` | reliable |
| `exams` | `createdBy`, `updatedBy` | `updatedBy` better for edits |
| `quiz_attempts` | `user_id` | the pupil who took it = author |
| `teacher_attendance` | `teacherId` | the *subject*; author only for self check-in |
| `subjects`, `teacher_assignments`, `timetable` | `teacher_id` | the *subject*, **not** the author (admin edits) — not usable |
| `students` | `user_id` | the pupil's login — not usable |
| `fee_payments`, `expenses`, `gate_events`, `classes`, `periods`, `users`, `attendance` | none | no author evidence on the row |
| any table | outbox `owner_id` of a queued row with the same entity key / `__local.ids` | strong evidence where it exists |
| device | last signed-in user (SecureStore `USER_KEY`; cleared on logout) | weak: says who was last here, not who made a row |

Desktop: every local write goes through `outbox` with `user_id` since v4;
`docs.pending = 1` rows can be attributed via the matching outbox row
(`collection`, `doc_id`, `extra_docs`). Only pre-v4 rows lack an owner.

**Caution:** "dirty" is noisy on mobile. Several tables default `_synced` to
0 and some caches insert without setting it (e.g. `userCache.service.js`,
the offline credential upsert into `users`). A migration must use the
backfill's own filters (SPECS `where`/`skip`) to decide what is a real change,
never `_synced = 0` alone.

---

## 2. Options

### Mobile

| | A. One DB file per user | B. Owner column + row scoping in one DB | C. Shared mirror, per-user overlay only |
|---|---|---|---|
| Shape | `schoolapp.<userId>.db` + a small shared `device.db` (credentials, device id, user list) | every mirror + dirty table gets `_owner_id`/`_visible_to`; every read filters | keep one mirror, purge it on account switch; dirty rows/outbox carry owner |
| Storage (5 teachers × full mirror) | 5 × mirror. Teacher mirrors are class-scoped, typically 2–20 MB each → 10–100 MB. Admin/bursar mirrors larger | 1 × union, plus duplicated rows where two users see the same row (or a join table) | 1 × mirror |
| First sync per user | full pull for each new user on the device | full pull per user (cursor per user) unless rows are shared | full pull on **every switch** (purged) |
| Offline login | works: credentials live in `device.db`, each user's data in their file | works | works, but after a switch the new user has **no data offline** until they sync |
| Security | strongest: a screen can only open the signed-in user's file; no query can leak | weakest: every one of ~hundreds of SQLite reads must add the filter; one missed `WHERE` leaks | strong for reads; nothing to leak because it is purged |
| Complexity | moderate: `getDatabase()` takes the user; migrations run per file; services that cache the handle must reset on switch | high and permanent: every query, every index, every upsert | low, but destructive by nature |
| Cursor / initial sync | naturally per file (move cursor into a `meta` table in the file) | per user key in SecureStore/meta | reset on switch |
| Unsent work on switch | stays in the owner's file, sent when they return | owner column | must be kept outside the purge (outbox already has owner) |

### Desktop

| | A. One store file per user | B. `docs.owner`/visibility column | C. Read guards + per-user outbox views (shipped partly) |
|---|---|---|---|
| Notes | Same trade-offs as mobile A. Desktop installs are usually office machines with 1–3 staff; storage is not a concern | Same leak risk as mobile B; `docs` reads are centralised in handlers, so less risky than mobile | Mirror stays per school; every local read handler enforces the server route's permission (F6). Cheap, but the data is still on disk for anyone with file access |

## 3. Recommendation

- **Mobile: Option A — one SQLite file per user + a shared `device.db`.**
  It is the only option where "another account can read it" is impossible by
  construction rather than by discipline, it makes cursor and initial-sync
  state per user for free, and it keeps offline login working. Cap the number
  of user files per device (decision D6) and evict least-recently-used files
  **only when they hold no unsent work**.
- **Desktop: Option C now (done for fees/students/results/attendance), Option A
  later if the owner wants at-rest separation.** Extend the read guards to the
  remaining handler families (finance, payroll, approvals already partly
  guarded; exams, timetable, intelligence, templates, staff). Scope
  `summary()`/`stuck` per user (decision D8).
- Web: nothing.

---

## 4. Migration plan for existing installs (mobile, Option A)

Each step lists: **Lose?** **Orphan?** (kept but unreachable) **Expose?**
**Rollback.** Steps M0–M2 are shipped or safe; **M3 onward are NOT shipped and
need the owner's decisions (§5).**

**M0 — Visibility (shipped).** Pending screen + status bar show "N changes
from another account" and "N changes with no recorded owner"; no action
buttons. Lose: no. Orphan: no. Expose: counts only, no content. Rollback:
revert UI.

**M1 — Owner stamp on new writes (shipped).** Additive `_owner_id` column on
the 17 backfill tables; TEMP triggers stamp the signed-in account when a row
is inserted dirty or turns clean→dirty. Existing rows keep their bytes and read
NULL; a legacy dirty row edited again stays NULL. Nothing reads the column yet.
Lose: no. Orphan: no. Expose: no. Rollback: downgrade is safe — the triggers
are TEMP (gone when the connection closes), the column is ignored by older
builds. Caveat: an `INSERT OR REPLACE` over a legacy ownerless dirty row is a
full rewrite and is stamped with the writer (its content is entirely the
writer's). `_owner_id` on a row the cache inserted dirty by default is not
proof of a user change (see §1 caution).

**M2 — Freeze before migrating (to build; safe).** Before any move: refuse to
start M3 while the outbox has rows that can be drained *by the signed-in
account* and the phone is online — drain first. Write a migration journal
(`migration_state` table) so every step is resumable. Take a **file copy** of
`schoolapp.db` to `schoolapp.pre-peruser.bak` (check free space first; abort,
don't proceed, if insufficient). Lose: no. Orphan: no. Expose: the backup is
as readable as the original (same sandbox). Rollback: delete the backup.

**M3 — Create `device.db` and move credentials (NOT shipped).** Copy (not
move) offline credential rows from `users` into `device.db`. Lose: no (copy).
Orphan: no. Expose: no. Rollback: the old rows are still there. **Offline
upgrade (d):** works — purely local.

**M4 — Decide the legacy mirror's owner — case (a) (NOT shipped; DECISION D1).**
The mirror was pulled by an unknown mix of accounts. Options:
1. *Give it to the last signed-in user* (SecureStore `USER_KEY`, else the most
   recent `users.passwordHash` row's `updated_at`). Lose: no. Orphan: no.
   **Expose: yes** — if the mirror contains rows an earlier, more-privileged
   account pulled, the last user now owns them in their file. Rollback: rename.
2. *Discard and re-pull per user* (recommended for clean rows). Clean rows
   (`_synced = 1`) are server copies by definition, so discarding them **loses
   nothing that is not on the server**, but: **offline upgrade (d)** leaves
   the user with an empty app until they are online → must be deferred until
   the first successful online sign-in of that user. Orphan: no. Expose: no.
   Rollback: restore from M2 backup.
3. *Keep read-only "legacy" file for N days* then 2. Lose: no for N days.
   **Orphan: yes** during the window if no screen opens it. Expose: same as 1
   if readable. Rollback: trivial.

**M5 — Ownerless dirty rows — case (b) (NOT shipped; DECISION D2).** For each
backfill spec, select rows the spec *would* send (its own `where`/`skip`).
Attribute in this order, recording the evidence used:
1. an outbox row (any status) with the same entity key / `__local.ids` and a
   non-null `owner_id`;
2. the row's author column from the §1 table (`author_id`, `created_by`,
   `createdBy/updatedBy`, `quiz_attempts.user_id`), if that user is known on
   the device;
3. `_owner_id` (M1) if set;
4. otherwise **hold**: leave in the legacy file, list on the pending screen
   with Send-as-me / Save a copy / Discard (each confirmed).
Lose: no (nothing deleted). **Orphan: yes, if held rows have no UI** — the
held list must ship with this step. **Expose / mis-attribute: yes** for rules
2–3 if the evidence is wrong (e.g. an admin edited a teacher's quiz). Today's
behaviour (send as whoever syncs next) is the worst case and is what
continues until M5 ships. Rollback: attribution is recorded in a column, not
applied by moving, until the owner confirms; undo = clear the column.

**M6 — Outbox rows owned by another account — case (c) (NOT shipped).** Move
each row into its owner's file (create the file if needed, mirror-less).
Rows with `owner_id IS NULL` stay held (same UI as M5.4). Lose: no if the copy
is verified before the source row is deleted (copy → verify count + ids →
delete, in one transaction per owner). **Orphan: yes** if the owner never signs
in on this device again — the rows sit in a file nobody opens (needs D5).
Expose: no. Rollback: M2 backup.

**M7 — Switch reads to the per-user file (NOT shipped; changes what an existing
install reads at launch).** `getDatabase()` opens `schoolapp.<userId>.db`;
cursor and quiz cursor move into that file's `meta` (start from EPOCH = full
pull for that user). Lose: no. **Orphan: yes** for anything left only in
`schoolapp.db` that M4–M6 did not place — so M7 must refuse to run while the
legacy file contains unplaced dirty or outbox rows, and must keep the legacy
file (never delete in this step). Expose: no. **Offline upgrade (d):** a user
signing in offline after the upgrade gets their file only if M4 placed data
there; otherwise an empty app with a clear "connect once to download your
data" message — never fall back to reading the legacy shared file.
Rollback: flip the feature flag back to `schoolapp.db`; nothing was deleted.

**M8 — Delete the legacy file (NOT shipped; DECISION D3).** Only after it holds
no dirty/outbox/held rows, and after N days. **Lose: yes, irreversibly** — the
only step that can. Requires the owner's approval and an export first.

**Downgrade — case (e).** After M7 an older build opens `schoolapp.db` (the
legacy file) and sees the pre-migration state minus whatever M6 moved out.
Rows moved to per-user files are **invisible to the older build (orphaned
until re-upgrade)** and anything the user did after the upgrade lives in their
file. Mitigation: M6 copies instead of moving until M8; a downgrade then sees
duplicates in the legacy outbox — which the server's Idempotency-Key
deduplicates (same `id`/`idem_key`). Desktop downgrade below v4 is already
unsupported by `migrate()`.

### Desktop plan (if Option A is chosen later)
Same steps; simpler because every write since v4 has `outbox.user_id` and
`docs.pending` rows map to outbox rows. Pre-v4 ownerless rows → held list
(already counted, now shown). Mirror: re-pull per user (office machines are
online most of the time).

---

## 5. Decisions the owner must make

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Legacy **clean** mirror data on upgrade | (1) last signed-in user · (2) discard and re-pull per user on first online sign-in · (3) keep read-only N days then (2) | (2), deferred until that user is online |
| D2 | Legacy **dirty, ownerless** rows | attribute by outbox → author column → `_owner_id` → hold · hold all for manual review · keep today's "send as next syncer" | evidence chain, hold the rest, show a review list |
| D3 | When the legacy file may be deleted | never · after N days with nothing unplaced · on explicit admin action | N = 30 days *and* nothing unplaced, with an export |
| D4 | Ownerless **outbox** rows (`owner_id IS NULL`) | stay held forever · "send as me" with confirmation · admin-only send/discard | admin-only, per row, with "save a copy" first |
| D5 | Another account's queued rows when that person never returns | keep forever · after N days let an admin send-as-them (not possible: no token) / export / discard | export + admin discard after N days |
| D6 | Max user files per device; eviction | unlimited · N (e.g. 5) LRU, never evicting a file with unsent work | N = 5, LRU, block eviction with unsent work |
| D7 | Feature flag rollout | all at once · per school · opt-in | per school |
| D8 | Desktop: scope sync indicator `pending`/`stuck` and the Discard button to the signed-in account | keep global · per user + read-only "other accounts" line | per user; others read-only |
| D9 | Desktop Option A (per-user store files) at all | yes · no (guards only) | no for now; revisit if at-rest separation is required |
| D10 | What to do on mobile *today* with ownerless dirty rows the backfill sends under the next account | leave until M5 · stop the backfill from claiming rows without `_owner_id` (changes current behaviour) | leave until M5; stopping it without a held-list UI would orphan them |

---

## 6. Shipped in this change (additive only)

- **Mobile — held changes visible** (`src/db/heldChanges.js`,
  `app/sync/pending.js`, `src/components/SyncStatusBar.js`, i18n en/fr):
  read-only counts of outbox rows queued by another account and rows with no
  owner, with an explanation. No send/discard action is offered for them.
- **Mobile — owner stamp on new writes** (`src/db/ownerStamp.js`,
  `src/db/localWrites.js`): §4 M1.
- **Desktop/web — held changes visible** (`SyncIndicator.tsx`, web i18n):
  "N of these were queued by another account" / "N have no recorded owner",
  derived from the existing `summary().ownerless` and `mine`.
- **Desktop — F6 read guards** (`api/handlers/readPermissions.js`, applied in
  fees, students, results, attendance): a local read answers only a session
  holding the server route's permission/role; otherwise the request goes to
  the server (403 online, online-only failure offline). Data stays on disk.
  **A person's own unsent changes are never hidden:** if the signed-in account
  has a queued request under that family's write paths, the local answer is
  given regardless (`outbox.hasOwnPending`). Another account's or an ownerless
  queued row never opens a read.
  Residual risk: a session whose cached permission list is stale (e.g. a
  persisted user from before `permissionsFor` was fixed) is declined locally
  until it signs in online again — the same rule the timetable/payroll/staff
  handlers already apply.

Checks: `mobile/scripts/check-owner-stamp.js` (existing rows byte-identical
by value and storage class, outbox untouched, downgrade leaves no trigger,
rollback, account switch), `desktop/scripts/check-read-permissions.js`.

## 7. Planned steps that can lose, orphan or expose data

| Step | Lose | Orphan | Expose / mis-attribute |
|---|---|---|---|
| M4.1 legacy mirror → last user | – | – | **yes** (earlier privileged pulls) |
| M4.2 discard clean mirror | only server copies; offline upgrade = empty app until online | – | – |
| M4.3 legacy read-only window | – | **yes** if no screen reads it | as M4.1 if readable |
| M5 attribute ownerless dirty rows | – | **yes** if held rows ship without UI | **yes** if evidence is wrong |
| M6 move other accounts' outbox rows | if delete-before-verify (must not) | **yes** if the owner never returns (D5) | – |
| M7 switch reads to per-user file | – | **yes** for anything left unplaced in legacy file; offline upgrade sees empty data | – |
| M8 delete legacy file | **yes, irreversible** | – | – |
| Downgrade after M6/M7 | – | **yes** (per-user files invisible to old build) | – |
| D10 "stop backfill claiming ownerless rows" | – | **yes** without M5 UI | removes today's mis-attribution |
| D4/D5 admin "send as me"/discard | discard: **yes** (per row, confirmed) | – | send-as-me: **mis-attribution by design** |

---

## 8. Implemented (mobile): per-user local data

### 8.1 Shape (Option A, kept)

| File | Holds |
|---|---|
| `schoolapp.db` (legacy) | Unchanged in meaning. Every account that has not flipped reads and writes it. It gains one table, `mutation_outbox_migrated`, which archives the outbox rows moved into an account's store. |
| `schoolapp.u_<id>.db` | One per account. It is created on that account's first **online** sign-in with the switch on and filled by the account's **own** full sync (D1). Its sync cursors live in a `local_meta` table inside the file (`src/db/storeMeta.js`). |
| `device.db` | Tables `credentials`, `stores`, `journal`, `attribution`, `placements`, `review_items` and `meta` (`src/db/deviceDb.js`). Created only when the switch is on. |

Code:
- `src/services/perUserData.service.js`: everything below.
- `src/db/database.js`: named files; `getDatabase()` returns the active one.
- `syncManager.primeOnce()`: one full sync that reports its outcome.
- `syncBackfill`: `dirtySelectors()` and the legacy owner gate.
- `auth.store.js`: sign-in, offline sign-in and sign-out.
- `app/_layout.js` and `src/components/PreparingLocalData.js`: the preparing screen.
- `app/sync/review.js`: the review list.

### 8.2 The switch (D7)

The setting is `School.settings.offline.perUserLocalData`, default `false`. Only the platform can change it:

    PUT /api/super-admin/schools/:schoolId/offline-settings
    Authorization: Bearer <super_admin token>
    { "perUserLocalData": true, "reason": "pilot" }

The route needs `platform.manageSchools` and is audited as `school.offlineSettingsChanged`. `GET` on the same path reads the value.

The phone reads `localData` from the `/auth/login` and `/auth/refresh` responses and remembers it per school in SecureStore (`peruser_switch`). While the switch is off and has never been on, nothing is written.

There is no UI toggle. The existing platform screens are on the web, and this is a rollout lever, not a school setting. super_admin accounts always stay on the legacy file.

### 8.3 Lifecycle of one account

1. **Setup.** Runs once per phone, locally, and is safe offline. The steps are:
   - `setup:meta`.
   - `setup:credentials`: copies (never moves) the salt and hash from `users` into `credentials`. It copies them as it finds them. On a phone that ran an older build, that can be the old clear-text `password + salt` form ([14-security.md](14-security.md#offline-sign-in-credentials-mobile)). Such a value still signs the account in offline. The account's next online sign-in replaces it in `device.db`, in the shared `users` table and in the account's own store.
   - `setup:attribution`: records a D2 decision for every existing dirty row. Rows with no evidence, and every ownerless outbox row, are copied in full into `review_items`.
2. **Sign-in, online, not yet primed.**
   - The cap check runs (D6).
   - `flip:<id>:store` creates the file and copies the schema and `sync_id_map` into it.
   - The store becomes active **behind the preparing screen**, so no data screen is mounted.
   - `SyncManager.primeOnce()` runs one full `syncAll` from the epoch. Only the outcome `"completed"` counts. Anything else (offline, a failed pull, or "use the app now") makes the legacy file active again, which is today's behaviour. The flip is retried at the next online sign-in or launch.
3. **Primed.** Four steps run in order:
   - `flip:<id>:outbox`: for each of the account's legacy outbox rows, the row is inserted into the store and read back, and its identity hash and owner are verified. Then, in ONE legacy transaction, the row is archived and deleted. A placement record follows.
   - `flip:<id>:dirty`: for each legacy dirty row attributed to the account, the row and its children are copied into the store with `_owner_id` set to the account, then read back and verified. A placement record follows. The legacy row itself is never changed.
   - `flip:<id>:review`: places the held items an admin gave to this account.
   - `flip:<id>:switched`.

   These sweeps run again, idempotently, at every later sign-in of that account.
4. **Sign-out.** The sync is stopped and drained, then the legacy file becomes active again for the next person.

Offline sign-in checks the `device.db` credentials first and the legacy `users` row second; either one can sign the person in. An account that was primed earlier reads its own store offline. An account that was never primed reads the legacy file, as today.

### 8.4 D2 evidence, as built

The evidence check applies to each row that the backfill's own specs would send (their `where` and `skip`). Offline credential-cache rows in `users` are excluded because they carry a password hash. The evidence is tried in this order:

1. An outbox row (any status, archive included) that names the row in `__local.ids`, in `__reconcile.localId` or in its entity key, and has an owner. If two different owners match, the row is held.
2. The author column: `announcements.author_id`, `quizzes/questions.created_by`, `exams.updatedBy/createdBy` or `quiz_attempts.user_id`. It counts only if that account has credentials on the phone.
3. `_owner_id`.
4. Otherwise the row is **held**.

Decisions for rows that existed at setup are persisted. A row dirtied later on the legacy file by an unflipped account is attributed by its `_owner_id` stamp first. Once setup has run, the legacy backfill sends only rows attributed to the signed-in account, never a held row and never a placed one.

### 8.5 The review list (D2/D4)

The review list is at `/sync/review` and is linked from the pending screen. Everyone sees the held changes. An admin (`school_admin` or `super_admin`) signed in on the phone has three actions:
- **Give to an account** known on the phone. The change is placed in that account's store now if it has one, otherwise at its next sign-in.
- **Send as me.** Needs an explicit confirmation and is recorded as `send-as-me`.
- **Save a copy.** The full JSON goes to the share sheet.

There is no discard.

### 8.6 D3 and D6

D3, `legacyDeletionGate()`. The legacy file can be deleted only when all of these hold:
- at least 30 days have passed since setup;
- the accounting shows nothing `unplaced` and nothing `waiting-owner`;
- no legacy uploads are pending;
- the legacy file is not the active one.

Only an admin can delete it, by pressing "Delete old shared data" on the review screen and confirming. The gate is checked again at that moment. Deletion never happens automatically.

D6:
- At most five stores are live.
- A sixth account evicts the least recently used store that holds **no** unsent outbox row and no unsent dirty row. The file is deleted and its row is kept, marked evicted.
- If all five stores hold work, the online sign-in is refused before the session is stored (`svcErr.deviceFullOfAccounts`, in en and fr).
- An evicted account is unprimed again and uses the legacy file until its next online sign-in.

### 8.7 Accounting (`accountLegacy`)

Every unsent legacy outbox row, archived row and dirty row gets one of four classes:
- `placed`: a verified copy exists and a placement record was written. With `verifyFiles`, the row must also still be in the store, or have been sent and re-keyed.
- `review`.
- `waiting-owner`: the owner has not flipped yet. The row can still be sent from the legacy file by that owner.
- `unplaced`.

The D3 gate and the checks both use this accounting.

### 8.8 Switch turned off again

Accounts that have not flipped are unaffected. A flipped account keeps its store while the store holds unsent work. Once the store is clean, the account returns to the legacy file at its next sign-in. The legacy gate stays on while `device.db` exists, so placed rows are never sent twice from the legacy file.

### 8.9 Downgrade

Until D3, the legacy file stays the source of truth for unflipped accounts.

If an older build reopens it, the older build sees:
- the mirror and all of the unflipped accounts' work;
- the archive table, which it ignores.

It does **not** see:
- the outbox rows moved to per-user stores. They are archived, not lost, and a re-upgrade sends them;
- anything written into a per-user store after the flip.

It **does** see the legacy dirty rows that were placed, because they stay dirty in the legacy file. Its backfill would queue them again under whoever signs in. Creates carry their local id, so the server answers most of them as repeats, but not every endpoint is idempotent.

Mitigation: the switch is per school, controlled by the owner and off by default. Do not ship a downgrade to a school that has it on.

### 8.10 Checks

- `mobile/scripts/check-peruser-migration.js`: database files on disk, the real modules and the real auth store. Ten sections, including a kill after each of the 33 journal and row steps.
- `mobile/scripts/check-peruser-e2e.js`: the real backend, with real sign-in and sync.
- `backend/scripts/check-offline-switch.js`.
