# 39 — Academic architecture audit

An audit of how OfflineSchoolApp models academic structure, assessment,
grading, results, ranking, promotion and report cards, and a staged plan for
making those rules configurable per school without changing what any existing
result means.

- **Branch:** `academic-architecture-audit`, from `cold-intelligence-analysis`
  @ `71a023d`.
- **Kind of change:** documentation only. No application code, schema, test,
  or dependency was changed.
- **Goal, as set:** *configurable academic rules, stable underlying
  data/evidence contracts.*
- **Method:** read the models, services, routes, renderers, clients and
  tests; ran two in-memory reproductions where reading alone could not settle
  a fact (§4.1, §17.3). Every claim below carries a `file:line` reference or
  says it was not verified.

> **Correction (found while starting Phase 2c, pinned in `check:academic`).**
> There are **two** code paths that compute sequence results, and this audit
> first described the wrong one as live:
>
> - `results.service.processResults` (CA blend, coefficients, GPA-point
>   average) is **not reachable over HTTP and never has been**. Its only
>   caller, `results.controller.computeResults`, is not mounted on any
>   router. `git log -S` over every branch finds no route that ever
>   referenced it.
> - **`POST /api/exams/:examId/process`** (`exam.routes.js:1539-1760`) is
>   what web, mobile and desktop call. Every real `ResultSummary` came from
>   it. It ignores CA and coefficients, counts an absent subject as zero,
>   stores a whole-number raw-mark mean, and writes no `academicYear`, so
>   the promotion run sees no results at all.
>
> So **§4.1 is real but describes the unrouted path**, and the defects that
> affect real data are in **§4.7**. Read §4.7 first. The conclusion stands:
> the current behaviour cannot be "represented as configuration" without
> first deciding which calculation is authoritative (§21 D1, revised).

---

## 1. Current architecture

### 1.1 What the chain actually is

The prompt's working hypothesis was
`AcademicYear → Term → Sequence → CA/Exam → Result → Report Card`. The code
is close to that, but **none of the upper levels are entities**, and nothing
references the academic structure by id:

```
School ─────────────── settings.academicYear "2026/2027" (string)  settings.currentTerm "Term 1" (label enum)
  │
  ├─ GradingConfig            one per school, unversioned (unique schoolId)
  │     bands /20 · passMark · showGrades · CA on/off + CA/Test split · dead weight fields
  │
  ├─ AcademicStructure        one per (school, academicYear string)
  │     terms[1..3] { weight, sequences[1..6] { weight, assessment{type,label} } }
  │     annualAverageMethod · promotionExams · promotionThreshold(/20) · passMark(/20) · maxAbsences
  │
  └─ Exam  (= one assessment occasion)       ── bound to the structure ONLY by matching numbers:
        academicYear (string) · term (1..3) · sequenceNumber (1..6 | null)
        type ∈ {test, practical, promotion_exam, ca} · parentExamId (CA → its paper)
        │
        ├─ ExamSubject (exam × subject × class)   maxScore · passMark · weight (= coefficient × 100)
        │                                          teacher · submission workflow
        ├─ ExamMark    (teacher submission layer; not synced; not read by results)
        └─ StudentScore (exam × student × subject)  raw score · maxScore · absent/exempt
              │                                      + grade/remark/points written back (default scale)
              ▼
        ResultSummary (exam × student)       the SEQUENCE result: CA blended into the paper's row
              │  average (GPA points 0–4!) · subjectBreakdown[] (/20 marks, CA parts) · positions
              ▼
        TermResult (school, year, term, class, student)      termAverage · sequenceAverages[] · position
              ▼
        AnnualResult (school, year, class, student)          annualAverage · termAverages[] · promotionStatus
              ▼
        PromotionRun / PromotionDecision                     (reads ResultSummary, not AnnualResult)

Report cards: sequence ← ResultSummary + live StudentScores
              term     ← TermResult (headline) + live StudentScores (rows)
              annual   ← AnnualResult (headline) + live StudentScores (rows)
```

Evidence:

| Fact | Where |
|---|---|
| Academic year is a string on every record; no AcademicYear entity | `School.js:77-86`, `Exam.js:64`, `AcademicStructure.js:61` |
| Terms and sequences are numbers with hard bounds | `AcademicStructure.js:36,46`, `Exam.js:56-65`, `TermResult.js:31` |
| Exam ↔ structure binding is by (year, term, sequenceNumber) match, no id | `termGrading.service.js:60-110`, `reportCardData.service.js:360-375` |
| Terms/sequences are nested arrays with no ids | `AcademicStructure.js:32-53` |
| `Period` is a **timetable slot** (HH:MM), not an academic period | `Period.js:15-58`, `web/src/pages/periods/index.tsx:2` |
| CA is a separate `Exam{type:"ca", parentExamId}` blended into the paper's summary | `shared/caAssessment.js:1-40`, `results.service.js:96,186-212` |
| Term result reads only non-CA papers' summaries | `termGrading.service.js:77-95` |
| Promotion reads published `ResultSummary`, not `AnnualResult` | `promotion.service.js:51-68` |
| `Grade` model (`examType: test/midterm/final/assignment/quiz`) is legacy: synced (`syncFeed.js:300`) but read by no backend code | grep, this audit |

### 1.2 The calculations, as they run

**Two writers of the sequence result (see the correction at the top).**
The table below is `results.service.processResults`, which is **unrouted**.
The live writer is `POST /exams/:examId/process`. Per subject it computes
`normalizedMark = round(round(score/max·100)/100·20, 1 dp)`; grade and pass
come from `computeGrade`, which uses the school's bands (falling back to the
built-in table) and the school's `passMark`. The summary `average` is
`Math.round(Σ raw scores / number of subjects)`, counting absent subjects as
zero. Overall grade and pass come from `computeGrade(Σ score, Σ max)`.
Positions are competition ranking on integer `percentage`, class only. There
is no CA, no coefficient, and no `academicYear`/`term` on the row. Term,
annual, cards and promotion (rows below "Term average") are shared by both.

| Step | Function | Rule |
|---|---|---|
| Subject mark | `grading.normalizeTo20` `grading.service.js:56-61` | `score/maxScore×20`, `Math.round(x·100)/100` |
| CA blend | `sequenceAssessment.blendSubject` `:289` → `caAssessment.combineSequenceMark` `:202` | weights from `GradingConfig.caWeight/testWeight`; a missing part is dropped and the weights renormalised (not zero) |
| Subject grade/pass | `grading.gradeSubject` `:102-127` | **built-in** scale `shared/gradeScale.GRADE_SCALE`; pass = **hard-coded** `≥ 10/20` (`:46`) |
| Sequence average | `grading.calculateOverallResult` `:150-280` | coefficient-weighted mean of **GPA points** (0–4); overall grade = `lookupGrade(avg×5)`; pass = `avg ≥ 2.0` |
| Sequence rank | `results.service.js:321-382` | competition ranking (1,1,3) on `average` (GPA points) within class, "grade" (= same `className`), school; fully-absent pupils unranked |
| Term average | `termGrading.termResultFields` `:121-171` | sequence-weight-weighted mean of `ResultSummary.average`; grade `lookupGrade(avg)` on /20; pass = `avg ≥ GradingConfig.passMark` |
| Term rank | `termGrading.computeTermPositions` `:360-399` | competition ranking within class only |
| Annual average | `annualGrading.annualRowFor` `:100-157` | term-weight-weighted mean of `termAverage`; pass `≥ GradingConfig.passMark` |
| Annual promotion status | same, `:136-154` | all 3 terms passed AND each promotion exam `average ≥ AcademicStructure.promotionThreshold` |
| Promotion proposal | `promotion.proposeFor` `promotion.service.js:82-124` | if `Class.promotionAverage` (0–100) set: mean of published `ResultSummary.average` vs it; else majority of published summaries passing |
| Card subject rows (term/annual) | `reportCardData.subjectRowsFor` `:192-238` | rebuilt live from marks; grade from the school's **current** `GradingConfig.grades`; pass `≥ current passMark` |

---

## 2. Current hardcoded assumptions

Classification key: **A** core domain logic · **B** UI presentation · **C**
API contract · **D** historical compatibility · **E** test/fixture · **F**
hardcoded business rule · **G** configuration · **H** intelligence dependency.

### 2.1 Against the questions asked

| Assumption | Holds today? | Where (class) |
|---|---|---|
| Every school has the same academic periods | **Yes**: ≤3 terms, ≤6 sequences, numbered | `AcademicStructure.js:36,46` (F); `Exam.js:56-65` (A,C); `TermResult.js:31` (A); `exam.constants.ts:42-65` SEQUENCE_MAP (B,F); `exams/term-results/index.tsx:32-34` (B); mobile `create.js:43-46` (B); `cohortSchema.js:153-156` (H) |
| Every period has sequences | **Yes** for term results: a term with no sequence has no exams to average | `termGrading.service.js:74-95` (A) |
| Every sequence has CA/exam | **No, already configurable**: `caEnabled` and per-sequence CA presence; missing CA renormalises | `GradingConfig.js:74`, `caAssessment.js` (G) |
| Every assessment is an exam | **Structurally yes**: an assessment *is* an `Exam` row with `type` from a closed enum of 4 | `Exam.js:14` (C,F); `AcademicStructure.js:11` (G); `learningEvidence/taxonomy.js:42-47` (H) |
| Every result uses the same calculation | **Yes**: one code path, no per-school variation except CA split, sequence/term weights, coefficients | `grading.service.js` (A,F) |
| Every school uses the same grading scale | **For stored results, yes**: `grading.service` uses the built-in scale; school bands apply only at render time | `grading.service.js:38,68-81` vs `reportCardData.service.js:210` (F) |
| Every school ranks students | **Yes**: always computed, always printed | `results.service.js:321-382`, `reportHtml.service.js:574-621` (A,B,F) |
| Every school promotes by the same rule | **Yes**, with a per-class average bar | `promotion.service.js:82-124` (F), `Class.promotionAverage` (G) |
| Every report card has the same sections | **Built-in renderer: yes.** A school may replace the whole card with an HTML token template | `reportHtml.service.js:323-977` (B,F); `ReportTemplate.js` (G) |
| The mark scale is /20 | **Yes, everywhere** | `grading.service.js:56`, `GradingConfig` bands (G but /20-bound), `reportCard.js:179-185`, `subjectInsights.js:467` SCALE=20 (H), `cohortSchema.js:249-254` (H), `SettingsPage.tsx` `max=20` (B), `AcademicStructureSection.tsx:417,432` (B) |
| Pass mark is 10/20 | **Mixed**: hard-coded in `grading.service.js:46`, `reportCardData.service.js:780`, `reportHtml.service.js:495`; configurable in `GradingConfig.passMark` and **again** in `AcademicStructure.passMark` (two sources) | (F, G) |
| The header is Cameroonian and bilingual | **Yes**, not configurable | `shared/officialHeader.js:58-105` (B,F) |

### 2.2 Search terms, classified

Only the occurrences that matter for the design are listed. Occurrences in
comments, labels and i18n strings are B and are not enumerated.

| Term | Representative occurrences | Class |
|---|---|---|
| `term` (1–3) | `Exam.term`, `TermResult.term`, `AnnualResult.termAverages[].term`, `GradingConfig.termWeights` (dead) | A, C, D |
| `term` label | `School.settings.currentTerm` enum incl. "Semester 1/2" (`School.js:88-98`); `School.termSystem` trimester/semester/quarter (`:390`), read by nothing in calculation | G (unused) |
| `sequence` (1–6) | `Exam.sequenceNumber`, `AcademicStructure.terms[].sequences[]`, `TermResult.sequenceAverages`, template tokens `sequence1..6Average` (`reportHtml.service.js:1208-1229`, `placeholder.engine.js:345-380`) | A, C, B |
| `CA` | `Exam.type "ca"`, `parentExamId`, `GradingConfig.caEnabled/caWeight/testWeight`, `ResultSummary.subjectBreakdown.ca*` | A, G, H |
| `exam`/`test` | `Exam` model name and API paths (`/api/exams`) | C |
| `midterm`/`final` | only the legacy `Grade.examType` enum | D |
| `annual` | `AnnualResult`, `reportTypeFor(promotion_exam) → "annual"` (`shared/reportCard.js:33`) | A |
| `semester`/`quarter` | settings labels only | B, G (unused) |
| `maximum mark` | `ExamSubject.maxScore` (default 100), `StudentScore.maxScore`, `Exam.totalMarks` (unused in calc) | A, C |
| `pass mark` | see §2.1 | A, F, G |
| `grade` | `GradingConfig.grades`, `shared/gradeScale.js` | A, G |
| `coefficient` | `Subject.coefficient` (×1), `ExamSubject.weight` (×100), `subjectCoefficient.service.js` | A, G |
| `rank`/`position` | `ResultSummary.class/grade/schoolPosition`, `TermResult/AnnualResult.class/schoolPosition` | A, B |
| `promotion` | `AcademicStructure.promotion*`, `Class.promotionAverage/nextClassId/isFinalYear`, `AnnualResult.promotionStatus`, `ResultSummary.promotionStatus` (never written), `PromotionRun/Decision` | A, F, G |
| Tests | `check-term-compute.js`, `check-term-annual-cards.js`, `check-ca-assessment.js`, `check-coefficients.js`, `check-report-card.js`, `seed-academic-structure.js` | E |

