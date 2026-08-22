// backend/src/db/models/GateEvent.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One scan at the school gate.
 *
 * Separate from StudentAttendance, which records whether a child was present
 * for a subject on a date and holds one row per student per subject per day.
 * A gate log is a different shape: several timestamped events per child per
 * day, in and out, with no subject. Forcing them into one table would break
 * that model's uniqueness rule the first time a child left at lunch.
 *
 * Append-only. A mistaken scan is corrected by scanning again, or by an admin
 * voiding the row — never by editing when a child arrived.
 */
const gateEventSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },

    direction: { type: String, enum: ["in", "out"], required: true },

    /** YYYY-MM-DD, so "today's scans" is an index hit rather than a range scan. */
    date: { type: String, required: true, index: true },

    /**
     * When the scan happened on the device, and when the server received it.
     *
     * Both, because a gate tablet may be offline for hours and its clock may be
     * wrong. `at` is what the parent is told; `receivedAt` is what lets someone
     * later work out that a batch arrived late.
     */
    at:         { type: Date, required: true },
    receivedAt: { type: Date, default: () => new Date() },

    scannedBy: { type: String, default: null },
    /** Which gate or device, when a school has more than one. */
    station:   { type: String, default: null },

    voidedAt:    { type: Date,   default: null },
    voidReason:  { type: String, default: null },

    /** The notification this scan raised, if any. */
    notificationId: { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true }
);

// The two questions asked of this collection: this child today, and everyone
// today.
gateEventSchema.index({ schoolId: 1, studentId: 1, date: 1, at: -1 });
gateEventSchema.index({ schoolId: 1, date: 1, at: -1 });

module.exports =
  mongoose.models.GateEvent ||
  mongoose.model("GateEvent", gateEventSchema);
