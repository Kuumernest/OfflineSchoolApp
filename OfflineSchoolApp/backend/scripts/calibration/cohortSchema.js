// backend/scripts/calibration/cohortSchema.js
"use strict";

/**
 * The calibration cohort: what a real school's histories look like once every
 * name has been taken out of them.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 *
 * Stage 7 asks one question — do the engine's rules say reasonable things
 * about real children — and answering it means feeding real histories to the
 * engine outside the database they live in. This file is the contract for that
 * hand-over: the shape a cohort file has, what it must never contain, and how
 * it is turned into the plain input shared/intelligence already accepts.
 *
 * ── The distinctions that must survive the export ─────────────────────────
 *
 * Every one of these is a different fact about a child, and the engine treats
 * them differently. A cohort format that flattened any pair of them would make
 * the calibration measure the flattening rather than the engine:
 *
 *   score: 0                  a mark the pupil earned            counted
 *   score: null               nothing behind the row            not counted
 *   isAbsent: true            did not sit the paper             not counted
 *   isExempt: true            excused from the subject          not counted
 *   exam.type: "ca"           half of a sequence                not an occasion
 *   isPublished: false        a draft nobody signed off         not read at all
 *
 * So the format carries each of them as its own field, the validator refuses a
 * file that omits them, and toEngineInput() applies exactly the one filter the
 * production loader applies (published only) and nothing else. Every other
 * exclusion is the engine's to make, so that what is measured is the engine.
 *
 * ── What must never be in the file ────────────────────────────────────────
 *
 * Names, contacts, guardians, credentials, money. The validator does a deep
 * key scan and refuses the whole file on the first hit, because a calibration
 * set is something that gets emailed to a head teacher and opened on a laptop,
 * and "we meant to strip that" is not a defence.
 *
 * ── Pure ──────────────────────────────────────────────────────────────────
 *
 * No database, no clock, no network. Everything here runs identically on the
 * server, on a desktop, or in a check script with nothing else installed.
 */

const path = require("path");

const { CA_TYPE, TEST_TYPE } = require(path.join(__dirname, "..", "..", "..", "shared", "caAssessment"));
const academicOrder   = require(path.join(__dirname, "..", "..", "..", "shared", "intelligence", "academicOrder"));
const subjectInsights = require(path.join(__dirname, "..", "..", "..", "shared", "intelligence", "subjectInsights"));

const FORMAT         = "osa-intelligence-cohort";
const FORMAT_VERSION = 1;

/**
 * Exam.type, as the backend model enumerates it. Listed here because this file
 * must not require a Mongoose model; scripts/check-calibration.js asserts the
 * two lists are identical so they cannot drift apart.
 */
const ASSESSMENT_TYPES = Object.freeze([TEST_TYPE, "practical", "promotion_exam", CA_TYPE]);

/** How the file says where it came from. Only one of these is evidence. */
const PROVENANCE_KINDS = Object.freeze(["synthetic", "anonymised-real"]);

/**
 * Keys that may not appear anywhere in a cohort file, at any depth.
 *
 * Matched case-insensitively as whole key names, so `subjectName` and
 * `className` pass (a subject is not a person) while `studentName`, `name`,
 * `firstName` and `guardianPhone` do not.
 */
const FORBIDDEN_KEYS = Object.freeze([
  "name", "studentname", "firstname", "lastname", "fullname", "displayname",
  "phone", "phonenumber", "mobile", "telephone", "email", "address",
  "guardian", "guardianname", "guardianphone", "guardianemail", "parent",
  "parentname", "parentphone", "nextofkin",
  "password", "passwordhash", "token", "refreshtoken", "userid", "authid",
  "dateofbirth", "dob", "birthdate", "nationalid", "photo", "photourl",
  "balance", "fee", "fees", "feebalance", "arrears", "payment", "payments",
  "invoice", "receipt", "amount",
]);

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Validate a cohort. Never throws; always returns every problem it found.
 *
 * @param {object} cohort  the parsed file
 * @returns {{ ok: boolean, errors: string[], warnings: string[], stats: object }}
 */
