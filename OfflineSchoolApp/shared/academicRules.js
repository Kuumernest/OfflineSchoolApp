// OfflineSchoolApp/shared/academicRules.js
"use strict";

/**
 * The school's calculation rules for one academic year (docs/39 §20, Phase 4).
 *
 * ── Every rule is the school's decision, and every default is today ───────
 *
 * docs/39 §21.1 lists the decisions that change real results: which sequence
 * average is official (D1), where promotion reads its results (D1b), which
 * promotion rule applies (D2), and whether published results may be silently
 * recomputed (D3). They need the school's authorised academic review, so the
 * code does not take them. Each is a rule here, chosen per school and year,
 * and each DEFAULT is exactly what the system did before this existed: a
 * school that never opens the setting computes byte-for-byte as before
 * (pinned by check:academic).
 *
 * ── How a rule reaches a result ───────────────────────────────────────────
 *
 * Rules live on AcademicStructure.rules (per year), are frozen into the
 * AcademicPolicySnapshot with the rest of the year's configuration, and every
 * row computed under them carries that snapshot's hash. Only rules that
 * differ from the default go into the snapshot, so a school on defaults keeps
 * the very same policy hash it had before rules existed.
 *
 * The writer's calcVersion says which arithmetic ran: "/1" is the code that
 * existed before Phase 4, used whenever the rules it depends on are at their
 * defaults; "/2" is the rule-driven code, interpreted with the snapshot's
 * rules. (policyHash, calcVersion) still answers "what produced this row?".
 *
 * Pure: no database. Shared by the backend and the web settings screen.
 */

/**
 * Each rule: its values, its default (today), and what it decides.
 * `decision` names the docs/39 §21.1 question it answers.
 */
const RULES = Object.freeze({
  sequenceAverage: Object.freeze({
    decision: "D1",
    default:  "raw_mean",
    values:   Object.freeze([
      // POST /exams/:examId/process as it has always been (docs/39 §4.7):
      // whole-number mean of raw paper marks, no CA, no coefficients, an
      // absent subject counted as zero, ranked by percentage.
      "raw_mean",
      // The figure the sequence card already prints (docs/39 §21.1, the
      // recommendation): each subject's mark on /20 with CA blended by the
      // school's split, weighted by coefficient, absent subjects left out;
      // two decimals; ranked by that average. Summaries also carry their
      // academicYear and term, which the promotion run selects by.
      "weighted_20",
    ]),
  }),
  gradingAuthority: Object.freeze({
    decision: "§12",
    default:  "split",
    values:   Object.freeze([
      // Term and annual rows store a grade from the built-in scale, while
      // their cards print the school's bands (docs/39 §4.2).
      "split",
      // Term and annual rows store the school's own bands and remark, so the
      // stored grade and the printed grade are the same one.
      "school_bands",
    ]),
  }),
  promotionRule: Object.freeze({
    decision: "D1b/D2",
    default:  "legacy",
    values:   Object.freeze([
      // Today: published sequence summaries of the year, a class's
      // promotionAverage when set, else passing at least half of them; the
      // annual row's status from "every term passed + promotion exams".
      "legacy",
      // The year's AnnualResult average at or above a threshold on /20
      // (a class may have its own). One rule for the proposal and for the
      // annual row's status (docs/39 §14).
      "annual_average_at_least",
      // The year's TermResults: passing at least half of them.
      "majority_of_terms_passed",
      // No proposal from results: every pupil is "needs decision".
      "manual_only",
    ]),
  }),
  publishedResults: Object.freeze({
    decision: "D3",
    default:  "overwrite",
    values:   Object.freeze([
      // Today: recomputing replaces published figures in place.
      "overwrite",
      // Recomputing anything already published is refused; unpublish first,
      // which is the deliberate, visible act.
      "refuse",
    ]),
  }),
});

const RULE_KEYS = Object.freeze(Object.keys(RULES));

/** The rules exactly as the system behaved before Phase 4. */
const DEFAULT_RULES = Object.freeze({
  sequenceAverage:    RULES.sequenceAverage.default,
  gradingAuthority:   RULES.gradingAuthority.default,
  promotionRule:      RULES.promotionRule.default,
  publishedResults:   RULES.publishedResults.default,
  promotionThreshold: null,
  classThresholds:    Object.freeze({}),
});

