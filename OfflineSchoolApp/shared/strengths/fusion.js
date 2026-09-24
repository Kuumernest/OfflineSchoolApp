// shared/strengths/fusion.js
"use strict";

/**
 * Evidence fusion — Strength Engine 1.1.0.
 *
 * 1.0.0 read one stream: the academic profile, with teacher observations
 * touching confidence under one rule. 1.1.0 reads several — academic marks,
 * rated exploration performance, teacher observations, a pupil's interest and
 * reflection, exposure and participation — and keeps each one what it is.
 *
 * ── Authority: what each source can and cannot say ────────────────────────
 *
 *   ACADEMIC                 demonstrated school performance        → the baseline; the only source that
 *                                                                     can establish or retire a strength alone
 *   EXPLORATION_PERFORMANCE  demonstrated performance in a defined  → can move a reading ONE step, on
 *                            activity, rated by a teacher against     independent events, never past
 *                            that activity's criteria                 the baseline's reach
 *   TEACHER_OBSERVATION      contextual human observation           → the one 1.0.0 rule, unchanged: two
 *                                                                     distinct observers lift EMERGING to strong
 *   STUDENT_INTEREST         stated preference                      → an interest signal; never ability
 *   STUDENT_REFLECTION       self-reported experience               → coverage; never ability
 *   EXPOSURE                 encountered the domain                 → coverage; never ability
 *   PARTICIPATION            engaged with the activity              → coverage; never ability
 *
 * ── One event is one event ────────────────────────────────────────────────
 *
 * An exploration produces several rows — exposure, participation, interest,
 * an observation or two, a performance rating. They share an eventId (the
 * exploration's id) and count as ONE event: one performance direction, one
 * interest signal, the distinct observers. Two supporting events are two
 * activities, not one activity's four rows.
 *
 * ── Recency, said out loud ────────────────────────────────────────────────
 *
 *   RECENT      ≤ 120 days before asOf
 *   HISTORICAL  ≤ 365 days
 *   STALE       older — kept on the record, listed on the timeline, counted
 *               in nothing
 *
 * ── Transitions fusion may make, and may not ──────────────────────────────
 *
 *   INSUFFICIENT → EMERGING      ≥ 2 independent supporting events, none contradicting
 *   EMERGING     → ESTABLISHED   ≥ 2 independent supporting events, none contradicting
 *   ESTABLISHED  stays           contradicting events lower CONFIDENCE and are reported;
 *                                exploration alone never retires an academic strength
 *   DECLINING    stays           supporting events are reported as a conflict, not a rescue
 *   INSUFFICIENT → ESTABLISHED   never, from exploration alone
 *
 * One successful activity establishes nothing; one unsuccessful activity
 * disproves nothing. Interest, participation, exposure and reflection move no
 * state. Skipped, declined and abandoned activities produce no performance
 * event and weaken nothing.
 *
 * ── Pure ──────────────────────────────────────────────────────────────────
 *
 * Normalised rows in, structured facts out — every contribution traceable to
 * an evidenceId, an eventId, a source and a date. No identity, no I/O.
 */

const { STATES, CONFIDENCE } = require("./engineConstants");

const FUSION = Object.freeze({
  recentDays: 120,
  historicalDays: 365,
  eventsToLift: 2,
  eventsToContradict: 2,
  sourcesForBroadCoverage: 3,
});

const SOURCES = Object.freeze([
  "ACADEMIC", "EXPLORATION_PERFORMANCE", "TEACHER_OBSERVATION", "STUDENT_INTEREST",
  "STUDENT_REFLECTION", "EXPOSURE", "PARTICIPATION",
]);

const AUTHORITY = Object.freeze({
  ACADEMIC:                "demonstrated_school_performance",
  EXPLORATION_PERFORMANCE: "demonstrated_activity_performance",
  TEACHER_OBSERVATION:     "contextual_observation",
  STUDENT_INTEREST:        "stated_preference",
  STUDENT_REFLECTION:      "self_reported_experience",
  EXPOSURE:                "encountered_domain",
  PARTICIPATION:           "engaged_with_activity",
});

const KIND_TO_SOURCE = Object.freeze({
  performance:         "EXPLORATION_PERFORMANCE",
  teacher_observation: "TEACHER_OBSERVATION",
  interest:            "STUDENT_INTEREST",
  student_reflection:  "STUDENT_REFLECTION",
  exposure:            "EXPOSURE",
  participation:       "PARTICIPATION",
});

