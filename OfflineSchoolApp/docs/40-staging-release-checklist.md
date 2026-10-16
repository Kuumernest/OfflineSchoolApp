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
browser or a device. Each step is something to do, not a result. Every step
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
- **Do:** agree, before deploying, how you would go back:
  - **Cold analysis:** revert the change and redeploy backend and web
    together. The previous code ignores the `intelligenceanalysisruns`
    collection, which can be left or dropped; no other collection changed.
    The four `ANALYSIS_*` variables are ignored (docs/38 §11, Rollback).
  - **Agreed calculation:** no rollback is written in docs/39. The developer
    must confirm it before the deploy. What is known from the code:
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
    - Restoring the 1.3 backup is the clean path if results were
      reprocessed.
- **Expected:** a written rollback decision, signed off by the developer.
- **If it fails:** do not deploy.
- **From:** docs/38 §10 item 7, §11; docs/39 §20.0 ("Agreed calculation").

**1.5 Release to one school first** — *operator, with that school's head*
- **Do:** release to one school for one week, with a database backup every
  day of that week. Then widen to the other schools, a few at a time.
- **Why:** the rollback of the agreed calculation, once a school has
  reprocessed its results, is a restore from backup (1.3, 1.4). Results
  recomputed after the release are stamped with the new calculation and the
  previous code does not read them the same way. One school first keeps a
  restore small, and a week shows the questions schools ask before everyone
  asks them.
- **Expected:** the first school's week ends with no failed analysis runs
  (7), no unexplained result changes against its dry run (1.7), and a daily
  backup for each day.
- **If it fails:** stop widening. Restore that school's backup if its
  results must go back (1.4), and give the developer the dry-run report and
  what differed.
- **From:** docs/39 §20.0 ("Agreed calculation": effective for every
  unpublished result); this checklist, 1.3 and 1.4.

**1.6 Ship backend and web together; plan desktop and mobile** — *operator*
- **Do:** deploy the backend and the web console from one build of this
  branch. They ship in one image here; keep it that way.
- **Desktop and mobile:**
  - Release new desktop and mobile builds from the same branch.
  - An older mobile app still works against the new server, but its
    "Calculate & save" screen shows editable fields the server now ignores.
  - An older desktop computes a provisional figure offline that the server
    replaces on sync, or refuses (409) if the class has a published result.
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

**1.7 Dry run, per school** — *operator runs it; school head reviews it*
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
    what.

  `--salt` makes the pupil ids reproducible, so the operator can match them
  privately if the head asks.
- **Expected:** the school head reads the report and accepts the changes
  before the release reaches the school. Large changes are expected where
  CA or coefficients were not counted before.
- **If it fails:** the script stops with a message (no school, no year,
  cannot connect), and nothing is written. If the head does not accept the
  changes, hold the release for that school and give the report to the
  developer.
- **From:** docs/39 Current status and §20.0 ("Agreed calculation").

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
| 3.6 | Settings → Academic structure | school head | Under the promotion threshold: "Not used to decide promotion. Promotion uses the annual average and the class bar." The same text appears as the tooltip of each sequence's "Promo" toggle, in English and French. | docs/39 §20.0 ("Follow-up") |
| 3.7 | An annual report card printed in French, for a final-year pupil and for a pupil who repeats | school head | The council's decision prints in French: DIPLOMÉ(E) for the final-year pupil, REDOUBLANT for the repeat, ADMIS(E) EN … for a promotion. The English card says GRADUATED for the final-year pupil. Average, grade and rank are as before. | docs/39 §20.0 ("Follow-up") |
| 3.8 | Mark entry: web exam marks page; mobile teacher marks screen | teacher | Web: the "A" toggle's tooltip says absent leaves the subject out of the average and 0 counts; saving with a blank mark is blocked with the same explanation. Mobile: the blank-mark message says the same. In English and French. | docs/39 §20.0 ("Agreed calculation") |
| 3.9 | Mobile: admin pupil result → Calculate & Generate Report Card | school head | Nothing on the screen is editable. Pressing the button first asks to confirm that the whole class is recalculated from the stored marks, and that it is refused if any result in the class is published. With a published result in the class, the refusal says so. | docs/39 §20.0 ("Mobile Calculate & save screen") |
| 3.10 | Mobile: create and edit an exam | school head | The term picker offers the school's own terms by name (for example two semesters). Offline it offers the last terms it saw, and the three fixed terms if it never saw any. | docs/39 §20.0 (validation and defect-closure passes) |

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

  Whether the closed pilot's reviews count toward the new one was not
  checked; ask the developer before closing.
