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

/**
 * Whose an entry is, as the signed-in account sees it.
 *
 *   "mine"   queued by this account
 *   "other"  queued by another account on this computer
 *   "none"   queued before the queue recorded who (migration 4) — nobody's
 *
 * Signed out, nothing is "mine".
 */
const ownerFor = (rowUserId, userId) => {
  if (rowUserId === null || rowUserId === undefined || rowUserId === "") return "none";
  return userId && String(rowUserId) === String(userId) ? "mine" : "other";
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
      idemKey = null, dedupeKey = null, extraDocs = null, userId = null,
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
           extra_docs, created_at, next_try_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key, dedupeKey, method.toUpperCase(), path,
        body === null ? null : JSON.stringify(body),
        collection, docId,
        extraDocs?.length ? JSON.stringify(extraDocs) : null,
        nowIso(), nowIso(),
        userId ? String(userId) : null
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
    nextBatch(limit = 25, { userId = null } = {}) {
      // With an account named, only that account's line. Another account's
      // rows are not this queue's business and are left untouched — and so is
      // a row with no owner at all (queued before migration 4): nobody can say
      // whose it is, so it is never sent and never adopted by whoever signed in.
      // OWNERLESS QUEUED MUTATIONS MUST NEVER BE EXECUTED UNDER A DIFFERENT
      // ACCOUNT. Without an account named (tests, tooling) the line is read as
      // it always was.
      const rows = userId
        ? db.prepare(
            "SELECT * FROM outbox WHERE user_id = ? ORDER BY seq ASC LIMIT ?"
          ).all(String(userId), limit)
        : db.prepare("SELECT * FROM outbox ORDER BY seq ASC LIMIT ?").all(limit);

      const due = [];
      for (const row of rows) {
        if (row.status === "blocked") break;
        if (row.next_try_at && row.next_try_at > nowIso()) break;
        let body, extraDocs;
        try {
          body      = row.body ? JSON.parse(row.body) : null;
          // Parsed here rather than in the engine: the engine's job is to decide
          // what to do with them, not to know how they are stored.
          extraDocs = row.extra_docs ? JSON.parse(row.extra_docs) : [];
        } catch (err) {
          // A row whose body cannot be read cannot be sent, ever. Parked as
          // blocked with the reason, and the queue stops behind it as it does
          // for any refusal — a person can discard it. Throwing here instead
          // ended every cycle at this row, and nothing behind it ever moved.
          db.prepare(
            "UPDATE outbox SET status='blocked', last_error=?, next_try_at=NULL WHERE seq=?"
          ).run(`Malformed request body could not be parsed: ${err.message}`.slice(0, 500), row.seq);
          break;
        }
        due.push({ ...row, seq: Number(row.seq), body, extraDocs });
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
     * The connection is back (or a person pressed "Sync now"): make every
     * entry that is backing off because the NETWORK failed due now.
     *
     * Only those. A network failure says nothing about the request, and its
     * backoff — up to ten minutes — exists only so an absent connection is not
     * hammered; once the connection is known to be back, waiting it out just
     * leaves a payment unsent for no reason. A 5xx/429/408 backoff is the
     * SERVER asking for time and is kept, and a blocked entry (a refusal) is
     * a person's to release. The attempt count is kept, so a connection that
     * drops again backs off from where it was.
     *
     * @returns how many entries were brought forward
     */
    retryNetworkNow() {
      const now = nowIso();
      return Number(db.prepare(`
        UPDATE outbox SET next_try_at = ?
        WHERE status = 'pending' AND attempts > 0 AND last_status IS NULL
          AND next_try_at IS NOT NULL AND next_try_at > ?
      `).run(now, now).changes);
    },

    /**
     * Is any request still queued (pending or blocked) that wrote this row —
     * as its primary document or among its extra_docs? While one is, the row
     * stays pending: settling it early let the next pull overwrite the latest
     * local change with the server's older copy.
     */
    queuedFor(collection, docId) {
      return Boolean(db.prepare(`
        SELECT 1 FROM outbox
        WHERE (collection = ? AND doc_id = ?)
           OR (extra_docs IS NOT NULL AND EXISTS (
                SELECT 1 FROM json_each(CASE WHEN json_valid(extra_docs) THEN extra_docs ELSE '[]' END) AS e
                WHERE json_extract(e.value, '$.collection') = ?
                  AND CAST(json_extract(e.value, '$.docId') AS TEXT) = ?))
        LIMIT 1
      `).get(collection, String(docId), collection, String(docId)));
    },

    /**
     * Let a blocked entry try again — after a person has done something about
     * whatever the server objected to.
     */
    unblock(seq) {
      // An entry blocked on a REFUSAL (4xx) goes out under a new
      // Idempotency-Key: the server replays a stored refusal for its key for
      // 45 days, so retrying under the old one got the same answer back without
      // the request being looked at — after the permission was granted or the
      // data fixed, the change still never landed. A refused request changed
      // nothing, so a new key cannot apply it twice.
      const row = db.prepare("SELECT last_status FROM outbox WHERE seq = ?").get(seq);
      const refused = row && Number(row.last_status) >= 400 && Number(row.last_status) < 500;
      db.prepare(
        `UPDATE outbox SET status='pending', attempts=0, next_try_at=?, last_error=NULL
           ${refused ? ", idem_key=?" : ""} WHERE seq=?`
      ).run(...(refused ? [nowIso(), randomUUID(), seq] : [nowIso(), seq]));
    },

    /**
     * Give up on a blocked entry and drop it.
     *
     * The caller is responsible for undoing the local row it wrote, or the
     * mirror keeps a change the server will never have.
     */
    discard(seq) {
      const row = db.prepare("SELECT method, collection, doc_id, extra_docs FROM outbox WHERE seq = ?").get(seq);
      db.prepare("DELETE FROM outbox WHERE seq = ?").run(seq);
      if (!row) return null;
      return {
        method:     row.method,
        collection: row.collection,
        docId:      row.doc_id,
        extraDocs:  row.extra_docs ? JSON.parse(row.extra_docs) : [],
      };
    },

    /**
     * What the UI shows: how much is waiting, and whether anything is stuck.
     *
     * Each stuck entry says whose it is (`owner`, see ownerFor) for the account
     * named — so the panel offers Discard, Try again and Save a copy only on
     * that account's own. The account id itself is not handed to the window.
     */
    summary({ userId = null } = {}) {
      const counts = db.prepare(
        "SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"
      ).all();

      const blocked = db.prepare(
        "SELECT seq, method, path, last_status, last_error, user_id FROM outbox WHERE status='blocked' ORDER BY seq"
      ).all().map(({ user_id: rowUser, ...r }) => ({
        ...r, seq: Number(r.seq), owner: ownerFor(rowUser, userId),
      }));

      return {
        pending: counts.find((c) => c.status === "pending")?.n ?? 0,
        blocked: blocked.length,
        // Rows from before ownership was recorded. No account will ever send
        // them; a person recovers or discards them from the sync screen.
        ownerless: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE user_id IS NULL").get()?.n ?? 0,
        // Named, not just counted. "3 changes could not be saved" is not
        // something a bursar can act on; "the payment for Ada Nkeng was
        // refused because the fee structure was deactivated" is.
        stuck: blocked,
        // The head of the queue, because when it is blocked, nothing behind it
        // is moving either and that is the thing to explain.
        head: blocked[0] ?? null,
      };
    },

    /**
     * Does this account have a request still waiting (or blocked) under any of
     * these path prefixes? Read only. Used by the local read guards so that a
     * permission check never hides a person's OWN unsent changes from them
     * (api/handlers/readPermissions.js).
     */
    hasOwnPending(userId, prefixes = []) {
      if (!userId || !prefixes.length) return false;
      const where = prefixes.map(() => "path LIKE ?").join(" OR ");
      return Boolean(db.prepare(
        `SELECT 1 FROM outbox WHERE user_id = ? AND (${where}) LIMIT 1`
      ).get(String(userId), ...prefixes.map((p) => `${p}%`)));
    },

    all() {
      return db.prepare("SELECT * FROM outbox ORDER BY seq").all()
        .map((r) => ({ ...r, seq: Number(r.seq) }));
    },

    /** One entry, whole (body included), or null. */
    get(seq) {
      const r = db.prepare("SELECT * FROM outbox WHERE seq = ?").get(seq);
      return r ? { ...r, seq: Number(r.seq) } : null;
    },

    /** Whose this entry is for `userId` (ownerFor), or null if there is none. */
    ownership(seq, userId) {
      const r = db.prepare("SELECT user_id FROM outbox WHERE seq = ?").get(seq);
      return r ? ownerFor(r.user_id, userId) : null;
    },
  };
};

/** A person asked to act on a queued change that is not theirs. */
class OutboxRefusal extends Error {
  constructor(code, message) {
    // The code leads the message: an Error crossing Electron's IPC arrives in
    // the window as its message only.
    super(`${code}: ${message}`);
    this.name = "OutboxRefusal";
    this.code = code;
  }
}

const REFUSALS = {
  NOT_SIGNED_IN: "Sign in to act on a change waiting on this computer.",
  OUTBOX_OTHER_ACCOUNT:
    "This change was recorded by another account on this computer. Only that " +
    "account can discard it, retry it or save a copy; it is sent when they sign in here.",
  OUTBOX_OWNERLESS:
    "This change was recorded before this computer noted who made it. It is kept " +
    "for review and cannot be discarded, retried or copied from here.",
};

/**
 * What a person may do to a queued change from the sync panel — Discard, Try
 * again, Save a copy — and only to their OWN.
 *
 * The owner's decision: another account's entries, and entries with no owner,
 * are read-only. Enforced here, in the main process, not only by the window
 * hiding the buttons: the window is the web app, and a check that lives only
 * there is one any renderer bug or console call steps around. Discarding a
 * colleague's queued payment loses their record of money taken; retrying it
 * changes its key and status; a saved copy is their data in a file. An
 * ownerless entry is never dropped — reviewing those is separate work.
 *
 * A refused call changes nothing: the check runs before any write, and both
 * happen in one synchronous turn, so nothing can interleave.
 *
 * @param {object}   o
 * @param {object}   o.queue        outbox(db)
 * @param {object}   [o.docs]       store.documents(db), to undo a discard's local rows
 * @param {object}   [o.state]      store.state(db), to re-pull a row whose server copy was not kept
 * @param {Function} o.currentUser  () => the signed-in account's id, or null
 */
const ownOutboxActions = ({ queue, docs = null, state = null, currentUser }) => {
  /** The entry if it is this account's; null if there is no such entry. */
  const own = (seq) => {
    const userId = currentUser() ?? null;
    const owner  = queue.ownership(seq, userId);
    if (owner === null) return null;   // already sent or discarded: nothing to alter
    if (owner === "mine") return queue.get(seq);
    // Ownerless first: it is read-only whoever is signed in, and saying so is
    // more use than "sign in".
    if (owner === "none") throw new OutboxRefusal("OUTBOX_OWNERLESS", REFUSALS.OUTBOX_OWNERLESS);
    if (!userId) throw new OutboxRefusal("NOT_SIGNED_IN", REFUSALS.NOT_SIGNED_IN);
    throw new OutboxRefusal("OUTBOX_OTHER_ACCOUNT", REFUSALS.OUTBOX_OTHER_ACCOUNT);
  };

  return {
    /** Try again. Throws OutboxRefusal for an entry that is not this account's. */
    unblock(seq) {
      if (own(seq)) queue.unblock(seq);
    },

    /**
     * Discard, and undo the local rows it wrote — or the desktop keeps showing
     * something the server has never heard of. Throws OutboxRefusal, before
     * anything is removed, for an entry that is not this account's.
     *
     * Undo, not delete. A row this request CREATED goes. A row it EDITED goes
     * back to the server's version kept under it (store.put, migration 5):
     * deleting it, as this used to, made an existing pupil or payment vanish
     * until the server next changed it, since the cursor is already past it.
     *
     * A row another queued request also wrote is left as it is — still
     * pending, showing that later change, which carries on. A row written
     * before its server version was kept (base unknown): a POST's own new row
     * goes as before; anything else is un-pended and its collection re-pulled
     * from the start, so the server's copy comes back rather than nothing.
     */
    discard(seq) {
      if (!own(seq)) return null;
      const undoRows = () => {
        const undo = queue.discard(seq);
        if (!docs || !undo) return undo;
        const rows = [
          ...(undo.collection && undo.docId ? [{ collection: undo.collection, docId: undo.docId, primary: true }] : []),
          ...(undo.extraDocs ?? []).filter((e) => e?.collection && e?.docId),
        ];
        for (const { collection, docId, primary } of rows) {
          if (queue.queuedFor(collection, docId)) continue;
          if (docs.restore(collection, docId) !== "unknown") continue;
          if (primary && undo.method === "POST") { docs.forget(collection, docId); continue; }
          docs.settle(collection, docId);
          state?.resetCursor(collection);
        }
        return undo;
      };
      // One commit: the entry gone and its rows undone, or neither.
      return docs ? docs.tx(undoRows) : undoRows();
    },

    /** The whole entry, to save a copy of. Throws OutboxRefusal as above. */
    entryForCopy(seq) {
      return own(seq);
    },
  };
};

module.exports = {
  outbox, isRetryable, BACKOFF_SECONDS, ownOutboxActions, OutboxRefusal, ownerFor,
};
