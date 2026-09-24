// shared/learningEvidence/quality.js
"use strict";

/**
 * Evidence quality and contradictions.
 *
 * Coverage says how much valid, current evidence a reading rests on — never
 * how well a pupil did. Strong performance on sparse evidence and strong
 * performance on twelve independent tasks read differently here and nowhere
 * else. Contradictions are named with the counts behind them and are left
 * standing: the layer does not pick a winner between a written test and a
 * practical, or between marks and attendance.
 */

const T = require("./taxonomy");

const band = (n) => (n === 0 ? "NO_DATA" : n < T.THRESHOLDS.minEventsForPattern ? "INSUFFICIENT_DATA"
  : n < T.THRESHOLDS.sparseBelow ? "SPARSE_DATA" : n < T.THRESHOLDS.goodBelow ? "GOOD_COVERAGE" : "STRONG_COVERAGE");

const seriesCoverage = (s) => ({
  level: band(s.independentEvents), independentEvents: s.independentEvents, stale: s.stale,
  flags: [...(s.stale > 0 && s.independentEvents === 0 ? ["STALE_DATA"] : [])],
});

/** Contradictions within one subject's readings, and against its attendance. */
const contradictionsFor = (subject, attendance) => {
  const out = [];
  const enough = (s, min = T.THRESHOLDS.minEventsForContradiction) => s.independentEvents >= min && s.mean !== null;
  const differ = (a, b) => Math.abs(a.mean - b.mean) >= T.THRESHOLDS.contradictionDelta;
  if (enough(subject.formal) && enough(subject.continuous) && differ(subject.formal, subject.continuous)) {
    out.push({ code: "FORMAL_VS_CONTINUOUS_ASSESSMENT", formal: subject.formal.mean, continuous: subject.continuous.mean, events: [subject.formal.independentEvents, subject.continuous.independentEvents] });
  }
  if (enough(subject.formal) && enough(subject.practical, T.THRESHOLDS.minPracticalForContradiction) && differ(subject.formal, subject.practical)) {
    out.push({ code: "THEORY_VS_PRACTICAL", formal: subject.formal.mean, practical: subject.practical.mean, events: [subject.formal.independentEvents, subject.practical.independentEvents] });
  }
  const hw = subject.homework;
  if (hw.performance.mean !== null && hw.pattern !== "INSUFFICIENT_EVIDENCE") {
    if (hw.performance.mean >= 0.7 && hw.pattern === "OFTEN_MISSING") out.push({ code: "PERFORMANCE_VS_ENGAGEMENT", performance: hw.performance.mean, completion: hw.pattern });
    if (hw.performance.mean < 0.5 && hw.pattern === "CONSISTENTLY_COMPLETED") out.push({ code: "PERFORMANCE_VS_ENGAGEMENT", performance: hw.performance.mean, completion: hw.pattern });
  }
  if (attendance && attendance.pattern !== "INSUFFICIENT_ATTENDANCE_DATA" && hw.pattern !== "INSUFFICIENT_EVIDENCE") {
    if (attendance.pattern === "ATTENDANCE_IRREGULAR" && hw.pattern === "CONSISTENTLY_COMPLETED") out.push({ code: "ATTENDANCE_VS_COMPLETION", attendance: attendance.pattern, completion: hw.pattern });
    if (attendance.pattern === "ATTENDANCE_STABLE" && hw.pattern === "OFTEN_MISSING") out.push({ code: "ATTENDANCE_VS_COMPLETION", attendance: attendance.pattern, completion: hw.pattern });
  }
  for (const fam of ["formal", "continuous", "practical", "quiz"]) {
    const s = subject[fam];
    if (s.recent >= 2 && s.historical >= 2 && s.delta !== null && Math.abs(s.delta) >= T.THRESHOLDS.contradictionDelta) {
      out.push({ code: "RECENT_VS_HISTORICAL", family: fam, delta: s.delta, direction: s.direction });
    }
  }
  return out;
};

/**
 * Quality per subject and overall. A subject whose formal evidence is thin
 * while attendance is irregular is flagged LIMITED_BY_ATTENDANCE — a note
 * about coverage, never a conclusion about ability.
 */
const assessQuality = (patterns) => {
  const subjects = {};
  const allContradictions = [];
  for (const [k, s] of Object.entries(patterns.bySubject)) {
    const att = patterns.attendance.bySubject[k] ?? patterns.attendance.overall;
    const contradictions = contradictionsFor(s, att);
    const families = { formal: seriesCoverage(s.formal), continuous: seriesCoverage(s.continuous), practical: seriesCoverage(s.practical), quiz: seriesCoverage(s.quiz), homework: { ...seriesCoverage(s.homework.performance), assigned: s.homework.assigned } };
    const independent = s.formal.independentEvents + s.continuous.independentEvents + s.practical.independentEvents + s.quiz.independentEvents + s.homework.performance.independentEvents;
    const flags = new Set(Object.values(families).flatMap((f) => f.flags));
    if (s.homework.pending > 0 || s.homework.ungraded > 0) flags.add("INCOMPLETE_PERIOD");
    if (contradictions.length) flags.add("CONFLICTING_DATA");
    if (att && att.pattern === "ATTENDANCE_IRREGULAR" && s.formal.independentEvents < T.THRESHOLDS.sparseBelow) flags.add("LIMITED_BY_ATTENDANCE");
    subjects[k] = { subjectId: s.subjectId, level: band(independent), independentEvents: independent, families, flags: [...flags].sort(), contradictions };
    allContradictions.push(...contradictions.map((c) => ({ subjectId: s.subjectId, ...c })));
  }
  const totalIndependent = Object.values(subjects).reduce((n, s) => n + s.independentEvents, 0);
  const att = patterns.attendance.overall;
  return {
    subjects,
    attendance: { level: att.marked === 0 ? "NO_DATA" : att.marked < T.THRESHOLDS.minAttendanceDays ? "INSUFFICIENT_DATA" : att.marked < 30 ? "SPARSE_DATA" : "GOOD_COVERAGE", marked: att.marked, stale: att.stale },
    overall: { level: band(totalIndependent), independentEvents: totalIndependent, subjects: Object.keys(subjects).filter((k) => k !== "__none__").length,
      flags: [...new Set(Object.values(subjects).flatMap((s) => s.flags))].sort() },
    contradictions: allContradictions,
  };
};

module.exports = { band, seriesCoverage, contradictionsFor, assessQuality };
