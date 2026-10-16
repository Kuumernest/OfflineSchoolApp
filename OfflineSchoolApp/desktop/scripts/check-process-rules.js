// desktop/scripts/check-process-rules.js
"use strict";
/**
 * Offline exam processing follows the year's calculation rules, or leaves the
 * request to the server.
 *
 * The local POST /api/exams/:examId/process computes the default rule
 * (raw_mean: the whole-number mean of the papers). Under weighted_20 the
 * server stores a different figure, and under publishedResults "refuse" it
 * refuses to touch a published result — so in either case the desk must not
 * answer with its own figures. It declines (null), which sends the request to
 * the server (the dispatcher's contract, src/main/api/index.js).
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
const fresh = (rules, summaries = []) => ({
  exam:        [{ _id: "e1", schoolId: "S1", classId: "c1", academicYear: YEAR, term: 1, sequenceNumber: 1, status: "ongoing", deletedAt: null }],
  examSubject: [{ _id: "es1", examId: "e1", schoolId: "S1", classId: "c1", subjectId: "x1", subjectName: "Mathematics", maxScore: 20, deletedAt: null },
                { _id: "es2", examId: "e1", schoolId: "S1", classId: "c1", subjectId: "x2", subjectName: "English", maxScore: 20, deletedAt: null }],
  studentScore: [
    { _id: "m1", examId: "e1", schoolId: "S1", classId: "c1", studentId: "s1", subjectId: "x1", score: 15, maxScore: 20, deletedAt: null },
    { _id: "m2", examId: "e1", schoolId: "S1", classId: "c1", studentId: "s1", subjectId: "x2", score: 9,  maxScore: 20, deletedAt: null },
  ],
  gradingConfig: [],
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
  const r = await api.handle({ method: "POST", path: "/api/exams/e1/process", query: {}, body: { classId: "c1" } }, ctx);
  return { r, queued, summaries: rows.resultSummary.filter((s) => !s.deletedAt) };
};

(async () => {
  console.log("\n--- the default rule is computed on the desk, as before ---");
  for (const [label, rules] of [["no structure mirrored", undefined], ["rules unset", null], ["every rule at its default", { sequenceAverage: "raw_mean", publishedResults: "overwrite" }]]) {
    const { r, queued, summaries } = await run(fresh(rules));
    // round((15 + 9) / 2) = 12, 24/40 = 60 %.
    check(`${label}: answered here, queued, s1 = 12 (60 %)`,
      [r?.status ?? null, queued, summaries.map((s) => [s.average, s.percentage])], [200, 1, [[12, 60]]]);
  }

  console.log("\n--- weighted_20: the server's figure, not the desk's ---");
  {
    const { r, queued, summaries } = await run(fresh({ sequenceAverage: "weighted_20" }));
    check("declined (sent to the server), nothing written or queued", [r, queued, summaries.length], [null, 0, 0]);
  }

  console.log("\n--- refuse: a published result is not recomputed on the desk ---");
  const published = [{ _id: "rs1", examId: "e1", schoolId: "S1", classId: "c1", studentId: "s1", average: 11, isPublished: true, deletedAt: null }];
  {
    const rows = fresh({ publishedResults: "refuse" }, published.map((s) => ({ ...s })));
    const { r, queued, summaries } = await run(rows);
    check("declined, nothing queued, the published 11 untouched", [r, queued, summaries.map((s) => s.average)], [null, 0, [11]]);
  }
  {
    const rows = fresh({ publishedResults: "refuse" }, published.map((s) => ({ ...s, isPublished: false })));
    const { r, queued } = await run(rows);
    check("refuse with nothing published: computed here as usual", [r?.status ?? null, queued], [200, 1]);
  }
  {
    const rows = fresh({ publishedResults: "overwrite" }, published.map((s) => ({ ...s })));
    const { r, queued } = await run(rows);
    check("overwrite (the default) with a published result: computed here as before", [r?.status ?? null, queued], [200, 1]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e.stack || e.message); process.exit(1); });
