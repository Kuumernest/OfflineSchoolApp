// OfflineSchoolApp/shared/academicRules.js
"use strict";

/**
 * How results are calculated, for every school (docs/39 §21.1, decided by the
 * project owner on 2026-10-16), and the one thing a school sets: its
 * promotion bars.
 *
 * ── The calculation is the platform's, not a school's choice ──────────────
 *
 * Phase 4 made D1, D1b, D2 and D3 per-school rules whose defaults were the
 * behaviour before rules existed. The project owner has decided them, once,
 * for every school:
 *
 *   sequence average   the coefficient-weighted mean out of 20; CA blended by
 *                      the school's split when GradingConfig.caEnabled is on;
 *                      a subject with no paper mark (absent, exempt, or not
 *                      entered) left out, mark and coefficient; a 0 entered by
 *                      a teacher is a real 0 (weightedSequence.service)
 *   grading authority  term and annual rows store the school's own bands
 *   promotion          the published annual average, out of 20, against the
 *                      class's bar for the year; every term of the year must
 *                      be published, or the pupil needs a decision
 *   published results  never recomputed in place: unpublish first
 *
 * Effective for every result computed from the release date: a published row
 * keeps its figures and its calcVersion, and an unpublished one follows these
 * rules the next time its exam, term or year is processed.
 *
 * ── What a school still sets ───────────────────────────────────────────────
 *
 * AcademicStructure.rules, per year: `promotionThreshold`, the school's bar
 * for a class without its own (null = the school's pass mark), and
 * `classThresholds`, classId → bar. Both out of 20. Coefficients, CA on/off,
 * the CA/paper split and showGrades stay on GradingConfig and the subjects.
 *
 * A stored `promotionRule: "manual_only"` is still honoured (no proposal from
 * results), because it promotes and holds back nobody; nothing can set it any
 * more. Every other stored rule value from Phase 4 is ignored.
 *
 * Pure: no database. Shared by the backend and the web settings screens.
 */

/** The decided behaviour (docs/39 §21.1). Not configurable. */
const PLATFORM = Object.freeze({
  sequenceAverage:  "weighted_20",
  gradingAuthority: "school_bands",
  promotionRule:    "annual_average_at_least",
  publishedResults: "refuse",
});

/** Names the decided rule set in every policy snapshot it produced. */
const PLATFORM_RULES = "agreed/1";

/** The rule names Phase 4 let a school choose. A write naming one is refused. */
const FIXED_RULE_KEYS = Object.freeze(Object.keys(PLATFORM));

/** What a school may write. */
const WRITABLE_KEYS = Object.freeze(["promotionThreshold", "classThresholds"]);

const SCALE_MAX = 20;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const onScale = (v) => isFiniteNumber(v) && v >= 0 && v <= SCALE_MAX;

/**
 * The rules in force, from a stored AcademicStructure.rules. Tolerant: this
 * runs on stored documents, so a stray field or an old Phase 4 choice reads as
 * the platform's behaviour. Writes are checked strictly by validateRules.
 */
const effectiveRules = (raw) => {
  const r = raw && typeof raw === "object" ? raw : {};
  const ct = {};
  if (r.classThresholds && typeof r.classThresholds === "object") {
    for (const id of Object.keys(r.classThresholds).sort()) {
      if (onScale(r.classThresholds[id])) ct[id] = r.classThresholds[id];
    }
  }
  return {
    ...PLATFORM,
    promotionRule: r.promotionRule === "manual_only" ? "manual_only" : PLATFORM.promotionRule,
    promotionThreshold: onScale(r.promotionThreshold) ? r.promotionThreshold : null,
    classThresholds: ct,
  };
};

/** What is stored on the structure: the bars, and a legacy manual_only. */
const storedRules = (raw) => {
  const r = effectiveRules(raw);
  const out = {};
  if (r.promotionRule === "manual_only") out.promotionRule = "manual_only";
  if (r.promotionThreshold !== null) out.promotionThreshold = r.promotionThreshold;
  if (Object.keys(r.classThresholds).length > 0) out.classThresholds = r.classThresholds;
  return out;
};