---

## 3. Current configurable capabilities

What a school can already change without code, and where:

| Capability | Stored in | Edited in | Actually used by |
|---|---|---|---|
| Term names and weights (≤3) | `AcademicStructure.terms[]` | web Settings → Academic structure | term/annual compute, card headers |
| Sequence names and weights (≤6, any count per term) | `AcademicStructure.terms[].sequences[]` | same | term compute, term card columns |
| Assessment type label per sequence | `sequences[].assessment` | same | **nothing in calculation** (descriptive) |
| Annual method `terms`/`sequences` | `annualAverageMethod` | same | **nothing**: `annualGrading` always uses terms (untested, `docs/12:263`, `docs/19` D7) |
| `maxAbsences` | `AcademicStructure` | same | **nothing** |
| Promotion exams + threshold | `promotionExams`, `promotionThreshold` | same | `annualGrading` promotion status |
| Grade bands, remarks (EN/FR) | `GradingConfig.grades` | web Settings → Grading | report card rendering, intelligence band floors; **not** stored grades |
| Pass mark | `GradingConfig.passMark` and `AcademicStructure.passMark` | both screens | term/annual pass, card subject pass, intelligence (GradingConfig first, then AcademicStructure) |
| Show grades | `GradingConfig.showGrades` | Grading | cards |
| CA on/off, CA/Test split | `GradingConfig.caEnabled/caWeight/testWeight` | Grading | sequence blend, term card weights |
| `useGpa`, `gpaScale`, `gradingType` | `GradingConfig` | Grading | **nothing** in calculation |
| `sequenceWeights`, `termWeights`, `*WeightingMethod` | `GradingConfig` | not exposed | **nothing** (dead; the live weights are in AcademicStructure) |
| Subject coefficient | `Subject.coefficient` → `ExamSubject.weight` | subjects, exam subject editor | sequence average, card rows |
| Per-subject max mark, pass mark | `ExamSubject.maxScore`, `passMark` | exam editor | `maxScore` yes; `ExamSubject.passMark` **no** (grading uses 10/20) |
| Promotion average per class (0–100) | `Class.promotionAverage` | Promotion → Progression | promotion proposal |
| Class progression | `Class.nextClassId`, `isFinalYear` | same | promotion proposal |
| Whole report card layout | `ReportTemplate.html/css` (token template) | Reports → Builder | rendering, when a default template exists |

So the system is **already partly configurable**, but the configuration is
spread over five documents (`School.settings`, `GradingConfig`,
`AcademicStructure`, `Class`, `ReportTemplate`), some of it is dead, and
none of it is versioned.

---

## 4. Problems with the current model

Ordered by consequence. §4.1–§4.4 are defects in current behaviour, found
during the audit. They are **reported, not fixed**: fixing any of them
changes stored or printed results, which this task forbids.

### 4.1 The sequence average is GPA points; everything above it reads it as /20 — **reproduced, on the unrouted path**

> Applies to results computed by `results.service.processResults`, which no
> route reaches (correction at the top). Real data comes from
> `POST /exams/:examId/process`, whose average is on a raw-mark scale (§4.7).
> This section stays as the description of the path the tests exercise and
> that `check:ca` relies on.

`calculateOverallResult` stores `ResultSummary.average` as the
coefficient-weighted mean of **GPA points** (0–4) (`grading.service.js:240-256`,
`results.service.js:288`). `shared/reportCard.js:165-185` documents this and
multiplies by 5 for sequence cards. But:

- `termGrading.termResultFields` averages `summary.average` as if /20, grades it
  with `lookupGrade` on /20 and passes it against `passMark` 10
  (`termGrading.service.js:136-171`);
- `annualGrading` does the same one level up and derives promotion status
  from it (`annualGrading.service.js:111-154`);
- `promotion.resultsByStudent` averages `ResultSummary.average` and compares it
  with `Class.promotionAverage`, entered as 0–100 (`promotion.service.js:51-68,94-108`,
  `web/src/pages/promotion/progression.tsx:176-189`);
- the annual promotion-exam check compares `ResultSummary.average` with
  `promotionThreshold` (/20) (`annualGrading.service.js:142-147`);
- the sequence card's **headline grade** is looked up on the un-multiplied GPA
  value (`results.controller.js:474-475,736-741`), while its printed average is
  the /20 weighted mean (`:649-651`).

**Reproduction** (scratch script, in-memory MongoDB, real services; not
committed): one pupil, two sequences of term 1, CA off, Maths 15/20 coefficient
2, English 9/20 coefficient 1.

```
ResultSummary.average per sequence: [ 2.53, 2.53 ]  grade: [ 'B', 'B' ]  isPassing: [ true, true ]
coefficient-weighted /20 mean of the marks: 13.00
TermResult: {"termAverage":2.53,"overallGrade":"F","isPassing":false,"seq":[2.53,2.53]}
```

A pupil who passes both sequences with B is stored as failing the term with
F. The term card prints `2.53 /20`, F, "Failed" and ranks on it, above subject
rows that say ≈13/20 (report-card trace: `reportCardData.service.js:469-479`,
`reportHtml.service.js:221-230,589-593`). The QR verification snapshot carries
the same figures (`reportCardData.service.js:776-824`).

The existing tests do not catch this because they seed `ResultSummary.average`
directly on /20 (`check-term-compute.js:108-111`, `check-term-annual-cards.js:96-103`)
instead of producing it through `processResults`.

**Not verified:** what live school data contains. If any term or annual
results were published from summaries computed this way, they carry this
meaning, and §9 treats them as historical facts to be preserved and
flagged, not silently recalculated.

### 4.2 Two grading authorities

- **Stored** grades, remarks and pass flags: built-in scale and hard-coded
  10/20 (`grading.service.js:38,46,102-127`; written back to `StudentScore` at
  `results.service.js:230-250`).
- **Printed** grades and pass flags on term/annual rows: the school's
  *current* `GradingConfig.grades` and `passMark`, at render time
  (`reportCardData.service.js:192-251`).

The prompt's rule that "the grading system must remain the authoritative
source" is not met today. There are two systems, and the one a school
configures is not the one that writes results. Re-rendering an old card
after a band change prints different grades.

### 4.3 Nothing is versioned, and published results are not protected from recomputation

- `GradingConfig` is one mutable document per school (`GradingConfig.js:35`,
  `unique: true`). `AcademicStructure` is per year but mutable in place
  (`academicStructure.routes.js:104-108`). `ReportTemplate.version` is a
  counter over an overwritten `html` (`template.routes.js:286-296`).
- Results record no configuration identity at all.
- `processResults` rewrites `isPublished:false, isLocked:false` on every
  recompute (`results.service.js:309-310`), and `POST /exams/:id/process`
  runs it without the result-write guard (`exam.routes.js:1539+`).
- Term and annual recompute overwrites published rows (`termGrading.service.js:266-330`,
  `annualGrading.service.js:223-334`). `TermResult/AnnualResult.isLocked`
  exists and nothing sets or enforces it. Publish has no audit row, and
  `ResultChangeLog.entity` has no term/annual value (`ResultChangeLog.js:39`).
- Only **sequence** cards are frozen at issue (`GeneratedReport`,
  `results.controller.js:847-887`). Term and annual cards re-render live.
  The QR snapshot is refreshed on **every** render, including previews
  (`documentVerify.service.js:66-78`).

Today, "which configuration produced this result?" has no answer.

### 4.4 Promotion is decided in three places with three rules

1. `AnnualResult.promotionStatus`: all terms passed plus promotion exams
   (`annualGrading.service.js:136-154`).
2. `PromotionDecision`: per-class average or majority of published summaries
   (`promotion.service.js:82-124`). This is what moves pupils.
3. `ResultSummary.promotionStatus`: a field nothing writes.

Annual cards print (1) (`reportCardData.service.js:575-623`). The rollover
acts on (2). They can disagree, and both are affected by §4.1.

### 4.5 Structural rigidity

- Period identity is a number. Six sequences in three terms is a schema bound,
  repeated in clients, the cohort export format and template tokens.
- An assessment can be only one of four types. "Assignment", "project",
  "oral" or "homework" as a *graded component* has nowhere to go (`ExamSubject.isOral`
  and `isPractical` are flags that nothing calculates with).
- Component weighting exists for exactly two parts (CA and paper), stored on
  the grading config rather than the structure. Sequence and term weights are
  on the structure, and dead copies sit on the grading config.
- The "grade" ranking scope groups by `className` string
  (`results.service.js:357`), which is the class again under another name.

### 4.6 Other defects found on the way (reported, not fixed)

| # | Finding | Evidence | Verified |
|---|---|---|---|
| a | Bulk-score validation checks against the **client-sent** `maxScore` but stores the ExamSubject's | `exam.routes.js:1318` vs `:1393` | code reading |
| b | Desktop offline grading looks up GradingConfig by `_id = schoolId`, so it never finds the school's bands | `desktop/src/main/api/writes/exams.js:402`, `store.js:369-374` | code reading |
| c | Mobile carries a divergent 7-band scale for its offline card fallback | `mobile/src/services/report.data.service.js:886-925` | code reading (sync audit) |
| d | Strengths engine counts CA twice: CA events (family `continuous`) are corroboration though CA is already blended into the academic mark | `shared/strengths/learningIntegration.js:86,124` | code reading; not reproduced |
| e | `results.controller` calls `processResults({examId,…})` with an object | `results.controller.js:1369` | code reading; route reachability not traced |
| f | Reissued sequence cards lose the letterhead and QR, and no audit row is written | `results.controller.js:1038-1042` | report-card audit |
| g | `POST /api/generated-reports` can `$set` client HTML over a frozen record | `generated.report.routes.js:48-144` | report-card audit |
| h | Annual card's French remark reads `termAverage ?? annualAverage` | `reportCardData.service.js:580` | code reading |
| i | Super admin with no school selected: academic-structure, term, annual and promotion routes refuse with 400; `/api/exams` and `/api/templates` have no explicit guard. **Tested:** `Exam.countDocuments({schoolId: undefined})` across two schools returns **0** on Mongoose 9.9.1, so the list fails closed by accident, not by design. **Fixed in Phase 2(e)** (§17.4) | `exam.routes.js:20-23,194-200`; scratch probe | probe |
| j | Teachers lack `settings.view` (ADMIN only, delegable) and cannot read `AcademicStructure` over REST, yet the desktop feed ships it to `exams.view` | `permissions.js:329`, `syncFeed.js:295` | code reading |
| k | A pupil with **no term result** is written an `AnnualResult` of 0, grade F, and ranked last; the term layer deliberately writes no row in that case | `annualGrading.service.js` `computeClassAnnualAverages` (one op per active pupil) | **pinned** in `check:academic` |
| l | The sequence card's subject pass flag is the paper's `StudentScore.isPassing`, not the blended mark the row prints: CA 12/20 + paper 9/20 → 10.2, grade C, "not passing" against a pass mark of 10 | `results.controller.js:612` | **pinned** in `check:academic` |

---

### 4.7 The live route: what real results are made of — **reproduced over HTTP**

`check:academic` builds the same synthetic school twice. The second copy is
processed through `POST /api/exams/:examId/process` with the real router and
auth, exactly as the apps send it. One pupil, Ama, has Maths 15/20
(coefficient 2) with CA 8/10, and English 9/20 with CA 6/10:

| | Unrouted `processResults` | **Live `/process`** |
|---|---|---|
| Maths / English subject mark | 15.4 / 10.2 (CA blended) | **15 / 9** (paper only) |
| Coefficient carried | 2 | **1** (not set) |
| Stored `average` | 2.87 (GPA points) | **12** = `round((15+9)/2)` |
| English | C, passing | **D, failing** |
| Term 1 | 3.09, F, failing | **13, B, passing** |
| Annual | 2.73, F, repeated | **12, B, promoted** |