const SCALE_MAX = 20;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const onScale = (v) => isFiniteNumber(v) && v >= 0 && v <= SCALE_MAX;

/**
 * Every rule, with defaults filled in. Tolerant: an unknown value or a stray
 * field reads as the default, because this runs on stored documents, and a
 * stored document that no longer validates must still compute — as it did
 * before. Writes are checked strictly by validateRules.
 *
 * @param {object|null|undefined} raw  AcademicStructure.rules
 */
const effectiveRules = (raw) => {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of RULE_KEYS) {
    out[key] = RULES[key].values.includes(r[key]) ? r[key] : RULES[key].default;
  }
  out.promotionThreshold = onScale(r.promotionThreshold) ? r.promotionThreshold : null;
  const ct = {};
  if (r.classThresholds && typeof r.classThresholds === "object") {
    for (const id of Object.keys(r.classThresholds).sort()) {
      if (onScale(r.classThresholds[id])) ct[id] = r.classThresholds[id];
    }
  }
  out.classThresholds = ct;
  return out;
};

/**
 * Only what differs from the default — what the policy snapshot records.
 * Empty when the school is on defaults, so its policy hash does not move.
 * Thresholds are recorded only where the chosen rule reads them.
 */
const nonDefaultRules = (raw) => {
  const r = effectiveRules(raw);
  const out = {};
  for (const key of RULE_KEYS) {
    if (r[key] !== RULES[key].default) out[key] = r[key];
  }
  if (r.promotionRule === "annual_average_at_least") {
    if (r.promotionThreshold !== null) out.promotionThreshold = r.promotionThreshold;
    if (Object.keys(r.classThresholds).length > 0) out.classThresholds = r.classThresholds;
  }
  return out;
};

const isDefault = (raw) => Object.keys(nonDefaultRules(raw)).length === 0;

/**
 * A write's body, checked strictly. Partial bodies are allowed: a field left
 * out keeps its current value (the caller merges).
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: Array<{field, code, message}> }}
 */
