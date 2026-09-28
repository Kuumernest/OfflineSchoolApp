# 28 — Longitudinal Student Development & Change Intelligence (Stage 14)

> The development layer explains how a pupil's evidence-backed profile has
> changed over time, when, and what evidence explains the change. It never
> measures the pupil: no score, no rate, no rank, no prediction, no cause.

`DEVELOPMENT_ENGINE_VERSION` **1.0.0** · academic 1.0.0 · strengths 1.2.0 ·
exploration 1.0.0 · learning evidence 1.0.0 · learning integration 1.0.0 —
none of the five beneath moved.

## 1. Objective

Stage 13 answers *what evidence supports, contradicts or limits this
strength today*. Stage 14 answers *how has that relationship changed over
time, when did the change occur, and what evidence explains it*. The system
can now distinguish a stable strength from an emerging or declining one, a
newly corroborated from a newly contradicted reading, a persistent from a
temporary contradiction, newly available from stale or retracted evidence,
and all of these from a history too short to read. It is a change layer, not
a scoring layer.

## 2. Architecture

```
Academic 1.0.0 → Strengths 1.2.0 (with Learning Integration 1.0.0) → current profile
                                          ↓ snapshots (immutable)
                                 Development Engine 1.0.0
                                          ↓
                    trajectories · change events · contradiction history
                                          ↓
                       student / teacher / parent authorised views
```

The engine consumes what already exists — `StrengthProfileSnapshot`
documents and the current profile built for the same `asOf` — and stores
nothing. There is no development model, no second source of truth, no copy
of a mark. It recomputes no academic reading and never reinterprets an old
snapshot with today's engine: a 1.1.0 snapshot enters the history under its
own version, with its own states, and with no learning relationship because
none was recorded then.

## 3. The engine (`shared/development/`)

| File | Role |
|---|---|
| `version.js` | version, vocabulary (trajectories, change types, reason codes, contradiction statuses), windows, rules, forbidden keys, not-inferred |
| `observations.js` | a snapshot or a profile → one order-free observation: per dimension state, confidence, persistence, direction, relationship, counts, families, missing modalities, standing conflicts; versions; coverage |
| `trajectory.js` | the observations of one dimension → direction, trajectory label, transitions, persistence, coverage history, quality, reasons |
| `changes.js` | two observations → change events (types + reason codes); `compareDevelopmentSnapshots` |
| `contradictions.js` | standing conflicts across observations → one record per (dimension, kind) with status |
| `index.js` | `buildDevelopmentHistory({ snapshots, current, asOf })`, `explain`, exports |

Pure: no I/O, no clock (`asOf` is required and the engine throws without
it), no randomness, no identity. Every function is deterministic.

## 4. Observations and independence

An observation is a snapshot dated on or before `asOf`, or the current
reading if it was built for a date on or before `asOf`. Observations on the
same evidence boundary hash collapse to one **independent** observation: a
snapshot taken today and today's reading are one observation, and three
snapshots forced on the same day are not persistence. Change events and the
contradiction history are read over independent observations; the trajectory
lists every observation but counts independence separately.

## 5. Trajectory model

Per dimension (and per single-subject strength outside the taxonomy, under
its own subject id):

```
dimensionId / subjectId, observations[], currentState, currentRelationship,
firstObservedAt, lastObservedAt, direction, trajectory,
persistence { observationCount, independentObservationCount, consecutiveObservations,
              independentPeriods, firstObservedAtCurrentState, academic },
stateTransitions[], relationshipTransitions[],
evidenceCoverage { current { academicSequences, learning{family: n}, learningIndependentEvents,
                             learningStale, exploration, teacherObservers, unavailable[] },
                   familyHistory[], firstSeenFamily{}, corroborationBegan },
contradictions[], changes[], quality { coverage, recency, independence, conflicts, missingModalities },
reasons[], explanation[]
```

**Direction** reuses the strengths engine's own words — `rising`,
`sustaining`, `declining` — plus `variable` and `insufficient`; it is read
from the order of states, never from a slope. **Trajectory** is one of
`INSUFFICIENT_HISTORY`, `STABLE_<STATE>`, `EMERGING`, `STRENGTHENING`,
`WEAKENING`, `DECLINING`, `RECOVERING`, `VARIABLE`. Fewer than two
independent observations is always `INSUFFICIENT_HISTORY`, whatever the
current state: *current state ≠ longitudinal trend*.

## 6. State transitions

Recorded only where the state actually changed between consecutive
observations: `INSUFFICIENT → EMERGING`, `EMERGING → ESTABLISHED`,
`ESTABLISHED → EMERGING`, `EMERGING → DECLINING`, `ESTABLISHED → DECLINING`,
`DECLINING → EMERGING`, `DECLINING → ESTABLISHED`, each with the dates of
both observations. A repeated state is an observation without a transition
(`STATE_STABLE`). Nothing is manufactured.

## 7. Evidence trajectory and coverage

