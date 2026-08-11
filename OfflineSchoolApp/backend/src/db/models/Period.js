// backend/src/db/models/Period.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const periodSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────
    _id: {
      type:    String,
      default: uuidv4,
    },

    schoolId: {
      type:     String,
      ref:      "School",
      required: true,
      index:    true,
    },

    // ── Period info ───────────────────────────────────────────────────────
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    startTime: {
      type:     String,   // "HH:MM"
      required: true,
      validate: {
        validator: (v) => /^\d{2}:\d{2}$/.test(v),
        message:   "startTime must be in HH:MM format",
      },
    },

    endTime: {
      type:     String,   // "HH:MM"
      required: true,
      validate: {
        validator: (v) => /^\d{2}:\d{2}$/.test(v),
        message:   "endTime must be in HH:MM format",
      },
    },

    sortOrder: { type: Number,  default: 0     },
    isBreak:   { type: Boolean, default: false },

    // ── State ─────────────────────────────────────────────────────────────
    isActive:  { type: Boolean, default: true, index: true },
    deletedAt: { type: Date,    default: null              },

    // ── Sync ──────────────────────────────────────────────────────────────
    version: { type: Number, default: 1 },

    // ── Meta ──────────────────────────────────────────────────────────────
    assignedBy: { type: String, ref: "User", default: null },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

periodSchema.index({ schoolId: 1, sortOrder: 1                });
periodSchema.index({ schoolId: 1, startTime: 1, endTime:    1 });
periodSchema.index({ schoolId: 1, isActive:  1, deletedAt:  1 });

module.exports = mongoose.models.Period || mongoose.model("Period", periodSchema);