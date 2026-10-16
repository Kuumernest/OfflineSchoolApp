# 40 — Launch checklist

For whoever deploys and accepts the platform's first launch, on **Sunday 1
November 2026**, from branch `academic-agreed-calculation`.

**This is a first launch, not a migration** (confirmed by the project
owner, 2026-10-16). No school uses the platform yet, so no school has
results under the previous code: the agreed calculation
([docs/39](39-academic-architecture-audit.md) §21.1) is simply the
platform's calculation from the first day, and the cold analysis
([docs/38](38-cold-intelligence-analysis.md)) its analysis. The steps a
migration of live schools would need (a revert-plus-cleanup rollback, a dry
run per school, days without publishing, warnings about old app builds,
re-baselining pilots) are marked **not needed for this launch** below, with
when they would apply: a later change to the calculation once schools are
live. Their tools stay in `backend/scripts/` and their history in docs/39
§20.0.

Nothing below has been done on a real server, a browser or a device. Tests
at this version (2026-10-16, database URI and provider keys blanked):
backend `check:all`, every suite one by one, 115 suites, 6,490 checks, 0
failed; `check-revert-previous.js` 41 passed against each of
`origin/master` and `097de9c`; desktop 275 and mobile 721 passed, 0 failed;
web build, lint, `i18n:check` and `check:l10n` pass. The detail check
before release, and what it left open, is [docs/41](41-detail-check.md).
Each step is something to do, not a result. Every step has an owner:

- **Operator:** runs the servers and the database.
- **School head:** a first school's head, accepting the platform for it.
- **Teacher:** checks the screens they use.
- **Developer:** answers anything that fails.
- **Project owner:** decides what this checklist leaves to a decision.

---

## 0. Launch readiness

In the order to do them; 0.20 is on the day.

**0.1 Merge and tag the release** — *developer, with the project owner*
- **Do:** merge pull request #3 into `master`; tag the merge commit (for
  example `v1.0.0`) and push the tag.
- **Expected:** one tag, on `master`, naming the commit every build comes
  from.
- **If it fails:** do not build from a branch or an untagged commit.

**0.2 Build every app from the tag** — *developer*
- **Do:** build the backend and web image, the desktop installer and the
  mobile apps from the tag's commit, and note its short hash in each build's
  release notes.
- **Expected:** four builds, all from the same commit.
- **If it fails:** rebuild from the tag; never mix builds from different
  commits (1.7).

**0.3 Confirm which database is production** — *operator, with the project owner*
- **Do:** name the production MongoDB (host, database name, user), distinct
  from staging and from development. The development `.env` points at a
  demo database (`school_db`, one demo school); that is not production.
- **Expected:** the production URI written down where the operator keeps
  secrets, and used only by the production stack.
- **If it fails:** stop: a stack pointed at the wrong database writes
  there.

**0.4 Production data before the first school joins** — *project owner, then operator*
- **Do:** decide whether production starts empty or keeps the demo school,
  then wipe or keep it accordingly.
- **Expected:** the decision written down, and production matching it.
- **If it fails:** a demo school left by accident shows in the super
  admin's list and in every cross-school report.

**0.5 Production settings** — *operator*
- **Do:** set and check:
  - secrets: `JWT_SECRET` and `JWT_REFRESH_SECRET` (32+ characters, new
    for production, not the staging ones), the Brevo, Sentry and AI keys;
  - `MONGODB_URI` (0.3);
  - `ALLOWED_ORIGINS` (CORS): exactly the production web address(es);
  - `ANALYSIS_*` values (1.1);
  - `DOMAIN`, the name the certificate is for, pointing at the server. The
    stack starts without a certificate (port 80 only); issue the first one
    once through the webroot (docs/17, TLS), and nginx turns HTTPS on
    within a minute (`[tls] certificate found … HTTPS on` in its log). Then
    check the expiry (more than a month ahead; the `certbot` service renews
    it);
  - free disk space on the host, for the database, the uploads volume and
    the logs.
- **Expected:** each value set, checked by a second person, none copied
  from staging.
- **If it fails:** the backend refuses to start on a short or placeholder
  `JWT_SECRET`; a wrong `ALLOWED_ORIGINS` makes the web console fail every
  request. Fix and restart.

**0.6 Backups, and one full restore** — *operator*
- **Do:** back up the database **and** the uploads volume (`uploads_data`:
  logos, photos, attachments) on a schedule, daily, as normal operations;
  copy each backup off the server. Then restore one backup of both to a
  scratch instance and time it.
- **Expected:** a schedule, backups landing off the server, and a restore
  that brings back the data and the images, with its duration written
  down.
- **If it fails:** without a tested restore there is no rollback for data;
  do not launch.

