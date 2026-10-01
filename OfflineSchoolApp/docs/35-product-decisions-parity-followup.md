# 35 — Four product decisions from the parity audit, and the unpublished-result rule

The cross-platform parity audit (docs/34) left four items for a product
decision. This records the decisions as taken, what each one changed, and the
authorization finding the same audit raised about unpublished marks. Nothing
in the intelligence engines, the grading engines, their versions, the pilot
evidence or the reviewer data changed. No permission widened.

## 1. Teachers and term / annual results

**Decision.** A teacher may open Term Results and Annual Results, for their
own teaching scope only. The server is the boundary.

**Before.** `GET /api/term-results` and `GET /api/annual-results` answered
every row in the school to any holder of `results.view` (administrators,
bursar, teacher), published or not; `POST …/compute` let a teacher recompute
the whole school; the per-pupil reads answered across every school for an
operator who had selected none. The web menu hid both pages from teachers
while the route gate let them in by URL.

**After.** One module, `backend/src/utils/periodResultScope.js`, shared by
both routers:

- an administrator reads every row and computes the school;
- a bursar reads the published rows, school-wide (what the sync feed already
  mirrored to them);
- a teacher reads the published rows of the classes they hold an active
  assignment in — the class-level set, because a term average spans every
  subject — and computes one of those classes at a time (`403
  CLASS_NOT_ASSIGNED` otherwise; a class they may not read is an empty page,
  not a 403, and its card a 404);
- an operator must name a school; `/student/:id` without one is a 400, no
  longer every school's rows.

The published-only rule is the feed's own `publishedUnlessAdmin`, reused, not
restated. On the web the nav entries now list teachers; both pages gained a
class selector (a teacher's roster or the school's classes, through the
existing `fetchStaffClasses`), Compute carries the class and is disabled for a
teacher until one is chosen, Publish is an administrator's button.

**Policy delta, stated.** `backend/scripts/check-teacher-read-scope.js`
documents that teacher reads of *exam* marks and results are school-wide.
That policy is unchanged for the exam-level routes; this decision scopes the
term and annual aggregates. The two now differ on purpose and the report
names it so the next decision can be made with the same clarity.

Check: `check-period-results-scope.js` (50 assertions): assigned teacher,
unassigned teacher, bursar, pupil, administrator, operator with and without a
school, another school's administrator — for both routers.

## 2. Student fees on mobile

**Decision.** A pupil sees their own fee account on the phone.

**Implementation.** `GET /api/student/fees` (students only; the record the
signed-in account owns; no pupil id to ask for) answers the *same* redacted
ledger the guardian portal shows: `fees.service.familyLedger` is one function
read by `/api/portal/fees` and by this route, so the pupil sees what the
family sees and nothing the bursar's screen adds (no cashier, no internal
note, no voided row). Charges carry label, amount, waived amount, year, term
and due date; payments carry receipt number, amount, date and whether they
reverse another; totals carry charged, waived, paid and balance. The finance
routes are untouched and still refuse a pupil.

Mobile: `app/student/fees/index.js`, reached from a Fees tile on the pupil's
home; `src/services/studentFees.service.js` reads the route and keeps the
last answer in SQLite under the account, shown dated when offline; a lapsed
sign-in is never answered from the cache. Read-only: the screen says payments
are the office's to record. English and French strings added.

Checks: `check-student-fees.js` (backend, 13: own ledger, year filter,
another pupil's id ignored, finance routes refused, teacher refused, no pupil
record, portal reads the same function) and `check-student-fees-screen.js`
(mobile, 9: tile, route, no finance route, no write, keys in both languages).

## 3. Teacher exploration ratings on mobile

**Decision.** The web's two staff actions on a pupil's exploration — record an
observation, rate the output — are on the phone.

