# 40 — Staging and release checklist

For whoever deploys and accepts the release. It covers two changes, shipped
together on branch `academic-agreed-calculation`:

- **Cold analysis.** The school-wide Intelligence analysis runs in a worker
  and its report is stored ([docs/38](38-cold-intelligence-analysis.md),
  §10–§11).
- **The agreed calculation.** One way of calculating results and promotion
  for every school
  ([docs/39](39-academic-architecture-audit.md), Current status and §20.0).

Nothing below has been done on a real server, a real school's data, a
browser or a device. Tests at this version (2026-10-16, database URI and
provider keys blanked): backend `check:all`, every suite one by one, 110
suites, 6,430 checks, 0 failed; `check-revert-previous.js` (1.4), 33 passed
against each of `origin/master` and `097de9c`; desktop 275 and mobile 714
passed, 0 failed; web build, lint, `i18n:check` and `check:l10n` pass. The
detail check before release, and what it left open, is
[docs/41](41-detail-check.md). Each step is something to do, not a result. Every step
has an owner:

- **Operator:** runs the servers and the database.
- **School head:** accepts the release for the school.
- **Teacher:** checks the screens they use.
- **Developer:** answers anything that fails.

---

## 1. Before deploy

**1.1 Size the analysis worker** — *operator*
- **Do:** choose `ANALYSIS_WORKER_HEAP_MB` (default 2048) and
  `ANALYSIS_CONCURRENCY` (default 1) for the server's memory. The memory
  needed is about
  `ANALYSIS_CONCURRENCY × ANALYSIS_WORKER_HEAP_MB + the server's own memory`,
  plus MongoDB if it runs on the same host.
- **How:**
  - Measure the server's own memory on the host (for example
    `docker stats` at rest).
  - Add about 130 MB for a 5,000-pupil run; that is the server heap growth
    measured in docs/38 §8, in a Codespace.
  - The worker heap figure is a cap. Its real use at your size was never
    measured.
- **Worked example** (illustration figures, not measurements): a host with
  4,096 MB for the app and a server measured at 400 MB.
  - `1 × 2,048 + 400 + 130 = 2,578 MB` fits.
  - `2 × 2,048 + 400 + 130 = 4,626 MB` does not.
- **Expected:** the chosen values leave headroom on the host; set them in
  the backend environment.
- **If it fails:** an analysis ends `WORKER_OUT_OF_MEMORY` (the server carries on).
  Lower concurrency first, then raise the heap if memory allows.
- **From:** docs/38 §7, §10 item 5, §11 prerequisite 4.

**1.2 Database user, or the index by hand** — *operator*
- **Do:** give the backend's database user the right to create indexes on
  `intelligenceanalysisruns`. Or create the index once, by hand:
  `db.intelligenceanalysisruns.createIndex({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: "string" } }, name: "one_active_analysis_per_key" })`
- **Expected:** step 2.2's boot line says the index is unique.
- **If it fails:** with the index missing, two server processes can run the
  same analysis twice. Do not run more than one process until it exists.
- **From:** docs/38 §7, §11 prerequisite 3.

**1.3 Back up the database** — *operator*
- **Do:** take a backup immediately before the deploy.
- **Expected:** a restorable backup, dated, kept until the release is
  accepted.
- **If it fails:** do not deploy.
- **From:** the rollback steps below.

**1.4 Decide the rollback path, for both changes** — *operator, with the developer*
- **One server, one database, every school.** Every school runs on the same
  backend and the same database: `docker-compose.yml` starts one `backend`
  (line 26) on one database, `school_app` (line 37). Schools are created
  inside the app by the super admin (`POST /api/super-admin/schools`,
  `backend/src/routes/superAdmin.routes.js:198`), and every record carries
  its `schoolId` (`backend/src/utils/tenant.js:98`, `requireSchool`). So
  deploying switches every school at once, and restoring the database
  restores every school, not one.
