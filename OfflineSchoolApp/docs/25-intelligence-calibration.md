# 25 — Intelligence Calibration (Stage 7)

Stage 7 asks one question of the engine that Stages 2–6 built:

> Do the existing rules and thresholds say reasonable things when applied to
> real, anonymised histories from an actual school?

This document is the standing record for answering it. It contains the data
contract, the tooling, the baseline that must not move, and — in §6 — the
decisions, each of which is one of **KEEP**, **CHANGE** or
**INSUFFICIENT EVIDENCE**. It is written so that a second run, against a real
cohort, can be appended below without rewriting anything above.

---

## 1. Status of the evidence, stated first

**No real anonymised cohort was available in the development environment.**

The only student data reachable from this checkout is the live Atlas cluster
named in `backend/.env`, and the calibration tooling was deliberately not
pointed at it: a script in a development checkout has no business reading a
production school's marks, and the previous stage's brief said so in terms. The
`backend/backups/` directory holds report templates and exam coefficients only.

So this stage produced:

| Kind | What it is | What it proves |
|---|---|---|
| **Existing regression fixtures** | The 279 intelligence assertions from Stages 2–6, now 347 with this stage | That the engine does what its authors intended on constructed cases |
| **Synthetic test data** | `scripts/calibration/fixtures/synthetic-cohort.json`, 14 pupils, hand-built to hit every review category | That the calibration *tooling* works end to end |
| **Real cohort evidence** | — | **None yet.** |

Every threshold decision in §6 is therefore **INSUFFICIENT EVIDENCE → KEEP**,
and `ENGINE_VERSION` is unchanged at `1.0.0`. The distributions in the synthetic
report are not evidence about any child and the report's first line says so.

---

## 2. The data contract

`backend/scripts/calibration/cohortSchema.js` defines the file, validates it,
and turns it into the plain input `shared/intelligence` already accepts.

### What a cohort file contains

```
format, formatVersion, provenance { kind: synthetic | anonymised-real, note }
grading            { passMark, grades[] }          the school's GradingConfig, or null
academicStructure  { passMark }                    or null
exams[]            examId, type, academicYear, term, sequenceNumber, startDate, parentExamId
students[]         studentId, classId              optional; pupils with no results
results[]          resultId, studentId, classId, examId, isPublished, computedAt,
                   subjects[] { subjectId, subjectName, normalizedMark, score,
                                maxScore, coefficient, isAbsent, isExempt }
interventions[]    interventionId, studentId, subjectId, status, createdAt, startedAt
```

### The distinctions that must survive

Each is its own field, the validator refuses a file that omits any of them, and
the loader passes all of them through untouched so that what is measured is the
engine's treatment of them, not the export's:

| State | Encoding | Engine's treatment |
|---|---|---|
| genuine zero | `score: 0`, flags false | counted — the pupil earned it |
| unentered | `score: null`, flags false | not counted |
| absent | `isAbsent: true` | not counted |
| exempt | `isExempt: true` | not counted |
| continuous assessment | `exam.type: "ca"` | not an occasion of its own |
| unpublished | `isPublished: false` | never read |

`toEngineInput()` applies exactly one filter — published only — because that is
the one filter the production loader applies. Every other exclusion is left to
the engine.

### What a cohort file may never contain

Names, contacts, guardians, credentials, dates of birth, photos, money. The
validator does a deep key scan (`FORBIDDEN_KEYS`) and refuses the whole file on
the first hit. `subjectName` and `className` are permitted: a subject is not a
person, and a review sheet with subject codes on it is one a teacher cannot read.

### How identity is removed

`export-cohort.js` replaces every pupil, class, exam, result and intervention id
with an HMAC-SHA256 of the original under a salt that only the operator holds.
The same pupil gets the same opaque id everywhere in the file, so a history stays
a history; nobody without the salt can get back to the database. The exporter
runs its own output through the validator and refuses to write a file that
fails it.

### How it is validated

Structure, types, ranges, referential integrity (every result names an exam),
temporal ordering (a later sequence may not be dated before an earlier one),
duplicate evidence (one mark per pupil per subject per exam), and the forbidden
key scan. `check-calibration.js` feeds each of these a deliberately broken file
and asserts it is refused by name.

---

## 3. The tooling

```
backend/scripts/calibration/
├── cohortSchema.js      contract, validator, loader           pure
├── isolatedEngine.js    a private copy of the engine for what-ifs   pure
├── analyseCohort.js     distributions, flags, sensitivity, review cases   pure
├── run.js               CLI: cohort.json → report.json / report.md / review-cases.json
├── export-cohort.js     operator-run anonymising exporter (Mongoose; never run here)
└── fixtures/
    ├── synthetic-cohort.json        14 constructed pupils, clearly marked
    └── synthetic-regression.json    the engine's current answers on them
```

### The one rule of the analysis

It contains no intelligence rule. Every classification it reports came out of
`shared/intelligence`, and every number it reads is one the engine already put
in a profile. The check asserts this three ways: the tooling's require graph
reaches `shared/intelligence` and nothing in `backend/src`; its source contains
no threshold definition, no mark comparison and no confidence assignment; and
its profiles are byte-identical to a direct engine call on the same input.

### Sensitivity without touching production

Threshold sensitivity means running the *same* rules with a different number.
Poking the shared `THRESHOLDS` object would change production behaviour for
every module in the process; copying the rules into the script would be a second
implementation. `isolatedEngine.js` does neither: it evicts the engine's files
from Node's module cache, requires them again to get fresh module objects, and
puts the originals straight back. The isolated copy's thresholds can be moved
freely; the check asserts production is the same object with the same values
afterwards.

Each numeric threshold is moved by −2, −1, +1, +2 and the whole cohort re-run.
A classification that appears or disappears under any ±1 move is **borderline**.

### Review heuristics are not engine rules

`FLAG_LIMITS` names the shares above which the report raises a flag — "more than
40% of pupils with evidence carrying a risk insight is worth a look". They change
nothing. They are printed beside every flag so a reader can argue with them.

### Determinism

No clock, no randomness, no network, no environment variable. Every list is
sorted. Running the CLI twice on the same file writes byte-identical output,
which the check asserts and which is what lets two people diff two runs and see
only what changed in the engine or the data.

---

## 4. Running it

Against a real school, on a machine entitled to read its database:

```
MONGODB_URI=… SCHOOL_ID=… CALIBRATION_SALT=<≥16 chars, kept by the operator> \
  node scripts/calibration/export-cohort.js out/cohort.json

node scripts/calibration/run.js out/cohort.json --out out/analysis
```

`out/analysis/report.md` is for people; `report.json` is the whole analysis;
`review-cases.json` is the teacher sheet. Add `--emit-fixtures` to also write
`regression.json`, which — once teachers have reviewed the cases and the answers
are agreed — becomes the permanent fixture that holds future engines to them.

The runner needs Node and the cohort file. It does not need the backend, a
database, or a connection.

---

## 5. Baseline

Recorded before any calibration work, and re-run after it:

| | Before Stage 7 | After Stage 7 |
|---|---|---|
| Assertions | 2,888 | 2,956 |
| Failures | 0 | 0 |
| Check scripts executed | 30 | 31 |
| `check:all` | not run — SMTP/Brevo credentials absent | same |

The 68 new assertions are `check-calibration.js`. No existing assertion was
weakened, removed or changed. `ENGINE_VERSION` is `1.0.0` before and after.

---

## 6. Decisions