const validateCohort = (cohort) => {
  const errors = [];
  const warnings = [];
  const err  = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!isPlainObject(cohort)) {
    return { ok: false, errors: ["cohort must be an object"], warnings, stats: {} };
  }

  // ── Envelope ─────────────────────────────────────────────────────────────
  if (cohort.format !== FORMAT) err(`format must be "${FORMAT}"`);
  if (cohort.formatVersion !== FORMAT_VERSION) err(`formatVersion must be ${FORMAT_VERSION}`);
  if (!isPlainObject(cohort.provenance) || !PROVENANCE_KINDS.includes(cohort.provenance.kind)) {
    err(`provenance.kind must be one of ${PROVENANCE_KINDS.join(", ")}`);
  }

  // ── Nothing identifying, anywhere ────────────────────────────────────────
  const forbidden = new Set(FORBIDDEN_KEYS);
  const scan = (node, trail) => {
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, `${trail}[${i}]`)); return; }
    if (!isPlainObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (forbidden.has(k.toLowerCase())) err(`identifying or financial field "${k}" at ${trail}.${k}`);
      scan(v, `${trail}.${k}`);
    }
  };
  scan(cohort, "$");

  // ── Grading context (optional; the engine defaults without it) ───────────
  if (cohort.grading !== undefined && cohort.grading !== null) {
    if (!isPlainObject(cohort.grading)) err("grading must be an object or null");
    else if (cohort.grading.grades !== undefined && !Array.isArray(cohort.grading.grades)) {
      err("grading.grades must be an array");
    }
  }
  if (cohort.academicStructure !== undefined && cohort.academicStructure !== null &&
      !isPlainObject(cohort.academicStructure)) {
    err("academicStructure must be an object or null");
  }

  // ── Exams ────────────────────────────────────────────────────────────────
  const exams = Array.isArray(cohort.exams) ? cohort.exams : [];
  if (!Array.isArray(cohort.exams)) err("exams must be an array");
  const examById = new Map();
  exams.forEach((e, i) => {
    const at = `exams[${i}]`;
    if (!isPlainObject(e)) { err(`${at} must be an object`); return; }
    if (!isNonEmptyString(e.examId)) err(`${at}.examId is required`);
    else if (examById.has(e.examId)) err(`${at}.examId "${e.examId}" is duplicated`);
    else examById.set(e.examId, e);
    if (!ASSESSMENT_TYPES.includes(e.type)) {
      err(`${at}.type "${e.type}" is not one of ${ASSESSMENT_TYPES.join(", ")}`);
    }
    if (!isNonEmptyString(e.academicYear)) err(`${at}.academicYear is required`);
    if (!isInt(e.term) || e.term < 1 || e.term > 3) err(`${at}.term must be an integer 1–3`);
    if (e.sequenceNumber !== null && e.sequenceNumber !== undefined &&
        (!isInt(e.sequenceNumber) || e.sequenceNumber < 1 || e.sequenceNumber > 6)) {
      err(`${at}.sequenceNumber must be null or an integer 1–6`);
    }
    if (e.startDate !== null && e.startDate !== undefined && !isDay(e.startDate)) {
      err(`${at}.startDate must be null or YYYY-MM-DD`);
    }
    if (e.type === CA_TYPE && !isNonEmptyString(e.parentExamId)) {
      warn(`${at} is continuous assessment with no parentExamId; still excluded as an occasion`);
    }
  });

  /*
   * Temporal ordering. Within one year, a later term must not be dated before
   * an earlier one, and within one term a later sequence must not be dated
   * before an earlier one. A file that breaks this would make the before/after
   * comparison split on dates that contradict the sequence numbers, and the
   * calibration would be measuring the export rather than the engine.
   */
  const dated = exams.filter((e) => isDay(e.startDate) && e.type !== CA_TYPE && isNonEmptyString(e.academicYear));
  for (const a of dated) {
    for (const b of dated) {
      if (a === b || a.academicYear !== b.academicYear) continue;
      const aKey = [a.term, a.sequenceNumber ?? academicOrder.UNSEQUENCED];
      const bKey = [b.term, b.sequenceNumber ?? academicOrder.UNSEQUENCED];
      const earlier = aKey[0] < bKey[0] || (aKey[0] === bKey[0] && aKey[1] < bKey[1]);
      if (earlier && a.startDate > b.startDate) {
        err(`invalid temporal ordering: exam "${a.examId}" (T${aKey[0]} S${aKey[1]}) is dated ` +
            `${a.startDate}, after "${b.examId}" (T${bKey[0]} S${bKey[1]}) at ${b.startDate}`);
      }
    }
  }

  // ── Results ──────────────────────────────────────────────────────────────
  const results = Array.isArray(cohort.results) ? cohort.results : [];
  if (!Array.isArray(cohort.results)) err("results must be an array");
  const resultIds = new Set();
  const evidenceSeen = new Set();
  const studentIds = new Set();
  const subjectIds = new Set();
  let published = 0, subjectRows = 0;

  results.forEach((r, i) => {
    const at = `results[${i}]`;
    if (!isPlainObject(r)) { err(`${at} must be an object`); return; }
    if (!isNonEmptyString(r.resultId)) err(`${at}.resultId is required`);
    else if (resultIds.has(r.resultId)) err(`${at}.resultId "${r.resultId}" is duplicated`);
    else resultIds.add(r.resultId);
    if (!isNonEmptyString(r.studentId)) err(`${at}.studentId is required`);
    else studentIds.add(r.studentId);
    if (!isNonEmptyString(r.examId)) err(`${at}.examId is required`);
    else if (!examById.has(r.examId)) err(`${at}.examId "${r.examId}" names no exam`);
    if (typeof r.isPublished !== "boolean") err(`${at}.isPublished must be true or false`);
    else if (r.isPublished) published += 1;
    if (r.computedAt !== undefined && r.computedAt !== null &&
        (typeof r.computedAt !== "string" || Number.isNaN(Date.parse(r.computedAt)))) {
      err(`${at}.computedAt must be null or an ISO date-time`);
    }
    if (!Array.isArray(r.subjects)) { err(`${at}.subjects must be an array`); return; }

    r.subjects.forEach((s, j) => {
      const sat = `${at}.subjects[${j}]`;
      subjectRows += 1;
      if (!isPlainObject(s)) { err(`${sat} must be an object`); return; }
      if (!isNonEmptyString(s.subjectId)) err(`${sat}.subjectId is required`);
      else subjectIds.add(s.subjectId);
      if (!isNonEmptyString(s.subjectName)) err(`${sat}.subjectName is required`);

      // The dedupe key is what the source keeps unique: one mark per pupil per
      // subject per exam. Two rows here mean the export double-counted.
      if (isNonEmptyString(r.studentId) && isNonEmptyString(r.examId) && isNonEmptyString(s.subjectId)) {
        const key = `${r.studentId}|${r.examId}|${s.subjectId}`;
        if (evidenceSeen.has(key)) err(`duplicate evidence for ${key} at ${sat}`);
        evidenceSeen.add(key);
      }

      for (const flag of ["isAbsent", "isExempt"]) {
        if (typeof s[flag] !== "boolean") err(`${sat}.${flag} must be true or false`);
      }
      const max = Number(s.maxScore);
      if (!Number.isFinite(max) || max <= 0) err(`${sat}.maxScore must be a positive number`);
      if (s.coefficient !== undefined && s.coefficient !== null &&
          (!Number.isFinite(Number(s.coefficient)) || Number(s.coefficient) <= 0)) {
        err(`${sat}.coefficient must be a positive number`);
      }

      // score: a number in range, or null. Nothing else — "", "abs", NaN and
      // undefined are all the malformed case, not a fourth state.
      if (s.score === null) {
        // fine: no mark behind the row
      } else if (typeof s.score !== "number" || !Number.isFinite(s.score)) {
        err(`${sat}.score must be a number or null`);
      } else if (s.score < 0 || (Number.isFinite(max) && s.score > max)) {
        err(`${sat}.score ${s.score} is outside 0–${max}`);
      }
      if (s.normalizedMark === null) {
        // permitted only beside a null score
        if (s.score !== null) err(`${sat}.normalizedMark is null but score is not`);
      } else if (typeof s.normalizedMark !== "number" || !Number.isFinite(s.normalizedMark) ||
                 s.normalizedMark < 0 || s.normalizedMark > subjectInsights.SCALE) {
        err(`${sat}.normalizedMark must be a number 0–${subjectInsights.SCALE} or null`);
      }

      if ((s.isAbsent || s.isExempt) && s.score !== null) {
        warn(`${sat} is ${s.isAbsent ? "absent" : "exempt"} but carries a score; the engine will ignore the row`);
      }
    });
  });

  // ── Students (optional list, for pupils with no results at all) ──────────
  if (cohort.students !== undefined) {
    if (!Array.isArray(cohort.students)) err("students must be an array when present");
    else cohort.students.forEach((s, i) => {
      if (!isPlainObject(s) || !isNonEmptyString(s.studentId)) err(`students[${i}].studentId is required`);
      else studentIds.add(s.studentId);
    });
  }

  // ── Interventions (optional) ─────────────────────────────────────────────
  if (cohort.interventions !== undefined) {
    if (!Array.isArray(cohort.interventions)) err("interventions must be an array when present");
    else cohort.interventions.forEach((iv, i) => {
      const at = `interventions[${i}]`;
      if (!isPlainObject(iv)) { err(`${at} must be an object`); return; }
      if (!isNonEmptyString(iv.interventionId)) err(`${at}.interventionId is required`);
      if (!isNonEmptyString(iv.studentId)) err(`${at}.studentId is required`);
      if (iv.subjectId !== null && iv.subjectId !== undefined && !isNonEmptyString(iv.subjectId)) {
        err(`${at}.subjectId must be a string or null`);
      }
      for (const f of ["createdAt", "startedAt"]) {
        if (iv[f] !== undefined && iv[f] !== null &&
            (typeof iv[f] !== "string" || Number.isNaN(Date.parse(iv[f])))) {
          err(`${at}.${f} must be null or an ISO date-time`);
        }
      }
      if (!isNonEmptyString(iv.createdAt)) err(`${at}.createdAt is required`);
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      exams: exams.length,
      results: results.length,
      publishedResults: published,
      subjectRows,
      students: studentIds.size,
      subjects: subjectIds.size,
      interventions: Array.isArray(cohort.interventions) ? cohort.interventions.length : 0,
    },
  };
};

