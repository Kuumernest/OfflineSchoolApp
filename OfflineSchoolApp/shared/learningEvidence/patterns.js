// shared/learningEvidence/patterns.js
"use strict";

/**
 * Longitudinal patterns over learning-evidence events.
 *
 * A pattern needs THRESHOLDS.minEventsForPattern independent, valid,
 * non-stale observations; below that the answer is INSUFFICIENT_EVIDENCE and
 * nothing is inferred from one quiz or one homework. Direction compares the
 * mean of the later half against the earlier half; variability is the spread;
 * every reading carries first/last observed and the recent/historical/stale
 * counts, so a screen can say how much the pattern rests on.
 *
 * Attendance is read as engagement: a presence rate over marked days
 * (excused days are reported and left out of the rate), a trend, and never a
 * word about ability.
 */

const T = require("./taxonomy");

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
const performanceOf = (e) => e.observations.find((o) => o.kind === "performance" && T.VALUE_STATES.includes(o.state) && o.normalizedValue !== null);

/** The one series reading: count, recency, direction, variability, pattern. */
const readSeries = (events) => {
  const dated = events.filter((e) => performanceOf(e)).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  const live = dated.filter((e) => e.recency !== "STALE");
  // Independence: several attempts of one quiz count once (the last attempt speaks).
  const byKey = new Map();
  for (const e of live) byKey.set(e.independentKey ?? e.learningEventId, e);
  const independent = [...byKey.values()];
  const values = independent.map((e) => performanceOf(e).normalizedValue);
  const n = values.length;
  const out = {
    events: events.length, validEvents: dated.length, independentEvents: n,
    recent: dated.filter((e) => e.recency === "RECENT").length,
    historical: dated.filter((e) => e.recency === "HISTORICAL").length,
    stale: dated.filter((e) => e.recency === "STALE").length,
    firstObserved: dated[0]?.occurredAt ?? null, lastObserved: dated[dated.length - 1]?.occurredAt ?? null,
    mean: round3(mean(values)), spread: n ? round3(Math.max(...values) - Math.min(...values)) : null,
    direction: null, delta: null, pattern: "INSUFFICIENT_EVIDENCE",
  };
  if (n < T.THRESHOLDS.minEventsForPattern) return out;
  const half = Math.floor(n / 2);
  const earlier = values.slice(0, half), later = values.slice(n - half);
  const delta = round3(mean(later) - mean(earlier));
  out.delta = delta;
  out.direction = delta >= T.THRESHOLDS.directionDelta ? "improving" : delta <= -T.THRESHOLDS.directionDelta ? "declining" : "steady";
  out.pattern = out.direction === "improving" ? "IMPROVING" : out.direction === "declining" ? "DECLINING"
    : out.spread > T.THRESHOLDS.variableSpread ? "VARIABLE" : "CONSISTENT";
  return out;
};

/** Homework: how often assigned work was handed in, and when. */
const readCompletion = (homeworkEvents) => {
  const live = homeworkEvents.filter((e) => e.recency !== "STALE");
  const assigned = live.filter((e) => e.observations.some((o) => o.kind === "completion"));
  const completed = assigned.filter((e) => e.observations.some((o) => o.kind === "completion" && o.state === "COMPLETED"));
  const missing = assigned.length - completed.length;
  const pending = live.filter((e) => e.observations.some((o) => o.state === "PENDING")).length;
  const rate = assigned.length ? round3(completed.length / assigned.length) : null;
  const pattern = assigned.length < T.THRESHOLDS.minEventsForPattern ? "INSUFFICIENT_EVIDENCE"
    : rate >= T.THRESHOLDS.completionConsistent ? "CONSISTENTLY_COMPLETED"
    : rate >= T.THRESHOLDS.completionOften ? "OFTEN_COMPLETED" : "OFTEN_MISSING";
  const timings = live.flatMap((e) => e.observations.filter((o) => o.kind === "submission").map((o) => o.state));
  const submitted = timings.filter((t) => ["ON_TIME", "LATE", "VERY_LATE"].includes(t));
  const onTime = submitted.filter((t) => t === "ON_TIME").length;
  const submissionPattern = submitted.length < T.THRESHOLDS.minEventsForPattern ? "INSUFFICIENT_EVIDENCE"
    : onTime / submitted.length >= T.THRESHOLDS.onTimeMostly ? "MOSTLY_ON_TIME" : "OFTEN_LATE";
  const ungraded = live.filter((e) => e.observations.some((o) => o.state === "NOT_GRADED")).length;
  return {
    assigned: assigned.length, completed: completed.length, missing, pending, ungraded, completionRate: rate, pattern,
    submission: { onTime, late: timings.filter((t) => t === "LATE").length, veryLate: timings.filter((t) => t === "VERY_LATE").length,
      missing: timings.filter((t) => t === "MISSING").length, noDeadline: timings.filter((t) => t === "NO_DEADLINE").length, pattern: submissionPattern },
  };
};

