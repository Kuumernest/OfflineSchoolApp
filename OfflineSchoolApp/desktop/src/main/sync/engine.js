// desktop/src/main/sync/engine.js
"use strict";

/**
 * Getting the local mirror and the server to agree.
 *
 * ── Push before pull, always ──────────────────────────────────────────────
 *
 * The order is not a preference. Pulling first would fetch the server's copy of
 * a document this machine has already changed but not yet sent, and the merge
 * would then have to choose between two versions with no way to know that ours
 * is newer. Pushing first removes the question: by the time a page arrives, our
 * write has either been accepted — so the server's version IS the newer one and
 * taking it is correct — or refused, in which case it is sitting blocked in the
 * outbox and merge() leaves the local row alone.
 *
 * ── One cycle at a time ───────────────────────────────────────────────────
 *
 * Two overlapping cycles would push the same queued request twice and write the
 * same cursor from two places. The server would survive it — the requests are
 * idempotent — but the second push would see a queue the first has already
 * emptied and log failures for work that succeeded.
 *
 * ── What it does not do ───────────────────────────────────────────────────
 *
 * Resolve conflicts. There is no field-level merge, no last-write-wins, no
 * vector clocks. A document is either the server's or this machine's, decided by
 * whether our write reached it. That is a small enough answer to hold in your
 * head, and for this domain it is also the right one: two people editing the
 * same pupil's name in the same hour is rare, and a wrong automatic merge of a
 * fee payment is much worse than a refusal somebody has to look at.
 */

const { SyncError } = require("./client");

/** Between cycles when nothing is waiting. */
const IDLE_INTERVAL_MS = 60_000;

/** After a cycle that could not reach the server. */
const OFFLINE_INTERVAL_MS = 15_000;

/** How many pages of one collection to take in a single cycle. */
const MAX_PAGES_PER_CYCLE = 40;

/**
 * @param feedCollections  Optional. Leave it out — see the note in pull().
 */