/** What the policy snapshot records: the decided rule set, then the bars. */
const snapshotRules = (raw) => ({ platform: PLATFORM_RULES, ...storedRules(raw) });

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
  for (const k of Object.keys(body)) {
    if (FIXED_RULE_KEYS.includes(k)) {
      errors.push({ field: k, code: "RULE_FIXED",
                    message: `${k} is no longer a school setting; every school calculates the same way` });
    } else if (!WRITABLE_KEYS.includes(k)) {
      errors.push({ field: k, code: "UNKNOWN_RULE", message: `${k} is not a rule` });
    }
  }
  const value = {};
  if (body.promotionThreshold !== undefined) {
    if (body.promotionThreshold !== null && !onScale(body.promotionThreshold)) {
      errors.push({ field: "promotionThreshold", code: "INVALID_THRESHOLD",
                    message: `promotionThreshold must be a number from 0 to ${SCALE_MAX}, or null (the pass mark)` });
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
        if (v === null) { clean[id] = null; continue; }   // null removes a class's own bar
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
 * Current rules with a checked write applied. A class bar of null in the
 * write removes that class's own bar; other classes keep theirs.
 */
const mergeRules = (current, value) => {
  const cur = effectiveRules(current);
  const ct = { ...cur.classThresholds };
  if (value.classThresholds) {
    for (const [id, v] of Object.entries(value.classThresholds)) {
      if (v === null) delete ct[id]; else ct[id] = v;
    }
  }
  return effectiveRules({
    ...cur,
    ...(value.promotionThreshold !== undefined ? { promotionThreshold: value.promotionThreshold } : {}),
    classThresholds: ct,
  });
};

/** The calcVersion each writer stamps under the decided rules. */
const CALC_VERSION_OF = Object.freeze({
  examProcess: "exam-process/3",
  term:        "term/3",
  annual:      "annual/3",
});

const calcVersionFor = (writer) => {
  if (!CALC_VERSION_OF[writer]) throw new Error(`calcVersionFor: unknown writer ${writer}`);
  return CALC_VERSION_OF[writer];
};

/**
 * A class's bar for the year: its own, else the school's, else the school's
 * pass mark. Never null when a pass mark is given.
 */
const promotionBarFor = (raw, classId, passMark = null) => {
  const r = effectiveRules(raw);
  const own = classId != null ? r.classThresholds[String(classId)] : undefined;
  return own ?? r.promotionThreshold ?? (isFiniteNumber(passMark) ? passMark : null);
};

/**
 * The year's promotion outcome — ONE function for the annual row's
 * promotionStatus and for the promotion run's proposal (docs/39 §14).
 *
 * @param {object} raw  the stored rules
 * @param {object} year
 * @param {number|null} year.annualAverage   the AnnualResult average (/20)
 * @param {Array<{isComplete: boolean}>} year.terms  one per term of the year
 * @param {number} year.termsInYear          how many terms the year's structure has
 * @param {string|null} [year.classId]
 * @param {number|null} [year.passMark]      the default bar
 * @returns {{ status: "promoted"|"repeated"|"pending", reason: string }}
 *   pending = not decidable from results (incomplete year, no average, manual_only)
 */
const promotionUnderRules = (raw, { annualAverage, terms, termsInYear, classId = null, passMark = null }) => {
  const r = effectiveRules(raw);
  if (r.promotionRule === "manual_only") return { status: "pending", reason: "manual" };

  const done = (terms || []).filter((t) => t.isComplete);
  if (!(termsInYear > 0) || done.length < termsInYear) return { status: "pending", reason: "incomplete" };

  const bar = promotionBarFor(raw, classId, passMark);
  if (bar == null || annualAverage == null) return { status: "pending", reason: "no_threshold" };
  return annualAverage >= bar
    ? { status: "promoted", reason: "average_pass" }
    : { status: "repeated", reason: "average_fail" };
};

/**
 * Is a sequence summary's `average` already on /20?
 *
 * Three writers have produced ResultSummary rows: the unrouted processResults
 * (GPA points, results-service/1), the live route before the decision
 * (exam-process/1, a raw-mark mean on the papers' own scale) and the live
 * route since (exam-process/2 under the Phase 4 weighted_20 rule, and
 * exam-process/3 under the decided rules), which store a /20 average.
 */
const sequenceAverageIsOn20 = (calcVersion) =>
  calcVersion === "exam-process/2" || calcVersion === "exam-process/3";

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A sequence summary's figure on /20, for the term layer. The stored row is
 * never changed; only how it is read.
 *
 *   exam-process/2, /3   the stored average
 *   results-service/1    the stored average, as before (the unrouted path,
 *                        reached only by tests and scripts)
 *   exam-process/1, or   the summary's percentage ÷ 5: the raw-mark mean put
 *   no calcVersion       on /20, from the same marks (no CA, no coefficients,
 *                        absent counted as zero, as it was computed). Decided
 *                        by the project owner for terms that mix old and new
 *                        sequences (docs/39 §20.0). A row with no percentage
 *                        is read as stored.
 */
const sequenceFigureOn20 = (summary) => {
  if (!summary || summary.average == null) return null;
  const average = Number(summary.average);
  const v = summary.calcVersion ?? null;
  if (sequenceAverageIsOn20(v) || v === "results-service/1") return average;
  const pct = Number(summary.percentage);
  return summary.percentage != null && Number.isFinite(pct) ? round2(pct / 5) : average;
};

module.exports = {
  PLATFORM,
  PLATFORM_RULES,
  FIXED_RULE_KEYS,
  WRITABLE_KEYS,
  SCALE_MAX,
  CALC_VERSION_OF,
  effectiveRules,
  storedRules,
  snapshotRules,
  validateRules,
  mergeRules,
  calcVersionFor,
  promotionBarFor,
  promotionUnderRules,
  sequenceAverageIsOn20,
  sequenceFigureOn20,
};