/**
 * A validated cohort → the plain input the shared engine takes.
 *
 * Mirrors the production loader and only the loader: PUBLISHED rows only, in
 * the ResultSummary shape. Every other exclusion — CA, absence, exemption, the
 * null score — is left for the engine, because the point of the exercise is to
 * measure what the engine does with them.
 *
 * @param {object} cohort  a cohort that validateCohort() accepted
 */
const toEngineInput = (cohort) => {
  const exams = cohort.exams ?? [];
  const examById = new Map(exams.map((e) => [e.examId, e]));

  const summaries = (cohort.results ?? [])
    .filter((r) => r.isPublished === true)
    .map((r) => {
      const exam = examById.get(r.examId);
      return {
        _id:          r.resultId,
        examId:       r.examId,
        studentId:    r.studentId,
        classId:      r.classId ?? null,
        academicYear: exam?.academicYear ?? null,
        term:         exam ? String(exam.term) : null,
        isPublished:  true,
        createdAt:    r.computedAt ?? null,
        subjectBreakdown: (r.subjects ?? []).map((s) => ({
          subjectId:      s.subjectId,
          subjectName:    s.subjectName,
          normalizedMark: s.normalizedMark,
          score:          s.score,
          maxScore:       s.maxScore,
          coefficient:    s.coefficient ?? 1,
          isAbsent:       s.isAbsent === true,
          isExempt:       s.isExempt === true,
        })),
      };
    });

  const engineExams = exams.map((e) => ({
    _id:            e.examId,
    type:           e.type,
    academicYear:   e.academicYear,
    term:           e.term,
    sequenceNumber: e.sequenceNumber ?? null,
    startDate:      e.startDate ?? null,
    parentExamId:   e.parentExamId ?? null,
  }));

  const studentIds = [...new Set([
    ...(cohort.students ?? []).map((s) => s.studentId),
    ...(cohort.results ?? []).map((r) => r.studentId),
  ])].sort();

  const historyByStudent = academicOrder.orderPublishedHistory(summaries, engineExams);
  const grading = subjectInsights.resolveGradingContext({
    gradingConfig:     cohort.grading ?? null,
    academicStructure: cohort.academicStructure ?? null,
  });

  return {
    studentIds,
    summaries,
    exams: engineExams,
    historyByStudent,
    grading,
    interventions: (cohort.interventions ?? []).map((iv) => ({
      _id:        iv.interventionId,
      studentId:  iv.studentId,
      subjectId:  iv.subjectId ?? null,
      status:     iv.status ?? null,
      createdAt:  iv.createdAt,
      startedAt:  iv.startedAt ?? null,
    })),
  };
};

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  ASSESSMENT_TYPES,
  PROVENANCE_KINDS,
  FORBIDDEN_KEYS,
  validateCohort,
  toEngineInput,
};
