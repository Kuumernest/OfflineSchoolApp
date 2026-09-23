// backend/scripts/calibration/reviewFeedback.js
"use strict";

/**
 * What the teachers said, set against what the engine said.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * A review sheet comes back from a school with its forms filled in. This turns
 * that into the thing Stage 7's decision protocol actually needs: for each
 * classification code and each threshold behind it, how often did the person
 * who knows the child agree, half-agree, or disagree — and when they disagreed
 * about a trend, what did they think really happened.
 *
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * Compute an accuracy score. A dozen reviewed cases from one school do not
 * support a percentage anybody should repeat, and a number like that acquires
 * authority the moment it is written down. Below MIN_CASES_FOR_SHARE the shares
 * are withheld and the counts stand on their own. Above it they are reported as
 * shares of reviewed cases, never as "accuracy".
 *
 * Nor does it change anything. A pattern it surfaces — "every rejected decline
 * was explained as assessment difficulty" — is an observation for the threshold
 * decision protocol in docs/25, where a human weighs it against the alternative
 * explanations. Teacher feedback is calibration evidence, not a rule.
 *
 * ── Pure, deterministic ───────────────────────────────────────────────────
 *
 * Takes the review-cases file with its forms filled; returns counts. No clock,
 * no I/O, no engine call. Sorted throughout.
 */

const { REVIEW_FORM } = require("./analyseCohort");

/** Below this many reviewed cases, no share is reported — only counts. */
const MIN_CASES_FOR_SHARE = 30;

/** A pattern is only named when at least this many cases support it. */
const MIN_SUPPORT_FOR_PATTERN = 3;

const OUTCOMES = Object.freeze([
  "confirmed", "partially_appropriate", "rejected", "insufficient_evidence", "uncertain", "unreviewed",
]);

/** One form → one outcome word. Insufficient evidence outranks the verdict. */
const outcomeOf = (review) => {
  if (!review || review.classificationAppropriate === null || review.classificationAppropriate === undefined) {
    return review?.evidenceSufficient === "NO" ? "insufficient_evidence" : "unreviewed";
  }
  if (review.evidenceSufficient === "NO") return "insufficient_evidence";
  switch (review.classificationAppropriate) {
    case "YES":       return "confirmed";
    case "PARTIALLY": return "partially_appropriate";
    case "NO":        return "rejected";
    default:          return "uncertain";
  }
};

