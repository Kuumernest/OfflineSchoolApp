// desktop/scripts/check-student-writes.js
"use strict";

/**
 * The admin pupil-record writes, exercised against a mock of the mirror.
 *
 * ── Why every assertion here is cross-school ───────────────────────────────
 *
 * The server versions of these routes spent their life taking a pupil id and
 * never asking whose pupil it was, and check-student-tenancy.js exists because
 * a test suite of single-school assertions could not have noticed. The same
 * trap waits for the offline mirror: a local write handler that resolves an id
 * without a school clause would corrupt another school's register from a desk
 * in this one, and no same-school test would fail. So every happy-path case
 * here runs beside a second school's pupil, class and application, and the
 * assertions state that the wrong-school id is DECLINED TO THE QUEUE — the same
 * answer the fixed server gives — rather than written.
 *
 * Run by `npm run check:student-writes`, part of the desktop `check` chain.
 */

const api = require("../src/main/api");

const rows = {
  student: [
    { _id: "p1", schoolId: "S1", status: "active", isActive: true, classId: "c1", userId: "u1" },
    { _id: "p2", schoolId: "S2", status: "active", isActive: true, classId: "c9", userId: "u2" },
    { _id: "p3", schoolId: "S1", status: "approved", isActive: true, classId: "c1", userId: "u3" },
    { _id: "p4", schoolId: "S1", status: "approved", isActive: true, classId: "c1", userId: "u4",
      updatedAt: "2026-08-20T10:00:00.000Z", updatedBy: "someone-else", updatedByName: "Someone Else" },
    { _id: "p5", schoolId: "S1", status: "approved", isActive: true, classId: "c1", userId: "u5",
      updatedAt: "2026-08-20T10:00:00.000Z", updatedBy: "admin-1", updatedByName: "Admin One" },
  ],
  user: [
    { _id: "u1", schoolId: "S1", isActive: true },
    { _id: "u2", schoolId: "S2", isActive: true },
    { _id: "u3", schoolId: "S1", isActive: true },
    { _id: "u4", schoolId: "S1", isActive: true },
    { _id: "u5", schoolId: "S1", isActive: true },
  ],
  class: [
    { _id: "c1", schoolId: "S1", name: "P4" },
    { _id: "c2", schoolId: "S1", name: "P5" },
    { _id: "cX", schoolId: "S2", name: "Other school's class" },
  ],
  studentApplication: [
    { _id: "a1", schoolId: "S1", status: "pending", studentName: "Ada" },
  ],
};

