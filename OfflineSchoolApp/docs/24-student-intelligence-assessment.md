# 24 — Student Intelligence: Architecture Assessment

Stage 1 of the Student Intelligence & Guidance System. **No code was changed to
produce this document.** It records what the repository actually contains, which
of it the intelligence layer may consume, which of it the intelligence layer must
not touch, and the constraints that will decide the shape of Stages 2–11.

Everything below was read from the tree at commit `4de662f` on branch
`ca-assessment`. Where a statement is an inference rather than something the code
states, it says so.

---

## 1. The headline

**An intelligence layer already exists in embryo, and it is the right seam.**

`backend/src/services/earlyWarning.service.js` is a 238-line deterministic,
evidence-carrying risk engine. It is already:

* reading only records the school already keeps (no extra teacher input);
* scoring with a visible points table rather than a model;
* returning machine codes plus the numbers behind them, with the clients owning
  the wording in the reader's language;
* served from `/api/insights/early-warning`, gated on an `insights.view`
  capability that exists in the permission registry;
* rendered by `web/src/pages/insights/watchlist.tsx`.

This is Layer 1 and part of Layer 2 of the brief's §15, already built, already
shipped, already following the brief's own §16 explainability rule. The brief's
Stages 3–5 should **extend this module**, not start beside it. A second scoring
engine reading the same four collections is precisely the "two documents that
disagree about the same class" failure that `classStats.service.js` was written
to prevent.

What does not exist anywhere in the repository: any AI, LLM or model-provider
integration. `grep -rniE "openai|anthropic|claude|gemini|llm|gpt-"` across
`backend/src`, `web/src`, `mobile/src` and all three `package.json` files returns
nothing. Stage 7 is greenfield, with no key handling, no provider dependency and
no prior art to be consistent with.

---

## 2. Topology

```
OfflineSchoolApp/
├── backend/          Node/Express + Mongoose. 245 JS files under src/.
│   ├── src/db/models/      52 Mongoose models (+ index.js, which registers them all)
│   ├── src/routes/         33 routers, mounted in src/server.js
│   ├── src/controllers/    5 — most logic lives in routes + services, not controllers
│   ├── src/services/       30 services; this is where the domain logic is
│   ├── src/config/         roles.js, permissions.js, syncFeed.js  ← the three registries
│   ├── middleware/         auth.js, permissions.js, idempotency.js, errorHandler.js
│   └── scripts/            67 check-*.js scripts — this project's test suite
├── shared/           13 modules shared by backend, desktop and clients
├── web/              React + Vite + TS admin console (react-query, tailwind, i18n en/fr)
├── mobile/           Expo SDK 57 / React Native, SQLite, expo-router
├── desktop/          Electron; its own offline API handlers under src/main/api
└── docs/             23 numbered documents; this is the 24th
```

Note `desktop/` — the brief does not mention it, but it exists, it has its own
copy of grading logic (`desktop/src/main/api/gradeUtils.js`, fed from
`shared/gradeScale.js`) and it is the primary consumer of the `/sync/changes`
feed. Any intelligence decision that touches the sync feed touches the desktop.

---

## 3. The academic calculation chain — the do-not-touch list

The brief's §4 says the intelligence engine must treat existing academic results
as authoritative and must not invent alternative averages. Here is what
"authoritative" concretely means in this repository.

### 3.1 The hierarchy

```
StudentScore        one mark, one pupil, one subject, one exam
      ↓  results.service.processResults()
ResultSummary       one pupil's whole result for ONE exam (= one sequence)
      ↓  termGrading.service
TermResult          one pupil's term average, from the term's sequence summaries
      ↓  annualGrading.service
AnnualResult        one pupil's annual average, from the three terms
      ↓  promotion.service
PromotionDecision   who moves up
```

Each arrow is a **deliberate, explicit computation a school triggers**, not a
live derivation. `resultStaleness.service.js` exists precisely because a stored
term average is not recomputed when an underlying mark changes — it reports the
discrepancy rather than silently recomputing, so the school keeps the decision.

**The intelligence layer must read these rows and never write them, and must not
recompute an average that one of them already holds.**

### 3.2 `ResultSummary.subjectBreakdown` is the single richest input we have

This is the most important discovery for the brief's §8 (strengths) and §5
(subject-level risk). Every `ResultSummary` carries a `subjectBreakdown` array,
one entry per subject, holding:

| field | meaning |
|---|---|
| `subjectId`, `subjectName` | the subject |
| `normalizedMark` | the mark on the **/20 scale** — the comparable number |
| `coefficient`, `weightedMark` | Cameroon coefficient weighting |
| `caMark`, `testMark` | CA and paper marks separately, each /20 |
| `caWeight`, `testWeight` | the blend actually applied |
| `grade`, `points`, `remark`, `isPassing`, `isAbsent` | the graded outcome |

So per-subject trend, per-subject consistency, cross-subject clustering and
CA-versus-paper divergence are all computable **from rows that already exist**,
with no new collection and no re-derivation. `normalizedMark` is the field to
compare across subjects; `percentage` on the summary root is the whole-result
figure and mixes scales at subject level (see the header of
`classStats.service.js`, which documents exactly this trap).

`TermResult` and `AnnualResult` carry **no subject breakdown** —
`reportCardData.service.js` rebuilds it on every print because nothing stores
it. So subject-level history must be assembled from `ResultSummary` rows, which
is what `buildTermCard` already does; that function is the reference
implementation for how to combine them, and is reusable.

### 3.3 The CA trap — a real hazard for any trend calculation

A sequence is two exams: an `Exam` of `type: "test"` (the paper) and an `Exam`
of `type: "ca"` with `parentExamId` pointing at it.
`sequenceAssessment.service.js` states the rule in its header:

> The CA exam gets a summary of its own too, because it is an exam and
> processing one must not be a special case, but nothing downstream aggregates
> that summary: doing so would count CA twice.

**`earlyWarning.service.js` does not honour that rule.** Its result query is:

```js
ResultSummary.find({ schoolId, isPublished: true, deletedAt: null })
  .sort({ createdAt: 1 })
```

— no join to `Exam`, no filter on exam type. `results.service.processResults()`
and `publishResults()` both take a bare `examId` and neither refuses a CA exam,
so a school that processes and publishes its CA exam produces published CA
summaries, and the watchlist's "last two results" can then compare a CA mark
against a paper mark and report it as a `grade_drop`. Whether this fires today
depends on whether any school publishes CA summaries — unverified against live
data, and worth checking before the demo.

Two corollaries for the intelligence engine:

1. **Filter by exam type.** Any sequence-over-sequence comparison must join
   `Exam` and keep only the sequence papers (`isSequencePaper`, already exported
   by `sequenceAssessment.service.js`).
2. **Order academically, not by row age.** `sort({ createdAt: 1 })` is the order
   rows were *written*, not the order sequences were *sat*. A recomputed or
   late-published earlier sequence sorts last. Trend must be ordered by
   `(academicYear, term, sequenceNumber)`, which `Exam` carries and
   `ResultSummary` partly duplicates (`academicYear`, `term` — but **not**
   sequence number).

`ResultSummary` not carrying `sequenceNumber` is a genuine friction point: every
trend query needs an `Exam` join. That is a design input for Stage 2, not a
reason to denormalise someone else's collection.

### 3.4 The other authoritative pieces

* **Grade scale** — `shared/gradeScale.js`, one copy, seven bands, pass at 10/20,
  two remarks per band (en/fr). `GradingConfig` holds a school's override.
* **Academic structure** — `AcademicStructure` holds the year's terms, their
  sequences, their weights, `passMark`, `promotionThreshold`, `maxAbsences`.
  A school may run 2 or more sequences a term; nothing may assume two.
