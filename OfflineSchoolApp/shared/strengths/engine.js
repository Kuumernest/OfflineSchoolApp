// shared/strengths/engine.js
"use strict";

/**
 * From an academic profile to a strengths-and-exploration profile.
 *
 * ── Where this sits ───────────────────────────────────────────────────────
 *
 *   raw school evidence
 *     → shared/intelligence   (academic profile: per-subject metrics, insights)
 *     → this file             (evidence → strengths → exploration areas)
 *     → human guidance
 *
 * This layer consumes the academic profile and computes nothing about marks
 * that the academic engine did not already compute: averages, spread,
 * consistency, deltas, strong-mark counts and the pupil's sequence/term
 * ordering all arrive ready. What is new here is the reading ACROSS subjects
 * and ACROSS time — persistence, recurrence, cross-subject support — and the
 * mapping of that reading onto exploration dimensions and areas.
 *
 * ── The four rules that shape every profile ───────────────────────────────
 *
 *  1. No strength from one mark. A dimension needs at least
 *     THRESHOLDS.minObservations strong observations in a subject before that
 *     subject can support it, and every claim carries the evidence that made it.
 *  2. Persistence is a state, not a number. One assessment sequence at
 *     strength is EMERGING; two or more sequences RECURRING; two or more terms
 *     PERSISTENT. The sequence/term structure is the academic engine's own.
 *  3. Level and consistency are different facts. 18,18,18,18 and 20,12,19,11
 *     share an average and not a pattern; a variable series supports a
 *     dimension weakly whatever its mean.
 *  4. Evidence against counts. A decline, high variability or a recent fall
 *     below the strength threshold weakens or retires a strength; a subject
 *     that used to be strong and is not now reads as DECLINING, never as
 *     still strong. Missing evidence stays missing: INSUFFICIENT is an answer.
 *
 * ── What it never says ────────────────────────────────────────────────────
 *
 * Nothing here names a career, an occupation, a probability of success, a
 * personality, an intelligence quotient or a fixed talent. Interest and
 * exposure evidence (a club joined, an activity enjoyed) are carried as
 * separate signals and never counted as demonstrated ability. Teacher
 * observations feed confidence only under the one explicit, versioned rule in
 * confidenceFor(). The profile lists what it does not infer, every time.
 *
 * ── Pure and shared ───────────────────────────────────────────────────────
 *
 * No I/O, no identity: the input is an academic profile keyed by studentId
 * plus optional exploration-evidence rows, and the output carries the same
 * key and nothing more. Names are joined by the authorised service layer, as
 * for every other intelligence surface. The live route and the offline
 * reconstruction call this same function, and the consistency checker diffs
 * their outputs.
 */

const { DIMENSIONS, EXPLORATION_AREAS, dimensionsForSubject } = require("./taxonomy");
const { STATES, PERSISTENCE, CONFIDENCE } = require("./engineConstants");
const fusion = require("./fusion");
const learningIntegration = require("./learningIntegration");

/**
 * 1.1.0 — longitudinal fusion of authorised exploration evidence into strength
 * interpretation. The 1.0.0 reading is computed exactly as before and kept on
 * every dimension as baseState/baseConfidence; fusion.js then reads rated
 * exploration performance, observations, interest, reflection, exposure and
 * participation — each as what it is — and may move a reading one step on
 * independent events. See fusion.js for the rules and the recency windows.
 */
const STRENGTH_ENGINE_VERSION = "1.2.0";

/**
 * Every number the layer reasons with. Documented here because the brief
 * requires it and because each one is a calibration question in waiting.
 */
