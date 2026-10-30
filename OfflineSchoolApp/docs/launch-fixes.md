# Pre-launch QA fixes (launch 1 Nov 2026)

Branch: `fix/launch-readiness`. One commit per numbered item, tagged with the
item number. Every calculation fix gets a check script in `backend/scripts/`
wired into `npm run check:all`. Ask the project owner before changing a
calculation rule beyond what is written here.

To resume: `git log master..HEAD --oneline`, then the first unticked item below.

Rules already decided: coefficients always applied; an absent subject is
removed with its coefficient; CA on/off per school; grading is /20.

## Rule: one guardian, many children (owner, 2026-10-27)

A parent/guardian can have several children at the school. Siblings sharing
the same guardian name, email or phone is normal, valid data — not a duplicate
and not test data. Every change must keep this true: no uniqueness on guardian
email/phone across pupils; one portal code can cover several children and the
parent can switch between them; "code covers no student" only for zero
children; fees and overdue are per child while the parent sees all of them;
cleanup clears only explicitly listed fake addresses. Checked across the whole
branch on 2026-10-27 — only D1 broke it (fixed). `check:siblings` (a guardian
with three children) and the family-of-three case in `check:portalcodes` guard
it. Also in the repo's `CLAUDE.md`.

## Decisions from the owner (2026-10-27)

- A8: several teachers on one class-subject are allowed; every screen lists them all.
- B2: school hours and periods are each school's own setting — no fixed defaults; warn when they disagree.
- B3: age range warning: Form 1 = 9–14; each level up the minimum rises 1 year and the maximum 2 (Upper Sixth 15–26). Option (b), confirmed 2026-10-27.

- D1: superseded the same day — a shared email is NOT test data (siblings share a guardian). Only clearly fake addresses listed in the script are cleared; other shared addresses are reported, grouped by guardian (owner, 2026-10-27).

- Overdue rule (fix approved by owner 2026-10-27): a family is overdue when the first charge its payments have not covered is past due, not when the earliest charge on the account is. See C6.

## Phase A — wrong numbers (fix first)

- [x] **A1** Class positions: rank denominator = pupils in that class with results (Term Results page and printed report card; find where "50" comes from). — `52088d7`
- [x] **A2** One term average everywhere: sum(mark × coef) / sum(coef of subjects with marks); shared in `shared/`, used by term results, report card, analytics, exports; same for annual. — `3fb211c`
- [x] **A3** One outstanding-balance function (no voided payments, current academic year) on Fees > Outstanding, Financial reports, Platform dashboard. — `0846dd5`
- [x] **A4** One pass rate: average ≥ school pass mark on /20, denominator = pupils with results, same exam/term/year scope. — `ccfaf44`
- [x] **A5** /20 everywhere on results analytics, exams overview, Students to watch; no GPA, no letter grades; the school's remark scale. — `shared/examAnalytics.js`
- [x] **A6** Rankings per class: class filter on exam analytics, rank within class; bottom-5 sorted ascending and numbered consistently. — `shared/examAnalytics.js` topAndBottom
- [x] **A7** Marks progress "2/0 entered": denominator = enrolled pupils in the class. — exam submissions now carry `totalStudents`
- [x] **A8** Teacher assignments: one source of truth (class-subject assignment) for Subjects page, exam marks screen, report card. — `shared/classSubjectTeachers.js`
- [x] **A9** French report header: all 10 region names translated; remark typo "Faire" → "Fair". — regions in `shared/officialHeader.js`; "Faire" is in a school's saved grading scale (data, not code) → repaired by the Phase D script after go-ahead

## Phase B — validation rules

