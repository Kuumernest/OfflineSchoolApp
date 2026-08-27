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

const client = ({ meta }) => {
  // Never persisted. See the note above.
  let token = null;

  const baseUrl = () =>
    (meta.get("serverUrl") || process.env.SCHOOL_SERVER_URL || "").replace(/\/+$/, "");

  const request = async (method, path, body) => {
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
        },
        body:   body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
    changes({ collections, cursors, limit = 500 }) {
      const params = new URLSearchParams();
      // Omitted entirely when there is no list: the server then sends everything
      // this caller may have, which is what keeps the collection list in one
      // place. See the note in engine.js pull().
      if (collections?.length) params.set("collections", collections.join(","));
      if (cursors && Object.keys(cursors).length) params.set("cursors", JSON.stringify(cursors));
      params.set("limit", String(limit));
      return request("GET", `/api/sync/changes?${params}`);
    },

    /** Replay one queued write, exactly as the UI made it. */
    replay({ method, path, body }) {
      return request(method, path, body);
    },

    request,
    SyncError,
  };
};

module.exports = { client, SyncError, TIMEOUT_MS };