const THRESHOLDS = Object.freeze({
  // A subject supports a dimension only with this many observations at or
  // above the school's strength mark. Two, as the academic engine's minimum.
  minObservations: 2,
  // Persistence states, counted over distinct sequences and distinct terms in
  // which the mark reached the strength threshold.
  recurringSequences: 2,
  persistentTerms: 2,
  // Consistency, as the academic engine grades spread: high ≤ 2, moderate ≤ 4.
  consistentSpread: 2,
  variableSpread: 4,
  // A fall of this much between earlier and recent averages contradicts a
  // strength; a recent average below the strength mark retires it.
  declineDrop: 2,
  // Cross-subject support: this many subjects speaking to one dimension.
  crossSubjectMin: 2,
  // The one place teacher judgement touches confidence: at least this many
  // distinct teachers recording a performance observation in the dimension's
  // domain lifts an EMERGING dimension's confidence one notch. Never from
  // INSUFFICIENT, never to more than strong.
  teacherObservationsForSupport: 2,
  // A subject's share of a dimension below this weight is context, not support.
  minWeight: 0.5,
});


/** What this layer will not do, stated on every profile. */
const NOT_INFERRED = Object.freeze([
  "career", "occupation", "career_fit", "future_success", "personality", "intelligence_quotient",
  "mental_health", "learning_disability", "character", "motivation", "discipline", "leadership", "fixed_talent",
]);

const round1 = (x) => Math.round(x * 10) / 10;

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECT EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one subject's marks say, in the strength layer's terms.
 *
 * Reads the academic engine's per-subject metrics and marks; computes only
 * the persistence and direction reading on top.
 */
