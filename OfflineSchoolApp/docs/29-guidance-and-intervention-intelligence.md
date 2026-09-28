# 29 — Evidence-Informed Development Guidance & Intervention Intelligence (Stage 15)

> Guidance is downstream of evidence. Intervention is downstream of guidance.
> Outcomes are downstream of intervention. The system informs; a person
> decides. Nothing here is a score, a probability, a ranking or a career.

`GUIDANCE_ENGINE_VERSION` **1.0.0** · `INTERVENTION_ENGINE_VERSION` **1.0.0** ·
academic 1.0.0 · strengths 1.2.0 · exploration 1.0.0 · learning evidence 1.0.0 ·
learning integration 1.0.0 · development 1.0.0 — none of the six beneath moved.

## 1. Purpose

Stage 14 explains how a pupil's evidence-backed profile changed over time.
Stage 15 turns that history into **bounded, explainable guidance** — what was
observed, what changed, what supports it, what the pupil could try, why, and
what evidence would show whether it helped — and, where a documented pattern
supports it, into a **human-owned intervention** with an objective, an action,
an owner, a review point and, afterwards, an observed outcome. Nothing in this
stage modifies evidence, marks, strength states or development history.

## 2. Architecture

```
ACADEMIC → STRENGTH (+ exploration, learning evidence) → DEVELOPMENT
        → GUIDANCE (shared/guidance)            reproducible, never stored
        → INTERVENTION (shared/interventions)   proposed from a trigger; a person owns it
        → OBSERVED OUTCOME                      academic before/after + development before/after
        → back into DEVELOPMENT                 the next snapshots carry what happened
```

| Piece | Path |
|---|---|
| Guidance engine | `shared/guidance/` — `version`, `taxonomy`, `rules`, `buildGuidance`, `index` |
| Intervention engine | `shared/interventions/` — `version`, `taxonomy`, `rules`, `buildIntervention`, `index` |
| Services | `developmentGuidance.service.js`, `developmentInterventions.service.js` |
| Persistence | the existing `Intervention` collection, `sourceType: "development_guidance"`, with a `development` sub-document (see §6); no new collection |
| Routes | insights `…/development/guidance`, `…/interventions`, `…/interventions/:id`, `…/interventions/:id/review`; portal `…/children/:id/guidance` |
| Checks | `check-development-guidance.js`, `check-development-interventions.js` (named apart from the Stage 3/4 `check-guidance.js` and `check-interventions.js`, which cover the academic guidance projection and the legacy intervention record and are unchanged) |

Both engines are pure: no database, no Express, no identity, no filesystem,
no network, no clock (`asOf` is required), no LLM.

## 3. Guidance taxonomy

`MAINTAIN`, `PRACTICE`, `DEEPEN`, `EXPLORE`, `REFLECT`, `SEEK_SUPPORT`,
`CHANGE_APPROACH`, `BUILD_EVIDENCE`, `REVISIT`, `MONITOR` — with the
definitions of the brief (`taxonomy.js DEFINITIONS`). Each category carries one
bounded action (`type`, `instruction` code, `expectedEvidence` code) and the
evidence families to watch. At most five items per dimension, in a fixed
order of preference. The interface renders every code; the pupil-facing
templates are invitations ("you could try…", "one option is…"), and the check
asserts that neither catalogue contains "you must" or "should become".

## 4. Guidance rules (`rules.js`)

Read from a Stage 14 trajectory only; nothing upstream is re-judged.

| Situation | Categories |
|---|---|
| fewer than two independent observations | BUILD_EVIDENCE first; MAINTAIN / EXPLORE / MONITOR for the current state, all `INSUFFICIENT` |
| STABLE_ESTABLISHED | MAINTAIN; DEEPEN when corroborated and coverage is not limited |
| STRENGTHENING | MAINTAIN; DEEPEN when corroborated |
| EMERGING (rising) | EXPLORE, PRACTICE |
| STABLE_EMERGING | PRACTICE, EXPLORE |
| RECOVERING | MAINTAIN, MONITOR |
| WEAKENING | MONITOR, PRACTICE |
| DECLINING / STABLE_DECLINING | MONITOR; SEEK_SUPPORT after two consecutive declining observations or a learning contradiction; CHANGE_APPROACH when the decline repeated with learning evidence on record |
| VARIABLE | REFLECT, MONITOR |
| a current contradiction | REFLECT, BUILD_EVIDENCE; MONITOR when persistent — never resolved by the engine |
| UNSUPPORTED / INSUFFICIENT_EVIDENCE relationship, or seven of nine modalities unavailable | BUILD_EVIDENCE |
| CONTEXT_LIMITED | MONITOR |
| stale latest evidence | BUILD_EVIDENCE, MONITOR |
| exploration seen earlier, absent now, at strength | REVISIT |
| coverage changed without a state change | MONITOR |