Coverage is counted, never scored: academic sittings, independent learning
events per family (retries of one quiz are one event; a mark, a submission
time and a completion are one event), exploration events (a performance, an
observation and a reflection from one project are one event), distinct
teacher observers, and the list of unavailable modalities. `familyHistory`
records which families each observation carried and `firstSeenFamily` when
each first appeared. When the school starts collecting a new source the
change is `EVIDENCE_COVERAGE_CHANGED` with `EVIDENCE_COVERAGE_EXPANDED`,
never `STATE_CHANGED`; an unavailable modality is never negative evidence.

## 8. Contradiction persistence

Every standing conflict the layers beneath record (`ACADEMIC_VS_EXPLORATION`,
`EXPLORATION_MIXED`, `OBSERVATION_VS_PERFORMANCE`, `INTEREST_VS_PERFORMANCE`,
`ACADEMIC_VS_LEARNING_EVIDENCE`) becomes one longitudinal record per
(dimension, kind): `firstSeen`, `lastSeen`, `occurrences`,
`independentPeriods`, `observedIn[]`, `current`, `status`, `priority`.

| Status | Rule |
|---|---|
| `NEW` | present in the latest observation, never before |
| `PERSISTENT` | present in the latest observation and the one before |
| `RECURRING` | present now, seen before, absent in between |
| `RESOLVED` | absent in **two** independent observations after it was last seen — `resolutionDate` and `resolutionEvidence` recorded |
| `STALE` | not resolved, last seen more than a year before `asOf`, absent since |
| `INSUFFICIENT_HISTORY` | absent now but only one later observation: too soon to call it resolved |

A contradiction is never erased and never downgrades the academic state.
`priority` (NEW / RECURRING / PERSISTENT) is available to the review workflow;
no review case is created automatically.

## 9. Change events

One event per dimension per pair of consecutive independent observations:

```
changeId, dimensionId, subjectId, observedAt, previousObservedAt,
previousState, currentState, previousRelationship, currentRelationship,
previousDirection, currentDirection, previousPersistence, currentPersistence,
changeTypes[], reasonCodes[], supportingEvidence, contradictingEvidence,
evidenceBoundaryHash, previousEvidenceBoundaryHash, engineVersions
```

Change types: `STATE_CHANGED`, `STATE_STABLE`, `RELATIONSHIP_CHANGED`,
`RELATIONSHIP_STABLE`, `DIRECTION_CHANGED`, `PERSISTENCE_CHANGED`,
`EVIDENCE_ADDED`, `EVIDENCE_RETRACTED`, `EVIDENCE_BECAME_STALE`,
`EVIDENCE_COVERAGE_CHANGED`, `CONTRADICTION_STARTED`,
`CONTRADICTION_PERSISTED`, `CONTRADICTION_RESOLVED`, `NO_MEANINGFUL_CHANGE`.
Reason codes: `ACADEMIC_STATE_CHANGED`, `LEARNING_CORROBORATION_ADDED`,
`LEARNING_CORROBORATION_LOST`, `LEARNING_CONTRADICTION_ADDED`,
`LEARNING_CONTRADICTION_PERSISTED`, `LEARNING_CONTRADICTION_RESOLVED`,
`CONTRADICTION_NOT_CURRENTLY_OBSERVED`, `EVIDENCE_COVERAGE_EXPANDED`,
`EVIDENCE_COVERAGE_REDUCED`, `EVIDENCE_BECAME_STALE`, `EVIDENCE_RETRACTED`,
`EXPLORATION_EVIDENCE_ADDED`, `TEACHER_OBSERVATION_ADDED`,
`PROFILE_VERSION_CHANGED`, `INSUFFICIENT_HISTORY`, `ACADEMIC_DIRECTION_CHANGED`,
`ACADEMIC_PERSISTENCE_CHANGED`, `NEW_EVIDENCE_WITHOUT_STATE_CHANGE`. A single
new event beside an unchanged state is `EVIDENCE_ADDED` +
`NEW_EVIDENCE_WITHOUT_STATE_CHANGE`; it is never a trend.
`CONTRADICTION_RESOLVED` is emitted only when the history's resolution rule
holds; otherwise the absence is `CONTRADICTION_NOT_CURRENTLY_OBSERVED`.

## 10. Snapshot comparison

`compareDevelopmentSnapshots({ previous, current })` reduces both to
observations and reports state, relationship, direction and persistence
changes, new / retracted / stale evidence, new / persisted / resolved
contradictions and coverage changes. Because it compares the reduced shape,
object order, serialisation timestamps, ids and database metadata cannot
produce a difference; a real difference always does.

## 11. `asOf`

Every development read accepts `?asOf=`; the same value goes to the strengths
layer (and through it to the learning and exploration layers) for the current
reading, and filters the snapshots. Nothing after `asOf` exists for that
read: as of a date before the first snapshot, the history is one observation
and `INSUFFICIENT_HISTORY`. The same `asOf` twice is byte-identical. Rebuild
and snapshot keep using the server's today, as Stage 13 specifies.

## 12. Evidence retraction

