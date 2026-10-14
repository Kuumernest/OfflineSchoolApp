# 30 — Development Planning & Adaptive Support Intelligence (Stage 16)

> A development plan turns guidance into something a pupil and a teacher work
> on together: a bounded objective, controlled actions, observable milestones,
> a review date. At review the system reads the evidence and answers with one
> categorical outcome; a person decides. Nothing is a score, a probability, a
> prediction or a future identity.

`DEVELOPMENT_PLANNING_ENGINE_VERSION` **1.0.0** · `ADAPTIVE_SUPPORT_ENGINE_VERSION`
**1.0.0** · academic 1.0.0 · strengths 1.2.0 · exploration 1.0.0 · learning
evidence 1.0.0 · learning integration 1.0.0 · development 1.0.0 · guidance
1.0.0 · intervention 1.0.0 — none of the eight beneath moved.

## 1. Purpose

Stage 15 can say "the pupil could try additional practical activities". Stage
16 lets an authorised person and the pupil turn that into a plan: an objective,
a chosen action, milestones that are observable events, a review that reads
what evidence became available, and an adaptation the human may take. The
loop — evidence → development → guidance → intervention → plan → milestones →
review → new evidence → development — is longitudinal, measurable through
observable evidence, student-participatory and adaptable, and it is not
autonomous at any step.

## 2. Architecture

| Piece | Path |
|---|---|
| Planning engine | `shared/developmentPlanning/` — `version`, `taxonomy`, `rules`, `milestones`, `buildPlan`, `review` (reconstruction), `index` |
| Adaptive engine | `shared/adaptiveSupport/` — `version`, `rules`, `reviewPlan`, `adaptPlan`, `index` |
| Model | `DevelopmentPlan` (see §3 for why it is its own collection) — registered in the sync feed as read-online, never mirrored |
| Service | `developmentPlans.service.js` |
| Routes | insights `…/development-plans`, `…/development-plans/:planId`, `/accept`, `/decline`, `/pause`, `/milestones/:milestoneId`, `/reflect`, `/constraints`, `/review`; portal `…/children/:id/development-plans` |
| Checks | `check-development-planning.js` (48), `check-adaptive-support.js` (32) |

Both engines are pure: no database, no Express, no identity, no filesystem, no
network, no clock (`asOf` is required for a review), no LLM. The mobile client
holds none of the logic; it reads the server's plan and the server's reading.

## 3. The development plan model

```
id, studentId, dimension, subjectId,
objective { category, code, evidenceFamilies, completion { requiredMilestones, independentObservations } },
rationale { guidanceId, guidanceCategory, reasons, observed { state, trajectory, relationship, direction }, evidenceQuality, eligibility },
sourceGuidanceIds, sourceInterventionIds,
actions [{ actionType, explanation, addedAt, replacedAt }],
milestones [{ milestoneId, kind, owner, order, evidenceFamily, state, reason, history[] }],
reviewSchedule { startDate, reviewDate, intervalDays }, ownerRole,
studentParticipation { required, acceptedAt, declinedAt, reflections },
status, statusHistory[], reviews[], adaptations[], reflections[], constraints[],
evidenceBoundaryHash, engineVersions, explanation, createdAt, updatedAt
```

The evidence is referenced (the strengths boundary hash and the source ids),
never copied. **Why a new collection:** the existing records were considered
first. An Intervention is one support action with its own eight-state
lifecycle; a plan aggregates guidance and interventions, carries milestones
with their own state machine, reviews with a system reading beside a human
decision, adaptations that replace actions without deleting them, the pupil's
reflections and documented constraints, and runs a ten-state lifecycle. Folding
it into Intervention would hand the legacy readers rows that are not
interventions and a status they cannot derive. `StrengthProfileSnapshot` is
immutable history; the exploration records are exploration-scoped. None can
carry a plan's lifecycle safely. The record is append-only: nothing is edited
in place, so the plan as of any date is reconstructable.

## 4. Objectives

Ten categories — `BUILD_SKILL`, `INCREASE_PRACTICE`, `INCREASE_EXPOSURE`,
`EXPLORE`, `STRENGTHEN_CONSISTENCY`, `ADDRESS_DECLINE`, `RESOLVE_EVIDENCE_GAP`,
`TEST_AN_APPROACH`, `REFLECT`, `SEEK_SUPPORT` — each with an objective code
("increase exposure to applied work in this area"), default actions from the
controlled vocabulary, milestone kinds with their owners, the evidence families
it collects, and completion criteria (required milestones plus at least one
new independent observation; a reflection objective needs none). A guidance
category opens one objective (`GUIDANCE_TO_OBJECTIVE`); MONITOR opens none. No
objective names a future identity or a trait; the check asserts it.

