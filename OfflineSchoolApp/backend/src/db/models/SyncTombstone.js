// backend/src/db/models/SyncTombstone.js
"use strict";

/**
 * The record that a row was HARD-deleted, so devices can learn it.
 *
 * The sync contract is in-row tombstones: a soft-deleted row (deletedAt set,
 * updatedAt moved) reaches a device through its updatedAt cursor, and the
 * device marks its copy deleted. A hard delete leaves no row, so nothing ever
 * reached the device and it kept the record for good. Subjects, teacher
 * assignments and students are hard-deleted (admin.routes, students.routes),
 * so for those this row stands in: GET /sync/pull turns it into the same
 * { _id, deletedAt } row the client already applies.
 *
 * Written by the syncTombstones plugin (db/plugins/syncTombstones.js) before
 * the delete runs, for every delete path. Kept indefinitely — a device can be
 * offline for a term, and a tombstone discarded before it reconnects is a
 * deletion it never sees. They are a few dozen bytes each.
 *
 * Also what refuses a stale upload that would recreate the record under its
 * old id (410 RECORD_DELETED).
 */

const mongoose = require("mongoose");
const { randomUUID } = require("crypto");

const ENTITIES = ["subject", "teacherAssignment", "student"];

const syncTombstoneSchema = new mongoose.Schema(
  {
    _id:       { type: String, default: () => randomUUID() },
    // null only for a legacy row that had none; such a tombstone reaches no device.
    schoolId:  { type: String, default: null },
    entity:    { type: String, required: true, enum: ENTITIES },
    docId:     { type: String, required: true },
    deletedAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false }
);

// One tombstone per deleted record; written by upsert, so repeating is harmless.
syncTombstoneSchema.index({ entity: 1, docId: 1 }, { unique: true, name: "sync_tombstone_entity_doc" });
// The pull's query: this school's deletions since the cursor.
syncTombstoneSchema.index({ schoolId: 1, deletedAt: 1 }, { name: "sync_tombstone_school_time" });

module.exports =
  mongoose.models.SyncTombstone || mongoose.model("SyncTombstone", syncTombstoneSchema);
module.exports.ENTITIES = ENTITIES;
