// shared/strengths/learningIntegration.js
"use strict";

/**
 * Multi-modal integration — LEARNING_INTEGRATION_VERSION 1.0.0, the layer
 * that makes the Strength Reading 1.2.0.
 *
 * ── The question this layer asks ──────────────────────────────────────────
 *
 * Given the 1.1.0 reading of a dimension (the academic baseline with
 * exploration and observation already fused in): what INDEPENDENT learning
 * evidence — assignments, quizzes, coursework, practicals — supports,
 * qualifies or contradicts it? Not: what is the pupil's combined score.
 * There is no score. The output is a relationship, its counts, its sources,
 * its limits and its reasons, per dimension.
 *
 * ── Authority ─────────────────────────────────────────────────────────────
 *
 *   ACADEMIC                baseline — anchors state, persistence, direction,
 *                           consistency; never retired or rescued by anything below
 *   PRACTICAL, COURSEWORK,
 *   QUIZ, ASSIGNMENT        supporting capability — ≥ 2 independent, clean,
 *                           non-stale events may move a reading ONE step above
 *                           its academic baseline (INSUFFICIENT → EMERGING or
 *                           EMERGING → ESTABLISHED), and only when exploration
 *                           has not already taken that step; never further
 *   EXPLORATION,
 *   TEACHER_OBSERVATION     fused by 1.1.0 — reported here as sources, not recounted
 *   INTEREST, REFLECTION,
 *   EXPOSURE, PARTICIPATION,
 *   ATTENDANCE, SUBMISSION  context only — never ability. Irregular attendance
 *                           may mark thin evidence CONTEXT_LIMITED; nothing more.
 *
 * ── Independence ──────────────────────────────────────────────────────────
 *
 * One learning event is one event whatever it carries — a mark, a submission
 * time and a completion are three observations of the same event. Quiz
 * retries share the quiz's independence key and collapse to the latest
 * attempt. Formal exam marks are the academic engine's own input and are
 * NOT counted again here: that would be the same assessment twice. The same
 * holds for a practical entered as an exam score — in this application the
 * academic baseline already reads it, so it is reported as baseline evidence
 * and not recounted; a practical recorded outside the results (none today)
 * would count under PRACTICAL. Continuous assessment (CA) is skipped by the
 * academic engine and is therefore independent.
 *
 * ── Relationships ─────────────────────────────────────────────────────────
 *
 *   CORROBORATED             ≥ 2 independent supporting events, none contradicting
 *   PARTIALLY_CORROBORATED   1 supporting, or support beside contradiction
 *   CONTRADICTED             ≥ 2 contradicting events, more than supporting
 *   UNSUPPORTED              no independent learning evidence speaks to the dimension
 *   INSUFFICIENT_EVIDENCE    evidence exists but is stale or only neutral
 *   CONTEXT_LIMITED          thin evidence beside irregular or declining attendance
 *
 * Each describes the evidence, not the child. Pure: no I/O, no clock, no
 * identity, no randomness; the same inputs give the same output.
 */

const { STATES, CONFIDENCE } = require("./engineConstants");
const { dimensionsForSubject } = require("./taxonomy");

const LEARNING_INTEGRATION_VERSION = "1.0.0";

const LEARNING_EVIDENCE_AUTHORITY = Object.freeze({
  academic:           "baseline",
  practical:          "supporting_capability",
  coursework:         "supporting_capability",
  quiz:               "supporting_capability",
  assignment:         "supporting_capability",
  exploration:        "supporting_capability",
  teacherObservation: "supporting_observation",
  interest:           "context_only",
  reflection:         "context_only",
  exposure:           "context_only",
  participation:      "context_only",
  attendance:         "context_only",
  submission:         "context_only",
});

const FAMILIES = Object.freeze([
  "ACADEMIC", "ASSIGNMENT", "QUIZ", "COURSEWORK", "PRACTICAL", "EXPLORATION", "TEACHER_OBSERVATION",
  "INTEREST", "REFLECTION", "EXPOSURE", "PARTICIPATION", "ATTENDANCE", "SUBMISSION",
]);

