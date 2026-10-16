# 41 — Detail check before release

A pass over the whole app on branch `academic-agreed-calculation`
(2026-10-16): speed, storage, English/French, the clients against the
backend, the mobile display (the message module first), and loose ends.
Ground rules as every pass: in-memory MongoDB and synthetic data only,
database URI and provider keys blanked, no calculation, engine, threshold,
version constant, published row or recorded decision changed.

Every fix has a test that failed before it and passes after, or, for text,
the exact before and after. The project owner's answers to §7 (same day)
are recorded there and closed the rows they cover in §6. Totals after
both passes: backend `check:all` 110 suites, 6,430 checks, 0 failed;
`check-revert-previous.js` 33 against each of `origin/master` and
`097de9c`; desktop 275, mobile 714, 0 failed; web build, lint, `i18n:check`
and `check:l10n` (89) pass. Nothing here ran on a device, in Electron or in
a browser: no browser is installed in this environment, and the phone app
has no component renderer (jest is not installed). Screen fixes were read in
code and are held by source checks (`mobile/scripts/check-screen-details.js`,
web `check:l10n`).

---

## 1. Speed

### Perf scripts against docs/37 and docs/38 §8

`perf:scale` and `perf:analysis`, synthetic school, this Codespace. At 5,000
pupils:

| Path | docs/37 (after) | Now | |
|---|---|---|---|
| POST exams/:id/process, whole school | 15.1 s, 16 queries, +405.5 MB | 11.1 s, 20 queries, +505 MB | faster; heap +25 % (CA context, policy) |
| POST term-results/compute, whole school | 7.68 s, 756 queries | 3.35 s, 881 queries | faster; +125 queries = one per class (the published-row check) |
| POST annual-results/compute, whole school | 7.31 s, 1,003 queries | 3.19 s, 1,128 queries | same: +1 query per class |
| sequence card HTML | 356 ms, 24 queries | 179 ms, 24 queries | — |
| term card | 1,898 ms, 19 queries, +274.7 MB | 1,285 ms, 20 queries, +282 MB | the heap per call was already this large |
| sync/pull (admin, full) | 337 ms | 337 ms | — |

| perf:analysis, 5,000 pupils | docs/38 §8 | Now |
|---|---|---|
| Cold run (worker) | 31.4 s | 33.3 s |
| Worst timer lag during the run | 289 ms | 297 ms |
| Server heap during the run | +130 MB | +130.8 MB |
| Warm p50 / summary p50 | 214 / 188 ms | 219 / 220 ms |

No regression beyond run-to-run noise.

### Queries per call on the paths this branch changed

A class of 5 against a class of 40 (`check:complexitycalc`, new):

| Path | Queries (5 / 40 pupils) |
|---|---|
| /process (processExam), one class | 11 / 11 |
| term compute, one class | 10 / 10 |
| sequence card payload | 12 / 12 |
| term card / annual card | 11 / 11 |
| promotion run (generateRun) | 10 / 10 |
| GET /promotion/progression?year | 8 / 8 |
| calculate & save (HTTP) | 20 / 20 |

All flat: no N+1. Ceilings are now held by `check:complexitycalc`
(check:complexity already held the annual compute). The dry run is per
exam and per class, not per pupil. Under the profiler (436 operations on
those paths) no query scanned a collection.

### Web bundle

`vite build`: 2.8 MB of assets. Largest chunks: `i18n` 498.6 kB (160.4 kB
gzip), `react` 255 kB (83 kB), `index` 110 kB, `student-strengths` 76 kB,
`SettingsPage` 76 kB. The `i18n` chunk holds **both** locale files (en
252 kB, fr 280 kB raw) and is preloaded on every page: a user reads one.
Loading the other language on demand would save about 80 kB gzip on first
load; not done (it changes how a language switch behaves).

### Mobile lists

The message lists are FlatLists. Not virtualised, or loading a whole list:
`admin/exams/index.js:274` loads page 1 only (limit 50) into a ScrollView,
so a school past 50 exams loses the older ones online; `admin/subjects`
renders every subject of every class (200–400 cards) in a ScrollView. Not
fixed (should fix).

## 2. Storage

### Indexes

