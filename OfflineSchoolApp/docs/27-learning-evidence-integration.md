# 27 — Learning Evidence Integration & Multi-Modal Student Intelligence (Stage 13)

> Learning evidence corroborates, qualifies or contradicts the academic
> reading of a strength. It is never a score, never a weight, and never a
> verdict on the child. More evidence-aware without becoming a scoring system.

`STRENGTH_ENGINE_VERSION` **1.2.0** · `LEARNING_INTEGRATION_VERSION` **1.0.0** ·
academic 1.0.0 · exploration 1.0.0 · learning evidence 1.0.0 — the three
beneath are unchanged; the strengths engine moved because its reading changed.

## 1. Purpose

Stage 12 built a Learning Evidence layer that represents the school's own
records — assignments, quizzes, continuous assessment, practicals, attendance —
as events and patterns, and handed the engines nothing. Stage 13 is the
versioned decision that follows: the independent learning evidence is set
beside each dimension's academic reading and the relationship between the two
is reported, per dimension, with counts, sources, dates, limits and reasons.
The question it answers is *"what independent evidence supports, qualifies or
contradicts this reading?"* — not *"what is the pupil's combined score?"*.

## 2. Where it lives

| Piece | Path |
|---|---|
| Pure integration | `shared/strengths/learningIntegration.js` — `integrateLearningEvidence({ readings, academicProfile, learningEvidence, explorationEvidence, subjectNames, asOf })`; no I/O, no clock, no randomness, no identity |
| Engine | `shared/strengths/engine.js` — `buildStrengthProfile({ academicProfile, explorationEvidence, learningEvidence, subjectNames, asOf })` fuses (1.1.0) then integrates (1.2.0) |
| Change codes | `shared/strengths/fusion.js` — `learningChangeOf`, folded into `compareProfiles` |
| Service | `backend/src/services/intelligence/strengths.service.js` — loads the learning reading on the same `asOf`, joins subject names, extends the evidence boundary and the snapshot |
| Snapshot | `StrengthProfileSnapshot` — `learningIntegrationVersion`, `learningEvidenceVersion`, `evidenceBoundary.learningEvents / latestLearningEventAt` |
| Consistency | `backend/scripts/calibration/consistency.js` — difference classes `state, relationship, reasonCodes, eventCounts, sources, contradictions, versions` |
| Check | `backend/scripts/check-learning-integration.js` (`npm run check:integration`, in `check:intel`) |

## 3. Authority — the contract

`LEARNING_EVIDENCE_AUTHORITY`, exported and frozen:

| Family | Authority | Meaning |
|---|---|---|
| academic | **baseline** | anchors state, persistence, direction and consistency; never retired or rescued by anything below |
| practical, coursework, quiz, assignment, exploration | **supporting_capability** | may corroborate; two independent, clean, non-stale events may move a reading one step above its baseline |
| teacherObservation | **supporting_observation** | the 1.1.0 two-observer rule; reported here, not recounted |
| interest, reflection, exposure, participation, attendance, submission | **context_only** | never ability; attendance may mark thin evidence `CONTEXT_LIMITED`, nothing more |

Tiers in prose: Tier 1 the academic baseline; Tier 2 independent demonstrated
learning evidence; Tier 3 teacher observation (two distinct observers,
unchanged from 1.1.0); Tier 4 exploration corroborates and never overrides;
Tier 5 context.

## 4. Independence

- One learning event is one event whatever it carries. A homework's mark,
  submission time and completion are three observations of one event and one
  item; a submission without a mark is context and no item.
- Quiz retries share the quiz's `independentKey` and collapse to the latest
  attempt; the profile reports `duplicateEventsCollapsed` and the quality code
  `DUPLICATE_EVENT_COLLAPSED`.
- **Nothing the baseline already read is counted again.** Formal test and
  promotion-exam marks are the academic engine's input and are excluded. A
  practical is, in this application, a `StudentScore` under an exam of type
  `practical`, which the academic engine also reads (`cohortSchema`
  `ASSESSMENT_TYPES`); it is therefore reported as `baselineEventsNotRecounted`
  and never corroborates. Continuous assessment (`ca`) is skipped by the
  academic engine (`academicOrder.js`: "half of a sequence, not an occasion")
  and is therefore independent — COURSEWORK counts. The PRACTICAL family stays
  in the contract for a practical recorded outside the results, of which the
  repository holds none today.
- Exploration events and teacher observers were counted by 1.1.0; 1.2.0
  reports them under `corroboration` and does not recount them.
- Subjects reach dimensions through the taxonomy by subject **name**; the
  service joins names to the learning events' subject ids (the academic
  profile's names first, the `Subject` collection for a subject with homework
  or quizzes but no exam mark). A subject with no known name maps to no
  dimension and lifts nothing.

## 5. Direction of one item

