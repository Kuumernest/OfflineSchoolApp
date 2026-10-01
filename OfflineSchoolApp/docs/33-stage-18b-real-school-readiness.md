# 33 — Stage 18B: Real-School Pilot Data Cleanup & Final Readiness

Operational readiness of the one authorised school, after Stage 18A. No
engine, rule, threshold, gate or version changed. No real pilot was opened.
Everything below was read or written through the application's own
services and lifecycle; counts only, no pupil named.

```text
STAGE 18B — REAL-SCHOOL PILOT DATA CLEANUP & FINAL READINESS

BASELINE
Branch: ca-assessment
Starting commit: 6bd0406 (Stage 18A), level with origin
Working tree: clean

SCHOOL SCOPE
School selected: the only school in the configured database, selected by its
                 explicit id 6a4ccbfac10ad6faa189bd85 (code GVA001)
School status: active, not deleted
Authorization status: 2 active school administrators; 1 active platform
                 operator (no school of its own); 4 active teachers, all with
                 active assignments at this school; 1 bursar; 3 guardian links

TEST DATA
Seeded records found: 49 pupils created by seed-form1-students.js in one run
                 on 2026-08-31 17:52–18:05 UTC (enrollment 008–056 under the
                 seed's own prefix GVA00/2026/, which is NOT the school's
                 numbering — the school code is GVA001)
Confirmed test records: 48 — every one carries the seed's full signature:
                 the seed's class id, the seed batch window, the seed's
                 enrollment sequence, no e-mail, mustResetPassword never
                 cleared, no photo, no edit in the change log, and either the
                 seed's literal address or the seed's default password
                 (bcrypt-verified, never printed). None was ever signed in to.
Ambiguous records: 0. Fifteen other pupils carry the same prefix pattern but
                 were created on other days, in other classes, with e-mails
                 and edits; they are the school's own records and were not
                 touched. Fourteen more use the school's dash format.
Removed/deactivated: 48 pupils soft-deleted exactly as DELETE
                 /admin/students/:id does ({ deletedAt: 2026-09-30T18:57:35Z,
                 isActive: false }); nothing hard-deleted; reversible by that
                 timestamp
Remaining test records: 1 seed-batch pupil that had already been soft-deleted
                 before this stage and has no account; left as is

DEFAULT CREDENTIALS
Confirmed test accounts: 48 (7 of them still on the seed's default password;
                 the other 41 had never been reset either — mustResetPassword
                 still set — but their hashes no longer matched the default)
Deactivated: 48 accounts ({ isActive: false }, the app's own deactivation);
                 authentication refuses an inactive account at the door
Remaining: 0 active student accounts at the school match the seed's default
                 password (re-verified after the change)

SEEDED EVIDENCE
Found: linked to the 48: 96 result summaries, 1,392 score rows, 48 term
                 results, 144 fee charges, 1 fee payment, 1 intelligence
                 review (inside the synthetic pilot); no attendance,
                 homework, quiz, exploration, snapshot, intervention, plan
                 or pilot-feedback rows
Cleaned: by the application's soft-delete semantics the rows stay on record
                 and the pupils leave every cohort: 0 of the 48 appear in the
                 live cohort, the review sheet, the calibration summary or
                 the preflight counts. Nothing was deleted from results,
                 finance or reviews.
Remaining contamination: none in pilot-eligible evidence. For the bursar's
                 attention: 144 charges and 1 recorded payment stand against
                 test pupils; for the administrator's: 1 guardian link points
                 at a test pupil.

SYNTHETIC/DEVELOPMENT PILOTS
Found: 1 synthetic pilot, READY, open since 2026-09-24, opened by the operator
State: CLOSED through pilot.service.transition (READY → CLOSED), actor the
                 operator who opened it, note recording Stage 18B; endedAt
                 2026-09-30T18:57:35Z; two transitions on the trail; nothing
                 deleted
Closed: yes
Real evidence contamination: none — its single review is stamped
                 pilotKind "synthetic" and is counted as excluded (1) by any
                 real pilot's evidence window; 0 real reviews exist

TECHNICAL READINESS
Live/offline: READY — 3 of 3 sampled pupils identical, 0 differences, on the
                 eleven engine versions below (the sample is the preflight's
                 own; it is a sample, not the whole school)
School isolation: only the operator exists outside the school; teachers'
                 review packages through the route's own scoping hold only
                 their taught classes (4 of 4); check-cross-school,
                 check-school-scope, check-school-context green
Engine boundary: academic 1.0.0, strengths 1.2.0, exploration 1.0.0,
                 learningEvidence 1.0.0, learningIntegration 1.0.0,
                 development 1.0.0, guidance 1.0.0, intervention 1.0.0,
                 developmentPlanning 1.0.0, adaptiveSupport 1.0.0,
                 advancedIntelligence 1.0.0 — unchanged
Privacy: name-free engine input, no salt on the wire; the record and the
                 report carry counts (suites); the four privacy confirmations
                 are a person's to give
Reviewer isolation: 0 cases show a colleague's answer before one's own, for
                 every teacher; the bursar holds no review, intervention,
                 summary or pilot capability (insights.review and
                 insights.pilot exclude the bursar; insights.view remains the
                 office's money-free watch list by design)
Advanced intelligence boundary: watched by counts only; provider and every
                 failure mode verified in Stage 18A (35/35); unchanged

OPERATIONAL READINESS
Administrator: 2 active school administrators hold insights.pilot; the
                 operator must name the school (no school named → 400,
                 never all schools)
Reviewers: 4 teachers with active assignments (minimum 2); all 22 cases sit
                 in classes with two or more assigned teachers; attestation
                 reviewersUnderstandTask pending
Evidence: BLOCKED — 4 published results for 22 pupils; 22 reviewable cases
                 (need 30); 22 multi-review-capable (need 3)
Attestations: none signed (schoolParticipates, reviewersUnderstandTask,
                 noticeRequirementsMet, retentionAgreed) — no real pilot
                 record exists
Notice/retention: REQUIRES SCHOOL / OPERATOR CONFIRMATION; not inferred

REGRESSION
Backend: check:all 58 scripts, 5,434 assertions, 0 failures (check:brevo skipped:
                 credentials); check:inputs 3/3 (10,680 malformed requests, no 5xx)
Intelligence: check:intel 22 scripts, 1,377 assertions, 0 failures
Pilot: check-real-pilot 87/87, check-pilot-readiness 88/88 (inside the run)
Roles: check:roles 94/94; web roles 31/31
Web: tsc clean; eslint 0 errors (1 pre-existing warning); build ok;
                 i18n 4,621 keys; l10n 70; roles 31; intelui 16; pilotui 16
Mobile: 20/20 (lint 0 errors, 49 pre-existing warnings; types; i18n; l10n;
                 intelligence client)
Consistency: the real school's preflight, 3 of 3 identical, 0 differences

FINAL STATUS

REAL PILOT: BLOCKED

BLOCKING REASONS:
1. Evidence below the minimum: 22 reviewable cases of the 30 required, and
   only 4 published results across the 22 real pupils. Real published
   results must accumulate; nothing here can or should manufacture them.
2. The four attestations are unsigned and the notice/consent and retention
   confirmations have not been given by the school or operator.
3. The reviewers have not been briefed (reviewersUnderstandTask).

NON-BLOCKING ITEMS:
1. 144 fee charges and 1 recorded payment stand against soft-deleted test
   pupils — for the bursar to review or reverse through the app.
2. 1 guardian link references a test pupil — for the administrator.
3. One seed-batch pupil had been soft-deleted before this stage and has no
   account; nothing further to do.
4. The five search-escaping helpers committed in Stage 18A carried a literal
   NUL byte inside the regex instead of the escape; corrected in this
   commit (behaviour identical).

REAL-WORLD VALIDATION:
NOT YET PERFORMED
```