- **Do:** agree, before deploying, how you would go back:
  - **Cold analysis:** revert the change and redeploy backend and web
    together. The previous code ignores the `intelligenceanalysisruns`
    collection, which can be left or dropped; no other collection changed.
    The four `ANALYSIS_*` variables are ignored (docs/38 §11, Rollback).
  - **Agreed calculation: decided by the project owner, 2026-10-16.**
    - Nothing published under the new calculation: revert backend and web
      together, then run the cleanup with the latest manifest, --dry-run
      first. No restore; nothing entered is lost.
    - Something published under the new calculation: either restore the
      backup from 1.3 or the latest daily backup from 1.6, or, after the
      revert, unpublish those results, run the cleanup, reprocess and
      publish again. Cards already issued from the new figures must be
      reissued. Tell the schools before either.
    - The manifest must exist: it is recorded every day of the first week
      (1.6) and again immediately before any revert. If the last recording
      was missed, use the latest daily one, and check by hand the exams
      reprocessed since it.

    The commands, from `backend/`:
    - record the manifest (read-only):
      `node scripts/revert-cleanup-agreed-calc.js --uri <URI> --record <manifest-YYYY-MM-DD.json>`;
    - the cleanup, after the revert:
      `node scripts/revert-cleanup-agreed-calc.js --uri <URI> --manifest <manifest.json> --dry-run`,
      then the same without `--dry-run`. It sets `academicYear` and `term`
      back to null on exactly the recorded rows, where they still hold the
      recorded values and are unpublished; it counts the rest.

    The reasons, from the code:
    - **Sequence results:** results computed after the release are stamped
      `exam-process/3`, `term/3` and `annual/3`. The previous code reads only
      `exam-process/2` sequence results as /20, so on a card with no rebuilt
      figure it would multiply an `exam-process/3` average by 5.
    - **Promotion bars:** stored in `AcademicStructure.rules`, they are
      ignored by the previous default rule (`legacy`).
    - **Cohort files:** a format 2 calibration file is refused by the
      previous code.
    - **Pilots:** learning integration goes back to 1.0.0, so pilots drift
      again.
    - **A code revert leaves the year on every reprocessed sequence result
      (tested).** The new code writes `academicYear` and `term` on each
      sequence result. The previous route's update does not set them, so
      they stay, even after the previous code reprocesses the exam
      (`backend/src/routes/exam.routes.js:1760` at `origin/master`, `:1873`
      at `097de9c`). The previous promotion run selects published sequence
      results by `academicYear` (`backend/src/services/promotion.service.js:53`
      at `origin/master`, `:58` at `097de9c`). Its own results carry
      no year, so today it finds none and proposes on `no_results`. After a
      revert it finds the left-over results and compares their /20 average
      with the class's old 0–100 bar: with a bar of 50, every pupil of the
      class is proposed "repeated". Everything else reads correctly and is
      overwritten cleanly: cards, terms, years and figures are what the
      previous code gives on its own.
    - **The previous code can also write a year and term itself.** Its
      "Calculate & save" (`POST /api/results/:examId/student/:studentId/reportcard/calculate`)
      creates a sequence result with them when the pupil has none
      (`backend/src/controllers/results.controller.js:1333` at
      `origin/master`, `:1406` at `097de9c`). So the year on a row does not
      say which code wrote it, and after the previous code reprocesses a row
      its `calcVersion` is `exam-process/1` again. Only the ids recorded
      before the revert say which rows this branch wrote.

  - **On the shared server, a restore affects every school.** Restoring
    the shared database puts every school back to that backup, and every
    school loses what it entered after it, not only the school whose
    results went wrong. Nothing restores one school's documents on its own:
    no tool for it exists. 1.6 keeps a backup of the whole server for each
    day of the first week, so the loss is at most a day.
- **Tested:** `node scripts/check-revert-previous.js --ref origin/master`
  (from `backend/`; not in `check:all`, as it checks out the previous code
  in a temporary git worktree). On a made-up school, the new code
  reprocesses, then the previous code reads, reprocesses and runs
  promotion. It covers the cleanup: dry run first, then cleanup, with and
  without the previous code reprocessing in between; an older row with a
  year, as "Calculate & save" writes one, is left alone. It also covers
  results published under the new code, and published then unpublished.
  After a revert the class-wide unpublish routes are gone with the new
  code: the previous code unpublishes one sequence result at a time
  (`PUT /api/results/summary/:id/publish` with `publish: false`), which the
  test uses; it has no route for term or annual results, and does not
  refuse to recompute them when published.
  After the cleanup, the previous promotion run proposes exactly what it
  proposed before this branch existed, and nothing else changed. 33
  passed, 0 failed against `origin/master` (`99d59f4`) and against
  `097de9c` (this branch just before the agreed calculation).