**Eligibility.** A plan comes from a guidance item the current guidance
carries, whose history is sufficient — except `RESOLVE_EVIDENCE_GAP`, which is
what an insufficient history calls for. One mark, one activity, one
observation or one reflection never opens a plan, because the guidance beneath
already needs two independent observations. The service refuses a duplicate
open plan for the same pupil, dimension/subject and objective unless the new
one explicitly supersedes it with a reason.

## 5. Milestones

Observable events only: `activity_started`, `activity_completed`,
`assignment_submitted`, `quiz_completed`, `teacher_observation_recorded`,
`practical_completed`, `reflection_submitted`, `support_session_completed`,
`second_independent_observation_recorded`, `coursework_submitted`,
`different_approach_tried`. States `PENDING → AVAILABLE → STARTED → COMPLETED`,
with `SKIPPED` (a categorical reason: `STUDENT_CHOICE`, `RESOURCE_UNAVAILABLE`,
`TIME_CONSTRAINT`, `SCHOOL_CONSTRAINT`, `SUPPORT_UNAVAILABLE`, `OTHER`) and
`BLOCKED ⇄ AVAILABLE`. The first is available; completing or skipping one opens
the next. A milestone's owner or staff may move it; a skip is not a failure;
progress is counts, never a percentage.

## 6. Student participation

`GUIDANCE → PLAN PROPOSAL → PLAN ACCEPTANCE → EXECUTION → REVIEW` are separate
acts. A pupil accepts, declines, pauses, resumes, completes or skips their own
milestones, reflects with controlled codes (`USEFUL`, `NOT_USEFUL`, `TOO_EASY`,
`TOO_DIFFICULT`, `INTERESTING`, `NOT_INTERESTING`, `NEED_MORE_SUPPORT`,
`PREFER_DIFFERENT_APPROACH`, `RESOURCE_PROBLEM`, `OTHER`) and an optional short
note, and may record a constraint on their own plan. A pupil may create only a
plan they own themselves. A pupil never activates, reviews, completes or
closes. Declining is recorded as a decision and read as nothing else. A
reflection is evidence about the experience — it changes what is suggested,
never a strength.

## 7. Review lifecycle

`DRAFT → PROPOSED → ACCEPTED → ACTIVE → REVIEW_DUE → (ADAPTING → ACTIVE |
COMPLETED | ACTIVE)`, with `DECLINED` from PROPOSED, `PAUSED ⇄ ACTIVE`, and
`CLOSED` from ACCEPTED, ACTIVE, REVIEW_DUE, ADAPTING or PAUSED. `transition({
status, action, actorRole })` is the only way to move: an invalid move throws
`INVALID_TRANSITION`, a role that may not make it throws `ROLE_NOT_ALLOWED`,
a replayed move is a no-op. A review by staff records the system reading of the
day beside the teacher's observation code (`OBSERVED_PROGRESS`,
`OBSERVED_STABILITY`, `OBSERVED_DIFFICULTY`, `NO_NEW_EVIDENCE`,
`CONTEXT_CHANGED`, `SUPPORT_REQUIRED`), an optional staff-only note, and the
human decision (`continue`, `adapt` with a chosen action, `complete`, `pause`,
`close`). The system's outcome is stored beside the decision, never instead of
it; the two may differ, and both are kept.

## 8. Adaptive support