**0.7 Security** — *operator, with the developer*
- **Do:** check:
  - MongoDB is not reachable from the internet (the compose file publishes
    no port for it);
  - only 80 and 443 are open. **Automatic:** the stack publishes only those
    two (the backend's 5000 is not published; nginx serves HTTPS on 443,
    port 80 redirecting; `check:deployconfig`). **Still checked:** the host
    firewall agrees, from outside: `nc -z <server> 5000` and `27017` refuse;
  - no seed or test accounts with known passwords. **Automatic:**
    `scripts/seed-form1-students.js` (the one script that creates accounts
    with a known password, "student123") refuses to run when `NODE_ENV` is
    production or the database is not local or named as a test one, unless
    `--i-know` is passed (`check:seedguard`). **Still checked:** no such
    account exists in production;
  - a strong super admin password, not shared;
  - no secrets in the repository (`.env` files are not committed);
  - `npm audit` in backend, web, mobile and desktop: no high or critical
    findings;
  - the logs contain no passwords or tokens. The `console.log` in
    `examProcess.service.js` prints only a count ("Results processed: N
    students").
- **Expected:** every point checked and written down.
- **If it fails:** fix before launch; a high or critical audit finding goes
  to the developer.

**0.8 Live services, with production keys on staging** — *operator*
- **Do:** send one real email (Brevo), and make one call to the AI feature
  the app uses (the advanced intelligence, `ADVANCED_INTELLIGENCE_PROVIDER`,
  Anthropic). Check the email sender domain (SPF, DKIM) and that the
  message does not land in spam. SMS: the code has no SMS channel (it sends
  email, and has a WhatsApp channel that docs/19 D6 records as unproven), so
  there is no SMS to send; if SMS is expected, it is a decision and new
  work.
- **Expected:** the email arrives in the inbox, not spam; the AI call
  answers.
- **If it fails:** fix the sender domain or the key before launch.

**0.9 Monitoring** — *operator*
- **Automatic:** every service's Docker logs are capped (json-file, 10 MB ×
  5 files; `check:deployconfig`).
- **Do:** an outside health check on `https://$DOMAIN/api/health` that
  alerts the operator; disk-space alerts on the host.
- **Expected:** an alert reaches the operator when the health check fails
  (test it by stopping the backend once).
- **If it fails:** without the check nobody knows the site is down.

**0.10 Restarts after a reboot** — *operator*
- **Do:** every service has `restart: unless-stopped` (`docker-compose.yml`
  lines 7, 30, 62) and Docker starts at boot; reboot the server once.
- **Expected:** after the reboot, 2.3 answers 200 without anyone touching
  it.
- **If it fails:** enable Docker at boot and check the restart policy.

**0.11 Time zone** — *operator, with each school's head*
- **Automatic:** a new school's time zone defaults to `Africa/Douala`
  (`School.settings.timezone`), and the backend and nginx run with
  `TZ=Africa/Douala` (`check:timezone`, `check:deployconfig`): a date
  printed at 23:30 UTC falls on the Cameroon day.
- **Still checked:** a school created before this default keeps what it
  stored (the old default was "UTC"); check each one's time zone in its
  settings. The host's own clock is the operator's choice.
- **Expected:** printed dates and times (cards, receipts, registers) are
  Cameroon time.
- **If it fails:** a date printed near midnight falls on the wrong day.

**0.12 Slow connections** — *teacher, school head*
- **Do:** use the web console and the mobile app on a slow mobile
  connection (or throttled to 3G): sign in, open a class, enter marks,
  print a card.
- **Expected:** every screen works, slowly; nothing times out silently;
  the phone keeps marks offline and sends them later.
- **If it fails:** note the screen and give it to the developer.

**0.13 A full school year on staging** — *school head and a teacher, with the operator*
- **Do:** on web and on mobile, in English and again in French, as a real
  school would:
  1. create a school, its admin, classes, subjects and pupils;
  2. an exam with continuous assessment (CA); enter marks, process,
     publish, print the sequence cards;
  3. compute and publish the term results and print their cards; the same
     for the year;
  4. set the promotion bars on Promotion → Progression and run promotion;
  5. print the ID cards.
- **Expected:** every step works on both clients and in both languages;
  every printed document reads correctly (§3 lists what each should show).
- **If it fails:** note the step, the client and the language; do not
  launch with a broken step.

**0.14 App stores** — *project owner, with the developer*
- **Do:** a privacy policy URL; the Play Console data-safety form; Apple's
  privacy labels and its account-deletion requirement. The app holds
  children's data (names, photos, marks, attendance, guardians' phones):
  check Cameroon's personal data protection law, with advice, before
  launch.
- **Expected:** both store listings complete; the legal check done and
  written down.
- **If it fails:** a store rejects the build; resubmit once fixed.

