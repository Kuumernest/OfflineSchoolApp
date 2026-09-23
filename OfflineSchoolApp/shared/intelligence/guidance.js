// OfflineSchoolApp/shared/intelligence/guidance.js
"use strict";

/**
 * From "what is happening to this pupil" to "what could somebody do about it".
 *
 * ── Why this is in shared/ ────────────────────────────────────────────────
 *
 * It sits directly on top of subjectInsights, which moved here for the reason
 * given in that file: three consumers, one set of rules. A guidance projection
 * that lived only on the server would mean a desktop working offline could show
 * a teacher the evidence and not the suggested action — or, worse, grow its own
 * copy of the mapping and eventually suggest something different for the same
 * evidence.
 *
 * ── A deliberately dull projection ────────────────────────────────────────
 *
 * Every judgement — is this a decline, is the evidence strong enough to say so
 * — was already made by subjectInsights and is not revisited here. This reads a
 * profile and nothing else: no model, no query, no mark, no threshold of its
 * own. Pure, and it does no I/O.
 *
 * ── Why the output is codes and not sentences ─────────────────────────────
 *
 * A Cameroonian school reads in English or French, sometimes both in one
 * staffroom. The server sends `{ code }` and the client renders it from the
 * i18n catalogue, exactly as the watch list already does. A sentence written
 * here would be an English sentence in a French school.
 *
 * ── Why there are only three categories ───────────────────────────────────
 *
 * academic_support, strength_development and monitoring, because those are the
 * three the evidence upstream can support. There is no attendance_support or
 * engagement_support: subjectInsights produces no attendance or assignment
 * insight to project, and inventing a category with nothing behind it would put
 * an action in front of a teacher with no evidence page to open.
 *
 * ── What it must never produce ────────────────────────────────────────────
 *
 * A career, a field of study, a pathway, a prediction, or anything resembling
 * "this pupil should become". EXPLORE_RELATED_LEARNING is an invitation to look
 * further at a SUBJECT, not a nomination to a profession. It decides nothing
 * academic either: no grade, no pass, no rank, no promotion.
 *
 * ── The seam a future explanation layer would use ─────────────────────────
 *
 * A generative model could one day turn these codes and their evidence into a
 * paragraph a parent finds easier to read. It would sit BELOW this file, at the
 * presentation boundary, consuming a fixed code and fixed figures. It must
 * never choose the code, invent the evidence or change the action.
 */

/**
 * The risk statements that earn an action, and which actions.
 *
 * Keyed by the insight code from subjectInsights, so a code that engine stops
 * producing silently stops producing guidance, rather than guidance outliving
 * the evidence that justified it.
 */
const RISK_GUIDANCE = {
  academic_decline: {
    rationaleCode: "RECENT_DECLINE",
    actions: ["REVIEW_RECENT_ASSESSMENTS", "TARGETED_PRACTICE", "MONITOR_NEXT_SEQUENCE"],
  },
  sudden_performance_change: {
    rationaleCode: "SUDDEN_PERFORMANCE_CHANGE",
    actions: ["REVIEW_RECENT_ASSESSMENTS", "IDENTIFY_REPEATED_ERRORS", "MONITOR_NEXT_SEQUENCE"],
  },
  persistent_underperformance: {
    rationaleCode: "PERSISTENT_UNDERPERFORMANCE",
    actions: [
      "REVIEW_RECENT_ASSESSMENTS", "TARGETED_PRACTICE",
      "ADDITIONAL_SUPPORT", "MONITOR_NEXT_SEQUENCE",
    ],
  },
};

/**
 * The strength statements, which all earn the same three actions.
 *
 * One action set on purpose: the difference between "strong", "improving" and
 * "consistently strong" is a difference in the EVIDENCE, which travels with the
 * item, not a difference in what a teacher can usefully offer next.
 */
const STRENGTH_RATIONALE = {
  subject_strength:     "SUBJECT_STRENGTH",
  sustained_improvement: "SUSTAINED_IMPROVEMENT",
  consistency_strength: "CONSISTENT_STRENGTH",
};

