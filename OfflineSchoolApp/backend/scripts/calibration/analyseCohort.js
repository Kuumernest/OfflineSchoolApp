// backend/scripts/calibration/analyseCohort.js
"use strict";

/**
 * What the engine says about a whole cohort, and where to look harder.
 *
 * ── The one rule of this file ─────────────────────────────────────────────
 *
 * It contains no intelligence rule. Not one threshold, not one comparison
 * against a mark, not one definition of "strong" or "declining". Every
 * classification it reports came out of shared/intelligence, and every number
 * it reads is a number the engine already put in a profile. The moment this
 * file decided for itself what a decline was, the calibration would be
 * measuring the calibration.
 *
 * What it DOES contain is review heuristics: "more than this share of a cohort
 * carrying academic_decline is worth a human looking at". Those are flags for
 * a reader, they are named FLAG_LIMITS, they change nothing, and the report
 * says so beside every one of them.
 *
 * ── The pipeline ──────────────────────────────────────────────────────────
 *
 *   validated cohort
 *        ↓ toEngineInput           the production loader's one filter
 *   shared/intelligence            profiles, guidance, comparisons
 *        ↓
 *   distributions                  counting what came out
 *   flags                          ratios worth a look
 *   sensitivity                    the same rules, thresholds moved ±1/±2,
 *                                  on an ISOLATED engine copy
 *   review cases                   evidence laid out for a teacher
 *
 * ── Deterministic ─────────────────────────────────────────────────────────
 *
 * No clock, no randomness, no network, no environment. Every list is sorted.
 * The same file produces the same report byte for byte, which is what makes
 * two people able to argue about it.
 */

const path = require("path");

const engine = require(path.join(__dirname, "..", "..", "..", "shared", "intelligence"));
const { toEngineInput } = require("./cohortSchema");
const { withThresholds } = require("./isolatedEngine");

const { subjectInsights, guidance, interventionOutcome, academicOrder, ENGINE_VERSION } = engine;

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW HEURISTICS — flags for a reader, not rules for the engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Above or below these shares, a distribution is flagged for human review.
 *
 * Starting values chosen the way the engine's own thresholds were: plausible
 * for a Cameroonian day school and written down so they can be argued with.
 * Crossing one changes nothing; it puts a line in the report.
 */
const FLAG_LIMITS = Object.freeze({
  /** Share of pupils with evidence carrying a risk insight: above this, over-triggering? */
  riskShareHigh:        0.40,
  /** Share of pupils with evidence carrying academic_decline specifically. */
  declineShareHigh:     0.35,
  /** Share of pupils with evidence carrying any strength: below this, under-triggering? */
  strengthShareLow:     0.05,
  /** Share of strong-average subjects (recentAverage ≥ strongMark) that got NO strength insight. */
  strongButUnflaggedHigh: 0.25,
  /** Share of pupils the engine calls insufficient: above this, the data is thin. */
  insufficientShareHigh: 0.50,
  /** Share of insights at "emerging" rather than "strong": above this, most claims rest on two marks. */
  emergingShareHigh:    0.70,
  /** Share of classifications that flip under ±1 on any threshold. */
  borderlineShareHigh:  0.30,
});

/** How far each threshold is moved for the sensitivity table. */
const SENSITIVITY_DELTAS = Object.freeze([-2, -1, 1, 2]);

/**
 * Which thresholds each insight code is decided by.
 *
 * Metadata for the review sheet, so a teacher can see which number to argue
 * with. It is not used to compute anything.
 */
const THRESHOLDS_BEHIND = Object.freeze({
  academic_decline:            ["declineDrop", "minObservations", "establishedObservations"],
  sudden_performance_change:   ["suddenDrop", "minObservations", "establishedObservations"],
  persistent_underperformance: ["minUnderperformanceObservations", "passMark", "establishedObservations"],
  subject_strength:            ["strongMark", "minObservations", "establishedObservations"],
  sustained_improvement:       ["improvementGain", "minObservations", "establishedObservations"],
  consistency_strength:        ["consistencySpread", "strongMark", "establishedObservations"],
  cross_subject_strength:      ["crossSubjectStrengths", "strongMark"],
});

// ─────────────────────────────────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;
const share  = (n, d) => (d ? round2(n / d) : 0);
const sortedKeys = (obj) => Object.keys(obj).sort();
const countBy = (items, key) => {
  const out = {};
  for (const item of items) {
    const k = key(item);
    if (k === null || k === undefined) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(sortedKeys(out).map((k) => [k, out[k]]));
};
const summarise = (nums) => {
  if (!nums.length) return { count: 0, min: null, median: null, mean: null, max: null };
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    count:  s.length,
    min:    s[0],
    median: s.length % 2 ? s[mid] : round2((s[mid - 1] + s[mid]) / 2),
    mean:   round2(s.reduce((a, b) => a + b, 0) / s.length),
    max:    s[s.length - 1],
  };
};