For each threshold: **KEEP**, **CHANGE**, or **INSUFFICIENT EVIDENCE**. A
distribution in a report is not by itself grounds to change a rule; the evidence
a change needs is teacher review of the cases the report selects, against real
histories. That evidence does not yet exist.

| Threshold | Current | Decision | Reason |
|---|---|---|---|
| `minObservations` | 2 | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `establishedObservations` | 3 | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `strongMark` (heuristic) | 14/20 | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `passMark` (default) | 10/20 | INSUFFICIENT EVIDENCE → KEEP | Read from the school's own config in practice |
| `declineDrop` | 2 marks | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `improvementGain` | 2 marks | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `suddenDrop` | 4 marks | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `consistencySpread` | 2 marks | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `moderateSpread` | 4 marks | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `minUnderperformanceObservations` | 3 | INSUFFICIENT EVIDENCE → KEEP | No real cohort |
| `crossSubjectStrengths` | 3 | INSUFFICIENT EVIDENCE → KEEP | No real cohort |

**Engine version: unchanged, `1.0.0`.** No rule changed, so no version changed.

### What the synthetic run shows, and does not

Run on the constructed cohort the report raises `POSSIBLE_OVER_TRIGGERING_RISK`
and `HIGHLY_BORDERLINE`. Neither means anything: the fixture was built to
contain one of every edge case in fourteen pupils, which is a distribution no
real class has. What the run does show is that the flags fire, the sensitivity
table populates, the borderline detector finds the case placed exactly on the
`declineDrop` line, every review category is covered, and the whole pipeline is
deterministic. That is what synthetic data is for.

### Things to watch for in a real run

Written down now so the first real report is read with them in mind:

1. **A cohort-wide fall between sequences** (a harder paper) will read as many
   individual declines. If `academic_decline` clusters on one sequence boundary
   across the class, the signal is the paper, not the pupils.
2. **`strongMark` versus where marks actually cluster.** A school whose marks
   rarely exceed 13 will show almost no strengths; that is a fact about the
   threshold's fit, not about the children.
3. **`awaiting_after` as the common outcome status** in a first year, by design.
4. **Two-mark claims.** If most insights are `emerging`, the cohort is telling
   you how little has been published, not how the rules perform.

---

## 7. Regression fixtures from real cases

None yet — there are no real cases. The mechanism exists: `run.js
--emit-fixtures` writes `regression.json` with each review case's current
classification, guidance and metrics, and `check-calibration.js` §7 holds the
engine to a fixture placed at `fixtures/synthetic-regression.json`. When a real
anonymised cohort has been reviewed, its `regression.json` is added beside it
under a real-provenance name, and the check is pointed at both. Provenance is
carried into every fixture so a synthetic one can never be mistaken for a real
one.

---

## 8. What Stage 7 did not do, on purpose

No new intelligence dimension, capability domain, career or orientation logic,
model, embedding, or guidance category. No threshold was moved. No connection
was made to the live database. The engine is exactly the engine Stage 6 shipped,
and it is now the engine a school can be asked to check.

---

## 9. Stage 7A — real-cohort run: BLOCKED ON OPERATOR INPUTS

### Run metadata

| | |
|---|---|
| Date | 2026-09-23 |
| Engine version | `1.0.0` (unchanged) |
| School / cohort scope | **none — no export was performed** |
| Cohort size | — |
| Data period | — |
| Published observations | — |

### Why no export was performed

`export-cohort.js` requires three inputs and refuses to start without them.
At the time of this run:

```
MONGODB_URI        present in backend/.env only — not in the process environment,
                   and the exporter deliberately does not read .env
SCHOOL_ID          absent everywhere
CALIBRATION_SALT   absent everywhere
```

The stage brief says to stop and report rather than supply these. That is also
the right call on its own merits. `SCHOOL_ID` is the authorisation decision —
choosing it from a development checkout would mean enumerating a production
database to pick a school. `CALIBRATION_SALT` is the anonymisation key; a salt
invented here would live in a transcript, and whoever held it could walk the
exported ids back to the pupils. Both belong to the school's operator, on a
machine they control.

**No connection to the live database was made.** Nothing was read, nothing was
written.

### What was done instead

The exporter had never executed — it was written for a database this checkout
must not touch. `check-calibration-export.js` now runs it as the operator
would, as a child process with the three variables set, against an in-memory
database seeded with two schools full of things that must not leave: names,
enrolment numbers, guardian phones, a fee balance, and an intervention note
naming a child. It proves, by watching rather than reading:

* it refuses to start with any input missing or a salt under 16 characters, and
  writes nothing;
* it exports **one** school — two pupils, three exams, five results — and none
  of the other school's;
* no name, enrolment number, phone, guardian, note, raw id, school id or school
  name survives; every pupil id is an opaque HMAC prefix; subject names are kept;
* the six semantic states arrive intact and are tallied separately by the
  analysis; the CA mark never becomes an occasion; the unpublished draft is
  exported *as* unpublished and the loader hands the engine only published rows;
* every collection is byte-identical before and after — read-only is now a
  proof, not a claim;
* the same salt gives the same file; a different salt gives different ids and
  the same marks; an unknown school gives an empty valid cohort, never another
  school's.

The teacher review form (§7 of the brief) now exists as the structured `review`
block on every case, with its allowed values published in `reviewForm` so the
sheet is self-describing, and a `selectedBecause` line so a reviewer knows what
to look at. `reviewFeedback.js` ingests a filled sheet and cross-tabulates
verdicts against codes and against the thresholds behind them, names patterns
only above three supporting cases, and **withholds shares below 30 reviewed
cases** — there is no accuracy score and no field called one.

### Threshold decisions

All eleven: **INSUFFICIENT EVIDENCE → KEEP.** No real cohort, no teacher
review. Table unchanged from §6.

### FLAG_LIMITS (Task 10)

**INSUFFICIENT EVIDENCE.** Left unchanged. The first real report will show
whether they prompt useful review or cry wolf; nothing said about them from
synthetic data would be worth writing down.

### Regression cases

None from real data. The mechanism is unchanged from §7 and the synthetic
fixture still holds.

### Baseline integrity (Task 11)

`ENGINE_VERSION` 1.0.0 before and after. `THRESHOLDS` unchanged. No file under
`shared/intelligence/`, `backend/src/`, `web/`, `mobile/` or `desktop/` was
modified in this stage. Production data was never reached.

### To perform the run

On a machine entitled to read the school's database, with a salt the operator
generates and keeps:

```
MONGODB_URI=… SCHOOL_ID=<one school> CALIBRATION_SALT=<≥16 chars> \
  node scripts/calibration/export-cohort.js out/cohort.json
node scripts/calibration/run.js out/cohort.json --out out/analysis
```

Hand `out/analysis/review-cases.json` to two teachers who know the children.
When it comes back filled in, `reviewFeedback.js` turns it into the evidence
§6's protocol needs. Append the result below this section; do not edit above it.

### Verification (Stage 7A)

| | |
|---|---|
| `check-calibration.js` | 68 assertions, 0 failures |
| `check-calibration-export.js` | 51 assertions, 0 failures — the exporter's first execution |
| 30-script regression baseline | 2,888 assertions, 0 failures, re-run after the last change to any code under test |
| `npm run check:intel` as wired | 7 scripts in sequence, 398 assertions, exit 0 |
| Total | **3,007 assertions, 0 failures, 32 scripts** |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |
| Engine | `ENGINE_VERSION` 1.0.0, every threshold unchanged |