Read against the school's own marks on the 0–1 scale the learning layer
already normalises to: at or above the strong mark (`strongMark / 20`, the
academic engine's own threshold) supports; below the pass mark contradicts;
between is neutral. No weighting: every item is one count.

## 6. Relationships

| Relationship | Rule |
|---|---|
| `CORROBORATED` | ≥ 2 independent supporting events, none contradicting |
| `PARTIALLY_CORROBORATED` | 1 supporting, or support beside contradiction |
| `CONTRADICTED` | ≥ 2 contradicting events and more contradicting than supporting |
| `UNSUPPORTED` | no independent learning evidence speaks to the dimension |
| `INSUFFICIENT_EVIDENCE` | evidence exists but is stale or only neutral |
| `CONTEXT_LIMITED` | fewer than two live events beside irregular or declining attendance (never overrides `CONTRADICTED`; never applied to a corroborated reading) |

Thresholds (`INTEGRATION`): `eventsToCorroborate 2`, `eventsToContradict 2`,
`minWeight 0.5` — the same bar 1.1.0 set for exploration. No threshold in the
academic, exploration or learning layers changed.

## 7. What may move, and what may not

- The 1.1.0 state and confidence are kept as `fusedState` / `fusedConfidence`;
  the academic answer as `baseState`, `baseConfidence`, `basePersistence`,
  `baseDirection`, `baseConsistency` and the `academic` block.
- Clean corroboration (≥ 2 supporting, 0 contradicting, non-stale) lifts
  **one step above the academic baseline**: `INSUFFICIENT → EMERGING` or
  `EMERGING → ESTABLISHED`, with `stateSource: "learning_evidence"` — and only
  when exploration has not already taken that step. If it has, the reason
  `LEARNING_SUPPORT_AFTER_EXPLORATION_LIFT` is recorded and nothing moves.
  No reading rises two steps in one integration however many modalities agree;
  six clean events from two families reach `EMERGING`, not `ESTABLISHED`.
- `CONTRADICTED` beside an `ESTABLISHED` or `EMERGING` reading steps
  confidence down once. The state is never retired.
- A `DECLINING` academic reading is never rescued; the support is reported.
- An `INSUFFICIENT` reading contradicted by learning evidence stays
  `INSUFFICIENT`; no dimension is minted to be contradicted.
- Attendance, submission, interest, reflection, exposure and participation
  never change a state or a confidence.

## 8. Missing modalities

`MODALITIES` = ASSIGNMENT, QUIZ, COURSEWORK, PRACTICAL, EXPLORATION,
TEACHER_OBSERVATION, INTEREST, REFLECTION, ATTENDANCE. A modality with no record
for the pupil is **unavailable** and listed in `context.missingModalities`;
it is never read as weak and never lowers anything. A learning reading that is
absent altogether (`learningEvidence: null`) still builds a profile, with
`learningIntegration.available: false` and the limitation
`no_learning_evidence`.

## 9. The integrated reading, per dimension

```
academic          { state, confidence, persistence, direction, consistency }
learningEvidence  { relationship, independentEventCount, sourceFamilies,
                    currentEventCount, historicalEventCount, staleEventCount, subjects }
corroboration     { supportingSources, supportingEvents[], contradictingSources, contradictingEvents[],
                    neutralEvents, explorationSupportingEvents, explorationContradictingEvents, teacherObservers }
context           { attendanceLimited, attendancePattern, submissionContextAvailable, missingModalities }
interpretation    { state, confidence, stateSource, relationship, reasonCodes[], quality[], contradictions[] }
```

Each event reference carries `eventId`, `independenceKey`, `sourceKind`,
`subjectId`, `subjectName`, `observedAt`, `recency`, `normalizedValue` — no
note text, no teacher's words. The profile carries `learningIntegration`:
version, authority, thresholds, `items`, `modalities`, `missingModalities`,
`relationships`, `contradictions`, `quality`, `duplicateEventsCollapsed`,
`baselineEventsNotRecounted`.

## 10. Explainability

Reason codes in `interpretation.reasonCodes` (beside the 1.1.0 fusion
reasons): `LEARNING_SUPPORT:n`, `LEARNING_CONTRADICTION:n`,
`LEARNING_SUPPORT_BELOW_THRESHOLD:1`, `LEARNING_SUPPORT_AFTER_EXPLORATION_LIFT`,
`LEARNING_FAMILIES:A+B`, `LEARNING_STALE:n`, `ATTENDANCE_LIMITED_COVERAGE`,
`MODALITY_UNAVAILABLE:X`. A conflict is kept standing as
`ACADEMIC_VS_LEARNING_EVIDENCE` with the academic state, the counts, the
families and five possible explanations (`different_task_type`,
`different_period`, `limited_evidence`, `assessment_context`,
`missing_context`) — offered, never chosen.

## 11. Data quality codes

`NO_INDEPENDENT_LEARNING_EVENTS`, `DUPLICATE_EVENT_COLLAPSED`,
`LEARNING_EVIDENCE_STALE`, `LEARNING_EVIDENCE_PARTIAL`,
`SOURCE_MODALITY_UNAVAILABLE`, `ACADEMIC_LEARNING_CONFLICT`,
`CONTEXT_INCOMPLETE` — per dimension in `interpretation.quality`, and
de-duplicated on the profile. A conflict anywhere adds the profile limitation
`academic_learning_conflict`.

## 12. Longitudinal change

`compareProfiles(previous, current)` now carries `learningEvidence[]` and, on
each dimension entry, `learningEvidence { previous, current, reasons }`. The
codes are about evidence, never ability: `LEARNING_EVIDENCE_CORROBORATION_ADDED`,
`_CONTRADICTION_ADDED`, `_COVERAGE_CHANGED` (the source families changed),
`_BECAME_STALE`, `_RETRACTED` (fewer events than before), `_CONTEXT_CHANGED`
(attendance limitation or pattern changed). A 1.1.0 snapshot, which has no
learning block, yields no codes — nothing is invented for the past.

## 13. Evidence boundary and snapshots

The boundary hash covers the exploration evidence ids, the academic coverage,
every independent learning item (`eventId`, source version, normalised value),
the `asOf`, and all four versions (academic, strengths, integration, learning
evidence). A corrected mark, a retracted homework, a new quiz or a version
bump changes the hash; a rebuild on an unchanged boundary returns the existing
snapshot. Snapshots record `academicEngineVersion`, `strengthEngineVersion`,
`explorationEngineVersion`, `learningIntegrationVersion`,
`learningEvidenceVersion`; old snapshots are never edited — a retraction
changes the next reading only.

## 14. Live = offline

`profileFor` reads the learning evidence through the live loader;
`offlineProfileFor` through the mirrored (JSON round-tripped) documents and
the exporter's road to the academic profile — both on one shared `asOf`. The
consistency route diffs the two and names the class of any difference:
`state`, `relationship`, `reasonCodes`, `eventCounts`, `sources`,
`contradictions`, `versions`. The check asserts byte-identical profiles.

## 15. Routes — extended, none added

| Route | 1.2.0 addition |
|---|---|
| `GET …/student/:id/strengths` | the profile carries the integrated dimensions and `learningIntegration`; accepts `?asOf=` for reads |
| `GET …/student/:id/profile` | `current` carries both new versions and the integration summary (no events); history rows carry every version |
| `GET …/student/:id/profile/timeline` | `learningRelationships`, learning conflicts beside exploration conflicts, every version |
| `GET …/student/:id/profile/changes` | `previous`/`current` versions; `comparison.learningEvidence[]` |
| `GET …/student/:id/profile/evidence` | `learningAuthority`, `learningIntegration.items`, modalities, versions, and the five integrated blocks per dimension |
| `GET …/student/:id/consistency` | `strengths.summary` and `strengths.versions` |
| `POST …/profile/rebuild`, `…/profile/snapshot` | unchanged; snapshots carry the new versions; the server's versions, never the request's |

Authorisation is unchanged: a pupil reads their own (`me`), a teacher within
`mayReadClass`, a school admin their school, the operator only with an
explicit `schoolId`, the bursar never. The guardian's view (`forGuardian`)
adds the versions only.

## 16. Presentation

**Pupil** (web `student-strengths`, mobile Explore): *Your strengths* —
each established or emerging dimension with *How we know* (the academic
reading and the relationship), *What supports this* (independent events by
family, current / earlier / too old), *What is still unclear* (quality,
unavailable sources, attendance context, a conflict with its possible
explanations), *What you can explore next* (the areas the dimension opens).
No percentage, no score, no ranking. **Teacher**: the same, plus *Evidence,
source by source* — every supporting and contradicting event with its family,
subject, date and recency, the neutral count, and the limitations. Locale keys
under `strengths.integration` in EN and FR, web and mobile.

## 17. What this stage does not do

- No career prediction, no psychological inference, no ranking, no score of
  any kind (`studentScore`, `intelligenceScore`, `talentScore`,
  `learningScore`, `careerScore`, `overallScore`, `abilityScore` are checked
  absent from the module and from a full profile).
- No LLM in the decision path; no manufactured teacher feedback.
- No threshold of the academic, exploration or learning layers changed.
- The exploration engine is untouched (`EXPLORATION_ENGINE_VERSION` 1.0.0).
- No real pupil has been through the integrated reading. **Real-world
  validation is still pending**; real evidence enters through the Stage 8
  pilot and nothing else.

## 18. Stage 14 — what the integration leaves for the history

The per-dimension blocks this stage added (`academic`, `learningEvidence`,
`corroboration`, `context`, `interpretation`) are kept in every snapshot's
reading, so the Development Engine (docs/28) can read, for each observation,
the relationship, the independent event count, the families, the unavailable
modalities and the standing `ACADEMIC_VS_LEARNING_EVIDENCE` conflict — and
describe how each changed between observations without recomputing anything.
A snapshot from before this stage has none of these and is read as such.

## 19. Stage 15 — what the integration feeds guidance

The learning relationship this stage records per dimension is what the
guidance engine (docs/29) reads as `CORROBORATED` (→ DEEPEN beside MAINTAIN),
`CONTRADICTED` (→ REFLECT, and SEEK_SUPPORT on a decline), `UNSUPPORTED` or
`INSUFFICIENT_EVIDENCE` (→ BUILD_EVIDENCE) and `CONTEXT_LIMITED` (→ MONITOR).
Two consecutive contradicted readings are the intervention trigger
`REPEATED_DIFFICULTY`. Nothing here changed for that.