`reviewPlan({ plan, development, interventionOutcomes, reflections,
teacherReview, constraints, asOf })` reads the plan as it stood, the milestones
that occurred, the independent observations since the plan's evidence boundary,
the development reading before and after the start, the linked interventions'
outcomes (Stage 15's engine, reused as it is), what the pupil reported and
what the teacher observed, and answers with one of `CONTINUE`, `ADAPT`,
`COMPLETE`, `PAUSE`, `INSUFFICIENT_EVIDENCE` and its reasons. Priority when
several apply: a documented constraint or a resource problem → PAUSE;
completion criteria met → COMPLETE; a contradiction, a decline, the expected
change not shown, or a request for a change from the pupil or the teacher →
ADAPT; nothing new and nothing in progress → INSUFFICIENT_EVIDENCE; otherwise
CONTINUE. Completion is milestones plus new independent evidence, never a mark
going up. A contradiction is explained and the original evidence kept. "The
available evidence does not show the expected change" needs two reviews with
new evidence and no improvement; "failed" and "did not work" are not in the
vocabulary. The bounded adaptation (`MORE_PRACTICE`, `DIFFERENT_PRACTICE`,
`LOWER_COMPLEXITY`, `HIGHER_COMPLEXITY`, `NEW_CONTEXT`, `ADDITIONAL_EXPOSURE`,
`TEACHER_SUPPORT`, `PEER_SUPPORT`, `REFLECTION`, `REPEAT_OBSERVATION`,
`WAIT_FOR_MORE_EVIDENCE`, `RESOURCE_SUBSTITUTION`), each with one deterministic
explanation, is suggested; `adaptPlan` applies the one a person chose, marking
the current actions replaced (never deleted), appending fresh milestones, and
recording previous, next, reason, evidence boundary, reviewer, time and engine
versions. Every review answers the nine questions as structured fields
(`contract`).

## 9. Evidence boundaries

A plan records the strengths boundary hash it was made on; a review records
`evidenceBoundaryHash`, `developmentObservationBoundary` and `asOf`.
Observations since the plan started on the plan's own boundary, or on a
boundary already counted, are not new independent evidence — Stage 14's rule,
kept. A snapshot dated the same day as the plan counts once.

## 10. Historical replay

Every read accepts `?asOf=`. The plan is reconstructed from its append-only
histories using only what happened at or before that moment (`reconstruct`);
a plan created later did not exist (404). The development history beneath is
built for the same day, and the adaptive engine ignores any observation after
`asOf` whatever history it is handed. The same `asOf` twice is byte-identical.

## 11. Intervention integration

A plan may name the interventions it follows (`sourceInterventionIds`). At
review their outcomes are read through Stage 15's `interpretOutcome` — the
existing academic before/after beside the development reading — and enter the
reasons (`INTERVENTION_OUTCOME_IMPROVED / DECLINED / MIXED / INSUFFICIENT`).
No second before/after calculation exists; the check asserts the adaptive
engine never computes one.

## 12. Privacy

The engines are name-free and carry no reflection text; a reflection reaches
them as codes. A pupil's view omits staff notes, actor ids and review
boundaries; the parent's view carries objective, support, completed and
upcoming milestones and review status — no reflection, no note, no reason
code. A constraint is an explicit operational fact recorded by an authorised
person; nothing socioeconomic is inferred or stored, and the vocabulary
contains no such term.

## 13. Authorization

| Route | Who |
|---|---|
| `GET …/development-plans`, `GET …/development-plans/:planId` | pupil (own), teacher in scope, school admin, operator with `schoolId` |
| `POST …/development-plans` | staff with the intervention capability; a pupil for a plan they own |
| `PATCH …/:planId`, `POST …/:planId/accept|decline|pause`, `POST …/:planId/milestones/:milestoneId`, `POST …/:planId/constraints` | same; the engines' role tables decide which move |
| `POST …/:planId/reflect` | the pupil only |
| `POST …/:planId/review` | staff only |
| `GET /api/portal/children/:id/development-plans` | a guardian, for an unlocked child |

Missing `schoolId` is never "all schools". The bursar has no route.

## 14. Offline consistency

The consistency route reviews every plan on both roads (live history vs
mirrored documents) and names any mismatch: `PLAN_STATE_MISMATCH`,
`PLAN_OBJECTIVE_MISMATCH`, `PLAN_MILESTONE_MISMATCH`,
`PLAN_EVIDENCE_BOUNDARY_MISMATCH`, `PLAN_REVIEW_MISMATCH`,
`PLAN_ADAPTATION_MISMATCH`, `PLAN_VERSION_MISMATCH`. The pilot readiness check
expects the seven classes false; a real difference fails closed.

## 15. API

Listed in §13. Reads carry each plan with the adaptive engine's current reading
(`systemReview`) when the plan is active, and the vocabulary a client needs
(objectives, reflection codes, skip reasons).

## 16. Testing

`check-development-planning.js` (48): eligibility, the contract, bounded
objectives and observable milestones, every lifecycle move and every invalid
one, roles, replay, duplicates, milestones (create, complete, skip with a
reason, block, unblock, roles, no-op), reconstruction, purity and vocabulary;
then the routes: refusal on weak evidence, creation, idempotent replay,
duplicate refusal, the pupil's ownership rule, authorisation, propose, accept,
activate, milestones, reflection, historical replay, pause, resume, review,
constraints, decline, close, the guardian, live = offline, the feed
registration. `check-adaptive-support.js` (32): the five outcomes from
improving, stable, declining, contradictory and missing evidence; completion by
criteria; the pupil's and the teacher's feedback; a constraint; the
intervention outcome; the boundary rule; the expected-change rule; the nine
questions; the adaptation record; determinism; historical asOf; purity; then
the routes: a reading on an active plan, a contradiction after a new boundary,
a review that adapts with a chosen action, the pupil's limited view, refusals,
a second review, live = offline.

## 17. Limitations

- A plan needs snapshots beneath it: the review's "new independent evidence"
  is a snapshot on a new boundary, so a school that takes none reviews with
  `INSUFFICIENT_EVIDENCE` or `CONTINUE` until it does.
- The completion criteria, the two-review bar for "expected change not shown"
  and the 14–120-day review window were not tuned on real data.
- Parents read; they do not yet accept, decline or reflect through the portal.
- A review reads the pupil's codes, not their words; the note is kept for a
  person to read.

## 18. Real-world validation requirements

No real pupil has been through a plan. Deterministic rules and green tests say
nothing about whether a plan helps a child; that needs authorised real-school
evidence, read with the teachers who were in the room, before any threshold
moves. **Real-world validation is still pending.**