### Final status

```
REAL-COHORT CALIBRATION: NOT PERFORMED — OPERATOR INPUTS ABSENT
CALIBRATION REQUIRES MORE DATA
EVIDENCE INSUFFICIENT FOR RULE CHANGES
ENGINE_VERSION: 1.0.0
```

### A note on how the exporter check had to be written

The first version of `check-calibration-export.js` drove the exporter with
`spawnSync`, and the export timed out selecting a server while a trivial child
connected fine. The cause took some finding and is worth recording:
`mongodb-memory-server` pipes `mongod`'s log to the parent process; loading the
backend's sixty models fires well over a hundred `createIndexes`, each logged;
a parent blocked in `spawnSync` cannot drain that pipe; `mongod` blocks on its
next log write; every child from then on times out, while the parent — which
drains its own pipe the moment it is unblocked — keeps working. The check now
drives the child with async `spawn`. The exporter itself was never at fault,
and the real run does not involve an in-memory server at all.

---

## 10. Stage 7B — real-cohort run: still blocked on the same inputs

Checked again on 2026-09-23: `SCHOOL_ID` and `CALIBRATION_SALT` are absent from
the environment and from `backend/.env`; `MONGODB_URI` is in `.env` only, which
the exporter deliberately does not read. The run stopped at the gate, as the
stage requires. No database connection was made; no substitute was manufactured.

What did change is that the calibration review surface now exists **inside the
application**, scoped by the same authorisation hierarchy as every other
intelligence read (see docs/24, "Visibility and authorisation"), and teacher
judgements are persisted, named, as `IntelligenceReview` records and
cross-tabulated by the same `reviewFeedback.js` the offline sheet uses. That
means the teacher-validation half of 7B no longer has to wait for the operator
export: a head teacher can open the school's review cases today and two
teachers can record independent judgements against live pupils. The operator
export remains the path for a cohort that must leave the building.

```
REAL-COHORT CALIBRATION: NOT PERFORMED — OPERATOR INPUTS ABSENT
CALIBRATION REQUIRES MORE DATA
ENGINE_VERSION: 1.0.0
```

---

## 11. Stage 7C — in-app teacher validation and evidence collection

Stage 7B left the operator export blocked and put the review surface inside the
application. Stage 7C makes that surface usable by a teacher with nothing but
the application, and makes what it collects fit to be read as evidence. The
engine, its thresholds, `FLAG_LIMITS` and `ENGINE_VERSION` were not touched;
`check-shared-intelligence.js` and the regression fixture hold the engine's
answers exactly where they were.

### What a teacher now does, and does not need a developer for

Sidebar → **Intelligence review** (`/intelligence-review`, teachers, heads and
the operator). The queue is the calibration sheet over live pupils the caller
may see, in priority order — borderline first, then the trend claims, then the
rest (`REVIEW_PRIORITY` in `analyseCohort.js`, a presentation order that changes
nothing the engine says). Opening a case shows three sections, always in the
same order and never blended:

1. **Observed evidence** — the published marks as `year Tn Sn: mark` strings and
   the figures computed from them (recent, earlier and overall averages, change,
   latest step, spread, consistency, marks below pass, marks at or above the
   strength threshold).
2. **System interpretation** — the codes with their confidence, the guidance the
   engine attached, and the thresholds behind them with their current values.
3. **Your review** — the one form contract from `REVIEW_FORM`, unchanged in its
   four questions and its temporal block, extended with an optional
   `dataQuality[]` list of codes (`missing_assessment`, `incorrect_result`,
   `unpublished_result`, `assessment_unusually_difficult`, `grading_change`,
   `student_absence`, `curriculum_change`, `insufficient_history`, `other`).
   There is no second schema: the offline sheet, the in-app form, the model and
   `reviewFeedback.validateReview` all read the same list.

Submit → `POST /api/insights/reviews`. The server verifies the case against
the engine before storing anything (`reviewCases.caseFor` analyses the pupil
alone; a review of a case the engine does not produce today is 404
`CASE_NOT_FOUND`), stores the **server's** classifications rather than the
request's, stamps `engineVersion` and `reviewedBy`, refuses a second review by
the same person on the same case (409 `DUPLICATE_REVIEW`, backed by a unique
index), and refuses a review made against another engine version (409
`STALE_ENGINE_VERSION`).

### Independence — the contamination rule

A teacher who has not answered a case sees how many colleagues have, and not
one word of what they said, nor who they were, nor whether they agreed. The
package is built for the viewer in `reviewCases.service.js`: the review list,
`agreement`, the school-wide agreement counts and the feedback tally are all
cut to what that viewer may see — a tally over one hidden review would be that
review with the shield taken off, so for a teacher the tally covers only cases
they have answered. After they submit, the other reviews appear, named. Heads
and the operator are not reviewers; they see everything from the start.
`check-review-workflow.js` §3 asserts the second teacher's whole response
carries neither the first teacher's reason text nor their name.

### Status, monitoring, aggregate

Every case carries `reviewStatus` — `UNREVIEWED`, `ONE_REVIEW`,
`MULTIPLE_REVIEWS` — with counts and, where visible, `agreement` on the one
question that matters most (`classificationAppropriate`): `AGREE` or `DIFFER`,
described and never scored. Two teachers agreeing that the engine was wrong is
agreement.

The head's page shows the school-wide block: cases, reviewed / unreviewed /
with several, reviewers, agree / differ, per category, how reviewers answered,
data problems cited, and any pattern above the support minimum — including the
new `DATA_QUALITY_OFTEN_CITED`, raised when at least three reviews and at least
half of them point at the data rather than the rule. Shares stay withheld below
thirty reviewed cases, as before. Nothing anywhere is called accuracy.

The operator sees the selected school exactly as its head does, and, gated on
`platform.dashboard`, `GET /api/super-admin/intelligence/calibration` — counts
per school from the persisted reviews alone: reviews, reviewers, engine
versions, outcomes, categories, data-quality citations, patterns. The engine is
not run there and no pupil row is loaded; the test asserts no pupil id, name or
mark appears in it.

### Audit trail and revision

A review keeps who, when, and the engine version it was made under. The author
— and only the author — may revise it (`PATCH /api/insights/reviews/:id`, 403
`NOT_AUTHOR` for everyone else including the head, 409 `VERSION_CONFLICT` on a
stale version). The replaced form is pushed onto `revisions[]` with
`replacedAt`; `revisedAt` is set; `engineVersion` and `reviewedBy` are not
touched. Evidence that can be silently rewritten is not evidence.

### Case identity

Case ids are now derived from what a case is about
(`category:studentId:subjectId`) rather than its position on the sheet, so a
new category cannot renumber a fixture. The regression fixture was re-keyed
accordingly — its 33 recorded answers are byte-identical and the check that
holds them still passes. A `cross_subject_strength` category joins the sheet
(student-scoped, the subjects named, no domain claimed) and the synthetic
cohort gained one pupil so that every category has a case; that pupil, like the
other fourteen, is not evidence about anything.

### Verification (Stage 7C)

