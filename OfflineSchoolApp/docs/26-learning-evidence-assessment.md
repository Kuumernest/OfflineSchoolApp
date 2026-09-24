# 26 — Learning Evidence Assessment (Stage 12)

> Learning evidence describes observed educational activity and performance.
> It does not by itself establish personality, motivation, intelligence,
> psychological traits, or career suitability.

`LEARNING_EVIDENCE_VERSION` 1.0.0 · academic 1.0.0 · strengths 1.1.0 · exploration 1.0.0 — none of the
three moved because this layer reads them.

## 1. Audit — what learning records exist in this repository

| Data source | Model | Owner | Available fields | Published / final state | Offline support | Current intelligence use | Proposed evidence type | Limitations |
|---|---|---|---|---|---|---|---|---|
| **Assignments (homework)** | `Homework` (class-level) with embedded `submissions[]` | teacher | subjectId, classId, dueDate, maxScore, allowLate, isPublished; per pupil: submittedAt, score, gradedAt | `isPublished` = assigned; `gradedAt` = final mark; past due with no submission = not submitted | mirrored (`homework`, `homework.view`) | none | ACHIEVEMENT (marks) + ENGAGEMENT (completion, submission timing) + CONTEXT (pending, ungraded) | free-text feedback excluded; a homework without a due date has no lateness |
| **Quizzes** | `QuizAttempt` / `Quiz` (`QuizModule.js`) | pupil (attempt), teacher (quiz) | quiz_id, user_id (the pupil's *User* id), status, raw_score, max_score, submitted_at, attempt_number; quiz: subject_id, class_id, is_published | `status` submitted / timed_out = final; in_progress / abandoned = context | quiz definitions deliberately not mirrored (answers); attempts are the phone's own until synced | none | ACHIEVEMENT + PERSISTENCE (retries) | attempts keyed by user id, joined to the pupil in the service |
| **Class tests, exams** | `StudentScore` + `Exam` (type `test`, `promotion_exam`) | teacher / office | score, maxScore, isAbsent, isExempt; exam: type, academicYear, term, sequenceNumber, startDate, resultsPublished | `resultsPublished` | mirrored (`studentScore`, `exam`) | the academic engine reads the published `ResultSummary` built from these | ACHIEVEMENT, family *formal* | duplicates the academic engine's input by design; this layer never recomputes an average the academic engine owns |
| **Continuous assessment (coursework)** | `StudentScore` + `Exam` type `ca` | teacher | as above | as above | mirrored | folded into the academic engine's subject mark | ACHIEVEMENT, family *continuous* | — |
| **Practical / laboratory work** | `StudentScore` + `Exam` type `practical` | teacher | as above | as above | mirrored | none as a distinct kind | **SKILL**, family *practical* | rare; a pattern needs 3 practicals, a contradiction 2 |
| **Attendance** | `StudentAttendance` (`Attendance.js`) | teacher | date, status (present / absent / late / excused), subjectId, periodId | final on marking | mirrored (`studentAttendance`) | the early-warning watch list | ENGAGEMENT / CONTEXT | no "expected days" source: unmarked days cannot be derived and are not invented |
| Participation | — | — | — | — | — | — | **does not exist**; not invented | the only participation evidence is the exploration layer's own row |
| Projects | — | — | — | — | — | — | **does not exist**; not invented | — |
| Teacher remarks | `StudentScore.remark / teacherRemark`, `ResultSummary.subjectBreakdown[].remark` | teacher | free text | — | mirrored | none | **excluded** — free text is not a signal | — |

## 2. Taxonomy (`shared/learningEvidence/taxonomy.js`)

Five evidence types with their authority: **ACHIEVEMENT** (demonstrated
performance on a task — not, by itself, a subject strength), **SKILL** (a
practical), **ENGAGEMENT** (interaction with a learning opportunity — never
ability), **PERSISTENCE** (repeated engagement — never a trait), **CONTEXT**
(what limits the rest — never a strength or a weakness). Families: formal,
continuous, practical, quiz, homework. Observation kinds: performance,
submission, completion, attendance, context.

## 3. Events and identity (`events.js`)

One source record → one event with a `learningEventId` (`homework:<id>`,
`quiz:<quizId>:<attempt>`, `exam:<examId>:<subjectId>`, `attendance:<id>`)
and several observations kept apart. A homework's mark, its submission time
and its completion are three observations on one event; nothing counts an
event more than once. Quiz retries are distinct events sharing an
`independentKey`, so a pattern counts quizzes, not attempts. Duplicate ids are
kept once and reported. Every event carries provenance (`sourceModel`,
`sourceId`, `sourceVersion`) and context (year, term, sequence, class).

## 4. Semantic states

`VALID`, `ZERO` (a genuine zero, value 0), `NULL_SCORE`, `ABSENT`, `EXEMPT`,
`UNPUBLISHED`, `NOT_SUBMITTED`, `NOT_GRADED`, `PENDING` (not yet due),
`IN_PROGRESS`, `ABANDONED`, `TIMED_OUT`. A normalised value (0..1) exists only
when score and maxScore are numbers and maxScore is positive. None of the
other states is ever converted into a zero; each carries no value and says
why. Unpublished homework was never assigned and yields no event; pending
homework enters no completion count.

## 5. Patterns (`patterns.js`)

A performance pattern needs **3 independent, valid, non-stale** observations:
IMPROVING / DECLINING (later-half mean vs earlier-half mean by ≥ 0.10),
VARIABLE (spread > 0.20), CONSISTENT, else INSUFFICIENT_EVIDENCE. Every
reading carries events, valid, independent, recent / historical / stale,
first and last observed, mean, spread, delta. Homework completion:
CONSISTENTLY_COMPLETED ≥ 90 %, OFTEN_COMPLETED ≥ 60 %, OFTEN_MISSING, on ≥ 3
assigned; submission timing MOSTLY_ON_TIME ≥ 80 % / OFTEN_LATE on ≥ 3
submitted (ON_TIME, LATE, VERY_LATE > 7 days, MISSING, NO_DEADLINE).
Attendance: presence rate over marked days (excused reported and left out),
≥ 10 days for a pattern, STABLE ≥ 90 %, IRREGULAR, DECLINING / IMPROVING on a
half-to-half change of 0.10. Persistence: quizzes retried, current completion
streak. Recency: RECENT ≤ 120 days, HISTORICAL ≤ 365, STALE beyond — kept,
listed, counted in nothing. `asOf` is an input; no function reads the clock;
with nothing to date, `asOf` is null.

## 6. Evidence quality and contradictions (`quality.js`)

Coverage per family and per subject: NO_DATA (0), INSUFFICIENT_DATA (< 3),
SPARSE_DATA (< 6), GOOD_COVERAGE (< 12), STRONG_COVERAGE — a count of
independent valid current observations, never a performance score. Flags:
STALE_DATA, INCOMPLETE_PERIOD (pending or ungraded work), CONFLICTING_DATA,
LIMITED_BY_ATTENDANCE (thin formal evidence beside irregular attendance — a
note about coverage, never about ability). Contradictions are named with
their counts and left standing: FORMAL_VS_CONTINUOUS_ASSESSMENT,
THEORY_VS_PRACTICAL, PERFORMANCE_VS_ENGAGEMENT, ATTENDANCE_VS_COMPLETION,
RECENT_VS_HISTORICAL.

## 7. Attendance limitations

Attendance is engagement and context. Low attendance never reads as low
ability; it limits what the formal evidence can show and is said so. The
register records marked days only; unmarked days are not derivable from any
source in this application and are reported as unknown.

## 8. The integration boundary

`learningEvidenceForIntelligence()` classifies every pattern as an
ACHIEVEMENT_SIGNAL, SKILL_SIGNAL, ENGAGEMENT_SIGNAL, PERSISTENCE_SIGNAL,
CONTEXT_SIGNAL or COVERAGE_SIGNAL and states which engines it may influence:

```
INTEGRATION = { strengthEngine: [], explorationEngine: [], guidance: [] }
```

In 1.0.0 every signal is informational. The strength engine (1.1.0), the
exploration engine (1.0.0) and guidance read exactly what they read before;
the test asserts a strengths profile is byte-identical with and without this
layer. Authorising a signal is a versioned decision of the receiving engine.

## 9. Privacy

Rows reach the pure layer reduced to ids, dates, scores and states. A row
carrying a name, contact, guardian, token or password field is refused and
reported. Notes and feedback text never enter. Identity is joined by the
router after authorisation.

## 10. Authorisation and routes

`GET /api/insights/student/:id/learning-evidence | learning-patterns |
learning-coverage | learning-changes`, `POST …/learning-evidence/rebuild`
(staff), `GET …/learning-evidence/consistency` (staff),
`GET /api/portal/children/:id/learning` (guardian). Teacher: assigned classes;
school_admin: the school; super_admin: the school selected with `?schoolId`
and nothing without one; pupil: their own, by role; bursar: nothing.

## 11. Offline

The sources are mirrored already (homework, scores, exams, attendance); quiz
definitions are deliberately not, and attempts are the phone's own until they
sync. The projection from documents to rows is one function; the consistency
route feeds it the live documents and the same documents round-tripped
through JSON as a mirror holds them, and diffs the two readings structurally.
Transport (dates as strings) is the only difference allowed, and the layer's
own date parsing normalises it.

## 12. Snapshots

`LearningEvidenceSnapshot`: numbered per pupil, the layer's version, `asOf`,
a hash of exactly which events (with their states and values) it was made
from, the reading without the events. Rebuild is idempotent on the hash; a
corrected source record changes the next reading and never an old snapshot.

## 13. What the system does not infer

Personality, motivation, discipline, laziness, intelligence, ability from
attendance, ability from participation, career, dropout risk, mental health,
a student ranking, a student score. There is no weighted formula anywhere:
no field is a score of the pupil, and coverage is never presented as one.
