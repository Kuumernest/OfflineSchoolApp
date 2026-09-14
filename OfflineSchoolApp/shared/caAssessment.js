// OfflineSchoolApp/shared/caAssessment.js
"use strict";

/**
 * Continuous Assessment, and the only copy of its rules.
 *
 * ── What a sequence actually is ───────────────────────────────────────────
 *
 * A sequence is not one paper. Most Cameroonian schools mark a pupil twice
 * inside it — continuous assessment through the weeks, then the sequence
 * paper — and the sequence mark is the two combined by the school's own
 * percentages. Some schools run the paper alone. Both have to be true of the
 * same system, which is what `caEnabled` decides.
 *
 * CA is therefore not a column on a report card. It is an assessment in its
 * own right, stored the way every other assessment is stored: an Exam of type
 * "ca" bound to the same sequence as the paper, with its own ExamSubjects and
 * its own StudentScores. Everything that already exists for marks — entry,
 * validation, permissions, the offline queue, the sync engine — works on it
 * without knowing it is CA.
 *
 * Used by:
 *   - backend/src/db/models/GradingConfig.js          (the stored settings)
 *   - backend/src/services/sequenceAssessment.service (pairing + blending)
 *   - backend/src/services/results.service.js         (the sequence result)
 *   - backend/src/routes/admin.routes.js              (PUT /settings/grading)
 *   - desktop/src/main/api/…/settings.js              (the same, offline)
 *   - web + mobile settings screens                   (the same validation)
 *
 * ── The one rule that is easy to get wrong ────────────────────────────────
 *
 * A pupil with no CA recorded is not a pupil who scored zero in CA. The two
 * look identical in an average that treats a missing mark as 0 and they are
 * not the same fact: one is an absent record, the other is a mark a teacher
 * gave. So a missing part is DROPPED and the weights are renormalised over
 * what is actually there — which is also why a school that has never used CA
 * gets exactly the marks it has always had, with no migration.
 */

// ── The assessment types a sequence is made of ────────────────────────────

/** Exam.type for continuous assessment. */
const CA_TYPE = "ca";

/** Exam.type for the sequence paper. The system's pre-existing default. */
const TEST_TYPE = "test";

// ── Defaults ──────────────────────────────────────────────────────────────

/**
 * CA is ON for a new school.
 *
 * A school that does not use it turns it off; the alternative — off by default —
 * means the schools that do use it silently print half a report card until
 * somebody notices.
 */
const DEFAULT_CA_ENABLED = true;

/** 40 / 60, which is the split this system was specified against. */
const DEFAULT_CA_WEIGHT   = 40;
const DEFAULT_TEST_WEIGHT = 60;

/** What the two weights must add up to when CA is on. */
const TOTAL_WEIGHT = 100;

// ── Reading the settings ──────────────────────────────────────────────────

const isFiniteNumber = (n) => Number.isFinite(Number(n));

/**
 * The CA settings a school is operating under, from whatever the grading
 * config happens to hold — including nothing at all.
 *
 * When CA is off the answer is Test at 100 %, so every caller downstream can
 * do the same arithmetic in both cases rather than branching on a boolean it
 * might forget to check.
 *
 * @param {{caEnabled?: boolean, caWeight?: number, testWeight?: number}|null} config
 * @returns {{caEnabled: boolean, caWeight: number, testWeight: number}}
 */
const caSettings = (config) => {
  const caEnabled = config?.caEnabled ?? DEFAULT_CA_ENABLED;
  if (!caEnabled) return { caEnabled: false, caWeight: 0, testWeight: TOTAL_WEIGHT };

  const caWeight = isFiniteNumber(config?.caWeight)
    ? Number(config.caWeight) : DEFAULT_CA_WEIGHT;
  const testWeight = isFiniteNumber(config?.testWeight)
    ? Number(config.testWeight) : DEFAULT_TEST_WEIGHT;

  /*
   * A stored pair that does not add up is repaired on READ rather than
   * obeyed. It can only get there by predating this feature or by a write
   * that bypassed validation, and the honest reading of "CA 40, Test 0" is
   * not "the paper counts for nothing" — it is a half-written document. The
   * write path refuses it; this keeps a report card from being graded by it.
   */
  if (caWeight < 0 || testWeight < 0 ||
      Math.round((caWeight + testWeight) * 100) / 100 !== TOTAL_WEIGHT) {
    return {
      caEnabled: true,
      caWeight:   DEFAULT_CA_WEIGHT,
      testWeight: DEFAULT_TEST_WEIGHT,
    };
  }

  return { caEnabled: true, caWeight, testWeight };
};

/**
 * May these settings be saved?
 *
 * @param {{caEnabled?: boolean, caWeight?: any, testWeight?: any}} input
 * @returns {{ok: boolean, error: string|null, code: string|null}}
 */