One decline is MONITOR only. A decline is never read as lack of ability.

## 5. Evidence contract

`evidenceQuality` is categorical — `INSUFFICIENT` (history insufficient or
stale), `LIMITED` (coverage limited, a current conflict, or attendance
limited), `SUPPORTED`, `WELL_SUPPORTED` (broad coverage and corroborated). It
describes how much and how good the evidence is, never how likely the guidance
is to help. Each item carries `explanation { observed, changed, relationship,
why, uncertain }`, `evidence { state, relationship, trajectory, direction,
coverage counts, quality, contradictions, transitions }`, `reasons`,
`suggestedActions`, `evidenceToWatch`, `developmentContext`, `asOf` and both
engine versions. When nothing has been observed in any dimension, one
profile-level `BUILD_EVIDENCE` item is the whole guidance.

## 6. Intervention contract

`buildIntervention({ trigger, dimension, triggerEvidence, guidanceId, action,
ownerRole, durationDays, startDate, engineVersions })` →

```
dimension, trigger, triggerEvidence, guidanceId, objective, action, ownerRole,
startDate, durationDays (14–120, default per trigger), reviewDate, evidenceToCollect[],
lifecycle: "PROPOSED", outcome: null, engineVersions, explanation { why, owner, objective, evidence, review }
```

Persisted in the existing `Intervention` collection under
`sourceType: "development_guidance"`; the contract lives in `development`,
with `lifecycleHistory[]`, `reviews[]`, `proposedBy/Role`, `acceptedBy/At`.
The legacy `status` is derived from the lifecycle (PROPOSED/ACCEPTED →
planned; ACTIVE/REVIEW_DUE/PAUSED → active; COMPLETED → completed;
DECLINED/CANCELLED → cancelled) so the class page, the sync feed and the legacy
outcome page keep working. No mark, no reflection text, no name is stored.

### Triggers

`PERSISTENT_DECLINE` (two consecutive declining observations),
`REPEATED_DIFFICULTY` (two consecutive contradicted readings),
`LEARNING_CONTRADICTION` (a persistent or recurring contradiction),
`ACADEMIC_LEARNING_MISMATCH` (three or more established observations meet a
first contradicted reading), `INSUFFICIENT_EVIDENCE` and
`EVIDENCE_COVERAGE_GAP` (three observations without independent evidence),
`REPEATED_SUPPORT_SIGNAL` (SEEK_SUPPORT for two different reasons). Every
trigger needs at least two independent observations; a single poor mark, a
single missed activity or a single observation never proposes anything. The
service refuses a proposal whose trigger the current history does not
support (`409 TRIGGER_NOT_SUPPORTED`).

## 7. Intervention lifecycle

`PROPOSED → ACCEPTED → ACTIVE → (REVIEW_DUE) → COMPLETED`, with `DECLINED`
from PROPOSED, `PAUSED ⇄ ACTIVE`, and `CANCELLED` from ACCEPTED, ACTIVE,
REVIEW_DUE or PAUSED. `transition({ lifecycle, action, actorRole })` is the
only way to move; an invalid move throws `INVALID_TRANSITION`, a role that
may not make it throws `ROLE_NOT_ALLOWED`, and a replayed move is a no-op so
an offline outbox is safe. `reviewDue` is derived from the review date on the
day of the read; it is a fact, not an escalation. `GUIDANCE ≠ INTERVENTION`
and `PROPOSED ≠ ACTIVE` are both asserted by the check.

## 8. Human ownership

`ownerRole` ∈ STUDENT, TEACHER, PARENT, SCHOOL_ADMIN — explicit on every
proposal, defaulted per trigger, never silent. A pupil may accept or decline
what is proposed to them and may propose only what they would own themselves;
staff activate, pause, resume, review, complete, cancel. The system performs
none of it and never alerts, escalates or refers.

## 9. Outcome interpretation

`interpretOutcome` sets the existing academic before/after
(`shared/intelligence/interventionOutcome.compareOutcome`, unchanged) beside
the development reading before and after the start date: both agree → that
reading; they disagree → `MIXED`; one available → that one; none →
`INSUFFICIENT_EVIDENCE`. The statement is `OBSERVED_AFTER_PERIOD`, `causal:
false`. A review records the outcome of that day with the reviewer's note; a
completing review also sets the legacy `outcomeCode`.

## 10. Privacy