const ctx = {
  docs: {
    find: (c, q = {}) => (rows[c] || []).filter((r) =>
      Object.entries(q).every(([k, v]) => String(r[k]) === String(v))),
    get: (c, id) => (rows[c] || []).find((r) => String(r._id) === String(id)),
    put: (c, d) => {
      const list = (rows[c] = rows[c] || []);
      const i = list.findIndex((r) => String(r._id) === String(d._id));
      if (i >= 0) list[i] = d; else list.push(d);
      return String(d._id);
    },
    tx: (fn) => fn(),
  },
  session: { userId: "admin-1", schoolId: "S1" },
  queue: { add: (r) => ({ seq: 1, duplicate: false }) },
};

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}` +
    (ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const call = (method, path, body = {}) => api.handle({ method, path, query: {}, body }, ctx);

// ── suspend ──────────────────────────────────────────────────────────────────
const suspended = call("PATCH", "/api/admin/students/p1/suspend");
check("suspend writes the record suspended",
  [suspended !== null, rows.student[0].status, rows.student[0].isActive],
  [true, "suspended", false]);
check("suspend also deactivates the login",
  rows.user[0].isActive, false);
check("suspend answers in the server's envelope",
  [suspended.status, suspended.data.success, suspended.queued],
  [200, true, true]);
check("suspend of a pupil in another school declines",
  call("PATCH", "/api/admin/students/p2/suspend"), null);

// ── second suspend is refused (the safe endpoint's 409) ──────────────────────
check("a second suspend is refused",
  call("PATCH", "/api/admin/students/p1/suspend"), null);

// ── restore ──────────────────────────────────────────────────────────────────
const restored = call("PATCH", "/api/admin/students/p1/restore");
check("restore reactivates the record",
  [rows.student[0].status, rows.student[0].isActive],
  ["active", true]);
check("restore reactivates the login", rows.user[0].isActive, true);
check("restore of a non-suspended pupil declines",
  call("PATCH", "/api/admin/students/p1/restore"), null);

// ── move ─────────────────────────────────────────────────────────────────────
check("move into another school's class declines",
  call("PATCH", "/api/admin/students/p1/move", { classId: "cX" }), null);
const moved = call("PATCH", "/api/admin/students/p1/move", { classId: "c2" });
check("move within the school lands",
  [moved !== null, rows.student[0].classId, rows.student[0].className],
  [true, "c2", "P5"]);

// ── approve (application path) ───────────────────────────────────────────────
const approved = call("PUT", "/api/admin/students/a1/approve", { classId: "c1" });
check("approve promotes the pending application",
  [approved !== null, rows.studentApplication[0].status, rows.studentApplication[0].classId],
  [true, "approved", "c1"]);
check("re-approving answers the replay, not a conflict",
  [approved.data.replay, approved.status],
  [undefined, 200]);

// a second approval of the now-approved record is the replay answer
const again = call("PUT", "/api/admin/students/a1/approve", { classId: "c1" });
check("the replayed approval answers replay:true",
  [again !== null, again.data.replay], [true, true]);

// ── reject ───────────────────────────────────────────────────────────────────
rows.studentApplication.push({ _id: "a2", schoolId: "S1", status: "pending", studentName: "BTree" });
const rejected = call("PUT", "/api/admin/students/a2/reject", { reason: "Duplicate" });
check("reject stamps reason and status",
  [rows.studentApplication[1].status, rows.studentApplication[1].rejectionReason],
  ["rejected", "Duplicate"]);
check("reject of an approved record declines",
  call("PUT", "/api/admin/students/a1/reject", { reason: "x" }), null);

// ── withdraw (DELETE) ────────────────────────────────────────────────────────
const gone = call("DELETE", "/api/admin/students/p1");
check("withdraw marks rather than destroys",
  [rows.student[0].status, !!rows.student[0].deletedAt],
  ["withdrawn", true]);
check("withdraw deactivates the login", rows.user[0].isActive, false);
check("a second withdraw is refused", call("DELETE", "/api/admin/students/p1"), null);

// ── renumber: server-owned, always queued ────────────────────────────────────
check("renumber is declined to the queue",
  call("POST", "/api/admin/students/p1/enrollment-number"), null);

// ── no session school → decline ──────────────────────────────────────────────
check("a body schoolId that disagrees with the session declines",
  api.handle({ method: "PATCH", path: "/api/admin/students/p1/suspend", query: {}, body: { schoolId: "S2" } }, ctx),
  null);

// ── the SAFE paths — the router the console actually calls ───────────────────
const safeSuspend = call("PATCH", "/api/students/p3/suspend");
check("safe-path suspend writes suspended and deactivates the login",
  [rows.student[2].status, rows.student[2].isActive, rows.user[2].isActive],
  ["suspended", false, false]);
check("safe-path suspend answers in the endpoint's own shape",
  [safeSuspend.status, safeSuspend.data.message, typeof safeSuspend.data.data],
  [200, '"Student" has been suspended', "object"]);
check("safe-path suspend of another school's pupil declines",
  call("PATCH", "/api/students/p2/suspend"), null);
check("safe-path suspend of a pupil already suspended declines",
  call("PATCH", "/api/students/p3/suspend"), null);

const safeRestore = call("PATCH", "/api/students/p3/restore");
check("safe-path restore returns the pupil to APPROVED, not active",
  [rows.student[2].status, rows.student[2].isActive, rows.user[2].isActive],
  ["approved", true, true]);
check("safe-path restore of an already-approved pupil declines",
  call("PATCH", "/api/students/p3/restore"), null);

// the concurrent-edit guard: p4 was edited by somebody else after the caller's
// baseline, so the suspend is an overwrite and the caller is told
const guarded = api.handle({
  method: "PATCH", path: "/api/students/p4/suspend", query: {},
  body: { baseUpdatedAt: "2026-08-01T00:00:00.000Z" },
}, ctx);
check("an edit against a stale baseline reports the overwrite",
  [guarded.data.overwrote !== null, guarded.data.overwrote?.lostEditBy],
  [true, "Someone Else"]);
check("an edit against a current baseline reports none",
  api.handle({
    method: "PATCH", path: "/api/students/p5/suspend", query: {},
    body: { baseUpdatedAt: "2026-08-01T00:00:00.000Z" },
  }, ctx).data.overwrote ?? null,
  null);

const safeDelete = call("DELETE", "/api/students/p3");
check("safe-path delete tombstones the record and the login",
  [!!rows.student[2].deletedAt, rows.user[2].isActive],
  [true, false]);
check("safe-path delete answers the endpoint's shape",
  [safeDelete.status, safeDelete.data.data.studentId],
  [200, "p3"]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURE(S)`);
