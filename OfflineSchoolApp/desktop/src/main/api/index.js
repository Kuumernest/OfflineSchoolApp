// desktop/src/main/api/index.js
"use strict";

/**
 * The server's HTTP contract, answered locally.
 *
 * ── The shape of the whole idea ───────────────────────────────────────────
 *
 * The React console makes HTTP calls. On the desktop those calls arrive here
 * instead of going out, and are answered from the local mirror. Nothing in the
 * UI knows: no component was rewritten, no hook changed, no build flag threaded
 * through the app. There are 225 call sites in that codebase and this is one
 * seam in front of all of them.
 *
 * ── Why the handlers live in the main process ─────────────────────────────
 *
 * Because they sit next to the database. Written in the renderer they would each
 * make several IPC round trips — a fee ledger reads charges, payments, a plan
 * and a school — and every one of those is a message hop. Here the whole request
 * is one hop and the queries are synchronous against a local file.
 *
 * It also makes them testable in a way they otherwise could not be: plain
 * JavaScript in a Node process, which means the real Express app can be loaded
 * ALONGSIDE them and the two answers compared on identical data. That is what
 * scripts/check-api-parity.js does, and it is the only honest way to know a
 * local handler reproduces an endpoint — reading the endpoint and reimplementing
 * it by eye is how the two drift.
 *
 * ── Not implemented is a first-class answer ───────────────────────────────
 *
 * A request this file does not recognise returns null, and the renderer sends it
 * over the network as it always did. So the coverage grows endpoint by endpoint
 * with nothing broken in between, and a screen that is not yet offline behaves
 * exactly as it does today rather than failing in a new way.
 */

const reads = [
  ...require("./handlers/students"),
  ...require("./handlers/fees"),
  ...require("./handlers/school"),
  ...require("./handlers/finance"),
  ...require("./handlers/payroll"),
  ...require("./handlers/approvals"),
  ...require("./handlers/attendance"),
  ...require("./handlers/exams"),
  ...require("./handlers/results"),
  ...require("./handlers/announcements"),
  ...require("./handlers/templates"),
  ...require("./handlers/settings"),
  ...require("./handlers/promotion"),
];

/**
 * Writes are a different kind of entry.
 *
 * A read handler answers. A write handler PREPARES: it returns the row to store,
 * the request to queue and the response to give back, and the dispatcher commits
 * the first two together. Keeping the commit here rather than in each handler
 * means no handler can store a document without queueing the request that makes
 * it real, or queue a request without showing the user what they just did.
 */
const writes = require("./writes");

/**
 * Turn "/api/fees/students/:studentId" into something matchable.
 *
 * Deliberately tiny. A path-to-regexp dependency would bring wildcards,
 * optional segments and modifiers, none of which this needs, and each of which
 * is a way for a route to match more than its author intended — which here
 * would mean one endpoint answering with another's shape.
 */
const compile = (pattern) => {
  const [method, path] = pattern.split(" ");
  const names = [];

  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) {
        // Escaped: a literal segment must match itself and nothing else.
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      names.push(segment.slice(1));
      // One segment only. [^/]+ rather than .+ so /students/1/scores cannot be
      // captured as an id of "1/scores".
      return "([^/]+)";
    })
    .join("/");

  return { method: method.toUpperCase(), regex: new RegExp(`^${source}$`), names };
};

const table = [
  ...reads.map((h)  => ({ ...h, kind: "read",  ...compile(h.route) })),
  ...writes.map((h) => ({ ...h, kind: "write", ...compile(h.route) })),
];

/**
 * Answer a request from the mirror, or say that this one has to go out.
 *
 * @param   {object} req  { method, path, query, body }
 * @param   {object} ctx  { docs, meta, queue, outbox }
 * @returns {object|null} { status, data } or null for "not handled here"
 */
const handle = (req, ctx) => {
  const method = String(req.method || "GET").toUpperCase();
  const path   = String(req.path || "");

  for (const entry of table) {
    if (entry.method !== method) continue;
    const match = entry.regex.exec(path);
    if (!match) continue;

    const params = {};
    entry.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });

    try {
      const result = entry.handler({
        params,
        query: req.query ?? {},
        body:  req.body  ?? {},
      }, ctx);

      // A handler may itself decline — a query parameter it does not support, a
      // body it would rather the server validated — and that has to fall through
      // to the network rather than return a subtly different answer.
      if (!result) return null;

      if (entry.kind === "read") return result;

      // ── A write: every row and the queued request commit together ────────
      //
      // Not separate operations. A document stored with nothing queued is a
      // change that will never reach the school; a request queued with no
      // document is a screen that does not show what the user just did. Either
      // alone is worse than neither.
      //
      // `also` is for the requests that change more than one document. Reversing
      // a payment appends the opposite-signed row AND stamps the original, and
      // the stamp is what stops the same payment being reversed twice — so the
      // two have to land together or the screen offers an action the server will
      // refuse. The ids go into the queue entry as well, because a row nothing
      // settles stays pending for ever.
      const { collection, doc, also = [], request, response } = result;

      const queued = ctx.docs.tx(() => {
        const id = ctx.docs.put(collection, doc, { pending: true });

        const extraDocs = also.map((row) => ({
          collection: row.collection,
          docId:      ctx.docs.put(row.collection, row.doc, { pending: true }),
        }));

        return ctx.queue.add({ ...request, collection, docId: id, extraDocs });
      });

      /**
       * ── A response that depends on what was just written ─────────────────
       *
       * Most writes can describe their own answer before anything is stored.
       * Some cannot: reversing a payment answers with the family's balance, and
       * a balance computed before the reversal row exists still includes the
       * money that was just taken back off the account.
       *
       * So a handler may return `response` as a function instead of an object,
       * and it is called HERE — after the transaction, with the same context the
       * handler had. Which keeps the awkwardness in the one place that needs it
       * rather than making every handler carry a two-phase shape.
       */
      const answer = typeof response === "function" ? response(ctx) : response;

      // `queued` sits on the envelope, not in the response body: the body is a
      // contract the screens read and must match the server's exactly.
      return { ...answer, queued: true, seq: queued.seq, duplicate: queued.duplicate };
    } catch (err) {
      // A handler throwing is a bug in this file, not a server error. Reported
      // as one rather than dressed up as a 500, so it is visible in development
      // and falls back to the network in production.
      console.error(`[api] ${method} ${path} failed locally: ${err.message}`);
      return null;
    }
  }

  return null;
};

/** Which routes are answered locally — for the diagnostics screen. */
const routes = () => table.map((e) => `${e.kind === "write" ? "queue" : "read"} ${e.route}`);

module.exports = { handle, routes, compile };