/** Learning families that may corroborate, by the learning layer's family name. Formal marks are the baseline and are absent on purpose. */
const SUPPORTING_LEARNING_FAMILIES = Object.freeze({ homework: "ASSIGNMENT", quiz: "QUIZ", continuous: "COURSEWORK", practical: "PRACTICAL" });

const RELATIONSHIPS = Object.freeze(["CORROBORATED", "PARTIALLY_CORROBORATED", "UNSUPPORTED", "CONTRADICTED", "CONTEXT_LIMITED", "INSUFFICIENT_EVIDENCE"]);

const QUALITY_CODES = Object.freeze([
  "NO_INDEPENDENT_LEARNING_EVENTS", "DUPLICATE_EVENT_COLLAPSED", "LEARNING_EVIDENCE_STALE", "LEARNING_EVIDENCE_PARTIAL",
  "SOURCE_MODALITY_UNAVAILABLE", "ACADEMIC_LEARNING_CONFLICT", "CONTEXT_INCOMPLETE",
]);

/** Change reason codes about evidence — what arrived, left or aged. None names ability. */
const CHANGE_REASONS = Object.freeze([
  "LEARNING_EVIDENCE_CORROBORATION_ADDED", "LEARNING_EVIDENCE_CONTRADICTION_ADDED", "LEARNING_EVIDENCE_COVERAGE_CHANGED",
  "LEARNING_EVIDENCE_BECAME_STALE", "LEARNING_EVIDENCE_RETRACTED", "LEARNING_EVIDENCE_CONTEXT_CHANGED",
]);

const INTEGRATION = Object.freeze({
  eventsToCorroborate: 2,   // independent, clean, non-stale — the same bar 1.1.0 sets for exploration
  eventsToContradict:  2,
  minWeight:           0.5, // a subject speaks to a dimension at this taxonomy weight or more
});

const MODALITIES = Object.freeze(["ASSIGNMENT", "QUIZ", "COURSEWORK", "PRACTICAL", "EXPLORATION", "TEACHER_OBSERVATION", "INTEREST", "REFLECTION", "ATTENDANCE"]);

const CONF_RANK = { insufficient: 0, emerging: 1, strong: 2 };
const CONF_BY_RANK = ["insufficient", "emerging", "strong"];
const stepConfidence = (c, delta) => CONF_BY_RANK[Math.max(0, Math.min(2, (CONF_RANK[c] ?? 0) + delta))];

const perfOf = (e) => (e.observations ?? []).find((o) => o.kind === "performance" && o.normalizedValue !== null && o.normalizedValue !== undefined && (o.state === "VALID" || o.state === "ZERO"));

/**
 * Learning events → independent items that speak to dimensions.
 *
 * Direction is read against the school's own marks: at or above the strong
 * mark supports, below the pass mark contradicts, between is neutral — the
 * same bar the academic engine uses, on the same 0–1 scale.
 */
const inBaseline = (e) => e.family === "formal" || (e.family === "practical" && e.provenance?.sourceModel === "StudentScore");

const learningItems = ({ learningEvidence, subjectNames, grading }) => {
  const strongAt = (grading?.strongMark ?? 14) / 20, passAt = (grading?.passMark ?? 10) / 20;
  const byKey = new Map();
  let collapsed = 0, baseline = 0;
  for (const e of learningEvidence?.events ?? []) {
    if (!perfOf(e)) continue;
    if (inBaseline(e)) { baseline += 1; continue; }   // already in the academic reading: never counted twice
    if (!SUPPORTING_LEARNING_FAMILIES[e.family]) continue;
    const key = e.independentKey ?? e.learningEventId;
    if (byKey.has(key)) collapsed += 1;          // a retry of the same quiz: one event, the latest attempt speaks
    byKey.set(key, e);
  }
  const items = [...byKey.entries()].map(([key, e]) => {
    const value = perfOf(e).normalizedValue;
    const name = subjectNames?.[e.subjectId] ?? null;
    return {
      eventId: e.learningEventId, independenceKey: key, sourceKind: SUPPORTING_LEARNING_FAMILIES[e.family],
      subjectId: e.subjectId ?? null, subjectName: name, dimensions: name ? dimensionsForSubject(name) : {},
      observedAt: e.occurredAt ?? null, recency: e.recency, normalizedValue: value,
      direction: value >= strongAt ? "supports" : value < passAt ? "contradicts" : "neutral",
      sourceVersion: e.provenance?.sourceVersion ?? null, sourceModel: e.provenance?.sourceModel ?? null,
    };
  }).sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  return { items, collapsed, baseline };
};

