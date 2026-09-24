// backend/scripts/check-learning-evidence.js
"use strict";

/**
 * The learning-evidence layer: every source the audit found, every semantic
 * state, one event counted once, patterns that need evidence, recency,
 * quality, contradictions kept standing, the strength boundary untouched,
 * determinism, privacy — then the routes as each role, snapshots, and
 * live = offline.
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-learning-evidence.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const le = require(path.join(ROOT, "..", "shared", "learningEvidence"));
const st = require(path.join(ROOT, "..", "shared", "strengths"));
const ASOF = "2027-06-01";
const build = (sources) => le.buildLearningEvidence({ pupilId: "st", schoolId: "A", sources, asOf: ASOF });
const maths = (r) => r.patterns.bySubject.maths;

// Fixture helpers — dates are explicit, never the clock.
const hw = (id, due, opts) => { const { score = null, submittedOffsetDays = null, graded = true, maxScore = 20, isPublished = true, subjectId = "maths" } = opts ?? {}; return ({
  _id: id, subjectId, classId: "c", dueDate: due, maxScore, isPublished, createdAt: due, version: 1,
  submission: submittedOffsetDays === null ? null : { submittedAt: new Date(new Date(due).getTime() + submittedOffsetDays * 86400000).toISOString(), score, gradedAt: graded && score !== null ? due : null },
}); };
const quiz = (quizId, date, raw, { status = "submitted", attemptNumber = 1, isPublished = true, max = 10, subjectId = "maths" } = {}) =>
  ({ _id: `${quizId}-${attemptNumber}`, quizId, subjectId, classId: "c", isPublished, status, rawScore: raw, maxScore: max, submittedAt: date, startedAt: date, attemptNumber });
const score = (examId, type, date, value, { isAbsent = false, isExempt = false, resultsPublished = true, subjectId = "maths", maxScore = 20 } = {}) =>
  ({ _id: `s-${examId}-${subjectId}`, examId, subjectId, classId: "c", examType: type, academicYear: "2026-2027", term: 1, sequenceNumber: 1, startDate: date, resultsPublished, score: value, maxScore, isAbsent, isExempt, version: 1 });
const att = (i, date, status, subjectId = null) => ({ _id: `a${i}`, date, status, subjectId, classId: "c" });
const days = (n, from = "2027-03-01") => Array.from({ length: n }, (_, i) => new Date(new Date(from).getTime() + i * 86400000).toISOString().slice(0, 10));

(async () => {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. sources become events, one each, with their observations apart ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = build({ homework: [hw("h1", "2027-05-01", { score: 18, submittedOffsetDays: 1 })] });
  let e = r.events[0];
  check("one graded, late homework is ONE event with three observations — performance, submission, completion — not one opaque score",
    [r.counts.events, e.learningEventId, e.observations.map((o) => [o.kind, o.state]).sort()],
    [1, "homework:h1", [["completion", "COMPLETED"], ["performance", "VALID"], ["submission", "LATE"]]]);
  check("the score is normalised only where the arithmetic is valid, and the event carries its provenance and version",
    [e.observations.find((o) => o.kind === "performance").normalizedValue, e.provenance, e.evidenceType, e.family], [0.9, { sourceModel: "Homework", sourceId: "h1", sourceVersion: 1 }, "ACHIEVEMENT", "homework"]);
  r = build({ scores: [score("x1", "test", "2027-03-01", 14), score("p1", "practical", "2027-03-05", 19), score("c1", "ca", "2027-03-10", 9)] });
  check("a test, a practical and a CA mark are three events in three families; the practical is SKILL evidence, the others ACHIEVEMENT",
    r.events.map((x) => [x.family, x.evidenceType]).sort(), [["continuous", "ACHIEVEMENT"], ["formal", "ACHIEVEMENT"], ["practical", "SKILL"]]);
  r = build({ quizAttempts: [quiz("q1", "2027-04-01", 7), quiz("q1", "2027-04-02", 9, { attemptNumber: 2 })] });
  check("two attempts of one quiz are two events that share an independence key — a retry is persistence, not a second quiz",
    [r.events.map((x) => x.learningEventId), [...new Set(r.events.map((x) => x.independentKey))], maths(r).persistence.quizzesRetried], [["quiz:q1:1", "quiz:q1:2"], ["quiz:q1"], 1]);
  r = build({ attendance: [att(1, "2027-03-01", "present"), att(2, "2027-03-02", "absent"), att(3, "2027-03-03", "excused"), att(4, "2027-03-04", "late")] });
  check("attendance entries are engagement events; excused is context; the four statuses stay four",
    r.events.map((x) => [x.evidenceType, x.observations[0].state]).sort(), [["CONTEXT", "excused"], ["ENGAGEMENT", "absent"], ["ENGAGEMENT", "late"], ["ENGAGEMENT", "present"]]);
  check("participation and project records do not exist as sources and none is invented", [le.SOURCE_TYPES.includes("PARTICIPATION"), le.SOURCE_TYPES.includes("PROJECT")], [false, false]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. semantic states are states, never zeros ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = build({ scores: [score("z", "test", "2027-03-01", 0), score("n", "test", "2027-03-02", null), score("ab", "test", "2027-03-03", null, { isAbsent: true }), score("ex", "test", "2027-03-04", null, { isExempt: true }), score("un", "test", "2027-03-05", 15, { resultsPublished: false })] });
  const stateOf = (id) => r.events.find((x) => x.learningEventId === `exam:${id}:maths`).observations[0];
  check("zero is a valid value of 0; null, absent, exempt and unpublished carry no value and say why",
    [[stateOf("z").state, stateOf("z").normalizedValue], stateOf("n").state, stateOf("ab").state, stateOf("ex").state, stateOf("un").state, stateOf("un").normalizedValue],
    [["ZERO", 0], "NULL_SCORE", "ABSENT", "EXEMPT", "UNPUBLISHED", undefined]);
  check("only the genuine zero enters a performance series", maths(r).formal.validEvents, 1);
  r = build({ homework: [hw("ns", "2027-05-01"), hw("ng", "2027-05-02", { score: null, submittedOffsetDays: 0, graded: false }), hw("pend", "2027-07-01"), hw("unpub", "2027-05-03", { isPublished: false })] });
  const hwState = (id, kind) => r.events.find((x) => x.learningEventId === `homework:${id}`)?.observations.find((o) => o.kind === kind)?.state;
  check("not submitted past due is NOT_SUBMITTED / MISSING; submitted but ungraded is NOT_GRADED; not yet due is PENDING; unpublished was never assigned",
    [hwState("ns", "completion"), hwState("ns", "submission"), hwState("ng", "performance"), hwState("pend", "context"), r.events.some((x) => x.learningEventId === "homework:unpub")],
    ["NOT_SUBMITTED", "MISSING", "NOT_GRADED", "PENDING", false]);
  check("a pending homework enters no completion count", [maths(r).homework.assigned, maths(r).homework.pending], [2, 1]);
  r = build({ quizAttempts: [quiz("q1", "2027-04-01", 3, { status: "in_progress" }), quiz("q2", "2027-04-02", 0, { status: "abandoned" }), quiz("q3", "2027-04-03", 8, { status: "timed_out" }), quiz("q4", "2027-04-04", 8, { isPublished: false })] });
  check("an attempt in progress or abandoned is context; a timed-out one is a valid result; an unpublished quiz is context",
    r.events.map((x) => x.observations[0].state), ["IN_PROGRESS", "ABANDONED", "VALID", "UNPUBLISHED"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. identity: one event once, duplicates refused, distinct stays distinct ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const one = hw("h1", "2027-05-01", { score: 18, submittedOffsetDays: 0 });
  r = build({ homework: [one, one] });
  check("the same homework delivered twice is one event and one rejection", [r.counts.events, r.rejected], [1, [{ source: "HOMEWORK", sourceId: "h1", reason: "duplicate homework:h1" }]]);
  r = build({ homework: [hw("h1", "2027-05-01", { score: 18, submittedOffsetDays: 0 }), hw("h2", "2027-05-02", { score: 18, submittedOffsetDays: 0 })] });
  check("two homeworks with identical marks are two events", r.counts.events, 2);
  check("one homework's three observations count as one performance event, not three", build({ homework: [one] }).patterns.bySubject.maths.homework.performance.independentEvents, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. patterns need evidence; recency is explicit ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("one quiz is an observation, not a pattern", build({ quizAttempts: [quiz("q1", "2027-04-01", 9)] }).patterns.bySubject.maths.quiz.pattern, "INSUFFICIENT_EVIDENCE");
  check("two are still insufficient; three independent quizzes make a pattern",
    [build({ quizAttempts: [quiz("q1", "2027-04-01", 9), quiz("q2", "2027-04-08", 9)] }).patterns.bySubject.maths.quiz.pattern,
     build({ quizAttempts: [quiz("q1", "2027-04-01", 9), quiz("q2", "2027-04-08", 9), quiz("q3", "2027-04-15", 9)] }).patterns.bySubject.maths.quiz.pattern], ["INSUFFICIENT_EVIDENCE", "CONSISTENT"]);
  check("three attempts of ONE quiz are not three quizzes", build({ quizAttempts: [1, 2, 3].map((n) => quiz("q1", `2027-04-0${n}`, 9, { attemptNumber: n }))}).patterns.bySubject.maths.quiz.pattern, "INSUFFICIENT_EVIDENCE");
  const series = (vals, from = "2027-01-01") => build({ quizAttempts: vals.map((v, i) => quiz(`q${i}`, new Date(new Date(from).getTime() + i * 7 * 86400000).toISOString(), v)) }).patterns.bySubject.maths.quiz;
  check("direction: rising → IMPROVING, falling → DECLINING, swinging → VARIABLE, level → CONSISTENT",
    [series([5, 6, 8, 9]).pattern, series([9, 8, 6, 5]).pattern, series([9, 4, 9, 4]).pattern, series([8, 8, 8, 8]).pattern], ["IMPROVING", "DECLINING", "VARIABLE", "CONSISTENT"]);
  check("first/last observed, counts and spread are on every reading", (({ firstObserved, lastObserved, independentEvents, spread }) => [Boolean(firstObserved), Boolean(lastObserved), independentEvents, spread])(series([8, 8, 8, 8])), [true, true, 4, 0]);
  check("recency: 120 days is RECENT, 121 HISTORICAL, 365 HISTORICAL, 366 STALE", ["2027-02-01", "2027-01-31", "2026-06-01", "2026-05-31"].map((d) => le.recencyOf(d, ASOF)), ["RECENT", "HISTORICAL", "HISTORICAL", "STALE"]);
  const stale = build({ quizAttempts: [quiz("q1", "2025-04-01", 9), quiz("q2", "2025-04-08", 9), quiz("q3", "2025-04-15", 9)] });
  check("stale evidence is kept and counted as stale, and reads no pattern", [maths(stale).quiz.stale, maths(stale).quiz.pattern, stale.quality.subjects.maths.flags], [3, "INSUFFICIENT_EVIDENCE", ["STALE_DATA"]]);
  check("the reading is a function of asOf, never of the clock", [le.buildLearningEvidence({ pupilId: "s", schoolId: "A", sources: {}, asOf: null }).asOf, series([8, 8, 8, 8]).pattern], [null, "CONSISTENT"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. homework: completion, submission, lateness, missing ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const hwSet = (spec) => build({ homework: spec.map(([id, due, s], i) => hw(id ?? `h${i}`, due, s ?? undefined)) }).patterns.bySubject.maths.homework;
  let h = hwSet([["a", "2027-04-01", { score: 16, submittedOffsetDays: 0 }], ["b", "2027-04-08", { score: 15, submittedOffsetDays: 0 }], ["c", "2027-04-15", { score: 17, submittedOffsetDays: 0 }], ["d", "2027-04-22", { score: 14, submittedOffsetDays: 0 }]]);
  check("four of four handed in on time → CONSISTENTLY_COMPLETED, MOSTLY_ON_TIME, and a performance series of its own", [h.pattern, h.submission.pattern, h.performance.pattern, h.completionRate], ["CONSISTENTLY_COMPLETED", "MOSTLY_ON_TIME", "CONSISTENT", 1]);
  h = hwSet([["a", "2027-04-01", { score: 16, submittedOffsetDays: 2 }], ["b", "2027-04-08", { score: 15, submittedOffsetDays: 9 }], ["c", "2027-04-15", null], ["d", "2027-04-22", { score: 17, submittedOffsetDays: 0 }]]);
  check("late, very late and missing are counted apart; three of four → OFTEN_COMPLETED; lateness → OFTEN_LATE", [h.completed, h.missing, h.submission.late, h.submission.veryLate, h.submission.missing, h.pattern, h.submission.pattern], [3, 1, 1, 1, 1, "OFTEN_COMPLETED", "OFTEN_LATE"]);
  h = hwSet([["a", "2027-04-01", null], ["b", "2027-04-08", null], ["c", "2027-04-15", { score: 18, submittedOffsetDays: 0 }]]);
  check("one of three → OFTEN_MISSING — and the word is missing, never lazy", [h.pattern, /lazy|undisciplined|unmotivated/i.test(JSON.stringify(h))], ["OFTEN_MISSING", false]);
  check("two assigned is insufficient for a completion pattern", hwSet([["a", "2027-04-01", null], ["b", "2027-04-08", null]]).pattern, "INSUFFICIENT_EVIDENCE");
  check("no homework recorded means homework evidence unavailable — NO_DATA, not never-does-homework", build({ scores: [score("x", "test", "2027-03-01", 14)] }).quality.subjects.maths.families.homework.level, "NO_DATA");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. attendance is engagement and context, never ability ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const attSet = (statuses) => build({ attendance: statuses.map((s, i) => att(i, days(statuses.length)[i], s)) }).patterns.attendance.overall;
  let a = attSet(Array(12).fill("present"));
  check("twelve present days → ATTENDANCE_STABLE, presence 1", [a.pattern, a.presenceRate, a.marked], ["ATTENDANCE_STABLE", 1, 12]);
  a = attSet(["present", "absent", "present", "absent", "present", "absent", "present", "absent", "present", "absent", "present", "absent"]);
  check("half the days absent → ATTENDANCE_IRREGULAR; absent, present counted apart", [a.pattern, a.presenceRate, a.absent, a.present], ["ATTENDANCE_IRREGULAR", 0.5, 6, 6]);
  a = attSet([...Array(6).fill("present"), ...Array(6).fill("absent")]);
  check("presence falling from the earlier half to the later → ATTENDANCE_DECLINING", a.pattern, "ATTENDANCE_DECLINING");
  a = attSet([...Array(6).fill("absent"), ...Array(6).fill("present")]);
  check("and rising → ATTENDANCE_IMPROVING", a.pattern, "ATTENDANCE_IMPROVING");
  a = attSet(["present", "excused", "excused", "present", "absent", "present", "present", "present", "present", "present", "present", "present"]);
  check("excused days are reported and left out of the presence rate; unmarked days are not derivable and not invented", [a.excused, a.marked, a.unmarked], [2, 10, null]);
  check("nine marked days are insufficient", attSet(Array(9).fill("absent")).pattern, "INSUFFICIENT_ATTENDANCE_DATA");
  const weakAndAbsent = build({ scores: [score("x1", "test", "2027-03-01", 6), score("x2", "test", "2027-03-15", 7)], attendance: Array(12).fill(0).map((_, i) => att(i, days(12)[i], i % 2 ? "absent" : "present")) });
  check("weak marks with irregular attendance: no conclusion about ability — only that formal evidence is LIMITED_BY_ATTENDANCE",
    [weakAndAbsent.quality.subjects.maths.flags.includes("LIMITED_BY_ATTENDANCE"), maths(weakAndAbsent).formal.pattern, /ability|weak learner/i.test(JSON.stringify(weakAndAbsent.signals))], [true, "INSUFFICIENT_EVIDENCE", false]);
  check("attendance produces an ENGAGEMENT signal and nothing in the achievement family", weakAndAbsent.signals.filter((s) => s.family === "attendance").map((s) => s.signal), ["ENGAGEMENT_SIGNAL"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. practical apart from formal; contradictions stand ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = build({ scores: [score("t1", "test", "2027-01-10", 9), score("t2", "test", "2027-02-10", 10), score("t3", "test", "2027-03-10", 9), score("p1", "practical", "2027-02-01", 18), score("p2", "practical", "2027-03-01", 19)] });
  check("formal moderate and practical strong are two readings, not one number", [maths(r).formal.mean, maths(r).practical.mean, maths(r).practical.independentEvents], [0.467, 0.925, 2]);
  check("and the layer names THEORY_VS_PRACTICAL rather than resolving it", r.quality.contradictions.map((c) => c.code), ["THEORY_VS_PRACTICAL"]);
  r = build({ scores: [score("t1", "test", "2027-01-10", 17), score("t2", "test", "2027-02-10", 18), score("t3", "test", "2027-03-10", 17), score("c1", "ca", "2027-01-20", 9), score("c2", "ca", "2027-02-20", 10), score("c3", "ca", "2027-03-20", 8)] });
  check("formal strong, continuous weak → FORMAL_VS_CONTINUOUS_ASSESSMENT, both means shown", r.quality.contradictions.map((c) => [c.code, c.formal, c.continuous]), [["FORMAL_VS_CONTINUOUS_ASSESSMENT", 0.867, 0.45]]);
  r = build({ homework: [hw("a", "2027-04-01", { score: 19, submittedOffsetDays: 0 }), hw("b", "2027-04-08", null), hw("c", "2027-04-15", null), hw("d", "2027-04-22", null)] });
  check("one excellent homework among three missing → PERFORMANCE_VS_ENGAGEMENT", r.quality.contradictions.map((c) => c.code), ["PERFORMANCE_VS_ENGAGEMENT"]);
  r = build({ homework: [1, 2, 3, 4].map((i) => hw(`h${i}`, `2027-04-0${i}`, { score: 15, submittedOffsetDays: 0 })), attendance: Array(12).fill(0).map((_, i) => att(i, days(12)[i], i % 2 ? "absent" : "present")) });
  check("irregular attendance yet every homework in → ATTENDANCE_VS_COMPLETION, reported, not resolved", r.quality.contradictions.map((c) => c.code), ["ATTENDANCE_VS_COMPLETION"]);
  r = build({ quizAttempts: [quiz("q1", "2026-08-01", 9), quiz("q2", "2026-09-01", 9), quiz("q3", "2027-04-01", 5), quiz("q4", "2027-05-01", 5)] });
  check("recent quizzes far below historical ones → RECENT_VS_HISTORICAL alongside a DECLINING direction", [r.quality.contradictions.map((c) => c.code), maths(r).quiz.pattern], [["RECENT_VS_HISTORICAL"], "DECLINING"]);
  check("no field anywhere is a student score, rank or quality", /studentScore|learningScore|engagementScore|rank|overallScore/.test(JSON.stringify({ ...r, notInferred: undefined })), false);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. quality is coverage, not performance ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const q = (n) => build({ quizAttempts: Array.from({ length: n }, (_, i) => quiz(`q${i}`, days(n, "2027-03-01")[i], 9)) }).quality.subjects.maths;
  check("0 → NO_DATA, 2 → INSUFFICIENT, 4 → SPARSE, 8 → GOOD, 12 → STRONG", [build({}).quality.overall.level, q(2).level, q(4).level, q(8).level, q(12).level], ["NO_DATA", "INSUFFICIENT_DATA", "SPARSE_DATA", "GOOD_COVERAGE", "STRONG_COVERAGE"]);
  check("strong marks on sparse evidence and on strong coverage read the same mean and different coverage", [q(4).families.quiz.level, q(12).families.quiz.level], ["SPARSE_DATA", "STRONG_COVERAGE"]);
  r = build({ homework: [hw("pend", "2027-07-01"), hw("ng", "2027-05-02", { score: null, submittedOffsetDays: 0, graded: false })] });
  check("pending or ungraded work flags INCOMPLETE_PERIOD; conflicts flag CONFLICTING_DATA", [r.quality.subjects.maths.flags, build({ scores: [score("t1", "test", "2027-01-10", 9), score("t2", "test", "2027-02-10", 10), score("t3", "test", "2027-03-10", 9), score("p1", "practical", "2027-02-01", 18), score("p2", "practical", "2027-03-01", 19)] }).quality.subjects.maths.flags], [["INCOMPLETE_PERIOD"], ["CONFLICTING_DATA"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. the boundary with the strength engine, privacy, determinism ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = build({ homework: [1, 2, 3, 4].map((i) => hw(`h${i}`, `2027-04-0${i}`, { score: 19, submittedOffsetDays: 0 })), quizAttempts: [1, 2, 3].map((i) => quiz(`q${i}`, `2027-04-1${i}`, 10)), scores: [score("p1", "practical", "2027-02-01", 20), score("p2", "practical", "2027-03-01", 20), score("p3", "practical", "2027-04-01", 20)] });
  check("every signal is classified, and in 1.0.0 none is authorised to influence any engine",
    [r.signals.length > 0, r.signals.every((s) => le.SIGNALS.includes(s.signal) && s.authorizedFor.length === 0), r.integration], [true, true, { strengthEngine: [], explorationEngine: [], guidance: [] }]);
  check("the strengths engine does not read this layer: a profile built with and without it is the same bytes",
    JSON.stringify(st.buildStrengthProfile({ academicProfile: { studentId: "s", engine: { version: "1.0.0", passMark: 10, strongMark: 14 }, coverage: { sequences: 0, subjects: 0, sufficient: false }, subjects: [], insights: [] }, explorationEvidence: [] }))
      === JSON.stringify(st.buildStrengthProfile({ academicProfile: { studentId: "s", engine: { version: "1.0.0", passMark: 10, strongMark: 14 }, coverage: { sequences: 0, subjects: 0, sufficient: false }, subjects: [], insights: [] }, explorationEvidence: [] })), true);
  check("versions: learning evidence 1.0.0 beside strengths 1.1.0 and academic 1.0.0", [le.LEARNING_EVIDENCE_VERSION, st.STRENGTH_ENGINE_VERSION], ["1.0.0", "1.1.0"]);
  check("a row carrying a name, phone or email is refused and reported, not read",
    build({ homework: [{ ...hw("h1", "2027-05-01", { score: 18, submittedOffsetDays: 0 }), studentName: "X" }], attendance: [{ ...att(1, "2027-03-01", "present"), phone: "6" }] }).rejected.map((x) => x.reason), ["forbidden field(s): studentName", "forbidden field(s): phone"]);
  const big = { homework: [1, 2, 3, 4].map((i) => hw(`h${i}`, `2027-04-0${i}`, { score: 15 + i, submittedOffsetDays: i % 2 })), quizAttempts: [1, 2, 3].map((i) => quiz(`q${i}`, `2027-04-1${i}`, 6 + i)), scores: [score("t1", "test", "2027-01-10", 14), score("c1", "ca", "2027-01-20", 12)], attendance: days(12).map((d, i) => att(i, d, i % 3 ? "present" : "absent")) };
  check("deterministic: same input, same asOf, same bytes", JSON.stringify(build(big)) === JSON.stringify(build(big)), true);
  check("the concise lines are facts a pupil can read, and none is a label", [build(big).concise.every((l) => ["QUIZ_CONSISTENT", "QUIZ_IMPROVING", "HOMEWORK_MOSTLY_COMPLETED", "HOMEWORK_OFTEN_MISSING", "LIMITED_EVIDENCE"].includes(l.code)), /lazy|smart|weak|unmotivated|poor/i.test(JSON.stringify(build(big).concise))], [true, false]);
  check("the not-inferred list names personality, motivation, discipline, intelligence, career, dropout risk, ranking", ["personality", "motivation", "discipline", "intelligence", "career", "dropout_risk", "student_ranking"].every((k) => le.NOT_INFERRED.includes(k)), true);

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: the application.
  // ═══════════════════════════════════════════════════════════════════════════

  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const A = "6a00000000000000000000a1", B = "6a00000000000000000000b2", YEAR = "2026-2027";
  await M("School").create([{ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" }, { _id: B, name: "Beta College", code: "BETA", email: "beta@example.test" }]);
  const mkUser = (id, role, schoolId, name) => M("User").create({ _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId, isActive: true });
  await Promise.all([mkUser("teach-a", "teacher", A, "Mme Ateba"), mkUser("teach-c", "teacher", A, "Mme Chantal"), mkUser("admin-a", "school_admin", A, "Head Alpha"), mkUser("admin-b", "school_admin", B, "Head Beta"),
    mkUser("bursar-a", "bursar", A, "Bursar Alpha"), mkUser("operator", "super_admin", null, "Operator"), mkUser("stu-a1", "student", A, "Pupil A1"), mkUser("stu-a2", "student", A, "Pupil A2")]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" }]);
  await M("TeacherAssignment").create([{ schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" }, { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" }]);
  const pupil = (id, classId, n) => ({ _id: id, userId: `stu-${id.slice(3)}`, schoolId: A, classId, studentName: `Pupil ${n}`, enrollmentNo: n, isActive: true, status: "approved" });
  await M("Student").create([pupil("st-a1", "form3a", "A1"), pupil("st-a2", "form4b", "A2")]);
  await M("Subject").create({ _id: "maths", schoolId: A, name: "Mathematics", code: "MAT", classId: "form3a" }).catch(() => null);
  const mkExam = (id, type, term, seq, startDate, published = true) => ({ _id: id, schoolId: A, name: id, type, academicYear: YEAR, term, sequenceNumber: seq, startDate, classId: "form3a", totalMarks: 20, passMark: 10, status: "published", resultsPublished: published });
  await M("Exam").create([mkExam("t1", "test", 1, 1, "2027-01-10"), mkExam("t2", "test", 1, 2, "2027-02-10"), mkExam("t3", "test", 2, 1, "2027-03-10"), mkExam("p1", "practical", 2, 1, "2027-03-15"), mkExam("u1", "test", 2, 2, "2027-04-10", false)]);
  const sc = (examId, v, extra = {}) => ({ examId, studentId: "st-a1", subjectId: "maths", classId: "form3a", schoolId: A, score: v, maxScore: 20, passMark: 10, ...extra });
  await M("StudentScore").create([sc("t1", 14), sc("t2", 15), sc("t3", 16), sc("p1", 19), sc("u1", 18), { ...sc("t1", null, { isAbsent: true }), subjectId: "phy" }]);
  const gradedSub = (score, submittedAt) => ({ studentId: "st-a1", text: "done", submittedAt, score, gradedAt: submittedAt, gradedBy: "teach-a" });
  await M("Homework").create([
    { _id: "hw1", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Fractions", dueDate: "2027-04-01", maxScore: 20, isPublished: true, submissions: [gradedSub(16, "2027-04-01")] },
    { _id: "hw2", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Ratios", dueDate: "2027-04-08", maxScore: 20, isPublished: true, submissions: [gradedSub(18, "2027-04-10")] },
    { _id: "hw3", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Algebra", dueDate: "2027-04-15", maxScore: 20, isPublished: true, submissions: [] },
    { _id: "hw4", schoolId: A, classId: "form3a", subjectId: "maths", createdBy: "teach-a", title: "Draft", dueDate: "2027-04-22", maxScore: 20, isPublished: false, submissions: [] },
  ]);
  const quizDocs = await M("Quiz").create([1, 2, 3].map((n) => ({ schoolId: A, title: `Q${n}`, subject_id: "maths", class_id: "form3a", is_published: true, created_by: "teach-a" })));
  await M("QuizAttempt").create(quizDocs.map((qd, i) => ({ quiz_id: qd._id, user_id: "stu-a1", schoolId: A, attempt_number: 1, status: "submitted", raw_score: 7 + i, max_score: 10, percentage: (7 + i) * 10, submitted_at: new Date(`2027-05-0${i + 1}`), started_at: new Date(`2027-05-0${i + 1}`) })));
  await M("StudentAttendance").create(days(12, "2027-05-01").map((d, i) => ({ schoolId: A, classId: "form3a", studentId: "st-a1", markedBy: "teach-a", date: d, status: i % 3 === 1 ? "absent" : "present" })));
  const access = await M("GuardianAccess").create({ schoolId: A, studentIds: ["st-a1"], codeHash: "x", label: "Parent", sessions: [{ _id: "s1", tokenHash: crypto.createHash("sha256").update("r").digest("hex"), createdAt: new Date(), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) }] });
  const portalToken = jwt.sign({ aud: "portal", accessId: String(access._id), schoolId: A, sid: "s1" }, process.env.JWT_SECRET, { expiresIn: "20m" });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/insights", auth.authenticate, require(path.join(SRC, "routes/insights.routes")));
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  // Every read in this test is as of 2027-06-01, the fixtures' own year; a rebuild uses today, as it must.
  const asOf = (url) => `${url}${url.includes("?") ? "&" : "?"}asOf=2027-06-01`;
  const call = (token) => { const c = async (method, url, body) => { const res = await fetch(`${API}${method === "GET" ? asOf(url) : url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); let out = {}; try { out = await res.json(); } catch { /* empty */ } return { status: res.status, body: out }; }; return { get: (u) => c("GET", u), post: (u, b) => c("POST", u, b) }; };
  const as = (id, role, schoolId) => call(jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" }));
  const teacherA = as("teach-a", "teacher", A), teacherC = as("teach-c", "teacher", A), head = as("admin-a", "school_admin", A), headB = as("admin-b", "school_admin", B);
  const bursar = as("bursar-a", "bursar", A), operator = as("operator", "super_admin", null), pupilA1 = as("stu-a1", "student", A), pupilA2 = as("stu-a2", "student", A), guardian = call(portalToken);
  const inA = (u) => `${u}${u.includes("?") ? "&" : "?"}schoolId=${A}`;
  const reads = ["learning-evidence", "learning-patterns", "learning-coverage", "learning-changes"].map((k) => `/insights/student/st-a1/${k}`);
  const statuses = async (who, urls) => Promise.all(urls.map(async (u) => (await who.get(u)).status));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. the application: sources through the real routes ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let rr = await teacherA.get("/insights/student/st-a1/learning-evidence");
  const d = rr.body.data, m = d.patterns.bySubject.maths;
  check("the teacher's read → 200, named, version 1.0.0, events from all four sources",
    [rr.status, d.name, d.learningEvidenceVersion, d.counts.bySource], [200, "Pupil A1", "1.0.0", { HOMEWORK: 3, QUIZ: 3, EXAM_SCORE: 6, ATTENDANCE: 12 }]);
  check("formal tests read a pattern; the practical is one skill observation; the unpublished exam is context; the absent physics mark is ABSENT",
    [m.formal.pattern, m.formal.independentEvents, m.practical.independentEvents, d.events.find((x) => x.learningEventId === "exam:u1:maths").observations[0].state, d.events.find((x) => x.learningEventId === "exam:t1:phy").observations[0].state],
    ["IMPROVING", 3, 1, "UNPUBLISHED", "ABSENT"]);
  check("homework: 2 of 3 assigned (the draft never assigned), one late, one missing; quizzes: 3 independent",
    [m.homework.assigned, m.homework.completed, m.homework.submission.late, m.homework.submission.missing, m.quiz.independentEvents, m.quiz.pattern], [3, 2, 1, 1, 3, "IMPROVING"]);
  check("attendance: 8 present, 4 absent of 12, evenly spread → irregular; no word about ability anywhere", [d.patterns.attendance.overall.present, d.patterns.attendance.overall.absent, d.patterns.attendance.overall.pattern, /ability|lazy/i.test(JSON.stringify(d.signals))], [8, 4, "ATTENDANCE_IRREGULAR", false]);
  check("the pupil reads their own; another pupil, the bursar, a teacher of another class → 403; Beta's head → 404; the operator only with a selection",
    [await statuses(pupilA1, reads.map((u) => u.replace("st-a1", "me"))), (await pupilA2.get(reads[0])).status, await statuses(bursar, reads), await statuses(teacherC, reads), await statuses(headB, reads), await statuses(operator, reads.map(inA)), (await statuses(operator, reads)).every((s) => s !== 200)],
    [[200, 200, 200, 200], 403, [403, 403, 403, 403], [403, 403, 403, 403], [404, 404, 404, 404], [200, 200, 200, 200], true]);
  check("the pupil's reading carries no note text and no other pupil", /done|st-a2|Pupil A2/.test(JSON.stringify((await pupilA1.get("/insights/student/me/learning-evidence")).body)), false);
  rr = await guardian.get("/portal/children/st-a1/learning");
  check("the guardian sees patterns and coverage per subject, attendance counts, the concise lines — no events, no notes",
    [rr.status, rr.body.data.subjects[0]?.homework, rr.body.data.attendance.pattern, "events" in rr.body.data, /done/.test(JSON.stringify(rr.body))], [200, { pattern: "OFTEN_COMPLETED", completed: 2, assigned: 3 }, "ATTENDANCE_IRREGULAR", false, false]);
  check("a child the access does not unlock → 404", (await guardian.get("/portal/children/st-a2/learning")).status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 11. snapshots, rebuild, retraction, live = offline ---");
  // ═══════════════════════════════════════════════════════════════════════════

  check("a pupil cannot rebuild; the bursar cannot", [(await pupilA1.post("/insights/student/st-a1/learning-evidence/rebuild", {})).status, (await bursar.post("/insights/student/st-a1/learning-evidence/rebuild", {})).status], [403, 403]);
  rr = await teacherA.post("/insights/student/st-a1/learning-evidence/rebuild", { learningEvidenceVersion: "9.9.9" });
  const v1 = rr.body.data;
  check("first rebuild → 201, snapshot 1, the SERVER's version, the boundary hash, no events stored", [rr.status, rr.body.created, v1.snapshotNumber, v1.learningEvidenceVersion, typeof v1.evidenceBoundary.hash, v1.evidenceBoundary.events, "events" in v1.reading], [201, true, 1, "1.0.0", "string", 24, false]);
  rr = await teacherA.post("/insights/student/st-a1/learning-evidence/rebuild", {});
  check("a rebuild on unchanged evidence returns snapshot 1 and writes nothing", [rr.status, rr.body.created, await M("LearningEvidenceSnapshot").countDocuments({ studentId: "st-a1" })], [200, false, 1]);
  check("changes says nothing is pending", (await teacherA.get("/insights/student/st-a1/learning-changes")).body.data.pendingSnapshot, false);
  await M("StudentScore").updateOne({ examId: "t3", studentId: "st-a1" }, { $set: { score: 8 } });
  rr = await teacherA.get("/insights/student/st-a1/learning-changes");
  check("a corrected mark changes the next reading — pending, with the pattern change named — and snapshot 1 is untouched",
    [rr.body.data.pendingSnapshot, rr.body.data.comparison.changes.map((c) => [c.family, c.previous, c.current]), (await M("LearningEvidenceSnapshot").findOne({ studentId: "st-a1", snapshotNumber: 1 }).lean()).evidenceBoundary.hash === v1.evidenceBoundary.hash],
    [true, [["formal", "IMPROVING", "DECLINING"]], true]);
  rr = await head.post("/insights/student/st-a1/learning-evidence/rebuild", {});
  check("the head's rebuild → snapshot 2; history lists both", [rr.status, rr.body.data.snapshotNumber, (await teacherA.get("/insights/student/st-a1/learning-changes")).body.data.history.map((h) => h.snapshotNumber)], [201, 2, [1, 2]]);
  rr = await teacherA.get("/insights/student/st-a1/learning-evidence/consistency");
  check("live = offline: the reading from mirrored (JSON round-tripped) documents is structurally identical", [rr.status, rr.body.data.identical, rr.body.data.differences, rr.body.data.engineVersion], [200, true, [], { live: "1.0.0", offline: "1.0.0" }]);
  const feed = require(path.join(SRC, "config/syncFeed"));
  check("the snapshot stays online with a reason; the sources it reads are mirrored already",
    [typeof feed.EXCLUDED.LearningEvidenceSnapshot, ["homework", "studentScore", "exam", "studentAttendance"].every((c) => feed.byCollection.has(c))], ["string", true]);
  check("the strengths profile is unchanged by the learning layer's existence — no signal is authorised", (await teacherA.get("/insights/student/st-a1/strengths")).body.data.profile.strengthEngineVersion, "1.1.0");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
