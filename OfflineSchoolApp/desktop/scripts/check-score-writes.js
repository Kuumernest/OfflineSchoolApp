// desktop/scripts/check-score-writes.js
"use strict";
/**
 * The offline mark-sheet write grades a mark the way the server does.
 *
 * A row without its own maxScore is graded against the ExamSubject's maximum
 * (the server's rule: the row's, else the paper's). The old fallback here was
 * exam.passMark — a pass mark out of 20, not a maximum — so a row that arrived
 * without maxScore was graded against 10, and 15/20 became 150% and "A+" on
 * the desk until the server replaced the row. The letter itself comes from
 * shared/gradeScale through gradeUtils, the same table the server grades with.
 *
 * Run by `npm run check:score-writes`, part of the desktop `check` chain.
 */
const api = require("../src/main/api");
const { GRADE_SCALE } = require("../../shared/gradeScale");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};
const letter = (m) => GRADE_SCALE.find((b) => m >= b.min)?.grade ?? null;

const rows = {
  exam:        [{ _id: "e1", schoolId: "S1", classId: "c1", passMark: 10, totalMarks: 20, status: "ongoing" }],
  examSubject: [{ _id: "es1", examId: "e1", schoolId: "S1", classId: "c1", subjectId: "x1", subjectName: "Mathematics", maxScore: 20 },
                { _id: "es2", examId: "e1", schoolId: "S1", classId: "c1", subjectId: "x2", subjectName: "Practical", maxScore: 50 }],
  gradingConfig: [],
  studentScore: [],
};
const ctx = {
  session: { userId: "tea-1", role: "teacher", schoolId: "S1" },
  docs: {
    find: (c, q = {}) => (rows[c] || []).filter((r) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v))),
    get:  (c, id) => (rows[c] || []).find((r) => String(r._id) === String(id)),
    put:  (c, d) => { const list = (rows[c] = rows[c] || []); const i = list.findIndex((r) => String(r._id) === String(d._id)); if (i >= 0) list[i] = d; else list.push(d); },
    // handle() commits the doc, its `also` docs and the outbox entry in one transaction.
    tx:   (fn) => fn(),
  },
  meta: { get: () => null, set: () => {} },
  queue: { add: () => ({ seq: 1, duplicate: false }) },
  state: {},
};

(async () => {
  console.log("\n--- a row without maxScore is graded against the paper's maximum, not the pass mark ---");
  const r1 = await api.handle({ method: "POST", path: "/api/exams/e1/scores/bulk", params: { examId: "e1" }, query: {}, body: { classId: "c1", subjectId: "x1", scores: [{ studentId: "s1", examSubjectId: "es1", score: 15 }, { studentId: "s2", score: 8 }] } }, ctx);
  const saved = rows.studentScore;
  // handle() answers with the handler's response plus the queue envelope: { status, data, queued, seq, duplicate }.
  check("two rows written offline, queued for the server", [r1?.status ?? null, r1?.queued ?? null, saved.length], [201, true, 2]);
  const s1 = saved.find((x) => x.studentId === "s1"), s2 = saved.find((x) => x.studentId === "s2");
  check("15 with no maxScore on the row → 20 from the ExamSubject named by examSubjectId; 75%; the scale's letter for 15/20", [s1.maxScore, s1.percentage, s1.grade], [20, 75, letter(15)]);
  check("8 with neither maxScore nor examSubjectId → the ExamSubject found by exam, subject and class; 40%; the scale's letter for 8/20", [s2.maxScore, s2.percentage, s2.grade], [20, 40, letter(8)]);
  check("neither row was graded against the pass mark", saved.some((x) => x.maxScore === 10), false);

  console.log("\n--- a paper out of 50 keeps its own maximum ---");
  rows.studentScore = [];
  await api.handle({ method: "POST", path: "/api/exams/e1/scores/bulk", params: { examId: "e1" }, query: {}, body: { classId: "c1", subjectId: "x2", scores: [{ studentId: "s1", score: 40 }] } }, ctx);
  const p = rows.studentScore[0];
  check("40 on a /50 paper → max 50, 80%, graded as 16/20", [p.maxScore, p.percentage, p.grade], [50, 80, letter(16)]);

  console.log("\n--- a row that names its own maxScore is left alone ---");
  rows.studentScore = [];
  await api.handle({ method: "POST", path: "/api/exams/e1/scores/bulk", params: { examId: "e1" }, query: {}, body: { classId: "c1", subjectId: "x1", scores: [{ studentId: "s1", score: 9, maxScore: 10 }] } }, ctx);
  check("9/10 stays /10 → 90%, graded as 18/20", [rows.studentScore[0].maxScore, rows.studentScore[0].percentage, rows.studentScore[0].grade], [10, 90, letter(18)]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e.stack || e.message); process.exit(1); });
