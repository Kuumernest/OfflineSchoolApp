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