const subjectEvidence = (subject, grading) => {
  const strongMark = grading.strongMark;
  const marks = subject.marks ?? [];
  const strong = marks.filter((m) => m.mark !== null && m.mark >= strongMark);
  const seqKeys  = new Set(strong.map((m) => `${m.academicYear}|${m.term}|${m.sequence ?? "-"}`));
  const termKeys = new Set(strong.map((m) => `${m.academicYear}|${m.term}`));

  const persistence =
    strong.length < THRESHOLDS.minObservations ? PERSISTENCE.NONE
    : termKeys.size >= THRESHOLDS.persistentTerms ? PERSISTENCE.PERSISTENT
    : seqKeys.size >= THRESHOLDS.recurringSequences ? PERSISTENCE.RECURRING
    : PERSISTENCE.EMERGING;

  const recentStrong = subject.recentAverage !== null && subject.recentAverage !== undefined && subject.recentAverage >= strongMark;
  const declined = subject.delta !== null && subject.delta !== undefined && subject.delta <= -THRESHOLDS.declineDrop;
  const direction = declined ? "declining"
    : (subject.delta !== null && subject.delta !== undefined && subject.delta >= THRESHOLDS.declineDrop) ? "rising"
    : "sustaining";
  const consistency = subject.spread === null || subject.spread === undefined ? null
    : subject.spread <= THRESHOLDS.consistentSpread ? "consistent"
    : subject.spread <= THRESHOLDS.variableSpread ? "moderate" : "variable";

  // A subject that was strong and is not strong now is evidence AGAINST, and
  // is reported as such rather than quietly dropped.
  const wasStrong = strong.length >= THRESHOLDS.minObservations;
  const state =
    !wasStrong ? STATES.INSUFFICIENT
    : (!recentStrong || declined) ? STATES.DECLINING
    : persistence === PERSISTENCE.PERSISTENT && consistency !== "variable" ? STATES.ESTABLISHED
    : STATES.EMERGING;

  return {
    subjectId: subject.subjectId,
    subjectName: subject.subjectName ?? null,
    observations: subject.observations ?? marks.length,
    strongObservations: strong.length,
    sequencesAtStrength: seqKeys.size,
    termsAtStrength: termKeys.size,
    termsAtStrengthList: [...termKeys].sort().map((k) => k.replace("|", " T")),
    lastPeriod: marks.length ? `${marks[marks.length - 1].academicYear} T${marks[marks.length - 1].term}` : null,
    overallAverage: subject.overallAverage ?? null,
    recentAverage: subject.recentAverage ?? null,
    delta: subject.delta ?? null,
    spread: subject.spread ?? null,
    consistency,
    direction,
    persistence,
    state,
    strongMark,
    dimensions: dimensionsForSubject(subject.subjectName),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSIONS
// ─────────────────────────────────────────────────────────────────────────────

const rank = { [PERSISTENCE.NONE]: 0, [PERSISTENCE.EMERGING]: 1, [PERSISTENCE.RECURRING]: 2, [PERSISTENCE.PERSISTENT]: 3 };
const maxPersistence = (list) => list.reduce((best, p) => (rank[p] > rank[best] ? p : best), PERSISTENCE.NONE);

/**
 * Confidence that the school evidence supports a reading of this dimension.
 * Not talent probability, not success probability — the confidence of the
 * interpretation, from evidence quantity, persistence, consistency,
 * cross-subject support, data quality and (one rule) teacher observation.
 */
const confidenceFor = ({ supporting, persistence, consistent, contradicted, coverageSufficient, teacherObservers }) => {
  if (!coverageSufficient || supporting.length === 0) return CONFIDENCE.INSUFFICIENT;
  const crossSubject = supporting.length >= THRESHOLDS.crossSubjectMin;
  let level =
    persistence === PERSISTENCE.PERSISTENT && consistent && !contradicted ? CONFIDENCE.STRONG
    : persistence === PERSISTENCE.PERSISTENT && (crossSubject || consistent) && !contradicted ? CONFIDENCE.STRONG
    : rank[persistence] >= rank[PERSISTENCE.EMERGING] ? CONFIDENCE.EMERGING
    : CONFIDENCE.INSUFFICIENT;
  // The versioned teacher rule: enough distinct teachers recording a
  // PERFORMANCE observation in this domain lifts emerging to strong. Nothing
  // lifts insufficient; nothing goes past strong; interest never counts.
  if (level === CONFIDENCE.EMERGING && teacherObservers >= THRESHOLDS.teacherObservationsForSupport && !contradicted) {
    level = CONFIDENCE.STRONG;
  }
  return level;
};

/** Distinct teachers who recorded a performance observation in a set of areas. */
const observersFor = (explorationEvidence, dimension) =>
  new Set((explorationEvidence ?? [])
    .filter((e) => e.kind === "teacher_observation" && e.dimension === dimension && e.recordedBy)
    .map((e) => String(e.recordedBy))).size;

/**
 * One dimension, read across every subject that speaks to it.
 */
const dimensionReading = (dimension, subjects, { coverageSufficient, explorationEvidence }) => {
  const speaking = subjects.filter((s) => (s.dimensions[dimension] ?? 0) >= THRESHOLDS.minWeight);
  const atStrength  = speaking.filter((s) => s.state === STATES.ESTABLISHED || s.state === STATES.EMERGING);
  const declining   = speaking.filter((s) => s.state === STATES.DECLINING);
  const insufficient = speaking.filter((s) => s.state === STATES.INSUFFICIENT);

  // A subject that merely DRAWS on a dimension (weight below 1) cannot
  // establish it alone: English is about language, and only half about
  // interpretation. Secondary evidence supports a dimension when a primary
  // subject is there too, or when enough secondary subjects agree.
  const primary = atStrength.filter((s) => s.dimensions[dimension] >= 1);
  const supporting = primary.length > 0 || atStrength.length >= THRESHOLDS.crossSubjectMin ? atStrength : [];
  const secondaryOnly = atStrength.length > 0 && supporting.length === 0;

  const persistence = maxPersistence(supporting.map((s) => s.persistence));
  const consistent  = supporting.length > 0 && supporting.every((s) => s.consistency === "consistent" || s.consistency === "moderate");
  const variable    = supporting.some((s) => s.consistency === "variable");
  const contradicted = declining.length > 0 || variable;
  const teacherObservers = observersFor(explorationEvidence, dimension);

  const confidence = confidenceFor({ supporting, persistence, consistent, contradicted, coverageSufficient, teacherObservers });

  const state =
    supporting.length === 0 && declining.length > 0 ? STATES.DECLINING
    : supporting.length === 0 ? STATES.INSUFFICIENT
    : confidence === CONFIDENCE.STRONG ? STATES.ESTABLISHED
    : STATES.EMERGING;

  // Every claim traceable: the evidence list is the answer to "why did this
  // appear", subject by subject, with the direction of each.
  const evidence = [
    ...supporting.map((s) => ({
      evidenceType: "subject_performance", subjectId: s.subjectId, subjectName: s.subjectName, weight: s.dimensions[dimension],
      observations: s.observations, strongObservations: s.strongObservations, persistence: s.persistence,
      consistency: s.consistency, direction: s.direction, overallAverage: s.overallAverage, recentAverage: s.recentAverage,
      supports: true,
    })),
    ...declining.map((s) => ({
      evidenceType: "subject_decline", subjectId: s.subjectId, subjectName: s.subjectName, weight: s.dimensions[dimension],
      observations: s.observations, strongObservations: s.strongObservations, persistence: s.persistence,
      consistency: s.consistency, direction: s.direction, overallAverage: s.overallAverage, recentAverage: s.recentAverage, delta: s.delta,
      supports: false,
    })),
    ...(supporting.length >= THRESHOLDS.crossSubjectMin
      ? [{ evidenceType: "cross_subject_support", subjectIds: supporting.map((s) => s.subjectId), supports: true }] : []),
    ...(teacherObservers > 0
      ? [{ evidenceType: "teacher_observation", observers: teacherObservers,
           supports: teacherObservers >= THRESHOLDS.teacherObservationsForSupport }] : []),
  ];

  const limitations = [
    ...(variable ? ["variable_marks"] : []),
    ...(declining.length ? ["recent_decline"] : []),
    ...(insufficient.length && !supporting.length ? ["too_few_strong_observations"] : []),
    ...(secondaryOnly ? ["secondary_subject_only"] : []),
    ...(!coverageSufficient ? ["insufficient_coverage"] : []),
  ];

  return {
    dimension, state, confidence, persistence,
    supportingSubjects: supporting.map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName })),
    decliningSubjects:  declining.map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName })),
    crossSubject: supporting.length >= THRESHOLDS.crossSubjectMin,
    evidence, limitations,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPLORATION
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_RANK = { strong: 3, emerging: 2, limited: 1 };