Every query this branch added uses an index (profiler, above). The branch
added no index. No duplicate index on the collections it touched. Single-field
indexes that are a prefix of a compound one ({schoolId} on ResultSummary,
TermResult, AnnualResult, AcademicStructure, PromotionDecision, Exam,
StudentScore, ExamSubject, Class, ResultChangeLog; {examId} on several) are
older than this branch; dropping them needs a migration (nice to have).

### Growth per school per year

Measured document sizes (a class of 40, 12 subjects, 6 sequences, every
sequence card issued), times the perf school (5,000 pupils, 125 classes):

| Collection | Size each | Per year at 5,000 pupils | Bounded? |
|---|---|---|---|
| ResultSummary | 4.6 KB | 30,000 → ~139 MB | grows with pupils × years (history) |
| TermResult | 0.87 KB | 15,000 → ~13 MB | same |
| AnnualResult | 0.95 KB | 5,000 → ~5 MB | same |
| AcademicPolicySnapshot | 2.8 KB | one per distinct configuration (stored once by hash) | effectively bounded |
| ReportTemplateVersion | one per template or layout edit | small | grows with edits |
| GeneratedReport | 37.7 KB (frozen HTML + payload) | 30,000 → **~1.1 GB** if every sequence card is issued | **no limit** |
| DocumentVerification | 1.1 KB | 30,000 → ~32 MB | **no limit** |
| IntelligenceAnalysisRun | ~199 KB gzip report per run per scope (docs/38 §8) | one per scope per data change | **no limit** (retention rule is an open decision) |
| ResultChangeLog | one per manual change, lock or override (processing writes none) | small | **no limit** |
| AuditLog | one per audited admin action | small | **no limit** |

### Phone and desktop

- **Phone** (`mobile/src`). Admin: roster ~2 MB, whole-school attendance
  pulled 30 days at a time and never trimmed (~65–80 MB a year), ~8 MB
  per exam opened (never evicted). Teacher: the same attendance. Parent:
  under 100 KB, cleared on sign-out. SQLite is kept on sign-out (by design,
  docs/23). **Fixed:** the outbox kept every sent row for ever (now removed
  after a week by the drain), and a gate phone kept every scan (~400,000 a
  year at 1,200 pupils; synced scans of earlier days are now removed).
  **Answered (§7.5) and fixed:** synced attendance before the 30-day window
  is removed on each pull, and an exam's cached marks, results and cards
  go when it has not been opened for 60 days; nothing unsynced is removed.
- **Desktop mirror** (`desktop/src/main/db`): ~150 MB a year for an
  admin or a teacher (marks ~37 MB, results ~15–20 MB, attendance ~95 MB),
  kept on sign-out, no yearly archive; soft-deleted rows stay as tombstones.
  The outbox deletes sent rows.

## 3. English and French

All four checks pass (web `i18n:check`, `check:l10n`; mobile `check:i18n`,
`check:l10n`), and the locale files have the same keys. The gaps were
elsewhere.