- **Expected:** the rollback decision above, read and understood by the
  operator before the deploy.
- **If it fails:** do not deploy.
- **From:** docs/38 §10 item 7, §11; docs/39 §20.0 ("Agreed calculation").

**1.5 Dry run, per school** — *operator runs it; school head reviews it*
- **Do:** for each school, before the release reaches it, run the dry run
  against a copy of production, or read-only against production itself
  (from `backend/`, with devDependencies installed):
  `node scripts/dry-run-agreed-calc.js --uri <database URI> --school <schoolId> [--year 2026/2027] [--salt <word>]`.

  It copies that one school into a private in-memory database and
  reprocesses the year's unpublished results with the new code. Published
  results are left, as on the server. It never writes to the source:
  `check:dryrun` proves the source is byte-identical afterwards.
- **What it reports** (counts and pseudonymous pupil ids only, never names):
  - how many sequence, term and annual averages change, and the largest
    change;
  - how many positions change;
  - each pupil whose annual promotion status would change, and from what to
    what;
  - how many of the year's sequence, term and annual results are already
    **published**. Those keep their figures: reprocessing them is refused
    (409 `PUBLISHED_RESULTS`) until the school unpublishes them.

  The promotion section is empty until the year has annual results: before
  then, it reports no change because there is nothing to compare, not
  because nothing would change.

  `--salt` makes the pupil ids reproducible, so the operator can match them
  privately if the head asks.
- **Tested:** `check:dryrun` (13 checks, every figure worked by hand in
  `backend/scripts/check-dry-run-agreed-calc.js`) runs the dry run on a
  made-up school in an in-memory database, from the module and from the
  command line, and runs `list-unconfirmed-bars.js` (7.1) on the same
  database; the source is byte-identical afterwards (dbHash, every
  document, every index). Its report, as printed (pupil ids are
  pseudonyms; the school is made up):

  ```
  Dry run — school 6a00000000000000000000d1, 2026/2027
  Published for the year (refused until unpublished): 2 sequence, 0 term, 0 annual result(s)
  Reprocessed: 1 exam(s) (1 published, left), 2 class-term(s) (0 published), 2 class-year(s) (0 published)
  Sequence averages: 2 of 4 change, 0 new, 0 removed, 2 position(s) move; largest +2 (P-c0ced528, s1: 12 → 14)
  Term averages: 2 of 2 change, 0 new, 0 removed, 2 position(s) move; largest +1 (P-c0ced528, term 1: 12 → 13)
  Annual averages: 2 of 2 change, 0 new, 0 removed, 2 position(s) move; largest +1 (P-c0ced528, year: 12 → 13)
  Promotion status changes: 1
    P-1665d745: promoted → repeated
  ```

  Not yet run against any real school's data.
- **Expected:** every school's head reads that school's report and accepts
  the changes before the release. Large changes are expected where CA or
  coefficients were not counted before.
- **If it fails:** the script stops with a message (no school, no year,
  cannot connect), and nothing is written. If a head does not accept the
  changes, hold the release, for every school (1.6), and give the report to
  the developer.
- **From:** docs/39 Current status and §20.0 ("Agreed calculation").

**1.6 Release to every school, with safeguards** — *operator, with every school's head*
- **One shared server, so every school switches at once.** One backend and
  one database serve every school (1.4), and the calculation is one
  calculation for every school (docs/39 §20.0). There is no switch per
  school, and none is to be added without the project owner.
