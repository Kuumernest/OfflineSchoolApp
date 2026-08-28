// desktop/scripts/check-outbox.js
"use strict";

/**
 * Assert that queued writes reach the server in the right order, once each.
 *
 * ── What is at stake ──────────────────────────────────────────────────────
 *
 * The outbox is where a school's money waits. Its failure modes are not
 * abstract:
 *
 *   sending twice          a family is receipted twice for one payment
 *   sending out of order   a payment lands for a student who does not exist yet
 *   skipping a failure     three of four changes applied, silently
 *   retrying a refusal     a queue that never drains and nobody is told why
 *   DROPPING a write       the mirror shows a change the server never received,
 *                          and only a disagreeing report ever reveals it
 *
 * Every assertion below is one of those. The rules being pinned are that the
 * queue is strictly FIFO, that a permanent refusal STOPS it rather than being
 * stepped over, and that a request can never be queued twice.
 *
 *   node scripts/check-outbox.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const store = require("../src/main/db/store");
const { outbox, isRetryable } = require("../src/main/db/outbox");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-outbox-"));
const file = path.join(dir, "school.db");
const cleanup = () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.log(`  (could not remove ${dir}: ${err.code})`);
  }
};

const main = () => {
  let db = store.open(file);
  let q  = outbox(db);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- which failures are worth retrying ---");

  // No status at all is the ordinary offline case — no connection, no DNS.
  check("a network failure retries",            isRetryable(null), true);
  check("a timeout retries",                    isRetryable(408),  true);
  check("being asked to slow down retries",     isRetryable(429),  true);
  check("a server error retries",               isRetryable(500),  true);
  check("a gateway error retries",              isRetryable(502),  true);

  // The server understood and said no. An identical replay gets an identical
  // no, so retrying is a queue that never drains.
  check("a validation refusal does not",        isRetryable(400),  false);
  check("nor a capability refusal",             isRetryable(403),  false);
  check("nor a conflict",                       isRetryable(409),  false);
  check("nor a missing route",                  isRetryable(404),  false);

  // 401 is worth a thought: the token expired. Not retryable HERE because the
  // request as queued will keep failing — the axios layer refreshes the token
  // and the retry then carries a new one, so it is a refusal at this level.
  check("nor an expired session at this level", isRetryable(401),  false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- queueing ---");

  const a = q.add({
    method: "post", path: "/api/admin/students",
    body: { _id: "stu-1", studentName: "Ada Nkeng" },
    collection: "student", docId: "stu-1",
    dedupeKey: "create-student#stu-1",
  });
  check("the first request is queued", a.duplicate, false);
  check("with a sequence number", a.seq > 0, true);

  // The double-click, modelled by the INTENT being repeated rather than by an
  // id being reused. A caller that reaches here twice has generated two ids, so
  // a guard keyed on the document would never have seen it.
  const again = q.add({
    method: "post", path: "/api/admin/students",
    body: { _id: "stu-2", studentName: "Ada Nkeng" },
    collection: "student", docId: "stu-2",
    dedupeKey: "create-student#stu-1",
  });
  check("queueing the same intent twice is refused", again.duplicate, true);
  check("pointing at the request already queued", again.seq, a.seq);
  check("so there is one entry, not two", q.all().length, 1);

  const b = q.add({
    method: "post", path: "/api/fees/payments",
    body: { _id: "pay-1", studentId: "stu-1", amount: 30000 },
    collection: "feePayment", docId: "pay-1",
  });
  check("a different intent is queued", b.duplicate, false);
  check("behind the first", b.seq > a.seq, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- order is the order the user did things ---");

  const batch = q.nextBatch();
  check("both are due immediately", batch.length, 2);
  check("oldest first — the student before the payment that references them",
    batch.map((r) => r.path),
    ["/api/admin/students", "/api/fees/payments"]);
  check("the body comes back parsed",
    batch[0].body, { _id: "stu-1", studentName: "Ada Nkeng" });
  check("and the method is normalised",
    batch.map((r) => r.method), ["POST", "POST"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a retryable failure backs off, keeping its place ---");

  check("the decision is to retry",
    q.markFailed(a.seq, { status: null, message: "getaddrinfo ENOTFOUND" }), "retry");

  const afterFail = q.nextBatch();
  // Nothing is due: the head is backing off, and the queue is a line — the
  // payment behind it must not overtake the student it depends on.
  check("nothing is due while the head waits", afterFail.length, 0);
  check("and the entry is still pending, not lost", q.summary().pending, 2);

  const head = q.all()[0];
  check("the attempt was counted", head.attempts, 1);
  check("the reason was kept", /ENOTFOUND/.test(head.last_error), true);
  check("and a next-try time was set", Boolean(head.next_try_at), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a success leaves the queue ---");

  // Cleared so the rest of the walk is not waiting on a backoff.
  db.prepare("UPDATE outbox SET next_try_at = ?").run("2000-01-01T00:00:00.000Z");

  q.markSent(a.seq);
  check("it is gone", q.all().length, 1);
  check("and the next one is now the head", q.nextBatch()[0].path, "/api/fees/payments");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a permanent refusal stops the queue rather than being stepped over ---");

  const c = q.add({
    method: "post", path: "/api/fees/penalties",
    body: { academicYear: "2026-2027" }, idemKey: "pen-1",
  });

  check("the decision is to block",
    q.markFailed(b.seq, { status: 403, message: "fees.write required" }), "blocked");

  // THE ASSERTION THIS FILE EXISTS FOR. Skipping the blocked entry would let a
  // later request land without the earlier one it assumed — three of four
  // changes applied, and nothing saying so.
  check("nothing behind it is sent", q.nextBatch().length, 0);
  check("even though it is due", q.all().find((r) => r.seq === c.seq).status, "pending");

  const stuck = q.summary();
  check("the summary counts it", stuck.blocked, 1);
  check("and names it, because a count is not something a bursar can act on",
    stuck.head.path, "/api/fees/payments");
  check("with what the server said", stuck.head.last_status, 403);
  check("and why", /fees.write required/.test(stuck.head.last_error), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and can be released once a person has dealt with it ---");

  q.unblock(b.seq);
  check("the queue moves again", q.nextBatch().length, 2);
  check("still in the original order",
    q.nextBatch().map((r) => r.path),
    ["/api/fees/payments", "/api/fees/penalties"]);
  check("with the attempt count reset",
    q.all().find((r) => r.seq === b.seq).attempts, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- or discarded, telling the caller what to undo ---");

  q.markFailed(b.seq, { status: 409, message: "structure deactivated" });
  const discarded = q.discard(b.seq);
  // The local mirror still holds the row this request would have created. The
  // caller has to remove it, or the desktop shows a payment the server has
  // never heard of — for ever.
  check("it says which document to forget",
    discarded, { collection: "feePayment", docId: "pay-1" });
  check("and the queue drains past it", q.nextBatch().map((r) => r.path),
    ["/api/fees/penalties"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- backoff grows, then levels off ---");

  const { BACKOFF_SECONDS } = require("../src/main/db/outbox");
  const waits = [];
  for (let i = 0; i < 7; i++) {
    q.markFailed(c.seq, { status: 503, message: "unavailable" });
    const row = q.all().find((r) => r.seq === c.seq);
    waits.push(Math.round((new Date(row.next_try_at) - Date.now()) / 1000));
  }
  check("each wait is one step further down the ladder",
    waits.slice(0, BACKOFF_SECONDS.length).map((w, i) => Math.abs(w - BACKOFF_SECONDS[i]) <= 1),
    BACKOFF_SECONDS.map(() => true));
  check("and then holds at the ceiling rather than growing without bound",
    waits.slice(BACKOFF_SECONDS.length).every(
      (w) => Math.abs(w - BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]) <= 1
    ),
    true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- two operations on one document are two operations ---");

  /**
   * ── The bug this pins ────────────────────────────────────────────────────
   *
   * idem_key is UNIQUE, and add() used to default it to the document id. So the
   * SECOND write to any document found its key already taken: the edit was
   * reported as a duplicate and thrown away, while the mirror showed it applied
   * and the queue drained clean. Nothing would have surfaced it until a report
   * disagreed with the office's own screen, months later.
   *
   * It could not bite while the only offline writes were two creates — which is
   * precisely why it had to be pinned before the first edit shape was added.
   */
  const created = q.add({
    method: "post", path: "/api/exams", body: { _id: "exam-9", title: "Mock" },
    collection: "exam", docId: "exam-9",
  });
  const edited = q.add({
    method: "put", path: "/api/exams/exam-9",
    body: { _id: "exam-9", title: "Mock (revised)" },
    collection: "exam", docId: "exam-9",
  });
  check("the edit is queued rather than swallowed", edited.duplicate, false);
  check("as its own entry, behind the create", edited.seq > created.seq, true);

  const renamed = q.add({
    method: "put", path: "/api/exams/exam-9",
    body: { _id: "exam-9", title: "Mock (again)" },
    collection: "exam", docId: "exam-9",
  });
  check("and a second edit is not swallowed either", renamed.duplicate, false);

  // The server tells one attempt from another by this header alone. Two queued
  // operations sharing a key would have the later answered with the earlier's
  // stored response — a PUT receiving the POST's 201.
  const keys = q.all().map((r) => r.idem_key);
  check("every queued operation carries its own key", new Set(keys).size, keys.length);

  // Where dedup does earn its place: a DELETE queued twice meets a document
  // already gone on the second attempt, and a 404 is not retryable, so the whole
  // queue stops on work that had in fact succeeded.
  const removed = q.add({
    method: "delete", path: "/api/exams/exam-9",
    collection: "exam", docId: "exam-9", dedupeKey: "DELETE /api/exams/exam-9",
  });
  const removedTwice = q.add({
    method: "delete", path: "/api/exams/exam-9",
    collection: "exam", docId: "exam-9", dedupeKey: "DELETE /api/exams/exam-9",
  });
  check("deleting the same thing twice queues once", removedTwice.duplicate, true);
  check("pointing at the entry already waiting", removedTwice.seq, removed.seq);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the queue survives the machine being switched off ---");

  // The reason any of this exists. A bursar takes a payment, the power goes,
  // and the payment must still be waiting to be sent when the machine comes up.
  const beforeRestart = q.all().map((r) => ({ seq: r.seq, path: r.path, status: r.status }));
  db.close();

  db = store.open(file);
  q  = outbox(db);
  check("everything queued is still queued",
    q.all().map((r) => ({ seq: r.seq, path: r.path, status: r.status })),
    beforeRestart);
  check("including the attempt counts",
    q.all()[0].attempts > 0, true);

  // And the sequence keeps climbing rather than restarting, so a new request
  // cannot be inserted in front of one that was queued before the restart.
  const after = q.add({ method: "post", path: "/api/fees/reminders", idemKey: "rem-1" });
  check("new requests still go to the back",
    after.seq > Math.max(...beforeRestart.map((r) => r.seq)), true);

  // Closed so the temporary directory can be removed — the same handle leak the
  // document-store suite found in open(), here in the test itself.
  db.close();

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

try {
  main();
} catch (err) {
  console.error("\nHarness error:", err);
  fail++;
} finally {
  cleanup();
}

process.exit(fail ? 1 : 0);
