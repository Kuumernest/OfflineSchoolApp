// desktop/src/main/db/outbox.js
"use strict";

/**
 * Writes waiting to reach the server.
 *
 * ── The one decision everything else follows from ─────────────────────────
 *
 * The queue holds HTTP REQUESTS — method, path, body — exactly as the UI made
 * them, and replays them verbatim when there is a connection.
 *
 * The alternative would be a bespoke mutation format and a server endpoint that
 * applies it. That endpoint would be a second door into the same data, and it
 * would have to re-implement every guard the real routes already carry: the
 * capability check, the tenant scope, the approval threshold, the segregation of
 * duties, the "a bursar may not set a salary" rule. Two doors into a school's
 * money, one of them newer and less exercised, is not a trade worth making for
 * a tidier wire format.
 *
 * Replaying the real request means an offline write is checked by the same code
 * that would have checked it online, at the moment it lands. If a bursar's
 * capability was revoked while they were offline, their queued write is refused
 * — which is right, and which a custom applier would have had to remember to do.
 *
 * ── Why the order is strict ───────────────────────────────────────────────
 *
 * A payment refers to a student. If the student was also created offline, the
 * payment cannot arrive first. Rather than model dependencies between requests
 * — which means guessing at them — the queue is a single line in the order the
 * user did things, which is an order that is correct by construction.
 *
 * The cost is head-of-line blocking, and it is accepted knowingly. When the
 * server refuses something in a way retrying will not fix, the queue STOPS and
 * says so. It does not skip ahead. Skipping means a later request landing
 * without the earlier one it assumed, and for financial records a stalled queue
 * somebody has to look at is much better than a queue that quietly applied
 * three of your four changes.
 */

const { randomUUID } = require("crypto");

/**
 * Retries, spaced out.
 *
 * Slow growth then a ten-minute ceiling: a school's connection tends to be
 * absent for hours and then present, so there is nothing to gain from hammering
 * and nothing to lose by checking every ten minutes. The first few are quick
 * because the commonest failure is a connection that dropped for seconds.
 */
const BACKOFF_SECONDS = [5, 15, 60, 300, 600];

/**
 * Which failures are worth retrying.
 *
 * Anything without a status is a network or DNS failure — the ordinary offline
 * case, and always worth retrying. Of the statuses:
 *
 *   408, 429, 5xx  the server is unwell or asking us to slow down. Retry.
 *   other 4xx      the server understood and refused. Retrying an identical
 *                  request will be refused identically, so this needs a person.
 *
 * A replay landing on something already stored must NOT reach here as a 409:
 * the endpoints that accept client-generated ids answer 200 with replay:true
 * for exactly that reason (see POST /api/fees/payments), and everything else is
 * covered by the Idempotency-Key the sync client now sends, which returns the
 * stored response rather than a conflict.
 *
 * ── The one 409 that IS retryable ─────────────────────────────────────────
 *
 * IDEMPOTENCY_IN_PROGRESS. The server answers it when an identical request is
 * still being processed, with Retry-After — it means "ask again shortly", not
 * "no". Treating it as a refusal blocked the queue permanently and required a
 * person to release a request that was merely mid-flight, which is the opposite
 * of what the mechanism is for.
 */
const isRetryable = (status, code = null) => {
  if (!status) return true;
  if (status === 408 || status === 429) return true;
  if (status === 409 && code === "IDEMPOTENCY_IN_PROGRESS") return true;
  return status >= 500;
};

