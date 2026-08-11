const mongoose = require("mongoose");

const syncLogSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    deviceId: {
      type: String,
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
    operationId: {
      type: String,
      required: true,
      // Client's queue item ID
    },
    collection: {
      type: String,
      required: true,
    },
    operation: {
      type: String,
      enum: ["create", "update", "delete"],
      required: true,
    },
    documentId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["synced", "conflict", "rejected"],
      required: true,
    },
    clientVersion: { type: Number },
    serverVersion: { type: Number },
    error: { type: String },
    syncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    _id: false,
  }
);

syncLogSchema.index({ deviceId: 1 });
syncLogSchema.index({ documentId: 1 });
syncLogSchema.index({ syncedAt: -1 });
syncLogSchema.index({ collection: 1, operation: 1 });

module.exports = mongoose.model("SyncLog", syncLogSchema);