const engine = ({ docs, queue, state, client, feedCollections = null, onChange = () => {} }) => {
  let running  = false;
  let timer    = null;
  let stopped  = false;

  /** The last thing that happened, for the UI to render. */
  let status = {
    phase:      "idle",   // idle | pushing | pulling | offline | blocked | unauthenticated
    lastCycleAt: null,
    lastError:   null,
    pushed:      0,
    pulled:      0,
  };

  const publish = (next) => {
    status = { ...status, ...next };
    onChange(status);
  };

  // ── PUSH ────────────────────────────────────────────────────────────────

  /**
   * Send what is waiting, oldest first, stopping at the first thing that cannot
   * go.
   *
   * @returns {Promise<{sent:number, stopped:string|null}>}
   */
  const push = async () => {
    let sent = 0;

    // Re-read each time rather than iterating one snapshot: a success removes an
    // entry and a failure may block the queue, so the batch after this one is a
    // different batch.
    for (;;) {
      const batch = queue.nextBatch(1);
      if (!batch.length) return { sent, stopped: null };

      const item = batch[0];

      try {
        const answer = await client.replay(item);

        // The server has it. The local rows are no longer provisional.
        queue.markSent(item.seq);

        // Rows this request changed besides the primary — see the note on
        // extra_docs in schema.js. Settled FIRST so that an exception thrown
        // while taking the response's copy below cannot leave them pending: a
        // pending row is never overwritten by a pull, so it would disagree with
        // the server permanently rather than until the next cycle.
        for (const extra of item.extraDocs ?? []) {
          if (extra?.collection && extra?.docId) docs.settle(extra.collection, extra.docId);
        }

        if (item.collection && item.doc_id) {
          docs.settle(item.collection, item.doc_id);

          /**
           * ── Correcting the local guess from the server's answer ────────────
           *
           * The server fills in things the client could not know, and a receipt
           * number is exactly that: without this the mirror keeps the number it
           * invented and the bursar's printed paper does not match the record.
           *
           * ── This copy is transient, and that matters ───────────────────────
           *
           * A write response is not shaped like a feed document. The feed sends
           * lean Mongo rows; an endpoint returns a mongoose document, and
           * FeePayment sets toJSON: { virtuals: true } with isReversal and
           * isReversed declared on it — so the response carries three keys
           * (those two and the id virtual) that no feed document has.
           *
           * They land in the mirror and are replaced by the pull in this same
           * cycle, which is what push-before-pull is for. So the mirror's shape
           * between the two halves is not something to depend on, and nothing
           * does: the reads answer from whatever the row holds.
           *
           * Filtering them out here was tried and reverted. The only rule that
           * needs no list of virtuals is "keep the keys the local guess already
           * had" — and that drops the receipt number in the case where the
           * server issues one the client never had, which is the very reason
           * this copy is taken. A narrower fix belongs on the server, where the
           * write response and the feed could be made to agree.
           */
          const stored = answer?.data ?? answer?.admin ?? answer?.teacher ?? null;
          if (stored && (stored._id ?? stored.id)) docs.put(item.collection, stored);
        }
        sent++;
      } catch (err) {
        if (!(err instanceof SyncError)) throw err;

        // A token that will not authenticate stops the whole cycle rather than
        // burning through the queue marking everything blocked. Nothing is
        // wrong with the requests; the session is over.
        if (err.status === 401) return { sent, stopped: "unauthenticated" };

        const decision = queue.markFailed(item.seq, {
          status:  err.status,
          // The server's own code, so the queue can tell a refusal from a
          // request that is simply still being processed.
          code:    err.code,
          message: err.message,
        });

        // Either way the queue does not move: a retry is not due yet, and a
        // block is a full stop until somebody deals with it.
        return { sent, stopped: decision === "blocked" ? "blocked" : "waiting" };
      }
    }
  };

  // ── PULL ────────────────────────────────────────────────────────────────

  /**
   * Take everything new, one page at a time, remembering the place as it goes.
   *
   * Each page is stored together with its cursor in a single transaction. An
   * interrupted first sync of a large school therefore resumes where it stopped
   * rather than starting again — which over the connections this is built for is
   * the difference between finishing and never finishing.
   */
  const pull = async () => {
    let pulled = 0;
    const refusedNow = [];
    const heldBack   = [];

    // WHAT TO ASK FOR: nothing, normally.
    //
    // Omitting the parameter means "everything I am allowed to have", and the
    // server answers with the collections this caller's capabilities permit.
    // The alternative — a list of collection names kept here — would be a copy
    // of the server's feed table living in a separately-released application,
    // and the two would drift the first time a collection was added. This way a
    // change to the feed reaches every desktop on its next sync with no release
    // at all.
    //
    // A list may still be passed, which the tests use to keep their fixtures
    // small.
    let collections = feedCollections;

    for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
      // Cursors for everything already seen. Read from the table rather than
      // from a list of names, so a collection whose name this build has never
      // heard of still resumes from where it got to.
      const cursors = {};
      for (const row of state.all()) {
        if (!row.cursor) continue;
        if (collections && !collections.includes(row.collection)) continue;
        cursors[row.collection] = row.cursor;
      }

      const answer = await client.changes({ collections, cursors });

      for (const r of answer.refused ?? []) refusedNow.push(r);

      // A refused collection is dropped from subsequent pages rather than asked
      // for forty times over. Only possible when an explicit list was given —
      // with no list the server simply does not offer what it will not send.
      if (collections && answer.refused?.length) {
        const gone = new Set(answer.refused.map((r) => r.collection));
        collections = collections.filter((c) => !gone.has(c));
      }

      let more = false;

      for (const [name, slice] of Object.entries(answer.collections ?? {})) {
        if (slice.error) continue;

        const before = state.cursorFor(name);

        // The page and its cursor commit together. Written the other way round,
        // an interruption between the two either loses the rows or loses the
        // place; there is no safe order for two separate commits.
        docs.tx(() => {
          let cursor = slice.cursor;

          if (slice.documents?.length) {
            const { stored, held, firstHeldIndex } = docs.merge(name, slice.documents);
            pulled += stored;
            for (const id of held) heldBack.push(`${name}/${id}`);

            // THE CURSOR MAY NOT PASS A DOCUMENT THAT WAS NOT STORED.
            //
            // merge() leaves a row alone while a local write to it is still
            // waiting. If the cursor moved past that document anyway, the
            // server's version would never be offered again once the local
            // write settled, and the mirror would differ from the server for
            // ever with nothing to notice it. So the cursor stops at the last
            // document actually taken before the first one held.
            //
            // The cost is that this collection stops advancing while that write
            // is stuck — which is a stall, and visible, rather than a silent
            // divergence. A blocked write is already a state somebody has to
            // resolve.
            if (firstHeldIndex === 0) {
              cursor = before;
            } else if (firstHeldIndex > 0) {
              const last = slice.documents[firstHeldIndex - 1];
              cursor = Buffer.from(JSON.stringify({
                at: new Date(last.updatedAt).toISOString(),
                id: String(last._id ?? last.id),
              })).toString("base64url");
            }
          }

          if (cursor) state.setCursor(name, cursor);
        });

        // Only worth another page if this one actually moved. A cursor held
        // back by a pending row would otherwise be re-requested up to the page
        // ceiling, fetching the same documents every time.
        if (slice.hasMore && state.cursorFor(name) !== before) more = true;
      }

      if (!more) break;
    }

    return { pulled, refused: refusedNow, heldBack };
  };

  // ── ONE CYCLE ───────────────────────────────────────────────────────────

  const cycle = async () => {
    if (running || stopped) return status;
    running = true;

    try {
      if (!client.hasToken()) {
        publish({ phase: "unauthenticated", lastError: null });
        return status;
      }
      if (!client.serverUrl()) {
        publish({ phase: "unauthenticated", lastError: "No server address configured" });
        return status;
      }

      publish({ phase: "pushing" });
      const pushed = await push();

      if (pushed.stopped === "unauthenticated") {
        publish({ phase: "unauthenticated", pushed: pushed.sent });
        return status;
      }

      // Pulled even when the queue is stuck. A blocked write is one document's
      // problem; refusing to take any news from the server because of it would
      // make the whole machine stale over something the bursar may not look at
      // until Friday.
      publish({ phase: "pulling", pushed: pushed.sent });
      const pulledResult = await pull();

      publish({
        phase:       pushed.stopped === "blocked" ? "blocked" : "idle",
        lastCycleAt: new Date().toISOString(),
        lastError:   null,
        pushed:      pushed.sent,
        pulled:      pulledResult.pulled,
        refused:     pulledResult.refused,
        heldBack:    pulledResult.heldBack,
      });

      return status;
    } catch (err) {
      const offline = err instanceof SyncError && err.status === null;
      publish({
        phase:     offline ? "offline" : "idle",
        lastError: err.message,
        lastCycleAt: new Date().toISOString(),
      });
      return status;
    } finally {
      running = false;
    }
  };

  // ── SCHEDULING ──────────────────────────────────────────────────────────

  const scheduleNext = () => {
    if (stopped) return;
    clearTimeout(timer);

    const wait =
      status.phase === "offline" ? OFFLINE_INTERVAL_MS :
      IDLE_INTERVAL_MS;

    timer = setTimeout(async () => { await cycle(); scheduleNext(); }, wait);
    // Never a reason to keep the process alive on its own.
    timer.unref?.();
  };

  return {
    /** Run one cycle now — on sign-in, on a local write, on a button. */
    cycle,

    start() {
      stopped = false;
      scheduleNext();
    },

    stop() {
      stopped = true;
      clearTimeout(timer);
    },

    status: () => status,
  };
};

module.exports = {
  engine,
  IDLE_INTERVAL_MS,
  OFFLINE_INTERVAL_MS,
  MAX_PAGES_PER_CYCLE,
};