Guidance is codes, counts and categories; it carries no note, no reviewer,
no other pupil. A pupil's view of an intervention omits staff notes, trigger
evidence, reviewer identities and lifecycle actors; the parent's view carries
agreed support only (accepted, active, paused, completed), with owner role,
objective, action, review date and the observed progress. The engines never
see a name or a reflection text.

## 11. Student agency

`agency: "INFORMS_ONLY"` on every guidance payload. The pupil-facing text is
"you could try", "you may want to explore", "one option is". A proposal made
to a pupil waits for the pupil (or a staff member) to accept it, and the pupil
may decline.

## 12. Historical replay

Every read accepts `?asOf=`, passed to the development, strengths, learning
and exploration layers beneath. Guidance is reproducible from the history,
the current evidence and the engine version; the same `asOf` gives
byte-identical guidance, and an older `asOf` yields the guidance of that day.
Rules that change in the future are a new version; historical outputs stay
attributable to theirs (every item carries `engineVersion`).

## 13. Offline consistency

The consistency route now diffs guidance (live vs offline history) and the
intervention interpretation (triggers, both roads) and names any mismatch:
`GUIDANCE_STATE_MISMATCH`, `GUIDANCE_REASON_MISMATCH`,
`GUIDANCE_EVIDENCE_MISMATCH`, `INTERVENTION_TRIGGER_MISMATCH`,
`INTERVENTION_RULE_MISMATCH`, `VERSION_MISMATCH`. The pilot readiness check
expects the classes `guidanceState`, `guidanceReason`, `guidanceEvidence`,
`interventionTrigger`, `interventionRule` false; a real difference fails
closed.

## 14. API authorization

| Route | Who |
|---|---|
| `GET …/development/guidance` | pupil (own), teacher in scope, school admin, operator with `schoolId` |
| `GET …/interventions`, `GET …/interventions/:id` | same readers; a pupil's view omits staff notes and evidence |
| `POST …/interventions` | staff with `interventions.create` or `interventions.manage`; a pupil for an intervention they own |
| `PATCH …/interventions/:id` | same; the engine's role table decides which action |
| `POST …/interventions/:id/review` | staff only |
| `GET /api/portal/children/:id/guidance` | a guardian, for an unlocked child |

Missing `schoolId` is never "all schools". The bursar has no route.

## 15. Testing

`check-development-guidance.js` (38): every rule case, the object contract,
bounded categories and actions, categorical quality, agency, determinism,
historical `asOf`, purity, forbidden vocabulary in the engine, its output and
both locale catalogues; then the route as every role, the guardian, live =
offline, no model. `check-development-interventions.js` (48): triggers and the
no-single-observation rule, the proposal contract, every lifecycle move and
every invalid one, roles, replay, review-due, outcome classification and
insufficient evidence, legacy status; then the routes: refusal without
evidence, proposal, idempotent replay, the pupil's limited view, accept,
activate, review, pause, resume, complete, decline, cancel, snapshot
integrity, authorisation, the guardian's agreed support, live = offline, no
new model. Both run in `check:intel`.

## 16. Limitations

- Guidance needs a history; until snapshots are taken most pupils receive
  `BUILD_EVIDENCE` and a state-of-the-day item, marked `INSUFFICIENT`.
- The rule thresholds (two observations, three for a gap, seven of nine
  modalities, 14–120 days) were not tuned on real data.
- The outcome is observed change on two evidence roads; it cannot separate
  the intervention from everything else that happened in the period.
- Parents read; they do not yet accept or decline through the portal.

## 17. What is intentionally not implemented

Career prediction or recommendation, profession or university matching,
personality or psychological inference, IQ, socioeconomic inference,
automated labelling, dropout prediction, disciplinary recommendation, risk
scores, intervention scores, best-intervention rankings, success probability,
machine-learned or LLM decisions, automated alerts, escalations or referrals,
automated teacher or parent judgments.

## 18. Future validation requirements

No real pupil has been through either engine. Real evidence enters through
the Stage 8 pilot and nothing else. The pilot should compare each guidance
category and each trigger against what teachers recognise, and each observed
outcome against the teacher's own reading of the period, before any threshold
moves. **Real-world validation is still pending.**

## 19. Stage 16 — from guidance to a plan

A guidance item on a sufficient history (or a BUILD_EVIDENCE item on any
history) may open a development plan (docs/30): the guidance category maps to
one objective, the item's reasons become the plan's rationale, and the plan
references the guidance id and the strengths boundary it stood on. An
intervention a plan follows is named in `sourceInterventionIds`; at review its
outcome is read through `interpretOutcome` unchanged. Guidance and
interventions themselves did not change for this.