/** Which modalities the pupil's records contain at all. Absent means "unavailable", never "weak". */
const modalitiesPresent = ({ learningEvidence, readings, explorationEvidence }) => {
  const evs = learningEvidence?.events ?? [];
  const rows = explorationEvidence ?? [];
  return {
    ASSIGNMENT: evs.some((e) => e.family === "homework"),
    QUIZ: evs.some((e) => e.family === "quiz"),
    COURSEWORK: evs.some((e) => e.family === "continuous"),
    PRACTICAL: evs.some((e) => e.family === "practical"),
    EXPLORATION: (readings ?? []).some((r) => (r.fused?.events ?? 0) > 0) || rows.some((r) => r.kind === "performance"),
    TEACHER_OBSERVATION: (readings ?? []).some((r) => (r.fused?.teacherObservers ?? 0) > 0) || rows.some((r) => r.kind === "teacher_observation"),
    INTEREST: rows.some((r) => r.kind === "interest"),
    REFLECTION: rows.some((r) => r.kind === "student_reflection"),
    ATTENDANCE: evs.some((e) => e.sourceType === "ATTENDANCE"),
  };
};

const familiesOf = (list) => [...new Set(list.map((i) => i.sourceKind))].sort();
const summarise = (i) => ({ eventId: i.eventId, independenceKey: i.independenceKey, sourceKind: i.sourceKind, subjectId: i.subjectId, subjectName: i.subjectName, observedAt: i.observedAt, recency: i.recency, normalizedValue: i.normalizedValue });

/** The academic baseline's direction and consistency, read from the subjects that support the reading. */
const academicOf = (reading) => {
  const perf = (reading.evidence ?? []).filter((e) => e.evidenceType === "subject_performance");
  const decline = (reading.evidence ?? []).filter((e) => e.evidenceType === "subject_decline");
  const one = (list, key) => { const v = [...new Set(list.map((e) => e[key]).filter(Boolean))]; return v.length === 0 ? null : v.length === 1 ? v[0] : "mixed"; };
  return {
    state: reading.baseState ?? reading.state, confidence: reading.baseConfidence ?? reading.confidence, persistence: reading.persistence,
    direction: one(perf.length ? perf : decline, "direction"), consistency: one(perf.length ? perf : decline, "consistency"),
  };
};

