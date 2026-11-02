# 40 — Per-user local data on shared devices

Status: **design + migration plan for the owner to decide on.** Only the
additive parts in §6 have shipped. Nothing here moves, copies, deletes,
re-attributes or hides an existing local row, and nothing changes what an
existing install reads at launch.

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