const STRENGTH_ACTIONS = [
  "ENRICHMENT_ACTIVITY", "ADVANCED_PROBLEM_SOLVING", "EXPLORE_RELATED_LEARNING",
];

/**
 * How loudly to say it.
 *
 * Derived from the engine's confidence rather than invented beside it, which is
 * what stops a second, disagreeing notion of certainty growing here. A risk the
 * engine calls established is worth a teacher's week; one it calls emerging is
 * worth a look. A strength is never "high": a pupil doing well is an
 * opportunity, and putting it at the top of a list above a child who is failing
 * would be the wrong list.
 */
const priorityFor = (type, confidence) => {
  if (type === "academic_support") return confidence === "strong" ? "high" : "moderate";
  return confidence === "strong" ? "moderate" : "low";
};

/** One insight → one guidance item, or null when the insight earns no action. */
const fromInsight = (insight) => {
  const risk = RISK_GUIDANCE[insight.code];
  if (risk) {
    return {
      type:     "academic_support",
      priority: priorityFor("academic_support", insight.confidence),
      subjectId:   insight.subjectId,
      subjectName: insight.subjectName,
      rationaleCode: risk.rationaleCode,
      // The insight this came from, so a reader can get back to the evidence
      // page that produced it rather than taking the action on trust.
      sourceInsightCode: insight.code,
      evidence: insight.evidence,
      recommendedActionCodes: risk.actions,
      confidence: insight.confidence,
    };
  }

  const strength = STRENGTH_RATIONALE[insight.code];
  if (strength) {
    return {
      type:     "strength_development",
      priority: priorityFor("strength_development", insight.confidence),
      subjectId:   insight.subjectId,
      subjectName: insight.subjectName,
      rationaleCode: strength,
      sourceInsightCode: insight.code,
      evidence: insight.evidence,
      recommendedActionCodes: STRENGTH_ACTIONS,
      confidence: insight.confidence,
    };
  }

  /*
   * Everything else — cross_subject_strength today — deliberately produces no
   * action. Naming several strong subjects together is a useful thing to SHOW
   * a teacher; turning it into a suggested action would mean suggesting a
   * direction, and a direction across subjects is the first step towards the
   * career claim this system refuses to make.
   */
  return null;
};

/**
 * Say "we do not know enough yet" out loud.
 *
 * For most pupils in a school's first term this is the whole of the guidance,
 * and it is the honest answer. An empty list reads as "nothing to do here",
 * which is a different and wrong message.
 */
const monitoringItem = (coverage) => ({
  type:     "monitoring",
  priority: "low",
  rationaleCode: "INSUFFICIENT_ACADEMIC_EVIDENCE",
  evidence: [
    { metric: "observed_sequences", value: coverage?.sequences ?? 0 },
    { metric: "observed_subjects",  value: coverage?.subjects  ?? 0 },
  ],
  recommendedActionCodes: ["MONITOR_NEXT_SEQUENCE"],
  confidence: "insufficient",
});

/**
 * Guidance for an already-computed profile.
 *
 * Pure, and exported separately from the loading version so the projection can
 * be exercised without a database — and so a caller that already holds a
 * profile (a class fan-out, say) does not recompute it per pupil.
 *
 * @param {object|null} profile from subjectInsights.profileFor / analyse
 * @returns {object[]} guidance items, in the profile's own order
 */
const guidanceForProfile = (profile) => {
  if (!profile) return [];

  const items = (profile.insights ?? [])
    // Belt and braces: the engine does not emit an insight it calls
    // insufficient, and if that ever changes this must not quietly start
    // recommending action on evidence the engine itself distrusts.
    .filter((insight) => insight.confidence !== "insufficient")
    .map(fromInsight)
    .filter(Boolean);

  if (!profile.coverage?.sufficient) items.push(monitoringItem(profile.coverage));

  return items;
};

module.exports = {
  guidanceForProfile,
  // Exported so a check can assert the vocabulary is stable — a code that
  // changes spelling silently loses its translation in both languages.
  RISK_GUIDANCE,
  STRENGTH_RATIONALE,
  STRENGTH_ACTIONS,
};