- **Do:**
  - **Dry run accepted by every head.** Run 1.5 for every school; every
    head accepts the report before the release.
  - **Back up the whole server every day for the first week**, on top of
    the backup before the deploy (1.3). Keep each one, dated, until the
    release is accepted.
  - **Record the manifest every day, beside the backup:**
    `node scripts/revert-cleanup-agreed-calc.js --uri <URI> --record <manifest-YYYY-MM-DD.json>`
    (read-only). Keep it, dated, with that day's backup. The cleanup in a
    rollback needs it (1.4).
  - **Ask schools not to publish results for the first 5 school days**, so
    that rollback stays a revert plus cleanup (1.4). The request is in the
    message (6).
  - **Prefer the break between terms.** Release when schools are not
    entering marks or processing results, so that fewer results are
    reprocessed in the first days, and a restore (1.4) loses as little as
    possible.
- **Expected:** every head's acceptance of their dry run, a backup and a
  manifest for each day of the first week, nothing published in the first
  5 school days, no failed analysis runs (7), and no result changes a
  school cannot match to its dry run.
- **If it fails:** decide with the developer whether to roll back, as 1.4
  says. Record the manifest again immediately before the revert. Tell
  every school first.
- **Considered, not chosen: a separate instance for the first school.** A
  second copy of the stack with a copy of one school's data, so that a
  restore touches that school alone. Its costs:
  - a second server or stack, and the operator's time to run it;
  - a tool to copy one school's documents out of the shared database and,
    after the week, back in: none exists; it would be new developer work;
  - that school's users pointed at the new instance: the desktop app's
    server is set in the app (`desktop/src/main/main.js:332`), but the
    mobile app's is fixed when it is built (`EXPO_PUBLIC_API_URL`,
    `mobile/src/services/api.js:46`), so the school needs its own mobile
    build;
  - the school kept off the shared server while its copy exists.
- **From:** docs/39 §20.0 ("Agreed calculation": effective for every
  unpublished result); this checklist, 1.3 to 1.5.

**1.7 Ship backend and web together; plan desktop and mobile** — *operator*
- **Do:** deploy the backend and the web console from one build of this
  branch. They ship in one image here; keep it that way.
- **Desktop and mobile:**
  - Release new desktop and mobile builds from the same branch.
  - An older mobile app still works against the new server, but its
    "Calculate & save" screen shows editable fields the server now ignores.
  - An older desktop computes a provisional figure offline that the server
    replaces on sync, or refuses (409) if the class has a published result.
  - **An older desktop cannot render, print or issue a report card
    offline**, so it cannot print its offline figure on a card. The
    sequence card and its reissue are server-only
    (`desktop/src/main/api/coverage.js:417` and `:427`); the desktop has no
    offline answer for the term or annual card; a route the desktop does
    not answer goes to the server (`desktop/src/main/api/index.js:111`,
    `handle`); and printed cards (`GeneratedReport`) are not copied to the
    desktop (`backend/src/config/syncFeed.js:469`). The cards page asks the
    server for the rendered card (`web/src/pages/reports/cards.tsx:323`).
    Offline, the card asks for a connection. The old offline figure shows
    only in the desktop's own results lists until it syncs. Not a
    card-printing risk; the results-list risk is the line above.
  - **Neither app can be forced to a minimum version.** Neither sends its
    version to the server, the server checks none, and neither has an
    automatic updater. So the old builds keep working against the new
    server, with the limits above: tell schools to install the new builds,
    and keep this warning until they have.
- **Expected:** one backend+web version live, and the desktop and mobile
  builds scheduled.
- **If it fails:** a web build older than the backend reads the analysis's
  202 answer as a report. From reading that code, the review page is
  expected to break until the run completes (not tested). Redeploy them
  together.
- **From:** docs/38 §11 prerequisite 5; docs/39 §20.0.

---

## 2. Deploy to staging

**2.1 Compose networking end to end** — *operator*
- **Do:** `docker compose up --build` on the staging host, then check from
  inside the network that:
  - the backend reaches `mongo:27017`;
  - nginx reaches `backend`.
- **Expected:** the backend logs `MongoDB connected` and stays up; nginx
  proxies `/api`.
- **If it fails:** this has **never** been verified: the development
  environment dropped container-to-container traffic. Check the Compose
  network and host firewall. The same images worked with host networking
  (docs/38 §11). Escalate to the developer.
