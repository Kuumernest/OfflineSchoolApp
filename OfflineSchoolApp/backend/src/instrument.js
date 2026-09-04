// backend/src/instrument.js
"use strict";

/**
 * Error reporting. Required first, before anything else in server.js.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 *
 * This system is built to fail quietly. That is a feature everywhere else and a
 * problem here: the mobile outbox absorbs a failed write and retries it later,
 * the desktop answers a read from its own database when the server cannot be
 * reached, and a dashboard figure that cannot be fetched renders as a zero. Each
 * of those is the right behaviour for a school with no connection, and each one
 * also means a genuine fault reaches nobody. Every bug found in the last audit
 * was invisible from outside the code.
 *
 * So the server needs somewhere to say "that threw", or the first report of a
 * fault is a head teacher on the telephone describing a screen.
 *
 * ── Inert without a DSN ───────────────────────────────────────────────────────
 *
 * Sentry.init() with no dsn disables the SDK: no network, no queue, no cost. A
 * developer, a CI run and a school that has not been given a DSN all behave
 * exactly as they did before this file existed. Nothing here is required for the
 * server to boot.
 *
 * ── What is deliberately NOT sent ─────────────────────────────────────────────
 *
 * This database holds children's names, photographs, guardian telephone numbers
 * and medical notes, and it is not ours to forward to a third party because a
 * stack trace happened to be near it. sendDefaultPii stays off, and beforeSend
 * strips the request body, the query string, the cookies and the Authorization
 * header before anything leaves the process. What is kept is the shape of the
 * failure: route, method, status, stack. That is what a fix is made from.
 */

const Sentry = require("@sentry/node");

const dsn = (process.env.SENTRY_DSN || "").trim();

/** Header names worth keeping — everything else is dropped rather than judged. */
const SAFE_HEADERS = new Set([
  "host",
  "user-agent",
  "content-type",
  "content-length",
  "accept-language",
]);

const scrubRequest = (request) => {
  if (!request) return request;

  // The body is the whole point of the redaction: a POST to /api/students is a
  // child's record, and a POST to /api/auth/login is a password.
  delete request.data;
  delete request.cookies;

  // A query string carries schoolId and studentId, and sometimes a token.
  if (request.query_string) request.query_string = "[redacted]";

  // The URL keeps its path — the route is the useful part — but loses its query.
  if (typeof request.url === "string") {
    const q = request.url.indexOf("?");
    if (q !== -1) request.url = request.url.slice(0, q) + "?[redacted]";
  }

  if (request.headers && typeof request.headers === "object") {
    for (const name of Object.keys(request.headers)) {
      if (!SAFE_HEADERS.has(name.toLowerCase())) delete request.headers[name];
    }
  }

  return request;
};

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,

    // Off by default. Turning it on would attach IP addresses and usernames to
    // every event, which is precisely the data this file exists to withhold.
    sendDefaultPii: false,

    // Performance tracing is opt-in and sampled: a school's connection is the
    // scarce resource, and full tracing would spend it on telemetry. 0 by
    // default, so tracing costs nothing unless somebody asks for it.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),

    beforeSend(event) {
      scrubRequest(event.request);
      // Breadcrumbs record earlier requests, and carry the same payloads.
      if (Array.isArray(event.breadcrumbs)) {
        for (const crumb of event.breadcrumbs) {
          if (crumb && crumb.data) {
            delete crumb.data.body;
            delete crumb.data.query;
          }
        }
      }
      return event;
    },
  });

  console.log(
    `🛰️  Error reporting enabled (${process.env.NODE_ENV || "development"}) — ` +
    "request bodies, queries, cookies and auth headers are stripped before send"
  );
}

module.exports = { Sentry, enabled: Boolean(dsn) };