## How the 48 were identified

Not by name and not by prefix alone. `seed-form1-students.js` writes a fixed
class id, a fixed address string, a `+237 6…` guardian phone, no e-mail,
`mustResetPassword: true`, one bcrypt hash of one default password, and
sequential enrollment numbers under `GVA00/2026/`. The school's own code
is `GVA001`, so its numbering never produces that prefix; the fifteen
prefix-pattern pupils outside the seed batch were created on other days, in
other classes, with e-mails, and were left alone. A record was confirmed
only when it sat in the seed's class, in the seed's batch window, in the
seed's sequence, with no e-mail, no photo, no change-log entry,
`mustResetPassword` still set, and either the seed's literal address or a
hash that verified against the seed's default password. The selection is
re-derived from those facts each time; nothing is looked up from a saved
list. Reversal: every affected pupil carries `deletedAt` equal to
2026-09-30T18:57:35.414Z and an account with `isActive: false`.

## What the school must do before a real pilot

1. Publish real results until the sheet holds thirty reviewable cases (the
   review sheet caps at three cases per category; today's 22 real pupils
   yield 22).
2. Brief the reviewers; the head then opens **Intelligence review →
   Validation pilot → kind: real** and signs the four attestations. The
   preflight must read `AWAITING_ATTESTATION` first; it reads
   `REAL_PILOT_BLOCKED` today for reason 1 alone.
3. Confirm notice/consent and retention with the school.

A real pilot is opened by a person, after this readiness result is
reviewed. This stage stops at `REAL PILOT: BLOCKED`.

## Addendum, 2026-10-01 — seeded evidence rows and the live check

The 48 confirmed seeded pupils kept their result rows on record after the
soft delete above; the cohort, the review sheet and the preflight already
excluded them. Those rows are now soft-deleted too, the way the application
deletes a score (`deletedAt` set, nothing removed): 96 result summaries,
1,392 score rows and 48 term results, at 2026-10-01T10:41:23Z. Audit rows
stay: 1,489 result change-log entries, 105 document verifications, 44 gate
events, and the synthetic pilot's one review. Finance stays for the bursar:
144 charges and 1 payment. One seed-batch pupil soft-deleted before Stage
18B still carried `isActive: true` and a dangling account reference; the
flag is now cleared as the delete route would have left it. Nothing of the
22 remaining pupils was touched: their 4 published results and 73 score rows
are intact.

`scripts/check-real-school-seed.js` (opt-in, live: `npm run check:realschool
-- <schoolId>`) re-derives the seeded population from the seed's own
signature and asserts, counts only, that none of it is active in the
evidence population. The preflight afterwards: TECHNICAL READY, EVIDENCE
BLOCKED (22 of 30 reviewable cases, 4 published results for 22 pupils), the
four attestations and the notice/retention confirmations pending.
REAL PILOT: BLOCKED.