Defects on the live route, each pinned:

- **(a) CA is ignored in every stored figure.** `GradingConfig.caEnabled`
  defaults to `true`, and CA exams are created alongside sequence papers.
  Their marks reach the sequence **card**, which rebuilds rows from marks,
  but never the stored summary, term or annual result, ranks, promotion, or
  intelligence.
- **(b) Coefficients are ignored** in every stored figure. The card applies
  them.
- **(c) An absent subject counts as zero** in the average (`round(11/2) = 6`
  for a pupil absent in Maths, giving F). Its maximum also stays in the
  percentage.
- **(d) Averages are whole numbers.** `Math.round` of a raw-mark mean, on the
  scale the papers are marked on (/20 here; /100 if papers are /100, the
  `ExamSubject.maxScore` default). Term and annual results then read it as
  /20.
- **(e) No `academicYear` or `term` on the summary**, and nothing backfills
  them. `promotion.resultsByStudent` selects published summaries by
  `academicYear`, so **the promotion run finds no results for any pupil**.
  Every pupil is proposed on basis `no_results`, which means "promoted"
  wherever the class has a next class. That includes a pupil the annual
  results mark "repeated".
- **(f) The sequence card contradicts the stored result.** It prints 13.67
  (rebuilt from marks, with CA and coefficients) as the average, above a
  grade (B) and position taken from the stored 12.
- **(g) Re-processing a published exam rewrites its figures** with no guard
  and no `ResultChangeLog` row. Unlike `processResults`, it leaves
  `isPublished` alone.

The intelligence layer reads `subjectBreakdown.normalizedMark`. On real data
that is the paper-only mark, rounded to one decimal, not the CA-blended mark
that §15 assumed. The engines' semantics are unchanged; their input is
simply not what the CA work intended.

## 5. Proposed target architecture

### 5.1 Principle

Separate three things that are currently mixed:

1. **Evidence**: what was assessed and what the pupil scored. Raw,
   append-audited, never reinterpreted. `Exam`, `ExamSubject`, `StudentScore`
   already are this.
2. **Policy**: how evidence becomes results. Structure, weights, grading,
   ranking, promotion. Editable as a *draft*; **frozen into an immutable
   snapshot** whenever it is used to compute something that may be published.
3. **Derived results and documents**: `ResultSummary`, `TermResult`,
   `AnnualResult`, report cards. Each stamped with the snapshot that
   produced it, and never recomputed after publication except by an explicit,
   audited reissue.

```
          editable (draft)                          immutable                        derived, stamped
┌───────────────────────────────┐   freeze    ┌──────────────────────────┐   compute   ┌─────────────────────────┐
│ AcademicStructure (per year)  │ ──────────► │ AcademicPolicySnapshot   │ ──────────► │ ResultSummary            │
│  periods · components ·       │             │  hash = sha256(canonical │             │ TermResult  / Period res.│
│  ranking · promotion          │             │  resolved policy)        │             │ AnnualResult             │
│ GradingConfig (per school)    │ ──────────► │  structure · grading ·   │             │   policyHash             │
│  bands · scale · pass · round │             │  ranking · promotion ·   │             │   calcVersion            │
└───────────────────────────────┘             │  calcVersion             │             └───────────┬─────────────┘
┌───────────────────────────────┐   freeze    ├──────────────────────────┤                         │ issue
│ ReportTemplate (draft)        │ ──────────► │ ReportTemplateVersion    │ ────────────────────────┤
└───────────────────────────────┘             └──────────────────────────┘                         ▼
                                                                                  GeneratedReport (frozen HTML,
   Evidence (unchanged): Exam (= Assessment) · ExamSubject · StudentScore         payload hash, policyHash,
                                                                                  templateVersionId) + QR snapshot
```

### 5.2 What is deliberately *not* proposed

- **No new Assessment collection, and no rename of `Exam`.** `Exam` already is
  an assessment occasion with subjects, marks, permissions, an offline queue
  and sync rules. Renaming it would touch every client, the sync feed and the
  cohort export for no behavioural gain. "Assessment" becomes the domain and
  UI term. `/api/assessments` can later be an alias.
- **No rules engine.** Ranking and promotion get a small closed set of
  policies. A new policy is a code change plus an enum value, on purpose.
- **No separate AcademicYear, AcademicPeriod, AssessmentType, RankingConfig or
  PromotionConfig collections.** Each would add a join on every computation
  and a sync collection, and none has an independent lifecycle. They are
  sub-documents of the per-year `AcademicStructure` and are versioned
  together by the snapshot.
- **No drag-and-drop template editor.**

---

## 6. Proposed domain model

Each entity is listed with the problem it solves (§4). "New" means a new
collection.

### 6.1 `AcademicStructure` (evolved in place, schemaVersion 2)

- **Purpose:** the school's academic calendar and assessment plan for one
  year. **Solves** §4.5.
- **Ownership / scope:** one per (`schoolId`, `academicYear`), as today.
- **Fields added** (all existing fields kept):

```js
schemaVersion: 2,
periods: [{                       // replaces numbered terms/sequences as the source of truth
  key:   "t1",                    // stable, unique within the document; referenced by Exam.periodKey
  name:  "First Term", nameFr: "Premier Trimestre",
  kind:  "term" | "semester" | "quarter" | "sequence" | "custom",
  parentKey: null | "t1",         // a sequence sits under a term; a semester has no parent
  order: 1,
  weight: 33.33,                  // share in the parent (or in the annual result for a root)
  contributesToAnnual: true,
  startDate: "2026-09-07", endDate: "2026-12-18",   // optional calendar (today: derived from exams)
  scored: true,                   // a period whose assessments produce a period result (today: sequences)
  components: [{                  // only on scored periods
    key: "ca", name: "Continuous assessment",
    assessmentType: "ca",         // from assessmentTypes below
    weight: 40,                   // share of the period result
    defaultMaxMark: 20,
    required: false,              // missing → renormalise (today's CA rule) vs missing → incomplete
  }],
  legacy: { term: 1, sequence: null },   // the numbers existing readers use; generated, never edited
}],
assessmentTypes: [                // open list; built-ins seeded, school may add
  { key: "test", name: "Test", family: "formal" },
  { key: "ca", name: "Continuous assessment", family: "continuous" },
  { key: "practical", name: "Practical", family: "practical" },
  { key: "promotion_exam", name: "Promotion exam", family: "formal" },
  // school-defined: { key: "project", name: "Project", family: "practical" }, …
],
ranking:   { … §13 },
promotion: { … §14 },
```

- **Relationships:** `Exam.periodKey` and `Exam.componentKey` point into it by
  key. That makes it a reference *within a year*, not an id join.
- **Versioning:** the document stays editable. Its use is versioned through
  `AcademicPolicySnapshot` (§8).
- **Historical behaviour:** v1 documents (no `periods`) are read through a
  pure function `periodsFromLegacy(structure, gradingConfig)` that yields the
  same tree. No stored v1 document is rewritten.

`assessmentType.family` is the only thing intelligence needs (§15). It maps
to the existing `ASSESSMENT_FAMILY` taxonomy, and an unknown family falls back
to `formal` exactly as `events.js:173` does today.

### 6.2 `GradingConfig` (kept as the single grading authority, extended)

- **Purpose:** turning a mark into a grade, remark and pass decision.
  **Solves** §4.2.
- **Scope:** one per school, as today (the editable draft).
- **Fields added:**

```js
scale:    { max: 20 },                       // the mark scale bands and pass marks are expressed on
rounding: { decimals: 2, mode: "half_up" },  // documents today's Math.round(x*100)/100
subjectPass: { rule: "mark_at_least", mark: null },   // null → passMark
overallPass: { rule: "average_at_least", mark: null },
// distinction / fail rules, when a school asks: { rule: "subjects_failed_at_most", count: n }
```

- **Removed from authority:** `sequenceWeights`, `termWeights`, `*WeightingMethod`
  (dead) and, in Phase 4, `caWeight/testWeight`, which become component
  weights of each scored period. They are kept readable for D-class
  compatibility and never deleted.
- **The single code path:** `grading.service` gains a `policy` argument. Called
  with the snapshot's grading, it must return **byte-identical** output to
  today's for the built-in policy (characterisation tests, §20 Phase 2).
- `AcademicStructure.passMark` stops being a second source. The snapshot
  resolves one pass mark with the precedence intelligence already uses
  (`subjectInsights.js:502-507`: GradingConfig, then AcademicStructure, then
  default) and records which one won.

### 6.3 `AcademicPolicySnapshot` (**new**, immutable)

- **Purpose:** the answer to "which configuration produced this result?"
  **Solves** §4.3.
- **Scope:** `schoolId`. Never shared across schools, even when two schools'
  policies hash equal (the hash input includes `schoolId`).
- **Fields:**

```js
_id: "<sha256 of canonical JSON of the fields below>",
schoolId, academicYear,
calcVersion: "results/1",        // the arithmetic's own version (code), bumped on any formula change
structure:   { periods, assessmentTypes },        // resolved, legacy expanded
grading:     { bands, scale, rounding, passMark, passMarkSource, subjectPass, overallPass, showGrades },
ranking:     { … },
promotion:   { … },
sources:     { structureId, structureUpdatedAt, gradingConfigUpdatedAt },
createdAt, createdBy,
```

- **Lifecycle:** created on demand by `policySnapshot.resolve(schoolId, year)`
  the first time a computation runs under a new effective policy. It is
  insert-only. A unique `_id` makes concurrent creation idempotent. It is
  append-only like `ResultChangeLog`, enforced by the same pre-hooks.
- **Why one snapshot rather than four versioned collections:** a result is
  produced by the *combination*. Four independent versions would need four
  stamps on every row and four reads per computation. One hash is one stamp
  and one read, cacheable forever in-process because it is immutable.

### 6.4 Result models (kept; fields added)

`ResultSummary`, `TermResult`, `AnnualResult` gain:

```js
policyHash:   String | null,      // null = produced before this system ("legacy-v0")
calcVersion:  String | null,
averageScale: "gpa4" | "20" | null,   // what `average` is on; null on legacy rows = "as §9 documents"
averageOn20:  Number | null,      // ResultSummary only: the /20 figure, stored beside the legacy one
```

- **No new "AssessmentContribution" collection.** The contribution of each
  component is already on `subjectBreakdown` (`caScore/caMark/caWeight/test*`,
  `ResultSummary.js:22-52`). It generalises to
  `subjectBreakdown[].components[] { key, score, maxScore, mark, weight }`,
  while the `ca*`/`test*` fields stay populated for every reader that uses
  them (intelligence, cards, clients).
- **Period results:** `TermResult` stays the result of a non-scored parent
  period. A school with semesters gets `TermResult` rows whose `term` is the
  period's `legacy.term` ordinal and whose new `periodKey` names it. Renaming
  the collection to `PeriodResult` is not proposed. The name is internal, and
  renaming it is a migration without benefit.

### 6.5 `ReportTemplate` + `ReportTemplateVersion` (**new**, immutable)

- **Purpose:** reproduce a published card after the school's report-card
  configuration changes. **Solves** §4.3 for documents.
- `ReportTemplate` stays the editable token template. Its HTML/CSS is still
  edited in place and is **not** versioned (§10.3, limitations).
- **As implemented (Phase 2d, §10.3):** `ReportTemplateVersion { _id:
  "${schoolId}:v${n}", schoolId, version, sections, basedOnVersion,
  createdBy, createdAt }` versions the school's report-card **section
  layout**: which sections its cards print. A layout change inserts version
  n+1, and a save that changes nothing inserts nothing. It is append-only:
  model pre-hooks refuse every update, replace and delete. Issued sequence
  cards record `layoutVersionId`, `layoutVersion` and `layoutSections` on
  `GeneratedReport`.
- Proposed, not implemented: `GeneratedReport` gains `kind: "sequence"|"term"|"annual"`, `periodKey`,
  `policyHash`, `templateVersionId`, `payloadHash`, and is written for term
  and annual cards too (today: sequence only).

### 6.6 What `Class` keeps

`nextClassId` and `isFinalYear` stay on `Class`: they are about the class,
not the year's rules. `Class.promotionAverage` moves conceptually into
`AcademicStructure.promotion.classOverrides[classId]`, so it is versioned with
the year. The field stays readable as the fallback (D).

---

## 7. Configuration boundaries