/** Integrate one dimension: the 1.1.0 reading plus the independent learning items that speak to it. */
const integrateDimension = (reading, items, { attendancePattern, present }) => {
  const mine = items.filter((i) => (i.dimensions[reading.dimension] ?? 0) >= INTEGRATION.minWeight);
  const live = mine.filter((i) => i.recency !== "STALE");
  const supporting = live.filter((i) => i.direction === "supports");
  const contradicting = live.filter((i) => i.direction === "contradicts");
  const neutral = live.filter((i) => i.direction === "neutral");
  const stale = mine.length - live.length;
  const S = supporting.length, C = contradicting.length;
  const attendanceLimited = attendancePattern === "ATTENDANCE_IRREGULAR" || attendancePattern === "ATTENDANCE_DECLINING";
  const missingModalities = MODALITIES.filter((m) => !present[m]);

  let relationship;
  if (S === 0 && C === 0) relationship = neutral.length || stale ? "INSUFFICIENT_EVIDENCE" : "UNSUPPORTED";
  else if (C >= INTEGRATION.eventsToContradict && C > S) relationship = "CONTRADICTED";
  else if (S >= INTEGRATION.eventsToCorroborate && C === 0) relationship = "CORROBORATED";
  else relationship = "PARTIALLY_CORROBORATED";
  if (attendanceLimited && live.length < INTEGRATION.eventsToCorroborate && relationship !== "CONTRADICTED") relationship = "CONTEXT_LIMITED";

  // The 1.2.0 state. The academic baseline is never retired and a decline is
  // never rescued. Clean corroboration lifts one step above the BASELINE —
  // and only if exploration (1.1.0) has not already taken that step, so no
  // reading rises two steps in one integration however many modalities agree.
  const academic = academicOf(reading);
  let state = reading.state, confidence = reading.confidence, stateSource = reading.fused?.stateSource ?? "academic";
  const reasons = [...(reading.fused?.reasons ?? [])];
  const clean = C === 0 && S >= INTEGRATION.eventsToCorroborate;
  const unlifted = reading.state === academic.state;
  if (clean && unlifted && reading.state === STATES.INSUFFICIENT) { state = STATES.EMERGING; confidence = CONFIDENCE.EMERGING; stateSource = "learning_evidence"; }
  else if (clean && unlifted && reading.state === STATES.EMERGING) { state = STATES.ESTABLISHED; confidence = CONFIDENCE.STRONG; stateSource = "learning_evidence"; }
  else if (clean && !unlifted) reasons.push("LEARNING_SUPPORT_AFTER_EXPLORATION_LIFT");
  else if (relationship === "CONTRADICTED" && (reading.state === STATES.ESTABLISHED || reading.state === STATES.EMERGING)) confidence = stepConfidence(confidence, -1);

  if (S) reasons.push(`LEARNING_SUPPORT:${S}`);
  if (C) reasons.push(`LEARNING_CONTRADICTION:${C}`);
  if (S === 1 && C === 0) reasons.push("LEARNING_SUPPORT_BELOW_THRESHOLD:1");
  if (S || C) reasons.push(`LEARNING_FAMILIES:${familiesOf([...supporting, ...contradicting]).join("+")}`);
  if (stale) reasons.push(`LEARNING_STALE:${stale}`);
  if (attendanceLimited) reasons.push("ATTENDANCE_LIMITED_COVERAGE");
  for (const m of missingModalities) reasons.push(`MODALITY_UNAVAILABLE:${m}`);

  const conflict = relationship === "CONTRADICTED" || (S > 0 && C > 0) || (C > 0 && (academic.state === STATES.ESTABLISHED || academic.state === STATES.EMERGING));
  const quality = [
    ...(live.length === 0 ? ["NO_INDEPENDENT_LEARNING_EVENTS"] : []),
    ...(stale ? ["LEARNING_EVIDENCE_STALE"] : []),
    ...(relationship === "PARTIALLY_CORROBORATED" ? ["LEARNING_EVIDENCE_PARTIAL"] : []),
    ...(missingModalities.length ? ["SOURCE_MODALITY_UNAVAILABLE"] : []),
    ...(conflict ? ["ACADEMIC_LEARNING_CONFLICT"] : []),
    ...(attendanceLimited ? ["CONTEXT_INCOMPLETE"] : []),
  ];
  const contradictions = conflict
    ? [{ kind: "ACADEMIC_VS_LEARNING_EVIDENCE", academic: academic.state, supporting: S, contradicting: C, families: familiesOf(contradicting),
         possibleExplanations: ["different_task_type", "different_period", "limited_evidence", "assessment_context", "missing_context"] }]
    : [];

  return {
    ...reading,
    // Stage 11 baseline fields, kept: what the academic engine alone said.
    baseState: academic.state, baseConfidence: academic.confidence, baseDirection: academic.direction, basePersistence: academic.persistence, baseConsistency: academic.consistency,
    fusedState: reading.state, fusedConfidence: reading.confidence,
    state, confidence,
    academic,
    learningEvidence: {
      relationship, independentEventCount: live.length, sourceFamilies: familiesOf(live),
      currentEventCount: live.filter((i) => i.recency === "RECENT").length, historicalEventCount: live.filter((i) => i.recency === "HISTORICAL").length, staleEventCount: stale,
      subjects: [...new Set(mine.map((i) => i.subjectId).filter(Boolean))].sort(),
    },
    corroboration: {
      supportingSources: familiesOf(supporting), supportingEvents: supporting.map(summarise),
      contradictingSources: familiesOf(contradicting), contradictingEvents: contradicting.map(summarise), neutralEvents: neutral.length,
      explorationSupportingEvents: reading.fused?.supportingEvents ?? 0, explorationContradictingEvents: reading.fused?.contradictingEvents ?? 0, teacherObservers: reading.fused?.teacherObservers ?? 0,
    },
    context: { attendanceLimited, attendancePattern: attendancePattern ?? null, submissionContextAvailable: Boolean(present.ASSIGNMENT), missingModalities },
    interpretation: { state, confidence, stateSource, relationship, reasonCodes: reasons, quality, contradictions },
  };
};

