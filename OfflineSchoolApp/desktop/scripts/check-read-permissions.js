// desktop/scripts/check-read-permissions.js
"use strict";

/**
 * Audit F6: a local read answers only someone the server would answer.
 *
 * The mirror on a shared computer holds what the most privileged account that
 * synced there could pull. The fee, student, results and attendance read
 * handlers checked the school and nothing else, so a teacher signed in after a
 * bursar was answered from the bursar's fee ledgers — a request the server
 * refuses with 403.
 *
 * Pinned here:
 *   - a session without the server route's permission (or role) is declined
 *     locally (null → the request goes to the server, which decides);
 *   - a session with it is answered exactly as before;
 *   - no session: declined;
 *   - every permission named is a real key in backend/src/config/permissions.js;
 *   - declining changes nothing on disk.
 *
 *   node scripts/check-read-permissions.js
 */

const api = require("../src/main/api");
const { open, documents } = require("../src/main/db/store");
const { DEFAULTS_BY_ROLE, isPermission } = require("../../backend/src/config/permissions");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const db   = open(":memory:");
const docs = documents(db);

docs.putMany("student", [
  { _id: "s1", schoolId: "S1", firstName: "Ada", lastName: "N", classId: "c1", status: "approved", deletedAt: null },
]);
docs.putMany("feeCharge", [
  { _id: "fc1", schoolId: "S1", studentId: "s1", academicYear: "2026-2027", amount: 50000,
    waivedAmount: 0, dueDate: "2026-01-01", deletedAt: null },
]);

const session = (role, extra = {}) => ({
  userId: `${role}-1`, schoolId: "S1", role, permissions: DEFAULTS_BY_ROLE[role] ?? [], ...extra,
});
const get = (path, s, query = { schoolId: "S1" }) =>
  api.handle({ method: "GET", path, query }, { docs, session: s, queue: { add: () => ({ seq: 1 }) }, state: {} });

const diskBefore = JSON.stringify(db.prepare("SELECT collection, id, json, pending FROM docs ORDER BY collection, id").all());

// ── The case that was the finding ──────────────────────────────────────────
const bursar = get("/api/fees/outstanding", session("bursar"));
check("bursar (fees.view): outstanding answered locally", bursar?.status, 200);
check("teacher (no fees.view): outstanding declined → server decides",
  get("/api/fees/outstanding", session("teacher")), null);
check("teacher: one pupil's fee ledger declined",
  get("/api/fees/students/s1", session("teacher")), null);
check("no session: declined", get("/api/fees/outstanding", null), null);
check("a bursar whose school revoked fees.view: declined",
  get("/api/fees/outstanding", session("bursar", { permissions: DEFAULTS_BY_ROLE.bursar.filter((p) => p !== "fees.view") })),
  null);

// ── Every guarded route ────────────────────────────────────────────────────
const handlers = [
  ...require("../src/main/api/handlers/fees"),
  ...require("../src/main/api/handlers/students"),
  ...require("../src/main/api/handlers/results"),
  ...require("../src/main/api/handlers/attendance"),
];
const guarded = handlers.filter((h) => h.requires);
const expected = [
  "GET /api/fees/plans", "GET /api/fees/structures", "GET /api/fees/outstanding",
  "GET /api/fees/students/:studentId", "GET /api/fees/penalties", "GET /api/fees/reminders",
  "GET /api/admin/students/pending", "GET /api/admin/students", "GET /api/admin/students/approved",
  "GET /api/admin/students/stats", "GET /api/admin/students/:id", "GET /api/students/:id/editable",
  "GET /api/students/stats/summary",
  "GET /api/results/:examId", "GET /api/results/:examId/stats", "GET /api/results/:examId/rankings",
  "GET /api/results/:examId/student/:studentId",
  "GET /api/admin/attendance/stats", "GET /api/attendance/report/overview",
  "GET /api/attendance/report/weekly", "GET /api/attendance/report/class/:classId",
  "GET /api/attendance/teachers/roster", "GET /api/attendance/teachers",
  "GET /api/attendance/students/roster",
];
check("every fee/student/results/attendance read the server guards is guarded",
  expected.filter((r) => !guarded.some((h) => h.route === r)), []);
check("every permission named is a real permission key",
  guarded.flatMap((h) => h.requires.permissions ?? []).filter((p) => !isPermission(p)), []);

// A session holding nothing: every guarded handler declines before it reads.
const params = { studentId: "s1", id: "s1", examId: "e1", classId: "c1" };
const answeredForNobody = guarded.filter((h) =>
  h.handler({ params, query: { schoolId: "S1" }, body: {} },
    { docs, session: { userId: "x", schoolId: "S1", role: "teacher", permissions: [] } }) !== null);
check("a session with no permissions is answered by none of them", answeredForNobody.map((h) => h.route), []);

// A student holds none of these and is not staff.
const answeredForStudent = guarded.filter((h) =>
  h.handler({ params, query: { schoolId: "S1" }, body: {} },
    { docs, session: session("student") }) !== null);
check("a student is answered by none of them", answeredForStudent.map((h) => h.route), []);

// Teacher keeps what the server gives a teacher: results.view, attendance.view.
const teacherKeeps = guarded
  .filter((h) => (h.requires.permissions ?? []).every((p) => DEFAULTS_BY_ROLE.teacher.includes(p))
              && (!h.requires.roles || h.requires.roles.includes("teacher")))
  .map((h) => h.route);
check("a teacher still passes the guard on results and attendance reads",
  teacherKeeps.filter((r) => /^GET \/api\/(fees|admin\/students|students\/)/.test(r)), []);
check("…and those are the results and attendance-report reads",
  teacherKeeps.length >= 10, true);

// Unguarded on purpose: the server scopes a student to themselves there.
check("GET /api/attendance/students is not permission-gated (server has none)",
  handlers.find((h) => h.route === "GET /api/attendance/students")?.requires ?? null, null);

// ── A person's OWN unsent changes are never hidden ─────────────────────────
// A bursar takes a payment offline; the school then revokes their fees.view.
// Their queued payment must still be readable to them from the mirror. Another
// account's queued payment opens nothing for a teacher.
{
  const { outbox } = require("../src/main/db/outbox");
  const q = outbox(db);
  q.add({ method: "post", path: "/api/fees/payments", body: { _id: "pay-1" },
          collection: "feePayment", docId: "pay-1", userId: "bursar-1" });
  const revoked = session("bursar", { permissions: DEFAULTS_BY_ROLE.bursar.filter((p) => p !== "fees.view") });
  const withQueue = (s) => api.handle(
    { method: "GET", path: "/api/fees/outstanding", query: { schoolId: "S1" } },
    { docs, session: s, queue: q, state: {} });
  check("revoked bursar WITH their own payment queued: still answered locally",
    withQueue(revoked)?.status, 200);
  check("a teacher is not opened by the bursar's queued payment",
    withQueue(session("teacher")), null);
  check("an ownerless queued fee request opens nothing",
    (() => {
      db.prepare("UPDATE outbox SET user_id = NULL").run();
      return withQueue(revoked);
    })(), null);
  db.prepare("DELETE FROM outbox").run();
}

check("declining and answering wrote nothing to disk",
  JSON.stringify(db.prepare("SELECT collection, id, json, pending FROM docs ORDER BY collection, id").all()),
  diskBefore);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