```
Platform        built-in defaults only: DEFAULT_GRADES, CA defaults, policy enums, calcVersion
  └─ School     GradingConfig (draft) · ReportTemplate (draft) · Class progression
      └─ Academic year
          └─ AcademicStructure (draft): periods · components · assessmentTypes · ranking · promotion
              └─ AcademicPolicySnapshot (frozen per use) ◄─ GradingConfig is resolved INTO it
                  └─ Exam (assessment) → ExamSubject → StudentScore
                      └─ results stamped with policyHash
```

This differs from the prompt's suggested hierarchy in one way. **Grading sits
at school level and is pulled into the year's snapshot**, rather than living
below "Assessments". Schools change their grade bands rarely and for the
whole school. A per-year GradingConfig would force every school to copy it
yearly. The snapshot gives the per-year immutability anyway.

Scope rules:

- Every config document carries `schoolId` and is read only through
  `resolveSchoolId` (`utils/tenant.js:30-41`).
- A super admin must name the school. With none named, every configuration
  route returns 400, as `academicStructure.routes.js:44,84,126` already does.
  §4.6(i) lists the routers that must adopt the same explicit guard rather
  than relying on `schoolId: undefined` matching nothing.
- The snapshot hash includes `schoolId`, so identical policies in two schools
  never share a document.

---

## 8. Versioning strategy

| Boundary | Mechanism | Changes when |
|---|---|---|
| Academic structure + grading + ranking + promotion | `AcademicPolicySnapshot._id` (content hash) | any effective rule changes |
| Arithmetic | `calcVersion` per writer (`shared/academicPolicy.CALC_VERSIONS`: `exam-process/1`, `results-service/1`, `term/1`, `annual/1`) | that writer's formula changes (e.g. a D1 decision) |
| Report-card section layout | `ReportTemplateVersion` (§10.3) | each layout change that changes something (template HTML/CSS is not versioned) |
| Issued document | `GeneratedReport.payloadHash` | never (first issue wins; reissue = new row) |
| Evidence | `ResultChangeLog` (exists) | each mark change |

Rules:

1. A result's `policyHash` is set when it is computed. Recomputing an
   **unpublished** result under a new policy is normal and restamps it.
2. A **published** result is never recomputed implicitly. A recompute that
   finds published rows reports them as stale (`resultStaleness` gains
   `policyHash ≠ current` as a staleness reason) and leaves them. Changing
   them is an explicit "reissue" with a reason, a `ResultChangeLog` row, and
   a new `GeneratedReport`.
3. Editing a draft never touches results. The admin UI shows how many
   published results the change would leave stale (§15).
4. The academic structure document is never physically deleted. `deletedAt`
   stays a soft delete, and snapshots survive it regardless.

---

## 9. Historical-result strategy

**What is preserved untouched:** every existing `StudentScore`,
`ResultSummary`, `TermResult`, `AnnualResult`, `PromotionDecision`,
`GeneratedReport`. Nothing is backfilled into them except, optionally, an
*annotation* (below).

**How legacy rows are read** (`policyHash: null` = "legacy-v0"):

- **Corrected:** in a real database, `ResultSummary` rows come from
  `POST /exams/:examId/process` (§4.7). `average` is a whole-number
  raw-mark mean with absent subjects counted as zero. There is no CA, no
  coefficient, and no `academicYear`. A row with `academicYear` set and
  `subjectBreakdown[].caWeight` present came from `processResults`, which
  only tests and scripts reach. On such rows `average` is GPA points, and
  sequence cards print it ×5 (`shared/reportCard.js`).
- `TermResult.termAverage` and `AnnualResult.annualAverage` are means of
  whichever average their summaries held. On real data that is the
  raw-mark mean (§4.7). Their stored values are what was published. They
  are shown as stored and never silently recomputed.