const countBy = (items, key) => {
  const out = {};
  for (const it of items) {
    const k = key(it);
    if (k === null || k === undefined) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
};
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Validate one filled form against the published contract.
 * @returns {string[]} problems, empty when the form is acceptable
 */
const validateReview = (review, caseId) => {
  const problems = [];
  if (!review || typeof review !== "object") return [`${caseId}: review must be an object`];
  const allow = (field, values) => {
    const v = review[field];
    if (v !== null && v !== undefined && !values.includes(v)) {
      problems.push(`${caseId}: ${field} "${v}" is not one of ${values.join("/")}`);
    }
  };
  allow("observedPattern",           REVIEW_FORM.observedPattern);
  allow("classificationAppropriate", REVIEW_FORM.classificationAppropriate);
  allow("evidenceSufficient",        REVIEW_FORM.evidenceSufficient);
  allow("guidanceAppropriate",       REVIEW_FORM.guidanceAppropriate);
  if (review.temporal) {
    const t = review.temporal;
    if (t.interpretationReasonable != null && !REVIEW_FORM.temporal.interpretationReasonable.includes(t.interpretationReasonable)) {
      problems.push(`${caseId}: temporal.interpretationReasonable "${t.interpretationReasonable}" is not allowed`);
    }
    if (t.possibleExplanation != null && !REVIEW_FORM.temporal.possibleExplanation.includes(t.possibleExplanation)) {
      problems.push(`${caseId}: temporal.possibleExplanation "${t.possibleExplanation}" is not allowed`);
    }
  }
  for (const f of ["reason", "notes"]) {
    if (review[f] != null && typeof review[f] !== "string") problems.push(`${caseId}: ${f} must be text`);
  }
  return problems;
};

/**
 * Cross-tabulate teacher verdicts against engine classifications.
 *
 * @param {object} sheet  a review-cases.json whose `review` forms have been filled
 * @returns {object}
 */
const analyseReviews = (sheet) => {
  const cases = Array.isArray(sheet?.cases) ? sheet.cases : [];
  const problems = cases.flatMap((c) => validateReview(c.review, c.caseId));

  const rows = cases.map((c) => ({
    caseId: c.caseId,
    category: c.category,
    codes: (c.classifications ?? []).map((x) => x.code),
    thresholds: (c.thresholdsInvolved ?? []).map((t) => t.threshold),
    outcome: outcomeOf(c.review),
    guidance: c.review?.guidanceAppropriate ?? null,
    temporal: c.review?.temporal ?? null,
    reason: c.review?.reason ?? null,
  })).sort((a, b) => a.caseId.localeCompare(b.caseId));

  const reviewed = rows.filter((r) => r.outcome !== "unreviewed");
  const n = reviewed.length;
  const shares = n >= MIN_CASES_FOR_SHARE;

  const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]));

  // Per classification code: how the reviews of cases carrying it fell.
  const byCode = {};
  for (const r of reviewed) {
    for (const code of new Set(r.codes)) {
      byCode[code] = byCode[code] ?? Object.fromEntries(OUTCOMES.filter((o) => o !== "unreviewed").map((o) => [o, 0]));
      byCode[code][r.outcome] += 1;
    }
  }
  // Per threshold behind those codes: where disagreement concentrates.
  const byThreshold = {};
  for (const r of reviewed) {
    for (const t of new Set(r.thresholds)) {
      byThreshold[t] = byThreshold[t] ?? { confirmed: 0, partially_appropriate: 0, rejected: 0, insufficient_evidence: 0, uncertain: 0 };
      byThreshold[t][r.outcome] += 1;
    }
  }

  const guidanceDisagreements = reviewed
    .filter((r) => r.guidance === "NO" || r.guidance === "PARTIALLY")
    .map((r) => ({ caseId: r.caseId, codes: r.codes, guidanceAppropriate: r.guidance, reason: r.reason }));

  const temporalRows = reviewed.filter((r) => r.temporal);
  const temporalDisagreements = temporalRows
    .filter((r) => r.temporal.interpretationReasonable === "NO" || r.temporal.interpretationReasonable === "UNCERTAIN")
    .map((r) => ({ caseId: r.caseId, codes: r.codes, interpretationReasonable: r.temporal.interpretationReasonable,
                   possibleExplanation: r.temporal.possibleExplanation ?? null, reason: r.reason }));
  const explanations = countBy(temporalRows, (r) => r.temporal.possibleExplanation);

  /*
   * Patterns worth a human's attention, each with its support count. Named
   * only above MIN_SUPPORT_FOR_PATTERN, and phrased as what was observed, not
   * as what should change.
   */
  const patterns = [];
  for (const [code, o] of Object.entries(byCode).sort()) {
    const total = Object.values(o).reduce((a, b) => a + b, 0);
    if (o.rejected >= MIN_SUPPORT_FOR_PATTERN && o.rejected * 2 >= total) {
      patterns.push({ kind: "CODE_OFTEN_REJECTED", code, support: o.rejected, of: total,
        note: `Reviewers rejected ${o.rejected} of ${total} cases carrying ${code}. Examine the thresholds behind it before anything else.` });
    }
    if (o.insufficient_evidence >= MIN_SUPPORT_FOR_PATTERN && o.insufficient_evidence * 2 >= total) {
      patterns.push({ kind: "CODE_ON_THIN_EVIDENCE", code, support: o.insufficient_evidence, of: total,
        note: `Reviewers found the evidence insufficient in ${o.insufficient_evidence} of ${total} ${code} cases. Look at minObservations and establishedObservations.` });
    }
  }
  const nonGenuine = temporalDisagreements.filter((r) => r.possibleExplanation && r.possibleExplanation !== "genuine_student_change");
  const byExplanation = countBy(nonGenuine, (r) => r.possibleExplanation);
  for (const [why, k] of Object.entries(byExplanation)) {
    if (k >= MIN_SUPPORT_FOR_PATTERN) {
      patterns.push({ kind: "TREND_EXPLAINED_OTHERWISE", explanation: why, support: k, of: temporalRows.length,
        note: `${k} disputed trend readings were attributed to ${why} rather than the pupil. If they share an assessment boundary, the signal may be the paper, not the children.` });
    }
  }
  if (guidanceDisagreements.length >= MIN_SUPPORT_FOR_PATTERN &&
      guidanceDisagreements.length * 2 >= n) {
    patterns.push({ kind: "GUIDANCE_OFTEN_DISPUTED", support: guidanceDisagreements.length, of: n,
      note: "Reviewers disputed the suggested actions in at least half the reviewed cases, independently of the classification." });
  }

  return {
    totals: { cases: rows.length, reviewed: n, unreviewed: rows.length - n, byOutcome },
    shares: shares
      ? Object.fromEntries(Object.entries(byOutcome).filter(([o]) => o !== "unreviewed").map(([o, k]) => [o, round2(k / n)]))
      : null,
    sharesWithheld: shares ? null : `fewer than ${MIN_CASES_FOR_SHARE} reviewed cases; counts only`,
    byCode,
    byThreshold,
    guidanceDisagreements,
    temporalDisagreements,
    temporalExplanations: explanations,
    patterns,
    problems,
    minCasesForShare: MIN_CASES_FOR_SHARE,
    minSupportForPattern: MIN_SUPPORT_FOR_PATTERN,
  };
};

module.exports = { analyseReviews, validateReview, outcomeOf, OUTCOMES, MIN_CASES_FOR_SHARE, MIN_SUPPORT_FOR_PATTERN };
