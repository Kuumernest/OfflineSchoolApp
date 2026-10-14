// shared/learningEvidence/index.js
"use strict";

/**
 * The Learning Evidence layer — one entry point.
 *
 *   school records → normalise (events) → patterns → quality → the
 *   integration boundary → (informational, in 1.0.0) the existing intelligence
 *
 * Pure. Reduced rows in, structured facts out; the clock is an input.
 *
 * Learning evidence describes observed educational activity and performance.
 * It does not by itself establish personality, motivation, intelligence,
 * psychological traits, or career suitability.
 */

const { LEARNING_EVIDENCE_VERSION } = require("./version");
const T        = require("./taxonomy");
const events   = require("./events");
const patterns = require("./patterns");
const quality  = require("./quality");

/**
 * The integration boundary: every pattern the layer produced, classified as
 * a signal, with the engines it is currently authorised to influence. In
 * 1.0.0 the answer is none — the signals are informational, and the strength,
 * exploration and guidance engines read exactly what they read before.
 */
const learningEvidenceForIntelligence = (result) => {
  const signals = [];
  const auth = (kind) => ({ authorizedFor: Object.entries(T.INTEGRATION).filter(([, list]) => list.includes(kind)).map(([engine]) => engine) });
  for (const [k, s] of Object.entries(result.patterns.bySubject)) {
    const subjectId = s.subjectId;
    void k;
    for (const fam of ["formal", "continuous", "quiz"]) {
      if (s[fam].pattern !== "INSUFFICIENT_EVIDENCE") signals.push({ signal: "ACHIEVEMENT_SIGNAL", subjectId, family: fam, code: s[fam].pattern, events: s[fam].independentEvents, ...auth("ACHIEVEMENT_SIGNAL") });
    }
    if (s.practical.pattern !== "INSUFFICIENT_EVIDENCE") signals.push({ signal: "SKILL_SIGNAL", subjectId, family: "practical", code: s.practical.pattern, events: s.practical.independentEvents, ...auth("SKILL_SIGNAL") });
    if (s.homework.pattern !== "INSUFFICIENT_EVIDENCE") signals.push({ signal: "ENGAGEMENT_SIGNAL", subjectId, family: "homework", code: s.homework.pattern, events: s.homework.assigned, ...auth("ENGAGEMENT_SIGNAL") });
    if (s.homework.submission.pattern !== "INSUFFICIENT_EVIDENCE") signals.push({ signal: "ENGAGEMENT_SIGNAL", subjectId, family: "submission", code: s.homework.submission.pattern, ...auth("ENGAGEMENT_SIGNAL") });
    if (s.persistence.currentCompletionStreak >= T.THRESHOLDS.minEventsForPattern) signals.push({ signal: "PERSISTENCE_SIGNAL", subjectId, code: "COMPLETION_STREAK", events: s.persistence.currentCompletionStreak, ...auth("PERSISTENCE_SIGNAL") });
  }
  const att = result.patterns.attendance.overall;
  if (att.pattern !== "INSUFFICIENT_ATTENDANCE_DATA") signals.push({ signal: "ENGAGEMENT_SIGNAL", subjectId: null, family: "attendance", code: att.pattern, events: att.marked, ...auth("ENGAGEMENT_SIGNAL") });
  for (const c of result.quality.contradictions) signals.push({ signal: "CONTEXT_SIGNAL", subjectId: c.subjectId, code: c.code, ...auth("CONTEXT_SIGNAL") });
  for (const [k, q] of Object.entries(result.quality.subjects)) {
    signals.push({ signal: "COVERAGE_SIGNAL", subjectId: q.subjectId ?? (k === "__none__" ? null : k), code: q.level, flags: q.flags, ...auth("COVERAGE_SIGNAL") });
  }
  return { integration: T.INTEGRATION, signals };
};

/**
 * Concise, factual codes a pupil's screen can render as sentences. No labels,
 * no verdicts: what happened, and where evidence is thin.
 */
