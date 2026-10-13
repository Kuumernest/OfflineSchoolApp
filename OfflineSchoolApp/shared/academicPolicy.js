// OfflineSchoolApp/shared/academicPolicy.js
"use strict";

/**
 * The academic policy a result is computed under, as one plain object.
 *
 * ── What this is for (docs/39 §6.3, Phase 2b) ─────────────────────────────
 *
 * A result today records nothing about the rules that produced it: the grade
 * bands, the CA split, the sequence and term weights and the pass mark all
 * live in documents a school edits in place. "Which configuration produced
 * this result?" has no answer, and nothing done later can recover one for a
 * result already written. This module turns the documents a computation reads
 * into a single canonical description of the rules, so the backend can freeze
 * it (AcademicPolicySnapshot) and, from Phase 2c, stamp its hash on results.
 *
 * ── Configuration, not code ───────────────────────────────────────────────
 *
 * The policy records the CONFIGURATION a computation read — never what the
 * code does with it. Four different pieces of code read the same documents
 * and do different things with them (docs/39 §4.7): the live sequence route
 * ignores the CA split the unrouted one blends, and grades with the school's
 * bands where the unrouted one uses the built-in table. A policy that tried
 * to describe that would be true of one writer and false of the others.
 *
 * What the code does is named separately, per writer, by CALC_VERSIONS and
 * stamped beside the policy hash on every row. (policy, calcVersion) is the
 * whole answer to "what produced this result?". Nothing here is read by a
 * calculation.
 *
 * ── What changes the hash, and what deliberately does not ─────────────────
 *
 * Only fields a result row or a printed card depends on. The fields no code
 * reads (INERT_FIELDS) are left out, so editing one does not make every
 * result in the school look stale. If a later change makes one of them live,
 * it moves into the policy and POLICY_FORMAT says so.
 *
 * Class promotion bars (Class.promotionAverage) are left out too: no result
 * row depends on them, only the promotion run does, and reading every class
 * on every computation would cost a query on paths that are held to a fixed
 * count (check-term-compute, check-complexity). When promotion decisions are
 * stamped they carry their own record of the bars they used.
 *
 * Pure: no database, no clock, no crypto (the backend hashes canonicalJson).
 */

const { DEFAULT_PASS_MARK } = require("./gradeScale");
const CA = require("./caAssessment");

/**
 * The code that wrote a result row, one name per writer. Each moves only when
 * that writer's arithmetic does (docs/39 §8) — a D1 decision would ship as,
 * say, "exam-process/2" for new computations.
 *
 *   examProcess     POST /exams/:examId/process (exam.routes.js) — the live
 *                   sequence route: raw-mark whole-number mean, no CA, no
 *                   coefficients, absent as zero (docs/39 §4.7)
 *   resultsService  results.service.processResults — unrouted: CA blended,
 *                   coefficients, GPA-point average (docs/39 §4.1)
 *   term            termGrading — term average from the sequence summaries
 *   annual          annualGrading — annual average and promotion status
 */
const CALC_VERSIONS = Object.freeze({
  examProcess:    "exam-process/1",
  resultsService: "results-service/1",
  term:           "term/1",
  annual:         "annual/1",
});

/** The shape of the object below. Moves only if the shape does. */
const POLICY_FORMAT = 2;

/**
 * Fields stored on the configuration documents that no calculation reads
 * under results/1 (docs/39 §3). Listed so the omission is a decision with a
 * reason rather than an oversight, and so a test can hold the list to it.
 */
const INERT_FIELDS = Object.freeze({
  academicStructure: ["annualAverageMethod", "maxAbsences", "sequences[].assessment"],
  gradingConfig:     ["useGpa", "gpaScale", "gradingType", "sequenceWeightingMethod",
                      "sequenceWeights", "termWeightingMethod", "termWeights"],
});

const num = (v, fallback = null) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);

const band = (b) => ({
  grade:     String(b.grade),
  minMark:   num(b.minMark ?? b.min),
  maxMark:   num(b.maxMark ?? b.max),
  gpaPoints: num(b.gpaPoints ?? b.points, 0),
  remark:    b.remark ?? "",
  remarkFr:  b.remarkFr ?? "",
});

/**
 * The parts a scored period's result is made of, from the CA settings.
 *
 * Under results/1 every sequence is a paper and, when CA is on, the CA beside
 * it, combined by the school-wide split (sequenceAssessment.blendSubject). A
 * part with no mark is dropped and the rest renormalised, so neither part is
 * `required`.
 */
const componentsFor = (ca) => (ca.caEnabled
  ? [
      { key: "ca",   assessmentType: CA.CA_TYPE,   weight: ca.caWeight,   required: false },
      { key: "test", assessmentType: CA.TEST_TYPE, weight: ca.testWeight, required: false },
    ]
  : [{ key: "test", assessmentType: CA.TEST_TYPE, weight: ca.testWeight, required: false }]);

