"use strict";

const IdempotencyKey = require("../src/db/models/IdempotencyKey");

module.exports = async function idempotency(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const key = req.get("Idempotency-Key");
  const userId = req.user?._id || req.user?.id;
  if (!key || !userId) return next();
  try {
    try {
      await IdempotencyKey.create({
        key, userId: String(userId), method: req.method,
        path: req.baseUrl + req.path, state: "processing",
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const prior = await IdempotencyKey.findOne({ key, userId: String(userId) }).lean();
      if (prior?.state === "completed") {
        return res.status(prior.statusCode).json(prior.response);
      }
      return res.status(409).set("Retry-After", "2").json({
        success: false, code: "IDEMPOTENCY_IN_PROGRESS",
        message: "An identical request is already being processed",
      });
    }
    const send = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      const query = { key, userId: String(userId) };
      if (statusCode >= 500) {
        IdempotencyKey.deleteOne(query).catch(() => {});
      } else {
        IdempotencyKey.updateOne(query, {
          $set: { state: "completed", statusCode, response: body },
        }).catch((err) => console.warn("Idempotency completion failed:", err.message));
      }
      return send(body);
    };
    return next();
  } catch (err) {
    return next(err);
  }
};