- **Fixed:** web and mobile showed a server refusal in English, or axios's
  "Request failed with status code 409", for PUBLISHED_RESULTS and the other
  coded refusals; they are now said from the locale files. Notifications
  were always English (`notification/index.js` read the school's language
  from a path that does not exist). The verification page's titles and
  buttons were English only. Promotion basis "Below the class average"
  meant something else since the agreed calculation ("Below the class's
  promotion bar" / "Sous le seuil de passage de la classe"). The admin
  mark-entry screen lacked the absent/0 sentence the teacher's has. The
  promotion-exam hint still said sequences 5 and 6 can be configured. The
  French calculate & save texts were reworded; "Delivered" read "Envoyé"
  ("Distribué").
- **Mobile hard-coded text:** mobile had no check for text written outside
  t(). `check-hardcoded-strings.js` (new, in `npm run check`) fails on any
  new one; the 87 found today are listed in its baseline, to be translated
  and removed from it. Web: 92 found by the same scanner (its own
  `i18n:check` regexes miss them); the most visible are listed in §6.
- **Answered (§7.3) and fixed:** report cards followed the viewer's
  interface language on web, were always English from mobile, and English
  after any reissue; every card and reissue now prints in the school's
  language (`School.defaultLanguage`), set on the web settings screen. No
  class or section carries a language of its own in the data model, so
  none is used. **Not fixed:** the six emails are English only. About 476 English server messages remain
  (clients now translate the coded ones). The academic structure's seeded
  names ("1st Term", "Sequence 1") show in English in the French interface.

## 4. Clients against the backend

The calculation is right on every client: desktop defers to the server,
mobile sends an empty calculate body, the rules page is read-only. Nothing
on desktop still computes a raw mean, overwrites a published result or uses
the old promotion rule.

- **Fixed:** the 409 handling above; whole-school term and annual compute
  now say which classes were left because their results are published
  (`refusedClasses`), instead of only "computed"; the desktop's offline exam
  create and edit stored any term (a label, 4) where the server takes 1-3,
  and stored "1" as text.
- **Answered (§7.1) and closed:** the 409 said "unpublish them first", and
  no client could. There are now routes to unpublish a class's sequence,
  term and annual results with a reason (`POST /api/results/:examId/
  unpublish`, `/api/term-results/unpublish`, `/api/annual-results/
  unpublish`; `check:unpublish`), an Unpublish action on the web beside
  every Publish, and the mobile refusal says where to unpublish.
- **Not fixed:** the term and annual "Recompute" banner counts published
  stale rows too (needs the server to count unpublished ones); mobile
  calculate & save on a locked exam (423 REASON_REQUIRED) does not ask for a
  reason. The structure screen's two inert fields are gone (§7.4).

## 5. Mobile display; the message module

**The message module** is "messaging": direct, class, subject and group
conversations with read receipts. Staff and pupils use `app/messages/`
(list, thread, new); messages are stored in local SQLite and sent through
the shared outbox (`mutationQueue.service.js`) with the client's id, so a
replay is recognised by the server. Guardians use `app/portal/messages/`
through `portal.service.js`, with no outbox: a failed send is reported and
the text kept. Server: `routes/messages.routes.js`, `portal.routes.js`,
`services/communication/`. Web: `pages/messages/`. Announcements are a
separate module.

| What | Status |
|---|---|
| Unread badge on the staff/pupil list always 0 (the list sent no `lastMessageSeq`) | fixed (server) |
| A refused message showed "queued" for ever; "pull to retry" with no retry | fixed: shown failed, tap to retry |
| Composer offered on read-only conversations (server refuses: 403) | fixed |
| No safe-area insets on the six message screens (header under the status bar, send button under the navigation bar) | fixed; to confirm on a device |
| Times in the phone's language, not the app's (mobile and web) | fixed |
| List not reloaded on return from a thread | fixed |
| Guardian send had no client id: a timed-out send retried posts twice | fixed |
| Guardian thread kept an old load error after later loads succeeded | fixed |
| Portal's six tabs wrap mid-word at 360 px; notice header overflows | fixed |
| Web messages unusable at 360 px (288 px list beside the thread) | fixed: list and thread in turn below md |
| Thread sync fetches only the newest 50: more than 50 while offline leaves a silent gap | not fixed (should fix) |
| Ordering across a failure (a later message can overtake one retried) | not fixed (nice to have) |
| KeyboardAvoidingView `padding` on Android | to verify on a device |
| No day separators; header says "Conversation" | design |

Queued messages: sent once (client id plus Idempotency-Key), oldest first,
shown pending until the server confirms. Empty, loading and offline states
exist in both languages.

On this branch's own screen (pupil result): the read-only coefficient box
(52 px) overlapped the next column at 360 px, and decimals printed "12.50"
in French. Fixed.

Rendered: nothing. Read in code: everything above.

## 6. Every finding

Severity: **B** blocks release, **S** should fix, **N** nice to have.

| Area | What | Where | Sev | Fixed | Test / before→after |
|---|---|---|---|---|---|
| Analysis | The code digest throws in the Docker image (the image has no `backend/` folder), so every analysis run fails in production | `backend/src/services/intelligence/analysisCode.js:38-44,101` | B | yes | check:analysis: the image's layout and the root `/` (old: throws ENOENT) |
| Clients | "Unpublish first" cannot be done from any client; no term/annual unpublish route | `examProcess.service.js:144`; `termResults.routes.js`; `annualResults.routes.js` | B | yes (§7.1) | `check:unpublish` (end to end); check-revert-previous Q |
| Mobile | No safe-area insets on the message screens | `app/messages/*`, `app/portal/messages/*` | B | yes | check-screen-details (old: 0/13) |
| Web | Messages unusable at 360 px | `web/src/pages/messages/index.tsx:330-333` | B | yes | web check:l10n (old: fails) |
| Messaging | Unread badge always 0 | `backend/src/routes/messages.routes.js:211-224` | S | yes | check:schoolctx (old: `[null,2]`) |
| Messaging | Failed message "queued" for ever; no retry | `mutationQueue.service.js`, `message.service.js`, `app/messages/[id].js` | S | yes | check:outbox H (old: crashes) |
| Messaging | Composer on read-only threads | `app/messages/[id].js` | S | yes | check-screen-details |
| Messaging | Guardian double post on retry | `app/portal/messages/[id].js`, `portal.service.js` | S | yes | check-screen-details |
| Mobile | `outboxRowsForTable` SQL compared with a column `synced`: queued marks never shown | `mutationQueue.service.js:315` | S | yes | check:outbox (old: `[]`) |
| Mobile | Outbox keeps sent rows for ever | `mutationQueue.service.js` drain | S | yes | check:outbox |
| Mobile | Gate phone keeps every scan | `gate.service.js` | S | yes | check:outbox |
| l10n | Notifications always English | `backend/src/services/notification/index.js:154` | S | yes | check:portalnotices (old: fails) |
| l10n | Server refusals shown in English / axios text (web, mobile) | `web/src/hooks/useExamResults.ts`, `web/src/lib/axios.ts`, `mobile/src/utils/appError.js` | S | yes | web/mobile check:l10n |
| l10n | Promotion basis "Below the class average" wrong since the agreed calculation | locales `promo.basis_average_fail` | S | yes | "Below the class average" → "Below the class's promotion bar"; FR "Sous la moyenne de la classe" → "Sous le seuil de passage de la classe" |
| l10n | Admin mark entry lacks the absent/0 sentence | mobile `marksEntry.unenteredBody` | S | yes | adds "Absent leaves the subject out of the pupil's average; 0 counts as a mark." / "Absent retire la matière de la moyenne de l'élève ; 0 compte comme une note." |
| l10n | Stale promotion-exam hint | web `examCreate.promoSequenceHint` | S | yes | "* Sequences 5 and 6 can be configured as promotion exams" → "* marks this year's promotion exams, set in the academic structure. They do not decide promotion." (FR likewise) |
| l10n | Verification page titles and buttons English only | `backend/src/print/verifyPage.js` | S | yes | "Verify" → "Verify · Vérifier"; "Try again" → "Try again · Réessayer"; titles likewise (check:cards) |
| Mobile | Result screen: coefficient box overlaps; "12.50" in French | `app/admin/exams/results/[examId]/student/[studentId].js` | S | yes | check-screen-details |
| Mobile | Portal tabs wrap at 360 px; notice meta overflows | `app/portal/index.js` | S | yes | check-screen-details |
| Mobile/Web | Message times in the device's/browser's language | `app/messages/*`, `app/portal/messages/[id].js`, `web/src/pages/messages/index.tsx` | S | yes | source checks |
| Desktop | Offline exam create/edit took any term, stored "1" as text | `desktop/src/main/api/writes/exams.js` | S | yes | check:process-rules (old: 3 fail) |
| Web | Whole-school compute said "computed" when classes were refused | `web/src/hooks/useExamResults.ts` | S | yes | web check:l10n |
| Web | Saving bars left the settings screen's copy stale | `web/src/pages/promotion/progression.tsx:119` | S | yes | web check:l10n |
| Web | Stray "from it." after the reports blurb | `web/src/pages/reports/index.tsx:69` | S | yes | removed |
| Docs/code | Comments contradicting the code (rules "every rule at its default", annual "passes all terms + promotion exams", ranking's "own loop") | `AcademicStructure.js`, `annualGrading.service.js`, `shared/ranking.js` | S | yes | rewritten to the decided rule |
| l10n | French: "Envoyé" for delivered; "attachment" literal; hard-coded "participants" | mobile/web | N | yes | "Distribué"; keys |
| l10n | Report card language: viewer's UI language on web, English from mobile and after reissue | `web/src/pages/reports/cards.tsx:319`, `results.controller.js:1104` | S | yes (§7.3) | `check:unpublish` (cards and reissue in the school's language); `check:schoolctx` (the setting) |
| l10n | Emails English only | `backend/src/services/email.service.js` | S | no | large |
| l10n | Seeded structure names English in French UI | `AcademicStructure.js:65-82` | S | no | decision on how |
| l10n | 87 mobile / 92 web hard-coded strings | lists: mobile baseline; web (scanner) | S | partly | mobile check guards new ones |
| Clients | Recompute banner counts published stale rows | `resultStaleness.service.js:146` | S | no | needs a server count |
| Clients | Mobile calculate & save on a locked exam: no reason asked | `reportCardCalc.service.js`, `[studentId].js` | S | no | — |
| Clients | Inert structure fields offered and sent | `web/src/pages/settings/AcademicStructureSection.tsx:500-540` | S | yes (§7.4) | `check:agreedfollowup` (no copy onto annual rows); screen and payload changed |
| Messaging | Thread silently misses messages past 50 while offline | `message.service.js:270-276` | S | no | paging |
| Mobile | Exams list page 1 only | `app/admin/exams/index.js:274` | S | no | — |
| Speed | Both locales preloaded (160 kB gzip) | `web/src/i18n/index.ts` | N | no | lazy-load the other |
| Speed | +1 query per class in whole-school term/annual compute | `termGrading`, `annualGrading` | N | no | batch the published check |
| Storage | GeneratedReport, analysis runs, logs: no retention | models | N | no | decision |
| Storage | Phone attendance outside 30 days, exam caches: never trimmed | `attendance.service.js`, `examCache.service.js` | N | yes (§7.5) | mobile `check:outbox` |
| l10n | French card wording and terms (DIPLÔMÉ(E), ADMIS(E) SOUS CONDITION, Année scolaire, annuler la publication, Chef d'établissement) | `reportHtml.service.js` LABELS.fr; locales | S | yes (§7.2, §7.6) | `check:agreedfollowup`; locale before→after in docs/39 §20.0 |
| Hygiene | Dead code left behind (`promotionExamIds`, unused `rules`, unused exports in `shared/academicRules.js`, mobile `report.data.service.js` with no importer, web `getSequencesForTerm`, unused locale keys) | as listed | N | no | left: in calculation files |
| Hygiene | `console.log` on every process call | `examProcess.service.js:264` | N | no | as on master |

## 7. For the project owner — answered 2026-10-16

1. **Unpublish: yes.** Routes, with a required reason and school admin only,
   to unpublish a class's sequence results for one exam, its term results
   for one term, and its annual results for one year. Each writes an
   AuditLog row (counts before and after, the reason). Only isPublished
   and its date change; issued cards stay as issued, and the answer says
   so. A year is refused while a promotion run for it is draft or
   committed. Web: Unpublish beside every Publish; mobile: the refusal says
   where to unpublish; desktop: the server's. (`ResultChangeLog` is per exam
   — `examId` is required — so it records the sequence case; term and annual
   are in the AuditLog only, rather than extending its `entity`.)
2. **French card wording:** DIPLÔMÉ(E) with the circumflex; REDOUBLANT kept;
   ADMIS(E) SOUS CONDITION for a conditional promotion.
3. **Report cards print in the school's language** (School.defaultLanguage),
   whoever views them, on web, mobile and reissue; the setting is on the web
   school settings screen. No class or section language exists in the data
   model (Class.section is a free-text label), so none was added.
4. **Removed** annualAverageMethod and the structure-level promotion
   threshold from the structure screen and what it sends; annual rows no
   longer copy the structure threshold. Stored data untouched.
5. **Phone:** synced attendance older than the 30-day window is trimmed;
   exam caches not opened for 60 days are evicted; nothing unsynced is
   removed.
6. **French terms:** "Année scolaire" everywhere; "annuler la publication";
   "Chef d'établissement" where the card names the head.