A retracted or corrected record changes the next reading and no snapshot.
`ESTABLISHED + CORROBORATED` followed by the retraction of the corroborating
work reads `ESTABLISHED + UNSUPPORTED` with `LEARNING_CORROBORATION_LOST` and
`EVIDENCE_RETRACTED` — never "ability declined". A contradiction that was
based on the retracted work becomes `CONTRADICTION_NOT_CURRENTLY_OBSERVED`
and, in the history, `INSUFFICIENT_HISTORY` until two later observations.

## 13. Missing modalities and staleness

`quality.missingModalities` lists what the record does not contain;
`quality.coverage` is LIMITED / MODERATE / BROAD by the number of families
present (the fusion layer's bar of three for broad); `quality.recency` and
the learning layer's recency semantics (RECENT ≤ 120 d, HISTORICAL ≤ 365 d,
STALE) are reused. Stale evidence stays in the historical trajectory; only
the current interpretation excludes it, as the layers beneath already do.

## 14. Privacy

The engine is name-free (no name, email, phone or address field is read or
written) and carries no reflection text: exploration evidence reaches it as
counts and ids only. Identity is joined by the router after authorisation.
The parent's view carries states, categories and counts — no reason codes,
no reviewer, no note.

## 15. Authorisation

Unchanged from the strengths routes: a pupil reads their own (`me`), a
teacher within `mayReadClass`, a school admin their school, the operator
only with an explicit `schoolId` (never all schools), the bursar never. The
guardian reads an unlocked child only.

## 16. Offline consistency

`historyFor` and `offlineHistoryFor` build the same history from the live
loader and from mirrored (JSON round-tripped) snapshots with the strengths
layer's offline road, on one `asOf`. The consistency route diffs them and
names the classes: `trajectory`, `transitions`, `changeTypes`,
`changeReasons`, `quality`, `persistence`, beside the earlier `state`,
`relationship`, `contradictions`, `versions` and the rest. The pilot
readiness check expects every class false; a real difference fails closed.

## 17. API

| Route | Content |
|---|---|
| `GET /api/insights/student/:id/development` | engine version, asOf, versions, history counts, observations, trajectories, changes, contradictions, coverage, quality |
| `GET /api/insights/student/:id/development/changes` | change events filtered by `from`, `to`, `dimensionId`, `subjectId`; the filter echoed |
| `GET /api/insights/student/:id/development/evidence` | per trajectory the supporting / contradicting event references (id, family, subject, date, recency), exploration evidence ids, coverage, and each change's boundaries |
| `GET /api/insights/student/:id/consistency` | now also `development { identical, engineVersion, summary, differences }` |
| `GET /api/portal/children/:id/development` | developing / consistent / changing / too early, each with history, what supports it, what is unclear |

## 18. Mobile UX

`mobile/app/student/development/` — *Your development*: per strength the
current state and trajectory, the history period by period, *Why it
changed* (the explanation lines) and *Still unclear* (insufficient history,
unavailable sources). A tile on the pupil's home opens it. Online only; no
score, no ranking, no career.

## 19. Teacher UX

On the strengths page, a *Development over time* section: per dimension the
current and previous state, trajectory, direction, evidence relationship,
the history period by period, why it changed, coverage counts per family,
what is still unclear, and (for staff) the change events with their reasons,
the quality (coverage / recency / independence) and the contradictions over
time with status, occurrences and dates.

## 20. Limitations

- A history needs snapshots. Until a school takes them at term ends, most
  pupils read `INSUFFICIENT_HISTORY`, correctly.
- Two independent observations is the least a trajectory needs; the pilot
  should tell whether that bar, the two-observation resolution rule and the
  one-year stale window are right. None was tuned on real data.
- Independence between observations is the evidence boundary hash, which
  includes `asOf`: the same evidence read on two different days is two
  observations, by design (recency changed), but a reader should know it.
- The engine reads what the layers beneath recorded. It cannot recover a
  relationship for a 1.1.0 snapshot, and does not try.

## 21. Real-world validation

No real pupil has been through the development engine. Real evidence enters
through the Stage 8 pilot and nothing else. **Real-world validation is still
pending.**

## 22. Stage 15 — what the history feeds downstream

The guidance engine (docs/29) reads each trajectory's `trajectory`,
`direction`, `currentState`, `currentRelationship`, `quality`,
`contradictions`, `evidenceCoverage` and the last change event, and nothing
else. The intervention engine reads the same trajectories for its triggers
(`PERSISTENT_DECLINE` from two consecutive declining observations,
`LEARNING_CONTRADICTION` from a persistent or recurring contradiction, and so
on) and, for an outcome, the observation before and the observation after an
intervention's start date. Neither writes anything back: the next snapshots
carry what happened, and the history reads them as it reads any other.

## 23. Stage 16 — the history at review time

A plan review (docs/30) reads this history for its day: the observations of
the plan's dimension since the plan's start on a boundary other than the
plan's own are its "new independent evidence"; the reading before and after
the start is its development change. The history is not written to by a plan:
the next snapshots carry what happened, and the loop closes there.