* **Coefficients** — `Subject.coefficient` (Cameroon sense, 1 = normal) cascades
  to `ExamSubject.weight` (percentage sense, 100 = coefficient 1) via
  `subjectCoefficient.service.js`. A strength signal that weights subjects must
  use the coefficient the exam actually applied, not the subject's current value.
* **Cohort statistics** — `classStats.service.js` already computes class average,
  best and lowest at sequence, term and annual level. A "strong relative to the
  class" signal must call it, not re-derive it.

---

## 4. Signal inventory — what the data can honestly support

The brief's §9 warns against fabricating an assessment for a domain the platform
has no evidence for. This table is that audit.

| Brief's signal | Source in this repo | Verdict |
|---|---|---|
| Sustained / sudden academic decline | `ResultSummary.percentage`, `subjectBreakdown[].normalizedMark` across sequences | **Supported** — needs the §3.3 fixes |
| Repeated poor performance in a subject | `subjectBreakdown[].isPassing` per subject over time | **Supported** |
| Widening gap between subjects | `subjectBreakdown[].normalizedMark` spread | **Supported** |
| Declining term / sequence performance | `TermResult.termAverage`, `sequenceAverages[]` | **Supported** |
| Attendance decline, lateness, clustering | `StudentAttendance` (`present`/`absent`/`late`/`excused`, one row **per period**, `date` as a `YYYY-MM-DD` string) | **Supported** — must reuse `attendanceSummary.service.js`, which already distinguishes *records* from *days* |
| Attendance coinciding with academic decline | both of the above, on a common window | **Supported** as coincidence only; the brief's §6 wording rule is correct and the data cannot support more |
| Missing / declining assignments | `Homework.submissions[]` — an embedded array on the homework, not a per-student record | **Partially supported.** "Assigned" is inferred class-wide, exactly as `earlyWarning` already does. A pupil who joined the class mid-term looks like a pupil who missed everything. Worth a stated caveat in any evidence string |
| Subject-specific assignment difficulty | `Homework.subjectId` exists | **Supported**, and currently unused by `earlyWarning` |
| Assignment *scores* | `submissions[].score`, `maxScore`, `gradedBy` | **Supported** where teachers grade in-app; coverage unknown |
| Consistency / improvement trajectory | derived from the above | **Supported** |
| Strong relative to own baseline | `ResultSummary` history per pupil | **Supported** |
| Strong relative to class | `classStats.service.js` | **Supported** |
| Teacher-identified strengths | `StudentScore.teacherRemark`, `ResultSummary.principalRemark` | **Weak.** Free text, unstructured, in two languages. Not a basis for a domain claim |
| Extracurricular achievement | — | **No data.** No model, no field, nowhere |
| Leadership, collaboration, sports, creative arts, visual/design | — | **No data** beyond whatever subjects the school happens to teach |
| Practical/technical skill | only via subject marks (e.g. an ICT subject) | **Inferred from subjects only** |

**Conclusion for §9.** Of the twelve talent domains the brief lists, the data
supports exactly those that can be read off subject performance. There is no
competency model, no skills taxonomy, no observation record and no
extracurricular register anywhere in the 52 models. The first implementation
must therefore derive domains from **subject clusters only**, and must be able
to say "insufficient evidence" for everything else — which is the brief's own
§17 requirement, and here it is not a nicety but the common case.

Subjects are free-text per school (`Subject.name`, optional `code`), so a
subject→domain mapping cannot be hard-coded against a fixed list. It has to be a
configurable, school-visible mapping, or it will silently mis-cluster every
school that names Mathematics anything else. This is the largest open design
question in Stage 3.

---

## 5. Authorization — the model the intelligence layer must inherit

The brief's §21 says do not create a new unrestricted intelligence endpoint and
do not introduce parallel authorization. This repository has an unusually strict
existing model, and following it is mostly a matter of not inventing anything.

### 5.1 Three layers

1. **`config/roles.js`** — five roles (`super_admin`, `school_admin`, `bursar`,
   `teacher`, `student`) and named sets: `ADMIN_ROLES`, `FINANCE_ROLES`,
   `OFFICE_ROLES` (= admins + bursar), `TEACHING_ROLES` (= admins + teacher),
   `STAFF_ROLES`, `PLATFORM_ROLES`.
2. **`config/permissions.js`** — a registry of ~70 capability keys, each with a
   default role set and a `delegable` flag. Anything that alters a mark,
   publishes a result, manages users or runs promotion is `delegable: false`.
3. **`middleware/permissions.js`** — `requirePermission(key)` /
   `requireAnyPermission(...)`. It **throws at startup** on a key that is not in
   the registry.

Guardians are deliberately outside all of this: a parent is **not a `User` and
holds no role**. They authenticate through `/api/portal` against a
`GuardianAccess` row carrying `studentIds[]`. Students reach their own records
through routes that scope to the caller rather than through capability checks.

### 5.2 Teacher scoping

Two mechanisms, both keyed on `TeacherAssignment`:

* `src/utils/teacherScope.js` → `teacherAssigned({ teacherId, schoolId, classId, subjectId })`.
  A `null` subjectId asks the class-level question (the register, the form
  master); a subjectId asks the pair question (marks). Both field spellings
  (`teacher`/`teacherId`) are read, for older rows.
* `config/syncFeed.js` → `taughtStudentsOnly(req, models)`, the same logic
  expressed as a Mongo filter for the mirror.

Any per-teacher intelligence endpoint must go through one of these. There is no
third way and there should not be.

### 5.3 The decision this layer forces — and it is the big one

`insights.view` today defaults to **`OFFICE_ROLES`** — admins and the bursar,
**teachers excluded**. The route says why, in terms:

> Office only, teachers excluded — the list names children by fee arrears, which
> is bursar knowledge, not staffroom knowledge. A per-class teacher view would
> first need the money signal stripped.

The brief's §24 asks for a **teacher** dashboard. So the teacher dashboard
cannot reuse `insights.view`, and it cannot reuse the current watchlist payload,
because that payload carries `fees_outstanding` with a balance in it.

The clean shape, consistent with how this codebase already separates
`students.view` from `students.viewTaught`:

* keep `insights.view` as the office-wide, money-inclusive read;
* add a second capability (`insights.viewTaught`, default `TEACHING_ROLES`) for
  a per-class, **money-free** projection scoped by `teacherAssigned`;
* never let the two share a serializer — the money signal must be absent from
  the teacher shape by construction, not filtered out at the edge.

Note the precedent in `config/syncFeed.js`: a capability is paired with a
collection only where the pairing is honest, and a "loosely related" pairing to
make a screen light up is explicitly called a fiction there. An intelligence
endpoint pairing itself with `students.viewTaught` because it happens to admit
teachers would be that fiction.

Parent and student guidance (brief §11, Stage 8) are a **third and fourth**
shape, reached through `/api/portal` and the student routes respectively, not
through capability keys at all.

---

## 6. Synchronization — and the boot-time invariant that will bite

### 6.1 Two doors, on purpose

* **`GET /api/sync/pull`** — the legacy mobile path. Six collections, bespoke
  shape, scoped by tenant and barely by role. Every phone in every school
  depends on its exact shape. `syncFeed.controller.js` states plainly that it is
  left alone on purpose. **Do not extend it.**
* **`GET /api/sync/changes`** — the capability-scoped desktop feed. Uniform
  shape, `(updatedAt, _id)` pair cursor (the header explains why a bare
  `updatedAt` cursor silently loses or loops records). Declared entirely by
  `config/syncFeed.js`.
* **`POST /api/sync/push`** — gated on `sync.push`, `delegable: false`.

### 6.2 `config/syncFeed.js` will refuse to boot