- [x] **B1** Timetable: no lessons in Break/non-teaching rows; only a teacher assigned to that class+subject; Wednesday column width. — `shared/timetableRules.js`; existing bad slots listed by the Phase D report
- [x] **B2** School hours: one source of truth between Settings and Periods; warn on conflict; header counts teaching periods only. — both stay school-set (owner); warning on Settings + Periods; dashboard counts teaching periods only
- [x] **B3** Student validation (frontend + backend): DOB not in future, age range per class level (warn, configurable); Cameroon phones → +237 + 9 digits; one system-generated admission number format for new pupils, report existing mismatches (don't rewrite). — `shared/studentValidation.js`; admission format was already single (admissionNumber.service.js), mismatches go in the Phase D report
- [x] **B4** Flag unassigned class-subjects on Dashboard and Teachers page; relabel "Subjects: 105" as class-subject pairs or show distinct subjects. — `classSubjectCoverage`; `GET /admin/class-subjects/unassigned`
- [x] **B5** Year pickers on Progression and Academic structure default to the school's current academic year. — `useSchoolYear` reads `currentAcademicYear` from school-info

## Phase C — UX fixes (after A and B)

- [x] **C1** Fee account page header: student's name and class.
- [x] **C2** Loading states/skeletons instead of blank tables; report card speed (~3s each); batch class print (bulk query, no N+1). — measured: a card is 23 queries (constant per pupil); time was sequential round trips
- [x] **C3** Attendance "–" instead of 0% when nobody was marked; 7-day chart counts school days only. — `schoolDaysOnly`, `dayRate` in shared/attendance.js
- [x] **C4** Remove developer wording from school-facing screens; Intelligence review pilot section Super Admin only.
- [x] **C5** Class intelligence: no change flag with < 3 data points; never "declined" and "strength emerging" for one subject; no duplicated phrasing. — `minChangeObservations` in shared/intelligence/subjectInsights.js; a fall already called a decline is not repeated as a sudden change; "strength is emerging" reworded (it echoed the "emerging" confidence badge)
- [x] **C6** Students to watch: fee debt only when overdue. — watchlist reads `feeReminders.candidates({ mode: "overdue" })`, the same rule as Fee reminders (due date passed, plan behind, or undated this year); `check:watchfees`. **Fixed 2026-10-27 (owner's go-ahead):** the rule took the earliest due date of *any* charge, so a family that paid First Term and owed a Second Term not yet due was overdue since First Term's date (found while building the parent portal). Now `feeReminders.firstUnpaid`: payments and waivers settle charges in due-date order (an undated charge counts as due today), and the first charge not covered gives the deadline. Plans unchanged. Reminders, Students to watch, To do and the portal all read it. `check:overdue` (the old rule fails 8 of its 15 checks)
- [x] **C7** Consistency: shared DD/MM/YYYY + HH:mm formatter; line icons only; one primary button colour; Admissions vs Applications; class-name casing; Fees group header "Form 5 – 5 owing".
  - [x] dates — `shared/dateFormat.js` (web `fmt.date`/`fmt.dateTime`/`utils/formatDate`; mobile copy in `mobile/src/i18n/format.js`); `web: check:dates`
  - [x] Admissions vs Applications — the screen is "Admissions" everywhere (page title, dashboard card, banner, search); `/students/applications` redirects there
  - [x] class-name casing — class group headings no longer upper-case the name ("FORM 5" → "Form 5")
  - [x] Fees group header — "Form 5 – 5 owing"
  - [x] line icons only — colour emoji used as icons replaced by lucide line icons (exams, results, report cards, assignments, subjects, teachers, applications); emoji removed from web + mobile strings; `web: check:icons`
  - [x] one primary button colour — 26 hand-made indigo/blue/purple filled buttons and 11 green "main action" buttons now `primary-*`; green kept only for approve / publish / copied (`success`); `web: check:buttons`
- [x] **C8** Portal access: "Last opened" column ("Never" when null); guardian names; flag access codes linked to no student. — the column header read "Never opened"; `GET /documents/guardian-access` now returns `guardianNames` (from the children's records, shown when no label) and `linkedToNoStudent` (badge + count banner); `check:portalcodes`
- [x] **C9** Settings: broken school logo; Cameroon school types (Collège / Lycée, general/technical); pass mark label "/20". — Settings fetched school-info without `includeLogo`, so an inline-stored logo came back null; a logo file that 404s now falls back (Settings, portal); types `college_general|college_technical|lycee_general|lycee_technical` (+ primary, comprehensive, other), printed header follows; old JHS/SHS values still validate; `check:schooltypes`
- [x] **C10** Student profile: results, attendance, fee balance, guardian contact. — `GET /admin/students/:id/overview` (studentOverview.service: published results on /20 with class position, last 30 days' attendance, current-year balance — fees only with `fees.view`); `StudentOverviewCard` on the profile; `check:studentoverview`
- [x] **C11** Notifications: action items (marks awaiting approval, unpublished exams, overdue fees). — `GET /admin/action-items` (actionItems.service), counted live and per permission (`exams.manage`, `results.publish`, `fees.view`); a "To do" block at the top of the bell panel (no longer counted in the badge since 2026-10-30: the badge is the panel's unread count, so it clears when the panel says "All read"); `check:actionitems`
- [x] **C12** Report templates: 3 ready-made layouts + toggles; raw HTML as advanced. — Classic / Compact / Clear (`print/reportPresets.js`: the shipped template's HTML, CSS-only differences, so every section switch works on each); `GET /templates/presets`, `POST /templates/presets/:id/use`; Templates page leads with the layouts and links to the section switches (Settings → Report layout, now reachable by `?section=reportLayout`); HTML templates moved under "Advanced"; `check:reportpresets`

## Phase D — test data (prepare only, do NOT run)

- [x] **D1** Cleanup script with dry-run: student "Bin Laden", "Testing testing" announcement, pupils sharing one test email; report Kena Academy (7 students, 0 teachers) and exams with no dates. Show dry-run output and wait for go-ahead before deleting. — `scripts/phase-d-cleanup.js` (`npm run cleanup:phased`, dry run by default, `-- --apply` to write). On apply: soft-deletes the test pupil (and deactivates their login) and the test announcement, clears only clearly fake addresses (`FAKE_EMAILS` / `FAKE_DOMAINS` / `test@…` in the script) from a pupil's email or guardian email (the pupils stay), "Faire" → "Fair" (A9). Report only: other addresses shared by several pupils, grouped by guardian (siblings — review, never cleared), Kena Academy counts, undated exams, B1 timetable breaches, B3 old-shape admission numbers. `check:phased`. **Not yet run against the real database** — no `MONGODB_URI` in this shell; the owner runs the dry run and gives the go-ahead

- [x] **D2** Delete Green Valley Academy (all test data — owner, 2026-10-27): `scripts/delete-school.js` (`npm run school:delete -- --school <id or exact name>`), dry run by default (count per collection, logins, portal codes, files). `--apply` asks for the exact school name, refuses a name matching several schools, runs in a transaction on a replica set (otherwise in order, school record last). Sweeps every collection with the school's `schoolId` (read from the database, so none is missed), plus exam marks of its exams/pupils, its staff and pupil logins (never Super Admin), their idempotency keys and sync logs, and uploaded files no remaining record points to. A portal code that also covers a child elsewhere is kept, unlinked from the deleted children and filed under the remaining child's school. Platform stats are built from the school list, so the school just drops out (tested). `check:deleteschool` (two schools + a duplicate name); transaction path checked by hand on an in-memory replica set. **Not applied** — owner runs the dry run first
  - Schools to delete (owner, 2026-10-27): **Green Valley Academy** (`6a4ccbfac10ad6faa189bd85`; real dry run: ~4,600 documents, 72 students, 88 logins, 9 uploaded files) and **Kena Academy** (test data: 0 teachers, 2 undated exams, a portal code shared with a Green Valley child). Delete Green Valley first — the shared code is unlinked and moves to Kena — then Kena, which takes the code with it.
  - Deleting both leaves zero schools and a working platform: Super Admin logs in, dashboard / performance / filters / school list load empty with zero totals, a new school can be created — `check:deleteallschools`.
  - Uploaded files are removed from wherever they live — GridFS in the same database (always checked, whatever driver the machine running the script is set to), the bucket if `STORAGE_BUCKET` is set, else the local disk — so `--apply` can run from any machine with the same `MONGODB_URI`. It also removes logo and photo files named after the school or its pupils that no record points to any more (a replaced logo), and every GridFS file filed under the school. The dry run prints how many GridFS files and MB that is.

## Phase E — launch blockers found after Phase D

- [x] **E1** Uploaded files lost on every Render deploy (2026-10-27: Render redeployed master at ~22:13 UTC and `/uploads/logos/6a4ccbfac10ad6faa189bd85-ad40837113a2.jpg` went 404 — QA's "broken school logo"). Every upload now goes through `backend/src/storage/fileStore.js`: a local-disk driver (development) and an S3-compatible bucket driver (Cloudflare R2), configured by `STORAGE_*` env vars. Writers moved: school logos, student photos (staff and the pupil's own), admission documents (multipart and base64), teacher content, message attachments. Records keep their `/uploads/...` URLs; `src/storage/serveUploads.js` (moved out of `server.js`) redirects them to a signed bucket URL, or to `STORAGE_PUBLIC_URL` for logos. The message signature gate and the closed `/uploads/applications` stay in front. A missing logo or photo is answered with a grey placeholder image instead of a broken image. Printed documents and receipts load logos and photos from the bucket before embedding them. D2 deletes the school's files from the bucket. `npm run uploads:to-bucket` copies files still on a disk into the bucket. `check:filestore` (mocked bucket). **Files already lost on Render cannot be recovered** — they show the placeholder until uploaded again.
  - 2026-10-28: no R2 (Cloudflare asks for a card). Production now keeps uploads in **MongoDB GridFS** (`uploads.files` / `uploads.chunks`, a third driver; the default with `NODE_ENV=production` and no `STORAGE_BUCKET` — **nothing to set on Render**). Each file records its school. Logos are shrunk to ≤ 512 px WebP, photos to ≤ 400 px JPEG, quality 80, metadata stripped; over 5 MB or not an image is refused. One gate (`src/storage/fileAccess.js`) for `/uploads/...` and the new `/files/:id`: logos public; photos, attachments and teacher content need a login of the file's school, a Super Admin, or a signed link (printed report cards sign the photo link; `GET /api/files/signed-link` for the phone's browser). `REQUIRE_MEDIA_SIGNATURE` is no longer read. D2 removes the school's GridFS files and counts them in the dry run. `npm run uploads:usage` — MB per school against Atlas's 512 MB. `check:gridfs` (49 checks). The bucket stays available: set `STORAGE_BUCKET` + `STORAGE_*` and `npm run uploads:to-bucket`.

## Launch order

1. `cd OfflineSchoolApp/backend && npm run check:all` on a stable machine (plus the web checks) — all green.
2. Merge PR #39 into master.
2b. Uploads (E1): nothing to set — after the deploy the boot log must say `Uploads → MongoDB GridFS`. Make sure Render has no `STORAGE_DRIVER=local` and no `STORAGE_BUCKET` left over. Re-upload Green Valley's logo if it is kept. Check the size now and then: `npm run uploads:usage`.
3. Deploy.
4. Back up the production database: Atlas → Backup → take snapshot, or `mongodump --uri "$MONGODB_URI" --out backup-2026-10-31`. Confirm the backup finished before going on.
5. D2, Green Valley Academy — dry run, read the counts, then apply (asks for the exact name):
   `npm run -s school:delete -- --school "Green Valley Academy"`
   `npm run -s school:delete -- --school 6a4ccbfac10ad6faa189bd85 --apply`
6. D2, Kena Academy — dry run, then apply:
   `npm run -s school:delete -- --school "Kena Academy"`
   `npm run -s school:delete -- --school "Kena Academy" --apply`
7. Delete the 9 uploaded files on the server (paths printed by the Green Valley dry run, under `backend/uploads/`), unless step 5 ran on the server and reported them removed.
8. Create the new clean test school: `npm run -s seed:test-school` — "Ecole Test Bilingue" (code ETEST): 4 classes, 8 teachers covering every class-subject, a clash-free timetable, 40 pupils with four multi-child guardians, Sequences 1–2 marked (1 published), two weeks of attendance, fees paid / part-paid / overdue, one announcement. Prints the head teacher, a teacher and a three-child parent sign-in once; refuses if the school exists. `check:seedtestschool`.
9. Check: `npm run -s cleanup:phased` dry run should list nothing; the platform dashboard shows only the new school.

Pass `MONGODB_URI` with `read -rs MONGODB_URI && export MONGODB_URI` so the connection string is not echoed or kept in shell history.

## Final

- [x] Run all suites; open PR listing what was fixed and what was skipped and why. — PR #39. 2026-10-27: backend `npm run check:all` green in one uninterrupted run (125 scripts, exit 0) after fixing what the first runs found: C11's action-items route reachable by a teacher (now `fees.view`); stale expectations from A5 (statistics on /20, `check:panel`) and C5 (one fall said once: calibration fixture re-recorded with S16 added, `check:pilot-readiness`); an unused import from C7 (web lint). Web: 13/15 checks green; `check:l10n` (1) and `check:print` (3) fail identically on master — see Notes.

## Notes / skipped

- A5: Term and Annual Results showed `overallGrade`, which for schools on the shipped bands is a US letter (A+…F); replaced with the stored remark. The bands themselves (and their `gpaPoints`) were left in the data model.
- A8: Form 1 English has two active assignments (Mr Buh, Mr Kum); every screen shows both — allowed (owner, 2026-10-27).
- B2: the dashboard period-count fix (exclude breaks) has no automated test — the admin dashboard endpoint has no fixture harness yet.
- B3: mobile add/edit student forms have no inline check yet; the server normalises or refuses what they send.
- C2: no true server-side bulk print endpoint yet. A card already reads its class in a constant 23 queries (measured); the cost was ~20 sequential round trips per card and one card at a time. Fixed by parallel reads within a card and 4 cards in flight. A single bulk endpoint would cut further; follow-up if prints are still slow on the real database.
- C4: the pilot section is hidden in the UI for everyone but Super Admin; the server's pilot endpoints still accept any role holding the `insights.pilot` permission (changing role permissions is a policy call — not done).
- C5: the rules changed but `ENGINE_VERSION` stays "1.0.0" — pilot reviews are filed under that version; bumping it (so pre- and post-C5 reviews are told apart) is the owner's call.
- C7: `web/scripts/check-localization.mjs` has one failure that predates this branch's C7 work ("the exam page offers Unpublish while any class's results are out") — not a date issue; left for the final suite run.
- Web `check:print`: 3 failures (window populated after the card request; batch HTML collected; no card counted before its HTML) — identical on master with master's files, so they predate this branch; the checks look for source patterns in `reports/cards.tsx` that an earlier refactor changed. Left for a follow-up. Web `lint`: one warning in `LoginPage.tsx` (React Compiler skip), untouched by this branch.
- C7: `web/src/pages/students/applications/index.tsx` (and `components/applications/*`) is no longer routed — the old address redirects to Admissions. Left in place; delete in a follow-up.
- C7: icons and button colour were done on web; the mobile app already uses Ionicons line icons (its emoji were in strings, now removed) — its button colours were not audited.
- C9: schools that saved JHS / SHS / vocational / university keep that value (shown as a selected chip) until someone picks a Cameroon type — not rewritten automatically.
- C11: action items are recounted on the panel's 60 s poll; the overdue-fees count reads the whole school's fee ledger each time. Fine at this size — cache it if a large school's database feels it.
- C12: a layout's look was checked through its CSS and the section gates, not by printing a card in a browser — worth one visual print of each before the first issue.