const validateCaWeights = (input) => {
  const caEnabled = input?.caEnabled ?? DEFAULT_CA_ENABLED;

  // Off: the weights are not used, so whatever is stored stays stored. A
  // school that turns CA off and back on must find its own split intact.
  if (!caEnabled) return { ok: true, error: null, code: null };

  const caWeight   = input?.caWeight;
  const testWeight = input?.testWeight;

  for (const [label, value] of [["caWeight", caWeight], ["testWeight", testWeight]]) {
    if (value === undefined || value === null || value === "") {
      return {
        ok: false, code: "CA_WEIGHT_REQUIRED",
        error: `${label} is required when continuous assessment is enabled`,
      };
    }
    if (!isFiniteNumber(value)) {
      return { ok: false, code: "CA_WEIGHT_INVALID", error: `${label} must be a number` };
    }
    if (Number(value) < 0) {
      return { ok: false, code: "CA_WEIGHT_NEGATIVE", error: `${label} cannot be negative` };
    }
  }

  const sum = Math.round((Number(caWeight) + Number(testWeight)) * 100) / 100;
  if (sum !== TOTAL_WEIGHT) {
    return {
      ok: false, code: "CA_WEIGHT_SUM",
      error: `caWeight + testWeight must equal ${TOTAL_WEIGHT}% (got ${sum}%)`,
    };
  }

  return { ok: true, error: null, code: null };
};

// ── Combining the two assessments ─────────────────────────────────────────

/**
 * One part of a sequence, as a fraction of its own maximum.
 *
 * null — not zero — when the pupil has no mark: absent, exempt, or simply
 * never recorded. A CA that was never entered must not pull an average down.
 *
 * @param {{score?: number|null, maxScore?: number|null, isAbsent?: boolean, isExempt?: boolean}|null} part
 * @returns {number|null} 0..1, or null
 */
const fractionOf = (part) => {
  if (!part || part.isAbsent || part.isExempt) return null;
  if (part.score === null || part.score === undefined || part.score === "") return null;
  const score = Number(part.score);
  const max   = Number(part.maxScore);
  if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return null;
  return score / max;
};

/** A part expressed on the /20 scale the report card speaks, or null. */
const markOutOf20 = (part) => {
  const f = fractionOf(part);
  return f == null ? null : Math.round(f * 20 * 100) / 100;
};

/**
 * Combine a pupil's CA and Test for one subject into the sequence mark.
 *
 * The weights are renormalised over the parts that exist, so:
 *
 *   CA 14/20 + Test 16/20 at 40/60  →  0.4×14 + 0.6×16       = 15.2/20
 *   Test 16/20 alone                →  16/20, not 0.6×16     = 16.0/20
 *   CA 14/20 alone                  →  14/20                 = 14.0/20
 *   neither                         →  null, and null is not a zero
 *
 * Combining as FRACTIONS rather than raw marks is deliberate: CA may be marked
 * out of 20 and the paper out of 100, and a school is entitled to do that.
 *
 * @param {object} p
 * @param {object|null} p.ca     {score, maxScore, isAbsent, isExempt} or null
 * @param {object|null} p.test   same
 * @param {number} p.caWeight
 * @param {number} p.testWeight
 * @returns {{
 *   fraction: number|null, mark20: number|null,
 *   caMark20: number|null, testMark20: number|null,
 *   hasCa: boolean, hasTest: boolean,
 *   appliedCaWeight: number, appliedTestWeight: number,
 * }}
 */
const combineSequenceMark = ({ ca, test, caWeight, testWeight }) => {
  const caFraction   = fractionOf(ca);
  const testFraction = fractionOf(test);

  const hasCa   = caFraction   != null;
  const hasTest = testFraction != null;

  const wCa   = hasCa   ? Math.max(0, Number(caWeight)   || 0) : 0;
  const wTest = hasTest ? Math.max(0, Number(testWeight) || 0) : 0;
  const total = wCa + wTest;

  let fraction = null;
  if (total > 0) {
    fraction = ((hasCa ? caFraction * wCa : 0) + (hasTest ? testFraction * wTest : 0)) / total;
  } else if (hasCa || hasTest) {
    /*
     * Both weights zero and yet a mark exists — a configuration nobody meant.
     * A plain mean of what is there beats discarding a real mark, and it is
     * the same fallback the term card already makes for unweighted sequences.
     */
    const present = [hasCa ? caFraction : null, hasTest ? testFraction : null]
      .filter((f) => f != null);
    fraction = present.reduce((s, f) => s + f, 0) / present.length;
  }

  return {
    fraction,
    mark20:     fraction == null ? null : Math.round(fraction * 20 * 100) / 100,
    caMark20:   markOutOf20(ca),
    testMark20: markOutOf20(test),
    hasCa,
    hasTest,
    appliedCaWeight:   total > 0 ? Math.round((wCa   / total) * 10000) / 100 : 0,
    appliedTestWeight: total > 0 ? Math.round((wTest / total) * 10000) / 100 : 0,
  };
};

module.exports = {
  CA_TYPE,
  TEST_TYPE,
  DEFAULT_CA_ENABLED,
  DEFAULT_CA_WEIGHT,
  DEFAULT_TEST_WEIGHT,
  TOTAL_WEIGHT,
  caSettings,
  validateCaWeights,
  fractionOf,
  markOutOf20,
  combineSequenceMark,
};