| | |
|---|---|
| `check-review-workflow.js` (new) | 55 assertions, 0 failures — the workflow as two teachers, a head, a third teacher, the bursar and the operator |
| `check-intelligence-access.js` | 61 assertions (was 52), 0 failures — shield, revision rights, the cross-school aggregate |
| `check-calibration.js` | 68 assertions, 0 failures, against the re-keyed fixture and the 15-pupil cohort |
| `npm run check:intel` | 9 scripts, 514 assertions, 0 failures |
| `check:roles` (backend) | 94 assertions, 0 failures — no new permission key; `insights.review` reused |
| web | `tsc` clean, `eslint` 0 errors (one pre-existing warning in LoginPage), `vite build` ok, `i18n:check` 3,213 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| Engine | `ENGINE_VERSION` 1.0.0; every threshold and every flag limit unchanged |

Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials: **68 scripts, 4,310 assertions, 0 failures** (the nine intelligence scripts included). One script exited non-zero without a tally — `check-student-integrity.js`, a live-database maintenance report that connects to the configured Atlas cluster; it is not a regression test, is not in `check:all`, and stopped on connectivity before reaching any code. `check:all` itself remains unrun: SMTP/Brevo credentials absent, as before.

### Real teacher validation

No authorised school and no real reviewers were available in this environment.
No teacher response was manufactured; the answers in the test fixtures are
test inputs and are labelled as such in the script header. Nothing in this
stage produces evidence for or against any threshold.

```
REAL TEACHER VALIDATION: NOT PERFORMED
REASON: AUTHORIZED SCHOOL/REVIEWERS UNAVAILABLE
CALIBRATION REQUIRES MORE DATA
ENGINE_VERSION: 1.0.0
```

When a school and at least two reviewers are authorised: each reviewer opens
**Intelligence review**, works the queue top-down, and submits; the head reads
the school-wide block; the operator reads the per-school counts. Then apply §6
to what `reviewFeedback.js` reports — with the data-quality citations read
first, because a threshold is never the answer to a wrong mark.

---

## 12. Stage 7D — controlled pilot and validation readiness

Everything before this section built the machinery. This section is about
running it at a real school without a developer in the room, and about never
mistaking the machinery having run for the engine having been validated. The
engine, its thresholds, `FLAG_LIMITS`, the guidance, confidence and outcome
rules and `ENGINE_VERSION` are unchanged; nothing in this stage touches
`shared/intelligence/`.

### Four things that are not the same

