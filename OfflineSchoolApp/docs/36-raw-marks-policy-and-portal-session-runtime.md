# 36 — Raw marks: the policy as the repository states it; and the portal-session runtime

Two items left over after the four product decisions (docs/35). Nothing in
the grading or intelligence engines, the pilot evidence or the reviewer data
changed, and no permission in the registry changed.

## A. Raw marks (StudentScore)

### What the repository says

The question "may a teacher read the marks of classes they do not teach?" is
answered the same way in every place that records it, and the answer is:
*open*.

- docs/20 §7b: reads "remain capability-wide … `results.view` is documented
  as 'a look, not a licence' and this matches the product as built; confining
  teachers' reads to their assigned classes would be a product change and is
  not made here. Recorded for a decision."
- docs/20 §11.7 and its status table: "Teacher READ scope — Open policy —
  Unchanged by decision."
- docs/22 §4: "Confining reads to assigned classes is a PRODUCT DECISION
  REQUIRED, not taken here."
- `scripts/check-teacher-read-scope.js` asserts the school-wide read so that
  it is "not mistaken for a gap", and asserts the pair-scoped write beside it.

So school-wide teacher reads of raw marks are **B**: implemented and recorded,
with the justification explicitly deferred. They are not **A** (no document
calls them required), and within the exam module they are not **C** either:
the write is confined to the pair, the read is the school's, and the two
have been consistent since docs/20. The decision is therefore **not taken
here**. Only one person can take it, and the minimum form of it is:

> **Decision required.** On the exam module's read routes
> (`GET /api/exams/:examId/scores`, `GET /api/exams/:examId/results`,
> `GET /api/results/:examId` and its `/stats`, `/rankings`,
> `/student/:id`, the transcript print, and the `studentScore` and
> `resultSummary` sync collections), does a teacher read the whole school
> or only the classes they hold an active assignment in? docs/35 §1 already
> scoped the term and annual aggregates to assigned classes; the exam level
> is where the policy now differs from the aggregates. Either answer is
> implementable in one place (`utils/teacherScope.js` and the feed scopes),
> with `check-teacher-read-scope.js` and `check-raw-marks-scope.js` rewritten
> to the chosen answer and documented as such.

### What was inconsistent, and is now fixed

Four things did not match the rules the application already states.

1. **The bursar mirrored every raw mark, drafts included.** `results.view`
   includes the bursar; the `studentScore` feed entry had no scope; the feed's
   own header says a collection reachable offline but not online is the gap
   to avoid. Online, a bursar reaches a raw mark only inside a *published*
   result (`/results/:examId/student/:id`); the mark sheet needs `exams.view`,
   which the exam module withholds from the bursar on purpose. The entry now
   carries `marksAsReadOnline`: administrators and `exams.view` holders mirror
   the collection whole (the recorded teacher policy, untouched); a
   `results.view` holder without `exams.view` mirrors the marks of exams with
   a published result. The known-gap note is rewritten accordingly.
2. **Two exam-router lists returned unpublished summaries to teachers.**
   `GET /api/exams/reports/results` and `GET /api/exams/submissions/results`
   now apply `publishedUnlessAdmin`, the rule every other summary read applies
   (docs/35 §5).
3. **An operator with no school.** `GET /api/exams/:examId/scores` and the two
   lists above now answer 400 without a school, as `/exams/stats` already did,
   instead of filtering on a null school. On the sync feed an operator who
   names no school used to receive **every school's rows**; the tenant filter
   now matches nothing for them. The exam-anchored per-pupil routes keep
   anchoring on the exam's own school (docs/20 §11.6, asserted by
   `check-marks-scope.js`): one exam is one school's, never all.
4. **The desktop drew what the server would refuse.** The local
   `/api/results/:examId/student/:id` handler returned raw scores for an
   unpublished result to any role; it now applies the server's rule (not an
   administrator and not published: the request goes to the server, which
   answers 404). The local `/api/exams/:examId/scores` and
   `/api/exams/reports/results` handlers no longer answer a bursar, and the
   export list is published-only for non-administrators, as online.

### Roles and scope, as they stand

| Role | Raw marks online | Raw marks in the mirror | Unpublished results |
|---|---|---|---|
| Teacher | own pairs via `/teacher/results`; whole school via `/exams/:id/scores` and per published pupil result (recorded open policy) | whole school | never |
| Bursar | only inside a published pupil result | marks of published exams only | never |
| School administrator | whole school | whole school | yes |
| Operator | the named school; 400 without one on the sheet and the lists | the named school; nothing without one | yes, in the named school |
| Pupil | own, via `/results/my-results`, published only | none | never |
| Guardian | child's, via the portal, published only | none | never |

Cross-school: a staff member naming another school is refused at the door;
another school's ids answer nothing or 404.

### Check

`check-raw-marks-scope.js` (37 assertions, in `check:all`): the teacher's
pair and the school; the write refused outside the pair; the bursar's
published-only reach on the routes and the feed; the administrator; the
operator with and without a school on the routes and the feed; the pupil
and a guardian token on every staff route; Beta's staff naming Alpha; the
two export lists published-only.

## B. The portal-session suite

| | |
|---|---|
| Command | `node scripts/check-portal-session.js` (`npm run check:portalsession`) |
| Assertions | 47 |
| Normal runtime, seven earlier chain runs | 12–15 s |
| The outlier (2026-10-01, full `check:all` chain) | 1755 s, 47/47 |
| Reproduced in isolation, twice | 16 s, 16 s |
| In the full `check:all` chain after the stamps, 2026-10-02 | 18 s, 47/47 |

**Cause: the machine slept.** The run's log is born at 12:28:37 local and
the suite started 375 s of suite time later, at 12:34:52, and ended at
13:04:07. The Windows power log (Power-Troubleshooter event 1) records sleep
at 12:35:08 local and wake at 13:04:02: the host slept 16 s into the suite
and woke 5 s before it ended, for 1734 s. The remaining 21 s is the suite.
Nothing in the suite waits, polls, retries or holds a connection across that
gap; mongod start is bounded by `launchTimeout`, teardown by the library's
twenty-second kill window.

**Change.** None to the assertions, the session semantics or the server.
The suite now stamps each phase with elapsed and wall-clock time, so a
future outlier names its phase, and a gap that falls inside no phase's work
is the host's. The twenty-minute access token, the ninety-day per-device
session, renewal without a code, survival of a month offline, expiry at
ninety days, rejection of non-session tokens, two-phone isolation, sign-out
of one phone only, the ten-session cap, re-issue and revocation, the
lockout after six wrong codes — all 47 assertions are as they were.

## C. Regression

| Suite | Result |
|---|---|
| backend `check:all`, 64 parts, mail-provider check skipped as always | 63 of 63 passed |
| backend targeted: feed 61, readscope 15, marks 83, authz 24, crossschool 15, unpublished 23, desktop parity 1363, raw marks 37, portal session 47 | all passed |
| mobile `check`, 23 suites | 23 passed |
| desktop `check`, 12 suites | 12 passed |
| web lint, build, i18n, api paths, normalisers, roles, intelligence UI, pilot UI, grouping, l10n, layout | 11 passed |

No pre-existing or unrelated failures were observed in any run.

## D. Commit

COMMIT_HASH
