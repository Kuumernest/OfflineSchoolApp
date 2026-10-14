// OfflineSchoolApp/shared/intelligence/subjectInsights.js
"use strict";

/**
 * What a pupil's own marks say about each subject, over time.
 *
 * ── Why this is in shared/ ────────────────────────────────────────────────
 *
 * Because three places need the answer and there must only be one of it.
 *
 * The server answers it over HTTP. The desktop answers it from its local mirror
 * when there is no connection. Both are looking at the same child, and the
 * first time the two implementations disagreed — about whether an absence is a
 * zero, about where a series splits, about what counts as strong — a teacher
 * would be told one thing by a screen and another by the report card, with
 * nothing to say which was right.
 *
 * shared/gradeScale.js is next door for exactly that reason: four copies of the
 * grading table had drifted, and whether a pupil on 11.5 got "C" or "C+"
 * depended on which code path graded them. This moved here before the same
 * thing could happen to it.
 *
 * ── Pure ──────────────────────────────────────────────────────────────────
 *
 * No database, no models, no Express, no clock, no network, no authorisation.
 * Every function takes plain serialisable data and returns plain serialisable
 * data. It does not know who is asking, which school they belong to, or whether
 * they are allowed to see the pupil — those are application questions and they
 * stay with the application. The backend keeps the loading and the guards; this
 * keeps the arithmetic.
 *
 * ── Every number is read, not recomputed ──────────────────────────────────
 *
 * `normalizedMark` on ResultSummary.subjectBreakdown is the subject mark on the
 * /20 scale, written by results.service after grading.service graded it and
 * after sequenceAssessment blended CA into it. That is the authoritative mark
 * and it is what this module averages. Nothing here re-derives a grade, a
 * sequence average, a term average or a position.
 *
 * ── What it refuses to claim ──────────────────────────────────────────────
 *
 * A career, a domain, an aptitude, or anything about a pupil's future. It
 * reports subjects and the evidence behind each statement, and it declines to
 * say anything at all where there is not enough record to say it.
 */

const { DEFAULT_PASS_MARK, DEFAULT_GRADES } = require("../gradeScale");
const { UNSEQUENCED } = require("./academicOrder");

/**
 * The engine's version, reported with every profile.
 *
 * Not decoration: these are thresholds, not laws, and a school that asks why a
 * subject stopped being flagged between one term and the next deserves to be
 * able to tell "the pupil changed" from "the rules changed".
 */
const ENGINE_VERSION = "1.0.0";

/**
 * The thresholds, in one visible place — the same discipline the watch list
 * keeps, and for the same reason: a teacher who disagrees with a statement
 * should be able to find the number that produced it.
 *
 * Marks are on the /20 scale throughout, because that is the scale
 * `normalizedMark` is already on and the scale a Cameroonian report card is
 * read on.
 */
const THRESHOLDS = {
  /** Below this many usable marks in a subject, nothing at all is claimed. */
  minObservations: 2,
  /** At or above this many, a pattern that holds throughout may be called strong. */
  establishedObservations: 3,

  /**
   * Where a mark stops being average and starts being a strength.
   *
   * ── This is an intelligence heuristic, not a grading rule ────────────────
   *
   * Nothing in this platform defines "strong". GradingConfig defines BANDS —
   * labels, ranges, remarks — and a pass mark, and a school may rename every
   * band; none of it says which band a school considers a strength. Inventing
   * a "strength band" in GradingConfig to answer that would be the intelligence
   * layer dictating grading, which is exactly backwards.
   *
   * So the engine owns the number. It changes no grade, decides no pass and
   * appears on no report card; it decides only whether this module says the
   * word "strength" out loud, and it is reported in every response so a school
   * can see what produced the statement.
   *
   * 14/20 is the floor of the "Good" band on the shipped Cameroon scale. It is
   * a starting value chosen the way the watch list's thresholds were, not a
   * validated one.
   *
   * ── What the school's bands DO decide ────────────────────────────────────
   *
   * Where that heuristic lands. gradingContextFor below snaps it up to the
   * nearest floor in the school's OWN band table, so a statement of strength
   * always coincides with a band boundary the report card already prints. On
   * the default scale the nearest floor at or above 14 is 14 itself, so a
   * school that has configured nothing gets exactly this number.
   */
  strongMark: 14,

  /** Overridden per school — see gradingContextFor. 10/20 by default. */
  passMark: DEFAULT_PASS_MARK,

  /** Recent half minus earlier half, in marks out of 20. */
  declineDrop:      2,
  improvementGain:  2,

  /** One sequence to the next, in marks out of 20. */
  suddenDrop: 4,

  /** Highest mark minus lowest, across the whole series. */
  consistencySpread: 2,
  moderateSpread:    4,

  /** Persistent underperformance needs a record, not a bad afternoon. */
  minUnderperformanceObservations: 3,

  /** How many strong subjects before they are worth naming together. */
  crossSubjectStrengths: 3,
};