- **From:** docs/38 §10 acceptance 1, §11 "Not verified".

**2.2 The boot line for the index** — *operator*
- **Do:** read the backend's boot log.
- **Expected:** `intelligenceanalysisruns activeKey is unique ✅`.
- **If it fails:** the line says `MISSING`. Create the index by hand (1.2)
  and restart before running more than one backend process.
- **From:** docs/38 §7, §10 acceptance 1.

**2.3 Health through nginx** — *operator*
- **Do:** `GET /api/health` through nginx, not directly to the backend.
- **Expected:** `200` with `"status":"ok","database":"connected"`.
- **If it fails:** check 2.1 first. Escalate to the developer.
- **From:** docs/38 §11.

**2.4 Ownership of an existing uploads volume** — *operator*
- **Do:** if the `uploads_data` volume was created by an earlier image or by
  hand, check its owner.
- **Expected:** owned by the image's `appuser:appgroup` (100:101), and an
  upload (a school logo) succeeds.
- **If it fails:** uploads fail with `EACCES`. Run
  `chown -R 100:101` on the volume once.
- **From:** docs/38 §11 "Not verified".

**2.5 One analysis, end to end** — *operator, signed in as a school head*
- **Do:** on staging, ask for the review queue as a head,
  `GET /api/insights/review-cases`. A first request may answer 202 (being
  prepared). Then read the run, `GET /api/insights/analysis-runs/latest`.
- **Expected:** the run ends with `status: "succeeded"` (within a minute or
  two for a small school), and a second `GET /api/insights/review-cases`
  answers 200 from the stored report.
- **If it fails:** a run that ends `failed` carries `error.code`; give it and
  the run id to the developer. This is the check that would have caught the
  code digest failing in the image (docs/41 §6).
- **From:** docs/38 §10; docs/41 §6.

---

## 3. Browser and device checks on staging

None of these screens has been opened in a browser or on a device. Use a
staging copy of a real school's structure, or the demo school, never a
production school.

