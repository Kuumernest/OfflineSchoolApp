// backend/src/db/models/SyncOverwrite.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * SyncOverwrite records a case where one admin's edit silently
 * replaced another admin's more recent edit. Used to give the
 * "loser" visibility of what happened.
 *
 * LWW (last-write-wins) still applies at the sync layer.
 * This model provides the audit trail.
 */
const syncOverwriteSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    // What was overwritten
    entityType:  { type: String, required: true, index: true },  // e.g. "student"
    entityId:    { type: String, required: true, index: true },  // the record's id
    entityName:  { type: String, default: null },                // display label

    // Scoping
    schoolId:    { type: String, required: true, index: true },

    // Who won (the admin whose edit was applied)
    overwrittenBy:    { type: String, ref: "User", default: null },
    overwrittenByName:{ type: String, default: null },
    overwrittenAt:    { type: Date,   default: () => new Date() },
    newAction:        { type: String, default: null },  // e.g. "suspend", "move", "delete"

    // Who lost (the admin whose edit got replaced)
    lostEditBy:      { type: String, ref: "User", default: null },
    lostEditByName:  { type: String, default: null },
    lostEditAt:      { type: Date,   default: null },

    // Snapshot of the version that was replaced (so we can show a diff)
    lostVersion:     { type: mongoose.Schema.Types.Mixed, default: null },

    // Resolution tracking
    seenByLoser:     { type: Boolean, default: false, index: true },
    seenAt:          { type: Date,    default: null },
    dismissedAt:     { type: Date,    default: null },
  },
  {
    timestamps: true,
    _id:        false,
  }
);

// Query optimisation: fetch unseen overwrites for a specific user in a school
syncOverwriteSchema.index({ schoolId: 1, lostEditBy: 1, seenByLoser: 1, createdAt: -1 });

// Query optimisation: fetch all overwrites for admin dashboard
syncOverwriteSchema.index({ schoolId: 1, createdAt: -1 });

module.exports =
  mongoose.models.SyncOverwrite || mongoose.model("SyncOverwrite", syncOverwriteSchema);