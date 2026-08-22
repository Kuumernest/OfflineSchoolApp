"use strict";

const mongoose = require("mongoose");

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
schema.index({ createdAt: 1 }, { expireAfterSeconds: 1209600 });

module.exports = mongoose.models.IdempotencyKey ||
  mongoose.model("IdempotencyKey", schema);