const conciseFor = (result) => {
  const lines = [];
  for (const s of Object.values(result.patterns.bySubject)) {
    if (s.quiz.pattern === "CONSISTENT") lines.push({ code: "QUIZ_CONSISTENT", subjectId: s.subjectId, n: s.quiz.independentEvents });
    if (s.quiz.pattern === "IMPROVING") lines.push({ code: "QUIZ_IMPROVING", subjectId: s.subjectId, n: s.quiz.independentEvents });
    if (s.homework.pattern === "CONSISTENTLY_COMPLETED" || s.homework.pattern === "OFTEN_COMPLETED") lines.push({ code: "HOMEWORK_MOSTLY_COMPLETED", subjectId: s.subjectId, completed: s.homework.completed, assigned: s.homework.assigned });
    if (s.homework.pattern === "OFTEN_MISSING") lines.push({ code: "HOMEWORK_OFTEN_MISSING", subjectId: s.subjectId, completed: s.homework.completed, assigned: s.homework.assigned });
    const q = result.quality.subjects[s.subjectId ?? "__none__"];
    if (q && (q.level === "INSUFFICIENT_DATA" || q.level === "NO_DATA") && s.subjectId) lines.push({ code: "LIMITED_EVIDENCE", subjectId: s.subjectId });
  }
  return lines;
};

/**
 * Build the learning-evidence reading for one pupil.
 *
 * @param {object} input  { pupilId, schoolId, sources: { homework, quizAttempts, scores, attendance }, asOf }
 */
const buildLearningEvidence = ({ pupilId, schoolId, sources = {}, asOf = null }) => {
  const asOfDate = asOf ? new Date(asOf) : null;
  const { events: evs, rejected } = events.normalizeSources({ pupilId, schoolId, sources, asOf: asOfDate });
  const pats = patterns.analysePatterns(evs);
  const qual = quality.assessQuality(pats);
  const result = {
    learningEvidenceVersion: LEARNING_EVIDENCE_VERSION,
    pupilId: String(pupilId),
    asOf: asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate.toISOString() : null,
    windows: { recentDays: T.THRESHOLDS.recentDays, historicalDays: T.THRESHOLDS.historicalDays },
    thresholds: T.THRESHOLDS,
    authority: T.AUTHORITY,
    counts: { events: evs.length, bySource: Object.fromEntries(T.SOURCE_TYPES.map((s) => [s, evs.filter((e) => e.sourceType === s).length])), rejected: rejected.length },
    events: evs,
    rejected,
    patterns: pats,
    quality: qual,
    timeline: patterns.timelineOf(evs),
    notInferred: T.NOT_INFERRED,
  };
  const boundary = learningEvidenceForIntelligence(result);
  result.integration = boundary.integration;
  result.signals = boundary.signals;
  result.concise = conciseFor(result);
  return result;
};

/** What changed between two readings: per subject and family, pattern and coverage. No score. */
const compareReadings = (previous, current) => {
  const subjects = new Set([...Object.keys(previous?.patterns?.bySubject ?? {}), ...Object.keys(current?.patterns?.bySubject ?? {})]);
  const changes = [];
  for (const k of [...subjects].sort()) {
    const b = previous?.patterns?.bySubject?.[k], a = current?.patterns?.bySubject?.[k];
    for (const fam of ["formal", "continuous", "practical", "quiz"]) {
      const bp = b?.[fam]?.pattern ?? "INSUFFICIENT_EVIDENCE", ap = a?.[fam]?.pattern ?? "INSUFFICIENT_EVIDENCE";
      if (bp !== ap) changes.push({ subjectId: k === "__none__" ? null : k, family: fam, previous: bp, current: ap });
    }
    const bh = b?.homework?.pattern ?? "INSUFFICIENT_EVIDENCE", ah = a?.homework?.pattern ?? "INSUFFICIENT_EVIDENCE";
    if (bh !== ah) changes.push({ subjectId: k === "__none__" ? null : k, family: "homework", previous: bh, current: ah });
  }
  const ba = previous?.patterns?.attendance?.overall?.pattern ?? "INSUFFICIENT_ATTENDANCE_DATA", aa = current?.patterns?.attendance?.overall?.pattern ?? "INSUFFICIENT_ATTENDANCE_DATA";
  if (ba !== aa) changes.push({ subjectId: null, family: "attendance", previous: ba, current: aa });
  const prevC = new Set((previous?.quality?.contradictions ?? []).map((c) => `${c.subjectId}|${c.code}`));
  const newContradictions = (current?.quality?.contradictions ?? []).filter((c) => !prevC.has(`${c.subjectId}|${c.code}`));
  return {
    changes, newContradictions,
    coverage: { previous: previous?.quality?.overall?.level ?? null, current: current?.quality?.overall?.level ?? null, independentEvents: { previous: previous?.quality?.overall?.independentEvents ?? 0, current: current?.quality?.overall?.independentEvents ?? 0 } },
  };
};

module.exports = {
  LEARNING_EVIDENCE_VERSION,
  ...T,
  ...events,
  ...patterns,
  ...quality,
  buildLearningEvidence,
  learningEvidenceForIntelligence,
  conciseFor,
  compareReadings,
};