const RECENCY = Object.freeze(["RECENT", "HISTORICAL", "STALE"]);
const CONF_RANK = { insufficient: 0, emerging: 1, strong: 2 };
const CONF_BY_RANK = ["insufficient", "emerging", "strong"];
const STATE_RANK = { INSUFFICIENT: 0, DECLINING: 0, EMERGING: 1, ESTABLISHED: 2 };

const dayMs = 86400000;
const toDate = (v) => { const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

/** RECENT / HISTORICAL / STALE against asOf; an unreadable date is STALE, and says so. */
const recencyOf = (date, asOf) => {
  const d = toDate(date), a = toDate(asOf);
  if (!d || !a) return "STALE";
  const days = Math.floor((a.getTime() - d.getTime()) / dayMs);
  if (days <= FUSION.recentDays) return "RECENT";
  if (days <= FUSION.historicalDays) return "HISTORICAL";
  return "STALE";
};

/** The rated level a performance row carries, as the exploration layer wrote it ("strong: …"). */
const performanceLevelOf = (row) => {
  if (row.level && ["strong", "demonstrated", "partial", "limited"].includes(row.level)) return row.level;
  const m = /^(strong|demonstrated|partial|limited)\b/.exec(String(row.outcome ?? ""));
  return m ? m[1] : null;
};
const directionOf = (source, level) => {
  if (source !== "EXPLORATION_PERFORMANCE") return "neutral";
  if (level === "strong" || level === "demonstrated") return "supports";
  if (level === "limited") return "contradicts";
  return "neutral";
};

/**
 * Rows → fused evidence items. Duplicates (same evidenceId) are kept once;
 * a row without a kind the layer knows is reported under `rejected`.
 */
const normalizeEvidence = (rows = [], asOf = new Date()) => {
  const items = [];
  const rejected = [];
  const seen = new Set();
  for (const r of rows) {
    const sourceType = KIND_TO_SOURCE[r.kind];
    if (!sourceType) { rejected.push({ evidenceId: r._id ?? r.evidenceId ?? null, reason: `unknown kind ${r.kind}` }); continue; }
    const eventId = r.explorationId ?? r._id ?? r.evidenceId ?? null;
    const evidenceId = String(r._id ?? r.evidenceId ?? `${eventId}:${r.kind}:${r.recordedBy ?? r.source ?? ""}`);
    if (seen.has(evidenceId)) { rejected.push({ evidenceId, reason: "duplicate" }); continue; }
    seen.add(evidenceId);
    const level = sourceType === "EXPLORATION_PERFORMANCE" ? performanceLevelOf(r) : null;
    const date = toDate(r.date);
    items.push({
      evidenceId, sourceType, authority: AUTHORITY[sourceType],
      sourceId: String(r.recordedBy ?? r.source ?? ""),
      eventId: eventId ? String(eventId) : evidenceId,
      dimension: r.dimension ?? null, explorationArea: r.area ?? null, subjectId: null,
      observation: { kind: r.kind, level, participation: r.participation ?? null, reflection: r.reflection ?? null, outcome: r.outcome ?? null },
      direction: directionOf(sourceType, level),
      timestamp: date ? date.toISOString() : null,
      recency: recencyOf(date, asOf),
      provenance: { source: r.source ?? null, explorationId: r.explorationId ?? null, activityId: r.activityId ?? null, activityVersion: r.activityVersion ?? null },
    });
  }
  return { items, rejected };
};

/** Group a dimension's items into events: one performance direction, one interest signal, distinct observers. */
const eventsOf = (items) => {
  const byEvent = new Map();
  for (const it of items) {
    const e = byEvent.get(it.eventId) ?? { eventId: it.eventId, performance: null, direction: "none", observers: new Set(), interest: false, reflection: false, participation: false, exposure: false, latest: null, area: it.explorationArea };
    if (it.sourceType === "EXPLORATION_PERFORMANCE" && !e.performance) { e.performance = it.observation.level; e.direction = it.direction; }
    if (it.sourceType === "TEACHER_OBSERVATION" && it.sourceId) e.observers.add(it.sourceId);
    if (it.sourceType === "STUDENT_INTEREST") e.interest = true;
    if (it.sourceType === "STUDENT_REFLECTION") e.reflection = true;
    if (it.sourceType === "PARTICIPATION") e.participation = true;
    if (it.sourceType === "EXPOSURE") e.exposure = true;
    if (it.timestamp && (!e.latest || it.timestamp > e.latest)) e.latest = it.timestamp;
    byEvent.set(it.eventId, e);
  }
  return [...byEvent.values()].map((e) => ({ ...e, observers: [...e.observers].sort() })).sort((a, b) => String(a.latest).localeCompare(String(b.latest)) || a.eventId.localeCompare(b.eventId));
};

const stepConfidence = (c, delta) => CONF_BY_RANK[Math.max(0, Math.min(2, (CONF_RANK[c] ?? 0) + delta))];

/**
 * Fuse one dimension: the 1.0.0 reading plus the dimension's evidence items.
 * Returns the reading with `state`/`confidence` fused and a `fused` block that
 * says how and why; `baseState`/`baseConfidence` keep the 1.0.0 answer.
 */
const fuseDimension = (reading, items) => {
  const mine = items.filter((i) => i.dimension === reading.dimension);
  const live = mine.filter((i) => i.recency !== "STALE");
  const events = eventsOf(live);
  const supporting    = events.filter((e) => e.direction === "supports");
  const contradicting = events.filter((e) => e.direction === "contradicts");
  const neutral       = events.filter((e) => e.direction === "neutral" && e.performance);
  const observers     = new Set(live.filter((i) => i.sourceType === "TEACHER_OBSERVATION").map((i) => i.sourceId)).size;

  let state = reading.state, confidence = reading.confidence, stateSource = "academic";
  const reasons = [];
  const clean = contradicting.length === 0;

  if (reading.state === STATES.INSUFFICIENT && supporting.length >= FUSION.eventsToLift && clean) {
    state = STATES.EMERGING; confidence = CONFIDENCE.EMERGING; stateSource = "exploration";
    reasons.push(`EXPLORATION_SUPPORT:${supporting.length}`);
  } else if (reading.state === STATES.EMERGING && supporting.length >= FUSION.eventsToLift && clean) {
    state = STATES.ESTABLISHED; confidence = CONFIDENCE.STRONG; stateSource = "exploration";
    reasons.push(`EXPLORATION_SUPPORT:${supporting.length}`);
  } else if (reading.state === STATES.EMERGING && contradicting.length >= FUSION.eventsToContradict && contradicting.length > supporting.length) {
    confidence = stepConfidence(confidence, -1);
    reasons.push(`EXPLORATION_CONTRADICTION:${contradicting.length}`);
  } else if (reading.state === STATES.ESTABLISHED && contradicting.length >= FUSION.eventsToContradict && supporting.length === 0) {
    confidence = stepConfidence(confidence, -1);
    reasons.push(`EXPLORATION_CONTRADICTION:${contradicting.length}`);
  }
  if (reading.state === STATES.DECLINING && supporting.length > 0) reasons.push(`EXPLORATION_SUPPORT_DESPITE_DECLINE:${supporting.length}`);
  if (supporting.length > 0 && supporting.length < FUSION.eventsToLift && state === reading.state) reasons.push(`EXPLORATION_SUPPORT_BELOW_THRESHOLD:${supporting.length}`);
  if (reading.evidence?.some((e) => e.evidenceType === "teacher_observation" && e.supports)) reasons.push(`TEACHER_OBSERVERS:${observers}`);
  if (reading.persistence === "persistent") reasons.push("ACADEMIC_PERSISTENT");
  if (reading.state === STATES.DECLINING) reasons.push("ACADEMIC_DECLINE");

  // Interest × performance, from the most recent event that has both.
  const pairEvent = [...events].reverse().find((e) => e.performance);
  const interestEvents = events.filter((e) => e.interest).length;
  const pair = pairEvent ? { interest: pairEvent.interest ? "HIGH" : (interestEvents ? "MIXED" : "NOT_STATED"), performance: pairEvent.performance } : null;

  const conflicts = [];
  if ((reading.state === STATES.ESTABLISHED || reading.state === STATES.EMERGING) && contradicting.length) {
    conflicts.push({ kind: "ACADEMIC_VS_EXPLORATION", academic: reading.state, exploration: supporting.length ? "mixed" : "contradictory", supporting: supporting.length, contradicting: contradicting.length });
  }
  if (reading.state === STATES.DECLINING && supporting.length) {
    conflicts.push({ kind: "ACADEMIC_VS_EXPLORATION", academic: reading.state, exploration: "supportive", supporting: supporting.length, contradicting: contradicting.length });
  }
  if (supporting.length && contradicting.length && reading.state === STATES.INSUFFICIENT) {
    conflicts.push({ kind: "EXPLORATION_MIXED", academic: reading.state, exploration: "mixed", supporting: supporting.length, contradicting: contradicting.length });
  }
  if (observers > 0 && contradicting.length >= FUSION.eventsToContradict && supporting.length === 0) {
    conflicts.push({ kind: "OBSERVATION_VS_PERFORMANCE", teacherObservation: "supportive", exploration: "contradictory", observers, contradicting: contradicting.length });
  }
  if (pair && ((pair.interest === "HIGH" && pair.performance === "limited") || (pair.interest === "NOT_STATED" && interestEvents === 0 && (pair.performance === "strong" || pair.performance === "demonstrated") && events.some((e) => e.reflection)))) {
    conflicts.push({ kind: "INTEREST_VS_PERFORMANCE", interest: pair.interest, performance: pair.performance });
  }

  const recency = { recent: mine.filter((i) => i.recency === "RECENT").length, historical: mine.filter((i) => i.recency === "HISTORICAL").length, stale: mine.filter((i) => i.recency === "STALE").length };

  return {
    ...reading,
    baseState: reading.state, baseConfidence: reading.confidence,
    state, confidence,
    fused: {
      stateSource, reasons,
      events: events.length, supportingEvents: supporting.length, contradictingEvents: contradicting.length, neutralEvents: neutral.length,
      teacherObservers: observers, interestEvents,
      participationEvents: events.filter((e) => e.participation).length, exposureEvents: events.filter((e) => e.exposure).length,
      pair, recency, conflicts,
      evidenceIds: mine.map((i) => i.evidenceId),
    },
  };
};

/** How much evidence there is, by source — never how capable the pupil is. */
const coverageOf = (items, academicCoverage) => {
  const live = items.filter((i) => i.recency !== "STALE");
  const count = (s) => live.filter((i) => i.sourceType === s).length;
  const events = new Set(live.filter((i) => i.provenance.explorationId).map((i) => i.eventId)).size;
  const sources = [academicCoverage?.sufficient ? "ACADEMIC" : null, ...SOURCES.slice(1).filter((s) => count(s) > 0)].filter(Boolean);
  const overall = sources.length === 0 ? "none" : sources.length === 1 ? "thin" : sources.length < FUSION.sourcesForBroadCoverage ? "moderate" : "broad";
  return {
    academic: { sequences: academicCoverage?.sequences ?? 0, subjects: academicCoverage?.subjects ?? 0, sufficient: Boolean(academicCoverage?.sufficient) },
    exploration: { events, performanceRows: count("EXPLORATION_PERFORMANCE") },
    teacherObservation: { rows: count("TEACHER_OBSERVATION"), observers: new Set(live.filter((i) => i.sourceType === "TEACHER_OBSERVATION").map((i) => i.sourceId)).size },
    interest: count("STUDENT_INTEREST"), reflection: count("STUDENT_REFLECTION"), exposure: count("EXPOSURE"), participation: count("PARTICIPATION"),
    stale: items.length - live.length,
    sources, overall,
  };
};

/** The timeline for one dimension: academic terms at strength, then events by date, then the reading. */
const timelineFor = (fusedReading, subjects, items) => {
  const rows = [];
  for (const s of subjects.filter((x) => (x.dimensions?.[fusedReading.dimension] ?? 0) >= 0.5)) {
    for (const t of s.termsAtStrengthList ?? []) rows.push({ when: t, source: "ACADEMIC", subjectId: s.subjectId, subjectName: s.subjectName ?? null, reading: "at_strength" });
    if (s.state === "DECLINING") rows.push({ when: s.lastPeriod ?? null, source: "ACADEMIC", subjectId: s.subjectId, subjectName: s.subjectName ?? null, reading: "below_strength" });
  }
  for (const e of eventsOf(items.filter((i) => i.dimension === fusedReading.dimension))) {
    if (e.performance) rows.push({ when: e.latest, source: "EXPLORATION_PERFORMANCE", eventId: e.eventId, area: e.area, reading: e.performance, direction: e.direction });
    if (e.observers.length) rows.push({ when: e.latest, source: "TEACHER_OBSERVATION", eventId: e.eventId, observers: e.observers.length, reading: "observed" });
    if (e.interest) rows.push({ when: e.latest, source: "STUDENT_INTEREST", eventId: e.eventId, reading: "interest" });
  }
  rows.sort((a, b) => String(a.when ?? "").localeCompare(String(b.when ?? "")));
  rows.push({ when: null, source: "PROFILE", reading: fusedReading.state, confidence: fusedReading.confidence, stateSource: fusedReading.fused.stateSource });
  return rows;
};

/**
 * 1.2.0: what changed in the learning evidence beside a dimension, as reason
 * codes about EVIDENCE — corroboration added, contradiction added, coverage
 * changed, evidence gone stale, evidence retracted, context changed. Never
 * "ability increased": the codes name what arrived or left, not the child.
 * A reading without the block (a 1.1.0 snapshot) yields no codes.
 */
const learningChangeOf = (b, a) => {
  const pb = b?.learningEvidence, pa = a?.learningEvidence;
  const cb = b?.corroboration, ca = a?.corroboration;
  const xb = b?.context, xa = a?.context;
  if (!pb || !pa) return { previous: pb?.relationship ?? null, current: pa?.relationship ?? null, reasons: [] };
  const reasons = [];
  if ((ca?.supportingEvents?.length ?? 0) > (cb?.supportingEvents?.length ?? 0)) reasons.push("LEARNING_EVIDENCE_CORROBORATION_ADDED");
  if ((ca?.contradictingEvents?.length ?? 0) > (cb?.contradictingEvents?.length ?? 0)) reasons.push("LEARNING_EVIDENCE_CONTRADICTION_ADDED");
  if (JSON.stringify(pa.sourceFamilies) !== JSON.stringify(pb.sourceFamilies)) reasons.push("LEARNING_EVIDENCE_COVERAGE_CHANGED");
  if (pa.staleEventCount > pb.staleEventCount) reasons.push("LEARNING_EVIDENCE_BECAME_STALE");
  if (pa.independentEventCount + pa.staleEventCount < pb.independentEventCount + pb.staleEventCount) reasons.push("LEARNING_EVIDENCE_RETRACTED");
  // Context is attendance and submission; a source that newly exists is a coverage change, counted above.
  if (Boolean(xa?.attendanceLimited) !== Boolean(xb?.attendanceLimited) || (xa?.attendancePattern ?? null) !== (xb?.attendancePattern ?? null)) reasons.push("LEARNING_EVIDENCE_CONTEXT_CHANGED");
  return { previous: pb.relationship, current: pa.relationship, reasons };
};

/**
 * What changed between two readings of the same pupil (profiles or snapshot
 * readings). Structured facts and reason codes; no improvement score.
 */
const compareProfiles = (previous, current) => {
  const dims = (p) => new Map([...(p?.strengths ?? []), ...(p?.emergingAreas ?? []), ...(p?.decliningAreas ?? [])].map((d) => [d.dimension, d]));
  const before = dims(previous), after = dims(current);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out = { newStrengths: [], strengthened: [], unchanged: [], weakened: [], newEmerging: [], declining: [], newContradictions: [], coverage: null, dimensions: [] };
  for (const d of names) {
    const b = before.get(d), a = after.get(d);
    const bs = b?.state ?? "INSUFFICIENT", as = a?.state ?? "INSUFFICIENT";
    const bc = b?.confidence ?? "insufficient", ac = a?.confidence ?? "insufficient";
    const entry = { dimension: d, previous: { state: bs, confidence: bc }, current: { state: as, confidence: ac }, reasons: a?.fused?.reasons ?? [],
                    learningEvidence: learningChangeOf(b, a) };
    if (as === "ESTABLISHED" && bs !== "ESTABLISHED") out.newStrengths.push(entry);
    else if (as === "EMERGING" && bs === "INSUFFICIENT") out.newEmerging.push(entry);
    else if (as === "DECLINING" && bs !== "DECLINING") out.declining.push(entry);
    else if (as === bs && CONF_RANK[ac] > CONF_RANK[bc]) out.strengthened.push(entry);
    else if ((STATE_RANK[as] < STATE_RANK[bs]) || (as === bs && CONF_RANK[ac] < CONF_RANK[bc])) out.weakened.push(entry);
    else out.unchanged.push(entry);
    out.dimensions.push(entry);
  }
  const prevConf = new Set((previous?.fusion?.contradictions ?? []).map((c) => `${c.dimension}|${c.kind}`));
  out.newContradictions = (current?.fusion?.contradictions ?? []).filter((c) => !prevConf.has(`${c.dimension}|${c.kind}`));
  out.learningEvidence = out.dimensions.filter((x) => x.learningEvidence?.reasons.length).map((x) => ({ dimension: x.dimension, ...x.learningEvidence }));
  const pc = previous?.fusion?.coverage, cc = current?.fusion?.coverage;
  out.coverage = { previous: pc?.overall ?? null, current: cc?.overall ?? null, explorationEvents: { previous: pc?.exploration?.events ?? 0, current: cc?.exploration?.events ?? 0 }, teacherObservers: { previous: pc?.teacherObservation?.observers ?? 0, current: cc?.teacherObservation?.observers ?? 0 } };
  return out;
};

module.exports = {
  FUSION, SOURCES, AUTHORITY, KIND_TO_SOURCE, RECENCY,
  recencyOf, performanceLevelOf, normalizeEvidence, eventsOf, fuseDimension, coverageOf, timelineFor, compareProfiles, learningChangeOf,
};