| | What it is | What it proves |
|---|---|---|
| **Synthetic validation** | fixtures (`synthetic-cohort.json`, the check scripts' schools) through the tooling | the tooling works; nothing about a threshold |
| **Technical validation** | a developer or tester driving the live workflow — a pilot of kind `development` | the workflow is usable end to end; nothing about a threshold |
| **Real-cohort calibration** | an authorised school's exported cohort through the offline runner (§7–§9) | distributions, flags, sensitivity on real marks |
| **Real-teacher validation** | that school's own teachers reviewing live cases — a pilot of kind `real` | whether the engine's conclusions match what teachers see |

Only the last two are evidence. A report that aggregates reviews must say
which kind of pilot they came from; the pilot record exists so that it can.

### The pilot record

`IntelligencePilot` — one per open exercise per school, enforced by a partial
unique index on `isOpen` and by `pilot.service.createPilot`. It carries:

```
pilotRunId · schoolId · classIds (null = whole school) · kind · status
engineVersion (stamped by the server) · startedAt · endedAt · createdBy
transitions[] {from, to, at, by, note} · evidence (counts) · decision
```

It carries **no** salt, credential, export, pupil row, mark, result or review
document id, or reviewer's words. The evidence block is counts and code lists
taken by the server from the persisted reviews at the moment of a transition.
`check-pilot-readiness.js` §4 asserts all of this against the stored JSON with
`CALIBRATION_SALT` set in the environment. The scope fields are the tenancy
key and class ids the application already puts in every URL.

### State model

```
READY → ACTIVE → REVIEWING → ANALYSIS_READY → CALIBRATED
                                            → INSUFFICIENT_EVIDENCE
any → CLOSED (terminal)
```

No skipping, no going back. `pilot.service.transition` is the only writer of
`status`. Two moves have conditions:

- **→ ANALYSIS_READY** takes the evidence snapshot; refused (409
  `EVIDENCE_REQUIRED`) when no review exists in the scope.
- **→ CALIBRATED** requires a written decision (≥ 20 characters, outcome
  `KEEP` or `CALIBRATE`) **and** the snapshot to clear the minimum evidence
  gate; otherwise 409 `EVIDENCE_GATE` with each shortfall named — the response
  text says `CALIBRATION REQUIRES MORE DATA`. **→ INSUFFICIENT_EVIDENCE**
  requires the written decision only. Teachers having submitted reviews never,
  by itself, reaches CALIBRATED.

A `CALIBRATE` outcome is a recorded intention. The threshold change itself
remains the separate decision of §6, with its own evidence list and regression
coverage; the engine version on the pilot stays the one its reviews were of.

### Minimum evidence gate

Derived from minimums that already exist rather than invented: the feedback
tool withholds shares below `MIN_CASES_FOR_SHARE` and names no pattern below
`MIN_SUPPORT_FOR_PATTERN`; the brief requires two independent reviewers.

```
reviewers                 ≥ 2
casesReviewed             ≥ 30
casesWithMultipleReviews  ≥ 3
```

This is a floor for calling the exercise analysable, not a proof of anything.
Before declaring evidence sufficient the snapshot also has to be read, and it
records for that purpose: pupils reviewed, cases reviewed, independent
reviewers, cases with two or more reviews, categories represented, subjects
represented, temporal patterns represented, repeated disagreements by category,
data-quality citations, and how reviewers answered.

### Pilot checklist

**School authorisation**
- [ ] the school is explicitly selected (the head's own; the operator via `?schoolId`)
- [ ] the operator is authorised to access the school (the door middleware answers 404 `SCHOOL_NOT_FOUND` / 403 otherwise)
- [ ] the school knows it is participating and has agreed

**Data readiness**
- [ ] sufficient published results exist (`calibration-summary` → `evidence`; `studentsSufficient` is not a handful)
- [ ] more than one sequence/term exists where the categories need it (`declining`, `sudden_change`, `weak_but_improving` all need history)
- [ ] subjects have usable history (the review sheet's `coverage` shows every category with a case)
- [ ] the grading configuration is valid (`engine.passMark`/`strongMark`/`strongBand` on the class route read sensibly)
- [ ] attendance/result semantics are intact (absent = `isAbsent`, score `null`; genuine zero kept — Stage 2.1)

**Reviewer readiness**
- [ ] at least two teachers identified, each holding an assignment for the classes in scope
- [ ] each knows the pupils they will be asked about
- [ ] each has read the briefing on the review page (the system is being tested; it is not expected to be right)
- [ ] each will review independently — the shield enforces it; the briefing asks for it
- [ ] the head understands the review process and the state model

**Technical readiness**
- [ ] intelligence routes answer for the school (`/insights/class/:id`, `/insights/student/:id`)
- [ ] authorisation verified for the three roles (`check-intelligence-access.js`, and a manual check with real accounts)
- [ ] review queue available (`/insights/review-cases`)
- [ ] review submission available (`POST /insights/reviews`)
- [ ] review revision available (`PATCH /insights/reviews/:id`)
- [ ] calibration summary available (`/insights/calibration-summary`)
- [ ] audit trail available (`reviewedBy`, `reviewedAt`, `engineVersion`, `revisions[]` on each review; `transitions[]` on the pilot)
- [ ] live = offline for a sample of pupils (`/insights/student/:id/consistency`, or the button on any case)

### Workflow

1. The head opens **Intelligence review** → *Validation pilot* → opens a pilot of
   kind `real`, scoped to the classes the two reviewers teach. State READY.
2. Teachers are briefed (the page carries the briefing; the head moves the pilot to
   ACTIVE with a note).
3. Each teacher works the queue top-down. It is in `REVIEW_PRIORITY` order —
   borderline first, then the trend claims, then the rest — and the page offers
   no filter by category, so a reviewer cannot pick only the cases that look
   right. The head moves the pilot to REVIEWING once reviews are arriving.
4. The head reads *Evidence now* on the panel as the pilot runs. When the
   sample is worth reading, → ANALYSIS_READY; the snapshot is stored.
5. The head reads the school-wide block (how reviewers answered, data problems
   cited, repeated disagreements) and `reviewFeedback.js` through the summary,
   and records the decision: → CALIBRATED (gate met, KEEP/CALIBRATE) or
   → INSUFFICIENT_EVIDENCE. Then → CLOSED.
6. Evidence that must leave the school goes through the existing operator
   export (§7A); in-app validation uses the live path. Both end in
   `shared/intelligence`; the consistency check proves the road to it is the same.

### Reviewer responsibilities (the briefing on the page)

The system analyses academic evidence already on record; it does not diagnose
pupils, predict careers or replace the teacher's judgement; the teacher is
judging whether the detected pattern is reasonable for a pupil they know;
disagreement is valuable evidence; reviews are made independently and colleagues'
answers are hidden until one's own is submitted; where the problem is the data,
the data-quality codes are ticked; nobody has told the system it is expected to
be right.

### Data quality is recorded apart from disagreement

`dataQuality[]` codes on the form, tallied as `dataQualityCitations` and, above
the support minimum, the `DATA_QUALITY_OFTEN_CITED` pattern. A systemic data
problem (missing results, unpublished results, a grading mismatch, an unexpected
sequence structure) is a platform issue to be documented and fixed at source;
no threshold is moved to compensate for bad source data.

### Live = offline — and what the check found

`GET /api/insights/student/:id/consistency` runs one pupil through the live
loader and through `cohortFromDocuments → toEngineInput → runEngine`, and
diffs the two profiles and guidance lists path by path
(`scripts/calibration/consistency.js`). It normalises nothing. On its first run
it reported a real difference: the live path carries `isPassing` on every mark
(the engine copies it from the result row as evidence; it is an input to no
rule) and the cohort contract dropped it, so the offline profile showed
`null` where the live one showed a boolean. The fix is at the mapping —
`cohortFromDocuments` and `toEngineInput` now carry the field — and the engine
was not touched. That is exactly the class of difference §11 of the brief says
must be investigated rather than normalised away, and the mechanism now exists
to find the next one.

### Security and privacy

The pilot routes sit on the same hierarchy as every other intelligence read:
teachers read the lean pilot state for their school (that a pilot is on, its
kind and state); `insights.pilot` — office roles, not delegable — opens,
advances and concludes; the operator does so for the school selected with
`?schoolId` and nothing without a selection; the bursar reaches none of it.
The operator's cross-school figure now carries each school's open pilot kind
and state and how many it has closed — counts, no pupil. No endpoint added in
this stage bypasses the door middleware or the capability registry.

### Verification (Stage 7D)

| | |
|---|---|
| `check-pilot-readiness.js` (new) | 64 assertions, 0 failures — state machine, gate, record contents, authorisation, independence inside a pilot, live = offline, operator row, registries |
| `npm run check:intel` | 10 scripts, 578 assertions, 0 failures |
| `check:roles` (backend) | 94 assertions, 0 failures — `insights.pilot` registered, labelled in EN/FR, its lock explained |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials | **69 scripts, 4,374 assertions, 0 failures**; `check-student-integrity.js` (a live-Atlas maintenance report, not a regression test) again exited without a tally |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 3,300 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| Engine | `ENGINE_VERSION` 1.0.0; `shared/intelligence/` untouched; every threshold and flag limit unchanged |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

No authorised school and no real reviewers were available in this environment.
The pilot exercised in the tests is of kind `development`, with fixture
teachers, and concludes INSUFFICIENT_EVIDENCE — which is what two reviews of
one case deserve. Nothing here is validation of the engine.

```
PILOT READY
REAL VALIDATION NOT YET PERFORMED
REAL COHORT VALIDATION: NOT PERFORMED
REAL TEACHER VALIDATION: NOT PERFORMED
CALIBRATION REQUIRES MORE DATA
ENGINE_VERSION: 1.0.0
```

---

## 13. Stage 8 — controlled real-world validation: not started

Stage 8 is the first real pilot: an authorised school, its own administrator,
at least two of its own teachers, at least thirty reviewable cases, at least
three cases that two teachers can review independently. None of the
operational preconditions exist in this environment. The real pilot was not
started, no teacher feedback was manufactured, and nothing synthetic is
described below as validation.

```
STAGE 8 NOT STARTED
REAL PILOT PREREQUISITES: BLOCKED — no authorised school, administrator or reviewers available
ENGINE_VERSION: 1.0.0
```

### Prerequisite status

| Precondition (brief §1) | Status here | How it is verified when a school exists |
|---|---|---|
| one authorised school | **missing** | operator selects it; head signs `schoolParticipates` |
| an authorised school administrator | **missing** (fixtures only) | preflight `schoolAdminPresent` |
| ≥ 2 real teachers/reviewers | **missing** (fixtures only) | preflight `reviewersAvailable` — active assignments in scope |
| teachers understand the task | **missing** | briefing on the page; head signs `reviewersUnderstandTask` |
| sufficient published evidence | **missing** | preflight `publishedEvidence` |
| ≥ 30 reviewable cases | **missing** | preflight `reviewableCases` |
| ≥ 3 multi-review-capable cases | **missing** | preflight `multiReviewCapableCases` — cases in classes with two or more assigned teachers |
| teacher visibility assignment-limited | verified | `check-intelligence-access.js` §1, `check-review-workflow.js` §5 |
| school-admin visibility | verified | `check-intelligence-access.js` §2 |
| super-admin requires explicit selection | verified | `check-intelligence-access.js` §3, `check-pilot-readiness.js` §2 |
| no salt exposed to school users | verified | `check-intelligence-access.js` §6; preflight `saltNotExposed` |
| no raw cohort export to ordinary users | verified | `check-intelligence-access.js` §6 |
| no pupil identity in the engine input | verified | preflight `engineInputNameFree` runs `validateCohort` over the live cohort |
| live/offline consistency operational | verified | preflight `consistencyOperational` on a sample; `/insights/student/:id/consistency` |

### What was put in place so the real pilot needs no developer

- **Preflight** — `GET /api/insights/pilot/preflight` answers every automatic
  precondition for the school (and an optional class scope), names the two
  that only a person can answer, and lists blockers. **A pilot of kind `real`
  cannot be opened while any automatic check fails** (409 `REAL_PILOT_BLOCKED —
  <reason>`) **or without both attestations signed** (409
  `ATTESTATION_REQUIRED`). The attestations are stored on the record with who
  signed and when. Development and synthetic pilots are not gated.
- **Findings record** — `findings[]` on the pilot: `findingId`, category
  (ENGINE, DATA_QUALITY, MAPPING, AUTHORIZATION, UX, MISSING_EVIDENCE, GUIDANCE,
  REVIEW_WORKFLOW, OFFLINE_CONSISTENCY), severity, summary, evidence, affected
  cases, the pilot's engine version (never the caller's), status (open →
  investigating → confirmed / resolved / not_reproduced), recommended next
  action. Findings are never deleted; a closed pilot takes no new ones. This is
  the `finding → evidence → reproduction → review → post-pilot decision` path
  the brief requires instead of a silent fix; the one finding this project has
  so far (the offline contract dropping `isPassing`, §12) is the worked example.
- **Four phenomena, kept apart** — the tally now carries `concerns`:
  interpretation disagreement (classification judged NO or PARTIALLY), data
  quality, missing evidence, contextual limitation — each a count of reviews
  with the codes repeated at or above the support minimum, never summed. Two
  reviewer codes were added to the one form contract for this: `stale_record`
  and `context_unavailable`. The head's page shows the four side by side with
  the sentence "teacher agreement is not ground truth".
- **Reviewer wording** — the outcomes are labelled as the brief words them:
  Supported / Partly supported / Not supported / Insufficient evidence. They
  are the existing `confirmed / partially_appropriate / rejected /
  insufficient_evidence` outcomes of `reviewFeedback.outcomeOf`; no second
  schema.

### The protocol, when a school is available

1. Operator selects the school; head opens **Intelligence review → Validation
   pilot → kind: real**; the preflight must be all green; the head signs both
   attestations; the pilot opens READY with `engineVersion` stamped by the server.
2. Head briefs the teachers (the page carries the briefing; the banner tells
   each teacher a real pilot is on) and moves the pilot to ACTIVE.
3. Teachers work the queue top-down in `REVIEW_PRIORITY` order; no category
   filter exists, so the sample is the engine's own distribution. Colleagues'
   answers stay hidden until one's own is submitted. → REVIEWING.
4. Suspected engine defects, mapping differences, authorisation surprises and
   UX problems are recorded as **findings**, not fixed. `shared/intelligence/`
   is not touched while the pilot is open.
5. For a sample of real cases the head presses *Check live = offline*; a
   mismatch is recorded as an OFFLINE_CONSISTENCY finding with the exact paths.
6. → ANALYSIS_READY takes the evidence snapshot. The head reads: outcome
   distribution, the four concern groups, data-quality citations, repeated
   disagreements, patterns, and the sensitivity table on the calibration
   summary. Threshold changes are candidates only under §14 of the brief and §6
   of this document; a single disagreement changes nothing.
7. → CALIBRATED (gate met — ≥ 2 reviewers, ≥ 30 reviewed cases, ≥ 3
   multi-reviewed — and a written decision, meaning only "the evidence is
   sufficient to accept the current rules for this pilot's scope") or
   → INSUFFICIENT_EVIDENCE. Then → CLOSED. The trail and the evidence stay.

### Privacy

Real pupil data enters no fixture, test, commit, log or document; the
committed fixtures remain synthetic. The engine input is name-free and the
preflight re-checks it against the live cohort every time. Teacher screens show
the minimum a teacher needs to recognise the case (name, class, enrolment
number); the operator's cross-school figure shows counts and the pilot's kind
and state.

### Verification (Stage 8 readiness)

| | |
|---|---|
| `check-pilot-readiness.js` | 82 assertions (was 64), 0 failures — preflight answers and blockers, `REAL_PILOT_BLOCKED` on open, findings lifecycle and authorisation, four concern groups counted apart, the two new reviewer codes |
| `npm run check:intel` | 10 scripts, 596 assertions, 0 failures |
| `check-calibration-export.js` | 51/51, twice in a row after fixing a race in the read-only proof itself (the parent's `autoIndex` had not always created every collection before the "before" snapshot; the check now awaits `Model.init()` and names a drifting collection instead of reporting `false`) |
| `check:roles` (backend) | 94 assertions, 0 failures — no new permission; `insights.pilot` reused |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials | **69 scripts, 4,392 assertions, 0 failures** (`check-student-integrity.js`, a live-database maintenance report, is not a regression test and is excluded) |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 3,363 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| Engine | `ENGINE_VERSION` 1.0.0; `shared/intelligence/` untouched; every threshold and flag limit unchanged |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Final output

```
STAGE 8 NOT STARTED
REAL PILOT PREREQUISITES: BLOCKED — no authorised school, administrator or reviewers available;
                          every technical precondition verified and enforced by the preflight
ENGINE_VERSION: 1.0.0
```

---

## 14. Stage 9 — the strengths layer, and how it will be calibrated

`shared/strengths` (STRENGTH_ENGINE_VERSION 1.0.0) reads the academic profile
the review sheet already carries; nothing in the academic engine moved for it.
Its thresholds are its own and documented in `engine.js`: minObservations 2,
recurringSequences 2, persistentTerms 2, consistentSpread 2, variableSpread 4,
declineDrop 2, crossSubjectMin 2, teacherObservationsForSupport 2, minWeight 0.5.

Calibration hooks already in place:

- **Teacher confirmation** — a review of category `strength`, on the existing
  `IntelligenceReview` collection, tallied by the same `reviewFeedback.js`;
  the four concern groups apply unchanged.
- **Live = offline** — `GET …/consistency` diffs the strengths profile through
  both roads; a difference is recorded as an OFFLINE_CONSISTENCY finding on the
  pilot, as for the academic profile.
- **Longitudinal record** — snapshots keep what the profile said each term,
  with both engine versions, so a rule change can be read against history.

Any threshold, keyword, weight or area change follows §6 and §14 of the Stage
8 brief exactly as an academic threshold does — repeated evidence, affected
cases, expected effect, regression, a documented version increment of the
strengths layer only.

### Verification (Stage 9)

| | |
|---|---|
| `check-strengths.js` (new) | 74 assertions, 0 failures — persistent / emerging / variable / declining / cross-subject / single-subject / secondary-only / sparse / contradictory / absences / interest / participation / teacher-observation rule / never-said / determinism; then every role and boundary, evidence by source, snapshots and history, confirmation stored apart, the guardian shape, live = offline for the layer |
| `npm run check:intel` | 11 scripts, 670 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | **70 scripts, 4,466 assertions, 0 failures** (`check-desktop-parity.js` 1,365, `check-sync-feed.js` 61 among them) |
| `check:roles` (backend) | 94 assertions, 0 failures — no capability minted for pupils; students still hold none |
| web | `tsc -b` clean, `eslint` 0 errors, `vite build` ok, `i18n:check` 3,530 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| Engines | `ENGINE_VERSION` 1.0.0 and `shared/intelligence/` untouched; `STRENGTH_ENGINE_VERSION` 1.0.0 |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 9 COMPLETE
ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.0.0
CAREER_PREDICTION: NOT IMPLEMENTED
PSYCHOLOGICAL_INFERENCE: NOT IMPLEMENTED
LLM_DECISION_MAKING: NOT IMPLEMENTED
REAL-WORLD VALIDATION: STILL PENDING
```

---

## 15. Stage 10 — exploration evidence, and what it will mean

`shared/exploration` (EXPLORATION_ENGINE_VERSION 1.0.0) produces evidence rows
by kind; it interprets none of them. When the real pilot runs, the loop
produces three things the calibration protocol can use:

- **Interest × performance pairs** per exploration — the four corners, never a
  score — read against the strengths profile's dimensions.
- **Teacher observations** in the layer's coded vocabulary, already consumed by
  the strengths engine under its one rule (two distinct observers lift EMERGING
  to strong) and therefore already a calibration question.
- **Participation and performance rows**, carried and not yet consumed. Whether
  and how the strengths engine should read them is a STRENGTH_ENGINE_VERSION
  1.1.0 decision under §6: repeated evidence, affected cases, expected effect,
  regression, a documented increment. Nothing in 1.0.0 moves because a pupil
  completed an activity.

The recommender's quota (3 / 1 / 2 for six) and adjacency map are the layer's
thresholds; any change moves EXPLORATION_ENGINE_VERSION and is read against the
office's summary (frequently skipped, frequently declined) before it is made.

### Verification (Stage 10)

| | |
|---|---|
| `check-exploration.js` (new) | 86 assertions, 0 failures — catalog validity and versioning; quota, reasons, breadth, history, resources, determinism; the evidence matrix and the pair; discover / start / save / skip / decline / abandon / submit with replays and version conflicts; reflection privacy and revision; observation and rating apart; the strengths profile unmoved; guardian, office, feed classification |
| `npm run check:intel` | 12 scripts, 756 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | **71 scripts, 4,552 assertions, 0 failures** (`check-create-replays.js`, `check-idempotency.js`, `check-sync-feed.js`, `check-desktop-parity.js` among them) |
| `check:roles` (backend) | 94 assertions, 0 failures — no capability minted; pupils act by role |
| web | `tsc -b` clean, `eslint` 0 errors, `vite build` ok, `i18n:check` 3,687 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| mobile | `eslint` clean on the Explore screens, the service and the home entry; the `explore` key tree added to both locales in step with the web |
| Engines | `ENGINE_VERSION` 1.0.0 and `STRENGTH_ENGINE_VERSION` 1.0.0 untouched; `EXPLORATION_ENGINE_VERSION` 1.0.0 |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 10 COMPLETE
ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.0.0
EXPLORATION_ENGINE_VERSION: 1.0.0

EXPLORATION_LOOP: IMPLEMENTED
LONGITUDINAL_EVIDENCE: IMPLEMENTED
STUDENT_AGENCY: PRESERVED

CAREER_PREDICTION: NOT IMPLEMENTED
PSYCHOLOGICAL_INFERENCE: NOT IMPLEMENTED
LLM_DECISION_MAKING: NOT IMPLEMENTED

REAL-WORLD VALIDATION: STILL PENDING
```

---

## 16. Stage 11 — Strength Engine 1.1.0 and what it will calibrate against

The fusion thresholds are the layer's own and documented in
`shared/strengths/fusion.js`: recentDays 120, historicalDays 365, eventsToLift
2, eventsToContradict 2, sourcesForBroadCoverage 3; the teacher rule's 2
observers is unchanged from 1.0.0. Each is a calibration question the real
pilot can answer with the same tools: teacher confirmation on a strength
reading (a review of category `strength`), the four concern groups, and the
interest × performance pairs the exploration loop records.

When 1.1.0 moves a reading that 1.0.0 would not have, the profile says so
(`baseState` vs `state`, `fused.stateSource`, `fused.reasons`), so a reviewer
can judge the fusion step apart from the academic reading. A change to any
fusion threshold is a 1.2.0 decision under §6.

### Verification (Stage 11)

| | |
|---|---|
| `check-strength-fusion.js` (new) | 58 assertions, 0 failures — baseline kept, one step on two events and never two, one event is one event, signals never ability, the one teacher rule unchanged, four corners, recency at 120/121 and 365/366 days, agency, timeline, comparison, saturation, determinism; then roles, v1 → evidence → v2 with v1 untouched, idempotent rebuild, retraction, live = offline |
| `check-strengths.js` / `check-exploration.js` | 74 / 86, 0 failures — only the strength-engine version pins moved to 1.1.0; every 1.0.0 behaviour still asserted |
| `npm run check:intel` | 13 scripts, 814 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | 72 scripts, 4,609 passed, 1 failed — the failure a pre-existing false positive in `check-teacher-intelligence.js` (its money-word scan matched the hex letters `cfa` inside a randomly generated UUID); the currency codes now match as whole words, and the script re-runs 55/55 |
| `check:roles` (backend) | 94 assertions, 0 failures |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 3,733 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| mobile | `eslint` clean on the Explore screen and service |
| Engines | `ENGINE_VERSION` 1.0.0 untouched; `STRENGTH_ENGINE_VERSION` 1.0.0 → **1.1.0**; `EXPLORATION_ENGINE_VERSION` 1.0.0 — its recommender's new `saturation` input is optional and leaves the 1.0.0 output identical when omitted |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 11 COMPLETE

ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.1.0
EXPLORATION_ENGINE_VERSION: 1.0.0

EVIDENCE_FUSION: IMPLEMENTED
LONGITUDINAL_PROFILE: IMPLEMENTED
PROFILE_CHANGE_EXPLANATION: IMPLEMENTED
CONTRADICTION_TRACKING: IMPLEMENTED
EXPLORATION_FEEDBACK_LOOP: CLOSED

CAREER_PREDICTION: NOT IMPLEMENTED
PSYCHOLOGICAL_INFERENCE: NOT IMPLEMENTED
LLM_DECISION_MAKING: NOT IMPLEMENTED

REAL-WORLD_VALIDATION: STILL PENDING
```

---

## 17. Stage 12 — learning evidence and calibration

The learning-evidence layer's thresholds are its own (`taxonomy.js`):
minEventsForPattern 3, minAttendanceDays 10, veryLateDays 7, directionDelta
0.10, consistentSpread 0.10, variableSpread 0.20, completion 0.90 / 0.60,
onTime 0.80, attendanceStable 0.90, contradictionDelta 0.15, coverage bands
3 / 6 / 12. None of its signals is authorised to influence the strength,
exploration or guidance engines in 1.0.0; the real pilot will read them beside
teacher confirmations before any signal is admitted, and admitting one is a
versioned change of the receiving engine.

### Verification (Stage 12)

| | |
|---|---|
| `check-learning-evidence.js` (new) | 69 assertions, 0 failures — every source, every semantic state, one event once, patterns that need evidence, recency at the boundaries, homework completion/submission/lateness, attendance never ability, practical apart from formal, five contradictions kept standing, quality as coverage, the strength boundary untouched, privacy, determinism; then every role, the guardian, snapshots, an idempotent rebuild, a corrected mark, live = offline |
| `npm run check:intel` | 14 scripts, 883 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | **73 scripts, 4,679 assertions, 0 failures** |
| `check:roles` (backend) | 94 assertions, 0 failures |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 3,804 keys in 2 languages, `api:check`, `check:roles`, `check:l10n` ok |
| mobile | `eslint` clean on the Explore screen and service |
| Engines | academic 1.0.0, strengths 1.1.0, exploration 1.0.0 untouched; `LEARNING_EVIDENCE_VERSION` 1.0.0 |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 12 COMPLETE

ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.1.0
EXPLORATION_ENGINE_VERSION: 1.0.0
LEARNING_EVIDENCE_VERSION: 1.0.0

REAL-WORLD_VALIDATION: STILL PENDING
```

---

## 18. Stage 13 — Strength Reading 1.2.0 and what the integration will calibrate against

The integration adds no threshold of its own beyond the two-event bar it
shares with 1.1.0 (`eventsToCorroborate 2`, `eventsToContradict 2`,
`minWeight 0.5`). What the pilot can calibrate: whether a `CORROBORATED`
reading is more often confirmed by a teacher than an `UNSUPPORTED` one;
whether `CONTRADICTED` readings correspond to something the teacher recognises
(a different kind of task, a different period) or to noise; whether the
one-step limit is too cautious or not cautious enough; whether the strong-mark
bar for an assignment or a quiz should differ from the exam bar. Each is a
comparison of a relationship code against a teacher's answer, never a fit of
a weight. No real pupil has been through 1.2.0.

### Verification (Stage 13)

| | |
|---|---|
| `check-learning-integration.js` (new) | 67 assertions, 0 failures — baseline preserved, corroboration per family, one step at most, practical and formal marks never recounted, quiz retries one event, contradiction kept standing (never retired, never rescued), stale and neutral evidence, modalities unavailable not weak, attendance and submission as context, interest as context, six change codes about evidence, a 1.1.0 snapshot yields no codes, determinism, purity, no score or career key; then the routes as every role, the pupil's own view, snapshots with five versions, a corrected mark, a retraction, live = offline |
| `check-pilot-readiness.js` | 82 (the consistency summary names seven more difference classes, all false) |
| `npm run check:intel` | 15 scripts, 950 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | **74 scripts, 4,746 assertions, 0 failures** |
| `check:roles` (backend) | 94 assertions, 0 failures |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 3,888 keys in 2 languages, `api:check`, `check:roles` 31, `check:l10n` 70 ok |
| mobile | `eslint` clean on the Explore screen and service; `check:i18n` 5,589 keys OK (a pre-existing missing `common.offline` reference fixed); `check:l10n` 89 |
| Engines | academic 1.0.0, exploration 1.0.0, learning evidence 1.0.0 untouched; strengths **1.2.0**; learning integration **1.0.0** |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 13 COMPLETE

ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.2.0
EXPLORATION_ENGINE_VERSION: 1.0.0
LEARNING_EVIDENCE_VERSION: 1.0.0
LEARNING_INTEGRATION_VERSION: 1.0.0

REAL-WORLD_VALIDATION: STILL PENDING
```

---

## 19. Stage 14 — the Development Engine and what a pilot can calibrate

The development layer adds three rules of its own: two independent
observations before any trajectory is named, two later independent
observations before a contradiction is called resolved, and the shared
one-year window before an unobserved contradiction is called stale. A pilot
can compare each against what teachers recognise: whether a `STABLE_*` or
`STRENGTHENING` trajectory matches the teacher's sense of the year; whether
a `PERSISTENT` contradiction points at something real (a task type, a
period) or at noise; whether the resolution bar is too quick or too slow.
Each is a categorical comparison, never a fit of a rate. No real pupil has
been through the engine.

### Verification (Stage 14)

| | |
|---|---|
| `check-development.js` (new) | 62 assertions, 0 failures — one observation is no trend; every supported transition; coverage change is not state change; unavailable modalities are not negative; contradictions new / recurring / persistent / resolved / stale / never erased; retraction changes the next reading and no snapshot; asOf replay and determinism; duplicate observations, quiz retries and one project across modalities count once; no score, no prediction, purity, name-free, no reflection text; versions kept as recorded; then the routes as every role, snapshots feeding the history, the guardian's view, live = offline, no new model |
| `check-pilot-readiness.js` | 82 (the consistency summary names six more difference classes, all false) |
| `npm run check:intel` | 16 scripts, 1,012 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | **75 scripts, 4,808 assertions, 0 failures** |
| `check:roles` (backend) | 94 assertions, 0 failures |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 3,999 keys in 2 languages, `api:check`, `check:roles` 31, `check:l10n` 70 ok |
| mobile | `eslint` clean on the development screen, home and service; `check:i18n` 5,700 keys OK; `check:l10n` 89 |
| Engines | academic 1.0.0, strengths 1.2.0, exploration 1.0.0, learning evidence 1.0.0, learning integration 1.0.0 untouched; `DEVELOPMENT_ENGINE_VERSION` 1.0.0 |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 14 COMPLETE

ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.2.0
EXPLORATION_ENGINE_VERSION: 1.0.0
LEARNING_EVIDENCE_VERSION: 1.0.0
LEARNING_INTEGRATION_VERSION: 1.0.0
DEVELOPMENT_ENGINE_VERSION: 1.0.0

REAL-WORLD_VALIDATION: STILL PENDING
```

---

## 20. Stage 15 — guidance and interventions, and what a pilot can calibrate

Guidance adds no threshold of its own beyond the vocabulary and the bounds
(five items per dimension, "most modalities" at seven of nine); the
intervention engine adds the trigger bars (two independent observations, three
for an evidence gap) and the review window (14–120 days). A pilot can compare
each guidance category against what the teacher would have suggested, each
trigger against whether the teacher recognises the pattern, and each observed
outcome against the teacher's own reading of the period — categorical
comparisons, never a fit. No real pupil has been through either engine.

### Verification (Stage 15)

| | |
|---|---|
| `check-development-guidance.js` (new) | 38 assertions, 0 failures — every rule case, the object contract, bounded categories and actions, categorical quality, agency, determinism, historical asOf, purity, forbidden vocabulary in the engine, its output and both locale catalogues; the route as every role, the guardian, live = offline, no model |
| `check-development-interventions.js` (new) | 48 assertions, 0 failures — triggers and the no-single-observation rule, the proposal contract, every lifecycle move and every invalid one, roles, replay, review-due, outcome classification, legacy status; refusal without evidence, proposal, idempotent replay, the pupil's limited view, accept, activate, review, pause, resume, complete, decline, cancel, snapshot integrity, authorisation, the guardian's agreed support, live = offline, no new model |
| `check-pilot-readiness.js` | 82 (five more consistency classes expected false; a time-of-day flake in its "no mark" scan fixed by stripping timestamps) |
| `check-interventions.js`, `check-teacher-intelligence.js` | unchanged in scope; their money-word scans now word-bound the short tokens ("fee", "xaf", "cfa") a generated uuid can contain |
| `npm run check:intel` | 18 scripts, 1,098 assertions, 0 failures |
| Whole-repository sweep, every `scripts/check-*.js` except the two that need mail credentials and the live-database maintenance report | **77 scripts, 4,894 assertions, 0 failures** |
| `check:roles` (backend) | 94 assertions, 0 failures |
| web | `tsc -b` clean, `eslint` 0 errors (one pre-existing warning), `vite build` ok, `i18n:check` 4,171 keys in 2 languages, `api:check`, `check:roles` 31, `check:l10n` 70 ok |
| mobile | `eslint` clean on the development screen, home and service; `check:i18n` 5,872 keys OK; `check:l10n` 89 |
| Engines | academic 1.0.0, strengths 1.2.0, exploration 1.0.0, learning evidence 1.0.0, learning integration 1.0.0, development 1.0.0 untouched; `GUIDANCE_ENGINE_VERSION` 1.0.0, `INTERVENTION_ENGINE_VERSION` 1.0.0 |
| `check:all` | not run — SMTP/Brevo credentials absent, unchanged |

### Status

```
STAGE 15 COMPLETE

ACADEMIC_ENGINE_VERSION: 1.0.0
STRENGTH_ENGINE_VERSION: 1.2.0
EXPLORATION_ENGINE_VERSION: 1.0.0
LEARNING_EVIDENCE_VERSION: 1.0.0
LEARNING_INTEGRATION_VERSION: 1.0.0
DEVELOPMENT_ENGINE_VERSION: 1.0.0
GUIDANCE_ENGINE_VERSION: 1.0.0
INTERVENTION_ENGINE_VERSION: 1.0.0

REAL-WORLD_VALIDATION: STILL PENDING
```