const round1 = (n) => Math.round(n * 10) / 10;
const mean   = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

/**
 * How much evidence stands behind a statement.
 *
 * The vocabulary is the brief's: a pattern seen once is not a pattern, a
 * pattern seen twice is worth mentioning and not worth acting on alone, and a
 * pattern that holds across three or more occasions is worth a conversation.
 *
 * `unanimous` means the pattern is present across the WHOLE record rather than
 * only in the part that produced the headline number — a subject strong in
 * every sequence, a decline where no sequence went up. Without it a series that
 * went 18, 8, 18 could call itself consistently strong on its average alone.
 */
const confidenceFrom = ({ observations, unanimous }) => {
  if (observations < THRESHOLDS.minObservations) return "insufficient";
  if (observations >= THRESHOLDS.establishedObservations && unanimous) return "strong";
  return "emerging";
};

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — MEASUREMENT
//
// Pure functions over marks. No database, no models, no wording. Everything
// below this line is testable by calling it with an array of numbers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One pupil's history → one ordered series of marks per subject.
 *
 * ── What counts as a mark ─────────────────────────────────────────────────
 *
 * Absent and exempt rows are skipped. A pupil who did not sit a paper did not
 * score nothing in it, which is the same distinction shared/caAssessment.js
 * makes about a missing CA, and averaging an absence as a zero would invent a
 * collapse in a subject that never happened.
 *
 * A null `score` is skipped as well, and that is not a second guess at the same
 * thing — it is the authoritative record's own way of saying there is no mark
 * behind this row. grading.service writes `score: null` on exactly the absent
 * and exempt rows, and a number on every graded one, INCLUDING a genuine zero.
 * So `score === null` and `normalizedMark === 0` together mean "no mark", while
 * `score === 0` means a mark of zero, which the pupil earned and which stays.
 *
 * It is tested rather than left to the flags because the flags were not always
 * stored: ResultSummary's breakdown schema carried no `isExempt` path until
 * recently, so every exempt row written before that reads as isExempt:
 * undefined with a zero beside it. Reading the score keeps those rows right
 * without anybody having to backfill them.
 *
 * @param {object[]} history summaries from academicHistory, oldest first
 * @returns {Map<string, object>} subjectId → { subjectId, subjectName, points[] }
 */
const seriesFrom = (history) => {
  const series = new Map();

  for (const summary of history) {
    for (const row of summary.subjectBreakdown ?? []) {
      if (row.isAbsent || row.isExempt) continue;
      if (row.score === null) continue;
      const mark = Number(row.normalizedMark);
      if (!Number.isFinite(mark)) continue;

      const id = String(row.subjectId);
      let entry = series.get(id);
      if (!entry) {
        entry = { subjectId: id, subjectName: row.subjectName ?? null, points: [] };
        series.set(id, entry);
      }
      // The most recent spelling of the name wins: a subject renamed mid-year
      // should read as its current name everywhere.
      if (row.subjectName) entry.subjectName = row.subjectName;

      entry.points.push({
        occurrence:  summary.occurrence,
        mark:        round1(mark),
        grade:       row.grade ?? null,
        isPassing:   row.isPassing ?? null,
        coefficient: row.coefficient ?? null,
        // Carried because they are already there and they are the one place the
        // record distinguishes coursework from the paper. Not yet analysed.
        caMark:      row.caMark ?? null,
        testMark:    row.testMark ?? null,
      });
    }
  }

  return series;
};

