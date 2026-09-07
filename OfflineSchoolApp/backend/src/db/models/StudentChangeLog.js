// backend/src/db/models/StudentChangeLog.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What a pupil's record used to say.
 *
 * Until this existed, a school admin could not change a student record at all.
 * Not a name, not a date of birth, not a guardian's phone number — the only
 * writes were approve, reject, suspend, restore, move class and delete. A name
 * misspelled during admission was permanent from the office's side, and that
 * name is what prints on report cards, identity cards, receipts and
 * transcripts.
 *
 * The workaround that looks available is not one: twenty collections carry a
 * `studentId`, so deleting and re-creating a pupil to correct a typo detaches
 * their marks, their register, their fees and every report card already issued.
 *
 * ── Why the edit needs a log and the creation does not ────────────────────
 *
 * A pupil's legal name, date of birth and sex are what a certificate asserts.
 * A school has to be able to answer "who changed this, and what did it say
 * before" about all three, years later, to a parent or to an examinations
 * board. That is the same reason ResultChangeLog and AttendanceChangeLog
 * exist, and this is deliberately the same shape as both.
 *
 * A first entry is not a change and gets no row — there was nothing to lose.
 *
 * ── One row per field, grouped by batchId ─────────────────────────────────
 *
 * A single save that corrects a surname and a guardian's phone is two rows
 * sharing a `batchId`, following ResultChangeLog rather than storing a diff
 * blob. It costs more rows and buys the question people actually ask: "when
 * did this pupil's date of birth change, and to what?" — one indexed query on
 * `field`, no scanning of JSON.
 *
 * ── Why there is no de-duplication key ────────────────────────────────────
 *
 * A row is written only when a value actually MOVED, which is what makes a
 * replayed sync safe with no key at all: the retry reads the value it already
 * wrote, finds new equal to old, and writes nothing. A deliberate correction
 * and then a correction back is three genuine rows, and any key clever enough
 * to suppress the replay would suppress that too. Same reasoning as
 * AttendanceChangeLog, and the same conclusion.
 */
const studentChangeLogSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    // ── Which pupil ────────────────────────────────────────────────────────
    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },

    /**
     * The pupil's name as it stood when the change was made.
     *
     * Denormalised on purpose, and the one field here that is about the row
     * rather than the change: a history list has to be readable after the
     * pupil has left and after their name has itself been corrected. Joining
     * back to Student would show today's name against a change made under the
     * old one, which is exactly the thing this log exists to disentangle.
     */
    studentName: { type: String, default: null },

    // ── What changed ───────────────────────────────────────────────────────
    //
    // `field` is the schema path, not a label — "dateOfBirth", not "Date of
    // birth". Labels are the clients' business and they already translate
    // them; a stored label would be frozen in whichever language the admin
    // happened to be using.
    field: { type: String, required: true, index: true },

    // Mixed because these are whatever the field held: a string for a name, a
    // "YYYY-MM-DD" string for a birth date, null for a value being cleared.
    previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue:      { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Who ────────────────────────────────────────────────────────────────
    changedBy:     { type: String, default: null },
    changedByName: { type: String, default: null },  // denormalised: staff get renamed
    changedByRole: { type: String, default: null },
    changedAt:     { type: Date,   default: Date.now, index: true },

    /**
     * Groups the fields of one save.
     *
     * Without it, correcting three fields at once reads as three unrelated
     * events an hour apart on a slow connection, and there is no way to show
     * "this edit" as one thing in a history list.
     */
    batchId: { type: String, default: null, index: true },

    /**
     * Where the write came from, when the caller says so.
     *
     * A record corrected by a phone whose outbox drained an hour late looks
     * identical to one corrected deliberately just now, and the difference
     * decides whether anybody needs to be told. Free text because the clients
     * disagree about what they are — "web", "mobile", "desktop", "sync" — and
     * a strict enum here would reject the honest answer.
     */
    source: { type: String, default: null },

    /**
     * Why, when the admin gave a reason.
     *
     * Optional by design. Requiring a reason to fix a typo would train people
     * to type "typo" and stop reading the prompt, which is how the field on
     * published results earns its keep and how this one would lose its.
     */
    reason: { type: String, default: null, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// One pupil's history, newest first — the list a school office actually opens.
studentChangeLogSchema.index({ schoolId: 1, studentId: 1, changedAt: -1 });

// And across a school, for "what was edited this week".
studentChangeLogSchema.index({ schoolId: 1, changedAt: -1 });

module.exports =
  mongoose.models.StudentChangeLog ||
  mongoose.model("StudentChangeLog", studentChangeLogSchema);
