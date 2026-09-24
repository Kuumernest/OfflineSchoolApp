// shared/learningEvidence/events.js
"use strict";

/**
 * From school records to learning-evidence events.
 *
 * ── One real event, several observations ──────────────────────────────────
 *
 * A homework yields a score, a submission time and a completion fact. They
 * are three observations on ONE event, identified by a `learningEventId`
 * derived from the source record. Nothing downstream counts an event more
 * than once because it carries several observations.
 *
 * ── States, not zeros ─────────────────────────────────────────────────────
 *
 * ABSENT, EXEMPT, NOT_SUBMITTED, NOT_GRADED, UNPUBLISHED, PENDING, an
 * attempt IN_PROGRESS or ABANDONED — each is kept as its state with no value.
 * A genuine zero is VALID with value 0 (state ZERO). A normalised value exists
 * only when score and maxScore are numbers and maxScore is positive.
 *
 * ── Inputs are reduced rows ───────────────────────────────────────────────
 *
 * The service hands in plain rows with only the fields named below — ids,
 * dates, scores, states. A row carrying an identity or contact field is
 * refused and reported; the layer does not read around it.
 *
 * ── Time is an input ──────────────────────────────────────────────────────
 *
 * `asOf` fixes recency and "past due". Nothing here reads the clock.
 */

const T = require("./taxonomy");

