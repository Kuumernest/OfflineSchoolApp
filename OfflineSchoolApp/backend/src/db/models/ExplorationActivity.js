// backend/src/db/models/ExplorationActivity.js
"use strict";

/**
 * A school's own addition to the exploration catalog.
 *
 * The shipped catalog lives in shared/exploration/catalog.js and is offline
 * by construction. A school may add activities of its own — a local
 * competition, a club's project — in the same shape, validated by the same
 * validateActivity, versioned the same way, and carrying nothing about any
 * pupil. Retired activities stay: an exploration that names one must still
 * be readable years later.
 */

const mongoose = require("mongoose");

const explorationActivitySchema = new mongoose.Schema(
  {
    _id:      { type: String, required: true },          // the activityId
    schoolId: { type: String, required: true, index: true },
    version:  { type: Number, required: true, default: 1 },
    definition: { type: mongoose.Schema.Types.Mixed, required: true },
    status:   { type: String, enum: ["active", "retired"], default: "active" },
    createdBy: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

module.exports =
  mongoose.models.ExplorationActivity ||
  mongoose.model("ExplorationActivity", explorationActivitySchema);
