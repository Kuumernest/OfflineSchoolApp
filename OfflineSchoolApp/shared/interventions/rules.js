// shared/interventions/rules.js
"use strict";

/**
 * Triggers, the lifecycle, and the interpretation of an outcome.
 *
 * ── Triggers ──────────────────────────────────────────────────────────────
 * Read from the development history and the guidance. Every trigger needs
 * at least two independent observations: one weak mark, one missed
 * activity, one observation never proposes anything.
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────
 * A closed state machine (version.js TRANSITIONS). An invalid move throws
 * INVALID_TRANSITION; a move the actor's role may not make throws
 * ROLE_NOT_ALLOWED. Repeating a move that already happened is reported as
 * a no-op, so an offline replay is safe.
 *
 * ── Outcome ───────────────────────────────────────────────────────────────
 * The existing academic before/after (shared/intelligence/interventionOutcome)
 * is reused as it is; beside it, the development reading before and after
 * the start date. Both are observed change after the period, never cause.
 */

const { TRANSITIONS, ACTION_ROLES, RULES, LIFECYCLE } = require("./version");

const STATE_RANK = { INSUFFICIENT: 0, DECLINING: 0, EMERGING: 1, ESTABLISHED: 2 };

/**
 * Triggers a development history supports, per dimension.
 *
 * @param {object} input
 * @param {object} input.development  Stage 14 history
 * @param {object} [input.guidance]   Stage 15 guidance (for REPEATED_SUPPORT_SIGNAL)
 */
const triggersFor = ({ development, guidance = null }) => {
  const out = [];
  for (const t of development?.trajectories ?? []) {
    if (!t.dimensionId) continue;
    const n = t.persistence?.independentObservationCount ?? 0;
    if (n < RULES.independentObservationsForTrigger) continue;                       // never from one observation
    const rows = t.observations ?? [];
    const last = rows[rows.length - 1], prev = rows[rows.length - 2];
    const reasons = (trigger, evidence) => out.push({ dimension: t.dimensionId, trigger, evidence, independentObservations: n });

    if ((t.trajectory === "DECLINING" || t.trajectory === "STABLE_DECLINING") && (t.persistence?.consecutiveObservations ?? 0) >= 2 && t.currentState === "DECLINING")
      reasons("PERSISTENT_DECLINE", { consecutiveDeclining: t.persistence.consecutiveObservations, transitions: t.stateTransitions.map((s) => `${s.from}>${s.to}`) });
    if (last?.relationship === "CONTRADICTED" && prev?.relationship === "CONTRADICTED")
      reasons("REPEATED_DIFFICULTY", { relationships: [prev.relationship, last.relationship] });
    const conflict = (t.contradictions ?? []).find((c) => c.current && (c.status === "PERSISTENT" || c.status === "RECURRING"));
    if (conflict) reasons("LEARNING_CONTRADICTION", { kind: conflict.kind, status: conflict.status, occurrences: conflict.occurrences, firstSeen: conflict.firstSeen, lastSeen: conflict.lastSeen });
    // A long-established strength (three or more observations, all established) meets a contradicted reading for the first time:
    // worth checking the assessment context and the task types. Not from a first or second observation.
    if (t.currentState === "ESTABLISHED" && last?.relationship === "CONTRADICTED" && !conflict && n >= RULES.independentObservationsForGap && rows.slice(0, -1).every((o) => o.state === "ESTABLISHED"))
      reasons("ACADEMIC_LEARNING_MISMATCH", { state: t.currentState, relationship: last.relationship, establishedObservations: rows.length - 1 });
    if (n >= RULES.independentObservationsForGap && rows.every((o) => o.relationship === null || o.relationship === "UNSUPPORTED" || o.relationship === "INSUFFICIENT_EVIDENCE") && (t.quality?.missingModalities ?? []).length >= RULES.mostModalities)
      reasons("INSUFFICIENT_EVIDENCE", { missingModalities: t.quality.missingModalities, observations: n });
    // Support signalled from two different directions at once (for example a persistent decline AND a learning contradiction).
    const supportItems = (guidance?.items ?? []).filter((g) => g.dimension === t.dimensionId && g.category === "SEEK_SUPPORT" && g.evidenceQuality !== "INSUFFICIENT");
    const supportReasons = [...new Set(supportItems.flatMap((g) => g.reasons))];
    if (supportReasons.length >= 2) reasons("REPEATED_SUPPORT_SIGNAL", { guidance: supportItems.map((g) => g.id), reasons: supportReasons });
    const limitedAcross = n >= RULES.independentObservationsForGap && (t.quality?.coverage === "LIMITED") && (t.evidenceCoverage?.familyHistory ?? []).slice(-RULES.independentObservationsForGap).every((h) => h.families.length === 0);
    if (limitedAcross && t.currentState !== "INSUFFICIENT") reasons("EVIDENCE_COVERAGE_GAP", { coverage: t.quality.coverage, missingModalities: t.quality?.missingModalities ?? [] });
  }
  return out.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.trigger.localeCompare(b.trigger));
};