const outbox = (db) => {
  const nowIso = () => new Date().toISOString();

  return {
    /**
     * Queue a request.
     *
     * @param idemKey    Sent as Idempotency-Key so a replay is answered with the
     *                   response the server already gave. Identifies ONE
     *                   OPERATION; a fresh one is generated per call, and it is
     *                   passed explicitly only by tests that assert on it.
     * @param dedupeKey  Identifies an INTENT — pass it where submitting the same
     *                   thing twice should be ignored, such as a create behind a
     *                   button somebody may double-click. Omit it for edits.
     * @param extraDocs  Rows this request wrote BESIDES the primary one, as
     *                   [{ collection, docId }]. They are settled with it. A row
     *                   written and not listed here stays pending for ever, and
     *                   a pending row is never overwritten by the server — so it
     *                   would disagree with the school's record permanently.
     *
     * ── These were one value, and that lost data ─────────────────────────────
     *
     * idemKey defaulted to docId. Since it is UNIQUE, a queued EDIT to a
     * document with a queued CREATE was reported as a duplicate and dropped: the
     * mirror showed the change, the queue drained, and the server never heard.
     * Only two create-shaped endpoints existed at the time, so nothing hit it.
     */
    add({
      method, path, body = null, collection = null, docId = null,
      idemKey = null, dedupeKey = null, extraDocs = null,
    }) {
      // Never derived from the document: two operations on one document are two
      // operations, and the server must be able to tell them apart.
      const key = idemKey ?? randomUUID();

      if (dedupeKey) {
        // Only against what is still queued. Once an intent has drained, doing
        // the same thing again is a person's decision, not a stray click.
        const pending = db.prepare(
          "SELECT seq, status FROM outbox WHERE dedupe_key = ?"
        ).get(dedupeKey);
        if (pending) return { seq: Number(pending.seq), duplicate: true };
      }

      const existing = db.prepare("SELECT seq, status FROM outbox WHERE idem_key = ?").get(key);
      if (existing) {
        // An explicit key reused — a caller replaying its own request.
        return { seq: Number(existing.seq), duplicate: true };
      }

      const res = db.prepare(`
        INSERT INTO outbox
          (idem_key, dedupe_key, method, path, body, collection, doc_id,
           extra_docs, created_at, next_try_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key, dedupeKey, method.toUpperCase(), path,
        body === null ? null : JSON.stringify(body),
        collection, docId,
        extraDocs?.length ? JSON.stringify(extraDocs) : null,
        nowIso(), nowIso()
      );

      return { seq: Number(res.lastInsertRowid), duplicate: false };
    },

    /**
     * The next requests to try, oldest first.
     *
     * Stops at a blocked entry rather than looking past it — see the note on
     * strict ordering above. Also stops at anything not yet due, because the
     * queue is a line: if the head is backing off, the rest waits with it.
     */
    nextBatch(limit = 25) {
      const rows = db.prepare(
        "SELECT * FROM outbox ORDER BY seq ASC LIMIT ?"
      ).all(limit);

      const due = [];
      for (const row of rows) {
        if (row.status === "blocked") break;
        if (row.next_try_at && row.next_try_at > nowIso()) break;
        due.push({
          ...row,
          seq:  Number(row.seq),
          body: row.body ? JSON.parse(row.body) : null,
          // Parsed here rather than in the engine: the engine's job is to decide
          // what to do with them, not to know how they are stored.
          extraDocs: row.extra_docs ? JSON.parse(row.extra_docs) : [],
        });
      }
      return due;
    },

    /** It reached the server. Nothing local needs to remember it any more. */
    markSent(seq) {
      db.prepare("DELETE FROM outbox WHERE seq = ?").run(seq);
    },

    /**
     * It failed. Decide between trying again and asking a person.
     *
     * @returns {"retry"|"blocked"} what was decided, so the caller can stop.
     */
    markFailed(seq, { status = null, message = "", code = null } = {}) {
      const row = db.prepare("SELECT attempts FROM outbox WHERE seq = ?").get(seq);
      if (!row) return "retry";

      const attempts = Number(row.attempts) + 1;

      if (!isRetryable(status, code)) {
        db.prepare(`
          UPDATE outbox SET status='blocked', attempts=?, last_error=?, last_status=?, next_try_at=NULL
          WHERE seq = ?
        `).run(attempts, message.slice(0, 500), status, seq);
        return "blocked";
      }

      const wait = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
      db.prepare(`
        UPDATE outbox SET status='pending', attempts=?, last_error=?, last_status=?, next_try_at=?
        WHERE seq = ?
      `).run(
        attempts, message.slice(0, 500), status,
        new Date(Date.now() + wait * 1000).toISOString(), seq
      );
      return "retry";
    },

    /**
     * Let a blocked entry try again — after a person has done something about
     * whatever the server objected to.
     */
    unblock(seq) {
      db.prepare(
        "UPDATE outbox SET status='pending', attempts=0, next_try_at=?, last_error=NULL WHERE seq=?"
      ).run(nowIso(), seq);
    },

    /**
     * Give up on a blocked entry and drop it.
     *
     * The caller is responsible for undoing the local row it wrote, or the
     * mirror keeps a change the server will never have.
     */
    discard(seq) {
      const row = db.prepare("SELECT collection, doc_id, extra_docs FROM outbox WHERE seq = ?").get(seq);
      db.prepare("DELETE FROM outbox WHERE seq = ?").run(seq);
      if (!row) return null;
      return {
        collection: row.collection,
        docId:      row.doc_id,
        extraDocs:  row.extra_docs ? JSON.parse(row.extra_docs) : [],
      };
    },

    /** What the UI shows: how much is waiting, and whether anything is stuck. */
    summary() {
      const counts = db.prepare(
        "SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"
      ).all();

      const blocked = db.prepare(
        "SELECT seq, method, path, last_status, last_error FROM outbox WHERE status='blocked' ORDER BY seq"
      ).all().map((r) => ({ ...r, seq: Number(r.seq) }));

      return {
        pending: counts.find((c) => c.status === "pending")?.n ?? 0,
        blocked: blocked.length,
        // Named, not just counted. "3 changes could not be saved" is not
        // something a bursar can act on; "the payment for Ada Nkeng was
        // refused because the fee structure was deactivated" is.
        stuck: blocked,
        // The head of the queue, because when it is blocked, nothing behind it
        // is moving either and that is the thing to explain.
        head: blocked[0] ?? null,
      };
    },

    all() {
      return db.prepare("SELECT * FROM outbox ORDER BY seq").all()
        .map((r) => ({ ...r, seq: Number(r.seq) }));
    },
  };
};

module.exports = { outbox, isRetryable, BACKOFF_SECONDS };