**Implementation.** No new route and no new model. `src/services/exploration.service.js`
gained a teacher section: read a pupil's explorations (cached under the
teacher), the criteria from the cached catalog, and two writes through the
outbox that post the web's exact bodies to the web's exact routes
(`POST /explorations/:id/observation` `{ level, codes, note? }`;
`POST /explorations/:id/performance` `{ version, ratings }`). The server
validates, scopes (`CLASS_NOT_ASSIGNED`), keeps one observation per teacher
per exploration with revisions, and derives the level; the phone computes
nothing. Screen: `app/teacher/explorations/[studentId].js`, opened from the
pupil's card on Class Intelligence; it shows what the server stored, re-read
after each write, and says when a write is waiting to sync.

Checks: `check-exploration-teacher-client.js` (mobile, 22: the phone's
service against the real routers — same stored observation as a web-shaped
post, revision on repeat, same rating level and ratings, the same refusals,
caching, option lists equal to the catalog's enums, every label in both
languages) and five assertions added to `check-exploration.js` (another
class's teacher and the bursar refused on both writes, unknown level,
`NOT_SUBMITTED`).

## 4. Dead mobile links and the orphan screen

| Item | Finding | Resolution |
|---|---|---|
| `/teacher/students/[id]` from the roster row | never existed; no per-pupil teacher screen on the handset (the office's student detail is the console's) | **removed**: the row is a row |
| `/admin/subjects/edit?id=` from the pencil | never existed; the server has `PUT /admin/subjects/:id` and the console an edit page | **restored**: the add form opens on the subject (`/admin/subjects/add?id=`), name/code/coefficient editable, class and teacher sections hidden |
| `/admin/teachers/:id` after adding a teacher | never existed; the teacher's screen that exists is `edit?id=` | **redirected** to `/admin/teachers/edit?id=` |
| `app/admin/timetable/periods.js` | unlinked duplicate of the linked `/admin/periods` screens | **removed** |

`check-teacher-routes.js` now reads template-literal routes too (the two
dead ones were invisible to it), its tolerated-dead set is empty, and it
asserts the four destinations above and the orphan's absence.

## 5. Unpublished results

**Finding confirmed.** The system's rule — a result the school has not
published reaches nobody but an administrator — was applied by
`GET /api/results/:examId` and by the feed's `termResult` / `annualResult`
entries, and nowhere else: the feed mirrored every `ResultSummary` to a
teacher's or a bursar's desk (the scope was lost when `ExamResult` was
replaced by this model), and the statistics, rankings, single-pupil,
report-card and `GET /api/exams/:examId/results` reads answered drafts. The
web's results page ranked them for teachers. This is a data-exposure defect,
not a product choice.

**Fixed at the data layer.** `resultSummary` carries `publishedUnlessAdmin`
in the feed; the five REST reads apply the same rule for non-administrators;
the web offers a teacher published exams only. `StudentScore` rows (raw
marks) are unchanged: teacher reads of marks are school-wide by documented
policy, and the bursar's mirror of marks is a recorded known gap of the
role matrix, not of this change.

Check: `check-unpublished-results.js` (23): teacher and bursar see the
published summary only on the feed and on every read; the administrator
sees both; the three feed entries share one scope function.

## Tests run

| Suite | Result |
|---|---|
| backend `check:all` (63 suites, three new) | 62 of 62 run suites passed (`check:brevo` skipped, it needs the mail provider) |
| mobile `check` (22 suites, two new, lint and types included) | 23 of 23 passed |
| desktop `check` | 12 of 12 passed |
| web lint, build, i18n, api paths, normalisers, roles, intelligence UI, pilot UI, grouping, l10n, layout | 11 of 11 passed |

## Regression assessment

Grading: untouched (one scale, graded at entry). Intelligence engines and
versions: untouched (`academic 1.0.0`, `strengths 1.2.0`, others `1.0.0`);
the exploration writes are the existing routes. Pilot evidence, reviewer
data: untouched. Permissions registry: untouched; every change narrows what a
non-administrator reads or confines a teacher's write to their assignment.
Intentional platform differences from docs/34 stand, with the three
decisions above now implemented as decided.

## Commit

COMMIT_HASH