/**
 * One lifecycle move. Returns { lifecycle, changed } or throws.
 *
 * @param {object} input  { lifecycle, action, actorRole }
 */
const transition = ({ lifecycle, action, actorRole }) => {
  const rule = TRANSITIONS[action];
  if (!rule) { const e = new Error(`Unknown action "${action}"`); e.code = "INVALID_TRANSITION"; throw e; }
  if (!LIFECYCLE.includes(lifecycle)) { const e = new Error(`Unknown lifecycle "${lifecycle}"`); e.code = "INVALID_TRANSITION"; throw e; }
  if (!ACTION_ROLES[action].includes(actorRole)) { const e = new Error(`${actorRole} may not ${action}`); e.code = "ROLE_NOT_ALLOWED"; throw e; }
  if (lifecycle === rule.to && action !== "review") return { lifecycle, changed: false };   // a replayed move
  if (!rule.from.includes(lifecycle)) { const e = new Error(`Cannot ${action} from ${lifecycle}`); e.code = "INVALID_TRANSITION"; throw e; }
  return { lifecycle: rule.to, changed: true };
};

/** Whether the review point has passed on a given day. Derived, never stored as a decision. */
const reviewDue = ({ lifecycle, reviewDate, asOf }) => lifecycle === "ACTIVE" && Boolean(reviewDate) && new Date(reviewDate).toISOString() <= new Date(asOf).toISOString();

const academicReading = (o) => (o?.reading === "INCREASED_AFTER" ? "IMPROVED" : o?.reading === "DECREASED_AFTER" ? "DECLINED" : o?.reading === "NO_CHANGE_OBSERVED" ? "STABLE" : null);
const developmentReading = (before, after) => {
  if (!before || !after) return null;
  const d = STATE_RANK[after.state] - STATE_RANK[before.state];
  if (after.state === "DECLINING" && before.state !== "DECLINING") return "DECLINED";
  if (before.state === "DECLINING" && after.state !== "DECLINING" && after.state !== "INSUFFICIENT") return "IMPROVED";
  return d > 0 ? "IMPROVED" : d < 0 ? "DECLINED" : "STABLE";
};

/**
 * The observed outcome after the intervention period: the academic before/
 * after (existing engine) beside the development reading before and after.
 * Both agree → that; they disagree → MIXED; one available → that one; none →
 * INSUFFICIENT_EVIDENCE. The sentence is "after the period", never "because".
 */
const interpretOutcome = ({ academicOutcome = null, developmentBefore = null, developmentAfter = null }) => {
  const a = academicReading(academicOutcome);
  const d = developmentReading(developmentBefore, developmentAfter);
  const outcome = a && d ? (a === d ? a : "MIXED") : (a ?? d ?? "INSUFFICIENT_EVIDENCE");
  return {
    outcome,
    statement: { code: "OBSERVED_AFTER_PERIOD", outcome },
    academic: academicOutcome ? { reading: academicOutcome.reading, status: academicOutcome.status, before: academicOutcome.before ?? null, after: academicOutcome.after ?? null, change: academicOutcome.change ?? null } : null,
    development: { before: developmentBefore ? { observedAt: developmentBefore.observedAt, state: developmentBefore.state, relationship: developmentBefore.relationship } : null,
                   after: developmentAfter ? { observedAt: developmentAfter.observedAt, state: developmentAfter.state, relationship: developmentAfter.relationship } : null, reading: d },
    causal: false,
  };
};

module.exports = { triggersFor, transition, reviewDue, interpretOutcome, academicReading, developmentReading };
