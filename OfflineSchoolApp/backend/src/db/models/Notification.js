// backend/src/db/models/Notification.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One message the school owes somebody, and what happened to it.
 *
 * A queue rather than a direct send, for the same reason the mobile outbox is a
 * queue: the thing that triggers a notification — a payment taken, a result
 * published, a child scanned at the gate — must succeed whether or not the mail
 * server is reachable. Recording the fee and telling the parent are two
 * different jobs, and only one of them is allowed to fail.
 *
 * The channel is a field, not a branch in the code. Email is what every school
 * gets today; a school that pays for WhatsApp has it enabled per-school and the
 * same queue delivers through a different adapter. Nothing that CREATES a
 * notification knows or cares which.
 */
const notificationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },

    /** What happened. Drives which template renders it. */
    kind: {
      type: String,
      required: true,
      enum: [
        "fee.payment",       // money received, with the receipt number
        "fee.reminder",      // outstanding balance
        "result.published",  // a term's results are available
        "attendance.absent", // did not arrive
        "gate.arrival",      // scanned in
        "gate.departure",    // scanned out
        "announcement",      // general school notice
        "test",              // used to prove the pipe works end to end
      ],
      index: true,
    },

    // Who it is for. `studentId` is the child the message concerns; `to` is the
    // address it actually went to, which may be the guardian or the student.
    studentId: { type: String, default: null, index: true },
    to:        { type: String, required: true },
    /** Which field `to` came from — guardian or student. Printed in the log so
     *  "the parent never got it" can be answered without guessing. */
    toSource:  { type: String, default: null },

    channel: {
      type: String,
      enum: ["email", "whatsapp", "sms", "log"],
      default: "email",
      index: true,
    },

    subject: { type: String, default: null },
    body:    { type: String, default: null },
    /** Values the template rendered from, kept so a resend is reproducible. */
    data:    { type: mongoose.Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      default: "pending",
      index: true,
    },

    attempts:      { type: Number, default: 0 },
    lastAttemptAt: { type: Date,   default: null },
    /**
     * Not retried before this. Exponential backoff, so a mail server that is
     * down for an hour is not hammered once a minute for that hour.
     */
    nextAttemptAt: { type: Date, default: () => new Date() },

    sentAt: { type: Date,   default: null },
    error:  { type: String, default: null },

    /**
     * Why a notification was never attempted — no address on file, guardian
     * has not opted in, channel disabled for this school. Distinct from
     * `failed`, which means we tried and could not.
     */
    skipReason: { type: String, default: null },

    createdBy: { type: String, default: null },
    deletedAt: { type: Date,   default: null },
  },
  { _id: false, timestamps: true }
);

// The dispatcher's query: everything due, oldest first.
notificationSchema.index({ status: 1, nextAttemptAt: 1 });
notificationSchema.index({ schoolId: 1, createdAt: -1 });

module.exports =
  mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
