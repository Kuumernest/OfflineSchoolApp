// shared/guidance/rules.js
"use strict";

/**
 * The deterministic rules: from a trajectory (Stage 14) and its current
 * reading (Stage 13) to categories and reason codes. Every judgement about
 * evidence — is this established, is it declining, is there a conflict — was
 * made upstream and is not revisited here. The rules only choose which
 * bounded categories that evidence supports, and say why.
 *
 * Insufficient history, stale evidence and open conflicts push toward
 * BUILD_EVIDENCE, REFLECT and MONITOR rather than stronger conclusions.
 * A decline is never read as lack of ability: it earns MONITOR, and
 * SEEK_SUPPORT or CHANGE_APPROACH only when it has repeated.
 */

const { CATEGORIES, MAX_PER_DIMENSION } = require("./version");

/** "Most" of the nine modalities: seven or more unavailable leaves the record academic-only or nearly so. */
const MOST_MODALITIES = 7;

/** Facets of one trajectory, read once. */
const facetsOf = (t) => {
  const last = t.observations[t.observations.length - 1] ?? null;
  const consecutive = t.persistence?.consecutiveObservations ?? 0;
  return {
    state: t.currentState, relationship: t.currentRelationship, trajectory: t.trajectory, direction: t.direction,
    historySufficient: t.trajectory !== "INSUFFICIENT_HISTORY",
    coverage: t.quality?.coverage ?? "LIMITED", recency: t.quality?.recency ?? null, conflicts: t.quality?.conflicts ?? "NONE",
    missing: t.quality?.missingModalities ?? [], attendanceLimited: Boolean(t.quality?.attendanceLimited),
    persistentConflict: (t.contradictions ?? []).some((c) => c.current && c.status === "PERSISTENT"),
    consecutive,
    learningPresent: (last?.independentEventCount ?? 0) > 0,
    explorationNow: (last?.explorationEvents ?? 0) > 0,
    explorationBefore: Boolean(t.evidenceCoverage?.firstSeenFamily?.EXPLORATION),
    lastChangeTypes: (t.changes ?? []).slice(-1)[0]?.changeTypes ?? [],
  };
};

/**
 * Evidence quality behind any item for this trajectory: how much and how
 * good, never how likely to help.
 */
const evidenceQualityOf = (f) => {
  if (!f.historySufficient || f.recency === "STALE") return "INSUFFICIENT";
  if (f.coverage === "LIMITED" || f.conflicts === "CURRENT" || f.attendanceLimited) return "LIMITED";
  if (f.coverage === "BROAD" && f.relationship === "CORROBORATED") return "WELL_SUPPORTED";
  return "SUPPORTED";
};

/** Categories and reasons a trajectory earns. */
const categoriesFor = (f) => {
  const out = new Map(); // category → reasons
  const add = (cat, reason) => { if (!out.has(cat)) out.set(cat, []); if (!out.get(cat).includes(reason)) out.get(cat).push(reason); };

  if (!f.historySufficient) {
    add("BUILD_EVIDENCE", "INSUFFICIENT_HISTORY");
    if (f.state === "ESTABLISHED") add("MAINTAIN", "CURRENT_STATE_ESTABLISHED");
    if (f.state === "EMERGING") add("EXPLORE", "CURRENT_STATE_EMERGING");
    if (f.state === "DECLINING") add("MONITOR", "CURRENT_STATE_DECLINING_SINGLE_OBSERVATION");
  } else {
    switch (f.trajectory) {
      case "STABLE_ESTABLISHED":
        add("MAINTAIN", "STABLE_ESTABLISHED");
        if (f.coverage !== "LIMITED" && f.relationship === "CORROBORATED") add("DEEPEN", "ESTABLISHED_AND_CORROBORATED");
        break;
      case "STRENGTHENING":
        add("MAINTAIN", "MOVED_TO_ESTABLISHED");
        if (f.relationship === "CORROBORATED") add("DEEPEN", "ESTABLISHED_AND_CORROBORATED");
        break;
      case "EMERGING":
        add("EXPLORE", "EMERGING_AND_RISING"); add("PRACTICE", "EMERGING_AND_RISING");
        break;
      case "STABLE_EMERGING":
        add("PRACTICE", "STABLE_EMERGING"); add("EXPLORE", "STABLE_EMERGING");
        break;
      case "RECOVERING":
        add("MAINTAIN", "RECOVERED_AFTER_DECLINE"); add("MONITOR", "RECOVERED_AFTER_DECLINE");
        break;
      case "WEAKENING":
        add("MONITOR", "MOVED_FROM_ESTABLISHED_TO_EMERGING"); add("PRACTICE", "MOVED_FROM_ESTABLISHED_TO_EMERGING");
        break;
      case "DECLINING":
      case "STABLE_DECLINING":
        add("MONITOR", "DECLINING_TRAJECTORY");
        if (f.consecutive >= 2 || f.trajectory === "STABLE_DECLINING") add("SEEK_SUPPORT", "PERSISTENT_DECLINE");
        if ((f.consecutive >= 2 || f.trajectory === "STABLE_DECLINING") && f.learningPresent) add("CHANGE_APPROACH", "REPEATED_DECLINE_WITH_LEARNING_EVIDENCE");
        if (f.relationship === "CONTRADICTED") add("SEEK_SUPPORT", "LEARNING_CONTRADICTION");
        break;
      case "VARIABLE":
        add("REFLECT", "VARIABLE_TRAJECTORY"); add("MONITOR", "VARIABLE_TRAJECTORY");
        break;
      case "STABLE_INSUFFICIENT":
        add("BUILD_EVIDENCE", "STABLE_INSUFFICIENT");
        break;
      default:
        add("MONITOR", "UNCLASSIFIED_TRAJECTORY");
    }
  }
  if (f.conflicts === "CURRENT") { add("REFLECT", "CONTRADICTION_CURRENT"); add("BUILD_EVIDENCE", "CONTRADICTION_CURRENT"); if (f.persistentConflict) add("MONITOR", "CONTRADICTION_PERSISTENT"); }
  if (f.relationship === "UNSUPPORTED" || f.relationship === "INSUFFICIENT_EVIDENCE") add("BUILD_EVIDENCE", "NO_INDEPENDENT_LEARNING_EVIDENCE");
  if (f.relationship === "CONTEXT_LIMITED") add("MONITOR", "CONTEXT_LIMITED");
  if (f.missing.length >= MOST_MODALITIES) add("BUILD_EVIDENCE", "MOST_MODALITIES_UNAVAILABLE");
  if (f.recency === "STALE") { add("BUILD_EVIDENCE", "EVIDENCE_STALE"); add("MONITOR", "EVIDENCE_STALE"); }
  if (f.explorationBefore && !f.explorationNow && (f.state === "ESTABLISHED" || f.state === "EMERGING")) add("REVISIT", "EARLIER_EXPLORATION_RELEVANT_AGAIN");
  if (f.lastChangeTypes.includes("EVIDENCE_COVERAGE_CHANGED") && !f.lastChangeTypes.includes("STATE_CHANGED")) add("MONITOR", "COVERAGE_CHANGED_STATE_UNCHANGED");

  // Bounded: the preferred few, in the taxonomy's order.
  return CATEGORIES.filter((c) => out.has(c)).slice(0, MAX_PER_DIMENSION).map((c) => ({ category: c, reasons: out.get(c) }));
};

module.exports = { facetsOf, evidenceQualityOf, categoriesFor, MOST_MODALITIES };