if (failed !== 0) process.exit(1);

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2 — the same tenancy-critical paths against the REAL document store.
//
// The mock above implements docs.find as a plain equality filter; the real
// store builds SQL from that filter, and a mirror whose find quietly ignored
// the schoolId clause would pass every assertion here and still answer for
// another school's child. So the four lookups the handlers lean on are
// repeated against node:sqlite itself.
// ═════════════════════════════════════════════════════════════════════════════

const { open, documents } = require("../src/main/db/store");

const db = open(":memory:");
const realCtx = {
  docs: documents(db),
  session: { userId: "admin-1", schoolId: "S1" },
  queue: { add: (r) => ({ seq: 1, duplicate: false }) },
};

realCtx.docs.putMany("student", [
  { _id: "p1", schoolId: "S1", status: "approved", isActive: true, classId: "c1", userId: "u1" },
  { _id: "p2", schoolId: "S2", status: "approved", isActive: true, classId: "c9", userId: "u2" },
]);
realCtx.docs.putMany("user", [
  { _id: "u1", schoolId: "S1", isActive: true },
  { _id: "u2", schoolId: "S2", isActive: true },
]);
realCtx.docs.putMany("class", [
  { _id: "c1", schoolId: "S1", name: "P4" },
  { _id: "cX", schoolId: "S2", name: "Other school's class" },
]);
realCtx.docs.putMany("studentApplication", [
  { _id: "a1", schoolId: "S1", status: "pending", studentName: "Ada" },
]);

const realCall = (method, path, body = {}) =>
  api.handle({ method, path, query: {}, body }, realCtx);

check("real store: wrong-school pupil declines",
  realCall("PATCH", "/api/students/p2/suspend"), null);
check("real store: own-school pupil suspends and queues",
  [realCall("PATCH", "/api/students/p1/suspend") !== null,
   realCtx.docs.get("student", "p1").status,
   realCtx.docs.get("user", "u1").isActive],
  [true, "suspended", false]);
check("real store: a foreign class is not a destination",
  realCall("PATCH", "/api/admin/students/p1/move", { classId: "cX" }), null);
check("real store: application lookup with school clause approves",
  [realCall("PUT", "/api/admin/students/a1/approve", { classId: "c1" }) !== null,
   realCtx.docs.get("studentApplication", "a1").status],
  [true, "approved"]);

console.log(failed === 0 ? "REAL STORE: ALL PASS" : `REAL STORE: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