**0.15 Mobile builds submitted early** — *developer*
- **Do:** submit the mobile builds to both stores well before 1 November,
  built with the production `EXPO_PUBLIC_API_URL`, `https://<DOMAIN>/api`
  (the server address is fixed at build time,
  `mobile/src/services/api.js:46`).
- **Expected:** both builds approved before launch day.
- **If it fails:** schools use the web console until the store approves.

**0.16 Desktop build signed** — *developer*
- **Do:** sign the desktop installer (Windows code signing; macOS
  notarisation if offered).
- **Expected:** it installs without an "unknown publisher" warning.
- **If it fails:** schools see a warning, or their antivirus blocks it.

**0.17 A named support contact** — *project owner*
- **Do:** name the person and the channel schools reach for help, and put
  them in the welcome note (§6).
- **Expected:** a name, a phone or WhatsApp number, and hours.
- **If it fails:** do not send the welcome note without it.

**0.18 First run, against production** — *operator, with a teacher*
- **Do:** a fresh desktop install's first full sync, and a fresh phone's
  first sign-in, against production.
- **Expected:** both complete; the desktop shows the school's data; the
  phone signs in and loads its classes.
- **If it fails:** note how long it ran and where it stopped; give it to
  the developer.

**0.19 Every index verified at boot** — *operator*
- **Automatic:** at boot the backend checks every index the models declare
  against the database and logs one line per missing index
  (`[indexes] missing on <collection>: { … }`), then
  `[indexes] Indexes verified: N, missing: M` (`check:indexboot`). It
  never stops the server.
- **Do:** read that summary line in the production boot log.
- **Expected:** `missing: 0`.
- **If it fails:** each missing index has its own line; create it (or give
  the line to the developer) before launch.

**0.20 On the day: re-run 2.2, 2.3 and 2.5 against production** — *operator*
- **Do:** after the production deploy, run 2.2 (the boot line), 2.3
  (health through nginx) and 2.5 (one analysis, end to end) against
  production.
- **Expected:** all three as on staging.
- **If it fails:** roll back (1.4) and tell the first schools.

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

**1.3 Back up before the deploy** — *operator*
- **Do:** take a backup of the database and the uploads volume immediately
  before the deploy, on top of the daily backups (0.6).
- **Expected:** a restorable backup, dated.
- **If it fails:** do not deploy.

**1.4 Rollback for this launch** — *operator, with the developer*
- **Do:** this is the first launch: no school data depends on the old
  code. The rollback is to redeploy the previous image (the last build
  known to work), or to fix forward with the developer.
- **Expected:** the previous image's tag known, and the operator able to
  redeploy it in minutes.
- **If it fails:** fix forward with the developer.
- **Not needed for this launch:** the revert-plus-cleanup rollback (record
  a manifest, unpublish with the new routes, revert, cleanup, reprocess,
  publish, reissue) and its daily manifest. It applies to a later change to
  the calculation once schools are live; the tools are
  `scripts/revert-cleanup-agreed-calc.js` and `scripts/check-revert-previous.js`,
  and the decision and its order are in docs/39 §20.0.

**1.5 Dry run per school** — **not needed for this launch**
- No school has results to compare. It applies to a later change to the
  calculation once schools are live: `scripts/dry-run-agreed-calc.js`
  copies one school into memory, reprocesses it with the new code and
  reports what would change, without writing to the source (`check:dryrun`).

**1.6 One server for every school** — *operator*
- **Do:** one backend and one database serve every school (docs/39
  §20.0): there is no switch per school, and none is to be added without
  the project owner. Keep daily backups as normal operations (0.6).
- **Not needed for this launch:** days without publishing and the daily
  manifest, which keep a revert-plus-cleanup rollback possible for live
  schools (1.4).

**1.7 Ship backend and web together; build desktop and mobile from the same tag** — *operator, developer*
- **Do:** deploy the backend and the web console from one build of the tag
  (0.2); they ship in one image here; keep it that way. Desktop and mobile
  are built from the same tag.
- **Expected:** one backend and web version live; desktop and mobile
  builds from the same commit.
- **If it fails:** a web build older than the backend reads the analysis's
  202 answer as a report (the review page breaks until the run completes,
  from reading that code). Redeploy them together.