- Grades on `StudentScore` were written by whichever path last saved the
  mark (`computeGrade` in `exam.routes.js`, using the school's bands).

**Annotation, not rewrite.** A one-off read-only script can classify legacy
term/annual rows by recomputing their expected value both ways and record
the outcome in a separate audit collection (or a `legacyAssessment` field).
The school can then see which published rows are affected by §4.1 and
decide, case by case, whether to reissue. **This is a school decision, not a
migration step.** It is listed in §21.

---

## 10. Report-card strategy

### 10.1 Today

There are two renderers:
- The **built-in layout**, with fixed sections (`reportHtml.service.js:323-977`).
- A **school token template**: free HTML with `{{tokens}}` (`ReportTemplate`,
  `placeholder.engine.js`), used whenever a default template exists.

There are no section toggles, and attendance is a label with no panel.
Stamp, custom fields and signature images do not exist. The principal
comment is never filled.

### 10.2 Target

1. **Built-in renderer becomes layout-driven.** It gets a fixed registry of
   supported sections, each a pure function of the card payload:
   `branding, studentInfo, results, assessmentBreakdown, attendance, conduct,
   teacherRemarks, headRemarks, position, overallAverage, promotionDecision,
   signatures, stamp, qr, customFields`.

   `ReportTemplate.layout = [{ section, enabled, order, options }]`. Options
   are per-section and closed, for example `results.columns`,
   `position.scopes` and `promotionDecision.onlyOnAnnual`, the last forced
   true to keep `shared/reportCard.carriesPromotion`. The default layout
   reproduces today's card exactly, so a school with no layout sees no
   change.
2. **Token templates stay.** Tokens tied to the fixed structure
   (`sequence1..6Average`, `term1..3Average`) remain for compatibility. New
   tokens are keyed by period: `{{period.t1.average}}`.
3. **Ranking and grade visibility come from the snapshot**, not from the
   template. A school with ranking disabled gets no position section even if
   its layout enables one. The renderer omits it and says so in the preview.
4. **Reproducibility:** issuing a card writes a `GeneratedReport` for
   **every** kind, with the frozen HTML, `payloadHash`, `policyHash` and
   `templateVersionId`. Reprinting an issued card serves the frozen HTML.
   Re-rendering from data is a *reissue* (§8).
5. **QR verification** snapshots its facts at **issue**, not on every
   render. Previews of unpublished data do not touch it.

**Do published reports need the three versions?** They need **grading and
structure** (both in `policyHash`) and **template** (`templateVersionId`).
The frozen HTML alone already guarantees the reprint is identical. The
versions are what make it *explainable* ("this card used bands v-x and
weights v-y") and what let a reissue be compared with the original.

---

### 10.3 As implemented: school section layouts (Phase 2d)

**What it is.** Each school chooses which **sections** its report cards
print. The choice is a versioned, immutable record per school
(`ReportTemplateVersion`). It is **presentation only**: a hidden section's
figures are still computed, stored, ranked, published and read by
intelligence exactly as before; they are simply not printed. Switching the
section back on prints them again. Nothing is deleted.

**Sections** (`shared/reportSections.js`, `SECTIONS`). These are the blocks
the built-in layout already printed, in its order. None is new: attendance,
stamp, signature images and custom fields are not sections, because no
renderer prints them today.

| Id | Prints |
|---|---|
| `watermark` | The school's logo, faint, behind the card. The server draws it around every card, including a school's own template, so the server hides it. |
| `header` | Ministry and delegations, school name, logo, motto, the card's title, and the exam/year subtitle. |
| `studentInfo` | Name, admission number, gender, date of birth, class, year (and photo on the shipped template). |
| `results` | The subject table: marks, CA/paper or sequence columns, coefficients, grades, remarks, subject positions, the totals, pass and decision rows under it, and the CA note. |
| `performance` | Rank, average, overall grade, and (annual card only) the decision, in the information panel. |
| `classProfile` | Class average, best, lowest. |
| `conduct` | The work, behaviour and observation boxes filled in by hand. |
| `remarks` | Class teacher's and head's remarks with signature lines. |
| `verification` | The QR code and verification code. It prints only when a code exists, whatever the layout says. |
| `footer` | Date of issue and school name. |

The three information-panel sections (`performance`, `classProfile`,
`conduct`) are independent. The grid narrows to the columns left, and
disappears when none are left.

**Default and compatibility.** A school with no version has the default:
every section on (version 0, source `default`). That is the card every
school printed before this existed. With no layout, the built-in card is
**byte-identical** to the renderer at `abdb150`. This was checked against
the committed renderer for sequence, term and annual cards, in English and
French. `check:reportlayout` pins that "no layout" and "every section on"
are the same document. No school sees a change until it switches a section
off itself, and nothing new is printed.

**Versions and issued cards.**
- A change (`PUT /api/templates/layout`) inserts version n+1 with every
  section stated explicitly. Earlier versions are never edited:
  append-only hooks enforce this at the model layer.
- `_id` is `${schoolId}:v${n}`, so concurrent saves race on the `_id`
  index. The loser re-reads and applies its change on top, so no change is
  lost. Pinned: five concurrent changes give five versions and keep all
  five. A save that changes nothing inserts nothing.
- **Sequence cards** are archived when first printed after publication
  (`GeneratedReport`). The archive now records `layoutVersionId`,
  `layoutVersion` and a copy of `layoutSections`. Every later print of that
  card uses that layout, whatever the school changed since. The frozen
  `renderedHtml` the portal serves is untouched.
- A **reissue** is the deliberate supersede. It takes the current layout and
  records it.
- **Legacy archives**, written before this, have no layout fields. They
  reprint with every section, which is what they were issued with (source
  `legacy`), and are not rewritten.
- **Term and annual cards** are never archived today: they re-render from
  live results on every request. So they print with the school's
  **current** layout, and the version is sent in an `x-report-layout-version`
  response header. Freezing them is the §10.2(4) work, not done here.

**Integration points.**
- `reportHtml.service.renderReportCardHtml` gates each block on
  `opts.sections`.
- `wrapTemplateHtml` gates the watermark.
- `toTemplateData` passes the sections to token templates.
- `placeholder.engine.buildReplacementMap` exposes `section_<id>` flags,
  which are also in `shared/reportTokens` so the builder lists them.
- The four places that render a card all resolve the layout through
  `services/reportLayout.service.js`:
  - `results.controller` `getStudentReportCardHtml` (issued, legacy or
    current, recorded by `archiveGeneratedReport`)
  - `reissueStudentReportCard` (current, recorded)
  - `termResults.routes` and `annualResults.routes` `/:studentId/report-card`
    (current)
- The JSON payload (`GET …/reportcard`) carries `layout` beside `data`,
  with the data unchanged.
- The template preview shows the current layout.

**Token templates.** A school's own template is its own document and is
never rewritten (`scripts/repair-report-templates.js` explains why). It
honours a section by gating the block: `{{if section_results}} … {{endif}}`.
- The **shipped default template** now gates every block, so a school that
  seeds it after this change gets layouts honoured in full.
- A stored template that does not gate a section **cannot hide it from
  inside the school's HTML**. That is reported, never silently ignored:
  - `GET`/`PUT /api/templates/layout` return
    `sectionsNotHiddenByTemplate` for the school's default template.
  - The card response's `layout.sectionsNotHiddenByTemplate` does the same.
  - `renderReportCard` returns `sectionsNotHidden`.
- **Existing seeded copies predate the flags and gate nothing.** Making
  them honour layouts is either a template edit by the school, or a
  repair-script patch in the existing style. That patch is not written
  here, because it would edit schools' documents.

**API contract** (for a future settings screen). `reports.manage` (ADMIN
roles), like every route under `/api/templates`. The school comes from
`utils/tenant.resolveSchoolId`, with an explicit 400 `SCHOOL_REQUIRED` when
none is resolved. A super_admin must name the school. A write naming
another school gets 403.

| Route | Answer |
|---|---|
| `GET /api/templates/sections` | `{ sections: [{ id, label, description, default: true }] }` |
| `GET /api/templates/layout` | `{ layout: { id, schoolId, version, sections, basedOnVersion, createdBy, createdAt, source }, sectionsNotHiddenByTemplate }` |
| `PUT /api/templates/layout` | body `{ sections: { <id>: true\|false, … } }`, partial allowed. 201 `{ changed: true, layout }` for a new version, 200 `{ changed: false }` if nothing changed. 400 `INVALID_BODY` / `UNKNOWN_FIELD` / `INVALID_SECTIONS` / `UNKNOWN_SECTION` / `INVALID_SECTION_VALUE`. 409 `LAYOUT_CONFLICT` after 5 lost races. |
| `GET /api/templates/layout/versions` | every version, newest first |
| `GET /api/templates/layout/versions/:n` | one version of this school's, or 404 |

There is no client UI for this. No existing screen manages sections: the
web Reports → Builder edits token-template HTML only. The settings screen is
future work (Phase 5, §20.2), against the contract above.

**Tests.** `check:reportlayout` (64 checks; in `check:all` after
`check:academicpolicy`) runs through the real routers and auth over HTTP. It
covers:
1. Two schools with different layouts and different cards.
2. Results switched off while every other block stays.
3. Presentation only: every `ResultSummary`, `StudentScore`, `TermResult`
   and `GradingConfig` row, and the intelligence layer's
   `publishedHistory`, are identical before and after layouts are changed
   and cards printed.
4. Switched back on, a section prints again when its data exists, and not
   when it doesn't.
5. 8 malformed or unknown inputs refused, and nothing stored. Teacher and
   bursar get 403. A super_admin with no school gets 400 for reads and
   writes.
6. Another school's write and read refused; its template not attachable
   by `?templateId`; a layout not attachable by any request parameter.
7. Versions immutable and listed, no-op saves insert nothing, concurrent
   saves lose nothing.
8. An issued card reprints with its layout; the archive is unchanged; a
   reissue records the current layout.
9. A legacy archive reprints with every section, unchanged.
10. "No layout" and "every section on" are the same document.

The shipped template honours every section, and a school's ungated
template is reported.

Mutations:
- Ignoring the issued layout fails 3 checks.
- Accepting unknown ids fails 7.

**Limitations and open points.**
- **Term and annual cards** use the current layout, because they are not
  issued today (above).
- **Stored token templates** made before this gate nothing, and are
  reported, not changed (above).
- **Token-template HTML is still edited in place.** `ReportTemplateVersion`
  versions the *section layout*. A template's HTML/CSS history is still
  only `ReportTemplate.version` (a counter) plus the issued card's frozen
  `renderedHtml`. Versioning template HTML on save is the remaining part of
  §6.5.
- **Hiding `verification` hides the strip only.** A verification code is
  still minted on render, as before. Whether a school that hides the strip
  should get no public record is a product decision, not taken here.
- **Mobile's offline fallback card** (`ReportCard.js` `buildPdfHtml`, used
  only when the server is unreachable) and its **on-screen results views**
  do not read the layout. Every printed card comes from the server. The
  JSON payload carries `layout` for a client that wants it.
- **Not changed:** §4.6(f) (reissue omits letterhead and QR) and §4.6(g)
  (`POST /api/generated-reports` can overwrite a frozen card).

## 11. Assessment strategy

### 11.1 Field inventory for "Assessment" (= `Exam` + `ExamSubject`)

| Wanted | Exists? | Where / gap |
|---|---|---|
| name | yes | `Exam.name` |
| type | **closed enum of 4** | `Exam.type` → becomes `assessmentType` key from the structure's open list. `type` kept as the legacy enum value (unknown → `"test"`) |
| period | **number pair** | `Exam.term` + `sequenceNumber` → add `periodKey`. Numbers kept, generated from `legacy` |
| subject | yes | `ExamSubject.subjectId` |
| maximum mark | yes | `ExamSubject.maxScore` (`Exam.totalMarks` unused) |
| weight in period result | **only CA vs paper**, on GradingConfig | → `componentKey` on Exam; weight from the structure's component |
| contribution to ranking | no | → `component.countsTowardRanking` (default true) |
| publication state | yes | `Exam.status`, `resultsPublished`, `ResultSummary.isPublished` |
| date | yes | `Exam.startDate/endDate` (strings) |
| description | yes | `Exam.description`, `instructions` |
| ordering | implicit | `periods[].order`, then `startDate` (already the intelligence order key) |
| coefficient | yes | `ExamSubject.weight` (÷100) |

### 11.2 Smallest safe model change

Add three optional fields to `Exam`: `periodKey`, `componentKey`,
`assessmentType`. Add the same three to the sync feed payload, which is
automatic because the feed ships whole documents. Do not change the
`StudentScore` key `(examId, studentId, subjectId)`: one assessment per
`Exam` row remains the rule, which is exactly how CA already works.

Everything that reads `term`, `sequenceNumber` or `type` keeps working,
because those fields are still written:
- `term = period.legacy.term`
- `sequenceNumber = period.legacy.sequence`
- `type = legacyType(assessmentType)`

The generalisation of `parentExamId` is `(periodKey, componentKey)`: all
exams of one scored period, one class and one component combine into the
period result. CA pairing becomes one instance of the rule instead of a
special case.

---

## 12. Grading strategy

1. One authority: `GradingConfig` → snapshot → `grading.service(policy)`.
   `lookupGrade` stops reading the module-level `GRADE_SCALE` and reads the
   policy's bands. For a school with no bands the policy *is* the built-in
   scale, so output is identical.
2. Scale: bands, pass marks and thresholds are expressed on `scale.max`
   (default 20). Marks are normalised to that scale. A /100 school sets
   `scale.max: 100` and enters /100 bands. `findBand` already does not clamp
   (`shared/gradeScale.js:79-84`).
3. Rounding: documented as `half_up, 2 decimals` (today's
   `Math.round(x·100)/100`, which for negatives rounds toward +∞; marks are
   never negative). Configurable only after characterisation tests pin
   today's values.
4. Weighting and coefficients: component weights (period), period weights
   (parent / annual), subject coefficients (unchanged).
5. Distinction and fail rules: two closed rules (`average_at_least`,
   `subjects_failed_at_most`). More only on demand.
6. **The sequence average's scale is a Phase-0 decision (§21-D1).** Under
   `calcVersion "results/1"` it stays GPA points, written beside an explicit
   `averageOn20`. A `"results/2"` that ranks and grades on the /20 mean is the
   likely fix, but it changes results and needs the school's sign-off.

`GradingConfig` must never be edited in a way that recomputes anything.
That is already true. What is new is that the edit becomes visible as
"N published results use the previous policy".

---

## 13. Ranking strategy

**Today:**
- Ranking is always computed and always printed.
- The basis is `average`, which is GPA points for a sequence (so ties are
  common, because the points are quantised by band) and the stored average
  for a term or year.
- Ties use competition ranking (1, 1, 3).
- Scopes: class, a "grade" that groups by `className`, and school for
  sequences; class only for term and annual.
- Fully absent pupils are excluded.
- Positions are written onto result rows.

**Extension point** (in `AcademicStructure.ranking`, snapshotted):

```js
ranking: {
  enabled: true,
  basis: "period_average",          // only value now; "total" when a school needs it
  ties: "competition",              // "dense" available; today = competition
  scopes: ["class"],                // subset of class | level | school; default reproduces today per level
  excludeFullyAbsent: true,
  publish: { onCards: true, toPortal: true },
}
```

`enabled: false` writes `null` positions and suppresses every position
section and token. The `competitionPlaces` function
(`termGrading.service.js:346-358`) and the sequence ranker
(`results.service.js:344-355`) become one `rank(values, policy)` in
`shared/`. Today they are two implementations of the same competition rule.

---

## 14. Promotion strategy

**Today:** three rules (§4.4). Promotion is **manual-reviewed**. A
`PromotionRun` is a draft of proposals that an administrator overrides and
commits, and reversal is exact. That workflow is right and is kept.

**Minimum useful abstraction:** one proposal function, one rule, one place:

```js
promotion: {
  rule: "annual_average_at_least" | "majority_of_periods_passed" | "manual_only",
  threshold: 10,                    // on grading.scale; NOT a percentage
  requirePromotionExam: false,      // today's promotionExams/promotionThreshold, as an option
  classOverrides: { "<classId>": { threshold: 12 } },   // replaces Class.promotionAverage
}
```

- The proposal reads **`AnnualResult`** (the year's figure), not the mean
  of sequence summaries.
- `AnnualResult.promotionStatus` and `PromotionDecision` are computed by
  the same function. The annual card prints the decision, or "pending
  review" until a run is committed.
- `Class.promotionAverage` (0–100) is converted to `threshold` on
  `grading.scale` only through an explicit, confirmed admin action. It is
  never inferred, because today it is compared against GPA points (§4.1).
- No rules engine. A school whose promotion needs judgement uses
  `manual_only`, and every proposal is "needs decision".

---

## 15. Intelligence compatibility

### 15.1 What the engines actually consume

| Engine | Reads | Structure dependency | Required? |
|---|---|---|---|
| academicOrder / academicHistory | published `ResultSummary` incl. `subjectBreakdown`; `Exam.type/term/sequenceNumber/startDate` | skips `type==="ca"`; orders by year **string**, term, sequence, startDate | CA skip **required**. Ordinals **required** as ordinals. Year string sort is a hidden format dependency |
| subjectInsights (ENGINE_VERSION 1.0.0) | `subjectBreakdown.normalizedMark`, pass mark, band floors | /20 scale and absolute /20 thresholds (`strongMark 14`, drops of 2/4) | **required** |
| guidance | subjectInsights codes | none | — |
| interventionOutcome | history with `startDate` | timestamp; /20 change | timestamp **required** |
| earlyWarning | summary `isPassing`, `percentage`, `subjectsFailed` | percent scale; hard-coded 10/20 pass | **required** (summary-level fields) |
| learningEvidence (1.0.0) | raw `StudentScore` + `Exam.type/startDate/resultsPublished` | `type → family`; 0–1 normalisation | family mapping **required**. Otherwise already structure-free |
| strengths (1.2.0) | profiles + learning evidence | persistence over ≥2 distinct **terms** (`engine.js:123-124`) | term-like grouping **required** |
| development, plans, interventions, advanced | snapshots/profiles only | `evidenceCoverage.sequences` count | incidental |
| reviewCases / analysisRuns / calibration cohort | Exam + ResultSummary | `cohortSchema.js`: term 1–3, sequence 1–6, type enum, scale 20, `FORMAT_VERSION 1` | **required for the format** |

Unused by every engine: `TermResult`, `AnnualResult`, positions,
coefficients (carried, not reasoned on), `ExamMark`, `Period`.

### 15.2 Consequences for the design

1. **The evidence contract intelligence depends on is the published
   sequence-level `ResultSummary`.** It has one blended /20 mark per subject
   per occasion, an ordinal `(year, term, sequence)`, `startDate`, and a CA
   flag on the exam. The design keeps producing exactly that:
   - Scored periods produce `ResultSummary` rows as sequences do now.
   - `legacy.term`/`legacy.sequence` provide the ordinals.
   - `normalizedMark` stays /20.
   - Component exams other than the "main" one are excluded from history as
     CA is today, through the component's role rather than `type === "ca"`.
2. **Phases 2–5 change no engine input, threshold, code or version.** The
   `ENGINE_VERSION`, `STRENGTH_ENGINE_VERSION`, `LEARNING_EVIDENCE_VERSION`
   and `FORMAT_VERSION` constants stay where they are.
3. **Migration dependencies for Phase 6** (genuinely custom structures):
   - **Non-/20 scales:** convert `normalizedMark` to /20 at the evidence
     boundary, so the thresholds stay put. Do not rescale thresholds.
   - **Structures with more than 3 roots or 6 occasions:** `cohortSchema`
     bounds need a `FORMAT_VERSION` 2 and a calibration re-run.
   - **Semesters:** strengths' "≥2 distinct terms" maps to "≥2 distinct root
     periods". This is a semantic change for a semester school, which has
     only 2 roots. It needs an explicit decision and a
     `STRENGTH_ENGINE_VERSION` bump. It is not a silent mapping.
   - **New assessment families:** they must map to an existing learning
     family. An unknown family falls back to `formal` today, which is the
     safe direction.
4. **Year-string ordering:** `AcademicStructure` and results keep
   `academicYear` in the validated `YYYY/YYYY` form (`School.js:84`). Mixed
   `YYYY-YYYY` values would misorder intelligence history, so any new write
   path normalises the separator.
5. §4.6(d), the CA double-count in strengths, is an engine defect in its own
   right. It is out of scope here because semantics are frozen, and it is
   listed in §21.

---

## 16. Offline/sync compatibility

### 16.1 Today

| Data | Desktop (`/api/sync/changes`, whole docs) | Mobile |
|---|---|---|
| Exam, ExamSubject, StudentScore | yes (`syncFeed.js:262-271`) | REST per exam; SQLite `exams` drops `sequenceNumber`, `parentExamId` |
| ResultSummary, TermResult, AnnualResult | yes, published unless admin | ResultSummary via REST; no term/annual |
| GradingConfig | yes (`results.view`) | admin settings blob only, unused for grading |
| AcademicStructure | yes (`exams.view`) | no |
| ReportTemplate | yes (`reports.manage`) | own table |
| Mark writes | outbox of REST calls, `Idempotency-Key`, last write wins per row, 423 on locked/published | same, but **teacher entry screen posts directly**, draft only offline |

Clients grade locally in two divergent ways (desktop `gradeUtils.js` without
coefficients or CA; mobile with its own scale). Those local results are
provisional display only. The server recomputes.

### 16.2 Can configurable assessments be represented offline?

**On desktop, yes, with no contract change.** It mirrors whole documents,
so new optional fields on `Exam` and `AcademicStructure` arrive by
themselves. A new `AcademicPolicySnapshot` collection is one feed entry. It
is immutable and small, so its cursor is trivial. **On mobile, partly.**
Required changes:

1. `exams` table: add `periodKey`, `componentKey`, `assessmentType`,
   `sequenceNumber`, `parentExamId` columns. Today pairing is lost on the
   phone.
2. Ship the snapshot (or the structure) to mobile, so mark entry can label
   components and show max marks without a round trip.
3. Mark key unchanged: `(examId, studentId, subjectId)`. No conflict-rule
   change is needed for configurability.
4. Validation must use the server-side `maxScore` (§4.6a). This is a server
   fix and independent of this design.
5. Local grading on both clients should call the shared, policy-driven
   grader from §12. Until then client grades are labelled provisional, as
   they effectively are.

Sync is not redesigned. The contract additions are additive fields plus one
collection.

---

## 17. Security / permissions

### 17.1 Roles that exist

`super_admin`, `school_admin`, `bursar`, `teacher`, `student`
(`config/roles.js:52-58`). There is **no parent role and no head/principal
role**. Parents use guardian-code portal sessions (`portal.service.js`).
Heads are `school_admin`.

### 17.2 Proposed authority

| Actor | Academic configuration | Mechanism |
|---|---|---|
| school_admin | read + write own school | `settings.manage` (ADMIN, not delegable), unchanged |
| super_admin | read + write the **explicitly named** school only; 400 when none | `resolveSchoolId` + explicit guard; `namedAnotherSchool` on writes |
| teacher | read the effective (snapshotted) policy for their school: periods, components, max marks, pass mark; never write | new read permission `academics.view` (TEACHING, delegable) **or** grant `settings.view` narrowly. Today teachers get the structure via the desktop feed (`exams.view`) but not REST (§4.6j); one rule should cover both |
| bursar | none | not in TEACHING roles |
| student / parent (portal) | only what is printed on *published* documents | portal routes already serve frozen cards (`portal.routes.js:762-805`) |

Rules:

- Every config write goes through one service function, not route-level
  `findOneAndUpdate`, so the audit, the "affects N published results"
  preview and the guard live in one place.
- Config writes are audited (`AuditLog`) with before/after.
- Snapshots are written only by the server.
- The routers that build school filters privately (`exam.routes.js:20-23`,
  `template.routes.js:42-47`, `admin.routes.js:68-74`,
  `promotion.routes.js:~17-21`) should move to `utils/tenant.resolveSchoolId`
  and refuse a missing school explicitly. This is a behaviour change for a
  super_admin with no school selected: empty list → 400. It belongs to the
  Phase 2 slice. **Done for the exam, template, issued-card and results
  routers in Phase 2(e)** (§17.4); `admin.routes` and `promotion.routes`
  are not part of it.

### 17.3 Tested in this audit

`Exam.countDocuments({ schoolId: undefined, deletedAt: null })` with exams in
two schools returns 0 (Mongoose 9.9.1, in-memory MongoDB). The current
behaviour is therefore fail-closed. It depends on driver serialisation of
`undefined`, which is why the plan replaces it with an explicit guard.

### 17.4 As implemented: the missing-school guard (Phase 2e)

**What was wrong.** Three routers kept a private `resolveSchoolId` that
returned `req.user.schoolId`: `exam.routes`, `template.routes` and
`generated.report.routes`. That value is `undefined` in two cases: a
super_admin who named no school, and a school account whose own `schoolId`
is empty. The door lets the second through, because there is no school of
theirs to be closed. With that `undefined`:

- Most exam and template handlers built `{ schoolId: undefined }`. That
  matched no row: fail-closed by accident (§17.3). It still answered 200,
  and `PATCH /exams/:id/lock` wrote a school-less audit row and reported
  success.
- `generated.report.routes` built `...(schoolId ? { schoolId } : {})` on
  `GET`/`PUT`/`DELETE /:id`, `GET /student/:studentId` and
  `GET /exam/:examId`. With no school that is no filter at all: **fail
  open**. A caller with no school read, unpublished or deleted any school's
  issued card by id.
- `results.controller` deliberately lets a super_admin with no school read
  across schools, anchored on the exam's school (docs/20 Info-A). It keyed
  that on "no school resolved", not on the role, so a schoolless school
  account got the same reach.

Reproduced: the new suite run against the routers before this change fails
111 of 170 checks. That includes "nothing was written": A's issued card was
unpublished and then deleted by a request that named no school.

**The rule.** `utils/tenant.requireSchool()` is one middleware. It
refuses a request that `tenant.resolveSchoolId` resolves to no school with
`400 { success: false, code: "SCHOOL_REQUIRED", error: "A school must be
selected" }`. That is the body the Phase 2(d) layout routes already sent,
so their answers are unchanged.

| Router | Guard | Exempt |
|---|---|---|
| `/api/exams` (every route) | `requireSchool()` | none |
| `/api/templates` (every route, after `reports.manage`) | `requireSchool()` | `GET /tokens`, `GET /sections`: the same vocabulary for every school, no school data |
| `/api/generated-reports` (every route) | `requireSchool()` | none |
| `/api/results` (every route) | `requireSchool({ superAdminMayOmit: true })` | a super_admin, so Info-A is kept as documented. A schoolless school account is refused. |

The three private helpers now delegate to `tenant.resolveSchoolId`. The
guard and every handler therefore resolve the same school: if the guard
passes, the handler's school is non-empty. Unchanged, and still enforced:

- the door's 403 `SCHOOL_ACCESS_DENIED` when a school account names another
  school in the query or body;
- its 404 `SCHOOL_NOT_FOUND` when a super_admin names a school that does
  not exist;
- every handler's existing `schoolId` scoping, so another school's record
  by id is a 404.

**Behaviour change.** A super_admin with no school selected gets 400 on the
exam, template and issued-card routers, where it used to get empty lists
and 404s. The web client names the active school on every super_admin
request (`web/src/lib/axios.ts`), so only a super_admin with no school
selected sees it. That is the change §17.2 anticipated. Nothing changes for
a school's own staff.

**Tests.** `check:schoolguard` has 170 checks and is in `check:all` after
`check:reportlayout`. It runs through the real routers and auth over HTTP,
on two synthetic schools:

1. 50 exam, template and issued-card routes refuse both kinds of
   schoolless caller with the exact 400 body, and no row of any touched
   model changes.
2. 13 results routes refuse the schoolless school account and write
   nothing. The super_admin's Info-A read still answers 200.
3. A school's admin and teacher list, read, create, rename, duplicate and
   update as before, and see only their own school.
4. Another school's exam, template and issued card, by id, gets 404 on
   read, update, status, delete, process, duplicate and set-default.
   Naming that school gets 403. B's rows are byte-identical afterwards.
5. A super_admin naming a school stays inside it. Naming a non-existent
   school gets 404.
6. Layout routes: `sections` and `tokens` work without a school, a
   school's layout reads and writes as before, a cross-school layout write
   gets 403, and a teacher still gets 403.

**Not covered.** `admin.routes` and `promotion.routes` still carry private
copies of the rule (§17.2). Promotion already refuses a missing school
(§4.6i). Neither is an exam or template router, so neither was changed
here. `POST /api/generated-reports` overwriting a frozen card (§4.6g) is
unchanged; that route only gained the missing-school refusal.

---

## 18. Migration strategy

| Item | Treatment |
|---|---|
| `StudentScore`, `Exam`, `ExamSubject` | **unchanged**; optional fields added later, populated for new exams; old exams resolved by `(term, sequenceNumber, type)` → `periodKey/componentKey` via `periodsFromLegacy` at read time |
| `AcademicStructure` v1 docs | **unchanged**; read through `periodsFromLegacy`. Converted to v2 only when an admin saves in the new editor (explicit) |
| `GradingConfig` | **unchanged** values; new fields default to today's behaviour (`scale.max 20`, `half_up/2`) |
| Dead fields (`sequenceWeights`, `termWeights`, `useGpa`, `gpaScale`, `gradingType`, `annualAverageMethod`, `maxAbsences`) | **kept, documented as inert**; never deleted; the new editor stops showing the inert ones |
| `ResultSummary`/`TermResult`/`AnnualResult` | **unchanged**; `policyHash null` = legacy-v0; new rows stamped |
| `Class.promotionAverage` | **kept** as fallback; converted only by explicit admin action (§14) |
| `ReportTemplate` | **unchanged**; its HTML/CSS is not versioned. `ReportTemplateVersion` versions the section layout only: a school's first layout change writes version 1, and a school with none prints every section (§10.3) |
| `GeneratedReport` | **unchanged**; new kinds added |
| **Generated** | `AcademicPolicySnapshot` (on first computation); `ReportTemplateVersion` (on a layout change) |
| **Versioned** | policy (snapshot), report-card section layout (`ReportTemplateVersion`), arithmetic (`calcVersion`) |
| **Becomes configuration** | periods/components/types, ranking, promotion rule, scale/rounding, card layout |

### 18.1 The current school as configuration (Cameroon default)

`periodsFromLegacy` turns the default structure plus today's GradingConfig
into:

```yaml
academicYear: 2026/2027
periods:
  - { key: t1, name: First Term,  kind: term, order: 1, weight: 33.33, contributesToAnnual: true, legacy: {term: 1} }
  - { key: s1, name: Sequence 1, kind: sequence, parentKey: t1, order: 1, weight: 50, scored: true, legacy: {term: 1, sequence: 1},
      components: [ { key: ca,   assessmentType: ca,   weight: 40, required: false },
                    { key: test, assessmentType: test, weight: 60, required: false } ] }
  - { key: s2, name: Sequence 2, kind: sequence, parentKey: t1, order: 2, weight: 50, scored: true, legacy: {term: 1, sequence: 2},
      components: [ …same… ] }
  - { key: t2, … s3, s4 … }   - { key: t3, … s5, s6 … }
grading: { scale: {max: 20}, passMark: 10, bands: DEFAULT_GRADES, rounding: {decimals: 2, mode: half_up} }
ranking: { enabled: true, basis: period_average, ties: competition, scopes: [class, level, school] }
promotion: { rule: majority_of_periods_passed, classOverrides: {…from Class.promotionAverage, unconverted…} }
```

With `caEnabled: false` the `ca` component is omitted and `test` weighs 100.
That is today's `caSettings()` (`caAssessment.js:81-112`).

---

## 19. Performance implications

Checked against docs/37:

- **Policy resolution:** one snapshot read per computation run, keyed by hash
  and cached in-process indefinitely because it is immutable. Today
  `termGrading.loadTermContext` already reads structure and grading once per
  run (`:60-63`). This replaces two reads with one cached read. **No N+1.**
- **No new joins on hot paths.** Periods, components, types, ranking and
  promotion are sub-documents. Exams reference them by key within an
  already-loaded document.
- **Annual and term calculation:** unchanged shape (bulk per class).
  `policyHash` is one more field in the same `bulkWrite`.
- **Report cards:** term and annual cards still read the whole school's
  marks for subject positions, the open P1 decision in docs/37 §15. This
  design does not worsen it. Freezing issued term and annual cards in
  `GeneratedReport` *removes* re-renders on reprint, which helps.
- **Ranking:** `rank(values, policy)` is the existing O(n log n) competition
  ranking.
- **School-wide intelligence:** the cold-analysis fingerprint (docs/38 §4)
  hashes `(id, updatedAt)` of the scope's exams, summaries, structure and
  grading. Stamping `policyHash` on new summaries changes nothing there. A
  config edit already invalidates the fingerprint through `updatedAt`.
- **Sync / mobile:** one small immutable collection. On the phone, a few
  columns on `exams`.
- **Storage:** snapshots are a few KB each, created only when the effective
  policy changes. Templates add one version row per save.

---

## 20. Recommended implementation phases

| Phase | Content | Behaviour change |
|---|---|---|
| **0. Decisions** (no code) | §21 D1–D4, above all D1, the sequence-average scale | none |
| **1. Audit** | this document | none |
| **2. Normalise without changing behaviour** | (a) **characterisation tests** that run real `processResults → term → annual → promotion → card payload` on synthetic data and pin today's outputs, including §4.1 as it stands; (b) `AcademicPolicySnapshot` model + `resolve()` + `periodsFromLegacy()`; (c) stamp `policyHash`/`calcVersion`/`averageScale` (and `averageOn20` on summaries) on newly computed rows; (d) `ReportTemplateVersion`: per-school, versioned report-card section layouts (§10.3); (e) explicit missing-school guard on exam/template routers (§17.4). **Complete:** (a)–(e) are all done (§20.0) | additive fields only, plus (e) |
| **3. Represent today's structure as configuration** (**done**, ahead of D1 on the project owner's instruction; §20.0) | read paths (term/annual compute, card builders) take periods from the snapshot via `periodsFromLegacy`; characterisation tests must stay green byte-for-byte | none |
| **4. Configuration-driven calculation** (**done** as per-school rules, defaults = today; §20.0) | single grading authority (§12), component weights replace `caWeight/testWeight` reading, unified ranker, unified promotion proposal, recompute guards on published rows, term/annual card archiving, QR at issue. Any deliberate result change (e.g. D1 fix) ships as `calcVersion "results/2"` for **new** computations only | yes, each behind a decision and a version |
| **5. Admin configuration UI** (**done** for the rules and section layouts; §20.0) | §15-style screens over the v2 structure, with impact preview and confirmations | UI |
| **6. Genuinely custom structures** (**partly done**: flexible periods within today's bounds; §20.0) | non-/20 scales, >3 roots, semesters, new families; cohort `FORMAT_VERSION` 2; intelligence mappings decided per §15.2 | yes, per school |

### 20.0 Progress

- **Phase 2(a), done:** `backend/scripts/check-academic-characterisation.js`
  (`npm run check:academic`, in `check:all` after `check:term`). It marks one
  synthetic school and runs the real pipeline: `processResults` → term →
  annual → card payloads → publish → `generateRun`. It pins 30 outputs, each
  checked by hand. Pins that encode a defect are tagged with their §. A
  mutation, changing the CA split from 40/60 to 50/50, fails 8 pins across
  the sequence, term and annual layers. The run also surfaced §4.6(k) and
  §4.6(l), which this audit had not caught by reading.
- **Phase 2(b), done:**
  - `shared/academicPolicy.js` (pure functions `periodsFromLegacy`,
    `resolvePolicy`, `canonicalJson`, plus `CALC_VERSION "results/1"` and
    `INERT_FIELDS`).
  - Model `AcademicPolicySnapshot`, with `_id` = SHA-256 of the canonical
    policy including school and year. It is append-only, enforced by
    pre-hooks.
  - `services/academicPolicy.service.js` (`resolve`, `get`, `hashOf`,
    `verify`). Both entry points refuse a missing school.
  - The model is listed in the sync feed's `EXCLUDED` with its reason.
  - Tests: `check:academicpolicy`, 85 checks, in `check:all` after `check:academic`.

  Differences from the §6.3 sketch, made on purpose:
  1. The grading section records **both** authorities as results/1 actually
     uses them (§4.2): `calcBands` and `subjectPassMark` (what stored
     results are graded with), and `schoolBands` and `periodPassMark` (what
     term/annual pass and card rows use). It also records
     `structurePassMark`, which intelligence falls back to. Tidying this is
     Phase 4, under a new `calcVersion`.
  2. Fields no code reads (`INERT_FIELDS`: `annualAverageMethod`,
     `maxAbsences`, sequence assessment labels, `useGpa`, `gpaScale`,
     `gradingType`, the dead weight fields) are **not hashed**, so editing
     them does not make results look stale. Term and sequence names are
     hashed, because cards print them.
  3. Ranking and promotion are recorded as the constants and inputs
     results/1 uses, including the per-level difference in who is ranked
     (§4.6k).
  4. Provenance (`sources`) is stored but not hashed. Changing a value and
     changing it back yields the same snapshot.

  Not wired into any calculation. No result, card or screen can differ:
  `check:academic` is unchanged at 30/30. Mutation-tested: dropping the
  pass mark from the policy fails 5 checks, and hashing an inert field
  fails 1.
- **Phase 2(a), extended (Phase 2c investigation):** the 2(a) suite pinned
  only `processResults`, which turned out to be unrouted. `check:academic`
  now also builds the same school a second time and processes it through
  the live `POST /exams/:examId/process` route over HTTP. It pins that
  route's summaries, term and annual results, card headline, promotion run,
  and re-process behaviour: 13 more pins, 43 in total, all hand-checked.
  This led to the correction at the top of this document and to §4.7.
- **Phase 2(b), corrected in 2(c): the policy is configuration only.** As
  first committed it described what `grading.service` (the unrouted path)
  does with the configuration (`calcBands`, a fixed 10/20, ranking
  constants, one `calcVersion`). That was false of the live route. Now
  (`POLICY_FORMAT 2`):
  - The policy holds only configuration: periods with their components, the
    school's bands, pass mark and source, the structure's pass mark,
    `showGrades`, the CA settings, and the promotion-exam inputs.
  - What the code does is named per writer by `CALC_VERSIONS`:
    `exam-process/1`, `results-service/1`, `term/1`, `annual/1`.
  - Class promotion bars are no longer in the policy. No result row depends
    on them, only the promotion run does, and reading every class would cost
    a query on the fixed-count paths. Promotion decisions will carry their
    own record when they are stamped (Phase 4).
  - `resolve()` accepts the structure and grading config the caller has
    already loaded. On a warm process stamping costs zero queries, and this
    is tested.

  No hash had been stored, so the change cost nothing.
- **Phase 2(c), done:**
  - `ResultSummary`, `TermResult` and `AnnualResult` gain `policyHash` and
    `calcVersion`, both null on older rows.
  - Every computing writer stamps them: `POST /exams/:examId/process` (the
    live route), `results.service.processResults`, `termGrading`
    (`loadTermContext` → every row) and `annualGrading`
    (`annualContextFor` → every row).
  - Not stamped: the bare summary created at per-summary publication
    (`results.controller` `publishResult`), because no computation produced
    it.
  - `check:academic` (now 52) pins that every row on both paths carries its
    school's snapshot and its writer's version. A configuration edit leaves
    earlier stamps alone. A re-process restamps with the new snapshot
    while, on the live route, its figures stay put (it ignores the CA
    split, §4.7a). The earlier snapshot still answers for the rows that
    used it.
  - All 43 earlier pins are unchanged, so no figure moved. Mutation:
    dropping the live route's `calcVersion` fails 2 checks.
  - Dropped from the §6.4 sketch: `averageScale`, because `calcVersion`
    determines how `average` is read; and `averageOn20`, because choosing
    *which* /20 figure to store is decision D1, not provenance.
- **Phase 2(d), done: school section
  layouts.** `ReportTemplateVersion` versions which sections each school's
  cards print. It is honoured by the built-in renderer, the shipped token
  template, and every card route. Issued sequence cards keep their layout.
  See §10.3 for the model, sections, default, versioning, integration, API,
  tests and limitations.
- **Phase 2(e), done: the missing-school guard.** One middleware,
  `utils/tenant.requireSchool`, refuses a request with no school (400
  `SCHOOL_REQUIRED`) on every exam, template and issued-card route. The
  results router refuses a schoolless school account and keeps the
  super_admin's documented cross-school read. The issued-card router had
  failed open: a caller with no school could read, unpublish or delete any
  school's card by id. `check:schoolguard` has 170 checks; the
  pre-change routers fail 111 of them. See §17.4 for the routes, rules,
  behaviour change and what is not covered.
- **Phase 2 is complete:** (a) through (e) are done.
- **Phase 3, done (ahead of D1, on the project owner's instruction).**
  The plan held Phase 3 until D1 was decided (§21.1). The project owner
  chose to proceed, so it was done strictly as defined: today's behaviour,
  read through the configuration, with no figure changed. D1 is still **not
  decided**. It still needs the school's authorised academic review, and it
  now blocks Phase 4, where results would actually change.
  - **What changed.** The term and annual readers take their terms and
    sequences from the period tree, not from `AcademicStructure.terms`
    directly. `shared/academicPolicy.legacyTermsFromPeriods` reads a tree
    back as numbered terms holding numbered sequences: the shape the
    readers were written against. Their arithmetic is untouched.
  - **Which readers:**
    - `termGrading.loadTermContext` and `annualGrading.annualContextFor`
      read the tree of the snapshot they already resolve and stamp. The
      resolve moved ahead of the term lookup; it was already on the path,
      and query counts are unchanged (`check:term`, `check:complexity`).
    - `reportCardData.buildTermCard`, `buildAnnualCard` and the sequence
      card's sequence name (`results.controller`) build the same tree from
      the structure document they already read (`legacyTermsOf`). They
      don't resolve a snapshot, so a card GET writes nothing.
    - The unused `termGrading.getSequenceWeights` was removed.
  - **One difference, on a shape the app can't save.** The tree lists terms
    and sequences in number order, and array order is deliberately not part
    of the policy hash (Phase 2b). A structure stored out of number order
    therefore gets the same terms, weights and averages, but its
    `sequenceAverages`, `termAverages` and term-card columns come out in
    number order. The settings screen edits the default 3×2 structure in
    place, so only a raw API write can store one. Missing and non-numeric
    weights can't reach the readers: Mongoose fills the defaults and refuses
    a non-number (checked).
  - **Kept as is, deliberately:**
    - `annualGrading` decides promotion only once `completedTerms >= 3`,
      whatever the tree holds. Counting the tree's terms would change
      results for a school with fewer terms.
    - Promotion-exam settings are still read off the structure. Both are
      promotion rules (D1b, D2), not structure.
  - **Tests.** `check:periodtree` has 20 checks and is in `check:all` after
    `check:academicpolicy`. It pins:
    - every reader's view, before and after, for six saved shapes;
    - the out-of-order difference;
    - that a stored snapshot's tree, re-read from the database, matches its
      structure;
    - real term and annual computation and real term and annual cards with
      non-50/50 weights, against hand-worked figures (13.2 / 13 / 11,
      annual 12.25).

    No earlier suite used non-default weights: forcing every sequence weight
    to 50 passed all of them, and fails 9 of these. The suite also passes
    against the pre-Phase-3 readers, so the figures are the ones they gave.
    `check:academic` (52), `check:academicpolicy` (86), `check:term`,
    `check:cards`, `check:coeff`, `check:reportcard` and `check:complexity`
    are unchanged.
- **Phase 4, done: the school's calculation rules (decisions D1–D3 and §12
  as settings, never taken by the code).**
  - **Why rules.** D1, D1b, D2 and D3 change real results and need the
    school's authorised academic review, which the code cannot give. So
    each is a rule on `AcademicStructure.rules`, chosen per school and year
    (`shared/academicRules.js`). **Every default is the behaviour before
    rules existed.** A school that sets nothing computes byte-for-byte as
    before (`check:academic` and every earlier suite unchanged) and keeps
    the same policy hash: only non-default rules enter the snapshot.
  - **The rules:**
    | Rule | Default (today) | Option | Writer version |
    |---|---|---|---|
    | `sequenceAverage` (D1) | `raw_mean` | `weighted_20`: the figure the sequence card prints (CA blended, coefficients, absent left out, 2 decimals); ranked on it; the subject passes on its blended mark (§4.6l); paper summaries carry `academicYear`/`term` (§4.7e) | `exam-process/2` |
    | `gradingAuthority` (§12) | `split` | `school_bands`: term and annual rows store the school's bands | `term/2`, `annual/2` |
    | `promotionRule` (D1b, D2) | `legacy` | `annual_average_at_least` (school bar, per-class bars), `majority_of_terms_passed`, `manual_only`. One function decides both the annual row's status and the promotion run's proposal (§4.4, §14). The run reads published `AnnualResult`/`TermResult` | `annual/2` |
    | `publishedResults` (D3) | `overwrite` | `refuse`: processing an exam, term or year with published results is refused with 409 and nothing is written; a whole-school run skips and names those classes | — |
  - **Reading /20.** Cards, the verification snapshot and class statistics
    read an `exam-process/2` average as /20 (`averageOutOf20` takes the
    row's `calcVersion`), never ×5.
  - **One ranker:** `shared/ranking.competitionPlaces`, used by term, annual
    and the weighted route. The default route keeps its own pinned loop.
  - **API:** `GET`/`PUT /api/academic-structure/:schoolId/:year/rules` and
    `POST …/rules/preview` (`settings.view` / `settings.manage`).
    - **Validation:** writes are validated strictly, and incoherent sets are
      refused (for example `annual_average_at_least` without a bar).
    - **Audit:** a no-op stores nothing. A real change is audited (`AuditLog`
      `academic.rulesChanged`, before/after and a reason).
    - **Draft promotion runs:** a promotion-rule change is refused while a
      draft promotion run exists for the year.
    - **Preview counts:** the preview returns, per layer, how many results
      are published (they keep their figures) and how many are unpublished
      (they follow the new rules when next processed).
  - **Tests:** `check:academicrules`, 63 checks. They include stored average
    === card `weightedAverage` for every pupil, and run proposals === annual
    status. Mutations: no CA blend fails 8, class bar ignored fails 2, the
    route ignoring `refuse` fails 2.
  - **Not done from the Phase 4 row:**
    - Component weights still come from `GradingConfig.caWeight/testWeight`.
      That is the same arithmetic; generalising components is the §6.4
      model, part of Phase 6.
    - Term and annual cards are still not archived at issue, and the QR is
      still refreshed per render (§10.2(4)(5)). Changing what a reprint
      shows is a document decision of its own; it is not taken here.
- **The decisions are still the school's.** No rule has been switched on for
  any school. Choosing `weighted_20` is D1. The settings screen (Phase 5)
  is where the school's authorised academic review records it, with the
  consequence shown first.
- **Phase 5, done: the settings screens** (web, Settings).
  - **Calculation rules:** per year, every option described, today's
    behaviour marked as such, published and unpublished counts, and the
    promotion bars validated. Save shows the server's preview first: what
    moves, what it reaches, the counts, any blocking draft run, and a reason
    for the audit trail.
  - **Report card sections:** the Phase 2(d) API, which had no client. Each
    section is described, with a warning where the school's own template
    prints a section regardless, a confirmation naming the new version, and
    the version history. Reorder and per-section options are not offered,
    because the API has none.
  - **Not built from §20.2:** a ranking visibility editor (§13), and an
    impact preview for structure edits (structure edits are guarded instead;
    see Phase 6).
- **Phase 6, partly done: a school shapes its own year, within the bounds
  every stored record already lives in.**
  - **The shape.** 1–3 terms (semesters by name), each with at least one
    sequence, up to 6 sequences across the year, numbered 1..m in order
    (`shared/periodStructure.js`). For example, two semesters of three
    evaluations each. No stored record needs migrating: terms stay 1–3 and
    sequences 1–6, and the term and annual layers, cards and snapshot
    already read the year from its structure (Phase 3).
  - **The save route** validates any `terms` it is sent (400
    `INVALID_STRUCTURE`). It refuses to remove a period, or move it to
    another term, while it has exams (409 `PERIODS_IN_USE`, nothing stored),
    and drops promotion exams the year no longer has. A write without
    `terms` is unaffected.
  - **The annual layer** decides the default promotion status when every
    term of the year is complete. That was `completedTerms >= 3`, which is
    identical for three-term years and could never be met by two
    semesters.
  - **Web:**
    - The structure editor adds and removes terms and sequences, numbers
      sequences across the year (it assumed two per term), and keeps
      promotion exams on their sequences.
    - Exam create and edit offer the year's own terms and sequences
      (`hooks/useAcademicPeriods`), including its own promotion exams in
      place of the fixed 5 and 6.
    - The term- and annual-results tables show one column per sequence or
      term the year actually has.
    - Everything falls back to the old fixed set when the structure cannot
      be read. That includes teachers, who lack `settings.view` (§4.6j).
  - **Tests:** `check:periodshapes`, 27 checks. The shape rules; the route,
    with nothing stored on refusal; and a two-semester school end to end,
    against hand-worked figures (semesters 13 and 12, year 12.5, three
    named columns, annual card 12.5). Mutations: the old `>= 3` rule fails
    1, no in-use guard fails 3.
  - **Not done from the Phase 6 row,** each a cross-cutting change of its
    own:
    - non-/20 scales, which the intelligence thresholds are all written in
      (`SCALE = 20`, deltas 2/4/14);
    - more than 3 terms or 6 sequences: the bounds of `Exam`, the cohort
      schema and the card tokens;
    - open assessment types and families, and `Exam.periodKey`/`componentKey`
      (§11.2);
    - cohort `FORMAT_VERSION` 2 and the §15.2 intelligence mappings;
    - the mobile and desktop term pickers.
  - **Found on the way, not fixed:**
    - Mobile's exam edit sends `"first_term"`, and its create sends
      `"Term 1"`, into the numeric `term` field.
    - The web exam list's term filter sends `"Term 1"` (400).
    - `platformStats` drops term filters above 3.

### 20.1 Safest first implementation slice

**Phase 2(a) + 2(b) + 2(c):** characterisation tests, the snapshot model with
`periodsFromLegacy`, and stamping new rows.

- It changes no figure a school sees. The tests prove that.
- It makes every *future* result answer "which configuration produced
  this?". That is the property everything else depends on, and the one the
  system cannot recover retroactively.
- The tests are the safety net Phase 3 needs. Today the term tests seed
  inputs that `processResults` never produces (§4.1), so a refactor could
  pass them and still change real results.

This slice is done, and so are Phase 2(d), section layouts (§10.3), and
Phase 2(e), the missing-school guard (§17.4), which was implemented and
verified by `check:schoolguard`. Phase 2 is complete. Phase 3 is also done,
ahead of D1 on the project owner's instruction, with no figure changed
(§20.0). Phase 4 made D1–D3 per-school rules whose defaults are today's
behaviour, so no school's results change until its authorised academic
review chooses otherwise in the Phase 5 screen. None has.

### 20.2 Admin experience (Phase 5 design; partly implemented, see §20.0)

```
Academic Settings
├─ Academic year         pick/create year; copy previous year's structure (explicit)
├─ Period structure      tree editor: add term/semester/quarter/custom; nest scored periods; order; weights
│                        (validated: siblings sum to 100; dates within the year)
├─ Assessments           per scored period: components (type, weight, default max mark, required)
│                        assessment types list (built-ins locked; school types addable)
├─ Grading               scale, bands EN/FR, pass marks, rounding, show grades
├─ Ranking               on/off, scopes, tie rule, show on cards/portal
├─ Promotion             rule, threshold on the grading scale, per-class overrides, promotion exam
└─ Report card           section list: enable/disable/reorder, per-section options, preview with a real pupil
```

**Dangerous settings: each requires a confirmation dialog that states the
consequence:**

| Change | Confirmation shows |
|---|---|
| grading scale / bands / pass mark | "N published results were produced under the current policy and will **not** change; M unpublished results will be recomputed on next processing" |
| component or period weights | same, per period; plus "exams already marked in these periods: K" |
| period structure (add/remove/re-parent) | blocked for periods that already have exams; renaming allowed |
| ranking policy | "positions on N issued cards stay as issued" |
| promotion rule | blocked while a promotion run is `draft` for that year |
| published report-card template | "issued cards keep their version; new issues use v+1" |
| converting `Class.promotionAverage` | shows old (0–100) and new (on scale) values side by side; explicit per class |

---

## 21. Risks and unresolved decisions

### 21.1 Decisions needed before Phase 3

> Phase 3 has since been done without these, as a behaviour-preserving
> refactor (§20.0). Phase 4 turned D1, D1b, D2 and D3 into per-school rules
> (`shared/academicRules.js`) whose defaults are today's behaviour. So none
> is decided by the code, and none is decided for any school until its
> authorised academic review chooses in Settings → Calculation rules. The
> questions below are the ones that review answers. D4 remains open as a
> permission question.

- **D1 (revised). Which sequence calculation is authoritative (§4.1, §4.7).**
  Real results are the live route's: a whole-number raw mean, with no CA, no
  coefficients, and absent counted as zero. The sequence card prints a
  different figure: the coefficient-weighted, CA-blended /20 mean (13.67
  against a stored 12 in the pinned case). The unrouted `processResults`
  computes a third: GPA points. Which is the school's official sequence
  average, and therefore the basis of ranks, term and annual results, and
  promotion?

  Recommendation: the coefficient-weighted, CA-blended /20 mean, with
  absent subjects excluded rather than zeroed. That is what the CA and
  coefficient features were built to produce, and what the card already
  prints. Ship it as a new `calcVersion` for new computations only.
  Published rows stay as issued, with an annotation report (§9). **This
  needs the school's authorised academic review.** It will move term and
  annual figures and promotion outcomes relative to today.
- **D1b. Promotion is blind on real data (§4.7e).** Until summaries carry
  `academicYear`, every proposal is "no results". Decide whether the run
  should read `AnnualResult` (the §14 recommendation) or summaries with a
  backfilled year. Either changes which pupils a run proposes to hold back.
- **D2. Which promotion rule is authoritative** (§4.4), and whether
  `Class.promotionAverage` was entered meaning /20, a percentage, or
  something else, since it is compared against GPA points today.
- **D3. Recompute of published results.** Today recompute silently
  unpublishes sequences and overwrites published term and annual results.
  Should Phase 4's guard *refuse*, or *recompute into a new unpublished
  revision*?
- **D4. Teacher read access to configuration** (§4.6j, §17.2).

### 21.2 Risks

| Risk | Mitigation |
|---|---|
| Phase 3 refactor silently changes results | characterisation tests from real pipeline outputs, byte-for-byte |
| A config edit is mistaken for a result correction | impact preview, confirmations, policy stamped on rows |
| Intelligence drift from custom structures | evidence boundary keeps /20 and ordinals; Phase 6 changes are version-bumped |
| Mobile lags desktop on new fields | additive columns; unknown fields ignored; server remains authority |
| Snapshot proliferation | content-addressed: identical policy → same document |
| Legacy rows read with new semantics | `policyHash null` → legacy reader, documented in §9 |
| Defects in §4.6 erode trust in printed documents | listed separately; each needs its own fix-and-review cycle |

### 21.3 Not done in this audit

- No live database was inspected, so the extent of §4.1 in real published
  data is unknown.
- Desktop renderer source is not in this repository (`desktop/src/main`
  only), so desktop UI assumptions were not audited.
- §4.6(a–h) were established by code reading. Only §4.1 and §4.6(i) were
  executed.
- No browser check of any screen.

---

## Appendix A. Commands run for this audit

```
git branch --show-current; git rev-parse HEAD; git status --short       # cold-intelligence-analysis @ 71a023d, clean but .vscode/settings.json
git switch -c academic-architecture-audit
node -e '<calculateOverallResult on 15/20×2, 9/20×1>'                  # normalizedAverage 2.53, plainAverage 2.15, grade B, passing
node <scratchpad>/scale-probe.js backend                                 # §4.1 reproduction (output quoted there)
node <scratchpad>/undef-probe.js backend                                 # §17.3: 0 documents
```

The scratch scripts are in the session scratchpad, not the repository. No
check suite was run, because no code changed. The probes exercise
unmodified services against an in-memory MongoDB.

## Appendix B. Files read (principal)

- **Models:** `AcademicStructure`, `Period`, `Exam`, `ExamSubject`,
  `ExamMark`, `StudentScore`, `GradingConfig`, `Grade`, `ResultSummary`,
  `TermResult`, `AnnualResult`, `PromotionRun`, `PromotionDecision`,
  `ResultChangeLog`, `Subject`, `School` (academic settings), `Class`
  (promotion fields), `ReportTemplate`, `GeneratedReport`,
  `DocumentVerification`.
- **Services:** `grading`, `results`, `termGrading`, `annualGrading`,
  `promotion`, `sequenceAssessment`, `reportCardData`, `reportHtml`,
  `classStats`, `resultAudit`, `resultStaleness`, `documentVerify`, and
  all of `services/intelligence/`.
- **Shared:** `gradeScale`, `caAssessment`, `reportCard`, `reportTokens`,
  `officialHeader`, and `intelligence/`, `learningEvidence/`, `strengths/`,
  `advancedIntelligence/`.
- **Routes:** academicStructure, exam, results, termResults, annualResults,
  promotion, template, generated.report, verify, documents, admin (grading
  settings), portal, teacher.
- **Sync:** `config/syncFeed.js`, `controllers/sync*.js`; mobile
  `src/db`, `src/services` (exam cache, sync manager, report data,
  mutation queue); desktop `src/main` (store, sync engine, writes,
  gradeUtils).
- **Web:** `pages/{exams,reports,settings,promotion,subjects,periods}`,
  `constants/exam.constants.ts`.
- **Docs:** 12, 05, DATA_MODEL, 19, 34, 35, 37, 38.