const dayMs = 86400000;
const toDate = (v) => { if (v === null || v === undefined || v === "") return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const iso = (d) => (d ? d.toISOString() : null);

const recencyOf = (date, asOf) => {
  const d = toDate(date), a = toDate(asOf);
  if (!d || !a) return "STALE";
  const days = Math.floor((a.getTime() - d.getTime()) / dayMs);
  if (days <= T.THRESHOLDS.recentDays) return "RECENT";
  if (days <= T.THRESHOLDS.historicalDays) return "HISTORICAL";
  return "STALE";
};

/** A normalised value when the arithmetic is valid; otherwise the state that explains why not. */
const normalize = (score, maxScore) => {
  if (score === null || score === undefined) return { normalizedValue: null, state: "NULL_SCORE" };
  const s = Number(score), m = Number(maxScore);
  if (!Number.isFinite(s) || !Number.isFinite(m) || m <= 0) return { normalizedValue: null, state: "NULL_SCORE" };
  const v = Math.max(0, Math.min(1, s / m));
  return { normalizedValue: Math.round(v * 1000) / 1000, state: s === 0 ? "ZERO" : "VALID" };
};

const forbiddenIn = (row) => Object.keys(row ?? {}).filter((k) => T.FORBIDDEN_KEYS.includes(k.toLowerCase()));

const base = ({ learningEventId, pupilId, schoolId, sourceType, evidenceType, family, subjectId, activityId, occurredAt, recordedAt, published, final, provenance, context, asOf }) => ({
  learningEventId, pupilId: String(pupilId), schoolId: String(schoolId),
  sourceType, evidenceType, family,
  subjectId: subjectId ?? null, activityId: activityId ?? null,
  occurredAt: iso(toDate(occurredAt)), recordedAt: iso(toDate(recordedAt)),
  recency: recencyOf(occurredAt, asOf),
  published: Boolean(published), final: Boolean(final),
  provenance, context: { academicYear: context?.academicYear ?? null, term: context?.term ?? null, sequence: context?.sequence ?? null, classId: context?.classId ?? null },
  observations: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// HOMEWORK — the application's assignments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * row: { _id, subjectId, classId, dueDate, maxScore, allowLate, isPublished, createdAt, version,
 *        submission: { submittedAt, score, gradedAt } | null }
 * Unpublished homework was never assigned and yields no event. A homework
 * whose due date has not passed is PENDING (context) and enters no completion
 * count: the pupil has not yet had the chance to miss it.
 */
const eventsFromHomework = ({ pupilId, schoolId, homework = [], asOf }) => {
  const out = [];
  for (const h of homework) {
    if (!h || h.isPublished === false) continue;
    const due = toDate(h.dueDate), a = toDate(asOf);
    const sub = h.submission ?? null;
    const submittedAt = toDate(sub?.submittedAt);
    const pastDue = Boolean(due && a && a > due);
    const e = base({
      learningEventId: `homework:${h._id}`, pupilId, schoolId, sourceType: "HOMEWORK", evidenceType: "ACHIEVEMENT", family: "homework",
      subjectId: h.subjectId, activityId: String(h._id), occurredAt: submittedAt ?? due ?? h.createdAt, recordedAt: sub?.gradedAt ?? submittedAt ?? h.createdAt,
      published: true, final: Boolean(sub?.gradedAt) || (!sub && pastDue), asOf,
      provenance: { sourceModel: "Homework", sourceId: String(h._id), sourceVersion: h.version ?? null },
      context: { classId: h.classId ?? null },
    });
    // completion
    if (sub) e.observations.push({ kind: "completion", evidenceType: "ENGAGEMENT", state: "COMPLETED" });
    else if (pastDue) e.observations.push({ kind: "completion", evidenceType: "ENGAGEMENT", state: "NOT_SUBMITTED" });
    else e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "PENDING" });
    // submission timing
    if (sub) {
      let timing = "NO_DEADLINE", lateDays = null;
      if (due && submittedAt) {
        lateDays = Math.max(0, Math.ceil((submittedAt.getTime() - due.getTime()) / dayMs));
        timing = lateDays === 0 ? "ON_TIME" : lateDays > T.THRESHOLDS.veryLateDays ? "VERY_LATE" : "LATE";
      }
      e.observations.push({ kind: "submission", evidenceType: "ENGAGEMENT", state: timing, lateDays });
    } else if (pastDue) {
      e.observations.push({ kind: "submission", evidenceType: "ENGAGEMENT", state: "MISSING", lateDays: null });
    }
    // performance
    if (sub && sub.gradedAt && sub.score !== null && sub.score !== undefined) {
      const n = normalize(sub.score, h.maxScore);
      e.observations.push({ kind: "performance", evidenceType: "ACHIEVEMENT", state: n.state, value: Number(sub.score), maxValue: Number(h.maxScore) || null, normalizedValue: n.normalizedValue });
    } else if (sub) {
      e.observations.push({ kind: "performance", evidenceType: "CONTEXT", state: "NOT_GRADED", value: null, maxValue: Number(h.maxScore) || null, normalizedValue: null });
    }
    out.push(e);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ ATTEMPTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * row: { _id, quizId, subjectId, classId, isPublished, status, rawScore, maxScore, submittedAt, startedAt, attemptNumber, version }
 * Each attempt is an event; attempts of one quiz share `independentKey`, so a
 * pattern counts quizzes, not retries. An attempt in progress or abandoned
 * is context; an unpublished quiz's attempt is UNPUBLISHED context.
 */
const eventsFromQuizAttempts = ({ pupilId, schoolId, quizAttempts = [], asOf }) => {
  const out = [];
  for (const q of quizAttempts) {
    if (!q) continue;
    const e = base({
      learningEventId: `quiz:${q.quizId}:${q.attemptNumber ?? 1}`, pupilId, schoolId, sourceType: "QUIZ", evidenceType: "ACHIEVEMENT", family: "quiz",
      subjectId: q.subjectId, activityId: String(q.quizId), occurredAt: q.submittedAt ?? q.startedAt, recordedAt: q.submittedAt ?? q.startedAt,
      published: q.isPublished !== false, final: ["submitted", "timed_out"].includes(q.status), asOf,
      provenance: { sourceModel: "QuizAttempt", sourceId: String(q._id), sourceVersion: q.version ?? null },
      context: { classId: q.classId ?? null },
    });
    e.independentKey = `quiz:${q.quizId}`;
    e.attemptNumber = q.attemptNumber ?? 1;
    if (q.isPublished === false) e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "UNPUBLISHED" });
    else if (q.status === "in_progress") e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "IN_PROGRESS" });
    else if (q.status === "abandoned") e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "ABANDONED" });
    else {
      const n = normalize(q.rawScore, q.maxScore);
      e.observations.push({ kind: "performance", evidenceType: "ACHIEVEMENT", state: q.status === "timed_out" && n.state !== "NULL_SCORE" ? n.state : n.state, value: q.rawScore ?? null, maxValue: q.maxScore ?? null, normalizedValue: n.normalizedValue, timedOut: q.status === "timed_out" });
      e.observations.push({ kind: "completion", evidenceType: "ENGAGEMENT", state: "COMPLETED" });
    }
    out.push(e);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// EXAM SCORES — tests, promotion exams, continuous assessment, practicals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * row: { _id, examId, subjectId, classId, examType, academicYear, term, sequenceNumber, startDate,
 *        resultsPublished, score, maxScore, isAbsent, isExempt, version }
 * A practical is SKILL evidence in its own family; the rest is ACHIEVEMENT in
 * the formal or continuous family. Absent, exempt and unpublished carry no
 * value and say why.
 */
