"use strict";

const IdempotencyKey = require("../src/db/models/IdempotencyKey");

/*
 * A "processing" record older than this is taken over by the next request
 * with its key instead of answering 409 IDEMPOTENCY_IN_PROGRESS.
 *
 * A record stays "processing" when its request never completed through
 * res.json: the process died mid-handler, or the handler answered with
 * res.send/res.end/a stream. Before this it stayed so for the key's whole
 * 14-day life, and every retry of that queued change — mobile and desktop
 * outboxes reuse one key per change — was told "in progress" until the TTL.
 *
 * Longer than the longest a request may run (server.timeout, 10 minutes in
 * server.js), so a request still being handled is never taken over. The cost
 * of a takeover is the cost of no key: the request runs again.
 */
const STALE_PROCESSING_MS = 11 * 60 * 1000;

/*
 * Fields never kept in a stored response. The body is replayed to the same
 * user for 14 days, and is readable by anyone with database access for as
 * long: a temporary password (staff creation, approvals) is a credential.
 * A replay answers without it; the admin resets the password if the first
 * answer was lost.
 */
const NOT_STORED = new Set(["tempPassword"]);

function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!NOT_STORED.has(k)) out[k] = withoutSecrets(v);
  }
  return out;
}

module.exports = async function idempotency(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const key = req.get("Idempotency-Key");
  const userId = req.user?._id || req.user?.id;
  if (!key || !userId) return next();
  const query = { key, userId: String(userId) };
  try {
    try {
      await IdempotencyKey.create({
        key, userId: String(userId), method: req.method,
        path: req.baseUrl + req.path, state: "processing",
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const prior = await IdempotencyKey.findOne(query).lean();
      if (prior?.state === "completed") {
        return res.status(prior.statusCode).json(prior.response);
      }
      // Abandoned, not in progress: claimed atomically, so of two retries
      // racing for it exactly one runs.
      const claimed = await IdempotencyKey.findOneAndUpdate(
        { ...query, state: "processing", updatedAt: { $lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
        { $set: { method: req.method, path: req.baseUrl + req.path } },
      );
      if (!claimed) {
        return res.status(409).set("Retry-After", "2").json({
          success: false, code: "IDEMPOTENCY_IN_PROGRESS",
          message: "An identical request is already being processed",
        });
      }
    }
    const send = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      if (statusCode >= 500) {
        IdempotencyKey.deleteOne(query).catch(() => {});
      } else {
        IdempotencyKey.updateOne(query, {
          $set: { state: "completed", statusCode, response: withoutSecrets(body) },
        }).catch((err) => console.warn("Idempotency completion failed:", err.message));
      }
      return send(body);
    };
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports.STALE_PROCESSING_MS = STALE_PROCESSING_MS;