`assertEveryModelIsClassified()` runs at require time and **throws if any file in
`src/db/models/` is in neither `FEED` nor `EXCLUDED`**. So the moment Stage 2
adds `StudentInsight.js`, `Intervention.js` or `InsightFeedback.js` to that
directory, **the server stops starting** until each is classified with either the
capability that gates mirroring it or a written reason it is online-only.

This is a feature, and the reason it is worth this paragraph is that it will look
like a broken build to whoever hits it first. It is the file asking a question
that has to be answered: may a device hold a copy of a child's insight record?

Three further invariants in the same family:

* `src/db/models/index.js` requires the whole directory at boot, so a new model
  is registered by existing. Nothing needs to import it.
* `requirePermission("…")` throws at startup on an unknown key — so a new
  capability must be added to `config/permissions.js` **before** any route uses
  it.
* `scripts/check-role-matrix.js` **fails on a permission nothing consults**. A
  capability added and not yet wired to a route breaks `npm run check`. Add the
  key and the route in the same change.

### 6.3 Offline behaviour of the intelligence layer itself

The brief's §20 requires basic operation without connectivity. What the clients
have today:

* **Mobile** — SQLite (`src/db/database.js`, `schema.js`, `schemaManager.js`)
  plus a single durable outbox, `mutationQueue.service.js`, through which *every*
  mutation passes. It classifies errors transient / conflict / permanent /
  resolved, retries with backoff, and holds reconcilers for server-reassigned
  ids. A teacher recording an **intervention** offline (Stage 6 + 9) should be
  one more entity on this queue and nothing more.
* **Web** — `src/lib/offline/{adapter,bridge}.ts`, plus react-query caching.
* **Desktop** — mirrors via `/sync/changes` and serves its own handlers.

The honest split for insights: **computed insights are derived data, and derived
data should not be queued for push.** Interventions and feedback are user-authored
facts and belong on the outbox. Insights themselves are either mirrored read-only
(if a device may hold them) or recomputed locally from the mirrored inputs — and
the mirrored inputs (`resultSummary`, `studentAttendance`, `homework`,
`termResult`, `annualResult`) are already in the feed. That second option is what
makes the brief's "perform locally supported intelligence calculations" real
rather than aspirational, and it is why the deterministic engine in Layer 1 must
have no server-only dependency.

---

## 7. Testing convention

`npm test` is `exit 1`. This project has **no test framework**. What it has
instead is 67 executable check scripts under `backend/scripts/`, each:

* a single `node scripts/check-thing.js` entry point;
* spinning up `MongoMemoryServer` and connecting mongoose to it;
* a hand-rolled `check(label, actual, expected)` counting pass/fail;
* a long header explaining *the fault it exists to prevent*, not just what it
  asserts (see `check-term-compute.js` — it pins a query **count**, because "it
  is fast now" decays the moment someone moves a query back inside a loop);
* registered in `package.json` as `check:<name>` and chained into `check:all`.

The brief's §31 "tests cover the intelligence calculations" therefore means a
`scripts/check-intelligence.js` in exactly this idiom, chained into `check:all`.
Introducing Jest or Vitest into the backend for this would be the "refactor
unrelated parts" the brief's §29.15 forbids.

Client-side, `web/` and `mobile/` have eslint and no test runner.

---

## 8. Gaps between the brief and the repository

Stated plainly, because each one is a decision someone has to take rather than a
thing that can be coded around.

1. **No competency, skills or extracurricular data exists.** §9's domain list is
   mostly unsupported. See §4 above.
2. **Subject names are free text per school.** Any subject→domain clustering
   needs a configurable mapping. Hard-coding "Mathematics, Physics, ICT →
   quantitative" works for the demo school and silently mis-clusters the next one.
3. **`insights.view` excludes teachers by design.** §24's teacher dashboard needs
   a new capability and a money-free projection. See §5.3.
4. **Homework has no per-student assignment record.** Engagement rates are
   class-inferred; a mid-term joiner looks like a persistent non-submitter.
5. **`ResultSummary` carries no `sequenceNumber`.** Every trend query joins `Exam`.
6. **The existing watchlist does not exclude CA summaries and orders by
   `createdAt`.** §3.3. This is the one place where the correct move may be to
   *fix* existing code rather than only build beside it — and it is a small,
   contained fix with an obvious check script.
7. **Intervention outcome measurement (§13) needs a before/after window that
   respects published-only.** An intervention recorded mid-sequence has no
   "after" until the next sequence is processed *and published*. The system must
   be able to say "follow-up pending" for weeks, and the UI must not read that
   as "no effect".
8. **No AI provider anywhere.** Stage 7 introduces the first outbound
   model call in the product: a dependency, a key, a failure mode when offline,
   and a cost. It must degrade to the deterministic evidence with no loss of
   function, since §20 forbids requiring connectivity.
9. **`desktop/` is unmentioned in the brief but real**, and shares grading code
   through `shared/`. Anything added to `shared/` lands there too.

---

## 9. Recommended shape for Stages 2–4

Direction only — this is the assessment, not the design, and no code follows
from it yet.

* **Layer 1 (measurement) belongs in `shared/` or a new
  `backend/src/services/intelligence/` directory**, pure and dependency-free, so
  the same arithmetic can run on a device. It consumes `ResultSummary`,
  `TermResult`, `AnnualResult`, `StudentAttendance`, `Homework` and calls
  `classStats.service.js` and `attendanceSummary.service.js` rather than
  reimplementing them.
* **Layer 2 (insights) extends `earlyWarning.service.js`** into a module that
  emits both risk and strength insights against the brief's §23 controlled
  vocabulary, keeping the existing points-table transparency and the existing
  `{ code, points, data }` evidence shape, which the clients already translate.
* **Confidence (§17) maps onto observation count and span**, and should be
  computed in Layer 1 where it is testable, not asserted in Layer 3.
* **New models** (`StudentInsight`, `Intervention`, `InsightFeedback`) must each
  be classified in `config/syncFeed.js` in the same commit that creates them, or
  the server will not boot (§6.2). `Intervention` carries teacher-authored facts
  and goes on the mobile outbox; `StudentInsight` is derived and probably should
  not.
* **API** extends `/api/insights` rather than opening a new root, and the
  teacher-scoped reads take the new capability plus `teacherAssigned`.
* **The bias rule (§18) is already structurally satisfied** — no demographic
  field is among the inputs listed above, and none should be added. Worth a
  check script that asserts the engine's input projection contains no
  demographic field, since that is the kind of thing that erodes by accident.

---

## 10. Open questions for the product owner

1. **Subject→domain mapping**: school-configurable, seeded per country
   curriculum, or demo-only for the ECA presentation?
2. **May a device hold a student's insights offline?** This is the
   `config/syncFeed.js` question and it is a privacy decision, not a technical
   one. Recomputing locally from already-mirrored inputs avoids it entirely.
3. **Does the teacher dashboard get a new capability** (`insights.viewTaught`,
   recommended) or does §24 get deferred to office roles for the first cut?
4. **Is the CA-summary trend hazard (§3.3) live** in the demonstration school's
   data? Cheap to check, and it changes whether the fix is urgent or tidy.
5. **Stage 7's AI provider and budget** — and confirmation that the product
   still demonstrates fully with the network unplugged, which §28.9 requires.

---

## Stage 3 — Guidance and intervention decision

Stage 3 adds `guidance.service.js` as a presentation-neutral projection of the
existing subject-intelligence profile. It consumes only structured insight codes,
confidence and evidence; it does not query source records or recompute marks.
The current categories are `academic_support`, `strength_development` and
`monitoring`. Guidance is code-based and translated by the existing web i18n
catalogues in English and French. It contains neither career conclusions nor
academic decisions. A future LLM may explain these fixed codes and evidence at
the presentation boundary, but must never generate or alter the authoritative
guidance.

The Stage 2.1 distinctions remain intact because guidance consumes its output:
CA is excluded from historical occasions, `score: 0` remains an earned mark,
`score: null` is unentered, absence and exemption remain non-performance states,
and GradingConfig remains the authority for pass/strength context.

Guidance itself is derived and stores nothing. No `StudentInsight` collection
exists and none is planned: a stored insight goes stale the moment a mark is
corrected, and a stale claim about a child is worse than no claim. Guidance is
recomputed from the profile on every request, which is also what makes it work
from a device's mirrored source data without a connection.

Intervention persistence was the open question at the start of Stage 3. It was
resolved by building it rather than deferring it — the decision, and what it
required, is the section below.

## Stage 4 — Human intervention persistence

The existing models were not reused. Homework represents class coursework;
messages and remarks do not provide a student-scoped support lifecycle, assigned
staff member, outcome, or status history. `Intervention` is therefore a separate
human-authored record. It stores a compact source type/code and action code, not
derived intelligence or a guidance snapshot.

The only lifecycle is `planned → active|cancelled` and `active → completed|cancelled`.
Every transition records its actor and time in `statusHistory`; completion and
cancellation receive their respective timestamps. Outcomes are human-entered
codes and cannot change grades, reports, promotion, or guidance.

Records use existing client-generated UUIDs. The desktop document mirror stores
the record locally and its existing durable outbox replays the normal REST
request with the same ID and idempotency key. Replayed creates return the existing
record. Updates carry `version`; the server answers `VERSION_CONFLICT` for a
stale version, preserving the existing explicit-conflict policy instead of
silently choosing a winner. Interventions are soft-delete capable, but no delete
route is exposed.

Admins have whole-school access. Teachers are limited to active
`TeacherAssignment` classes; bursars have no intervention permission. Parent and
student routes do not expose internal support notes. The sync feed applies the
same taught-student scope to desktop mirrors. No financial service or field is
used.

### What is proven, and what is not

`scripts/check-interventions.js` exercises the lifecycle, the four capabilities,
teacher scope, cross-school isolation, the bursar's exclusion, assignee
validation, idempotent replay of a resent create, version conflict on a stale
edit, the audit trail through the route, sync-feed classification and scope, and
the structural absence of any path to the fee ledger or the grading services.

Two honest gaps remain. The mobile write path (`mobile/src/services/
intervention.service.js`) is correct against the outbox and helper APIs it uses
but is not yet called by any screen — Stage 3 added no UI on purpose — and the
mobile package has no test runner, so it is reviewed rather than tested. And no
route exposes a school-wide or per-class intervention list; reads are per pupil,
which is what the routes a teacher would use actually need, but a future
dashboard will want more.

## Stage 5 — The teacher loop, closed

Stage 5 joins the layers into one workflow a teacher can actually run:

```
class surface → the evidence behind one pupil → the teacher chooses an action
   → the action is recorded → moved along → closed with an outcome
   → the marks before and after it are shown
```

### The class surface

`GET /api/insights/class/:classId` already existed from Stage 2 and was
extended rather than replaced. It now carries, per pupil, a **guidance summary**
(area, reason, priority, confidence — no evidence) and the pupil's **open
interventions**. "Open" is derived from the lifecycle table itself rather than
restated, so a fifth state could not be silently left out of a teacher's list.

The evidence deliberately stays on `GET /api/insights/student/:id/guidance`. A
class list answers "who should I look at"; carrying forty pupils' evidence into
it would turn a scanning list into a record dump.

The route costs a fixed number of queries regardless of class size — one bulk
`analyse()` plus one `Intervention.find` over the class — and
`check-teacher-intelligence.js` pins that by measuring a four-pupil class and a
ten-pupil class and asserting the read count is identical.

### Guidance to intervention

Nothing is created automatically. The check asserts that four pupils' guidance
can be surfaced across two requests with the intervention collection still
empty; a record appears only when a teacher posts one. The link back is the
Stage 4 `sourceType` / `sourceCode` pair plus a new `subjectId`, and no guidance
payload or evidence is copied into the record — the evidence is recomputed from
published marks whenever anybody asks, so it cannot drift from the report card.

`subjectId` is the one field Stage 5 added to `Intervention`. Without it the
before/after comparison cannot be honest: comparing a Mathematics action against
a pupil's whole average lets a good term in three other subjects read as a
Mathematics recovery.

### Before and after — and what it does not mean

`services/intelligence/interventionOutcome.service.js` splits the pupil's
published history at the moment the action started (`startedAt`, falling back to
`createdAt`, and the payload says which) and averages the subject's marks on each
side.

**A before/after change is not causal proof.** The pupil also grew up a term, the
syllabus moved, the paper was a different paper and the class may have changed
teacher. The service therefore emits flat observation codes — `INCREASED_AFTER`,
`DECREASED_AFTER`, `NO_CHANGE_OBSERVED` — never "improved by" or "worked", and
both clients render an explicit note saying the change does not establish that
the action caused it. A check reads every code the service can emit and fails on
any causal word.

Four states exist besides a comparison, and none of them is a zero:
`awaiting_after` (nothing sat since it started — the ordinary case for a recent
action, and emphatically not a failure), `no_before`, `no_evidence`, and
`not_subject_specific`. Nothing is persisted: no impact score, no effectiveness
rating, no cached comparison.

Which occasions count is decided by **when the paper was sat**
(`Exam.startDate`), not when the summary row was written. A sequence sat before
the action but published after it is prior evidence, and the check builds exactly
that row to prove it sorts that way.

Every Stage 2.1 distinction is inherited rather than reimplemented, because the
series is built by `subjectInsights.seriesFrom` over
`academicHistory.publishedHistory`: continuous assessment is not an occasion, a
genuine zero is counted, an absence and an exemption are not, an unentered mark
is not, and ordering is academic. One pupil in the check carries all five cases
in one subject.

### Clients

**Web** — one page, `/class-intelligence`, for teachers and admins. No charts, no
KPI tiles, no rankings: class picker, pupil cards, a panel with the evidence and
the action buttons, the recorded actions with their lifecycle moves, and the
before/after panel. All wording comes from the i18n catalogues in English and
French; the page recomputes nothing.

**Mobile** — `app/teacher/intelligence` is the first real caller of the Stage 4
writer. Reading guidance needs a connection, because the engine is backend-only;
the screen labels stale data with the time it was fetched rather than showing it
as current. **Recording an action does not need a connection** — it writes to
SQLite and queues through the existing outbox.

**Desktop** — the three read routes are recorded in the coverage census as
online-only, for the reason early-warning already was: the rows are mirrored but
the engine is not, and a second implementation of the ordering, exclusion and
threshold rules in that package would eventually disagree with the report card
about the same child. The honest fix is to move the engine into `shared/` so both
sides run identical code; that is real work and it is not this stage's. Recording
an intervention *is* answered offline there already.

### Remaining limitations

The mobile screen is reviewed, not tested — the mobile package still has no test
runner, and Stage 5 did not add one for a single screen. There is still no
school-wide intervention list; reads are per pupil and per class. The engine
thresholds remain unvalidated against real cohorts. And the before/after window
is whatever the school has published, which in a first term is often nothing —
`awaiting_after` will be the common answer for a while, by design.

## Stage 6 — One engine, three consumers

### Before

```
backend/src/services/intelligence/   ← the rules lived here
        ↓ HTTP only
   web        desktop (online-only)      mobile (online-only)
```

Desktop intelligence was online-only and the coverage census said why: the rows
were mirrored but the *rules* were not, and a second copy of them in Electron
would eventually disagree with the report card about the same child.

### After

```
                  shared/intelligence/
                  ├── academicOrder.js         which results count, in what order
                  ├── subjectInsights.js       what the marks say, with evidence
                  ├── guidance.js              what could reasonably be done
                  └── interventionOutcome.js   before and after an action
                              │
          ┌───────────────────┼───────────────────┐
          ↓                   ↓                   ↓
   backend services      desktop handlers     (mobile: see below)
   load + authorise      load from mirror
          ↓
      web / API
```

Every function in `shared/intelligence/` is pure: plain data in, plain data out,
no Mongoose, no Express, no HTTP, no filesystem, no clock, no authorisation, no
money. The backend services are now loaders — they query, they enforce scope,
they format a response, and they call the engine for every judgement.

The extraction was performed by lifting the rule bodies out of the backend file
character for character rather than retyping them, and
`scripts/check-shared-intelligence.js` asserts **identity, not resemblance**:
`backendInsights.seriesFrom === engine.seriesFrom`, and the same for the
metrics, the insight rules, the confidence function, the thresholds object, the
ordering rule, the guidance projection and the outcome comparison. It also
asserts the rule bodies are *gone* from the backend files, so an extraction that
left a duplicate behind would fail.

### Offline calculation is not offline data

These are different claims and only one of them is now true everywhere.

**Offline calculation** — proven. A check shuts `http.request`, `https.request`,
`dns.lookup`, `net.connect` and global `fetch`, then computes a real profile,
real guidance and a real before/after from plain objects. Nothing is mocked: the
functions under test are the ones the server runs. A second check loads the
engine with an empty module path to prove it needs nothing the server happens to
have installed.

**Offline data availability** — per consumer, and unchanged by this stage:

* **Desktop** has everything it needs. `resultSummary`, `exam`, `gradingConfig`,
  `academicStructure`, `student` and `intervention` are all in the sync feed, so
  `handlers/intelligence.js` answers all three routes from the mirror.
  One case still declines: an empty class. A teacher's mirror holds only the
  pupils they teach, so "no pupils here" and "not your class" look identical
  locally while the server answers 200 and 403 — so the handler asks rather than
  guessing.
* **Mobile cannot, and this stage did not change that.** Two independent
  blockers. Metro cannot resolve `shared/` from the mobile package (the repo
  already records this in `feeStructure.service.js`, and `metro.config.js` has
  no `watchFolders`). And more fundamentally, the mobile `result_summaries`
  table has **no `subjectBreakdown` column** — the engine's entire input is not
  mirrored to the handset. Fixing the first without the second would buy
  nothing. The mobile screen therefore still reads guidance from the server and
  labels stale data with its fetch time; **recording an intervention remains
  fully offline** through SQLite and the outbox.

### What stays with the application

Database access, authorisation, teacher and school scope, cross-school
isolation, persistence, synchronisation and intervention writes. The engine does
not know whether the caller is a teacher, an administrator or a parent, and it
must not learn — an engine that answered "may I" as well as "what does the
evidence say" would be two things, and the guard would end up with two
implementations too.

### What did not change

No threshold, confidence rule, guidance code, priority, CA treatment, zero/null/
absence/exemption rule, subject-matching rule or before/after methodology was
altered. All 225 pre-existing intelligence assertions pass unchanged, and the
parity check compares backend and shared output as serialised objects.

`shared/` is otherwise flat; `intelligence/` is a folder because it is four
files that only make sense together and are always reached as a unit.

## Visibility and authorisation — who may see what

The engine determines what the evidence means. The application determines who
may see it. The two never meet: the engine does not know whether a teacher, a
head or the platform operator is asking, and returns the same bytes to each.
`check-intelligence-access.js` asserts that literally, by fetching one pupil's
profile as all three and comparing.

| Caller | Sees | Resolved by |
|---|---|---|
| **teacher** | pupils in the classes they hold an active assignment for | `utils/teacherScope.js` per pupil; the sync feed's `taughtStudentsOnly` for a whole sheet |
| **school_admin** | every pupil in their school, whoever teaches them | tenancy alone |
| **super_admin** | the school they have selected with `?schoolId` — and no school they have not | the auth middleware: an unknown school is 404 `SCHOOL_NOT_FOUND` at the door; selecting nothing is not selecting everything |
| **bursar** | subject intelligence (it holds `results.view` already, and the module is money-free by construction); no interventions, no reviews | the capability registry |

The same hierarchy covers every intelligence surface at once — insights,
guidance, class lists, interventions and their before/after evidence, review
cases, calibration summaries and recorded reviews — because authorisation fails
at the seams: a rule enforced on one route and forgotten on the evidence route
is not a rule. The one gap the audit found was exactly that kind:
`interventions.routes.js` read `req.user.schoolId` alone, so an operator who
could see a pupil through `/insights` found that pupil had no interventions.
It now resolves the school the way every other router does.

### Reviews are school records

A teacher's recorded judgement of an engine conclusion (`IntelligenceReview`)
is named and stays named. The head reads it with the teacher's name on it; so
does the operator for the selected school. A role that may not read the pupil
gets nothing — not an anonymised copy, nothing. Writing one needs
`insights.review`; reading follows the intelligence guard.

### The review surface, in-app

The anonymised export exists so that nobody without the operator's salt can get
from a case back to a child — the right property for a file, the wrong one for
a teacher being asked "is this your pupil?". So `GET /api/insights/review-cases`
and `GET /api/insights/calibration-summary` run the identical calibration
analysis over **live** documents for a caller the server has already
authorised: `cohortFromDocuments` with the identity function where the exporter
puts its HMAC, then `analyseCohort.analyse`, then `shared/intelligence` for
every judgement. Nothing is a copy.

What those routes never carry: a salt (there is none — nothing was
anonymised), the raw cohort, a download, or any pupil the caller could not
already read through `/insights`. The exported file remains an operator
artefact that never passes through the application.


### Independent review, in-app (Stage 7C)

Reading a colleague's answer before giving your own is contamination, and the
shield against it is enforced where the package is built, not in the browser.
`reviewCases.service.reviewPackage(scope, viewer)` shapes every case for the
caller: a **teacher** who has not answered a case gets its `reviewCount` and
`reviewStatus` and an empty `reviews` list — no content, no names, no
`agreement` — and the school-wide tally is cut to the cases they have answered;
after they submit, the other reviews appear, named. A **head** or the
**operator** is not a reviewer and sees everything from the start.
`GET /api/insights/reviews/student/:id` applies the same rule and reports how
many it hid.

Writes are checked against the engine and against the record: a review must be
of a case the engine produces for that pupil today; the stored classifications
are the server's; one reviewer gets one review per case; a review is revised
by its author (`PATCH /api/insights/reviews/:id`) or by nobody, with the
replaced form kept on the row. The operator's cross-school figure,
`GET /api/super-admin/intelligence/calibration`, is gated on
`platform.dashboard` and built from review counts alone — the engine is not
run and no pupil is loaded. `check-review-workflow.js` walks all of it as the
people who will use it; `check-intelligence-access.js` holds the matrix.


### The pilot frame (Stage 7D)

A validation exercise at a school is a recorded thing: `IntelligencePilot`
holds the school, the class scope, the engine version (the server's), the kind
— `synthetic`, `development` or `real` — the state, the dates, the trail, the
evidence counts and the written decision. One open pilot per school. Only a
`real` pilot's reviews are calibration evidence, and the operator's
cross-school view says which kind each school is running.

Its state machine (`pilot.service.js`) is the only writer of `status`:
READY → ACTIVE → REVIEWING → ANALYSIS_READY → CALIBRATED | INSUFFICIENT_EVIDENCE,
any → CLOSED. CALIBRATED needs the server's own evidence snapshot to clear a
minimum gate (≥ 2 reviewers, ≥ 30 cases reviewed, ≥ 3 cases with two or more
reviews) and a written decision; nothing about a pilot changes what the engine
says. Who may act follows the one hierarchy: teachers read that a pilot is on,
`insights.pilot` (office, not delegable) runs it, the operator runs it for the
selected school, the bursar sees none of it.

`GET /api/insights/student/:id/consistency` diffs the live path against the
offline (exporter/review-sheet) path for one pupil, path by path, normalising
nothing. Its first run found the cohort contract dropping `isPassing` from each
mark — evidence, not a rule input — which is now carried; the engine was not
touched. docs/25 §12 has the checklist, the workflow and the status.


### Stage 8 — the real pilot, gated (not started)

No authorised school or reviewers were available, so no real pilot ran and no
feedback was manufactured. What exists is the gate: `GET
/api/insights/pilot/preflight` verifies every automatic precondition
(administrator present, two assigned teachers, published evidence, ≥ 30 cases,
≥ 3 multi-review-capable cases, name-free engine input, live = offline on a
sample, no salt in the package) and a `real` pilot cannot open until all pass
and the head signs two attestations. Findings live on the pilot record by
category and status, so a suspected defect becomes evidence for the post-pilot
decision rather than a change made mid-pilot. The tally keeps interpretation
disagreement, data quality, missing evidence and contextual limitation as four
separate counts. docs/25 §13 has the status and the protocol.


---

## Stage 9 — Student Strengths & Exploration Intelligence

A deterministic layer above the academic engine that answers: *what recurring
strengths, learning patterns, subject affinities and areas of exploration does
the pupil's school evidence support?* — and refuses to answer: *what career
should this pupil choose?*

```
raw school evidence → shared/intelligence (academic profile)
                    → shared/strengths     (evidence → strengths → exploration areas)
                    → human guidance
```

The academic engine is untouched and stays at `ENGINE_VERSION` 1.0.0. The new
layer has its own `STRENGTH_ENGINE_VERSION` (1.0.0) in
`shared/strengths/index.js`; a profile records both. A change to a keyword, a
weight, a threshold, a combination or an activity in the strengths layer moves
its version and not the academic one.

### The strength model

Ten **exploration dimensions** (`taxonomy.js`): quantitative reasoning,
scientific reasoning, language & communication, reading & interpretation,
analytical reasoning, creative expression, social/collaborative, technical/
applied, organisational/structured, visual/spatial. They are places where
evidence can recur, not traits. A school subject reaches a dimension through
keywords in its name (English or French) with a weight — 1 when the subject is
about the dimension, 0.5 when it draws on it. A subject that matches nothing is
still reported, as a **single-subject strength under its own name**.

For each subject the layer reads the academic engine's metrics — nothing about
marks is recomputed — and adds the reading across time:

| | |
|---|---|
| **level** | marks at or above the school's strength threshold (the academic engine's `strongMark`, from the grade bands) |
| **persistence** | none (< 2 strong marks) → *emerging* (one sequence) → *recurring* (≥ 2 sequences) → *persistent* (≥ 2 terms), over the academic ordering |
| **consistency** | spread ≤ 2 consistent, ≤ 4 moderate, else variable — the academic engine's own bands |
| **direction** | rising / sustaining / declining, from the academic `delta` (± 2) |
| **state** | ESTABLISHED (persistent, not variable, still strong) · EMERGING · DECLINING (was strong, is not now, or fell by 2) · INSUFFICIENT |

A dimension is read across every subject that speaks to it. A half-weight
subject cannot establish a dimension alone (English is about language and
only half about interpretation); it needs a primary subject or a second
subject agreeing. **Evidence against counts**: a declining or variable
supporting subject contradicts the reading and caps it at EMERGING; a
dimension whose only subjects have declined is DECLINING, never quietly
dropped. 18,18,18,18 and 20,12,19,11 share an average and not a state.

### Confidence

Confidence that the school evidence supports the reading — never talent,
career or success probability. From evidence quantity, persistence,
consistency, cross-subject support (≥ 2 subjects), coverage, and one explicit,
versioned teacher rule: at least two distinct teachers recording a
`teacher_observation` in a dimension lifts an EMERGING reading to strong.
Nothing lifts INSUFFICIENT; nothing exceeds strong; interest never counts.
Insufficient coverage in the academic profile makes the whole strengths
profile INSUFFICIENT, with the limitation named — poor data is never a
negative characteristic.

### Exploration areas

Ten broad areas (`EXPLORATION_AREAS`), each opened by one or more dimension
combinations — Mathematics + Physics opens *quantitative & scientific*, not
"engineer". Every area carries its evidence level (strong / emerging /
limited — the only ordering), the dimensions and subjects behind it (*why it
appeared*), and *ways to explore* (activities, framed as exploration, never as
proof of fit). No code in the taxonomy names a profession; the test asserts it.

### Evidence outside the marks

`ExplorationEvidence` rows: **interest** and **student_reflection** (recorded
by the pupil), **exposure**, **performance** and **teacher_observation**
(recorded by a teacher or the office), each with a dimension and/or area, an
activity, a date, participation or a reflection code. The kind a source may
record is fixed in `strengths.service.js`. The engine carries interest,
exposure and reflection as *interest signals*, apart from strengths — taking
part in the robotics club is exposure, not competence — and reads teacher
observations only under the rule above.

### The profile, and its history

`buildStrengthProfile` returns: both engine versions, the thresholds, the
grading in force, evidence coverage, overall confidence, `strengths`,
`emergingAreas`, `decliningAreas`, `singleSubjectStrengths`,
`explorationAreas`, `academicSignals` (the academic engine's own codes),
`interestSignals`, per-subject readings, `limitations`, and `notInferred`.
It carries no name; the router joins identity after authorisation.

The profile is recomputed on every read. To keep the progression visible,
`StrengthProfileSnapshot` records the reading deliberately (a teacher or the
office, e.g. at a term's end): numbered per pupil, both engine versions, the
source period, who took it, never edited. `GET …/profile` returns the current
reading and the history in order.

### Teacher confirmation

An ordinary review of category `strength` with the dimension (or subject) in
`subjectId`, verified against the current profile as an academic case is
verified against the sheet, stored with the server's reading. It is shown
beside the profile under the same shield (hidden from colleagues who have not
answered) and **changes nothing** in the engine's reading. Mapping onto the
brief's words: supported = YES, partly = PARTIALLY, not = NO, insufficient =
`evidenceSufficient: NO`.

### Routes and who may read

`GET /api/insights/student/:id/strengths | /exploration | /profile | /evidence`,
`POST …/evidence`, `POST …/profile/snapshot` (staff), and
`GET /api/portal/children/:id/strengths` for a guardian.

| Caller | Sees |
|---|---|
| teacher | pupils in the classes they hold an assignment for |
| school_admin | the school |
| super_admin | the school selected with `?schoolId`; nothing without a selection |
| bursar | nothing — holds no teaching capability |
| **student** | their own profile only — by role, as every student-facing route in the application (pupils hold no capabilities; the role matrix asserts it); another pupil's id → 403 `OWN_PROFILE_ONLY`; no teacher's review; may record interest and reflection |
| **guardian** | the children their portal access unlocks, in the plain `forGuardian` shape: dimensions, subjects by name, areas with ways to explore, limits, what is not inferred — no engine internals, no review |

### Offline

The layer is pure and lives in `shared/`. `GET …/consistency` now diffs the
strengths profile through both roads to the academic profile beneath it, with
the same evidence rows on both sides, and the top-level `identical` is the
conjunction. `ExplorationEvidence` mirrors to a teacher's machine like an
intervention; snapshots stay online (derived, recomputable).

### What the system does not infer

Every profile lists it, and the test asserts no other field mentions it:
**career, occupation, career fit, future success, personality, intelligence
quotient, mental health, learning disability, character, motivation,
discipline, leadership, fixed talent.** The wording the application uses is
"evidence suggests strength in", "recurring evidence appears in", "areas worth
exploring on current evidence" — never "is naturally", "was born to", "will
become", "should become". No LLM sits anywhere in this path.

### Limitations

Subject names are matched by keyword; a school's unusual name reaches no
dimension and is shown as a single-subject strength instead. Persistence is
read over published sequences only. Teacher observations are the only human
input to confidence, under one rule. No real pupil has yet been through this
layer — docs/25 §14 says how it will be calibrated when the real pilot runs.


---

## Stage 10 — Guided Exploration & Evidence Loop

**Exploration is evidence generation. It is not career prediction.**

Stage 9 reads what the school's records already say. Stage 10 gives the pupil
structured things to *try*, records what happened, and turns it into new
evidence — kind by kind — that a later profile snapshot can read.

```
strengths profile → suggestions (with reasons) → the pupil chooses
  → activity → outputs + reflection → optional teacher observation / rating
  → evidence rows (exposure · participation · interest · performance · observation)
  → the next profile snapshot
```

Versions: `ACADEMIC_ENGINE_VERSION` 1.0.0 and `STRENGTH_ENGINE_VERSION` 1.0.0
are untouched; `shared/exploration` carries `EXPLORATION_ENGINE_VERSION`
1.0.0, and every suggestion, exploration and evidence row records it.

### The catalog (`shared/exploration/catalog.js`)

Thirty reusable activity definitions — three levels (introductory,
intermediate, extended) in each of the strengths layer's ten exploration
areas — shipped in the code, so they are offline by construction. Each names
its task, expected outputs, the behaviours a teacher could observe, its
reflection prompts, its resources (most need paper, a phone, a group, or
nothing), its delivery mode, the evidence kinds it can produce and, where the
output is objective, the criteria a rating uses. English and French. A
definition carries nothing about any pupil; `validateActivity` refuses one
that does. A school may add its own (`ExplorationActivity`), validated the
same way.

### Five things that are never the same

| evidence | meaning | produced by |
|---|---|---|
| **exposure** | the pupil encountered the area | starting |
| **participation** | the pupil engaged in the activity | submitting |
| **interest** | the pupil wants more of it | the reflection (interest HIGH or continue YES) |
| **performance** | an observable outcome, rated against the activity's own criteria | a teacher's rating |
| **teacher observation** | an authorised adult saw something, coded | a teacher's observation |

Joining the robotics club is exposure and, once submitted, participation — not
technical strength. Each kind is its own row with an id derived from the
exploration and the kind, so a re-sent submission or observation lands on the
same row. The reflection itself is kept as the pupil's record, not as an
evidence row. Interest × performance is reported as a **pair** (`HIGH_INTEREST_
LIMITED_PERFORMANCE` …), never as a fit score.

### The recommender (`shared/exploration/recommend.js`)

Deterministic and explainable without an LLM. For N suggestions: ceil(N/2)
**aligned** with the areas the pupil's evidence opened (strong first), floor(N/4)
**adjacent** (next to an aligned area, by `ADJACENT_AREAS`), the rest
**discovery** (no evidence, fewest previous explorations first); for six,
3 / 1 / 2, with shortfall spilling discovery → adjacent → aligned and never
more than asked. Completed, abandoned and declined activities are not
suggested again; skipped ones go behind; in-progress ones are excluded; a
completed activity moves its area's next suggestion up a level. Resources
filter. Each suggestion carries `relevance`, `reasons` (RECURRING_STRENGTH,
EMERGING_STRENGTH, RELATED_EXPLORATION, NEW_DOMAIN_EXPLORATION,
STUDENT_INTEREST, PREVIOUS_ACTIVITY_FOLLOWUP, RESOURCE_AVAILABLE), the
dimensions and subjects behind it, and both versions. Interest moves an area
up within its bucket and never across: it is a reason, not evidence of
strength. A pupil strong only in Mathematics is still shown other areas — the
test asserts it.

### The pupil's record and agency

`StudentExploration`: DISCOVERED · SAVED · STARTED · SUBMITTED · REVIEW_REQUIRED ·
COMPLETED · ABANDONED · SKIPPED · NOT_INTERESTED, moved only through the
transitions in `shared/exploration`, every move on a trail. A pupil may start,
save, skip or decline any suggestion; NOT_INTERESTED is preference, not
failure, and nothing in the strengths profile moves because of it. Submitting
records outputs (what was produced) and, where the activity has rated
criteria, waits in REVIEW_REQUIRED for a teacher; otherwise it completes.

### Reflection, and who sees it

`ExplorationReflection`: controlled values (interest LOW/MODERATE/HIGH,
difficulty, continue NO/MAYBE/YES) and free text (enjoyed, difficult, next),
one per exploration, revised with the earlier account kept. **Student-private
by default**: the pupil sees all of it; staff who may read the pupil see the
controlled values, and the text only when the pupil ticked `shareText`; a
guardian sees no reflection. The collection is never mirrored to a staff
machine.

### Observation and performance

`ExplorationObservation`: OBSERVED / PARTLY_OBSERVED / NOT_OBSERVED /
INSUFFICIENT_OPPORTUNITY with codes (PROBLEM_SOLVING, PERSISTENCE,
COMMUNICATION, TECHNICAL_EXECUTION, CREATIVE_APPROACH, COLLABORATION,
EXPLANATION, ITERATION) — the only vocabulary; "natural leader" has no field.
One per teacher per exploration, revised in place. A performance rating is per
criterion (not_met / partly_met / met / exceeded) and folds to an
activity-specific level (limited / partial / demonstrated / strong); it is
never a score of the pupil.

### Boundary with the strengths engine

The exploration layer writes evidence; it never writes a strength. The
strengths engine 1.0.0 reads the kinds it already knew — interest, exposure,
reflection as signals, teacher observation under its one rule — and ignores
participation and performance until a deliberate, regression-covered 1.1.0
says otherwise. The current profile is not recomputed differently because an
activity was completed; the next snapshot reads whatever the evidence then
says. The test asserts the profile's strengths are byte-for-byte the same
before and after a completed exploration.

### Routes and authorisation

`GET /api/explorations/activities[/:id]` (catalog); `POST /api/explorations/:id/
start | skip | not-interested | abandon | submit | reflection | observation |
performance`; `GET /api/insights/student/:id/explorations[/recommended|/history]`,
`POST …/explorations` (choose), `GET …/exploration-evidence`,
`GET /api/insights/explorations/summary`; `GET /api/portal/children/:id/explorations`.

| Caller | May |
|---|---|
| **student** | read the catalog; read and act on their own explorations and reflection, by role |
| **teacher** | read/act for pupils in the classes they hold an assignment for; observe and rate |
| **school_admin** | the school; the aggregate summary |
| **super_admin** | the school selected with `?schoolId`; nothing without a selection |
| **bursar** | nothing — no teaching capability |
| **guardian** | progress on the children their portal access unlocks: status, area, evidence kinds, observation count; no reflection, outputs or trail |

Every create accepts the client's id; state moves are no-ops when already
made; evidence ids are derived — a retried or duplicated delivery does nothing
twice. `StudentExploration` and `ExplorationObservation` mirror to a
teacher's machine scoped like an intervention; `ExplorationReflection` and
`ExplorationActivity` stay online, with reasons in `syncFeed.js`.

### Monitoring

The office sees counts: pupils exploring each area, started / completed /
skipped / declined / abandoned, frequently skipped, declined and completed
activities, evidence volume. No pupil, no reflection, no ranking of pupils or
teachers.

### Limitations

The catalog is thirty activities and grows deliberately; adjacency is a fixed
map; a rating is a teacher's judgement against named criteria and nothing
more; participation and performance rows await a versioned strengths-engine
decision before they mean anything to a profile; the student experience on
mobile ships as the first screens of "Explore" and will need field use before
it is judged; no real pupil has been through the loop.

### What Stage 10 does not do

No career prediction, ranking or probability; no college recommendation; no
psychological profiling, IQ estimate or personality; no automated counselling;
no LLM anywhere in the path; no machine learning over the exploration data. A
missing signal is insufficient evidence, never absence of ability.


---

## Stage 11 — Longitudinal Evidence Fusion (Strength Engine 1.1.0)

> Strength Engine 1.1.0 introduces longitudinal fusion of authorised
> exploration evidence into strength interpretation.

Before: `ACADEMIC 1.0.0 · STRENGTH 1.0.0 · EXPLORATION 1.0.0`. After:
`ACADEMIC 1.0.0 · STRENGTH 1.1.0 · EXPLORATION 1.0.0`. The academic engine is
untouched. The exploration engine is untouched in behaviour: its recommender
gained an *optional* `saturation` input that leaves the 1.0.0 contract
identical when omitted (the service passes 2).

```
academic marks + rated exploration performance + teacher observations
  + interest / reflection + exposure / participation
    → normalise (shared/strengths/fusion.js)
    → 1.0.0 reading per dimension, kept as baseState / baseConfidence
    → fuse: one step on independent events, never past the baseline's reach
    → longitudinal profile · timeline · coverage · conflicts
    → exploration areas from the fused reading → recommendations
```

### Source semantics — what each can and cannot say

| source | authority | may |
|---|---|---|
| ACADEMIC | demonstrated school performance | establish or retire a strength alone — the baseline |
| EXPLORATION_PERFORMANCE | demonstrated performance in a defined activity, rated against its criteria | move a reading **one step** on ≥ 2 independent events; lower confidence on ≥ 2 contradicting |
| TEACHER_OBSERVATION | contextual human observation | the one 1.0.0 rule, unchanged: two distinct observers lift EMERGING to strong |
| STUDENT_INTEREST | stated preference | an interest signal — never ability |
| STUDENT_REFLECTION | self-reported experience | coverage — never ability |
| EXPOSURE | encountered the domain | coverage — never ability |
| PARTICIPATION | engaged with the activity | coverage — never ability |

### Evidence grouping — one event is one event

Rows share an `eventId` (the exploration's id). An event has at most one
performance direction (strong / demonstrated → *supports*; limited →
*contradicts*; partial → neutral), one interest signal and a set of distinct
observers. Two supporting events are two activities. The same rows delivered
twice are rejected as duplicates; a kind the layer does not know is rejected
and named. Every fused item keeps `evidenceId`, `sourceType`, `sourceId`,
`eventId`, `dimension`, `timestamp`, `recency` and `provenance`.

### Transitions fusion may make

| from | to | on |
|---|---|---|
| INSUFFICIENT | EMERGING | ≥ 2 independent supporting events, none contradicting |
| EMERGING | ESTABLISHED | ≥ 2 independent supporting events, none contradicting |
| EMERGING | (stays) confidence −1 | ≥ 2 contradicting events outnumbering support |
| ESTABLISHED | (stays) confidence −1 | ≥ 2 contradicting events and no support — reported as a conflict |
| DECLINING | (stays) | supporting events are reported as a conflict, not a rescue |
| INSUFFICIENT | ESTABLISHED | **never**, from exploration alone |

One successful activity establishes nothing; one unsuccessful activity
disproves nothing; five successes still cap at EMERGING without academic
support. Skipped, declined and abandoned activities produce no performance row
and weaken nothing.

### Recency

RECENT ≤ 120 days before `asOf`; HISTORICAL ≤ 365; STALE beyond — kept on the
record and on the timeline, counted in nothing. An unreadable date is STALE.
`asOf` is an input (the service passes the start of today, the same value on
both roads of the consistency check), so a profile is a function of its inputs
and never of the clock.

### Coverage, confidence, contradiction

**Coverage** is how much evidence there is, by source — academic
sequences/subjects, exploration events, observers, interest/reflection/
exposure/participation rows, stale rows, the sources present, an overall band
(none / thin / moderate / broad). It is never a score of the pupil.
**Confidence** keeps its meaning — confidence that the evidence supports the
reading — and moves one band at a time. **Contradictions** are reported as
patterns (`ACADEMIC_VS_EXPLORATION`, `EXPLORATION_MIXED`,
`OBSERVATION_VS_PERFORMANCE`, `INTEREST_VS_PERFORMANCE`) with the counts
behind them; nothing resolves them into "suited" or "not suited". The interest
× performance pair from Stage 10 is carried on every dimension that has both.

### Timeline, snapshots, comparison

Per dimension: academic periods at strength, then events by date with source
and reading, then the profile's reading with its state source. Snapshots
(`StrengthProfileSnapshot`) now carry all three engine versions, `asOf`, and an
**evidence boundary** (row count, latest evidence date, academic period, a hash
of exactly which rows). `POST …/profile/rebuild` is idempotent on that
boundary — unchanged evidence returns the snapshot that already covers it —
takes the server's engine versions only, and never touches an old snapshot.
`compareProfiles` says what changed — new strengths, strengthened, unchanged,
weakened, new emerging, declining, new contradictions, coverage change — with
structured reason codes (`EXPLORATION_SUPPORT:2`, `TEACHER_OBSERVERS:2`,
`ACADEMIC_PERSISTENT`, …). No improvement score. A retracted evidence row
changes the next reading and not the old snapshot.

### Rebuild semantics

Snapshots are taken by staff (rebuild), never on every write. `GET
…/profile/changes` says whether one is pending (the boundary moved) and lists
the evidence that arrived since; the pupil's phone shows it as "Your profile
has been updated — based on evidence", the teacher's page as previous →
current with reasons.

### Recommendation feedback

The recommender reads the fused profile; it interprets no evidence itself.
Every reason is an evidence reason. With `saturation` (2), an aligned area
with two completed activities yields its slot to adjacent and discovery areas;
the pupil can still open it from the catalog. "Recommended because it was
recommended" cannot occur.

### Routes and authorisation

`GET …/profile/timeline`, `GET …/profile/changes`, `GET …/profile/evidence`
(the pupil by role for their own; staff on `insights.viewTaught` for pupils
they may read; operator by selection; bursar out), `POST …/profile/rebuild`
(staff). The guardian's views are unchanged. The engine receives normalised
rows: no name, no contact, no note text.

### Offline

`GET …/consistency` diffs the fused profile through both roads with one
`asOf`: states, base states, evidence items, coverage, contradictions,
timeline. A structural difference fails.

## What evidence fusion does not mean

- Exploration evidence does not prove innate talent.
- Interest does not prove ability.
- Participation does not prove competence.
- One successful activity does not establish a strength.
- One unsuccessful activity does not disprove a strength.
- Teacher observation is contextual evidence, not absolute ground truth.
- The system does not determine a student's career.

### Limitations

Direction is read from a teacher's rating against an activity's own criteria;
adjacency and windows are fixed numbers awaiting calibration; participation and
exposure are coverage only; the pair is reported, not weighed; no real pupil
has been through the fused engine — real evidence enters through the Stage 8
pilot and nothing else.


---

## Stage 12 — Comprehensive Learning Evidence Intelligence

**More data ≠ more intelligence.** Stage 12 adds a deterministic
Learning Evidence layer (`shared/learningEvidence`, `LEARNING_EVIDENCE_VERSION`
1.0.0) that represents the school's ordinary records — homework, quiz
attempts, tests, continuous assessment, practicals, attendance — as events
with their observations kept apart, reads longitudinal patterns only where the
evidence suffices, states coverage and contradictions, and hands the existing
engines **nothing** until a versioned decision says otherwise. The academic,
strengths and exploration engines are unchanged. docs/26 holds the audit, the
taxonomy, the state vocabulary, the thresholds, the boundary, the privacy and
offline rules, and what the layer does not infer.