- **Not needed for this launch:** the warnings about older desktop and
  mobile builds running against a newer server. No school has an older
  build; they apply when a later release reaches schools that have not
  updated (neither app can be forced to a minimum version).

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
- **Do:** `GET https://$DOMAIN/api/health` through nginx (the backend's
  port is not published); and `http://$DOMAIN/` answers 301 to `https://`.
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
| 3.18 | An exam sat by two classes, both published; unpublish one | school head | The exam is no longer shown as published, so Publish is offered again (and publishes the class back). Unpublish is still offered for the class whose results are out. | docs/41 §6 (exam state) |
| 3.19 | Mobile admin exams list, in a school with more than 50 exams | school head | Every exam is listed, the older ones included, and the list scrolls smoothly. | docs/41 §6 |
| 3.20 | Mobile thread after the phone was offline while more than 50 messages arrived | teacher | Every message is there in order, none missing between the newest and the ones seen before going offline. | docs/41 §6 |
| 3.21 | A new year's academic structure, for a school whose language is French | school head | Its terms and sequences are named "1er trimestre", "Séquence 1" and so on; an existing year keeps its names. | docs/41 §6 |
| 3.22 | Pupil ID cards for a class, printed from the web console and from the mobile app, for a school set to English and again set to French | school head | The head's signature space is clean (no placeholder text) for a signature and the school's stamp, with the head's title ("Principal" / "Chef d'établissement") as the label under the line. The card shows the school's name, logo, address and phone; the pupil's photo (or the framed "affix photo" blank), full name, matricule, class, sex and date of birth; the academic year and "valid until"; an emergency contact (guardian's name and phone); the gate QR. Labels are in the school's language whoever prints it. A long name and a long French label stay on the card (no text cut off at the edge or overlapping); no health information is printed. | docs/41 §6 |

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

## 5. Pilots — **not needed for this launch**

No pilot exists yet. Re-baselining pilots after an engine version change
(close the drifted pilot, open a new one; its reviews do not carry over)
applies when a later release changes an engine version while pilots are
open; the steps are in docs/39 §20.0 and docs/38.

---

## 6. Welcome note for the first schools — *project owner, with the support contact*

Send to each first school when its account is created. English and French.
Fill in the support contact (0.17).

**English**

> Welcome. A few things about how results work:
> - Each sequence average is out of 20 and uses your subjects'
>   coefficients. Continuous assessment (CA) is included if your school
>   uses CA.
> - A subject marked absent, or with no exam mark, is left out of the
>   average. A mark of 0 counts as 0.
> - Promotion bars are set for each year, out of 20, on Promotion →
>   Progression.
> - Report cards print in your school's language, set in Settings (school
>   details).
> - A published result is never recalculated. To correct one, unpublish
>   it first (Unpublish, with a reason), then calculate and publish again.
>   Cards already issued stay as issued; reissue them if they must change.
> - For help: [support contact].

**Français**

> Bienvenue. Quelques points sur les résultats :
> - Chaque moyenne de séquence est sur 20 et tient compte des coefficients
>   de vos matières. Le contrôle continu (CC) est inclus si votre école
>   l'utilise.
> - Une matière notée absente, ou sans note d'épreuve, est retirée de la
>   moyenne. Une note de 0 compte comme 0.
> - Les seuils de passage se fixent par année, sur 20, dans Promotion →
>   Progression.
> - Les bulletins sont imprimés dans la langue de votre établissement,
>   choisie dans Paramètres (informations de l'établissement).
> - Un résultat publié n'est jamais recalculé. Pour le corriger, annulez
>   d'abord sa publication (« Annuler la publication », avec une raison),
>   puis recalculez et publiez à nouveau. Les bulletins déjà délivrés
>   restent tels quels ; rééditez-les s'ils doivent changer.
> - Pour toute aide : [support contact].

- **Expected:** each first school has the note, with a real support
  contact, before its first marks are entered.

---

## 7. After launch, for the first week — *operator, daily*

| Watch | Where | Act when |
|---|---|---|
| Analysis runs failing or timing out | run records (`intelligenceanalysisruns`, `status: "failed"`, `error.code` one of `WORKER_OUT_OF_MEMORY`, `TIMEOUT`, `ENGINE_ERROR`, `WORKER_EXITED`, `LOAD_ERROR`, `STORE_ERROR`, `REPORT_TOO_LARGE`, `INTERRUPTED`) | any `WORKER_OUT_OF_MEMORY` or `TIMEOUT`: revisit 1.1; any `ENGINE_ERROR`, `WORKER_EXITED`, `LOAD_ERROR` or `STORE_ERROR`: escalate to the developer; `INTERRUPTED` after a restart is expected (4) |
| Worker memory | host memory during runs (`docker stats`) | memory near the host's limit: lower `ANALYSIS_CONCURRENCY` |
| Health check and disk | the monitoring of 0.9 | any alert: act on it the same day |
| Backups | the off-server copies of 0.6 | a day without a backup: take one now |
| Support questions | the support contact (0.17) | the same question twice: add it to the welcome note (6) |

**Not needed for this launch:** the daily manifest row and the 409
`PUBLISHED_RESULTS` volume row, which watch a revert-plus-cleanup rollback
and the "unpublish first" step for schools moving from the previous
calculation; they apply to a later calculation change once schools are
live.

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