/**
 * The measurements for one subject's series.
 *
 * ── The recent/earlier split ──────────────────────────────────────────────
 *
 * Halves, not a fixed window. The record may be two sequences long or twelve,
 * and a fixed "last three" either has nothing to compare against early on or
 * throws away most of the year later.
 *
 * An odd-length series drops its MIDDLE mark from both halves rather than
 * lending it to one of them. Letting the middle count as recent is what makes
 * 18, 9, 18 read as a decline: the pupil finished exactly where they started,
 * and the only thing falling is an average with the dip inside it. Dropping the
 * pivot compares like with like — the start of the record against the end of it.
 */
const metricsFor = ({ subjectId, subjectName, points }, grading) => {
  const marks = points.map((p) => p.mark);
  const n     = marks.length;

  const half   = Math.floor(n / 2);
  // With fewer than two marks there is no split to make. The whole series is
  // "recent" and there is nothing earlier to compare it against, which is what
  // a null priorAverage says downstream.
  const recent = half ? marks.slice(n - half) : marks;
  const prior  = marks.slice(0, half);

  const steps = marks.slice(1).map((m, i) => round1(m - marks[i]));
  const spread = n ? round1(Math.max(...marks) - Math.min(...marks)) : 0;

  const recentAverage = recent.length ? round1(mean(recent)) : null;
  const priorAverage  = prior.length  ? round1(mean(prior))  : null;

  return {
    subjectId,
    subjectName,
    observations: n,
    marks: points.map((p) => ({
      academicYear: p.occurrence.academicYear,
      term:         p.occurrence.term,
      sequence:     p.occurrence.sequence === UNSEQUENCED
                      ? null : p.occurrence.sequence,
      mark:         p.mark,
      grade:        p.grade,
      isPassing:    p.isPassing,
    })),
    scale: 20,
    overallAverage: n ? round1(mean(marks)) : null,
    recentAverage,
    priorAverage,
    // null rather than 0 when there is nothing to compare against: no
    // comparison and no change are different facts.
    delta: priorAverage === null ? null : round1(recentAverage - priorAverage),
    latest:  n ? marks[n - 1] : null,
    best:    n ? Math.max(...marks) : null,
    lowest:  n ? Math.min(...marks) : null,
    spread,
    largestDrop: steps.length ? round1(-Math.min(...steps, 0)) : 0,
    largestGain: steps.length ? round1(Math.max(...steps, 0))  : 0,
    // The most recent movement, which is a different question from the biggest
    // one anywhere in the record — see sudden_performance_change below.
    latestStep: steps.length ? steps[steps.length - 1] : null,
    consistency: n < THRESHOLDS.minObservations ? null
      : spread <= THRESHOLDS.consistencySpread ? "high"
      : spread <= THRESHOLDS.moderateSpread    ? "moderate"
      : "variable",
    belowPass:   marks.filter((m) => m <  grading.passMark).length,
    atOrAbovePass: marks.filter((m) => m >= grading.passMark).length,
    strongMarks: marks.filter((m) => m >= grading.strongMark).length,
    coefficient: points[n - 1]?.coefficient ?? null,
    from: points[0]?.occurrence ?? null,
    to:   points[n - 1]?.occurrence ?? null,
    steps,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — INSIGHTS
//
// Measurements become statements, each carrying the numbers that produced it.
// The codes are the brief's controlled vocabulary; the wording belongs to the
// client, in the reader's language, exactly as the watch list already works.
// ─────────────────────────────────────────────────────────────────────────────

const ev = (metric, value, scale) =>
  scale === undefined ? { metric, value } : { metric, value, scale };

/** The evidence every subject statement carries, whatever it says. */
const baseEvidence = (m) => [
  ev("observations", m.observations),
  ev("recent_average", m.recentAverage, 20),
  ...(m.priorAverage === null ? [] : [ev("previous_average", m.priorAverage, 20)]),
  ev("overall_average", m.overallAverage, 20),
  ev("latest_mark", m.latest, 20),
  ...(m.consistency ? [ev("consistency", m.consistency)] : []),
];

const insight = (type, code, m, confidence, extra = []) => ({
  type,
  code,
  scope: "subject",
  subjectId:   m.subjectId,
  subjectName: m.subjectName,
  confidence,
  evidence: [...baseEvidence(m), ...extra],
  window: { from: m.from, to: m.to },
});

/**
 * Every statement one subject's measurements support.
 *
 * A subject can produce more than one — a subject can be both consistently
 * strong and recently improving, and collapsing that into a single verdict
 * would throw away the more useful half.
 */
const insightsFor = (m, grading) => {
  const out = [];
  if (m.observations < THRESHOLDS.minObservations) return out;

  // ── Risk ────────────────────────────────────────────────────────────────

  // Sustained decline: the recent half is materially below the earlier half.
  // Unanimous when no sequence in the record went up — a slide rather than one
  // bad paper pulling an average down.
  if (m.delta !== null && m.delta <= -THRESHOLDS.declineDrop) {
    out.push(insight("risk", "academic_decline", m,
      confidenceFrom({
        observations: m.observations,
        unanimous: m.steps.every((s) => s <= 0),
      }),
      [ev("change", m.delta, 20)]));
  }

  // The MOST RECENT step down, large enough to be an event rather than
  // variation — not the biggest drop anywhere in the record. A pupil who fell
  // nine marks and climbed back has not suddenly changed; they had a bad
  // sequence, and a panel that still says "sudden change" a term later is a
  // panel a staffroom learns to ignore. A long steady slide is not this either:
  // that is academic_decline, and saying both would be saying it twice.
  //
  // Unanimous when the fall is bigger than every movement that came before it,
  // which is what makes it a departure from a baseline rather than a volatile
  // subject behaving as it always has.
  const latestDrop = m.latestStep !== null && m.latestStep < 0 ? round1(-m.latestStep) : 0;
  if (latestDrop >= THRESHOLDS.suddenDrop) {
    const earlier = m.steps.slice(0, -1).map((s) => Math.abs(s));
    out.push(insight("risk", "sudden_performance_change", m,
      confidenceFrom({
        observations: m.observations,
        unanimous: earlier.every((s) => s < latestDrop),
      }),
      [ev("latest_change", m.latestStep, 20),
       ev("largest_single_drop", m.largestDrop, 20)]));
  }

  // Persistent underperformance. Deliberately the strictest rule here: three
  // marks minimum, a majority of them below the pass mark, and the recent half
  // still below it. One poor result cannot reach this, and neither can a pupil
  // who has already recovered.
  const majorityBelow = m.belowPass > m.observations / 2;
  if (
    m.observations >= THRESHOLDS.minUnderperformanceObservations &&
    majorityBelow &&
    m.recentAverage < grading.passMark
  ) {
    out.push(insight("risk", "persistent_underperformance", m,
      confidenceFrom({
        observations: m.observations,
        unanimous: m.belowPass === m.observations,
      }),
      [ev("marks_below_pass", m.belowPass), ev("pass_mark", grading.passMark, 20)]));
  }

  // ── Strength ────────────────────────────────────────────────────────────

  // Sustained strong performance: the recent half sits in the "Good" band or
  // above. Unanimous when every mark on record does.
  if (m.recentAverage >= grading.strongMark) {
    out.push(insight("strength", "subject_strength", m,
      confidenceFrom({
        observations: m.observations,
        unanimous: m.strongMarks === m.observations,
      }),
      [ev("strong_mark_threshold", grading.strongMark, 20),
       ev("marks_at_or_above_threshold", m.strongMarks)]));
  }

  // Meaningful positive progression. Unanimous when no sequence went down.
  if (m.delta !== null && m.delta >= THRESHOLDS.improvementGain) {
    out.push(insight("strength", "sustained_improvement", m,
      confidenceFrom({
        observations: m.observations,
        unanimous: m.steps.every((s) => s >= 0),
      }),
      [ev("change", m.delta, 20), ev("largest_single_gain", m.largestGain, 20)]));
  }

  // Strong AND steady, which is a different claim from strong: a pupil who
  // scores 18, 9, 17 averages well and is not dependable in the subject.
  // Needs the full three occasions — stability cannot be seen in two.
  if (
    m.observations >= THRESHOLDS.establishedObservations &&
    m.overallAverage >= grading.strongMark &&
    m.spread <= THRESHOLDS.consistencySpread
  ) {
    out.push(insight("strength", "consistency_strength", m,
      confidenceFrom({
        observations: m.observations,
        unanimous: m.strongMarks === m.observations,
      }),
      [ev("spread", m.spread, 20)]));
  }

  return out;
};

/**
 * Subjects that are strong together.
 *
 * This is a COUNT and a LIST, and nothing more. It deliberately does not name a
 * domain, a cluster or a field of study: subject names are free text per school
 * and there is no taxonomy in this platform to map them through, so any label
 * put on this group would be invented rather than observed. A later stage adds
 * a configurable subject profile; until it exists, naming the subjects is the
 * honest form of the statement.
 */
const crossSubjectStrength = (subjectInsights) => {
  const strong = subjectInsights.filter((i) => i.code === "subject_strength");
  if (strong.length < THRESHOLDS.crossSubjectStrengths) return null;

  const established = strong.filter((i) => i.confidence === "strong").length;

  return {
    type:  "strength",
    code:  "cross_subject_strength",
    scope: "student",
    subjects: strong.map((i) => ({ subjectId: i.subjectId, subjectName: i.subjectName })),
    confidence: established >= THRESHOLDS.crossSubjectStrengths ? "strong" : "emerging",
    evidence: [
      ev("strong_subjects", strong.length),
      ev("strong_subjects_with_established_evidence", established),
    ],
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ASSEMBLY
//
// Still pure. The caller loads the documents; these turn them into a profile.
// ─────────────────────────────────────────────────────────────────────────────

/** The scale ResultSummary.subjectBreakdown.normalizedMark is on. */
const SCALE = 20;

/**
 * The school's own grading rules, as far as they say anything this engine needs.
 *
 * Takes the two DOCUMENTS rather than fetching them, so the backend can hand
 * over what Mongoose loaded and the desktop can hand over what its mirror holds.
 * Both are optional: a school that has configured neither gets the shipped
 * defaults, and the answer says so in `passMarkSource` and `strongMarkBasis`.
 *
 * ── The pass mark ─────────────────────────────────────────────────────────
 *
 * Two documents hold one and they are not interchangeable.
 * GradingConfig.passMark is the PER-MARK rule — exam.routes.js grades every
 * mark a teacher enters with `markOutOf20 >= gradingConfig.passMark` — and
 * AcademicStructure.passMark is the promotion-side one. This module compares
 * subject marks, so the per-mark rule is the right one and the structure is the
 * fallback. Both ship as 10/20.
 *
 * ── Where the strength threshold lands ────────────────────────────────────
 *
 * The engine's heuristic (THRESHOLDS.strongMark) is snapped UP to the nearest
 * floor in the school's own band table. A school whose bands step at 15 never
 * hears a 14 called a strength, because on that school's report card 14 is in a
 * band the school itself considers middling.
 *
 * Two guards, both reported rather than hidden: the floor must sit ABOVE the
 * pass mark, or a barely-passing mark would be called a strength; and it must
 * sit inside the /20 scale, because a school may store bands on a /100 scale
 * and a 40 snapped out of one would be a threshold no subject mark could reach.
 *
 * @param {object}  input
 * @param {object} [input.gradingConfig]      a GradingConfig document
 * @param {object} [input.academicStructure]  an AcademicStructure document
 */
const resolveGradingContext = ({ gradingConfig, academicStructure } = {}) => {
  const usable = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
  const [passMark, passMarkSource] =
      usable(gradingConfig?.passMark)     ? [Number(gradingConfig.passMark), "gradingConfig"]
    : usable(academicStructure?.passMark) ? [Number(academicStructure.passMark), "academicStructure"]
    : [THRESHOLDS.passMark, "default"];

  const configured = Array.isArray(gradingConfig?.grades) && gradingConfig.grades.length > 0;
  const bands = configured ? gradingConfig.grades : DEFAULT_GRADES;

  // Both spellings, because the stored config uses minMark and the shipped
  // table is read through the same helper findBand tolerates both for.
  const floors = bands
    .map((band) => ({ band, floor: Number(band.minMark ?? band.min) }))
    .filter((entry) => Number.isFinite(entry.floor))
    .sort((a, b) => a.floor - b.floor);

  const snapped = floors.find((entry) =>
    entry.floor >= THRESHOLDS.strongMark &&
    entry.floor >  passMark &&
    entry.floor <= SCALE
  );

  return {
    scale: SCALE,
    passMark,
    passMarkSource,
    strongMark: snapped ? snapped.floor : Math.max(THRESHOLDS.strongMark, passMark),
    strongBand: snapped?.band?.grade ?? null,
    // Three answers, not two. "The school's bands say 14" and "nobody has
    // configured bands and the shipped table says 14" are the same number and
    // different facts, and only one of them is a decision a school took.
    strongMarkBasis: !snapped ? "engine_heuristic"
      : configured ? "school_grade_band"
      : "default_grade_band",
    heuristicStrongMark: THRESHOLDS.strongMark,
  };
};

/**
 * One pupil's ordered history → their profile.
 *
 * @param {object}   input
 * @param {string}   input.studentId
 * @param {object[]} input.history  ordered rows from academicOrder, oldest first
 * @param {object}   input.grading  from resolveGradingContext
 */
const buildProfile = ({ studentId, history = [], grading }) => {
  const subjects = [...seriesFrom(history).values()]
    .map((series) => metricsFor(series, grading))
    // Strongest first, so a reader meets the pupil at their best; a subject
    // with no average sorts last rather than winning on a null comparison.
    .sort((a, b) => (b.overallAverage ?? -1) - (a.overallAverage ?? -1));

  const subjectInsights = subjects.flatMap((m) => insightsFor(m, grading));
  const cross = crossSubjectStrength(subjectInsights);

  return {
    studentId: String(studentId),
    // Every threshold that produced a statement, reported with the statements.
    engine: {
      version: ENGINE_VERSION,
      ...grading,
      minObservations: THRESHOLDS.minObservations,
    },
    coverage: {
      sequences: history.length,
      subjects:  subjects.length,
      // Said out loud rather than left to be inferred from an empty list:
      // "we have not seen enough of this child yet" is itself the finding for
      // most pupils in a school's first term on the system.
      sufficient: subjects.some((s) => s.observations >= THRESHOLDS.minObservations),
      from: history[0]?.occurrence ?? null,
      to:   history[history.length - 1]?.occurrence ?? null,
    },
    subjects,
    insights: [...subjectInsights, ...(cross ? [cross] : [])],
  };
};

/**
 * Many pupils at once, from one already-loaded history map.
 *
 * Bulk by construction: the caller does one query for the class and this does
 * no I/O at all, which is what keeps a class of forty costing what one costs.
 *
 * @param {object} input
 * @param {Map<string, object[]>} input.historyByStudent
 * @param {string[]} input.studentIds
 * @param {object}   input.grading
 * @returns {Map<string, object>} studentId → profile
 */
const analyseHistories = ({ historyByStudent, studentIds, grading }) => {
  const profiles = new Map();
  for (const raw of studentIds ?? []) {
    const studentId = String(raw);
    profiles.set(studentId, buildProfile({
      studentId,
      history: historyByStudent?.get?.(studentId) ?? [],
      grading,
    }));
  }
  return profiles;
};

module.exports = {
  // Layer 1 — measurement
  seriesFrom,
  metricsFor,
  confidenceFrom,
  // Layer 2 — insights
  insightsFor,
  crossSubjectStrength,
  // Assembly
  resolveGradingContext,
  buildProfile,
  analyseHistories,
  // Constants
  THRESHOLDS,
  ENGINE_VERSION,
  SCALE,
};
