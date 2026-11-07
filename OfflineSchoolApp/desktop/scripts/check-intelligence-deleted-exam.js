"use strict";

/**
 * The offline class insights ignore a deleted exam, as the server does.
 *
 * Deleting an exam only stamps deletedAt on the Exam; its resultSummary rows
 * stay in the mirror. The server's loader drops them
 * (academicHistory.publishedHistory, services/deletedExams.service); the
 * desktop's historyFor read them, so a desk offline counted a deleted exam as
 * a sequence and its marks as evidence.
 *
 *   ama, Mathematics /20, published, 2026/2027 term 1:
 *     s1  Sequence 1   12
 *     s2  Sequence 2   13
 *     sd  Sequence 3    3   ← exam DELETED
 *
 *   GET /api/insights/class/f1   ama's coverage: 2 sequences, not 3
 *
 * Run by `npm run check:intel-deleted`, part of the desktop `check` chain.
 */

const api = require("../src/main/api");
const { open, documents } = require("../src/main/db/store");

const db = open(":memory:");
const ctx = {
  docs: documents(db),
  session: { userId: "admin-1", schoolId: "S1", role: "school_admin",
             permissions: require("../../backend/src/config/permissions").DEFAULTS_BY_ROLE.school_admin },
  queue: { add: () => ({ seq: 1, duplicate: false }) },
};

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}` +
    (ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const call = (method, path, query = {}) => api.handle({ method, path, query, body: {} }, ctx);

const YEAR = "2026/2027";
ctx.docs.putMany("student", [{
  _id: "ama", schoolId: "S1", classId: "f1", studentName: "Pupil ama",
  enrollmentNo: "EN-ama", status: "approved", deletedAt: null,
}]);
ctx.docs.putMany("gradingConfig", [{ _id: "g1", schoolId: "S1", passMark: 10 }]);
const exam = (_id, seq, startDate, deletedAt = null) => ({
  _id, schoolId: "S1", classId: "f1", classIds: ["f1"], name: `Sequence ${seq}`, type: "test",
  academicYear: YEAR, term: 1, sequenceNumber: seq, startDate, deletedAt,
});
ctx.docs.putMany("exam", [
  exam("s1", 1, "2026-09-15"), exam("s2", 2, "2026-10-10"), exam("sd", 3, "2026-10-20", "2026-10-25T00:00:00.000Z"),
]);
const summary = (examId, mark) => ({
  _id: `r-${examId}`, examId, studentId: "ama", classId: "f1", schoolId: "S1", academicYear: YEAR, term: "1",
  average: mark, isPublished: true, deletedAt: null, createdAt: "2026-10-26T00:00:00.000Z",
  subjectBreakdown: [{ subjectId: "maths", subjectName: "Mathematics", score: mark, maxScore: 20,
    normalizedMark: mark, coefficient: 1, isPassing: mark >= 10 }],
});
ctx.docs.putMany("resultSummary", [summary("s1", 12), summary("s2", 13), summary("sd", 3)]);

const res = call("GET", "/api/insights/class/f1");
const row = res?.data?.data?.students?.find((s) => s.studentId === "ama");
check("the class insights answer offline", res?.status, 200);
check("two sequences, not three: the deleted exam is not one", row?.coverage?.sequences, 2);

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nALL PASS");