const validateRules = (body) => {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: null, code: "INVALID_BODY", message: "rules must be an object" }] };
  }
  const allowed = new Set([...RULE_KEYS, "promotionThreshold", "classThresholds"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) errors.push({ field: k, code: "UNKNOWN_RULE", message: `${k} is not a rule` });
  }
  const value = {};
  for (const key of RULE_KEYS) {
    if (body[key] === undefined) continue;
    if (!RULES[key].values.includes(body[key])) {
      errors.push({
        field: key, code: "INVALID_VALUE",
        message: `${key} must be one of ${RULES[key].values.join(", ")}`,
      });
    } else value[key] = body[key];
  }
  if (body.promotionThreshold !== undefined) {
    if (body.promotionThreshold !== null && !onScale(body.promotionThreshold)) {
      errors.push({ field: "promotionThreshold", code: "INVALID_THRESHOLD",
                    message: `promotionThreshold must be a number from 0 to ${SCALE_MAX}, or null` });
    } else value.promotionThreshold = body.promotionThreshold;
  }
  if (body.classThresholds !== undefined) {
    const ct = body.classThresholds;
    if (!ct || typeof ct !== "object" || Array.isArray(ct)) {
      errors.push({ field: "classThresholds", code: "INVALID_THRESHOLD",
                    message: "classThresholds must be an object of classId → number" });
    } else {
      const clean = {};
      for (const [id, v] of Object.entries(ct)) {
        if (v === null) continue;                      // null removes a class's own bar
        if (!onScale(v)) {
          errors.push({ field: `classThresholds.${id}`, code: "INVALID_THRESHOLD",
                        message: `a class threshold must be a number from 0 to ${SCALE_MAX}` });
        } else clean[id] = v;
      }
      value.classThresholds = clean;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
};

/**
 * A complete rule set is coherent: annual_average_at_least needs a bar for
 * every class it will judge, so it needs the school-wide threshold.
 */
const coherenceErrors = (rules) => {
  const r = effectiveRules(rules);
  const errors = [];
  if (r.promotionRule === "annual_average_at_least" && r.promotionThreshold === null) {
    errors.push({ field: "promotionThreshold", code: "THRESHOLD_REQUIRED",
                  message: "annual_average_at_least needs a promotionThreshold" });
  }
  return errors;
};

/**
 * The calcVersion a writer stamps, from the rules it ran under.
 * "/1" whenever every rule it reads is at its default — the pre-Phase-4 code.
 */
const calcVersionFor = (writer, raw) => {
  const r = effectiveRules(raw);
  switch (writer) {
    case "examProcess":
      return r.sequenceAverage === "weighted_20" ? "exam-process/2" : "exam-process/1";
    case "term":
      return r.gradingAuthority === "school_bands" ? "term/2" : "term/1";
    case "annual":
      return r.gradingAuthority === "school_bands" || r.promotionRule !== "legacy"
        ? "annual/2" : "annual/1";
    default:
      throw new Error(`calcVersionFor: unknown writer ${writer}`);
  }
};

/**
 * A class's promotion bar under annual_average_at_least: its own, else the
 * school-wide one; null when neither is set.
 */
const promotionBarFor = (raw, classId) => {
  const r = effectiveRules(raw);
  const own = classId != null ? r.classThresholds[String(classId)] : undefined;
  return own ?? r.promotionThreshold;
};

/**
 * The year's promotion outcome under a non-legacy rule — ONE function for the
 * annual row's promotionStatus and for the promotion run's proposal
 * (docs/39 §14: today they are two rules that can disagree, §4.4).
 *
 * @param {object} raw  the rules
 * @param {object} year
 * @param {number|null} year.annualAverage   the AnnualResult average (/20)
 * @param {Array<{isComplete: boolean, passed: boolean}>} year.terms  one per term of the year
 * @param {number} year.termsInYear          how many terms the year's structure has
 * @param {string|null} [year.classId]
 * @returns {{ status: "promoted"|"repeated"|"pending", reason: string }}
 *   pending = not decidable from results (incomplete year, no bar, manual_only)
 */
const promotionUnderRules = (raw, { annualAverage, terms, termsInYear, classId = null }) => {
  const r = effectiveRules(raw);
  if (r.promotionRule === "legacy") throw new Error("promotionUnderRules: legacy has its own rule");
  if (r.promotionRule === "manual_only") return { status: "pending", reason: "manual" };

  const done = (terms || []).filter((t) => t.isComplete);
  if (!(termsInYear > 0) || done.length < termsInYear) return { status: "pending", reason: "incomplete" };

  if (r.promotionRule === "annual_average_at_least") {
    const bar = promotionBarFor(raw, classId);
    if (bar == null || annualAverage == null) return { status: "pending", reason: "no_threshold" };
    return annualAverage >= bar
      ? { status: "promoted", reason: "average_pass" }
      : { status: "repeated", reason: "average_fail" };
  }
  // majority_of_terms_passed
  const passed = done.filter((t) => t.passed).length;
  return passed * 2 >= termsInYear
    ? { status: "promoted", reason: "results_pass" }
    : { status: "repeated", reason: "results_fail" };
};

/**
 * Is a sequence summary's `average` already on /20?
 *
 * Three writers have produced ResultSummary rows: the unrouted
 * processResults (GPA points, which cards print ×5 — docs/39 §4.1), the live
 * route under raw_mean (a raw-mark mean, which cards have also multiplied by
 * 5), and the live route under weighted_20 (a true /20 average). Only the
 * last is on /20, and its calcVersion says so.
 */
const sequenceAverageIsOn20 = (calcVersion) => calcVersion === "exam-process/2";

module.exports = {
  RULES,
  RULE_KEYS,
  DEFAULT_RULES,
  SCALE_MAX,
  effectiveRules,
  nonDefaultRules,
  isDefault,
  validateRules,
  coherenceErrors,
  calcVersionFor,
  promotionBarFor,
  promotionUnderRules,
  sequenceAverageIsOn20,
};