/**
 * A v1 AcademicStructure (numbered terms holding numbered sequences) as the
 * keyed period tree of docs/39 §6.1.
 *
 * Keys are derived from the numbers ("t1", "s3"), so the same structure always
 * yields the same tree and an exam can be placed in it from (term,
 * sequenceNumber) alone. `legacy` carries those numbers for every reader that
 * still uses them — which, under results/1, is every reader.
 *
 * Terms and sequences are emitted in number order, not array order: term and
 * annual computation look them up by number, so array order is not part of
 * the rule and must not move the hash.
 *
 * @param {object|null} structure  an AcademicStructure document (lean)
 * @param {{caEnabled, caWeight, testWeight}} ca  resolved CA settings
 * @returns {Array<object>} periods, parents before their children
 */
const periodsFromLegacy = (structure, ca) => {
  if (!structure || !Array.isArray(structure.terms)) return [];
  const components = componentsFor(ca);
  const byNumber = (a, b) => Number(a.number) - Number(b.number);

  const periods = [];
  for (const t of [...structure.terms].sort(byNumber)) {
    const term = Number(t.number);
    periods.push({
      key: `t${term}`, name: t.name ?? null, kind: "term", parentKey: null,
      order: term, weight: num(t.weight), contributesToAnnual: true, scored: false,
      components: [], legacy: { term, sequence: null },
    });
    const sequences = [...(t.sequences || [])].sort(byNumber);
    sequences.forEach((s, i) => {
      const sequence = Number(s.number);
      periods.push({
        key: `s${sequence}`, name: s.name ?? null, kind: "sequence", parentKey: `t${term}`,
        order: i + 1,
        // termGrading reads `seqConfig?.weight ?? 50` — the same default here.
        weight: num(s.weight, 50),
        contributesToAnnual: true, scored: true,
        components: components.map((c) => ({ ...c })),
        legacy: { term, sequence },
      });
    });
  }
  return periods;
};

/**
 * The effective academic policy for one school and year.
 *
 * @param {object}  input
 * @param {string}  input.schoolId
 * @param {string}  input.academicYear
 * @param {object|null} input.structure      AcademicStructure for that year (lean), or null
 * @param {object|null} input.gradingConfig  the school's GradingConfig (lean), or null
 * @returns {object} the policy; canonicalJson() of it is what gets hashed
 */
const resolvePolicy = ({ schoolId, academicYear, structure = null, gradingConfig = null }) => {
  if (!schoolId)     throw new Error("resolvePolicy: schoolId is required");
  if (!academicYear) throw new Error("resolvePolicy: academicYear is required");

  const ca = CA.caSettings(gradingConfig);
  const schoolBands = Array.isArray(gradingConfig?.grades) && gradingConfig.grades.length > 0
    ? gradingConfig.grades.map(band) : null;

  // The school's pass mark as every live writer reads it: the live sequence
  // route (subject and overall pass), term, annual and the cards all use
  // `passMark ?? 10`. (The unrouted processResults uses a fixed 10 — that is
  // its calcVersion's business, not configuration.)
  const passMark = num(gradingConfig?.passMark, DEFAULT_PASS_MARK);

  return {
    format:       POLICY_FORMAT,
    schoolId:     String(schoolId),
    academicYear: String(academicYear),

    structure: structure ? { periods: periodsFromLegacy(structure, ca) } : null,

    grading: {
      // The school's own bands; null = it has none and every writer falls
      // back to the built-in table (shared/gradeScale DEFAULT_GRADES).
      schoolBands,
      passMark,
      passMarkSource: num(gradingConfig?.passMark) !== null ? "gradingConfig" : "default",
      // AcademicStructure's own pass mark: read by intelligence when the
      // grading config has none (shared/intelligence/subjectInsights.js).
      structurePassMark: num(structure?.passMark),
      showGrades: gradingConfig?.showGrades ?? true,
      ca,
    },

    // annualGrading's promotion status: every promotion exam at or above
    // the threshold (/20), alongside every term passed.
    promotion: {
      promotionExams:     [...(structure?.promotionExams || [])].map(Number).sort((a, b) => a - b),
      promotionThreshold: num(structure?.promotionThreshold),
    },
  };
};

/**
 * JSON with object keys sorted at every depth, so two equal policies are the
 * same string whatever order their fields were assembled in. Arrays keep
 * their order — band order is first-match-wins and is part of the rule.
 */
const canonicalJson = (value) => {
  const norm = (v) => {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : norm(x)));
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const n = norm(v[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  };
  return JSON.stringify(norm(value));
};

module.exports = {
  CALC_VERSIONS,
  POLICY_FORMAT,
  INERT_FIELDS,
  periodsFromLegacy,
  resolvePolicy,
  canonicalJson,
};
