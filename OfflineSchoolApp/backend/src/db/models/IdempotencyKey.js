"use strict";

const mongoose = require("mongoose");

/**
 * How long a stored answer to an Idempotency-Key is kept: 45 days.
 *
 * The supported offline period is 30 days (owner decision): a phone or desktop
 * may queue a write, stay offline that long, and then replay it. A replay is
 * only deduplicated while the key from its first attempt still exists, so the
 * key must outlive the offline period — 30 days plus a 15-day margin for a
 * device that comes back late, a first attempt that timed out just before it
 * went offline, and Mongo's TTL monitor running behind. Was 14 days.
 *
 * Changing this number does NOT change an existing database: Mongo keeps the
 * TTL an index was built with. db/ensureStudentIndexes.js
 * ensureIdempotencyIndex() brings the live index to this value at every boot
 * (collMod; drop + rebuild of the TTL index only if collMod cannot), and
 * scripts/check-idempotency-ttl.js pins a new database and an old one.
 */
const TTL_DAYS = 45;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

const schema = new mongoose.Schema({
  key: { type: String, required: true },
  userId: { type: String, required: true },
  method: { type: String, required: true },
  path: { type: String, required: true },
  state: { type: String, enum: ["processing", "completed"], default: "processing" },
  statusCode: { type: Number, default: null },
  response: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

schema.index({ key: 1, userId: 1 }, { unique: true });
schema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

module.exports = mongoose.models.IdempotencyKey ||
  mongoose.model("IdempotencyKey", schema);
module.exports.TTL_DAYS = TTL_DAYS;
module.exports.TTL_SECONDS = TTL_SECONDS;