/**
 * The areas the dimensions open. Ordered by evidence level only — strong,
 * emerging, limited — and the semantics are on the object, not implied by
 * position. There is no "best" area.
 */
const explorationAreas = (dimensionReadings) => {
  const byDim = new Map(dimensionReadings.map((d) => [d.dimension, d]));
  const present = (dim) => {
    const d = byDim.get(dim);
    return d && (d.state === STATES.ESTABLISHED || d.state === STATES.EMERGING);
  };
  const out = [];
  for (const area of EXPLORATION_AREAS) {
    const opening = area.openedBy.filter((set) => set.every(present));
    if (!opening.length) continue;
    const dims = [...new Set(opening.flat())].map((k) => byDim.get(k));
    const level = dims.every((d) => d.state === STATES.ESTABLISHED) ? "strong"
      : dims.some((d) => d.state === STATES.ESTABLISHED) ? "emerging" : "limited";
    out.push({
      area: area.code,
      evidenceLevel: level,
      openedBy: dims.map((d) => d.dimension),
      supportingSubjects: [...new Map(dims.flatMap((d) => d.supportingSubjects).map((s) => [s.subjectId, s])).values()],
      // "Why it appeared": the dimensions and their states, nothing else.
      because: dims.map((d) => ({ dimension: d.dimension, state: d.state, confidence: d.confidence, persistence: d.persistence })),
      waysToExplore: area.activities,
    });
  }
  return out.sort((a, b) => LEVEL_RANK[b.evidenceLevel] - LEVEL_RANK[a.evidenceLevel] || a.area.localeCompare(b.area));
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PROFILE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interest, exposure and reflection are carried as they are — signals about
 * what a pupil has tried or enjoyed — and never folded into a strength.
 */
const interestSignals = (explorationEvidence) => (explorationEvidence ?? [])
  .filter((e) => ["interest", "exposure", "student_reflection"].includes(e.kind))
  .map((e) => ({ kind: e.kind, dimension: e.dimension ?? null, area: e.area ?? null, activity: e.activity ?? null,
                 date: e.date ?? null, source: e.source ?? null, participation: e.participation ?? null, reflection: e.reflection ?? null }));

/**
 * Build the strengths profile for one pupil.
 *
 * @param {object} input
 * @param {object} input.academicProfile     shared/intelligence buildProfile output
 * @param {object[]} [input.explorationEvidence]  rows { kind, dimension, area, activity, date, recordedBy, source, ... }
 */
const buildStrengthProfile = ({ academicProfile, explorationEvidence = [], learningEvidence = null, subjectNames = {}, asOf = null }) => {
  const grading = academicProfile.engine;
  const coverageSufficient = Boolean(academicProfile.coverage?.sufficient);
  const subjects = (academicProfile.subjects ?? []).map((s) => subjectEvidence(s, grading));

  // asOf fixes the recency windows. Callers comparing two roads pass the same
  // value; left null it is the latest evidence date, so a profile is a pure
  // function of its inputs and never of the clock.
  const evidenceTimes = explorationEvidence.map((e) => new Date(e.date).getTime()).filter((n) => !Number.isNaN(n));
  const asOfDate = asOf ? new Date(asOf) : evidenceTimes.length ? new Date(Math.max(...evidenceTimes)) : null;
  const normalized = fusion.normalizeEvidence(explorationEvidence, asOfDate);

  const baseReadings = DIMENSIONS.map((d) => dimensionReading(d, subjects, { coverageSufficient, explorationEvidence }));
  const fusedReadings = baseReadings.map((r) => fusion.fuseDimension(r, normalized.items));

  // 1.2.0: the independent learning evidence — assignments, quizzes,
  // coursework, practicals — set beside each fused reading. It corroborates,
  // qualifies or contradicts; it never scores. The learning reading is the
  // pupil's own (shared/learningEvidence), built on the same asOf.
  const integrated = learningIntegration.integrateLearningEvidence({
    readings: fusedReadings, academicProfile, learningEvidence, explorationEvidence, subjectNames, asOf: asOfDate ? asOfDate.toISOString() : null,
  });
  const readings = integrated.readings;

  // Single-subject strengths: a subject at strength whose name maps to no
  // dimension still deserves to be named under its own name.
  const singleSubject = subjects
    .filter((s) => Object.keys(s.dimensions).length === 0 && (s.state === STATES.ESTABLISHED || s.state === STATES.EMERGING))
    .map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName, state: s.state, persistence: s.persistence,
                   consistency: s.consistency, direction: s.direction, strongObservations: s.strongObservations }));

  const strengths     = readings.filter((r) => r.state === STATES.ESTABLISHED);
  const emergingAreas = readings.filter((r) => r.state === STATES.EMERGING);
  const declining     = readings.filter((r) => r.state === STATES.DECLINING);

  const academicSignals = (academicProfile.insights ?? []).map((i) => ({
    code: i.code, scope: i.scope ?? null, subjectId: i.subjectId ?? null, subjectName: i.subjectName ?? null, confidence: i.confidence ?? null,
  }));

  const limitations = [
    ...(!coverageSufficient ? ["insufficient_academic_coverage"] : []),
    ...(subjects.length === 0 ? ["no_subject_evidence"] : []),
    ...(subjects.some((s) => Object.keys(s.dimensions).length === 0) ? ["subjects_outside_taxonomy"] : []),
    ...(declining.length ? ["declining_dimensions"] : []),
    ...(readings.some((r) => r.limitations.includes("variable_marks")) ? ["variable_marks"] : []),
    ...(!explorationEvidence.length ? ["no_exploration_evidence"] : []),
    ...(!learningEvidence ? ["no_learning_evidence"] : []),
    ...(integrated.integration.quality.includes("ACADEMIC_LEARNING_CONFLICT") ? ["academic_learning_conflict"] : []),
  ];

  // 1.1.0: a profile with exploration-established emerging areas is no longer
  // insufficient merely because the academic coverage is thin.
  const overallConfidence = strengths.length ? CONFIDENCE.STRONG
    : emergingAreas.length ? CONFIDENCE.EMERGING
    : CONFIDENCE.INSUFFICIENT;

  const coverage = fusion.coverageOf(normalized.items, academicProfile.coverage);
  const contradictions = readings.flatMap((r) => r.fused.conflicts.map((c) => ({ dimension: r.dimension, ...c })));
  const timeline = Object.fromEntries(readings
    .filter((r) => r.state !== STATES.INSUFFICIENT || r.fused.events > 0)
    .map((r) => [r.dimension, fusion.timelineFor(r, subjects, normalized.items)]));

  return {
    studentId: String(academicProfile.studentId),
    academicEngineVersion: academicProfile.engine?.version ?? null,
    strengthEngineVersion: STRENGTH_ENGINE_VERSION,
    learningIntegrationVersion: learningIntegration.LEARNING_INTEGRATION_VERSION,
    learningEvidenceVersion: learningEvidence?.learningEvidenceVersion ?? null,
    thresholds: THRESHOLDS,
    grading: { passMark: grading.passMark, strongMark: grading.strongMark, strongMarkBasis: grading.strongMarkBasis ?? null },
    evidenceCoverage: {
      sequences: academicProfile.coverage?.sequences ?? 0,
      subjects: subjects.length,
      subjectsInTaxonomy: subjects.filter((s) => Object.keys(s.dimensions).length > 0).length,
      sufficient: coverageSufficient,
      from: academicProfile.coverage?.from ?? null,
      to:   academicProfile.coverage?.to ?? null,
      explorationEvidence: explorationEvidence.length,
      learningEvents: learningEvidence?.counts?.events ?? 0,
    },
    confidence: overallConfidence,
    // "Strengths" means dimensions where the school evidence is consistent with
    // strength — established, with the evidence attached. Never a trait.
    strengths,
    emergingAreas,
    decliningAreas: declining,
    singleSubjectStrengths: singleSubject,
    explorationAreas: explorationAreas(readings),
    academicSignals,
    // Kept apart from strengths, always.
    interestSignals: interestSignals(explorationEvidence),
    subjects,
    limitations: [...limitations, ...(normalized.rejected.length ? ["rejected_evidence_rows"] : []), ...(coverage.stale ? ["stale_evidence_present"] : [])],
    notInferred: NOT_INFERRED,
    // 1.1.0: the fused evidence, its coverage, the conflicts and the timeline —
    // every contribution traceable to an evidenceId, an eventId and a source.
    fusion: {
      asOf: asOfDate ? asOfDate.toISOString() : null,
      windows: { recentDays: fusion.FUSION.recentDays, historicalDays: fusion.FUSION.historicalDays },
      thresholds: fusion.FUSION,
      authority: fusion.AUTHORITY,
      coverage, contradictions, timeline,
      evidence: normalized.items,
      rejected: normalized.rejected,
    },
    // 1.2.0: the integration — authority, independence, relationships per
    // dimension, conflicts kept standing, quality codes, what was unavailable.
    learningIntegration: integrated.integration,
  };
};

module.exports = {
  STRENGTH_ENGINE_VERSION,
  LEARNING_INTEGRATION_VERSION: learningIntegration.LEARNING_INTEGRATION_VERSION,
  LEARNING_EVIDENCE_AUTHORITY: learningIntegration.LEARNING_EVIDENCE_AUTHORITY,
  INTEGRATION: learningIntegration.INTEGRATION,
  RELATIONSHIPS: learningIntegration.RELATIONSHIPS,
  integrateLearningEvidence: learningIntegration.integrateLearningEvidence,
  FUSION: fusion.FUSION,
  SOURCES: fusion.SOURCES,
  AUTHORITY: fusion.AUTHORITY,
  recencyOf: fusion.recencyOf,
  normalizeEvidence: fusion.normalizeEvidence,
  fuseDimension: fusion.fuseDimension,
  compareProfiles: fusion.compareProfiles,
  THRESHOLDS,
  STATES,
  PERSISTENCE,
  CONFIDENCE,
  NOT_INFERRED,
  subjectEvidence,
  dimensionReading,
  confidenceFor,
  explorationAreas,
  buildStrengthProfile,
  round1,
};
