// desktop/scripts/check-process-rules.js
"use strict";
/**
 * Exam processing is the server's: the desk never computes a result summary.
 *
 * Every school's results are the decided calculation (shared/academicRules,
 * docs/39 §21.1): CA blended by the school's split, coefficients, a subject
 * with no paper mark left out, a published result never recomputed. The desk
 * used to compute the old raw-mark mean (12 for 15 and 9 on /20, where the
 * decided calculation with Maths ×2 gives (2·15 + 9)/3 = 13), a second answer
 * for the same marks. It now declines (null), which sends the request to the
 * server (the dispatcher's contract, src/main/api/index.js), whatever the
 * school's settings.
 *
 * Run by `npm run check:process-rules`, part of the desktop `check` chain.
 */
const api = require("../src/main/api");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const YEAR = "2026/2027";
const fresh = (rules, summaries = [], gradingConfig = []) => ({
  exam:        [{ _id: "e1", schoolId: "S1", classId: "c1", academicYear: YEAR, term: 1, sequenceNumber: 1, status: "ongoing", deletedAt: null }],
  examSubject: [{ _id: "es1", examId: "e1", schoolId: "S1", classId: "c1", subjectId: "x1", subjectName: "Mathematics", maxScore: 20, weight: 200, deletedAt: null },
                { _id: "es2", examId: "e1", schoolId: "S1", classId: "c1", subjectId: "x2", subjectName: "English", maxScore: 20, weight: 100, deletedAt: null }],
  studentScore: [
    { _id: "m1", examId: "e1", schoolId: "S1", classId: "c1", studentId: "s1", subjectId: "x1", score: 15, maxScore: 20, deletedAt: null },
    { _id: "m2", examId: "e1", schoolId: "S1", classId: "c1", studentId: "s1", subjectId: "x2", score: 9,  maxScore: 20, deletedAt: null },
  ],
  gradingConfig,
  academicStructure: rules === undefined ? [] : [{ _id: "as1", schoolId: "S1", academicYear: YEAR, rules, deletedAt: null }],
  resultSummary: summaries,
});

const run = async (rows) => {
  let queued = 0;
  const ctx = {
    session: { userId: "adm-1", role: "school_admin", schoolId: "S1" },
    docs: {
      find: (c, q = {}) => (rows[c] || []).filter((r) => Object.entries(q).every(([k, v]) => String(r[k] ?? null) === String(v))),
      get:  (c, id) => (rows[c] || []).find((r) => String(r._id) === String(id)),
      put:  (c, d) => { const list = (rows[c] = rows[c] || []); const i = list.findIndex((r) => String(r._id) === String(d._id)); if (i >= 0) list[i] = d; else list.push(d); return d._id; },
      tx:   (fn) => fn(),
    },
    meta: { get: () => null, set: () => {} },
    queue: { add: () => { queued += 1; return { seq: 1, duplicate: false }; } },
    state: {},
  };
  const before = JSON.stringify(rows.resultSummary);
  const r = await api.handle({ method: "POST", path: "/api/exams/e1/process", query: {}, body: { classId: "c1" } }, ctx);
  return { r, queued, unchanged: JSON.stringify(rows.resultSummary) === before };
};

(async () => {
  console.log("\n--- the desk never answers exam processing itself ---");
  const published = [{ _id: "rs1", examId: "e1", schoolId: "S1", classId: "c1", studentId: "s1", average: 11, isPublished: true, deletedAt: null }];
  const cases = [
    ["no structure mirrored",                          fresh(undefined)],
    ["rules unset",                                    fresh(null)],
    ["an old Phase 4 rule still stored (raw_mean)",    fresh({ sequenceAverage: "raw_mean" })],
    ["CA off on the school's grading config",          fresh(null, [], [{ _id: "gc1", schoolId: "S1", caEnabled: false }])],
    ["a published summary already there",             fresh(null, published.map((s) => ({ ...s })))],
  ];
  for (const [label, rows] of cases) {
    const { r, queued, unchanged } = await run(rows);
    check(`${label}: declined (sent to the server), nothing written or queued`, [r, queued, unchanged], [null, 0, true]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e.stack || e.message); process.exit(1); });
