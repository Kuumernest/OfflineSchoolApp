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
 * ── It DESCRIBES, it does not decide ──────────────────────────────────────
 *
 * Nothing here is read by a calculation. Under calcVersion "results/1" the
 * arithmetic is exactly the code's: grading.service, termGrading,
 * annualGrading, promotion. The policy records the inputs those read, with
 * the meaning they have there — including where the code does not do what the
 * configuration suggests (docs/39 §4.2): stored grades come from the built-in
 * scale (`calcBands`) and a hard-coded 10/20 subject pass mark, while cards
 * re-grade with the school's bands (`schoolBands`). Writing that down
 * faithfully is the point; tidying it is Phase 4.
 *
 * ── What changes the hash, and what deliberately does not ─────────────────
 *
 * Only fields some calculation or printed card reads. The fields no code
 * reads (INERT_FIELDS) are left out, so editing one does not make every
 * result in the school look stale. If a later change makes one of them live,
 * it moves into the policy and calcVersion says so.
 *
 * Pure: no database, no clock, no crypto (the backend hashes canonicalJson).
 */

const { DEFAULT_GRADES, DEFAULT_PASS_MARK } = require("./gradeScale");
const CA = require("./caAssessment");

/**
 * The arithmetic's own version. It names the code that turns a policy into
 * results, and moves only when a formula does (docs/39 §8) — e.g. the
 * sequence-average decision, D1, would be "results/2".
 */
const CALC_VERSION = "results/1";

/** The shape of the object below. Moves only if the shape does. */
const POLICY_FORMAT = 1;

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
 * @param {Array}  [input.classes]           the school's classes: [{ _id, promotionAverage }]
 * @returns {object} the policy; canonicalJson() of it is what gets hashed
 */
const resolvePolicy = ({ schoolId, academicYear, structure = null, gradingConfig = null, classes = [] }) => {
  if (!schoolId)     throw new Error("resolvePolicy: schoolId is required");
  if (!academicYear) throw new Error("resolvePolicy: academicYear is required");

  const ca = CA.caSettings(gradingConfig);
  const schoolBands = Array.isArray(gradingConfig?.grades) && gradingConfig.grades.length > 0
    ? gradingConfig.grades.map(band) : null;

  // The pass mark a TERM or YEAR, and a card's subject row, is judged against:
  // termGrading, annualGrading and reportCardData all read `passMark ?? 10`.
  const periodPassMark = num(gradingConfig?.passMark, DEFAULT_PASS_MARK);

  // Classes with their own promotion bar, by id. Entered 0–100 and compared,
  // under results/1, against the GPA-point mean of the year's sequence
  // averages (docs/39 §4.1) — recorded as entered, never converted.
  const classOverrides = {};
  for (const c of [...classes].sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const bar = num(c.promotionAverage);
    if (bar !== null) classOverrides[String(c._id)] = { promotionAverage: bar };
  }

  return {
    format:      POLICY_FORMAT,
    calcVersion: CALC_VERSION,
    schoolId:    String(schoolId),
    academicYear: String(academicYear),

    structure: structure ? {
      periods: periodsFromLegacy(structure, ca),
      assessmentTypes: ["test", "practical", "promotion_exam", CA.CA_TYPE],
    } : null,

    grading: {
      scale:    { max: 20 },
      rounding: { decimals: 2, mode: "half_up" },
      // What grading.service grades every stored mark with: the built-in
      // table and a hard-coded 10/20, whatever the school configured.
      calcBands:       DEFAULT_GRADES.map(band),
      subjectPassMark: DEFAULT_PASS_MARK,
      // What term/annual pass decisions and card subject rows use.
      periodPassMark,
      periodPassMarkSource: num(gradingConfig?.passMark) !== null ? "gradingConfig" : "default",
      // AcademicStructure's own pass mark: read by intelligence when the
      // grading config has none (shared/intelligence/subjectInsights.js).
      structurePassMark: num(structure?.passMark),
      // What cards grade with at render time; null = the built-in table.
      schoolBands,
      showGrades: gradingConfig?.showGrades ?? true,
      ca,
    },

    // Constant under results/1 — written out so that a policy that ranks
    // differently is a different policy rather than an unrecorded one.
    ranking: {
      enabled: true,
      basis:   "average",
      ties:    "competition",
      scopes:  { sequence: ["class", "className", "school"], term: ["class"], annual: ["class"] },
      // Who gets a place, per level, as check:academic pins it: a sequence
      // leaves fully-absent pupils unranked; a term writes no row (so no
      // place) for an unmarked pupil; the year ranks every active pupil,
      // the unmarked included (docs/39 §4.6k).
      ranked: { sequence: "not_fully_absent", term: "has_term_result", annual: "every_active_pupil" },
    },

    promotion: {
      // annualGrading: every term passed, and every promotion exam at or
      // above the threshold.
      annual: {
        rule:               "all_terms_passed_and_promotion_exams",
        promotionExams:     [...(structure?.promotionExams || [])].map(Number).sort((a, b) => a - b),
        promotionThreshold: num(structure?.promotionThreshold),
      },
      // promotion.proposeFor: the class's bar when set, else the majority of
      // published sequence results.
      proposal: { rule: "class_average_else_majority_passed", classOverrides },
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
  CALC_VERSION,
  POLICY_FORMAT,
  INERT_FIELDS,
  periodsFromLegacy,
  resolvePolicy,
  canonicalJson,
};