/** Attendance: counts by status, a presence rate over marked days, a trend. */
const readAttendance = (attendanceEvents) => {
  const dated = attendanceEvents.filter((e) => e.occurredAt).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const live = dated.filter((e) => e.recency !== "STALE");
  const status = (e) => e.observations[0]?.state;
  const count = (list, s) => list.filter((e) => status(e) === s).length;
  const counts = { present: count(live, "present"), absent: count(live, "absent"), late: count(live, "late"), excused: count(live, "excused") };
  const marked = counts.present + counts.absent + counts.late;   // excused days are not held against presence
  const rate = marked ? round3((counts.present + counts.late) / marked) : null;
  const trendOf = (list) => { const m = list.filter((e) => status(e) !== "excused"); return m.length ? (m.filter((e) => status(e) !== "absent").length / m.length) : null; };
  let pattern = "INSUFFICIENT_ATTENDANCE_DATA", trend = null;
  if (marked >= T.THRESHOLDS.minAttendanceDays) {
    const half = Math.floor(live.length / 2);
    const earlier = trendOf(live.slice(0, half)), later = trendOf(live.slice(live.length - half));
    if (earlier !== null && later !== null) {
      trend = round3(later - earlier);
      if (trend <= -T.THRESHOLDS.attendanceTrendDelta) pattern = "ATTENDANCE_DECLINING";
      else if (trend >= T.THRESHOLDS.attendanceTrendDelta) pattern = "ATTENDANCE_IMPROVING";
    }
    if (pattern === "INSUFFICIENT_ATTENDANCE_DATA") pattern = rate >= T.THRESHOLDS.attendanceStable ? "ATTENDANCE_STABLE" : "ATTENDANCE_IRREGULAR";
  }
  return {
    ...counts, marked, unmarked: null, // no "expected days" source exists; unmarked days are not derivable and are not invented
    presenceRate: rate, trend, pattern,
    recent: dated.filter((e) => e.recency === "RECENT").length, historical: dated.filter((e) => e.recency === "HISTORICAL").length, stale: dated.filter((e) => e.recency === "STALE").length,
    firstObserved: dated[0]?.occurredAt ?? null, lastObserved: dated[dated.length - 1]?.occurredAt ?? null,
  };
};

/** Repeated engagement: quiz retries, completion streak length. Facts, not traits. */
const readPersistence = (quizEvents, homeworkEvents) => {
  const attemptsByQuiz = new Map();
  for (const e of quizEvents.filter((e) => e.recency !== "STALE" && e.final)) attemptsByQuiz.set(e.independentKey, (attemptsByQuiz.get(e.independentKey) ?? 0) + 1);
  const retried = [...attemptsByQuiz.values()].filter((n) => n > 1).length;
  const ordered = homeworkEvents.filter((e) => e.recency !== "STALE" && e.observations.some((o) => o.kind === "completion")).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  let streak = 0;
  for (let i = ordered.length - 1; i >= 0; i--) { if (ordered[i].observations.some((o) => o.state === "COMPLETED")) streak += 1; else break; }
  return { quizzesRetried: retried, quizzesAttempted: attemptsByQuiz.size, currentCompletionStreak: streak };
};

/** Every pattern, per subject and per family, plus attendance and persistence. */
const analysePatterns = (events) => {
  const subjects = {};
  const subjectOf = (e) => e.subjectId ?? "__none__";
  for (const e of events.filter((x) => x.sourceType !== "ATTENDANCE")) {
    const s = subjects[subjectOf(e)] ?? (subjects[subjectOf(e)] = { subjectId: e.subjectId ?? null, formal: [], continuous: [], practical: [], quiz: [], homework: [] });
    if (e.family && s[e.family]) s[e.family].push(e);
  }
  const bySubject = {};
  for (const [k, s] of Object.entries(subjects)) {
    bySubject[k] = {
      subjectId: s.subjectId,
      formal: readSeries(s.formal), continuous: readSeries(s.continuous), practical: readSeries(s.practical), quiz: readSeries(s.quiz),
      homework: { performance: readSeries(s.homework), ...readCompletion(s.homework) },
      persistence: readPersistence(s.quiz, s.homework),
    };
  }
  const attendanceEvents = events.filter((e) => e.sourceType === "ATTENDANCE");
  const attendanceBySubject = {};
  for (const e of attendanceEvents.filter((x) => x.subjectId)) (attendanceBySubject[e.subjectId] = attendanceBySubject[e.subjectId] ?? []).push(e);
  return {
    bySubject,
    attendance: { overall: readAttendance(attendanceEvents), bySubject: Object.fromEntries(Object.entries(attendanceBySubject).map(([k, v]) => [k, readAttendance(v)])) },
  };
};

/** The timeline: every event, dated, with its kind, state and value. */
const timelineOf = (events) => events.map((e) => ({
  when: e.occurredAt, learningEventId: e.learningEventId, sourceType: e.sourceType, family: e.family, subjectId: e.subjectId, recency: e.recency,
  observations: e.observations.map((o) => ({ kind: o.kind, state: o.state, ...(o.normalizedValue !== undefined ? { normalizedValue: o.normalizedValue } : {}) })),
}));

module.exports = { readSeries, readCompletion, readAttendance, readPersistence, analysePatterns, timelineOf };