/**
 * Integrate a whole profile.
 *
 * @param {object}   input
 * @param {object[]} input.readings             the ten 1.1.0 dimension readings
 * @param {object}   input.academicProfile      shared/intelligence profile (grading and subject names)
 * @param {object}   [input.learningEvidence]   shared/learningEvidence reading, built on the same asOf
 * @param {object[]} [input.explorationEvidence] the exploration rows (for modality presence only; 1.1.0 already fused them)
 * @param {object}   [input.subjectNames]       { subjectId: subjectName } for subjects without an academic entry
 * @param {string}   [input.asOf]               ISO date, echoed; recency was already fixed by the two layers beneath
 */
const integrateLearningEvidence = ({ readings, academicProfile = null, learningEvidence = null, explorationEvidence = [], subjectNames = {}, asOf = null }) => {
  const names = { ...Object.fromEntries((academicProfile?.subjects ?? []).filter((s) => s.subjectName).map((s) => [String(s.subjectId), s.subjectName])), ...subjectNames };
  const grading = academicProfile?.engine ?? academicProfile?.grading ?? null;
  const { items, collapsed, baseline } = learningItems({ learningEvidence, subjectNames: names, grading });
  const attendancePattern = learningEvidence?.patterns?.attendance?.overall?.pattern ?? null;
  const present = modalitiesPresent({ learningEvidence, readings, explorationEvidence });
  const integrated = readings.map((r) => integrateDimension(r, items, { attendancePattern, present }));
  const quality = [...new Set([...integrated.flatMap((r) => r.interpretation.quality), ...(collapsed ? ["DUPLICATE_EVENT_COLLAPSED"] : [])])].sort();
  return {
    readings: integrated,
    integration: {
      version: LEARNING_INTEGRATION_VERSION,
      learningEvidenceVersion: learningEvidence?.learningEvidenceVersion ?? null,
      asOf,
      authority: LEARNING_EVIDENCE_AUTHORITY,
      thresholds: INTEGRATION,
      available: Boolean(learningEvidence),
      independentLearningItems: items.length,
      duplicateEventsCollapsed: collapsed,
      baselineEventsNotRecounted: baseline,
      items: items.map((i) => ({ ...summarise(i), sourceVersion: i.sourceVersion, dimensions: i.dimensions, direction: i.direction })),
      modalities: present,
      missingModalities: MODALITIES.filter((m) => !present[m]),
      attendancePattern,
      relationships: Object.fromEntries(integrated.filter((r) => r.state !== STATES.INSUFFICIENT || r.learningEvidence.independentEventCount > 0).map((r) => [r.dimension, r.learningEvidence.relationship])),
      contradictions: integrated.flatMap((r) => r.interpretation.contradictions.map((c) => ({ dimension: r.dimension, ...c }))),
      quality,
    },
  };
};

module.exports = {
  LEARNING_INTEGRATION_VERSION, LEARNING_EVIDENCE_AUTHORITY, FAMILIES, SUPPORTING_LEARNING_FAMILIES, RELATIONSHIPS, QUALITY_CODES, CHANGE_REASONS, INTEGRATION, MODALITIES,
  inBaseline, learningItems, modalitiesPresent, academicOf, integrateDimension, integrateLearningEvidence,
};