| # | Screen | Who | What correct looks like | From |
|---|---|---|---|---|
| 3.1 | Intelligence review, cold, on a school large enough that the analysis takes more than 8 s | school head | The page shows "being prepared", then fills by itself without a reload. A reload afterwards is served at once. | docs/38 §10 acceptance 2 |
| 3.2 | Intelligence review as a teacher; as an operator | teacher, operator | The teacher sees only the classes they teach. The operator must choose a school first and never sees every school at once. | docs/38 §10 acceptance 3 |
| 3.3 | Advancing a development pilot while the analysis is cold | school head | A toast says the analysis is being prepared. The same action succeeds once it is ready. | docs/38 §10 acceptance 4 |
| 3.4 | Settings → Calculation rules | school head | Read-only: five statements of how results are calculated, the default bar with a link to Progression, and the year's published and unpublished counts. No choices, no Save. | docs/39 §20.0 ("Agreed calculation") |
| 3.5 | Promotion → Progression | school head | A year selector and a school bar field showing the pass mark as placeholder. Each class has a /20 bar; where none is confirmed for the year, the old 0–100 value shows beneath it, marked "not used". Each class shows its published annual count, with a warning for classes with none. Bars are locked while a draft run exists. Saving a bar change asks for a reason. The "New run" dialog warns about classes with no published annual result. | docs/39 §20.0 |
| 3.6 | Settings → Academic structure | school head | No "annual average method" and no promotion threshold field (removed; the year's bars are on Progression). Each sequence's "Promo" toggle has the tooltip "Not used to decide promotion. Promotion uses the annual average and the class bar.", in English and French. | docs/39 §20.0 ("Follow-up"; owner's answers) |
| 3.7 | An annual report card printed in French, for a final-year pupil and for a pupil who repeats | school head | The council's decision prints in French: DIPLÔMÉ(E) for the final-year pupil, REDOUBLANT for the repeat, ADMIS(E) EN … for a promotion, ADMIS(E) SOUS CONDITION for a conditional one; the card says "Année scolaire". The English card says GRADUATED for the final-year pupil. Average, grade and rank are as before. | docs/39 §20.0 ("Follow-up") |
| 3.8 | Mark entry: web exam marks page; mobile teacher marks screen | teacher | Web: the "A" toggle's tooltip says absent leaves the subject out of the average and 0 counts; saving with a blank mark is blocked with the same explanation. Mobile: the blank-mark message says the same. In English and French. | docs/39 §20.0 ("Agreed calculation") |
| 3.9 | Mobile: admin pupil result → Calculate & Generate Report Card | school head | Nothing on the screen is editable. Pressing the button first asks to confirm that the whole class is recalculated from the stored marks, and that it is refused if any result in the class is published. With a published result in the class, the refusal says so. | docs/39 §20.0 ("Mobile Calculate & save screen") |
| 3.10 | Mobile: create and edit an exam | school head | The term picker offers the school's own terms by name (for example two semesters). Offline it offers the last terms it saw, and the three fixed terms if it never saw any. | docs/39 §20.0 (validation and defect-closure passes) |
| 3.11 | Mobile messages, staff and pupil: list, thread, new conversation; at 360 px, on Android and on iOS | teacher, pupil | The header and the send button sit clear of the status bar and the navigation bar (or home indicator). With the keyboard open, the input and the send button stay visible. The list's unread badge counts messages not yet read and clears after reading. Times are in the app's language (a French app on an English phone shows French). A read-only conversation has no reply box. | docs/41 §5 |
| 3.12 | Mobile messages: a refused message | teacher | Send a message the server refuses (for example, in a read-only conversation reached before the screen knew it was read-only, or with the server blocking it). The bubble turns red, "Not sent — tap to retry"; a tap puts it back to queued and it is sent when the server accepts it. | docs/41 §5 |
| 3.13 | Mobile parent portal: Messages tab and a thread; at 360 px, on Android and on iOS | parent | The six tabs fit or scroll sideways without breaking a word. The thread's header and send button clear the system bars; the keyboard does not cover the input. A send that times out and is retried does not appear twice. Times in the app's language. | docs/41 §5 |
| 3.14 | Web messages at phone width (360 px) | teacher | The list fills the screen; choosing a conversation shows the thread with a Back link; the composer and bubbles are readable. | docs/41 §5 |
| 3.15 | Unpublish, on the exam page, the term results and the annual results | school head | Beside Publish, "Unpublish…" opens a dialog: a class (when the page shows more than one), a reason of at least 4 characters, and the note that issued cards stay as issued. Confirming unpublishes that class only; its figures do not change; Process / Compute is then allowed. A teacher has no Unpublish. In English and French ("Annuler la publication"). | docs/41 §7 |
| 3.16 | Unpublishing a year while a promotion run for it exists | school head | With a draft or committed run for the year, unpublishing the year's results is refused, naming the run's state; once the draft is discarded or the run reversed, it is allowed. | docs/41 §7 |
| 3.17 | Settings → school details: Report card language; then any card from web, mobile and a reissue | school head | The setting offers English and Français. With Français chosen, every sequence, term and annual card prints in French, whoever opens it, including a reissue; with English, in English. | docs/41 §7 |

For each: **if it fails**, note the screen, the account and what was seen,
and give it to the developer. Do not accept the release with a failing
screen.

---

## 4. Restart mid-analysis — *operator, with a school head watching 3.1*

- **Do:** start a cold analysis (3.1), then restart the backend while it
  runs.
- **Expected:** the review page keeps answering "being prepared" (HTTP 202)
  and recovers on its own within about a minute.
- **If it fails:** the run stays stuck past its lease, or the page shows a
  failure. Escalate to the developer with the run id
  (`GET /api/insights/analysis-runs/latest`).
- **From:** docs/38 §5 (Shutdown), §10 acceptance 6.

---

## 5. Pilots — *operator, then each school head*

- **Do:**
  1. List open pilots, read-only, in the database:
     `db.intelligencepilots.find({ isOpen: true, deletedAt: null }, { schoolId: 1, kind: 1, status: 1, engineVersions: 1 })`.
  2. For each, the pilot's report, `GET /api/insights/pilot/:id/report`
     (as the school's head), shows `scope.engineVersionsMatch` and
     `scope.engineDrift`.
- **Expected:** a pilot opened before this release shows drift on
  `learningIntegration` (1.0.0 → 1.1.0). Recording a calibration decision on
  it answers 409 `ENGINE_VERSION_CHANGED`.
- **What to do with a drifted pilot:** nothing updates a pilot's recorded
  versions, so re-baselining means:
  - the head closes it (CLOSED is allowed from every state;
    INSUFFICIENT_EVIDENCE only from ANALYSIS_READY);
  - and opens a new pilot, which records the current versions.

  **The closed pilot's reviews do not count toward the new pilot.** A
  review is stamped, when it is recorded, with the id of the pilot open at
  that moment (`backend/src/routes/insights.routes.js:713`;
  `IntelligenceReview.pilotRunId`, `backend/src/db/models/IntelligenceReview.js:116`).
  A pilot's evidence is only the reviews stamped with its own id, since it
  opened, on its engine version
  (`backend/src/services/intelligence/pilot.service.js:190`, `windowOf`).
  A new pilot has a new id, so it starts with no evidence. The reviews are
  not deleted, and the closed pilot stays listed
  (`GET /api/insights/pilot/history`, `insights.routes.js:871`) with its
  report (`GET /api/insights/pilot/:id/report`, `insights.routes.js:860`),
  but that report is worked out again each time it is read, not frozen.

  So, before closing, the head saves:
  - the pilot's report, `GET /api/insights/pilot/:id/report`;
  - its current evidence, `GET /api/insights/pilot/evidence`;
  - a note of who reviewed and how much was covered, for the new pilot's
    start.
- **If it fails:** a drifted pilot cannot be closed. Escalate.
- **From:** docs/39 §20.0 ("Agreed calculation", the version bump).

---

## 6. Tell the schools — *school head, with the operator*

Send to every school before the release: it reaches them all at once (1.6). English and French.

**English**

> From [release date], results are calculated the same way in every school.
> - Each sequence average is out of 20 and uses subject coefficients. Your
>   continuous assessment (CA) is included if your school uses CA.
> - A subject marked absent or exempt, or with no exam mark, is left out of
>   the average. A mark of 0 counts as 0.
> - Results that are not yet published for this year will change when you
>   process them again. Published results do not change.
> - To recalculate results that are already published (a sequence, a term
>   or a year), unpublish them first: on the web console, open the exam (or
>   the term or year results), choose Unpublish, and give a reason. Report
>   cards already issued stay as issued.
> - A sequence calculated before this change keeps its old figure inside a
>   new term: converted to /20, but still without CA or coefficients.
> - On annual report cards, pupils in a final-year class show "Graduated"
>   (DIPLÔMÉ(E) on French cards).
> - Report cards print in your school's language, set in Settings (school
>   details), whoever opens them.
> - Promotion bars are now set for each year, out of 20, on Promotion →
>   Progression. Please confirm a bar for each class. Old bars (0–100) are
>   shown there but are not used.
> - Please do not publish results until [date].
> - The first Intelligence review after the change may take a few minutes to
>   prepare.

**Français**

> À partir du [date de mise en service], les résultats sont calculés de la
> même façon dans toutes les écoles.
> - Chaque moyenne de séquence est sur 20 et tient compte des coefficients.
>   Le contrôle continu (CC) est inclus si votre école l'utilise.
> - Une matière notée absente ou dispensée, ou sans note d'épreuve, est
>   retirée de la moyenne. Une note de 0 compte comme 0.
> - Les résultats de cette année qui ne sont pas encore publiés changeront
>   lorsque vous les retraiterez. Les résultats publiés ne changent pas.
> - Pour recalculer des résultats déjà publiés (une séquence, un trimestre
>   ou une année), annulez d'abord leur publication : dans la console web,
>   ouvrez l'examen (ou les résultats du trimestre ou de l'année), choisissez
>   « Annuler la publication » et indiquez une raison. Les bulletins déjà
>   délivrés restent tels quels.
> - Une séquence calculée avant ce changement garde son ancienne note dans
>   un nouveau trimestre : convertie sur 20, mais toujours sans CC ni
>   coefficients.
> - Sur les bulletins annuels, les élèves d'une classe terminale sont
>   indiqués « DIPLÔMÉ(E) » (« Graduated » sur les bulletins en anglais).
> - Les bulletins sont imprimés dans la langue de l'établissement, choisie
>   dans Paramètres (informations de l'établissement), quel que soit
>   l'utilisateur.
> - Les seuils de passage se fixent désormais par année, sur 20, dans
>   Promotion → Progression. Merci de confirmer un seuil pour chaque classe.
>   Les anciens seuils (0–100) y sont affichés mais ne sont pas utilisés.
> - Merci de ne pas publier de résultats avant le [date].
> - La première revue Intelligence après le changement peut prendre quelques
>   minutes à se préparer.

- **Expected:** every school has the message before the release.
- **If it fails:** hold the release, for every school.
- **From:** docs/39 Current status, §21.1; docs/38 §10.

---

## 7. After release, for the first week — *operator, daily*

| Watch | Where | Act when |
|---|---|---|
| Analysis runs failing or timing out | run records (`intelligenceanalysisruns`, `status: "failed"`, `error.code` one of `WORKER_OUT_OF_MEMORY`, `TIMEOUT`, `ENGINE_ERROR`, `WORKER_EXITED`, `LOAD_ERROR`, `STORE_ERROR`, `REPORT_TOO_LARGE`, `INTERRUPTED`) | any `WORKER_OUT_OF_MEMORY` or `TIMEOUT`: revisit 1.1; any `ENGINE_ERROR`, `WORKER_EXITED`, `LOAD_ERROR` or `STORE_ERROR`: escalate to the developer; `INTERRUPTED` after a restart is expected (4) |
| Worker memory | host memory during runs (`docker stats`) | memory near the host's limit: lower `ANALYSIS_CONCURRENCY` |
| 409 `PUBLISHED_RESULTS` volume | backend access log (morgan, `combined` in production): 409 answers to `/process`, `/term-results/compute`, `/annual-results/compute` and `/reportcard/calculate` | many from one school: that school needs the "unpublish first" step explained (6) |
| Support questions about promotion bars | support channel | the same question twice: add it to the message in 6 |
| Manifest recorded (1.6) | that day's `--record` line: "Recorded N sequence result(s) stamped exam-process/3 (M published) …"; note N and M with the day's backup | no manifest for the day: record it now; M above 0 in the first 5 school days: a school published, so rollback is no longer a revert plus cleanup for it (1.4) |

**7.1 Before each school's first promotion run: classes with no confirmed bar** — *operator, then the school head*
- **Do:** list, for every school, the classes with no confirmed bar for the
  year (read-only; from `backend/`):
  `node scripts/list-unconfirmed-bars.js --uri <database URI> [--year 2026/2027]`.
  It prints each school's classes without a bar of their own for the year,
  final-year classes excepted. Within one school the head sees the same on
  Promotion → Progression, and the API answers it at
  `GET /api/promotion/progression?year=…` (`year.classes[id].confirmed`).
- **Expected:** before a school's first promotion run, every class it lists
  has a confirmed bar, or the head has decided that the school's bar (or the
  pass mark) applies to it.
- **If it fails:** a class without a confirmed bar is judged against the
  school's bar, or the pass mark if none is set. Its old 0–100 value is
  never used. Ask the head to confirm a bar on Progression before generating
  the run.
- **From:** docs/39 §14 and §20.0 ("Agreed calculation", promotion bars).

---

## 8. Still open — decisions, not code

These have no owner in code. Each needs the project owner's decision; none
blocks this release.

- **The term and annual card and QR lifecycle:** when a term or annual card
  counts as issued, and what its QR page shows. The options are in docs/39
  §20.0 (defect-closure pass).
- **A bulk-decision control on the promotion screen**, now that pupils
  without a published annual result each need a decision (docs/39 Current
  status).
- **A retention rule for analysis run records:** records are kept
  indefinitely (docs/38 §10).
