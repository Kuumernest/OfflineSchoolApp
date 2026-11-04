// backend/src/db/models/SyncTombstone.js
"use strict";

/**
 * The record that a row was HARD-deleted, so devices can learn it.
 *
 * The sync contract is in-row tombstones: a soft-deleted row (deletedAt set,
 * updatedAt moved) reaches a device through its updatedAt cursor, and the
 * device marks its copy deleted. A hard delete leaves no row, so nothing ever
 * reached the device and it kept the record for good. Every mirrored model
 * that is hard-deleted carries the plugin, and for those this row stands in:
 * GET /sync/pull turns it into the same { _id, deletedAt } row the phone
 * already applies (subject, teacher assignment, pupil — the only three it
 * pulls), and GET /sync/changes sends it as a syncTombstone row the desktop
 * applies by removing `entity`/`docId` from its mirror.
 *
 * `entity` IS the desktop collection name (config/syncFeed.js FEED), because
 * the desktop removes the row from the collection the tombstone names. The
 * boot check in syncFeed.js asserts that, and that every mirrored model the
 * code hard-deletes is here.
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

const ENTITIES = [
  "subject", "teacherAssignment", "student", "user",
  // Recomputed results: a run removes the rows of pupils it no longer ranks.
  "resultSummary", "termResult", "annualResult",
  // Promotion: a reversal removes the next year's enrolments; a draft run is discarded.
  "enrollment", "promotionRun", "promotionDecision",
];

// Why a row leaves a mirror while it still exists on the server. Only one
// kind: a result unpublished. Non-admins mirror published results only
// (syncFeed publishedUnlessAdmin), so an unpublished row stops matching their
// feed and its published copy would stay on their machine for good.
const REASONS = ["unpublished"];

const syncTombstoneSchema = new mongoose.Schema(
  {
    _id:       { type: String, default: () => randomUUID() },
    // null only for a legacy row that had none; such a tombstone reaches no device.
    schoolId:  { type: String, default: null },
    entity:    { type: String, required: true, enum: ENTITIES },
    docId:     { type: String, required: true },
    // The deleted row's class, where it had one: a teacher's desktop mirrors
    // only the pupils of the classes they teach, and once the row is gone this
    // is the only place that says which class a deleted pupil was in.
    classId:   { type: String, default: null },
    deletedAt: { type: Date, required: true, default: () => new Date() },
    // null: the row was deleted. "unpublished": the row exists but left the
    // non-admin mirror (sent only to non-admins, and only while the row stays
    // unpublished — syncFeed.js).
    reason:    { type: String, enum: [null, ...REASONS], default: null },
  },
  // updatedAt: the desktop feed pages every collection on (updatedAt, _id).
  { versionKey: false, timestamps: true }
);

// One tombstone per deleted record; written by upsert, so repeating is harmless.
syncTombstoneSchema.index({ entity: 1, docId: 1 }, { unique: true, name: "sync_tombstone_entity_doc" });
// The pull's query: this school's deletions since the cursor.
syncTombstoneSchema.index({ schoolId: 1, deletedAt: 1 }, { name: "sync_tombstone_school_time" });
// The desktop feed's cursor (/sync/changes), as every mirrored collection has.
syncTombstoneSchema.index({ schoolId: 1, updatedAt: 1, _id: 1 });

module.exports =
  mongoose.models.SyncTombstone || mongoose.model("SyncTombstone", syncTombstoneSchema);
module.exports.ENTITIES = ENTITIES;
module.exports.REASONS = REASONS;
