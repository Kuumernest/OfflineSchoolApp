// backend/src/db/models/AttendanceChangeLog.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What a register entry used to say.
 *
 * Attendance is last-write-wins, like everything else here, and that is the
 * right trade for a school: two people marking the same register in the same
 * minute is rare, and a merge dialog on a phone in a corridor is worse than the
 * problem. But last-write-wins is only acceptable while the losing write leaves
 * a trace, and attendance was the one record type where it left none.
 *
 * The unique index on the natural key means a re-mark UPDATES the row. The old
 * status was overwritten in place and gone: `markedBy` names whoever set the
 * value that survived, and nothing anywhere said what it replaced or who had
 * said otherwise. A pupil marked present by the form master and absent by a
 * subject teacher an hour later ended the day absent, with no way for anyone to
 * find out that there had been a disagreement at all — which is exactly the
 * question a parent asks.
 *
 * ── Why there is no de-duplication key ────────────────────────────────────
 *
 * A row is written only when the status actually MOVED. That is what makes a
 * synchronisation retry safe, and it needs no key to enforce: the first attempt
 * applies present → absent and records it, and the replay reads absent, finds
 * the new value equal to the old one, and writes nothing. Nothing to collide,
 * nothing to reconcile.
 *
 * A deliberate second change back — absent → present → absent — is three
 * genuine rows, and any dedup key clever enough to suppress a retry would
 * suppress that too. Leaving it out is the safer of the two mistakes.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 *
 * No note field, no class or subject, no period. All of those are on the
 * attendance row this points at, which is never deleted — the natural key is
 * derived, so the row is stable and the id in `attendanceId` will still resolve
 * it. Copying them would be a second source of truth to go stale.
 */
const attendanceChangeLogSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    // ── Which register entry ───────────────────────────────────────────────
    //
    // Scoped by school on every read, like everything else. Indexed because
    // that is the first clause of every query that will ever run here.
    schoolId:     { type: String, required: true, index: true },
    attendanceId: { type: String, required: true, index: true },
    studentId:    { type: String, required: true, index: true },

    /**
     * The register's own date, as the register stores it — a "YYYY-MM-DD"
     * string, not a Date. Duplicated from the attendance row on purpose: it is
     * how a person asks the question ("what happened on the 3rd?"), and the
     * alternative is a join for every row of a history list.
     */
    date: { type: String, required: true, index: true },

    // ── What changed ───────────────────────────────────────────────────────
    previousStatus: { type: String, default: null },
    newStatus:      { type: String, required: true },

    // ── Who ────────────────────────────────────────────────────────────────
    //
    // Both sides. The previous marker is the half that was previously
    // unrecoverable, and it is the half somebody actually needs: knowing who
    // overwrote a mark is no use without knowing whose mark it was.
    previousMarkedBy: { type: String, default: null },
    previousMarkedAt: { type: Date,   default: null },
    changedBy:        { type: String, default: null },
    changedByName:    { type: String, default: null },   // users get renamed
    changedByRole:    { type: String, default: null },
    changedAt:        { type: Date,   default: Date.now, index: true },

    /**
     * Where the write came from, when the caller says.
     *
     * A register re-marked by a phone whose outbox drained an hour late looks
     * identical to one re-marked deliberately, and the difference decides
     * whether anybody needs to be told. Free text because the clients disagree
     * about what they are — "sync", "web", a device id — and a strict enum here
     * would reject the honest answer.
     */
    source: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// The history of one pupil's register, newest first — the list a school office
// actually opens.
attendanceChangeLogSchema.index({ schoolId: 1, studentId: 1, changedAt: -1 });

// And one day across a school, for "who changed what on the 3rd".
attendanceChangeLogSchema.index({ schoolId: 1, date: 1, changedAt: -1 });

module.exports =
  mongoose.models.AttendanceChangeLog ||
  mongoose.model("AttendanceChangeLog", attendanceChangeLogSchema);