const eventsFromScores = ({ pupilId, schoolId, scores = [], asOf }) => {
  const out = [];
  for (const s of scores) {
    if (!s) continue;
    const family = T.ASSESSMENT_FAMILY[s.examType] ?? "formal";
    const evidenceType = family === "practical" ? "SKILL" : "ACHIEVEMENT";
    const e = base({
      learningEventId: `exam:${s.examId}:${s.subjectId}`, pupilId, schoolId, sourceType: "EXAM_SCORE", evidenceType, family,
      subjectId: s.subjectId, activityId: String(s.examId), occurredAt: s.startDate, recordedAt: s.startDate,
      published: Boolean(s.resultsPublished), final: Boolean(s.resultsPublished), asOf,
      provenance: { sourceModel: "StudentScore", sourceId: String(s._id), sourceVersion: s.version ?? null },
      context: { academicYear: s.academicYear ?? null, term: s.term ?? null, sequence: s.sequenceNumber ?? null, classId: s.classId ?? null },
    });
    e.assessmentKind = s.examType ?? null;
    if (!s.resultsPublished) e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "UNPUBLISHED" });
    else if (s.isAbsent) e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "ABSENT" });
    else if (s.isExempt) e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "EXEMPT" });
    else {
      const n = normalize(s.score, s.maxScore);
      if (n.state === "NULL_SCORE") e.observations.push({ kind: "context", evidenceType: "CONTEXT", state: "NULL_SCORE" });
      else e.observations.push({ kind: "performance", evidenceType, state: n.state, value: Number(s.score), maxValue: Number(s.maxScore), normalizedValue: n.normalizedValue });
    }
    out.push(e);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE — engagement and context, never ability
// ─────────────────────────────────────────────────────────────────────────────

/** row: { _id, date, status, subjectId, classId, periodId } */
const eventsFromAttendance = ({ pupilId, schoolId, attendance = [], asOf }) => {
  const out = [];
  for (const r of attendance) {
    if (!r || !T.ATTENDANCE_STATUS.includes(r.status)) continue;
    const e = base({
      learningEventId: `attendance:${r._id}`, pupilId, schoolId, sourceType: "ATTENDANCE", evidenceType: r.status === "excused" ? "CONTEXT" : "ENGAGEMENT", family: null,
      subjectId: r.subjectId ?? null, activityId: null, occurredAt: r.date, recordedAt: r.date, published: true, final: true, asOf,
      provenance: { sourceModel: "StudentAttendance", sourceId: String(r._id), sourceVersion: null },
      context: { classId: r.classId ?? null },
    });
    e.observations.push({ kind: "attendance", evidenceType: r.status === "excused" ? "CONTEXT" : "ENGAGEMENT", state: r.status });
    out.push(e);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// ALL SOURCES, ONE LIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise every source. Rows carrying identity are refused; duplicate
 * learningEventIds are kept once and reported.
 */
const normalizeSources = ({ pupilId, schoolId, sources = {}, asOf = null }) => {
  const rejected = [];
  const clean = (list, label) => (list ?? []).filter((row) => {
    const bad = forbiddenIn(row);
    if (bad.length) { rejected.push({ source: label, sourceId: row?._id ? String(row._id) : null, reason: `forbidden field(s): ${bad.join(", ")}` }); return false; }
    return true;
  });
  const all = [
    ...eventsFromHomework({ pupilId, schoolId, homework: clean(sources.homework, "HOMEWORK"), asOf }),
    ...eventsFromQuizAttempts({ pupilId, schoolId, quizAttempts: clean(sources.quizAttempts, "QUIZ"), asOf }),
    ...eventsFromScores({ pupilId, schoolId, scores: clean(sources.scores, "EXAM_SCORE"), asOf }),
    ...eventsFromAttendance({ pupilId, schoolId, attendance: clean(sources.attendance, "ATTENDANCE"), asOf }),
  ];
  const seen = new Set();
  const events = [];
  for (const e of all) {
    if (seen.has(e.learningEventId)) { rejected.push({ source: e.sourceType, sourceId: e.provenance.sourceId, reason: `duplicate ${e.learningEventId}` }); continue; }
    seen.add(e.learningEventId);
    events.push(e);
  }
  events.sort((a, b) => String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")) || a.learningEventId.localeCompare(b.learningEventId));
  return { events, rejected };
};

module.exports = { recencyOf, normalize, normalizeSources, eventsFromHomework, eventsFromQuizAttempts, eventsFromScores, eventsFromAttendance };