- **If it fails:** a drifted pilot cannot be closed. Escalate.
- **From:** docs/39 §20.0 ("Agreed calculation", the version bump).

---

## 6. Tell the schools — *school head, with the operator*

Send before the release reaches the school. English and French.

**English**

> From [release date], results are calculated the same way in every school.
> - Each sequence average is out of 20 and uses subject coefficients. Your
>   continuous assessment (CA) is included if your school uses CA.
> - A subject marked absent or exempt, or with no exam mark, is left out of
>   the average. A mark of 0 counts as 0.
> - Results that are not yet published for this year will change when you
>   process them again. Published results do not change.
> - To reprocess a term or a year that is already published, unpublish it
>   first.
> - A sequence calculated before this change keeps its old figure inside a
>   new term: converted to /20, but still without CA or coefficients.
> - On annual report cards, pupils in a final-year class show "Graduated"
>   (DIPLOMÉ(E) on French cards).
> - Promotion bars are now set for each year, out of 20, on Promotion →
>   Progression. Please confirm a bar for each class. Old bars (0–100) are
>   shown there but are not used.
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
> - Pour retraiter un trimestre ou une année déjà publiés, dépubliez-les
>   d'abord.
> - Une séquence calculée avant ce changement garde son ancienne note dans
>   un nouveau trimestre : convertie sur 20, mais toujours sans CC ni
>   coefficients.
> - Sur les bulletins annuels, les élèves d'une classe terminale sont
>   indiqués « DIPLOMÉ(E) » (« Graduated » sur les bulletins en anglais).
> - Les seuils de passage se fixent désormais par année, sur 20, dans
>   Promotion → Progression. Merci de confirmer un seuil pour chaque classe.
>   Les anciens seuils (0–100) y sont affichés mais ne sont pas utilisés.
> - La première revue Intelligence après le changement peut prendre quelques
>   minutes à se préparer.

- **Expected:** every school has the message before its first
  reprocessing.
- **If it fails:** hold the release for that school.
- **From:** docs/39 Current status, §21.1; docs/38 §10.

---

## 7. After release, for the first week — *operator, daily*

| Watch | Where | Act when |
|---|---|---|
| Analysis runs failing or timing out | run records (`intelligenceanalysisruns`, `status: "failed"`, `error.code` one of `WORKER_OUT_OF_MEMORY`, `TIMEOUT`, `ENGINE_ERROR`, `WORKER_EXITED`, `LOAD_ERROR`, `STORE_ERROR`, `REPORT_TOO_LARGE`, `INTERRUPTED`) | any `WORKER_OUT_OF_MEMORY` or `TIMEOUT`: revisit 1.1; any `ENGINE_ERROR`, `WORKER_EXITED`, `LOAD_ERROR` or `STORE_ERROR`: escalate to the developer; `INTERRUPTED` after a restart is expected (4) |
| Worker memory | host memory during runs (`docker stats`) | memory near the host's limit: lower `ANALYSIS_CONCURRENCY` |
| 409 `PUBLISHED_RESULTS` volume | backend access log (morgan, `combined` in production): 409 answers to `/process`, `/term-results/compute`, `/annual-results/compute` and `/reportcard/calculate` | many from one school: that school needs the "unpublish first" step explained (6) |
| Support questions about promotion bars | support channel | the same question twice: add it to the message in 6 |

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