/** Every (student, subject, code) the engine produced, as a flat sorted list. */
const classificationsOf = (profiles) => {
  const rows = [];
  for (const [studentId, profile] of profiles) {
    for (const insight of profile.insights) {
      rows.push({
        studentId,
        subjectId: insight.subjectId ?? null,
        code: insight.code,
        confidence: insight.confidence,
      });
    }
  }
  return rows.sort((a, b) =>
    a.studentId.localeCompare(b.studentId) ||
    String(a.subjectId).localeCompare(String(b.subjectId)) ||
    a.code.localeCompare(b.code));
};
const keyOf = (c) => `${c.studentId}|${c.subjectId ?? ""}|${c.code}`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. RUN THE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Feed the cohort through the production engine once.
 *
 * Also exported on its own, so a check can compare its output to a direct
 * call of the engine and assert they are the same bytes.
 */
const runEngine = (cohort, eng = engine, precomputedInput = null) => {
  // The engine input is pure data derived from the cohort alone; a caller that
  // runs the engine many times over one cohort (the sensitivity sweep) hands it
  // in once rather than rebuilding it per run. Stage 18A: forty rebuilds per
  // request were a fifth of the review queue's time at a thousand pupils.
  const input = precomputedInput ?? toEngineInput(cohort);
  // The isolated copy resolves its own grading context, so an altered
  // strongMark flows through resolveGradingContext exactly as in production.
  const grading = eng === engine
    ? input.grading
    : eng.subjectInsights.resolveGradingContext({
        gradingConfig: cohort.grading ?? null, academicStructure: cohort.academicStructure ?? null,
      });
  const profiles = eng.subjectInsights.analyseHistories({
    historyByStudent: input.historyByStudent,
    studentIds: input.studentIds,
    grading,
  });
  const guidanceByStudent = new Map(
    input.studentIds.map((id) => [id, eng.guidance.guidanceForProfile(profiles.get(id))])
  );
  const outcomes = input.interventions.map((iv) => eng.interventionOutcome.compareOutcome({
    intervention: iv,
    history: input.historyByStudent.get(String(iv.studentId)) ?? [],
  }));
  return { input, grading, profiles, guidanceByStudent, outcomes, engineVersion: eng.subjectInsights.ENGINE_VERSION };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. WHAT THE DATA IS
// ─────────────────────────────────────────────────────────────────────────────

const evidenceReport = (cohort, run) => {
  const { input, profiles } = run;
  const examById = new Map(input.exams.map((e) => [e._id, e]));

  // Raw row states, counted from the cohort itself so the report can say how
  // much of the file the engine was ever allowed to see.
  const rowStates = { counted: 0, genuineZero: 0, absent: 0, exempt: 0, unentered: 0, inCa: 0, unpublished: 0 };
  for (const r of cohort.results ?? []) {
    const exam = examById.get(r.examId);
    for (const s of r.subjects ?? []) {
      if (!r.isPublished)              { rowStates.unpublished += 1; continue; }
      if (exam?.type === "ca")         { rowStates.inCa += 1;        continue; }
      if (s.isAbsent)                  { rowStates.absent += 1;      continue; }
      if (s.isExempt)                  { rowStates.exempt += 1;      continue; }
      if (s.score === null)            { rowStates.unentered += 1;   continue; }
      rowStates.counted += 1;
      if (s.score === 0)               rowStates.genuineZero += 1;
    }
  }

  const perStudent = [...profiles.values()].map((p) =>
    p.subjects.reduce((n, s) => n + s.observations, 0));
  const perSubject = {};
  for (const p of profiles.values()) {
    for (const s of p.subjects) {
      perSubject[s.subjectName ?? s.subjectId] = (perSubject[s.subjectName ?? s.subjectId] ?? 0) + s.observations;
    }
  }

  const occasions = [...input.historyByStudent.values()].flat().map((r) => r.occurrence);
  const years = countBy(occasions, (o) => o.academicYear);
  const terms = countBy(occasions, (o) => `${o.academicYear} T${o.term}`);
  const sequences = countBy(occasions, (o) =>
    `${o.academicYear} T${o.term} S${o.sequence === academicOrder.UNSEQUENCED ? "—" : o.sequence}`);

  return {
    students:              input.studentIds.length,
    studentsWithEvidence:  [...profiles.values()].filter((p) => p.coverage.sequences > 0).length,
    studentsSufficient:    [...profiles.values()].filter((p) => p.coverage.sufficient).length,
    studentsInsufficient:  [...profiles.values()].filter((p) => !p.coverage.sufficient).length,
    subjects:              Object.keys(perSubject).length,
    publishedOccasions:    occasions.length,
    countedMarks:          rowStates.counted,
    rowStates,
    observationsPerStudent: summarise(perStudent),
    observationsPerSubject: Object.fromEntries(sortedKeys(perSubject).map((k) => [k, perSubject[k]])),
    temporal: { years, terms, sequences },
    grading: run.grading,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT THE ENGINE SAID
// ─────────────────────────────────────────────────────────────────────────────

const distributionReport = (run) => {
  const { profiles, guidanceByStudent, outcomes, grading } = run;
  const classifications = classificationsOf(profiles);
  const withEvidence = [...profiles.values()].filter((p) => p.coverage.sufficient);
  const n = withEvidence.length;

  const studentsWith = (pred) => withEvidence.filter((p) => p.insights.some(pred)).length;
  const subjects = [...profiles.values()].flatMap((p) => p.subjects.map((s) => ({ ...s, studentId: p.studentId })));
  const analysable = subjects.filter((s) => s.observations >= grading.minObservations || s.observations >= 2);

  // "Strong on average but not flagged": read from the engine's own numbers
  // and its own threshold, no comparison invented here — recentAverage and
  // strongMark are both fields the engine emitted.
  const strongAverage = subjects.filter((s) =>
    s.observations >= 2 && s.recentAverage !== null && s.recentAverage >= grading.strongMark);
  const strongFlagged = new Set(classifications
    .filter((c) => c.code === "subject_strength").map((c) => `${c.studentId}|${c.subjectId}`));
  const strongUnflagged = strongAverage.filter((s) => !strongFlagged.has(`${s.studentId}|${s.subjectId}`));

  const allGuidance = [...guidanceByStudent.values()].flat();

  return {
    insights: {
      total:       classifications.length,
      byCode:      countBy(classifications, (c) => c.code),
      byConfidence: countBy(classifications, (c) => c.confidence),
      byCodeAndConfidence: countBy(classifications, (c) => `${c.code}:${c.confidence}`),
      studentsWithEvidence: n,
      studentsWithAnyRisk:      studentsWith((i) => i.type === "risk"),
      studentsWithAnyStrength:  studentsWith((i) => i.type === "strength"),
      studentsWithDecline:      studentsWith((i) => i.code === "academic_decline"),
      studentsWithBoth:         withEvidence.filter((p) =>
        p.insights.some((i) => i.type === "risk") && p.insights.some((i) => i.type === "strength")).length,
      studentsWithNone:         withEvidence.filter((p) => p.insights.length === 0).length,
    },
    subjects: {
      analysable:        analysable.length,
      consistency:       countBy(analysable, (s) => s.consistency),
      strongAverage:     strongAverage.length,
      strongButUnflagged: strongUnflagged.length,
      strongButUnflaggedCases: strongUnflagged.map((s) => ({
        studentId: s.studentId, subjectId: s.subjectId, recentAverage: s.recentAverage,
        observations: s.observations, spread: s.spread,
      })).slice(0, 20),
    },
    guidance: {
      total:      allGuidance.length,
      byType:     countBy(allGuidance, (g) => g.type),
      byRationale: countBy(allGuidance, (g) => g.rationaleCode),
      byPriority: countBy(allGuidance, (g) => g.priority),
      actions:    countBy(allGuidance.flatMap((g) => g.recommendedActionCodes), (a) => a),
    },
    outcomes: {
      interventions: outcomes.length,
      byStatus:      countBy(outcomes, (o) => o.status),
      byReading:     countBy(outcomes, (o) => o.reading),
      withUsableComparison: outcomes.filter((o) => o.status === "compared").length,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. SENSITIVITY — the same rules, the numbers moved, on a private copy
// ─────────────────────────────────────────────────────────────────────────────

const NUMERIC_THRESHOLDS = () =>
  Object.entries(subjectInsights.THRESHOLDS)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k)
    .sort();

const sensitivityReport = (cohort, baseline, input = null) => {
  const baseSet = new Set(baseline.map(keyOf));
  const table = {};
  const flipsByCase = new Map();   // key → Set of "threshold±d" that flipped it

  for (const key of NUMERIC_THRESHOLDS()) {
    const base = subjectInsights.THRESHOLDS[key];
    table[key] = { current: base, deltas: {} };
    for (const d of SENSITIVITY_DELTAS) {
      const value = base + d;
      if (value < 0 || (key.startsWith("min") && value < 1)) {
        table[key].deltas[d] = { value, skipped: "not a meaningful setting" };
        continue;
      }
      const run = withThresholds({ [key]: value }, (eng) => runEngine(cohort, eng, input));
      const altered = classificationsOf(run.profiles);
      const alteredSet = new Set(altered.map(keyOf));
      const gained = altered.filter((c) => !baseSet.has(keyOf(c)));
      const lost   = baseline.filter((c) => !alteredSet.has(keyOf(c)));
      for (const c of [...gained, ...lost]) {
        const k = keyOf(c);
        if (!flipsByCase.has(k)) flipsByCase.set(k, new Set());
        flipsByCase.get(k).add(`${key}${d > 0 ? "+" : ""}${d}`);
      }
      const affected = new Set([...gained, ...lost].map((c) => c.studentId));
      table[key].deltas[d] = {
        value,
        classificationsGained: gained.length,
        classificationsLost:   lost.length,
        studentsAffected:      affected.size,
        gainedByCode: countBy(gained, (c) => c.code),
        lostByCode:   countBy(lost,   (c) => c.code),
      };
    }
  }

  // Borderline: a classification that appears or disappears under any ±1 move.
  const borderline = [...flipsByCase.entries()]
    .filter(([, moves]) => [...moves].some((m) => /[+-]1$/.test(m)))
    .map(([k, moves]) => {
      const [studentId, subjectId, code] = k.split("|");
      return { studentId, subjectId: subjectId || null, code, flipsUnder: [...moves].sort() };
    })
    .sort((a, b) => a.studentId.localeCompare(b.studentId) || a.code.localeCompare(b.code));

  return {
    deltas: SENSITIVITY_DELTAS,
    thresholds: table,
    borderline,
    borderlineShare: share(borderline.length, baseline.length),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. FLAGS — where a human should look
// ─────────────────────────────────────────────────────────────────────────────

const flagsReport = (evidence, distribution, sensitivity) => {
  const flags = [];
  const flag = (code, message, value, limit) => flags.push({ code, message, value, limit });
  const n = distribution.insights.studentsWithEvidence;

  if (n === 0) {
    flag("NO_ANALYSABLE_STUDENTS", "No pupil has enough published evidence for any conclusion; nothing below is meaningful.", 0, 1);
    return flags;
  }

  const riskShare = share(distribution.insights.studentsWithAnyRisk, n);
  if (riskShare > FLAG_LIMITS.riskShareHigh) {
    flag("POSSIBLE_OVER_TRIGGERING_RISK",
      "A large share of pupils with evidence carry a risk insight. Review declineDrop, suddenDrop and minUnderperformanceObservations against what teachers say about these children.",
      riskShare, FLAG_LIMITS.riskShareHigh);
  }
  const declineShare = share(distribution.insights.studentsWithDecline, n);
  if (declineShare > FLAG_LIMITS.declineShareHigh) {
    flag("POSSIBLE_OVER_TRIGGERING_DECLINE",
      "A large share of pupils are read as declining. A cohort-wide fall in marks between sequences (a harder paper) would produce this without any child having changed.",
      declineShare, FLAG_LIMITS.declineShareHigh);
  }
  const strengthShare = share(distribution.insights.studentsWithAnyStrength, n);
  if (strengthShare < FLAG_LIMITS.strengthShareLow) {
    flag("POSSIBLE_UNDER_TRIGGERING_STRENGTH",
      "Almost nobody is read as having a strength. Check whether strongMark sits above where this school's marks actually cluster.",
      strengthShare, FLAG_LIMITS.strengthShareLow);
  }
  const unflagged = share(distribution.subjects.strongButUnflagged, distribution.subjects.strongAverage);
  if (distribution.subjects.strongAverage > 0 && unflagged > FLAG_LIMITS.strongButUnflaggedHigh) {
    flag("STRONG_AVERAGE_NOT_FLAGGED",
      "Many subjects whose recent average is at or above strongMark got no strength insight. Usually minObservations — two marks — but worth confirming case by case.",
      unflagged, FLAG_LIMITS.strongButUnflaggedHigh);
  }
  const insufficient = share(evidence.studentsInsufficient, evidence.students);
  if (insufficient > FLAG_LIMITS.insufficientShareHigh) {
    flag("DATA_SPARSE",
      "Most pupils have too little published history for any conclusion. The cohort can say little about the rules yet; it says a lot about how much has been published.",
      insufficient, FLAG_LIMITS.insufficientShareHigh);
  }
  const emerging = share(distribution.insights.byConfidence.emerging ?? 0, distribution.insights.total);
  if (distribution.insights.total > 0 && emerging > FLAG_LIMITS.emergingShareHigh) {
    flag("MOSTLY_EMERGING",
      "Most insights rest on two marks rather than three or more. Established-confidence claims are rare in this cohort; treat the distribution as provisional.",
      emerging, FLAG_LIMITS.emergingShareHigh);
  }
  if (sensitivity.borderlineShare > FLAG_LIMITS.borderlineShareHigh) {
    flag("HIGHLY_BORDERLINE",
      "A large share of classifications flip when a threshold moves by one mark. The engine's conclusions for this cohort are sensitive to its configuration.",
      sensitivity.borderlineShare, FLAG_LIMITS.borderlineShareHigh);
  }
  // Temporal anomaly candidates: the engine already guards against a
  // recovered dip reading as a decline; this lists any trend claim made on a
  // subject the engine itself calls variable, for a human to confirm.
  return flags;
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. REVIEW CASES — evidence laid out for a teacher, no names anywhere
// ─────────────────────────────────────────────────────────────────────────────

const REVIEW_CATEGORIES = Object.freeze([
  "strong_and_stable", "strong_but_recent", "weak_and_persistent", "weak_but_improving",
  "declining", "sudden_change", "volatile", "emerging_strength", "trend_on_variable_subject",
  "insufficient_evidence", "borderline_threshold", "absence_heavy", "zero_heavy",
  "mixed_assessment", "with_intervention", "cross_subject_strength",
]);

const MAX_PER_CATEGORY = 3;

/**
 * The order a reviewer's time is best spent in. Borderline first, because one
 * mark either way changes the answer; then the trend claims, which are the
 * ones most likely to be a hard paper rather than a child; then the rest.
 * A queue ordering only — it changes nothing the engine says.
 */
const REVIEW_PRIORITY = Object.freeze([
  "borderline_threshold", "declining", "sudden_change", "weak_and_persistent",
  "weak_but_improving", "cross_subject_strength", "trend_on_variable_subject",
  "strong_but_recent", "emerging_strength", "insufficient_evidence", "volatile",
  "strong_and_stable", "absence_heavy", "zero_heavy", "mixed_assessment", "with_intervention",
]);
const priorityOf = (category) => {
  const i = REVIEW_PRIORITY.indexOf(category);
  return i < 0 ? REVIEW_PRIORITY.length + 1 : i + 1;
};

/** Why each category is worth a teacher's minute. Labels for the sheet, not rules. */
const REVIEW_REASONS = Object.freeze({
  strong_and_stable:         "engine calls this an established, consistent strength",
  strong_but_recent:         "strength claimed on the minimum two marks",
  weak_and_persistent:       "engine calls this persistent underperformance",
  weak_but_improving:        "improving, but still below the pass mark",
  declining:                 "engine calls this a sustained decline",
  sudden_change:             "a large fall in the most recent sequence",
  volatile:                  "marks swing widely; the engine calls the subject variable",
  emerging_strength:         "a strength on limited evidence",
  trend_on_variable_subject: "a trend claimed on a subject the engine also calls variable",
  insufficient_evidence:     "too little published history for any claim",
  borderline_threshold:      "classification flips if a threshold moves by one mark",
  absence_heavy:             "several absences; only sat papers are counted",
  zero_heavy:                "several genuine zeros; check they were earned, not unentered",
  mixed_assessment:          "continuous assessment present; it must not count as an occasion",
  with_intervention:         "a support action was recorded; before/after evidence applies",
  cross_subject_strength:    "several subjects strong together — the engine names them and claims no domain",
});

/**
 * The teacher review form. Values a reviewer may enter, published with every
 * sheet so the file is self-describing and reviewFeedback.js can validate it.
 */
const REVIEW_FORM = Object.freeze({
  observedPattern:           ["YES", "NO", "UNCERTAIN"],
  classificationAppropriate: ["YES", "PARTIALLY", "NO", "UNCERTAIN"],
  evidenceSufficient:        ["YES", "NO"],
  guidanceAppropriate:       ["YES", "PARTIALLY", "NO", "UNCERTAIN"],
  /**
   * Where the reviewer thinks the problem is the DATA, not the rule. Structured
   * so it becomes evidence about data quality; it changes no result and no rule.
   */
  dataQuality: [
    "missing_assessment", "incorrect_result", "unpublished_result", "assessment_unusually_difficult",
    "grading_change", "student_absence", "curriculum_change", "insufficient_history",
    // Stage 8: a record that is out of date, and information that exists but
    // not in any school data — kept apart from data quality in the tally.
    "stale_record", "context_unavailable", "other",
  ],
  temporal: {
    appliesTo: ["academic_decline", "sustained_improvement", "sudden_performance_change"],
    interpretationReasonable: ["YES", "NO", "UNCERTAIN"],
    possibleExplanation: [
      "genuine_student_change", "assessment_difficulty", "curriculum_or_content_change",
      "grading_change", "missing_data", "attendance_or_context", "other",
    ],
  },
});

/** An unfilled form; the temporal block only where a trend was claimed. */
const emptyReview = (insights) => ({
  observedPattern: null,
  classificationAppropriate: null,
  evidenceSufficient: null,
  guidanceAppropriate: null,
  reason: null,
  notes: null,
  dataQuality: [],
  ...(insights.some((i) => REVIEW_FORM.temporal.appliesTo.includes(i.code))
    ? { temporal: { interpretationReasonable: null, possibleExplanation: null } }
    : {}),
});

const reviewCasesReport = (cohort, run, sensitivity) => {
  const { input, profiles, guidanceByStudent, grading } = run;
  const examById = new Map(input.exams.map((e) => [e._id, e]));
  const borderlineKeys = new Set(sensitivity.borderline.map((b) => `${b.studentId}|${b.subjectId}`));

  // Raw-data features per pupil (not rules: counts of row states).
  const raw = new Map();
  for (const r of cohort.results ?? []) {
    const f = raw.get(r.studentId) ?? { absent: 0, zeros: 0, ca: 0, tests: 0 };
    const exam = examById.get(r.examId);
    if (exam?.type === "ca") f.ca += 1; else f.tests += 1;
    for (const s of r.subjects ?? []) {
      if (s.isAbsent) f.absent += 1;
      if (s.score === 0 && !s.isAbsent && !s.isExempt) f.zeros += 1;
    }
    raw.set(r.studentId, f);
  }
  const interventionsBy = new Map();
  for (const iv of input.interventions) {
    const list = interventionsBy.get(String(iv.studentId)) ?? [];
    list.push(iv); interventionsBy.set(String(iv.studentId), list);
  }

  const cases = [];
  const seen = new Set();
  const add = (category, studentId, subject) => {
    const id = `${category}|${studentId}|${subject?.subjectId ?? "-"}`;
    if (seen.has(id)) return;
    if (cases.filter((c) => c.category === category).length >= MAX_PER_CATEGORY) return;
    seen.add(id);
    const profile = profiles.get(studentId);
    const insights = subject
      ? profile.insights.filter((i) => i.subjectId === subject.subjectId)
      : profile.insights.filter((i) => i.scope === "student");
    cases.push({
      // Stable: derived from what the case is ABOUT, not from its position on
      // the sheet, so adding a category later cannot renumber a fixture.
      caseId: `${category}:${studentId}:${subject?.subjectId ?? "-"}`,
      priority: priorityOf(category),
      category,
      studentId,
      subjectId:   subject?.subjectId ?? null,
      subjectName: subject?.subjectName ?? null,
      observations: subject?.observations ?? profile.coverage.sequences,
      marks: subject ? subject.marks.map((m) => `${m.academicYear} T${m.term}${m.sequence ? ` S${m.sequence}` : ""}: ${m.mark}`) : [],
      metrics: subject ? {
        recentAverage: subject.recentAverage, priorAverage: subject.priorAverage,
        overallAverage: subject.overallAverage, delta: subject.delta,
        spread: subject.spread, consistency: subject.consistency,
        latestStep: subject.latestStep, belowPass: subject.belowPass, strongMarks: subject.strongMarks,
      } : null,
      classifications: insights.map((i) => ({ code: i.code, confidence: i.confidence })),
      guidance: (guidanceByStudent.get(studentId) ?? [])
        .filter((g) => !subject || g.subjectId === subject.subjectId)
        .map((g) => ({ type: g.type, rationaleCode: g.rationaleCode, priority: g.priority })),
      trajectory: subject ? subject.marks.map((m) => m.mark).join(" → ") : null,
      confidence: insights[0]?.confidence ?? (profile.coverage.sufficient ? "n/a" : "insufficient"),
      thresholdsInvolved: [...new Set(insights.flatMap((i) => THRESHOLDS_BEHIND[i.code] ?? []))].sort()
        .map((k) => ({ threshold: k, value: k === "passMark" || k === "strongMark" ? grading[k] : subjectInsights.THRESHOLDS[k] })),
      explanation: insights.map((i) => ({ code: i.code, evidence: i.evidence })),
      // Why this case is on the sheet, so a reviewer knows what to look at.
      selectedBecause: REVIEW_REASONS[category],
      // The structured form the teacher fills in. Every field starts null and
      // the allowed values are published in reviewCases.reviewForm; nothing
      // written here ever feeds back into the engine on its own.
      review: emptyReview(insights),
    });
  };

  const studentIds = [...profiles.keys()].sort();
  for (const studentId of studentIds) {
    const profile = profiles.get(studentId);
    const has = (code, conf) => (s) =>
      profile.insights.some((i) => i.subjectId === s.subjectId && i.code === code && (!conf || i.confidence === conf));
    const subjects = [...profile.subjects].sort((a, b) => a.subjectId.localeCompare(b.subjectId));

    for (const s of subjects) {
      if (has("consistency_strength")(s))           add("strong_and_stable", studentId, s);
      if (has("subject_strength", "emerging")(s))   add("emerging_strength", studentId, s);
      if (has("subject_strength", "emerging")(s) && s.observations === 2) add("strong_but_recent", studentId, s);
      if (has("persistent_underperformance")(s))    add("weak_and_persistent", studentId, s);
      if (has("sustained_improvement")(s) && s.recentAverage !== null && s.recentAverage < grading.passMark) {
        add("weak_but_improving", studentId, s);
      }
      if (has("academic_decline")(s))               add("declining", studentId, s);
      if (has("sudden_performance_change")(s))      add("sudden_change", studentId, s);
      if (s.consistency === "variable" && s.observations >= 3) add("volatile", studentId, s);
      if (s.consistency === "variable" &&
          (has("academic_decline")(s) || has("sustained_improvement")(s))) {
        add("trend_on_variable_subject", studentId, s);
      }
      if (s.observations === 1)                     add("insufficient_evidence", studentId, s);
      if (borderlineKeys.has(`${studentId}|${s.subjectId}`)) add("borderline_threshold", studentId, s);
    }
    const f = raw.get(studentId);
    if (f?.absent >= 2) add("absence_heavy", studentId, subjects[0] ?? null);
    if (f?.zeros  >= 2) add("zero_heavy",    studentId, subjects[0] ?? null);
    if (f?.ca > 0 && f?.tests > 0) add("mixed_assessment", studentId, subjects[0] ?? null);
    if (!profile.coverage.sufficient) add("insufficient_evidence", studentId, null);
    if (profile.insights.some((i) => i.code === "cross_subject_strength")) add("cross_subject_strength", studentId, null);
    for (const iv of interventionsBy.get(studentId) ?? []) {
      const s = subjects.find((x) => x.subjectId === iv.subjectId) ?? null;
      add("with_intervention", studentId, s);
    }
  }

  return {
    categories: REVIEW_CATEGORIES,
    reviewForm: REVIEW_FORM,
    priority: REVIEW_PRIORITY,
    cases: cases.sort((a, b) => a.priority - b.priority || a.studentId.localeCompare(b.studentId) ||
      String(a.subjectId ?? "").localeCompare(String(b.subjectId ?? ""))),
    coverage: Object.fromEntries(REVIEW_CATEGORIES.map((c) => [c, cases.filter((x) => x.category === c).length])),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE WHOLE REPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse one cohort. Pure and deterministic.
 *
 * @param {object} cohort  a cohort that validateCohort() accepted
 * @returns {object} machine-readable report
 */
const analyse = (cohort) => {
  const input = toEngineInput(cohort);
  const run = runEngine(cohort, engine, input);
  const baseline = classificationsOf(run.profiles);
  const evidence = evidenceReport(cohort, run);
  const distribution = distributionReport(run);
  const sensitivity = sensitivityReport(cohort, baseline, input);
  const flags = flagsReport(evidence, distribution, sensitivity);
  const reviewCases = reviewCasesReport(cohort, run, sensitivity);

  return {
    engineVersion: ENGINE_VERSION,
    provenance: cohort.provenance,
    evidence,
    distribution,
    sensitivity,
    flags,
    flagLimits: FLAG_LIMITS,
    reviewCases,
    // Per-pupil profiles, so the review sheet can be traced back to the exact
    // engine output without re-running anything.
    profiles: Object.fromEntries([...run.profiles.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. A HUMAN CAN READ IT
// ─────────────────────────────────────────────────────────────────────────────

const pct = (x) => `${Math.round(x * 100)}%`;
const table = (rows) => {
  if (!rows.length) return "_none_\n";
  const cols = Object.keys(rows[0]);
  const line = (r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`;
  return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n") + "\n";
};
const kv = (obj) => table(Object.entries(obj).map(([k, v]) => ({ key: k, value: typeof v === "object" ? JSON.stringify(v) : v })));

const renderMarkdown = (report) => {
  const e = report.evidence, d = report.distribution, s = report.sensitivity;
  const banner = report.provenance.kind === "synthetic"
    ? "> **SYNTHETIC DATA.** This cohort was constructed to exercise the calibration tooling. " +
      "Nothing below is evidence about real pupils and nothing below validates a threshold.\n"
    : "> Anonymised real cohort. Identifiers are opaque; no names, contacts or money are present.\n";

  return `# Intelligence calibration report

${banner}
Engine version: \`${report.engineVersion}\`. Provenance: \`${report.provenance.kind}\`${report.provenance.note ? ` — ${report.provenance.note}` : ""}.

## 1. What the data is

${kv({
  "pupils in file": e.students,
  "pupils with any published evidence": e.studentsWithEvidence,
  "pupils the engine can say something about": e.studentsSufficient,
  "pupils with insufficient evidence": e.studentsInsufficient,
  "subjects": e.subjects,
  "published occasions (CA excluded)": e.publishedOccasions,
  "marks counted": e.countedMarks,
})}
Row states in the file, and what the engine did with each:

${table([
  { state: "counted (a real mark)", rows: e.rowStates.counted, treatment: "used" },
  { state: "of which genuine zero", rows: e.rowStates.genuineZero, treatment: "used — the pupil earned it" },
  { state: "absent", rows: e.rowStates.absent, treatment: "excluded, not a zero" },
  { state: "exempt", rows: e.rowStates.exempt, treatment: "excluded, not a zero" },
  { state: "unentered (score null)", rows: e.rowStates.unentered, treatment: "excluded, no mark behind it" },
  { state: "inside a CA exam", rows: e.rowStates.inCa, treatment: "not an occasion of its own" },
  { state: "unpublished", rows: e.rowStates.unpublished, treatment: "never read" },
])}
Observations per pupil: ${JSON.stringify(e.observationsPerStudent)}

Temporal coverage — sequences: ${JSON.stringify(e.temporal.sequences)}

Grading context resolved for this school: ${JSON.stringify(e.grading)}

## 2. What the engine said

Pupils with enough evidence: **${d.insights.studentsWithEvidence}**. Of those — any risk: ${d.insights.studentsWithAnyRisk}, any strength: ${d.insights.studentsWithAnyStrength}, both: ${d.insights.studentsWithBoth}, neither: ${d.insights.studentsWithNone}.

Insights by code:

${kv(d.insights.byCode)}
By confidence: ${JSON.stringify(d.insights.byConfidence)}

Subject consistency (engine's own label): ${JSON.stringify(d.subjects.consistency)}

Subjects with a strong recent average: ${d.subjects.strongAverage}; of those not given a strength insight: ${d.subjects.strongButUnflagged}.

Guidance by rationale:

${kv(d.guidance.byRationale)}
Guidance by priority: ${JSON.stringify(d.guidance.byPriority)}

Interventions with a usable before/after: ${d.outcomes.withUsableComparison} of ${d.outcomes.interventions} — statuses ${JSON.stringify(d.outcomes.byStatus)}

## 3. Flags for a human to look at

These are review heuristics (limits in \`flagLimits\`). None of them changed anything.

${table(report.flags.map((f) => ({ flag: f.code, observed: typeof f.value === "number" && f.value <= 1 ? pct(f.value) : f.value, limit: typeof f.limit === "number" && f.limit <= 1 ? pct(f.limit) : f.limit, note: f.message })))}
## 4. Threshold sensitivity

Each threshold moved by ${s.deltas.join(", ")} on an isolated copy of the engine; production thresholds untouched. "gained/lost" are classifications that appeared or disappeared across the whole cohort.

${Object.entries(s.thresholds).map(([k, t]) => `**${k}** (current ${t.current})\n\n` + table(
  Object.entries(t.deltas).map(([dlt, r]) => ({
    delta: dlt, value: r.value,
    gained: r.skipped ? "—" : r.classificationsGained,
    lost: r.skipped ? "—" : r.classificationsLost,
    pupils: r.skipped ? r.skipped : r.studentsAffected,
  })))).join("\n")}
Borderline classifications (flip under any ±1): **${s.borderline.length}** of ${d.insights.total} (${pct(s.borderlineShare)}).

## 5. Cases for teacher review

${report.reviewCases.cases.length} cases across ${Object.values(report.reviewCases.coverage).filter((n) => n > 0).length} categories. Coverage: ${JSON.stringify(report.reviewCases.coverage)}

Each case in \`review-cases.json\` carries the marks, the metrics, the classification, the thresholds behind it and the engine's evidence, plus an empty structured \`review\` form (observed pattern, classification appropriate, evidence sufficient, guidance appropriate, reason, notes — and for trend cases, whether the temporal reading is reasonable and a possible explanation). Teacher verdicts are calibration evidence; they do not feed back into the engine automatically.

${table(report.reviewCases.cases.map((c) => ({
  case: c.caseId, pupil: c.studentId, subject: c.subjectName ?? "—",
  trajectory: c.trajectory ?? "—",
  says: c.classifications.map((x) => `${x.code} (${x.confidence})`).join(", ") || "—",
})))}
## 6. Decisions

Every threshold: see \`docs/25-intelligence-calibration.md\`. A distribution in this report is not by itself grounds to change a rule; teacher review of the cases above is the evidence a change would need.
`;
};

module.exports = {
  analyse,
  runEngine,
  renderMarkdown,
  classificationsOf,
  FLAG_LIMITS,
  SENSITIVITY_DELTAS,
  THRESHOLDS_BEHIND,
  REVIEW_CATEGORIES,
  REVIEW_FORM,
  REVIEW_REASONS,
  REVIEW_PRIORITY,
};
