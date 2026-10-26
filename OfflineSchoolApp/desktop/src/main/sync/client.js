// desktop/src/main/sync/client.js
"use strict";

/**
 * Talking to the server.
 *
 * ── Where the token lives ─────────────────────────────────────────────────
 *
 * In memory, in this process, and nowhere else. The renderer signs in and hands
 * it over; nothing writes it to disk.
 *
 * That is a deliberate cost. It means a sync cannot run before somebody has
 * opened the app and signed in, so the machine will not quietly catch up
 * overnight. The alternative is a long-lived credential sitting in a file on an
 * office computer that several people use, which is a worse trade for a school:
 * the database on that machine is already the school's records, but a token is
 * the ability to act as that person against the server from anywhere.
 *
 * ── Why fetch and not axios ───────────────────────────────────────────────
 *
 * Node 24 has fetch, and the main process has no need of interceptors — the
 * renderer's axios instance owns token refresh and the request queue. Adding a
 * second HTTP stack with its own retry behaviour would mean two places deciding
 * what a failure means.
 */

/** Long enough for a slow connection, short enough not to hang a sync cycle. */
const TIMEOUT_MS = 30_000;

/**
 * For a page of the feed. A hosted server that sleeps when idle (Render's free
 * tier) takes 30–60 s to answer its first request, and the first page of a
 * first sync is up to 500 rows of every collection on top of that. At 30 s the
 * first pull after the server had slept timed out every time, the cycle was
 * reported as "offline", and the screens stayed empty for a server that was
 * on its way up.
 */
const PULL_TIMEOUT_MS = 90_000;

/**
 * A failure the caller can act on.
 *
 * `status` is null for anything that never reached the server — no route to
 * host, DNS, a dropped connection — which is the ordinary offline case and the
 * only one worth retrying blindly.
 */
class SyncError extends Error {
  constructor(message, { status = null, code = null, body = null } = {}) {
    super(message);
    this.name   = "SyncError";
    this.status = status;
    this.code   = code;
    this.body   = body;
  }
}

let PACKAGED_DEFAULT = "";
try { PACKAGED_DEFAULT = String(require("../../../package.json").config?.defaultServerUrl || ""); } catch { /* none */ }

const client = ({ meta }) => {
  // Never persisted. See the note above.
  let token = null;

  // Set on the first-run screen (meta, persisted); or for a test run, the
  // environment; or the address this installer was built for
  // (package.json config.defaultServerUrl, written by the release workflow).
  const baseUrl = () =>
    (meta.get("serverUrl") || process.env.SCHOOL_SERVER_URL || PACKAGED_DEFAULT || "").replace(/\/+$/, "");

  /**
   * @param {string} [idemKey] Sent as Idempotency-Key. See replay() below.
   */
  const request = async (method, path, body, idemKey, { timeoutMs = TIMEOUT_MS } = {}) => {
    const base = baseUrl();
    if (!base)  throw new SyncError("No server address configured", { code: "NO_SERVER" });
    if (!token) throw new SyncError("Not signed in", { code: "NO_TOKEN" });

    // AbortSignal.timeout rather than a manual timer: a hung socket has to
    // release the sync loop, and a leaked timer per request would keep the
    // process from ever going idle.
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization:  `Bearer ${token}`,
          ...(idemKey ? { "Idempotency-Key": String(idemKey) } : {}),
        },
        body:   body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No status: it never arrived. Reported as retryable rather than as a
      // refusal, which is the distinction the outbox depends on.
      throw new SyncError(err.message || "Could not reach the server", {
        code: err.name === "TimeoutError" ? "TIMEOUT" : "OFFLINE",
      });
    }

    let payload = null;
    try { payload = await res.json(); } catch { /* not every response is json */ }

    if (!res.ok) {
      throw new SyncError(
        payload?.message || `${method} ${path} failed with ${res.status}`,
        { status: res.status, code: payload?.code ?? null, body: payload }
      );
    }

    return payload;
  };

  return {
    /** Called by the renderer whenever it signs in or refreshes. */
    setToken(next) { token = next || null; },
    hasToken() { return Boolean(token); },

    /** The address of the school's server, stored so it survives a restart. */
    serverUrl: baseUrl,
    setServerUrl(url) { meta.set("serverUrl", String(url || "").replace(/\/+$/, "")); },

    /** One page of changes, for the collections named. */
    changes({ collections, cursors, limit = 500, schoolId = null }) {
      const params = new URLSearchParams();
      // Omitted entirely when there is no list: the server then sends everything
      // this caller may have, which is what keeps the collection list in one
      // place. See the note in engine.js pull().
      if (collections?.length) params.set("collections", collections.join(","));
      if (cursors && Object.keys(cursors).length) params.set("cursors", JSON.stringify(cursors));
      params.set("limit", String(limit));
      // Read by the server only for a super_admin, who has no school of their
      // own: without it the feed answers them with nothing at all (tenantFilter
      // in syncFeed.controller.js). Everybody else's school comes from the token.
      if (schoolId) params.set("schoolId", String(schoolId));
      return request("GET", `/api/sync/changes?${params}`, undefined, undefined, { timeoutMs: PULL_TIMEOUT_MS });
    },

    /**
     * Replay one queued write, exactly as the UI made it.
     *
     * ── The Idempotency-Key is what makes this safe at all ──────────────────
     *
     * A queued request can be sent more than once: the commonest case is a
     * connection that dropped after the request arrived and before the response
     * came back, which is indistinguishable from one that never arrived.
     *
     * Two of the endpoints mirrored so far survive that because they accept a
     * client-generated _id and answer a replay with the row they already have.
     * Almost none of the others do — POST /api/exams hard-codes uuidv4(), so a
     * replay would create a SECOND exam — and this layer replayed everything
     * with no protection at all.
     *
     * The server already has the general answer: middleware/idempotency.js is
     * mounted on all of /api and, given this header, records the first attempt
     * and returns the STORED RESPONSE to any repeat. So every write becomes
     * replayable without changing a hundred endpoints, and the outbox's own
     * unique idem_key is exactly the value it wants.
     */
    replay({ method, path, body, idem_key: idemKey }) {
      return request(method, path, body, idemKey);
    },

    request,
    SyncError,
  };
};

module.exports = { client, SyncError, TIMEOUT_MS, PULL_TIMEOUT_MS };
